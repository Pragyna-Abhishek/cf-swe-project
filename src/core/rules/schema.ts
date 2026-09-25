// The model output boundary. The JSON Schema is sent to Workers AI JSON mode; the decoder
// below enforces the same shape ourselves, because the provider documents that it cannot
// guarantee conformance. CLAUDE.md invariant 3: model output reaches this decoder, then the
// type checker, then the parser, and nothing else.
//
// The wire format is a flat node list with integer id references, not a nested recursive
// object. Phase 0 spike 0.4 (docs/spikes.md) measured the earlier nested-$ref encoding against
// the real account: 0/30 attempts produced valid JSON, because the model reliably ran away into
// an unboundedly deep nested "or" chain and got truncated by max_tokens before closing. A flat
// array has no recursive schema for the model to nest into, and it is capped by maxItems, which
// a nested $ref schema cannot express. This is PLAN.md's fallback 1 ("flatten the schema").
//
// The decoder is hand written rather than a generic JSON Schema library: the shape is fixed,
// the error messages are ours, and there is one less dependency to explain.

import type { Diagnostic, RuleAST } from "../types";
import { diag } from "./diagnostics";
import { isNumberField, isStringField, LIMITS, NUMBER_FIELDS, STRING_FIELDS } from "./fields";

const nodeIdProp = { type: "integer", minimum: 0 } as const;
const lowerProp = { type: "boolean", description: "Wrap the field in lower() first. String fields only." } as const;

/**
 * One entry in the flat node list. Children are referenced by "id", not nested.
 *
 * Leaf kinds are split by value type ("compareString"/"compareNumber", "inStrings"/"inNumbers")
 * rather than using a `value: ["string", "integer"]` union, measured 2026-09-25 (docs/spikes.md,
 * 0.4) to make a real difference: with the union type, the model would happily emit "and"/"or"
 * nodes (whose fields are all plain integers) but almost never a leaf, running away into an
 * unboundedly large tree of pure connectives that never reached a condition. Splitting by type
 * removes every union-typed field from the schema.
 */
export const RULE_JSON_SCHEMA = {
  type: "object",
  properties: {
    root: { ...nodeIdProp, description: "id of the node in \"nodes\" that is the whole rule." },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: LIMITS.maxNodes,
      items: {
        anyOf: [
          {
            type: "object",
            properties: { id: nodeIdProp, kind: { type: "string", enum: ["and"] }, left: nodeIdProp, right: nodeIdProp },
            required: ["id", "kind", "left", "right"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { id: nodeIdProp, kind: { type: "string", enum: ["or"] }, left: nodeIdProp, right: nodeIdProp },
            required: ["id", "kind", "left", "right"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { id: nodeIdProp, kind: { type: "string", enum: ["not"] }, operand: nodeIdProp },
            required: ["id", "kind", "operand"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              id: nodeIdProp,
              kind: { type: "string", enum: ["compareString"] },
              field: { type: "string", enum: [...STRING_FIELDS] },
              op: { type: "string", enum: ["eq", "ne"] },
              value: { type: "string" },
              lower: lowerProp,
            },
            required: ["id", "kind", "field", "op", "value"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              id: nodeIdProp,
              kind: { type: "string", enum: ["compareNumber"] },
              field: { type: "string", enum: [...NUMBER_FIELDS] },
              op: { type: "string", enum: ["eq", "ne"] },
              value: { type: "integer" },
            },
            required: ["id", "kind", "field", "op", "value"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              id: nodeIdProp,
              kind: { type: "string", enum: ["contains"] },
              field: { type: "string", enum: [...STRING_FIELDS] },
              value: { type: "string" },
              lower: lowerProp,
            },
            required: ["id", "kind", "field", "value"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              id: nodeIdProp,
              kind: { type: "string", enum: ["inStrings"] },
              field: { type: "string", enum: [...STRING_FIELDS] },
              values: { type: "array", items: { type: "string" }, minItems: 1, maxItems: LIMITS.maxSetSize },
              lower: lowerProp,
            },
            required: ["id", "kind", "field", "values"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              id: nodeIdProp,
              kind: { type: "string", enum: ["inNumbers"] },
              field: { type: "string", enum: [...NUMBER_FIELDS] },
              values: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: LIMITS.maxSetSize },
            },
            required: ["id", "kind", "field", "values"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["root", "nodes"],
  additionalProperties: false,
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

/** Decodes a flat `{root, nodes}` value into a `RuleAST`. `pointer` is where it sits for messages. */
export function decodeRuleAst(value: unknown, pointer = "/"): DecodeResult {
  try {
    if (!isRecord(value)) fail(pointer, "expected an object with \"root\" and \"nodes\"");
    only(value, pointer, ["root", "nodes"], ["root", "nodes"]);
    const root = value["root"];
    if (typeof root !== "number" || !Number.isInteger(root) || root < 0) {
      fail(`${pointer}/root`, "expected a non-negative integer");
    }
    const rawNodes = value["nodes"];
    if (!Array.isArray(rawNodes)) fail(`${pointer}/nodes`, "expected an array");
    if (rawNodes.length < 1) fail(`${pointer}/nodes`, "expected at least 1 entry");
    if (rawNodes.length > LIMITS.maxNodes) fail(`${pointer}/nodes`, `more than ${LIMITS.maxNodes} entries`);
    const byId = new Map<number, Record<string, unknown>>();
    rawNodes.forEach((n, i) => {
      const p = `${pointer}/nodes/${i}`;
      if (!isRecord(n)) fail(p, "expected an object");
      const id = n["id"];
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0) fail(`${p}/id`, "expected a non-negative integer");
      if (byId.has(id)) fail(`${p}/id`, `duplicate node id ${id}`);
      byId.set(id, n);
    });
    const ast = resolve(byId, root, `${pointer}/root`, 1, { count: 0 });
    return { ok: true, ast };
  } catch (e) {
    if (e instanceof SchemaError) {
      const tooDeep = e.message.startsWith("depth:");
      const tooMany = e.message.startsWith("nodes:");
      return {
        ok: false,
        diagnostics: [
          tooDeep
            ? diag("E_AST_TOO_DEEP", `Limit is ${LIMITS.maxDepth}.`, null)
            : tooMany
              ? diag("E_AST_TOO_MANY_NODES", `Limit is ${LIMITS.maxNodes}.`, null)
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

function stringLiteral(v: unknown, pointer: string): string {
  if (typeof v === "string") return v;
  return fail(pointer, "expected a string");
}

function numberLiteral(v: unknown, pointer: string): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)) return v;
  return fail(pointer, "expected a non-negative integer");
}

/**
 * Expands node `id` into a `RuleAST`, following child id references. `depth` guards recursion
 * (a chain of nodes, or a cycle, cannot exceed `maxDepth` calls before failing loudly rather than
 * overflowing the stack). `budget` guards total expansion: a node referenced by more than one
 * parent is expanded again at each reference, so without a separate cap a small node list could
 * still blow up into an exponentially large tree within the depth limit.
 */
function resolve(byId: ReadonlyMap<number, Record<string, unknown>>, id: number, pointer: string, depth: number, budget: { count: number }): RuleAST {
  if (depth > LIMITS.maxDepth) throw new SchemaError(`depth: exceeded at ${pointer}`);
  budget.count++;
  if (budget.count > LIMITS.maxNodes) throw new SchemaError(`nodes: exceeded at ${pointer}`);
  const v = byId.get(id);
  if (!v) fail(pointer, `references unknown node id ${id}`);
  const kind = v["kind"];
  switch (kind) {
    case "and":
    case "or":
      only(v, pointer, ["id", "kind", "left", "right"], ["id", "kind", "left", "right"]);
      return {
        kind,
        left: resolve(byId, childId(v["left"], `${pointer}/left`), `${pointer}/left`, depth + 1, budget),
        right: resolve(byId, childId(v["right"], `${pointer}/right`), `${pointer}/right`, depth + 1, budget),
      };
    case "not":
      only(v, pointer, ["id", "kind", "operand"], ["id", "kind", "operand"]);
      return { kind, operand: resolve(byId, childId(v["operand"], `${pointer}/operand`), `${pointer}/operand`, depth + 1, budget) };
    case "compareString": {
      only(v, pointer, ["id", "kind", "field", "op", "value", "lower"], ["id", "kind", "field", "op", "value"]);
      const field = v["field"];
      if (!isStringField(field)) fail(`${pointer}/field`, `unknown string field ${JSON.stringify(field)}`);
      const op = v["op"];
      if (op !== "eq" && op !== "ne") fail(`${pointer}/op`, `expected "eq" or "ne", found ${JSON.stringify(op)}`);
      return { kind: "compare", field, op, value: stringLiteral(v["value"], `${pointer}/value`), ...optionalLower(v, pointer) };
    }
    case "compareNumber": {
      only(v, pointer, ["id", "kind", "field", "op", "value"], ["id", "kind", "field", "op", "value"]);
      const field = v["field"];
      if (!isNumberField(field)) fail(`${pointer}/field`, `unknown number field ${JSON.stringify(field)}`);
      const op = v["op"];
      if (op !== "eq" && op !== "ne") fail(`${pointer}/op`, `expected "eq" or "ne", found ${JSON.stringify(op)}`);
      return { kind: "compare", field, op, value: numberLiteral(v["value"], `${pointer}/value`) };
    }
    case "contains": {
      only(v, pointer, ["id", "kind", "field", "value", "lower"], ["id", "kind", "field", "value"]);
      const field = v["field"];
      if (!isStringField(field)) fail(`${pointer}/field`, `contains needs a string field, found ${JSON.stringify(field)}`);
      const value = v["value"];
      if (typeof value !== "string") fail(`${pointer}/value`, "expected a string");
      return { kind, field, value, ...optionalLower(v, pointer) };
    }
    case "inStrings": {
      only(v, pointer, ["id", "kind", "field", "values", "lower"], ["id", "kind", "field", "values"]);
      const field = v["field"];
      if (!isStringField(field)) fail(`${pointer}/field`, `unknown string field ${JSON.stringify(field)}`);
      const values = v["values"];
      if (!Array.isArray(values)) fail(`${pointer}/values`, "expected an array");
      if (values.length > LIMITS.maxSetSize) fail(`${pointer}/values`, `more than ${LIMITS.maxSetSize} values`);
      return {
        kind: "in",
        field,
        values: values.map((x, i) => stringLiteral(x, `${pointer}/values/${i}`)),
        ...optionalLower(v, pointer),
      };
    }
    case "inNumbers": {
      only(v, pointer, ["id", "kind", "field", "values"], ["id", "kind", "field", "values"]);
      const field = v["field"];
      if (!isNumberField(field)) fail(`${pointer}/field`, `unknown number field ${JSON.stringify(field)}`);
      const values = v["values"];
      if (!Array.isArray(values)) fail(`${pointer}/values`, "expected an array");
      if (values.length > LIMITS.maxSetSize) fail(`${pointer}/values`, `more than ${LIMITS.maxSetSize} values`);
      return { kind: "in", field, values: values.map((x, i) => numberLiteral(x, `${pointer}/values/${i}`)) };
    }
    default:
      return fail(`${pointer}/kind`, `unknown kind ${JSON.stringify(kind)}`);
  }
}

function childId(v: unknown, pointer: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(pointer, "expected a non-negative node id");
  return v;
}

/** Wire node for `encodeRuleAst`, the flat encoding's counterpart to a `RuleAST` subtree. */
type FlatNode = { id: number } & (
  | { kind: "and"; left: number; right: number }
  | { kind: "or"; left: number; right: number }
  | { kind: "not"; operand: number }
  | { kind: "compareString"; field: string; op: "eq" | "ne"; value: string; lower?: true }
  | { kind: "compareNumber"; field: string; op: "eq" | "ne"; value: number }
  | { kind: "contains"; field: string; value: string; lower?: true }
  | { kind: "inStrings"; field: string; values: string[]; lower?: true }
  | { kind: "inNumbers"; field: string; values: number[] }
);

/**
 * The inverse of `decodeRuleAst`: turns a `RuleAST` into the flat wire shape. Used by the fake
 * model and by tests that need to produce model-shaped input from a hand-written AST.
 */
export function encodeRuleAst(ast: RuleAST): { root: number; nodes: FlatNode[] } {
  const nodes: FlatNode[] = [];
  const put = (n: FlatNode) => {
    nodes.push(n);
    return n.id;
  };
  const go = (n: RuleAST): number => {
    const id = nodes.length;
    switch (n.kind) {
      case "and":
      case "or": {
        // Reserve id before recursing into children, so ids are stable and readable, then patch.
        const idx = nodes.length;
        nodes.push({ id: idx, kind: n.kind, left: -1, right: -1 });
        const left = go(n.left);
        const right = go(n.right);
        nodes[idx] = { id: idx, kind: n.kind, left, right };
        return idx;
      }
      case "not": {
        const idx = nodes.length;
        nodes.push({ id: idx, kind: "not", operand: -1 });
        const operand = go(n.operand);
        nodes[idx] = { id: idx, kind: "not", operand };
        return idx;
      }
      case "compare":
        return typeof n.value === "string"
          ? put({ id, kind: "compareString", field: n.field, op: n.op, value: n.value, ...(n.lower ? { lower: true } : {}) })
          : put({ id, kind: "compareNumber", field: n.field, op: n.op, value: n.value });
      case "contains":
        return put({ id, kind: "contains", field: n.field, value: n.value, ...(n.lower ? { lower: true } : {}) });
      case "in": {
        const allStrings = n.values.every((v): v is string => typeof v === "string");
        return allStrings
          ? put({ id, kind: "inStrings", field: n.field, values: n.values as string[], ...(n.lower ? { lower: true } : {}) })
          : put({ id, kind: "inNumbers", field: n.field, values: n.values as number[] });
      }
    }
  };
  const root = go(ast);
  return { root, nodes };
}
