import assert from "node:assert/strict";
import test from "node:test";
import type { LLMRequest } from "../src/core/types.js";
import { FakeLLMProvider } from "../src/llm/fake.js";
import { OpenAIProvider, type ChatCompletionClient } from "../src/llm/openai.js";

const request: LLMRequest = {
  model: "test-model",
  messages: [
    { role: "system", content: "Be helpful" },
    { role: "assistant", content: null, toolCalls: [{ id: "old-call", name: "memory_search", arguments: { query: "kopi" } }] },
    { role: "tool", content: "found coffee", toolCallId: "old-call" },
  ],
  tools: [{ name: "memory_search", description: "Find memories", parameters: { type: "object", properties: { query: { type: "string" } } } }],
};

test("fake provider returns queued responses and captures immutable request order", async () => {
  const fake = new FakeLLMProvider();
  const queued = { content: "hai", toolCalls: [{ id: "queued-call", name: "memory_search", arguments: { query: "kopi" } }] };
  fake.enqueue(queued);
  queued.toolCalls[0]!.arguments["query"] = "teh";

  const response = await fake.complete(request);

  assert.equal(response.content, "hai");
  assert.equal(response.toolCalls[0]?.arguments["query"], "kopi");
  const captured = fake.getRequests();
  captured[0]!.messages[0]!.content = "mutated";
  assert.deepEqual(fake.getRequests(), [request]);
  await assert.rejects(fake.complete(request), /FakeLLMProvider queue is empty/);
});

test("fake provider returns cloned queued errors", async () => {
  const fake = new FakeLLMProvider();
  const queued = Object.assign(new Error("offline"), { code: "ECONNRESET" });
  fake.enqueue(queued);

  const thrown = await fake.complete(request).then(
    () => assert.fail("Expected queued error"),
    (error: unknown) => error,
  );
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "offline");
  thrown.message = "mutated";
  assert.equal(queued.message, "offline");
  assert.equal(queued.code, "ECONNRESET");
});

test("OpenAI provider maps messages, tools, and tool-call JSON", async () => {
  const calls: unknown[] = [];
  const client: ChatCompletionClient = {
    async create(input) {
      calls.push(input);
      return {
        choices: [{ message: { content: null, tool_calls: [{ id: "new-call", function: { name: "memory_search", arguments: '{"query":"teh"}' } }] } }],
      };
    },
  };
  const provider = new OpenAIProvider(client, async () => {});

  const response = await provider.complete(request);

  assert.deepEqual(response, { content: null, toolCalls: [{ id: "new-call", name: "memory_search", arguments: { query: "teh" } }] });
  assert.deepEqual(calls, [{
    model: "test-model",
    messages: [
      { role: "system", content: "Be helpful" },
      { role: "assistant", content: null, tool_calls: [{ id: "old-call", type: "function", function: { name: "memory_search", arguments: '{"query":"kopi"}' } }] },
      { role: "tool", content: "found coffee", tool_call_id: "old-call" },
    ],
    tools: [{ type: "function", function: { name: "memory_search", description: "Find memories", parameters: { type: "object", properties: { query: { type: "string" } } } } }],
  }]);
});

test("OpenAI provider retries 429, 5xx, and proven network failures no more than three attempts", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const client: ChatCompletionClient = {
    async create() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      if (attempts === 2) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
      return { choices: [{ message: { content: "pulih" } }] };
    },
  };
  const provider = new OpenAIProvider(client, async (milliseconds) => { delays.push(milliseconds); });

  assert.equal((await provider.complete(request)).content, "pulih");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("OpenAI provider does not retry non-retryable failures", async () => {
  let attempts = 0;
  const client: ChatCompletionClient = {
    async create() {
      attempts += 1;
      throw Object.assign(new Error("bad request"), { status: 400 });
    },
  };
  const provider = new OpenAIProvider(client, async () => { throw new Error("must not sleep"); });

  await assert.rejects(provider.complete(request));
  assert.equal(attempts, 1);
});

test("OpenAI provider does not retry unrelated TypeError", async () => {
  let attempts = 0;
  const client: ChatCompletionClient = {
    async create() {
      attempts += 1;
      throw new TypeError("invalid local state");
    },
  };
  const provider = new OpenAIProvider(client, async () => { throw new Error("must not sleep"); });

  await assert.rejects(provider.complete(request), /invalid local state/);
  assert.equal(attempts, 1);
});

test("OpenAI provider does not retry status 600", async () => {
  let attempts = 0;
  const client: ChatCompletionClient = {
    async create() {
      attempts += 1;
      throw Object.assign(new Error("invalid status"), { status: 600 });
    },
  };
  const provider = new OpenAIProvider(client, async () => { throw new Error("must not sleep"); });

  await assert.rejects(provider.complete(request), (error: unknown) => error instanceof Error && (error as Error & { status?: unknown }).status === 600);
  assert.equal(attempts, 1);
});

test("OpenAI provider does not retry AbortError or network-looking plain objects", async () => {
  for (const failure of [Object.assign(new Error("aborted"), { name: "AbortError" }), { code: "ECONNRESET" }, { name: "NetworkError" }]) {
    let attempts = 0;
    const client: ChatCompletionClient = { async create() { attempts += 1; throw failure; } };
    const provider = new OpenAIProvider(client, async () => { throw new Error("must not sleep"); });

    await assert.rejects(provider.complete(request));
    assert.equal(attempts, 1);
  }
});
