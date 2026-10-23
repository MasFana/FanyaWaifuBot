import type { LLMMessage } from "../src/core/types.js";

const content: LLMMessage = { role: "assistant", content: "halo" };
const toolCall: LLMMessage = { role: "assistant", content: null, toolCalls: [{ id: "call-1", name: "memory_search", arguments: {} }] };

void content;
void toolCall;

// @ts-expect-error Assistant messages require content or at least one tool call.
const invalidAssistant: LLMMessage = { role: "assistant", content: null };
void invalidAssistant;
