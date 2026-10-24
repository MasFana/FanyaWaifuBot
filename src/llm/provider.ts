import type { LLMRequest, LLMResponse } from "../core/types.js";

export interface LLMProvider {
  handlesRetries?: boolean;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export type { LLMRequest, LLMResponse } from "../core/types.js";
