// Columnar to row decoding. Used only by tests, the reference evaluator, and display code.
// CLAUDE.md invariant 8: no other code path materializes Request objects.

import type { ColumnarTraffic, HttpMethod, Request } from "./types";

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "DELETE", "HEAD"];

function asMethod(s: string): HttpMethod {
  const m = METHODS.find((x) => x === s);
  if (!m) throw new Error(`unknown method in dictionary: ${s}`);
  return m;
}

export function decodeRequests(t: ColumnarTraffic): Request[] {
  const d = t.dictionary;
  const out: Request[] = new Array(t.count);
  for (let i = 0; i < t.count; i++) {
    out[i] = {
      index: t.start + i,
      offsetMs: t.offsetMs[i] ?? 0,
      method: asMethod(d.methods[t.method[i] ?? 0] ?? ""),
      path: d.paths[t.path[i] ?? 0] ?? "",
      country: d.countries[t.country[i] ?? 0] ?? "",
      asn: t.asn[i] ?? 0,
      userAgent: d.userAgents[t.userAgent[i] ?? 0] ?? "",
      status: t.status[i] ?? 0,
      label: t.label[i] === 1 ? "attack" : "legitimate",
    };
  }
  return out;
}
