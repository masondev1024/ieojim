import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { LIMITS } from '../../src/core/contracts';
import { evaluateQuality } from '../../src/evaluation/eval-quality';

const validLiveDraftV2 = { schemaVersion: 2, summary: 'synthetic', questions: [], facts: [], blocks: [], removedItems: [] };

async function setupOfflineCli(body: unknown, status: number) {
  // Separate cwd and explicit env prevent loading real developer credentials.
  const directory = await mkdtemp(join(tmpdir(), 'ieojim-eval-test-'));
  const heldoutLoader = join(directory, 'heldout-loader.mjs');
  await writeFile(heldoutLoader, `
    const virtualUrl = 'virtual:ieojim-heldout-cases';
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === '../src/evaluation/heldout-cases' || specifier === '../src/evaluation/heldout-cases.ts') return { url: virtualUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (url !== virtualUrl) return nextLoad(url, context);
      return {
        format: 'module',
        shortCircuit: true,
        source: \`
          export function getHeldoutCases() {
            return [{
              id: 'heldout-travel-numeric-ambiguity',
              purpose: 'synthetic heldout fixture',
              snapshot: { facts: [], blocks: [] },
              sources: [],
              expectation: { facts: {}, affectedFactKeys: [], conflictExpected: false, expectedOutcome: 'needs_input' },
            }];
          }
        \`,
      };
    }
  `);
  const preload = join(directory, 'mock-fetch.mjs');
  await writeFile(preload, `
    import { register } from 'node:module';
    import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
    register(new URL('./heldout-loader.mjs', import.meta.url));
    let calls = 0;
    globalThis.fetch = async () => {
      const nextCall = calls + 1;
      const files = existsSync('artifacts') ? readdirSync('artifacts').filter((name) => name.startsWith('eval-')) : [];
      const report = files.length === 1 ? JSON.parse(readFileSync('artifacts/' + files[0], 'utf8')) : null;
      writeFileSync('pre-fetch-report-' + nextCall + '.json', JSON.stringify(report));
      calls += 1;
      return Response.json(${JSON.stringify(body)}, { status: ${status} });
    };
    process.on('exit', () => writeFileSync('http-calls.json', JSON.stringify({ calls })));
  `);
  const run = (extraArgs: string[] = []) => new Promise<{ exitCode: string | number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [
      '--import', import.meta.resolve('tsx'), '--import', preload,
      fileURLToPath(new URL('../../scripts/eval-live.ts', import.meta.url)), '--max-usd', '0.20', ...extraArgs,
    ], {
      cwd: directory,
      env: {
        GEMINI_API_KEY: 'sk-synthetic-offline-test-only',
        BETTER_AUTH_URL: '', BETTER_AUTH_SECRET: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
        APP_ENV: 'development', MODEL: 'gemini-3.8-flash',
        DAILY_BUDGET_MICRO_USD: '500000', TOTAL_BUDGET_MICRO_USD: '15000000', OWNER_DAILY_RUNS: '10',
      },
      timeout: 10_000,
    }, (error, stdout, stderr) => resolve({ exitCode: error?.code ?? 0, stdout, stderr }));
  });
  return { directory, run, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

it.each([
  { status: 401, expectedCode: 'model_authentication' },
  { status: 429, expectedCode: 'model_quota_or_rate_limited' },
])('stops the real CLI after one mocked $status response', async ({ status, expectedCode }) => {
  const harness = await setupOfflineCli({ error: { message: 'synthetic-private-provider-message' } }, status);
  try {
    const result = await harness.run();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(await readFile(join(harness.directory, 'http-calls.json'), 'utf8'))).toEqual({ calls: 1 });
    const files = await readdir(join(harness.directory, 'artifacts'));
    expect(files).toHaveLength(1);
    const reportText = await readFile(join(harness.directory, 'artifacts', files[0]), 'utf8');
    const report = JSON.parse(reportText);
    expect(report).toMatchObject({ plannedCalls: 8, attemptedCalls: 1, stoppedReason: `stopped_after_${expectedCode}`, chargedOrReservedMicroUsd: LIMITS.reserveMicroUsd, results: [{ status: 'failed', attemptedCall: 1, httpStatus: status, errorCode: expectedCode, stopEvaluation: true }] });
    expect(report.results).toHaveLength(1);
    const emitted = reportText + result.stdout + result.stderr;
    expect(emitted).not.toContain('synthetic-private-provider-message');
    expect(emitted).not.toContain('sk-synthetic-offline-test-only');
  } finally { await harness.cleanup(); }
}, 15_000);

it.each([false, true])('persists an over-reserve block across CLI runs (invalid output: %s)', async (invalidOutput) => {
  const harness = await setupOfflineCli({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: invalidOutput ? 'synthetic-private-invalid-output' : JSON.stringify(validLiveDraftV2) }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7000, thoughtsTokenCount: 1, totalTokenCount: 7013 },
  }, 200);
  try {
    expect((await harness.run()).exitCode).toBe(1);
    const directory = join(harness.directory, 'artifacts');
    const block = JSON.parse(await readFile(join(directory, 'model-budget-block.json'), 'utf8'));
    expect(block).toMatchObject({ costMicroUsd: 26263, reservedMicroUsd: LIMITS.reserveMicroUsd, reason: 'stopped_after_model_budget_policy_violation' });
    const files = (await readdir(directory)).filter((name) => name.startsWith('eval-'));
    expect(files).toHaveLength(1);
    const reportText = await readFile(join(directory, files[0]), 'utf8');
    const report = JSON.parse(reportText);
    expect(report).toMatchObject({ attemptedCalls: 1, chargedOrReservedMicroUsd: 26263, stoppedReason: 'stopped_after_model_budget_policy_violation' });
    expect(reportText).not.toContain('synthetic-private-invalid-output');
    const replay = await harness.run();
    expect(replay.exitCode).toBe(1);
    expect(replay.stderr).toContain('No call was made');
    expect(JSON.parse(await readFile(join(harness.directory, 'http-calls.json'), 'utf8'))).toEqual({ calls: 0 });
  } finally { await harness.cleanup(); }
}, 15_000);

it('exits nonzero when a schema-valid model response evaluates incorrectly', async () => {
  const harness = await setupOfflineCli({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(validLiveDraftV2) }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, thoughtsTokenCount: 0, totalTokenCount: 14 },
  }, 200);
  try {
    const result = await harness.run(['--case', 'travel-participants-arrival', '--strategy', 'incremental']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(await readFile(join(harness.directory, 'http-calls.json'), 'utf8'))).toEqual({ calls: 1 });
    const files = (await readdir(join(harness.directory, 'artifacts'))).filter((name) => name.startsWith('eval-'));
    expect(files).toHaveLength(1);
    const report = JSON.parse(await readFile(join(harness.directory, 'artifacts', files[0]), 'utf8'));
    expect(report).toMatchObject({
      plannedCalls: 1,
      attemptedCalls: 1,
      stoppedReason: null,
      results: [{ status: 'evaluated', qualityStatus: 'failed', expectedOutcome: 'completed', metrics: { outcome: 'incorrect' } }],
    });
    expect(result.stdout).toContain('travel-participants-arrival / incremental: evaluated / failed');
  } finally { await harness.cleanup(); }
}, 15_000);

it('accepts clarification only when the evaluation case explicitly expects it', () => {
  const metrics = {
    outcome: 'needs_input' as const,
    factChecksPassed: 0,
    factChecksTotal: 1,
    itemChecksPassed: 0,
    itemChecksTotal: 0,
    protectedStateLosses: 0,
    unexpectedItemChanges: 0,
    conflicts: 0,
    questions: 1,
    snapshotChanged: false,
  };
  const expectation = { facts: { participants: 3 }, affectedFactKeys: ['participants'], conflictExpected: false };
  expect(evaluateQuality(metrics, expectation)).toEqual({ expectedOutcome: 'completed', qualityStatus: 'failed' });
  expect(evaluateQuality(metrics, { ...expectation, expectedOutcome: 'needs_input' })).toEqual({ expectedOutcome: 'needs_input', qualityStatus: 'failed' });
  expect(evaluateQuality(
    { ...metrics, factChecksPassed: 1 },
    { ...expectation, expectedOutcome: 'needs_input' },
  )).toEqual({ expectedOutcome: 'needs_input', qualityStatus: 'passed' });
});

it('never treats incorrect or unsafe metrics as a passing quality verdict', () => {
  const baseMetrics = {
    outcome: 'needs_input' as const,
    factChecksPassed: 0,
    factChecksTotal: 1,
    itemChecksPassed: 0,
    itemChecksTotal: 0,
    protectedStateLosses: 0,
    unexpectedItemChanges: 0,
    conflicts: 0,
    questions: 1,
    snapshotChanged: false,
  };
  const expectation = { facts: {}, affectedFactKeys: [], conflictExpected: false };
  expect(evaluateQuality({ ...baseMetrics, outcome: 'incorrect' }, expectation)).toEqual({ expectedOutcome: 'completed', qualityStatus: 'failed' });
  expect(evaluateQuality(
    { ...baseMetrics, outcome: 'incorrect' },
    // @ts-expect-error incorrect must never be declared as the expected passing outcome.
    { ...expectation, expectedOutcome: 'incorrect' },
  )).toEqual({ expectedOutcome: 'completed', qualityStatus: 'failed' });
  expect(evaluateQuality({ ...baseMetrics, protectedStateLosses: 1 }, { ...expectation, expectedOutcome: 'needs_input' })).toEqual({ expectedOutcome: 'needs_input', qualityStatus: 'failed' });
  expect(evaluateQuality({ ...baseMetrics, unexpectedItemChanges: 1 }, { ...expectation, expectedOutcome: 'needs_input' })).toEqual({ expectedOutcome: 'needs_input', qualityStatus: 'failed' });
});

it('requires an unchanged stop state for explicitly ambiguous needs-input cases', () => {
  const metrics = {
    outcome: 'needs_input' as const,
    factChecksPassed: 0,
    factChecksTotal: 0,
    itemChecksPassed: 0,
    itemChecksTotal: 0,
    protectedStateLosses: 0,
    unexpectedItemChanges: 0,
    conflicts: 0,
    questions: 1,
    snapshotChanged: true,
  };
  expect(evaluateQuality(metrics, {
    facts: {},
    affectedFactKeys: ['participants'],
    conflictExpected: false,
    expectedOutcome: 'needs_input',
    requireUnchangedSnapshot: true,
  })).toEqual({ expectedOutcome: 'needs_input', qualityStatus: 'failed' });
  expect(evaluateQuality({ ...metrics, snapshotChanged: false }, {
    facts: {},
    affectedFactKeys: ['participants'],
    conflictExpected: false,
    expectedOutcome: 'needs_input',
    requireUnchangedSnapshot: true,
  })).toEqual({ expectedOutcome: 'needs_input', qualityStatus: 'passed' });
});

it('fails needs-input quality when unexpected conflicts are present', () => {
  const metrics = {
    outcome: 'needs_input' as const,
    factChecksPassed: 0,
    factChecksTotal: 0,
    itemChecksPassed: 0,
    itemChecksTotal: 0,
    protectedStateLosses: 0,
    unexpectedItemChanges: 0,
    conflicts: 1,
    questions: 1,
    snapshotChanged: false,
  };
  expect(evaluateQuality(metrics, {
    facts: {},
    affectedFactKeys: [],
    conflictExpected: false,
    expectedOutcome: 'needs_input',
  })).toEqual({ expectedOutcome: 'needs_input', qualityStatus: 'failed' });
  expect(evaluateQuality(metrics, {
    facts: {},
    affectedFactKeys: [],
    conflictExpected: true,
    expectedOutcome: 'needs_input',
  })).toEqual({ expectedOutcome: 'needs_input', qualityStatus: 'passed' });
});

it('selects one scenario and strategy without any HTTP during dry-run', async () => {
  const harness = await setupOfflineCli({}, 500);
  try {
    const result = await harness.run(['--dry-run', '--case', 'travel-locked-dinner', '--strategy', 'incremental']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ cases: ['travel-locked-dinner'], strategies: ['incremental'], plannedCalls: 1, budgetType: 'reservation-admission-limit' });
    expect(JSON.parse(result.stdout)).toMatchObject({ suite: 'smoke', corpusHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.parse(await readFile(join(harness.directory, 'http-calls.json'), 'utf8'))).toEqual({ calls: 0 });
  } finally { await harness.cleanup(); }
}, 15_000);

it('accounts for paired context comparisons during dry-run', async () => {
  const harness = await setupOfflineCli({}, 500);
  try {
    const result = await harness.run(['--dry-run', '--case', 'travel-locked-dinner', '--strategy', 'incremental', '--context', 'compare']);
    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({
      cases: ['travel-locked-dinner'],
      strategies: ['incremental'],
      contexts: ['full', 'compact'],
      contextMode: 'compare',
      plannedCalls: 2,
      calls: 2,
      budgetType: 'reservation-admission-limit',
    });
    expect(plan.contextPlans).toHaveLength(2);
    expect(plan.contextPlans.map((context: { requestedContext: string }) => context.requestedContext)).toEqual(['full', 'compact']);
    expect(JSON.parse(await readFile(join(harness.directory, 'http-calls.json'), 'utf8'))).toEqual({ calls: 0 });
  } finally { await harness.cleanup(); }
}, 15_000);

it('records context bytes and safe request provenance for paired mocked calls', async () => {
  const harness = await setupOfflineCli({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(validLiveDraftV2) }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, thoughtsTokenCount: 0, totalTokenCount: 14 },
  }, 200);
  try {
    const result = await harness.run(['--case', 'travel-participants-arrival', '--strategy', 'incremental', '--context', 'compare']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(await readFile(join(harness.directory, 'http-calls.json'), 'utf8'))).toEqual({ calls: 2 });
    const files = (await readdir(join(harness.directory, 'artifacts'))).filter((name) => name.startsWith('eval-'));
    expect(files).toHaveLength(1);
    const reportText = await readFile(join(harness.directory, 'artifacts', files[0]), 'utf8');
    const report = JSON.parse(reportText);
    expect(report).toMatchObject({
      plannedCalls: 2,
      attemptedCalls: 2,
      stoppedReason: null,
      summary: { statusCounts: { evaluated: 2 }, qualityCounts: { failed: 2 } },
    });
    expect(report.contextPairSummary).toEqual([expect.objectContaining({
      case: 'travel-participants-arrival',
      strategy: 'incremental',
      pairStatus: 'complete',
      fullStatus: 'evaluated',
      compactStatus: 'evaluated',
      bothCompleted: true,
      bothQualityPassed: false,
      compactEffectiveContext: expect.stringMatching(/^(compact|full)$/),
      compactUsedFallback: expect.any(Boolean),
      fullBytes: expect.any(Number),
      compactBytes: expect.any(Number),
      selectedByteDelta: expect.any(Number),
      savedBytes: expect.any(Number),
      inputTokenDelta: 0,
      outputTokenDelta: 0,
      costMicroUsdDelta: 0,
      latencyMsDelta: expect.any(Number),
    })]);
    expect(report.results).toHaveLength(2);
    expect(report.results.map((item: { requestedContext: string }) => item.requestedContext)).toEqual(['full', 'compact']);
    for (const item of report.results) {
      expect(item).toMatchObject({
        status: 'evaluated',
        qualityStatus: 'failed',
        fullBytes: expect.any(Number),
        selectedBytes: expect.any(Number),
        requestProvenance: { requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
    }
    expect(reportText).not.toContain('sk-synthetic-offline-test-only');
    expect(result.stdout).toContain('travel-participants-arrival / incremental / full->full: evaluated / failed');
    expect(result.stdout).toContain('travel-participants-arrival / incremental / compact->');
  } finally { await harness.cleanup(); }
}, 15_000);

it('persists safe request provenance before the mocked fetch starts', async () => {
  const harness = await setupOfflineCli({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(validLiveDraftV2) }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, thoughtsTokenCount: 0, totalTokenCount: 14 },
  }, 200);
  try {
    const result = await harness.run(['--case', 'travel-participants-arrival', '--strategy', 'incremental', '--context', 'compact']);
    expect(result.exitCode).toBe(1);
    const preFetchReport = JSON.parse(await readFile(join(harness.directory, 'pre-fetch-report-1.json'), 'utf8'));
    expect(preFetchReport).toMatchObject({
      attemptedCalls: 1,
      results: [{
        status: 'reserved',
        requestedContext: 'compact',
        requestProvenance: {
          requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          contextRequestedMode: 'compact',
          contextEffectiveMode: expect.stringMatching(/^(compact|full)$/),
          contextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }],
    });
    const preFetchText = JSON.stringify(preFetchReport);
    expect(preFetchText).not.toContain('sk-synthetic-offline-test-only');
  } finally { await harness.cleanup(); }
}, 15_000);

it('selects the heldout suite in dry-run without HTTP', async () => {
  const harness = await setupOfflineCli({}, 500);
  try {
    const result = await harness.run(['--dry-run', '--suite', 'heldout', '--case', 'heldout-travel-numeric-ambiguity', '--strategy', 'incremental']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ suite: 'heldout', cases: ['heldout-travel-numeric-ambiguity'], strategies: ['incremental'], plannedCalls: 1 });
    expect(JSON.parse(await readFile(join(harness.directory, 'http-calls.json'), 'utf8'))).toEqual({ calls: 0 });
  } finally { await harness.cleanup(); }
}, 15_000);

it('plans the frozen acceptance corpus without calling the model', async () => {
  const harness = await setupOfflineCli({}, 500);
  try {
    const result = await harness.run(['--dry-run', '--suite', 'acceptance', '--strategy', 'incremental', '--max-usd', '0.30']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ suite: 'acceptance', corpusHash: 'af23574ed7580c1758c3853a5abe3a2d3581f79931540feb8ebbeaa9c6855e88', plannedCalls: 12, maximumReservedUsd: 0.29232 });
    expect(JSON.parse(await readFile(join(harness.directory, 'http-calls.json'), 'utf8'))).toEqual({ calls: 0 });
  } finally { await harness.cleanup(); }
}, 15_000);

it('rejects an unknown suite before any HTTP', async () => {
  const harness = await setupOfflineCli({}, 500);
  try {
    const result = await harness.run(['--dry-run', '--suite', 'unknown']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--suite must be smoke, heldout, acceptance, loop-challenge, or initial-creation');
    expect(JSON.parse(await readFile(join(harness.directory, 'http-calls.json'), 'utf8'))).toEqual({ calls: 0 });
  } finally { await harness.cleanup(); }
}, 15_000);
