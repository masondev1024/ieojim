import { describe, expect, it } from 'vitest';
import type { ChangeSet, Snapshot, Source } from '../../src/core/contracts';
import { DomainError, emptySnapshot } from '../../src/core/contracts';
import {
  DEPARTURE_CUSTOM_SHARE_MESSAGE,
  DEPARTURE_ITEM_KEYS,
  DEPARTURE_SCENARIO,
} from '../../src/core/departure-sample';
import { buildChangeSet, resolveChangeSet } from '../../src/core/engine';
import { getSample } from '../../src/core/samples';

const makeSource = (id: string, text: string, relation: Source['relation'] = 'initial', targetSourceId: string | null = null): Source => ({
  id,
  text,
  title: `합성 자료 ${id}`,
  relation,
  targetSourceId,
  hash: `hash-${id}`,
  createdAt: '2026-09-14T00:00:00.000Z',
});

const item = (snapshot: Snapshot, id: string) => {
  const found = snapshot.blocks.flatMap((block) => block.items).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing item ${id}`);
  return found;
};

const hasItem = (snapshot: Snapshot, id: string) =>
  snapshot.blocks.flatMap((block) => block.items).some((candidate) => candidate.id === id);

const buildDepartureInitial = () => {
  const source = makeSource('departure-initial', DEPARTURE_SCENARIO.initialText);
  const changeSet = buildChangeSet({
    snapshot: emptySnapshot(),
    sources: [source],
    draft: DEPARTURE_SCENARIO.initialDraft(source.id),
    baseRevision: 0,
    baseSourceRevision: 1,
    id: 'cs-departure-initial',
    now: '2026-09-14T00:00:00.000Z',
  });
  const snapshot = DEPARTURE_SCENARIO.prepareInitialSnapshot?.(resolveChangeSet(changeSet, emptySnapshot(), [])) ?? changeSet.next;
  return { source, changeSet, snapshot };
};

const buildDepartureCorrection = () => {
  const initial = buildDepartureInitial();
  const correction = makeSource('departure-correction', DEPARTURE_SCENARIO.updateText, 'correction', initial.source.id);
  const before = structuredClone(initial.snapshot);
  const changeSet = buildChangeSet({
    snapshot: initial.snapshot,
    sources: [initial.source, correction],
    draft: DEPARTURE_SCENARIO.updateDraft(correction.id),
    baseRevision: 1,
    baseSourceRevision: 2,
    id: 'cs-departure-correction',
    now: '2026-09-14T00:01:00.000Z',
  });
  return { ...initial, correction, before, changeSet };
};

describe('departure sample fixture', () => {
  it('publishes the shared departure scenario without changing existing sample keys', () => {
    expect(getSample('travel').title).toBe('합성 예시: 제주 가족 여행');
    expect(getSample('syllabus').title).toBe('합성 예시: 데이터 공학 과제');
    expect(getSample('departure')).toBe(DEPARTURE_SCENARIO);
  });

  it('creates exact evidence slices and prepared user-protected state', () => {
    const { source, snapshot } = buildDepartureInitial();
    const participants = snapshot.facts.find((fact) => fact.key === 'participants');
    const totalCost = snapshot.facts.find((fact) => fact.key === 'fixed_total_cost');

    expect(participants).toMatchObject({ value: 4, semantic: { kind: 'count', unit: 'person' } });
    expect(totalCost).toMatchObject({ value: 900000, semantic: { kind: 'money', unit: 'KRW' } });
    expect(source.text.slice(participants!.evidence.start, participants!.evidence.end)).toBe(participants!.evidence.quote);
    expect(source.text.slice(totalCost!.evidence.start, totalCost!.evidence.end)).toBe(totalCost!.evidence.quote);
    expect(item(snapshot, DEPARTURE_ITEM_KEYS.dinner)).toMatchObject({ value: '오후 7시 약속', locked: true, edited: false });
    expect(item(snapshot, DEPARTURE_ITEM_KEYS.shareMessage)).toMatchObject({ value: DEPARTURE_CUSTOM_SHARE_MESSAGE, edited: true, stale: false });
    expect(item(snapshot, DEPARTURE_ITEM_KEYS.paperConfirmation)).toMatchObject({
      value: '출발 전 종이 확인서 출력',
      factKeys: ['paper_confirmation_required'],
      completed: true,
      edited: false,
    });
    const paperFact = snapshot.facts.find((fact) => fact.key === 'paper_confirmation_required');
    expect(paperFact).toBeTruthy();
    expect(source.text.slice(paperFact!.evidence.start, paperFact!.evidence.end)).toBe('종이 확인서 출력 항목을 준비 체크리스트에 포함해야 합니다');
  });

  it('produces a single complex correction with exactly two conflicts and no update-delete contradiction', () => {
    const { snapshot, before, changeSet } = buildDepartureCorrection();

    expect(changeSet.conflicts.map((conflict) => conflict.kind).sort()).toEqual(['deletion', 'locked']);
    expect(changeSet.questions).toEqual([]);
    expect(item(changeSet.next, DEPARTURE_ITEM_KEYS.costShare).value).toBe('300000');
    expect(item(changeSet.next, DEPARTURE_ITEM_KEYS.arrival).value).toBe('오후 4시 도착');
    expect(item(changeSet.next, DEPARTURE_ITEM_KEYS.dinner).value).toBe('오후 7시 약속');
    expect(item(changeSet.next, DEPARTURE_ITEM_KEYS.shareMessage)).toMatchObject({ value: DEPARTURE_CUSTOM_SHARE_MESSAGE, edited: true, stale: true });
    expect(hasItem(changeSet.next, DEPARTURE_ITEM_KEYS.paperConfirmation)).toBe(true);
    expect(snapshot).toEqual(before);

    const draft = DEPARTURE_SCENARIO.updateDraft('source-id');
    const updatedItemIds = draft.blocks.flatMap((block) => block.items.map((draftItem) => `item:${block.key}:${draftItem.key}`));
    expect(updatedItemIds).not.toContain(DEPARTURE_ITEM_KEYS.paperConfirmation);
    expect(draft.removedItems).toEqual([expect.objectContaining({ itemId: DEPARTURE_ITEM_KEYS.paperConfirmation })]);
  });

  it('requires both conflict choices before resolution', () => {
    const { snapshot, changeSet } = buildDepartureCorrection();

    expect(() => resolveChangeSet(changeSet, snapshot, [])).toThrow(DomainError);
    expect(() => resolveChangeSet(changeSet, snapshot, [{ conflictId: changeSet.conflicts[0]!.id, choice: 'keep_user' }])).toThrow(DomainError);
  });

  it('resolves all four locked-dinner and completed-deletion choice combinations', () => {
    const { snapshot, changeSet } = buildDepartureCorrection();
    const locked = conflict(changeSet, 'locked');
    const deletion = conflict(changeSet, 'deletion');

    for (const dinnerChoice of ['keep_user', 'use_source'] as const) {
      for (const deletionChoice of ['keep_user', 'use_source'] as const) {
        const resolved = resolveChangeSet(changeSet, snapshot, [
          { conflictId: locked.id, choice: dinnerChoice },
          { conflictId: deletion.id, choice: deletionChoice },
        ]);
        expect(item(resolved, DEPARTURE_ITEM_KEYS.arrival).value).toBe('오후 4시 도착');
        expect(item(resolved, DEPARTURE_ITEM_KEYS.costShare).value).toBe('300000');
        expect(item(resolved, DEPARTURE_ITEM_KEYS.shareMessage).value).toBe(DEPARTURE_CUSTOM_SHARE_MESSAGE);
        expect(item(resolved, DEPARTURE_ITEM_KEYS.shareMessage).stale).toBe(true);
        expect(item(resolved, DEPARTURE_ITEM_KEYS.dinner).value).toBe(dinnerChoice === 'use_source' ? '오후 8시 약속' : '오후 7시 약속');
        expect(hasItem(resolved, DEPARTURE_ITEM_KEYS.paperConfirmation)).toBe(deletionChoice === 'keep_user');
      }
    }
  });

  it('keeps or deletes the completed paper item only by explicit choice', () => {
    const { snapshot, changeSet } = buildDepartureCorrection();
    const locked = conflict(changeSet, 'locked');
    const deletion = conflict(changeSet, 'deletion');
    const keepCompleted = resolveChangeSet(changeSet, snapshot, [
      { conflictId: locked.id, choice: 'keep_user' },
      { conflictId: deletion.id, choice: 'keep_user' },
    ]);
    const approveDeletion = resolveChangeSet(changeSet, snapshot, [
      { conflictId: locked.id, choice: 'keep_user' },
      { conflictId: deletion.id, choice: 'use_source' },
    ]);

    expect(item(keepCompleted, DEPARTURE_ITEM_KEYS.paperConfirmation).completed).toBe(true);
    expect(hasItem(approveDeletion, DEPARTURE_ITEM_KEYS.paperConfirmation)).toBe(false);
  });

  it('uses real source quotes for deletion evidence', () => {
    const { correction, changeSet } = buildDepartureCorrection();
    const deletionChange = changeSet.changes.find((change) => change.targetId === DEPARTURE_ITEM_KEYS.paperConfirmation);
    expect(deletionChange?.status).toBe('needs_review');
    const evidence = deletionChange!.evidence[0]!;
    expect(correction.text.slice(evidence.start, evidence.end)).toBe('종이 확인서 출력 항목은 삭제해 주세요');
  });
});

const conflict = (changeSet: ChangeSet, kind: 'locked' | 'deletion') => {
  const found = changeSet.conflicts.find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`missing conflict ${kind}`);
  return found;
};
