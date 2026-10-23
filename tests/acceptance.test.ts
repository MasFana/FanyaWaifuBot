import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { createApplication, startApplication, type Application } from "../src/main.js";
import { FrozenClock } from "../src/core/clock.js";
import { FakeLLMProvider } from "../src/llm/fake.js";
import { migrate, openDatabase } from "../src/db/index.js";
import type { TelegramBot } from "../src/channels/telegram.js";
import { createTestConfig } from "./helpers.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OwnerQueue } from "../src/core/owner-queue.js";

class FakeTelegramBot implements TelegramBot {
  readonly messages: Array<{ chatId: string; text: string }> = [];
  readonly actions: string[] = [];
  async sendMessage(chatId: string, text: string): Promise<void> { this.messages.push({ chatId, text }); }
  async sendChatAction(_chatId: string, action: "typing"): Promise<void> { this.actions.push(action); }
  async sendDocument(chatId: string, document: string): Promise<void> { this.messages.push({ chatId, text: document }); }
  async start(): Promise<void> {}
  stop(): void {}
}

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

async function setup() {
  const clock = new FrozenClock(Date.UTC(2026, 9, 23, 7));
  const database = openDatabase(":memory:");
  databases.push(database);
  migrate(database, clock);
  const provider = new FakeLLMProvider();
  const bot = new FakeTelegramBot();
  const app = await createApplication({ config: createTestConfig(), database, clock, provider, bot, delay: async () => {}, toolDirectory: resolve("tests/fixtures") });
  await app.receive({ id: "claim", fromId: "123", text: "/start" });
  return { app, bot, clock, database, provider };
}

test("acceptance: owner lock and first claim happen before agent work", async () => {
  const { app, database, provider } = await setup();
  await app.receive({ id: "foreign", fromId: "99999", text: "halo" });
  assert.equal((database.prepare("SELECT count(*) AS count FROM messages").get() as { count: number }).count, 0);
  assert.equal(provider.getRequests().length, 0);
  await app.receive({ id: "foreign-start", fromId: "456", text: "/start" });
  assert.ok(database.prepare("SELECT 1 FROM identities WHERE external_id = '123'").get());
  assert.equal(database.prepare("SELECT 1 FROM identities WHERE external_id = '456'").get(), undefined);
});

test("acceptance: facts replace, FTS finds old messages, and schedule extraction persists defaults", async () => {
  const { app, clock, database, provider } = await setup();
  const owner = "123";
  provider.enqueue({ content: "Siap", toolCalls: [] });
  provider.enqueue({ content: JSON.stringify({ facts: [{ content: "Suka kopi hitam", category: "preferensi", origin: "stated" }], commitments: [] }), toolCalls: [] });
  await app.receive({ id: "m1", fromId: owner, text: "Aku suka kopi hitam" });
  await app.writerIdle();
  provider.enqueue({ content: "Oke", toolCalls: [] });
  provider.enqueue({ content: JSON.stringify({ facts: [{ content: "Suka teh hijau", category: "preferensi", origin: "stated" }], commitments: [] }), toolCalls: [] });
  await app.receive({ id: "m2", fromId: owner, text: "Sekarang aku ganti teh hijau" });
  await app.writerIdle();
  const facts = app.memory.listActiveFacts(owner);
  assert.deepEqual(facts.map((fact) => fact.content), ["Suka teh hijau"]);
  assert.equal((database.prepare("SELECT count(*) AS count FROM facts WHERE status = 'replaced'").get() as { count: number }).count, 1);
  app.memory.appendMessage(owner, { channel: "telegram", role: "user", content: "Detail lama: liburan Bandung naik kereta" });
  assert.equal(app.memory.search(owner, "liburan Bandung").messages[0]?.content, "Detail lama: liburan Bandung naik kereta");
  const eventAt = clock.now() + 24 * 60 * 60_000;
  provider.enqueue({ content: "Siap dicatat", toolCalls: [] });
  provider.enqueue({ content: JSON.stringify({ facts: [], commitments: [{ title: "Presentasi proyek", eventAt }] }), toolCalls: [] });
  await app.receive({ id: "m3", fromId: owner, text: "Besok jam 10 pagi aku ada presentasi proyek" });
  await app.writerIdle();
  const commitment = app.memory.listPendingCommitments(owner)[0];
  assert.equal(commitment?.remindAt, eventAt - 75 * 60_000);
  assert.equal(commitment?.followUpAt, eventAt + 150 * 60_000);
});

test("acceptance: reminder, follow-up, quiet hours, and unanswered backoff are enforced", async () => {
  const { app, bot, clock, provider } = await setup();
  const owner = "123";
  const eventAt = clock.now() + 60 * 60_000;
  const commitment = app.memory.upsertCommitment(owner, { title: "Presentasi proyek", eventAt, remindAt: clock.now(), followUpAt: clock.now() });
  provider.enqueue({ content: "Ingat presentasi proyek ya", toolCalls: [] });
  await app.heartbeat.tick();
  provider.enqueue({ content: "Gimana presentasinya?", toolCalls: [] });
  await app.heartbeat.tick();
  assert.deepEqual(bot.messages.slice(1).map((message) => message.text), ["Ingat presentasi proyek ya", "Gimana presentasinya?"]);
  assert.equal(app.memory.getProactiveState(owner).unansweredCount, 2);
  clock.set(Date.UTC(2026, 9, 22, 19));
  app.memory.recordOwnerActivity(owner);
  await app.heartbeat.tick();
  assert.equal(bot.messages.slice(1).length, 2);
  await app.receive({ id: "reply", fromId: owner, text: "Sudah" });
  assert.equal(app.memory.getProactiveState(owner).unansweredCount, 0);
  assert.equal(commitment.title, "Presentasi proyek");
});

test("acceptance: FTS tool retrieves message 2 from 40 old messages", async () => {
  const { app, provider } = await setup();
  const owner = "123";
  for (let index = 1; index <= 40; index += 1) {
    app.memory.appendMessage(owner, { channel: "telegram", role: "user", content: `Pesan lama ${index}${index === 2 ? ": detail rapat Bandung" : ""}` });
  }
  provider.enqueue({ content: null, toolCalls: [{ id: "search-1", name: "memory_search", arguments: { query: "detail rapat Bandung" } }] });
  provider.enqueue({ content: "Pesan kedua berisi detail rapat Bandung.", toolCalls: [] });
  await app.receive({ id: "search", fromId: owner, text: "Apa detail pesan kedua tentang rapat?" });
  assert.match(app.memory.exportOwner(owner).messages.at(-1)?.content ?? "", /Pesan kedua berisi detail rapat Bandung/);
  assert.equal(provider.getRequests()[0]?.tools.some((tool) => tool.name === "memory_search"), true);
  const toolResult = provider.getRequests()[1]?.messages.find((message) => message.role === "tool");
  assert.match(toolResult?.content ?? "", /detail rapat Bandung/);
});

test("acceptance: compiled tool discovery merges extension with built-ins", async () => {
  const { app } = await setup();
  assert.ok(app.tools.includes("acceptance_extension"));
  assert.ok(app.tools.includes("utility_calculate"));
});

test("application construction closes database when dependency loading fails", async () => {
  const database = openDatabase(":memory:");
  const clock = new FrozenClock(Date.UTC(2026, 9, 23, 7));
  migrate(database, clock);
  await assert.rejects(createApplication({ config: createTestConfig(), database, clock, provider: new FakeLLMProvider(), harnessDirectory: "missing-harness" }));
  assert.throws(() => database.prepare("SELECT 1").get(), /not open/);
});

test("emitted build contains schema and can migrate a database", async () => {
  assert.equal(existsSync("dist/src/db/schema.sql"), true);
  const schema = readFileSync("dist/src/db/schema.sql", "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS users/);
});

test("application shutdown waits for heartbeat and stays idempotent", async () => {
  const { app, bot, clock, provider } = await setup();
  const owner = "123";
  app.memory.upsertCommitment(owner, { title: "Rapat", eventAt: clock.now() + 60_000, remindAt: clock.now() });
  provider.enqueue({ content: "Pengingat rapat", toolCalls: [] });
  const tick = app.heartbeat.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const firstShutdown = app.shutdown();
  await Promise.all([firstShutdown, app.shutdown(), tick]);
  assert.equal(bot.messages.at(-1)?.text, "Pengingat rapat");
  await tick;
});

test("owner queue serializes concurrent inbound and heartbeat work", async () => {
  const queue = new OwnerQueue();
  const order: string[] = [];
  let release!: () => void;
  const first = queue.enqueue("owner", async () => {
    order.push("inbound-start");
    await new Promise<void>((resolve) => { release = resolve; });
    order.push("inbound-end");
  });
  const second = queue.enqueue("owner", async () => { order.push("heartbeat"); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["inbound-start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["inbound-start", "inbound-end", "heartbeat"]);
});

test("shutdown drains delayed post-turn writer before closing database", async () => {
  const { app, database, provider } = await setup();
  let release!: () => void;
  let extractorStarted!: () => void;
  const started = new Promise<void>((resolve) => { extractorStarted = resolve; });
  const originalComplete = provider.complete.bind(provider);
  let calls = 0;
  provider.complete = async (request) => {
    calls += 1;
    if (calls === 2) {
      extractorStarted();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return originalComplete(request);
  };
  provider.enqueue({ content: "balasan", toolCalls: [] });
  provider.enqueue({ content: JSON.stringify({ facts: [{ content: "Suka sate", category: "preferensi", origin: "stated" }], commitments: [] }), toolCalls: [] });
  const receive = app.receive({ id: "delayed", fromId: "123", text: "aku suka sate" });
  await started;
  const shutdown = app.shutdown();
  let closed = false;
  const originalClose = database.close.bind(database);
  database.close = () => { closed = true; return originalClose(); };
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await Promise.all([receive, shutdown]);
  assert.equal(closed, true);
});

test("startup closes database when migration or provider construction fails", async () => {
  const database = openDatabase(":memory:");
  let closes = 0;
  const originalClose = database.close.bind(database);
  database.close = () => { closes += 1; return originalClose(); };
  const config = createTestConfig();
  await assert.rejects(startApplication(config, {
    openDatabase: () => database,
    migrate: () => { throw new Error("migration failed"); },
  }));
  assert.equal(closes, 1);

  const providerDatabase = openDatabase(":memory:");
  let providerCloses = 0;
  const providerClose = providerDatabase.close.bind(providerDatabase);
  providerDatabase.close = () => { providerCloses += 1; return providerClose(); };
  await assert.rejects(startApplication(config, {
    openDatabase: () => providerDatabase,
    provider: () => { throw new Error("provider failed"); },
  }));
  assert.equal(providerCloses, 1);
});

test("startup stops partially started channel and drains heartbeat on failure", async () => {
  const database = openDatabase(":memory:");
  const events: string[] = [];
  const application = {
    heartbeat: { start: () => { events.push("heartbeat.start"); }, stop: async () => { events.push("heartbeat.stop"); } },
    channel: { start: async () => { events.push("channel.start"); throw new Error("polling failed"); }, stop: () => { events.push("channel.stop"); } },
    writer: { awaitIdle: async () => { events.push("writer.idle"); } },
  } as unknown as Application;
  await assert.rejects(startApplication(createTestConfig(), {
    openDatabase: () => database,
    application: async () => application,
  }));
  assert.deepEqual(events, ["heartbeat.start", "channel.start", "channel.stop", "heartbeat.stop", "writer.idle"]);
  assert.throws(() => database.prepare("SELECT 1").get(), /not open/);
});

test("startup failure drains an in-flight writer before closing database", async () => {
  const database = openDatabase(":memory:");
  const clock = new FrozenClock(Date.UTC(2026, 9, 23, 7));
  migrate(database, clock);
  const provider = new FakeLLMProvider();
  const app = await createApplication({ config: createTestConfig(), database, clock, provider, bot: new FakeTelegramBot() });
  const owner = app.memory.claimOwner("telegram", "123");
  assert.ok(owner);

  let release!: () => void;
  let started!: () => void;
  const writerStarted = new Promise<void>((resolve) => { started = resolve; });
  provider.complete = async () => {
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    return { content: JSON.stringify({ facts: [{ content: "Suka sate", category: "preferensi", origin: "stated" }], commitments: [] }), toolCalls: [] };
  };
  void app.writer.enqueue({ userId: owner.id, ownerMessage: "aku suka sate", messageId: "message-1" });
  await writerStarted;

  app.channel.start = async () => { throw new Error("polling failed"); };
  let factsAtClose = 0;
  const close = database.close.bind(database);
  database.close = () => {
    factsAtClose = (database.prepare("SELECT count(*) AS count FROM facts WHERE content = 'Suka sate'").get() as { count: number }).count;
    return close();
  };
  const startup = startApplication(createTestConfig(), {
    openDatabase: () => database,
    application: async () => app,
  });
  release();

  await assert.rejects(startup, /polling failed/);
  assert.equal(factsAtClose, 1);
  assert.throws(() => database.prepare("SELECT 1").get(), /not open/);
});

test("startup does not close database twice when application construction fails", async () => {
  const database = openDatabase(":memory:");
  let closes = 0;
  const originalClose = database.close.bind(database);
  database.close = () => { closes += 1; return originalClose(); };
  await assert.rejects(startApplication(createTestConfig(), {
    openDatabase: () => database,
    application: async () => { throw new Error("construction failed"); },
  }));
  assert.equal(closes, 1);
});
