import { createRecoveryExample, RECOVERY_SAMPLE_SOURCE_TEXT } from '../../core/schedule-recovery-sample';
import { repairSchedule } from '../../core/schedule-repair';
import { formatLocalMinute, parseLocalMinute } from '../../core/scheduling-contracts';
import type { RecoveryAction, RecoveryInput, RecoveryResult, ScheduleEvent } from '../../core/scheduling-contracts';
import type { RecoveryActionView, RecoveryDraft, RecoveryPlan, RecoveryView } from './recovery-types';

export const defaultRecoveryDraft: RecoveryDraft = {
  preparationMinutes: 90,
  submissionDeadline: '2026-09-18T10:00',
  expenseLocked: false,
  availability1430: true,
};

const confirmedConstraints = [
  '발표자료 준비는 끊기지 않는 시간으로 잡고, 제출 전에 끝내야 합니다.',
  '발표 장소 이동은 사용자가 확인한 60분입니다. 실시간 지도 추정이 아닙니다.',
  '금요일 09:00–10:00은 고정 일정이고, 10:00–11:00은 오전 발표 이동에 필요합니다.',
  '목요일 17:00 시작 개인 일정은 보호합니다.',
  '경비 정리는 30분짜리 별도 작업이며, 목요일 14:00–17:00 안에서만 옮길 수 있습니다.',
];

export const recoveryChangedNotice = RECOVERY_SAMPLE_SOURCE_TEXT;

export function createLocalRecoveryPlan(draft: RecoveryDraft, approved = false, baseInput?: RecoveryInput): RecoveryPlan {
  const input = createRecoveryInput(draft, baseInput);
  const result = repairSchedule(input);
  return planFromInputResult(input, result, { synthetic: true, applied: approved });
}

export function planFromRecoveryView(view: RecoveryView): RecoveryPlan {
  return planFromInputResult(view.input, view.result, { synthetic: false, applied: view.applied, view });
}

export function createRecoveryInput(draft: RecoveryDraft, baseInput?: RecoveryInput): RecoveryInput {
  const normalized = normalizeDraft(draft);
  const base = baseInput ?? createRecoveryExample();
  const events = base.events.filter((event) => event.id !== 'event:counterfactual_1430_busy' || event.itemId !== null || !normalized.availability1430).map((event) => {
    if (event.id === 'event:expense_admin') {
      return { ...event, locked: normalized.expenseLocked };
    }
    return { ...event };
  });
  if (!normalized.availability1430 && !events.some((event) => event.id === 'event:counterfactual_1430_busy')) {
    const thursday = base.now.slice(0, 10);
    events.push({
      id: 'event:counterfactual_1430_busy',
      itemId: null,
      title: '목요일 14:30 사용 불가',
      kind: 'busy',
      start: `${thursday}T14:30`,
      end: `${thursday}T15:00`,
      locked: true,
      completed: false,
      evidence: [],
      movableWindow: null,
    });
  }
  return {
    ...base,
    requestId: `recovery-preview-${planSignature(normalized)}`.slice(0, 100),
    events,
    change: {
      ...base.change,
      preparationDurationMinutes: normalized.preparationMinutes,
      preparationDeadline: normalized.submissionDeadline,
    },
  };
}

export function draftFromRecoveryInput(input: RecoveryInput): RecoveryDraft {
  return draftFromInput(input);
}

export function planSignature(draft: RecoveryDraft): string {
  const normalized = normalizeDraft(draft);
  return JSON.stringify(normalized);
}

export function invalidateApproval(plan: RecoveryPlan, reason: string): RecoveryPlan {
  return {
    ...plan,
    approval: { approved: false, approvedAt: null, invalidatedReason: reason },
    external: {
      calendar: plan.external.calendar === 'applied' ? 'needs_review' : plan.external.calendar,
      email: plan.external.email === 'applied' ? 'needs_review' : plan.external.email,
    },
  };
}

export function buildEmailDraft(plan: RecoveryPlan): { recipient: string; title: string; body: string } {
  if (plan.server?.origin) {
    const target = plan.input.events.find((event) => event.id === plan.input.change.presentationEventId);
    const interval = plan.input.change.presentationInterval;
    return {
      recipient: '',
      title: `${target?.title ?? '일정'} 시간 변경 확인`.slice(0, 160),
      body: [
        '안녕하세요. 일정 변경 내용을 확인했습니다.', '',
        `- 변경된 일정: ${interval.start.replace('T', ' ')}–${interval.end.replace('T', ' ')} (한국 시간)`,
        `- 준비 완료 기준: ${plan.input.change.preparationDeadline.replace('T', ' ')}`,
        '', '위 내용으로 준비하겠습니다. 감사합니다.',
      ].join('\n'),
    };
  }
  return {
    recipient: '',
    title: '금요일 발표 시간 변경 확인',
    body: [
      '안녕하세요. 발표 시간 변경 내용을 확인했습니다.',
      '',
      '- 새 발표 시간: 금요일 11:00–12:00',
      `- 자료 제출 기준: ${formatLocal(plan.input.change.preparationDeadline, plan.input)}`,
      '',
      '위 내용으로 준비하겠습니다. 감사합니다.',
    ].join('\n'),
  };
}

function planFromInputResult(input: RecoveryInput, result: RecoveryResult, options: { synthetic: boolean; applied: boolean; view?: RecoveryView }): RecoveryPlan {
  const draft = draftFromInput(input);
  const ready = result.status === 'ready';
  const before = ready ? result.before : input.events;
  const after = ready ? result.after : input.events;
  const actions = ready ? result.actions : [];
  const origin = options.view?.origin;
  const genericConstraints = [
    `변경 일정: ${input.change.presentationInterval.start.replace('T', ' ')}–${input.change.presentationInterval.end.replace('T', ' ')}`,
    `준비 시간 ${input.change.preparationDurationMinutes}분을 끊기지 않게 확보하고 ${input.change.preparationDeadline.replace('T', ' ')}까지 끝냅니다.`,
    `일정 직전에 이동 ${input.change.travelDurationMinutes}분을 확보합니다.`,
    ...input.workWindows.map((window) => `사용 가능한 시간: ${window.start.replace('T', ' ')}–${window.end.replace('T', ' ')}`),
    '사용자가 직접 확인한 시간과 관계만 기준으로 계산합니다. 원래 작업 공간이 바뀌면 다시 확인해야 합니다.',
  ];
  return {
    version: 1,
    synthetic: options.synthetic,
    timezone: input.timezone,
    noticeReceivedAt: `${input.now}:00+09:00`,
    changedNotice: origin?.noticeText ?? recoveryChangedNotice,
    draft,
    input,
    result,
    confirmedConstraints: origin ? genericConstraints : confirmedConstraints,
    before,
    after,
    movedEventIds: actions.filter((action) => action.kind === 'reschedule').map((action) => action.eventId),
    protectedEventIds: input.events.filter((event) => event.locked || event.completed).map((event) => event.id),
    feasible: ready,
    violations: ready ? [] : result.blockers.length > 0 ? result.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message, blockers: blocker.eventIds })) : [{ code: result.code, message: result.message, blockers: [] }],
    summary: {
      preparationWindow: ready ? summarizeEvent(after.find((event) => event.id === input.change.preparationEventId) ?? null, input, Boolean(origin)) : null,
      movedTask: ready ? summarizeMovedAction(actions.find((action) => action.kind === 'reschedule' && (origin ? input.events.find((event) => event.id === action.eventId)?.kind === 'flex' : action.eventId === 'event:expense_admin')) ?? null, input, Boolean(origin)) : null,
      protectedCount: ready ? result.metrics.protectedEvents : input.events.filter((event) => event.locked || event.completed).length,
      calendarActions: ready ? result.actions.filter((action) => action.kind === 'reschedule').length : 0,
      draftRecipients: origin ? [] : ['발표 담당자', '참석자'],
    },
    external: actionStatuses(options.view?.actions ?? []),
    approval: { approved: options.applied, approvedAt: options.applied ? new Date().toISOString() : null, invalidatedReason: null },
    server: options.view,
  };
}

function normalizeDraft(draft: RecoveryDraft): RecoveryDraft {
  return {
    preparationMinutes: clampInteger(draft.preparationMinutes, 1, 240),
    submissionDeadline: draft.submissionDeadline,
    expenseLocked: draft.expenseLocked,
    availability1430: draft.availability1430,
  };
}

function draftFromInput(input: RecoveryInput): RecoveryDraft {
  return {
    preparationMinutes: input.change.preparationDurationMinutes,
    submissionDeadline: input.change.preparationDeadline,
    expenseLocked: Boolean(input.events.find((event) => event.id === 'event:expense_admin')?.locked),
    availability1430: !input.events.some((event) => event.id === 'event:counterfactual_1430_busy'),
  };
}

function actionStatuses(actions: RecoveryActionView[]): RecoveryPlan['external'] {
  const calendar = latestAction(actions, 'calendar');
  const email = latestAction(actions, 'email');
  return { calendar: toExternalStatus(calendar?.status), email: toExternalStatus(email?.status) };
}

function latestAction(actions: RecoveryActionView[], kind: RecoveryActionView['kind']): RecoveryActionView | null {
  return actions.filter((action) => action.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

function toExternalStatus(status: RecoveryActionView['status'] | undefined): RecoveryPlan['external']['calendar'] {
  if (!status) return 'not_configured';
  if (status === 'queued' || status === 'executing') return 'pending';
  if (status === 'verified') return 'applied';
  if (status === 'accepted') return 'accepted';
  if (status === 'conflict' || status === 'uncertain') return 'needs_review';
  return 'failed';
}

function summarizeEvent(event: ScheduleEvent | null, input: RecoveryInput, generic = false): string | null {
  return event ? `${generic ? event.start.slice(0, 10) : dayLabel(event.start, input)} ${timeOnly(event.start)}–${generic && event.start.slice(0, 10) !== event.end.slice(0, 10) ? `${event.end.slice(0, 10)} ` : ''}${timeOnly(event.end)}` : null;
}

function summarizeMovedAction(action: RecoveryAction | null, input: RecoveryInput, generic = false): string | null {
  if (!action || action.kind !== 'reschedule') return null;
  return `${action.title}: ${generic ? action.before.start.slice(0, 10) : dayLabel(action.before.start, input)} ${timeOnly(action.before.start)}–${timeOnly(action.before.end)} → ${generic ? action.after.start.slice(0, 10) : dayLabel(action.after.start, input)} ${timeOnly(action.after.start)}–${timeOnly(action.after.end)}`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatLocal(value: string, input: RecoveryInput): string {
  return `${dayLabel(value, input)} ${timeOnly(value)}`;
}

function dayLabel(value: string, input: RecoveryInput): string {
  const firstDay = input.now.slice(0, 10);
  const secondDay = addLocalDays(input.now, 1).slice(0, 10);
  if (value.startsWith(firstDay)) return '목요일';
  if (value.startsWith(secondDay)) return '금요일';
  return value.slice(0, 10);
}

function addLocalDays(value: string, days: number): string {
  const minute = parseLocalMinute(value);
  if (minute === null) return value;
  return formatLocalMinute(minute + days * 24 * 60);
}

function timeOnly(value: string): string {
  return value.slice(11, 16);
}
