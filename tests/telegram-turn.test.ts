import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { FrozenClock } from "../src/core/clock.js";
import { openDatabase, migrate } from "../src/db/index.js";
import { MemoryService } from "../src/memory/service.js";
import { TelegramChannel, type Delay, type TelegramBot } from "../src/channels/telegram.js";
import { defaultPersonaState } from "../src/core/persona-state.js";
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

function setup(debounceMs: number, delay: Delay = async () => {}) {
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

test("command flushes the pending burst before running itself", async () => {
  const { channel, turns } = setup(10_000);

  await channel.receive({ id: "m1", fromId: "123", text: "halo dulu ya" });
  await channel.receive({ id: "c1", fromId: "123", text: "/agenda" });

  assert.ok(turns.some((turn) => turn.includes("halo dulu ya")), "burst flushed first");
  assert.ok(turns.some((turn) => turn.startsWith("[SYSTEM COMMAND")), "command then ran");
});

test("high focus defers the reply by deferExtraMs before running", async () => {
  const delays: number[] = [];
  const { channel, memory, turns } = setup(10_000, async (milliseconds) => { delays.push(milliseconds); });
  memory.setPersonaState("123", {
    ...defaultPersonaState,
    activity: { name: "baca novel bab terakhir", endsAt: 9_999_999_999_000 },
    drives: { wantCompany: 0, wantToShare: 0, focus: 0.9, boundary: 0 },
  });

  await channel.receive({ id: "m1", fromId: "123", text: "halo" });
  await channel.flushPending("123");

  assert.deepEqual(delays, [60_000]);
  assert.equal(turns.length, 1);
});

test("low focus replies without deferring", async () => {
  const delays: number[] = [];
  const { channel, turns } = setup(10_000, async (milliseconds) => { delays.push(milliseconds); });

  await channel.receive({ id: "m1", fromId: "123", text: "halo" });
  await channel.flushPending("123");

  assert.deepEqual(delays, []);
  assert.equal(turns.length, 1);
});