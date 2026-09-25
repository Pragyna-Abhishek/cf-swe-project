import { env } from "cloudflare:workers";
import { evictDurableObject, introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agentNamed, errorOf, waitForIncident } from "./helpers";

const SYMPTOM = "login latency spiked and users are getting locked out";

async function startInvestigation(agentName: string) {
  const agent = await agentNamed(agentName);
  const { incidentId } = await agent.startInvestigation(SYMPTOM);
  return { agent, incidentId };
}

describe("investigation workflow, end to end with the fake model", () => {
  it("reaches awaiting-approval with a verified proposal and a naive baseline beside it", async () => {
    const agent = await agentNamed("wf-await");
    // The incident ID is the workflow instance ID, so the introspector can be attached first.
    const pending = agent.startInvestigation(SYMPTOM);
    const { incidentId } = await pending;
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    const incident = await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);
    expect(incident.status).toBe("awaiting-approval");
    expect(incident.proposedRuleVersionId).toBe(`rv_${incidentId}_1`);
    expect(incident.baselineRuleVersionId).toBe(`rv_${incidentId}_baseline`);

    const state = await agent.state;
    const view = state.incidents.find((i) => i.id === incidentId);
    expect(view?.proposed?.status).toBe("valid");
    expect(view?.proposed?.text).toContain('http.request.uri.path eq "/login"');
    const replay = view?.proposed?.replay;
    const baseline = view?.baseline?.replay;
    if (!replay || !baseline) throw new Error("replays missing");
    // Blocked never exceeds total, and the counts cover the whole scenario.
    expect(replay.attackBlocked).toBeLessThanOrEqual(replay.attackTotal);
    expect(replay.legitimateBlocked).toBeLessThanOrEqual(replay.legitimateTotal);
    expect(replay.attackTotal + replay.legitimateTotal).toBe(6000);
    // The experiment: the naive rule blocks more legitimate traffic than the proposal.
    expect(baseline.legitimateBlocked).toBeGreaterThan(replay.legitimateBlocked);
    expect(view?.steps.map((s) => s.name)).toContain("wait-for-approval");
    expect(view?.modelId).toBe("fake");
    void instance;
  });

  it("approve applies exactly the proposed version and verifies recovery from its stored text", async () => {
    const { agent, incidentId } = await startInvestigation("wf-approve");
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    const waiting = await waitForIncident(agent, incidentId, ["awaiting-approval"]);
    const proposedId = waiting.proposedRuleVersionId;
    if (!proposedId) throw new Error("no proposal");

    await agent.approve(incidentId, proposedId);
    await instance.waitForStatus("complete");
    const done = await waitForIncident(agent, incidentId, ["applied"]);
    expect(done.appliedRuleVersionId).toBe(proposedId);
    expect(done.approval?.decision).toBe("approved");
    expect(done.recovery?.legitimateBlocked).toBe(0);
    expect(done.recovery?.attackBlocked).toBe(done.recovery?.attackTotal);
    expect(await agent.unsafeActionCount()).toBe(0);
  });

  it("reject leaves nothing applied", async () => {
    const { agent, incidentId } = await startInvestigation("wf-reject");
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval"]);
    await agent.reject(incidentId, "too broad");
    await instance.waitForStatus("complete");
    const done = await waitForIncident(agent, incidentId, ["rejected"]);
    expect(done.appliedRuleVersionId).toBeNull();
    expect(done.approval).toMatchObject({ decision: "rejected", reason: "too broad" });
    const state = await agent.state;
    expect(state.incidents.find((i) => i.id === incidentId)?.proposed?.status).toBe("rejected");
  });

  it("an approval timeout moves the incident to timed-out with nothing applied", async () => {
    const agent = await agentNamed("wf-timeout");
    // Modifiers registered before the instance exists, so there is no race with the gate.
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "wait-for-approval" });
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["timed-out", "failed"]);
    expect(done.status).toBe("timed-out");
    expect(done.appliedRuleVersionId).toBeNull();
  });

  it("incident history survives Durable Object eviction", async () => {
    const { agent, incidentId } = await startInvestigation("wf-evict");
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval"]);
    const stub = env.IncidentAgent.get(env.IncidentAgent.idFromName("wf-evict"));
    await evictDurableObject(stub);
    const again = await agentNamed("wf-evict");
    const state = await again.state;
    expect(state.incidents.some((i) => i.id === incidentId && i.status === "awaiting-approval")).toBe(true);
    // The parked workflow is unaffected by the eviction and still accepts the decision.
    const incident = await again.getIncidentForTest(incidentId);
    if (!incident?.proposedRuleVersionId) throw new Error("no proposal");
    await again.approve(incidentId, incident.proposedRuleVersionId);
    await instance.waitForStatus("complete");
    await waitForIncident(again, incidentId, ["applied"]);
  });

  it("a model step that keeps failing fails the incident visibly", async () => {
    const agent = await agentNamed("wf-model-fail");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "draft-rule-attempt-1" }, new Error("model unavailable"));
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["failed", "awaiting-approval"]);
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(/model unavailable/);
    expect(done.proposedRuleVersionId).toBeNull();
  });
});

describe("input validation at the edge", () => {
  it("rejects an oversized or empty symptom", async () => {
    const agent = await agentNamed("edge");
    expect(await errorOf(() => agent.startInvestigation("x".repeat(501)))).toMatch(/longer than/);
    expect(await errorOf(() => agent.startInvestigation("  "))).toMatch(/empty/);
    expect(await errorOf(() => agent.startInvestigation(42 as unknown as string))).toMatch(/string/);
  });

  it("caps concurrent investigations", async () => {
    const agent = await agentNamed("edge-cap");
    await agent.startInvestigation(SYMPTOM);
    await agent.startInvestigation(SYMPTOM);
    expect(await errorOf(() => agent.startInvestigation(SYMPTOM))).toMatch(/at most/);
  });
});
