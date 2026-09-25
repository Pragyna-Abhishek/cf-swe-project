// Fake ModelClient for tests, local development without credentials, and the eval harness.

import type { RuleAST } from "../core/types";
import type { ModelClient, ModelRequest, ModelResponse } from "./client";

export type Script = Array<ModelResponse | string> | ((request: ModelRequest, call: number) => ModelResponse);

export class FakeModelClient implements ModelClient {
  readonly calls: ModelRequest[] = [];

  constructor(
    private readonly script: Script,
    readonly modelId = "fake",
  ) {}

  async generateJson(request: ModelRequest): Promise<ModelResponse> {
    const call = this.calls.length;
    this.calls.push(request);
    if (typeof this.script === "function") return this.script(request, call);
    const next = this.script[Math.min(call, this.script.length - 1)];
    if (next === undefined) return { kind: "error", message: "fake model has no scripted response" };
    return typeof next === "string" ? { kind: "ok", raw: next } : next;
  }
}

/**
 * What the Worker uses when MODEL_MODE is "fake": a fixed, plausible rule for the credential
 * stuffing scenario. It lets the whole loop run locally and in integration tests with no
 * Cloudflare credentials. The UI labels the model as "fake" so nobody mistakes it for a real
 * model's output.
 */
export const CANNED_RULE: RuleAST = {
  kind: "and",
  left: { kind: "compare", field: "http.request.uri.path", op: "eq", value: "/login" },
  right: {
    kind: "or",
    left: { kind: "contains", field: "http.user_agent", value: "okhttp", lower: true },
    right: { kind: "contains", field: "http.user_agent", value: "HeadlessChrome" },
  },
};

export function cannedModel(): FakeModelClient {
  return new FakeModelClient([JSON.stringify({ rule: CANNED_RULE })], "fake");
}
