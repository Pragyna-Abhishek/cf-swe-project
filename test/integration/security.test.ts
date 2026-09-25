// CLAUDE.md invariants 1 and 2. These tests exist from Phase 1 onward and are never deleted,
// skipped or weakened to get a suite green.

import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import type { Connection } from "agents";
import type { IncidentAgent } from "../../src/server/agent";
import { describe, expect, it } from "vitest";
import { agentNamed, errorOf, waitForIncident } from "./helpers";

const SYMPTOM = "login latency spiked and users are getting locked out";

describe("approval boundary", () => {
  it("approving a rule version that is not the proposed one is rejected", async () => {
    const agent = await agentNamed("sec-wrong-version");
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    const waiting = await waitForIncident(agent, incidentId, ["awaiting-approval"]);

    // The naive baseline is a real, stored, valid rule version of this incident. It is still
    // not what the operator was asked to approve.
    const baselineId = waiting.baselineRuleVersionId;
    if (!baselineId) throw new Error("no baseline");
    expect(await errorOf(() => agent.approve(incidentId, baselineId))).toMatch(/does not match/);
    expect(await errorOf(() => agent.approve(incidentId, "rv_forged"))).toMatch(/does not match/);

    // A rule smuggled in place of an ID never gets as far as a lookup.
    const smuggled = JSON.stringify({ kind: "compare", field: "ip.src.asnum", op: "ne", value: 0 });
    expect(await errorOf(() => agent.approve(incidentId, smuggled))).toMatch(/rule version ID/);

    const after = await agent.getIncidentForTest(incidentId);
    expect(after?.status).toBe("awaiting-approval");
    expect(after?.approval).toBeNull();
    expect(after?.appliedRuleVersionId).toBeNull();
    void instance;
  });

  it("applying without an approval row is rejected, even when the gate is opened", async () => {
    const agent = await agentNamed("sec-no-approval-row");
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval"]);

    // Open the gate directly with an approval event, bypassing approve() and its audit row.
    // The apply step must check for the row itself and refuse.
    await instance.modify(async (m) => {
      await m.mockEvent({ type: "approval", payload: { approved: true } });
    });
    await instance.waitForStatus("errored");
    const done = await waitForIncident(agent, incidentId, ["failed"]);
    expect(done.appliedRuleVersionId).toBeNull();
    expect(done.failureReason).toMatch(/no approval row/);
    expect(await agent.unsafeActionCount()).toBe(0);
  });

  it("applyApprovedRule refuses directly when no approval exists", async () => {
    const agent = await agentNamed("sec-direct-apply");
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval"]);
    expect(await errorOf(() => agent.applyApprovedRule(incidentId))).toMatch(/refusing to apply/);
    void instance;
  });

  it("approve and reject refuse incidents that are not awaiting approval", async () => {
    const agent = await agentNamed("sec-state");
    expect(await errorOf(() => agent.approve("inc_missing", "rv_missing"))).toMatch(/unknown incident/);
    expect(await errorOf(() => agent.reject("inc_missing", "x"))).toMatch(/unknown incident/);
  });

  it("clients cannot push state", async () => {
    const agent = await agentNamed("sec-push");
    await agent.generateTrafficChunk();
    // validateStateChange runs for every setState; a non-server source must throw. Exercised
    // here through the same check the WebSocket path uses.
    const stub = env.IncidentAgent.get(env.IncidentAgent.idFromName("sec-push"));
    await runInDurableObject(stub, async (instance: IncidentAgent) => {
      const state = instance.state;
      const fakeClient = { id: "client" } as unknown as Connection;
      expect(() => instance.validateStateChange(state, fakeClient)).toThrow(/server-owned/);
      expect(() => instance.validateStateChange(state, "server")).not.toThrow();
    });
  });
});
