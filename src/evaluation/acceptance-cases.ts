import { createHash } from 'node:crypto';
import type { Block, BlockItem, Fact, FactSemantic, Snapshot, Source } from '../core/contracts';
import { snapshotSchema, sourceSchema } from '../core/contracts';
import type { EvaluationCase } from './case';

type SourceInput = {
  id: string;
  text: string;
  title: string;
  relation: Source['relation'];
  targetSourceId: string | null;
  createdAt: string;
};

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

const source = (input: SourceInput): Source => sourceSchema.parse({
  ...input,
  hash: hashText(input.text),
});

const evidence = (sourceValue: Source, quote: string) => {
  const start = sourceValue.text.indexOf(quote);
  if (start < 0) throw new Error(`Synthetic evidence quote not found in ${sourceValue.id}: ${quote}`);
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

function travelBase(caseId: string): { initial: Source; snapshot: Snapshot } {
  const initial = source({
    id: `${caseId}-initial`,
    title: '평가 전용 합성 여행 기준 자료',
    relation: 'initial',
    targetSourceId: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    text: [
      '부산 워크숍 여행 기준안입니다.',
      '참석자는 3명입니다.',
      '숙소 체크인은 2026-10-03 15:00입니다.',
      '첫째 날 KTX 101편 출발은 2026-10-03 09:00입니다.',
      '둘째 날 저녁 식사는 2026-10-04 18:00입니다.',
      '공동 고정비 총액은 900000원입니다.',
      '여권 사본 제출은 완료 상태로 관리합니다.',
      '가족 공유 안내문은 사용자가 직접 작성합니다.',
      '요트 투어 예약은 선택 일정입니다.',
    ].join('\n'),
  });
  const facts = [
    fact('participant_count', '참석자 수', 3, initial, '참석자는 3명입니다.', { kind: 'count', unit: 'person' }),
    fact('hotel_checkin_at', '숙소 체크인', '2026-10-03 15:00', initial, '숙소 체크인은 2026-10-03 15:00입니다.', { kind: 'date_time', date: '2026-10-03', time: '15:00' }),
    fact('ktx_departure_at', 'KTX 출발', '2026-10-03 09:00', initial, '첫째 날 KTX 101편 출발은 2026-10-03 09:00입니다.', { kind: 'date_time', date: '2026-10-03', time: '09:00' }),
    fact('dinner_at', '둘째 날 저녁', '2026-10-04 18:00', initial, '둘째 날 저녁 식사는 2026-10-04 18:00입니다.', { kind: 'date_time', date: '2026-10-04', time: '18:00' }),
    fact('fixed_cost_total_krw', '공동 고정비 총액', 900000, initial, '공동 고정비 총액은 900000원입니다.', { kind: 'money', unit: 'KRW' }),
    fact('passport_copy_status', '여권 사본 제출', '완료', initial, '여권 사본 제출은 완료 상태로 관리합니다.'),
    fact('yacht_tour_status', '요트 투어 예약', '선택 일정', initial, '요트 투어 예약은 선택 일정입니다.'),
  ];
  return {
    initial,
    snapshot: snapshot(facts, [
      block('travel_schedule', 'schedule', '여행 일정', [
        item('travel_schedule', 'hotel_checkin', '숙소 체크인', '2026-10-03 15:00', ['hotel_checkin_at'], { valueFactKey: 'hotel_checkin_at' }),
        item('travel_schedule', 'ktx_departure', 'KTX 출발', '2026-10-03 09:00', ['ktx_departure_at'], { valueFactKey: 'ktx_departure_at' }),
        item('travel_schedule', 'dinner', '둘째 날 저녁', '2026-10-04 18:00', ['dinner_at'], { valueFactKey: 'dinner_at', locked: true }),
      ]),
      block('travel_cost', 'cost', '여행 비용', [
        item('travel_cost', 'share_per_person', '1인 고정비', '300000', ['fixed_cost_total_krw', 'participant_count'], {
          calculation: { kind: 'divide', totalFactKey: 'fixed_cost_total_krw', divisorFactKey: 'participant_count' },
        }),
      ]),
      block('travel_checklist', 'checklist', '여행 준비', [
        item('travel_checklist', 'passport_copy', '여권 사본 제출', '완료', ['passport_copy_status'], {
          valueFactKey: 'passport_copy_status',
          completed: true,
        }),
        item('travel_checklist', 'yacht_tour', '요트 투어 예약', '선택 일정', ['yacht_tour_status'], { valueFactKey: 'yacht_tour_status' }),
      ]),
      block('travel_note', 'note', '공유 메모', [
        item('travel_note', 'family_message', '가족 공유 안내', '내 안내: 가족에게는 개인 일정 기준으로 따로 공유합니다.', ['hotel_checkin_at'], {
          edited: true,
        }),
      ]),
    ]),
  };
}

function assignmentBase(caseId: string): { initial: Source; snapshot: Snapshot } {
  const initial = source({
    id: `${caseId}-initial`,
    title: '평가 전용 합성 과제 기준 자료',
    relation: 'initial',
    targetSourceId: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    text: [
      '데이터 플랫폼 과제 기준안입니다.',
      '최종 제출 마감은 2026-10-10 23:59입니다.',
      '제출물은 보고서와 실행 로그입니다.',
      '팀 수는 4팀입니다.',
      '채점 대상 레코드는 200건입니다.',
      '팀당 검증 레코드는 50건입니다.',
      '리허설 발표는 2026-10-08 14:00입니다.',
      '재현 스크립트 점검은 완료된 체크리스트입니다.',
      '제출 안내 문구는 사용자가 직접 수정했습니다.',
    ].join('\n'),
  });
  const facts = [
    fact('assignment_deadline_at', '최종 제출 마감', '2026-10-10 23:59', initial, '최종 제출 마감은 2026-10-10 23:59입니다.', { kind: 'date_time', date: '2026-10-10', time: '23:59' }),
    fact('deliverables', '제출물', '보고서와 실행 로그', initial, '제출물은 보고서와 실행 로그입니다.'),
    fact('team_count', '팀 수', 4, initial, '팀 수는 4팀입니다.', { kind: 'count', unit: 'team' }),
    fact('record_count', '채점 대상 레코드', 200, initial, '채점 대상 레코드는 200건입니다.', { kind: 'count', unit: 'case' }),
    fact('records_per_team', '팀당 검증 레코드', 50, initial, '팀당 검증 레코드는 50건입니다.', { kind: 'count', unit: 'case' }),
    fact('rehearsal_at', '리허설 발표', '2026-10-08 14:00', initial, '리허설 발표는 2026-10-08 14:00입니다.', { kind: 'date_time', date: '2026-10-08', time: '14:00' }),
    fact('repro_script_status', '재현 스크립트 점검', '완료', initial, '재현 스크립트 점검은 완료된 체크리스트입니다.'),
  ];
  return {
    initial,
    snapshot: snapshot(facts, [
      block('assignment_schedule', 'schedule', '과제 일정', [
        item('assignment_schedule', 'deadline', '최종 제출 마감', '2026-10-10 23:59', ['assignment_deadline_at'], { valueFactKey: 'assignment_deadline_at' }),
        item('assignment_schedule', 'rehearsal', '리허설 발표', '2026-10-08 14:00', ['rehearsal_at'], { valueFactKey: 'rehearsal_at', locked: true }),
      ]),
      block('assignment_checklist', 'checklist', '제출 준비', [
        item('assignment_checklist', 'repro_script', '재현 스크립트 점검', '완료', ['repro_script_status'], {
          valueFactKey: 'repro_script_status',
          completed: true,
        }),
      ]),
      block('assignment_cost', 'cost', '검증 분량', [
        item('assignment_cost', 'records_per_team', '팀당 검증 레코드', '50', ['records_per_team'], { valueFactKey: 'records_per_team' }),
      ]),
      block('assignment_note', 'note', '제출 메모', [
        item('assignment_note', 'submit_message', '제출 안내', '내 안내: 제출 전에 팀원 검토를 받습니다.', ['assignment_deadline_at'], {
          edited: true,
        }),
      ]),
    ]),
  };
}

export function getAcceptanceCases(): EvaluationCase[] {
  const travelConflict = travelBase('accept-travel-checkin-conflict');
  const travelCorrection = travelBase('accept-travel-checkin-correction');
  const travelDifferentEntity = travelBase('accept-travel-different-entity');
  const travelAmbiguous = travelBase('accept-travel-ambiguous');
  const travelEvidence = travelBase('accept-travel-evidence');
  const travelLocked = travelBase('accept-travel-locked');
  const travelCompleted = travelBase('accept-travel-completed');
  const travelEdited = travelBase('accept-travel-edited');
  const travelDerived = travelBase('accept-travel-derived');
  const travelDeletion = travelBase('accept-travel-deletion');
  const assignmentDeadline = assignmentBase('accept-assignment-deadline');
  const assignmentAmbiguousEntity = assignmentBase('accept-assignment-ambiguous-entity');

  return [
    {
      id: 'accept-travel-same-entity-contradictory-addition',
      purpose: '부산 워크숍 여행 변경 자료를 기존 근거와 충돌 없이 반영한다.',
      snapshot: travelConflict.snapshot,
      sources: [
        travelConflict.initial,
        source({
          id: 'accept-travel-checkin-conflict-addition',
          title: '평가 전용 합성 여행 추가 자료',
          relation: 'addition',
          targetSourceId: null,
          createdAt: '2026-09-02T09:00:00.000Z',
          text: '숙소 담당자가 같은 부산 워크숍 예약에 대해 숙소 체크인은 2026-10-03 17:00이라고 새로 알렸습니다.',
        }),
      ],
      expectation: {
        facts: { hotel_checkin_at: '2026-10-03 15:00' },
        affectedFactKeys: ['hotel_checkin_at'],
        conflictExpected: true,
        expectedConflictFactKeys: ['hotel_checkin_at'],
        expectedItems: { 'item:travel_schedule:hotel_checkin': '2026-10-03 15:00' },
        expectedOutcome: 'conflict_detected',
      },
    },
    {
      id: 'accept-travel-targeted-checkin-correction',
      purpose: '명시적으로 기준 자료를 정정하는 여행 자료를 반영한다.',
      snapshot: travelCorrection.snapshot,
      sources: [
        travelCorrection.initial,
        source({
          id: 'accept-travel-checkin-correction-source',
          title: '평가 전용 합성 여행 정정 자료',
          relation: 'correction',
          targetSourceId: travelCorrection.initial.id,
          createdAt: '2026-09-02T09:10:00.000Z',
          text: '부산 워크숍 기준안 정정입니다. 숙소 체크인은 2026-10-03 16:30으로 확정되었습니다.',
        }),
      ],
      expectation: {
        facts: { hotel_checkin_at: '2026-10-03 16:30' },
        affectedFactKeys: ['hotel_checkin_at'],
        conflictExpected: false,
        expectedItems: { 'item:travel_schedule:hotel_checkin': '2026-10-03 16:30' },
      },
    },
    {
      id: 'accept-travel-different-entity-same-attribute',
      purpose: '같은 속성명이라도 다른 교통편의 값은 기존 여행 항목에 강제 병합하지 않는다.',
      snapshot: travelDifferentEntity.snapshot,
      sources: [
        travelDifferentEntity.initial,
        source({
          id: 'accept-travel-different-entity-source',
          title: '평가 전용 합성 다른 교통편 자료',
          relation: 'addition',
          targetSourceId: null,
          createdAt: '2026-09-02T09:20:00.000Z',
          text: '별도 참고 자료입니다. 부산 시내 이동용 셔틀버스 12번 출발은 2026-10-03 09:00입니다. KTX 101편 출발 변경은 언급하지 않습니다.',
        }),
      ],
      expectation: {
        facts: {},
        affectedFactKeys: [],
        conflictExpected: false,
        expectedItems: { 'item:travel_schedule:ktx_departure': '2026-10-03 09:00' },
        requireUnchangedSnapshot: true,
        expectedOutcome: 'needs_input',
      },
    },
    {
      id: 'accept-travel-ambiguous-quantity-and-time',
      purpose: '단위와 절대 시간이 빠진 여행 변경은 작업공간을 그대로 두고 질문한다.',
      snapshot: travelAmbiguous.snapshot,
      sources: [
        travelAmbiguous.initial,
        source({
          id: 'accept-travel-ambiguous-source',
          title: '평가 전용 합성 모호한 여행 자료',
          relation: 'correction',
          targetSourceId: travelAmbiguous.initial.id,
          createdAt: '2026-09-02T09:30:00.000Z',
          text: '부산 워크숍 변경 메모입니다. 공동 고정비는 30으로 조정될 수 있고, 저녁은 다음날 늦게 만나자는 의견이 있습니다.',
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
      id: 'accept-travel-targeted-departure-evidence',
      purpose: '정정된 출발 시간은 실제 저장된 문장 근거로만 반영한다.',
      snapshot: travelEvidence.snapshot,
      sources: [
        travelEvidence.initial,
        source({
          id: 'accept-travel-departure-evidence-source',
          title: '평가 전용 합성 출발 정정 자료',
          relation: 'correction',
          targetSourceId: travelEvidence.initial.id,
          createdAt: '2026-09-02T09:40:00.000Z',
          text: '운영팀 정정 공지입니다. 첫째 날 KTX 101편 출발은 2026-10-03 08:30입니다. 버스 집결 시간은 별도 공지하지 않았습니다.',
        }),
      ],
      expectation: {
        facts: { ktx_departure_at: '2026-10-03 08:30' },
        affectedFactKeys: ['ktx_departure_at'],
        conflictExpected: false,
        expectedItems: { 'item:travel_schedule:ktx_departure': '2026-10-03 08:30' },
      },
    },
    {
      id: 'accept-travel-locked-dinner-conflict',
      purpose: '잠긴 사용자 일정은 새 근거가 있어도 자동 덮어쓰지 않는다.',
      snapshot: travelLocked.snapshot,
      sources: [
        travelLocked.initial,
        source({
          id: 'accept-travel-locked-dinner-source',
          title: '평가 전용 합성 저녁 정정 자료',
          relation: 'correction',
          targetSourceId: travelLocked.initial.id,
          createdAt: '2026-09-02T09:50:00.000Z',
          text: '식당 예약 확정 정정입니다. 둘째 날 저녁 식사는 2026-10-04 19:30입니다.',
        }),
      ],
      expectation: {
        facts: { dinner_at: '2026-10-04 19:30' },
        affectedFactKeys: ['dinner_at'],
        conflictExpected: true,
        expectedConflictItemIds: ['item:travel_schedule:dinner'],
        expectedItems: { 'item:travel_schedule:dinner': '2026-10-04 18:00' },
        expectedOutcome: 'conflict_detected',
      },
    },
    {
      id: 'accept-travel-completed-checklist-preserved',
      purpose: '완료된 체크리스트 상태는 자료 정정 중에도 보존한다.',
      snapshot: travelCompleted.snapshot,
      sources: [
        travelCompleted.initial,
        source({
          id: 'accept-travel-completed-passport-source',
          title: '평가 전용 합성 체크리스트 정정 자료',
          relation: 'correction',
          targetSourceId: travelCompleted.initial.id,
          createdAt: '2026-09-02T10:00:00.000Z',
          text: '준비물 표현 정정입니다. 여권 사본 제출은 완료 후 원본 지참 확인으로 표시합니다.',
        }),
      ],
      expectation: {
        facts: { passport_copy_status: '완료 후 원본 지참 확인' },
        affectedFactKeys: ['passport_copy_status'],
        conflictExpected: false,
        expectedItems: { 'item:travel_checklist:passport_copy': '완료 후 원본 지참 확인' },
      },
    },
    {
      id: 'accept-travel-edited-note-stale',
      purpose: '사용자가 직접 쓴 메모는 관련 근거가 바뀌어도 보존하고 검토 대상으로 남긴다.',
      snapshot: travelEdited.snapshot,
      sources: [
        travelEdited.initial,
        source({
          id: 'accept-travel-edited-note-source',
          title: '평가 전용 합성 메모 관련 정정 자료',
          relation: 'correction',
          targetSourceId: travelEdited.initial.id,
          createdAt: '2026-09-02T10:10:00.000Z',
          text: '숙소 안내 정정입니다. 숙소 체크인은 2026-10-03 14:30으로 앞당겨졌습니다.',
        }),
      ],
      expectation: {
        facts: { hotel_checkin_at: '2026-10-03 14:30' },
        affectedFactKeys: ['hotel_checkin_at'],
        conflictExpected: false,
        expectedItems: {
          'item:travel_schedule:hotel_checkin': '2026-10-03 14:30',
          'item:travel_note:family_message': '내 안내: 가족에게는 개인 일정 기준으로 따로 공유합니다.',
        },
      },
    },
    {
      id: 'accept-travel-derived-krw-count',
      purpose: '인원 수 정정은 KRW 총액 나누기 인원 계산 항목까지 갱신한다.',
      snapshot: travelDerived.snapshot,
      sources: [
        travelDerived.initial,
        source({
          id: 'accept-travel-derived-source',
          title: '평가 전용 합성 인원 정정 자료',
          relation: 'correction',
          targetSourceId: travelDerived.initial.id,
          createdAt: '2026-09-02T10:20:00.000Z',
          text: '참석자 명단 정정입니다. 참석자는 4명입니다. 공동 고정비 총액은 900000원으로 유지합니다.',
        }),
      ],
      expectation: {
        facts: { participant_count: 4, fixed_cost_total_krw: 900000 },
        affectedFactKeys: ['participant_count', 'fixed_cost_total_krw'],
        conflictExpected: false,
        expectedItems: { 'item:travel_cost:share_per_person': '225000' },
      },
    },
    {
      id: 'accept-travel-protected-deletion-conflict',
      purpose: '완료되었거나 사용자 상태가 있는 항목 삭제는 명시적 충돌로 남긴다.',
      snapshot: travelDeletion.snapshot,
      sources: [
        travelDeletion.initial,
        source({
          id: 'accept-travel-deletion-source',
          title: '평가 전용 합성 삭제 정정 자료',
          relation: 'replacement',
          targetSourceId: travelDeletion.initial.id,
          createdAt: '2026-09-02T10:30:00.000Z',
          text: '준비물 대체 공지입니다. 여권 사본 제출 항목은 이번 워크숍 준비 목록에서 제외합니다.',
        }),
      ],
      expectation: {
        facts: {},
        affectedFactKeys: ['passport_copy_status'],
        conflictExpected: true,
        expectedConflictItemIds: ['item:travel_checklist:passport_copy'],
        expectedItems: { 'item:travel_checklist:passport_copy': '완료' },
        expectedOutcome: 'conflict_detected',
      },
    },
    {
      id: 'accept-assignment-targeted-deadline-replacement',
      purpose: '과제 마감 변경도 여행 변경과 같은 근거 검증 엔진으로 처리한다.',
      snapshot: assignmentDeadline.snapshot,
      sources: [
        assignmentDeadline.initial,
        source({
          id: 'accept-assignment-deadline-source',
          title: '평가 전용 합성 과제 마감 대체 자료',
          relation: 'replacement',
          targetSourceId: assignmentDeadline.initial.id,
          createdAt: '2026-09-02T11:00:00.000Z',
          text: '강의 운영 대체 공지입니다. 최종 제출 마감은 2026-10-12 18:00입니다. 제출물은 보고서와 실행 로그입니다.',
        }),
      ],
      expectation: {
        facts: { assignment_deadline_at: '2026-10-12 18:00', deliverables: '보고서와 실행 로그' },
        affectedFactKeys: ['assignment_deadline_at', 'deliverables'],
        conflictExpected: false,
        expectedItems: { 'item:assignment_schedule:deadline': '2026-10-12 18:00' },
      },
    },
    {
      id: 'accept-assignment-different-team-ambiguous',
      purpose: '다른 반의 팀 수와 모호한 발표 시간은 현재 과제 작업공간에 병합하지 않고 질문한다.',
      snapshot: assignmentAmbiguousEntity.snapshot,
      sources: [
        assignmentAmbiguousEntity.initial,
        source({
          id: 'accept-assignment-ambiguous-entity-source',
          title: '평가 전용 합성 다른 반 자료',
          relation: 'addition',
          targetSourceId: null,
          createdAt: '2026-09-02T11:10:00.000Z',
          text: '다른 분반 참고 메모입니다. B반 팀 수는 5팀이고 리허설은 다음 주 오후로 논의 중입니다. 현재 과제 기준안의 팀 수 변경은 말하지 않습니다.',
        }),
      ],
      expectation: {
        facts: {},
        affectedFactKeys: [],
        conflictExpected: false,
        expectedItems: { 'item:assignment_cost:records_per_team': '50' },
        requireUnchangedSnapshot: true,
        expectedOutcome: 'needs_input',
      },
    },
  ];
}
