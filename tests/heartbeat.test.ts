import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { FrozenClock } from "../src/core/clock.js";
import { HeartbeatEngine } from "../src/core/heartbeat.js";
import type { AgentOutcome } from "../src/core/agent.js";
import type { WakeupEvent } from "../src/core/types.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { MemoryService } from "../src/memory/service.js";
import { defaultPersonaState } from "../src/core/persona-state.js";
import { createTestConfig } from "./helpers.js";

const hour = 60 * 60_000;
const databases: Database.Database[] = [];

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

class FakeAgent {
  readonly wakeups: WakeupEvent[] = [];
  outcome: AgentOutcome = { status: "completed", delivered: true };
  rejectNext = false;

  async runWakeup(wakeup: WakeupEvent): Promise<AgentOutcome> {
    this.wakeups.push(wakeup);
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("wakeup failed");
    }
    return this.outcome;
  }
}

function setup(at: number, intervalMs = 60_000) {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(at);
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const agent = new FakeAgent();
  const heartbeat = new HeartbeatEngine(memory, agent, clock, createTestConfig({ heartbeat: { ...createTestConfig().heartbeat, intervalMs } }));
  return { agent, clock, heartbeat, memory, owner };
}

test("heartbeat atomically claims each due reminder before wakeup", async () => {
  const { agent, clock, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 12));
  const commitment = memory.upsertCommitment(owner.id, { title: "Rapat", eventAt: clock.now() + hour, remindAt: clock.now() });

  await Promise.all([heartbeat.tick(), heartbeat.tick()]);

  assert.deepEqual(agent.wakeups.filter((wakeup) => wakeup.triggerType === "agenda_reminder"), [{ userId: owner.id, triggerType: "agenda_reminder", commitmentId: commitment.id }]);
});

test("heartbeat reverts a skipped reminder claim for next tick", async () => {
  const { agent, clock, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 12));
  memory.upsertCommitment(owner.id, { title: "Rapat", eventAt: clock.now() + hour, remindAt: clock.now() });
  agent.outcome = { status: "skipped" };

  await heartbeat.tick();
  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "agenda_reminder").length, 2);
});

test("heartbeat blocks spontaneous care during midnight-crossing quiet hours", async () => {
  const twoAmJakarta = Date.UTC(2026, 9, 23, 19);
  const { agent, clock, heartbeat, memory, owner } = setup(twoAmJakarta - 7 * hour);
  memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "halo" });
  memory.recordOwnerActivity(owner.id);
  clock.set(twoAmJakarta);

  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "spontaneous").length, 0);
  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "greeting").length, 0);
});

test("heartbeat uses persisted quiet hours instead of stale config defaults", async () => {
  const { agent, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 12));
  memory.setQuietHours(owner.id, "00:00", "23:59");
  memory.recordOwnerActivity(owner.id);

  await heartbeat.tick();

  assert.equal(agent.wakeups.length, 0);
});

test("heartbeat retries reminder after failed agent result", async () => {
  const { agent, clock, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 12));
  memory.upsertCommitment(owner.id, { title: "Rapat", eventAt: clock.now() + hour, remindAt: clock.now() });
  agent.outcome = { status: "failed" };

  await heartbeat.tick();
  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "agenda_reminder").length, 2);
});

test("heartbeat retries reminder when agent rejects after claim", async () => {
  const { agent, clock, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 12));
  memory.upsertCommitment(owner.id, { title: "Rapat", eventAt: clock.now() + hour, remindAt: clock.now() });
  agent.rejectNext = true;

  await heartbeat.tick();
  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "agenda_reminder").length, 2);
});

test("heartbeat timer survives rejected tick and can be stopped", async () => {
  const { agent, heartbeat } = setup(Date.UTC(2026, 9, 23, 12), 1);
  agent.rejectNext = true;
  heartbeat.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  heartbeat.stop();

  assert.ok(agent.wakeups.length >= 1);
});

test("heartbeat initiates spontaneous care when a drive is high", async () => {
  const { agent, clock, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 10));
  memory.setPersonaState(owner.id, { ...defaultPersonaState, updatedAt: clock.now(), drives: { wantCompany: 0, wantToShare: 0.9, focus: 0, boundary: 0 } });

  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "spontaneous").length, 1);
});

test("heartbeat blocks drive initiative during quiet hours", async () => {
  const { agent, clock, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 19));
  memory.setPersonaState(owner.id, { ...defaultPersonaState, updatedAt: clock.now(), drives: { wantCompany: 0, wantToShare: 0.9, focus: 0, boundary: 0 } });

  await heartbeat.tick();

  assert.equal(agent.wakeups.length, 0);
});

test("heartbeat blocks drive initiative after maximum unanswered proactive messages", async () => {
  const { agent, clock, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 10));
  memory.setPersonaState(owner.id, { ...defaultPersonaState, updatedAt: clock.now(), drives: { wantCompany: 0, wantToShare: 0.9, focus: 0, boundary: 0 } });
  memory.setUnansweredProactiveCount(owner.id, 2);

  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "spontaneous").length, 0);
});

test("heartbeat greeting preempts drive initiative on the same tick", async () => {
  const { agent, clock, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 1));
  memory.setPersonaState(owner.id, { ...defaultPersonaState, updatedAt: clock.now(), drives: { wantCompany: 0, wantToShare: 0.9, focus: 0, boundary: 0 } });

  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "greeting").length, 1);
  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "spontaneous").length, 0);
});

test("heartbeat allows drive initiative once the daily greeting was already sent", async () => {
  const { agent, clock, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 1));
  memory.setPersonaState(owner.id, { ...defaultPersonaState, updatedAt: clock.now(), drives: { wantCompany: 0, wantToShare: 0.9, focus: 0, boundary: 0 } });

  await heartbeat.tick();
  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "greeting").length, 1);
  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "spontaneous").length, 1);
});

test("heartbeat backs off spontaneous care after maximum unanswered proactive messages", async () => {
  const { agent, heartbeat, memory, owner } = setup(Date.UTC(2026, 9, 23, 3));
  memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "halo" });
  memory.setUnansweredProactiveCount(owner.id, 2);

  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "spontaneous").length, 0);
  assert.equal(memory.getUnansweredProactiveCount(owner.id), 2);
});

test("heartbeat sends each daily greeting once", async () => {
  const { agent, heartbeat } = setup(Date.UTC(2026, 9, 23, 1));

  await heartbeat.tick();
  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "greeting").length, 1);
});

test("heartbeat retries greeting when agent rejects after claim", async () => {
  const { agent, heartbeat } = setup(Date.UTC(2026, 9, 23, 1));
  agent.rejectNext = true;

  await heartbeat.tick();
  await heartbeat.tick();

  assert.equal(agent.wakeups.filter((wakeup) => wakeup.triggerType === "greeting").length, 2);
});

test("heartbeat uses configured owner after first claimant changes", async () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(Date.UTC(2026, 9, 23, 12));
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  const oldOwner = memory.claimOwner("telegram", "old-owner");
  assert.ok(oldOwner);
  const configuredOwner = memory.ensureOwner("telegram", "new-owner");
  const commitment = memory.upsertCommitment(configuredOwner.id, { title: "Rapat", eventAt: clock.now() + hour, remindAt: clock.now() });
  memory.upsertCommitment(oldOwner.id, { title: "Rahasia lama", eventAt: clock.now() + hour, remindAt: clock.now() });
  const agent = new FakeAgent();
  const config = createTestConfig({ telegram: { botToken: "test", ownerId: "new-owner" } });
  const heartbeat = new HeartbeatEngine(memory, agent, clock, config);

  await heartbeat.tick();

  assert.deepEqual(agent.wakeups.filter((wakeup) => wakeup.triggerType === "agenda_reminder"), [{ userId: configuredOwner.id, triggerType: "agenda_reminder", commitmentId: commitment.id }]);
  assert.equal(agent.wakeups.some((wakeup) => wakeup.userId === oldOwner.id), false);
});
