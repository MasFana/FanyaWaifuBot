import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { Agent } from "../src/core/agent.js";
import { FrozenClock } from "../src/core/clock.js";
import { ContextBuilder } from "../src/core/context.js";
import type { Channel, InboundEvent } from "../src/core/types.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { FakeLLMProvider } from "../src/llm/fake.js";
import { MemoryService } from "../src/memory/service.js";
import { PostTurnWriter } from "../src/memory/writer.js";
import { ToolRegistry } from "../src/tools/index.js";
import { createMemorySearchTool } from "../src/tools/memory-search.js";
import { createScheduleTools } from "../src/tools/schedule.js";

const now = Date.UTC(2026, 9, 23, 12, 45);
const databases: Database.Database[] = [];

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function setup() {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(now);
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const extractor = new FakeLLMProvider();
  return { clock, extractor, memory, owner };
}

test("writer extracts owner facts and future schedule with default timing", async () => {
  const { clock, extractor, memory, owner } = setup();
  const eventAt = now + 21 * 60 * 60_000;
  extractor.enqueue({ content: JSON.stringify({
    facts: [{ content: "Suka teh hijau", category: "preferensi", origin: "stated" }],
    commitments: [{ title: "Presentasi proyek", eventAt, contextNotes: "siapkan slide" }],
  }), toolCalls: [] });
  const writer = new PostTurnWriter(extractor, memory, clock, "extractor-model");

  await writer.enqueue({ userId: owner.id, ownerMessage: "Besok jam 10 aku presentasi proyek", messageId: "message-1" });

  assert.equal(memory.listActiveFacts(owner.id)[0]?.content, "Suka teh hijau");
  const commitment = memory.listPendingCommitments(owner.id)[0];
  assert.equal(commitment?.title, "Presentasi proyek");
  assert.equal(commitment?.remindAt, eventAt - 75 * 60_000);
  assert.equal(commitment?.followUpAt, eventAt + 150 * 60_000);
  assert.deepEqual(extractor.getRequests()[0]?.messages, [{ role: "user", content: "Besok jam 10 aku presentasi proyek" }]);
});

test("writer ignores malformed output and past schedules", async () => {
  const { clock, extractor, memory, owner } = setup();
  const writer = new PostTurnWriter(extractor, memory, clock, "extractor-model");
  extractor.enqueue({ content: "not JSON", toolCalls: [] });
  await writer.enqueue({ userId: owner.id, ownerMessage: "rahasia", messageId: "message-1" });
  extractor.enqueue({ content: JSON.stringify({ facts: [], commitments: [{ title: "Kemarin", eventAt: now - 1 }] }), toolCalls: [] });
  await writer.enqueue({ userId: owner.id, ownerMessage: "jadwal lama", messageId: "message-2" });

  assert.equal(memory.listActiveFacts(owner.id).length, 0);
  assert.equal(memory.listPendingCommitments(owner.id).length, 0);
});

test("writer preserves valid extraction fields when one commitment is past", async () => {
  const { extractor, memory, owner } = setup();
  const writer = new PostTurnWriter(extractor, memory, new FrozenClock(now), "extractor-model");
  extractor.enqueue({ content: JSON.stringify({
    facts: [{ content: "Suka mangga", category: "preferensi", origin: "stated" }],
    commitments: [
      { title: "Kemarin", eventAt: now - 1 },
      { title: "Rapat besok", eventAt: now + 60_000 },
    ],
  }), toolCalls: [] });

  await writer.enqueue({ userId: owner.id, ownerMessage: "campuran", messageId: "message-1" });

  assert.equal(memory.listActiveFacts(owner.id)[0]?.content, "Suka mangga");
  assert.deepEqual(memory.listPendingCommitments(owner.id).map((item) => item.title), ["Rapat besok"]);
});

test("writer rejects unknown keys inside fact and commitment objects", async () => {
  const { clock, extractor, memory, owner } = setup();
  const writer = new PostTurnWriter(extractor, memory, clock, "extractor-model");
  extractor.enqueue({ content: JSON.stringify({ facts: [{ content: "Suka kopi", category: "preferensi", origin: "stated", injected: true }], commitments: [] }), toolCalls: [] });
  await writer.enqueue({ userId: owner.id, ownerMessage: "aku suka kopi", messageId: "message-1" });
  extractor.enqueue({ content: JSON.stringify({ facts: [], commitments: [{ title: "Rapat", eventAt: now + 1, injected: true }] }), toolCalls: [] });
  await writer.enqueue({ userId: owner.id, ownerMessage: "rapat", messageId: "message-2" });

  assert.equal(memory.listActiveFacts(owner.id).length, 0);
  assert.equal(memory.listPendingCommitments(owner.id).length, 0);
});

test("memory search and schedule tools expose FTS and pending agenda", async () => {
  const { clock, memory, owner } = setup();
  memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "Aku liburan ke Bandung" });
  const tools = new ToolRegistry([createMemorySearchTool(memory), ...createScheduleTools(memory, clock)]);
  const context = { userId: owner.id };

  const search = await tools.execute("memory_search", { query: "liburan Bandung" }, context) as { messages: Array<{ content: string | null }> };
  const scheduled = await tools.execute("schedule_upsert", { title: "Rapat", eventAt: now + 60_000 }, context) as { remindAt: number | null };
  const agenda = await tools.execute("schedule_list", {}, context) as Array<{ title: string }>;

  assert.equal(search.messages[0]?.content, "Aku liburan ke Bandung");
  assert.equal(scheduled.remindAt, now - 74 * 60_000);
  assert.equal(agenda[0]?.title, "Rapat");
});

test("agent passes current persisted owner message to writer only after nonempty delivery", async () => {
  const { clock, extractor, memory, owner } = setup();
  const inbound: InboundEvent = { id: "inbound-1", userId: owner.id, text: "raw event text", receivedAt: now };
  const sent: string[] = [];
  const channel: Channel = { sendReply: async (_userId, text) => { sent.push(text); }, sendProactive: async () => undefined };
  const fake = new FakeLLMProvider();
  fake.enqueue({ content: "Hai", toolCalls: [] });
  extractor.enqueue({ content: JSON.stringify({ facts: [], commitments: [] }), toolCalls: [] });
  const writer = new PostTurnWriter(extractor, memory, clock, "extractor-model");
  const agent = new Agent(fake, memory, new ToolRegistry([]), channel, new ContextBuilder(memory, clock, "P", "G", "T"), clock, "chat-model", writer);
  const stored = memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "persisted owner text" });

  await agent.runInbound({ ...inbound, storedMessageId: stored.id });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(sent, ["Hai"]);
  assert.deepEqual(extractor.getRequests()[0]?.messages, [{ role: "user", content: "persisted owner text" }]);
});

test("agent keeps original persisted owner message when newer inbound arrives during delivery", async () => {
  const { clock, extractor, memory, owner } = setup();
  const first = memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "pesan pertama" });
  const channel: Channel = {
    sendReply: async () => { memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "pesan lebih baru" }); },
    sendProactive: async () => undefined,
  };
  const fake = new FakeLLMProvider();
  fake.enqueue({ content: "balasan pertama", toolCalls: [] });
  extractor.enqueue({ content: JSON.stringify({ facts: [], commitments: [] }), toolCalls: [] });
  const writer = new PostTurnWriter(extractor, memory, clock, "extractor-model");
  const agent = new Agent(fake, memory, new ToolRegistry([]), channel, new ContextBuilder(memory, clock, "P", "G", "T"), clock, "chat-model", writer);

  await agent.runInbound({ id: "inbound-1", userId: owner.id, text: "raw first", receivedAt: now, storedMessageId: first.id });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(extractor.getRequests()[0]?.messages, [{ role: "user", content: "pesan pertama" }]);
});

test("agent does not start writer when final content is empty or delivery fails", async () => {
  const { clock, extractor, memory, owner } = setup();
  const inbound: InboundEvent = { id: "inbound-1", userId: owner.id, text: "halo", receivedAt: now };
  const fake = new FakeLLMProvider();
  fake.enqueue({ content: "", toolCalls: [] });
  fake.enqueue({ content: "gagal terkirim", toolCalls: [] });
  const channel: Channel = { sendReply: async () => { throw new Error("delivery failed"); }, sendProactive: async () => undefined };
  const writer = new PostTurnWriter(extractor, memory, clock, "extractor-model");
  const agent = new Agent(fake, memory, new ToolRegistry([]), channel, new ContextBuilder(memory, clock, "P", "G", "T"), clock, "chat-model", writer);
  memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: inbound.text });

  await agent.runInbound(inbound);
  await agent.runInbound({ ...inbound, id: "inbound-2" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(extractor.getRequests().length, 0);
});
