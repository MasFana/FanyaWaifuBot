import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { FrozenClock } from "../src/core/clock.js";
import { openDatabase, migrate } from "../src/db/index.js";
import { MemoryService } from "../src/memory/service.js";
import { TelegramChannel, sanitizeModelOutput, splitDynamicBubbles, type TelegramBot } from "../src/channels/telegram.js";
import { createTestConfig } from "./helpers.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

class FakeBot implements TelegramBot {
  readonly messages: string[] = [];
  async sendMessage(_chatId: string, text: string): Promise<void> { this.messages.push(text); }
  async sendChatAction(): Promise<void> {}
  async sendDocument(): Promise<void> {}
  async sendMedia(): Promise<void> {}
  async start(): Promise<void> {}
  stop(): void {}
}

const start = Date.UTC(2026, 9, 23, 12);
const hour = 3_600_000;

function setup() {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(start);
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  memory.ensureOwner("telegram", "123");
  const bot = new FakeBot();
  const base = createTestConfig();
  const channel = new TelegramChannel(
    { ...base, telegram: { botToken: "test-token", ownerId: "123" }, replies: { ...base.replies, debounceMs: 0 } },
    memory, clock, bot,
  );
  return { bot, channel, clock, memory };
}

test("sanitizeModelOutput strips CJK, markdown, and roleplay", () => {
  const raw = "**Halo** sayang\n还是在忙?\n*menatap dari rak buku* aku kangen\n- satset\n# Judul";

  const out = sanitizeModelOutput(raw);

  assert.doesNotMatch(out, /[\u4e00-\u9fff]/u);
  assert.doesNotMatch(out, /\*/u);
  assert.doesNotMatch(out, /(^|\n)[ \t]*[-#]/u);
  assert.match(out, /Halo sayang/u);
  assert.match(out, /aku kangen/u);
});

test("splitDynamicBubbles keeps a short message as one bubble", () => {
  assert.deepEqual(splitDynamicBubbles("halo sayang, kamu lagi apa?", 4), ["halo sayang, kamu lagi apa?"]);
});

test("splitDynamicBubbles allows a second bubble for a short reaction opening", () => {
  const raw = "ehh kok gitu\n\naku tadi nungguin kamu lama banget jadi aku baca novel sampai bab terakhir hehe";

  const bubbles = splitDynamicBubbles(raw, 4);

  assert.equal(bubbles.length, 2);
  assert.equal(bubbles[0], "ehh kok gitu");
});

test("splitDynamicBubbles preserves two paragraphs chosen by Fanya", () => {
  const raw = "aku tadi abis baca novel sampe bab terakhir nih ceritanya seru banget\n\nkamu udah makan belum?";

  assert.deepEqual(splitDynamicBubbles(raw, 4), [
    "aku tadi abis baca novel sampe bab terakhir nih ceritanya seru banget",
    "kamu udah makan belum?",
  ]);
});

test("splitDynamicBubbles respects configured bubble cap", () => {
  const raw = `${"A".repeat(200)}\n\n${"B".repeat(200)}\n\n${"C".repeat(200)}`;

  assert.equal(splitDynamicBubbles(raw, 2).length, 2);
});

test("sendProactive blocks spontaneous care while owner sleeps", async () => {
  const { bot, channel, clock } = setup();

  await channel.receive({ id: "m1", fromId: "123", text: "mau tidur dulu ya" });
  clock.set(start + 3 * hour);
  await channel.sendProactive("123", "malem sayang, udah makan?", { triggerType: "spontaneous" });

  assert.equal(bot.messages.length, 0);
});

test("sendProactive blocks spontaneous care while owner is recently active", async () => {
  const { bot, channel } = setup();

  await channel.receive({ id: "m1", fromId: "123", text: "halo" });
  await channel.sendProactive("123", "kangen nih", { triggerType: "spontaneous" });

  assert.equal(bot.messages.length, 0);
});

test("sendProactive blocks repeated proactive text within the cooldown", async () => {
  const { bot, channel, clock } = setup();

  await channel.sendProactive("123", "malem sayang, udah makan?", { triggerType: "spontaneous" });
  clock.set(start + 4 * hour);
  await channel.sendProactive("123", "malem sayang, udah makan?", { triggerType: "spontaneous" });

  assert.equal(bot.messages.length, 1);
});

test("sendProactive allows non-spontaneous proactive such as greetings", async () => {
  const { bot, channel } = setup();

  await channel.receive({ id: "m1", fromId: "123", text: "mau tidur dulu" });
  await channel.sendProactive("123", "selamat pagi sayang", { triggerType: "greeting" });

  assert.equal(bot.messages.length, 1);
});

test("sendProactive resumes after owner sends a normal message", async () => {
  const { bot, channel, clock } = setup();

  await channel.receive({ id: "m1", fromId: "123", text: "mau tidur dulu" });
  clock.set(start + 2 * hour);
  await channel.receive({ id: "m2", fromId: "123", text: "eh ga jadi tidur" });
  clock.set(start + 4 * hour);
  await channel.sendProactive("123", "kangen nih", { triggerType: "spontaneous" });

  assert.equal(bot.messages.length, 1);
});
