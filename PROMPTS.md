# PROMPTS.md: the AI prompt history

Two different things use the word "prompt" in this project, and this file is about the first one:

1. **Prompts to the coding assistant** (Claude Code) that built Portcullis. This file.
2. **Prompts Portcullis itself sends to the model at runtime** to draft a rule, classify a
   symptom, form a hypothesis, and write a report. Those live in `prompts/` as committed text
   files, one system/user pair per call site, so they are diffable and reviewable like code. This
   file does not repeat their contents; read them directly, or read `src/core/prompt.ts` for how
   they are assembled and escaped.

## How the assistant was directed

Every session worked under `CLAUDE.md`, committed at the repository root, which is the standing
instruction set: read `DESIGN.md` and `PLAN.md` first, work one phase at a time, never skip a
security test, never report an unmeasured number, keep `DESIGN.md` in sync with
`src/core/types.ts`, commit incrementally with a stated reason for any new dependency. That file
governed every phase below; it is not repeated here, only cited.

On top of that standing instruction, each work session was driven by a short human instruction
naming the next goal, of the general shape "continue building Portcullis, phase N" or "finish the
project through Phase M." The exact wording of the instructions for Phases 0 through 4 was not
preserved verbatim outside the commit history itself; the commit messages on
`claude/phase-0-account-spikes-x01vwv` (`git log`) are the accurate record of what was built and
why, phase by phase, since `CLAUDE.md` requires every commit message to say why. What follows is
what is actually known, not a reconstruction of every turn of every conversation.

Recorded verbatim, later in the project, because they were the operative instruction for the work
done immediately after them:

- *"once you are done with compacting, please continue towards your goal of finishing this
  project till the end of phase 5"* — drove finishing Phase 5 (the eval harness, its four
  ablations, and the response cache) in one session, ending with a commit, a push, and a
  deployment.
- *"A pull request was just created for this branch from the Claude Code UI ... Reference this PR
  going forward"* — established `PR #2` as the tracking artifact for the branch instead of the
  assistant opening a duplicate one. That PR was later merged into `main`.
- *"go all the way and finish the project please. commit at every major step in the process like a
  proper SWE and compact your context"* — the instruction that drove Phase 6 (failure injection,
  step timings, structured logging) and this Phase 7 work (this file, the README rewrite, the UI
  and `EXPLAINER.md` status updates), each committed as its own step rather than as one combined
  commit.

## Model choice for the coding assistant

Built with Claude Code. The exact model varied by session as Anthropic's available models changed
over the project's timeline; the session that wrote this file ran on the model identified to it as
`claude-sonnet-5`. This is a statement about which model wrote the code, not about
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, the one model Portcullis itself calls at runtime
(`docs/spikes.md`, spike 0.1).

## The runtime prompts, and how they got to their current shape

`prompts/` holds five system/user pairs, one per model call site in `src/server/workflow.ts`:
`draft-rule` (plus `draft-rule-text`, the Phase 5 text-output ablation's variant), `classify-symptom`,
`hypothesize`, `write-report`. Each is built up by `src/core/prompt.ts`'s template functions, which
insert only aggregated, label-blind data (CLAUDE.md invariant 4) and escape every inserted value
through `jsonForPrompt` so the traffic summary or a prior attempt's raw output can never break out
of its delimiters (`test/unit/model.test.ts`'s prompt-injection tests exercise this directly).

`draft-rule` is the one with real history: Phase 0's spike 0.4 measured the original nested,
recursive `RuleAST` JSON Schema failing structured-output validation on this account, tried a flat
node-list encoding (still failing), and shipped fallback 2 from `PLAN.md`'s 0.4 list — a flat,
type-split schema with no `$ref` recursion and no union-typed leaf fields
(`src/core/rules/schema.ts`, commit "Flatten and type-split the model output schema (0.4
fallback)"). The prompt template itself did not need to change for this; only the JSON Schema
handed to `response_format` did. `draft-rule-text` (Phase 5) is a separate template, not a
modification of `draft-rule`, so the AST-producing path this project actually uses in production
is never touched by the ablation.

No prompt template was hand-tuned against real model output beyond that one schema change,
because the account's Workers AI free-tier neuron quota was exhausted during Phase 0 (spike 0.4)
and has not reset since (`docs/eval-results/README.md`). Every template has been exercised against
the fake model (`src/model/fake.ts`), which validates that the harness, the retry loop, and the
ablations all execute correctly end to end, but says nothing about how well a real model follows
these instructions. That is the honest limitation of this project's prompt engineering: the
prompts are designed from the schema and the threat model, not iterated against measured model
behavior, and `DESIGN.md` section 9 and `docs/eval-results/README.md` say so explicitly rather
than implying otherwise.
