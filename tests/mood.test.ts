import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPersonaState } from "../src/core/persona-state.js";
import { applyOwnerSentiment, computeMood } from "../src/core/mood.js";

const tz = "Asia/Jakarta";

test("energy follows local hour", () => {
  const night = computeMood({ now: Date.UTC(2026, 9, 23, 18, 0), timeZone: tz, lastUserMessageAt: null, state: defaultPersonaState });
  assert.equal(night.energy, "rendah");
});

test("late-night local hour maps to low energy", () => {
  const mood = computeMood({ now: Date.UTC(2026, 9, 23, 15, 0), timeZone: tz, lastUserMessageAt: null, state: defaultPersonaState });
  assert.equal(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(Date.UTC(2026, 9, 23, 15, 0)), "22");
  assert.equal(mood.energy, "rendah");
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

test("rude message starts ngambek and a kind follow-up luluh", () => {
  const now = Date.UTC(2026, 9, 23, 5, 0);
  const rude = applyOwnerSentiment(defaultPersonaState, "ntahlah", now);
  assert.equal(rude.ngambekUntil, now + 5 * 3_600_000);
  assert.ok((rude.ngambekUntil ?? 0) > now);
  const kind = applyOwnerSentiment(rude, "maaf ya sayang", now + 1_000);
  assert.equal(kind.ngambekUntil, null);
});

test("rude detection uses word boundaries, not substrings", () => {
  assert.equal(applyOwnerSentiment(defaultPersonaState, "malesnya masih ada", 0).ngambekUntil, null);
  assert.equal(applyOwnerSentiment(defaultPersonaState, "terserahku begitu", 0).ngambekUntil, null);
  assert.equal(applyOwnerSentiment(defaultPersonaState, "gpp.", 0).ngambekUntil, 5 * 3_600_000);
  assert.equal(applyOwnerSentiment(defaultPersonaState, "diem aja", 0).ngambekUntil, 5 * 3_600_000);
});

test("affection decays toward baseline over elapsed time", () => {
  const now = Date.UTC(2026, 9, 23, 5, 0);
  const aged = { ...defaultPersonaState, affection: 1, updatedAt: now - 6 * 3_600_000 };
  const decayed = applyOwnerSentiment(aged, "halo", now);
  const expected = 0.7 + (1 - 0.7) * Math.exp(-1) + 0.05;
  assert.ok(decayed.affection < 1);
  assert.ok(decayed.affection > 0.7);
  assert.ok(Math.abs(decayed.affection - expected) < 1e-9);
});

test("fresh state (updatedAt 0) is treated as baseline, not over-decayed", () => {
  const now = Date.UTC(2026, 9, 23, 5, 0);
  const mood = applyOwnerSentiment(defaultPersonaState, "halo", now);
  assert.ok(mood.affection > 0.7);
});

test("applyOwnerSentiment returns a new object and does not mutate input", () => {
  const start = { ...defaultPersonaState, affection: 0.5, updatedAt: 1_000 };
  const snapshot = { ...defaultPersonaState, affection: 0.5, updatedAt: 1_000 };
  const result = applyOwnerSentiment(start, "kamu manis", 1_000);
  assert.notEqual(result, start);
  assert.deepEqual(start, snapshot);
});

test("ngambek influence is off while flag disabled", () => {
  const now = Date.UTC(2026, 9, 23, 5, 0);
  const state = { ...defaultPersonaState, ngambekUntil: now + 3_600_000 };
  const mood = computeMood({ now, timeZone: tz, lastUserMessageAt: now - 1_000, state });
  assert.equal(mood.ngambek, false);
  assert.doesNotMatch(mood.cue, /ngambek|dingin|cuek/u);
});
