import type { Clock } from "./clock.js";
import type { ContextBuilder } from "./context.js";
import { applyOwnerSentiment } from "./mood.js";
import { extractTraits, mergeTraits } from "./persona-state.js";
import type { Channel, InboundEvent, InboundImage, LLMMessage, LLMResponse, ToolContext, WakeupEvent } from "./types.js";
import type { LLMProvider } from "../llm/provider.js";
import type { MemoryService } from "../memory/service.js";
import type { ToolRegistry } from "../tools/index.js";
import type { PostTurnWriter } from "../memory/writer.js";

export type AgentOutcome = { status: "completed" | "failed" | "skipped"; error?: string; delivered?: boolean };
const maxToolCycles = 8;
const maxRetries = 3;
const maxFailedToolResults = 3;

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
    if (event.text.trim().length > 0 && !event.text.trimStart().startsWith("[SYSTEM")) {
      const state = this.memory.getPersonaState(event.userId);
      this.memory.setPersonaState(event.userId, applyOwnerSentiment(state, event.text, this.clock.now()));
    }
    const outcome = await this.run(event.userId, "inbound", {
      inboundText: event.text,
      ...(event.storedMessageId === undefined ? {} : { excludeMessageId: event.storedMessageId }),
      ...(event.storedMessageIds === undefined ? {} : { excludeMessageIds: event.storedMessageIds }),
      ...(event.images === undefined ? {} : { images: event.images }),
    });
    if (outcome.status === "failed") {
      await this.channel.sendReply(event.userId, "maaf bub, chat aku lagi gangguan bentar 😭 coba kirim lagi ya").catch(() => undefined);
    }
    const ownerMessage = event.storedMessageId === undefined ? undefined : this.memory.getMessage(event.storedMessageId);
    const ownerContent = ownerMessage?.content;
    if (outcome.status === "completed" && outcome.delivered === true && this.writer !== undefined && ownerMessage !== undefined && ownerContent !== null && ownerContent !== undefined) {
      void this.writer.enqueue({
        userId: event.userId,
        ownerMessage: ownerContent,
        messageId: ownerMessage.id,
        ...(event.imageMessageId === undefined ? {} : { imageMessageId: event.imageMessageId }),
        ...(event.images === undefined ? {} : { images: event.images }),
      }).catch(() => undefined);
    }
  }

  async runWakeup(wakeup: WakeupEvent): Promise<AgentOutcome> {
    const commitment = wakeup.commitmentId ? `; commitment: ${wakeup.commitmentId}` : "";
    const greeting = wakeup.triggerType === "greeting" && wakeup.greeting !== undefined ? `; ${greetingInstruction(wakeup.greeting)}` : "";
    const spontaneous = wakeup.triggerType === "spontaneous" ? `; ${spontaneousInstruction(this.clock.now(), this.ownerTimeZone(wakeup.userId))}` : "";
    return this.run(wakeup.userId, wakeup.triggerType, { wakeup: `Trigger: ${wakeup.triggerType}${commitment}${greeting}${spontaneous}` });
  }

  private ownerTimeZone(userId: string): string {
    try { return this.memory.exportOwner(userId).owner.timezone; } catch { return "Asia/Jakarta"; }
  }

  private async run(userId: string, trigger: WakeupEvent["triggerType"] | "inbound", input: { inboundText?: string; wakeup?: string; excludeMessageId?: string; excludeMessageIds?: readonly string[]; images?: readonly InboundImage[] }): Promise<AgentOutcome> {
    const runId = this.memory.createAgentRun(userId, trigger, this.model);
    try {
      const messages = await this.context.build({ userId, ...input });
      const outcome = await this.loop(runId, userId, trigger, messages);
      this.memory.finishAgentRun(runId, outcome.status, outcome.error);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown agent error";
      this.memory.finishAgentRun(runId, "failed", { message });
      return { status: "failed", error: message };
    }
  }

  private async loop(runId: string, userId: string, trigger: WakeupEvent["triggerType"] | "inbound", messages: LLMMessage[]): Promise<AgentOutcome> {
    const proactive = trigger !== "inbound";
    let failedToolResults = 0;
    for (let cycle = 0; cycle < maxToolCycles; cycle += 1) {
      const request = {
        messages,
        tools: this.tools.definitions().map(({ name, description, parameters }) => ({ name, description, parameters })),
        model: this.model,
      };
      let response: LLMResponse;
      try {
        response = hasImageParts(messages)
          ? await this.llm.complete(request)
          : await retry(() => this.llm.complete(request));
      } catch (error) {
        if (!hasImageParts(messages)) throw error;
        console.error("[vision] provider rejected image turn, retrying text-only", error);
        messages = stripImages(messages);
        response = await retry(() => this.llm.complete({ ...request, messages }));
      }
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
          let delivered = true;
          if (trigger === "inbound") await this.channel.sendReply(userId, response.content);
          else delivered = (await this.channel.sendProactive(userId, response.content, { triggerType: trigger })) !== false;
          this.memory.setPersonaState(userId, mergeTraits(this.memory.getPersonaState(userId), extractTraits(response.content)));
          return { status: "completed", delivered };
        }
        return { status: "completed", delivered: false };
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
        if (status === "error" && (failedToolResults += 1) > maxFailedToolResults) {
          return { status: "failed", error: `Agent exceeded ${maxFailedToolResults} failed tool recoveries` };
        }
      }
    }
    return { status: "failed", error: `Agent exceeded ${maxToolCycles} tool cycles` };
  }
}

async function retry<T>(operation: () => Promise<T>, shouldRetry: (error: unknown) => boolean = () => true): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (attempt === maxRetries || !shouldRetry(error)) throw error;
    }
  }
  throw new Error("Retry limit exceeded");
}

function hasImageParts(messages: readonly LLMMessage[]): boolean {
  return messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
}

function stripImages(messages: readonly LLMMessage[]): LLMMessage[] {
  return messages.map((message): LLMMessage => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    return { role: "user", content: message.content.filter((part) => part.type === "text").map((part) => part.text).join("") };
  });
}

function greetingInstruction(slot: "morning" | "night"): string {
  return slot === "morning"
    ? "ini sapaan pagi. Sapa dia dengan sapaan pagi yang hangat dan masih ngantuk."
    : "ini sapaan malam. Sapa dia dengan sapaan malam, tanya kabarnya dan ajak dia istirahat atau tidur.";
}

function spontaneousInstruction(now: number, timeZone: string): string {
  const local = new Intl.DateTimeFormat("id-ID", { dateStyle: "full", timeStyle: "short", timeZone }).format(now);
  return `waktu lokal saat ini persis ${local}. Sapa singkat sesuai jam ini (jangan menyapa pagi kalau sekarang masih malam). Kalau di chat terakhir owner baru saja pamit tidur di malam yang sama, atau topik sapaan ini sudah kamu tanyakan di pesan terakhirmu, balas HANYA dengan teks persis: [SKIP_PROACTIVE].`;
}
