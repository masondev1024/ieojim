import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainError, type BlockItem, type ChangeSet, type Snapshot } from '../../src/core/contracts';
import { ApiException, ModelHttpError } from '../../src/server/errors';
import { evaluateProposal, summarizeEvaluationError } from '../../src/evaluation/metrics';

const item: BlockItem = { id: 'item-1', key: 'note', label: '내 안내', value: '내가 직접 정한 안내', factKeys: ['people'], valueFactKey: null, calculation: null, completed: true, locked: true, edited: true, stale: false };
const before: Snapshot = { facts: [], blocks: [{ id: 'block-1', key: 'notes', type: 'note', title: '안내', items: [item] }] };
function proposal(next: Snapshot = structuredClone(before)): ChangeSet {
  return { id: 'proposal-1', baseRevision: 1, baseSourceRevision: 1, proposalRevision: 1, summary: '테스트', questions: [], changes: [], conflicts: [], next, createdAt: '2026-09-08T00:00:00Z' };
}
const expectation = { facts: {}, affectedFactKeys: ['people'], conflictExpected: false };

describe('evaluation avoids inflated success claims', () => {
  it('counts semantic-only mutations when a clarification must leave the snapshot unchanged', () => {
    const old: Snapshot = { facts: [{ id: 'fact:count', key: 'count', label: '수량', value: 4, evidence: { sourceId: 'source', quote: '4명', start: 0, end: 2 }, semantic: { kind: 'count', unit: 'person' } }], blocks: [] };
    const candidate = proposal(structuredClone(old));
    candidate.questions = ['어느 대상을 뜻하나요?'];
    candidate.next.facts[0]!.semantic = { kind: 'count', unit: 'team' };
    expect(evaluateProposal(old, candidate, { ...expectation, requireUnchangedSnapshot: true }).snapshotChanged).toBe(true);
  });
  it('does not count clarification as completion even when no protected state is lost', () => {
    const candidate = proposal();
    candidate.questions.push('몇 명인가요?');
    expect(evaluateProposal(before, candidate, expectation)).toMatchObject({ outcome: 'needs_input', snapshotChanged: false });
  });
  it('counts a lost locked/edited/completed item as one protected-state loss', () => {
    const candidate = proposal({ facts: [], blocks: [] });
    expect(evaluateProposal(before, candidate, expectation)).toMatchObject({ outcome: 'incorrect', protectedStateLosses: 1 });
  });
  it('does not count silently unlocked decisions as preserved', () => {
    const candidate = proposal();
    candidate.next.blocks[0].items[0].locked = false;
    expect(evaluateProposal(before, candidate, expectation).protectedStateLosses).toBe(1);
  });
  it('counts a silently cleared manual-edit marker even when text is unchanged', () => {
    const candidate = proposal();
    candidate.next.blocks[0].items[0].edited = false;
    expect(evaluateProposal(before, candidate, expectation).protectedStateLosses).toBe(1);
  });
  it('detects unrelated dependency and stale-marker mutations', () => {
    const candidate = proposal();
    candidate.next.blocks[0].items[0].factKeys = ['other'];
    candidate.next.blocks[0].items[0].stale = true;
    expect(evaluateProposal(before, candidate, { ...expectation, affectedFactKeys: [] }).unexpectedItemChanges).toBe(1);
  });
  it('separates a legitimate conflict from a completed change', () => {
    const candidate = proposal();
    candidate.conflicts.push({ id: 'conflict-1', itemId: item.id, message: '고정과 충돌', kind: 'locked', factKey: null });
    expect(evaluateProposal(before, candidate, { ...expectation, conflictExpected: true }).outcome).toBe('conflict_detected');
    expect(evaluateProposal(before, candidate, expectation).outcome).toBe('incorrect');
  });
  it('requires requested facts instead of accepting an unchanged workspace', () => {
    expect(evaluateProposal(before, proposal(), { ...expectation, facts: { people: 3 } })).toMatchObject({ outcome: 'incorrect', factChecksPassed: 0, factChecksTotal: 1 });
  });
  it('requires the expected conflicting item instead of accepting an unrelated conflict', () => {
    const candidate = proposal();
    candidate.conflicts.push({ id: 'unrelated', itemId: 'some-other-item', message: '다른 충돌', kind: 'locked', factKey: null });
    expect(evaluateProposal(before, candidate, { ...expectation, conflictExpected: true, expectedConflictItemIds: [item.id] }).outcome).toBe('incorrect');
  });
  it('requires expected source conflict fact keys instead of accepting an unrelated source conflict', () => {
    const candidate = proposal();
    candidate.conflicts.push({ id: 'source-conflict', itemId: null, message: '자료 충돌', kind: 'source', factKey: 'other_fact' });
    expect(evaluateProposal(before, candidate, { ...expectation, conflictExpected: true, expectedConflictFactKeys: ['people'] }).outcome).toBe('incorrect');
    candidate.conflicts[0].factKey = 'people';
    expect(evaluateProposal(before, candidate, { ...expectation, conflictExpected: true, expectedConflictFactKeys: ['people'] }).outcome).toBe('conflict_detected');
  });
  it('requires the calculated item output as well as extracted facts', () => {
    expect(evaluateProposal(before, proposal(), { ...expectation, expectedItems: { [item.id]: '300000' } })).toMatchObject({ outcome: 'incorrect', itemChecksPassed: 0, itemChecksTotal: 1 });
  });
  it('detects unrelated changes rather than measuring only protected fields', () => {
    const old = structuredClone(before);
    old.blocks[0].items[0] = { ...item, edited: false, locked: false, completed: false, factKeys: ['unrelated'] };
    const candidate = proposal(structuredClone(old));
    candidate.next.blocks[0].items[0].value = '근거 없는 수정';
    expect(evaluateProposal(old, candidate, expectation)).toMatchObject({ outcome: 'incorrect', unexpectedItemChanges: 1 });
  });
  it('detects snapshot changes independent of fact, block, and item array ordering', () => {
    const old: Snapshot = {
      facts: [
        { id: 'fact:beta', key: 'beta', label: 'B', value: 'b', evidence: { sourceId: 's1', quote: 'b', start: 0, end: 1 } },
        { id: 'fact:alpha', key: 'alpha', label: 'A', value: 'a', evidence: { sourceId: 's1', quote: 'a', start: 2, end: 3 } },
      ],
      blocks: [
        { id: 'block-2', key: 'second', type: 'note', title: '둘째', items: [{ ...item, id: 'item-2', key: 'second', factKeys: ['beta', 'alpha'] }] },
        { id: 'block-1', key: 'first', type: 'note', title: '첫째', items: [{ ...item, id: 'item-1', key: 'first', factKeys: ['alpha'] }] },
      ],
    };
    const reordered: Snapshot = {
      facts: [structuredClone(old.facts[1]), structuredClone(old.facts[0])],
      blocks: [
        structuredClone(old.blocks[1]),
        { ...structuredClone(old.blocks[0]), items: [{ ...old.blocks[0].items[0], factKeys: ['alpha', 'beta'] }] },
      ],
    };
    expect(evaluateProposal(old, proposal(reordered), { ...expectation, affectedFactKeys: ['alpha', 'beta'] }).snapshotChanged).toBe(false);
    reordered.blocks[0].items[0].value = '변경';
    expect(evaluateProposal(old, proposal(reordered), { ...expectation, affectedFactKeys: ['alpha', 'beta'] }).snapshotChanged).toBe(true);
  });
});

describe('live evaluation error summaries', () => {
  it('reports allowed semantic error codes without reflecting private details or arbitrary codes', () => {
    const known = summarizeEvaluationError(new DomainError('SEMANTIC_EVIDENCE_MISMATCH', 'private source quotation'));
    expect(known).toMatchObject({ errorCode: 'SEMANTIC_EVIDENCE_MISMATCH', stopEvaluation: false });
    const unknown = summarizeEvaluationError(new DomainError('private-untrusted-code', 'private response text'));
    expect(unknown.errorCode).toBe('domain_validation');
    expect(JSON.stringify([known, unknown])).not.toContain('private');
  });

  it.each([
    [400, 'configuration', 'model_bad_request'],
    [401, 'configuration', 'model_authentication'],
    [403, 'configuration', 'model_permission_denied'],
    [404, 'configuration', 'model_unavailable'],
    [429, 'provider', 'model_quota_or_rate_limited'],
    [503, 'provider', 'model_server_error'],
  ])('stops shared provider errors safely for HTTP %i', (status, errorKind, errorCode) => {
    const error = Object.assign(new ModelHttpError(Number(status)), { providerBody: 'synthetic-private-error', credential: 'synthetic-private-key' });
    const summary = summarizeEvaluationError(error);
    expect(summary).toEqual({ errorKind, errorCode, httpStatus: status, stopEvaluation: true });
    expect(JSON.stringify(summary)).not.toContain('synthetic-private');
  });

  it.each([new TypeError('private network detail'), new DOMException('private timeout detail', 'TimeoutError')])('stops uncertain network outcomes', (error) => {
    expect(summarizeEvaluationError(error)).toEqual({ errorKind: 'network_uncertain', errorCode: 'network_uncertain', httpStatus: null, stopEvaluation: true });
  });

  it('separates app configuration and domain/output validation from provider failures', () => {
    expect(summarizeEvaluationError(new ApiException('MODEL_UNAVAILABLE', 'private detail', 503))).toMatchObject({ errorKind: 'api_exception', httpStatus: 503, stopEvaluation: true });
    expect(summarizeEvaluationError(new DomainError('EVIDENCE_NOT_FOUND', 'private detail', 422))).toMatchObject({ errorKind: 'domain_validation', httpStatus: 422, stopEvaluation: false });
    expect(summarizeEvaluationError(new SyntaxError('private detail'))).toMatchObject({ errorCode: 'invalid_model_json', stopEvaluation: false });
    const parsed = z.string().safeParse(1);
    expect(summarizeEvaluationError(parsed.error)).toMatchObject({ errorCode: 'domain_validation', stopEvaluation: false });
  });
});
