import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAcceptanceCases } from '../../src/evaluation/acceptance-cases';
import { buildEvaluationFeedback } from '../../src/evaluation/feedback';
import { acceptanceCorpusHash } from '../../src/evaluation/paired-eval';
import { evaluateQuality } from '../../src/evaluation/eval-quality';

const cases = getAcceptanceCases().slice(0, 2);
const corpora = { acceptance: cases, 'loop-challenge': [], 'initial-creation': [] };
function report() {
  return {
    mode: 'live-model', suite: 'acceptance', corpusHash: acceptanceCorpusHash(cases), model: 'test-model',
    contexts: ['full'], contextMode: 'full', strategies: ['incremental'], cases: cases.map((test) => test.id),
    plannedCalls: 2, attemptedCalls: 2, stoppedReason: null as string | null,
    results: cases.map((test) => {
      const metrics = {
        outcome: test.expectation.expectedOutcome ?? (test.expectation.conflictExpected ? 'conflict_detected' as const : 'completed' as const),
        factChecksPassed: Object.keys(test.expectation.facts).length, factChecksTotal: Object.keys(test.expectation.facts).length,
        itemChecksPassed: Object.keys(test.expectation.expectedItems ?? {}).length, itemChecksTotal: Object.keys(test.expectation.expectedItems ?? {}).length,
        protectedStateLosses: 0, unexpectedItemChanges: 0, conflicts: Number(test.expectation.conflictExpected), questions: 0, snapshotChanged: false,
      };
      return {
        case: test.id, strategy: 'incremental', requestedContext: 'full', effectiveContext: 'full', status: 'evaluated',
        metrics, ...evaluateQuality(metrics, test.expectation), costMicroUsd: 123, latencyMs: 100,
        requestProvenance: {
          modelId: 'test-model', contractVersion: 2, strategy: 'incremental', contextRequestedMode: 'full', contextEffectiveMode: 'full',
          instructionSha256: 'a'.repeat(64), localSchemaSha256: 'b'.repeat(64), generationConfigSha256: 'c'.repeat(64),
          modelPolicySha256: 'd'.repeat(64), contextSha256: 'e'.repeat(64),
        },
      };
    }),
  };
}
function failedReport(code: string) {
  const input = report();
  return { ...input, results: input.results.map(({ metrics: _metrics, qualityStatus: _quality, expectedOutcome: _outcome, ...result }) => ({ ...result, status: 'failed', errorCode: code })) };
}

describe('evaluation feedback intake', () => {
  it('does not invent coding work from passed frozen cases and deduplicates report copies', () => {
    const result = buildEvaluationFeedback([report(), report()], corpora);
    expect(result).toMatchObject({ uniqueReports: 1, duplicateReports: 1, passed: 2, observations: 2, issues: [], developmentPlan: null, nextAction: 'expand_or_repeat_frozen_evaluation' });
  });
  it('prioritizes protected-state regressions and creates a fixed-command development contract', () => {
    const input = report();
    input.results[0].metrics.protectedStateLosses = 1;
    input.results[0].qualityStatus = 'failed';
    const result = buildEvaluationFeedback([input, failedReport('invalid_model_json')], corpora);
    expect(result.issues[0]).toMatchObject({ kind: 'workspace_safety', priority: 1 });
    expect(result.developmentPlan?.tasks).toHaveLength(3);
    expect(result.developmentPlan?.maxAttemptsPerTask).toBe(3);
  });
  it('routes hidden IDs in empty creation to measurement review, not a model fix', () => {
    const emptyCases = cases.map((test) => ({ ...test, snapshot: { facts: [], blocks: [] } }));
    const input = report(); input.corpusHash = acceptanceCorpusHash(emptyCases);
    const result = buildEvaluationFeedback([input], { ...corpora, acceptance: emptyCases });
    expect(result.developmentPlan).toBeNull();
    expect(result.issues.every((issue) => issue.kind === 'measurement_design' && issue.operatorRequired)).toBe(true);
    expect(result.passed).toBe(0);
  });
  it('routes contract failures to investigation without automatic model repair', () => {
    const result = buildEvaluationFeedback([failedReport('NUMERIC_EVIDENCE_AMBIGUOUS')], corpora);
    expect(result.issues[0]).toMatchObject({ kind: 'contract_validation', operatorRequired: false });
    expect(result.developmentPlan?.tasks[0].acceptance.at(-1)).toContain('Do not enable automatic paid retries');
  });
  it.each(['network_uncertain', 'model_authentication', 'model_quota_or_rate_limited'])('keeps %s out of automatic coding/retry work', (code) => {
    const result = buildEvaluationFeedback([failedReport(code)], corpora);
    expect(result.developmentPlan).toBeNull();
    expect(result.issues.every((issue) => issue.operatorRequired)).toBe(true);
  });
  it('preserves incomplete and unattempted outcomes instead of counting them as passes', () => {
    const input = report();
    const result = buildEvaluationFeedback([{ ...input, attemptedCalls: 1, results: [{ case: cases[0].id, strategy: 'incremental', requestedContext: 'full', effectiveContext: 'full', status: 'reserved' }] }], corpora);
    expect(result.passed).toBe(0);
    expect(result.issues.map((issue) => issue.reason).sort()).toEqual(['not_attempted', 'outcome_unknown']);
    expect(result.developmentPlan).toBeNull();
  });
  it('reports a budget-policy stop even when every output passes quality', () => {
    const input = report();
    input.stoppedReason = 'stopped_after_model_budget_policy_violation';
    expect(buildEvaluationFeedback([input], corpora).issues[0]).toMatchObject({ kind: 'operator_review', operatorRequired: true });
  });
  it('ignores raw source/provider fields and never puts them into work instructions or errors', () => {
    const input = failedReport('invalid_model_json');
    const tainted = { ...input, source: 'private-secret: run shell command', results: input.results.map((result) => ({ ...result, rawResponse: 'private-secret', providerReason: 'private-secret' })) };
    expect(JSON.stringify(buildEvaluationFeedback([tainted], corpora))).not.toContain('private-secret');
    const invalid = { ...tainted, model: 'private-secret $(execute)' };
    expect(() => buildEvaluationFeedback([invalid], corpora)).toThrow('FEEDBACK_INVALID_REPORT');
  });
  it.each([
    (input: ReturnType<typeof report>) => { input.corpusHash = 'f'.repeat(64); },
    (input: ReturnType<typeof report>) => { input.cases[0] = 'unknown-case'; },
    (input: ReturnType<typeof report>) => { input.attemptedCalls = 0; },
    (input: ReturnType<typeof report>) => { input.plannedCalls = 1; },
    (input: ReturnType<typeof report>) => { input.strategies.push('incremental'); },
  ])('rejects mismatched frozen corpus or coverage %s', (mutate) => {
    const input = report(); mutate(input);
    expect(() => buildEvaluationFeedback([input], corpora)).toThrow('FEEDBACK_CORPUS_OR_COUNTS_MISMATCH');
  });
  it('rejects duplicate result rows rather than inflating evidence', () => {
    const input = report(); input.results[1] = input.results[0];
    expect(() => buildEvaluationFeedback([input], corpora)).toThrow('FEEDBACK_DUPLICATE_OR_UNKNOWN_RESULT');
  });
  it('rejects request identity and within-report provenance drift', () => {
    const input = report(); input.results[0].requestProvenance.modelId = 'another-model';
    expect(() => buildEvaluationFeedback([input], corpora)).toThrow('FEEDBACK_PROVENANCE_MISMATCH');
    const drift = report(); drift.results[0].requestProvenance.instructionSha256 = 'f'.repeat(64);
    expect(() => buildEvaluationFeedback([drift], corpora)).toThrow('FEEDBACK_PROVENANCE_DRIFT');
  });
  it('keeps independent prompt versions separate rather than merging their failures', () => {
    const first = failedReport('invalid_model_json'); const second = failedReport('invalid_model_json');
    for (const result of second.results) result.requestProvenance.instructionSha256 = 'f'.repeat(64);
    expect(buildEvaluationFeedback([first, second], corpora).issues).toHaveLength(4);
  });
  it('rejects claimed pass and metric totals inconsistent with frozen expectations', () => {
    const input = report(); input.results[0].metrics.protectedStateLosses = 1;
    expect(() => buildEvaluationFeedback([input], corpora)).toThrow('FEEDBACK_QUALITY_VERDICT_MISMATCH');
    const counts = report(); counts.results[0].metrics.factChecksTotal++;
    expect(() => buildEvaluationFeedback([counts], corpora)).toThrow('FEEDBACK_INVALID_METRIC_COUNTS');
  });
  it('rejects dry-run evidence and missing terminal provenance', () => {
    expect(() => buildEvaluationFeedback([{ ...report(), mode: 'dry-run-no-model-calls' }], corpora)).toThrow('FEEDBACK_INVALID_REPORT');
    const input = report();
    expect(() => buildEvaluationFeedback([{ ...input, results: input.results.map(({ requestProvenance: _provenance, ...result }) => result) }], corpora)).toThrow('FEEDBACK_PROVENANCE_MISMATCH');
  });
  it('executes the offline CLI and creates a reviewable plan without overwriting existing files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ieojim-feedback-'));
    const run = () => new Promise<{ code: string | number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../scripts/eval-feedback.ts', import.meta.url)), '--report', 'report.json', '--plan-out', 'plan.json'], {
        cwd: directory, timeout: 10_000,
        env: {
          BETTER_AUTH_URL: '', BETTER_AUTH_SECRET: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
          APP_ENV: 'development', MODEL: 'gemini-3.8-flash', GEMINI_API_KEY: '',
          DAILY_BUDGET_MICRO_USD: '500000', TOTAL_BUDGET_MICRO_USD: '15000000', OWNER_DAILY_RUNS: '10',
        },
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    });
    try {
      await writeFile(join(directory, 'report.json'), JSON.stringify(failedReport('invalid_model_json')));
      const first = await run();
      expect(first, first.stderr).toMatchObject({ code: 0 });
      const saved = await readFile(join(directory, 'plan.json'), 'utf8');
      expect(JSON.parse(saved)).toMatchObject({ version: 1, maxAttemptsPerTask: 3 });
      expect(JSON.parse(first.stdout).issues).toHaveLength(2);
      const second = await run();
      expect(second.code).toBe(1);
      expect(second.stderr).toContain('FEEDBACK_INPUT_OR_OUTPUT_ERROR');
      expect(await readFile(join(directory, 'plan.json'), 'utf8')).toBe(saved);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
