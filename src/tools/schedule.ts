import { z } from "zod";
import type { Clock } from "../core/clock.js";
import type { ToolDefinition } from "../core/types.js";
import type { MemoryService } from "../memory/service.js";

export function createScheduleTools(memory: MemoryService, _clock: Clock): readonly ToolDefinition[] {
  return [
    {
      name: "schedule_upsert",
      description: "Create or update future owner schedule commitment.",
      parameters: { type: "object", properties: { title: { type: "string" }, eventAt: { type: "integer" }, remindAt: { type: "integer" }, followUpAt: { type: "integer" }, contextNotes: { type: "string" } }, required: ["title", "eventAt"], additionalProperties: false },
      argumentSchema: z.object({ title: z.string().min(1), eventAt: z.number().int(), remindAt: z.number().int().optional(), followUpAt: z.number().int().optional(), contextNotes: z.string().optional() }).strict(),
      async execute(arguments_, context) {
        const parsed = z.object({ title: z.string(), eventAt: z.number(), remindAt: z.number().optional(), followUpAt: z.number().optional(), contextNotes: z.string().optional() }).parse(arguments_);
        return memory.upsertCommitment(context.userId, {
          title: parsed.title,
          eventAt: parsed.eventAt,
          ...(parsed.remindAt === undefined ? {} : { remindAt: parsed.remindAt }),
          ...(parsed.followUpAt === undefined ? {} : { followUpAt: parsed.followUpAt }),
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
