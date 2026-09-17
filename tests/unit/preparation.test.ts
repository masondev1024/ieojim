import { describe, expect, it } from 'vitest';
import type { BlockItem, Snapshot } from '../../src/core/contracts';
import { getPreparationItems } from '../../src/core/preparation';

const baseItem: Pick<BlockItem, 'factKeys' | 'valueFactKey' | 'calculation' | 'completed' | 'locked' | 'edited' | 'stale'> = {
  factKeys: [],
  valueFactKey: null,
  calculation: null,
  completed: false,
  locked: false,
  edited: false,
  stale: false,
} as const;

describe('preparation projection', () => {
  it('projects every checklist item and orders items needing action first', () => {
    const snapshot: Snapshot = {
      facts: [],
      blocks: [{
        id: 'block_checklist',
        key: 'checklist',
        type: 'checklist',
        title: '미팅 준비',
        items: [
          { ...baseItem, id: 'item_done', key: 'done', label: '완료 항목', value: '완료됨', completed: true, preparation: { version: 1, dueDate: '2026-09-14', durationMinutes: 10 } },
          { ...baseItem, id: 'item_unscheduled', key: 'unscheduled', label: '미설정 항목', value: '시간 정하기' },
          { ...baseItem, id: 'item_today', key: 'today', label: '오늘 항목', value: '오늘 처리', preparation: { version: 1, dueDate: '2026-09-14', durationMinutes: 30 } },
          { ...baseItem, id: 'item_stale', key: 'stale', label: '재검토 항목', value: '변경 영향 있음', stale: true, preparation: { version: 1, dueDate: '2026-09-20', durationMinutes: 60 } },
          { ...baseItem, id: 'item_overdue', key: 'overdue', label: '지난 항목', value: '늦음', preparation: { version: 1, dueDate: '2026-09-13', durationMinutes: null } },
        ],
      }, {
        id: 'block_note',
        key: 'note',
        type: 'note',
        title: '메모',
        items: [{ ...baseItem, id: 'item_note', key: 'note', label: '메모', value: '제외', preparation: { version: 1, dueDate: '2026-09-14', durationMinutes: 5 } }],
      }],
    };

    const projected = getPreparationItems(snapshot, '2026-09-14');

    expect(projected.map((item) => [item.itemId, item.status])).toEqual([
      ['item_stale', 'needs_review'],
      ['item_overdue', 'overdue'],
      ['item_today', 'today'],
      ['item_unscheduled', 'unscheduled'],
      ['item_done', 'completed'],
    ]);
    expect(projected.find((item) => item.itemId === 'item_unscheduled')).toMatchObject({
      dueDate: null,
      durationMinutes: null,
      provenance: 'user',
    });
    expect(projected.some((item) => item.itemId === 'item_note')).toBe(false);
  });
});
