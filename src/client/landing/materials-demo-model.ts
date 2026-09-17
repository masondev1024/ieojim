import { emptySnapshot, type BlockItem, type ProposalDraft, type Snapshot, type Source } from '../../core/contracts';
import { buildChangeSet, editItem, resolveChangeSet } from '../../core/engine';

const now = '2026-09-16T00:00:00.000Z';
const keys = { review: 'item:tasks:review', appointment: 'item:events:appointment', note: 'item:notes:handoff' };
export type MaterialsChoice = 'reopen' | 'keep_completed';
export type MaterialsDemo = {
  source: string;
  before: BlockItem;
  after: BlockItem;
  meeting: { before: string; after: string };
  protectedAppointment: BlockItem;
  note: BlockItem;
  review: (choice: MaterialsChoice) => BlockItem;
};
const textFor = (changed: boolean) => changed
  ? '발표는 2026-09-24 11:00입니다. 발표 자료는 수정본입니다. 자료 검토 마감은 2026-09-23 18:00입니다.'
  : '발표는 2026-09-24 14:00입니다. 발표 자료는 초안입니다. 자료 검토 마감은 2026-09-24 12:00입니다. 다른 고객과의 약속은 2026-09-24 09:00입니다.';
function draft(sourceId: string, changed: boolean): ProposalDraft {
  const operation = changed ? 'update' as const : 'create' as const;
  const meeting = changed ? '2026-09-24 11:00' : '2026-09-24 14:00';
  const materials = changed ? '수정본' : '초안';
  const due = changed ? '2026-09-23 18:00' : '2026-09-24 12:00';
  const fact = (key: string, label: string, value: string, quote: string, dateTime = false) => ({
    key, label, value, sourceId, quote, operation, targetFactKey: changed ? key : null,
    semantic: dateTime ? { kind: 'date_time' as const, date: value.slice(0, 10), time: value.slice(11) } : null,
  });
  const item = (block: string, key: string, label: string, value: string, factKeys: string[]) => ({
    key, label, value, factKeys, valueFactKey: null, calculation: null, operation, targetItemId: changed ? `item:${block}:${key}` : null,
  });
  return { schemaVersion: 2, summary: '발표 시간과 자료 변경', questions: [], removedItems: [],
    facts: [
      fact('presentation', '발표', meeting, `발표는 ${meeting}입니다`, true),
      fact('materials', '발표 자료', materials, `발표 자료는 ${materials}입니다`),
      fact('deadline', '자료 검토 마감', due, `자료 검토 마감은 ${due}입니다`, true),
      ...(!changed ? [fact('appointment', '다른 고객 약속', '2026-09-24 09:00', '다른 고객과의 약속은 2026-09-24 09:00입니다', true)] : []),
    ],
    blocks: [
      { key: 'events', type: 'schedule', title: '일정', items: [
        item('events', 'presentation', '발표', meeting, ['presentation']),
        ...(!changed ? [item('events', 'appointment', '다른 고객 약속', '2026-09-24 09:00', ['appointment'])] : []),
      ] },
      { key: 'tasks', type: 'checklist', title: '발표 준비', items: [item('tasks', 'review', '발표 자료 검토', `${materials} 검토 · ${due}까지`, ['materials', 'deadline'])] },
      { key: 'notes', type: 'note', title: '전달 메모', items: [item('notes', 'handoff', '내 메모', `${materials} 확인 후 담당자에게 전달`, ['materials'])] },
    ],
  };
}
function find(snapshot: Snapshot, id: string): BlockItem {
  const item = snapshot.blocks.flatMap((block) => block.items).find((entry) => entry.id === id);
  if (!item) throw new Error('자료 변경 예시의 항목을 찾을 수 없습니다.');
  return structuredClone(item);
}
async function makeSource(id: string, changed: boolean): Promise<Source> {
  const text = textFor(changed);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return { id, text, title: changed ? '발표 정정 안내' : '기존 발표 안내', hash: Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''), relation: changed ? 'correction' : 'initial', targetSourceId: changed ? 'materials_initial' : null, createdAt: now };
}
// User-triggered, memory-only execution of the production core. No model, API or persistence.
export async function createMaterialsDemo(): Promise<MaterialsDemo> {
  const source = await makeSource('materials_initial', false);
  const correction = await makeSource('materials_update', true);
  let initial = resolveChangeSet(buildChangeSet({ snapshot: emptySnapshot(), sources: [source], draft: draft(source.id, false), baseRevision: 0, baseSourceRevision: 1, now, id: 'materials_first' }), emptySnapshot(), []);
  const command = { baseRevision: 1, requestId: '00000000-0000-4000-8000-000000000901' };
  initial = editItem(initial, { ...command, itemId: keys.review, completed: true, preparation: { version: 1, dueDate: '2026-09-24', durationMinutes: 40 } });
  initial = editItem(initial, { ...command, itemId: keys.appointment, locked: true });
  initial = editItem(initial, { ...command, itemId: keys.note, value: '견적 금액은 담당자 확인 후 전달하기' });
  const change = buildChangeSet({ snapshot: initial, sources: [source, correction], draft: draft(correction.id, true), baseRevision: 1, baseSourceRevision: 2, now, id: 'materials_correction' });
  const next = resolveChangeSet(change, initial, []);
  return {
    source: correction.text, before: find(initial, keys.review), after: find(next, keys.review),
    meeting: { before: find(initial, 'item:events:presentation').value, after: find(next, 'item:events:presentation').value },
    protectedAppointment: find(next, keys.appointment), note: find(next, keys.note),
    review(choice) {
      if (choice !== 'reopen' && choice !== 'keep_completed') throw new Error('확인 방법을 선택해 주세요.');
      return find(editItem(next, { ...command, itemId: keys.review, completed: choice === 'keep_completed', acknowledgeReview: true }), keys.review);
    },
  };
}
