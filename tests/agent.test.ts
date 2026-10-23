import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { z } from "zod";
import { Agent } from "../src/core/agent.js";
import { FrozenClock } from "../src/core/clock.js";
import { ContextBuilder } from "../src/core/context.js";
import type { Channel, InboundEvent, OutboundMedia, ToolDefinition } from "../src/core/types.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { FakeLLMProvider } from "../src/llm/fake.js";
import { defaultPersonaState } from "../src/core/persona-state.js";
import { MemoryService } from "../src/memory/service.js";
import { ToolRegistry, createBuiltinTools } from "../src/tools/index.js";

const now = Date.UTC(2026, 9, 23, 12, 45);
const databases: Database.Database[] = [];

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

class TestChannel implements Channel {
  readonly sent: Array<{ userId: string; text: string; proactive: boolean }> = [];
  async sendReply(userId: string, text: string): Promise<void> { this.sent.push({ userId, text, proactive: false }); }
  async sendProactive(userId: string, text: string): Promise<void> { this.sent.push({ userId, text, proactive: true }); }
}

function setup() {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(now);
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const channel = new TestChannel();
  const fake = new FakeLLMProvider();
  const context = new ContextBuilder(memory, clock, "Fanya persona", "Safety rules", "Tool guidance");
  const agent = new Agent(fake, memory, new ToolRegistry(createBuiltinTools({ clock, timeZone: "Asia/Jakarta" })), channel, context, clock, "test-model");
  const inbound: InboundEvent = { id: "inbound-1", userId: owner.id, text: "Berapa 2+2?", receivedAt: now };
  memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: inbound.text });
  return { agent, channel, database, fake, inbound, memory, owner };
}

test("agent executes tool, persists complete tool history, and delivers final reply", async () => {
  const { agent, channel, database, fake, inbound } = setup();
  fake.enqueue({ content: null, toolCalls: [{ id: "call-1", name: "utility_calculate", arguments: { expression: "2+2" } }] });
  fake.enqueue({ content: "Empat, yang 😊", toolCalls: [] });

  await agent.runInbound(inbound);

  assert.match(channel.sent[0]?.text ?? "", /Empat/u);
  assert.deepEqual(database.prepare("SELECT status, result_json FROM tool_events WHERE tool_call_id = ?").get("call-1"), { status: "ok", result_json: "4" });
  assert.equal((database.prepare("SELECT tool_call_id FROM messages WHERE role = 'tool'").get() as { tool_call_id: string }).tool_call_id, "call-1");
  assert.equal((database.prepare("SELECT status FROM agent_runs").get() as { status: string }).status, "completed");
});

test("second inbound replays stored assistant tool call directly before matching tool result", async () => {
  const { agent, fake, inbound, memory, owner } = setup();
  fake.enqueue({ content: null, toolCalls: [{ id: "persisted-call", name: "utility_calculate", arguments: { expression: "2+2" } }] });
  fake.enqueue({ content: "empat", toolCalls: [] });
  await agent.runInbound(inbound);

  memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "lanjut" });
  fake.enqueue({ content: "lanjut ya", toolCalls: [] });
  await agent.runInbound({ ...inbound, id: "inbound-2", text: "lanjut" });

  const messages = fake.getRequests()[2]?.messages ?? [];
  const assistantIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === "persisted-call");
  assert.ok(assistantIndex >= 0);
  assert.deepEqual(messages[assistantIndex + 1], { role: "tool", content: "4", toolCallId: "persisted-call" });
});

test("agent records failed tool calls, supplies result message, and ends error after exactly six cycles without throwing", async () => {
  const { agent, database, fake, inbound } = setup();
  for (let index = 0; index < 6; index += 1) {
    fake.enqueue({ content: null, toolCalls: [{ id: `bad-${index}`, name: "missing", arguments: {} }] });
  }

  await agent.runInbound(inbound);

  assert.equal((database.prepare("SELECT count(*) AS count FROM tool_events WHERE status = 'error'").get() as { count: number }).count, 6);
  assert.equal((database.prepare("SELECT status FROM agent_runs").get() as { status: string }).status, "failed");
  assert.equal((database.prepare("SELECT count(*) AS count FROM messages WHERE role = 'tool'").get() as { count: number }).count, 6);
  assert.equal(fake.getRequests().length, 6);
});

test("tool event and tool transcript insert atomically", () => {
  const { database, memory, owner } = setup();

  assert.throws(() => memory.recordToolResult("missing-run", owner.id, { id: "call-1", name: "missing", arguments: {} }, { error: "nope" }, "error", 0), /FOREIGN KEY/u);

  assert.equal((database.prepare("SELECT count(*) AS count FROM tool_events").get() as { count: number }).count, 0);
  assert.equal((database.prepare("SELECT count(*) AS count FROM messages WHERE role = 'tool'").get() as { count: number }).count, 0);
});

test("agent contains LLM and delivery errors while marking run failed", async () => {
  const { agent, channel, database, fake, inbound } = setup();
  fake.enqueue(new Error("provider down"));
  await agent.runInbound(inbound);
  assert.equal((database.prepare("SELECT status FROM agent_runs").get() as { status: string }).status, "failed");

  fake.enqueue({ content: "halo", toolCalls: [] });
  channel.sendReply = async () => { throw new Error("telegram down"); };
  await agent.runInbound({ ...inbound, id: "inbound-2" });
  assert.equal((database.prepare("SELECT count(*) AS count FROM agent_runs WHERE status = 'failed'").get() as { count: number }).count, 2);
});

test("agent passes channel media delivery into the tool context", async () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(now);
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const delivered: OutboundMedia[] = [];
  const channel: Channel = {
    sendReply: async () => {},
    sendProactive: async () => {},
    sendMedia: async (_userId, media) => { delivered.push(media); return "media"; },
  };
  const probe: ToolDefinition = {
    name: "send_probe",
    description: "Probe media delivery.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    argumentSchema: z.object({}).strict(),
    async execute(_arguments_, context) {
      return context.sendMedia ? await context.sendMedia({ kind: "video", url: "https://cdn/v.mp4" }) : "none";
    },
  };
  const fake = new FakeLLMProvider();
  const context = new ContextBuilder(memory, clock, "Fanya persona", "Safety rules", "Tool guidance");
  const agent = new Agent(fake, memory, new ToolRegistry([probe]), channel, context, clock, "test-model");
  memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "kirim vid" });
  fake.enqueue({ content: null, toolCalls: [{ id: "media-call", name: "send_probe", arguments: {} }] });
  fake.enqueue({ content: "sudah dikirim", toolCalls: [] });

  await agent.runInbound({ id: "inbound-media", userId: owner.id, text: "kirim vid", receivedAt: now });

  assert.deepEqual(delivered, [{ kind: "video", url: "https://cdn/v.mp4" }]);
});

test("agent records reply traits into persona state after delivery", async () => {
  const { agent, fake, inbound, memory, owner } = setup();
  fake.enqueue({ content: "halo 🤍", toolCalls: [] });

  await agent.runInbound(inbound);

  const persona = memory.getPersonaState(owner.id);
  assert.ok(persona.recentEndings.includes("🤍"));
  assert.ok(persona.recentEmojis.includes("🤍"));
});

test("greeting wakeup tells the model the correct time slot", async () => {
  const { agent, fake, owner } = setup();
  fake.enqueue({ content: "malam", toolCalls: [] });

  await agent.runWakeup({ userId: owner.id, triggerType: "greeting", greeting: "night" });

  const turn = fake.getRequests()[0]?.messages.at(-1)?.content ?? "";
  assert.match(turn, /malam/u);
  assert.doesNotMatch(turn, /pagi/u);
});

test("context includes a persisted inbound message exactly once", async () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(now);
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const stored = memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "Halo" });
  const fake = new FakeLLMProvider();
  const context = new ContextBuilder(memory, clock, "Fanya persona", "Safety rules", "Tool guidance");
  const agent = new Agent(fake, memory, new ToolRegistry([]), new TestChannel(), context, clock, "test-model");
  fake.enqueue({ content: "Halo juga", toolCalls: [] });

  await agent.runInbound({ id: "inbound-once", userId: owner.id, text: "Halo", receivedAt: now, storedMessageId: stored.id });

  const messages = fake.getRequests()[0]?.messages ?? [];
  assert.equal(messages.filter((message) => message.role === "user" && message.content === "Halo").length, 1);
});

test("context includes complete PRD dynamic blocks and honors agenda/history boundaries", async () => {
  const { database, memory, owner } = setup();
  memory.upsertFact(owner.id, { content: "Suka teh hijau", category: "preferensi", origin: "stated" });
  memory.upsertCommitment(owner.id, { title: "Presentasi", eventAt: now + 60 * 60_000, remindAt: now + 30 * 60_000, followUpAt: now + 2 * 60 * 60_000, contextNotes: "bawa slide" });
  memory.upsertCommitment(owner.id, { title: "Batas tiga hari", eventAt: now + 3 * 86_400_000, contextNotes: "masuk" });
  memory.upsertCommitment(owner.id, { title: "Terlalu jauh", eventAt: now + 3 * 86_400_000 + 1, contextNotes: "jangan masuk" });
  database.prepare("UPDATE users SET last_user_message_at = ? WHERE id = ?").run(now - 80 * 60_000, owner.id);
  memory.setPersonaState(owner.id, { ...defaultPersonaState, affection: 0.4 });
  database.prepare("UPDATE conversations SET summary = ? WHERE user_id = ?").run("Ringkasan lama", owner.id);
  for (let index = 0; index < 21; index += 1) memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: `riwayat-${index}` });
  const builder = new ContextBuilder(memory, new FrozenClock(now), "Persona", "Guardrails", "Tools");

  const messages = await builder.build({ userId: owner.id, inboundText: "halo" });

  const text = messages.map((message) => message.content).join("\n");
  assert.match(text, /Persona.*Guardrails.*Tools/us);
  assert.match(text, /1 jam 20 menit yang lalu.*Suasana hati sekarang: hangat; afeksi 0\.4.*Suka teh hijau.*Presentasi.*bawa slide.*Batas tiga hari.*Ringkasan lama.*halo/us);
  assert.doesNotMatch(text, /Terlalu jauh|riwayat-0/u);
  assert.match(text, /riwayat-20/u);
});
