import {
  calendarEmailSchema,
  calendarEventWriteSchema,
  deterministicCalendarEventId,
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_CALENDAR_FREEBUSY_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  type CalendarEventRead,
  type CalendarEventWrite,
  type CalendarProvider,
  type CalendarProviderResult,
  type ConnectedCalendarProvider,
  type FreeBusyBlock,
} from '../../core/calendar-contracts';
import { emailRecoverySchema, executeRecoverySchema, type RecoveryActionStatus, type RecoveryView } from '../../core/recovery-api-contracts';
import { repairSchedule, validateReadyResult } from '../../core/schedule-repair';
import type { RecoveryInput, RecoveryReadyResult, RecoveryResult } from '../../core/scheduling-contracts';
import { jsonHash, randomId } from '../crypto';
import { ApiException } from '../errors';
import type { AppBindings } from '../http';
import { nowIso } from '../http';
import { getConnectedProvider } from '../calendar/store';
import { assertOriginStillCurrent, readOriginState, recoveryOriginCurrentGuardSql } from './origin';
import { RecoveryStore } from './store';

type ActionKind = 'calendar' | 'email';
type ExecuteCommand = unknown;
type EmailCommand = unknown;

type ConnectedProviderGetter = (env: AppBindings, accountId: string, options: { db: D1Database }) => Promise<CalendarProviderResult<ConnectedCalendarProvider>>;

export type RecoveryActionDeps = {
  now?: () => string;
  getConnectedProvider?: ConnectedProviderGetter;
  dispatch?: (actionId: string) => Promise<void>;
  maxRecover?: number;
};

type RecoveryProfileRow = {
  workspace_id: string;
  condition_revision: number;
  base_revision: number;
  base_source_revision: number;
  input_json: string;
  proposal_id: string;
  applied_revision: number | null;
};

type WorkspaceRow = {
  id: string;
  owner_id: string;
  revision: number;
  source_revision: number;
  deleted_at: string | null;
  expires_at: string;
};

type RecoveryActionRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  account_id: string;
  request_id: string;
  connection_id: string;
  connection_version: number;
  base_revision: number;
  source_revision: number;
  condition_revision: number;
  kind: ActionKind;
  payload_json: string;
  payload_hash: string;
  status: RecoveryActionStatus;
  progress_json: string;
  message: string;
  attempts: number;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
};

type CalendarPayload = {
  version: 1;
  kind: 'calendar';
  workspaceId: string;
  ownerId: string;
  accountId: string;
  connectionId: string;
  connectionVersion: number;
  calendarId: string;
  baseRevision: number;
  sourceRevision: number;
  conditionRevision: number;
  resultHash: string;
  events: Array<{ itemId: string; eventId: string; write: CalendarEventWrite }>;
  freeBusy: { timeMin: string; timeMax: string; calendarIds: string[] };
};

type EmailPayload = {
  version: 1;
  kind: 'email';
  workspaceId: string;
  ownerId: string;
  accountId: string;
  connectionId: string;
  connectionVersion: number;
  baseRevision: number;
  sourceRevision: number;
  conditionRevision: number;
  recipient: string;
  subject: string;
  body: string;
  operationId: string;
};

type ActionPayload = CalendarPayload | EmailPayload;
type CalendarProgress = { completed?: Record<string, { eventId: string; etag: string; payloadHash: string }> };
type EmailProgress = { receipt?: { providerMessageId: string; acceptedAt: string; operationId: string } };


export async function proposeRecoveryAction(
  env: AppBindings,
  ownerId: string,
  accountId: string,
  workspaceId: string,
  kind: ActionKind,
  command: ExecuteCommand | EmailCommand,
  deps: RecoveryActionDeps = {},
): Promise<RecoveryView> {
  const now = deps.now?.() ?? nowIso();
  if (!accountId) throw new ApiException('RECOVERY_ACCOUNT_REQUIRED', '외부 실행은 확인된 계정에서만 사용할 수 있습니다.', 403);
  const parsedCommand = kind === 'email' ? emailRecoverySchema.parse(command) : executeRecoverySchema.parse(command);
  const payloadEnvelope = { kind, workspaceId, command: parsedCommand };
  const commandHash = await jsonHash(payloadEnvelope);
  const replay = await replayAction(env.DB, ownerId, parsedCommand.requestId, commandHash);
  if (replay) return new RecoveryStore(env).read(ownerId, workspaceId);

  const workspace = await readWorkspaceForAccount(env.DB, ownerId, accountId, workspaceId, now);
  const profile = await readProfile(env.DB, workspaceId);
  const actionCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM recovery_actions WHERE workspace_id=?').bind(workspaceId).first<number>('count');
  if ((actionCount ?? 0) >= 40) throw new ApiException('RECOVERY_ACTION_LIMIT', '이 작업 공간의 외부 실행 이력 한도에 도달했습니다.', 429);
  assertAppliedReadyBase(workspace, profile, parsedCommand.baseRevision, parsedCommand.conditionRevision);
  await assertOriginStillCurrent(env.DB, ownerId, workspaceId, now);
  const input = parseRecoveryInput(profile.input_json);
  const result = readyRecovery(repairSchedule(input));
  const validation = validateReadyResult(input, result);
  if (!validation.valid) throw new ApiException('RECOVERY_INVALID_RESULT', '일정 조정 결과가 현재 조건을 만족하지 않습니다.', 409);

  const connected = await (deps.getConnectedProvider ?? getConnectedProvider)(env, accountId, { db: env.DB });
  if (!connected.ok) throw providerSetupException(connected.error.kind);
  const connection = connected.value;
  const payload: ActionPayload = kind === 'calendar'
    ? await buildCalendarPayload({ workspace, ownerId, accountId, profile, input, result, connection })
    : buildEmailPayload({ workspace, ownerId, accountId, profile, command: parsedCommand as ReturnType<typeof emailRecoverySchema.parse>, connection });
  if (payload.kind === 'calendar' && hasStartedSlot(payload, now)) throw new ApiException('RECOVERY_TIME_PASSED', '이미 시작한 변경 구간이 있어 Calendar에 반영할 수 없습니다. 현재 시간 기준으로 다시 계획해 주세요.', 409);
  const payloadHash = await jsonHash(payload);
  const actionId = randomId('rec_act');

  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tx_guards(id,created_at) SELECT ?,? FROM workspaces w JOIN owners o ON o.id=w.owner_id JOIN recovery_profiles p ON p.workspace_id=w.id
        WHERE w.id=? AND w.owner_id=? AND o.account_id=? AND w.deleted_at IS NULL AND w.expires_at>?
        AND w.revision=? AND w.source_revision=? AND p.condition_revision=? AND p.applied_revision=w.revision AND p.base_source_revision=w.source_revision AND w.pending_changeset_json IS NULL
        AND EXISTS(SELECT 1 FROM calendar_connections c WHERE c.id=? AND c.account_id=? AND c.status='connected' AND c.auth_version=?)
        AND (SELECT COUNT(*) FROM recovery_actions a WHERE a.workspace_id=w.id) < 40
        AND NOT EXISTS(SELECT 1 FROM recovery_actions a WHERE a.workspace_id=w.id AND a.status IN ('queued','executing','uncertain'))
        ${recoveryOriginCurrentGuardSql('w.id')}`)
        .bind(actionId, now, workspaceId, ownerId, accountId, now, workspace.revision, workspace.source_revision, profile.condition_revision, connection.connectionId, accountId, connection.version, now),
      env.DB.prepare(`INSERT INTO recovery_actions(id,workspace_id,owner_id,account_id,request_id,connection_id,connection_version,base_revision,source_revision,condition_revision,kind,payload_json,payload_hash,status,progress_json,message,attempts,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?, 'queued', '{}', ?, 0, ?, ? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)`)
        .bind(actionId, workspaceId, ownerId, accountId, parsedCommand.requestId, connection.connectionId, connection.version, workspace.revision, workspace.source_revision, profile.condition_revision, kind, JSON.stringify(payload), payloadHash, actionMessage(kind, 'queued'), now, now, actionId),
      env.DB.prepare('INSERT INTO recovery_requests(owner_id,request_id,workspace_id,payload_hash,response_json,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
        .bind(ownerId, parsedCommand.requestId, workspaceId, commandHash, JSON.stringify({ actionId, payloadHash }), now, actionId),
      env.DB.prepare('INSERT INTO tx_abort(id) SELECT "abort" WHERE NOT EXISTS(SELECT 1 FROM tx_guards WHERE id=?)').bind(actionId),
      env.DB.prepare('DELETE FROM tx_guards WHERE id=?').bind(actionId),
    ]);
  } catch (error) {
    const saved = await replayAction(env.DB, ownerId, parsedCommand.requestId, commandHash);
    if (saved) return new RecoveryStore(env).read(ownerId, workspaceId);
    if (isUniqueError(error)) throw new ApiException('RECOVERY_ACTION_ACTIVE', '이미 실행 대기 중인 일정 조정 작업이 있습니다. 상태를 확인해 주세요.', 409);
    throw new ApiException('RECOVERY_ACTION_CONFLICT', '작업 상태가 바뀌어 외부 실행을 예약하지 못했습니다.', 409);
  }
  await deps.dispatch?.(actionId);
  return new RecoveryStore(env).read(ownerId, workspaceId);
}

export async function processRecoveryAction(env: AppBindings, actionId: string, deps: RecoveryActionDeps = {}): Promise<RecoveryActionStatus | null> {
  const now = deps.now?.() ?? nowIso();
  const claimed = await claimAction(env.DB, actionId, now);
  if (!claimed) return null;
  try {
    if (claimed.kind === 'calendar') return await processCalendarAction(env, claimed, deps);
    return await processEmailAction(env, claimed, deps);
  } catch (error) {
    if (error instanceof ActionStatusError) {
      await finishAction(env.DB, claimed.id, error.status, error.message, deps.now?.() ?? nowIso());
      return error.status;
    }
    if (error instanceof ApiException && [401, 403, 404].includes(error.status)) {
      await finishAction(env.DB, claimed.id, 'cancelled', '현재 계정·권한·작업 공간을 확인할 수 없어 실행을 중단했습니다.', deps.now?.() ?? nowIso());
      return 'cancelled';
    }
    await finishAction(env.DB, claimed.id, 'uncertain', '외부 실행 결과를 확정하지 못했습니다. 다시 실행하기 전에 provider 상태를 확인해야 합니다.', deps.now?.() ?? nowIso());
    return 'uncertain';
  }
}

export async function recoverPendingRecoveryActions(env: AppBindings, deps: RecoveryActionDeps = {}): Promise<{ queued: number; processed: number; uncertain: number }> {
  const now = deps.now?.() ?? nowIso();
  const limit = deps.maxRecover ?? 10;
  const stale = staleExecutingCutoff(now);
  await env.DB.prepare('UPDATE recovery_actions SET status="uncertain", message=?, updated_at=? WHERE status="executing" AND claimed_at < ?')
    .bind('실행 중 작업이 오래 응답하지 않아 확인 필요 상태로 전환했습니다.', now, stale).run();
  const rows = await env.DB.prepare('SELECT id FROM recovery_actions WHERE status="queued" ORDER BY created_at ASC LIMIT ?').bind(limit).all<{ id: string }>();
  let processed = 0;
  for (const row of rows.results ?? []) {
    const status = await processRecoveryAction(env, row.id, deps);
    if (status) processed += 1;
  }
  const uncertain = await env.DB.prepare('SELECT COUNT(*) AS count FROM recovery_actions WHERE status="uncertain"').first<{ count: number }>();
  return { queued: rows.results?.length ?? 0, processed, uncertain: uncertain?.count ?? 0 };
}

export async function buildCalendarPayload(input: {
  workspace: WorkspaceRow;
  ownerId: string;
  accountId: string;
  profile: RecoveryProfileRow;
  input: RecoveryInput;
  result: RecoveryReadyResult;
  connection: ConnectedCalendarProvider;
}): Promise<CalendarPayload> {
  requireScopes(input.connection.scopes, [GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE], 'Calendar');
  const events = [] as CalendarPayload['events'];
  for (const action of input.result.actions) {
    if (action.kind !== 'reschedule' || !action.itemId) continue;
    const eventId = await deterministicCalendarEventId(`${input.workspace.id}:${input.connection.connectionId}:${action.itemId}`);
    const operationId = `${input.workspace.id}:${input.profile.condition_revision}:${action.itemId}`;
    const payloadHash = await jsonHash({ itemId: action.itemId, after: action.after, title: action.title, conditionRevision: input.profile.condition_revision });
    events.push({ itemId: action.itemId, eventId, write: calendarEventWriteSchema.parse({
      id: eventId,
      summary: action.title,
      description: `이어짐 승인 일정 조정안 · ${action.reason}`,
      start: toCalendarDateTime(action.after.start),
      end: toCalendarDateTime(action.after.end),
      extendedProperties: { private: { ieojimOperationId: operationId, ieojimPayloadHash: payloadHash } },
    }) });
  }
  return {
    version: 1,
    kind: 'calendar',
    workspaceId: input.workspace.id,
    ownerId: input.ownerId,
    accountId: input.accountId,
    connectionId: input.connection.connectionId,
    connectionVersion: input.connection.version,
    calendarId: input.connection.calendarId,
    baseRevision: input.workspace.revision,
    sourceRevision: input.workspace.source_revision,
    conditionRevision: input.profile.condition_revision,
    resultHash: await jsonHash(input.result),
    events,
    freeBusy: { timeMin: toOffset(input.input.horizon.start), timeMax: toOffset(input.input.horizon.end), calendarIds: ['primary', input.connection.calendarId] },
  };
}

export function buildEmailPayload(input: {
  workspace: WorkspaceRow;
  ownerId: string;
  accountId: string;
  profile: RecoveryProfileRow;
  command: ReturnType<typeof emailRecoverySchema.parse>;
  connection: ConnectedCalendarProvider;
}): EmailPayload {
  requireScopes(input.connection.scopes, [GOOGLE_GMAIL_SEND_SCOPE], 'Gmail');
  const email = calendarEmailSchema.parse({
    to: input.command.recipient,
    subject: input.command.subject,
    body: input.command.body,
    operationId: `${input.workspace.id}:${input.profile.condition_revision}:email:${input.command.requestId}`,
  });
  return {
    version: 1,
    kind: 'email',
    workspaceId: input.workspace.id,
    ownerId: input.ownerId,
    accountId: input.accountId,
    connectionId: input.connection.connectionId,
    connectionVersion: input.connection.version,
    baseRevision: input.workspace.revision,
    sourceRevision: input.workspace.source_revision,
    conditionRevision: input.profile.condition_revision,
    recipient: email.to,
    subject: email.subject,
    body: email.body,
    operationId: email.operationId,
  };
}

async function processCalendarAction(env: AppBindings, row: RecoveryActionRow, deps: RecoveryActionDeps): Promise<RecoveryActionStatus> {
  const payload = await parsePayload(row, 'calendar');
  await assertActionStillCurrent(env, row, payload, deps);
  const mappings = await readMappings(env.DB, payload.workspaceId, payload.connectionId);
  const progress = await parseProgress(row.progress_json, payload, mappings);
  const connected = await (deps.getConnectedProvider ?? getConnectedProvider)(env, row.account_id, { db: env.DB });
  if (!connected.ok) throw new ActionStatusError(providerFailureStatus(connected.error.kind), providerFailureMessage(connected.error.kind));
  assertConnection(payload, connected.value);
  requireScopes(connected.value.scopes, [GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE], 'Calendar');
  await assertActionStillCurrent(env, row, payload, deps);
  const busy = await connected.value.provider.freeBusy(payload.freeBusy);
  if (!busy.ok) throw new ActionStatusError(providerFailureStatus(busy.error.kind), 'Calendar 가용 시간 조회를 확인하지 못했습니다. 빈 시간으로 간주하지 않습니다.');
  await assertActionStillCurrent(env, row, payload, deps);
  assertNoPrimaryBusyOverlap(payload, busy.value.blocks);
  const inventory = await connected.value.provider.listBusyEvents(payload.calendarId, { timeMin: payload.freeBusy.timeMin, timeMax: payload.freeBusy.timeMax });
  if (!inventory.ok) throw new ActionStatusError(providerFailureStatus(inventory.error.kind), '전용 Calendar의 전체 점유 일정을 확인하지 못해 적용을 중단했습니다.');
  await assertActionStillCurrent(env, row, payload, deps);
  const replaceableIds = new Set<string>();
  for (const event of payload.events) {
    const mapping = mappings.get(event.itemId);
    if (!mapping) continue;
    const current = await connected.value.provider.getEvent(payload.calendarId, mapping.event_id);
    const saved = JSON.parse(mapping.payload_json) as { write: CalendarEventWrite };
    if (!current.ok || current.value.etag !== mapping.etag || !eventMatches(current.value, saved.write)) {
      throw new ActionStatusError('conflict', '이전에 반영한 일정이 Calendar에서 변경되었습니다. 덮어쓰지 않고 재검토합니다.');
    }
    replaceableIds.add(mapping.event_id);
  }
  for (const occupied of inventory.value.events) {
    if (replaceableIds.has(occupied.id)) continue;
    if (!payload.events.some((event) => overlaps(event.write.start.dateTime, event.write.end.dateTime, occupied.start, occupied.end))) continue;
    const proposed = payload.events.find((event) => event.eventId === occupied.id);
    if (proposed) {
      const current = await connected.value.provider.getEvent(payload.calendarId, proposed.eventId);
      if (current.ok && eventMatches(current.value, proposed.write)) continue;
    }
    throw new ActionStatusError('conflict', '전용 Calendar에 승인한 시간과 겹치는 다른 일정이 있습니다.');
  }
  for (const event of payload.events) {
    const eventHash = await jsonHash(event.write);
    if (progress.completed?.[event.itemId]?.payloadHash === eventHash) continue;
    await assertActionStillCurrent(env, row, payload, deps);
    await upsertCalendarEvent(env.DB, connected.value.provider, payload.calendarId, payload.workspaceId, payload.connectionId, event, eventHash, row.id, () => assertActionStillCurrent(env, row, payload, deps));
    await assertActionStillCurrent(env, row, payload, deps);
    const mapping = await readMapping(env.DB, payload.workspaceId, payload.connectionId, event.itemId);
    if (!mapping) throw new ActionStatusError('uncertain', 'Calendar 적용 결과를 로컬에 기록하지 못했습니다.');
    progress.completed = { ...(progress.completed ?? {}), [event.itemId]: { eventId: event.eventId, etag: mapping.etag, payloadHash: eventHash } };
    await updateActionProgress(env.DB, row, JSON.stringify(progress), deps.now?.() ?? nowIso());
  }
  await finishAction(env.DB, row.id, 'verified', 'Calendar에서 승인한 이벤트 값을 다시 확인했습니다.', deps.now?.() ?? nowIso());
  return 'verified';
}

async function processEmailAction(env: AppBindings, row: RecoveryActionRow, deps: RecoveryActionDeps): Promise<RecoveryActionStatus> {
  const payload = await parsePayload(row, 'email');
  await assertActionStillCurrent(env, row, payload, deps);
  const connected = await (deps.getConnectedProvider ?? getConnectedProvider)(env, row.account_id, { db: env.DB });
  if (!connected.ok) throw new ActionStatusError(providerFailureStatus(connected.error.kind), providerFailureMessage(connected.error.kind));
  assertConnection(payload, connected.value);
  requireScopes(connected.value.scopes, [GOOGLE_GMAIL_SEND_SCOPE], 'Gmail');
  await assertActionStillCurrent(env, row, payload, deps);
  const sent = await connected.value.provider.sendEmail({ to: payload.recipient, subject: payload.subject, body: payload.body, operationId: payload.operationId });
  if (!sent.ok) {
    const status = sent.error.kind === 'unknown' ? 'uncertain' : providerFailureStatus(sent.error.kind);
    throw new ActionStatusError(status, sent.error.kind === 'unknown' ? '이메일 발송 결과를 확정하지 못했습니다. 같은 메일을 자동 재발송하지 않습니다.' : '이메일 발송이 거절되었습니다.');
  }
  const progress: EmailProgress = { receipt: { providerMessageId: sent.value.providerMessageId, acceptedAt: sent.value.acceptedAt, operationId: payload.operationId } };
  await updateActionProgress(env.DB, row, JSON.stringify(progress), deps.now?.() ?? nowIso());
  await finishAction(env.DB, row.id, 'accepted', 'Gmail이 승인한 메일 발송 요청을 접수했습니다. 수신·열람을 보장하지 않습니다.', deps.now?.() ?? nowIso());
  return 'accepted';
}

async function upsertCalendarEvent(db: D1Database, provider: CalendarProvider, calendarId: string, workspaceId: string, connectionId: string, event: CalendarPayload['events'][number], eventHash: string, actionId: string, assertCurrent: () => Promise<void>): Promise<void> {
  const existing = await readMapping(db, workspaceId, connectionId, event.itemId);
  await assertCurrent();
  let written: CalendarProviderResult<CalendarEventRead>;
  if (existing) {
    written = await provider.updateEvent(calendarId, event.eventId, event.write, existing.etag);
    if (!written.ok && written.error.kind === 'stale') throw new ActionStatusError('conflict', providerFailureMessage('stale'));
    if (!written.ok && ['conflict', 'not_found', 'unknown'].includes(written.error.kind)) {
      const read = await provider.getEvent(calendarId, event.eventId);
      if (read.ok && eventMatches(read.value, event.write)) written = read;
    }
  } else {
    written = await provider.insertEvent(calendarId, event.write);
    if (!written.ok && ['duplicate', 'unknown'].includes(written.error.kind)) {
      const read = await provider.getEvent(calendarId, event.eventId);
      if (read.ok && eventMatches(read.value, event.write)) written = read;
    }
  }
  if (!written.ok) throw new ActionStatusError(providerFailureStatus(written.error.kind), providerFailureMessage(written.error.kind));
  const readback = await provider.getEvent(calendarId, event.eventId);
  if (!readback.ok) throw new ActionStatusError(providerFailureStatus(readback.error.kind), providerFailureMessage(readback.error.kind));
  if (!eventMatches(readback.value, event.write)) throw new ActionStatusError('conflict', 'Calendar readback이 승인한 payload와 일치하지 않습니다.');
  await db.prepare(`INSERT INTO recovery_calendar_events(workspace_id,connection_id,item_id,event_id,etag,payload_json)
    VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,connection_id,item_id) DO UPDATE SET event_id=excluded.event_id, etag=excluded.etag, payload_json=excluded.payload_json`)
    .bind(workspaceId, connectionId, event.itemId, event.eventId, readback.value.etag, JSON.stringify({ actionId, hash: eventHash, write: event.write })).run();
}

async function assertActionStillCurrent(env: AppBindings, row: RecoveryActionRow, payload: ActionPayload, deps: RecoveryActionDeps): Promise<void> {
  const now = deps.now?.() ?? nowIso();
  if (payload.kind === 'calendar' && hasStartedSlot(payload, now)) throw new ActionStatusError('conflict', '실행 대기 중 변경 구간의 시작 시간이 지났습니다. 현재 시간 기준으로 다시 계획해 주세요.');
  const current = await env.DB.prepare(`SELECT a.status, a.connection_id, a.connection_version, c.status AS connection_status, c.auth_version
    FROM recovery_actions a LEFT JOIN calendar_connections c ON c.id=a.connection_id AND c.account_id=a.account_id
    WHERE a.id=? AND a.workspace_id=? AND a.owner_id=? AND a.account_id=?`)
    .bind(row.id, row.workspace_id, row.owner_id, row.account_id)
    .first<{ status: RecoveryActionStatus; connection_id: string; connection_version: number; connection_status: string | null; auth_version: number | null }>();
  if (!current || current.status !== 'executing') throw new ActionStatusError('cancelled', '외부 실행이 취소되었거나 더 이상 실행 상태가 아닙니다.');
  if (current.connection_id !== row.connection_id || current.connection_version !== row.connection_version) {
    throw new ActionStatusError('failed', '승인한 연결 기록이 변경되었습니다.');
  }
  if (current.connection_status !== 'connected' || current.auth_version !== row.connection_version) {
    throw new ActionStatusError('cancelled', 'Calendar 연결이 해제되었거나 다시 인증이 필요합니다.');
  }
  const workspace = await readWorkspaceForAccount(env.DB, row.owner_id, row.account_id, row.workspace_id, now);
  const origin = await readOriginState(env.DB, row.owner_id, row.workspace_id, now);
  if (!origin.current) throw new ActionStatusError('conflict', '기준 안내 작업 공간의 원문이나 결정 상태가 승인 이후 변경되었습니다.');
  const profile = await readProfile(env.DB, row.workspace_id);
  if (workspace.revision !== row.base_revision || workspace.source_revision !== row.source_revision || profile.condition_revision !== row.condition_revision || profile.applied_revision !== workspace.revision) {
    throw new ActionStatusError('conflict', '작업 공간 또는 일정 조정 조건이 승인 이후 변경되었습니다.');
  }
  if (payload.connectionId !== row.connection_id || payload.connectionVersion !== row.connection_version) {
    throw new ActionStatusError('failed', 'Calendar 연결 버전이 승인 기록과 다릅니다.');
  }
  const input = parseRecoveryInput(profile.input_json);
  const result = readyRecovery(repairSchedule(input));
  if (await jsonHash(result) !== ('resultHash' in payload ? payload.resultHash : await jsonHash(result))) {
    throw new ActionStatusError('conflict', '서버 재계산 결과가 승인 payload와 일치하지 않습니다.');
  }
}

async function claimAction(db: D1Database, actionId: string, now: string): Promise<RecoveryActionRow | null> {
  const result = await db.prepare('UPDATE recovery_actions SET status="executing", attempts=attempts+1, claimed_at=?, updated_at=? WHERE id=? AND status="queued"')
    .bind(now, now, actionId).run();
  if (!changed(result)) return null;
  return db.prepare('SELECT * FROM recovery_actions WHERE id=?').bind(actionId).first<RecoveryActionRow>();
}

async function finishAction(db: D1Database, actionId: string, status: RecoveryActionStatus, message: string, now: string): Promise<void> {
  const result = await db.prepare('UPDATE recovery_actions SET status=?, message=?, updated_at=? WHERE id=? AND status="executing"').bind(status, message, now, actionId).run();
  if (changed(result)) console.info(JSON.stringify({ event: 'recovery_action_finished', actionId, status }));
}

function hasStartedSlot(payload: CalendarPayload, now: string): boolean {
  return payload.events.some((event) => Date.parse(event.write.start.dateTime) < Date.parse(now));
}

async function readWorkspaceForAccount(db: D1Database, ownerId: string, accountId: string, workspaceId: string, now: string): Promise<WorkspaceRow> {
  const row = await db.prepare(`SELECT w.id,w.owner_id,w.revision,w.source_revision,w.deleted_at,w.expires_at FROM workspaces w JOIN owners o ON o.id=w.owner_id
    WHERE w.id=? AND w.owner_id=? AND o.account_id=? AND w.deleted_at IS NULL AND w.expires_at>?`)
    .bind(workspaceId, ownerId, accountId, now).first<WorkspaceRow>();
  if (!row) throw new ApiException('WORKSPACE_NOT_FOUND', '계정에 연결된 작업 공간을 찾을 수 없습니다.', 404);
  return row;
}

async function readProfile(db: D1Database, workspaceId: string): Promise<RecoveryProfileRow> {
  const row = await db.prepare('SELECT * FROM recovery_profiles WHERE workspace_id=?').bind(workspaceId).first<RecoveryProfileRow>();
  if (!row) throw new ApiException('RECOVERY_NOT_FOUND', '일정 조정 조건을 찾을 수 없습니다.', 404);
  return row;
}

async function readMapping(db: D1Database, workspaceId: string, connectionId: string, itemId: string): Promise<{ event_id: string; etag: string; payload_json: string } | null> {
  return db.prepare('SELECT event_id,etag,payload_json FROM recovery_calendar_events WHERE workspace_id=? AND connection_id=? AND item_id=?')
    .bind(workspaceId, connectionId, itemId).first<{ event_id: string; etag: string; payload_json: string }>();
}

async function readMappings(db: D1Database, workspaceId: string, connectionId: string): Promise<Map<string, { event_id: string; etag: string; payload_json: string }>> {
  const rows = await db.prepare('SELECT item_id,event_id,etag,payload_json FROM recovery_calendar_events WHERE workspace_id=? AND connection_id=?')
    .bind(workspaceId, connectionId).all<{ item_id: string; event_id: string; etag: string; payload_json: string }>();
  return new Map((rows.results ?? []).map((row) => [row.item_id, { event_id: row.event_id, etag: row.etag, payload_json: row.payload_json }]));
}

async function replayAction(db: D1Database, ownerId: string, requestId: string, hash: string): Promise<unknown | null> {
  const row = await db.prepare('SELECT payload_hash,response_json FROM recovery_requests WHERE owner_id=? AND request_id=?').bind(ownerId, requestId).first<{ payload_hash: string; response_json: string }>();
  if (!row) return null;
  if (row.payload_hash !== hash) throw new ApiException('IDEMPOTENCY_CONFLICT', '같은 요청 번호로 다른 외부 실행을 예약할 수 없습니다.', 409);
  return JSON.parse(row.response_json);
}

function assertAppliedReadyBase(workspace: WorkspaceRow, profile: RecoveryProfileRow, baseRevision: number, conditionRevision: number): void {
  if (workspace.revision !== baseRevision || workspace.source_revision !== profile.base_source_revision || profile.condition_revision !== conditionRevision || profile.applied_revision !== workspace.revision) {
    throw new ApiException('STALE_RECOVERY_APPROVAL', '저장된 일정 조정안과 현재 작업 공간 버전이 다릅니다.', 409);
  }
}

function readyRecovery(result: RecoveryResult): RecoveryReadyResult {
  if (result.status !== 'ready') throw new ApiException('RECOVERY_NOT_READY', result.message, 422);
  return result;
}

function parseRecoveryInput(json: string): RecoveryInput {
  return JSON.parse(json) as RecoveryInput;
}

async function parsePayload<T extends ActionKind>(row: RecoveryActionRow, kind: T): Promise<T extends 'calendar' ? CalendarPayload : EmailPayload> {
  const payload = JSON.parse(row.payload_json) as ActionPayload;
  if (payload.kind !== kind) throw new ActionStatusError('failed', '저장된 외부 실행 payload 종류가 올바르지 않습니다.');
  if (await jsonHash(payload) !== row.payload_hash) throw new ActionStatusError('failed', '저장된 외부 실행 payload가 승인 기록과 일치하지 않습니다.');
  if (payload.workspaceId !== row.workspace_id || payload.ownerId !== row.owner_id || payload.accountId !== row.account_id ||
    payload.connectionId !== row.connection_id || payload.connectionVersion !== row.connection_version ||
    payload.baseRevision !== row.base_revision || payload.sourceRevision !== row.source_revision || payload.conditionRevision !== row.condition_revision) {
    throw new ActionStatusError('failed', '저장된 외부 실행 payload 경계가 action 기록과 일치하지 않습니다.');
  }
  return payload as T extends 'calendar' ? CalendarPayload : EmailPayload;
}

async function parseProgress(
  json: string,
  payload: CalendarPayload,
  mappings: Map<string, { event_id: string; etag: string; payload_json: string }>,
): Promise<CalendarProgress> {
  const raw = parseProgressJson(json);
  if (!isPlainObject(raw)) throw unreliableProgress();
  const completedRaw = raw.completed;
  if (completedRaw === undefined) return {};
  if (!isPlainObject(completedRaw)) throw unreliableProgress();
  const completed: CalendarProgress['completed'] = {};
  const eventsByItemId = new Map(payload.events.map((event) => [event.itemId, event]));
  for (const [itemId, entry] of Object.entries(completedRaw)) {
    const event = eventsByItemId.get(itemId);
    if (!event || !isProgressEntry(entry)) throw unreliableProgress();
    const eventHash = await jsonHash(event.write);
    if (entry.eventId !== event.eventId || entry.payloadHash !== eventHash) throw unreliableProgress();
    const mapping = mappings.get(itemId);
    if (!mapping || mapping.event_id !== entry.eventId || mapping.etag !== entry.etag) throw unreliableProgress();
    const saved = parseMappingPayload(mapping.payload_json);
    if (saved.hash !== eventHash) throw unreliableProgress();
    completed[itemId] = entry;
  }
  return { completed };
}

function parseProgressJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw unreliableProgress();
  }
}

function parseMappingPayload(json: string): { hash: string } {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isPlainObject(parsed) || !isHash64(parsed.hash)) throw unreliableProgress();
    return { hash: parsed.hash };
  } catch (error) {
    if (error instanceof ActionStatusError) throw error;
    throw unreliableProgress();
  }
}

function isProgressEntry(value: unknown): value is { eventId: string; etag: string; payloadHash: string } {
  return isPlainObject(value) && nonEmptyString(value.eventId) && nonEmptyString(value.etag) && isHash64(value.payloadHash);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isHash64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function unreliableProgress(): ActionStatusError {
  return new ActionStatusError('uncertain', 'Calendar 진행 기록을 신뢰할 수 없어 provider 작업을 중단했습니다. 재시도 전에 로컬 기록을 점검해야 합니다.');
}

function requireScopes(scopes: string[], required: string[], label: string): void {
  const missing = required.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) throw new ApiException(`${label.toUpperCase()}_SCOPE_MISSING`, `${label} 실행에 필요한 권한이 연결되지 않았습니다.`, 403);
}

function assertConnection(payload: Pick<ActionPayload, 'connectionId' | 'connectionVersion'>, connection: ConnectedCalendarProvider): void {
  if (payload.connectionId !== connection.connectionId || payload.connectionVersion !== connection.version) {
    throw new ActionStatusError('failed', '연결 버전이 승인 이후 변경되었습니다. 다시 승인해 주세요.');
  }
  if ('calendarId' in payload && payload.calendarId !== connection.calendarId) {
    throw new ActionStatusError('failed', '승인한 Calendar 대상이 현재 연결과 다릅니다.');
  }
}

function assertNoPrimaryBusyOverlap(payload: CalendarPayload, blocks: FreeBusyBlock[]): void {
  const expectedCalendars = new Set(['primary', payload.calendarId]);
  if (payload.freeBusy.calendarIds.length !== expectedCalendars.size || payload.freeBusy.calendarIds.some((id) => !expectedCalendars.has(id))) {
    throw new ActionStatusError('failed', 'Calendar 가용 시간 조회 범위가 승인한 범위와 다릅니다.');
  }
  for (const event of payload.events) {
    if (blocks.some((block) => block.calendarId === 'primary' && overlaps(event.write.start.dateTime, event.write.end.dateTime, block.start, block.end))) {
      throw new ActionStatusError('conflict', '기본 Calendar에 승인한 시간과 겹치는 일정이 있습니다.');
    }
  }
}

function eventMatches(read: CalendarEventRead, write: CalendarEventWrite): boolean {
  return read.id === write.id && read.summary === write.summary &&
    sameInstant(read.start.dateTime, write.start.dateTime) && sameInstant(read.end.dateTime, write.end.dateTime) &&
    read.start.timeZone === write.start.timeZone && read.end.timeZone === write.end.timeZone &&
    (read.description ?? '') === (write.description ?? '') &&
    read.extendedProperties.private.ieojimOperationId === write.extendedProperties.private.ieojimOperationId &&
    read.extendedProperties.private.ieojimPayloadHash === write.extendedProperties.private.ieojimPayloadHash;
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

async function updateActionProgress(db: D1Database, row: RecoveryActionRow, progressJson: string, now: string): Promise<void> {
  const result = await db.prepare(`UPDATE recovery_actions SET progress_json=?, updated_at=?
    WHERE id=? AND status="executing" AND connection_id=? AND connection_version=?`)
    .bind(progressJson, now, row.id, row.connection_id, row.connection_version).run();
  if (!changed(result)) throw new ActionStatusError('cancelled', '외부 실행 상태가 바뀌어 진행 상황을 기록하지 않았습니다.');
}

function toCalendarDateTime(value: string): CalendarEventWrite['start'] {
  return { dateTime: toOffset(value), timeZone: 'Asia/Seoul' };
}

function toOffset(value: string): string {
  return `${value}:00+09:00`;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

function providerSetupException(kind: string): ApiException {
  const statuses: Record<string, number> = { not_configured: 503, not_connected: 409, calendar_missing: 409, reauth_required: 401, forbidden: 403, unknown: 503 };
  return new ApiException(`CALENDAR_${kind.toUpperCase()}`, 'Calendar 연결 상태를 확인해야 합니다.', statuses[kind] ?? 409);
}

function providerFailureStatus(kind: string): RecoveryActionStatus {
  if (kind === 'stale' || kind === 'conflict' || kind === 'duplicate') return 'conflict';
  if (kind === 'unknown' || kind === 'invalid_provider_response') return 'uncertain';
  if (kind === 'not_connected' || kind === 'reauth_required' || kind === 'calendar_missing') return 'cancelled';
  return 'failed';
}

function providerFailureMessage(kind: string): string {
  if (kind === 'unknown' || kind === 'invalid_provider_response') return '외부 provider 결과를 확정하지 못했습니다. 재조회 또는 수동 확인이 필요합니다.';
  if (kind === 'stale' || kind === 'conflict') return '외부 provider 상태가 승인 시점과 달라졌습니다.';
  if (kind === 'reauth_required') return 'Calendar 권한을 다시 연결해야 합니다.';
  return '외부 실행이 실패했습니다.';
}

function actionMessage(kind: ActionKind, status: RecoveryActionStatus): string {
  if (status === 'queued') return kind === 'calendar' ? 'Calendar 적용 대기 중입니다.' : '이메일 발송 대기 중입니다.';
  return '';
}

function staleExecutingCutoff(now: string): string {
  return new Date(Date.parse(now) - 10 * 60_000).toISOString();
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

function changed(result: D1Result<unknown>): boolean {
  return (result.meta.changes ?? 0) > 0;
}

class ActionStatusError extends Error {
  constructor(readonly status: RecoveryActionStatus, message: string) {
    super(message);
    this.name = 'ActionStatusError';
  }
}
