import { Bot, InputFile } from "grammy";
import type { AppConfig } from "../config.js";
import type { Clock } from "../core/clock.js";
import type { InboundEvent, MediaDelivery, OutboundMedia } from "../core/types.js";
import type { ForgetResult, MemoryService } from "../memory/service.js";
import { OwnerQueue } from "../core/owner-queue.js";

const channelName = "telegram";
const quietTime = /^([01]\d|2[0-3]):[0-5]\d$/;
const skipProactiveToken = "[SKIP_PROACTIVE]";

export interface TelegramBot {
  sendMessage(chatId: string, text: string): Promise<void>;
  sendChatAction(chatId: string, action: "typing"): Promise<void>;
  sendDocument(chatId: string, document: string): Promise<void>;
  sendMedia(chatId: string, media: OutboundMedia): Promise<void>;
  start(): Promise<void>;
  stop(): void;
}

export interface TelegramAgent {
  runInbound(event: InboundEvent): Promise<void>;
}

export interface TelegramUpdate {
  id: string;
  fromId: string;
  text?: string;
}

export type Delay = (milliseconds: number) => Promise<void>;

class GrammyBot implements TelegramBot {
  private readonly bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  bind(receiver: (update: TelegramUpdate) => Promise<void>): void {
    this.bot.on("message:text", async (context) => {
      await receiver({
        id: String(context.message.message_id),
        fromId: String(context.from.id),
        text: context.message.text,
      });
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, text);
  }

  async sendChatAction(chatId: string, action: "typing"): Promise<void> {
    await this.bot.api.sendChatAction(chatId, action);
  }

  async sendDocument(chatId: string, document: string): Promise<void> {
    await this.bot.api.sendDocument(
      chatId,
      new InputFile(Buffer.from(document), "fanya-export.json"),
    );
  }

  async sendMedia(chatId: string, media: OutboundMedia): Promise<void> {
    const options = media.caption === undefined ? {} : { caption: media.caption };
    if (media.kind === "audio") {
      await this.bot.api.sendAudio(chatId, media.url, options);
    } else if (media.kind === "photo") {
      await this.bot.api.sendPhoto(chatId, media.url, options);
    } else if (media.kind === "document") {
      await this.bot.api.sendDocument(chatId, media.url, options);
    } else {
      await this.bot.api.sendVideo(chatId, media.url, options);
    }
  }

  async start(): Promise<void> {
    await this.bot.start();
  }

  stop(): void {
    this.bot.stop();
  }
}

export class TelegramChannel {
  private agent: TelegramAgent | undefined;
  private owner: { externalId: string; id: string } | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly memory: MemoryService,
    private readonly clock: Clock,
    private readonly bot: TelegramBot = new GrammyBot(config.telegram.botToken),
    private readonly delay: Delay = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly queue: OwnerQueue = new OwnerQueue(),
  ) {
    if (this.bot instanceof GrammyBot) {
      this.bot.bind((update) => this.receive(update));
    }
    const configured = this.config.telegram.ownerId;
    if (configured) {
      this.owner = {
        externalId: configured,
        id: this.memory.ensureOwner(channelName, configured).id,
      };
    } else {
      const claimed = this.memory.resolveClaimedOwner(channelName);
      if (claimed) {
        this.owner = { externalId: claimed.externalId, id: claimed.owner.id };
      }
    }
  }

  setAgent(agent: TelegramAgent): void {
    this.agent = agent;
  }

  async start(): Promise<void> {
    await this.bot.start();
  }

  stop(): void {
    this.bot.stop();
  }

  async receive(update: TelegramUpdate): Promise<void> {
    const text = update.text;
    if (!text) return;
    const owner = this.authorize(update.fromId, text);
    if (!owner) return;

    return this.queue.enqueue(owner.id, async () => {
      const event: InboundEvent = {
        id: update.id,
        userId: owner.id,
        text,
        receivedAt: this.clock.now(),
      };
      if (!this.memory.recordInbound(channelName, event)) return;
      this.memory.resetUnansweredProactiveCount(owner.id);
      if (await this.handleCommand(owner.id, event)) return;

      const message = this.memory.appendMessage(owner.id, {
        channel: channelName,
        role: "user",
        content: text,
      });
      this.memory.recordOwnerActivity(owner.id);
      await this.agent?.runInbound({ ...event, storedMessageId: message.id });
    });
  }

  async sendReply(userId: string, text: string): Promise<void> {
    await this.deliver(userId, text);
  }

  async sendProactive(userId: string, text: string): Promise<void> {
    if (text.trim().includes(skipProactiveToken)) return;
    await this.deliver(userId, text);
  }

  async sendMedia(userId: string, media: OutboundMedia): Promise<MediaDelivery> {
    try {
      await this.bot.sendMedia(this.resolveChatId(userId), media);
      return "media";
    } catch {
      const link = media.caption === undefined ? media.url : `${media.caption}\n${media.url}`;
      await this.bot.sendMessage(this.resolveChatId(userId), link);
      return "link";
    }
  }

  private authorize(
    externalId: string,
    text: string,
  ): { id: string; externalId: string } | undefined {
    if (this.owner) {
      return externalId === this.owner.externalId ? this.owner : undefined;
    }
    if (text.trim().split(/\s+/)[0]?.toLowerCase() !== "/start") {
      return undefined;
    }
    const claimed = this.memory.claimOwner(channelName, externalId);
    if (!claimed) return undefined;
    this.owner = { externalId, id: claimed.id };
    return this.owner;
  }

  private resolveChatId(userId: string): string {
    if (
      this.owner &&
      (userId === this.owner.id || userId === this.owner.externalId)
    ) {
      return this.owner.externalId;
    }
    return userId;
  }

  private async handleCommand(
    userId: string,
    event: InboundEvent,
  ): Promise<boolean> {
    const chatId = this.resolveChatId(userId);
    const [command, ...arguments_] = event.text.trim().split(/\s+/);

    switch (command?.toLowerCase()) {
      case "/start":
        await this.dispatchDynamicCommand(
          userId,
          event,
          `[SYSTEM COMMAND: Pacarmu baru saja mengetik /start untuk menyambungkan Telegram. Sapa dia dengan hangat dan manja sesuai kepribadianmu, lalu beri tahu secara natural bahwa ID Telegram dia adalah ${chatId} kalau dia butuh menyimpannya di konfigurasi.]`,
          `haloooo sayaaaaang, aya udah nyambung ke telegram kamuuu hehe ><\n\nid telegram kamu itu ${chatId} yaaa 🤍`,
        );
        return true;

      case "/memory": {
        const facts = this.memory
          .listActiveFacts(userId)
          .map((fact) => fact.content);
        const prompt =
          facts.length === 0
            ? `[SYSTEM COMMAND: Pacarmu mengetik /memory untuk menanyakan apa saja yang kamu ingat tentangnya, tapi daftar ingatanmu masih kosong. Jawab dengan lembut dan manja, ajak dia cerita lebih banyak tentang dirinya.]`
            : `[SYSTEM COMMAND: Pacarmu mengetik /memory untuk menanyakan apa saja yang kamu ingat tentang dirinya. Berikut fakta aktif yang kamu ingat: ${JSON.stringify(facts)}. Ceritakan kembali hal-hal ini secara natural dalam kalimat obrolan pacar yang mengalir (JANGAN pakai bullet points!).]`;
        await this.dispatchDynamicCommand(
          userId,
          event,
          prompt,
          formatMemoryFallback(facts),
        );
        return true;
      }

      case "/agenda": {
        const commitments = this.memory
          .listPendingCommitments(userId)
          .map((item) => item.title);
        const prompt =
          commitments.length === 0
            ? `[SYSTEM COMMAND: Pacarmu mengetik /agenda untuk mengecek jadwalnya, tapi saat ini belum ada jadwal aktif yang tercatat. Beri tahu dia dengan santai dan manis.]`
            : `[SYSTEM COMMAND: Pacarmu mengetik /agenda untuk mengecek jadwalnya yang kamu catat. Berikut daftar agendanya: ${JSON.stringify(commitments)}. Sebutkan jadwal tersebut secara natural layaknya pacar yang mengingatkan (JANGAN pakai bullet points!).]`;
        await this.dispatchDynamicCommand(
          userId,
          event,
          prompt,
          formatAgendaFallback(commitments),
        );
        return true;
      }

      case "/forget": {
        const topic = arguments_.join(" ").trim();
        if (!topic) {
          await this.dispatchDynamicCommand(
            userId,
            event,
            `[SYSTEM COMMAND: Pacarmu mengetik /forget tanpa menyebutkan topik apa yang ingin dihapus. Beri tahu dia dengan lembut cara pakainya yaitu /forget <topik>.]`,
            "yaaaang, kalau mau minta aku lupain sesuatu ketiknya pake topik yaaa, contohnya /forget <topik> hehe",
          );
          return true;
        }
        const result = this.memory.forget(userId, topic);
        await this.dispatchDynamicCommand(
          userId,
          event,
          buildForgetPrompt(topic, result),
          formatForgetFallback(result),
        );
        return true;
      }

      case "/quiet": {
        const [start, end] = arguments_;
        if (
          arguments_.length !== 2 ||
          !start ||
          !end ||
          !quietTime.test(start) ||
          !quietTime.test(end)
        ) {
          await this.dispatchDynamicCommand(
            userId,
            event,
            `[SYSTEM COMMAND: Pacarmu mengetik /quiet dengan format jam yang kurang tepat. Beri tahu dengan manja bahwa formatnya adalah /quiet HH:mm HH:mm (misal /quiet 23:30 06:30).]`,
            "sayaaaaang, format jam bobonya gini yaaa: /quiet HH:mm HH:mm (contohnya /quiet 23:30 06:30) ><",
          );
        } else {
          this.memory.setQuietHours(userId, start, end);
          await this.dispatchDynamicCommand(
            userId,
            event,
            `[SYSTEM COMMAND: Pacarmu baru saja mengatur jam tenang/jam tidurnya dari pukul ${start} sampai ${end}. Konfirmasi dengan manis bahwa kamu sudah mencatatnya dan tidak akan berisik membangunkannya di jam tersebut.]`,
            `okeeey sayaaaaang, dari jam ${start} sampai ${end} aku ga bakal berisik gangguin kamu bobo hehe 🤍`,
          );
        }
        return true;
      }

      case "/export":
        await this.bot.sendDocument(
          chatId,
          JSON.stringify(this.memory.exportOwner(userId), null, 2),
        );
        return true;

      default:
        return false;
    }
  }

  /**
   * Jika agent terpasang, semua respons command dirangkai secara dinamis oleh LLM (Fanya).
   * Jika agent belum di-set (misal pada unit test terisolasi), gunakan fallback natural.
   */
  private async dispatchDynamicCommand(
    userId: string,
    event: InboundEvent,
    dynamicPrompt: string,
    fallbackText: string,
  ): Promise<void> {
    if (this.agent) {
      const message = this.memory.appendMessage(userId, {
        channel: channelName,
        role: "user",
        content: dynamicPrompt,
      });
      this.memory.recordOwnerActivity(userId);
      await this.agent.runInbound({
        ...event,
        text: dynamicPrompt,
        storedMessageId: message.id,
      });
      return;
    }
    await this.deliver(userId, fallbackText);
  }

  private async deliver(userId: string, text: string): Promise<void> {
    const chatId = this.resolveChatId(userId);
    const bubbles = splitDynamicBubbles(text);

    for (let index = 0; index < bubbles.length; index++) {
      const bubble = bubbles[index];
      if (!bubble) continue;

      // Jeda mikir sejenak antar balon chat agar terasa seperti manusia yang lanjut ngetik
      if (index > 0) {
        await this.delay(350 + Math.floor(Math.random() * 550));
      }

      await this.bot.sendChatAction(chatId, "typing");
      await this.delay(computeDynamicTypingDelay(bubble));
      await this.bot.sendMessage(chatId, bubble);
    }
  }
}

/**
 * Memecah teks menjadi balon chat secara dinamis:
 * 1. Menghormati pemisah paragraf (\n\n) dari LLM.
 * 2. Jika ada 1 balon yang terlalu panjang (> 220 karakter), otomatis memecahnya
 *    pada batas kalimat agar tidak terlihat seperti tembok teks (wall of text).
 */
function splitDynamicBubbles(rawText: string): string[] {
  const paragraphs = rawText
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  const bubbles: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= 220 || paragraph.includes("\n")) {
      bubbles.push(humanizeBubble(paragraph));
      continue;
    }

    const sentences = paragraph.match(/[^.!?]+[.!?]*\s*/g) ?? [paragraph];
    let current = "";

    for (const sentence of sentences) {
      if ((current + sentence).trim().length > 180 && current.trim()) {
        bubbles.push(humanizeBubble(current));
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) {
      bubbles.push(humanizeBubble(current));
    }
  }

  return bubbles.filter(Boolean);
}

function humanizeBubble(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Hapus satu titik kaku di akhir balon chat (tetap biarkan "..." jika elipsis)
  return trimmed.replace(/(?<!\.)\.$/, "");
}

function computeDynamicTypingDelay(bubble: string): number {
  const charSpeedMs = 32 + Math.floor(Math.random() * 14);
  const calculated = bubble.length * charSpeedMs;
  const jitter = Math.floor(Math.random() * 450);
  return Math.min(Math.max(calculated + jitter, 900), 3_800);
}

function buildForgetPrompt(topic: string, result: ForgetResult): string {
  if (result.outcome === "deleted") {
    return `[SYSTEM COMMAND: Pacarmu meminta kamu melupakan "${topic}", dan ingatan "${result.candidate.content}" sudah berhasil dihapus dari sistem. Katakan padanya dengan manis bahwa kamu sudah melupakannya.]`;
  }
  if (result.outcome === "not_found") {
    return `[SYSTEM COMMAND: Pacarmu meminta kamu melupakan "${topic}", tapi kamu tidak menemukan catatan ingatan atau jadwal tentang itu. Katakan dengan lembut dan agak bingung lucu bahwa kamu memang tidak menemukan ingatan soal itu.]`;
  }
  const candidates = result.candidates.map((item) => item.content);
  return `[SYSTEM COMMAND: Pacarmu meminta kamu melupakan "${topic}", tapi ada beberapa ingatan yang mirip: ${JSON.stringify(candidates)}. Tanyakan dengan lembut mana yang dia maksud secara lebih spesifik agar kamu tidak salah hapus.]`;
}

function lowerJoined(items: readonly string[], joiner: string): string {
  return items.map((item) => item.toLowerCase()).join(joiner);
}

function formatMemoryFallback(items: string[]): string {
  if (items.length === 0) {
    return "hmmm aku belum nyatet hal-hal khusus nih sayaaaaang, cerita-cerita dulu dong sama akuuu hehe ><";
  }
  return `kalau soal kamu mah aku inget dong sayaaaaang hehe, aku inget soal ${lowerJoined(items, ", terus ")} 🤍`;
}

function formatAgendaFallback(items: string[]): string {
  if (items.length === 0) {
    return "belum ada jadwal atau janji yang perlu aku ingetin nih yang, kamu lagi selo kahhh? hehe";
  }
  return `jadwal kamu yang udah aku catet buat aku ingetin nanti itu ada ${lowerJoined(items, ", sama ")} yaaa sayaaaaang ><`;
}

function formatForgetFallback(result: ForgetResult): string {
  if (result.outcome === "deleted") {
    return `iyaaaa sayaaaaang, soal "${result.candidate.content.toLowerCase()}" udah aku hapus dari ingatan aku yaaa hehe`;
  }
  if (result.outcome === "not_found") {
    return "ehhh aku cari-cari kok ga ketemu ya ingatan atau jadwal soal ituuuu huhu ><";
  }
  return `ummm ada beberapa yang mirip nih yang, ada soal ${result.candidates.map((item) => item.content.toLowerCase()).join(", terus ")}\n\ncoba ketik yang lebih spesifik yaa sayaaaaang biar aku ga salah hapus ><`;
}
