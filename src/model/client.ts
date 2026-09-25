// The single interface every model call goes through. One production implementation
// (workers-ai.ts) and one fake (fake.ts). CLAUDE.md, "Model access".

import type { Prompt } from "../core/prompt";

export type ModelRequest = Prompt & {
  /** What the call is for. Used for logging and for the eval cache key. */
  purpose: "draft-rule" | "classify-symptom" | "hypothesize" | "write-report";
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
