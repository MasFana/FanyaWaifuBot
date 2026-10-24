export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LLMMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: readonly ToolCall[] }
  | { role: "assistant"; content: null; toolCalls: readonly [ToolCall, ...ToolCall[]] }
  | { role: "tool"; content: string; toolCallId: string };

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMRequest {
  messages: readonly LLMMessage[];
  tools: readonly LLMTool[];
  model?: string;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: readonly ToolCall[];
}

export interface InboundImage {
  dataUrl: string;
  mimeType: string;
}

export interface InboundEvent {
  id: string;
  userId: string;
  text: string;
  receivedAt: number;
  storedMessageId?: string;
  storedMessageIds?: readonly string[];
  images?: InboundImage[];
}

export interface WakeupEvent {
  userId: string;
  triggerType: "agenda_reminder" | "agenda_followup" | "spontaneous" | "greeting";
  commitmentId?: string;
  greeting?: "morning" | "night";
}

export interface OutboundMedia {
  kind: "video" | "audio" | "photo" | "document";
  url: string;
  caption?: string;
}

export type MediaDelivery = "media" | "link";

export interface ToolContext {
  userId: string;
  sendMedia?(media: OutboundMedia): Promise<MediaDelivery>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  argumentSchema: z.ZodType;
  execute(arguments_: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

export interface Channel {
  sendReply(userId: string, text: string): Promise<void>;
  sendProactive(userId: string, text: string, options?: { triggerType?: WakeupEvent["triggerType"] }): Promise<void | boolean>;
  sendMedia?(userId: string, media: OutboundMedia): Promise<MediaDelivery>;
  flushPending?(userId?: string): Promise<void>;
}

export interface FactInput {
  content: string;
  category: string;
  origin: "stated" | "inferred";
}

export interface CommitmentInput {
  title: string;
  eventAt: number;
  remindAt?: number;
  followUpAt?: number;
  contextNotes?: string;
}
import type { z } from "zod";
