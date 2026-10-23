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

test("persona grants agency and drops fixed bubble rules", async () => {
  const persona = await readFile("harness/persona.md", "utf8");
  assert.doesNotMatch(persona, /maksimum 3 balon|~30% balasan|maksimum 3 bubble/u);
  assert.match(persona, /putuskan sendiri/u);
  assert.match(persona, /boleh (diam|nolak)/u);
});
