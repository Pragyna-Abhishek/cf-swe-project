// Worker entrypoint. Routes /agents/* to the IncidentAgent; everything else is the React UI,
// served from static assets in single-page-application mode (see wrangler.jsonc).

import { routeAgentRequest } from "agents";

export { IncidentAgent } from "./agent";
export { InvestigationWorkflow } from "./workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // routeAgentRequest addresses the Agent by the name in the URL: /agents/incident-agent/<name>.
    // Name addressing is required for Workflow callbacks to find the same instance.
    const routed = await routeAgentRequest(request, env);
    return routed ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
