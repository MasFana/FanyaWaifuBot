import { z } from "zod";
export default {
  name: "source_extension",
  description: "source test tool",
  parameters: { type: "object", additionalProperties: false },
  argumentSchema: z.object({}).strict(),
  async execute() { return "source"; },
};
