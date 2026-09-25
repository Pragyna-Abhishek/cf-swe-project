// Structural caps on a RuleAST. Checked before printing and before evaluation, so a
// pathological rule cannot burn the CPU budget downstream. Iterative, so a hostile depth
// cannot overflow the stack here either.

import type { Diagnostic, RuleAST } from "../types";
import { diag } from "./diagnostics";
import { LIMITS } from "./fields";

export function checkLimits(ast: RuleAST): Diagnostic[] {
  const out: Diagnostic[] = [];
  let nodes = 0;
  let deepest = 0;
  const stack: Array<{ node: RuleAST; depth: number }> = [{ node: ast, depth: 1 }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) break;
    const { node, depth } = top;
    nodes++;
    if (depth > deepest) deepest = depth;
    if (nodes > LIMITS.maxNodes || deepest > LIMITS.maxDepth) break;
    switch (node.kind) {
      case "and":
      case "or":
        stack.push({ node: node.left, depth: depth + 1 }, { node: node.right, depth: depth + 1 });
        break;
      case "not":
        stack.push({ node: node.operand, depth: depth + 1 });
        break;
      case "in":
        if (node.values.length > LIMITS.maxSetSize) {
          out.push(diag("E_SET_TOO_LARGE", `Limit is ${LIMITS.maxSetSize}, found ${node.values.length}.`, null));
        }
        for (const v of node.values) {
          if (typeof v === "string" && v.length > LIMITS.maxStringChars) {
            out.push(diag("E_STRING_TOO_LONG", `Limit is ${LIMITS.maxStringChars}.`, null));
          }
        }
        break;
      case "compare":
      case "contains":
        if (typeof node.value === "string" && node.value.length > LIMITS.maxStringChars) {
          out.push(diag("E_STRING_TOO_LONG", `Limit is ${LIMITS.maxStringChars}.`, null));
        }
        break;
    }
  }
  if (deepest > LIMITS.maxDepth) out.push(diag("E_AST_TOO_DEEP", `Limit is ${LIMITS.maxDepth}.`, null));
  if (nodes > LIMITS.maxNodes) out.push(diag("E_AST_TOO_MANY_NODES", `Limit is ${LIMITS.maxNodes}.`, null));
  return out;
}
