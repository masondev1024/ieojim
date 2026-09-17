import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot, type Source } from '../../src/core/contracts';
import { COORDINATION_ITEM_KEYS as keys, COORDINATION_MANUAL_NOTE, COORDINATION_SCENARIO as scenario } from '../../src/core/coordination-sample';
import { buildChangeSet, editItem, resolveChangeSet } from '../../src/core/engine';

const source = (id: string, text: string, target: string | null = null): Source => ({
  id, text, title: '합성 미팅 자료', relation: target ? 'correction' : 'initial', targetSourceId: target,
  hash: `hash-${id}`, createdAt: '2026-09-14T00:00:00.000Z',
});
const item = (snapshot: Snapshot, id: string) => snapshot.blocks.flatMap((block) => block.items).find((entry) => entry.id === id);
function setup() {
  const initial = source('initial', scenario.initialText);
  const change = buildChangeSet({ snapshot: emptySnapshot(), sources: [initial], draft: scenario.initialDraft(initial.id), baseRevision: 0, baseSourceRevision: 1, id: 'initial-cs' });
  const snapshot = scenario.prepareInitialSnapshot(resolveChangeSet(change, emptySnapshot(), []));
  const correction = source('correction', scenario.updateText, initial.id);
  const pending = buildChangeSet({ snapshot, sources: [initial, correction], draft: scenario.updateDraft(correction.id), baseRevision: 1, baseSourceRevision: 2, id: 'update-cs' });
  return { initial, correction, snapshot, pending };
}

describe('corporate meeting preparation sample', () => {
  it('creates useful initial work with exact evidence and explicit synthetic user settings', () => {
    const { initial, snapshot } = setup();
    for (const fact of snapshot.facts) {
      expect(initial.text.slice(fact.evidence.start, fact.evidence.end)).toBe(fact.evidence.quote);
    }
    expect(item(snapshot, keys.materials)).toMatchObject({ edited: false, preparation: { version: 1, dueDate: '2026-09-17', durationMinutes: 90 } });
    expect(item(snapshot, keys.briefing)).toMatchObject({ locked: true, value: '2026-09-18 13:00' });
    expect(item(snapshot, keys.print)?.completed).toBe(true);
    expect(item(snapshot, keys.message)?.value).toBe(COORDINATION_MANUAL_NOTE);
  });

  it('requires both real decisions before applying changed meeting and preparation requirements', () => {
    const { snapshot, pending, correction } = setup();
    expect(pending.conflicts.map((conflict) => conflict.kind).sort()).toEqual(['deletion', 'locked']);
    expect(() => resolveChangeSet(pending, snapshot, [])).toThrow();
    for (const fact of pending.next.facts.filter((entry) => entry.evidence.sourceId === correction.id)) {
      expect(correction.text.slice(fact.evidence.start, fact.evidence.end)).toBe(fact.evidence.quote);
    }
  });

  for (const keepBriefing of [true, false]) for (const keepPrint of [true, false]) {
    it(`preserves preparation and manual notes when briefing=${keepBriefing}, completed print=${keepPrint}`, () => {
      const { snapshot, pending } = setup();
      const before = structuredClone(snapshot);
      const resolved = resolveChangeSet(pending, snapshot, pending.conflicts.map((conflict) => ({
        conflictId: conflict.id,
        choice: (conflict.kind === 'locked' ? keepBriefing : keepPrint) ? 'keep_user' as const : 'use_source' as const,
      })));
      expect(item(resolved, keys.meeting)?.value).toBe('2026-09-18 16:00 · 별관 2층');
      expect(item(resolved, keys.briefing)?.value).toBe(keepBriefing ? '2026-09-18 13:00' : '2026-09-18 15:00');
      expect(Boolean(item(resolved, keys.print))).toBe(keepPrint);
      expect(item(resolved, keys.materials)).toMatchObject({ value: '2026-09-16 18:00까지 발표자료 정리', preparation: { version: 1, dueDate: '2026-09-17', durationMinutes: 90 }, stale: true });
      expect(item(resolved, keys.message)).toMatchObject({ value: COORDINATION_MANUAL_NOTE, edited: true, stale: true });
      expect(snapshot).toEqual(before);
    });
  }

  it('keeps preparation review stale when a locked prepared item accepts the source value', () => {
    const { initial, correction, snapshot } = setup();
    const lockedPrepared = editItem(snapshot, {
      baseRevision: 1,
      requestId: '00000000-0000-4000-8000-000000000601',
      itemId: keys.materials,
      locked: true,
    });
    const pending = buildChangeSet({ snapshot: lockedPrepared, sources: [initial, correction], draft: scenario.updateDraft(correction.id), baseRevision: 2, baseSourceRevision: 2 });
    const materialConflict = pending.conflicts.find((conflict) => conflict.itemId === keys.materials);

    expect(materialConflict?.kind).toBe('locked');
    const resolved = resolveChangeSet(pending, lockedPrepared, pending.conflicts.map((conflict) => ({
      conflictId: conflict.id,
      choice: conflict.id === materialConflict?.id ? 'use_source' as const : 'keep_user' as const,
    })));

    expect(item(resolved, keys.materials)).toMatchObject({
      value: '2026-09-16 18:00까지 발표자료 정리',
      preparation: { version: 1, dueDate: '2026-09-17', durationMinutes: 90 },
      stale: true,
    });
  });

  it('keeps preparation review stale when a source conflict is resolved to the new source', () => {
    const { initial, snapshot } = setup();
    const addition: Source = { ...source('addition', '추가 합성 안내입니다. 발표자료 마감은 2026-09-16 18:00입니다.'), relation: 'addition' };
    const draft = {
      schemaVersion: 2 as const,
      summary: '추가 안내의 발표자료 마감 충돌을 검토합니다.',
      questions: [],
      facts: [{
        key: 'materials_due',
        label: '발표자료 마감',
        value: '2026-09-16 18:00',
        sourceId: addition.id,
        quote: '발표자료 마감은 2026-09-16 18:00입니다',
        operation: 'update' as const,
        targetFactKey: 'materials_due',
        semantic: { kind: 'date_time' as const, date: '2026-09-16', time: '18:00' },
      }],
      blocks: [{
        key: 'meeting_preparation',
        type: 'checklist' as const,
        title: '미팅 준비',
        items: [{
          key: 'prepare_materials',
          label: '발표자료 정리',
          value: '2026-09-16 18:00까지 발표자료 정리',
          factKeys: ['materials_due'],
          valueFactKey: 'materials_due',
          calculation: null,
          operation: 'update' as const,
          targetItemId: keys.materials,
        }],
      }],
      removedItems: [],
    };
    const pending = buildChangeSet({ snapshot, sources: [initial, addition], draft, baseRevision: 1, baseSourceRevision: 2 });
    const sourceConflicts = pending.conflicts.filter((conflict) => conflict.kind === 'source');

    expect(sourceConflicts.length).toBeGreaterThan(0);
    const resolved = resolveChangeSet(pending, snapshot, pending.conflicts.map((conflict) => ({
      conflictId: conflict.id,
      choice: conflict.kind === 'source' ? 'use_source' as const : 'keep_user' as const,
    })));

    expect(item(resolved, keys.materials)).toMatchObject({
      preparation: { version: 1, dueDate: '2026-09-17', durationMinutes: 90 },
      stale: true,
    });
  });
});
