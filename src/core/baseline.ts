// The naive baseline: what a hurried operator does. Take the requests that show the symptom,
// find the single source attribute (ASN or country) most concentrated among them, and block
// it. Generated in code from the label-blind summary, so it needs no model and always works.
//
// Source attributes only, on purpose. Blocking the attacked endpoint itself (for example
// /login) would lock out every real user of that endpoint, and nobody would call that a
// mitigation. Blocking where the attack comes from is the common first move, and on a trap
// scenario it is exactly the move that causes collateral damage.

import type { Breakdown, RuleAST, TrafficSummary } from "./types";

export type BaselineChoice = { ast: RuleAST; dimension: "asn" | "country"; key: string; share: number };

export function naiveBaseline(summary: TrafficSummary): BaselineChoice | null {
  const find = (dimension: "asn" | "country"): Breakdown | undefined =>
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
  // Highest share wins; ties go to ASN, which comes first.
  candidates.sort((a, b) => b.share - a.share);
  return candidates[0] ?? null;
}
