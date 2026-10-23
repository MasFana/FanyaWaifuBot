import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPersonaState, extractTraits, mergeTraits, parsePersonaState } from "../src/core/persona-state.js";

test("parsePersonaState defaults on corrupt or absent json", () => {
  assert.deepEqual(parsePersonaState(null), defaultPersonaState);
  assert.deepEqual(parsePersonaState("{not json"), defaultPersonaState);
  assert.deepEqual(parsePersonaState('{"affection":"x"}'), defaultPersonaState);
});

test("extractTraits is safe on plain text", () => {
  assert.deepEqual(extractTraits("iyaa"), { opening: "iyaa", ending: "iyaa", emojis: [] });
  assert.deepEqual(extractTraits(""), { opening: "", ending: "", emojis: [] });
});

test("mergeTraits caps recent lists and keeps newest last", () => {
  let state = defaultPersonaState;
  for (const end of ["a", "b", "c", "d", "e", "f"]) {
    state = mergeTraits(state, { opening: end, ending: end, emojis: [] });
  }
  assert.deepEqual(state.recentEndings, ["b", "c", "d", "e", "f"]);
});
