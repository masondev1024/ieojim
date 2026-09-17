import { z } from 'zod';
import {
  DomainError,
  emptySnapshot,
  LIMITS,
  snapshotSchema,
  type Block,
  type BlockItem,
  type Evidence,
  type Fact,
  type Snapshot,
  type Source,
  type WorkspaceView,
} from './contracts';
import { repairSchedule } from './schedule-repair';
import {
  formatLocalMinute,
  intervalMinutes,
  localMinuteSchema,
  MAX_REPAIR_EVENTS,
  MAX_REPAIR_HORIZON_MINUTES,
  parseLocalMinute,
  recoveryInputSchema,
  scheduleIntervalSchema,
  scheduleMovableWindowSchema,
  scheduleWorkWindowSchema,
  type RecoveryInput,
  type ScheduleEvidenceRef,
  type ScheduleEvent,
  type ScheduleInterval,
} from './scheduling-contracts';

const itemIdSchema = z.string().min(1).max(100);
const titleSchema = z.string().trim().min(1).max(120).refine((value) => !/[\r\n]/.test(value), 'Title must be a single line.');

export const noticeRecoveryRequestSchema = z.object({
  requestId: z.string().uuid(),
  baseRevision: z.number().int().nonnegative(),
  baseSourceRevision: z.number().int().nonnegative(),
  sourceId: itemIdSchema,
  targetItemId: itemIdSchema,
  targetBefore: scheduleIntervalSchema,
  targetAfter: scheduleIntervalSchema,
  preparation: z.object({
    itemId: itemIdSchema.nullable(),
    title: titleSchema,
    before: scheduleIntervalSchema,
    durationMinutes: z.number().int().min(1).max(240),
    deadline: localMinuteSchema,
  }).strict(),
  travelMinutes: z.number().int().min(1).max(240),
  horizon: scheduleIntervalSchema,
  workWindows: z.array(scheduleWorkWindowSchema).min(1).max(8),
  commitments: z.array(z.object({
    itemId: itemIdSchema,
    interval: scheduleIntervalSchema,
    movableWindow: scheduleMovableWindowSchema.nullable(),
  }).strict()).max(MAX_REPAIR_EVENTS),
  extraBusy: z.array(z.object({
    title: titleSchema,
    interval: scheduleIntervalSchema,
  }).strict()).max(10),
  confirmed: z.literal(true),
}).strict().superRefine((request, context) => {
  const horizonMinutes = intervalMinutes(request.horizon);
  if (!Number.isFinite(horizonMinutes) || horizonMinutes > MAX_REPAIR_HORIZON_MINUTES) {
    context.addIssue({ code: 'custom', path: ['horizon'], message: 'Recovery horizon must be at most 48 hours.' });
  }
  for (const path of ['targetBefore', 'targetAfter'] as const) {
    if (!inside(request[path], request.horizon)) {
      context.addIssue({ code: 'custom', path: [path], message: `${path} must be inside the horizon.` });
    }
  }
  if (intervalMinutes(request.targetBefore) !== intervalMinutes(request.targetAfter)) {
    context.addIssue({ code: 'custom', path: ['targetAfter'], message: 'Target event duration must be preserved.' });
  }
});

export type NoticeRecoveryRequest = z.infer<typeof noticeRecoveryRequestSchema>;

export type NoticeRecoveryOrigin = {
  workspaceId: string;
  title: string;
  revision: number;
  sourceRevision: number;
  sourceId: string;
  sourceHash: string;
  targetItemId: string;
  preparationItemId: string | null;
  sourceMode: 'live' | 'fixture' | 'user';
  noticeText: string;
};

export type NoticeRecoverySeed = {
  input: RecoveryInput;
  snapshot: Snapshot;
  title: string;
  purpose: string;
  noticeText: string;
  conditionText: string;
  origin: NoticeRecoveryOrigin;
};

type ScheduleItem = { blockType: Block['type']; item: BlockItem };
type EventPlan = Omit<Parameters<typeof recoveryEvent>[0], 'evidence'>;

const relationIds = {
  timeChange: 'relation:time_change',
  deadline: 'relation:deadline',
  travelBefore: 'relation:travel_before',
  requiredFor: 'relation:required_for',
} as const;

export function buildNoticeRecoverySeed(
  workspace: WorkspaceView,
  raw: unknown,
  ids: { workspaceId: string; noticeSourceId: string; conditionSourceId: string },
): NoticeRecoverySeed {
  const request = parseRequest(raw);
  if (workspace.pending) throw domain('PENDING_CHANGESET', '대기 중인 변경안을 먼저 적용하거나 취소해 주세요.', 409);
  if (workspace.revision !== request.baseRevision || workspace.sourceRevision !== request.baseSourceRevision) {
    throw domain('STALE_WORKSPACE', '계획이나 원문이 바뀌었습니다. 복구 조건을 다시 확인해 주세요.', 409);
  }

  const noticeSource = requireSource(workspace, request.sourceId);
  assertUsableSource(workspace, noticeSource);
  const sourceMode = runModeForSource(workspace, noticeSource.id);
  const scheduleItems = scheduleItemsFrom(workspace.snapshot);
  const target = requireScheduleItem(scheduleItems, request.targetItemId);
  assertTargetAllowed(target.item, 'TARGET_PROTECTED', '선택한 일정은 잠금, 완료, 직접 수정 또는 재검토 상태라 자동 복구 대상으로 사용할 수 없습니다.');

  const targetFact = requireSourceBackedFact(workspace.snapshot, target.item, noticeSource);
  const preparationItem = request.preparation.itemId
    ? requireItem(workspace.snapshot, request.preparation.itemId)
    : null;
  if (preparationItem) {
    if (preparationItem.blockType !== 'checklist') throw domain('PREPARATION_NOT_CHECKLIST', '선택한 준비 항목은 체크리스트 항목이어야 합니다.', 422);
    assertTargetAllowed(preparationItem.item, 'PREPARATION_PROTECTED', '선택한 준비 항목은 잠금, 완료, 직접 수정 또는 재검토 상태라 자동 복구 대상으로 사용할 수 없습니다.');
    assertPreparationMatches(preparationItem.item, request.preparation.durationMinutes, request.preparation.deadline);
  }

  const eventPlans = buildEventPlans(scheduleItems, target.item, request, workspace.snapshot.facts);
  const conditionText = buildConditionText(workspace, request, eventPlans);
  const conditionSource: Source = {
    id: ids.conditionSourceId,
    text: conditionText,
    title: '사용자가 확인한 일정 복구 조건',
    relation: 'addition',
    targetSourceId: noticeSource.id,
    hash: 'server-owned-condition-source',
    createdAt: request.horizon.start,
  };
  assertSourceLimits(noticeSource, conditionText);

  const noticeEvidence = toNoticeEvidence(targetFact.evidence, ids.noticeSourceId, null);
  const conditionEvidence = conditionEvidenceFactory(conditionSource);
  const events = eventPlans.map((plan) => recoveryEvent({
    ...plan,
    evidence: [
      ...(plan.id === 'event:presentation' ? [noticeEvidence] : []),
      conditionEvidence(slotKey(plan.id), plan.id === 'event:presentation' ? relationIds.timeChange : null),
      ...relationEvidenceForEvent(plan.id, conditionEvidence),
    ],
  }));
  if (events.length > MAX_REPAIR_EVENTS) throw domain('TOO_MANY_EVENTS', '이번 복구 엔진은 최대 30개 일정 구간만 검증합니다.', 422);

  const input: RecoveryInput = {
    version: 1,
    requestId: request.requestId,
    workspaceId: ids.workspaceId,
    baseRevision: 1,
    sourceRevision: 2,
    timezone: 'Asia/Seoul',
    sources: [
      { id: ids.noticeSourceId, text: noticeSource.text },
      { id: conditionSource.id, text: conditionText },
    ],
    now: request.horizon.start,
    horizon: request.horizon,
    workWindows: request.workWindows,
    events,
    relations: [
      { id: relationIds.timeChange, kind: 'time_change', fromEventId: 'event:presentation', toEventId: null, confirmed: true, evidence: [conditionEvidence('time_change', relationIds.timeChange)] },
      { id: relationIds.deadline, kind: 'deadline', fromEventId: 'event:presentation_prep', toEventId: 'event:presentation', confirmed: true, evidence: [conditionEvidence('deadline', relationIds.deadline)] },
      { id: relationIds.travelBefore, kind: 'travel_before', fromEventId: 'event:presentation_travel', toEventId: 'event:presentation', confirmed: true, evidence: [conditionEvidence('travel_before', relationIds.travelBefore)] },
      { id: relationIds.requiredFor, kind: 'required_for', fromEventId: 'event:presentation_prep', toEventId: 'event:presentation', confirmed: true, evidence: [conditionEvidence('required_for', relationIds.requiredFor)] },
    ],
    change: {
      presentationEventId: 'event:presentation',
      presentationInterval: request.targetAfter,
      travelEventId: 'event:presentation_travel',
      travelDurationMinutes: request.travelMinutes,
      preparationEventId: 'event:presentation_prep',
      preparationDurationMinutes: request.preparation.durationMinutes,
      preparationDeadline: request.preparation.deadline,
      confirmedByRelationIds: [relationIds.timeChange, relationIds.deadline, relationIds.travelBefore, relationIds.requiredFor],
    },
  };

  const parsedInput = recoveryInputSchema.parse(input);
  const result = repairSchedule(parsedInput);
  if (result.status === 'invalid_input' || result.status === 'unsupported' || result.status === 'missing_information') {
    throw domain('INVALID_RECOVERY_SEED', result.message, 422);
  }

  const title = truncateLabel(`${target.item.label} 일정 복구`, 100);
  const purpose = '변경 안내와 사용자가 확인한 조건을 근거로 일정, 이동, 준비 시간을 검증합니다.';
  return {
    input: parsedInput,
    snapshot: buildRecoverySnapshot(parsedInput, request, target.item, conditionSource, preparationItem?.item ?? null),
    title,
    purpose,
    noticeText: noticeSource.text,
    conditionText,
    origin: {
      workspaceId: workspace.id,
      title: workspace.title,
      revision: workspace.revision,
      sourceRevision: workspace.sourceRevision,
      sourceId: noticeSource.id,
      sourceHash: noticeSource.hash,
      targetItemId: target.item.id,
      preparationItemId: request.preparation.itemId,
      sourceMode,
      noticeText: noticeSource.text,
    },
  };
}

function parseRequest(raw: unknown): NoticeRecoveryRequest {
  const parsed = noticeRecoveryRequestSchema.safeParse(raw);
  if (!parsed.success) throw domain('INVALID_NOTICE_RECOVERY_REQUEST', parsed.error.issues[0]?.message ?? '복구 요청 형식이 올바르지 않습니다.', 422);
  return parsed.data;
}

function domain(code: string, message: string, status = 422): DomainError {
  return new DomainError(code, message, status);
}

function requireSource(workspace: WorkspaceView, sourceId: string): Source {
  const source = workspace.sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw domain('SOURCE_NOT_FOUND', '선택한 안내 원문을 찾을 수 없습니다.', 404);
  if (!source.text.trim()) throw domain('EMPTY_SOURCE', '선택한 안내 원문이 비어 있습니다.', 422);
  return source;
}

function assertUsableSource(workspace: WorkspaceView, source: Source): void {
  if (workspace.sources.some((candidate) => ['correction', 'replacement'].includes(candidate.relation) && candidate.targetSourceId === source.id)) {
    throw domain('SOURCE_SUPERSEDED', '선택한 안내 원문은 정정되었거나 대체되었습니다.', 409);
  }
}

function runModeForSource(workspace: WorkspaceView, sourceId: string): NoticeRecoveryOrigin['sourceMode'] {
  const runs = workspace.runs.filter((run) => run.sourceId === sourceId && run.status === 'applied');
  if (runs.some((run) => run.mode === 'fixture')) return 'fixture';
  if (runs.some((run) => run.mode === 'live')) return 'live';
  return 'user';
}

function scheduleItemsFrom(snapshot: Snapshot): ScheduleItem[] {
  return snapshot.blocks
    .filter((block) => block.type === 'schedule')
    .flatMap((block) => block.items.map((item) => ({ blockType: block.type, item })));
}

function requireScheduleItem(items: ScheduleItem[], itemId: string): ScheduleItem {
  const entry = items.find((candidate) => candidate.item.id === itemId);
  if (!entry) throw domain('TARGET_NOT_SCHEDULE', '선택한 항목은 일정 블록에 없습니다.', 422);
  return entry;
}

function requireItem(snapshot: Snapshot, itemId: string): ScheduleItem {
  for (const block of snapshot.blocks) {
    const item = block.items.find((candidate) => candidate.id === itemId);
    if (item) return { blockType: block.type, item };
  }
  throw domain('ITEM_NOT_FOUND', '선택한 준비 항목을 찾을 수 없습니다.', 404);
}

function assertTargetAllowed(item: BlockItem, code: string, message: string): void {
  if (item.locked || item.completed || item.edited || item.stale) throw domain(code, message, 409);
}

function assertPreparationMatches(item: BlockItem, durationMinutes: number, deadline: string): void {
  if (!item.preparation) return;
  if ((item.preparation.durationMinutes !== null && item.preparation.durationMinutes !== durationMinutes) ||
      (item.preparation.dueDate !== null && item.preparation.dueDate !== deadline.slice(0, 10))) {
    throw domain('PREPARATION_SETTINGS_MISMATCH', '기존 준비 설정이 확인한 조건과 다릅니다. 원래 작업 공간에서 먼저 수정해 주세요.', 409);
  }
}

function requireSourceBackedFact(snapshot: Snapshot, item: BlockItem, source: Source): Fact {
  const factKeys = [item.valueFactKey, ...item.factKeys].filter((key): key is string => Boolean(key));
  const facts = snapshot.facts.filter((fact) => factKeys.includes(fact.key));
  const fact = facts.find((candidate) => evidenceMatchesSource(candidate.evidence, source));
  if (!fact) throw domain('TARGET_EVIDENCE_NOT_FOUND', '선택한 일정은 선택한 실제 안내 원문에 연결된 근거가 없습니다.', 422);
  return fact;
}

function evidenceMatchesSource(evidence: Evidence, source: Source): boolean {
  return evidence.sourceId === source.id &&
    evidence.start >= 0 &&
    evidence.end > evidence.start &&
    evidence.end <= source.text.length &&
    source.text.slice(evidence.start, evidence.end) === evidence.quote;
}

function assertCommitmentAnchor(item: BlockItem, interval: ScheduleInterval, facts: Fact[]): void {
  const parsedInterval = parseIntervalText(item.value);
  if (parsedInterval) {
    if (slotText(parsedInterval) !== slotText(interval)) {
      throw domain('COMMITMENT_BASELINE_MISMATCH', '확인한 기존 일정 구간이 현재 작업 공간 값과 다릅니다.', 409);
    }
    return;
  }
  const parsedStart = parseStartText(item.value);
  if (parsedStart && parsedStart !== interval.start) {
    throw domain('COMMITMENT_START_MISMATCH', '확인한 기존 일정 시작 시간이 현재 작업 공간 값과 다릅니다.', 409);
  }
  if (parsedStart || item.edited) return;
  const keys = item.valueFactKey ? [item.valueFactKey] : item.factKeys;
  const anchors = [...new Set(facts.filter((fact) => keys.includes(fact.key)).flatMap((fact) => {
    const semantic = fact.semantic;
    if (semantic?.kind !== 'date_time' || !semantic.date || !/^\d{4}-\d{2}-\d{2}$/.test(semantic.date)) return [];
    const value = `${semantic.date}T${semantic.time ?? '00:00'}`;
    return parseLocalMinute(value) === null ? [] : [semantic.time ? value : semantic.date];
  }))];
  if (anchors.length === 1 && !interval.start.startsWith(anchors[0]!)) {
    throw domain('COMMITMENT_START_MISMATCH', '확인한 기존 일정의 날짜·시간이 저장된 일정 정보와 다릅니다.', 409);
  }
}

function buildEventPlans(
  scheduleItems: ScheduleItem[],
  target: BlockItem,
  request: NoticeRecoveryRequest,
  facts: Fact[],
): EventPlan[] {
  const commitmentsByItemId = new Map<string, NoticeRecoveryRequest['commitments'][number]>();
  for (const commitment of request.commitments) {
    if (commitmentsByItemId.has(commitment.itemId)) throw domain('DUPLICATE_COMMITMENT', '같은 기존 일정이 두 번 확인되었습니다.', 422);
    commitmentsByItemId.set(commitment.itemId, commitment);
  }
  const expected = scheduleItems.filter(({ item }) => item.id !== target.id);
  const expectedIds = new Set(expected.map(({ item }) => item.id));
  const unknown = request.commitments.find((commitment) => !expectedIds.has(commitment.itemId));
  if (unknown) throw domain('UNKNOWN_COMMITMENT', '작업 공간 일정에 없는 항목이 확인 조건에 포함되었습니다.', 422);
  const missing = expected.find(({ item }) => !commitmentsByItemId.has(item.id));
  if (missing) throw domain('MISSING_COMMITMENT', '원래 작업 공간의 다른 모든 일정 구간을 확인해야 합니다.', 422);
  const movable = request.commitments.filter((commitment) => commitment.movableWindow !== null);
  if (movable.length > 1) throw domain('TOO_MANY_MOVABLE_COMMITMENTS', '이번 경로는 이동 가능한 기존 업무를 최대 하나만 지원합니다.', 422);

  const commitmentPlans = expected.map(({ item }, index): EventPlan => {
    const commitment = commitmentsByItemId.get(item.id)!;
    assertCommitmentAnchor(item, commitment.interval, facts);
    if (commitment.movableWindow && (item.locked || item.completed || item.edited || item.stale)) {
      throw domain('MOVABLE_COMMITMENT_PROTECTED', '잠금, 완료, 직접 수정 또는 재검토 일정은 이동 가능 항목으로 사용할 수 없습니다.', 409);
    }
    const kind = commitment.movableWindow ? 'flex' : 'fixed';
    return {
      id: `event:commitment_${index + 1}`,
      itemId: recoveryScheduleItemId(`commitment_${index + 1}`),
      title: truncateLabel(item.label, 120),
      kind,
      interval: commitment.interval,
      locked: commitment.movableWindow ? false : true,
      completed: item.completed,
      movableWindow: commitment.movableWindow,
    };
  });
  return [
    ...commitmentPlans,
    {
      id: 'event:presentation_travel',
      itemId: 'item:recovery_schedule:event_presentation_travel',
      title: truncateLabel(`${target.label} 이동`, 120),
      kind: 'travel',
      interval: travelInterval(request.targetBefore, request.travelMinutes),
      locked: false,
      completed: false,
      movableWindow: null,
    },
    {
      id: 'event:presentation',
      itemId: 'item:recovery_schedule:event_presentation',
      title: truncateLabel(target.label, 120),
      kind: 'presentation',
      interval: request.targetBefore,
      locked: false,
      completed: false,
      movableWindow: null,
    },
    {
      id: 'event:presentation_prep',
      itemId: 'item:recovery_schedule:event_presentation_prep',
      title: request.preparation.title,
      kind: 'preparation',
      interval: request.preparation.before,
      locked: false,
      completed: false,
      movableWindow: null,
    },
    ...request.extraBusy.map((busy, index): EventPlan => ({
      id: `event:extra_busy_${index + 1}`,
      itemId: null,
      title: busy.title,
      kind: 'busy',
      interval: busy.interval,
      locked: true,
      completed: false,
      movableWindow: null,
    })),
  ];
}

function buildConditionText(workspace: WorkspaceView, request: NoticeRecoveryRequest, eventPlans: EventPlan[]): string {
  const lines = [
    `사용자가 확인한 일정 복구 조건 · ${JSON.stringify(truncateLabel(workspace.title, 100))}`,
    `기준 시각: ${request.horizon.start} Asia/Seoul`,
    `time_change: ${slotText(request.targetBefore)} -> ${slotText(request.targetAfter)} 변경을 사용자가 확인했습니다.`,
    `이동 시간: ${request.travelMinutes}분`,
    `준비 작업: ${JSON.stringify(request.preparation.title)} · ${request.preparation.durationMinutes}분 · ${request.preparation.deadline} 전 완료`,
    `baseline_target_before: ${slotText(request.targetBefore)}`,
    `baseline_target_after: ${slotText(request.targetAfter)}`,
    `baseline_preparation_before: ${slotText(request.preparation.before)}`,
    `travel_before: 일정 시작 ${request.travelMinutes}분 전부터 이동이 필요하다고 사용자가 확인했습니다.`,
    `deadline: 준비 작업은 ${request.preparation.deadline} 전에 끝나야 한다고 사용자가 확인했습니다.`,
    `required_for: 준비 작업은 변경 대상 일정에 필요하다고 사용자가 확인했습니다.`,
    ...request.workWindows.map((window, index) => `work_window_${index + 1}: ${JSON.stringify(window.label)} ${window.start} ~ ${window.end}`),
    ...request.commitments.map((commitment, index) => `commitment_${index + 1}: ${JSON.stringify(commitment.itemId)} ${commitment.interval.start} ~ ${commitment.interval.end} 이동범위 ${commitment.movableWindow ? `${commitment.movableWindow.start} ~ ${commitment.movableWindow.end}` : '없음'}`),
    ...request.extraBusy.map((busy, index) => `extra_busy_${index + 1}: ${JSON.stringify(busy.title)} ${busy.interval.start} ~ ${busy.interval.end}`),
    ...eventPlans.map((event) => `${slotKey(event.id)}: ${JSON.stringify(event.title)} ${slotText(event.interval)}`),
  ];
  for (const line of lines) {
    if (line.length > 800) throw domain('CONDITION_LINE_TOO_LONG', '확인 조건 한 줄이 800자를 초과합니다.', 413);
  }
  return lines.join('\n');
}

function assertSourceLimits(noticeSource: Source, conditionText: string): void {
  if (noticeSource.text.length > LIMITS.sourceChars) throw domain('NOTICE_SOURCE_TOO_LARGE', '선택한 안내 원문이 6000자를 초과합니다.', 413);
  if (conditionText.length > LIMITS.sourceChars) throw domain('CONDITION_SOURCE_TOO_LARGE', '확인 조건 원문이 6000자를 초과합니다.', 413);
  const total = noticeSource.text.length + conditionText.length;
  if (total > LIMITS.totalSourceChars) throw domain('SOURCE_TOTAL_TOO_LARGE', '작업 공간 원문 총량 한도를 초과합니다.', 413);
}

function conditionEvidenceFactory(source: Source) {
  return (key: string, relationId: string | null): ScheduleEvidenceRef => {
    const quote = source.text.split('\n').find((line) => line.startsWith(`${key}:`));
    if (!quote) throw domain('CONDITION_EVIDENCE_MISSING', `확인 조건 근거를 찾을 수 없습니다: ${key}`, 500);
    const start = source.text.indexOf(quote);
    return { sourceId: source.id, quote, start, end: start + quote.length, authority: 'user_confirmed', relationId };
  };
}

function toNoticeEvidence(evidence: Evidence, sourceId: string, relationId: string | null): ScheduleEvidenceRef {
  return { ...evidence, sourceId, authority: 'source_confirmed', relationId };
}

function recoveryEvent(input: {
  id: string;
  itemId: string | null;
  title: string;
  kind: ScheduleEvent['kind'];
  interval: ScheduleInterval;
  locked: boolean;
  completed: boolean;
  evidence: ScheduleEvidenceRef[];
  movableWindow: ScheduleEvent['movableWindow'];
}): ScheduleEvent {
  return {
    id: input.id,
    itemId: input.itemId,
    title: input.title,
    kind: input.kind,
    start: input.interval.start,
    end: input.interval.end,
    locked: input.locked,
    completed: input.completed,
    moved: false,
    evidence: input.evidence,
    movableWindow: input.movableWindow,
  };
}

function travelInterval(targetBefore: ScheduleInterval, travelMinutes: number): ScheduleInterval {
  const start = parseLocalMinute(targetBefore.start);
  if (start === null) throw domain('INVALID_TARGET_START', '대상 일정 시작 시간이 올바르지 않습니다.', 422);
  return { start: formatLocalMinute(start - travelMinutes), end: targetBefore.start };
}

function inside(interval: ScheduleInterval, horizon: ScheduleInterval): boolean {
  const start = parseLocalMinute(interval.start);
  const end = parseLocalMinute(interval.end);
  const horizonStart = parseLocalMinute(horizon.start);
  const horizonEnd = parseLocalMinute(horizon.end);
  return start !== null && end !== null && horizonStart !== null && horizonEnd !== null && horizonStart <= start && end <= horizonEnd;
}

function slotText(interval: ScheduleInterval): string {
  return `${interval.start}-${interval.end}`;
}

function parseIntervalText(value: string): ScheduleInterval | null {
  const pattern = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})\s*(?:-|~|–|—|·)\s*(?:(\d{4}-\d{2}-\d{2})[T ])?(\d{2}:\d{2})/;
  const match = pattern.exec(value);
  if (!match) return null;
  const start = `${match[1]}T${match[2]}`;
  const end = `${match[3] ?? match[1]}T${match[4]}`;
  if (parseLocalMinute(start) === null || parseLocalMinute(end) === null || parseLocalMinute(start)! >= parseLocalMinute(end)!) return null;
  return { start, end };
}

function parseStartText(value: string): string | null {
  const match = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value);
  if (!match) return null;
  const start = `${match[1]}T${match[2]}`;
  return parseLocalMinute(start) === null ? null : start;
}

function recoveryScheduleItemId(key: string): string {
  return `item:recovery_schedule:${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function slotKey(eventId: string): string {
  return `slot:${eventId}`;
}

function relationEvidenceForEvent(eventId: string, evidence: (key: string, relationId: string | null) => ScheduleEvidenceRef): ScheduleEvidenceRef[] {
  if (eventId === 'event:presentation_travel') return [evidence('travel_before', relationIds.travelBefore)];
  if (eventId === 'event:presentation_prep') return [
    evidence('deadline', relationIds.deadline),
    evidence('required_for', relationIds.requiredFor),
  ];
  return [];
}

function stripEvidence(evidence: ScheduleEvidenceRef): Evidence {
  return { sourceId: evidence.sourceId, quote: evidence.quote, start: evidence.start, end: evidence.end };
}

function truncateLabel(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function buildRecoverySnapshot(
  input: RecoveryInput,
  request: NoticeRecoveryRequest,
  target: BlockItem,
  conditionSource: Source,
  preparationItem: BlockItem | null,
): Snapshot {
  const conditionEvidence = conditionEvidenceFactory(conditionSource);
  const facts = input.events.map((event) => ({
    id: `fact:${event.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    key: `slot_${event.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 80),
    label: event.title,
    value: slotText(event),
    evidence: stripEvidence(conditionEvidence(slotKey(event.id), null)),
    semantic: null,
  }));
  const scheduleItems = input.events.filter((event) => event.itemId !== null).map((event) => {
    const fact = facts.find((candidate) => candidate.key === `slot_${event.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 80))!;
    return {
      id: event.itemId!,
      key: event.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
      label: truncateLabel(event.title, 120),
      value: slotText(event),
      factKeys: [fact.key],
      valueFactKey: fact.key,
      calculation: null,
      completed: event.completed,
      locked: event.locked,
      edited: false,
      stale: false,
    };
  });
  const prepFact = facts.find((fact) => fact.key === 'slot_event_presentation_prep') ?? facts[facts.length - 1]!;
  const scheduleBlocks = [
    { id: 'block:recovery_schedule', key: 'recovery_schedule', type: 'schedule' as const, title: '확인된 일정', items: scheduleItems.slice(0, 16) },
    ...(scheduleItems.length > 16 ? [{ id: 'block:recovery_schedule_2', key: 'recovery_schedule_2', type: 'schedule' as const, title: '확인된 일정', items: scheduleItems.slice(16, 32) }] : []),
  ];
  const snapshot: Snapshot = {
    ...emptySnapshot(),
    facts,
    blocks: [
      ...scheduleBlocks,
      { id: 'block:recovery_cost', key: 'recovery_cost', type: 'cost', title: '비용 영향', items: [] },
      {
        id: 'block:recovery_checklist',
        key: 'recovery_checklist',
        type: 'checklist',
        title: '준비 작업',
        items: [{
          id: 'item:recovery_checklist:event_presentation_prep',
          key: 'event_presentation_prep',
          label: request.preparation.title,
          value: `${request.preparation.durationMinutes}분 연속 준비 · ${request.preparation.deadline} 전 완료`,
          factKeys: [prepFact.key],
          valueFactKey: null,
          calculation: null,
          completed: preparationItem?.completed ?? false,
          locked: preparationItem?.locked ?? false,
          edited: false,
          stale: false,
          preparation: { version: 1, dueDate: request.preparation.deadline.slice(0, 10), durationMinutes: request.preparation.durationMinutes },
        }],
      },
      {
        id: 'block:recovery_note',
        key: 'recovery_note',
        type: 'note',
        title: '검토 메모',
        items: [{
          id: 'item:recovery_note:origin',
          key: 'origin',
          label: '복구 기준',
          value: `${target.label} 변경 안내와 사용자가 확인한 조건으로 생성했습니다.`,
          factKeys: [],
          valueFactKey: null,
          calculation: null,
          completed: false,
          locked: true,
          edited: false,
          stale: false,
        }],
      },
    ],
  };
  return snapshotSchema.parse(snapshot);
}
