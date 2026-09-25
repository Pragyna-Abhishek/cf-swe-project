# Portcullis: standing instructions

Portcullis is an attack-response agent for web traffic. An LLM proposes a mitigation rule,
deterministic code verifies it, a human authorizes it.

## Start here, every session

1. Read `DESIGN.md`. It is the source of truth for architecture, data model, grammar and security.
2. Read `PLAN.md`. Find the current phase.
3. Work on **one phase at a time**. Do not start the next phase's work because it seems small.
4. Check `docs/spikes.md` before relying on any performance or platform number.

If a change would contradict DESIGN.md, update DESIGN.md in the same commit or do not make the
change. A design document that drifts from the code is worse than no design document.

## Architecture invariants

These are not preferences. Breaking one is a bug even if tests pass.

1. **The approve call carries a rule version ID, never a rule.** The apply step re-reads that row
   from SQLite and applies what is stored. If a client could submit the rule at approval time, it
   could show the reviewer a narrow rule and apply a broad one, which would make human authorization
   decorative. There are dedicated tests for this and they are never deleted or skipped.
2. **Applying a rule requires an approval row to exist.** The apply step verifies this itself. It
   does not trust that it was only reachable through the approval gate.
3. **Model output reaches only the JSON Schema validator, then the type checker, then the parser.**
   It never reaches SQL, `eval`, the filesystem, a fetch URL, or the UI as raw text. It is data under
   suspicion until validated.
4. **The model never sees raw requests and never sees ground truth labels.** It receives aggregated
   summaries computed without the attack or legitimate label. If a new prompt needs traffic detail,
   add a deterministic aggregation, do not widen what the model sees.
5. **The model never produces a number the operator sees.** No metrics, no confidence, no pass or
   fail. Every number is computed in code from the four replay counts.
6. **The deterministic core imports nothing platform specific.** No `agents`, no
   `cloudflare:workers`, no bindings in `src/core/`. It takes data and returns data. This is what
   makes it testable at speed and it is the most valuable part of the project.
7. **The 10 ms CPU budget.** This targets Workers Free, where CPU per request is 10 ms everywhere:
   Worker, Durable Object, and Workflow step. Any work that could exceed one slice goes through the
   chunk driver. Never write a loop over all requests outside it.
8. **Traffic is columnar and dictionary encoded.** Do not add a code path that materializes an array
   of `Request` objects for anything other than tests and the reference evaluator.
9. **Traffic never crosses a Workflow step boundary.** Steps pass identifiers, digests, aggregates and
   counts. Step returns and event payloads are capped at 1 MiB by the platform, and summaries are the
   whole point of the design.
10. **The Agent is name-addressed**, never addressed by raw Durable Object ID. Workflow callbacks
    re-resolve it with `getAgentByName`, so a raw ID sends callbacks to a different instance.
11. **The bundler preserves class names** (esbuild `keepNames: true`). The Workflow's originating path
    is keyed by `constructor.name`, so minification silently breaks callbacks in production but not in
    dev.
12. **Workflow steps are deterministic.** Step names are constants or derived from a fixed loop bound.
    No `Date.now()` or randomness in step names, outside steps, or in conditionals outside steps. The
    simulator seed comes from `event.payload` or a prior step's output, never from the clock.
13. **A printer and parser disagreement is a hard failure, never a retry.** It means our code is
    wrong. Fail loudly.

## Never rules

- **Never use a Cloudflare API without checking current docs.** The Agents SDK is pre-1.0 and moves
  fast. Training data is stale: as of this writing the docs live under `agents/runtime/...` not
  `agents/api-reference/...`, the server state hook is `onStateChanged` not `onStateUpdate`,
  `AIChatAgent` moved to `@cloudflare/ai-chat`, and `@cloudflare/vitest-pool-workers` was replaced by
  `@cloudflare/vitest-plugin`. Assume more has changed. Note that `developers.cloudflare.com` may be
  blocked by the network egress policy; the docs are also readable from the
  `cloudflare/cloudflare-docs` repository, which is the same Markdown.
- **Never let model output reach anything except the parser and schema validators.** See invariant 3.
- **Never bypass the approval step.** No auto-apply, no "safe enough to skip", no debug flag that
  applies without approval. If a test needs an applied rule, it goes through the approval path.
- **Never add a dependency without stating why** in the commit message. Pin exact versions, not
  carets. This project is judged partly on being explicable, and an unexplained dependency is a
  liability.
- **Never change the architecture without updating DESIGN.md** in the same commit.
- **Never skip, disable, or delete a security test** to get a suite green.
- **Never report an unmeasured number.** Mark it UNVERIFIED or leave it out. This applies to the
  README, to commit messages, and to anything shown in the UI.

## TypeScript conventions

- Strict mode on. No `any`. Use `unknown` and narrow.
- No non-null assertions (`!`). Handle the null case or make the type honest.
- Discriminated unions for anything with variants. `RuleAST` and `Diagnostic` are the pattern to
  follow.
- Types in `src/core/types.ts` are the shared vocabulary. Do not define a parallel shape elsewhere.
- Parse at the boundary. Validate external input once, at the edge, into a typed value; do not
  re-check the same thing in five places.
- Errors carry structure. Return `Diagnostic[]` or a discriminated result, not a thrown string.
- Name things after the domain: `legitimateBlockedRate`, not `fpRate`.
- No default exports.
- Comments explain why, not what. Match the surrounding density.

## Testing

**Every feature ships with tests, in the same commit.** Not a follow-up commit.

Two projects, for different reasons:

- `test/unit`, plain Vitest, no Workers runtime. Simulator, aggregator, printer, lexer, parser, type
  checker, evaluator. Pure functions over plain data. Most tests live here because they are fast.
- `test/integration`, `@cloudflare/vitest-plugin`, run with `--max-workers=1 --no-isolate`, because
  WebSockets with Durable Objects are unsupported under per-file storage isolation.

Rules:

- Coverage via Istanbul. V8 coverage is unsupported in the Workers pool.
- Always dispose Workflow introspectors with `await using`, or storage isolation leaks between tests.
- Always `await` storage operations and always consume response bodies in Workers tests.
- New grammar production means a positive and a negative test.
- New diagnostic code means a test that produces it.
- The columnar evaluator is validated against a naive reference evaluator over decoded `Request`
  objects. That property test is the correctness argument for the optimization; keep it passing.
- Re-measure CPU after any change to the evaluator or simulator. Do not assume the budget still fits.

## Model access

All model calls go through the single `ModelClient` interface. One production implementation (Workers
AI) and one fake.

- Unit tests and the eval harness run against the fake, with no Cloudflare credentials.
- The eval harness caches real responses by hash of `(scenario, prompt, model)` so re-runs and
  ablations are reproducible and cheap.
- JSON mode does not support streaming, and Workers AI can return `JSON Mode couldn't be met`. Handle
  it as a schema failure.
- Prompt templates live in `prompts/` as files, not inline string literals, so they are diffable.

## Repository conventions

- `prompts/` is committed. Every prompt template is version controlled, and `PROMPTS.md` records the
  prompt history. These are submission requirements, not optional extras.
- `docs/spikes.md` holds every measurement with its date and the account tier. Cite it rather than
  restating numbers from memory.
- Commit messages say what changed and why. If a dependency was added, say why there.

## Writing style for all documents in this repository

Plain and specific. No marketing tone. No em-dashes. No metrics that have not been measured. Anything
not confirmed against current docs or measured on the target account is marked UNVERIFIED.
