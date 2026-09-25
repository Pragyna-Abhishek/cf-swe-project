// Spans keyed by node path, so diagnostics from the type checker (which walks an AST) can be
// placed on text produced by the printer or read by the parser.
//
// Paths: "" is the root; children are "left", "right", "operand", joined with ".".
// Sub-parts of a comparison use "#": "left#field", "left#value", "left#values.2", "left#set".

import type { RuleAST, Span } from "../types";

export type SpanMap = Map<string, Span>;

export type NodeParts = { field?: Span; value?: Span; values?: Span[]; set?: Span };

export function childPath(path: string, segment: "left" | "right" | "operand"): string {
  return path === "" ? segment : `${path}.${segment}`;
}

/** Walk an AST whose nodes were given spans by identity, and key those spans by path. */
export function spansByPath(
  ast: RuleAST,
  nodeSpans: WeakMap<RuleAST, Span>,
  parts: WeakMap<RuleAST, NodeParts>,
): SpanMap {
  const out: SpanMap = new Map();
  const walk = (node: RuleAST, path: string) => {
    const s = nodeSpans.get(node);
    if (s) out.set(path, s);
    const p = parts.get(node);
    if (p?.field) out.set(`${path}#field`, p.field);
    if (p?.value) out.set(`${path}#value`, p.value);
    if (p?.set) out.set(`${path}#set`, p.set);
    p?.values?.forEach((v, i) => out.set(`${path}#values.${i}`, v));
    switch (node.kind) {
      case "and":
      case "or":
        walk(node.left, childPath(path, "left"));
        walk(node.right, childPath(path, "right"));
        return;
      case "not":
        walk(node.operand, childPath(path, "operand"));
        return;
      default:
        return;
    }
  };
  walk(ast, "");
  return out;
}
