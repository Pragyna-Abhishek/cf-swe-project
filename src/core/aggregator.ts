// Label-blind aggregation. One pass per chunk produces a mergeable partial; finalizing the
// merged partials produces the TrafficSummary the model sees and the panel the UI draws.
//
// The label column is never read here. CLAUDE.md invariant 4: the model never sees ground
// truth, and the cheapest way to guarantee that is for the aggregator to not look at it.

import { sanitizeAttribute } from "./sanitize";
import type { Breakdown, BreakdownDimension, BreakdownRow, ColumnarTraffic, TrafficSummary } from "./types";

export const TIME_BUCKETS = 20;
export const BREAKDOWN_ROW_CAP = 8;
export const SYMPTOM_STATUS = 401;

/** Status classes shown on the traffic panel. */
export const STATUS_CLASSES = ["ok", "unauthorized", "rateLimited", "otherError"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export function statusClassIndex(status: number): number {
  if (status === 401) return 1;
  if (status === 429) return 2;
  if (status >= 400) return 3;
  return 0;
}

/** Counts for one set of requests. Plain arrays and records so it survives RPC and JSON. */
export type DimensionCounts = {
  total: number;
  method: number[];
  path: number[];
  country: number[];
  userAgent: number[];
  asn: Record<string, number>;
  status: Record<string, number>;
  timeBucket: number[];
};

export type PartialAggregate = {
  scenarioId: string;
  seed: number;
  durationMs: number;
  all: DimensionCounts;
  symptom: DimensionCounts;
  /** panel[bucket][statusClass] */
  panel: number[][];
};

function emptyCounts(t: ColumnarTraffic): DimensionCounts {
  return {
    total: 0,
    method: new Array<number>(t.dictionary.methods.length).fill(0),
    path: new Array<number>(t.dictionary.paths.length).fill(0),
    country: new Array<number>(t.dictionary.countries.length).fill(0),
    userAgent: new Array<number>(t.dictionary.userAgents.length).fill(0),
    asn: {},
    status: {},
    timeBucket: new Array<number>(TIME_BUCKETS).fill(0),
  };
}

export function inc(counts: number[], i: number): void {
  counts[i] = (counts[i] ?? 0) + 1;
}

export function bucketOf(offsetMs: number, durationMs: number): number {
  const b = Math.floor((offsetMs * TIME_BUCKETS) / durationMs);
  return b < 0 ? 0 : b >= TIME_BUCKETS ? TIME_BUCKETS - 1 : b;
}

export function emptyPanel(): number[][] {
  return Array.from({ length: TIME_BUCKETS }, () => new Array<number>(STATUS_CLASSES.length).fill(0));
}

/** One pass over one chunk. Bounded by chunk size, so it fits one CPU slice. */
export function aggregateChunk(t: ColumnarTraffic, durationMs: number): PartialAggregate {
  const all = emptyCounts(t);
  const symptom = emptyCounts(t);
  const panel = emptyPanel();

  const bump = (c: DimensionCounts, i: number, bucket: number) => {
    c.total++;
    inc(c.method, t.method[i] ?? 0);
    inc(c.path, t.path[i] ?? 0);
    inc(c.country, t.country[i] ?? 0);
    inc(c.userAgent, t.userAgent[i] ?? 0);
    const asn = String(t.asn[i] ?? 0);
    c.asn[asn] = (c.asn[asn] ?? 0) + 1;
    const status = String(t.status[i] ?? 0);
    c.status[status] = (c.status[status] ?? 0) + 1;
    inc(c.timeBucket, bucket);
  };

  for (let i = 0; i < t.count; i++) {
    const bucket = bucketOf(t.offsetMs[i] ?? 0, durationMs);
    const status = t.status[i] ?? 0;
    bump(all, i, bucket);
    if (status === SYMPTOM_STATUS) bump(symptom, i, bucket);
    const row = panel[bucket];
    if (row) inc(row, statusClassIndex(status));
  }
  return { scenarioId: t.scenarioId, seed: t.seed, durationMs, all, symptom, panel };
}

function addArrays(a: number[], b: readonly number[]): number[] {
  return a.map((v, i) => v + (b[i] ?? 0));
}

function addRecords(a: Record<string, number>, b: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function mergeCounts(a: DimensionCounts, b: DimensionCounts): DimensionCounts {
  return {
    total: a.total + b.total,
    method: addArrays(a.method, b.method),
    path: addArrays(a.path, b.path),
    country: addArrays(a.country, b.country),
    userAgent: addArrays(a.userAgent, b.userAgent),
    asn: addRecords(a.asn, b.asn),
    status: addRecords(a.status, b.status),
    timeBucket: addArrays(a.timeBucket, b.timeBucket),
  };
}

export function mergePartials(a: PartialAggregate, b: PartialAggregate): PartialAggregate {
  if (a.scenarioId !== b.scenarioId || a.seed !== b.seed) {
    throw new Error("cannot merge partials from different scenarios");
  }
  return {
    ...a,
    all: mergeCounts(a.all, b.all),
    symptom: mergeCounts(a.symptom, b.symptom),
    panel: a.panel.map((row, i) => addArrays(row, b.panel[i] ?? [])),
  };
}

// ---------------------------------------------------------------------------
// Finalizing
// ---------------------------------------------------------------------------

/** Dimension order is fixed, so evidence IDs are stable: ev_1 is always the path breakdown. */
export const DIMENSION_ORDER: readonly BreakdownDimension[] = [
  "path",
  "method",
  "country",
  "asn",
  "userAgent",
  "status",
  "timeBucket",
];

export function breakdownEvidenceId(slice: "all" | "symptom", dimension: BreakdownDimension): string {
  const n = DIMENSION_ORDER.indexOf(dimension) + 1 + (slice === "symptom" ? DIMENSION_ORDER.length : 0);
  return `ev_${n}`;
}

function formatBucket(bucket: number, durationMs: number): string {
  const fmt = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const size = durationMs / TIME_BUCKETS;
  return `${fmt(bucket * size)}-${fmt((bucket + 1) * size)}`;
}

function toRows(entries: Array<[string, number]>, total: number): { rows: BreakdownRow[]; otherCount: number } {
  const nonzero = entries.filter(([, c]) => c > 0);
  // Ties break on key so the output is identical across runs and chunkings.
  nonzero.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const kept = nonzero.slice(0, BREAKDOWN_ROW_CAP);
  const keptCount = kept.reduce((a, [, c]) => a + c, 0);
  return {
    rows: kept.map(([key, count]) => ({
      key: sanitizeAttribute(key),
      count,
      share: total === 0 ? 0 : round4(count / total),
    })),
    otherCount: total - keptCount,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function breakdownsFor(
  c: DimensionCounts,
  t: { dictionary: ColumnarTraffic["dictionary"] },
  durationMs: number,
  slice: "all" | "symptom",
): Breakdown[] {
  const d = t.dictionary;
  const byIndex = (names: readonly string[], counts: readonly number[]): Array<[string, number]> =>
    names.map((name, i) => [name, counts[i] ?? 0]);
  const entries: Record<BreakdownDimension, Array<[string, number]>> = {
    path: byIndex(d.paths, c.path),
    method: byIndex(d.methods, c.method),
    country: byIndex(d.countries, c.country),
    asn: Object.entries(c.asn),
    userAgent: byIndex(d.userAgents, c.userAgent),
    status: Object.entries(c.status),
    timeBucket: c.timeBucket.map((n, b): [string, number] => [formatBucket(b, durationMs), n]),
  };
  return DIMENSION_ORDER.map((dimension) => {
    if (dimension === "timeBucket") {
      // Time is shown in order, not by count, and never truncated.
      return {
        dimension,
        rows: entries.timeBucket.map(([key, count]) => ({
          key,
          count,
          share: c.total === 0 ? 0 : round4(count / c.total),
        })),
        otherCount: 0,
        evidenceId: breakdownEvidenceId(slice, dimension),
      };
    }
    return { dimension, ...toRows(entries[dimension], c.total), evidenceId: breakdownEvidenceId(slice, dimension) };
  });
}

export function finalizeSummary(p: PartialAggregate, dictionary: ColumnarTraffic["dictionary"]): TrafficSummary {
  const total = p.all.total;
  const share = (n: number) => (total === 0 ? 0 : round4(n / total));
  let errors = 0;
  for (const [status, n] of Object.entries(p.all.status)) if (Number(status) >= 400) errors += n;
  return {
    scenarioId: p.scenarioId,
    seed: p.seed,
    window: { fromMs: 0, toMs: p.durationMs },
    totalRequests: total,
    breakdowns: breakdownsFor(p.all, { dictionary }, p.durationMs, "all"),
    symptomSlice: {
      description: `requests that returned HTTP ${SYMPTOM_STATUS}`,
      totalRequests: p.symptom.total,
      breakdowns: breakdownsFor(p.symptom, { dictionary }, p.durationMs, "symptom"),
    },
    signals: {
      errorRate: share(errors),
      status401Share: share(p.all.status["401"] ?? 0),
      status429Share: share(p.all.status["429"] ?? 0),
    },
  };
}
