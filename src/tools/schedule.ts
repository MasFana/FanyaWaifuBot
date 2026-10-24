import { z } from "zod";
import type { Clock } from "../core/clock.js";
import type { ToolDefinition } from "../core/types.js";
import type { MemoryService } from "../memory/service.js";

const dateTime = z.union([z.string().datetime({ offset: true }), z.number().int().min(1_000_000_000_000)]);

export function createScheduleTools(memory: MemoryService, _clock: Clock): readonly ToolDefinition[] {
  return [
    {
      name: "schedule_upsert",
      description: "Create or update future owner schedule commitment.",
      parameters: { type: "object", properties: { title: { type: "string" }, eventAt: { type: "string", description: "ISO 8601 date-time with UTC offset, e.g. 2026-10-25T09:00:00+07:00" }, remindAt: { type: "string", description: "ISO 8601 date-time with UTC offset" }, followUpAt: { type: "string", description: "ISO 8601 date-time with UTC offset" }, contextNotes: { type: "string" } }, required: ["title", "eventAt"], additionalProperties: false },
      argumentSchema: z.object({ title: z.string().min(1), eventAt: dateTime, remindAt: dateTime.optional(), followUpAt: dateTime.optional(), contextNotes: z.string().optional() }).strict(),
      async execute(arguments_, context) {
        const parsed = z.object({ title: z.string(), eventAt: dateTime, remindAt: dateTime.optional(), followUpAt: dateTime.optional(), contextNotes: z.string().optional() }).parse(arguments_);
        return memory.upsertCommitment(context.userId, {
          title: parsed.title,
          eventAt: toEpoch(parsed.eventAt),
          ...(parsed.remindAt === undefined ? {} : { remindAt: toEpoch(parsed.remindAt) }),
          ...(parsed.followUpAt === undefined ? {} : { followUpAt: toEpoch(parsed.followUpAt) }),
          ...(parsed.contextNotes === undefined ? {} : { contextNotes: parsed.contextNotes }),
        });
      },
    },
    {
      name: "schedule_list",
      description: "List pending owner schedule commitments.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      argumentSchema: z.object({}).strict(),
      async execute(_arguments_, context) { return memory.listPendingCommitments(context.userId); },
    },
  ];
}

function toEpoch(value: string | number): number {
  return typeof value === "string" ? Date.parse(value) : value;
}
