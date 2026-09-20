import {
  CALENDAR_WATCH_DURATION_MS,
  CALENDAR_WATCH_INTERVAL_MS,
  CALENDAR_WATCH_MAX_FAILURES,
  checkCalendarVerificationSchema,
  configureCalendarWatchSchema,
  type CalendarVerificationEvent,
  type CalendarVerificationStatus,
  type CalendarVerificationView,
  type CheckCalendarVerificationCommand,
  type ConfigureCalendarWatchCommand,
} from '../../core/recovery-verification-contracts';
import {
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  calendarEventWriteSchema,
  type CalendarEventRead,
  type CalendarEventWrite,
  type CalendarProviderErrorKind,
  type CalendarProviderFailure,
  type ConnectedCalendarProvider,
} from '../../core/calendar-contracts';
import { jsonHash, randomId } from '../crypto';
import { ApiException } from '../errors';
import { nowIso, type AppBindings } from '../http';
import { getConnectedProvider } from '../calendar/store';
import { readOriginState, recoveryOriginCurrentGuardSql } from './origin';
import type { RecoveryActionDeps } from './actions';

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

type ActionRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  account_id: string;
  connection_id: string;
  connection_version: number;
  base_revision: number;
  source_revision: number;
  condition_revision: number;
  kind: string;
  payload_json: string;
  payload_hash: string;
  status: string;
};

type WorkspaceRow = { id: string; owner_id: string; revision: number; source_revision: number; deleted_at: string | null; expires_at: string };
type ProfileRow = { workspace_id: string; condition_revision: number; base_revision: number; base_source_revision: number; applied_revision: number | null };
type MappingRow = { item_id: string; event_id: string; etag: string; payload_json: string };

type VerificationRow = {
  action_id: string;
  workspace_id: string;
  owner_id: string;
  account_id: string;
  connection_id: string;
  connection_version: number;
  payload_hash: string;
  status: CalendarVerificationStatus;
  last_result_json: string;
  checked_at: string | null;
  watch_enabled: number;
  watch_expires_at: string | null;
  next_check_at: string | null;
  consecutive_failures: number;
  stopped_reason: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
};

type VerificationResult = {
  status: CalendarVerificationStatus;
  message: string;
  events: CalendarVerificationEvent[];
  checkedAt: string | null;
  consecutiveFailures?: number;
  stopWatch?: boolean;
  stoppedReason?: string | null;
  nextCheckAt?: string | null;
};

type ClaimedVerification = { row: VerificationRow; action: ActionRow; payload: CalendarPayload; claimToken: string };

const MAX_EVENTS = 30;
const MAX_RECOVER = 5;
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const MANUAL_CHECK_COOLDOWN_MS = 60 * 1000;
const MAX_RECOVERY_REQUESTS_PER_WORKSPACE = 200;
const MANUAL_CHECK_BUDGET_MS = 30 * 1000;
const REQUEST_NAMESPACE_CHECK = 'calendar_verification_check';
const REQUEST_NAMESPACE_CONFIGURE = 'calendar_verification_configure';

export async function readCalendarVerifications(db: D1Database, ownerId: string, workspaceId: string): Promise<Map<string, CalendarVerificationView>> {
  const rows = await db.prepare('SELECT * FROM recovery_calendar_verifications WHERE owner_id=? AND workspace_id=?')
    .bind(ownerId, workspaceId)
    .all<VerificationRow>();
  return new Map((rows.results ?? []).map((row) => [row.action_id, viewFromRow(row)]));
}

export async function checkCalendarVerification(
  env: AppBindings,
  ownerId: string,
  accountId: string,
  workspaceId: string,
  command: CheckCalendarVerificationCommand,
  deps: RecoveryActionDeps = {},
): Promise<CalendarVerificationView> {
  const parsed = checkCalendarVerificationSchema.parse(command);
  const payloadHash = await jsonHash({ kind: REQUEST_NAMESPACE_CHECK, workspaceId, command: parsed });
  const replay = await replayRequest(env.DB, ownerId, workspaceId, parsed.requestId, payloadHash);
  if (replay) return replay;

  const now = deps.now?.() ?? nowIso();
  const action = await readVerifiedCalendarAction(env.DB, ownerId, accountId, workspaceId, parsed.actionId, parsed.baseRevision, parsed.conditionRevision, now);
  const payload = await parsePayload(action);
  await enforceManualCooldown(env.DB, action.id, now);
  const reserved = await reserveRequest(env.DB, ownerId, workspaceId, parsed.requestId, payloadHash, checkingView(action.id), now);
  if (reserved.replay) return reserved.view;

  const claim = await claimVerification(env.DB, action, payload, now, false);
  if (!claim) {
    const view = await currentOrChecking(env.DB, action);
    await updateRequestReceipt(env.DB, ownerId, parsed.requestId, payloadHash, view, now);
    return view;
  }

  const result = await verifyClaim(env, claim, deps, false);
  const view = await finishClaim(env.DB, claim, result, deps.now?.() ?? nowIso(), false);
  await updateRequestReceipt(env.DB, ownerId, parsed.requestId, payloadHash, view, deps.now?.() ?? nowIso());
  return view;
}

export async function configureCalendarWatch(
  env: AppBindings,
  ownerId: string,
  accountId: string,
  workspaceId: string,
  command: ConfigureCalendarWatchCommand,
  deps: RecoveryActionDeps = {},
): Promise<CalendarVerificationView> {
  const parsed = configureCalendarWatchSchema.parse(command);
  const payloadHash = await jsonHash({ kind: REQUEST_NAMESPACE_CONFIGURE, workspaceId, command: parsed });
  const replay = await replayRequest(env.DB, ownerId, workspaceId, parsed.requestId, payloadHash);
  if (replay) return replay;
  const now = deps.now?.() ?? nowIso();

  if (!parsed.enabled) {
    const action = await readCalendarActionForDisable(env.DB, ownerId, accountId, workspaceId, parsed.actionId);
    const existing = await env.DB.prepare('SELECT action_id FROM recovery_calendar_verifications WHERE action_id=?').bind(action.id).first();
    const view = existing ? viewFromRow(await updateWatchDisabled(env.DB, action.id, now, 'user_disabled'))
      : fallbackView(action.id, 'not_checked', '반복 확인이 꺼져 있습니다.', null);
    // Cancellation must remain available even after the request ledger reaches its cap.
    await recordCancellationReceipt(env.DB, ownerId, workspaceId, parsed.requestId, payloadHash, view, now);
    return view;
  }

  const action = await readVerifiedCalendarAction(env.DB, ownerId, accountId, workspaceId, parsed.actionId, parsed.baseRevision, parsed.conditionRevision, now);
  const payload = await parsePayload(action);
  const workspace = await readCurrentWorkspace(env.DB, ownerId, accountId, workspaceId, now);
  const stale = await assertCurrentBase(env.DB, action, workspace, now, payload);
  if (stale) throw new ApiException('CALENDAR_VERIFICATION_STALE', stale.message, 409);
  const expiresAt = watchExpiresAt(now, workspace.expires_at, payload.freeBusy.timeMax);
  if (!expiresAt) throw new ApiException('CALENDAR_WATCH_WINDOW_CLOSED', '확인할 수 있는 시간이 지나 자동 확인을 켤 수 없습니다.', 409);
  const reserved = await reserveRequest(env.DB, ownerId, workspaceId, parsed.requestId, payloadHash, checkingView(action.id), now);
  if (reserved.replay) return reserved.view;
  await ensureVerificationRow(env.DB, action, payload, now);
  const row = await updateWatchEnabled(env.DB, action, expiresAt, now);
  const view = viewFromRow(row);
  await updateRequestReceipt(env.DB, ownerId, parsed.requestId, payloadHash, view, now);
  return view;
}

export async function recoverCalendarVerifications(env: AppBindings, deps: RecoveryActionDeps = {}): Promise<{ claimed: number; matched: number; attention: number }> {
  const now = deps.now?.() ?? nowIso();
  await sweepExpiredWatches(env.DB, now);
  const limit = Number.isFinite(deps.maxRecover) ? Math.min(Math.max(1, Math.floor(deps.maxRecover!)), MAX_RECOVER) : MAX_RECOVER;
  const rows = await env.DB.prepare(`SELECT v.* FROM recovery_calendar_verifications v
    JOIN recovery_actions a ON a.id=v.action_id
    JOIN workspaces w ON w.id=v.workspace_id
    WHERE v.watch_enabled=1 AND v.next_check_at IS NOT NULL AND v.next_check_at<=? AND v.watch_expires_at>? AND w.deleted_at IS NULL AND w.expires_at>?
      AND (v.status <> 'checking' OR v.claimed_at IS NULL OR v.claimed_at < ?)
    ORDER BY v.next_check_at ASC LIMIT ?`)
    .bind(now, now, now, leaseCutoff(now), limit)
    .all<VerificationRow>();

  let claimed = 0;
  let matched = 0;
  let attention = 0;
  for (const due of rows.results ?? []) {
    try {
      const action = await env.DB.prepare('SELECT * FROM recovery_actions WHERE id=? AND workspace_id=? AND owner_id=? AND account_id=?')
        .bind(due.action_id, due.workspace_id, due.owner_id, due.account_id)
        .first<ActionRow>();
      if (!action) continue;
      const payload = await parsePayload(action);
      const claim = await claimVerification(env.DB, action, payload, now, true);
      if (!claim) continue;
      claimed += 1;
      const result = await verifyClaim(env, claim, deps, true);
      const view = await finishClaim(env.DB, claim, result, deps.now?.() ?? nowIso(), true);
      if (view.status === 'matched') matched += 1;
      if (['drifted', 'stale', 'unavailable'].includes(view.status) && !view.watch.enabled) attention += 1;
    } catch {
      // A malformed saved action must not prevent other owners' checks from running.
      await env.DB.prepare(`UPDATE recovery_calendar_verifications SET status='unavailable', watch_enabled=0, next_check_at=NULL,
        claim_token=NULL, claimed_at=NULL, stopped_reason='invalid_record', last_result_json=?, updated_at=?
        WHERE action_id=? AND updated_at=? AND claim_token IS ?`)
        .bind(JSON.stringify({ message: '저장된 확인 기록을 점검해야 해서 반복 확인을 중지했습니다.', events: [] }), now, due.action_id, due.updated_at, due.claim_token).run();
      attention += 1;
      console.warn(JSON.stringify({ event: 'calendar_verification_record_failed', actionId: due.action_id }));
    }
  }
  return { claimed, matched, attention };
}

async function readVerifiedCalendarAction(db: D1Database, ownerId: string, accountId: string, workspaceId: string, actionId: string, baseRevision: number, conditionRevision: number, now: string): Promise<ActionRow> {
  const row = await db.prepare(`SELECT a.* FROM recovery_actions a JOIN workspaces w ON w.id=a.workspace_id AND w.owner_id=a.owner_id
    JOIN owners o ON o.id=w.owner_id AND o.account_id=a.account_id
    WHERE a.id=? AND a.workspace_id=? AND a.owner_id=? AND a.account_id=? AND a.kind='calendar' AND a.status='verified'
      AND a.base_revision=? AND a.condition_revision=? AND w.deleted_at IS NULL AND w.expires_at>?`)
    .bind(actionId, workspaceId, ownerId, accountId, baseRevision, conditionRevision, now)
    .first<ActionRow>();
  if (!row) throw new ApiException('CALENDAR_VERIFICATION_NOT_AVAILABLE', '검증된 Calendar 실행 기록을 찾지 못했습니다.', 404);
  return row;
}

async function readCalendarActionForDisable(db: D1Database, ownerId: string, accountId: string, workspaceId: string, actionId: string): Promise<ActionRow> {
  const row = await db.prepare(`SELECT a.* FROM recovery_actions a JOIN workspaces w ON w.id=a.workspace_id AND w.owner_id=a.owner_id
    JOIN owners o ON o.id=w.owner_id AND o.account_id=a.account_id
    WHERE a.id=? AND a.workspace_id=? AND a.owner_id=? AND a.account_id=? AND a.kind='calendar' AND w.deleted_at IS NULL`)
    .bind(actionId, workspaceId, ownerId, accountId)
    .first<ActionRow>();
  if (!row) throw new ApiException('CALENDAR_VERIFICATION_NOT_FOUND', 'Calendar 실행 기록을 찾지 못했습니다.', 404);
  return row;
}

async function claimVerification(db: D1Database, action: ActionRow, payload: CalendarPayload, now: string, dueOnly: boolean): Promise<ClaimedVerification | null> {
  await ensureVerificationRow(db, action, payload, now);
  const token = randomId('cal_ver_claim');
  const dueClause = dueOnly ? 'AND watch_enabled=1 AND next_check_at IS NOT NULL AND next_check_at<=? AND watch_expires_at>?' : 'AND (checked_at IS NULL OR checked_at<=?)';
  const bindings = dueOnly
    ? [token, now, now, action.id, action.payload_hash, now, now, leaseCutoff(now)]
    : [token, now, now, action.id, action.payload_hash, new Date(Date.parse(now) - MANUAL_CHECK_COOLDOWN_MS).toISOString(), leaseCutoff(now)];
  const result = await db.prepare(`UPDATE recovery_calendar_verifications SET status='checking', claim_token=?, claimed_at=?, updated_at=?
    WHERE action_id=? AND payload_hash=? ${dueClause}
      AND (status <> 'checking' OR claimed_at IS NULL OR claimed_at < ?)`)
    .bind(...bindings)
    .run();
  if (!changed(result)) return null;
  const row = await db.prepare('SELECT * FROM recovery_calendar_verifications WHERE action_id=? AND claim_token=?')
    .bind(action.id, token)
    .first<VerificationRow>();
  return row ? { row, action, payload, claimToken: token } : null;
}

async function ensureVerificationRow(db: D1Database, action: ActionRow, payload: CalendarPayload, now: string): Promise<void> {
  await db.prepare(`INSERT INTO recovery_calendar_verifications(
      action_id, workspace_id, owner_id, account_id, connection_id, connection_version, payload_hash, status, last_result_json, watch_enabled, consecutive_failures, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'not_checked', '{}', 0, 0, ?, ?)
    ON CONFLICT(action_id) DO UPDATE SET updated_at=recovery_calendar_verifications.updated_at`)
    .bind(action.id, action.workspace_id, action.owner_id, action.account_id, payload.connectionId, payload.connectionVersion, action.payload_hash, now, now)
    .run();
}

async function currentOrChecking(db: D1Database, action: ActionRow): Promise<CalendarVerificationView> {
  const row = await db.prepare('SELECT * FROM recovery_calendar_verifications WHERE action_id=?').bind(action.id).first<VerificationRow>();
  if (row?.status === 'checking') return viewFromRow(row);
  if (row) throw manualCooldownError();
  return {
    actionId: action.id,
    status: 'checking',
    message: '다른 확인 요청이 같은 Calendar 실행 기록을 확인하고 있습니다.',
    checkedAt: null,
    events: [],
    watch: { enabled: false, expiresAt: null, nextCheckAt: null, consecutiveFailures: 0, stoppedReason: null },
  } satisfies CalendarVerificationView;
}

async function verifyClaim(env: AppBindings, claim: ClaimedVerification, deps: RecoveryActionDeps, fromWatch: boolean): Promise<VerificationResult> {
  const started = deps.now?.() ?? nowIso();
  const deadlineMs = Date.now() + MANUAL_CHECK_BUDGET_MS;
  try {
    if (claim.payload.events.length > MAX_EVENTS || claim.payload.events.length < 1) {
      return { status: 'unavailable', message: '확인할 Calendar 일정 개수가 한도를 벗어났습니다.', checkedAt: started, events: [], stopWatch: true, stoppedReason: 'event_limit' };
    }
    const stale = await currentStateFailure(env.DB, claim, deps.now?.() ?? nowIso(), fromWatch);
    if (stale) return stale;

    const connected = await boundedRead((deps.getConnectedProvider ?? getConnectedProvider)(env, claim.action.account_id, { db: env.DB }), deadlineMs);
    if (!connected.ok) return providerFailureResult(connected.error.kind, started, claim.row.consecutive_failures, fromWatch);
    const connectionFailure = assertConnectionAndScopes(claim.payload, connected.value, started);
    if (connectionFailure) return connectionFailure;

    const mappings = await readMappings(env.DB, claim.payload.workspaceId, claim.payload.connectionId);
    const events: CalendarVerificationEvent[] = [];
    for (const event of claim.payload.events) {
      if (Date.now() >= deadlineMs) return transientFailureResult('Calendar 확인 시간이 길어져 중단했습니다. 자동으로 변경하지 않았습니다.', started, claim.row.consecutive_failures, fromWatch, 'read_budget_exceeded');
      const preRead = await currentStateFailure(env.DB, claim, deps.now?.() ?? nowIso(), fromWatch);
      if (preRead) return preRead;
      const mappingFailure = await validateMappingOwnership(mappings.get(event.itemId), event, claim.action.id, started);
      if (mappingFailure) return mappingFailure;
      const read = await boundedRead(connected.value.provider.getEvent(claim.payload.calendarId, event.eventId), deadlineMs);
      if (!read.ok) {
        if (read.error.kind === 'not_found') {
          events.push({ itemId: event.itemId, title: event.write.summary, status: 'missing', differences: ['identity'] });
          continue;
        }
        return providerReadFailureResult(read.error, started, claim.row.consecutive_failures, fromWatch);
      }
      events.push(compareEvent(event.itemId, event.write, read.value, mappings.get(event.itemId)?.etag ?? null));
    }

    const finalState = await currentStateFailure(env.DB, claim, deps.now?.() ?? nowIso(), fromWatch);
    if (finalState) return finalState;
    const drifted = events.some((event) => event.status !== 'matched');
    if (drifted) {
      return { status: 'drifted', message: 'Calendar에서 승인한 일정과 다른 값을 발견했습니다. 자동으로 덮어쓰지 않았습니다.', checkedAt: deps.now?.() ?? nowIso(), events, stopWatch: true, stoppedReason: 'attention_needed' };
    }
    return { status: 'matched', message: '이번 조회에서 Calendar 일정이 승인한 내용과 일치했습니다.', checkedAt: deps.now?.() ?? nowIso(), events, consecutiveFailures: 0, nextCheckAt: fromWatch ? nextWatchCheck(deps.now?.() ?? nowIso(), claim.row.watch_expires_at) : claim.row.next_check_at };
  } catch {
    return transientFailureResult('Calendar 상태를 확인하지 못했습니다. 자동으로 변경하지 않았습니다.', started, claim.row.consecutive_failures, fromWatch, 'exception');
  }
}

async function currentStateFailure(db: D1Database, claim: ClaimedVerification, now: string, fromWatch: boolean): Promise<VerificationResult | null> {
  const current = await db.prepare(`SELECT
      v.status AS verification_status, v.claim_token, v.watch_enabled, v.watch_expires_at,
      a.status AS action_status, a.payload_hash, a.connection_id, a.connection_version,
      c.status AS connection_status, c.auth_version, c.scopes_json, c.calendar_id,
      w.id,w.owner_id,w.revision,w.source_revision,w.deleted_at,w.expires_at
    FROM recovery_calendar_verifications v
    JOIN recovery_actions a ON a.id=v.action_id AND a.workspace_id=v.workspace_id AND a.owner_id=v.owner_id AND a.account_id=v.account_id
    JOIN workspaces w ON w.id=v.workspace_id AND w.owner_id=v.owner_id
    JOIN owners o ON o.id=w.owner_id AND o.account_id=v.account_id
    LEFT JOIN calendar_connections c ON c.id=v.connection_id AND c.account_id=v.account_id
    WHERE v.action_id=? AND v.workspace_id=? AND v.owner_id=? AND v.account_id=?`)
    .bind(claim.action.id, claim.action.workspace_id, claim.action.owner_id, claim.action.account_id)
    .first<WorkspaceRow & { verification_status: string; claim_token: string | null; watch_enabled: number; watch_expires_at: string | null; action_status: string; payload_hash: string; connection_id: string; connection_version: number; connection_status: string | null; auth_version: number | null; scopes_json: string | null; calendar_id: string | null }>();
  if (!current || current.deleted_at !== null || current.expires_at <= now) return staleResult('작업 공간이 삭제되었거나 만료되어 Calendar 확인을 중단했습니다.', 'workspace_unavailable', now);
  if (current.verification_status !== 'checking' || current.claim_token !== claim.claimToken) return unavailableResult('Calendar 확인이 취소되었거나 새 확인으로 바뀌었습니다.', 'claim_changed', now);
  if (fromWatch && (current.watch_enabled !== 1 || !current.watch_expires_at || current.watch_expires_at <= now)) return unavailableResult('자동 확인 기간이 끝났습니다.', 'watch_expired', now);
  if (current.action_status !== 'verified' || current.payload_hash !== claim.action.payload_hash) return staleResult('Calendar 실행 기록이 바뀌어 확인을 중단했습니다.', 'action_changed', now);
  if (current.connection_id !== claim.action.connection_id || current.connection_version !== claim.action.connection_version || current.connection_status !== 'connected' || current.auth_version !== claim.action.connection_version || current.calendar_id !== claim.payload.calendarId) {
    return unavailableResult('Calendar 연결이 바뀌었거나 다시 인증이 필요합니다.', 'connection_unavailable', now);
  }
  const scopes = parseScopes(current.scopes_json);
  if (!scopes.includes(GOOGLE_CALENDAR_APP_CREATED_SCOPE)) return unavailableResult('Calendar 확인 권한이 없어 확인을 중단했습니다.', 'scope_missing', now);
  return assertCurrentBase(db, claim.action, current, now, claim.payload);
}


async function assertCurrentBase(db: D1Database, action: ActionRow, workspace: WorkspaceRow, now: string, payload?: CalendarPayload): Promise<VerificationResult | null> {
  const profile = await db.prepare('SELECT workspace_id,condition_revision,base_revision,base_source_revision,applied_revision FROM recovery_profiles WHERE workspace_id=?')
    .bind(action.workspace_id)
    .first<ProfileRow>();
  if (!profile) return staleResult('일정 조정 조건을 찾지 못해 Calendar 확인을 중단했습니다.', 'profile_missing', now);
  const origin = await readOriginState(db, action.owner_id, action.workspace_id, now);
  if (!origin.current) return staleResult('기준 안내 작업 공간이 바뀌어 Calendar 확인을 중단했습니다.', 'origin_stale', now);
  const payloadMatches = !payload || (payload.workspaceId === action.workspace_id && payload.ownerId === action.owner_id && payload.accountId === action.account_id && payload.baseRevision === action.base_revision && payload.sourceRevision === action.source_revision && payload.conditionRevision === action.condition_revision);
  if (!payloadMatches || workspace.revision !== action.base_revision || workspace.source_revision !== action.source_revision || profile.condition_revision !== action.condition_revision || profile.applied_revision !== workspace.revision) {
    return staleResult('저장된 계획이나 일정 조정 조건이 승인 이후 바뀌어 Calendar 확인을 중단했습니다.', 'local_stale', now);
  }
  return null;
}

async function finishClaim(db: D1Database, claim: ClaimedVerification, result: VerificationResult, now: string, fromWatch: boolean): Promise<CalendarVerificationView> {
  const failures = result.status === 'unavailable'
    ? Math.min(CALENDAR_WATCH_MAX_FAILURES, result.consecutiveFailures ?? claim.row.consecutive_failures)
    : (result.consecutiveFailures ?? 0);
  const candidateNext = result.nextCheckAt !== undefined ? result.nextCheckAt : (fromWatch && result.status === 'unavailable' ? retryAfter(now, failures) : claim.row.next_check_at);
  const expired = claim.row.watch_enabled === 1 && (!candidateNext || !claim.row.watch_expires_at || candidateNext >= claim.row.watch_expires_at);
  const stopWatch = Boolean(result.stopWatch || expired || (result.status === 'unavailable' && failures >= CALENDAR_WATCH_MAX_FAILURES));
  const nextCheckAt = stopWatch ? null : candidateNext;
  const stoppedReason = stopWatch ? (result.stoppedReason ?? (expired ? 'watch_expired' : result.status === 'unavailable' ? 'transient_failure_limit' : result.status)) : null;
  const updated = await db.prepare(`UPDATE recovery_calendar_verifications
    SET status=?, last_result_json=?, checked_at=?, watch_enabled=CASE WHEN ? THEN 0 ELSE watch_enabled END,
      next_check_at=?, consecutive_failures=?, stopped_reason=?, claim_token=NULL, claimed_at=NULL, updated_at=?
    WHERE action_id=? AND claim_token=? AND payload_hash=? AND status='checking'
      ${fromWatch ? "AND watch_enabled=1 AND watch_expires_at>?" : ''}
      AND EXISTS (${publicationGuardSql('recovery_calendar_verifications.action_id')})`)
    .bind(result.status, JSON.stringify({ message: result.message, events: result.events }), result.checkedAt,
      stopWatch ? 1 : 0, nextCheckAt, failures, stoppedReason, now, claim.action.id, claim.claimToken, claim.action.payload_hash,
      ...(fromWatch ? [now] : []), ...publicationBindings(claim.action, now))
    .run();
  if (!changed(updated)) return publishGuardFailure(db, claim, now, fromWatch);
  const row = await db.prepare('SELECT * FROM recovery_calendar_verifications WHERE action_id=?').bind(claim.action.id).first<VerificationRow>();
  return row ? viewFromRow(row) : fallbackView(claim.action.id, result.status, result.message, result.checkedAt);
}

function publicationBindings(action: ActionRow, now: string): Array<string | number> {
  return [
    action.workspace_id, action.owner_id, action.account_id, action.id, action.payload_hash,
    action.connection_id, action.connection_version, GOOGLE_CALENDAR_APP_CREATED_SCOPE,
    now, action.base_revision, action.source_revision, action.condition_revision,
    now,
  ];
}

async function publishGuardFailure(db: D1Database, claim: ClaimedVerification, now: string, fromWatch: boolean): Promise<CalendarVerificationView> {
  const failure = await currentStateFailure(db, claim, now, fromWatch) ?? unavailableResult('Calendar 확인 결과를 저장하기 전에 상태가 바뀌었습니다.', 'publish_guard_failed', now);
  await db.prepare(`UPDATE recovery_calendar_verifications
    SET status=?, last_result_json=?, checked_at=?, watch_enabled=0, next_check_at=NULL, consecutive_failures=?, stopped_reason=?, claim_token=NULL, claimed_at=NULL, updated_at=?
    WHERE action_id=? AND claim_token=? AND status='checking'`)
    .bind(failure.status, JSON.stringify({ message: failure.message, events: failure.events }), failure.checkedAt, failure.consecutiveFailures ?? claim.row.consecutive_failures, failure.stoppedReason ?? 'publish_guard_failed', now, claim.action.id, claim.claimToken)
    .run();
  const row = await db.prepare('SELECT * FROM recovery_calendar_verifications WHERE action_id=?').bind(claim.action.id).first<VerificationRow>();
  return row ? viewFromRow(row) : fallbackView(claim.action.id, failure.status, failure.message, failure.checkedAt);
}

function publicationGuardSql(actionExpression: string): string {
  return `SELECT 1 FROM recovery_actions a
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_id=a.owner_id
    JOIN owners o ON o.id=w.owner_id AND o.account_id=a.account_id
    JOIN recovery_profiles p ON p.workspace_id=w.id
    JOIN calendar_connections c ON c.id=a.connection_id AND c.account_id=a.account_id
    WHERE a.id=${actionExpression} AND a.workspace_id=? AND a.owner_id=? AND a.account_id=?
      AND a.id=? AND a.kind='calendar' AND a.status='verified' AND a.payload_hash=?
      AND c.id=? AND c.status='connected' AND c.auth_version=?
      AND a.connection_version=c.auth_version AND a.base_revision=w.revision AND a.source_revision=w.source_revision
      AND a.condition_revision=p.condition_revision
      AND c.calendar_id=json_extract(a.payload_json,'$.calendarId')
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(c.scopes_json) THEN c.scopes_json ELSE '[]' END) WHERE value=?)
      AND w.deleted_at IS NULL AND w.expires_at>?
      AND w.revision=? AND w.source_revision=?
      AND p.condition_revision=? AND p.applied_revision=w.revision AND p.base_source_revision=w.source_revision
      ${recoveryOriginCurrentGuardSql('w.id')}`;
}


async function updateWatchEnabled(db: D1Database, action: ActionRow, expiresAt: string, now: string): Promise<VerificationRow> {
  const result = await db.prepare(`UPDATE recovery_calendar_verifications
    SET watch_enabled=1, watch_expires_at=?, next_check_at=?, consecutive_failures=0, stopped_reason=NULL,
      last_result_json=CASE WHEN status='checking' THEN '{}' ELSE last_result_json END,
      checked_at=CASE WHEN status='checking' THEN NULL ELSE checked_at END,
      claim_token=NULL, claimed_at=NULL, status=CASE WHEN status='checking' THEN 'not_checked' ELSE status END, updated_at=?
    WHERE action_id=? AND payload_hash=?
      AND EXISTS (${publicationGuardSql('recovery_calendar_verifications.action_id')})`)
    .bind(expiresAt, now, now, action.id, action.payload_hash, ...publicationBindings(action, now))
    .run();
  if (!changed(result)) throw new ApiException('CALENDAR_VERIFICATION_STALE', 'Calendar 자동 확인을 켜기 전에 계획이나 연결 상태가 바뀌었습니다.', 409);
  return mustReadVerification(db, action.id);
}

async function updateWatchDisabled(db: D1Database, actionId: string, now: string, reason: string): Promise<VerificationRow> {
  await db.prepare(`UPDATE recovery_calendar_verifications
    SET watch_enabled=0, next_check_at=NULL, stopped_reason=?, claim_token=NULL, claimed_at=NULL,
      last_result_json=CASE WHEN status='checking' THEN '{}' ELSE last_result_json END,
      checked_at=CASE WHEN status='checking' THEN NULL ELSE checked_at END,
      status=CASE WHEN status='checking' THEN 'not_checked' ELSE status END, updated_at=?
    WHERE action_id=?`)
    .bind(reason, now, actionId)
    .run();
  return mustReadVerification(db, actionId);
}


async function mustReadVerification(db: D1Database, actionId: string): Promise<VerificationRow> {
  const row = await db.prepare('SELECT * FROM recovery_calendar_verifications WHERE action_id=?').bind(actionId).first<VerificationRow>();
  if (!row) throw new ApiException('CALENDAR_VERIFICATION_NOT_FOUND', 'Calendar 확인 기록을 찾지 못했습니다.', 404);
  return row;
}

async function readMappings(db: D1Database, workspaceId: string, connectionId: string): Promise<Map<string, MappingRow>> {
  const rows = await db.prepare('SELECT item_id,event_id,etag,payload_json FROM recovery_calendar_events WHERE workspace_id=? AND connection_id=?')
    .bind(workspaceId, connectionId)
    .all<MappingRow>();
  return new Map((rows.results ?? []).map((row) => [row.item_id, row]));
}

async function parsePayload(action: ActionRow): Promise<CalendarPayload> {
  let raw: unknown;
  try { raw = JSON.parse(action.payload_json); }
  catch { throw new ApiException('CALENDAR_VERIFICATION_INVALID_RECORD', '저장된 Calendar 확인 기록을 읽지 못했습니다.', 500); }
  if (!isRecord(raw) || raw.kind !== 'calendar' || raw.version !== 1) {
    throw new ApiException('CALENDAR_VERIFICATION_INVALID_RECORD', '저장된 Calendar 확인 기록이 올바르지 않습니다.', 500);
  }
  const eventsRaw = raw.events;
  if (!Array.isArray(eventsRaw) || eventsRaw.length < 1 || eventsRaw.length > MAX_EVENTS) {
    throw new ApiException('CALENDAR_VERIFICATION_EVENT_LIMIT', 'Calendar 확인 대상 이벤트 개수가 올바르지 않습니다.', 422);
  }
  const events = eventsRaw.map((entry) => {
    if (!isRecord(entry) || typeof entry.itemId !== 'string' || typeof entry.eventId !== 'string') {
      throw new ApiException('CALENDAR_VERIFICATION_INVALID_RECORD', '저장된 Calendar 이벤트 기록이 올바르지 않습니다.', 500);
    }
    return { itemId: entry.itemId, eventId: entry.eventId, write: calendarEventWriteSchema.parse(entry.write) };
  });
  const payload: CalendarPayload = {
    version: 1,
    kind: 'calendar',
    workspaceId: stringField(raw.workspaceId),
    ownerId: stringField(raw.ownerId),
    accountId: stringField(raw.accountId),
    connectionId: stringField(raw.connectionId),
    connectionVersion: numberField(raw.connectionVersion),
    calendarId: stringField(raw.calendarId),
    baseRevision: numberField(raw.baseRevision),
    sourceRevision: numberField(raw.sourceRevision),
    conditionRevision: numberField(raw.conditionRevision),
    resultHash: stringField(raw.resultHash),
    events,
    freeBusy: parseFreeBusy(raw.freeBusy),
  };
  if (payload.workspaceId !== action.workspace_id || payload.ownerId !== action.owner_id || payload.accountId !== action.account_id ||
      payload.connectionId !== action.connection_id || payload.connectionVersion !== action.connection_version ||
      payload.baseRevision !== action.base_revision || payload.sourceRevision !== action.source_revision || payload.conditionRevision !== action.condition_revision) {
    throw new ApiException('CALENDAR_VERIFICATION_BOUNDARY_MISMATCH', '저장된 Calendar 확인 범위가 실행 기록과 일치하지 않습니다.', 500);
  }
  if (await jsonHash(payload) !== action.payload_hash) {
    throw new ApiException('CALENDAR_VERIFICATION_HASH_MISMATCH', '저장된 Calendar 확인 기록의 무결성을 확인하지 못했습니다.', 500);
  }
  return payload;
}

function parseFreeBusy(value: unknown): CalendarPayload['freeBusy'] {
  if (!isRecord(value) || typeof value.timeMin !== 'string' || typeof value.timeMax !== 'string' || !Array.isArray(value.calendarIds) || !value.calendarIds.every((entry) => typeof entry === 'string')) {
    throw new ApiException('CALENDAR_VERIFICATION_INVALID_RECORD', '저장된 Calendar 확인 범위가 올바르지 않습니다.', 500);
  }
  return { timeMin: value.timeMin, timeMax: value.timeMax, calendarIds: value.calendarIds };
}

function stringField(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new ApiException('CALENDAR_VERIFICATION_INVALID_RECORD', '저장된 Calendar 확인 기록이 올바르지 않습니다.', 500);
  return value;
}

function numberField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ApiException('CALENDAR_VERIFICATION_INVALID_RECORD', '저장된 Calendar 확인 기록이 올바르지 않습니다.', 500);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScopes(raw: string | null): string[] {
  try { const value: unknown = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
  catch { return []; }
}

async function validateMappingOwnership(mapping: MappingRow | undefined, event: CalendarPayload['events'][number], actionId: string, now: string): Promise<VerificationResult | null> {
  if (!mapping || mapping.event_id !== event.eventId) return unavailableResult('Calendar에 반영한 일정 기록을 찾지 못했습니다.', 'mapping_missing', now);
  try {
    const saved: unknown = JSON.parse(mapping.payload_json);
    const hash = await jsonHash(event.write);
    if (!isRecord(saved) || saved.actionId !== actionId || saved.hash !== hash || await jsonHash(calendarEventWriteSchema.parse(saved.write)) !== hash) {
      return unavailableResult('승인 기록과 Calendar 반영 기록이 맞지 않아 확인을 중단했습니다.', 'mapping_mismatch', now);
    }
    return null;
  } catch { return unavailableResult('Calendar 반영 기록을 읽지 못해 확인을 중단했습니다.', 'mapping_invalid', now); }
}

async function boundedRead<T>(request: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Calendar verification read timeout')), Math.max(1, Math.min(8_000, deadlineMs - Date.now())));
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function sweepExpiredWatches(db: D1Database, now: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE recovery_calendar_verifications SET watch_enabled=0, next_check_at=NULL, claim_token=NULL, claimed_at=NULL,
      last_result_json=CASE WHEN status='checking' THEN '{}' ELSE last_result_json END,
      checked_at=CASE WHEN status='checking' THEN NULL ELSE checked_at END,
      status=CASE WHEN status='checking' THEN 'unavailable' ELSE status END, stopped_reason='watch_expired', updated_at=?
      WHERE watch_enabled=1 AND (watch_expires_at IS NULL OR watch_expires_at<=? OR next_check_at IS NULL
        OR NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.deleted_at IS NULL AND w.expires_at>?))`).bind(now, now, now),
    db.prepare(`UPDATE recovery_calendar_verifications SET status='unavailable', last_result_json=?, checked_at=?,
      consecutive_failures=MIN(3,consecutive_failures+1), claim_token=NULL, claimed_at=NULL,
      watch_enabled=CASE WHEN consecutive_failures+1>=3 THEN 0 ELSE watch_enabled END,
      next_check_at=CASE WHEN consecutive_failures+1>=3 OR watch_enabled=0 THEN NULL ELSE ? END,
      stopped_reason=CASE WHEN consecutive_failures+1>=3 THEN 'transient_failure_limit' ELSE 'interrupted_check' END, updated_at=?
      WHERE status='checking' AND (claimed_at IS NULL OR claimed_at<?)`)
      .bind(JSON.stringify({ message: '이전 Calendar 확인이 끝나지 않았습니다. 일치 여부를 확인하지 못했습니다.', events: [] }), now, retryAfter(now, 1), now, leaseCutoff(now)),
  ]);
}

function assertConnectionAndScopes(payload: CalendarPayload, connection: ConnectedCalendarProvider, now: string): VerificationResult | null {
  if (payload.connectionId !== connection.connectionId || payload.connectionVersion !== connection.version || payload.calendarId !== connection.calendarId) {
    return { status: 'unavailable', message: 'Calendar 연결이 승인 이후 변경되어 확인을 중단했습니다.', checkedAt: now, events: [], stopWatch: true, stoppedReason: 'connection_changed' };
  }
  if (!connection.scopes.includes(GOOGLE_CALENDAR_APP_CREATED_SCOPE)) {
    return { status: 'unavailable', message: 'Calendar 확인에 필요한 권한이 없어 확인을 중단했습니다.', checkedAt: now, events: [], stopWatch: true, stoppedReason: 'scope_missing' };
  }
  return null;
}

function compareEvent(itemId: string, write: CalendarEventWrite, read: CalendarEventRead, storedEtag: string | null): CalendarVerificationEvent {
  const differences: CalendarVerificationEvent['differences'] = [];
  if (read.summary !== write.summary) differences.push('title');
  if (!sameInstant(read.start.dateTime, write.start.dateTime) || !sameInstant(read.end.dateTime, write.end.dateTime) || read.start.timeZone !== write.start.timeZone || read.end.timeZone !== write.end.timeZone) differences.push('time');
  if ((read.description ?? '') !== (write.description ?? '')) differences.push('description');
  if (read.id !== write.id || read.extendedProperties.private.ieojimOperationId !== write.extendedProperties.private.ieojimOperationId || read.extendedProperties.private.ieojimPayloadHash !== write.extendedProperties.private.ieojimPayloadHash) differences.push('identity');
  if (storedEtag && read.etag !== storedEtag) differences.push('version');
  return { itemId, title: write.summary, status: differences.length > 0 ? 'changed' : 'matched', differences };
}

function providerFailureResult(kind: CalendarProviderErrorKind, now: string, previousFailures: number, fromWatch: boolean): VerificationResult {
  if (['not_connected', 'calendar_missing', 'reauth_required', 'forbidden'].includes(kind)) {
    return { status: 'unavailable', message: 'Calendar 연결 또는 권한을 다시 확인해야 합니다.', checkedAt: now, events: [], stopWatch: true, stoppedReason: kind };
  }
  return transientFailureResult('Calendar 상태를 확인하지 못했습니다. 자동으로 변경하지 않았습니다.', now, previousFailures, fromWatch, kind);
}

function providerReadFailureResult(error: CalendarProviderFailure['error'], now: string, previousFailures: number, fromWatch: boolean): VerificationResult {
  if (['reauth_required', 'forbidden'].includes(error.kind)) {
    return { status: 'unavailable', message: 'Calendar 권한을 다시 확인해야 합니다.', checkedAt: now, events: [], stopWatch: true, stoppedReason: error.kind };
  }
  return transientFailureResult('Calendar 이벤트를 확인하지 못했습니다. 자동으로 변경하지 않았습니다.', now, previousFailures, fromWatch, error.kind);
}

function transientFailureResult(message: string, now: string, previousFailures: number, fromWatch: boolean, reason: string): VerificationResult {
  const failures = Math.min(CALENDAR_WATCH_MAX_FAILURES, previousFailures + 1);
  return {
    status: 'unavailable',
    message,
    checkedAt: now,
    events: [],
    consecutiveFailures: failures,
    stopWatch: fromWatch && failures >= CALENDAR_WATCH_MAX_FAILURES,
    stoppedReason: fromWatch && failures >= CALENDAR_WATCH_MAX_FAILURES ? 'transient_failure_limit' : reason,
  };
}

function staleResult(message: string, reason: string, now: string): VerificationResult {
  return { status: 'stale', message, checkedAt: now, events: [], stopWatch: true, stoppedReason: reason };
}

function unavailableResult(message: string, reason: string, now: string): VerificationResult {
  return { status: 'unavailable', message, checkedAt: now, events: [], stopWatch: true, stoppedReason: reason };
}

function viewFromRow(row: VerificationRow): CalendarVerificationView {
  const parsed = parseResult(row.last_result_json);
  return {
    actionId: row.action_id,
    status: row.status,
    message: parsed.message ?? defaultMessage(row.status),
    checkedAt: row.checked_at,
    events: parsed.events,
    watch: {
      enabled: row.watch_enabled === 1,
      expiresAt: row.watch_expires_at,
      nextCheckAt: row.next_check_at,
      consecutiveFailures: row.consecutive_failures,
      stoppedReason: row.stopped_reason,
    },
  };
}

function fallbackView(actionId: string, status: CalendarVerificationStatus, message: string, checkedAt: string | null): CalendarVerificationView {
  return { actionId, status, message, checkedAt, events: [], watch: { enabled: false, expiresAt: null, nextCheckAt: null, consecutiveFailures: 0, stoppedReason: null } };
}

function parseResult(json: string): { message: string | null; events: CalendarVerificationEvent[] } {
  try {
    const parsed = JSON.parse(json) as { message?: unknown; events?: unknown };
    return {
      message: typeof parsed.message === 'string' ? parsed.message : null,
      events: Array.isArray(parsed.events) ? parsed.events.filter(isVerificationEvent) : [],
    };
  } catch {
    return { message: null, events: [] };
  }
}

function isVerificationEvent(value: unknown): value is CalendarVerificationEvent {
  return typeof value === 'object' && value !== null &&
    typeof (value as CalendarVerificationEvent).itemId === 'string' &&
    typeof (value as CalendarVerificationEvent).title === 'string' &&
    ['matched', 'changed', 'missing', 'unavailable'].includes((value as CalendarVerificationEvent).status) &&
    Array.isArray((value as CalendarVerificationEvent).differences);
}

function defaultMessage(status: CalendarVerificationStatus): string {
  const messages: Record<CalendarVerificationStatus, string> = {
    not_checked: '아직 Calendar를 다시 확인하지 않았습니다.',
    checking: 'Calendar 확인이 진행 중입니다.',
    matched: 'Calendar 이벤트가 마지막 승인값과 일치합니다.',
    drifted: 'Calendar에서 마지막 승인값과 다른 이벤트를 발견했습니다.',
    unavailable: 'Calendar 상태를 확인하지 못했습니다.',
    stale: '저장된 계획이나 기준이 바뀌어 Calendar 확인을 중단했습니다.',
  };
  return messages[status];
}

function watchExpiresAt(now: string, workspaceExpiry: string, horizonEnd: string): string | null {
  const start = Date.parse(now);
  const horizon = Date.parse(horizonEnd);
  if (!Number.isFinite(horizon) || horizon <= start) return null;
  const max = start + CALENDAR_WATCH_DURATION_MS;
  const candidates = [Date.parse(workspaceExpiry), max, horizon];
  const end = Math.min(...candidates.filter(Number.isFinite));
  return end > start ? new Date(end).toISOString() : null;
}

function nextWatchCheck(now: string, expiresAt: string | null): string | null {
  const next = Date.parse(now) + CALENDAR_WATCH_INTERVAL_MS;
  if (expiresAt && next > Date.parse(expiresAt)) return null;
  return new Date(next).toISOString();
}

function retryAfter(now: string, failures: number): string {
  const multipliers = [1, 4, 24];
  return new Date(Date.parse(now) + CALENDAR_WATCH_INTERVAL_MS * multipliers[Math.max(0, Math.min(failures - 1, multipliers.length - 1))]).toISOString();
}

function leaseCutoff(now: string): string {
  return new Date(Date.parse(now) - CLAIM_LEASE_MS).toISOString();
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function changed(result: D1Result<unknown>): boolean {
  return (result.meta.changes ?? 0) > 0;
}

async function replayRequest(db: D1Database, ownerId: string, workspaceId: string, requestId: string, payloadHash: string): Promise<CalendarVerificationView | null> {
  const row = await db.prepare('SELECT workspace_id,payload_hash,response_json FROM recovery_requests WHERE owner_id=? AND request_id=?')
    .bind(ownerId, requestId)
    .first<{ workspace_id: string; payload_hash: string; response_json: string }>();
  if (!row) return null;
  if (row.workspace_id !== workspaceId || row.payload_hash !== payloadHash) throw new ApiException('IDEMPOTENCY_CONFLICT', '같은 요청 번호로 다른 Calendar 확인 요청을 처리할 수 없습니다.', 409);
  return JSON.parse(row.response_json) as CalendarVerificationView;
}

async function reserveRequest(db: D1Database, ownerId: string, workspaceId: string, requestId: string, payloadHash: string, view: CalendarVerificationView, now: string): Promise<{ replay: boolean; view: CalendarVerificationView }> {
  const inserted = await db.prepare(`INSERT INTO recovery_requests(owner_id,request_id,workspace_id,payload_hash,response_json,created_at)
    SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM recovery_requests WHERE workspace_id=?) < ?
    ON CONFLICT(owner_id,request_id) DO NOTHING`)
    .bind(ownerId, requestId, workspaceId, payloadHash, JSON.stringify(view), now, workspaceId, MAX_RECOVERY_REQUESTS_PER_WORKSPACE).run();
  if (changed(inserted)) return { replay: false, view };
  const replay = await replayRequest(db, ownerId, workspaceId, requestId, payloadHash);
  if (replay) return { replay: true, view: replay };
  throw new ApiException('CALENDAR_VERIFICATION_LIMIT', '이 작업 공간의 확인 요청 한도에 도달했습니다. 반복 확인 끄기는 계속 사용할 수 있습니다.', 429);
}

async function updateRequestReceipt(db: D1Database, ownerId: string, requestId: string, hash: string, view: CalendarVerificationView, _now: string): Promise<void> {
  await db.prepare('UPDATE recovery_requests SET response_json=? WHERE owner_id=? AND request_id=? AND payload_hash=?')
    .bind(JSON.stringify(view), ownerId, requestId, hash).run();
}

async function recordCancellationReceipt(db: D1Database, ownerId: string, workspaceId: string, requestId: string, hash: string, view: CalendarVerificationView, now: string): Promise<void> {
  try { await reserveRequest(db, ownerId, workspaceId, requestId, hash, view, now); }
  catch (error) { if (!(error instanceof ApiException && error.code === 'CALENDAR_VERIFICATION_LIMIT')) throw error; }
}

function checkingView(actionId: string): CalendarVerificationView {
  return fallbackView(actionId, 'checking', 'Calendar 확인을 요청했습니다. 최신 결과는 처리 기록에서 확인할 수 있습니다.', null);
}

async function enforceManualCooldown(db: D1Database, actionId: string, now: string): Promise<void> {
  const recent = await db.prepare("SELECT 1 FROM recovery_calendar_verifications WHERE action_id=? AND status <> 'checking' AND checked_at>?")
    .bind(actionId, new Date(Date.parse(now) - MANUAL_CHECK_COOLDOWN_MS).toISOString()).first();
  if (recent) throw manualCooldownError();
}

function manualCooldownError(): ApiException {
  return new ApiException('CALENDAR_CHECK_COOLDOWN', '최근 확인한 결과가 있습니다. 새 조회는 마지막 확인에서 1분 뒤에 요청해 주세요.', 429);
}

async function readCurrentWorkspace(db: D1Database, ownerId: string, accountId: string, workspaceId: string, now: string): Promise<WorkspaceRow> {
  const row = await db.prepare(`SELECT w.id,w.owner_id,w.revision,w.source_revision,w.deleted_at,w.expires_at FROM workspaces w JOIN owners o ON o.id=w.owner_id
    WHERE w.id=? AND w.owner_id=? AND o.account_id=? AND w.deleted_at IS NULL AND w.expires_at>?`)
    .bind(workspaceId, ownerId, accountId, now)
    .first<WorkspaceRow>();
  if (!row) throw new ApiException('WORKSPACE_NOT_FOUND', '작업 공간을 찾을 수 없습니다.', 404);
  return row;
}
