import { ZodError } from 'zod';
import { DomainError, type ChangeSet, type ProposalDraft, type Snapshot } from '../core/contracts';
import { ApiException, ModelHttpError } from '../server/errors';

export type EvaluationExpectation = {
  facts: Record<string, string | number>;
  affectedFactKeys: string[];
  conflictExpected: boolean;
  expectedItems?: Record<string, string>;
  expectedConflictItemIds?: string[];
  expectedConflictFactKeys?: string[];
  requireUnchangedSnapshot?: boolean;
};

export type EvaluationMetrics = {
  outcome: 'completed' | 'conflict_detected' | 'needs_input' | 'incorrect';
  factChecksPassed: number;
  factChecksTotal: number;
  itemChecksPassed: number;
  itemChecksTotal: number;
  protectedStateLosses: number;
  unexpectedItemChanges: number;
  conflicts: number;
  questions: number;
  snapshotChanged: boolean;
};

export type EvaluationErrorKind = 'configuration' | 'provider' | 'network_uncertain' | 'api_exception' | 'domain_validation' | 'unexpected';
export type EvaluationErrorCode =
  | 'model_authentication'
  | 'model_permission_denied'
  | 'model_quota_or_rate_limited'
  | 'model_bad_request'
  | 'model_unavailable'
  | 'model_server_error'
  | 'model_api_error'
  | 'network_uncertain'
  | 'api_exception'
  | 'domain_validation'
  | 'NUMERIC_EVIDENCE_UNSUPPORTED'
  | 'NUMERIC_EVIDENCE_AMBIGUOUS'
  | 'NUMERIC_EVIDENCE_MISMATCH'
  | 'FACT_IDENTITY_COLLISION'
  | 'SEMANTIC_EVIDENCE_MISMATCH'
  | 'MISSING_FACT_SEMANTIC'
  | 'SEMANTIC_ERASURE'
  | 'BAD_FACT_OPERATION_TARGET'
  | 'BAD_ITEM_OPERATION_TARGET'
  | 'ITEM_IDENTITY_COLLISION'
  | 'DUPLICATE_ITEM_REMOVAL'
  | 'ITEM_NOT_FOUND'
  | 'INVALID_CALCULATION_SEMANTICS'
  | 'BAD_SOURCE_RELATION'
  | 'EVIDENCE_NOT_FOUND'
  | 'invalid_model_json'
  | 'unexpected_error';

export type EvaluationErrorSummary = {
  errorKind: EvaluationErrorKind;
  errorCode: EvaluationErrorCode;
  httpStatus: number | null;
  stopEvaluation: boolean;
  providerReason?: string;
  parameter?: string | null;
};

const safeDomainErrorCodes = new Set<EvaluationErrorCode>([
  'NUMERIC_EVIDENCE_UNSUPPORTED',
  'NUMERIC_EVIDENCE_AMBIGUOUS',
  'NUMERIC_EVIDENCE_MISMATCH',
  'FACT_IDENTITY_COLLISION',
  'SEMANTIC_EVIDENCE_MISMATCH', 'MISSING_FACT_SEMANTIC', 'SEMANTIC_ERASURE',
  'BAD_FACT_OPERATION_TARGET', 'BAD_ITEM_OPERATION_TARGET', 'ITEM_IDENTITY_COLLISION',
  'DUPLICATE_ITEM_REMOVAL', 'ITEM_NOT_FOUND', 'INVALID_CALCULATION_SEMANTICS', 'BAD_SOURCE_RELATION',
  'EVIDENCE_NOT_FOUND',
]);

const sortByStableId = <T extends { id: string }>(values: T[]): T[] =>
  [...values].sort((left, right) => left.id.localeCompare(right.id));

function canonicalSnapshot(snapshot: Snapshot): unknown {
  return {
    facts: sortByStableId(snapshot.facts).map((fact) => ({
      id: fact.id,
      key: fact.key,
      label: fact.label,
      value: fact.value,
      evidence: fact.evidence,
      semantic: fact.semantic ? Object.fromEntries(Object.entries(fact.semantic).sort(([left], [right]) => left.localeCompare(right))) : null,
    })),
    blocks: sortByStableId(snapshot.blocks).map((block) => ({
      id: block.id,
      key: block.key,
      type: block.type,
      title: block.title,
      items: sortByStableId(block.items).map((item) => ({
        id: item.id,
        key: item.key,
        label: item.label,
        value: item.value,
        factKeys: [...item.factKeys].sort(),
        valueFactKey: item.valueFactKey,
        calculation: item.calculation,
        completed: item.completed,
        locked: item.locked,
        edited: item.edited,
        stale: item.stale,
      })),
    })),
  };
}

/** Content-free diagnosis of omitted or mis-targeted model observations. */
export function summarizeProposalShape(snapshot: Snapshot, draft: ProposalDraft, latestSourceId?: string) {
  const existing = new Map(snapshot.facts.map((fact) => [fact.key, fact]));
  const existingObservations = draft.facts.filter((fact) => existing.has(fact.key));
  return {
    factObservations: draft.facts.length,
    existingFactObservations: existingObservations.length,
    changedExistingValues: existingObservations.filter((fact) => String(existing.get(fact.key)!.value) !== String(fact.value)).length,
    newFactObservations: draft.facts.length - existingObservations.length,
    latestSourceObservations: latestSourceId ? draft.facts.filter((fact) => fact.sourceId === latestSourceId).length : 0,
    questions: draft.questions.length,
    blocks: draft.blocks.length,
    items: draft.blocks.reduce((sum, block) => sum + block.items.length, 0),
    removals: draft.removedItems.length,
  };
}

/** Deterministic fixture assertions, not a claim of general semantic accuracy. */
export function evaluateProposal(
  before: Snapshot,
  proposal: ChangeSet,
  expectation: EvaluationExpectation,
): EvaluationMetrics {
  const after = proposal.next;
  const nextItems = new Map(after.blocks.flatMap((block) => block.items).map((item) => [item.id, item]));
  const expectedFacts = Object.entries(expectation.facts);
  const factChecksPassed = expectedFacts.filter(([key, value]) => after.facts.some((fact) => fact.key === key && fact.value === value)).length;
  const expectedItems = Object.entries(expectation.expectedItems ?? {});
  const itemChecksPassed = expectedItems.filter(([id, value]) => nextItems.get(id)?.value === value).length;
  let protectedStateLosses = 0;
  let unexpectedItemChanges = 0;

  for (const item of before.blocks.flatMap((block) => block.items)) {
    const next = nextItems.get(item.id);
    const protectedContent = item.edited || item.locked;
    if ((protectedContent && (!next || next.value !== item.value || next.label !== item.label)) ||
        (item.completed && !next?.completed) || (item.locked && !next?.locked) || (item.edited && !next?.edited)) {
      protectedStateLosses += 1;
    }
    const dependencies = new Set([
      ...item.factKeys,
      ...(item.valueFactKey ? [item.valueFactKey] : []),
      ...(item.calculation ? [item.calculation.totalFactKey, item.calculation.divisorFactKey] : []),
    ]);
    const affected = expectation.affectedFactKeys.some((key) => dependencies.has(key));
    const lineageChanged = next && (JSON.stringify([...next.factKeys].sort()) !== JSON.stringify([...item.factKeys].sort()) ||
      next.valueFactKey !== item.valueFactKey || JSON.stringify(next.calculation) !== JSON.stringify(item.calculation));
    if (!affected && (!next || next.value !== item.value || next.label !== item.label || next.completed !== item.completed || next.locked !== item.locked || next.edited !== item.edited || next.stale !== item.stale || lineageChanged)) {
      unexpectedItemChanges += 1;
    }
  }

  const questions = proposal.questions.length;
  const conflicts = proposal.conflicts.length;
  const factsMatch = factChecksPassed === expectedFacts.length;
  const itemsMatch = itemChecksPassed === expectedItems.length;
  const expectedItemConflictsMatch = (expectation.expectedConflictItemIds ?? []).every((id) => proposal.conflicts.some((conflict) => conflict.itemId === id));
  const expectedFactConflictsMatch = (expectation.expectedConflictFactKeys ?? []).every((factKey) => proposal.conflicts.some((conflict) => conflict.kind === 'source' && conflict.factKey === factKey));
  const expectedConflictsMatch = expectedItemConflictsMatch && expectedFactConflictsMatch;
  const snapshotChanged = JSON.stringify(canonicalSnapshot(before)) !== JSON.stringify(canonicalSnapshot(after));
  let outcome: EvaluationMetrics['outcome'] = 'incorrect';
  if (questions > 0) outcome = 'needs_input';
  else if (protectedStateLosses === 0 && expectation.conflictExpected && conflicts > 0 && expectedConflictsMatch && factsMatch && itemsMatch && unexpectedItemChanges === 0) outcome = 'conflict_detected';
  else if (protectedStateLosses === 0 && !expectation.conflictExpected && conflicts === 0 && factsMatch && itemsMatch && unexpectedItemChanges === 0) outcome = 'completed';

  return { outcome, factChecksPassed, factChecksTotal: expectedFacts.length, itemChecksPassed, itemChecksTotal: expectedItems.length, protectedStateLosses, unexpectedItemChanges, conflicts, questions, snapshotChanged };
}

export function summarizeEvaluationError(error: unknown): EvaluationErrorSummary {
  if (error instanceof ModelHttpError) {
    const status = error.status;
    const codes: Record<number, EvaluationErrorCode> = {
      400: 'model_bad_request', 401: 'model_authentication', 403: 'model_permission_denied',
      404: 'model_unavailable', 429: 'model_quota_or_rate_limited',
    };
    return {
      errorKind: [400, 401, 403, 404].includes(status) ? 'configuration' : 'provider',
      errorCode: codes[status] ?? (status >= 500 ? 'model_server_error' : 'model_api_error'),
      httpStatus: status,
      stopEvaluation: true,
      ...(error.reason !== 'unknown' ? { providerReason: error.reason, parameter: error.parameter } : {}),
    };
  }
  if (error instanceof ApiException) {
    const stop = ['MODEL_UNAVAILABLE', 'UNSUPPORTED_MODEL', 'MODEL_INPUT_TOO_LARGE', 'MODEL_PRICING_EXPIRED', 'MODEL_NOT_COMPLETED'];
    return { errorKind: 'api_exception', errorCode: 'api_exception', httpStatus: error.status, stopEvaluation: stop.includes(error.code) };
  }
  if (error instanceof DomainError || error instanceof ZodError) {
    const errorCode = error instanceof DomainError && safeDomainErrorCodes.has(error.code as EvaluationErrorCode)
      ? error.code as EvaluationErrorCode
      : 'domain_validation';
    return { errorKind: 'domain_validation', errorCode, httpStatus: error instanceof DomainError ? error.status : null, stopEvaluation: false };
  }
  if (error instanceof SyntaxError) return { errorKind: 'domain_validation', errorCode: 'invalid_model_json', httpStatus: null, stopEvaluation: false };
  if (error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) {
    return { errorKind: 'network_uncertain', errorCode: 'network_uncertain', httpStatus: null, stopEvaluation: true };
  }
  return { errorKind: 'unexpected', errorCode: 'unexpected_error', httpStatus: null, stopEvaluation: true };
}
