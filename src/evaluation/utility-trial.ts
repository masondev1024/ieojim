import { z } from 'zod';

const participantTypeSchema = z.enum(['self', 'operator', 'independent']);
const methodSchema = z.enum(['manual', 'service']);
const outcomeSchema = z.enum(['completed', 'failed', 'aborted']);

const elapsedSecondsSchema = z.object({
  copy: z.number().finite().nonnegative(),
  setup: z.number().finite().nonnegative(),
  review: z.number().finite().nonnegative(),
  correction: z.number().finite().nonnegative(),
  approval: z.number().finite().nonnegative(),
}).strict()
  .refine((value) => Object.values(value).some((seconds) => seconds > 0), 'elapsedSeconds must contain positive work time')
  .refine((value) => totalSeconds(value) <= 86_400, 'elapsedSeconds total must be at most one day');

const recordSchema = z.object({
  participantPseudonym: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  participantType: participantTypeSchema,
  caseId: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  order: z.number().int().positive().safe(),
  method: methodSchema,
  elapsedSeconds: elapsedSecondsSchema,
  outcome: outcomeSchema,
  corrections: z.number().int().nonnegative().safe(),
  missedChanges: z.number().int().nonnegative().safe(),
}).strict();

export const utilityTrialInputSchema = z.object({
  schemaVersion: z.literal(1),
  studyId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  records: z.array(recordSchema).min(2).max(500),
}).strict();

export type UtilityTrialInput = z.infer<typeof utilityTrialInputSchema>;
export type UtilityTrialRecord = z.infer<typeof recordSchema>;
export type ParticipantType = z.infer<typeof participantTypeSchema>;

export type UtilityTrialReport = {
  schemaVersion: 1;
  studyId: string;
  totals: {
    records: number;
    participants: number;
    cases: number;
    pairs: number;
    completedPairs: number;
    excludedPairs: number;
    failedOrAbortedRecords: number;
  };
  participantTypes: Array<{
    participantType: ParticipantType;
    participants: number;
    pairs: number;
    completedPairs: number;
    failedOrAbortedRecords: number;
    averageManualSeconds: number | null;
    averageServiceSeconds: number | null;
    averageSavingsSeconds: number | null;
    averageCorrectionsDelta: number | null;
    averageMissedChangesDelta: number | null;
  }>;
  pairs: Array<{
    participantPseudonym: string;
    participantType: ParticipantType;
    caseId: string;
    manualOrder: number;
    serviceOrder: number;
    manualOutcome: UtilityTrialRecord['outcome'];
    serviceOutcome: UtilityTrialRecord['outcome'];
    manualSeconds: number;
    serviceSeconds: number;
    includedInTimeComparison: boolean;
    exclusionReason: string | null;
    savingsSeconds: number | null;
    correctionsDelta: number;
    missedChangesDelta: number;
    serviceMissedChanges: number;
  }>;
  exclusions: Array<{
    participantPseudonym: string;
    participantType: ParticipantType;
    caseId: string;
    reason: string;
    manualOutcome: UtilityTrialRecord['outcome'];
    serviceOutcome: UtilityTrialRecord['outcome'];
  }>;
  failureCounts: {
    manualFailed: number;
    manualAborted: number;
    serviceFailed: number;
    serviceAborted: number;
  };
  qualityGate: {
    passed: boolean;
    reason: string;
    failedPairs: Array<{
      participantPseudonym: string;
      caseId: string;
      correctionsDelta: number;
      missedChangesDelta: number;
    }>;
  };
  counterbalance: {
    manualFirstPairs: number;
    serviceFirstPairs: number;
    tiedOrderPairs: number;
    balanced: boolean;
    practiceEffectRisk: boolean;
  };
  speedClaim: {
    allowed: boolean;
    reasons: string[];
    averageSavingsSeconds: number | null;
  };
  localComparisonSignal: {
    supported: boolean;
    reasons: string[];
    averageSavingsSeconds: number | null;
    scope: 'local_paired_observation_only';
  };
  globalClaim: {
    allowed: false;
    reason: 'UTILITY_TRIAL_DOES_NOT_PROVE_GENERAL_USER_SPEED_OR_DEMAND';
  };
};

type Pair = {
  participantPseudonym: string;
  participantType: ParticipantType;
  caseId: string;
  manual: UtilityTrialRecord;
  service: UtilityTrialRecord;
};

export function buildUtilityTrialReport(raw: unknown): UtilityTrialReport {
  const input = utilityTrialInputSchema.parse(raw);
  assertStableParticipantTypes(input.records);
  const pairs = pairRecords(input.records);
  const pairRows = pairs.map((pair) => pairReport(pair));
  const completedRows = pairRows.filter((pair) => pair.includedInTimeComparison);
  const failedOrAbortedRecords = input.records.filter((record) => record.outcome !== 'completed').length;
  const qualityFailures = completedRows
    .filter((pair) => pair.correctionsDelta > 0 || pair.serviceMissedChanges !== 0)
    .map(({ participantPseudonym, caseId, correctionsDelta, missedChangesDelta }) => ({ participantPseudonym, caseId, correctionsDelta, missedChangesDelta }));
  const qualityPassed = qualityFailures.length === 0;
  const averageSavingsSeconds = average(completedRows.map((pair) => pair.savingsSeconds).filter((value): value is number => value !== null));
  const balance = counterbalance(pairRows);
  const localSignalReasons = localComparisonReasons(completedRows.length, failedOrAbortedRecords, qualityPassed, averageSavingsSeconds, balance);

  return {
    schemaVersion: 1,
    studyId: input.studyId,
    totals: {
      records: input.records.length,
      participants: new Set(input.records.map((record) => record.participantPseudonym)).size,
      cases: new Set(input.records.map((record) => record.caseId)).size,
      pairs: pairs.length,
      completedPairs: completedRows.length,
      excludedPairs: pairRows.length - completedRows.length,
      failedOrAbortedRecords,
    },
    participantTypes: summarizeParticipantTypes(pairs),
    pairs: pairRows,
    exclusions: pairRows
      .filter((pair) => !pair.includedInTimeComparison)
      .map(({ participantPseudonym, participantType, caseId, exclusionReason, manualOutcome, serviceOutcome }) => ({
        participantPseudonym,
        participantType,
        caseId,
        reason: exclusionReason ?? 'not_excluded',
        manualOutcome,
        serviceOutcome,
      })),
    failureCounts: {
      manualFailed: count(input.records, 'manual', 'failed'),
      manualAborted: count(input.records, 'manual', 'aborted'),
      serviceFailed: count(input.records, 'service', 'failed'),
      serviceAborted: count(input.records, 'service', 'aborted'),
    },
    qualityGate: {
      passed: qualityPassed,
      reason: qualityPassed ? 'SERVICE_COMPLETED_WITH_ZERO_MISSED_CHANGES_AND_NO_EXTRA_CORRECTIONS' : 'SERVICE_MISSED_CHANGES_OR_EXTRA_CORRECTIONS_PRESENT',
      failedPairs: qualityFailures,
    },
    counterbalance: balance,
    speedClaim: {
      allowed: false,
      reasons: ['UTILITY_TRIAL_DOES_NOT_PROVE_GENERAL_USER_SPEED_OR_DEMAND', ...localSignalReasons],
      averageSavingsSeconds,
    },
    localComparisonSignal: {
      supported: localSignalReasons.length === 0,
      reasons: localSignalReasons,
      averageSavingsSeconds,
      scope: 'local_paired_observation_only',
    },
    globalClaim: {
      allowed: false,
      reason: 'UTILITY_TRIAL_DOES_NOT_PROVE_GENERAL_USER_SPEED_OR_DEMAND',
    },
  };
}

function pairRecords(records: UtilityTrialRecord[]): Pair[] {
  const groups = new Map<string, UtilityTrialRecord[]>();
  for (const record of records) {
    const key = `${record.participantPseudonym}\u0000${record.caseId}`;
    groups.set(key, [...groups.get(key) ?? [], record]);
  }
  const pairs: Pair[] = [];
  for (const [key, group] of groups) {
    const manual = group.filter((record) => record.method === 'manual');
    const service = group.filter((record) => record.method === 'service');
    if (manual.length !== 1 || service.length !== 1 || group.length !== 2) {
      throw new Error(`UTILITY_TRIAL_INVALID_PAIR:${key.replaceAll('\u0000', ':')}`);
    }
    if (manual[0]!.order === service[0]!.order) {
      throw new Error(`UTILITY_TRIAL_TIED_ORDER:${key.replaceAll('\u0000', ':')}`);
    }
    if (manual[0]!.participantType !== service[0]!.participantType) {
      throw new Error(`UTILITY_TRIAL_PARTICIPANT_TYPE_MISMATCH:${key.replaceAll('\u0000', ':')}`);
    }
    pairs.push({
      participantPseudonym: manual[0]!.participantPseudonym,
      participantType: manual[0]!.participantType,
      caseId: manual[0]!.caseId,
      manual: manual[0]!,
      service: service[0]!,
    });
  }
  return pairs.sort((left, right) =>
    left.participantPseudonym.localeCompare(right.participantPseudonym) ||
    left.caseId.localeCompare(right.caseId));
}

function pairReport(pair: Pair): UtilityTrialReport['pairs'][number] {
  const manualSeconds = totalSeconds(pair.manual.elapsedSeconds);
  const serviceSeconds = totalSeconds(pair.service.elapsedSeconds);
  const included = pair.manual.outcome === 'completed' && pair.service.outcome === 'completed';
  const correctionsDelta = pair.service.corrections - pair.manual.corrections;
  const missedChangesDelta = pair.service.missedChanges - pair.manual.missedChanges;
  return {
    participantPseudonym: pair.participantPseudonym,
    participantType: pair.participantType,
    caseId: pair.caseId,
    manualOrder: pair.manual.order,
    serviceOrder: pair.service.order,
    manualOutcome: pair.manual.outcome,
    serviceOutcome: pair.service.outcome,
    manualSeconds,
    serviceSeconds,
    includedInTimeComparison: included,
    exclusionReason: included ? null : 'PAIR_NOT_BOTH_COMPLETED',
    savingsSeconds: included ? manualSeconds - serviceSeconds : null,
    correctionsDelta,
    missedChangesDelta,
    serviceMissedChanges: pair.service.missedChanges,
  };
}

function summarizeParticipantTypes(pairs: Pair[]): UtilityTrialReport['participantTypes'] {
  return participantTypeSchema.options.map((participantType) => {
    const selected = pairs.filter((pair) => pair.participantType === participantType);
    const rows = selected.map((pair) => pairReport(pair));
    const completed = rows.filter((row) => row.includedInTimeComparison);
    return {
      participantType,
      participants: new Set(selected.map((pair) => pair.participantPseudonym)).size,
      pairs: selected.length,
      completedPairs: completed.length,
      failedOrAbortedRecords: selected.flatMap((pair) => [pair.manual, pair.service]).filter((record) => record.outcome !== 'completed').length,
      averageManualSeconds: average(completed.map((row) => row.manualSeconds)),
      averageServiceSeconds: average(completed.map((row) => row.serviceSeconds)),
      averageSavingsSeconds: average(completed.map((row) => row.savingsSeconds).filter((value): value is number => value !== null)),
      averageCorrectionsDelta: average(completed.map((row) => row.correctionsDelta)),
      averageMissedChangesDelta: average(completed.map((row) => row.missedChangesDelta)),
    };
  });
}

function counterbalance(rows: UtilityTrialReport['pairs']): UtilityTrialReport['counterbalance'] {
  const manualFirstPairs = rows.filter((row) => row.manualOrder < row.serviceOrder).length;
  const serviceFirstPairs = rows.filter((row) => row.serviceOrder < row.manualOrder).length;
  const tiedOrderPairs = rows.length - manualFirstPairs - serviceFirstPairs;
  const balanced = tiedOrderPairs === 0 && manualFirstPairs > 0 && serviceFirstPairs > 0 && Math.abs(manualFirstPairs - serviceFirstPairs) <= 1;
  return { manualFirstPairs, serviceFirstPairs, tiedOrderPairs, balanced, practiceEffectRisk: !balanced };
}

function totalSeconds(elapsed: { copy: number; setup: number; review: number; correction: number; approval: number }): number {
  return elapsed.copy + elapsed.setup + elapsed.review + elapsed.correction + elapsed.approval;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function count(records: UtilityTrialRecord[], method: UtilityTrialRecord['method'], outcome: UtilityTrialRecord['outcome']): number {
  return records.filter((record) => record.method === method && record.outcome === outcome).length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function assertStableParticipantTypes(records: UtilityTrialRecord[]): void {
  const participantTypes = new Map<string, ParticipantType>();
  for (const record of records) {
    const previous = participantTypes.get(record.participantPseudonym);
    if (previous && previous !== record.participantType) throw new Error(`UTILITY_TRIAL_PARTICIPANT_TYPE_CHANGED:${record.participantPseudonym}`);
    participantTypes.set(record.participantPseudonym, record.participantType);
  }
}

function localComparisonReasons(
  completedPairs: number,
  failedOrAbortedRecords: number,
  qualityPassed: boolean,
  averageSavingsSeconds: number | null,
  balance: UtilityTrialReport['counterbalance'],
): string[] {
  const reasons: string[] = [];
  if (completedPairs === 0) reasons.push('NO_COMPLETED_PAIRS');
  if (failedOrAbortedRecords > 0) reasons.push('FAILURES_OR_ABORTS_PRESENT');
  if (!qualityPassed) reasons.push('QUALITY_GATE_FAILED');
  if (averageSavingsSeconds === null || averageSavingsSeconds <= 0) reasons.push('NO_POSITIVE_AVERAGE_SAVINGS');
  if (!balance.balanced) reasons.push('ORDER_OR_PRACTICE_BIAS_RISK');
  return reasons;
}
