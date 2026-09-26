# Portcullis

An attack-response agent for web traffic. An LLM proposes a mitigation rule, deterministic code
verifies it, a human authorizes it.

Submission for Cloudflare's optional software engineering assignment. Built on the Cloudflare Agents
SDK, Workflows, Durable Objects and Workers AI.

**Status:** all seven phases of [PLAN.md](PLAN.md) are built and tested. Deployed at
[`portcullis.pragyna-portcullis.workers.dev`](https://portcullis.pragyna-portcullis.workers.dev).
The one thing not measured is how well the **real** model drafts a rule: the account's Workers AI
free-tier neuron quota has been exhausted since Phase 0, so every rule-quality number below is
measured against the fake model, and is labeled as such. See [Status](#status) and
[docs/eval-results/README.md](docs/eval-results/README.md).

## What it does

A seeded simulator produces web traffic with a credential stuffing attack hidden in it. The attack
shares its network (ASN) with a mobile carrier that nearly half the real customers use. That is the
trap: the obvious rule, "block that network," blocks the customers too. Seven more scenarios across
two more attack families (scraping, L7 flood), three of them traps with different shared
attributes, exercise the same question from different angles.

1. The operator types a symptom ("users are getting locked out").
2. A durable Workflow aggregates the traffic in code into label-blind summaries, classifies the
   symptom, and loads any lesson learned from a past incident in the same scenario family.
3. The model forms a hypothesis citing evidence IDs from the aggregation, then proposes a rule, as
   a JSON syntax tree, never as text.
4. Our own printer turns the tree into Rules language text, our own parser reads it back, and the
   two trees must be identical. A type checker validates fields and literals. A schema or type
   failure feeds its diagnostics back into the next attempt, up to three attempts.
5. Our evaluator replays every request through the rule and counts four numbers: attack total,
   attack blocked, legitimate total, legitimate blocked. A naive single-attribute rule is replayed
   beside it for comparison.
6. The Workflow parks on a durable approval gate. The operator approves a specific stored rule
   version, by ID, never by resubmitting the rule text.
7. The rule is re-read from storage, applied, re-parsed from its stored text and replayed again to
   verify recovery. The model writes a closing report and a one-sentence lesson, retrievable by the
   next investigation in the same family.

Every number the operator sees comes from code. The model produces none of them (CLAUDE.md
invariant 5), never sees which requests are attacks (invariant 4), and its output never reaches
anything but the JSON Schema validator, the type checker and the parser (invariant 3).

## Measured so far

On the simulator's credential-stuffing trap scenario, seed fixed, deterministic (see
[docs/spikes.md](docs/spikes.md)):

| Rule | Attack blocked | Legitimate blocked |
| --- | --- | --- |
| Naive baseline, `ip.src.asnum eq 64500` | 62.3% (1061 of 1704) | 46.3% (1987 of 4296) |
| The fake model's canned rule | 100% (1704 of 1704) | 0% (0 of 4296) |

**What the real model proposes is still not measured.** `npm run eval -- --real` runs the same
comparison against Workers AI; it is implemented and smoke-tested end to end (it reaches the model
and correctly declines to cache a quota-error response), but the account's daily neuron allocation
has been exhausted since Phase 0's spike 0.4, so it has not produced a result. Every other number in
`docs/eval-results/fake.json` is a harness self-test against the fake model, not evidence about real
model quality; see [docs/eval-results/README.md](docs/eval-results/README.md) for exactly what that
file does and does not show.

CPU cost per 500-request chunk, measured in Node on the development machine, not on Cloudflare:
at most about 5.5 ms cold for generate, encode and aggregate together. That sets the chunk size under
the Workers Free 10 ms CPU limit. Full tables in [docs/spikes.md](docs/spikes.md).

## Run it locally

Needs Node 22. No Cloudflare account needed: local mode uses a fake model that returns a fixed rule,
and the UI labels it "fake".

```sh
npm install
npm run build                                          # builds the React UI into dist/client
npx wrangler dev --local --var MODEL_MODE:fake         # http://localhost:8787
```

Open the page, wait for the traffic panel to fill, press **Investigate**, then **Approve this
exact rule**. Reload the page: the incident is still there, because state lives in the Durable
Object. The step list on the right shows every step's status, how long it took, and what it found;
the naive baseline is shown beside the model's proposal for comparison.

To use the real model instead, log in with `npx wrangler login` and run `npx wrangler dev` without
`--local` and without the `MODEL_MODE` override. The AI binding always runs remotely and spends
Workers AI neurons.

## Live demo

[`https://portcullis.pragyna-portcullis.workers.dev`](https://portcullis.pragyna-portcullis.workers.dev)
is deployed with `MODEL_MODE=workers-ai` (`wrangler.jsonc`), calling the real model. For the same
reason the eval harness's `--real` run has no output, this account's Workers AI daily neuron quota
is currently exhausted, so **Investigate** on the deployed URL is expected to fail visibly at the
draft-rule step until the quota resets (PLAN.md's Phase 1 status notes this too). The 60 second
demo script in [DESIGN.md section 3](DESIGN.md#3-demo-script-60-seconds) has been driven end to end
against `wrangler dev --local --var MODEL_MODE:fake`, not yet against the deployed URL with a
working model call.

## Tests

```sh
npm run typecheck
npm run test:unit          # 204 tests, plain Vitest in Node: the whole deterministic core
npm run test:integration   # 40 tests in workerd via @cloudflare/vitest-plugin, fake model
npm run coverage           # Istanbul coverage for src/core
npm run bench              # CPU benchmarks (Phase 0.3)
npm run eval               # the eval harness: all 8 scenarios, all four ablations, fake model
```

Highlights:

- 1,000 generated rule trees round-trip through printer and parser.
- The columnar evaluator agrees request by request with an independent naive evaluator on
  generated rules and traffic.
- Every diagnostic code is produced by at least one test.
- Security tests: approving any rule version other than the one shown is refused; applying without
  an approval row is refused even when the approval gate is forced open. These never get deleted or
  skipped (CLAUDE.md).
- A hypothesis citing a fabricated evidence ID is caught and never rendered.
- `test/integration/failure-injection.test.ts`: every step in DESIGN.md section 8 forced to error
  (one also forced to time out) ends the incident in a defined `failed` state, never a silent hang.
- `DESIGN.md` section 6 must match `src/core/types.ts` byte for byte.
- `test/unit/boundaries.test.ts` enforces CLAUDE.md invariant 6: nothing under `src/core/` imports
  anything platform specific.

## Deploy

```sh
npx wrangler login
npm run deploy
```

Deployed to `https://portcullis.pragyna-portcullis.workers.dev` on the Workers Free plan.

## Layout

| Path | What it is |
| --- | --- |
| `src/core/` | The deterministic core. Pure TypeScript, no platform imports. Simulator, codec, aggregator, rules language (lexer, parser, printer, type checker, evaluator), replay math, citations, scenario registry |
| `src/model/` | The one `ModelClient` interface, its Workers AI implementation and a fake |
| `src/server/` | The Cloudflare shell: Worker entry, `IncidentAgent` (Durable Object), `InvestigationWorkflow`, structured logging |
| `src/eval/` | The Phase 5 eval harness and its response cache, reused directly from production code, not a reimplementation |
| `ui/` | React UI, served as static assets |
| `prompts/` | Prompt templates, as files |
| `spikes/`, `scripts/` | Phase 0 spike Worker, the eval harness's CLI driver, and the account measurements |
| `test/unit`, `test/integration`, `test/bench` | Tests, by kind |
| `DESIGN.md` | Architecture and the source of truth |
| `PLAN.md` | Build phases and their status |
| `EXPLAINER.md` | The whole project explained from zero background |
| `PROMPTS.md` | The AI prompt history: how the coding assistant was directed, and how the runtime prompts in `prompts/` reached their current shape |
| `docs/spikes.md` | Every Phase 0 measurement, with date and conditions |
| `docs/eval-results/` | Phase 5's committed eval report and what it does and does not show |

## Status

| Phase | State |
| --- | --- |
| 0. Spikes and measurements | 0.1 to 0.3 measured on the account or locally. 0.4 (structured output) measured negative on the original schema; the flat, type-split fallback schema ships and is what every later phase uses |
| 1. Thin end-to-end slice | Built, tested, deployed |
| 2. Real parser and evaluator | Built and tested |
| 3. Retry loop and diagnostics feedback | Built and tested |
| 4. Scenarios, evidence ledger, memory | Built and tested: 8 scenarios across 3 families, 3 traps |
| 5. Eval harness and ablations | Built and tested against the fake model; `--real` implemented and smoke-tested, not measured (quota) |
| 6. Failure injection and tracing | Built and tested: every step forced to fail, step timings, structured logging |
| 7. UI polish, README, PROMPTS | This document, `PROMPTS.md`, and the UI's step timings, attempt history, evidence drill-down and naive-vs-proposed comparison |

Open items are listed at the end of [DESIGN.md](DESIGN.md#13-open-items).
