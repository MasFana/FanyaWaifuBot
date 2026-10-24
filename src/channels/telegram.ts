import { Bot, InputFile } from "grammy";
import type { AppConfig } from "../config.js";
import type { Clock } from "../core/clock.js";
import type {
  InboundEvent,
  InboundImage,
  MediaDelivery,
  OutboundMedia,
  WakeupEvent,
} from "../core/types.js";
import type { ForgetResult, MemoryService } from "../memory/service.js";
import { OwnerQueue } from "../core/owner-queue.js";
import { decideReply } from "../core/living-state.js";

const channelName = "telegram";
const quietTime = /^([01]\d|2[0-3]):[0-5]\d$/;
const skipProactiveToken = "[SKIP_PROACTIVE]";
const sleepPhrase =
  /(\bmau tidur|\bpengen tidur|\bbobo dulu|\bmau bobo|\btidur dulu)/i;
const sleepDurationMs = 7 * 3_600_000;
const userActiveGraceMs = 2 * 3_600_000;
const proactiveCooldownMs = 3 * 3_600_000;
const recentProactiveLimit = 5;
const shortMessageMs = 260;
const reactionLength = 45;
const mergeCeiling = 280;
const sentenceSplitCeiling = 380;
const ordinaryBubbleCap = 2;
const shortBurstLength = 20;
const shortBurstDebounceMs = 4500;
const replyQuoteMax = 220;
const photoMarker = "[Mengirim foto]";

export function computeBurstDebounceMs(
  joinedLength: number,
  configuredMs: number,
): number {
  return joinedLength < shortBurstLength
    ? Math.max(configuredMs, shortBurstDebounceMs)
    : configuredMs;
}

export function truncateQuote(text: string, max = replyQuoteMax): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function formatReplyQuote(text: string, fromBot: boolean): string {
  return fromBot
    ? `[Membalas pesanmu: "${text}"]`
    : `[Membalas pesan sebelumnya: "${text}"]`;
}

export function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export function photoFallbackText(caption?: string): string {
  return caption ?? photoMarker;
}

export function isImageContentType(value: string | null): boolean {
  return value !== null && value.startsWith("image/");
}

function buildInboundText(update: TelegramUpdate): string {
  const parts: string[] = [];
  if (update.replyToText) {
    parts.push(
      formatReplyQuote(
        truncateQuote(update.replyToText),
        update.replyToFromBot ?? false,
      ),
    );
  }
  if (update.images !== undefined && update.images.length > 0) {
    parts.push(update.text ? `${photoMarker} ${update.text}` : photoMarker);
  } else if (update.text !== undefined) {
    parts.push(update.text);
  }
  return parts.join("\n");
}

export interface SendProactiveOptions {
  triggerType?: WakeupEvent["triggerType"];
}

interface PendingBurst {
  texts: string[];
  ids: string[];
  images?: InboundImage[];
  timer?: ReturnType<typeof setTimeout>;
}

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
  replyToText?: string;
  replyToFromBot?: boolean;
  images?: InboundImage[];
}

export type Delay = (milliseconds: number) => Promise<void>;

class GrammyBot implements TelegramBot {
  private readonly bot: Bot;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
    this.bot = new Bot(token);
  }

  bind(receiver: (update: TelegramUpdate) => Promise<void>): void {
    this.bot.on("message:text", async (context) => {
      await receiver({
        id: String(context.message.message_id),
        fromId: String(context.from.id),
        text: context.message.text,
        ...this.replyContext(context.message.reply_to_message, context.me.id),
      });
    });
    this.bot.on("message:photo", async (context) => {
      const images = await this.downloadPhoto(
        context.message.photo.at(-1)?.file_id,
      );
      const update: TelegramUpdate = {
        id: String(context.message.message_id),
        fromId: String(context.from.id),
        ...this.replyContext(context.message.reply_to_message, context.me.id),
      };
      if (images.length > 0) {
        update.images = images;
        if (context.message.caption !== undefined)
          update.text = context.message.caption;
      } else {
        update.text = photoFallbackText(context.message.caption);
      }
      await receiver(update);
    });
  }

  private replyContext(
    reply:
      | {
          text?: string;
          caption?: string;
          from?: { id: number; is_bot?: boolean };
        }
      | undefined,
    botId: number,
  ): Pick<TelegramUpdate, "replyToText" | "replyToFromBot"> {
    if (reply === undefined) return {};
    const quote = reply.text ?? reply.caption;
    if (quote === undefined) return {};
    return {
      replyToText: truncateQuote(quote),
      replyToFromBot: reply.from?.id === botId || reply.from?.is_bot === true,
    };
  }

  private async downloadPhoto(
    fileId: string | undefined,
  ): Promise<InboundImage[]> {
    if (fileId === undefined) {
      console.error("[photo] no file_id on message");
      return [];
    }
    try {
      const file = await this.bot.api.getFile(fileId);
      if (file.file_path === undefined) {
        console.error("[photo] getFile returned no file_path", { fileId });
        return [];
      }
      const response = await fetch(
        `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
      );
      if (!response.ok) {
        console.error("[photo] file fetch not ok", { status: response.status, filePath: file.file_path });
        return [];
      }
      const header = response.headers.get("content-type");
      if (header !== null && !isImageContentType(header)) {
        console.error("[photo] unexpected content-type", { header, filePath: file.file_path });
        return [];
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = header ?? "image/jpeg";
      return [{ dataUrl: toDataUrl(buffer, mimeType), mimeType }];
    } catch (error) {
      console.error("[photo] download threw", error);
      return [];
    }
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
    const options =
      media.caption === undefined ? {} : { caption: media.caption };
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
  private readonly pending = new Map<string, PendingBurst>();
  private lastUserActivityAt: number | null = null;
  private lastProactiveSentAt: number | null = null;
  private sleepUntil: number | null = null;
  private readonly recentProactiveTexts: string[] = [];

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
    if (!update.text && !update.images?.length) return;
    const raw = update.text ?? "";
    const owner = this.authorize(update.fromId, raw);
    if (!owner) return;

    const text = buildInboundText(update);
    const event: InboundEvent = {
      id: update.id,
      userId: owner.id,
      text,
      receivedAt: this.clock.now(),
      ...(update.images === undefined || update.images.length === 0
        ? {}
        : { images: update.images }),
    };
    if (!this.memory.recordInbound(channelName, event)) return;
    this.memory.resetUnansweredProactiveCount(owner.id);
    this.lastUserActivityAt = event.receivedAt;
    this.sleepUntil = sleepPhrase.test(raw)
      ? event.receivedAt + sleepDurationMs
      : null;

    if (raw.trimStart().startsWith("/")) {
      await this.flushPending(owner.id, { force: true });
      await this.queue.enqueue(owner.id, async () => {
        await this.handleCommand(owner.id, { ...event, text: raw });
      });
      return;
    }

    const message = this.memory.appendMessage(owner.id, {
      channel: channelName,
      role: "user",
      content: text,
    });
    this.memory.recordOwnerActivity(owner.id);

    const burst = this.pending.get(owner.id) ?? { texts: [], ids: [] };
    burst.texts.push(text);
    burst.ids.push(message.id);
    if (update.images !== undefined && update.images.length > 0) {
      burst.images = [...(burst.images ?? []), ...update.images];
    }
    this.pending.set(owner.id, burst);

    if (this.config.replies.debounceMs <= 0) {
      await this.flushPending(owner.id, { force: true });
      return;
    }
    this.scheduleFlush(owner.id);
  }

  /**
   * Menggabungkan pesan owner yang beruntun (burst) menjadi satu giliran, lalu
   * menjalankannya sebagai satu agent turn. Dipanggil oleh timer debounce, oleh
   * command (agar burst lama tidak hilang), dan oleh heartbeat sebelum wakeup.
   *
   * Selama masih ada giliran yang berjalan untuk owner ini, burst baru ditahan
   * dan dijadwalkan ulang agar semua pesan yang diketik sambil Fanya "mikir"
   * menyatu jadi satu balasan susulan, bukan satu balasan per pesan.
   */
  async flushPending(
    userId?: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const owners = userId === undefined ? [...this.pending.keys()] : [userId];
    for (const id of owners) {
      const burst = this.pending.get(id);
      if (burst === undefined || burst.texts.length === 0) continue;
      if (options.force !== true && this.queue.isBusy(id)) {
        this.scheduleFlush(id);
        continue;
      }
      if (burst.timer) clearTimeout(burst.timer);
      this.pending.delete(id);
      const lastId = burst.ids.at(-1);
      const event: InboundEvent = {
        id: lastId ?? burst.texts.join("\n"),
        userId: id,
        text: burst.texts.join("\n"),
        receivedAt: this.clock.now(),
        ...(lastId === undefined ? {} : { storedMessageId: lastId }),
        storedMessageIds: burst.ids,
        ...(burst.images === undefined || burst.images.length === 0
          ? {}
          : { images: burst.images }),
      };
      await this.queue.enqueue(id, async () => {
        if (
          decideReply(this.memory.getPersonaState(id), {
            focusThreshold: this.config.replies.focusDeferThreshold,
          }) === "defer"
        ) {
          await this.delay(this.config.replies.deferExtraMs);
        }
        await this.agent?.runInbound(event);
      });
    }
  }

  private scheduleFlush(ownerId: string): void {
    const burst = this.pending.get(ownerId);
    if (burst === undefined) return;
    if (burst.timer) clearTimeout(burst.timer);
    const delay = computeBurstDebounceMs(
      burst.texts.join("\n").length,
      this.config.replies.debounceMs,
    );
    burst.timer = setTimeout(() => {
      void this.flushPending(ownerId);
    }, delay);
  }

  async sendReply(userId: string, text: string): Promise<void> {
    await this.deliver(userId, text);
  }

  /** Mengembalikan false bila rem proaktif menahan pengiriman, true bila benar-benar terkirim. */
  async sendProactive(
    userId: string,
    text: string,
    options: SendProactiveOptions = {},
  ): Promise<boolean> {
    if (text.trim().includes(skipProactiveToken)) return false;
    const spontaneous =
      (options.triggerType ?? "spontaneous") === "spontaneous";
    const now = this.clock.now();
    if (spontaneous && this.holdsSpontaneous(text, now)) return false;
    await this.deliver(userId, text);
    if (spontaneous) {
      this.lastProactiveSentAt = this.clock.now();
      this.recentProactiveTexts.push(normalizeProactiveText(text));
      while (this.recentProactiveTexts.length > recentProactiveLimit)
        this.recentProactiveTexts.shift();
    }
    return true;
  }

  /** Rem proaktif: tidur, owner baru aktif, jeda antar-pesan, atau teks yang berulang. */
  private holdsSpontaneous(text: string, now: number): boolean {
    if (this.sleepUntil !== null && now < this.sleepUntil) return true;
    if (
      this.lastUserActivityAt !== null &&
      now - this.lastUserActivityAt < userActiveGraceMs
    )
      return true;
    if (
      this.lastProactiveSentAt !== null &&
      now - this.lastProactiveSentAt < proactiveCooldownMs
    )
      return true;
    const normalized = normalizeProactiveText(text);
    return (
      normalized.length > 0 &&
      this.recentProactiveTexts.some((previous) =>
        isSimilarProactiveText(previous, normalized),
      )
    );
  }

  async sendMedia(
    userId: string,
    media: OutboundMedia,
  ): Promise<MediaDelivery> {
    try {
      await this.bot.sendMedia(this.resolveChatId(userId), media);
      return "media";
    } catch {
      const link =
        media.caption === undefined
          ? media.url
          : `${media.caption}\n${media.url}`;
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
          `haloooo sayaaaaang, aya udah nyambung ke telegram kamuuu hehe ( ́• ω •\`)ノ\n\nid telegram kamu itu ${chatId} yaaa`,
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
            `okeeey sayaaaaang, dari jam ${start} sampai ${end} aku ga bakal berisik gangguin kamu bobo hehe`,
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
    const bubbles = splitDynamicBubbles(text, this.config.replies.maxBubbles);

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
 * Membersihkan artefak AI dan roleplay sebelum dipecah menjadi bubble:
 * 1. Mengubah **bold** atau __bold__ menjadi teks polos (judul/nama tetap terbaca).
 * 2. Menghapus narasi aksi roleplay di dalam asterisk tunggal (*menatap dari jauh*, dll).
 * 3. Menghapus bullet list atau markdown heading di awal baris.
 */
export function sanitizeModelOutput(rawText: string): string {
  let cleaned = rawText;

  // 0. Hapus kebocoran aksara Hanzi/Kanji
  cleaned = cleaned.replace(/[\u4e00-\u9fff\u3400-\u4dbf]+/g, "");

  // === TAMBAHKAN INI: Ganti em dash (—), en dash (–), atau double hyphen (--) jadi koma atau spasi ===
  cleaned = cleaned.replace(/—|–|--/g, ", ");

  // 1. Buka bungkus **bold** dan __underline__
  cleaned = cleaned.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/__([^_\n]+)__/g, "$1");

  // 2. Hapus narasi roleplay *aksi*
  cleaned = cleaned.replace(
    /(?<!\*)\*([a-zA-Z][^*\n]*?\s+[^*\n]*?[a-zA-Z])\*(?!\*)/g,
    " ",
  );

  // 3. Hapus markdown heading (#), bullet points (- / • / *), atau angka list (1. / 2.) di awal baris
  cleaned = cleaned.replace(/^[ \t]*(?:#{1,6}|\u2022|-|\*|\d+\.)[ \t]+/gm, "");

  // 4. Ubah panah kaku khas bot rekap (→, ->, =>) menjadi koma
  cleaned = cleaned.replace(/\s*(?:→|->|=>)\s*/g, ", ");

  // 5. Rapikan spasi ganda (terutama jika em dash diganti koma/spasi)
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // 7. Runtuhkan "menu pertanyaan" beruntun
  const questionLines = cleaned
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (
    questionLines.length >= 2 &&
    questionLines.filter((line) => line.trim().endsWith("?")).length >= 2
  ) {
    cleaned = questionLines.map((line) => line.trim()).join(" ");
  }

  return cleaned.trim();
}

/**
 * Memecah teks menjadi balon chat secara dinamis:
 * 1. Menghormati pemisah paragraf (\n\n) dari LLM setelah dibersihkan dari markdown/roleplay.
 * 2. Jika ada 1 balon yang terlalu panjang (> 380 karakter), otomatis memecahnya
 *    pada batas kalimat agar tidak terlihat seperti tembok teks.
 * 3. Semua balon dibatasi maksimum `maxBubbles`; kelebihannya digabung ke balon terakhir.
 */
export function splitDynamicBubbles(
  rawText: string,
  maxBubbles: number,
): string[] {
  const sanitized = sanitizeModelOutput(rawText);
  if (!sanitized) return [];

  const cap = Math.max(1, Math.min(maxBubbles, ordinaryBubbleCap));
  const paragraphs = sanitized
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const first = paragraphs[0]!;
  // Paragraf pertama yang sangat pendek = reaksi spontan; biarkan jadi balon kedua.
  const leadingReaction =
    paragraphs.length > 1 && first.length <= reactionLength;
  if (sanitized.length <= shortMessageMs && !leadingReaction)
    return [humanizeBubble(sanitized)];

  const rest = leadingReaction ? paragraphs.slice(1) : paragraphs;
  const groups: string[] = [];
  let current = "";
  for (const paragraph of rest) {
    const candidate =
      current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (current.length > 0 && candidate.length > mergeCeiling) {
      groups.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) groups.push(current);

  const bubbles: string[] = [];
  if (leadingReaction) bubbles.push(humanizeBubble(first));
  for (const group of groups) {
    if (group.length <= sentenceSplitCeiling || group.includes("\n")) {
      bubbles.push(humanizeBubble(group));
      continue;
    }
    const sentences = group.match(/[^.!?]+[.!?]*\s*/g) ?? [group];
    let accumulated = "";
    for (const sentence of sentences) {
      if (
        (accumulated + sentence).trim().length > sentenceSplitCeiling &&
        accumulated.trim()
      ) {
        bubbles.push(humanizeBubble(accumulated));
        accumulated = sentence;
      } else {
        accumulated += sentence;
      }
    }
    if (accumulated.trim()) bubbles.push(humanizeBubble(accumulated));
  }

  return capBubbles(bubbles.filter(Boolean), cap);
}

function normalizeProactiveText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSimilarProactiveText(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 12 && longer.includes(shorter);
}

function capBubbles(bubbles: string[], maxBubbles: number): string[] {
  if (bubbles.length <= maxBubbles) return bubbles;
  return [
    ...bubbles.slice(0, maxBubbles - 1),
    bubbles.slice(maxBubbles - 1).join("\n"),
  ];
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
  return `kalau soal kamu mah aku inget dong sayaaaaang hehe, aku inget soal ${lowerJoined(items, ", terus ")}`;
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
