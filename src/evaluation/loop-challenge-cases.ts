import { createHash } from 'node:crypto';
import { emptySnapshot, snapshotSchema, sourceSchema, type Block, type BlockItem, type Fact, type FactSemantic, type Snapshot, type Source } from '../core/contracts';
import type { EvaluationCase } from './case';

export type LoopChallengeCaseKind = 'repair_candidate' | 'human_input' | 'state_preservation';

type SourceInput = {
  id: string;
  title: string;
  text: string;
  relation?: Source['relation'];
  targetSourceId?: string | null;
  createdAt?: string;
};

const CREATED_AT = '2026-09-10T00:00:00.000Z';

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

const source = (input: SourceInput): Source => sourceSchema.parse({
  id: input.id,
  title: input.title,
  text: input.text,
  relation: input.relation ?? 'initial',
  targetSourceId: input.targetSourceId ?? null,
  hash: hashText(input.text),
  createdAt: input.createdAt ?? CREATED_AT,
});

const evidence = (sourceValue: Source, quote: string) => {
  const start = sourceValue.text.indexOf(quote);
  if (start < 0) throw new Error(`Loop challenge quote not found in ${sourceValue.id}: ${quote}`);
  return { sourceId: sourceValue.id, quote, start, end: start + quote.length };
};

const fact = (
  key: string,
  label: string,
  value: string | number,
  sourceValue: Source,
  quote: string,
  semantic?: FactSemantic | null,
): Fact => ({
  id: `fact:${key}`,
  key,
  label,
  value,
  evidence: evidence(sourceValue, quote),
  ...(semantic !== undefined ? { semantic } : {}),
});

const item = (
  blockKey: string,
  key: string,
  label: string,
  value: string,
  factKeys: string[],
  options: Partial<Pick<BlockItem, 'valueFactKey' | 'calculation' | 'completed' | 'locked' | 'edited' | 'stale'>> = {},
): BlockItem => ({
  id: `item:${blockKey}:${key}`,
  key,
  label,
  value,
  factKeys,
  valueFactKey: options.valueFactKey ?? null,
  calculation: options.calculation ?? null,
  completed: options.completed ?? false,
  locked: options.locked ?? false,
  edited: options.edited ?? false,
  stale: options.stale ?? false,
});

const block = (key: string, type: Block['type'], title: string, items: BlockItem[]): Block => ({
  id: `block:${key}`,
  key,
  type,
  title,
  items,
});

const snapshot = (facts: Fact[], blocks: Block[]): Snapshot => snapshotSchema.parse({ facts, blocks });

function coastalTripBase(caseId: string): { initial: Source; snapshot: Snapshot } {
  const initial = source({
    id: `${caseId}-initial`,
    title: '평가 전용 합성 강릉 여행 기준 자료',
    text: [
      '강릉 데이터 리트릿 기준안입니다.',
      '참석자는 6명입니다.',
      '서울역 KTX 출발은 2026-11-14 08:20입니다.',
      '숙소 체크인은 2026-11-14 15:00입니다.',
      '공동 숙박비 총액은 1200000원입니다.',
      '저녁 식사는 2026-11-14 19:00입니다.',
      '렌터카 반납은 2026-11-16 10:00입니다.',
      '여행자 보험 가입은 완료 상태입니다.',
      '가족 공유 메모는 사용자가 직접 다듬었습니다.',
    ].join('\n'),
  });
  const facts = [
    fact('traveler_count', '참석자 수', 6, initial, '참석자는 6명입니다.', { kind: 'count', unit: 'person' }),
    fact('outbound_train_at', '서울역 KTX 출발', '2026-11-14 08:20', initial, '서울역 KTX 출발은 2026-11-14 08:20입니다.', { kind: 'date_time', date: '2026-11-14', time: '08:20' }),
    fact('lodging_checkin_at', '숙소 체크인', '2026-11-14 15:00', initial, '숙소 체크인은 2026-11-14 15:00입니다.', { kind: 'date_time', date: '2026-11-14', time: '15:00' }),
    fact('lodging_total_krw', '공동 숙박비 총액', 1200000, initial, '공동 숙박비 총액은 1200000원입니다.', { kind: 'money', unit: 'KRW' }),
    fact('dinner_at', '저녁 식사', '2026-11-14 19:00', initial, '저녁 식사는 2026-11-14 19:00입니다.', { kind: 'date_time', date: '2026-11-14', time: '19:00' }),
    fact('rental_return_at', '렌터카 반납', '2026-11-16 10:00', initial, '렌터카 반납은 2026-11-16 10:00입니다.', { kind: 'date_time', date: '2026-11-16', time: '10:00' }),
    fact('insurance_status', '여행자 보험 가입', '완료', initial, '여행자 보험 가입은 완료 상태입니다.'),
  ];

  return {
    initial,
    snapshot: snapshot(facts, [
      block('coastal_schedule', 'schedule', '강릉 일정', [
        item('coastal_schedule', 'outbound_train', '서울역 KTX 출발', '2026-11-14 08:20', ['outbound_train_at'], { valueFactKey: 'outbound_train_at' }),
        item('coastal_schedule', 'lodging_checkin', '숙소 체크인', '2026-11-14 15:00', ['lodging_checkin_at'], { valueFactKey: 'lodging_checkin_at' }),
        item('coastal_schedule', 'dinner', '저녁 식사', '2026-11-14 19:00', ['dinner_at'], { valueFactKey: 'dinner_at', locked: true }),
        item('coastal_schedule', 'rental_return', '렌터카 반납', '2026-11-16 10:00', ['rental_return_at'], { valueFactKey: 'rental_return_at' }),
      ]),
      block('coastal_cost', 'cost', '강릉 비용', [
        item('coastal_cost', 'lodging_share', '1인 숙박비', '200000', ['lodging_total_krw', 'traveler_count'], {
          calculation: { kind: 'divide', totalFactKey: 'lodging_total_krw', divisorFactKey: 'traveler_count' },
        }),
      ]),
      block('coastal_checklist', 'checklist', '강릉 준비', [
        item('coastal_checklist', 'insurance', '여행자 보험 가입', '완료', ['insurance_status'], {
          valueFactKey: 'insurance_status',
          completed: true,
        }),
      ]),
      block('coastal_note', 'note', '공유 메모', [
        item('coastal_note', 'family_note', '가족 공유 메모', '내 안내: 숙소 도착 후 가족에게 따로 연락합니다.', ['lodging_checkin_at'], {
          edited: true,
        }),
      ]),
    ]),
  };
}

const emptyInitial = source({
  id: 'loop-empty-baseline-initial',
  title: '평가 전용 합성 여수 여행 최초 자료',
  text: [
    '여수 워크숍 최초 안내입니다.',
    '참석자는 4명입니다.',
    '첫 일정 집합 시간은 2026-12-02 10:00입니다.',
    '공동 교통비 총액은 480000원입니다.',
  ].join('\n'),
});

const lateInitialSource = source({
  id: 'loop-late-supersede-initial',
  title: '평가 전용 합성 강릉 체크인 기준 자료',
  text: [
    '강릉 데이터 리트릿 체크인 기준안입니다.',
    '숙소 체크인은 2026-11-14 15:00입니다.',
    '가족 공유 메모는 사용자가 직접 다듬었습니다.',
  ].join('\n'),
});
const lateInitial = {
  initial: lateInitialSource,
  snapshot: snapshot([
    fact('lodging_checkin_at', '숙소 체크인', '2026-11-14 15:00', lateInitialSource, '숙소 체크인은 2026-11-14 15:00입니다.', { kind: 'date_time', date: '2026-11-14', time: '15:00' }),
  ], [
    block('coastal_schedule', 'schedule', '강릉 일정', [
      item('coastal_schedule', 'lodging_checkin', '숙소 체크인', '2026-11-14 15:00', ['lodging_checkin_at'], { valueFactKey: 'lodging_checkin_at' }),
    ]),
    block('coastal_note', 'note', '공유 메모', [
      item('coastal_note', 'family_note', '가족 공유 메모', '내 안내: 숙소 도착 후 가족에게 따로 연락합니다.', ['lodging_checkin_at'], {
        edited: true,
      }),
    ]),
  ]),
};
const latePrior = source({
  id: 'loop-late-supersede-prior-correction',
  title: '평가 전용 합성 강릉 여행 1차 정정',
  relation: 'correction',
  targetSourceId: lateInitial.initial.id,
  createdAt: '2026-09-10T01:00:00.000Z',
  text: '강릉 데이터 리트릿 1차 정정입니다. 숙소 체크인은 2026-11-14 16:00입니다.',
});
const lateSnapshot = snapshot(
  lateInitial.snapshot.facts.map((existing) => existing.key === 'lodging_checkin_at'
    ? fact('lodging_checkin_at', '숙소 체크인', '2026-11-14 16:00', latePrior, '숙소 체크인은 2026-11-14 16:00입니다.', { kind: 'date_time', date: '2026-11-14', time: '16:00' })
    : existing),
  lateInitial.snapshot.blocks.map((existing) => existing.key === 'coastal_schedule'
    ? {
        ...existing,
        items: existing.items.map((existingItem) => existingItem.id === 'item:coastal_schedule:lodging_checkin'
          ? { ...existingItem, value: '2026-11-14 16:00' }
          : existingItem),
      }
    : existing),
);

const precisionBase = coastalTripBase('loop-integer-precision');
const ambiguousBase = coastalTripBase('loop-ambiguous-nights');
const lockedBase = coastalTripBase('loop-locked-dinner');
const additionBase = coastalTripBase('loop-addition-contradiction');

export const loopChallengeCases: EvaluationCase[] = [
  {
    id: 'loop-empty-travel-baseline',
    purpose: '빈 작업공간에서 최초 여행 자료를 근거 연결된 일정과 비용으로 구성한다.',
    snapshot: emptySnapshot(),
    sources: [emptyInitial],
    expectation: {
      facts: { yeosu_traveler_count: 4, yeosu_transport_total_krw: 480000, yeosu_gather_at: '2026-12-02 10:00' },
      affectedFactKeys: [],
      conflictExpected: false,
      expectedItems: {
        'item:yeosu_schedule:gather': '2026-12-02 10:00',
        'item:yeosu_cost:transport_share': '120000',
      },
    },
  },
  {
    id: 'loop-travel-late-replacement-targets-prior-correction',
    purpose: '이미 정정된 체크인 근거를 대상으로 한 늦은 replacement를 최신 기준으로 반영한다.',
    snapshot: lateSnapshot,
    sources: [
      lateInitial.initial,
      latePrior,
      source({
        id: 'loop-late-supersede-final-replacement',
        title: '평가 전용 합성 강릉 여행 최종 교체',
        relation: 'replacement',
        targetSourceId: latePrior.id,
        createdAt: '2026-09-10T02:00:00.000Z',
        text: '강릉 데이터 리트릿 최종 교체본입니다. 숙소 체크인은 2026-11-14 17:30입니다.',
      }),
    ],
    expectation: {
      facts: { lodging_checkin_at: '2026-11-14 17:30' },
      affectedFactKeys: ['lodging_checkin_at'],
      conflictExpected: false,
      expectedItems: {
        'item:coastal_schedule:lodging_checkin': '2026-11-14 17:30',
        'item:coastal_note:family_note': '내 안내: 숙소 도착 후 가족에게 따로 연락합니다.',
      },
    },
  },
  {
    id: 'loop-travel-comma-money-integer-share',
    purpose: '쉼표가 포함된 KRW 금액 정정을 정수 계산 항목까지 정확하게 전파한다.',
    snapshot: precisionBase.snapshot,
    sources: [
      precisionBase.initial,
      source({
        id: 'loop-integer-precision-correction',
        title: '평가 전용 합성 강릉 숙박비 정정',
        relation: 'correction',
        targetSourceId: precisionBase.initial.id,
        createdAt: '2026-09-10T01:10:00.000Z',
        text: '강릉 데이터 리트릿 숙박비 정정입니다. 공동 숙박비 총액은 1,234,560원입니다. 참석자는 6명으로 유지합니다.',
      }),
    ],
    expectation: {
      facts: { lodging_total_krw: 1234560, traveler_count: 6 },
      affectedFactKeys: ['lodging_total_krw', 'traveler_count'],
      conflictExpected: false,
      expectedItems: { 'item:coastal_cost:lodging_share': '205760' },
    },
  },
  {
    id: 'loop-travel-ambiguous-night-extension',
    purpose: '박수만 늘리라는 지시처럼 절대 체크아웃 정보가 없는 여행 변경은 질문으로 멈춘다.',
    snapshot: ambiguousBase.snapshot,
    sources: [
      ambiguousBase.initial,
      source({
        id: 'loop-ambiguous-nights-correction',
        title: '평가 전용 합성 강릉 숙박 애매한 정정',
        relation: 'correction',
        targetSourceId: ambiguousBase.initial.id,
        createdAt: '2026-09-10T01:20:00.000Z',
        text: '강릉 데이터 리트릿 숙박을 1박 더 늘려 주세요. 렌터카 반납도 그에 맞춰 조정하면 됩니다.',
      }),
    ],
    expectation: {
      facts: {},
      affectedFactKeys: [],
      conflictExpected: false,
      requireUnchangedSnapshot: true,
      expectedOutcome: 'needs_input',
    },
  },
  {
    id: 'loop-travel-locked-dinner-change-conflict',
    purpose: '사용자가 잠근 저녁 일정을 원문 정정이 바꾸려 할 때 잠금 충돌로 보존한다.',
    snapshot: lockedBase.snapshot,
    sources: [
      lockedBase.initial,
      source({
        id: 'loop-locked-dinner-correction',
        title: '평가 전용 합성 강릉 저녁 정정',
        relation: 'correction',
        targetSourceId: lockedBase.initial.id,
        createdAt: '2026-09-10T01:40:00.000Z',
        text: '강릉 데이터 리트릿 저녁 정정입니다. 저녁 식사는 2026-11-14 20:30입니다.',
      }),
    ],
    expectation: {
      facts: { dinner_at: '2026-11-14 20:30' },
      affectedFactKeys: ['dinner_at'],
      conflictExpected: true,
      expectedConflictItemIds: ['item:coastal_schedule:dinner'],
      expectedItems: { 'item:coastal_schedule:dinner': '2026-11-14 19:00' },
    },
  },
  {
    id: 'loop-travel-addition-contradicts-cost',
    purpose: '추가 자료가 현재 숙박비를 뒤집으면 자동 덮어쓰기 대신 source 충돌로 남긴다.',
    snapshot: additionBase.snapshot,
    sources: [
      additionBase.initial,
      source({
        id: 'loop-addition-contradiction-source',
        title: '평가 전용 합성 강릉 숙박비 추가 메모',
        relation: 'addition',
        targetSourceId: null,
        createdAt: '2026-09-10T01:50:00.000Z',
        text: '강릉 데이터 리트릿 추가 메모입니다. 공동 숙박비 총액은 1500000원입니다. 참석자는 6명입니다.',
      }),
    ],
    expectation: {
      facts: { lodging_total_krw: 1200000 },
      affectedFactKeys: ['lodging_total_krw'],
      conflictExpected: true,
      expectedConflictFactKeys: ['lodging_total_krw'],
      expectedItems: { 'item:coastal_cost:lodging_share': '200000' },
    },
  },
];

export const loopChallengeCaseKinds: Record<string, LoopChallengeCaseKind> = {
  'loop-empty-travel-baseline': 'repair_candidate',
  'loop-travel-late-replacement-targets-prior-correction': 'repair_candidate',
  'loop-travel-comma-money-integer-share': 'repair_candidate',
  'loop-travel-ambiguous-night-extension': 'human_input',
  'loop-travel-locked-dinner-change-conflict': 'state_preservation',
  'loop-travel-addition-contradicts-cost': 'human_input',
};
