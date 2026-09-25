// Type checker. Rules:
//   - string fields take string literals, number fields take number literals
//   - contains is for string fields only
//   - lower() is for string fields only
//   - a set is non-empty and homogeneous, and its type matches the field
//   - number literals fall inside the field's range
//
// It re-checks things the RuleAST type already promises (known fields, known operators),
// because RuleAST values arrive from JSON and a cast is not a proof.

import type { Diagnostic, RuleAST, Span } from "../types";
import { diag } from "./diagnostics";
import { isNumberField, isRuleField, isStringField, NUMBER_RANGES } from "./fields";
import { childPath, type SpanMap } from "./spans";

export function typecheck(ast: RuleAST, spans: SpanMap | null = null): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = (key: string): Span | null => spans?.get(key) ?? null;

  const checkLiteral = (field: string, value: unknown, key: string) => {
    if (isStringField(field)) {
      if (typeof value !== "string") {
        out.push(diag("E_TYPE_MISMATCH", `${field} is a string field; found ${describe(value)}.`, at(key)));
      }
      return;
    }
    if (isNumberField(field)) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        out.push(diag("E_TYPE_MISMATCH", `${field} is a number field; found ${describe(value)}.`, at(key)));
        return;
      }
      const range = NUMBER_RANGES[field];
      if (value < range.min || value > range.max) {
        out.push(diag("E_NUMBER_OUT_OF_RANGE", `${field} is ${range.min} to ${range.max}; found ${value}.`, at(key)));
      }
    }
  };

  const checkLower = (field: string, lower: boolean | undefined, path: string) => {
    if (lower && !isStringField(field)) {
      out.push(diag("E_LOWER_ON_NUMBER", `Field is ${field}.`, at(`${path}#field`)));
    }
  };

  const warnUppercase = (lower: boolean | undefined, value: unknown, key: string) => {
    if (lower && typeof value === "string" && value !== value.toLowerCase()) {
      out.push(diag("W_LOWER_UPPERCASE_LITERAL", `Literal is ${JSON.stringify(value)}.`, at(key)));
    }
  };

  const walk = (node: RuleAST, path: string): void => {
    switch (node.kind) {
      case "and":
      case "or":
        walk(node.left, childPath(path, "left"));
        walk(node.right, childPath(path, "right"));
        return;
      case "not":
        walk(node.operand, childPath(path, "operand"));
        return;
      case "compare": {
        if (!isRuleField(node.field)) {
          out.push(diag("E_UNKNOWN_FIELD", `Found ${JSON.stringify(node.field)}.`, at(`${path}#field`)));
          return;
        }
        if (node.op !== "eq" && node.op !== "ne") {
          out.push(diag("E_UNKNOWN_OPERATOR", `Found ${JSON.stringify(node.op)}.`, at(path)));
        }
        checkLower(node.field, node.lower, path);
        checkLiteral(node.field, node.value, `${path}#value`);
        warnUppercase(node.lower, node.value, `${path}#value`);
        return;
      }
      case "contains": {
        if (!isRuleField(node.field)) {
          out.push(diag("E_UNKNOWN_FIELD", `Found ${JSON.stringify(node.field)}.`, at(`${path}#field`)));
          return;
        }
        if (!isStringField(node.field)) {
          out.push(diag("E_CONTAINS_ON_NUMBER", `Field is ${node.field}.`, at(`${path}#field`)));
          return;
        }
        checkLiteral(node.field, node.value, `${path}#value`);
        if (node.value === "") out.push(diag("W_EMPTY_CONTAINS", null, at(`${path}#value`)));
        warnUppercase(node.lower, node.value, `${path}#value`);
        return;
      }
      case "in": {
        if (!isRuleField(node.field)) {
          out.push(diag("E_UNKNOWN_FIELD", `Found ${JSON.stringify(node.field)}.`, at(`${path}#field`)));
          return;
        }
        checkLower(node.field, node.lower, path);
        if (node.values.length === 0) {
          out.push(diag("E_EMPTY_SET", null, at(`${path}#set`)));
          return;
        }
        const types = new Set(node.values.map((v) => typeof v));
        if (types.size > 1) {
          out.push(diag("E_SET_NOT_HOMOGENEOUS", null, at(`${path}#set`)));
          return;
        }
        const seen = new Set<string | number>();
        node.values.forEach((v, i) => {
          const key = `${path}#values.${i}`;
          checkLiteral(node.field, v, key);
          warnUppercase(node.lower, v, key);
          if (seen.has(v)) out.push(diag("W_DUPLICATE_SET_VALUE", `Value ${JSON.stringify(v)}.`, at(key)));
          seen.add(v);
        });
        return;
      }
      default: {
        const unknown: never = node;
        out.push(diag("E_SCHEMA_INVALID", `Unknown node ${JSON.stringify(unknown)}.`, at(path)));
      }
    }
  };

  walk(ast, "");
  return out;
}

function describe(value: unknown): string {
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (typeof value === "number") return `the number ${value}`;
  return typeof value;
}
