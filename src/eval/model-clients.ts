// Model clients for the eval harness (Phase 5): one that talks to the real model over HTTP (via
// the deployed spikes Worker's /model/run, the only way Node can reach the AI binding, see
// docs/spikes.md), and a caching wrapper around any ModelClient. Both implement the same
// ModelClient interface the product uses, so what the harness measures is exactly what a real
// investigation would send and receive (CLAUDE.md, "Model access").

import type { ModelClient, ModelRequest, ModelResponse } from "../model/client";
import type { ResponseCache } from "./cache";

/**
 * Talks to the deployed portcullis-spikes Worker's POST /model/run, the same endpoint the
 * Phase 0 structured-output spike uses (scripts/spikes-driver.ts). MODEL_ID is fixed by that
 * Worker's wrangler.jsonc; kept in sync here as a constant for cache keys and reporting.
 */
export class HttpModelClient implements ModelClient {
  readonly modelId = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  constructor(private readonly baseUrl: string) {}

  async generateJson(request: ModelRequest): Promise<ModelResponse> {
    const res = await fetch(new URL("/model/run", this.baseUrl), {
      method: "POST",
      body: JSON.stringify({ system: request.system, user: request.user, schema: request.jsonSchema }),
    });
    if (!res.ok) return { kind: "error", message: `spike worker returned HTTP ${res.status}` };
    const body = (await res.json()) as { response: ModelResponse; ms: number };
    return body.response;
  }
}

/** Wraps any ModelClient with the (scenario, prompt, model) response cache. */
export class CachingModelClient implements ModelClient {
  constructor(
    private readonly inner: ModelClient,
    private readonly cache: ResponseCache,
    private readonly scenarioId: string,
  ) {}

  get modelId(): string {
    return this.inner.modelId;
  }

  async generateJson(request: ModelRequest): Promise<ModelResponse> {
    const key = { scenarioId: this.scenarioId, system: request.system, user: request.user, modelId: this.inner.modelId };
    const cached = this.cache.get(key);
    if (cached) return cached;
    const response = await this.inner.generateJson(request);
    // Only cache a real generation. Caching a rate-limit or quota error would make it permanent
    // from the cache's point of view: a re-run after the quota resets would still see the old
    // failure and never find out it would now succeed.
    if (response.kind === "ok") this.cache.set(key, response);
    return response;
  }
}
