import { describe, expect, it } from 'vitest';
import { emptySnapshot, itemPreparationSchema, type Source } from '../../src/core/contracts';
import { COORDINATION_ITEM_KEYS as keys, COORDINATION_SCENARIO as scenario } from '../../src/core/coordination-sample';
import { buildChangeSet, editItem, resolveChangeSet } from '../../src/core/engine';

const initial: Source = { id: 'source-initial', title: '합성 업무', text: scenario.initialText, relation: 'initial', targetSourceId: null, hash: 'synthetic-hash', createdAt: '2026-09-14T00:00:00.000Z' };
function preparedSnapshot() {
  const cs = buildChangeSet({ snapshot: emptySnapshot(), sources: [initial], draft: scenario.initialDraft(initial.id), baseRevision: 0, baseSourceRevision: 1 });
  return scenario.prepareInitialSnapshot(resolveChangeSet(cs, emptySnapshot(), []));
}
const command = { itemId: keys.materials, baseRevision: 1, requestId: '00000000-0000-4000-8000-000000000701' };

describe('user-owned preparation boundary', () => {
  it('rejects calendar-invalid dates and unsupported numeric estimates while accepting leap day', () => {
    for (const dueDate of ['2026-02-29', '2026-02-30', '2026-13-01', '09-17', '2026-09-17T10:00:00Z']) {
      expect(itemPreparationSchema.safeParse({ version: 1, dueDate, durationMinutes: 30 }).success).toBe(false);
    }
    for (const durationMinutes of [0, -1, 1441, 1.5, Infinity, NaN]) {
      expect(itemPreparationSchema.safeParse({ version: 1, dueDate: null, durationMinutes }).success).toBe(false);
    }
    expect(itemPreparationSchema.safeParse({ version: 1, dueDate: '2028-02-29', durationMinutes: 1440 }).success).toBe(true);
  });

  it('rejects a model trying to author preparation settings', () => {
    const draft = scenario.initialDraft(initial.id);
    const target = draft.blocks.find((block) => block.type === 'checklist')!.items[0]!;
    Object.assign(target, { preparation: { version: 1, dueDate: '2026-09-18', durationMinutes: 30 } });
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [initial], draft, baseRevision: 0, baseSourceRevision: 1 })).toThrow();
  });

  it('protects an unfinished preparation-only task against source-backed deletion', () => {
    const before = preparedSnapshot();
    const correction: Source = { ...initial, id: 'source-remove', relation: 'correction', targetSourceId: initial.id, text: '발표자료 정리 항목을 삭제합니다.' };
    const pending = buildChangeSet({ snapshot: before, sources: [initial, correction], baseRevision: 1, baseSourceRevision: 2, draft: {
      schemaVersion: 2, summary: '준비 항목 삭제 요청', questions: [], facts: [], blocks: [],
      removedItems: [{ operation: 'remove', itemId: keys.materials, sourceId: correction.id, quote: correction.text }],
    } });
    expect(pending.conflicts).toHaveLength(1);
    expect(pending.conflicts[0]).toMatchObject({ kind: 'deletion', itemId: keys.materials });
    expect(() => resolveChangeSet(pending, before, [])).toThrow();
    const kept = resolveChangeSet(pending, before, [{ conflictId: pending.conflicts[0]!.id, choice: 'keep_user' }]);
    expect(kept.blocks.flatMap((block) => block.items).find((item) => item.id === keys.materials)).toMatchObject({ completed: false, edited: false, preparation: { dueDate: '2026-09-17', durationMinutes: 90 } });
    const removed = resolveChangeSet(pending, before, [{ conflictId: pending.conflicts[0]!.id, choice: 'use_source' }]);
    expect(removed.blocks.flatMap((block) => block.items).some((item) => item.id === keys.materials)).toBe(false);
  });

  it('keeps review pending after an estimate edit and clears it only with explicit acknowledgement', () => {
    const snapshot = preparedSnapshot();
    const original = snapshot.blocks.flatMap((block) => block.items).find((item) => item.id === keys.materials)!;
    original.stale = true;
    const changed = editItem(snapshot, { ...command, preparation: { version: 1, dueDate: '2026-09-16', durationMinutes: 60 } });
    const changedItem = changed.blocks.flatMap((block) => block.items).find((item) => item.id === keys.materials)!;
    expect(changedItem).toMatchObject({ stale: true, completed: false, edited: false, value: original.value });
    const reviewed = editItem(changed, { ...command, acknowledgeReview: true });
    const reviewedItem = reviewed.blocks.flatMap((block) => block.items).find((item) => item.id === keys.materials)!;
    expect(reviewedItem).toEqual({ ...changedItem, stale: false });
    expect(original.preparation?.durationMinutes).toBe(90);
    expect(() => editItem(snapshot, { ...command, itemId: keys.meeting, acknowledgeReview: true })).toThrow();
  });

  it('does not acknowledge stale preparation through completion, locking or text edits', () => {
    const snapshot = preparedSnapshot();
    snapshot.blocks.flatMap((block) => block.items).find((item) => item.id === keys.materials)!.stale = true;
    for (const updates of [{ completed: true }, { locked: true }, { label: '자료 최종 점검' }, { value: '최종 자료 준비' }]) {
      const changed = editItem(snapshot, { ...command, ...updates });
      const item = changed.blocks.flatMap((block) => block.items).find((item) => item.id === keys.materials)!;
      expect(item.stale).toBe(true);
      expect(item).toMatchObject(updates);
      const acknowledged = editItem(changed, { ...command, acknowledgeReview: true });
      expect(acknowledged.blocks.flatMap((block) => block.items).find((entry) => entry.id === keys.materials)).toEqual({ ...item, stale: false });
    }
  });

  it('does not bypass preparation review by clearing settings together with an ordinary edit', () => {
    const snapshot = preparedSnapshot();
    snapshot.blocks.flatMap((block) => block.items).find((item) => item.id === keys.materials)!.stale = true;
    const changed = editItem(snapshot, { ...command, completed: true, preparation: { version: 1, dueDate: null, durationMinutes: null } });
    expect(changed.blocks.flatMap((block) => block.items).find((item) => item.id === keys.materials)).toMatchObject({ completed: true, stale: true });
  });
});
