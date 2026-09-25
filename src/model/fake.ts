// Fake ModelClient for tests, local development without credentials, and the eval harness.

import { print } from "../core/rules/printer";
import { encodeRuleAst } from "../core/rules/schema";
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

/** A canned response for every purpose, since one FakeModelClient instance now serves all of
 * them across a single investigation (classify, hypothesize, draft, write-report). */
export function cannedModel(): FakeModelClient {
  return new FakeModelClient((request) => {
    switch (request.purpose) {
      case "draft-rule":
        return { kind: "ok", raw: JSON.stringify({ rule: encodeRuleAst(CANNED_RULE) }) };
      case "draft-rule-text":
        return { kind: "ok", raw: JSON.stringify({ rule: print(CANNED_RULE).text }) };
      case "classify-symptom":
        return { kind: "ok", raw: JSON.stringify({ intent: "credential-stuffing" }) };
      case "hypothesize":
        return {
          kind: "ok",
          raw: JSON.stringify({
            hypothesis: "Credential stuffing traffic is concentrated on the login endpoint, sharing a carrier ASN with real customers (ev_4).",
          }),
        };
      case "write-report":
        return {
          kind: "ok",
          raw: JSON.stringify({
            report: "Credential stuffing against the login endpoint was investigated and a rule was proposed that separates the attack from legitimate traffic on the same network.",
            lesson: "A shared ASN between attack and legitimate traffic needs a more specific rule than blocking the network alone.",
          }),
        };
    }
  }, "fake");
}
