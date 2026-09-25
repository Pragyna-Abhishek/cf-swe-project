// Naive reference evaluator over decoded Request objects. Deliberately simple and written
// without sharing any code with evaluate.ts: it walks the AST per request and compares
// strings directly. It exists so the columnar evaluator has something independent to agree
// with. Not used at runtime.

import type { ReplayCounts, Request, RuleAST } from "../types";

function fieldValue(r: Request, field: string): string | number {
  switch (field) {
    case "http.request.method":
      return r.method;
    case "http.request.uri.path":
      return r.path;
    case "http.user_agent":
      return r.userAgent;
    case "ip.src.country":
      return r.country;
    case "http.response.code":
      return r.status;
    case "ip.src.asnum":
      return r.asn;
    default:
      throw new Error(`unknown field ${field}`);
  }
}

export function referenceMatches(ast: RuleAST, r: Request): boolean {
  switch (ast.kind) {
    case "and":
      return referenceMatches(ast.left, r) && referenceMatches(ast.right, r);
    case "or":
      return referenceMatches(ast.left, r) || referenceMatches(ast.right, r);
    case "not":
      return !referenceMatches(ast.operand, r);
    case "compare": {
      let v = fieldValue(r, ast.field);
      if (ast.lower && typeof v === "string") v = v.toLowerCase();
      return ast.op === "eq" ? v === ast.value : v !== ast.value;
    }
    case "contains": {
      let v = fieldValue(r, ast.field);
      if (typeof v !== "string") return false;
      if (ast.lower) v = v.toLowerCase();
      return v.includes(ast.value);
    }
    case "in": {
      let v = fieldValue(r, ast.field);
      if (ast.lower && typeof v === "string") v = v.toLowerCase();
      return ast.values.includes(v);
    }
  }
}

export function referenceReplay(ast: RuleAST, requests: readonly Request[]): ReplayCounts {
  const c: ReplayCounts = { attackTotal: 0, attackBlocked: 0, legitimateTotal: 0, legitimateBlocked: 0 };
  for (const r of requests) {
    const blocked = referenceMatches(ast, r);
    if (r.label === "attack") {
      c.attackTotal++;
      if (blocked) c.attackBlocked++;
    } else {
      c.legitimateTotal++;
      if (blocked) c.legitimateBlocked++;
    }
  }
  return c;
}
