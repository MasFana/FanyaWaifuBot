import type { Clock } from "./clock.js";
import type { ContextBuilder } from "./context.js";
import { extractTraits, mergeTraits } from "./persona-state.js";
import type { Channel, InboundEvent, LLMMessage, ToolContext, WakeupEvent } from "./types.js";
import type { LLMProvider } from "../llm/provider.js";
import type { MemoryService } from "../memory/service.js";
import type { ToolRegistry } from "../tools/index.js";
import type { PostTurnWriter } from "../memory/writer.js";

export type AgentOutcome = { status: "completed" | "failed" | "skipped"; error?: string; delivered?: boolean };
const maxToolCycles = 6;

export class Agent {
  constructor(
    private readonly llm: LLMProvider,
    private readonly memory: MemoryService,
    private readonly tools: ToolRegistry,
    private readonly channel: Channel,
    private readonly context: ContextBuilder,
    private readonly clock: Clock,
    private readonly model: string,
    private readonly writer?: PostTurnWriter,
  ) {}

  async runInbound(event: InboundEvent): Promise<void> {
    const outcome = await this.run(event.userId, "inbound", {
      inboundText: event.text,
      ...(event.storedMessageId === undefined ? {} : { excludeMessageId: event.storedMessageId }),
    });
    const ownerMessage = event.storedMessageId === undefined ? undefined : this.memory.getMessage(event.storedMessageId);
    const ownerContent = ownerMessage?.content;
    if (outcome.status === "completed" && outcome.delivered === true && this.writer !== undefined && ownerMessage !== undefined && ownerContent !== null && ownerContent !== undefined) {
      void this.writer.enqueue({ userId: event.userId, ownerMessage: ownerContent, messageId: ownerMessage.id }).catch(() => undefined);
    }
  }

  async runWakeup(wakeup: WakeupEvent): Promise<AgentOutcome> {
    const commitment = wakeup.commitmentId ? `; commitment: ${wakeup.commitmentId}` : "";
    const greeting = wakeup.triggerType === "greeting" && wakeup.greeting !== undefined ? `; ${greetingInstruction(wakeup.greeting)}` : "";
    return this.run(wakeup.userId, wakeup.triggerType, { wakeup: `Trigger: ${wakeup.triggerType}${commitment}${greeting}` });
  }

  private async run(userId: string, trigger: WakeupEvent["triggerType"] | "inbound", input: { inboundText?: string; wakeup?: string; excludeMessageId?: string }): Promise<AgentOutcome> {
    const runId = this.memory.createAgentRun(userId, trigger, this.model);
    try {
      const messages = await this.context.build({ userId, ...input });
      const outcome = await this.loop(runId, userId, trigger !== "inbound", messages);
      this.memory.finishAgentRun(runId, outcome.status, outcome.error);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown agent error";
      this.memory.finishAgentRun(runId, "failed", { message });
      return { status: "failed", error: message };
    }
  }

  private async loop(runId: string, userId: string, proactive: boolean, messages: LLMMessage[]): Promise<AgentOutcome> {
    for (let cycle = 0; cycle < maxToolCycles; cycle += 1) {
      const response = await this.llm.complete({
        messages,
        tools: this.tools.definitions().map(({ name, description, parameters }) => ({ name, description, parameters })),
        model: this.model,
      });
      const assistant: LLMMessage = response.toolCalls.length > 0
        ? { role: "assistant", content: response.content, toolCalls: response.toolCalls as [typeof response.toolCalls[number], ...typeof response.toolCalls] }
        : { role: "assistant", content: response.content ?? "" };
      messages.push(assistant);
      this.memory.appendMessage(userId, {
        channel: "telegram",
        role: "assistant",
        content: response.content,
        runId,
        isProactive: proactive,
        ...(response.toolCalls.length > 0 ? { toolCallsJson: JSON.stringify(response.toolCalls) } : {}),
      });
      if (response.toolCalls.length === 0) {
        if (proactive && response.content?.trim() === "[SKIP_PROACTIVE]") return { status: "skipped" };
        if (response.content) {
          await (proactive ? this.channel.sendProactive(userId, response.content) : this.channel.sendReply(userId, response.content));
          this.memory.setPersonaState(userId, mergeTraits(this.memory.getPersonaState(userId), extractTraits(response.content)));
        }
        return { status: "completed", delivered: response.content !== null && response.content.trim().length > 0 };
      }
      for (const call of response.toolCalls) {
        const started = this.clock.now();
        const sendMedia = this.channel.sendMedia;
        const context: ToolContext = sendMedia === undefined ? { userId } : { userId, sendMedia: (media) => sendMedia.call(this.channel, userId, media) };
        let output: unknown;
        let status: "ok" | "error" = "ok";
        try { output = await this.tools.execute(call.name, call.arguments, context); }
        catch (error) { status = "error"; output = { error: error instanceof Error ? error.message : "Tool failed" }; }
        const content = JSON.stringify(output);
        this.memory.recordToolResult(userId, runId, call, output, status, this.clock.now() - started);
        messages.push({ role: "tool", content, toolCallId: call.id });
      }
    }
    return { status: "failed", error: `Agent exceeded ${maxToolCycles} tool cycles` };
  }
}

function greetingInstruction(slot: "morning" | "night"): string {
  return slot === "morning"
    ? "ini sapaan pagi. Sapa dia dengan sapaan pagi yang hangat dan masih ngantuk."
    : "ini sapaan malam. Sapa dia dengan sapaan malam, tanya kabarnya dan ajak dia istirahat atau tidur.";
}
