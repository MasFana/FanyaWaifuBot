import type { LLMRequest, LLMResponse } from "../core/types.js";
import type { LLMProvider } from "./provider.js";

export class FakeLLMProvider implements LLMProvider {
  #requests: LLMRequest[] = [];
  #responses: Array<LLMResponse | Error> = [];

  enqueue(response: LLMResponse | Error): void {
    this.#responses.push(response instanceof Error ? cloneError(response) : structuredClone(response));
  }

  getRequests(): readonly LLMRequest[] {
    return structuredClone(this.#requests);
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.#requests.push(structuredClone(request));
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("FakeLLMProvider queue is empty");
    if (response instanceof Error) throw cloneError(response);
    return structuredClone(response);
  }
}

function cloneError(error: Error): Error {
  const clone = new Error(error.message, { cause: error.cause instanceof Error ? cloneError(error.cause) : structuredClone(error.cause) });
  clone.name = error.name;
  Object.assign(clone, structuredClone(Object.fromEntries(Object.entries(error))));
  return clone;
}
