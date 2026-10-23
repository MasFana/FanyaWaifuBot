import { z } from "zod";
import type { Clock } from "../core/clock.js";
import type { LLMProvider } from "../llm/provider.js";
import type { MemoryService } from "./service.js";

const extractionSchema = z.object({
  facts: z.array(z.object({ content: z.string().min(1), category: z.string().min(1), origin: z.enum(["stated", "inferred"]) }).strict()).default([]),
  mood: z.string().min(1).optional(),
  commitments: z.array(z.object({
    title: z.string().min(1),
    eventAt: z.number().int(),
    remindAt: z.number().int().optional(),
    followUpAt: z.number().int().optional(),
    contextNotes: z.string().optional(),
  }).strict()).default([]),
}).strict();

export interface PostTurnInput { userId: string; ownerMessage: string; messageId: string }

/** Extracts durable owner details after delivery; failures deliberately have no chat impact. */
export class PostTurnWriter {
  private readonly inFlight = new Set<Promise<void>>();
  constructor(private readonly extractor: LLMProvider, private readonly memory: MemoryService, private readonly clock: Clock, private readonly model: string) {}

  enqueue(input: PostTurnInput): Promise<void> {
    const task = this.write(input);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
    return task;
  }

  async awaitIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private async write(input: PostTurnInput): Promise<void> {
    try {
      const response = await this.extractor.complete({ messages: [{ role: "user", content: input.ownerMessage }], tools: [], model: this.model });
      if (response.content === null || response.toolCalls.length > 0) return;
      const parsed = extractionSchema.safeParse(JSON.parse(response.content) as unknown);
      if (!parsed.success) return;
      for (const fact of parsed.data.facts) this.memory.upsertFact(input.userId, fact);
      if (parsed.data.mood !== undefined) this.memory.setMood(input.userId, parsed.data.mood);
      for (const commitment of parsed.data.commitments) {
        if (commitment.eventAt <= this.clock.now()) continue;
        this.memory.upsertCommitment(input.userId, {
          title: commitment.title,
          eventAt: commitment.eventAt,
          ...(commitment.remindAt === undefined ? {} : { remindAt: commitment.remindAt }),
          ...(commitment.followUpAt === undefined ? {} : { followUpAt: commitment.followUpAt }),
          ...(commitment.contextNotes === undefined ? {} : { contextNotes: commitment.contextNotes }),
        });
      }
    } catch { /* Extraction is best-effort and must not affect chat delivery. */ }
  }
}
