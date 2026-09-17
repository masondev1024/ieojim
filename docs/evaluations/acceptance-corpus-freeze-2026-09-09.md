# Acceptance Corpus Freeze - 2026-09-09

This document freezes `src/evaluation/acceptance-cases.ts` as a synthetic acceptance corpus authored before observing any live model outputs for these cases.

## Scope

- Corpus file: `src/evaluation/acceptance-cases.ts`
- Validation file: `tests/unit/acceptance-cases.test.ts`
- Case count: 12
- Language and domain: Korean, source-backed editable workspace scenarios
- Scenarios: travel changes and assignment/deadline changes using the same workspace engine

## Freeze Hash

The corrected frozen corpus SHA-256 is:

```text
af23574ed7580c1758c3853a5abe3a2d3581f79931540feb8ebbeaa9c6855e88
```

The hash uses the same corpus algorithm as `scripts/eval-live.ts`: case id, purpose, snapshot, source id/hash/relation/target/answer metadata, and expectation are serialized with `JSON.stringify` and hashed with SHA-256.

The original pre-paid freeze hash was:

```text
06d0b47830c3d0388539239d35351064de07708b9a7d60df85dcd72731475e22
```

That first freeze was invalidated before any paid acceptance calls because the baseline used timezone metadata where the source quotes only showed local clock values, and one assignment item used a typed count/count calculation that the current engine contract does not support. The corrected corpus removes implicit timezone metadata and replaces the assignment calculation with a direct fact-backed count item. This correction is not based on model output; the fresh suite still has zero paid calls.

## Authorship And Evidence Boundary

- The cases are fully synthetic and are not based on user studies, private user data, production workspaces, or prior live model outputs.
- They were created before running paid live evaluations against this acceptance corpus.
- The author did not inspect prior heldout cases, prior live outputs, or current model instructions. While locating the hash algorithm, an adjacent existing smoke-case block was incidentally displayed. This is independent pre-output case authorship with that disclosure, not a claim of a fully blind experiment.
- Source dates are synthetic fixed timestamps on 2026-09-01 and 2026-09-02.
- Source text is treated as immutable evidence. Baseline facts point to exact stored source quotes with checked offsets.
- This corpus should not be edited in response to observed model behavior. If requirements change, create a new dated corpus freeze and keep this hash as the historical benchmark.

## Coverage Intent

The 12 cases cover:

- Same-entity contradictory additions that require a source conflict.
- Targeted corrections and replacements that should update the existing fact and dependent item.
- Clearly different entities with the same attribute that must not be force-merged.
- Ambiguous quantities or times that require a question and unchanged snapshot.
- Immutable evidence anchoring through source hashes and quote offsets.
- Locked, edited, and completed user content preservation.
- Protected deletion conflicts.
- Derived KRW/count dependency recalculation.
- Travel and assignment workflows using the same evaluation contract.

## Budget Note

The planned live acceptance run is 12 calls. At the current reserve of `$0.02436` per call, the maximum reserved amount is `$0.29232`, which is within the stated `$0.30` planning envelope. No paid calls were made while authoring this corpus.

## Execution Record

After independent gold re-review and all 12 ideal-draft feasibility checks, the corrected freeze was executed once at 21:19 KST. First result: **12/12 passed**, 12 calls, USD 0.035063 by usage accounting. No corpus edits followed those outputs. See [the measured report](source-identity-recovery-2026-09-09.md). This execution does not change the authorship disclosures or establish human-trial results.
