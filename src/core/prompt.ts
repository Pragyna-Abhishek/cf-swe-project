// Prompt assembly. Templates live in prompts/ as files so they are diffable; this file only
// fills them in. Every inserted value goes through jsonForPrompt, so quotes, newlines and
// anything that looks like markup arrive as escaped data inside the delimiters, never as
// prompt structure.

import type { Breakdown, TrafficSummary } from "./types";

export type PromptTemplates = { system: string; user: string };
export type Prompt = { system: string; user: string };

export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`template variable {{${name}}} has no value`);
    return v;
  });
}

/**
 * JSON.stringify escapes quotes and newlines but not angle brackets, so an attacker-controlled
 * user agent containing "</traffic_summary>" would close the delimiter early. Escaping < and >
 * as \u003c and \u003e keeps the JSON equivalent and the delimiters unforgeable.
 */
export function jsonForPrompt(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/** Compact, model-facing view of a summary. Evidence IDs are kept so later phases can cite them. */
export function summaryForPrompt(s: TrafficSummary): unknown {
  const compact = (b: Breakdown) => ({
    evidenceId: b.evidenceId,
    dimension: b.dimension,
    rows: b.rows.map((r) => [r.key, r.count, r.share]),
    otherCount: b.otherCount,
  });
  return {
    totalRequests: s.totalRequests,
    signals: s.signals,
    breakdowns: s.breakdowns.filter((b) => b.dimension !== "timeBucket").map(compact),
    symptomSlice: {
      description: s.symptomSlice.description,
      totalRequests: s.symptomSlice.totalRequests,
      breakdowns: s.symptomSlice.breakdowns.filter((b) => b.dimension !== "timeBucket").map(compact),
    },
  };
}

export function buildDraftRulePrompt(t: PromptTemplates, input: { symptom: string; summary: TrafficSummary }): Prompt {
  return {
    system: t.system,
    user: renderTemplate(t.user, {
      symptom: jsonForPrompt(input.symptom),
      summary: jsonForPrompt(summaryForPrompt(input.summary)),
    }),
  };
}
