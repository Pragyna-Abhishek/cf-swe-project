// Seeded traffic simulator. Pure: (definition, seed, range) in, columnar traffic out.
//
// Generation is order-free because each request has its own generator (see random.ts), so
// any chunk can be produced independently and the concatenation is identical to generating
// the whole scenario in one call. test/unit/simulator.test.ts pins that property.

import { rngForRequest } from "./random";
import type { Population, ScenarioDefinition } from "./scenarios";
import type { ColumnarTraffic, TrafficDictionary } from "./types";

type CompiledPopulation = {
  label: 0 | 1;
  fromMs: number;
  spanMs: number;
  routeWeights: number[];
  routeTotal: number;
  routeMethod: number[];
  routePath: number[];
  routeStatuses: Array<{ values: number[]; weights: number[]; total: number }>;
  asnValues: number[];
  asnWeights: number[];
  asnTotal: number;
  countryIdx: number[];
  countryWeights: number[];
  countryTotal: number;
  uaIdx: number[];
  uaWeights: number[];
  uaTotal: number;
};

export type CompiledScenario = {
  dictionary: TrafficDictionary;
  shareWeights: number[];
  shareTotal: number;
  populations: CompiledPopulation[];
};

const compiledCache = new WeakMap<ScenarioDefinition, CompiledScenario>();

/** Build the dictionary and index tables once per definition. */
export function compileScenario(def: ScenarioDefinition): CompiledScenario {
  const cached = compiledCache.get(def);
  if (cached) return cached;

  const dictionary: TrafficDictionary = { methods: [], paths: [], countries: [], userAgents: [] };
  const intern = (list: string[], value: string): number => {
    const at = list.indexOf(value);
    if (at >= 0) return at;
    list.push(value);
    return list.length - 1;
  };

  const populations = def.populations.map((p: Population): CompiledPopulation => {
    const sum = (xs: readonly (readonly [unknown, number])[]) => xs.reduce((a, [, w]) => a + w, 0);
    return {
      label: p.label === "attack" ? 1 : 0,
      fromMs: Math.floor(p.activeFrom * def.scenario.durationMs),
      spanMs: Math.max(1, Math.floor((p.activeTo - p.activeFrom) * def.scenario.durationMs)),
      routeWeights: p.routes.map((r) => r.weight),
      routeTotal: p.routes.reduce((a, r) => a + r.weight, 0),
      routeMethod: p.routes.map((r) => intern(dictionary.methods, r.method)),
      routePath: p.routes.map((r) => intern(dictionary.paths, r.path)),
      routeStatuses: p.routes.map((r) => ({
        values: r.statuses.map(([s]) => s),
        weights: r.statuses.map(([, w]) => w),
        total: sum(r.statuses),
      })),
      asnValues: p.asns.map(([a]) => a),
      asnWeights: p.asns.map(([, w]) => w),
      asnTotal: sum(p.asns),
      countryIdx: p.countries.map(([c]) => intern(dictionary.countries, c)),
      countryWeights: p.countries.map(([, w]) => w),
      countryTotal: sum(p.countries),
      uaIdx: p.userAgents.map(([u]) => intern(dictionary.userAgents, u)),
      uaWeights: p.userAgents.map(([, w]) => w),
      uaTotal: sum(p.userAgents),
    };
  });

  const compiled: CompiledScenario = {
    dictionary,
    shareWeights: def.populations.map((p) => p.share),
    shareTotal: def.populations.reduce((a, p) => a + p.share, 0),
    populations,
  };
  compiledCache.set(def, compiled);
  return compiled;
}

export function emptyTraffic(
  scenarioId: string,
  seed: number,
  start: number,
  count: number,
  dictionary: TrafficDictionary,
): ColumnarTraffic {
  return {
    scenarioId,
    seed,
    start,
    count,
    dictionary,
    offsetMs: new Uint32Array(count),
    method: new Uint8Array(count),
    path: new Uint16Array(count),
    country: new Uint16Array(count),
    asn: new Uint32Array(count),
    userAgent: new Uint16Array(count),
    status: new Uint16Array(count),
    label: new Uint8Array(count),
  };
}

/**
 * Generate requests [start, start + count) of a scenario. Callers that need to stay inside one
 * CPU slice pass a count no larger than the measured chunk size.
 */
export function generateRange(
  def: ScenarioDefinition,
  seed: number,
  start: number,
  count: number,
): ColumnarTraffic {
  const total = def.scenario.requestCount;
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0) {
    throw new RangeError(`invalid range start=${start} count=${count}`);
  }
  const n = Math.max(0, Math.min(count, total - start));
  const c = compileScenario(def);
  const out = emptyTraffic(def.scenario.id, seed, start, n, c.dictionary);

  for (let i = 0; i < n; i++) {
    const rng = rngForRequest(seed, start + i);
    const pop = c.populations[rng.weighted(c.shareWeights, c.shareTotal)];
    if (!pop) throw new Error("population table is empty");
    const route = rng.weighted(pop.routeWeights, pop.routeTotal);
    const st = pop.routeStatuses[route];
    if (!st) throw new Error("route table is inconsistent");

    out.offsetMs[i] = pop.fromMs + rng.int(pop.spanMs);
    out.method[i] = pop.routeMethod[route] ?? 0;
    out.path[i] = pop.routePath[route] ?? 0;
    out.status[i] = st.values[rng.weighted(st.weights, st.total)] ?? 0;
    out.asn[i] = pop.asnValues[rng.weighted(pop.asnWeights, pop.asnTotal)] ?? 0;
    out.country[i] = pop.countryIdx[rng.weighted(pop.countryWeights, pop.countryTotal)] ?? 0;
    out.userAgent[i] = pop.uaIdx[rng.weighted(pop.uaWeights, pop.uaTotal)] ?? 0;
    out.label[i] = pop.label;
  }
  return out;
}

/** Whole scenario in one call. For tests, the reference path and build-time use only. */
export function generateAll(def: ScenarioDefinition, seed: number): ColumnarTraffic {
  return generateRange(def, seed, 0, def.scenario.requestCount);
}

/** Concatenate chunks that were generated separately, in scenario order. */
export function concatTraffic(chunks: readonly ColumnarTraffic[]): ColumnarTraffic {
  const first = chunks[0];
  if (!first) throw new Error("concatTraffic needs at least one chunk");
  const count = chunks.reduce((a, ch) => a + ch.count, 0);
  const out = emptyTraffic(first.scenarioId, first.seed, first.start, count, first.dictionary);
  let at = 0;
  for (const ch of chunks) {
    if (ch.start !== first.start + at) throw new Error("chunks are not contiguous");
    out.offsetMs.set(ch.offsetMs, at);
    out.method.set(ch.method, at);
    out.path.set(ch.path, at);
    out.country.set(ch.country, at);
    out.asn.set(ch.asn, at);
    out.userAgent.set(ch.userAgent, at);
    out.status.set(ch.status, at);
    out.label.set(ch.label, at);
    at += ch.count;
  }
  return out;
}
