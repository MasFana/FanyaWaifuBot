import { z } from "zod";
import type { ToolDefinition } from "../core/types.js";
import type { BuiltinToolDependencies } from "./index.js";

export default function createDatetimeTool({ clock, timeZone }: BuiltinToolDependencies): ToolDefinition {
  return {
    name: "system_get_datetime",
    description: "Gets current date and time in owner's timezone.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    argumentSchema: z.object({}).strict(),
    async execute() {
      return new Intl.DateTimeFormat("id-ID", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone,
      }).format(clock.now());
    },
  };
}
