// InvestigationWorkflow. The sequence is fixed in code; the model decides nothing about which
// steps run. DESIGN.md section 8 has the full table. Phase 1 runs one draft attempt; the
// bounded retry loop is Phase 3.
//
// Determinism rules this file obeys (Rules of Workflows):
//   - Step names are constants. The attempt number in a name comes from a constant.
//   - Every value that crosses a step boundary is a step return: IDs, digests, counts, and one
//     summary. Never traffic. CLAUDE.md invariant 9.
//   - No Date.now() or randomness outside steps. The seed comes from the payload.

import { AgentWorkflow, WorkflowRejectedError, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import { planChunks } from "../core/chunks";
import { buildDraftRulePrompt } from "../core/prompt";
import { toReplayResult } from "../core/replay";
import { mergeChunkReplays, type ChunkReplay } from "../core/rules/evaluate";
import { RULE_JSON_SCHEMA } from "../core/rules/schema";
import { findScenario } from "../core/scenarios";
import type { ReplayResult, RuleVersionStatus, TrafficSummary } from "../core/types";
import type { IncidentAgent } from "./agent";
import { modelFor } from "./model";
import { DRAFT_RULE_TEMPLATES } from "./prompts";
import type { InvestigationParams } from "./views";

export const STEP = {
  ensureTraffic: "ensure-traffic",
  aggregateTraffic: "aggregate-traffic",
  draftRule: "draft-rule-attempt-1",
  validateRule: "validate-rule-attempt-1",
  replayRule: "replay-rule-attempt-1",
  baselineRule: "naive-baseline",
  replayBaseline: "replay-naive-baseline",
  failIncident: "fail-incident",
  publishProposal: "publish-proposal",
  waitForApproval: "wait-for-approval",
  markTimedOut: "mark-timed-out",
  applyRule: "apply-rule",
  verifyRecovery: "verify-recovery",
  persistIncident: "persist-incident",
} as const;

const ATTEMPT = 1;

// Step results are plain data. RPC results arrive branded Disposable, which a step cannot
// serialize, so every tracked step names its plain result type explicitly.
type TrafficDigest = { digest: string; count: number; chunks: number };
type Validation = { status: RuleVersionStatus; diagnosticCodes: string[] };
type Applied = { ruleVersionId: string };
const APPROVAL_TIMEOUT = "7 days";

// Retry policies from DESIGN.md section 8.
const cpuHeavy = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
const cheap = { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "1 minute" } as const;
const modelCall = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

export class InvestigationWorkflow extends AgentWorkflow<IncidentAgent, InvestigationParams> {
  override async run(event: AgentWorkflowEvent<InvestigationParams>, step: AgentWorkflowStep) {
    const p = event.payload;
    const def = findScenario(p.scenarioId);
    if (!def) throw new NonRetryableError(`unknown scenario ${p.scenarioId}`);
    const agent = this.agent;

    /** Record step progress for the UI from inside the step, so a replayed step does not repeat it. */
    const tracked = async <T>(name: string, fn: () => Promise<T>, detail?: (r: T) => string | null): Promise<T> => {
      await agent.recordStep(p.incidentId, name, "running", null);
      try {
        const r = await fn();
        await agent.recordStep(p.incidentId, name, "complete", detail ? detail(r) : null);
        return r;
      } catch (e) {
        await agent.recordStep(p.incidentId, name, "error", e instanceof Error ? e.message.slice(0, 300) : String(e));
        throw e;
      }
    };

    // 1. Traffic exists, chunk by chunk. Each chunk is a separate call into the Agent.
    const traffic = await step.do(STEP.ensureTraffic, cpuHeavy, () =>
      tracked<TrafficDigest>(
        STEP.ensureTraffic,
        async () => {
          for (const c of planChunks(def.scenario.requestCount)) await agent.ensureTrafficChunk(p.scenarioId, p.seed, c.index);
          return agent.trafficDigest(p.scenarioId, p.seed);
        },
        (r) => `${r.count} requests in ${r.chunks} chunks, digest ${r.digest}`,
      ),
    );

    // 4. Summaries only. This is the whole of what the model will see about traffic.
    const summary = await step.do(STEP.aggregateTraffic, cpuHeavy, () =>
      tracked<TrafficSummary>(
        STEP.aggregateTraffic,
        () => agent.summarizeTraffic(p.incidentId, p.scenarioId, p.seed),
        (s) => `${s.breakdowns.length + s.symptomSlice.breakdowns.length} breakdowns over ${s.totalRequests} requests`,
      ),
    );

    // 6. One draft. Rate limits and transport errors throw, so the step retries with backoff.
    const draftId = await step.do(STEP.draftRule, modelCall, () =>
      tracked<string>(STEP.draftRule, async () => {
        const model = modelFor(this.env);
        const prompt = buildDraftRulePrompt(DRAFT_RULE_TEMPLATES, { symptom: p.symptom, summary });
        const response = await model.generateJson({ ...prompt, purpose: "draft-rule", jsonSchema: RULE_JSON_SCHEMA });
        if (response.kind === "rate-limited" || response.kind === "error") {
          throw new Error(`model call failed (${response.kind}): ${response.message}`);
        }
        return agent.recordDraft(p.incidentId, ATTEMPT, response);
      }),
    );

    // 7. Schema, limits, types, print, parse, round trip.
    const validation = await step.do(STEP.validateRule, cheap, () =>
      tracked<Validation>(
        STEP.validateRule,
        () => agent.validateRuleVersion(draftId),
        (v) => (v.diagnosticCodes.length ? `${v.status}: ${v.diagnosticCodes.join(", ")}` : v.status),
      ),
    );

    if (validation.status !== "valid") {
      // No retry loop in Phase 1: a failed draft fails the incident, visibly, with its reason.
      await step.do(STEP.failIncident, cheap, () =>
        tracked<string>(STEP.failIncident, async () => {
          await agent.markIncident(p.incidentId, "failed", `draft ${validation.status}: ${validation.diagnosticCodes.join(", ")}`);
          return validation.status;
        }),
      );
      return { status: "failed" as const };
    }

    // 8. Replay the proposal, and the naive baseline beside it.
    const replayAll = async (ruleVersionId: string, fromText: boolean): Promise<ChunkReplay> => {
      let merged: ChunkReplay | null = null;
      for (const c of planChunks(def.scenario.requestCount)) {
        const part = await agent.replayRuleChunk(ruleVersionId, c.index, fromText);
        merged = merged ? mergeChunkReplays(merged, part) : part;
      }
      if (!merged) throw new Error("scenario has no traffic");
      return merged;
    };

    await step.do(STEP.replayRule, cpuHeavy, () =>
      tracked<ReplayResult>(STEP.replayRule, async () => agent.recordReplay(draftId, await replayAll(draftId, false)), describeReplay),
    );

    const baselineId = await step.do(STEP.baselineRule, cheap, () =>
      tracked<string | null>(STEP.baselineRule, () => agent.createBaselineVersion(p.incidentId)),
    );
    if (baselineId) {
      await step.do(STEP.replayBaseline, cpuHeavy, () =>
        tracked<ReplayResult>(STEP.replayBaseline, async () => agent.recordReplay(baselineId, await replayAll(baselineId, false)), describeReplay),
      );
    }

    // 9. Ask the human.
    await step.do(STEP.publishProposal, cheap, () =>
      tracked<string>(STEP.publishProposal, async () => {
        const status = await agent.publishProposal(p.incidentId, draftId, baselineId);
        await agent.recordStep(p.incidentId, STEP.waitForApproval, "waiting", "waiting for the operator");
        return status;
      }),
    );

    // 10. Durable gate. Nothing below runs without an approval event.
    try {
      await this.waitForApproval(step, { timeout: APPROVAL_TIMEOUT, stepName: STEP.waitForApproval });
    } catch (e) {
      if (e instanceof WorkflowRejectedError) {
        // The reject callable already recorded the decision and the audit row.
        await agent.recordStep(p.incidentId, STEP.waitForApproval, "complete", "rejected by operator");
        return { status: "rejected" as const };
      }
      // waitForEvent throws on timeout (Workflows docs, "Timeout behavior").
      await step.do(STEP.markTimedOut, cheap, () =>
        tracked<string>(STEP.markTimedOut, async () => {
          await agent.markIncident(p.incidentId, "timed-out", null);
          return "timed-out";
        }),
      );
      return { status: "timed-out" as const };
    }
    await agent.recordStep(p.incidentId, STEP.waitForApproval, "complete", "approved by operator");

    // 11. Apply exactly the stored version the operator was shown. The Agent re-reads it and
    //     checks the approval row itself; a refusal is final, not retried.
    const applied = await step.do(STEP.applyRule, cheap, () =>
      tracked<Applied>(STEP.applyRule, async () => {
        try {
          return await agent.applyApprovedRule(p.incidentId);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (message.includes("refusing to apply")) throw new NonRetryableError(message);
          throw e;
        }
      }),
    );

    // 12. Re-parse the applied rule from its stored text and replay it: what is measured is
    //     what is applied.
    const recovery = await step.do(STEP.verifyRecovery, cpuHeavy, () =>
      tracked<ReplayResult>(
        STEP.verifyRecovery,
        async () => toReplayResult((await replayAll(applied.ruleVersionId, true)).counts, def.scenario.thresholds, "ev_recovery"),
        describeReplay,
      ),
    );

    // 14. Final state.
    await step.do(STEP.persistIncident, cheap, () =>
      tracked<string>(STEP.persistIncident, async () => {
        await agent.finishIncident(p.incidentId, recovery);
        return traffic.digest;
      }),
    );
    return { status: "applied" as const, ruleVersionId: applied.ruleVersionId };
  }
}

function describeReplay(r: ReplayResult | null): string | null {
  if (!r) return null;
  return `attack blocked ${r.attackBlocked}/${r.attackTotal}, legitimate blocked ${r.legitimateBlocked}/${r.legitimateTotal}`;
}

