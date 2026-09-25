// The six fields of the Rules language subset, and the limits every rule must satisfy.

import type { NumberField, RuleField, StringField } from "../types";

export const STRING_FIELDS: readonly StringField[] = [
  "http.request.method",
  "http.request.uri.path",
  "http.user_agent",
  "ip.src.country",
];

export const NUMBER_FIELDS: readonly NumberField[] = ["http.response.code", "ip.src.asnum"];

export const ALL_FIELDS: readonly RuleField[] = [...STRING_FIELDS, ...NUMBER_FIELDS];

export function isStringField(f: unknown): f is StringField {
  return STRING_FIELDS.some((x) => x === f);
}

export function isNumberField(f: unknown): f is NumberField {
  return NUMBER_FIELDS.some((x) => x === f);
}

export function isRuleField(f: unknown): f is RuleField {
  return isStringField(f) || isNumberField(f);
}

/** Inclusive value ranges for number fields. */
export const NUMBER_RANGES: Readonly<Record<NumberField, { min: number; max: number }>> = {
  "http.response.code": { min: 100, max: 599 },
  "ip.src.asnum": { min: 0, max: 4294967295 },
};

/** Largest number literal the lexer accepts at all. */
export const MAX_NUMBER_LITERAL = 4294967295;

// Caps, enforced before printing so a pathological rule cannot burn the CPU budget in the
// printer or the evaluator. DESIGN.md section 11.
export const LIMITS = {
  maxDepth: 32,
  maxNodes: 64,
  maxSetSize: 32,
  maxStringChars: 256,
  maxTextChars: 8192,
} as const;
