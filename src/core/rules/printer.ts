// AST to Rules text. The model never writes rule text; this does.
//
// The printer adds exactly the parentheses the parser needs to rebuild the same tree, which
// is what makes the round-trip assertion hold: parse(print(ast)) deep-equals ast.
//   - A child binds less tightly than its parent: parenthesize.
//   - The right child of `and` or `or` is the same operator: parenthesize, because the parser
//     folds to the left and would otherwise rebuild a different tree.
//   - The operand of `not` is anything but a comparison: parenthesize. The grammar only allows
//     `not primary`, so `not not a` must print as `not (not a)`.

import type { RuleAST, Span } from "../types";
import { childPath, type SpanMap } from "./spans";

const PREC = { or: 1, and: 2, not: 3, leaf: 4 } as const;

function precedence(node: RuleAST): number {
  switch (node.kind) {
    case "or":
      return PREC.or;
    case "and":
      return PREC.and;
    case "not":
      return PREC.not;
    default:
      return PREC.leaf;
  }
}

export function quoteString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function literal(value: string | number): string {
  return typeof value === "number" ? String(value) : quoteString(value);
}

export type Printed = { text: string; spans: SpanMap };

export function print(ast: RuleAST): Printed {
  const spans: SpanMap = new Map();
  let out = "";
  const emit = (s: string): Span => {
    const start = out.length;
    out += s;
    return { start, end: out.length };
  };

  const walk = (node: RuleAST, path: string, minPrec: number): void => {
    const start = out.length;
    const parens = precedence(node) < minPrec;
    if (parens) emit("(");

    switch (node.kind) {
      case "and":
      case "or": {
        const p = precedence(node);
        walk(node.left, childPath(path, "left"), p);
        emit(` ${node.kind} `);
        walk(node.right, childPath(path, "right"), p + 1);
        break;
      }
      case "not":
        emit("not ");
        walk(node.operand, childPath(path, "operand"), PREC.leaf);
        break;
      case "compare":
      case "contains":
      case "in": {
        let fieldSpan: Span;
        if (node.lower) {
          emit("lower(");
          fieldSpan = emit(node.field);
          emit(")");
        } else {
          fieldSpan = emit(node.field);
        }
        spans.set(`${path}#field`, fieldSpan);
        if (node.kind === "in") {
          emit(" in ");
          const setStart = out.length;
          emit("{");
          node.values.forEach((v, i) => {
            if (i > 0) emit(" ");
            spans.set(`${path}#values.${i}`, emit(literal(v)));
          });
          emit("}");
          spans.set(`${path}#set`, { start: setStart, end: out.length });
        } else {
          emit(` ${node.kind === "compare" ? node.op : "contains"} `);
          spans.set(`${path}#value`, emit(literal(node.value)));
        }
        break;
      }
    }

    if (parens) emit(")");
    spans.set(path, { start, end: out.length });
  };

  walk(ast, "", 0);
  return { text: out, spans };
}
