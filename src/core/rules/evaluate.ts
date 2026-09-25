// Columnar evaluator. Works in integer space: every string predicate is decided once per
// dictionary entry, up front, and becomes a lookup table indexed by the dictionary code. The
// per-request work is then table lookups and integer comparisons over typed arrays.
//
// Evaluation is column at a time: each node produces a 0/1 mask over the chunk, and and/or/not
// combine masks. No short circuiting, but no per-request recursion or branching on node kind
// either, and the cost is predictable: (nodes x requests) simple operations, bounded by the AST
// caps and the chunk size.
//
// Correctness argument: test/unit/rules/evaluate.property.test.ts checks this against the
// naive reference evaluator in reference.ts on generated rules and traffic.

import { bucketOf, emptyPanel, statusClassIndex } from "../aggregator";
import type { ColumnarTraffic, Diagnostic, ReplayCounts, RuleAST, StringField, TrafficDictionary } from "../types";
import { diag, hasErrors } from "./diagnostics";
import { checkLimits } from "./limits";
import { typecheck } from "./typecheck";

type Column = "method" | "path" | "userAgent" | "country";

const STRING_COLUMN: Readonly<Record<StringField, { column: Column; dict: keyof TrafficDictionary }>> = {
  "http.request.method": { column: "method", dict: "methods" },
  "http.request.uri.path": { column: "path", dict: "paths" },
  "http.user_agent": { column: "userAgent", dict: "userAgents" },
  "ip.src.country": { column: "country", dict: "countries" },
};

/** A compiled node. Leaves hold everything they need; nothing is looked up per request. */
type Compiled =
  | { kind: "and" | "or"; left: Compiled; right: Compiled }
  | { kind: "not"; operand: Compiled }
  | { kind: "table"; column: Column; table: Uint8Array }
  | { kind: "number"; column: "asn" | "status"; values: readonly number[]; negate: boolean };

export type CompiledRule = { root: Compiled; dictionary: TrafficDictionary };

export type CompileResult = { ok: true; rule: CompiledRule } | { ok: false; diagnostics: Diagnostic[] };

/**
 * Compile a rule against a scenario dictionary. Refuses anything that does not pass the limits
 * and the type checker: the evaluator only ever runs verified rules.
 */
export function compileRule(ast: RuleAST, dictionary: TrafficDictionary): CompileResult {
  const limits = checkLimits(ast);
  if (limits.length > 0) return { ok: false, diagnostics: limits };
  const types = typecheck(ast);
  if (hasErrors(types)) return { ok: false, diagnostics: types };
  try {
    return { ok: true, rule: { root: compileNode(ast, dictionary), dictionary } };
  } catch (e) {
    return { ok: false, diagnostics: [diag("E_TYPE_MISMATCH", e instanceof Error ? e.message : String(e), null)] };
  }
}

function stringTable(
  entries: readonly string[],
  lower: boolean | undefined,
  predicate: (value: string) => boolean,
): Uint8Array {
  const table = new Uint8Array(entries.length);
  for (let j = 0; j < entries.length; j++) {
    const raw = entries[j] ?? "";
    table[j] = predicate(lower ? raw.toLowerCase() : raw) ? 1 : 0;
  }
  return table;
}

function compileNode(node: RuleAST, d: TrafficDictionary): Compiled {
  switch (node.kind) {
    case "and":
    case "or":
      return { kind: node.kind, left: compileNode(node.left, d), right: compileNode(node.right, d) };
    case "not":
      return { kind: "not", operand: compileNode(node.operand, d) };
    case "contains": {
      const { column, dict } = STRING_COLUMN[node.field];
      const needle = node.value;
      return { kind: "table", column, table: stringTable(d[dict], node.lower, (s) => s.includes(needle)) };
    }
    case "compare":
    case "in": {
      const values = node.kind === "in" ? node.values : [node.value];
      const negate = node.kind === "compare" && node.op === "ne";
      if (node.field === "ip.src.asnum" || node.field === "http.response.code") {
        const nums = values.map((v) => {
          if (typeof v !== "number") throw new Error(`${node.field} needs number literals`);
          return v;
        });
        return { kind: "number", column: node.field === "ip.src.asnum" ? "asn" : "status", values: nums, negate };
      }
      const { column, dict } = STRING_COLUMN[node.field];
      const wanted = new Set(values.map((v) => {
        if (typeof v !== "string") throw new Error(`${node.field} needs string literals`);
        return v;
      }));
      return {
        kind: "table",
        column,
        table: stringTable(d[dict], node.lower, (s) => wanted.has(s) !== negate),
      };
    }
  }
}

function evalMask(node: Compiled, t: ColumnarTraffic): Uint8Array {
  const n = t.count;
  const out = new Uint8Array(n);
  switch (node.kind) {
    case "table": {
      const col = t[node.column];
      const table = node.table;
      for (let i = 0; i < n; i++) out[i] = table[col[i] ?? 0] ?? 0;
      return out;
    }
    case "number": {
      const col = node.column === "asn" ? t.asn : t.status;
      const vs = node.values;
      const hit = node.negate ? 0 : 1;
      const miss = node.negate ? 1 : 0;
      if (vs.length === 1) {
        const v = vs[0];
        for (let i = 0; i < n; i++) out[i] = col[i] === v ? hit : miss;
      } else {
        const set = new Set(vs);
        for (let i = 0; i < n; i++) out[i] = set.has(col[i] ?? -1) ? hit : miss;
      }
      return out;
    }
    case "not": {
      const m = evalMask(node.operand, t);
      for (let i = 0; i < n; i++) out[i] = (m[i] ?? 0) ^ 1;
      return out;
    }
    case "and": {
      const a = evalMask(node.left, t);
      const b = evalMask(node.right, t);
      for (let i = 0; i < n; i++) out[i] = (a[i] ?? 0) & (b[i] ?? 0);
      return out;
    }
    case "or": {
      const a = evalMask(node.left, t);
      const b = evalMask(node.right, t);
      for (let i = 0; i < n; i++) out[i] = (a[i] ?? 0) | (b[i] ?? 0);
      return out;
    }
  }
}

/** Which requests in the chunk the rule blocks. Exposed for tests. */
export function matchMask(rule: CompiledRule, t: ColumnarTraffic): Uint8Array {
  // A cheap sanity check, not a proof: comparing every string would cost more than evaluating.
  const a = t.dictionary;
  const b = rule.dictionary;
  if (
    a !== b &&
    (a.methods.length !== b.methods.length ||
      a.paths.length !== b.paths.length ||
      a.countries.length !== b.countries.length ||
      a.userAgents.length !== b.userAgents.length)
  ) {
    throw new Error("rule was compiled against a different dictionary");
  }
  return evalMask(rule.root, t);
}

export type ChunkReplay = {
  counts: ReplayCounts;
  /** blockedPanel[bucket][statusClass]: blocked requests, for the recovery panel. */
  blockedPanel: number[][];
};

/**
 * Replay one chunk. This is the only place the label column is read, and it only ever
 * leaves as the four counts. CLAUDE.md invariant 5: every operator-facing number derives
 * from these.
 */
export function replayChunk(rule: CompiledRule, t: ColumnarTraffic, durationMs: number): ChunkReplay {
  const mask = matchMask(rule, t);
  const counts: ReplayCounts = { attackTotal: 0, attackBlocked: 0, legitimateTotal: 0, legitimateBlocked: 0 };
  const blockedPanel = emptyPanel();
  for (let i = 0; i < t.count; i++) {
    const blocked = mask[i] === 1;
    if (t.label[i] === 1) {
      counts.attackTotal++;
      if (blocked) counts.attackBlocked++;
    } else {
      counts.legitimateTotal++;
      if (blocked) counts.legitimateBlocked++;
    }
    if (blocked) {
      const row = blockedPanel[bucketOf(t.offsetMs[i] ?? 0, durationMs)];
      const cls = statusClassIndex(t.status[i] ?? 0);
      if (row) row[cls] = (row[cls] ?? 0) + 1;
    }
  }
  return { counts, blockedPanel };
}

export function addCounts(a: ReplayCounts, b: ReplayCounts): ReplayCounts {
  return {
    attackTotal: a.attackTotal + b.attackTotal,
    attackBlocked: a.attackBlocked + b.attackBlocked,
    legitimateTotal: a.legitimateTotal + b.legitimateTotal,
    legitimateBlocked: a.legitimateBlocked + b.legitimateBlocked,
  };
}

export function mergeChunkReplays(a: ChunkReplay, b: ChunkReplay): ChunkReplay {
  return {
    counts: addCounts(a.counts, b.counts),
    blockedPanel: a.blockedPanel.map((row, i) => row.map((v, j) => v + (b.blockedPanel[i]?.[j] ?? 0))),
  };
}
