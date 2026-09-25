# Portcullis

An attack-response agent for web traffic. An LLM proposes a mitigation rule, deterministic code
verifies it, a human authorizes it.

Submission for Cloudflare's optional software engineering assignment. Built on the Cloudflare Agents
SDK, Workflows, Durable Objects and Workers AI.

**Status:** Phases 0 to 2 of [PLAN.md](PLAN.md) are built and tested locally. Nothing is deployed
yet, and three Phase 0 measurements need a Cloudflare account and have not been run. See
[Status](#status).

## What it does

A seeded simulator produces web traffic with a credential stuffing attack hidden in it. The attack
shares its network (ASN) with a mobile carrier that nearly half the real customers use. That is the
trap: the obvious rule, "block that network", blocks the customers too.

1. The operator types a symptom ("users are getting locked out").
2. A durable Workflow aggregates the traffic in code into label-blind summaries.
3. The model reads the summaries and proposes a rule, as a JSON syntax tree, never as text.
4. Our own printer turns the tree into Rules language text, our own parser reads it back, and the
   two trees must be identical. A type checker validates fields and literals.
5. Our evaluator replays every request through the rule and counts four numbers: attack total,
   attack blocked, legitimate total, legitimate blocked. A naive single attribute rule is replayed
   beside it for comparison.
6. The Workflow parks on a durable approval gate. The operator approves a specific stored rule
   version, by ID.
7. The rule is re-read from storage, applied, re-parsed from its stored text and replayed again to
   verify recovery.

Every number the operator sees comes from code. The model produces none of them.

## Measured so far

On the simulator, for the committed scenario and seed (exact, deterministic; see
[docs/spikes.md](docs/spikes.md)):

| Rule | Attack blocked | Legitimate blocked |
| --- | --- | --- |
| Naive baseline, `ip.src.asnum eq 64500` | 62.3% (1061 of 1704) | 46.3% (1987 of 4296) |
| A precise hand-written rule (the fake model's canned answer) | 100% (1704 of 1704) | 0% (0 of 4296) |

What the real model proposes is **not yet measured**. The harness for that exists and needs an
account (spike 0.4).

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
Object.

To use the real model instead, log in with `npx wrangler login` and run `npx wrangler dev` without
`--local` and without the `MODEL_MODE` override. The AI binding always runs remotely and spends
Workers AI neurons.

## Tests

```sh
npm run typecheck
npm run test:unit          # 159 tests, plain Vitest in Node: the whole deterministic core
npm run test:integration   # 14 tests in workerd via @cloudflare/vitest-plugin, fake model
npm run coverage           # Istanbul coverage for src/core
npm run bench              # CPU benchmarks (Phase 0.3)
```

Highlights:

- 1,000 generated rule trees round-trip through printer and parser.
- The columnar evaluator agrees request by request with an independent naive evaluator on
  generated rules and traffic.
- Every diagnostic code is produced by at least one test.
- Security tests: approving any rule version other than the one shown is refused; applying without
  an approval row is refused even when the approval gate is forced open.
- `DESIGN.md` section 6 must match `src/core/types.ts` byte for byte.

## Deploy

```sh
npx wrangler login
npm run deploy
```

Not done yet. Deploying targets the Workers Free plan.

## Layout

| Path | What it is |
| --- | --- |
| `src/core/` | The deterministic core. Pure TypeScript, no platform imports. Simulator, codec, aggregator, rules language (lexer, parser, printer, type checker, evaluator), replay math |
| `src/model/` | The one `ModelClient` interface, its Workers AI implementation and a fake |
| `src/server/` | The Cloudflare shell: Worker entry, `IncidentAgent` (Durable Object), `InvestigationWorkflow` |
| `ui/` | React UI, served as static assets |
| `prompts/` | Prompt templates, as files |
| `spikes/`, `scripts/` | Phase 0 spike Worker and drivers for the account measurements |
| `test/unit`, `test/integration`, `test/bench` | Tests, by kind |
| `DESIGN.md` | Architecture and the source of truth |
| `PLAN.md` | Build phases and their status |
| `EXPLAINER.md` | The whole project explained from zero background |
| `docs/spikes.md` | Every measurement, with date and conditions |

## Status

| Phase | State |
| --- | --- |
| 0. Spikes and measurements | CPU sizing measured locally. Model availability, CPU refresh over RPC, and structured output reliability need the account; tooling built |
| 1. Thin end-to-end slice | Built and tested locally with the fake model. Not deployed |
| 2. Real parser and evaluator | Built and tested |
| 3 to 7 | Not started |

Open items are listed at the end of [DESIGN.md](DESIGN.md#13-open-items).
