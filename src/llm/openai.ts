import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionAssistantMessageParam, ChatCompletionContentPart, ChatCompletionCreateParamsNonStreaming, ChatCompletionFunctionTool, ChatCompletionMessageParam, ChatCompletionSystemMessageParam, ChatCompletionToolMessageParam, ChatCompletionUserMessageParam } from "openai/resources/chat/completions/completions";
import type { ContentPart, LLMMessage, LLMRequest, LLMResponse, ToolCall } from "../core/types.js";
import type { LLMProvider } from "./provider.js";

export interface ChatCompletionClient {
  create(request: ChatCompletionCreateParamsNonStreaming): Promise<ChatResponse>;
}

type ChatResponse = {
  choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
};

export type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = async (milliseconds) => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

export class OpenAIProvider implements LLMProvider {
  constructor(
    private readonly client: ChatCompletionClient,
    private readonly sleep: Sleep = defaultSleep,
    private readonly defaultModel = "gpt-4o",
  ) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const input = mapRequest(request, this.defaultModel);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const message = (await this.client.create(input)).choices[0]?.message;
        if (message === undefined) throw new Error("OpenAI completion contained no choices");
        return { content: message.content, toolCalls: (message.tool_calls ?? []).map(mapToolCall) };
      } catch (error) {
        if (!isRetryable(error) || attempt === 2) throw error;
        await this.sleep(100 * 2 ** attempt);
      }
    }
    throw new Error("Unreachable retry state");
  }
}

export function createOpenAIProvider(apiKey: string, baseURL: string, model: string, sleep?: Sleep): OpenAIProvider {
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  return new OpenAIProvider({
    create: async (request) => mapOpenAIResponse(await client.chat.completions.create(request)),
  }, sleep, model);
}

function mapRequest(request: LLMRequest, defaultModel: string): ChatCompletionCreateParamsNonStreaming {
  return {
    model: request.model ?? defaultModel,
    messages: request.messages.map(mapMessage),
    tools: request.tools.map((tool): ChatCompletionFunctionTool => ({ type: "function", function: tool })),
  };
}

function mapMessage(message: LLMMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system": return { role: "system", content: message.content } satisfies ChatCompletionSystemMessageParam;
    case "user": return { role: "user", content: typeof message.content === "string" ? message.content : message.content.map(mapContentPart) } satisfies ChatCompletionUserMessageParam;
    case "tool": return { role: "tool", content: message.content, tool_call_id: message.toolCallId } satisfies ChatCompletionToolMessageParam;
    case "assistant": {
      const toolCalls = message.toolCalls?.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
      return toolCalls === undefined
        ? ({ role: "assistant", content: message.content } satisfies ChatCompletionAssistantMessageParam)
        : ({ role: "assistant", content: message.content, tool_calls: toolCalls } satisfies ChatCompletionAssistantMessageParam);
    }
  }
}

function mapContentPart(part: ContentPart): ChatCompletionContentPart {
  return part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image_url", image_url: { url: part.dataUrl } };
}

function mapToolCall(call: { id: string; function: { name: string; arguments: string } }): ToolCall {
  const parsed: unknown = JSON.parse(call.function.arguments);
  if (!isRecord(parsed)) throw new Error(`Tool call ${call.id} arguments must be a JSON object`);
  return { id: call.id, name: call.function.name, arguments: parsed };
}

function mapOpenAIResponse(response: ChatCompletion): ChatResponse {
  return {
    choices: response.choices.map(({ message }) => {
      const toolCalls = (message.tool_calls ?? []).flatMap((call) => call.type === "function"
        ? [{ id: call.id, function: { name: call.function.name, arguments: call.function.arguments } }]
        : []);
      return { message: toolCalls.length === 0 ? { content: message.content } : { content: message.content, tool_calls: toolCalls } };
    }),
  };
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = readNumber(error, "status");
  if (typeof status === "number") return status === 429 || (status >= 500 && status <= 599);
  const code = readString(error, "code");
  return (code !== undefined && networkCodes.has(code)) || isRetryable(error.cause);
}

const networkCodes = new Set(["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT"]);

function readNumber(error: Error, key: string): number | undefined {
  const value: unknown = (error as Error & Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function readString(error: Error, key: string): string | undefined {
  const value: unknown = (error as Error & Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
