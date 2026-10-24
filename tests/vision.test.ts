import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { Agent } from "../src/core/agent.js";
import { FrozenClock } from "../src/core/clock.js";
import { ContextBuilder } from "../src/core/context.js";
import type { Channel, ContentPart, InboundEvent } from "../src/core/types.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { FakeLLMProvider } from "../src/llm/fake.js";
import { MemoryService } from "../src/memory/service.js";
import { ToolRegistry } from "../src/tools/index.js";

const now = Date.UTC(2026, 9, 23, 12, 45);
const databases: Database.Database[] = [];

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

class TestChannel implements Channel {
  readonly sent: string[] = [];
  async sendReply(_userId: string, text: string): Promise<void> { this.sent.push(text); }
  async sendProactive(): Promise<void> {}
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
  const agent = new Agent(fake, memory, new ToolRegistry([]), channel, context, clock, "test-model");
  return { agent, channel, fake, memory, owner };
}

const image = { dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" };

test("context build attaches images as image_url parts on the final user turn", async () => {
  const { memory, owner } = setup();
  const builder = new ContextBuilder(memory, new FrozenClock(now), "Persona", "Guardrails", "Tools");

  const messages = await builder.build({ userId: owner.id, inboundText: "lihat ini", images: [image] });

  assert.deepEqual(messages.at(-1), {
    role: "user",
    content: [
      { type: "text", text: "lihat ini" },
      { type: "image_url", dataUrl: "data:image/jpeg;base64,AAAA" },
    ],
  });
});

test("context build keeps a plain string when no images are present", async () => {
  const { memory, owner } = setup();
  const builder = new ContextBuilder(memory, new FrozenClock(now), "Persona", "Guardrails", "Tools");

  const messages = await builder.build({ userId: owner.id, inboundText: "halo biasa" });

  assert.deepEqual(messages.at(-1), { role: "user", content: "halo biasa" });
});

test("agent strips images and retries text-only when the provider rejects vision", async () => {
  const { agent, channel, fake, owner } = setup();
  const inbound: InboundEvent = { id: "inbound-1", userId: owner.id, text: "lihat ini", receivedAt: now, images: [image] };
  fake.enqueue(new Error("vision unsupported"));
  fake.enqueue({ content: "wah keren", toolCalls: [] });

  await agent.runInbound(inbound);

  assert.deepEqual(channel.sent, ["wah keren"]);
  const requests = fake.getRequests();
  assert.equal(requests.length, 2);
  assert.ok(requests[0]!.messages.some((message) => Array.isArray(message.content) && message.content.some((part: ContentPart) => part.type === "image_url")));
  const second = requests[1]!;
  assert.ok(!second.messages.some((message) => Array.isArray(message.content) && message.content.some((part: ContentPart) => part.type === "image_url")));
  assert.ok(second.messages.some((message) => message.role === "user" && message.content === "lihat ini"));
});
