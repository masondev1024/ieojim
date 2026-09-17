import type { ProposalDraft, Snapshot } from './contracts';
import { editItem } from './engine';
import type { SampleScenario } from './samples';
import { formatLocalMinute, parseLocalMinute, type LocalMinute, type RecoveryInput, type ScheduleEvent, type ScheduleInterval } from './scheduling-contracts';

const sourceText = '금요일 발표는 16시에서 11시로 변경됩니다. 발표자료는 오전 10시까지 제출해 주세요. 발표 장소까지 이동은 60분입니다.';
const baseRecoveryThursday: LocalMinute = '2026-09-17T14:00';
const kstOffsetMs = 9 * 60 * 60 * 1000;
const minimumFutureBufferMinutes = 24 * 60;

const evidence = (quote: string, relationId: string) => {
  const start = sourceText.indexOf(quote);
  return {
    sourceId: 'source:presentation_change',
    quote,
    start,
    end: start + quote.length,
    authority: 'source_confirmed' as const,
    relationId,
  };
};

export function createRecoveryExample(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  const base: RecoveryInput = {
    version: 1,
    requestId: 'recovery-demo-request',
    workspaceId: 'workspace:recovery-demo',
    baseRevision: 7,
    sourceRevision: 3,
    timezone: 'Asia/Seoul',
    sources: [{ id: 'source:presentation_change', text: sourceText }],
    now: '2026-09-17T14:00',
    horizon: { start: '2026-09-17T14:00', end: '2026-09-19T14:00' },
    workWindows: [
      { label: '목요일 오후', start: '2026-09-17T14:00', end: '2026-09-17T17:00' },
      { label: '금요일 근무', start: '2026-09-18T09:00', end: '2026-09-18T18:00' },
    ],
    events: [
      { id: 'event:thu_fixed_1400', itemId: 'item:recovery_schedule:event_thu_fixed_1400', title: '고정 상담', kind: 'fixed', start: '2026-09-17T14:00', end: '2026-09-17T14:30', locked: true, completed: false, evidence: [], movableWindow: null },
      { id: 'event:thu_fixed_1500', itemId: 'item:recovery_schedule:event_thu_fixed_1500', title: '거래처 확인', kind: 'fixed', start: '2026-09-17T15:00', end: '2026-09-17T15:30', locked: true, completed: false, evidence: [], movableWindow: null },
      { id: 'event:expense_admin', itemId: 'item:recovery_schedule:event_expense_admin', title: '경비 정리', kind: 'flex', start: '2026-09-17T16:00', end: '2026-09-17T16:30', locked: false, completed: false, evidence: [], movableWindow: { start: '2026-09-17T14:00', end: '2026-09-17T17:00', durationMinutes: 30 } },
      { id: 'event:personal_1700', itemId: 'item:recovery_schedule:event_personal_1700', title: '개인 고정 일정', kind: 'fixed', start: '2026-09-17T17:00', end: '2026-09-17T18:00', locked: true, completed: false, evidence: [], movableWindow: null },
      { id: 'event:fri_fixed_0900', itemId: 'item:recovery_schedule:event_fri_fixed_0900', title: '금요일 오전 고정 일정', kind: 'fixed', start: '2026-09-18T09:00', end: '2026-09-18T10:00', locked: true, completed: false, evidence: [], movableWindow: null },
      { id: 'event:presentation_travel', itemId: 'item:recovery_schedule:event_presentation_travel', title: '발표장 이동', kind: 'travel', start: '2026-09-18T15:00', end: '2026-09-18T16:00', locked: false, completed: false, evidence: [evidence('발표 장소까지 이동은 60분입니다', 'relation:travel_before')], movableWindow: null },
      { id: 'event:presentation', itemId: 'item:recovery_schedule:event_presentation', title: '금요일 발표', kind: 'presentation', start: '2026-09-18T16:00', end: '2026-09-18T17:00', locked: false, completed: false, evidence: [evidence('금요일 발표는 16시에서 11시로 변경됩니다', 'relation:time_change')], movableWindow: null },
      { id: 'event:presentation_prep', itemId: 'item:recovery_schedule:event_presentation_prep', title: '발표자료 준비', kind: 'preparation', start: '2026-09-18T13:30', end: '2026-09-18T15:00', locked: false, completed: false, evidence: [evidence('발표자료는 오전 10시까지 제출해 주세요', 'relation:deadline')], movableWindow: null },
    ],
    relations: [
      { id: 'relation:time_change', kind: 'time_change', fromEventId: 'event:presentation', toEventId: null, confirmed: true, evidence: [evidence('금요일 발표는 16시에서 11시로 변경됩니다', 'relation:time_change')] },
      { id: 'relation:deadline', kind: 'deadline', fromEventId: 'event:presentation_prep', toEventId: 'event:presentation', confirmed: true, evidence: [evidence('발표자료는 오전 10시까지 제출해 주세요', 'relation:deadline')] },
      { id: 'relation:travel_before', kind: 'travel_before', fromEventId: 'event:presentation_travel', toEventId: 'event:presentation', confirmed: true, evidence: [evidence('발표 장소까지 이동은 60분입니다', 'relation:travel_before')] },
      { id: 'relation:required_for', kind: 'required_for', fromEventId: 'event:presentation_prep', toEventId: 'event:presentation', confirmed: true, evidence: [evidence('발표자료는 오전 10시까지 제출해 주세요', 'relation:required_for')] },
    ],
    change: {
      presentationEventId: 'event:presentation',
      presentationInterval: { start: '2026-09-18T11:00', end: '2026-09-18T12:00' },
      travelEventId: 'event:presentation_travel',
      travelDurationMinutes: 60,
      preparationEventId: 'event:presentation_prep',
      preparationDurationMinutes: 90,
      preparationDeadline: '2026-09-18T10:00',
      confirmedByRelationIds: ['relation:time_change', 'relation:deadline', 'relation:travel_before', 'relation:required_for'],
    },
  };

  return { ...base, ...overrides, change: { ...base.change, ...overrides.change } };
}

export function createFutureRecoveryExample(clock: () => Date = () => new Date(), overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return createAnchoredRecoveryExample(nextFutureRecoveryThursday(clock), overrides);
}

export function createAnchoredRecoveryExample(anchorThursday1400: LocalMinute, overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  const shifted = shiftRecoveryInput(createRecoveryExample(), anchorThursday1400);
  return { ...shifted, ...overrides, change: { ...shifted.change, ...overrides.change } };
}

export function nextFutureRecoveryThursday(clock: () => Date = () => new Date()): LocalMinute {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Invalid recovery clock');
  const nowKst = new Date(now.getTime() + kstOffsetMs);
  const day = nowKst.getUTCDay();
  const date = new Date(Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate(), 14, 0));
  date.setUTCDate(date.getUTCDate() + ((4 - day + 7) % 7));
  const candidateUtcMs = date.getTime() - kstOffsetMs;
  const bufferedUtcMs = now.getTime() + minimumFutureBufferMinutes * 60_000;
  if (candidateUtcMs < bufferedUtcMs) date.setUTCDate(date.getUTCDate() + 7);
  return formatLocalMinute(Math.floor(date.getTime() / 60_000));
}

function shiftRecoveryInput(input: RecoveryInput, anchorThursday1400: LocalMinute): RecoveryInput {
  assertValidAnchor(anchorThursday1400);
  const delta = parseLocalMinute(anchorThursday1400)! - parseLocalMinute(baseRecoveryThursday)!;
  const shift = (value: LocalMinute): LocalMinute => formatLocalMinute(parseLocalMinute(value)! + delta);
  const shiftInterval = (interval: ScheduleInterval): ScheduleInterval => ({ start: shift(interval.start), end: shift(interval.end) });
  return {
    ...input,
    requestId: `recovery-demo-request-${anchorThursday1400.slice(0, 10)}`,
    now: shift(input.now),
    horizon: shiftInterval(input.horizon),
    workWindows: input.workWindows.map((window) => ({ ...window, ...shiftInterval(window) })),
    events: input.events.map((event) => ({
      ...event,
      ...shiftInterval(event),
      movableWindow: event.movableWindow ? { ...event.movableWindow, ...shiftInterval(event.movableWindow) } : null,
    })),
    change: {
      ...input.change,
      presentationInterval: shiftInterval(input.change.presentationInterval),
      preparationDeadline: shift(input.change.preparationDeadline),
    },
  };
}

function assertValidAnchor(value: LocalMinute): void {
  const minute = parseLocalMinute(value);
  if (minute === null) throw new Error('Recovery anchor must be a valid local minute.');
  if (!value.endsWith('T14:00')) throw new Error('Recovery anchor must be Thursday 14:00.');
  const kstDay = new Date(minute * 60_000).getUTCDay();
  if (kstDay !== 4) throw new Error('Recovery anchor must be Thursday 14:00.');
}

export function buildRecoveryScenario(input: RecoveryInput): SampleScenario {
  const initialText = buildInitialText(input);
  return {
    title: input.relations.some((relation) => relation.evidence.some((entry) => entry.authority === 'ai_suggested'))
      ? '합성 예시: 확인 필요한 발표 일정 수습'
      : '합성 예시: 직접 확인된 발표 일정 수습',
    purpose: '변경 안내가 발표, 이동, 준비 시간과 보호된 일정을 어떻게 연쇄적으로 바꾸는지 검증합니다.',
    initialText,
    updateText: RECOVERY_SAMPLE_SOURCE_TEXT,
    conflictText: RECOVERY_SAMPLE_SOURCE_TEXT,
    initialDraft: (sourceId) => buildInitialDraft(input, sourceId),
    updateDraft: (sourceId) => buildInitialDraft(input, sourceId),
    conflictDraft: (sourceId) => buildInitialDraft(input, sourceId),
    prepareInitialSnapshot: (snapshot) => prepareRecoverySnapshot(input, snapshot),
  };
}

export const RECOVERY_SAMPLE_SOURCE_TEXT = sourceText;

function buildInitialText(input: RecoveryInput): string {
  const lines = [
    '합성 일정 확인 조건입니다.',
    `검증 기준 시각은 ${input.now} Asia/Seoul입니다.`,
    ...input.sources.map((source) => source.text),
    `확인 조건 ${JSON.stringify(input.change)} ${JSON.stringify(input.workWindows)}`,
    ...input.events.map((event) => `${event.title} ${event.start}-${event.end}`),
  ];
  return lines.join(' ');
}

function buildInitialDraft(input: RecoveryInput, sourceId: string): ProposalDraft {
  const eventFacts = input.events.map((event) => ({
    key: factKeyForEvent(event),
    label: event.title,
    value: `${event.start}-${event.end}`,
    sourceId,
    quote: `${event.title} ${event.start}-${event.end}`,
    operation: 'create' as const,
    targetFactKey: null,
    semantic: null,
  }));
  const scheduleItems = input.events.map((event) => ({
    key: itemKeyForEvent(event),
    label: event.title,
    value: `${event.start}-${event.end}`,
    factKeys: [factKeyForEvent(event)],
    valueFactKey: factKeyForEvent(event),
    calculation: null,
    operation: 'create' as const,
    targetItemId: null,
  }));
  return {
    schemaVersion: 2,
    summary: '직접 확인한 일정 조건을 복구 엔진의 초기 상태로 구성합니다.',
    questions: [],
    facts: eventFacts,
    blocks: [
      ...[0, 16].filter((offset) => offset < scheduleItems.length).map((offset) => ({
        key: offset === 0 ? 'recovery_schedule' : 'recovery_schedule_2', type: 'schedule' as const, title: '확인된 일정', items: scheduleItems.slice(offset, offset + 16),
      })),
      { key: 'recovery_cost', type: 'cost', title: '비용 영향', items: [] },
      { key: 'recovery_checklist', type: 'checklist', title: '준비 작업', items: [{
        key: 'event_presentation_prep',
        label: '발표자료 준비',
        value: `${input.change.preparationDurationMinutes}분 연속 준비 · ${input.change.preparationDeadline} 전 완료`,
        factKeys: [factKeyForEvent(eventById(input, input.change.preparationEventId))],
        valueFactKey: null,
        calculation: null,
        operation: 'create' as const,
        targetItemId: null,
      }] },
      { key: 'recovery_note', type: 'note', title: '검토 메모', items: [{
        key: 'manual_review_note',
        label: '수동 검토',
        value: '보호된 일정과 완료된 항목은 자동 이동하지 않습니다.',
        factKeys: [],
        valueFactKey: null,
        calculation: null,
        operation: 'create' as const,
        targetItemId: null,
      }] },
    ],
    removedItems: [],
  };
}

function prepareRecoverySnapshot(input: RecoveryInput, snapshot: Snapshot): Snapshot {
  return input.events.reduce((current, event, index) => {
    const preparation = event.id === input.change.preparationEventId
      ? { version: 1 as const, dueDate: input.change.preparationDeadline.slice(0, 10), durationMinutes: input.change.preparationDurationMinutes }
      : undefined;
    let next = current;
    if (preparation) {
      next = editItem(next, {
        baseRevision: 1,
        requestId: `00000000-0000-4000-8000-${String(800 + index).padStart(12, '0')}`,
        itemId: 'item:recovery_checklist:event_presentation_prep',
        preparation,
      });
    }
    if (!event.locked && !event.completed) return next;
    return editItem(next, {
      baseRevision: 1,
      requestId: `00000000-0000-4000-8000-${String(900 + index).padStart(12, '0')}`,
      itemId: recoveryItemId(event, index),
      locked: event.locked || undefined,
      completed: event.completed || undefined,
    });
  }, snapshot);
}

function eventById(input: RecoveryInput, eventId: string): ScheduleEvent {
  const event = input.events.find((candidate) => candidate.id === eventId);
  if (!event) throw new Error(`Missing recovery event: ${eventId}`);
  return event;
}

export function recoveryItemId(event: ScheduleEvent, index: number): string {
  const blockKey = index < 16 ? 'recovery_schedule' : 'recovery_schedule_2';
  return `item:${blockKey}:${itemKeyForEvent(event)}`;
}

function itemKeyForEvent(event: ScheduleEvent): string {
  return event.id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function factKeyForEvent(event: ScheduleEvent): string {
  return `slot_${itemKeyForEvent(event)}`.slice(0, 80);
}
