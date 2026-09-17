import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/core/contracts';
import { getAcceptanceCases } from '../../src/evaluation/acceptance-cases';
import { acceptanceCorpusHash, aggregatePairedReports, createFinalsPairedPlan, type LiveEvalReport } from '../../src/evaluation/paired-eval';

const cases = getAcceptanceCases();
const corpusHash = acceptanceCorpusHash(cases);
const caseIds = cases.map((test) => test.id);

function result(caseId: string, strategy: 'incremental' | 'regenerate', overrides: Record<string, unknown> = {}) {
  return {
    case: caseId,
    strategy,
    requestedContext: 'full',
    effectiveContext: 'full',
    status: 'evaluated',
    qualityStatus: 'passed',
    expectedOutcome: 'completed',
    inputTokens: 100,
    outputTokens: strategy === 'incremental' ? 20 : 25,
    costMicroUsd: strategy === 'incremental' ? 200 : 250,
    latencyMs: strategy === 'incremental' ? 1000 : 1200,
    requestProvenance: {
      modelId: 'gemini-3.8-flash', contractVersion: 2, strategy,
      contextRequestedMode: 'full', contextEffectiveMode: 'full',
      instructionSha256: (strategy === 'incremental' ? 'a' : 'b').repeat(64),
      localSchemaSha256: 'c'.repeat(64), generationConfigSha256: 'd'.repeat(64),
      modelPolicySha256: 'e'.repeat(64), contextSha256: 'f'.repeat(64),
    },
    metrics: {
      outcome: 'completed',
      factChecksPassed: 1,
      factChecksTotal: 1,
      itemChecksPassed: 1,
      itemChecksTotal: 1,
      protectedStateLosses: 0,
      unexpectedItemChanges: 0,
      conflicts: 0,
      questions: 0,
      snapshotChanged: true,
    },
    ...overrides,
  };
}

function report(
  strategy: 'incremental' | 'regenerate',
  results: ReturnType<typeof result>[] = caseIds.map((caseId) => result(caseId, strategy)),
  reportCaseIds = caseIds,
): LiveEvalReport {
  return {
    suite: 'acceptance',
    corpusHash,
    model: 'gemini-3.8-flash',
    contexts: ['full'],
    contextMode: 'full',
    strategies: [strategy],
    cases: reportCaseIds,
    maximumReservedUsd: reportCaseIds.length * LIMITS.reserveMicroUsd / 1_000_000,
    plannedCalls: reportCaseIds.length,
    attemptedCalls: results.length,
    chargedOrReservedMicroUsd: results.length * LIMITS.reserveMicroUsd,
    stoppedReason: null,
    results,
  };
}

describe('finals paired evaluation planning', () => {
  it('splits the frozen acceptance corpus into two under-limit strategy batches', () => {
    const plan = createFinalsPairedPlan(cases, 'gemini-3.8-flash');
    expect(plan).toMatchObject({
      planKind: 'finals-paired-acceptance-v1',
      mode: 'dry-run-no-model-calls',
      suite: 'acceptance',
      corpusHash,
      corpusCaseCount: 12,
      contractVersion: 2,
      context: 'full',
      strategies: ['incremental', 'regenerate'],
      plannedCalls: 24,
      maximumReservedUsd: 0.58464,
    });
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches.map((batch) => batch.command)).toEqual([
      'npm run eval:live -- --suite acceptance --strategy incremental --context full --max-usd 0.50',
      'npm run eval:live -- --suite acceptance --strategy regenerate --context full --max-usd 0.50',
    ]);
    expect(plan.batches.every((batch) => batch.fitsBatchLimit && batch.maximumReservedUsd === 0.29232)).toBe(true);
  });
});

describe('finals paired evaluation aggregation', () => {
  it('flags provenance drift and does not penalize necessary questions on passed cases', () => {
    const incremental = result(caseIds[0], 'incremental');
    const regenerate = result(caseIds[0], 'regenerate');
    const badProvenance = { ...regenerate.requestProvenance, localSchemaSha256: 'a'.repeat(64) };
    const drift = aggregatePairedReports([report('incremental', [incremental]), report('regenerate', [{ ...regenerate, requestProvenance: badProvenance }])], cases);
    expect(drift.mismatches).toContain('provenance drift: localSchemaSha256');
    expect(drift.comparable).toBe(false);
    const clean = aggregatePairedReports([report('incremental'), report('regenerate', caseIds.map((id) => {
      const value = result(id, 'regenerate');
      return { ...value, metrics: { ...value.metrics, questions: 1 } };
    }))], cases);
    expect(clean.comparable).toBe(true);
    expect(clean.cases.every((entry) => entry.winner === 'tie')).toBe(true);
  });

  it('keeps unknown cost unknown and never declares failed pairs winners', () => {
    const failed = (strategy: 'incremental' | 'regenerate') => caseIds.map((id) => result(id, strategy, { status: 'failed', qualityStatus: undefined, metrics: undefined, costMicroUsd: undefined }));
    const aggregate = aggregatePairedReports([report('incremental', failed('incremental')), report('regenerate', failed('regenerate'))], cases);
    expect(aggregate.summary.totalCostMicroUsd).toBeNull();
    expect(aggregate.summary.costObservations).toBe(0);
    expect(aggregate.summary.totalProtectedStateLosses).toBeNull();
    expect(aggregate.summary.totalUnexpectedItemChanges).toBeNull();
    expect(aggregate.summary.totalQuestions).toBeNull();
    expect(aggregate.summary.totalConflicts).toBeNull();
    expect(aggregate.summary.metricObservations).toEqual({ protectedStateLosses: 0, unexpectedItemChanges: 0, questions: 0, conflicts: 0 });
    expect(aggregate.cases.every((entry) => entry.winner === 'neither_passed')).toBe(true);
  });

  it('summarizes complete incremental/regenerate pairs without inventing missing metrics', () => {
    const aggregate = aggregatePairedReports([
      report('incremental'),
      report('regenerate', caseIds.map((caseId, index) => result(caseId, 'regenerate', index === 0 ? {
        outputTokens: undefined,
        costMicroUsd: undefined,
        latencyMs: undefined,
      } : {}))),
    ], cases);
    expect(aggregate).toMatchObject({
      reportKind: 'finals-paired-acceptance-aggregate-v1',
      suite: 'acceptance',
      corpusHash,
      model: 'gemini-3.8-flash',
      context: 'full',
      caseCount: 12,
      plannedCalls: 24,
      attemptedCalls: 24,
      missingPairs: [],
      duplicatePairs: [],
      mismatches: [],
      summary: {
        completePairs: 12,
        passedPairs: 12,
        failedOrErroredPairs: 0,
        totalProtectedStateLosses: 0,
        totalUnexpectedItemChanges: 0,
        totalQuestions: 0,
        totalConflicts: 0,
        evaluatedResults: 24,
        failedResults: 0,
      },
    });
    expect(aggregate.cases[0].comparison).toEqual({
      costMicroUsdDeltaRegenerateMinusIncremental: null,
      latencyMsDeltaRegenerateMinusIncremental: null,
      outputTokenDeltaRegenerateMinusIncremental: null,
    });
    expect(aggregate.cases[1].comparison).toMatchObject({
      costMicroUsdDeltaRegenerateMinusIncremental: 50,
      latencyMsDeltaRegenerateMinusIncremental: 200,
      outputTokenDeltaRegenerateMinusIncremental: 5,
    });
  });

  it('reports missing pairs and malformed corpus/context metadata', () => {
    const aggregate = aggregatePairedReports([
      { ...report('incremental'), corpusHash: 'stale', contextMode: 'compact', contexts: ['compact'] },
      report('regenerate', caseIds.slice(0, 11).map((caseId) => result(caseId, 'regenerate')), caseIds.slice(0, 11)),
    ], cases);
    expect(aggregate.missingPairs).toEqual([`${caseIds[11]}/regenerate`]);
    expect(aggregate.mismatches).toEqual(expect.arrayContaining([
      'report[0]: corpusHash does not match frozen acceptance corpus',
      'report[0]: context is not full-only',
      `report[1]: missing case ids ${caseIds[11]}`,
    ]));
    expect(aggregate.summary).toMatchObject({ completePairs: 11, passedPairs: 11, failedOrErroredPairs: 1 });
  });

  it('detects duplicate case/strategy results instead of choosing one silently', () => {
    const duplicateCase = caseIds[0];
    const aggregate = aggregatePairedReports([
      report('incremental', [result(duplicateCase, 'incremental'), result(duplicateCase, 'incremental')], [duplicateCase]),
      report('regenerate', [result(duplicateCase, 'regenerate')], [duplicateCase]),
    ], [cases[0]]);
    expect(aggregate.duplicatePairs).toEqual([`${duplicateCase}/incremental`]);
    expect(aggregate.cases).toEqual([expect.objectContaining({
      case: duplicateCase,
      pairStatus: 'duplicate_pair',
      incremental: null,
      regenerate: expect.objectContaining({ status: 'evaluated' }),
      winner: 'incomplete',
    })]);
  });
});
