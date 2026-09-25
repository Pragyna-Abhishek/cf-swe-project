// The naive baseline: what a hurried operator does. Take the requests that show the symptom,
// find the single source attribute (ASN, country, or user agent) most concentrated among them,
// and block it. Generated in code from the label-blind summary, so it needs no model and always
// works.
//
// Source attributes only, on purpose. Blocking the attacked endpoint itself (for example
// /login, or a product path) would lock out every real user of that endpoint, and nobody would
// call that a mitigation, so path is deliberately never a candidate here. ASN, country and user
// agent describe the client, not the endpoint, so they are fair game. Blocking where the attack
// comes from is the common first move, and on a trap scenario it is exactly the move that causes
// collateral damage.

import type { Breakdown, RuleAST, TrafficSummary } from "./types";

export type BaselineChoice = { ast: RuleAST; dimension: "asn" | "country" | "userAgent"; key: string; share: number };

export function naiveBaseline(summary: TrafficSummary): BaselineChoice | null {
  const find = (dimension: "asn" | "country" | "userAgent"): Breakdown | undefined =>
    summary.symptomSlice.breakdowns.find((b) => b.dimension === dimension);
  const candidates: BaselineChoice[] = [];
  const asnTop = find("asn")?.rows[0];
  if (asnTop && /^\d+$/.test(asnTop.key)) {
    candidates.push({
      ast: { kind: "compare", field: "ip.src.asnum", op: "eq", value: Number(asnTop.key) },
      dimension: "asn",
      key: asnTop.key,
      share: asnTop.share,
    });
  }
  const countryTop = find("country")?.rows[0];
  if (countryTop) {
    candidates.push({
      ast: { kind: "compare", field: "ip.src.country", op: "eq", value: countryTop.key },
      dimension: "country",
      key: countryTop.key,
      share: countryTop.share,
    });
  }
  const userAgentTop = find("userAgent")?.rows[0];
  if (userAgentTop) {
    candidates.push({
      ast: { kind: "compare", field: "http.user_agent", op: "eq", value: userAgentTop.key },
      dimension: "userAgent",
      key: userAgentTop.key,
      share: userAgentTop.share,
    });
  }
  // Highest share wins; ties go to whichever candidate was pushed first (asn, then country,
  // then userAgent), since Array#sort is stable.
  candidates.sort((a, b) => b.share - a.share);
  return candidates[0] ?? null;
}
