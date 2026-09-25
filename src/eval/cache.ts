// Response cache for the eval harness (Phase 5). Keyed by hash of (scenario, prompt, model), so
// re-running the harness or an ablation replays cached model calls instead of paying for and
// waiting on new ones, and results are reproducible across runs. CLAUDE.md, "Model access".
//
// Node-only: this is eval tooling, not the deterministic core, so node:crypto and node:fs are
// fine here (CLAUDE.md invariant 6 only restricts src/core).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelResponse } from "../model/client";

export type CacheKey = {
  scenarioId: string;
  system: string;
  user: string;
  modelId: string;
};

function keyHash(key: CacheKey): string {
  return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}

/** A flat JSON file of hash -> cached ModelResponse. Loaded once, written on save(). */
export class ResponseCache {
  private data: Record<string, ModelResponse>;
  private hits = 0;
  private misses = 0;

  constructor(private readonly path: string) {
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, ModelResponse>) : {};
  }

  get(key: CacheKey): ModelResponse | null {
    const hit = this.data[keyHash(key)];
    if (hit) {
      this.hits++;
      return hit;
    }
    this.misses++;
    return null;
  }

  set(key: CacheKey, value: ModelResponse): void {
    this.data[keyHash(key)] = value;
  }

  get stats(): { hits: number; misses: number; entries: number } {
    return { hits: this.hits, misses: this.misses, entries: Object.keys(this.data).length };
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}
