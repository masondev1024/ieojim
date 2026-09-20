# 이어짐 — project engineering guide

Build an editable, evidence-linked workspace that survives source changes while preserving the user's decisions. The approved scope and actual progress live in `PLANS.md`; setup belongs in `README.md`.

The dated winner evidence and adoption decisions live in `docs/research/ai-competition-winners-2026.md` and `docs/research/ieojim-engineering-upgrade-2026.md`. Treat them as decision context; use `PLANS.md` to distinguish implemented behavior from future work.

## Working approach

- Respect the current user-selected model and reasoning settings. Use engineering judgment; do not impose a fixed reasoning ritual, agent count, or repeated interview.
- Inspect relevant code and documentation before guessing. Continue reversible implementation choices within the approved scope. Ask only about unresolved choices that materially change product behavior, cost, authority, or public exposure.
- Prefer the smallest maintainable implementation that meets the requirements. Timeouts, duplicate delivery, stale proposals, invalid model output, and partial failures are expected operating conditions.
- Change what the task requires, including necessary dependencies. Avoid unrelated refactors and speculative features; clean up dead code introduced by your own changes.
- OMX owns this implementation. Delegate independent work with explicit file ownership; do not overwrite another worker's edits. Use installed role-specific agents when useful.
- Use Superpowers selectively for core-logic TDD, systematic debugging, and evidence-based completion. Small wording or styling changes need proportionate verification.
- Do not nest competing autonomous controllers. Ouroboros remains available for an explicitly chosen workflow transition.
- For an approved multi-step development/evaluation-failure loop, read `.codex/skills/ieojim-loop/SKILL.md`. Its repo-local CLI records checkpoints and verification; OMX remains the active executor. Ordinary localized edits do not need a loop. Saved checkpoints do not imply an installed off-app scheduler.
- When a failure repeats without new evidence, investigate its cause before trying another patch. Continue independent authorized work if one lane is blocked.

## Product invariants

- Application code is TypeScript. React/Vite handles the UI; Hono on Workers handles APIs; D1 and one Queue handle persistence and background runs.
- Source text is untrusted data. The model proposes structured facts and changes; deterministic code validates references, calculations, authority, revisions, and application.
- Sources are immutable. Source observations, applied values, user edits, and derived calculations remain distinguishable. Evidence must point to real stored source text.
- Preserve stable IDs, manual edits, completed checklist items, and locked decisions. Mark potentially stale manual content for review. Never silently unlock or overwrite it.
- Apply an approved, conflict-resolved bundle atomically against its exact base revisions. Duplicate requests must not apply twice.
- Restore content as a new revision. Never restore authentication, cost ledgers, source catalog state, or retention timestamps from a historical snapshot.
- Every private API enforces guest-owner or verified-account isolation at DB execution time. Claimed owner buckets retain stable identities and aggregate account usage; expired/revoked account cookies never silently authorize guest writes. Keep credentials and raw source text out of logs. Enforce input limits, usage budgets, deletion, and seven-day inactivity expiry.
- Model failures must preserve existing state. An uncertain external-call outcome must not trigger an automatic second paid call.
- Four block types only: schedule, cost, checklist, note. The September 14 submission direction is a cross-context workspace for people updating plans after changed notices. Corporate meeting preparation, academic assignments and travel/departure are use cases of the same engine; corporate assistants are an adoption hypothesis, not the entire product target. See `docs/design/submission-positioning-2026-09-14.md`. Checklist preparation settings are user-owned; models must not author or overwrite them. The approved September 15 local milestone adds separate Calendar OAuth and exact-approved outbox execution to an app-created secondary calendar, with provider readback and explicit optional email approval. Live provider verification and public deployment require their existing authorization boundaries; see the dated recovery runbook.

## Verification and continuity

- Define observable acceptance criteria before substantial implementation. Start state, persistence, authorization, and budget changes with meaningful regression tests.
- Read actual package scripts before running commands. Once scaffolded, `npm run verify` owns deterministic checks; browser checks use `npm run test:e2e`; paid evaluation uses `npm run eval:live` separately.
- Run focused checks during iteration and the required broader checks at milestone completion. Do not weaken assertions or substitute fixture results for live-model evidence.
- Assign one owner to browser test runners and their server lifecycle. Parallel agents must not start overlapping runs, erase shared reports, rebuild watched assets, or stop a server without confirming that they own that process.
- Seek independent review for major functionality and risky boundaries. Record blockers and resolve substantive findings before declaring those paths complete.
- Update `PLANS.md` with verified behavior, exact checks, material decisions, and remaining work. A later session must be able to resume without reconstructing the conversation.
- Report what changed, why, verification evidence, and material limitations. Keep routine narration brief and explain key trade-offs in Korean.

## Authority boundaries

- Develop on `dev` or a task branch. Update `main` only through an authorized PR; never bypass the local push guard. Check `docs/operations/branch-workflow.md` for the actual server-protection status and hook setup for a new clone.
- Work in this project; do not change global instructions, model settings, plugins, or MCP configuration for convenience.
- No commits, pushes, PRs, public deployment, account creation, or paid infrastructure changes without the applicable user approval. Prepare concrete reviewable artifacts before requesting an external action.
- Never send messages to others on the user's behalf without explicit authorization.

These project-specific principles adapt the ideas in [Karpathy-inspired guidelines](https://github.com/multica-ai/andrej-karpathy-skills/blob/2c606141936f1eeef17fa3043a72095b4765b9c2/CLAUDE.md); they are not a claim of model-specific optimization.
