// JSON Schemas for the three narrative model calls (classify-symptom, hypothesize,
// write-report). Unlike RULE_JSON_SCHEMA (src/core/rules/schema.ts), these are flat: a single
// object with one or two string-typed properties and no nesting, no arrays, no unions. That
// shape carries none of the risk spike 0.4 measured for the rule schema (docs/spikes.md):
// there is nothing to recurse into and nothing for a union-typed field to make the decoder
// avoid. Still unverified against the real account (the account's daily neuron allocation was
// exhausted verifying the rule schema fallback; see docs/spikes.md), recorded here rather than
// assumed safe just because the shape is simpler.

export const CLASSIFY_INTENTS = ["credential-stuffing", "scraper", "l7-flood", "unknown"] as const;
export type ClassifyIntent = (typeof CLASSIFY_INTENTS)[number];

export const CLASSIFY_JSON_SCHEMA = {
  type: "object",
  properties: { intent: { type: "string", enum: [...CLASSIFY_INTENTS] } },
  required: ["intent"],
  additionalProperties: false,
} as const;

export const HYPOTHESIZE_JSON_SCHEMA = {
  type: "object",
  properties: { hypothesis: { type: "string" } },
  required: ["hypothesis"],
  additionalProperties: false,
} as const;

export const WRITE_REPORT_JSON_SCHEMA = {
  type: "object",
  properties: { report: { type: "string" }, lesson: { type: "string" } },
  required: ["report", "lesson"],
  additionalProperties: false,
} as const;

export function isClassifyIntent(v: unknown): v is ClassifyIntent {
  return CLASSIFY_INTENTS.includes(v as ClassifyIntent);
}

/**
 * Phase 5, ablation 4: ask the model for the rule as literal Rules-language text instead of the
 * flat AST wire format, and parse it with the real parser (src/core/rules/pipeline.ts,
 * checkRuleText). Flat like the schemas above, so it carries none of 0.4's nesting risk; what it
 * measures is the syntax error rate of free-form text versus structured output, not schema risk.
 */
export const TEXT_RULE_JSON_SCHEMA = {
  type: "object",
  properties: { rule: { type: "string" } },
  required: ["rule"],
  additionalProperties: false,
} as const;
