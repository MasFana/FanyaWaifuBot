import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "../core/clock.js";
import type { ToolContext, ToolDefinition } from "../core/types.js";
import datetime from "./datetime.js";
import calculator from "./calculator.js";

export type BuiltinToolDependencies = { clock: Clock; timeZone: string };

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(definitions: readonly ToolDefinition[]) {
    for (const definition of definitions) {
      if (this.tools.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
      this.tools.set(definition.name, definition);
    }
  }

  async execute(name: string, rawArguments: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`Unknown tool: ${name}`);
    const parsed = tool.argumentSchema.safeParse(rawArguments);
    if (!parsed.success) throw new Error(`Invalid arguments for ${name}: ${parsed.error.message}`);
    if (!isRecord(parsed.data)) throw new Error(`Invalid arguments for ${name}: expected object`);
    return tool.execute(parsed.data, context);
  }

  definitions(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }
}

export function createBuiltinTools(dependencies: BuiltinToolDependencies): readonly ToolDefinition[] {
  return [datetime(dependencies), calculator];
}

export async function discoverTools(directory: string): Promise<readonly ToolDefinition[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const tools: ToolDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isToolModule(entry.name)) continue;
    const module: unknown = await import(pathToFileURL(`${directory}/${entry.name}`).href);
    if (isRecord(module) && isToolDefinition(module["default"])) tools.push(module["default"]);
  }
  return tools;
}

function isToolModule(name: string): boolean {
  return (name.endsWith(".js") || name.endsWith(".ts"))
    && !name.endsWith(".d.ts")
    && name !== "index.js"
    && name !== "index.ts"
    && !name.endsWith(".test.js")
    && !name.endsWith(".test.ts")
    && !name.endsWith(".spec.js")
    && !name.endsWith(".spec.ts");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  return isRecord(value)
    && typeof value["name"] === "string"
    && typeof value["description"] === "string"
    && isRecord(value["parameters"])
    && isRecord(value["argumentSchema"])
    && typeof value["execute"] === "function";
}
