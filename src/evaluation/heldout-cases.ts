import { createHash } from 'node:crypto';
import { buildChangeSet, editItem, resolveChangeSet } from '../core/engine';
import { emptySnapshot, type ProposalDraft, type Snapshot, type Source } from '../core/contracts';
import type { EvaluationCase } from './case';

type EditSeed = { itemId: string; value?: string; completed?: boolean; locked?: boolean };
type PriorUpdate = { id: string; title: string; text: string; draft: (sourceId: string) => ProposalDraft; relation?: 'correction' | 'replacement' };
type CaseSeed = {
  id: string;
  purpose: string;
  initial: { id: string; title: string; text: string; draft: (sourceId: string) => ProposalDraft };
  protectedEdits?: EditSeed[];
  prior?: PriorUpdate;
  latest: { id: string; title: string; text: string; relation?: 'addition' | 'correction' | 'replacement'; target?: 'initial' | 'prior' };
  expectation: EvaluationCase['expectation'];
};

const CREATED_AT = '2026-09-09T00:00:00.000Z';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const source = (
  id: string,
  title: string,
  text: string,
  relation: Source['relation'] = 'initial',
  targetSourceId: string | null = null,
): Source => ({ id, title, text, relation, targetSourceId, hash: sha256(text), createdAt: CREATED_AT });

const fact = (key: string, label: string, value: string | number, sourceId: string, quote: string) => ({ key, label, value, sourceId, quote });
const item = (
  key: string,
  label: string,
  value: string,
  factKeys: string[],
  valueFactKey: string | null = null,
  calculation: ProposalDraft['blocks'][number]['items'][number]['calculation'] = null,
) => ({ key, label, value, factKeys, valueFactKey, calculation });
const costShare = (key: string, label: string, totalFactKey: string, divisorFactKey: string) =>
  item(key, label, '0', [totalFactKey, divisorFactKey], totalFactKey, { kind: 'divide', totalFactKey, divisorFactKey });

const buildBaseline = (seed: CaseSeed): { snapshot: Snapshot; sources: Source[] } => {
  const initial = source(seed.initial.id, seed.initial.title, seed.initial.text);
  let sources = [initial];
  let snapshot = emptySnapshot();
  snapshot = resolveChangeSet(
    buildChangeSet({
      snapshot,
      sources,
      draft: seed.initial.draft(initial.id),
      baseRevision: 0,
      baseSourceRevision: sources.length,
      id: `seed:${seed.id}:initial`,
      now: CREATED_AT,
    }),
    snapshot,
    [],
  );

  if (seed.prior) {
    const prior = source(seed.prior.id, seed.prior.title, seed.prior.text, seed.prior.relation ?? 'correction', initial.id);
    sources = [...sources, prior];
    snapshot = resolveChangeSet(
      buildChangeSet({
        snapshot,
        sources,
        draft: seed.prior.draft(prior.id),
        baseRevision: 1,
        baseSourceRevision: sources.length,
        id: `seed:${seed.id}:prior`,
        now: CREATED_AT,
      }),
      snapshot,
      [],
    );
  }

  for (const edit of seed.protectedEdits ?? []) {
    snapshot = editItem(snapshot, { ...edit, baseRevision: 2, requestId: '00000000-0000-4000-8000-000000000001' });
  }

  const targetSourceId = seed.latest.target === 'prior' && seed.prior ? seed.prior.id : initial.id;
  const latest = source(seed.latest.id, seed.latest.title, seed.latest.text, seed.latest.relation ?? 'correction', targetSourceId);
  return { snapshot, sources: [...sources, latest] };
};

const travelTripInitial = (sourceId: string): ProposalDraft => ({
  summary: '부산 워크숍 기본 계획입니다.',
  questions: [],
  facts: [
    fact('attendees', '참석 인원', 6, sourceId, '참석 인원은 6명입니다'),
    fact('shared_budget', '공동 예산 총액', 480000, sourceId, '공동 예산 총액은 480000원입니다'),
    fact('arrival_slot', '도착 시간', '9월 21일 14:00', sourceId, '도착 시간은 9월 21일 14:00입니다'),
  ],
  blocks: [
    { key: 'trip_schedule', type: 'schedule', title: '일정', items: [item('arrival', '도착', '9월 21일 14:00 도착', ['arrival_slot'], 'arrival_slot')] },
    { key: 'trip_cost', type: 'cost', title: '비용', items: [costShare('budget_share', '인당 공동 예산', 'shared_budget', 'attendees')] },
    { key: 'trip_checklist', type: 'checklist', title: '확인', items: [item('send_notice', '공지 발송', '참석자 6명에게 예산과 도착 시간을 공지', ['attendees', 'shared_budget', 'arrival_slot'])] },
  ],
  removedItems: [],
});

const cases: CaseSeed[] = [
  {
    id: 'heldout-busan-attendees-budget',
    purpose: '부산 워크숍 변경 공지를 기존 결정과 분리해 반영한다.',
    initial: { id: 'busan-initial', title: '부산 워크숍 원본', text: '부산 워크숍 안내입니다. 참석 인원은 6명입니다. 공동 예산 총액은 480000원입니다. 도착 시간은 9월 21일 14:00입니다.', draft: travelTripInitial },
    protectedEdits: [{ itemId: 'item:trip_checklist:send_notice', completed: true }],
    latest: { id: 'busan-update', title: '부산 워크숍 정정', text: '부산 워크숍 정정입니다. 참석 인원은 4명입니다. 공동 예산 총액은 480000원입니다.' },
    expectation: { facts: { attendees: 4, shared_budget: 480000 }, affectedFactKeys: ['attendees', 'shared_budget'], conflictExpected: false, expectedItems: { 'item:trip_cost:budget_share': '120000' } },
  },
  {
    id: 'heldout-seminar-room-deadline',
    purpose: '세미나 준비 일정에서 방 수와 마감 문자열을 같이 관리한다.',
    initial: {
      id: 'seminar-initial',
      title: '세미나 준비 원본',
      text: '세미나 준비 안내입니다. 예약 객실 수는 3개입니다. 자료 제출 마감은 10월 2일 18:00입니다. 현장 안내문은 하루 전 공유합니다.',
      draft: (sourceId) => ({
        summary: '세미나 준비 작업공간입니다.', questions: [],
        facts: [fact('room_count', '예약 객실 수', 3, sourceId, '예약 객실 수는 3개입니다'), fact('material_deadline', '자료 제출 마감', '10월 2일 18:00', sourceId, '자료 제출 마감은 10월 2일 18:00입니다')],
        blocks: [{ key: 'seminar_schedule', type: 'schedule', title: '마감', items: [item('materials', '자료 제출', '10월 2일 18:00', ['material_deadline'], 'material_deadline')] }, { key: 'seminar_note', type: 'note', title: '안내', items: [item('onsite_notice', '현장 안내문', '객실 3개 기준으로 안내문 공유', ['room_count'])] }],
        removedItems: [],
      }),
    },
    protectedEdits: [{ itemId: 'item:seminar_note:onsite_notice', value: '내 안내: 현장 담당자에게 직접 확인 후 공유' }],
    latest: { id: 'seminar-replacement', title: '세미나 준비 교체', relation: 'replacement', text: '세미나 준비 최종본입니다. 예약 객실 수는 5개입니다. 자료 제출 마감은 10월 5일 12:00입니다.' },
    expectation: { facts: { room_count: 5, material_deadline: '10월 5일 12:00' }, affectedFactKeys: ['room_count', 'material_deadline'], conflictExpected: false, expectedItems: { 'item:seminar_schedule:materials': '10월 5일 12:00' } },
  },
  {
    id: 'heldout-market-cost-share',
    purpose: '장보기 공동비를 사람 수 변경에도 계산 항목으로 유지한다.',
    initial: {
      id: 'market-initial',
      title: '장보기 원본',
      text: '장보기 계획입니다. 참여 가구 수는 4가구입니다. 공동 장보기 금액은 160000원입니다. 픽업 시간은 토요일 오전 11시입니다.',
      draft: (sourceId) => ({
        summary: '장보기 계획입니다.', questions: [],
        facts: [fact('households', '참여 가구 수', 4, sourceId, '참여 가구 수는 4가구입니다'), fact('market_total', '공동 장보기 금액', 160000, sourceId, '공동 장보기 금액은 160000원입니다'), fact('pickup_time', '픽업 시간', '토요일 오전 11시', sourceId, '픽업 시간은 토요일 오전 11시입니다')],
        blocks: [{ key: 'market_cost', type: 'cost', title: '정산', items: [costShare('household_share', '가구별 분담금', 'market_total', 'households')] }, { key: 'market_schedule', type: 'schedule', title: '픽업', items: [item('pickup', '픽업', '토요일 오전 11시', ['pickup_time'], 'pickup_time')] }],
        removedItems: [],
      }),
    },
    latest: { id: 'market-update', title: '장보기 정정', text: '장보기 정정입니다. 참여 가구 수는 5가구입니다. 공동 장보기 금액은 160000원입니다.' },
    expectation: { facts: { households: 5, market_total: 160000 }, affectedFactKeys: ['households', 'market_total'], conflictExpected: false, expectedItems: { 'item:market_cost:household_share': '32000' } },
  },
  {
    id: 'heldout-airport-arrival-string',
    purpose: '공항 픽업 도착 문구 변경을 비용 항목과 분리한다.',
    initial: {
      id: 'airport-initial',
      title: '공항 픽업 원본',
      text: '공항 픽업 안내입니다. 입국 도착 시간은 11월 4일 08:20입니다. 차량 대수는 2대입니다. 기사님 연락은 전날 완료합니다.',
      draft: (sourceId) => ({
        summary: '공항 픽업 계획입니다.', questions: [],
        facts: [fact('flight_arrival', '입국 도착 시간', '11월 4일 08:20', sourceId, '입국 도착 시간은 11월 4일 08:20입니다'), fact('van_count', '차량 대수', 2, sourceId, '차량 대수는 2대입니다')],
        blocks: [{ key: 'pickup_schedule', type: 'schedule', title: '픽업', items: [item('flight_arrival', '입국 도착', '11월 4일 08:20', ['flight_arrival'], 'flight_arrival')] }, { key: 'pickup_checklist', type: 'checklist', title: '확인', items: [item('driver_call', '기사 연락', '전날 차량 2대 기사에게 연락', ['van_count'])] }],
        removedItems: [],
      }),
    },
    protectedEdits: [{ itemId: 'item:pickup_checklist:driver_call', completed: true }],
    latest: { id: 'airport-update', title: '공항 픽업 정정', text: '공항 픽업 정정입니다. 입국 도착 시간은 11월 4일 09:10입니다.' },
    expectation: { facts: { flight_arrival: '11월 4일 09:10' }, affectedFactKeys: ['flight_arrival'], conflictExpected: false, expectedItems: { 'item:pickup_schedule:flight_arrival': '11월 4일 09:10' } },
  },
  {
    id: 'heldout-capstone-deadline-extension',
    purpose: '캡스톤 과제 마감 연장을 작업 체크리스트와 연결한다.',
    initial: {
      id: 'capstone-initial',
      title: '캡스톤 공지 원본',
      text: '캡스톤 공지입니다. 최종 보고서 마감은 12월 1일 23:59입니다. 제출 팀 수는 8팀입니다. 데모 영상 링크를 함께 제출합니다.',
      draft: (sourceId) => ({
        summary: '캡스톤 제출 계획입니다.', questions: [],
        facts: [fact('final_deadline', '최종 보고서 마감', '12월 1일 23:59', sourceId, '최종 보고서 마감은 12월 1일 23:59입니다'), fact('team_count', '제출 팀 수', 8, sourceId, '제출 팀 수는 8팀입니다')],
        blocks: [{ key: 'capstone_schedule', type: 'schedule', title: '마감', items: [item('final_report', '최종 보고서', '12월 1일 23:59', ['final_deadline'], 'final_deadline')] }, { key: 'capstone_checklist', type: 'checklist', title: '제출물', items: [item('demo_video', '데모 영상 링크', '데모 영상 링크 제출', ['final_deadline'])] }],
        removedItems: [],
      }),
    },
    protectedEdits: [{ itemId: 'item:capstone_checklist:demo_video', completed: true }],
    latest: { id: 'capstone-update', title: '캡스톤 정정', text: '캡스톤 정정 공지입니다. 최종 보고서 마감은 12월 8일 23:59입니다.' },
    expectation: { facts: { final_deadline: '12월 8일 23:59' }, affectedFactKeys: ['final_deadline'], conflictExpected: false, expectedItems: { 'item:capstone_schedule:final_report': '12월 8일 23:59' } },
  },
  {
    id: 'heldout-locked-client-dinner',
    purpose: '사용자가 잠근 저녁 약속과 원문 정정을 명시적 충돌로 분리한다.',
    initial: {
      id: 'client-initial',
      title: '고객 미팅 원본',
      text: '고객 미팅 안내입니다. 저녁 미팅 시간은 금요일 19:00입니다. 참가자는 3명입니다. 식당 예약금은 90000원입니다.',
      draft: (sourceId) => ({
        summary: '고객 미팅 계획입니다.', questions: [],
        facts: [fact('dinner_time', '저녁 미팅 시간', '금요일 19:00', sourceId, '저녁 미팅 시간은 금요일 19:00입니다'), fact('client_people', '참가자', 3, sourceId, '참가자는 3명입니다'), fact('deposit_total', '식당 예약금', 90000, sourceId, '식당 예약금은 90000원입니다')],
        blocks: [{ key: 'client_schedule', type: 'schedule', title: '일정', items: [item('dinner', '저녁 미팅', '금요일 19:00', ['dinner_time'], 'dinner_time')] }, { key: 'client_cost', type: 'cost', title: '예약금', items: [costShare('deposit_share', '인당 예약금', 'deposit_total', 'client_people')] }],
        removedItems: [],
      }),
    },
    protectedEdits: [{ itemId: 'item:client_schedule:dinner', locked: true }],
    latest: { id: 'client-update', title: '고객 미팅 정정', text: '고객 미팅 정정입니다. 저녁 미팅 시간은 금요일 20:30입니다.' },
    expectation: { facts: { dinner_time: '금요일 20:30' }, affectedFactKeys: ['dinner_time'], conflictExpected: true, expectedConflictItemIds: ['item:client_schedule:dinner'] },
  },
  {
    id: 'heldout-completed-item-deletion',
    purpose: '완료된 제출 항목 삭제 요청을 보호 상태 충돌로 처리한다.',
    initial: {
      id: 'audit-initial',
      title: '감사 준비 원본',
      text: '감사 준비 안내입니다. 증빙 파일 제출 마감은 9월 30일 17:00입니다. 필요한 항목은 원본 영수증과 승인 메일입니다.',
      draft: (sourceId) => ({
        summary: '감사 준비 작업공간입니다.', questions: [],
        facts: [fact('audit_deadline', '증빙 제출 마감', '9월 30일 17:00', sourceId, '증빙 파일 제출 마감은 9월 30일 17:00입니다'), fact('audit_items', '필요 항목', '원본 영수증과 승인 메일', sourceId, '필요한 항목은 원본 영수증과 승인 메일입니다')],
        blocks: [{ key: 'audit_checklist', type: 'checklist', title: '증빙', items: [item('receipt', '원본 영수증', '원본 영수증 제출', ['audit_items']), item('approval_mail', '승인 메일', '승인 메일 제출', ['audit_items'])] }],
        removedItems: [],
      }),
    },
    protectedEdits: [{ itemId: 'item:audit_checklist:approval_mail', completed: true }],
    latest: { id: 'audit-update', title: '감사 준비 정정', text: '감사 준비 정정입니다. 승인 메일 항목은 제출하지 않아도 됩니다.' },
    expectation: { facts: {}, affectedFactKeys: [], conflictExpected: true, expectedConflictItemIds: ['item:audit_checklist:approval_mail'] },
  },
  {
    id: 'heldout-edited-note-preserved-stale',
    purpose: '사용자 편집 안내문은 보존하고 근거 변경만 반영한다.',
    initial: { id: 'offsite-initial', title: '오프사이트 원본', text: '오프사이트 안내입니다. 참석 인원은 10명입니다. 셔틀 출발 시간은 월요일 07:30입니다. 간식 예산은 200000원입니다.', draft: (sourceId) => ({
      summary: '오프사이트 계획입니다.', questions: [],
      facts: [fact('offsite_people', '참석 인원', 10, sourceId, '참석 인원은 10명입니다'), fact('shuttle_departure', '셔틀 출발 시간', '월요일 07:30', sourceId, '셔틀 출발 시간은 월요일 07:30입니다'), fact('snack_budget', '간식 예산', 200000, sourceId, '간식 예산은 200000원입니다')],
      blocks: [{ key: 'offsite_schedule', type: 'schedule', title: '이동', items: [item('shuttle', '셔틀 출발', '월요일 07:30', ['shuttle_departure'], 'shuttle_departure')] }, { key: 'offsite_note', type: 'note', title: '공지', items: [item('notice', '참석자 공지', '참석자 10명에게 셔틀 출발 시간을 공지', ['offsite_people', 'shuttle_departure'])] }],
      removedItems: [],
    }) },
    protectedEdits: [{ itemId: 'item:offsite_note:notice', value: '내 안내: 부서별 리더에게 먼저 전달' }],
    latest: { id: 'offsite-update', title: '오프사이트 정정', text: '오프사이트 정정입니다. 참석 인원은 12명입니다.' },
    expectation: { facts: { offsite_people: 12 }, affectedFactKeys: ['offsite_people'], conflictExpected: false },
  },
  {
    id: 'heldout-addition-source-conflict',
    purpose: '추가 자료가 기존 사실을 뒤집을 때 자동 덮어쓰기가 아닌 source 충돌로 남긴다.',
    initial: { id: 'training-initial', title: '교육 원본', text: '교육 안내입니다. 등록 인원은 25명입니다. 교육비 총액은 750000원입니다. 시작 시간은 수요일 10:00입니다.', draft: (sourceId) => ({
      summary: '교육 운영 계획입니다.', questions: [],
      facts: [fact('registered_people', '등록 인원', 25, sourceId, '등록 인원은 25명입니다'), fact('training_total', '교육비 총액', 750000, sourceId, '교육비 총액은 750000원입니다'), fact('training_start', '시작 시간', '수요일 10:00', sourceId, '시작 시간은 수요일 10:00입니다')],
      blocks: [{ key: 'training_cost', type: 'cost', title: '정산', items: [costShare('training_share', '인당 교육비', 'training_total', 'registered_people')] }, { key: 'training_schedule', type: 'schedule', title: '일정', items: [item('start', '교육 시작', '수요일 10:00', ['training_start'], 'training_start')] }],
      removedItems: [],
    }) },
    latest: { id: 'training-addition', title: '교육 추가 메모', relation: 'addition', text: '교육 추가 메모입니다. 등록 인원은 28명입니다. 시작 시간은 수요일 10:00입니다.' },
    expectation: { facts: { registered_people: 25 }, affectedFactKeys: ['registered_people'], conflictExpected: true, expectedConflictFactKeys: ['registered_people'] },
  },
  {
    id: 'heldout-late-replacement-after-correction',
    purpose: '이미 정정된 근거를 대상으로 한 늦은 replacement를 최신 근거로 반영한다.',
    initial: { id: 'release-initial', title: '릴리스 원본', text: '릴리스 계획입니다. 배포 시간은 화요일 15:00입니다. 대상 서비스 수는 3개입니다. 검증 담당자는 플랫폼팀입니다.', draft: (sourceId) => ({
      summary: '릴리스 계획입니다.', questions: [],
      facts: [fact('release_time', '배포 시간', '화요일 15:00', sourceId, '배포 시간은 화요일 15:00입니다'), fact('service_count', '대상 서비스 수', 3, sourceId, '대상 서비스 수는 3개입니다')],
      blocks: [{ key: 'release_schedule', type: 'schedule', title: '배포', items: [item('deploy', '배포', '화요일 15:00', ['release_time'], 'release_time')] }, { key: 'release_checklist', type: 'checklist', title: '검증', items: [item('service_check', '서비스 검증', '3개 서비스 검증', ['service_count'])] }],
      removedItems: [],
    }) },
    prior: { id: 'release-correction-1', title: '릴리스 1차 정정', text: '릴리스 1차 정정입니다. 배포 시간은 화요일 16:00입니다.', draft: (sourceId) => ({
      summary: '배포 시간이 1차 정정되었습니다.', questions: [],
      facts: [fact('release_time', '배포 시간', '화요일 16:00', sourceId, '배포 시간은 화요일 16:00입니다')],
      blocks: [{ key: 'release_schedule', type: 'schedule', title: '배포', items: [item('deploy', '배포', '화요일 16:00', ['release_time'], 'release_time')] }],
      removedItems: [],
    }) },
    latest: { id: 'release-replacement-final', title: '릴리스 최종 교체', relation: 'replacement', target: 'prior', text: '릴리스 최종 교체본입니다. 배포 시간은 화요일 18:00입니다.' },
    expectation: { facts: { release_time: '화요일 18:00' }, affectedFactKeys: ['release_time'], conflictExpected: false, expectedItems: { 'item:release_schedule:deploy': '화요일 18:00' } },
  },
  {
    id: 'heldout-no-change-correction',
    purpose: '정정 공지가 기존 값과 같을 때 불필요한 작업공간 변경을 만들지 않는다.',
    initial: { id: 'ops-initial', title: '운영 점검 원본', text: '운영 점검 안내입니다. 점검 시작은 목요일 22:00입니다. 담당 인원은 2명입니다. 알림 채널은 슬랙입니다.', draft: (sourceId) => ({
      summary: '운영 점검 계획입니다.', questions: [],
      facts: [fact('maintenance_start', '점검 시작', '목요일 22:00', sourceId, '점검 시작은 목요일 22:00입니다'), fact('operator_count', '담당 인원', 2, sourceId, '담당 인원은 2명입니다')],
      blocks: [{ key: 'ops_schedule', type: 'schedule', title: '점검', items: [item('start', '점검 시작', '목요일 22:00', ['maintenance_start'], 'maintenance_start')] }, { key: 'ops_note', type: 'note', title: '알림', items: [item('channel', '알림 채널', '슬랙으로 점검 시작 알림', ['maintenance_start'])] }],
      removedItems: [],
    }) },
    latest: { id: 'ops-update', title: '운영 점검 재공지', text: '운영 점검 재공지입니다. 점검 시작은 목요일 22:00입니다. 담당 인원은 2명입니다.' },
    expectation: { facts: { maintenance_start: '목요일 22:00', operator_count: 2 }, affectedFactKeys: [], conflictExpected: false, expectedItems: { 'item:ops_schedule:start': '목요일 22:00' } },
  },
  {
    id: 'heldout-travel-numeric-ambiguity',
    purpose: '여행성 모임에서 범위로만 주어진 참석 인원은 숫자 사실로 확정하지 않고 질문해야 한다.',
    initial: { id: 'dinner-initial', title: '팀 디너 원본', text: '팀 디너 안내입니다. 예약 인원은 10명입니다. 예약금 총액은 300000원입니다. 모임 시간은 금요일 18:30입니다.', draft: (sourceId) => ({
      summary: '팀 디너 계획입니다.', questions: [],
      facts: [fact('dinner_people', '예약 인원', 10, sourceId, '예약 인원은 10명입니다'), fact('dinner_deposit', '예약금 총액', 300000, sourceId, '예약금 총액은 300000원입니다'), fact('dinner_meet_time', '모임 시간', '금요일 18:30', sourceId, '모임 시간은 금요일 18:30입니다')],
      blocks: [{ key: 'dinner_cost', type: 'cost', title: '정산', items: [costShare('deposit_share', '인당 예약금', 'dinner_deposit', 'dinner_people')] }, { key: 'dinner_schedule', type: 'schedule', title: '일정', items: [item('meet', '모임', '금요일 18:30', ['dinner_meet_time'], 'dinner_meet_time')] }],
      removedItems: [],
    }) },
    latest: { id: 'dinner-update', title: '팀 디너 애매한 정정', text: '팀 디너 정정입니다. 예약 인원은 10~12명으로 보입니다. 예약금 총액은 300000원입니다.' },
    expectation: { facts: {}, affectedFactKeys: ['dinner_people'], conflictExpected: false, expectedOutcome: 'needs_input', requireUnchangedSnapshot: true },
  },
  {
    id: 'heldout-ambiguous-budget-split',
    purpose: '여러 금액이 섞인 문장에서 총액이 불명확하면 질문으로 멈춘다.',
    initial: { id: 'swag-initial', title: '굿즈 원본', text: '굿즈 주문 안내입니다. 주문 수량은 40개입니다. 굿즈 총액은 400000원입니다. 수령 시간은 다음 주 월요일입니다.', draft: (sourceId) => ({
      summary: '굿즈 주문 계획입니다.', questions: [],
      facts: [fact('swag_count', '주문 수량', 40, sourceId, '주문 수량은 40개입니다'), fact('swag_total', '굿즈 총액', 400000, sourceId, '굿즈 총액은 400000원입니다'), fact('swag_pickup', '수령 시간', '다음 주 월요일', sourceId, '수령 시간은 다음 주 월요일입니다')],
      blocks: [{ key: 'swag_cost', type: 'cost', title: '비용', items: [costShare('unit_cost', '개당 비용', 'swag_total', 'swag_count')] }, { key: 'swag_schedule', type: 'schedule', title: '수령', items: [item('pickup', '수령', '다음 주 월요일', ['swag_pickup'], 'swag_pickup')] }],
      removedItems: [],
    }) },
    latest: { id: 'swag-update', title: '굿즈 애매한 정정', text: '굿즈 정정입니다. 인쇄비 300000원과 배송비 50000원이 보이며, 최종 굿즈 총액은 담당자가 다시 확인 중입니다.' },
    expectation: { facts: {}, affectedFactKeys: ['swag_total'], conflictExpected: false, expectedOutcome: 'needs_input', requireUnchangedSnapshot: true },
  },
  {
    id: 'heldout-source-target-mismatch',
    purpose: '다른 출처를 대상으로 한 정정은 기존 사실을 곧바로 덮어쓰지 않게 만든다.',
    initial: { id: 'venue-a-initial', title: '장소 A 원본', text: '장소 A 예약 안내입니다. 좌석 수는 30석입니다. 대관료 총액은 600000원입니다. 시작 시간은 토요일 13:00입니다.', draft: (sourceId) => ({
      summary: '장소 A 예약 계획입니다.', questions: [],
      facts: [fact('seat_count', '좌석 수', 30, sourceId, '좌석 수는 30석입니다'), fact('venue_fee', '대관료 총액', 600000, sourceId, '대관료 총액은 600000원입니다'), fact('venue_start', '시작 시간', '토요일 13:00', sourceId, '시작 시간은 토요일 13:00입니다')],
      blocks: [{ key: 'venue_cost', type: 'cost', title: '비용', items: [costShare('seat_fee', '좌석당 대관료', 'venue_fee', 'seat_count')] }, { key: 'venue_schedule', type: 'schedule', title: '일정', items: [item('start', '시작', '토요일 13:00', ['venue_start'], 'venue_start')] }],
      removedItems: [],
    }) },
    latest: { id: 'venue-b-update', title: '장소 B 정정', relation: 'addition', text: '장소 B 별도 메모입니다. 좌석 수는 35석입니다. 시작 시간은 토요일 13:00입니다.' },
    expectation: { facts: { seat_count: 30 }, affectedFactKeys: ['seat_count'], conflictExpected: true, expectedConflictFactKeys: ['seat_count'] },
  },
  {
    id: 'heldout-deliverable-existing-id-replacement',
    purpose: '기존 과제 마감은 유지하고 제출물 변경을 기존 체크리스트 ID에 반영한다.',
    initial: { id: 'mlops-initial', title: 'MLOps 과제 원본', text: 'MLOps 과제 안내입니다. 제출 마감은 11월 20일 23:59입니다. 제출물은 리포트입니다. 팀 수는 6팀입니다.', draft: (sourceId) => ({
      summary: 'MLOps 과제 계획입니다.', questions: [],
      facts: [fact('mlops_deadline', '제출 마감', '11월 20일 23:59', sourceId, '제출 마감은 11월 20일 23:59입니다'), fact('mlops_deliverable', '제출물', '리포트', sourceId, '제출물은 리포트입니다'), fact('mlops_teams', '팀 수', 6, sourceId, '팀 수는 6팀입니다')],
      blocks: [{ key: 'mlops_schedule', type: 'schedule', title: '마감', items: [item('deadline', '제출 마감', '11월 20일 23:59', ['mlops_deadline'], 'mlops_deadline')] }, { key: 'mlops_checklist', type: 'checklist', title: '제출물', items: [item('report', '리포트', '리포트 제출', ['mlops_deliverable'])] }],
      removedItems: [],
    }) },
    latest: { id: 'mlops-update', title: 'MLOps 제출물 정정', text: 'MLOps 제출물 정정입니다. 제출물은 실행 로그입니다.' },
    expectation: { facts: { mlops_deliverable: '실행 로그' }, affectedFactKeys: ['mlops_deliverable'], conflictExpected: false, expectedItems: { 'item:mlops_checklist:report': '실행 로그 제출' } },
  },
  {
    id: 'heldout-tax-currency-commas',
    purpose: '쉼표가 있는 금액 근거를 숫자 사실로 안정적으로 추출한다.',
    initial: { id: 'tax-initial', title: '세금계산서 원본', text: '세금계산서 요청입니다. 청구 건수는 2건입니다. 청구 총액은 1,200,000원입니다. 발행 마감은 9월 25일입니다.', draft: (sourceId) => ({
      summary: '세금계산서 발행 계획입니다.', questions: [],
      facts: [fact('invoice_count', '청구 건수', 2, sourceId, '청구 건수는 2건입니다'), fact('invoice_total', '청구 총액', 1200000, sourceId, '청구 총액은 1,200,000원입니다'), fact('invoice_deadline', '발행 마감', '9월 25일', sourceId, '발행 마감은 9월 25일입니다')],
      blocks: [{ key: 'invoice_cost', type: 'cost', title: '청구', items: [costShare('invoice_average', '건당 평균 청구액', 'invoice_total', 'invoice_count')] }, { key: 'invoice_schedule', type: 'schedule', title: '마감', items: [item('deadline', '발행 마감', '9월 25일', ['invoice_deadline'], 'invoice_deadline')] }],
      removedItems: [],
    }) },
    latest: { id: 'tax-update', title: '세금계산서 정정', text: '세금계산서 정정입니다. 청구 총액은 1,500,000원입니다.' },
    expectation: { facts: { invoice_total: 1500000 }, affectedFactKeys: ['invoice_total'], conflictExpected: false, expectedItems: { 'item:invoice_cost:invoice_average': '750000' } },
  },
  {
    id: 'heldout-capacity-locked-calculation',
    purpose: '잠긴 계산 결과는 사실 변경과 충돌로 노출하고 사용자 결정을 보존한다.',
    initial: { id: 'study-initial', title: '스터디 원본', text: '스터디 안내입니다. 참가자는 5명입니다. 교재 총액은 125000원입니다. 첫 모임은 일요일 15:00입니다.', draft: (sourceId) => ({
      summary: '스터디 계획입니다.', questions: [],
      facts: [fact('study_people', '참가자', 5, sourceId, '참가자는 5명입니다'), fact('book_total', '교재 총액', 125000, sourceId, '교재 총액은 125000원입니다'), fact('first_meeting', '첫 모임', '일요일 15:00', sourceId, '첫 모임은 일요일 15:00입니다')],
      blocks: [{ key: 'study_cost', type: 'cost', title: '교재비', items: [costShare('book_share', '인당 교재비', 'book_total', 'study_people')] }, { key: 'study_schedule', type: 'schedule', title: '일정', items: [item('first', '첫 모임', '일요일 15:00', ['first_meeting'], 'first_meeting')] }],
      removedItems: [],
    }) },
    protectedEdits: [{ itemId: 'item:study_cost:book_share', locked: true }],
    latest: { id: 'study-update', title: '스터디 정정', text: '스터디 정정입니다. 참가자는 4명입니다. 교재 총액은 125000원입니다.' },
    expectation: { facts: { study_people: 4, book_total: 125000 }, affectedFactKeys: ['study_people', 'book_total'], conflictExpected: true, expectedConflictItemIds: ['item:study_cost:book_share'] },
  },
];

const HELDOUT_CASES: EvaluationCase[] = cases.map((seedCase) => {
  const { snapshot, sources } = buildBaseline(seedCase);
  return {
    id: seedCase.id,
    purpose: seedCase.purpose,
    snapshot,
    sources,
    expectation: seedCase.expectation,
  };
});

/**
 * Synthetic, newly authored Korean challenge cases for live evaluation.
 * These are not statistically held out after tuning; they are fixed regression
 * probes that exercise evidence, authority, protection and ambiguity handling.
 */
export const getHeldoutCases = (): EvaluationCase[] => structuredClone(HELDOUT_CASES);
