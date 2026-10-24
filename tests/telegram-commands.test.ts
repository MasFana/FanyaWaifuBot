import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { FrozenClock } from "../src/core/clock.js";
import { openDatabase, migrate } from "../src/db/index.js";
import { MemoryService, type ForgetResult } from "../src/memory/service.js";
import { TelegramChannel, type TelegramBot } from "../src/channels/telegram.js";
import { createTestConfig } from "./helpers.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

class FakeBot implements TelegramBot {
  readonly messages: string[] = [];
  readonly actions: string[] = [];
  readonly documents: string[] = [];
  async sendMessage(_chatId: string, text: string): Promise<void> { this.messages.push(text); }
  async sendChatAction(_chatId: string, action: string): Promise<void> { this.actions.push(action); }
  async sendDocument(_chatId: string, document: string): Promise<void> { this.documents.push(document); }
  async sendMedia(): Promise<void> {}
  async start(): Promise<void> {}
  stop(): void {}
}

class SpyMemory extends MemoryService {
  forgetCalls = 0;
  quietHoursCalls = 0;

  override forget(userId: string, topic: string): ForgetResult {
    this.forgetCalls += 1;
    return super.forget(userId, topic);
  }

  override setQuietHours(userId: string, start: string, end: string): void {
    this.quietHoursCalls += 1;
    super.setQuietHours(userId, start, end);
  }
}

function setup(): { channel: TelegramChannel; memory: SpyMemory; bot: FakeBot } {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(1_729_648_000_000);
  migrate(database, clock);
  const memory = new SpyMemory(database, clock);
  const bot = new FakeBot();
  return { channel: new TelegramChannel(createTestConfig({ telegram: { botToken: "test-token", ownerId: "123" } }), memory, clock, bot, async () => {}), memory, bot };
}

test("native commands respond from memory without agent", async () => {
  const { channel, memory, bot } = setup();
  memory.ensureOwner("telegram", "123");
  memory.upsertFact("123", { content: "Suka teh hijau", category: "preferensi", origin: "stated" });
  memory.upsertCommitment("123", { title: "Dokter gigi", eventAt: 1_729_652_000_000, contextNotes: "kontrol" });

  await channel.receive({ id: "memory", fromId: "123", text: "/memory" });
  await channel.receive({ id: "agenda", fromId: "123", text: "/agenda" });
  await channel.receive({ id: "quiet", fromId: "123", text: "/quiet 22:00 07:00" });
  await channel.receive({ id: "forget", fromId: "123", text: "/forget teh hijau" });
  await channel.receive({ id: "export", fromId: "123", text: "/export" });

  assert.match(bot.messages[0] ?? "", /Suka teh hijau/);
  assert.match(bot.messages[1] ?? "", /Dokter gigi/);
  assert.match(bot.messages[2] ?? "", /22:00.*07:00/);
  assert.match(bot.messages[3] ?? "", /dihapus/i);
  assert.equal(bot.documents.length, 1);
  assert.equal(memory.listActiveFacts("123").length, 0);
});

test("accepted ordinary text persists, resets unanswered count, runs agent, and splits delivery bubbles", async () => {
  const { channel, memory, bot } = setup();
  memory.ensureOwner("telegram", "123");
  memory.setUnansweredProactiveCount("123", 2);
  let inboundText = "";
  channel.setAgent({ runInbound: async (event) => { inboundText = event.text; } });

  await channel.receive({ id: "text", fromId: "123", text: "halo" });
  await channel.sendReply("123", "Satu\n\nDua");

  assert.equal(inboundText, "halo");
  assert.equal(memory.exportOwner("123").messages[0]?.content, "halo");
  assert.equal(memory.getUnansweredProactiveCount("123"), 0);
  assert.deepEqual(bot.messages.slice(-2), ["Satu", "Dua"]);
  assert.deepEqual(bot.actions.slice(-2), ["typing", "typing"]);
});

test("caps delivery at configured bubble count and merges overflow into the last", async () => {
  const { channel, memory, bot } = setup();
  memory.ensureOwner("telegram", "123");

  await channel.sendReply("123", "Satu\n\nDua\n\nTiga\n\nEmpat\n\nLima");

  assert.deepEqual(bot.messages, ["Satu", "Dua", "Tiga\nEmpat\nLima"]);
  assert.equal(bot.actions.length, 3);
});

test("forget rejects missing or whitespace topic without service mutation", async () => {
  const { channel, memory, bot } = setup();
  memory.ensureOwner("telegram", "123");

  await channel.receive({ id: "forget-missing", fromId: "123", text: "/forget" });
  await channel.receive({ id: "forget-space", fromId: "123", text: "/forget    " });

  assert.equal(memory.forgetCalls, 0);
  assert.match(bot.messages[0] ?? "", /\/forget <topik>/);
  assert.match(bot.messages[1] ?? "", /\/forget <topik>/);
});

test("quiet requires exactly two valid times without service mutation", async () => {
  const { channel, memory, bot } = setup();
  memory.ensureOwner("telegram", "123");

  await channel.receive({ id: "quiet-trailing", fromId: "123", text: "/quiet 22:00 07:00 extra" });
  await channel.receive({ id: "quiet-invalid", fromId: "123", text: "/quiet 25:00 07:00" });

  assert.equal(memory.quietHoursCalls, 0);
  assert.match(bot.messages[0] ?? "", /Format: \/quiet HH:mm HH:mm/);
  assert.match(bot.messages[1] ?? "", /Format: \/quiet HH:mm HH:mm/);
});
