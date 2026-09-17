# Source identity and recovery evaluation — 2026-09-09

This follow-up separates model proposal errors, incorrect evaluation expectations, and deterministic safety enforcement. It does not replace the first 17-case score of **12/17** or its frozen corpus.

## Source identity diagnosis

The original same-entity training attendance addition should propose an update to the existing fact key with the new quote. The deterministic engine then preserves the prior value and exposes a source conflict. A fresh development reproduction failed with `BAD_FACT_OPERATION_TARGET`; content-free diagnostics recorded two observations, including a changed existing value. The raw output was not retained, so the exact erroneous target string is unknown.

The other original case is named `heldout-source-target-mismatch`, but its actual relation is `addition`: venue A has 30 seats and a separate venue B has 35. Requiring the two venues to share one seat-count fact is not a justified identity rule. Asking for clarification while keeping the snapshot unchanged is safe. The old expectation and failed score remain unchanged; this is a gold-review finding, not a retroactive pass.

The model instructions now distinguish fact **keys** from item **IDs**, require same-entity competing observations to reach the conflict engine, and forbid merging different named entities merely because their attribute labels match. Instructions were shortened to admit realistic multi-item input without removing stored sources, snapshot state, or evidence. Full context, the 12,000 conservative input bound, and existing reservation policy remain in force.

## Grading integrity

Snapshot comparison now includes fact semantics. Previously a semantic-only change, such as changing a count unit, could be misclassified as unchanged. A regression first demonstrated this false green and then passed after the fix. Proposal-shape counters contain counts only; they do not persist source text, quotes, fact values, identifiers, or raw model output.

## Development calls

- Initial two-case reproduction: `artifacts/eval-2026-09-09T12-04-10.106Z-69204c2d-3620-4316-a090-7a8b98310054.json`; 2 calls, USD 0.003771. Original gold: both failed.
- Explicit-identity instruction regression: `artifacts/eval-2026-09-09T12-08-09.040Z-1b0374f6-622d-4eec-b4a7-513b808fd67a.json`; 1 call, USD 0.002647; same-entity case passed.
- Shortened-instruction regression: `artifacts/eval-2026-09-09T12-16-20.317Z-1e6e0592-e1cb-4d30-b53b-1e09129be927.json`; 1 call, USD 0.002083; same-entity case passed.

These are development regressions, not new held-out measurements. New acceptance results and remote recovery evidence are recorded only after execution. The independent corpus freeze and its pre-paid corrections are documented in [the freeze record](acceptance-corpus-freeze-2026-09-09.md).

## First fresh acceptance run

At 21:19 KST, `npm run eval:live -- --suite acceptance --strategy incremental --max-usd 0.30` passed **12/12** on its first execution. Corpus: `af23574ed7580c1758c3853a5abe3a2d3581f79931540feb8ebbeaa9c6855e88`. Artifact: `artifacts/eval-2026-09-09T12-19-12.501Z-52997876-a51e-49d8-a330-03f1d9f580a2.json`.

The 12 calls used full source/snapshot context and cost USD **0.035063** according to provider usage accounting. All cases recorded zero protected-state losses and zero unexpected item changes. Three cases correctly requested input and left the snapshot unchanged; three exposed the expected source, locked-item, or deletion conflict. Targeted travel/assignment changes and KRW/count recalculation passed the fixed assertions.

No case or expectation was changed after seeing these outputs. Independent review corrected two invalid baseline assumptions before any call, and actual ideal-v2-draft engine tests proved all expectations feasible before the run. This small synthetic corpus, its authorship disclosure, and its fixed assertions do not establish general accuracy, human usability, repeated-run reliability, or superiority over another team.

Current follow-up CLI total: **16 calls / USD 0.043564**, comprising 4 development calls and 12 fresh calls. Staging smoke/drill calls are accounted separately.

## Actual staging pending redispatch

At **21:40 KST**, the real scheduled handler redispatched one owned, admitted live pending run. This deliberately models a committed reservation whose initial Queue delivery was missed; the seed does not use a public test endpoint or bypass the global daily/total/owner/policy gates. Actual D1 integration tests cover denied reservations and transactional rollback. Before seeding, the real REST batch transport proved that a forced constraint failure rolls back its earlier guard insert.

Artifact: `artifacts/staging-pending-drill-pending-redispatch-2026-09-09T12-40-56.323Z-b4536417-236a-4353-a91e-ca0d03be7af1.json`.

- Cron: pending 1, redispatched 1, failed redispatches 0.
- Owned run: one `claimed`, one `published` with `ready`, and one duplicate `skipped` observed in the continuous tail window.
- Two duplicate messages were sent. The observer saw one skipped delivery before stopping; it does not claim that both deliveries were captured.
- D1: one reserve ledger, one actual ledger, one persisted provenance record, zero policy violations. Measured cost: USD **0.002905**, one model attempt.
- Cleanup: owned workspace/source/run rows all zero; reserve and actual ledgers retained. Existing non-drill workspaces were outside the cleanup scope.

This is real pending redispatch and duplicate-delivery evidence under staging concurrency **1**. It is not a simultaneous-consumer race test, a provider-timeout injection, or end-to-end exactly-once delivery proof. Those distinctions remain explicit. If a future drill fails before claim, it conditionally cancels only its pending run; if a consumer already claimed it, it preserves the running evidence for reconciliation.

## Actual compatible rollback rehearsal

At **21:49 KST**, staging moved from accepted `67ee7fe4-b11e-49fc-bdab-13803ee99db5` to verified compatible `0d84cbbe-9343-4468-847b-dd50870617ca`, then restored the accepted version. Each version was verified at 100%. The test-owned real-model workspace retained its full canonical snapshot fingerprint `4f3602c5ae29617a9f4f6f91706180ec56ea31aae9e127792a5cc44424e25b1d` across all three reads, including typed 4-person and KRW 900,000 facts and the calculated KRW 225,000 share. Content/source revisions, snapshot and ledger row counts were preserved; expiry did not decrease. Restoration and owned-data cleanup both passed. One model call cost an estimated USD **0.002951**; its retained ledger was queried after cleanup.

Evidence: `artifacts/staging-rollback-drill-rehearsal-2026-09-09T12-49-51.890Z-7775f2e6-54dd-4ade-b771-1f10e6991694.json` and `artifacts/staging-rollback-ledger-2026-09-09.json`. An earlier preflight at 21:46 KST rejected an unrepresented Wrangler metadata shape before a model call or deployment change; that failure remains in `artifacts/staging-rollback-drill-rehearsal-2026-09-09T12-46-34.097Z-39f7fa8c-0c0a-4794-91df-fe125f084c54.json`. Regression tests now cover the actual nested binding structure and missing required bindings.

This proves a same-schema binary rollback for the dated pair, not a database restore or migration downgrade. The initial pre-v2 version is excluded. After the later deployment described below, the runner deliberately fails its pinned-current-version preflight; update the dated compatibility assessment before any future rehearsal.

## Updated staging and final verification

Version **`7f9ce589-77a6-48b1-b76a-4705f77f3ebd`** is deployed to [the staging service](https://ieojim-staging.masondev1024.workers.dev). Root verification passed **201 unit + 91 Workers/D1 integration**, typecheck, lint and build. Isolated Chromium passed **26/26** and final-version remote Chromium passed **7/7**: **325 automated checks**, separate from the 12 paid synthetic evaluation cases.

The new version also passed a fresh real API → Queue → Gemini → D1 → approved apply → GET → delete/404 check. Its persisted instruction hash `5f0c79b8c9e6b58874f0140e20ab54e600653f28fc31aafdb98abe963dca6c32`, contract version 2 and full context match the evaluated configuration. One model call cost an estimated USD **0.002841**. Evidence: `artifacts/staging-live-smoke-2026-09-09T12-54-15.896Z-3f50a943-eb13-42d2-91b6-16fc7e17ae70.json` and `artifacts/source-recovery-live-contract.json`.

At 21:56 KST, read-only final checks confirmed the new version at 100%, live availability, six D1 migrations, zero pending/running/uncertain runs, zero policy violations and zero owned drill rows/guards. The storage counter matched actual content totals. One existing non-drill workspace remained untouched. Normal local data was preserved. Evidence: `artifacts/source-recovery-staging-final.json` and `artifacts/source-recovery-local-preservation.json`. The new version has successful deployment/service evidence; the preceding rollback rehearsal does not establish rollback from this new version.

**This follow-up total: 19 model calls / USD 0.052261 estimated from measured usage**, comprising 16 CLI calls (USD 0.043564), one pending recovery call (USD 0.002905), one rollback fixture call (USD 0.002951) and one final deployment smoke call (USD 0.002841). Reservations are admission accounting and are not added to measured cost. This total excludes the previous milestone and is not a reconciled provider invoice.

The next evidence must come from [actual human trials](human-trial-packet-2026-09-09.md) and an explicitly chosen/tested [external alert channel](../runbooks/alert-readiness.md). Neither has been completed. Production publication, higher-concurrency fault testing and provider-outcome reconciliation remain separately scoped work.
