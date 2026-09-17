import type { EvaluationExpectation, EvaluationMetrics } from './metrics';

export type ExpectedEvaluationOutcome = Exclude<EvaluationMetrics['outcome'], 'incorrect'>;
export type QualityExpectation = EvaluationExpectation & { expectedOutcome?: ExpectedEvaluationOutcome };
export type QualityVerdict = {
  expectedOutcome: ExpectedEvaluationOutcome;
  qualityStatus: 'passed' | 'failed';
};

export function evaluateQuality(metrics: EvaluationMetrics, expectation: QualityExpectation): QualityVerdict {
  const rawExpectedOutcome = (expectation as EvaluationExpectation & { expectedOutcome?: EvaluationMetrics['outcome'] }).expectedOutcome;
  const expectedOutcome = rawExpectedOutcome && rawExpectedOutcome !== 'incorrect'
    ? rawExpectedOutcome
    : expectation.conflictExpected ? 'conflict_detected' : 'completed';
  const preservesWorkspaceSafety = metrics.protectedStateLosses === 0 && metrics.unexpectedItemChanges === 0;
  const expectedFactsMatch = metrics.factChecksPassed === metrics.factChecksTotal;
  const expectedItemsMatch = metrics.itemChecksPassed === metrics.itemChecksTotal;
  const snapshotChangeAllowed = !expectation.requireUnchangedSnapshot || !metrics.snapshotChanged;
  const conflictsAllowed = expectedOutcome !== 'needs_input' || expectation.conflictExpected || metrics.conflicts === 0;
  return {
    expectedOutcome,
    qualityStatus: preservesWorkspaceSafety && expectedFactsMatch && expectedItemsMatch && snapshotChangeAllowed && conflictsAllowed && metrics.outcome === expectedOutcome ? 'passed' : 'failed',
  };
}
