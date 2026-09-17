# Notice Date Contract — 2026-09-16

## Decision

Keep scalar date/time validation strict. A model fact may use `semantic: { kind: "date_time" }` only when the quoted source text and displayed value both support one clear scalar date and/or one clear scalar time.

Do not loosen `SEMANTIC_EVIDENCE_MISMATCH` for Korean relative-date ranges. The guard protects users from invented dates and from choosing one time out of a range without evidence.

## Historical Failure Boundary

The failed natural-language live call under `artifacts/notice-recovery-release-2026-09-15/` is known to have failed with `SEMANTIC_EVIDENCE_MISMATCH`, measured model usage, and no state mutation. The exact offending fact remains unknown because raw model output was not retained.

The archived notice shape contains multiple instants in one sentence:

`2026년 9월 23일 16:00~17:00에서 같은 날 11:00~12:00`

This is not a safe scalar fact:

- The whole sentence has one full date but four time candidates.
- The changed-time clause has `같은 날` and two time candidates.
- A full date inferred from a previous clause would be invented if stored as scalar evidence for the narrow quote.

## Fresh Observed Cause

The bounded 2026-09-16 synthetic measurement saved raw output under `artifacts/product-utility-2026-09-16/live/`. That fresh output handled the relative range correctly as `semantic:null`, but still failed because `fact_prep_deadline` emitted `timezone: "Asia/Seoul"` for the quote `2026년 9월 23일 10:00`.

The full source had a separate sentence saying all times were Korean Standard Time. The scalar quote and display value did not contain the timezone. The strict validator rejected this as `SEMANTIC_EVIDENCE_MISMATCH`. This fresh cause is precise for the 2026-09-16 bounded measurement only; it must not be retroactively claimed as the exact cause of the earlier historical failure.

## Model Contract

The model prompt now tells the provider:

- ranges, relative dates such as `같은 날`, and quotes with multiple instants are not scalar `date_time` facts;
- timezone must appear in both the scalar quote and the displayed value; the model must never inherit timezone from another sentence or wider context;
- for quote/value such as `2026년 9월 23일 10:00`, omit timezone even when the full source says `KST` or `Asia/Seoul` elsewhere;
- for new untyped facts only, preserve verbatim source text with `semantic:null`;
- prose items for that preserved text must use `valueFactKey:null`;
- if preserving text would erase an existing typed semantic, leave state unchanged and ask a clear question.

The model must not emit invented normalized ISO intervals from ambiguous prose. User-confirmed recovery setup fields remain the place where exact old/new intervals are entered and validated.

## Verification Shape

The dedicated deterministic unit tests live in `tests/unit/notice-date-contract.test.ts`:

- one explicit Korean date-time scalar is accepted;
- a scalar Korean deadline with a global timezone sentence is accepted only when timezone is omitted;
- inherited scalar timezone from another sentence is rejected;
- the archived relative-date range is rejected when miscast as a scalar `date_time`;
- the same range can be preserved as untyped source text and a prose item without invented ISO normalization;
- typed semantic erasure is rejected and the input snapshot remains unchanged;
- the generated Gemini request contains the prompt contract.

These tests are contract tests for the deterministic engine and prompt body. They do not call Gemini, start a browser, or prove live model accuracy.

## Bounded live recheck

After the fresh output identified unsupported timezone inheritance, the concrete one-call retest plan and exact grader received independent approval. The same synthetic notice passed production `buildChangeSet` with verbatim range facts, no scalar range semantics, a linked single schedule, a correctly typed deadline without inherited timezone, one checklist item and no unanswered question. Evidence: `artifacts/product-utility-2026-09-16/live/timezone-recheck/`. Cost USD0.007757; preceding failed range and passing explicit-scalar calls cost USD0.006397 together, for USD0.014154 total. These are newly observed narrow measurements, not historical regrading, general accuracy, or a public Queue/persistence test. No automatic retries, public workspace writes, Calendar actions or email sends occurred in these calls.

## Final prompt measurement and remaining limitation

The expanded instructions exceeded the existing input budget on frozen large-input cases. Instructions were compacted without changing the schema, budget, validator or frozen assertions; independent review found the material rules preserved. The largest recorded corpus request is 11,975 of the 12,000 conservative input units. The focused 49 model/date/corpus/CLI checks passed.

One separately reviewed final-prompt call cost USD0.004073 and **failed** its fixed quality criterion (5 of 6 checks passed). Production core validation accepted the proposal, and the relative range remained untyped with no unsupported timezone. However, the model also left the explicit deadline `2026년 9월 23일 10:00` untyped. Its text and evidence were retained, but it was not eligible for typed automatic input. This is a missed structured extraction, not a passed date-quality check. Evidence: `artifacts/product-utility-2026-09-16/live/final-prompt-recheck/`.

Total observed cost for all four calls in this task: USD0.018227. The earlier successful call does not establish acceptance of the final prompt. Reliable typed extraction remains unresolved; users must confirm or enter times when verified scalar metadata is absent. No further paid retries or grader changes were made. Ship claims cover strict validation, conservative prefill, completed-work review and the prepared demonstration, not robust parsing of arbitrary natural-language intervals.
