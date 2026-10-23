import { Bot, InputFile } from "grammy";
import type { AppConfig } from "../config.js";
import type { Clock } from "../core/clock.js";
import type { InboundEvent } from "../core/types.js";
import type { ForgetResult, MemoryService } from "../memory/service.js";
import { OwnerQueue } from "../core/owner-queue.js";

const channelName = "telegram";
const quietTime = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface TelegramBot {
  sendMessage(chatId: string, text: string): Promise<void>;
  sendChatAction(chatId: string, action: "typing"): Promise<void>;
  sendDocument(chatId: string, document: string): Promise<void>;
  start(): Promise<void>;
  stop(): void;
}

export interface TelegramAgent { runInbound(event: InboundEvent): Promise<void>; }
export interface TelegramUpdate { id: string; fromId: string; text?: string; }
export type Delay = (milliseconds: number) => Promise<void>;

class GrammyBot implements TelegramBot {
  private readonly bot: Bot;

  constructor(token: string) { this.bot = new Bot(token); }
  bind(receiver: (update: TelegramUpdate) => Promise<void>): void {
    this.bot.on("message:text", async (context) => {
      await receiver({
        id: String(context.message.message_id),
        fromId: String(context.from.id),
        text: context.message.text,
      });
    });
  }
  async sendMessage(chatId: string, text: string): Promise<void> { await this.bot.api.sendMessage(chatId, text); }
  async sendChatAction(chatId: string, action: "typing"): Promise<void> { await this.bot.api.sendChatAction(chatId, action); }
  async sendDocument(chatId: string, document: string): Promise<void> {
    await this.bot.api.sendDocument(chatId, new InputFile(Buffer.from(document), "fanya-export.json"));
  }
  async start(): Promise<void> { await this.bot.start(); }
  stop(): void { this.bot.stop(); }
}

export class TelegramChannel {
  private agent: TelegramAgent | undefined;
  private owner: { externalId: string; id: string } | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly memory: MemoryService,
    private readonly clock: Clock,
    private readonly bot: TelegramBot = new GrammyBot(config.telegram.botToken),
    private readonly delay: Delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly queue: OwnerQueue = new OwnerQueue(),
  ) {
    if (this.bot instanceof GrammyBot) this.bot.bind((update) => this.receive(update));
    const configured = this.config.telegram.ownerId;
    if (configured) {
      this.owner = { externalId: configured, id: this.memory.ensureOwner(channelName, configured).id };
    } else {
      const claimed = this.memory.resolveClaimedOwner(channelName);
      if (claimed) this.owner = { externalId: claimed.externalId, id: claimed.owner.id };
    }
  }

  setAgent(agent: TelegramAgent): void { this.agent = agent; }
  async start(): Promise<void> { await this.bot.start(); }
  stop(): void { this.bot.stop(); }

  async receive(update: TelegramUpdate): Promise<void> {
    const text = update.text;
    if (!text) return;
    const owner = this.authorize(update.fromId, text);
    if (!owner) return;

    return this.queue.enqueue(owner.id, async () => {
      const event: InboundEvent = { id: update.id, userId: owner.id, text, receivedAt: this.clock.now() };
      if (!this.memory.recordInbound(channelName, event)) return;
      this.memory.resetUnansweredProactiveCount(owner.id);
      if (await this.handleCommand(owner.id, text)) return;
      const message = this.memory.appendMessage(owner.id, { channel: channelName, role: "user", content: text });
      this.memory.recordOwnerActivity(owner.id);
      await this.agent?.runInbound({ ...event, storedMessageId: message.id });
    });
  }

  async sendReply(userId: string, text: string): Promise<void> { await this.deliver(userId, text); }
  async sendProactive(userId: string, text: string): Promise<void> { await this.deliver(userId, text); }

  private authorize(externalId: string, text: string): { id: string } | undefined {
    if (this.owner) return externalId === this.owner.externalId ? { id: this.owner.id } : undefined;
    if (text !== "/start") return undefined;
    const claimed = this.memory.claimOwner(channelName, externalId);
    if (!claimed) return undefined;
    this.owner = { externalId, id: claimed.id };
    return claimed;
  }

  private async handleCommand(userId: string, text: string): Promise<boolean> {
    const [command, ...arguments_] = text.trim().split(/\s+/);
    switch (command?.toLowerCase()) {
      case "/start":
        await this.bot.sendMessage(userId, `Fanya tersambung. ID Telegram kamu: ${userId}`);
        return true;
      case "/memory":
        await this.bot.sendMessage(userId, formatMemory(this.memory.listActiveFacts(userId).map((fact) => fact.content)));
        return true;
      case "/agenda":
        await this.bot.sendMessage(userId, formatAgenda(this.memory.listPendingCommitments(userId).map((item) => item.title)));
        return true;
      case "/forget":
        if (arguments_.join(" ").trim()) {
          await this.bot.sendMessage(userId, formatForget(this.memory.forget(userId, arguments_.join(" "))));
        } else {
          await this.bot.sendMessage(userId, "Format: /forget <topik>");
        }
        return true;
      case "/quiet": {
        const [start, end] = arguments_;
        if (arguments_.length !== 2 || !start || !end || !quietTime.test(start) || !quietTime.test(end)) {
          await this.bot.sendMessage(userId, "Format: /quiet HH:mm HH:mm");
        } else {
          this.memory.setQuietHours(userId, start, end);
          await this.bot.sendMessage(userId, `Jam tenang diatur: ${start}–${end}.`);
        }
        return true;
      }
      case "/export":
        await this.bot.sendDocument(userId, JSON.stringify(this.memory.exportOwner(userId), null, 2));
        return true;
      default:
        return false;
    }
  }

  private async deliver(userId: string, text: string): Promise<void> {
    for (const bubble of text.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean)) {
      await this.bot.sendChatAction(userId, "typing");
      await this.delay(1_500 + Math.floor(Math.random() * 1_501));
      await this.bot.sendMessage(userId, bubble);
    }
  }
}

function formatMemory(items: string[]): string { return items.length === 0 ? "Belum ada ingatan aktif." : `Yang aku ingat:\n${items.map((item) => `• ${item}`).join("\n")}`; }
function formatAgenda(items: string[]): string { return items.length === 0 ? "Belum ada agenda aktif." : `Agenda aktif:\n${items.map((item) => `• ${item}`).join("\n")}`; }
function formatForget(result: ForgetResult): string {
  if (result.outcome === "deleted") return `Sudah dihapus: ${result.candidate.content}`;
  if (result.outcome === "not_found") return "Aku tidak menemukan ingatan atau agenda itu.";
  return `Ada beberapa kecocokan:\n${result.candidates.map((item) => `• ${item.content}`).join("\n")}\nKetik topik lebih spesifik ya.`;
}
