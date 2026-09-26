// The single interface every model call goes through. One production implementation
// (workers-ai.ts) and one fake (fake.ts). CLAUDE.md, "Model access".

import type { Prompt } from "../core/prompt";

export type ModelRequest = Prompt & {
  /** What the call is for. Used for logging and for the eval cache key. */
  purpose: "draft-rule" | "draft-rule-text" | "classify-symptom" | "hypothesize" | "write-report";
  jsonSchema: object;
};

export type ModelResponse =
  /** The raw text the model returned. Not yet validated: data under suspicion. */
  | { kind: "ok"; raw: string }
  /** Workers AI's documented "JSON Mode couldn't be met". Treated as a schema failure. */
  | { kind: "json-mode-failed"; message: string }
  /** HTTP 429 or equivalent. The step retries with backoff. */
  | { kind: "rate-limited"; message: string }
  | { kind: "error"; message: string };

export interface ModelClient {
  readonly modelId: string;
  generateJson(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * The draft-rule step has no diagnostic feedback loop for a transport failure (only for a
 * schema/type failure), so a rate limit or a provider error is not retried at the prompt level:
 * it throws, which the Workflow's own step retry policy (backoff, then eventually fail the
 * incident visibly) handles instead. `json-mode-failed` is not thrown here: DESIGN.md treats it
 * as a schema failure, so the caller feeds it back into the retry loop like any other one.
 */
export function requireOkResponse(
  response: ModelResponse,
): asserts response is Exclude<ModelResponse, { kind: "rate-limited" } | { kind: "error" }> {
  if (response.kind === "rate-limited" || response.kind === "error") {
    throw new Error(`model call failed (${response.kind}): ${response.message}`);
  }
}
