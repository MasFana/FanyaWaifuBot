import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("persona drops quotable example utterances but keeps shape rules", async () => {
  const persona = await readFile("harness/persona.md", "utf8");
  for (const artifact of ["pagiiiii", "asdfghjkl", "bikin aku salting tiba-tiba", "jantung aku jedag jedug"]) {
    assert.equal(persona.includes(artifact), false, `leaked example: ${artifact}`);
  }
  assert.match(persona, /Bentuk balon/u);
  assert.match(persona, /jangan pakai bullet/u);
});
