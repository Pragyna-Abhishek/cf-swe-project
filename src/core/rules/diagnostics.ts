// Stable diagnostic codes. These are part of the contract with the retry loop (Phase 3 feeds
// them back to the model) and with the UI, so a code is never renamed or reused. Every code
// here is produced by at least one test; test/unit/rules/diagnostics.test.ts enforces that.

import type { Diagnostic, Span } from "../types";

export const DIAGNOSTIC_CODES = {
  // Lexer
  E_INPUT_TOO_LONG: "Rule text is longer than the maximum length.",
  E_UNEXPECTED_CHAR: "Character is not valid here.",
  E_UNTERMINATED_STRING: "String literal is missing its closing quote.",
  E_INVALID_ESCAPE: 'Only \\" and \\\\ escapes are allowed in string literals.',
  E_CONTROL_CHAR: "Control characters are not allowed in string literals.",
  E_INVALID_NUMBER: "Number literals are decimal digits without leading zeros.",
  E_NUMBER_OUT_OF_RANGE: "Number is outside the range for this field.",
  // Parser
  E_UNEXPECTED_TOKEN: "Token is not valid here.",
  E_UNEXPECTED_EOF: "Rule text ended early.",
  E_UNKNOWN_FIELD: "Field is not part of the supported Rules language subset.",
  E_UNKNOWN_OPERATOR: "Operator is not part of the supported Rules language subset.",
  E_TRAILING_INPUT: "Unexpected text after the end of the rule.",
  // Type checker
  E_TYPE_MISMATCH: "Literal type does not match the field type.",
  E_CONTAINS_ON_NUMBER: "contains is only defined for string fields.",
  E_LOWER_ON_NUMBER: "lower() is only defined for string fields.",
  E_EMPTY_SET: "A set must contain at least one value.",
  E_SET_NOT_HOMOGENEOUS: "Every value in a set must have the same type.",
  W_LOWER_UPPERCASE_LITERAL: "Comparing lower() against a literal with uppercase letters never matches.",
  W_EMPTY_CONTAINS: 'contains "" matches every request.',
  W_DUPLICATE_SET_VALUE: "Set contains the same value more than once.",
  // Limits
  E_AST_TOO_DEEP: "Rule is nested too deeply.",
  E_AST_TOO_MANY_NODES: "Rule has too many nodes.",
  E_SET_TOO_LARGE: "Set has too many values.",
  E_STRING_TOO_LONG: "String literal is too long.",
  // Model output boundary
  E_SCHEMA_NOT_JSON: "Model output is not valid JSON.",
  E_SCHEMA_INVALID: "Model output does not match the rule schema.",
  E_JSON_MODE_FAILED: "The model provider reported that JSON mode could not be met.",
  E_MODEL_ERROR: "The model call failed.",
  // Round trip
  E_ROUNDTRIP_MISMATCH: "Printer and parser disagree. This is a bug in Portcullis, not in the rule.",
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

export function diag(code: DiagnosticCode, detail: string | null, span: Span | null): Diagnostic {
  const base = DIAGNOSTIC_CODES[code];
  return {
    severity: code.startsWith("W_") ? "warning" : "error",
    code,
    message: detail ? `${base} ${detail}` : base,
    span,
  };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
