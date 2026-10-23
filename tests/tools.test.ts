import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { FrozenClock } from "../src/core/clock.js";
import type { ToolContext, ToolDefinition } from "../src/core/types.js";
import { createBuiltinTools, ToolRegistry } from "../src/tools/index.js";

const context: ToolContext = { userId: "owner-1" };

test("registry validates Zod arguments before invoking a handler", async () => {
  let invoked = false;
  const tool: ToolDefinition = {
    name: "echo",
    description: "Returns input text.",
    parameters: { type: "object" },
    argumentSchema: z.object({ text: z.string().min(1) }).strict(),
    async execute(arguments_) {
      invoked = true;
      return arguments_["text"];
    },
  };
  const tools = new ToolRegistry([tool]);

  await assert.rejects(tools.execute("echo", { text: "" }, context), /Invalid arguments/);
  assert.equal(invoked, false);
  assert.equal(await tools.execute("echo", { text: "halo" }, context), "halo");
  await assert.rejects(tools.execute("missing", {}, context), /Unknown tool/);
});

test("built-in datetime formats injected clock in owner timezone", async () => {
  const tools = new ToolRegistry(createBuiltinTools({ clock: new FrozenClock(Date.UTC(2026, 9, 23, 12, 45)), timeZone: "Asia/Jakarta" }));

  assert.match(String(await tools.execute("system_get_datetime", {}, context)), /23 Oktober 2026.*19[.:]45/u);
});

test("calculator evaluates bounded arithmetic grammar", async () => {
  const tools = new ToolRegistry(createBuiltinTools({ clock: new FrozenClock(0), timeZone: "UTC" }));

  assert.equal(await tools.execute("utility_calculate", { expression: "(2 + 3) * 4" }, context), 20);
  assert.equal(await tools.execute("utility_calculate", { expression: "2 ** 3 ** 2 - 500" }, context), 12);
  assert.equal(await tools.execute("utility_calculate", { expression: "-3.5 % 2" }, context), -1.5);
});

test("calculator rejects executable, malformed, and resource-exhausting input", async () => {
  const tools = new ToolRegistry(createBuiltinTools({ clock: new FrozenClock(0), timeZone: "UTC" }));

  for (const expression of ["process.exit()", "Math.constructor", "1 / 0", "1 +".repeat(600), "(".repeat(33) + "1" + ")".repeat(33)]) {
    await assert.rejects(tools.execute("utility_calculate", { expression }, context));
  }
});
