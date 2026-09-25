import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { IncidentAgent } from "../../src/server/agent";
import type { Incident, IncidentStatus } from "../../src/core/types";

export async function agentNamed(name: string) {
  return getAgentByName<Env, IncidentAgent>(env.IncidentAgent as unknown as DurableObjectNamespace<IncidentAgent>, name);
}

export async function waitForIncident(
  agent: Awaited<ReturnType<typeof agentNamed>>,
  incidentId: string,
  statuses: readonly IncidentStatus[],
  timeoutMs = 30_000,
): Promise<Incident> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const incident = (await agent.getIncidentForTest(incidentId)) as Incident | null;
    if (incident && statuses.includes(incident.status)) return incident;
    if (Date.now() > deadline) throw new Error(`incident ${incidentId} stuck at ${incident?.status ?? "missing"}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The message of the error a call throws. Durable Object RPC promises are not plain promises,
 * and `expect(rpc).rejects` leaves a stray unhandled rejection behind; awaiting inside
 * try/catch does not.
 */
export async function errorOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the call to throw");
}
