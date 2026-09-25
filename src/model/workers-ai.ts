// Workers AI implementation of ModelClient, using JSON mode with a JSON Schema.
// JSON mode does not support streaming (Workers AI docs), so this call never streams.

import type { ModelClient, ModelRequest, ModelResponse } from "./client";

/** The subset of the AI binding this file uses, so the fake and tests need no Ai type. */
export type AiRunner = { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };

export class WorkersAiModelClient implements ModelClient {
  constructor(
    private readonly ai: AiRunner,
    readonly modelId: string,
  ) {}

  async generateJson(request: ModelRequest): Promise<ModelResponse> {
    let result: unknown;
    try {
      result = await this.ai.run(this.modelId, {
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: { type: "json_schema", json_schema: request.jsonSchema },
        max_tokens: 1024,
        temperature: 0,
      });
    } catch (e) {
      return classifyError(e);
    }
    return toResponse(result);
  }
}

export function toResponse(result: unknown): ModelResponse {
  if (typeof result !== "object" || result === null || !("response" in result)) {
    return { kind: "error", message: "Workers AI returned no response field" };
  }
  const response = (result as { response: unknown }).response;
  // JSON mode returns the parsed object; plain mode returns a string. Keep whatever came back
  // as a string: rawModelOutput is kept verbatim for audit, and parsing is the decoder's job.
  if (typeof response === "string") return { kind: "ok", raw: response };
  if (response === null || response === undefined) return { kind: "error", message: "empty response" };
  return { kind: "ok", raw: JSON.stringify(response) };
}

export function classifyError(e: unknown): ModelResponse {
  const message = e instanceof Error ? e.message : String(e);
  if (/JSON Mode couldn't be met/i.test(message)) return { kind: "json-mode-failed", message };
  // 429, 3036 (daily neuron allocation used up) and 3040 (out of capacity) are all worth
  // backing off from. Codes from workers-ai/platform/errors.mdx.
  if (/\b(429|3036|3040)\b|rate.?limit|capacity/i.test(message)) return { kind: "rate-limited", message };
  return { kind: "error", message };
}
