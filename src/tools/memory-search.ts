import { z } from "zod";
import type { ToolDefinition } from "../core/types.js";
import type { MemoryService } from "../memory/service.js";

export function createMemorySearchTool(memory: MemoryService): ToolDefinition {
  return {
    name: "memory_search",
    description: "Search owner facts and previous conversations.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    argumentSchema: z.object({ query: z.string().min(1) }).strict(),
    async execute(arguments_, context) { return memory.search(context.userId, String(arguments_["query"])); },
  };
}
