import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { FrozenClock } from "../src/core/clock.js";
import type { ToolContext, ToolDefinition } from "../src/core/types.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { MemoryService } from "../src/memory/service.js";
import { createBuiltinTools, ToolRegistry } from "../src/tools/index.js";
import { createScheduleTools } from "../src/tools/schedule.js";

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

test("schedule_upsert accepts an ISO date-time and stores millisecond timestamps", async () => {
  const clock = new FrozenClock(Date.UTC(2026, 9, 25, 0, 0));
  const database = openDatabase(":memory:");
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const tools = new ToolRegistry(createScheduleTools(memory, clock));

  await tools.execute("schedule_upsert", {
    title: "Beli obat ke toko pak nur",
    eventAt: "2026-10-25T09:00:00+07:00",
    remindAt: "2026-10-25T09:00:00+07:00",
  }, { userId: owner.id });

  assert.equal(memory.listPendingCommitments(owner.id)[0]?.eventAt, Date.UTC(2026, 9, 25, 2, 0));
  database.close();
});

test("schedule_upsert rejects Unix seconds", async () => {
  const clock = new FrozenClock(Date.UTC(2026, 9, 25, 0, 0));
  const database = openDatabase(":memory:");
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const tools = new ToolRegistry(createScheduleTools(memory, clock));

  await assert.rejects(
    tools.execute("schedule_upsert", { title: "Beli obat", eventAt: 1792976400 }, { userId: owner.id }),
    /Invalid arguments/u,
  );
  database.close();
});
