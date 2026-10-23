import assert from "node:assert/strict";
import test from "node:test";
import { discoverTools } from "../tools/index.js";
import { resolve } from "node:path";

test("bare test script discovers source tests", () => {
  assert.ok(true);
});

test("source tool loader discovers TypeScript tools without index or unrelated files", async () => {
  const tools = await discoverTools(resolve("tests/source-tools"));
  assert.deepEqual(tools.map((tool) => tool.name), ["source_extension"]);
});
