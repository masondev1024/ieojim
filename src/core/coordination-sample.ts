import type { ProposalDraft, Snapshot } from './contracts';
import { editItem } from './engine';

export const COORDINATION_ITEM_KEYS = {
  meeting: 'item:meeting_schedule:client_meeting',
  briefing: 'item:meeting_schedule:executive_briefing',
  materials: 'item:meeting_preparation:prepare_materials',
  room: 'item:meeting_preparation:confirm_room',
  print: 'item:meeting_preparation:check_print',
  message: 'item:meeting_note:attendee_draft',
} as const;

export const COORDINATION_INITIAL_TEXT = '합성 고객 미팅 안내입니다. 고객 미팅은 2026-09-18 14:00입니다. 사전 보고는 2026-09-18 13:00입니다. 발표자료 마감은 2026-09-17 18:00입니다. 장소는 본사 3층입니다. 인쇄본 확인 항목을 준비 목록에 포함합니다. 발표자료 정리와 회의실 확인, 참석자 안내 초안이 필요합니다.';
export const COORDINATION_CORRECTION_TEXT = '합성 고객 미팅 정정입니다. 고객 미팅은 2026-09-18 16:00으로 변경합니다. 사전 보고는 2026-09-18 15:00으로 변경해야 합니다. 발표자료 마감은 2026-09-16 18:00으로 앞당깁니다. 장소는 별관 2층으로 변경합니다. 인쇄본 확인 항목은 삭제해 주세요.';
export const COORDINATION_MANUAL_NOTE = '참석자에게 전달하기 전 담당자가 최종 장소와 준비 자료를 확인합니다.';

const createDraft = (sourceId: string, correction: boolean): ProposalDraft => {
  const operation = correction ? 'update' as const : 'create' as const;
  const meeting = correction ? '2026-09-18 16:00' : '2026-09-18 14:00';
  const briefing = correction ? '2026-09-18 15:00' : '2026-09-18 13:00';
  const deadline = correction ? '2026-09-16 18:00' : '2026-09-17 18:00';
  const room = correction ? '별관 2층' : '본사 3층';
  const fact = (key: string, label: string, value: string, quote: string, dateTime = false) => ({
    key, label, value, sourceId, quote, operation,
    targetFactKey: correction ? key : null,
    semantic: dateTime ? { kind: 'date_time' as const, date: value.slice(0, 10), time: value.slice(11) } : null,
  });
  const item = (blockKey: string, key: string, label: string, value: string, factKeys: string[]) => ({
    key, label, value, factKeys, valueFactKey: factKeys.length === 1 ? factKeys[0] : null,
    calculation: null, operation, targetItemId: correction ? `item:${blockKey}:${key}` : null,
  });
  return {
    schemaVersion: 2,
    summary: correction ? '미팅 시간·장소·자료 마감 변경을 검토하고, 고정 보고와 완료한 준비 삭제는 직접 선택합니다.' : '합성 미팅 안내에서 일정과 준비 업무를 정리합니다.',
    questions: [],
    facts: [
      fact('meeting_at', '고객 미팅', meeting, correction ? `고객 미팅은 ${meeting}으로 변경합니다` : `고객 미팅은 ${meeting}입니다`, true),
      fact('briefing_at', '사전 보고', briefing, correction ? `사전 보고는 ${briefing}으로 변경해야 합니다` : `사전 보고는 ${briefing}입니다`, true),
      fact('materials_due', '발표자료 마감', deadline, correction ? `발표자료 마감은 ${deadline}으로 앞당깁니다` : `발표자료 마감은 ${deadline}입니다`, true),
      fact('meeting_room', '미팅 장소', room, correction ? `장소는 ${room}으로 변경합니다` : `장소는 ${room}입니다`),
      ...(!correction ? [fact('print_required', '인쇄본 확인', '인쇄본 확인', '인쇄본 확인 항목을 준비 목록에 포함합니다')] : []),
    ],
    blocks: [
      { key: 'meeting_schedule', type: 'schedule', title: '미팅 일정', items: [
        item('meeting_schedule', 'client_meeting', '고객 미팅', `${meeting} · ${room}`, ['meeting_at', 'meeting_room']),
        item('meeting_schedule', 'executive_briefing', '사전 보고', briefing, ['briefing_at']),
      ] },
      { key: 'meeting_preparation', type: 'checklist', title: '미팅 준비', items: [
        item('meeting_preparation', 'prepare_materials', '발표자료 정리', `${deadline}까지 발표자료 정리`, ['materials_due']),
        item('meeting_preparation', 'confirm_room', '회의실 확인', `${room} 사용 가능 여부 확인`, ['meeting_room']),
        ...(!correction ? [item('meeting_preparation', 'check_print', '인쇄본 확인', '미팅 전 인쇄본 확인', ['print_required'])] : []),
      ] },
      { key: 'meeting_note', type: 'note', title: '참석자 안내 초안', items: [
        item('meeting_note', 'attendee_draft', '참석자 안내', `고객 미팅은 ${meeting}, ${room}입니다. 자료는 ${deadline}까지 준비합니다.`, ['meeting_at', 'meeting_room', 'materials_due']),
      ] },
    ],
    removedItems: correction ? [{ operation: 'remove', itemId: COORDINATION_ITEM_KEYS.print, sourceId, quote: '인쇄본 확인 항목은 삭제해 주세요' }] : [],
  };
};

export const prepareCoordinationSnapshot = (snapshot: Snapshot): Snapshot => {
  const changes = [
    { itemId: COORDINATION_ITEM_KEYS.briefing, locked: true },
    { itemId: COORDINATION_ITEM_KEYS.print, completed: true },
    { itemId: COORDINATION_ITEM_KEYS.message, value: COORDINATION_MANUAL_NOTE },
    { itemId: COORDINATION_ITEM_KEYS.materials, preparation: { version: 1 as const, dueDate: '2026-09-17', durationMinutes: 90 } },
    { itemId: COORDINATION_ITEM_KEYS.room, preparation: { version: 1 as const, dueDate: '2026-09-17', durationMinutes: 15 } },
  ];
  return changes.reduce((current, change, index) => editItem(current, {
    ...change, baseRevision: 1, requestId: `00000000-0000-4000-8000-${String(301 + index).padStart(12, '0')}`,
  }), snapshot);
};

export const COORDINATION_SCENARIO = {
  title: '합성 예시: 고객 미팅 변경',
  purpose: '미팅 안내의 일정·장소·자료 마감과 준비 업무를 정리하고, 변경 시 고정 약속·완료 기록·직접 쓴 안내와 준비 설정을 지킨다.',
  initialText: COORDINATION_INITIAL_TEXT,
  updateText: COORDINATION_CORRECTION_TEXT,
  conflictText: COORDINATION_CORRECTION_TEXT,
  initialDraft: (sourceId: string) => createDraft(sourceId, false),
  updateDraft: (sourceId: string) => createDraft(sourceId, true),
  conflictDraft: (sourceId: string) => createDraft(sourceId, true),
  prepareInitialSnapshot: prepareCoordinationSnapshot,
};
