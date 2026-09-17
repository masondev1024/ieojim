import { ZodError } from 'zod';
import { analyzeScheduleImpact } from './schedule-impact';
import {
  formatLocalMinute,
  intervalMinutes,
  MAX_REPAIR_EVENTS,
  MAX_REPAIR_HORIZON_MINUTES,
  parseLocalMinute,
  recoveryInputSchema,
  type RecoveryAction,
  type RecoveryBlocker,
  type RecoveryInput,
  type RecoveryReadyResult,
  type RecoveryResult,
  type ScheduleEvent,
  type ScheduleEvidenceRef,
  type ScheduleInterval,
} from './scheduling-contracts';

type MinuteInterval = { start: number; end: number };
type Candidate = {
  prep: MinuteInterval;
  moved: { event: ScheduleEvent; interval: MinuteInterval } | null;
};

export function repairSchedule(rawInput: unknown): RecoveryResult {
  const parsed = recoveryInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  if (input.events.some((event) => event.movableWindow && event.movableWindow.durationMinutes !== intervalMinutes(event))) {
    return stop('invalid_input', 'flex_duration_mismatch', '옮길 수 있는 작업의 필요 시간이 원래 일정 길이와 맞지 않습니다. 시간을 다시 확인해 주세요.', []);
  }
  if (new Set(input.events.map((event) => event.id)).size !== input.events.length ||
      new Set(input.sources.map((source) => source.id)).size !== input.sources.length ||
      new Set(input.relations.map((relation) => relation.id)).size !== input.relations.length ||
      new Set([input.change.presentationEventId, input.change.travelEventId, input.change.preparationEventId]).size !== 3) {
    return stop('invalid_input', 'duplicate_identity', '같은 일정이나 근거가 중복되어 계산할 수 없습니다. 원문과 일정을 다시 확인해 주세요.', []);
  }
  const evidence = validateEvidence(input);
  if (evidence) return evidence;
  const scope = validateScope(input);
  if (scope) return scope;
  const missing = validateConfirmedRelations(input);
  if (missing) return missing;

  const presentation = eventById(input, input.change.presentationEventId);
  const travel = eventById(input, input.change.travelEventId);
  const preparation = eventById(input, input.change.preparationEventId);
  if (!presentation || !travel || !preparation) {
    return stop('missing_information', 'missing_target_event', '변경된 일정, 이동 시간, 준비 시간이 모두 필요합니다.', [{
      code: 'missing_target_event',
      message: '일정 조정안을 계산하려면 변경된 일정, 이동, 준비 항목을 모두 확인해야 합니다.',
      eventIds: [input.change.presentationEventId, input.change.travelEventId, input.change.preparationEventId],
    }]);
  }
  const protectedTarget = [presentation, travel, preparation].find((event) => event.locked || event.completed);
  if (protectedTarget) {
    return stop('infeasible', 'target_protected', '보호했거나 이미 완료한 항목은 자동으로 옮기지 않습니다.', [{
      code: 'target_protected',
      message: `${protectedTarget.title} 항목은 보호되었거나 완료된 상태입니다.`,
      eventIds: [protectedTarget.id],
    }]);
  }

  const presentationInterval = toMinutes(input.change.presentationInterval);
  const travelInterval = {
    start: presentationInterval.start - input.change.travelDurationMinutes,
    end: presentationInterval.start,
  };
  const deadlineMinute = parseLocalMinute(input.change.preparationDeadline);
  if (deadlineMinute === null) return stop('invalid_input', 'invalid_deadline', '제출 마감 시간을 다시 확인해 주세요.', []);
  const changedScope = validateChangedIntervals(input, [input.change.presentationInterval, fromMinutes(travelInterval)]);
  if (changedScope) return changedScope;
  if (travelInterval.start < parseLocalMinute(input.now)!) {
    return stop('infeasible', 'travel_in_past', '새 일정으로 가기 위한 이동 시간이 이미 지나갔습니다. 미래 시간으로 다시 확인해 주세요.', [{
      code: 'travel_in_past',
      message: '이동 시간이 현재 시각보다 앞에 있습니다.',
      eventIds: [travel.id],
    }]);
  }

  const impact = analyzeScheduleImpact(input);
  const movableIds = new Set(impact.movableCandidates.map((event) => event.id));
  const fixedBusy = impact.busyEvents.filter((event) => !movableIds.has(event.id));
  const busyWithNewFixed = [
    ...fixedBusy.map((event) => toMinutes(event)),
    presentationInterval,
    travelInterval,
  ];
  if (hasOverlap(presentationInterval, travelInterval)) {
    return stop('infeasible', 'new_fixed_overlap', '변경된 일정과 이동 시간이 겹칩니다.', [{
      code: 'new_fixed_overlap',
      message: '이동 시간은 일정 시작 전에 끝나야 합니다.',
      eventIds: [presentation.id, travel.id],
    }]);
  }
  if (overlapsAny(presentationInterval, fixedBusy, []) || overlapsAny(travelInterval, fixedBusy, [])) {
    return stop('infeasible', 'fixed_conflict', '변경된 일정이나 이동 시간이 보호된 일정과 겹칩니다.', [{
      code: 'fixed_conflict',
      message: '보호된 일정은 사용자가 바꾸기 전까지 그대로 둡니다.',
      eventIds: [presentation.id, travel.id],
    }]);
  }

  const candidate = findCandidate(input, busyWithNewFixed, impact.movableCandidates);
  if (!candidate) {
    return stop('infeasible', 'no_continuous_preparation_window', '현재 조건에서는 제출 전에 끊기지 않는 준비 시간을 확보할 수 없습니다.', [{
      code: 'no_continuous_preparation_window',
      message: `${input.change.preparationDurationMinutes}분 준비 시간을 사용 가능한 시간 안에서 확보하지 못했습니다.`,
      eventIds: [preparation.id],
    }]);
  }

  const ready = readyResult(input, presentation, travel, preparation, candidate, fixedBusy.length);
  const readyValidation = validateReadyResult(input, ready);
  if (!readyValidation.valid) return stop('infeasible', readyValidation.blockers[0]?.code ?? 'invalid_ready_result', '계산된 일정 조정안이 최종 확인을 통과하지 못했습니다.', readyValidation.blockers);
  return ready;
}

export function validateReadyResult(input: RecoveryInput, result: RecoveryResult): { valid: true; blockers: [] } | { valid: false; blockers: RecoveryBlocker[] } {
  if (result.status !== 'ready') return { valid: true, blockers: [] };
  const beforeById = new Map(input.events.map((event) => [event.id, event]));
  const blockers: RecoveryBlocker[] = [];
  for (const after of result.after) {
    const before = beforeById.get(after.id);
    if (!before) {
      blockers.push({ code: 'unknown_after_event', message: `${after.id}는 확인한 일정 목록에 없습니다.`, eventIds: [after.id] });
      continue;
    }
    const changed = before.start !== after.start || before.end !== after.end;
    if (changed && (before.locked || before.completed)) {
      blockers.push({ code: 'protected_event_changed', message: `${before.title} 보호 일정이 바뀌었습니다.`, eventIds: [before.id] });
    }
    if (changed && !insideAnyWorkWindow(input, toMinutes(after))) {
      blockers.push({ code: 'changed_interval_outside_work_window', message: `${before.title} 변경 시간이 사용 가능한 시간 밖입니다.`, eventIds: [before.id] });
    }
  }
  const sorted = result.after.map((event) => ({ event, interval: toMinutes(event) })).sort((left, right) => left.interval.start - right.interval.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (hasOverlap(previous.interval, current.interval)) {
      blockers.push({
        code: 'final_schedule_overlap',
        message: `${previous.event.title}와 ${current.event.title}가 조정된 일정에서 겹칩니다.`,
        eventIds: [previous.event.id, current.event.id],
      });
    }
  }
  return blockers.length === 0 ? { valid: true, blockers: [] } : { valid: false, blockers };
}

function validateEvidence(input: RecoveryInput): RecoveryResult | null {
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const relationById = new Map(input.relations.map((relation) => [relation.id, relation]));
  const evidenceEntries = [
    ...input.events.flatMap((event) => event.evidence.map((entry) => ({ entry, eventId: event.id, relationId: entry.relationId }))),
    ...input.relations.flatMap((relation) => relation.evidence.map((entry) => ({ entry, eventId: relation.fromEventId, relationId: relation.id }))),
  ];
  const blockers: RecoveryBlocker[] = [];
  for (const { entry, eventId, relationId } of evidenceEntries) {
    const source = sourceById.get(entry.sourceId);
    if (!source) {
      blockers.push({ code: 'missing_evidence_source', message: `${entry.sourceId} 근거 원문을 찾을 수 없습니다.`, eventIds: [eventId] });
      continue;
    }
    if (source.text.slice(entry.start, entry.end) !== entry.quote) {
      blockers.push({ code: 'evidence_quote_mismatch', message: `${entry.sourceId}의 인용 위치가 실제 원문과 일치하지 않습니다.`, eventIds: [eventId] });
    }
    if (entry.relationId !== relationId) {
      blockers.push({ code: 'evidence_relation_mismatch', message: '근거가 연결된 조건과 일치하지 않습니다.', eventIds: [eventId] });
    }
    if (entry.relationId !== null && !relationById.has(entry.relationId)) {
      blockers.push({ code: 'unknown_evidence_relation', message: `${entry.relationId} 조건을 찾을 수 없습니다.`, eventIds: [eventId] });
    }
    if (entry.relationId !== null && relationById.has(entry.relationId) && relationById.get(entry.relationId)!.fromEventId !== eventId) {
      blockers.push({ code: 'evidence_relation_mismatch', message: '이 근거는 다른 일정에 연결된 조건입니다.', eventIds: [eventId] });
    }
  }
  return blockers.length === 0 ? null : stop('invalid_input', 'invalid_evidence', '원문 인용 위치가 실제 저장된 원문과 일치하지 않습니다.', blockers);
}

function validateScope(input: RecoveryInput): RecoveryResult | null {
  const horizonMinutes = intervalMinutes(input.horizon);
  if (!Number.isFinite(horizonMinutes) || horizonMinutes > MAX_REPAIR_HORIZON_MINUTES) {
    return stop('unsupported', 'horizon_too_large', '이 일정 조정안은 최대 이틀 범위까지만 계산합니다.', [{
      code: 'horizon_too_large',
      message: '계산 범위가 48시간을 넘었습니다.',
      eventIds: [],
    }]);
  }
  if (input.events.length > MAX_REPAIR_EVENTS) {
    return stop('unsupported', 'too_many_events', '이 일정 조정안은 최대 30개 일정 구간까지만 계산합니다.', [{
      code: 'too_many_events',
      message: `${input.events.length}개 일정 구간이 들어왔습니다.`,
      eventIds: [],
    }]);
  }
  const horizon = toMinutes(input.horizon);
  const now = parseLocalMinute(input.now)!;
  if (now < horizon.start || horizon.end < now) {
    return stop('unsupported', 'now_outside_horizon', '현재 시각이 계산 범위 밖입니다.', [{
      code: 'now_outside_horizon',
      message: '현재 시각은 계산 범위 안에 있어야 합니다.',
      eventIds: [],
    }]);
  }
  for (const event of input.events) {
    if (!inside(toMinutes(event), horizon)) {
      return stop('unsupported', 'event_outside_horizon', '일부 일정이 계산 범위 밖에 있습니다.', [{
        code: 'event_outside_horizon',
        message: `${event.title} 시간이 계산 범위 밖에 있습니다.`,
        eventIds: [event.id],
      }]);
    }
  }
  for (const window of input.workWindows) {
    if (!inside(toMinutes(window), horizon)) {
      return stop('unsupported', 'work_window_outside_horizon', '사용 가능한 시간이 계산 범위 밖에 있습니다.', [{
        code: 'work_window_outside_horizon',
        message: `${window.label} 사용 가능 시간이 계산 범위 밖에 있습니다.`,
        eventIds: [],
      }]);
    }
  }
  return null;
}

function validateChangedIntervals(input: RecoveryInput, intervals: ScheduleInterval[]): RecoveryResult | null {
  const horizon = toMinutes(input.horizon);
  for (const interval of intervals) {
    const candidate = toMinutes(interval);
    if (!inside(candidate, horizon)) {
      return stop('unsupported', 'changed_interval_outside_horizon', '변경할 일정이 계산 범위 밖에 있습니다.', [{
        code: 'changed_interval_outside_horizon',
        message: `${interval.start}-${interval.end} 시간이 계산 범위 밖입니다.`,
        eventIds: [],
      }]);
    }
    if (!insideAnyWorkWindow(input, candidate)) {
      return stop('infeasible', 'changed_interval_outside_work_window', '변경할 일정이 사용 가능한 시간 밖에 있습니다.', [{
        code: 'changed_interval_outside_work_window',
        message: `${interval.start}-${interval.end} 시간이 사용 가능한 시간 밖입니다.`,
        eventIds: [],
      }]);
    }
  }
  return null;
}

function validateConfirmedRelations(input: RecoveryInput): RecoveryResult | null {
  const relations = new Map(input.relations.map((relation) => [relation.id, relation]));
  const missingIds = input.change.confirmedByRelationIds.filter((id) => !relations.get(id)?.confirmed);
  if (missingIds.length > 0) {
    return stop('missing_information', 'unconfirmed_relations', '원문에서 찾은 관계를 사용자가 확인하지 않아 일정 조정안을 계산하지 않습니다.', [{
      code: 'unconfirmed_relations',
      message: `확인이 필요한 관계: ${missingIds.join(', ')}`,
      eventIds: [],
    }]);
  }
  const requiredKinds = new Set(['required_for', 'deadline', 'travel_before', 'time_change']);
  for (const relationId of input.change.confirmedByRelationIds) {
    const relation = relations.get(relationId);
    if (relation) {
      const expectedFrom = relation.kind === 'time_change' ? input.change.presentationEventId : relation.kind === 'travel_before' ? input.change.travelEventId : input.change.preparationEventId;
      const expectedTo = relation.kind === 'time_change' ? null : input.change.presentationEventId;
      if (relation.fromEventId !== expectedFrom || relation.toEventId !== expectedTo) {
        return stop('missing_information', 'relation_target_mismatch', '확인한 관계가 변경된 일정·이동·준비 항목과 맞지 않습니다.', []);
      }
    }
    if (relation) requiredKinds.delete(relation.kind);
    if (relation?.evidence.some((entry) => entry.authority === 'ai_suggested')) {
      return stop('missing_information', 'unconfirmed_ai_relation', 'AI가 찾은 관계라도 사용자가 확인하지 않으면 일정 조정에 쓰지 않습니다.', [{
        code: 'unconfirmed_ai_relation',
        message: `${relation.id} 관계에 아직 사용자가 확인하지 않은 AI 제안 근거가 있습니다.`,
        eventIds: [relation.fromEventId],
      }]);
    }
  }
  if (requiredKinds.size > 0) {
    return stop('missing_information', 'missing_required_relation_kinds', '일정 조정에 필요한 관계가 부족합니다.', [{
      code: 'missing_required_relation_kinds',
      message: `필요한 관계: ${Array.from(requiredKinds).join(', ')}`,
      eventIds: [],
    }]);
  }
  return null;
}

function findCandidate(input: RecoveryInput, fixedBusy: MinuteInterval[], movableCandidates: ScheduleEvent[]): Candidate | null {
  const prepDuration = input.change.preparationDurationMinutes;
  const deadline = parseLocalMinute(input.change.preparationDeadline)!;
  const now = parseLocalMinute(input.now)!;
  const initialPrep = findPreparationSlot(input, prepDuration, deadline, now, [...fixedBusy, ...movableCandidates.map((event) => toMinutes(event))]);
  if (initialPrep && !movableCandidates.some((event) => fixedBusy.some((busy) => hasOverlap(toMinutes(event), busy)))) return { prep: initialPrep, moved: null };

  const sortedMovable = [...movableCandidates].sort(compareEvents);
  for (const event of sortedMovable) {
    if (sortedMovable.some((other) => other.id !== event.id && fixedBusy.some((busy) => hasOverlap(toMinutes(other), busy)))) continue;
    const busyWithoutEvent = [...fixedBusy, ...sortedMovable.filter((candidate) => candidate.id !== event.id).map((candidate) => toMinutes(candidate))];
    // The first preparation slot may consume the flexible task's only window.
    // Try subsequent minute boundaries before declaring the bounded problem
    // infeasible. firstSlot jumps past occupied intervals to keep this bounded.
    for (const window of sortedWorkWindows(input)) {
      const end = Math.min(toMinutes(window).end, deadline);
      let cursor = Math.max(toMinutes(window).start, now);
      while (cursor + prepDuration <= end) {
        const prep = firstSlot({ start: cursor, end }, prepDuration, normalizeBusy(busyWithoutEvent));
        if (!prep) break;
        const move = findMoveSlot(input, event, [...busyWithoutEvent, prep], now);
        if (move) return { prep, moved: { event, interval: move } };
        cursor = prep.start + 1;
      }
    }
  }

  // Retain the final overlap validator's explicit conflict diagnosis if the
  // preparation slot fits but no single flexible move resolves the collision.
  return initialPrep ? { prep: initialPrep, moved: null } : null;
}

function findPreparationSlot(input: RecoveryInput, duration: number, deadline: number, now: number, busy: MinuteInterval[]): MinuteInterval | null {
  const boundedBusy = normalizeBusy(busy);
  for (const window of sortedWorkWindows(input)) {
    const base = toMinutes(window);
    const start = Math.max(base.start, now);
    const end = Math.min(base.end, deadline);
    const slot = firstSlot({ start, end }, duration, boundedBusy);
    if (slot) return slot;
  }
  return null;
}

function findMoveSlot(input: RecoveryInput, event: ScheduleEvent, busy: MinuteInterval[], now: number): MinuteInterval | null {
  if (!event.movableWindow) return null;
  const duration = event.movableWindow.durationMinutes;
  const window = toMinutes(event.movableWindow);
  for (const available of sortedWorkWindows(input)) {
    const allowed = toMinutes(available);
    const slot = firstSlot({ start: Math.max(window.start, now, allowed.start), end: Math.min(window.end, allowed.end) }, duration, normalizeBusy(busy));
    if (slot) return slot;
  }
  return null;
}

function firstSlot(window: MinuteInterval, duration: number, busy: MinuteInterval[]): MinuteInterval | null {
  if (window.end - window.start < duration) return null;
  for (let start = window.start; start + duration <= window.end; start += 1) {
    const interval = { start, end: start + duration };
    const collision = busy.find((occupied) => hasOverlap(interval, occupied));
    if (!collision) return interval;
    start = collision.end - 1;
  }
  return null;
}

function readyResult(
  input: RecoveryInput,
  presentation: ScheduleEvent,
  travel: ScheduleEvent,
  preparation: ScheduleEvent,
  candidate: Candidate,
  protectedCount: number,
): RecoveryReadyResult {
  const presentationAfter = input.change.presentationInterval;
  const travelAfter = fromMinutes({
    start: parseLocalMinute(input.change.presentationInterval.start)! - input.change.travelDurationMinutes,
    end: parseLocalMinute(input.change.presentationInterval.start)!,
  });
  const prepAfter = fromMinutes(candidate.prep);
  const after = input.events.map((event) => {
    if (event.id === presentation.id) return { ...event, ...presentationAfter, moved: true };
    if (event.id === travel.id) return { ...event, ...travelAfter, moved: true };
    if (event.id === preparation.id) return { ...event, ...prepAfter, moved: true };
    if (candidate.moved && event.id === candidate.moved.event.id) return { ...event, ...fromMinutes(candidate.moved.interval), moved: true };
    return { ...event, moved: false };
  });
  const relationEvidence = confirmedEvidence(input);
  const actions: RecoveryAction[] = [
    rescheduleAction(presentation, presentationAfter, '변경 안내에서 발표 시간이 새로 확정되었습니다.', relationEvidence),
    rescheduleAction(travel, travelAfter, '발표 시작 전에 확인된 60분 이동 시간을 배치했습니다.', relationEvidence),
    rescheduleAction(preparation, prepAfter, '제출 마감 전에 연속 준비 시간을 확보했습니다.', relationEvidence),
  ];
  if (candidate.moved) {
    actions.push(rescheduleAction(candidate.moved.event, fromMinutes(candidate.moved.interval), '준비 시간을 확보하기 위해 이동 가능한 보조 작업을 같은 허용 범위 안에서 옮겼습니다.', candidate.moved.event.evidence));
  }
  for (const event of input.events.filter((event) => event.locked || event.completed)) {
    actions.push({
      kind: 'preserve',
      eventId: event.id,
      itemId: event.itemId,
      title: event.title,
      interval: { start: event.start, end: event.end },
      reason: event.locked ? '사용자가 보호한 일정입니다.' : '완료된 항목입니다.',
      evidence: event.evidence,
    });
  }

  return {
    status: 'ready',
    summary: `${preparation.title} ${input.change.preparationDurationMinutes}분을 확보했습니다. 제출 마감과 보호된 약속을 모두 검증했습니다.`,
    timezone: input.timezone,
    baseRevision: input.baseRevision,
    sourceRevision: input.sourceRevision,
    before: input.events,
    after,
    actions,
    blockers: [],
    metrics: {
      movedEvents: actions.filter((action) => action.kind === 'reschedule').length,
      protectedEvents: protectedCount,
      preparationMinutesSecured: input.change.preparationDurationMinutes,
      deadline: input.change.preparationDeadline,
    },
  };
}

function confirmedEvidence(input: RecoveryInput): ScheduleEvidenceRef[] {
  const relationIds = new Set(input.change.confirmedByRelationIds);
  return input.relations
    .filter((relation) => relationIds.has(relation.id))
    .flatMap((relation) => relation.evidence);
}

function rescheduleAction(event: ScheduleEvent, after: ScheduleInterval, reason: string, evidence: ScheduleEvidenceRef[]): RecoveryAction {
  return {
    kind: 'reschedule',
    eventId: event.id,
    itemId: event.itemId,
    title: event.title,
    before: { start: event.start, end: event.end },
    after,
    reason,
    evidence,
  };
}

function invalidInput(error: ZodError): RecoveryResult {
  return stop('invalid_input', 'schema_validation_failed', '일정 조정 입력 형식이 올바르지 않습니다.', error.issues.slice(0, 5).map((issue) => ({
    code: issue.code,
    message: issue.message,
    eventIds: [],
  })));
}

function stop(status: RecoveryResult['status'], code: string, message: string, blockers: RecoveryBlocker[]): RecoveryResult {
  if (status === 'ready') throw new Error('Use readyResult for ready recovery results.');
  return { status, code, message, blockers };
}

function eventById(input: RecoveryInput, eventId: string): ScheduleEvent | null {
  return input.events.find((event) => event.id === eventId) ?? null;
}

function compareEvents(left: ScheduleEvent, right: ScheduleEvent): number {
  return left.start.localeCompare(right.start) || left.id.localeCompare(right.id);
}

function sortedWorkWindows(input: RecoveryInput): Array<RecoveryInput['workWindows'][number]> {
  return [...input.workWindows].sort((left, right) => left.start.localeCompare(right.start));
}

function normalizeBusy(busy: MinuteInterval[]): MinuteInterval[] {
  return [...busy].sort((left, right) => left.start - right.start || left.end - right.end);
}

function overlapsAny(interval: MinuteInterval, events: ScheduleEvent[], excludedIds: string[]): boolean {
  const excluded = new Set(excludedIds);
  return events.some((event) => !excluded.has(event.id) && hasOverlap(interval, toMinutes(event)));
}



function hasOverlap(left: MinuteInterval, right: MinuteInterval): boolean {
  return left.start < right.end && right.start < left.end;
}

function inside(inner: MinuteInterval, container: MinuteInterval): boolean {
  return container.start <= inner.start && inner.end <= container.end;
}

function insideAnyWorkWindow(input: RecoveryInput, inner: MinuteInterval): boolean {
  return input.workWindows.some((window) => inside(inner, toMinutes(window)));
}

function toMinutes(interval: ScheduleInterval): MinuteInterval {
  return {
    start: parseLocalMinute(interval.start)!,
    end: parseLocalMinute(interval.end)!,
  };
}

function fromMinutes(interval: MinuteInterval): ScheduleInterval {
  return {
    start: formatLocalMinute(interval.start),
    end: formatLocalMinute(interval.end),
  };
}
