import type { ProposalDraft, Snapshot } from './contracts';
import { DEPARTURE_SCENARIO } from './departure-sample';
import { COORDINATION_SCENARIO } from './coordination-sample';

export type SampleScenario = {
  title: string;
  purpose: string;
  initialText: string;
  updateText: string;
  conflictText: string;
  initialDraft: (sourceId: string) => ProposalDraft;
  updateDraft: (sourceId: string) => ProposalDraft;
  conflictDraft: (sourceId: string) => ProposalDraft;
  prepareInitialSnapshot?: (snapshot: Snapshot) => Snapshot;
};

const travel: SampleScenario = {
  title: '합성 예시: 제주 가족 여행',
  purpose: '여행 안내와 비용 분담을 원문 변경에도 안전하게 관리한다.',
  initialText:
    '합성 여행 안내입니다. 참석자는 4명입니다. 공동 고정비는 총 900000원이며 참석 인원이 바뀌어도 총액은 유지됩니다. 첫날 도착 시간은 오전 10시입니다. 둘째 날 저녁 약속은 오후 7시입니다. 준비물 확인과 공유 안내문이 필요합니다.',
  updateText:
    '합성 여행 정정 안내입니다. 참석자는 3명으로 변경됐습니다. 공동 고정비 총액 900000원은 그대로 유지됩니다. 첫날 도착 시간은 오후 4시로 늦어졌습니다.',
  conflictText: '합성 여행 충돌 안내입니다. 둘째 날 저녁 약속은 오후 8시로 변경해야 합니다.',
  initialDraft: (sourceId) => ({
    summary: '합성 여행 원문으로 최초 작업공간을 구성합니다.',
    questions: [],
    facts: [
      { key: 'participants', label: '참석자 수', value: 4, sourceId, quote: '참석자는 4명입니다' },
      { key: 'fixed_total_cost', label: '공동 고정비 총액', value: 900000, sourceId, quote: '공동 고정비는 총 900000원' },
      { key: 'arrival_time_day1', label: '첫날 도착 시간', value: '오전 10시', sourceId, quote: '첫날 도착 시간은 오전 10시입니다' },
      { key: 'dinner_time_day2', label: '둘째 날 저녁 약속', value: '오후 7시', sourceId, quote: '둘째 날 저녁 약속은 오후 7시입니다' },
    ],
    blocks: [
      {
        key: 'travel_schedule',
        type: 'schedule',
        title: '일정',
        items: [
          { key: 'arrival_day1', label: '첫날 도착', value: '오전 10시 도착', factKeys: ['arrival_time_day1'], valueFactKey: 'arrival_time_day1', calculation: null },
          { key: 'dinner_day2', label: '둘째 날 저녁', value: '오후 7시 약속', factKeys: ['dinner_time_day2'], valueFactKey: 'dinner_time_day2', calculation: null },
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
            factKeys: ['fixed_total_cost', 'participants'],
            valueFactKey: 'fixed_total_cost',
            calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participants' },
          },
        ],
      },
      {
        key: 'travel_checklist',
        type: 'checklist',
        title: '준비 체크리스트',
        items: [
          { key: 'confirm_arrival', label: '도착 시간 확인', value: '첫날 오전 10시 기준으로 이동 계획 확인', factKeys: ['arrival_time_day1'], valueFactKey: 'arrival_time_day1', calculation: null },
          { key: 'collect_cost', label: '고정비 정산', value: '4명이 각 225000원씩 분담', factKeys: ['participants', 'fixed_total_cost'], valueFactKey: 'fixed_total_cost', calculation: null },
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
            factKeys: ['arrival_time_day1', 'participants', 'fixed_total_cost'],
            valueFactKey: null,
            calculation: null,
          },
        ],
      },
    ],
    removedItems: [],
  }),
  updateDraft: (sourceId) => ({
    summary: '참석자와 첫날 도착 시간이 바뀌었고 관련 비용과 안내가 영향을 받습니다.',
    questions: [],
    facts: [
      { key: 'participants', label: '참석자 수', value: 3, sourceId, quote: '참석자는 3명으로 변경됐습니다' },
      { key: 'fixed_total_cost', label: '공동 고정비 총액', value: 900000, sourceId, quote: '공동 고정비 총액 900000원은 그대로 유지됩니다' },
      { key: 'arrival_time_day1', label: '첫날 도착 시간', value: '오후 4시', sourceId, quote: '첫날 도착 시간은 오후 4시로 늦어졌습니다' },
    ],
    blocks: [
      {
        key: 'travel_schedule',
        type: 'schedule',
        title: '일정',
        items: [
          { key: 'arrival_day1', label: '첫날 도착', value: '오후 4시 도착', factKeys: ['arrival_time_day1'], valueFactKey: 'arrival_time_day1', calculation: null },
          { key: 'dinner_day2', label: '둘째 날 저녁', value: '오후 7시 약속', factKeys: ['dinner_time_day2'], valueFactKey: 'dinner_time_day2', calculation: null },
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
            factKeys: ['fixed_total_cost', 'participants'],
            valueFactKey: 'fixed_total_cost',
            calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participants' },
          },
        ],
      },
      {
        key: 'travel_checklist',
        type: 'checklist',
        title: '준비 체크리스트',
        items: [
          { key: 'confirm_arrival', label: '도착 시간 확인', value: '첫날 오후 4시 기준으로 이동 계획 확인', factKeys: ['arrival_time_day1'], valueFactKey: 'arrival_time_day1', calculation: null },
          { key: 'collect_cost', label: '고정비 정산', value: '3명이 각 300000원씩 분담', factKeys: ['participants', 'fixed_total_cost'], valueFactKey: 'fixed_total_cost', calculation: null },
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
            value: '첫날 오후 4시에 도착하고, 공동 고정비는 3명이 동일하게 나눕니다.',
            factKeys: ['arrival_time_day1', 'participants', 'fixed_total_cost'],
            valueFactKey: null,
            calculation: null,
          },
        ],
      },
    ],
    removedItems: [],
  }),
  conflictDraft: (sourceId) => ({
    summary: '고정된 둘째 날 저녁 약속과 충돌하는 변경입니다.',
    questions: [],
    facts: [{ key: 'dinner_time_day2', label: '둘째 날 저녁 약속', value: '오후 8시', sourceId, quote: '둘째 날 저녁 약속은 오후 8시로 변경해야 합니다' }],
    blocks: [
      {
        key: 'travel_schedule',
        type: 'schedule',
        title: '일정',
        items: [{ key: 'dinner_day2', label: '둘째 날 저녁', value: '오후 8시 약속', factKeys: ['dinner_time_day2'], valueFactKey: 'dinner_time_day2', calculation: null }],
      },
    ],
    removedItems: [],
  }),
};

const syllabus: SampleScenario = {
  title: '합성 예시: 데이터 공학 과제',
  purpose: '강의 계획과 과제 공지 변경을 같은 엔진으로 관리한다.',
  initialText:
    '합성 강의 공지입니다. 팀 과제 마감은 10월 3일 23:59입니다. 제출물은 보고서와 실행 로그입니다. 체크리스트에는 데이터 검증과 재현 스크립트 확인이 필요합니다.',
  updateText: '합성 강의 정정 공지입니다. 팀 과제 마감은 10월 10일 23:59로 연장됐습니다. 제출물은 보고서와 실행 로그입니다.',
  conflictText: '합성 강의 충돌 공지입니다. 재현 스크립트 확인 항목은 제출하지 않아도 됩니다.',
  initialDraft: (sourceId) => ({
    summary: '합성 강의 공지로 과제 작업공간을 구성합니다.',
    questions: [],
    facts: [
      { key: 'assignment_deadline', label: '과제 마감', value: '10월 3일 23:59', sourceId, quote: '팀 과제 마감은 10월 3일 23:59입니다' },
      { key: 'deliverables', label: '제출물', value: '보고서와 실행 로그', sourceId, quote: '제출물은 보고서와 실행 로그입니다' },
    ],
    blocks: [
      {
        key: 'assignment_schedule',
        type: 'schedule',
        title: '마감 일정',
        items: [{ key: 'deadline', label: '팀 과제 마감', value: '10월 3일 23:59', factKeys: ['assignment_deadline'], valueFactKey: 'assignment_deadline', calculation: null }],
      },
      {
        key: 'assignment_checklist',
        type: 'checklist',
        title: '제출 체크리스트',
        items: [
          { key: 'data_validation', label: '데이터 검증', value: '제출 전 데이터 검증 완료', factKeys: ['deliverables'], valueFactKey: null, calculation: null },
          { key: 'repro_script', label: '재현 스크립트 확인', value: '실행 로그와 재현 스크립트 확인', factKeys: ['deliverables'], valueFactKey: null, calculation: null },
        ],
      },
      {
        key: 'assignment_note',
        type: 'note',
        title: '제출 안내',
        items: [{ key: 'submit_message', label: '안내 문장', value: '보고서와 실행 로그를 10월 3일 23:59까지 제출합니다.', factKeys: ['assignment_deadline', 'deliverables'], valueFactKey: null, calculation: null }],
      },
    ],
    removedItems: [],
  }),
  updateDraft: (sourceId) => ({
    summary: '마감일이 연장되어 일정과 안내 문장이 바뀝니다.',
    questions: [],
    facts: [
      { key: 'assignment_deadline', label: '과제 마감', value: '10월 10일 23:59', sourceId, quote: '팀 과제 마감은 10월 10일 23:59로 연장됐습니다' },
      { key: 'deliverables', label: '제출물', value: '보고서와 실행 로그', sourceId, quote: '제출물은 보고서와 실행 로그입니다' },
    ],
    blocks: [
      {
        key: 'assignment_schedule',
        type: 'schedule',
        title: '마감 일정',
        items: [{ key: 'deadline', label: '팀 과제 마감', value: '10월 10일 23:59', factKeys: ['assignment_deadline'], valueFactKey: 'assignment_deadline', calculation: null }],
      },
      {
        key: 'assignment_note',
        type: 'note',
        title: '제출 안내',
        items: [{ key: 'submit_message', label: '안내 문장', value: '보고서와 실행 로그를 10월 10일 23:59까지 제출합니다.', factKeys: ['assignment_deadline', 'deliverables'], valueFactKey: null, calculation: null }],
      },
    ],
    removedItems: [],
  }),
  conflictDraft: (sourceId) => ({
    summary: '사용자가 완료한 항목 삭제 시도를 검토합니다.',
    questions: [],
    facts: [],
    blocks: [],
    removedItems: [{ itemId: 'item:assignment_checklist:repro_script', sourceId, quote: '재현 스크립트 확인 항목은 제출하지 않아도 됩니다' }],
  }),
};

export const SAMPLE_SCENARIOS = { travel, syllabus, departure: DEPARTURE_SCENARIO, coordination: COORDINATION_SCENARIO } as const satisfies Record<string, SampleScenario>;

export type SampleScenarioKey = keyof typeof SAMPLE_SCENARIOS;

export const getSample = (scenario: SampleScenarioKey): SampleScenario => SAMPLE_SCENARIOS[scenario];
