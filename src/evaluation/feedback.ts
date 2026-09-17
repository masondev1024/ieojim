import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EvaluationCase } from './case';
import { evaluateQuality } from './eval-quality';
import { acceptanceCorpusHash } from './paired-eval';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const strategy = z.enum(['incremental', 'regenerate']);
const errorCode = z.enum([
  'model_authentication', 'model_permission_denied', 'model_quota_or_rate_limited',
  'model_bad_request', 'model_unavailable', 'model_server_error', 'model_api_error',
  'network_uncertain', 'api_exception', 'domain_validation', 'unexpected_error', 'invalid_model_json',
  'NUMERIC_EVIDENCE_UNSUPPORTED', 'NUMERIC_EVIDENCE_AMBIGUOUS', 'NUMERIC_EVIDENCE_MISMATCH',
  'FACT_IDENTITY_COLLISION', 'SEMANTIC_EVIDENCE_MISMATCH', 'MISSING_FACT_SEMANTIC', 'SEMANTIC_ERASURE',
  'BAD_FACT_OPERATION_TARGET', 'BAD_ITEM_OPERATION_TARGET', 'ITEM_IDENTITY_COLLISION',
  'DUPLICATE_ITEM_REMOVAL', 'ITEM_NOT_FOUND', 'INVALID_CALCULATION_SEMANTICS', 'BAD_SOURCE_RELATION', 'EVIDENCE_NOT_FOUND',
]);
const metricsSchema = z.object({
  outcome: z.enum(['completed', 'conflict_detected', 'needs_input', 'incorrect']),
  factChecksPassed: count, factChecksTotal: count, itemChecksPassed: count, itemChecksTotal: count,
  protectedStateLosses: count, unexpectedItemChanges: count, conflicts: count, questions: count,
  snapshotChanged: z.boolean(),
});
const resultSchema = z.object({
  case: z.string().regex(/^[a-z0-9-]{1,100}$/), strategy,
  requestedContext: z.literal('full'), effectiveContext: z.literal('full'),
  status: z.enum(['reserved', 'evaluated', 'failed']),
  qualityStatus: z.enum(['passed', 'failed']).optional(),
  expectedOutcome: z.enum(['completed', 'conflict_detected', 'needs_input']).optional(),
  metrics: metricsSchema.optional(), errorCode: errorCode.optional(),
  costMicroUsd: count.optional(), latencyMs: count.optional(),
  requestProvenance: z.object({
    modelId: z.string().regex(/^[a-zA-Z0-9._/-]{1,120}$/), contractVersion: z.literal(2), strategy,
    contextRequestedMode: z.literal('full'), contextEffectiveMode: z.literal('full'),
    instructionSha256: hash, localSchemaSha256: hash, generationConfigSha256: hash,
    modelPolicySha256: hash, contextSha256: hash,
  }).optional(),
});
const reportSchema = z.object({
  mode: z.literal('live-model'), suite: z.enum(['acceptance', 'loop-challenge', 'initial-creation']), corpusHash: hash,
  model: z.string().regex(/^[a-zA-Z0-9._/-]{1,120}$/),
  contexts: z.tuple([z.literal('full')]), contextMode: z.literal('full'),
  strategies: z.array(strategy).min(1).max(2),
  cases: z.array(z.string().regex(/^[a-z0-9-]{1,100}$/)).min(1).max(100),
  plannedCalls: count, attemptedCalls: count, results: z.array(resultSchema).max(200),
  stoppedReason: z.string().max(100).nullable().optional(),
});
type Result = z.infer<typeof resultSchema>;
type FailureKind = 'workspace_safety' | 'contract_validation' | 'semantic_quality' | 'measurement_design' | 'operator_review' | 'incomplete_measurement';
type Failure = { kind: FailureKind; reason: string; priority: number; operatorRequired: boolean };
export type FeedbackIssue = Failure & {
  id: string; case: string; strategy: Result['strategy']; occurrences: number; evidence: string[];
};

const operationalErrors = new Set([
  'model_authentication', 'model_permission_denied', 'model_quota_or_rate_limited',
  'model_bad_request', 'model_unavailable', 'model_server_error', 'model_api_error',
  'network_uncertain', 'api_exception', 'unexpected_error',
]);

/** Reports are untrusted measurements, never executable commands or model instructions. */
export function buildEvaluationFeedback(rawReports: unknown[], corpora: Record<'acceptance' | 'loop-challenge' | 'initial-creation', EvaluationCase[]>) {
  if (!rawReports.length || rawReports.length > 20) throw new Error('FEEDBACK_REPORT_COUNT');
  const issues = new Map<string, FeedbackIssue>();
  const seenReports = new Set<string>();
  let observations = 0;
  let passed = 0;
  let duplicateReports = 0;
  for (const raw of rawReports) {
    const parsed = reportSchema.safeParse(raw);
    // Do not reflect unknown provider text or malformed values in errors.
    if (!parsed.success) throw new Error('FEEDBACK_INVALID_REPORT');
    const report = parsed.data;
    if (report.stoppedReason && report.stoppedReason !== 'stopped_after_model_budget_policy_violation' &&
      !errorCode.safeParse(report.stoppedReason.replace(/^stopped_after_/, '')).success) throw new Error('FEEDBACK_UNKNOWN_STOP_REASON');
    const corpus = corpora[report.suite];
    const selected = corpus.filter((test) => report.cases.includes(test.id));
    if (selected.length !== report.cases.length || new Set(report.cases).size !== report.cases.length ||
      new Set(report.strategies).size !== report.strategies.length ||
      report.corpusHash !== acceptanceCorpusHash(selected) ||
      report.plannedCalls !== selected.length * report.strategies.length ||
      report.attemptedCalls !== report.results.length || report.attemptedCalls > report.plannedCalls) {
      throw new Error('FEEDBACK_CORPUS_OR_COUNTS_MISMATCH');
    }
    const reportId = digest(report);
    if (seenReports.has(reportId)) { duplicateReports++; continue; }
    seenReports.add(reportId);
    const seenResults = new Set<string>();
    const sharedHashes = new Map<string, string>();
    for (const result of report.results) {
      const key = `${result.case}/${result.strategy}`;
      if (seenResults.has(key) || !report.cases.includes(result.case) || !report.strategies.includes(result.strategy)) {
        throw new Error('FEEDBACK_DUPLICATE_OR_UNKNOWN_RESULT');
      }
      seenResults.add(key);
      const provenance = result.requestProvenance;
      if ((result.status !== 'reserved' && !provenance) || (provenance && (provenance.modelId !== report.model || provenance.strategy !== result.strategy))) {
        throw new Error('FEEDBACK_PROVENANCE_MISMATCH');
      }
      if (provenance) {
        for (const field of ['localSchemaSha256', 'generationConfigSha256', 'modelPolicySha256', 'instructionSha256', 'contextSha256'] as const) {
          const hashKey = field === 'instructionSha256' ? `${field}/${result.strategy}` : field === 'contextSha256' ? `${field}/${result.case}` : field;
          if (sharedHashes.has(hashKey) && sharedHashes.get(hashKey) !== provenance[field]) throw new Error('FEEDBACK_PROVENANCE_DRIFT');
          sharedHashes.set(hashKey, provenance[field]);
        }
      }
      const test = selected.find((entry) => entry.id === result.case)!;
      const failure = classify(result, test);
      observations++;
      if (!failure) { passed++; continue; }
      addIssue(failure, result.case, result.strategy, reportId, { suite: report.suite, corpusHash: report.corpusHash, model: report.model, provenance });
    }
    for (const test of selected) for (const method of report.strategies) {
      if (!seenResults.has(`${test.id}/${method}`)) {
        addIssue({ kind: 'incomplete_measurement', reason: 'not_attempted', priority: 1, operatorRequired: true }, test.id, method, reportId, { suite: report.suite, corpusHash: report.corpusHash, model: report.model });
      }
    }
    if (report.stoppedReason) {
      addIssue({ kind: 'operator_review', reason: report.stoppedReason, priority: 1, operatorRequired: true }, selected[0].id, report.strategies[0], reportId, { suite: report.suite, corpusHash: report.corpusHash, model: report.model });
    }
  }
  const ranked = [...issues.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const tasks = ranked.filter((issue) => !issue.operatorRequired).map((issue) => ({
    id: issue.id, title: `${issue.kind}: ${issue.case} (${issue.strategy})`, priority: issue.priority,
    dependsOn: [] as string[],
    acceptance: [
      `Investigate ${issue.reason} in frozen case ${issue.case}; preserve original reports and expected values.`,
      'Add a focused deterministic regression, implement the narrow fix, and pass npm run verify plus independent review.',
      'Do not enable automatic paid retries or claim live quality improved until a separately bounded fresh evaluation confirms it.',
    ],
  }));
  return {
    reportKind: 'ieojim-evaluation-feedback-v1', uniqueReports: seenReports.size, duplicateReports,
    observations, passed, issues: ranked,
    nextAction: ranked.some((issue) => issue.operatorRequired) ? 'review_measurement_and_independent_coding_tasks' : tasks.length ? 'review_development_plan' : 'expand_or_repeat_frozen_evaluation',
    developmentPlan: tasks.length ? {
      version: 1, id: `eval-${digest([...seenReports].sort()).slice(0, 16)}`,
      objective: 'Resolve measured evaluation failures while preserving frozen expectations and workspace invariants.',
      maxAttemptsPerTask: 3, maxNoProgress: 2, tasks,
    } : null,
    limitations: [
      'Metadata validation does not authenticate reports or re-execute the original model output. Review source artifacts before starting a generated plan.',
      'Different prompt/model/corpus identities remain separate issues; this backlog does not estimate comparative quality or causal improvement.',
      'Uncertain, unavailable and unattempted calls require operator review; no calls, retries or source edits are executed by this tool.',
    ],
  };

  function addIssue(failure: Failure, caseId: string, method: Result['strategy'], evidence: string, identity: unknown) {
    const id = `eval-${digest({ failure, caseId, method, identity }).slice(0, 20)}`;
    const existing = issues.get(id);
    if (existing) { existing.occurrences++; existing.evidence.push(evidence); }
    else issues.set(id, { ...failure, id, case: caseId, strategy: method, occurrences: 1, evidence: [evidence] });
  }
}

function classify(result: Result, test: EvaluationCase): Failure | null {
  if (result.status === 'reserved') {
    if (result.metrics || result.errorCode || result.qualityStatus) throw new Error('FEEDBACK_INCONSISTENT_FAILURE');
    return { kind: 'incomplete_measurement', reason: 'outcome_unknown', priority: 1, operatorRequired: true };
  }
  if (result.status === 'failed') {
    if (!result.errorCode || result.metrics || result.qualityStatus) throw new Error('FEEDBACK_INCONSISTENT_FAILURE');
    const operatorRequired = operationalErrors.has(result.errorCode);
    return { kind: operatorRequired ? 'operator_review' : 'contract_validation', reason: result.errorCode, priority: operatorRequired ? 1 : 2, operatorRequired };
  }
  if (!result.metrics || result.errorCode) throw new Error('FEEDBACK_MISSING_METRICS');
  const metrics = result.metrics;
  const expectedFactCount = Object.keys(test.expectation.facts).length;
  const expectedItemCount = Object.keys(test.expectation.expectedItems ?? {}).length;
  if (metrics.factChecksTotal !== expectedFactCount || metrics.itemChecksTotal !== expectedItemCount ||
    metrics.factChecksPassed > metrics.factChecksTotal || metrics.itemChecksPassed > metrics.itemChecksTotal) {
    throw new Error('FEEDBACK_INVALID_METRIC_COUNTS');
  }
  const verdict = evaluateQuality(metrics, test.expectation);
  if (verdict.qualityStatus !== result.qualityStatus || verdict.expectedOutcome !== result.expectedOutcome) throw new Error('FEEDBACK_QUALITY_VERDICT_MISMATCH');
  if (metrics.protectedStateLosses || metrics.unexpectedItemChanges) return { kind: 'workspace_safety', reason: 'protected_or_unrelated_state_changed', priority: 1, operatorRequired: false };
  // Before first creation there are no stable keys to preserve. A fixed-key-only
  // grader cannot distinguish a missing fact from a correctly generated new key.
  if (!test.initialExpectation && !test.snapshot.facts.length && !test.snapshot.blocks.length &&
    (expectedFactCount || expectedItemCount)) {
    return { kind: 'measurement_design', reason: 'initial_creation_requires_semantic_grader', priority: 1, operatorRequired: true };
  }
  if (verdict.qualityStatus === 'failed') return { kind: 'semantic_quality', reason: 'frozen_expectation_not_met', priority: 3, operatorRequired: false };
  return null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
