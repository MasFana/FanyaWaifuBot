import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPersonaState } from "../src/core/persona-state.js";
import { applyOwnerSentiment, computeMood } from "../src/core/mood.js";

const tz = "Asia/Jakarta";

test("energy follows local hour", () => {
  const night = computeMood({ now: Date.UTC(2026, 9, 23, 18, 0), timeZone: tz, lastUserMessageAt: null, state: defaultPersonaState });
  assert.equal(night.energy, "rendah");
});

test("first-ever message does not produce NaN", () => {
  const mood = computeMood({ now: Date.UTC(2026, 9, 23, 5, 0), timeZone: tz, lastUserMessageAt: null, state: defaultPersonaState });
  assert.equal(mood.missYou, false);
  assert.doesNotMatch(mood.cue, /NaN|Infinity/u);
});

test("long gap sets missYou", () => {
  const now = Date.UTC(2026, 9, 23, 5, 0);
  const mood = computeMood({ now, timeZone: tz, lastUserMessageAt: now - 9 * 3_600_000, state: defaultPersonaState });
  assert.equal(mood.missYou, true);
});

test("system turns are ignored, rude text lowers affection", () => {
  const start = defaultPersonaState;
  assert.deepEqual(applyOwnerSentiment(start, "[SYSTEM COMMAND: x]", 0), start);
  const rude = applyOwnerSentiment(start, "ntahlah males", 0);
  assert.ok(rude.affection < start.affection);
});

test("ngambek influence is off while flag disabled", () => {
  const now = Date.UTC(2026, 9, 23, 5, 0);
  const state = { ...defaultPersonaState, ngambekUntil: now + 3_600_000 };
  const mood = computeMood({ now, timeZone: tz, lastUserMessageAt: now - 1_000, state });
  assert.equal(mood.ngambek, false);
  assert.doesNotMatch(mood.cue, /ngambek|dingin|cuek/u);
});