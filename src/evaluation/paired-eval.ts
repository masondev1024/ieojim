import { createHash } from 'node:crypto';
import { LIMITS } from '../core/contracts';
import type { EvaluationCase } from './case';
import type { EvaluationMetrics } from './metrics';

export type EvaluationStrategy = 'incremental' | 'regenerate';

export type FinalsPairedBatchPlan = {
  id: string;
  suite: 'acceptance';
  strategy: EvaluationStrategy;
  context: 'full';
  cases: string[];
  plannedCalls: number;
  maximumReservedUsd: number;
  maxUsd: 0.5;
  fitsBatchLimit: boolean;
  command: string;
};

export type FinalsPairedPlan = {
  planKind: 'finals-paired-acceptance-v1';
  mode: 'dry-run-no-model-calls';
  suite: 'acceptance';
  corpusHash: string;
  corpusCaseCount: number;
  cases: string[];
  model: string;
  contractVersion: 2;
  context: 'full';
  strategies: EvaluationStrategy[];
  reserveMicroUsdPerCall: number;
  plannedCalls: number;
  maximumReservedUsd: number;
  batchLimitUsd: 0.5;
  batches: FinalsPairedBatchPlan[];
  aggregationCommand: string;
  limitations: string[];
};

export type LiveEvalReport = {
  suite?: unknown;
  corpusHash?: unknown;
  model?: unknown;
  contexts?: unknown;
  contextMode?: unknown;
  strategies?: unknown;
  cases?: unknown;
  maximumReservedUsd?: unknown;
  plannedCalls?: unknown;
  attemptedCalls?: unknown;
  chargedOrReservedMicroUsd?: unknown;
  stoppedReason?: unknown;
  results?: unknown;
};

export type PairedCaseReport = {
  case: string;
  pairStatus: 'complete' | 'missing_pair' | 'duplicate_pair';
  incremental: PairedResultSummary | null;
  regenerate: PairedResultSummary | null;
  bothEvaluated: boolean | null;
  bothQualityPassed: boolean | null;
  winner: 'incremental' | 'regenerate' | 'tie' | 'neither_passed' | 'incomplete';
  comparison: {
    costMicroUsdDeltaRegenerateMinusIncremental: number | null;
    latencyMsDeltaRegenerateMinusIncremental: number | null;
    outputTokenDeltaRegenerateMinusIncremental: number | null;
  };
};

export type PairedResultSummary = {
  status: string | null;
  qualityStatus: string | null;
  expectedOutcome: string | null;
  outcome: string | null;
  factChecksPassed: number | null;
  factChecksTotal: number | null;
  itemChecksPassed: number | null;
  itemChecksTotal: number | null;
  protectedStateLosses: number | null;
  unexpectedItemChanges: number | null;
  questions: number | null;
  conflicts: number | null;
  latencyMs: number | null;
  costMicroUsd: number | null;
  outputTokens: number | null;
  inputTokens: number | null;
  errorCode: string | null;
};

export type PairedAggregateReport = {
  reportKind: 'finals-paired-acceptance-aggregate-v1';
  suite: 'acceptance';
  corpusHash: string | null;
  model: string | null;
  context: 'full';
  strategies: EvaluationStrategy[];
  caseCount: number;
  plannedCalls: number;
  attemptedCalls: number;
  maximumReservedUsd: number;
  chargedOrReservedMicroUsd: number;
  missingPairs: string[];
  duplicatePairs: string[];
  mismatches: string[];
  comparable: boolean;
  summary: {
    completePairs: number;
    passedPairs: number;
    failedOrErroredPairs: number;
    totalProtectedStateLosses: number | null;
    totalUnexpectedItemChanges: number | null;
    totalQuestions: number | null;
    totalConflicts: number | null;
    metricObservations: Record<'protectedStateLosses' | 'unexpectedItemChanges' | 'questions' | 'conflicts', number>;
    totalCostMicroUsd: number | null;
    costObservations: number;
    evaluatedResults: number;
    failedResults: number;
  };
  provenance: {
    modelIds: string[];
    contractVersions: number[];
    instructionSha256: string[];
    localSchemaSha256: string[];
    generationConfigSha256: string[];
    modelPolicySha256: string[];
  };
  cases: PairedCaseReport[];
  limitations: string[];
};

type ResultRecord = Record<string, unknown>;

export function acceptanceCorpusHash(cases: EvaluationCase[]): string {
  return createHash('sha256')
    .update(JSON.stringify(cases.map((test) => ({
      id: test.id,
      purpose: test.purpose,
      snapshot: test.snapshot,
      sources: test.sources.map((source) => ({
        id: source.id,
        hash: source.hash,
        relation: source.relation,
        targetSourceId: source.targetSourceId,
        answerTo: source.answerTo,
      })),
      expectation: test.expectation,
      ...(test.initialExpectation ? { initialExpectation: test.initialExpectation } : {}),
    }))))
    .digest('hex');
}

export function createFinalsPairedPlan(cases: EvaluationCase[], model: string): FinalsPairedPlan {
  assertUniqueCases(cases);
  const caseIds = cases.map((test) => test.id);
  const strategies: EvaluationStrategy[] = ['incremental', 'regenerate'];
  const batchLimitUsd = 0.5 as const;
  const batches = strategies.map((strategy): FinalsPairedBatchPlan => {
    const plannedCalls = cases.length;
    const maximumReservedUsd = plannedCalls * LIMITS.reserveMicroUsd / 1_000_000;
    return {
      id: `acceptance-full-${strategy}`,
      suite: 'acceptance',
      strategy,
      context: 'full',
      cases: caseIds,
      plannedCalls,
      maximumReservedUsd,
      maxUsd: batchLimitUsd,
      fitsBatchLimit: maximumReservedUsd <= batchLimitUsd,
      command: `npm run eval:live -- --suite acceptance --strategy ${strategy} --context full --max-usd 0.50`,
    };
  });
  const plannedCalls = batches.reduce((sum, batch) => sum + batch.plannedCalls, 0);
  return {
    planKind: 'finals-paired-acceptance-v1',
    mode: 'dry-run-no-model-calls',
    suite: 'acceptance',
    corpusHash: acceptanceCorpusHash(cases),
    corpusCaseCount: cases.length,
    cases: caseIds,
    model,
    contractVersion: 2,
    context: 'full',
    strategies,
    reserveMicroUsdPerCall: LIMITS.reserveMicroUsd,
    plannedCalls,
    maximumReservedUsd: plannedCalls * LIMITS.reserveMicroUsd / 1_000_000,
    batchLimitUsd,
    batches,
    aggregationCommand: 'npm run eval:live -- --aggregate artifacts/eval-incremental.json --aggregate artifacts/eval-regenerate.json',
    limitations: [
      'This is a deterministic dry-run plan; it makes no model calls and does not prove quality.',
      'Both strategies are evaluated through the same deterministic buildChangeSet engine, so the comparison isolates proposal strategy behavior rather than engine causal impact or ChatGPT/Notion superiority.',
      'Reservation totals are admission limits, not provider invoices. Actual cost, latency and token fields are reported only when present in live artifacts.',
    ],
  };
}

export function aggregatePairedReports(reports: LiveEvalReport[], expectedCases: EvaluationCase[]): PairedAggregateReport {
  assertUniqueCases(expectedCases);
  const expectedCaseIds = expectedCases.map((test) => test.id);
  const expectedCaseSet = new Set(expectedCaseIds);
  const expectedCorpusHash = acceptanceCorpusHash(expectedCases);
  const mismatches: string[] = [];
  const allResults: ResultRecord[] = [];
  let model: string | null = null;
  let corpusHash: string | null = null;
  let plannedCalls = 0;
  let attemptedCalls = 0;
  let maximumReservedUsd = 0;
  let chargedOrReservedMicroUsd = 0;

  reports.forEach((report, index) => {
    const label = `report[${index}]`;
    if (report.suite !== 'acceptance') mismatches.push(`${label}: suite is not acceptance`);
    if (report.corpusHash !== expectedCorpusHash) mismatches.push(`${label}: corpusHash does not match frozen acceptance corpus`);
    if (!hasOnlyFullContext(report)) mismatches.push(`${label}: context is not full-only`);
    const reportStrategies = parseStrategies(report.strategies);
    if (reportStrategies.length !== 1) mismatches.push(`${label}: report must contain exactly one strategy`);
    if (typeof report.model === 'string') {
      if (model === null) model = report.model;
      else if (model !== report.model) mismatches.push(`${label}: model differs from previous reports`);
    } else {
      mismatches.push(`${label}: model is missing`);
    }
    if (typeof report.corpusHash === 'string') corpusHash = report.corpusHash;
    if (Array.isArray(report.cases)) {
      const reportCases = report.cases.filter((value): value is string => typeof value === 'string');
      const unknownCases = reportCases.filter((id) => !expectedCaseSet.has(id));
      const missingCases = expectedCaseIds.filter((id) => !reportCases.includes(id));
      if (unknownCases.length) mismatches.push(`${label}: unknown case ids ${unknownCases.join(', ')}`);
      if (missingCases.length) mismatches.push(`${label}: missing case ids ${missingCases.join(', ')}`);
    } else {
      mismatches.push(`${label}: cases are missing`);
    }
    plannedCalls += finiteNumber(report.plannedCalls) ?? 0;
    attemptedCalls += finiteNumber(report.attemptedCalls) ?? 0;
    maximumReservedUsd += finiteNumber(report.maximumReservedUsd) ?? 0;
    chargedOrReservedMicroUsd += finiteNumber(report.chargedOrReservedMicroUsd) ?? 0;
    if (Array.isArray(report.results)) {
      const results = report.results.filter(isRecord);
      if (results.length !== report.results.length) mismatches.push(`${label}: invalid result record`);
      if (results.some((result) => !reportStrategies.includes(result.strategy as EvaluationStrategy))) mismatches.push(`${label}: result strategy differs from report`);
      allResults.push(...results);
    } else {
      mismatches.push(`${label}: results are missing`);
    }
  });

  validateProvenance(allResults, model, mismatches);

  const byPair = new Map<string, ResultRecord[]>();
  for (const result of allResults) {
    const caseId = stringValue(result.case);
    const strategy = stringValue(result.strategy);
    const requestedContext = stringValue(result.requestedContext);
    if (!caseId || !strategy) {
      mismatches.push('result: missing case or strategy');
      continue;
    }
    if (!expectedCaseSet.has(caseId)) mismatches.push(`result: unknown case ${caseId}`);
    if (strategy !== 'incremental' && strategy !== 'regenerate') mismatches.push(`result: unsupported strategy ${strategy}`);
    if (requestedContext !== null && requestedContext !== 'full') mismatches.push(`result: ${caseId}/${strategy} is not full context`);
    const key = `${caseId}:${strategy}`;
    byPair.set(key, [...(byPair.get(key) ?? []), result]);
  }

  const duplicatePairs = [...byPair.entries()].filter(([, values]) => values.length > 1).map(([key]) => key.replace(':', '/'));
  const missingPairs: string[] = [];
  const caseReports = expectedCaseIds.map((caseId): PairedCaseReport => {
    const incrementalValues = byPair.get(`${caseId}:incremental`) ?? [];
    const regenerateValues = byPair.get(`${caseId}:regenerate`) ?? [];
    if (!incrementalValues.length) missingPairs.push(`${caseId}/incremental`);
    if (!regenerateValues.length) missingPairs.push(`${caseId}/regenerate`);
    const incremental = incrementalValues.length === 1 ? summarizeResult(incrementalValues[0]) : null;
    const regenerate = regenerateValues.length === 1 ? summarizeResult(regenerateValues[0]) : null;
    const duplicate = incrementalValues.length > 1 || regenerateValues.length > 1;
    const complete = incremental !== null && regenerate !== null && terminal(incremental) && terminal(regenerate);
    const bothEvaluated = incremental !== null && regenerate !== null ? incremental.status === 'evaluated' && regenerate.status === 'evaluated' : null;
    const bothQualityPassed = incremental !== null && regenerate !== null ? incremental.qualityStatus === 'passed' && regenerate.qualityStatus === 'passed' : null;
    const winner = incremental !== null && regenerate !== null ? chooseWinner(incremental, regenerate) : 'incomplete';
    return {
      case: caseId,
      pairStatus: duplicate ? 'duplicate_pair' : complete ? 'complete' : 'missing_pair',
      incremental,
      regenerate,
      bothEvaluated,
      bothQualityPassed,
      winner,
      comparison: {
        costMicroUsdDeltaRegenerateMinusIncremental: delta(regenerate?.costMicroUsd, incremental?.costMicroUsd),
        latencyMsDeltaRegenerateMinusIncremental: delta(regenerate?.latencyMs, incremental?.latencyMs),
        outputTokenDeltaRegenerateMinusIncremental: delta(regenerate?.outputTokens, incremental?.outputTokens),
      },
    };
  });

  return {
    reportKind: 'finals-paired-acceptance-aggregate-v1',
    suite: 'acceptance',
    corpusHash,
    model,
    context: 'full',
    strategies: ['incremental', 'regenerate'],
    caseCount: expectedCaseIds.length,
    plannedCalls,
    attemptedCalls,
    maximumReservedUsd,
    chargedOrReservedMicroUsd,
    missingPairs,
    duplicatePairs,
    mismatches,
    comparable: mismatches.length === 0 && missingPairs.length === 0 && duplicatePairs.length === 0 && caseReports.every((entry) => entry.pairStatus === 'complete'),
    summary: summarizeCases(caseReports),
    provenance: summarizeProvenance(allResults),
    cases: caseReports,
    limitations: [
      'Both proposal strategies use the same deterministic engine after model output; this aggregate must not be cited as engine causal impact or competitor superiority.',
      'Only fields present in input artifacts are aggregated. Missing token, latency or cost values remain null instead of being estimated.',
      'Artifacts must remain preserved separately; this aggregate is a metadata and metric summary, not a replacement for failed outputs.',
    ],
  };
}

function summarizeProvenance(results: ResultRecord[]): PairedAggregateReport['provenance'] {
  const provenances = results.map((result) => result.requestProvenance).filter(isRecord);
  return {
    modelIds: uniqueStrings(provenances.map((provenance) => provenance.modelId)),
    contractVersions: uniqueNumbers(provenances.map((provenance) => provenance.contractVersion)),
    instructionSha256: uniqueStrings(provenances.map((provenance) => provenance.instructionSha256)),
    localSchemaSha256: uniqueStrings(provenances.map((provenance) => provenance.localSchemaSha256)),
    generationConfigSha256: uniqueStrings(provenances.map((provenance) => provenance.generationConfigSha256)),
    modelPolicySha256: uniqueStrings(provenances.map((provenance) => provenance.modelPolicySha256)),
  };
}

function validateProvenance(results: ResultRecord[], model: string | null, mismatches: string[]): void {
  const sharedHashes = ['localSchemaSha256', 'generationConfigSha256', 'modelPolicySha256'] as const;
  const hashes = new Map<string, Set<string>>();
  const contextByCase = new Map<string, Set<string>>();
  for (const result of results) {
    const label = `${String(result.case)}/${String(result.strategy)}`;
    const provenance = result.requestProvenance;
    if (!isRecord(provenance)) {
      mismatches.push(`${label}: request provenance missing`);
      continue;
    }
    if (provenance.modelId !== model || provenance.contractVersion !== 2 || provenance.strategy !== result.strategy) mismatches.push(`${label}: request identity mismatch`);
    if (provenance.contextRequestedMode !== 'full' || provenance.contextEffectiveMode !== 'full' || result.effectiveContext !== 'full') mismatches.push(`${label}: effective context is not full`);
    for (const field of [...sharedHashes, 'instructionSha256', 'contextSha256'] as const) {
      const value = provenance[field];
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        mismatches.push(`${label}: ${field} missing or invalid`);
        continue;
      }
      // Instructions intentionally vary by strategy; the context should not.
      const key = field === 'instructionSha256' ? `${field}:${String(result.strategy)}` : field;
      if (field === 'contextSha256') {
        const values = contextByCase.get(String(result.case)) ?? new Set<string>();
        values.add(value);
        contextByCase.set(String(result.case), values);
      } else {
        const values = hashes.get(key) ?? new Set<string>();
        values.add(value);
        hashes.set(key, values);
      }
    }
  }
  for (const [field, values] of hashes) if (values.size > 1) mismatches.push(`provenance drift: ${field}`);
  for (const [caseId, values] of contextByCase) if (values.size > 1) mismatches.push(`context drift: ${caseId}`);
}

function terminal(result: PairedResultSummary): boolean {
  return result.status === 'evaluated' || result.status === 'failed';
}

function assertUniqueCases(cases: EvaluationCase[]): void {
  const ids = cases.map((test) => test.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) throw new Error(`Duplicate evaluation case ids: ${[...new Set(duplicates)].join(', ')}`);
}

function hasOnlyFullContext(report: LiveEvalReport): boolean {
  const contexts = Array.isArray(report.contexts) ? report.contexts : [];
  return report.contextMode === 'full' && contexts.length === 1 && contexts[0] === 'full';
}

function parseStrategies(raw: unknown): EvaluationStrategy[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is EvaluationStrategy => value === 'incremental' || value === 'regenerate');
}

function summarizeResult(result: ResultRecord): PairedResultSummary {
  const metrics = isRecord(result.metrics) ? result.metrics as Partial<EvaluationMetrics> : {};
  return {
    status: stringValue(result.status),
    qualityStatus: stringValue(result.qualityStatus),
    expectedOutcome: stringValue(result.expectedOutcome),
    outcome: stringValue(metrics.outcome),
    factChecksPassed: finiteNumber(metrics.factChecksPassed),
    factChecksTotal: finiteNumber(metrics.factChecksTotal),
    itemChecksPassed: finiteNumber(metrics.itemChecksPassed),
    itemChecksTotal: finiteNumber(metrics.itemChecksTotal),
    protectedStateLosses: finiteNumber(metrics.protectedStateLosses),
    unexpectedItemChanges: finiteNumber(metrics.unexpectedItemChanges),
    questions: finiteNumber(metrics.questions),
    conflicts: finiteNumber(metrics.conflicts),
    latencyMs: finiteNumber(result.latencyMs),
    costMicroUsd: finiteNumber(result.costMicroUsd),
    outputTokens: finiteNumber(result.outputTokens),
    inputTokens: finiteNumber(result.inputTokens),
    errorCode: stringValue(result.errorCode),
  };
}

function summarizeCases(cases: PairedCaseReport[]): PairedAggregateReport['summary'] {
  const results = cases.flatMap((test) => [test.incremental, test.regenerate]).filter((result): result is PairedResultSummary => result !== null);
  return {
    completePairs: cases.filter((test) => test.pairStatus === 'complete').length,
    passedPairs: cases.filter((test) => test.bothQualityPassed).length,
    failedOrErroredPairs: cases.filter((test) => test.pairStatus !== 'complete' || test.bothQualityPassed === false).length,
    totalProtectedStateLosses: observedSum(results.map((result) => result.protectedStateLosses)),
    totalUnexpectedItemChanges: observedSum(results.map((result) => result.unexpectedItemChanges)),
    totalQuestions: observedSum(results.map((result) => result.questions)),
    totalConflicts: observedSum(results.map((result) => result.conflicts)),
    metricObservations: {
      protectedStateLosses: results.filter((result) => result.protectedStateLosses !== null).length,
      unexpectedItemChanges: results.filter((result) => result.unexpectedItemChanges !== null).length,
      questions: results.filter((result) => result.questions !== null).length,
      conflicts: results.filter((result) => result.conflicts !== null).length,
    },
    totalCostMicroUsd: results.some((result) => result.costMicroUsd !== null) ? sum(results.map((result) => result.costMicroUsd)) : null,
    costObservations: results.filter((result) => result.costMicroUsd !== null).length,
    evaluatedResults: results.filter((result) => result.status === 'evaluated').length,
    failedResults: results.filter((result) => result.status === 'failed').length,
  };
}

function chooseWinner(incremental: PairedResultSummary, regenerate: PairedResultSummary): PairedCaseReport['winner'] {
  if (!['evaluated', 'failed'].includes(incremental.status ?? '') || !['evaluated', 'failed'].includes(regenerate.status ?? '')) return 'incomplete';
  const incrementalPassed = incremental.qualityStatus === 'passed';
  const regeneratePassed = regenerate.qualityStatus === 'passed';
  if (incrementalPassed !== regeneratePassed) return incrementalPassed ? 'incremental' : 'regenerate';
  // Necessary questions are a successful outcome for some cases, not a penalty.
  // There is no justified ranking between two unsuccessful outcomes.
  return incrementalPassed ? 'tie' : 'neither_passed';
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function observedSum(values: Array<number | null>): number | null {
  return values.some((value) => value !== null) ? sum(values) : null;
}

function delta(left: number | null | undefined, right: number | null | undefined): number | null {
  return typeof left === 'number' && typeof right === 'number' ? left - right : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort();
}

function uniqueNumbers(values: unknown[]): number[] {
  return [...new Set(values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)))].sort((left, right) => left - right);
}

function isRecord(value: unknown): value is ResultRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
