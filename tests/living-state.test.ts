import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPersonaState, parsePersonaState } from "../src/core/persona-state.js";
import { activityPool, decideReply, renderStateCue, tickLivingState } from "../src/core/living-state.js";
import { computeMood } from "../src/core/mood.js";

const tz = "Asia/Jakarta";
const now = Date.UTC(2026, 9, 24, 10, 0);

test("old-shape settings_json parses to living defaults", () => {
  const state = parsePersonaState(JSON.stringify({
    affection: 0.5,
    ngambekUntil: null,
    recentOpenings: [],
    recentEndings: [],
    recentEmojis: [],
    updatedAt: 0,
  }));

  assert.equal(state.activity, null);
  assert.deepEqual(state.drives, { wantCompany: 0, wantToShare: 0, focus: 0, boundary: 0 });
});

test("tick picks a deterministic activity when idle", () => {
  const seedState = { ...defaultPersonaState, updatedAt: now - 1_000 };

  const first = tickLivingState(seedState, { now, lastUserMessageAt: now, seed: "owner" });
  const second = tickLivingState(seedState, { now, lastUserMessageAt: now, seed: "owner" });

  assert.ok(first.activity);
  assert.ok(activityPool.includes(first.activity.name));
  assert.ok(first.activity.endsAt > now);
  assert.deepEqual(first.activity, second.activity);
});

test("activity ending clears it and raises wantToShare", () => {
  const ended = { ...defaultPersonaState, updatedAt: now - 1_000, activity: { name: "baca novel bab terakhir", endsAt: now - 1 } };

  const next = tickLivingState(ended, { now, lastUserMessageAt: now, seed: "owner" });

  assert.equal(next.activity, null);
  assert.ok(next.drives.wantToShare > ended.drives.wantToShare);
});

test("long silence raises wantCompany and clamps to one", () => {
  const base = { ...defaultPersonaState, updatedAt: now - 3 * 3_600_000 };

  const next = tickLivingState(base, { now, lastUserMessageAt: now - 10 * 3_600_000, seed: "owner" });

  assert.ok(next.drives.wantCompany > 0);
  assert.ok(next.drives.wantCompany <= 1);
});

test("recent owner activity lowers wantCompany", () => {
  const base = { ...defaultPersonaState, updatedAt: now - 3_600_000, drives: { wantCompany: 0.9, wantToShare: 0, focus: 0, boundary: 0 } };

  const next = tickLivingState(base, { now, lastUserMessageAt: now, seed: "owner" });

  assert.ok(next.drives.wantCompany < 0.9);
});

test("decideReply defers only when an activity is active and focus is high", () => {
  const focused = { ...defaultPersonaState, activity: { name: "baca novel bab terakhir", endsAt: now + 3_600_000 }, drives: { wantCompany: 0, wantToShare: 0, focus: 0.9, boundary: 0 } };

  assert.equal(decideReply(focused, { focusThreshold: 0.6 }), "defer");
  assert.equal(decideReply({ ...focused, activity: null }, { focusThreshold: 0.6 }), "reply");
  assert.equal(decideReply(defaultPersonaState, { focusThreshold: 0.6 }), "reply");
});

test("renderStateCue has no NaN or Infinity for default state", () => {
  const mood = computeMood({ now, timeZone: tz, lastUserMessageAt: null, state: defaultPersonaState });

  const cue = renderStateCue(defaultPersonaState, mood);

  assert.doesNotMatch(cue, /NaN|Infinity/u);
});