import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { FrozenClock } from "../src/core/clock.js";
import { openDatabase, migrate } from "../src/db/index.js";
import { MemoryService } from "../src/memory/service.js";
import { TelegramChannel, computeBurstDebounceMs, sanitizeModelOutput, splitDynamicBubbles, type Delay, type TelegramBot } from "../src/channels/telegram.js";
import { defaultPersonaState } from "../src/core/persona-state.js";
import { createTestConfig } from "./helpers.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

class FakeBot implements TelegramBot {
  readonly messages: string[] = [];
  readonly actions: Array<{ chatId: string; action: "typing" }> = [];
  async sendMessage(_chatId: string, text: string): Promise<void> { this.messages.push(text); }
  async sendChatAction(chatId: string, action: "typing"): Promise<void> { this.actions.push({ chatId, action }); }
  async sendDocument(): Promise<void> { }
  async sendMedia(): Promise<void> { }
  async start(): Promise<void> { }
  stop(): void { }
}

function setup(debounceMs: number, delay: Delay = async () => { }) {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(1_729_648_000_000);
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  memory.ensureOwner("telegram", "123");
  const bot = new FakeBot();
  const base = createTestConfig();
  const channel = new TelegramChannel(
    { ...base, telegram: { botToken: "test-token", ownerId: "123" }, replies: { ...base.replies, debounceMs } },
    memory, clock, bot, delay,
  );
  const turns: string[] = [];
  channel.setAgent({ runInbound: async (event) => { turns.push(event.text); } });
  return { channel, memory, bot, turns };
}

test("burst of owner messages within the debounce window becomes one turn", async () => {
  const { channel, memory, turns } = setup(10_000);

  await channel.receive({ id: "m1", fromId: "123", text: "aku tadi makan pedes banget" });
  await channel.receive({ id: "m2", fromId: "123", text: "kek" });
  await channel.receive({ id: "m3", fromId: "123", text: "jir" });

  assert.equal(turns.length, 0);

  await channel.flushPending("123");

  assert.deepEqual(turns, ["aku tadi makan pedes banget\nkek\njir"]);
  assert.equal(memory.exportOwner("123").messages.filter((message) => message.role === "user").length, 3);
});

test("messages arriving while a turn is in flight merge into one follow-up turn", async () => {
  const { channel, turns } = setup(10_000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  channel.setAgent({ runInbound: async (event) => { turns.push(event.text); if (event.text === "m1") await gate; } });

  await channel.receive({ id: "m1", fromId: "123", text: "m1" });
  void channel.flushPending("123");
  await Promise.resolve();

  await channel.receive({ id: "m2", fromId: "123", text: "m2" });
  await channel.receive({ id: "m3", fromId: "123", text: "m3" });
  await channel.flushPending("123");

  assert.deepEqual(turns, ["m1"], "follow-up waits while the first turn is in flight");

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await channel.flushPending("123");

  assert.deepEqual(turns, ["m1", "m2\nm3"], "held messages coalesce into a single follow-up turn");
});

test("command flushes the pending burst before running itself", async () => {
  const { channel, turns } = setup(10_000);

  await channel.receive({ id: "m1", fromId: "123", text: "halo dulu ya" });
  await channel.receive({ id: "c1", fromId: "123", text: "/agenda" });

  assert.ok(turns.some((turn) => turn.includes("halo dulu ya")), "burst flushed first");
  assert.ok(turns.some((turn) => turn.startsWith("[SYSTEM COMMAND")), "command then ran");
});

test("high focus defers while showing typing for deferExtraMs", async () => {
  const delays: number[] = [];
  const { channel, memory, bot, turns } = setup(10_000, async (milliseconds) => { delays.push(milliseconds); });
  memory.setPersonaState("123", {
    ...defaultPersonaState,
    activity: { name: "baca novel bab terakhir", endsAt: 9_999_999_999_000 },
    drives: { wantCompany: 0, wantToShare: 0, focus: 0.9, boundary: 0 },
  });

  await channel.receive({ id: "m1", fromId: "123", text: "halo" });
  await channel.flushPending("123");

  assert.deepEqual(delays, Array(15).fill(4_000));
  assert.deepEqual(bot.actions, Array(15).fill({ chatId: "123", action: "typing" }));
  assert.equal(turns.length, 1);
})

test("low focus replies without deferring", async () => {
  const delays: number[] = [];
  const { channel, turns } = setup(10_000, async (milliseconds) => { delays.push(milliseconds); });

  await channel.receive({ id: "m1", fromId: "123", text: "halo" });
  await channel.flushPending("123");

  assert.deepEqual(delays, []);
  assert.equal(turns.length, 1);
});

test("computeBurstDebounceMs extends the window for short lead bursts", () => {
  assert.equal(computeBurstDebounceMs(8, 2000), 4500);
  assert.equal(computeBurstDebounceMs(8, 8000), 8000);
  assert.equal(computeBurstDebounceMs(40, 2000), 2000);
});

test("sanitizeModelOutput collapses a menu of question lines into one flowing message", () => {
  const cleaned = sanitizeModelOutput(
    "lo-fi chill buat nemenin baca?\nanime ost?\ncity pop japan 80s? kasih tau aja",
  );
  assert.ok(!cleaned.includes("\n"), "menu must not keep internal newlines");
  assert.equal(
    cleaned,
    "lo-fi chill buat nemenin baca? anime ost? city pop japan 80s? kasih tau aja",
  );
});

test("splitDynamicBubbles keeps a collapsed question menu as a single bubble", () => {
  const bubbles = splitDynamicBubbles(
    "lo-fi chill buat nemenin baca?\nanime ost?\ncity pop japan 80s? kasih tau aja",
    3,
  );
  assert.equal(bubbles.length, 1);
});

test("splitDynamicBubbles still splits a normal two-paragraph reply", () => {
  const bubbles = splitDynamicBubbles("Satu\n\nDua", 3);
  assert.deepEqual(bubbles, ["Satu", "Dua"]);
});