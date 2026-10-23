import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { FrozenClock } from "../src/core/clock.js";
import type { InboundEvent } from "../src/core/types.js";
import { openDatabase, migrate } from "../src/db/index.js";
import { MemoryService } from "../src/memory/service.js";
import { TelegramChannel, type TelegramBot } from "../src/channels/telegram.js";
import { createTestConfig } from "./helpers.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

class SpyMemory extends MemoryService {
  calls = 0;

  override claimOwner(channel: string, externalId: string) {
    this.calls += 1;
    return super.claimOwner(channel, externalId);
  }

  override ensureOwner(channel: string, externalId: string) {
    this.calls += 1;
    return super.ensureOwner(channel, externalId);
  }

  override resolveOwner(channel: string, externalId: string) {
    this.calls += 1;
    return super.resolveOwner(channel, externalId);
  }

  override resolveClaimedOwner(channel: string) {
    this.calls += 1;
    return super.resolveClaimedOwner(channel);
  }

  override recordInbound(channel: string, event: InboundEvent): boolean {
    this.calls += 1;
    return super.recordInbound(channel, event);
  }
}

class FakeBot implements TelegramBot {
  readonly messages: Array<{ chatId: string; text: string }> = [];
  readonly actions: string[] = [];
  started = false;
  stopped = false;

  async sendMessage(chatId: string, text: string): Promise<void> { this.messages.push({ chatId, text }); }
  async sendChatAction(_chatId: string, action: string): Promise<void> { this.actions.push(action); }
  async sendDocument(): Promise<void> {}
  async start(): Promise<void> { this.started = true; }
  stop(): void { this.stopped = true; }
}

function setup(ownerId?: string): { channel: TelegramChannel; database: Database.Database; memory: SpyMemory; bot: FakeBot; agentRuns: () => number } {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(1_729_648_000_000);
  migrate(database, clock);
  const memory = new SpyMemory(database, clock);
  const bot = new FakeBot();
  let runs = 0;
  const channel = new TelegramChannel(createTestConfig({ telegram: { botToken: "test-token", ownerId } }), memory, clock, bot, async () => {});
  memory.calls = 0;
  channel.setAgent({ runInbound: async () => { runs += 1; } });
  return { channel, database, memory, bot, agentRuns: () => runs };
}

test("silently drops foreign update before database or agent work", async () => {
  const { channel, database, memory, bot, agentRuns } = setup("123");

  await channel.receive({ id: "foreign-1", fromId: "99999", text: "halo" });

  assert.equal(memory.calls, 0);
  assert.equal((database.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0);
  assert.equal(agentRuns(), 0);
  assert.deepEqual(bot.messages, []);
});

test("empty owner setting drops unknown non-start updates without database calls", async () => {
  const { channel, memory, bot, agentRuns } = setup();

  await channel.receive({ id: "foreign-no-start", fromId: "99999", text: "halo" });

  assert.equal(memory.calls, 0);
  assert.equal(agentRuns(), 0);
  assert.deepEqual(bot.messages, []);
});

test("empty owner setting lets first start claim owner and rejects later foreign text", async () => {
  const { channel, memory, agentRuns } = setup();

  await channel.receive({ id: "start-1", fromId: "123", text: "/start" });
  await channel.receive({ id: "foreign-2", fromId: "456", text: "halo" });

  assert.equal(memory.resolveOwner("telegram", "123")?.id, "123");
  assert.equal(memory.resolveOwner("telegram", "456"), undefined);
  assert.equal(agentRuns(), 0);
});

test("empty owner setting accepts persisted first claimant after channel setup", async () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(1_729_648_000_000);
  migrate(database, clock);
  const memory = new SpyMemory(database, clock);
  memory.claimOwner("telegram", "123");
  const channel = new TelegramChannel(createTestConfig(), memory, clock, new FakeBot(), async () => {});
  memory.calls = 0;
  let runs = 0;
  channel.setAgent({ runInbound: async () => { runs += 1; } });

  await channel.receive({ id: "persisted-owner", fromId: "123", text: "halo" });

  assert.equal(runs, 1);
});

test("configured owner change accepts configured ID and leaves old claim inaccessible", async () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(1_729_648_000_000);
  migrate(database, clock);
  const memory = new SpyMemory(database, clock);
  memory.claimOwner("telegram", "123");
  const bot = new FakeBot();
  let runs = 0;
  const channel = new TelegramChannel(createTestConfig({ telegram: { botToken: "test-token", ownerId: "456" } }), memory, clock, bot, async () => {});
  channel.setAgent({ runInbound: async () => { runs += 1; } });

  await channel.receive({ id: "old-1", fromId: "123", text: "lama" });
  await channel.receive({ id: "new-1", fromId: "456", text: "baru" });

  assert.equal(memory.resolveOwner("telegram", "123")?.id, "123");
  assert.equal(memory.resolveOwner("telegram", "456")?.id, "456");
  assert.equal(memory.exportOwner("123")?.messages.length, 0);
  assert.equal(memory.exportOwner("456")?.messages[0]?.content, "baru");
  assert.equal(runs, 1);
});
