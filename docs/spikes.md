# Phase 0 spikes and measurements

Every number the design relies on lives here, with its date, where it was measured, and on what.
Cite this file rather than restating a number from memory.

**Target account tier:** Workers Free.

**Where these were measured:** a development container with no Cloudflare credentials. Anything that
needs the real account (0.1, 0.2, 0.4) is **not yet measured**. The tooling to measure it is built
and smoke-tested; section "How to run the account spikes" below says how. Until someone runs it,
those items stay UNVERIFIED in DESIGN.md.

| Spike | Status | Decision taken meanwhile |
| --- | --- | --- |
| 0.1 Model usable on the account, and its rate limit | NOT MEASURED (needs the account) | Keep `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Fallback changed, see below |
| 0.2 Does a Durable Object RPC call refresh the CPU budget | NOT MEASURED (needs the account) | Provisional: RPC. One interface to change if wrong |
| 0.3 How many requests fit in 10 ms | MEASURED locally, 2026-09-25 | `CHUNK_SIZE = 500`, `requestCount = 6000` |
| 0.4 Structured output reliability | NOT MEASURED (needs the account) | AST JSON with a nested JSON Schema, as designed |

## 0.3 CPU per chunk

Measured 2026-09-25 in Node 22.22.2 on an Intel Xeon at 2.10 GHz (4 vCPU) in the development
container. Not on Cloudflare hardware.

Why Node and not workerd: inside a Worker, timers do not advance during synchronous CPU work (a
Spectre mitigation), so CPU time cannot be measured from inside a Worker. Node runs the same V8
engine. The numbers are an estimate of the production figure, which is why the chunk size keeps a
wide margin.

### Warm (median of 41 runs after 20 warm-up runs)

Command: `npm run bench`. Source: `test/bench/cpu.test.ts`.

| chunk | generate | encode | decode | aggregate | eval trivial | eval ~10 nodes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 0.128 ms | 0.002 ms | 0.004 ms | 0.098 ms | 0.044 ms | 0.103 ms |
| 500 | 0.055 ms | 0.006 ms | 0.007 ms | 0.122 ms | 0.018 ms | 0.027 ms |
| 1000 | 0.128 ms | 0.012 ms | 0.013 ms | 0.153 ms | 0.021 ms | 0.031 ms |
| 2000 | 0.209 ms | 0.019 ms | 0.019 ms | 0.329 ms | 0.044 ms | 0.067 ms |
| 4000 | 0.527 ms | 0.034 ms | 0.035 ms | 0.996 ms | 0.152 ms | 0.217 ms |

### Cold (first call in a fresh process, p50 and max of 15 processes)

Command: `node scripts/bench-cold.mjs 15`. Source: `test/bench/cold.ts`. This is the honest bound:
the first request into a new isolate gets no warm JIT.

| chunk | generate | encode | decode | aggregate | verify (pipeline) | compile | evaluate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 2.42 / 3.60 ms | 0.15 / 0.25 ms | 0.14 / 0.24 ms | 0.68 / 1.61 ms | 2.04 / 3.54 ms | 0.29 / 0.42 ms | 1.06 / 1.76 ms |
| 1000 | 4.25 / 5.58 ms | 0.18 / 0.24 ms | 0.15 / 0.35 ms | 1.01 / 1.59 ms | 1.98 / 2.58 ms | 0.32 / 1.39 ms | 0.47 / 0.70 ms |
| 2000 | 6.00 / 6.89 ms | 0.18 / 0.55 ms | 0.16 / 0.32 ms | 1.69 / 2.94 ms | 2.05 / 4.01 ms | 0.29 / 0.53 ms | 0.69 / 1.12 ms |
| 6000 | 9.21 / 11.26 ms | 0.25 / 0.36 ms | 0.26 / 0.33 ms | 3.47 / 5.27 ms | 2.43 / 4.43 ms | 0.35 / 0.50 ms | 1.64 / 2.19 ms |

### What this decides

- **Generating a whole scenario in one call does not fit.** 6,000 requests cold is 9.2 ms at the
  median and 11.3 ms at worst, before any SQLite write. Chunking is required, as DESIGN.md section 5
  predicted.
- **`CHUNK_SIZE = 500`.** The heaviest single call is `ensureTrafficChunk`: generate, encode and
  aggregate one chunk. At 500 that is 3.3 ms at the median and at most 5.5 ms cold (summing the
  per-operation maxima, which is pessimistic), leaving room for the SQLite write and RPC overhead.
  At 1,000 the same sum is 7.4 ms, too close to 10 ms. Warm, every operation on a 500 chunk is well
  under 1 ms.
- **`Scenario.requestCount = 6000`**, which is 12 chunks. Each heavy workflow step makes 12 Agent
  calls, inside the Workers Free limit of 50 subrequests per request.
- **Evaluation is cheap.** Even cold, replaying 6,000 requests through a real rule is 1.6 ms median.
  Replay is still chunked, because it shares the chunk loop with generation and because the budget
  is per call.
- **Re-measure on the account.** Look for `exceededCpu` in Workers logs during the first cold
  generation. If it appears, halve `CHUNK_SIZE` in `src/core/chunks.ts`; nothing else changes.

Phase 2 re-measurement at the full grammar: the "eval ~10 nodes" column uses a rule touching every
column kind (`and`, `or`, `not`, `contains` with `lower()`, string `in`, number `in`), and the
"verify" column runs the whole pipeline (decode, limits, type check, print, parse, round trip) on a
realistic rule. Both are inside budget.

## 0.1 Model availability and rate limit (NOT MEASURED)

What the docs say, read 2026-09-25 from the `cloudflare/cloudflare-docs` repository:

- Text generation models get 300 requests per minute by default. Models that require Workers Paid
  get 20 per minute (`workers-ai/platform/limits.mdx`).
- On 2026-07-28, Kimi K2.6, Kimi K2.7 Code and GLM-5.2 moved to Workers Paid only
  (`changelog/workers-ai/2026-07-28-models-require-workers-paid.mdx`). Llama 3.3 70B is not on that
  list, and the pricing page lists it with no paid-only note. So it is probably callable on Free at
  300 per minute. UNVERIFIED until measured.
- Free accounts get 10,000 neurons per day. Llama 3.3 70B fp8-fast costs 26,668 neurons per million
  input tokens and 204,805 per million output tokens (`workers-ai/platform/pricing.mdx`).
- The current draft prompt is 5,795 characters for the trap scenario at seed 1 (measured
  2026-09-25 by assembling it with `buildDraftRulePrompt`; `test/unit/model.test.ts` keeps it
  under 12,000). At a rough 4 characters per token (UNVERIFIED) that is
  about 1,450 input tokens, so a draft with 150 output tokens would cost about 70 neurons, or roughly
  140 drafts per day on the free allocation. This is an estimate, not a measurement, and it is the
  reason the Phase 5 eval harness caches responses.

**The planned fallback model no longer exists.** PLAN.md named `@cf/meta/llama-3.1-8b-instruct` as
the fallback. It was deprecated on 2026-05-30
(`changelog/workers-ai/2026-05-08-planned-model-deprecations.mdx`). Llama 3.3 70B fp8-fast is
explicitly listed there as remaining active. Replacement fallback candidates from the same
changelog, all UNVERIFIED for JSON mode support: `@cf/meta/llama-3.1-8b-instruct-fast`,
`@cf/google/gemma-4-26b-a4b-it`, `@cf/zai-org/glm-4.7-flash`. The model ID is one variable
(`MODEL_ID` in `wrangler.jsonc`).

Also from the docs: error `3036` means the daily neuron allocation is used up and `3040` means out
of capacity. `src/model/workers-ai.ts` treats both like a 429, so the step retries with backoff.

## 0.2 CPU budget refresh per transport (NOT MEASURED)

The docs say the budget is refreshed by "each incoming HTTP request or WebSocket message" and do not
mention RPC. The code currently uses:

- **WebSocket messages** for the browser-driven traffic generation on page load (documented to
  refresh the budget).
- **Durable Object RPC** from Workflow steps to the Agent for the chunk loops (the unmeasured case).

If the measurement shows RPC does not refresh the budget, the Workflow's chunk calls move to
`fetch()` on the Agent stub. That is a change to the chunk loops in `src/server/workflow.ts` only;
the core does not change.

The spike Worker (`spikes/`) was run locally with `wrangler dev --local` on 2026-09-25 to check the
plumbing only: RPC, fetch and WebSocket burn calls all complete. Local runs do not enforce the CPU
limit, so this proves nothing about the budget.

## 0.4 Structured output reliability (NOT MEASURED)

The driver sends the real production prompt and schema for three scenario shapes, 10 seeds each (30
attempts), and verifies every output locally with the real pipeline. It records the fractions the
plan asks for: valid JSON, schema-valid, type-valid, `JSON Mode couldn't be met`, and which
diagnostics occur. As a bonus it replays each valid rule and the naive baseline.

The three shapes: the committed trap (`cs-trap-carrier`), the same trap with a single attack user
agent and different wording, and a non-trap where the attack comes only from hosting ASNs.

Temperature is 0, as in production, so the 30 attempts differ by traffic seed and wording rather
than by sampling.

## Measured on the simulator: the trap works

This is deterministic, so it is exact for the committed scenario and seed. Pinned by
`test/unit/scenario.test.ts`.

| Rule | Attack blocked | Legitimate blocked | Passes thresholds |
| --- | --- | --- | --- |
| Naive baseline, `ip.src.asnum eq 64500` | 1061 of 1704 (62.3%) | 1987 of 4296 (46.3%) | No |
| The fake model's canned rule | 1704 of 1704 (100%) | 0 of 4296 (0%) | Yes |

The canned rule is written by hand in `src/model/fake.ts`. It shows the scenario can be separated
precisely; it says nothing about whether the real model will find such a rule. That is what 0.4
measures.

## How to run the account spikes

Needs a Cloudflare account on the target tier and `wrangler login` (or `CLOUDFLARE_API_TOKEN`).

```sh
npx wrangler deploy -c spikes/wrangler.jsonc
# prints https://portcullis-spikes.<your-subdomain>.workers.dev

node scripts/run-spikes.mjs https://portcullis-spikes.<sub>.workers.dev cpu
node scripts/run-spikes.mjs https://portcullis-spikes.<sub>.workers.dev structured 10
node scripts/run-spikes.mjs https://portcullis-spikes.<sub>.workers.dev model-rate 400
```

Each writes `docs/spike-results/<spike>.json`. Run `model-rate` last: it deliberately drives the
account into rate limiting, and it spends neurons (tiny prompts, `max_tokens` 16).

Then fill in the three NOT MEASURED sections here and remove the matching UNVERIFIED marks in
DESIGN.md sections 5 and 13.
