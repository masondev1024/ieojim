import type { ProposalDraft, Snapshot } from './contracts';
import { editItem } from './engine';

export const DEPARTURE_ITEM_KEYS = {
  arrival: 'item:travel_schedule:arrival_day1',
  dinner: 'item:travel_schedule:dinner_day2',
  costShare: 'item:travel_cost:fixed_cost_share',
  shareMessage: 'item:travel_note:share_message',
  paperConfirmation: 'item:travel_checklist:paper_confirmation_print',
} as const;

export const DEPARTURE_FACT_KEYS = {
  participants: 'participants',
  fixedTotalCost: 'fixed_total_cost',
  arrivalTime: 'arrival_time_day1',
  dinnerTime: 'dinner_time_day2',
  paperConfirmationRequired: 'paper_confirmation_required',
} as const;

export const DEPARTURE_CUSTOM_SHARE_MESSAGE = '민지야, 출발 전날 다시 정리된 내용만 보고 움직이면 돼. 내가 종이 확인서는 챙겨둘게.';

export const DEPARTURE_INITIAL_TEXT =
  '합성 출발 전날 안내입니다. 참석자는 4명입니다. 공동 고정비는 총 900000원이며 참석 인원이 바뀌어도 총액은 유지됩니다. 첫날 도착 시간은 오전 10시입니다. 둘째 날 저녁 약속은 오후 7시입니다. 종이 확인서 출력 항목을 준비 체크리스트에 포함해야 합니다. 준비물 확인과 공유 안내문이 필요합니다.';

export const DEPARTURE_CORRECTION_TEXT =
  '합성 출발 전날 정정입니다. 참석자는 3명으로 변경됐습니다. 공동 고정비 총액 900000원은 그대로 유지됩니다. 첫날 도착 시간은 오후 4시로 늦어졌습니다. 둘째 날 저녁 약속은 오후 8시로 변경해야 합니다. 종이 확인서 출력 항목은 삭제해 주세요.';

const typedDraft = (draft: ProposalDraft): ProposalDraft => ({ schemaVersion: 2, ...draft });

const countFact = (sourceId: string, quote: string, value: number) => ({
  key: DEPARTURE_FACT_KEYS.participants,
  label: '참석자 수',
  value,
  sourceId,
  quote,
  operation: value === 4 ? 'create' as const : 'update' as const,
  targetFactKey: value === 4 ? null : DEPARTURE_FACT_KEYS.participants,
  semantic: { kind: 'count' as const, unit: 'person' as const },
});

const fixedTotalFact = (sourceId: string, quote: string, operation: 'create' | 'update') => ({
  key: DEPARTURE_FACT_KEYS.fixedTotalCost,
  label: '공동 고정비 총액',
  value: 900000,
  sourceId,
  quote,
  operation,
  targetFactKey: operation === 'create' ? null : DEPARTURE_FACT_KEYS.fixedTotalCost,
  semantic: { kind: 'money' as const, unit: 'KRW' as const },
});

const timeFact = (key: string, label: string, value: string, sourceId: string, quote: string, time: string, operation: 'create' | 'update') => ({
  key,
  label,
  value,
  sourceId,
  quote,
  operation,
  targetFactKey: operation === 'create' ? null : key,
  semantic: { kind: 'date_time' as const, time },
});

export const createDepartureInitialDraft = (sourceId: string): ProposalDraft => typedDraft({
  summary: '출발 전날 합성 원문으로 보호 상태가 있는 작업공간을 구성합니다.',
  questions: [],
  facts: [
    countFact(sourceId, '참석자는 4명입니다', 4),
    fixedTotalFact(sourceId, '공동 고정비는 총 900000원', 'create'),
    timeFact(DEPARTURE_FACT_KEYS.arrivalTime, '첫날 도착 시간', '오전 10시', sourceId, '첫날 도착 시간은 오전 10시입니다', '10:00', 'create'),
    timeFact(DEPARTURE_FACT_KEYS.dinnerTime, '둘째 날 저녁 약속', '오후 7시', sourceId, '둘째 날 저녁 약속은 오후 7시입니다', '19:00', 'create'),
    {
      key: DEPARTURE_FACT_KEYS.paperConfirmationRequired,
      label: '종이 확인서 준비',
      value: '종이 확인서 출력',
      sourceId,
      quote: '종이 확인서 출력 항목을 준비 체크리스트에 포함해야 합니다',
      operation: 'create',
      targetFactKey: null,
      semantic: null,
    },
  ],
  blocks: [
    {
      key: 'travel_schedule',
      type: 'schedule',
      title: '일정',
      items: [
        { key: 'arrival_day1', label: '첫날 도착', value: '오전 10시 도착', factKeys: [DEPARTURE_FACT_KEYS.arrivalTime], valueFactKey: DEPARTURE_FACT_KEYS.arrivalTime, calculation: null, operation: 'create', targetItemId: null },
        { key: 'dinner_day2', label: '둘째 날 저녁', value: '오후 7시 약속', factKeys: [DEPARTURE_FACT_KEYS.dinnerTime], valueFactKey: DEPARTURE_FACT_KEYS.dinnerTime, calculation: null, operation: 'create', targetItemId: null },
      ],
    },
    {
      key: 'travel_cost',
      type: 'cost',
      title: '비용',
      items: [
        {
          key: 'fixed_cost_share',
          label: '인당 고정비',
          value: '225000',
          factKeys: [DEPARTURE_FACT_KEYS.fixedTotalCost, DEPARTURE_FACT_KEYS.participants],
          valueFactKey: DEPARTURE_FACT_KEYS.fixedTotalCost,
          calculation: { kind: 'divide', totalFactKey: DEPARTURE_FACT_KEYS.fixedTotalCost, divisorFactKey: DEPARTURE_FACT_KEYS.participants },
          operation: 'create',
          targetItemId: null,
        },
      ],
    },
    {
      key: 'travel_checklist',
      type: 'checklist',
      title: '준비 체크리스트',
      items: [
        { key: 'confirm_arrival', label: '도착 시간 확인', value: '첫날 오전 10시 기준으로 이동 계획 확인', factKeys: [DEPARTURE_FACT_KEYS.arrivalTime], valueFactKey: DEPARTURE_FACT_KEYS.arrivalTime, calculation: null, operation: 'create', targetItemId: null },
        { key: 'collect_cost', label: '고정비 정산', value: '4명이 각 225000원씩 분담', factKeys: [DEPARTURE_FACT_KEYS.participants, DEPARTURE_FACT_KEYS.fixedTotalCost], valueFactKey: DEPARTURE_FACT_KEYS.fixedTotalCost, calculation: null, operation: 'create', targetItemId: null },
        { key: 'paper_confirmation_print', label: '종이 확인서 출력', value: '출발 전 종이 확인서 출력', factKeys: [DEPARTURE_FACT_KEYS.paperConfirmationRequired], valueFactKey: null, calculation: null, operation: 'create', targetItemId: null },
      ],
    },
    {
      key: 'travel_note',
      type: 'note',
      title: '공유 안내',
      items: [
        {
          key: 'share_message',
          label: '공유 문장',
          value: '첫날 오전 10시에 도착하고, 공동 고정비는 4명이 동일하게 나눕니다.',
          factKeys: [DEPARTURE_FACT_KEYS.arrivalTime, DEPARTURE_FACT_KEYS.participants, DEPARTURE_FACT_KEYS.fixedTotalCost],
          valueFactKey: null,
          calculation: null,
          operation: 'create',
          targetItemId: null,
        },
      ],
    },
  ],
  removedItems: [],
});

export const createDepartureCorrectionDraft = (sourceId: string): ProposalDraft => typedDraft({
  summary: '출발 전날 참석자, 도착, 저녁 시간과 완료 항목 삭제 요청을 한 번에 검토합니다.',
  questions: [],
  facts: [
    countFact(sourceId, '참석자는 3명으로 변경됐습니다', 3),
    fixedTotalFact(sourceId, '공동 고정비 총액 900000원은 그대로 유지됩니다', 'update'),
    timeFact(DEPARTURE_FACT_KEYS.arrivalTime, '첫날 도착 시간', '오후 4시', sourceId, '첫날 도착 시간은 오후 4시로 늦어졌습니다', '16:00', 'update'),
    timeFact(DEPARTURE_FACT_KEYS.dinnerTime, '둘째 날 저녁 약속', '오후 8시', sourceId, '둘째 날 저녁 약속은 오후 8시로 변경해야 합니다', '20:00', 'update'),
  ],
  blocks: [
    {
      key: 'travel_schedule',
      type: 'schedule',
      title: '일정',
      items: [
        { key: 'arrival_day1', label: '첫날 도착', value: '오후 4시 도착', factKeys: [DEPARTURE_FACT_KEYS.arrivalTime], valueFactKey: DEPARTURE_FACT_KEYS.arrivalTime, calculation: null, operation: 'update', targetItemId: DEPARTURE_ITEM_KEYS.arrival },
        { key: 'dinner_day2', label: '둘째 날 저녁', value: '오후 8시 약속', factKeys: [DEPARTURE_FACT_KEYS.dinnerTime], valueFactKey: DEPARTURE_FACT_KEYS.dinnerTime, calculation: null, operation: 'update', targetItemId: DEPARTURE_ITEM_KEYS.dinner },
      ],
    },
    {
      key: 'travel_cost',
      type: 'cost',
      title: '비용',
      items: [
        {
          key: 'fixed_cost_share',
          label: '인당 고정비',
          value: '300000',
          factKeys: [DEPARTURE_FACT_KEYS.fixedTotalCost, DEPARTURE_FACT_KEYS.participants],
          valueFactKey: DEPARTURE_FACT_KEYS.fixedTotalCost,
          calculation: { kind: 'divide', totalFactKey: DEPARTURE_FACT_KEYS.fixedTotalCost, divisorFactKey: DEPARTURE_FACT_KEYS.participants },
          operation: 'update',
          targetItemId: DEPARTURE_ITEM_KEYS.costShare,
        },
      ],
    },
    {
      key: 'travel_checklist',
      type: 'checklist',
      title: '준비 체크리스트',
      items: [
        { key: 'confirm_arrival', label: '도착 시간 확인', value: '첫날 오후 4시 기준으로 이동 계획 확인', factKeys: [DEPARTURE_FACT_KEYS.arrivalTime], valueFactKey: DEPARTURE_FACT_KEYS.arrivalTime, calculation: null, operation: 'update', targetItemId: 'item:travel_checklist:confirm_arrival' },
        { key: 'collect_cost', label: '고정비 정산', value: '3명이 각 300000원씩 분담', factKeys: [DEPARTURE_FACT_KEYS.participants, DEPARTURE_FACT_KEYS.fixedTotalCost], valueFactKey: DEPARTURE_FACT_KEYS.fixedTotalCost, calculation: null, operation: 'update', targetItemId: 'item:travel_checklist:collect_cost' },
      ],
    },
  ],
  removedItems: [{ operation: 'remove', itemId: DEPARTURE_ITEM_KEYS.paperConfirmation, sourceId, quote: '종이 확인서 출력 항목은 삭제해 주세요' }],
});

export const prepareDepartureInitialSnapshot = (snapshot: Snapshot): Snapshot => {
  const lockedDinner = editItem(snapshot, {
    baseRevision: 1,
    requestId: '00000000-0000-4000-8000-000000000101',
    itemId: DEPARTURE_ITEM_KEYS.dinner,
    locked: true,
  });
  const editedMessage = editItem(lockedDinner, {
    baseRevision: 1,
    requestId: '00000000-0000-4000-8000-000000000102',
    itemId: DEPARTURE_ITEM_KEYS.shareMessage,
    value: DEPARTURE_CUSTOM_SHARE_MESSAGE,
  });
  return editItem(editedMessage, {
    baseRevision: 1,
    requestId: '00000000-0000-4000-8000-000000000103',
    itemId: DEPARTURE_ITEM_KEYS.paperConfirmation,
    completed: true,
  });
};

export const DEPARTURE_SCENARIO = {
  title: '합성 예시: 출발 전날 변경',
  purpose: '출발 직전 여러 변경을 반영하면서 고정한 결정, 완료한 일, 직접 쓴 안내문을 안전하게 지킨다.',
  initialText: DEPARTURE_INITIAL_TEXT,
  updateText: DEPARTURE_CORRECTION_TEXT,
  conflictText: DEPARTURE_CORRECTION_TEXT,
  initialDraft: createDepartureInitialDraft,
  updateDraft: createDepartureCorrectionDraft,
  conflictDraft: createDepartureCorrectionDraft,
  prepareInitialSnapshot: prepareDepartureInitialSnapshot,
};
