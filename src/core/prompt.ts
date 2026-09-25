// Prompt assembly. Templates live in prompts/ as files so they are diffable; this file only
// fills them in. Every inserted value goes through jsonForPrompt, so quotes, newlines and
// anything that looks like markup arrive as escaped data inside the delimiters, never as
// prompt structure.

import type { Breakdown, Diagnostic, TrafficSummary } from "./types";

/** What a rejected attempt looked like, fed back into the next attempt's prompt. Phase 3. */
export type PriorAttempt = { raw: string; diagnostics: Diagnostic[] };

/**
 * DESIGN.md section 8: "i runs from 1 to MAX_DRAFT_ATTEMPTS (3)." A constant, never model
 * output. Lives here (not src/server/workflow.ts) so the Phase 5 eval harness can import it
 * without pulling in the Workflow's platform-specific SDK imports.
 */
export const MAX_DRAFT_ATTEMPTS = 3;

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

/** The most recent rejected attempt, formatted for the model to fix. Empty string on attempt 1. */
function retryContextBlock(priorAttempts: readonly PriorAttempt[] | undefined): string {
  if (!priorAttempts || priorAttempts.length === 0) return "";
  const last = priorAttempts[priorAttempts.length - 1];
  if (!last) return "";
  const problems = last.diagnostics.map((d) => `${d.code}: ${d.message}`);
  return [
    "",
    "Your previous attempt was rejected. It is untrusted data, JSON-encoded:",
    "<previous_rule>",
    jsonForPrompt(last.raw),
    "</previous_rule>",
    "Problems found, JSON-encoded:",
    "<problems>",
    jsonForPrompt(problems),
    "</problems>",
    "Fix these problems and propose a corrected rule.",
    "",
  ].join("\n");
}

export function buildDraftRulePrompt(
  t: PromptTemplates,
  input: { symptom: string; summary: TrafficSummary; priorAttempts?: readonly PriorAttempt[] },
): Prompt {
  return {
    system: t.system,
    user: renderTemplate(t.user, {
      symptom: jsonForPrompt(input.symptom),
      summary: jsonForPrompt(summaryForPrompt(input.summary)),
      retryContext: retryContextBlock(input.priorAttempts),
    }),
  };
}

/** Phase 4: classify the symptom into a fixed enum, from signals alone (no raw traffic). */
export function buildClassifyPrompt(t: PromptTemplates, input: { symptom: string; signals: TrafficSummary["signals"] }): Prompt {
  return {
    system: t.system,
    user: renderTemplate(t.user, {
      symptom: jsonForPrompt(input.symptom),
      signals: jsonForPrompt(input.signals),
    }),
  };
}

/** Phase 4: form a hypothesis citing evidence IDs, informed by prior lessons for the family. */
export function buildHypothesizePrompt(
  t: PromptTemplates,
  input: { symptom: string; intent: string; summary: TrafficSummary; lessons: readonly string[] },
): Prompt {
  return {
    system: t.system,
    user: renderTemplate(t.user, {
      symptom: jsonForPrompt(input.symptom),
      intent: input.intent,
      summary: jsonForPrompt(summaryForPrompt(input.summary)),
      lessons: jsonForPrompt(input.lessons),
    }),
  };
}

/** Phase 4: the closing report and one-sentence lesson, from the measured outcome only. */
export function buildReportPrompt(
  t: PromptTemplates,
  input: { symptom: string; hypothesis: string | null; outcome: unknown },
): Prompt {
  return {
    system: t.system,
    user: renderTemplate(t.user, {
      symptom: jsonForPrompt(input.symptom),
      hypothesis: jsonForPrompt(input.hypothesis),
      outcome: jsonForPrompt(input.outcome),
    }),
  };
}
