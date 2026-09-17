import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildUtilityTrialReport, type UtilityTrialInput } from '../../src/evaluation/utility-trial';

describe('utility trial report', () => {
  it('builds a paired report without private content and preserves negative savings', () => {
    const report = buildUtilityTrialReport(input([
      record('p01', 'independent', 'case_a', 1, 'manual', completed(300), 1, 1),
      record('p01', 'independent', 'case_a', 2, 'service', completed(360), 1, 0),
      record('p02', 'operator', 'case_b', 2, 'manual', completed(600), 2, 1),
      record('p02', 'operator', 'case_b', 1, 'service', completed(420), 1, 0),
    ]));

    expect(report.totals).toMatchObject({ records: 4, participants: 2, cases: 2, pairs: 2, completedPairs: 2, excludedPairs: 0, failedOrAbortedRecords: 0 });
    expect(report.pairs.map((pair) => pair.savingsSeconds)).toEqual([-60, 180]);
    expect(report.participantTypes.find((group) => group.participantType === 'independent')).toMatchObject({ pairs: 1, averageSavingsSeconds: -60 });
    expect(report.counterbalance).toMatchObject({ manualFirstPairs: 1, serviceFirstPairs: 1, tiedOrderPairs: 0, balanced: true, practiceEffectRisk: false });
    expect(report.qualityGate).toMatchObject({ passed: true });
    expect(report.localComparisonSignal).toMatchObject({ supported: true, averageSavingsSeconds: 60, scope: 'local_paired_observation_only' });
    expect(report.speedClaim).toMatchObject({ allowed: false, averageSavingsSeconds: 60 });
    expect(report.speedClaim.reasons).toContain('UTILITY_TRIAL_DOES_NOT_PROVE_GENERAL_USER_SPEED_OR_DEMAND');
    expect(report.globalClaim).toMatchObject({ allowed: false });
    expect(JSON.stringify(report)).not.toContain('private');
  });

  it('counts every failure and excludes incomplete pairs from time savings', () => {
    const report = buildUtilityTrialReport(input([
      record('self_1', 'self', 'case_a', 1, 'manual', completed(300), 0, 0),
      record('self_1', 'self', 'case_a', 2, 'service', completed(200), 1, 1),
      record('self_1', 'self', 'case_b', 3, 'manual', completed(240), 0, 0),
      record('self_1', 'self', 'case_b', 4, 'service', completed(180), 0, 2, 'failed'),
    ]));

    expect(report.totals).toMatchObject({ pairs: 2, completedPairs: 1, excludedPairs: 1, failedOrAbortedRecords: 1 });
    expect(report.exclusions).toEqual([expect.objectContaining({ caseId: 'case_b', reason: 'PAIR_NOT_BOTH_COMPLETED', serviceOutcome: 'failed' })]);
    expect(report.failureCounts).toMatchObject({ manualFailed: 0, manualAborted: 0, serviceFailed: 1, serviceAborted: 0 });
    expect(report.qualityGate).toMatchObject({ passed: false });
    expect(report.speedClaim.allowed).toBe(false);
    expect(report.speedClaim.reasons).toEqual(expect.arrayContaining(['FAILURES_OR_ABORTS_PRESENT', 'QUALITY_GATE_FAILED']));
    expect(report.localComparisonSignal.reasons).toEqual(expect.arrayContaining(['FAILURES_OR_ABORTS_PRESENT', 'QUALITY_GATE_FAILED', 'ORDER_OR_PRACTICE_BIAS_RISK']));
  });

  it('does not treat equal missed changes as a quality pass', () => {
    const report = buildUtilityTrialReport(input([
      record('p01', 'independent', 'case_a', 1, 'manual', completed(300), 1, 1),
      record('p01', 'independent', 'case_a', 2, 'service', completed(210), 1, 1),
      record('p02', 'independent', 'case_b', 2, 'manual', completed(300), 0, 0),
      record('p02', 'independent', 'case_b', 1, 'service', completed(210), 0, 0),
    ]));

    expect(report.qualityGate).toMatchObject({ passed: false, reason: 'SERVICE_MISSED_CHANGES_OR_EXTRA_CORRECTIONS_PRESENT' });
    expect(report.qualityGate.failedPairs).toEqual([expect.objectContaining({ participantPseudonym: 'p01', missedChangesDelta: 0 })]);
    expect(report.localComparisonSignal.supported).toBe(false);
    expect(report.localComparisonSignal.reasons).toContain('QUALITY_GATE_FAILED');
  });

  it('requires both trial orders before supporting even a local comparison signal', () => {
    const oneOrder = buildUtilityTrialReport(input([
      record('p01', 'independent', 'case_a', 1, 'manual', completed(300), 0, 0),
      record('p01', 'independent', 'case_a', 2, 'service', completed(210), 0, 0),
    ]));

    expect(oneOrder.counterbalance).toMatchObject({ manualFirstPairs: 1, serviceFirstPairs: 0, balanced: false, practiceEffectRisk: true });
    expect(oneOrder.localComparisonSignal).toMatchObject({ supported: false });
    expect(oneOrder.localComparisonSignal.reasons).toContain('ORDER_OR_PRACTICE_BIAS_RISK');
  });

  it('rejects duplicate or missing manual/service pairs', () => {
    expect(() => buildUtilityTrialReport(input([
      record('p01', 'independent', 'case_a', 1, 'manual', completed(100), 0, 0),
      record('p01', 'independent', 'case_a', 2, 'manual', completed(90), 0, 0),
      record('p01', 'independent', 'case_a', 3, 'service', completed(80), 0, 0),
    ]))).toThrow(/UTILITY_TRIAL_INVALID_PAIR/);

    expect(() => buildUtilityTrialReport(input([
      record('p02', 'operator', 'case_a', 1, 'manual', completed(100), 0, 0),
      record('p03', 'operator', 'case_a', 1, 'manual', completed(100), 0, 0),
      record('p03', 'operator', 'case_a', 2, 'service', completed(80), 0, 0),
    ]))).toThrow(/UTILITY_TRIAL_INVALID_PAIR/);

    expect(() => buildUtilityTrialReport(input([
      record('p04', 'operator', 'case_a', 1, 'manual', completed(100), 0, 0),
      record('p04', 'operator', 'case_a', 1, 'service', completed(80), 0, 0),
    ]))).toThrow(/UTILITY_TRIAL_TIED_ORDER/);
  });

  it('rejects invalid durations, counts, participant type drift and unexpected raw fields', () => {
    expect(() => buildUtilityTrialReport(input([
      record('p01', 'independent', 'case_a', 1, 'manual', completed(0), 0, 0),
      record('p01', 'independent', 'case_a', 2, 'service', completed(80), 0, 0),
    ]))).toThrow();

    expect(() => buildUtilityTrialReport(input([
      record('p01', 'independent', 'case_a', 1, 'manual', { copy: 86_401, setup: 0, review: 0, correction: 0, approval: 0 }, 0, 0),
      record('p01', 'independent', 'case_a', 2, 'service', completed(80), 0, 0),
    ]))).toThrow();

    expect(() => buildUtilityTrialReport(input([
      record('p01', 'independent', 'case_a', 1, 'manual', completed(100), -1, 0),
      record('p01', 'independent', 'case_a', 2, 'service', completed(80), 0, 0),
    ]))).toThrow();

    expect(() => buildUtilityTrialReport(input([
      record('p01', 'self', 'case_a', 1, 'manual', completed(100), 0, 0),
      record('p01', 'self', 'case_a', 2, 'service', completed(80), 0, 0),
      record('p01', 'operator', 'case_b', 1, 'manual', completed(100), 0, 0),
      record('p01', 'operator', 'case_b', 2, 'service', completed(80), 0, 0),
    ]))).toThrow(/UTILITY_TRIAL_PARTICIPANT_TYPE_CHANGED/);

    const rawWithPrivateFields = {
      schemaVersion: 1,
      studyId: 'utility_trial_test',
      privateContent: 'private source text',
      records: [
        { ...record('p01', 'independent', 'case_a', 1, 'manual', completed(100), 0, 0), rawSource: 'private source text' },
        record('p01', 'independent', 'case_a', 2, 'service', completed(80), 0, 0),
      ],
    };
    expect(() => buildUtilityTrialReport(rawWithPrivateFields)).toThrow();
  });

  it('executes the offline CLI for a specified JSON path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ieojim-utility-trial-'));
    try {
      const path = join(directory, 'trial.json');
      await writeFile(path, JSON.stringify(input([
        record('p01', 'independent', 'case_a', 1, 'manual', completed(300), 0, 0),
        record('p01', 'independent', 'case_a', 2, 'service', completed(210), 0, 0),
      ])));
      const result = await execUtilityTrial(path);
      expect(result, result.stderr).toMatchObject({ code: 0 });
      const report = JSON.parse(result.stdout) as { speedClaim: { allowed: boolean }; totals: { completedPairs: number } };
      expect(report).toMatchObject({ speedClaim: { allowed: false }, totals: { completedPairs: 1 } });

      const invalidPath = join(directory, 'invalid.json');
      await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, studyId: 'bad', records: [] }));
      const failedRun = await execUtilityTrial(invalidPath);
      expect(failedRun.code).toBe(1);
      expect(failedRun.stderr).toContain('UTILITY_TRIAL_INPUT_ERROR');
      expect(await readFile(path, 'utf8')).toContain('case_a');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function input(records: UtilityTrialInput['records']): UtilityTrialInput {
  return { schemaVersion: 1, studyId: 'utility_trial_test', records };
}

function record(
  participantPseudonym: string,
  participantType: UtilityTrialInput['records'][number]['participantType'],
  caseId: string,
  order: number,
  method: UtilityTrialInput['records'][number]['method'],
  elapsedSeconds: UtilityTrialInput['records'][number]['elapsedSeconds'],
  corrections: number,
  missedChanges: number,
  outcome: UtilityTrialInput['records'][number]['outcome'] = 'completed',
): UtilityTrialInput['records'][number] {
  return { participantPseudonym, participantType, caseId, order, method, elapsedSeconds, outcome, corrections, missedChanges };
}

function completed(total: number): UtilityTrialInput['records'][number]['elapsedSeconds'] {
  return { copy: total, setup: 0, review: 0, correction: 0, approval: 0 };
}

function execUtilityTrial(path: string): Promise<{ code: number | string; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../scripts/utility-trial.ts', import.meta.url)), path], { timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}
