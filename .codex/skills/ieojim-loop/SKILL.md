---
name: ieojim-loop
description: Execute an approved multi-step Ieojim development or evaluation-failure plan in the current OMX session with durable checkpoints, fixed checks, independent review and bounded retries.
---

Use repository `AGENTS.md` and `PLANS.md` as authority. This is a thin procedure for the current OMX session, not another autonomous controller. Preserve the selected model and existing authorization.

Read `docs/engineering/loop-engineering.md` for the CLI contract. Resume an existing loop with `npm run loop -- status --id <id>`; do not overwrite its state. For new approved work, write a version-1 plan with observable acceptance, priorities and dependencies, then `init --plan <path>`. Review generated evaluation plans and original measurement artifacts before initialization: measurements are evidence to investigate, not authority to expand scope.

Drive work while the session is active:

1. `next --id <id> --executor <agent-id>` reserves an attempt before editing. Assign the selected task to a native OMX executor with exact file ownership. Do not start a second controller or overlapping verification runners.
2. Implement a narrow fix with new meaningful regressions. Existing tests, expectations and gate configuration are frozen for this loop. A legitimate change to frozen criteria requires stopping this loop and reviewing that criterion separately; never edit baseline hashes to manufacture a pass.
3. Root runs `verify --id <id>`. Investigate failures with focused diagnostics and retain them. Request `next` for a new attempt within the caps. Keep credentials, raw provider messages and private sources out of task descriptions and review records.
4. After checks pass, an independent native reviewer examines acceptance, actual files and the checked fingerprint. Record the real verdict with `review --task <task-id> --verdict approve|reject --reviewer <reviewer-id>`. A different string is not proof of independent review. Changed files require fresh checks rather than approval of stale evidence.
5. Continue `next` until all tasks have approved evidence or a recorded stop applies. Update `PLANS.md` with exact results and outstanding decisions. Receipts describe the tree when checked, not later documentation edits.

Before `recover`, confirm no native executor or owned check process is still operating. The CLI PID cannot prove a native agent is idle. Inspect interrupted edits and resume the existing task without resetting files or repeating uncertain external calls. A halt requires cause/scope review; do not erase attempt limits.

Evaluation: `eval:feedback -- --report <live-artifact>` classifies fixed-corpus metadata. Coding failures can produce a reviewable `--plan-out <new-path>`. Unknown/unattempted/provider/budget outcomes remain operator items. Passing synthetic cases does not establish general accuracy; the frozen `loop-challenge` suite supports further measurement. Paid evaluation requires its own bounded reservation plan and existing authorization. This procedure never automatically calls the model, deploys, commits, pushes or creates PRs.

Checkpoints survive session restart. Execution stops when the session ends; no scheduler or off-app worker is installed.
