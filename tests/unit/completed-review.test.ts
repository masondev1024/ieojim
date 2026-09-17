import { describe, expect, it } from 'vitest';
import { emptySnapshot, type ProposalDraft, type Snapshot, type Source } from '../../src/core/contracts';
import { buildChangeSet, editItem, resolveChangeSet } from '../../src/core/engine';
import { getSample } from '../../src/core/samples';
import { getPreparationItems } from '../../src/core/preparation';

const itemId = 'item:tasks:review';
const command = { itemId, baseRevision: 1, requestId: '00000000-0000-4000-8000-000000000801' };
const source = (id: string, value: string, relation: Source['relation'] = 'initial'): Source => ({
  id, text: `발표 자료는 ${value}입니다.`, title: '자료 안내', hash: id,
  relation, targetSourceId: relation === 'correction' ? 'initial' : null, createdAt: '2026-09-16T00:00:00.000Z',
});
function draft(sourceId: string, value: string, update = false): ProposalDraft {
  return { schemaVersion: 2, summary: '발표 자료 확인', questions: [], removedItems: [],
    facts: [{ key: 'materials', label: '자료', value, sourceId, quote: `발표 자료는 ${value}입니다`, semantic: null, operation: update ? 'update' : 'create', targetFactKey: update ? 'materials' : null }],
    blocks: [{ key: 'tasks', title: '발표 준비', type: 'checklist', items: [{ key: 'review', label: '발표 자료 검토', value: `${value} 검토`, factKeys: ['materials'], valueFactKey: null, calculation: null, operation: update ? 'update' : 'create', targetItemId: update ? itemId : null }] }],
  };
}
const find = (snapshot: Snapshot) => snapshot.blocks[0]!.items[0]!;
function scenario(options: { locked?: boolean; sameText?: boolean; omitted?: boolean; supplementary?: boolean; unchanged?: boolean } = {}) {
  const initialSource = source('initial', '초안');
  const initial = buildChangeSet({ snapshot: emptySnapshot(), sources: [initialSource], draft: draft('initial', '초안'), baseRevision: 0, baseSourceRevision: 1, id: 'first', now: initialSource.createdAt }).next;
  const current = editItem(initial, { ...command, completed: true, locked: options.locked ?? false });
  const value = options.unchanged ? '초안' : '수정본';
  const updateSource = source('update', value, options.supplementary ? 'addition' : 'correction');
  const update = draft('update', value, true);
  if (options.sameText) update.blocks[0]!.items[0]!.value = find(current).value;
  if (options.omitted) update.blocks = [];
  const change = buildChangeSet({ snapshot: current, sources: [initialSource, updateSource], draft: update, baseRevision: 1, baseSourceRevision: 2, id: 'update', now: updateSource.createdAt });
  return { current, change };
}

describe('completed work after source changes', () => {
  it('keeps prior completion but requires review of new content', () => {
    const { current, change } = scenario();
    const next = resolveChangeSet(change, current, []);
    expect(find(next)).toMatchObject({ value: '수정본 검토', completed: true, stale: true });
    expect(find(current)).toMatchObject({ value: '초안 검토', completed: true, stale: false });
    expect(change.changes.find((entry) => entry.targetId === itemId)?.status).toBe('needs_review');
    expect(getPreparationItems(next, '2026-09-16')[0]!.status).toBe('needs_review');
  });
  it.each([{ sameText: true }, { omitted: true }])('marks affected completed dependencies even without new text: %j', (options) => {
    const { current, change } = scenario(options);
    expect(find(resolveChangeSet(change, current, []))).toMatchObject({ completed: true, stale: true });
  });
  it('does not turn an unchanged notice into more work', () => {
    const { current, change } = scenario({ unchanged: true });
    expect(find(resolveChangeSet(change, current, []))).toMatchObject({ completed: true, stale: false });
  });
  it.each(['keep_user', 'use_source'] as const)('keeps review needed after a locked choice: %s', (choice) => {
    const { current, change } = scenario({ locked: true });
    expect(change.conflicts).toHaveLength(1);
    const next = resolveChangeSet(change, current, [{ conflictId: change.conflicts[0]!.id, choice }]);
    expect(find(next)).toMatchObject({ completed: true, locked: true, stale: true, value: choice === 'keep_user' ? '초안 검토' : '수정본 검토' });
  });
  it.each(['keep_user', 'use_source'] as const)('reviews only accepted new source after a source conflict: %s', (choice) => {
    const { current, change } = scenario({ supplementary: true });
    const next = resolveChangeSet(change, current, change.conflicts.map((conflict) => ({ conflictId: conflict.id, choice })));
    expect(find(next)).toMatchObject({ completed: true, stale: choice === 'use_source' });
  });
  it('requires explicit acknowledgement even through repeated ordinary edits', () => {
    const { current, change } = scenario();
    let next = resolveChangeSet(change, current, []);
    for (const patch of [{ completed: false }, { locked: true }, { value: '내 확인 메모' }, { completed: true }]) {
      next = editItem(next, { ...command, ...patch });
      expect(find(next).stale).toBe(true);
    }
    expect(find(editItem(next, { ...command, acknowledgeReview: true }))).toMatchObject({ completed: true, stale: false, value: '내 확인 메모' });
    expect(find(editItem(next, { ...command, completed: false, acknowledgeReview: true }))).toMatchObject({ completed: false, stale: false });
  });
});


it('omitted completed calculations keep prior completion and require review after recomputation', () => {
  const sample = getSample('travel');
  const original: Source = { ...source('initial', '초안'), text: sample.initialText };
  const current = buildChangeSet({ snapshot: emptySnapshot(), sources: [original], draft: sample.initialDraft(original.id), baseRevision: 0, baseSourceRevision: 1 }).next;
  const cost = current.blocks.find((block) => block.type === 'cost')!;
  cost.type = 'checklist';
  const completed = cost.items.find((item) => item.calculation)!;
  completed.completed = true;
  const updateSource = { ...source('update', '수정본', 'correction'), text: sample.updateText };
  const update = sample.updateDraft(updateSource.id);
  update.blocks = [];
  const change = buildChangeSet({ snapshot: current, sources: [original, updateSource], draft: update, baseRevision: 1, baseSourceRevision: 2 });
  const result = resolveChangeSet(change, current, []).blocks.flatMap((block) => block.items).find((item) => item.id === completed.id)!;
  expect(result).toMatchObject({ completed: true, stale: true, value: '300000' });
  expect(change.changes.find((item) => item.targetId === completed.id)?.status).toBe('needs_review');
});
