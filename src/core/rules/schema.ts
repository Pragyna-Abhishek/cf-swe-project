// The model output boundary. The JSON Schema is sent to Workers AI JSON mode; the decoder
// below enforces the same shape ourselves, because the provider documents that it cannot
// guarantee conformance. CLAUDE.md invariant 3: model output reaches this decoder, then the
// type checker, then the parser, and nothing else.
//
// The decoder is hand written rather than a generic JSON Schema library: the shape is fixed,
// the error messages are ours, and there is one less dependency to explain.

import type { Diagnostic, RuleAST } from "../types";
import { diag } from "./diagnostics";
import { ALL_FIELDS, isRuleField, isStringField, LIMITS, STRING_FIELDS } from "./fields";

const ref = { $ref: "#/$defs/node" } as const;
const lowerProp = { type: "boolean", description: "Wrap the field in lower() first. String fields only." } as const;

export const RULE_JSON_SCHEMA = {
  type: "object",
  properties: { rule: ref },
  required: ["rule"],
  additionalProperties: false,
  $defs: {
    node: {
      anyOf: [
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["and"] }, left: ref, right: ref },
          required: ["kind", "left", "right"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["or"] }, left: ref, right: ref },
          required: ["kind", "left", "right"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["not"] }, operand: ref },
          required: ["kind", "operand"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["compare"] },
            field: { type: "string", enum: [...ALL_FIELDS] },
            op: { type: "string", enum: ["eq", "ne"] },
            value: { type: ["string", "integer"] },
            lower: lowerProp,
          },
          required: ["kind", "field", "op", "value"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["contains"] },
            field: { type: "string", enum: [...STRING_FIELDS] },
            value: { type: "string" },
            lower: lowerProp,
          },
          required: ["kind", "field", "value"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["in"] },
            field: { type: "string", enum: [...ALL_FIELDS] },
            values: {
              type: "array",
              items: { type: ["string", "integer"] },
              minItems: 1,
              maxItems: LIMITS.maxSetSize,
            },
            lower: lowerProp,
          },
          required: ["kind", "field", "values"],
          additionalProperties: false,
        },
      ],
    },
  },
} as const;

export type DecodeResult = { ok: true; ast: RuleAST } | { ok: false; diagnostics: Diagnostic[] };

class SchemaError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse the raw model string. Everything the model says is data under suspicion. */
export function decodeModelOutput(raw: string): DecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, diagnostics: [diag("E_SCHEMA_NOT_JSON", null, null)] };
  }
  if (!isRecord(value)) return schemaFail("/", "expected an object with a \"rule\" property");
  const extra = Object.keys(value).filter((k) => k !== "rule");
  if (extra.length > 0) return schemaFail("/", `unexpected properties ${JSON.stringify(extra)}`);
  if (!("rule" in value)) return schemaFail("/", 'missing required property "rule"');
  return decodeRuleAst(value["rule"], "/rule");
}

export function decodeRuleAst(value: unknown, pointer = ""): DecodeResult {
  try {
    return { ok: true, ast: node(value, pointer === "" ? "/" : pointer, 1) };
  } catch (e) {
    if (e instanceof SchemaError) {
      const tooDeep = e.message.startsWith("depth:");
      return {
        ok: false,
        diagnostics: [
          tooDeep
            ? diag("E_AST_TOO_DEEP", `Limit is ${LIMITS.maxDepth}.`, null)
            : diag("E_SCHEMA_INVALID", e.message, null),
        ],
      };
    }
    throw e;
  }
}

function schemaFail(pointer: string, message: string): DecodeResult {
  return { ok: false, diagnostics: [diag("E_SCHEMA_INVALID", `At ${pointer}: ${message}.`, null)] };
}

function fail(pointer: string, message: string): never {
  throw new SchemaError(`At ${pointer}: ${message}.`);
}

function only(v: Record<string, unknown>, pointer: string, allowed: readonly string[], required: readonly string[]) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(pointer, `unexpected property "${k}"`);
  for (const k of required) if (!(k in v)) fail(pointer, `missing required property "${k}"`);
}

function optionalLower(v: Record<string, unknown>, pointer: string): { lower?: true } {
  if (!("lower" in v)) return {};
  if (typeof v["lower"] !== "boolean") fail(`${pointer}/lower`, "expected a boolean");
  // false and absent mean the same thing; normalize so the round trip compares like with like.
  return v["lower"] ? { lower: true } : {};
}

function literal(v: unknown, pointer: string): string | number {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)) return v;
  return fail(pointer, "expected a string or a non-negative integer");
}

function node(v: unknown, pointer: string, depth: number): RuleAST {
  // Guard recursion before anything else: JSON.parse accepts nesting far deeper than we do.
  if (depth > LIMITS.maxDepth) throw new SchemaError(`depth: exceeded at ${pointer}`);
  if (!isRecord(v)) fail(pointer, "expected an object");
  const kind = v["kind"];
  switch (kind) {
    case "and":
    case "or":
      only(v, pointer, ["kind", "left", "right"], ["kind", "left", "right"]);
      return {
        kind,
        left: node(v["left"], `${pointer}/left`, depth + 1),
        right: node(v["right"], `${pointer}/right`, depth + 1),
      };
    case "not":
      only(v, pointer, ["kind", "operand"], ["kind", "operand"]);
      return { kind, operand: node(v["operand"], `${pointer}/operand`, depth + 1) };
    case "compare": {
      only(v, pointer, ["kind", "field", "op", "value", "lower"], ["kind", "field", "op", "value"]);
      const field = v["field"];
      if (!isRuleField(field)) fail(`${pointer}/field`, `unknown field ${JSON.stringify(field)}`);
      const op = v["op"];
      if (op !== "eq" && op !== "ne") fail(`${pointer}/op`, `expected "eq" or "ne", found ${JSON.stringify(op)}`);
      return { kind, field, op, value: literal(v["value"], `${pointer}/value`), ...optionalLower(v, pointer) };
    }
    case "contains": {
      only(v, pointer, ["kind", "field", "value", "lower"], ["kind", "field", "value"]);
      const field = v["field"];
      if (!isStringField(field)) fail(`${pointer}/field`, `contains needs a string field, found ${JSON.stringify(field)}`);
      const value = v["value"];
      if (typeof value !== "string") fail(`${pointer}/value`, "expected a string");
      return { kind, field, value, ...optionalLower(v, pointer) };
    }
    case "in": {
      only(v, pointer, ["kind", "field", "values", "lower"], ["kind", "field", "values"]);
      const field = v["field"];
      if (!isRuleField(field)) fail(`${pointer}/field`, `unknown field ${JSON.stringify(field)}`);
      const values = v["values"];
      if (!Array.isArray(values)) fail(`${pointer}/values`, "expected an array");
      if (values.length > LIMITS.maxSetSize) fail(`${pointer}/values`, `more than ${LIMITS.maxSetSize} values`);
      return {
        kind,
        field,
        values: values.map((x, i) => literal(x, `${pointer}/values/${i}`)),
        ...optionalLower(v, pointer),
      };
    }
    default:
      return fail(`${pointer}/kind`, `unknown kind ${JSON.stringify(kind)}`);
  }
}
