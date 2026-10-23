import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { FrozenClock } from "../src/core/clock.js";
import type { WakeupEvent } from "../src/core/types.js";

const productionEnv = {
  LLM_API_KEY: "test-key",
  TELEGRAM_BOT_TOKEN: "test-token",
};

test("loadConfig rejects missing LLM API key", () => {
  assert.throws(() => loadConfig({}), /LLM_API_KEY/);
});

test("loadConfig applies PRD defaults to deployment config", () => {
  const config = loadConfig(productionEnv);

  assert.equal(config.llm.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.llm.model, "gpt-4o");
  assert.equal(config.llm.extractorModel, "gpt-4o-mini");
  assert.equal(config.owner.timezone, "Asia/Jakarta");
  assert.equal(config.heartbeat.intervalMs, 60_000);
  assert.equal(config.heartbeat.quietHours.start, "23:30");
  assert.equal(config.heartbeat.quietHours.end, "06:30");
  assert.equal(config.heartbeat.spontaneousIdleHours, 6);
  assert.equal(config.heartbeat.maxUnansweredProactive, 2);
  assert.equal(config.replies.debounceMs, 4_000);
  assert.equal(config.replies.deferExtraMs, 60_000);
  assert.equal(config.replies.maxBubbles, 4);
  assert.equal(config.replies.focusDeferThreshold, 0.6);
  assert.equal(config.replies.ngambekEnabled, false);
});

test("loadConfig rejects an invalid owner IANA timezone", () => {
  assert.throws(
    () => loadConfig({ ...productionEnv, OWNER_TIMEZONE: "Mars/Olympus" }),
    /OWNER_TIMEZONE/,
  );
});

test("loadConfig requires Telegram token outside test overrides", () => {
  assert.throws(() => loadConfig({ LLM_API_KEY: "test-key" }), /TELEGRAM_BOT_TOKEN/);
});

test("loadConfig permits missing composition credentials in test mode", () => {
  const config = loadConfig({ NODE_ENV: "test" });

  assert.equal(config.llm.apiKey, "");
  assert.equal(config.telegram.botToken, "");
});

test("WakeupEvent exposes the Task 9 triggerType contract", () => {
  const wakeup: WakeupEvent = { userId: "123", triggerType: "agenda_reminder" };

  assert.equal(wakeup.triggerType, "agenda_reminder");
});

test("FrozenClock keeps its supplied epoch milliseconds", () => {
  const clock = new FrozenClock(100);

  assert.equal(clock.now(), 100);
});
