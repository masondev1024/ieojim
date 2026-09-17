import { z } from 'zod';
import {
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_EMAIL_SCOPE,
  GOOGLE_OPENID_SCOPE,
  GOOGLE_PROFILE_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  googleCalendarScopes,
  type CalendarProviderErrorKind,
  type CalendarConnectionSummary,
  type ConnectedCalendarProviderResult,
} from '../../core/calendar-contracts';
import { authConfiguration, type AuthBindings } from '../auth';
import { randomId, randomToken, sha256Hex } from '../crypto';
import { ApiException } from '../errors';
import { createGoogleCalendarProvider } from './provider';
import { decryptSecret, encryptSecret } from './secrets';

export type CalendarBindings = AuthBindings & { DB: D1Database };
export type CalendarFetch = typeof fetch;

type ConnectionRow = {
  id: string;
  account_id: string;
  provider: 'google';
  provider_subject: string;
  provider_email: string | null;
  status: 'connected' | 'needs_reauth' | 'disconnected' | 'bootstrap_uncertain';
  auth_version: number;
  calendar_id: string | null;
  calendar_summary: string | null;
  scopes_json: string;
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  access_token_expires_at: string | null;
  updated_at: string;
};

type OAuthStateRow = {
  state_hash: string;
  account_id: string;
  session_id: string;
  connection_version: number;
  code_verifier_ciphertext: string;
  scopes_json: string;
  expires_at: string;
};

type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
};

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096).optional(),
  expires_in: z.number().int().positive().max(86400).optional(),
  scope: z.string().max(2048).optional(),
  token_type: z.literal('Bearer').optional(),
}).passthrough();

const userInfoSchema = z.object({
  sub: z.string().min(1).max(256),
  email: z.string().email().max(254).optional(),
  email_verified: z.boolean().optional(),
}).passthrough();

const GOOGLE_USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const GOOGLE_USERINFO_PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile';

export function calendarConfiguration(env: CalendarBindings): { origin: string; secret: string; clientId: string; clientSecret: string; callbackUrl: string } | null {
  const auth = authConfiguration(env);
  if (!auth) return null;
  return { ...auth, callbackUrl: `${auth.origin}/api/calendar/callback` };
}

type BeginCalendarOAuthOptions = { includeEmail?: boolean };

export async function cleanCalendarOAuthStates(db: D1Database, now = new Date().toISOString()): Promise<number> {
  const result = await db.prepare(`DELETE FROM calendar_oauth_states WHERE state_hash IN
    (SELECT state_hash FROM calendar_oauth_states WHERE expires_at <= ? ORDER BY expires_at LIMIT 500)`).bind(now).run();
  return result.meta.changes ?? 0;
}

export async function beginCalendarOAuth(env: CalendarBindings, db: D1Database, accountId: string, sessionId: string, options: BeginCalendarOAuthOptions = {}): Promise<{ url: string }> {
  const config = requireCalendarConfiguration(env);
  const googleSubject = await requireGoogleLoginSubject(db, accountId);
  const connectionAtStart = await readConnection(db, accountId);
  let existingScopes: string[] = [];
  if (options.includeEmail) {
    const row = await readConnection(db, accountId);
    existingScopes = row ? parseScopes(row.scopes_json) : [];
    if (!row || row.status === 'disconnected' || !existingScopes.includes(GOOGLE_CALENDAR_APP_CREATED_SCOPE)) {
      throw new ApiException('CALENDAR_CONNECTION_REQUIRED', 'Calendar 연결 후 이메일 발송 권한을 별도로 연결할 수 있습니다.', 409);
    }
  }
  const now = new Date();
  const state = randomToken();
  const verifier = randomToken();
  const stateHash = await sha256Hex(state);
  const verifierCiphertext = await encryptSecret(verifier, config.secret, oauthStateAad(stateHash, accountId));
  const scopes = options.includeEmail
    ? [...new Set([...existingScopes, GOOGLE_OPENID_SCOPE, GOOGLE_EMAIL_SCOPE, GOOGLE_PROFILE_SCOPE, GOOGLE_GMAIL_SEND_SCOPE])]
    : [...googleCalendarScopes];

  await ensureAppAccount(db, accountId, now.toISOString());
  await db.prepare('DELETE FROM calendar_oauth_states WHERE account_id=? AND expires_at<=?').bind(accountId, now.toISOString()).run();
  await db.prepare(`INSERT INTO calendar_oauth_states(state_hash, account_id, session_id, connection_version, code_verifier_ciphertext, scopes_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(stateHash, accountId, sessionId, connectionAtStart?.auth_version ?? 0, verifierCiphertext, JSON.stringify(scopes), now.toISOString(), new Date(now.getTime() + 10 * 60 * 1000).toISOString())
    .run();

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', options.includeEmail ? 'true' : 'false');
  // Keep the Better Auth subject lookup as a hard precondition for callback validation.
  void googleSubject;
  return { url: url.toString() };
}

export async function completeCalendarOAuth(
  env: CalendarBindings,
  db: D1Database,
  accountId: string,
  sessionId: string,
  state: string,
  code: string,
  fetcher: CalendarFetch = fetch,
): Promise<CalendarConnectionSummary> {
  const config = requireCalendarConfiguration(env);
  const stateHash = await sha256Hex(state);
  const stateRow = await db.prepare(`SELECT state_hash, account_id, session_id, connection_version, code_verifier_ciphertext, scopes_json, expires_at
    FROM calendar_oauth_states WHERE state_hash = ? AND account_id = ? AND session_id = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(stateHash, accountId, sessionId, new Date().toISOString())
    .first<OAuthStateRow>();
  if (!stateRow) throw new ApiException('CALENDAR_OAUTH_STATE_INVALID', 'Calendar 연결 요청을 다시 시작해 주세요.', 401);
  const consumed = await db.prepare('UPDATE calendar_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL')
    .bind(new Date().toISOString(), stateHash).run();
  if (consumed.meta.changes !== 1) throw new ApiException('CALENDAR_OAUTH_STATE_INVALID', 'Calendar 연결 요청을 다시 시작해 주세요.', 401);

  const verifier = await decryptSecret(stateRow.code_verifier_ciphertext, config.secret, oauthStateAad(stateHash, accountId));
  const requestedScopes = parseScopes(stateRow.scopes_json);
  const token = await exchangeCodeForToken(config, code, verifier, requestedScopes, fetcher);
  const googleIdentity = await fetchGoogleIdentity(token.accessToken, fetcher);
  const expectedSubject = await requireGoogleLoginSubject(db, accountId);
  if (googleIdentity.sub !== expectedSubject) {
    throw new ApiException('CALENDAR_GOOGLE_IDENTITY_MISMATCH', '로그인한 Google 계정과 Calendar 권한 계정이 다릅니다.', 403);
  }
  await upsertCalendarConnection(env, db, accountId, googleIdentity.sub, googleIdentity.email ?? null, token, stateRow.connection_version);
  return calendarStatus(env, db, accountId);
}

export async function calendarStatus(env: CalendarBindings, db: D1Database, accountId: string): Promise<CalendarConnectionSummary> {
  if (!calendarConfiguration(env)) return summary('not_configured');
  const row = await readConnection(db, accountId);
  if (!row || row.status === 'disconnected') return summary('not_connected');
  const scopes = parseScopes(row.scopes_json);
  if (row.status === 'bootstrap_uncertain') return rowSummary(row, 'bootstrap_uncertain', scopes);
  if (!row.encrypted_access_token) return rowSummary(row, 'needs_reauth', scopes);
  if (!row.calendar_id) return rowSummary(row, 'calendar_missing', scopes);
  return rowSummary(row, row.status === 'needs_reauth' ? 'needs_reauth' : 'connected', scopes);
}

export async function bootstrapCalendar(
  env: CalendarBindings,
  db: D1Database,
  accountId: string,
  fetcher: CalendarFetch = fetch,
): Promise<{ summary: CalendarConnectionSummary; created: boolean }> {
  const connected = await getConnectedProvider(env, accountId, { fetcher, requireCalendar: false, db });
  if (!connected.ok) throw providerFailure(connected.error.kind);
  if (connected.value.calendarId) return { summary: await calendarStatus(env, db, accountId), created: false };
  const marker = `ieojim:connection:${connected.value.connectionId}`;
  const pending = await db.prepare(`SELECT status FROM calendar_bootstrap_ops
    WHERE account_id = ? AND connection_id = ? AND status IN ('pending', 'uncertain')
    ORDER BY requested_at DESC LIMIT 1`)
    .bind(accountId, connected.value.connectionId)
    .first<{ status: 'pending' | 'uncertain' }>();
  if (pending) {
    const recovered = await db.batch([
        db.prepare(`UPDATE calendar_bootstrap_ops SET status = 'uncertain', completed_at = ?
          WHERE account_id = ? AND connection_id = ? AND status = 'pending'`)
          .bind(new Date().toISOString(), accountId, connected.value.connectionId),
        db.prepare(`UPDATE calendar_connections SET status = "bootstrap_uncertain", updated_at = ?
          WHERE id = ? AND account_id = ? AND auth_version = ? AND status = 'connected'`)
        .bind(new Date().toISOString(), connected.value.connectionId, accountId, connected.value.version)
    ]);
    if (recovered[1]?.meta.changes !== 1) throw new ApiException('CALENDAR_CONNECTION_CHANGED', 'Calendar 연결 상태가 바뀌었습니다. 다시 확인해 주세요.', 409);
    throw providerFailure('unknown');
  }
  const operationId = randomId('calendar_bootstrap');
  const now = new Date().toISOString();
  const inserted = await db.prepare(`INSERT INTO calendar_bootstrap_ops(id, account_id, connection_id, operation_id, status, marker, requested_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(randomId('calendar_bootstrap_op'), accountId, connected.value.connectionId, operationId, marker, now)
    .run();
  if (inserted.meta.changes !== 1) throw providerFailure('unknown');
  const created = await connected.value.provider.createAppCalendar('Ieojim', marker);
  if (!created.ok) {
    const status = ['unknown', 'invalid_provider_response'].includes(created.error.kind) ? 'uncertain' : 'failed';
    await db.prepare('UPDATE calendar_bootstrap_ops SET status = ?, completed_at = ? WHERE connection_id = ? AND operation_id = ?')
      .bind(status, new Date().toISOString(), connected.value.connectionId, operationId)
      .run();
    if (status === 'uncertain') {
      const marked = await db.prepare(`UPDATE calendar_connections SET status = "bootstrap_uncertain", updated_at = ?
        WHERE id = ? AND account_id = ? AND auth_version = ? AND status = 'connected'`)
        .bind(new Date().toISOString(), connected.value.connectionId, accountId, connected.value.version)
        .run();
      if (marked.meta.changes !== 1) throw new ApiException('CALENDAR_CONNECTION_CHANGED', 'Calendar 연결 상태가 바뀌었습니다. 생성 결과를 다시 확인해 주세요.', 409);
    }
    throw providerFailure(created.error.kind);
  }
  if (created.value.description !== marker) {
    const marked = await db.batch([
      db.prepare('UPDATE calendar_bootstrap_ops SET status = "uncertain", completed_at = ? WHERE connection_id = ? AND operation_id = ?')
        .bind(new Date().toISOString(), connected.value.connectionId, operationId),
      db.prepare(`UPDATE calendar_connections SET status = 'bootstrap_uncertain', updated_at = ?
        WHERE id = ? AND account_id = ? AND auth_version = ? AND status = 'connected'`)
        .bind(new Date().toISOString(), connected.value.connectionId, accountId, connected.value.version),
    ]);
    if (marked[1]?.meta.changes !== 1) throw new ApiException('CALENDAR_CONNECTION_CHANGED', 'Calendar 연결 상태가 바뀌었습니다. 생성 결과를 다시 확인해 주세요.', 409);
    throw providerFailure('invalid_provider_response');
  }
  const row = await readConnection(db, accountId);
  if (!row || row.auth_version !== connected.value.version || row.status !== 'connected') throw new ApiException('CALENDAR_CONNECTION_CHANGED', 'Calendar 연결 상태가 변경되어 생성 결과를 다시 확인해야 합니다.', 409);
  const nextVersion = row.auth_version + 1;
  const rotatedAccess = row.encrypted_access_token
    ? await rotateEncryptedToken(env, row, nextVersion, 'access')
    : null;
  const rotatedRefresh = row.encrypted_refresh_token
    ? await rotateEncryptedToken(env, row, nextVersion, 'refresh')
    : null;
  const success = await db.batch([
    db.prepare(`UPDATE calendar_bootstrap_ops SET status = "confirmed", completed_at = ?, provider_calendar_id = ?
      WHERE connection_id = ? AND operation_id = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM calendar_connections WHERE id = ? AND account_id = ? AND auth_version = ? AND status = 'connected')`)
      .bind(new Date().toISOString(), created.value.id, connected.value.connectionId, operationId, connected.value.connectionId, accountId, row.auth_version),
    db.prepare(`UPDATE calendar_connections
      SET status = "connected", calendar_id = ?, calendar_summary = ?, auth_version = ?,
        encrypted_access_token = ?, encrypted_refresh_token = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND auth_version = ? AND status = 'connected'`)
      .bind(created.value.id, created.value.summary, nextVersion, rotatedAccess, rotatedRefresh, new Date().toISOString(), connected.value.connectionId, accountId, row.auth_version),
  ]);
  if (success[0]?.meta.changes !== 1 || success[1]?.meta.changes !== 1) throw new ApiException('CALENDAR_CONNECTION_CHANGED', 'Calendar 연결 상태가 바뀌었습니다. 다시 확인해 주세요.', 409);
  return { summary: await calendarStatus(env, db, accountId), created: true };
}

export async function adoptUncertainCalendar(
  env: CalendarBindings,
  db: D1Database,
  accountId: string,
  calendarId: string,
  fetcher: CalendarFetch = fetch,
): Promise<CalendarConnectionSummary> {
  const row = await readConnection(db, accountId);
  if (!row || row.status !== 'bootstrap_uncertain') {
    throw new ApiException('CALENDAR_BOOTSTRAP_NOT_UNCERTAIN', '수동 확인이 필요한 Calendar 생성 상태가 아닙니다.', 409);
  }
  const markerRow = await db.prepare(`SELECT marker FROM calendar_bootstrap_ops
    WHERE account_id = ? AND connection_id = ? AND status = 'uncertain'
    ORDER BY requested_at DESC LIMIT 1`)
    .bind(accountId, row.id)
    .first<{ marker: string }>();
  if (!markerRow) throw new ApiException('CALENDAR_BOOTSTRAP_NOT_UNCERTAIN', '수동 확인할 Calendar 생성 기록을 찾지 못했습니다.', 409);
  const connected = await getCalendarProviderForConnection(env, db, row, fetcher);
  if (!connected.ok) throw providerFailure(connected.error.kind);
  const calendar = await connected.value.provider.getCalendar(calendarId);
  if (!calendar.ok) throw providerFailure(calendar.error.kind);
  if (calendar.value.description !== markerRow.marker) {
    throw new ApiException('CALENDAR_ADOPTION_REJECTED', '이어짐이 만든 Calendar인지 확인하지 못했습니다.', 409);
  }
  const nextVersion = row.auth_version + 1;
  const rotatedAccess = row.encrypted_access_token ? await rotateEncryptedToken(env, row, nextVersion, 'access') : null;
  const rotatedRefresh = row.encrypted_refresh_token ? await rotateEncryptedToken(env, row, nextVersion, 'refresh') : null;
  const success = await db.batch([
    db.prepare(`UPDATE calendar_bootstrap_ops SET status = 'confirmed', completed_at = ?, provider_calendar_id = ?
      WHERE account_id = ? AND connection_id = ? AND status = 'uncertain'
      AND EXISTS (SELECT 1 FROM calendar_connections WHERE id = ? AND account_id = ? AND auth_version = ? AND status = 'bootstrap_uncertain')`)
      .bind(new Date().toISOString(), calendar.value.id, accountId, row.id, row.id, accountId, row.auth_version),
    db.prepare(`UPDATE calendar_connections SET status = 'connected', auth_version = ?, calendar_id = ?, calendar_summary = ?,
      encrypted_access_token = ?, encrypted_refresh_token = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND auth_version = ? AND status = 'bootstrap_uncertain'`)
      .bind(nextVersion, calendar.value.id, calendar.value.summary, rotatedAccess, rotatedRefresh, new Date().toISOString(), row.id, accountId, row.auth_version),
  ]);
  if (success[0]?.meta.changes !== 1 || success[1]?.meta.changes !== 1) throw new ApiException('CALENDAR_CONNECTION_CHANGED', 'Calendar 연결 상태가 바뀌었습니다. 다시 확인해 주세요.', 409);
  return calendarStatus(env, db, accountId);
}

export async function disconnectCalendar(
  env: CalendarBindings,
  db: D1Database,
  accountId: string,
  onDisconnected?: (connectionId: string, connectionVersion: number) => Promise<void>,
): Promise<CalendarConnectionSummary> {
  void env;
  const row = await readConnection(db, accountId);
  if (!row || row.status === 'disconnected') return summary('not_connected');
  const nextVersion = row.auth_version + 1;
  await db.prepare(`UPDATE calendar_connections
    SET status = 'disconnected', auth_version = ?, encrypted_access_token = NULL, encrypted_refresh_token = NULL,
      access_token_expires_at = NULL, disconnected_at = ?, updated_at = ?
    WHERE id = ? AND account_id = ?`)
    .bind(nextVersion, new Date().toISOString(), new Date().toISOString(), row.id, accountId)
    .run();
  await cancelPendingRecoveryActions(db, accountId, row.id, row.auth_version);
  if (onDisconnected) await onDisconnected(row.id, nextVersion);
  return summary('not_connected');
}

export async function getConnectedProvider(
  env: CalendarBindings,
  accountId: string,
  options: { fetcher?: CalendarFetch; requireCalendar?: boolean; db?: D1Database } = {},
): Promise<ConnectedCalendarProviderResult> {
  const config = calendarConfiguration(env);
  if (!config) return failure('not_configured', 'Calendar OAuth is not configured.');
  const db = options.db ?? env.DB;
  const row = await readConnection(db, accountId);
  if (!row || row.status === 'disconnected') return failure('not_connected', 'Calendar is not connected.');
  if (row.status === 'bootstrap_uncertain') return failure('unknown', 'Calendar bootstrap result is uncertain.');
  return getCalendarProviderForConnection(env, db, row, options.fetcher ?? fetch, options.requireCalendar ?? true);
}

async function getCalendarProviderForConnection(
  env: CalendarBindings,
  db: D1Database,
  row: ConnectionRow,
  fetcher: CalendarFetch,
  requireCalendar = false,
): Promise<ConnectedCalendarProviderResult> {
  const config = calendarConfiguration(env);
  if (!config) return failure('not_configured', 'Calendar OAuth is not configured.');
  if (!row.encrypted_access_token) return failure('reauth_required', 'Calendar access token is missing.');
  if (isExpired(row.access_token_expires_at)) {
    const refreshed = await refreshAccessToken(env, db, row, fetcher);
    if (!refreshed?.encrypted_access_token) return failure('reauth_required', 'Calendar token refresh is required.');
    row = refreshed;
  }
  if (!row.encrypted_access_token) return failure('reauth_required', 'Calendar access token is missing.');
  const scopes = parseScopes(row.scopes_json);
  const accessToken = await decryptSecret(row.encrypted_access_token, config.secret, tokenAad(row.account_id, row.id, row.auth_version, 'access'));
  const calendarId = row.calendar_id ?? '';
  if (requireCalendar && !calendarId) return failure('calendar_missing', 'Ieojim calendar has not been created.');
  return {
    ok: true,
    value: {
      provider: createGoogleCalendarProvider({ accessToken, scopes, fetcher }),
      connectionId: row.id,
      version: row.auth_version,
      calendarId,
      scopes,
    },
  };
}

async function upsertCalendarConnection(env: CalendarBindings, db: D1Database, accountId: string, subject: string, email: string | null, token: TokenResponse, expectedVersion: number): Promise<void> {
  const config = requireCalendarConfiguration(env);
  const now = new Date().toISOString();
  const existing = await readConnection(db, accountId);
  if ((existing?.auth_version ?? 0) !== expectedVersion) throw new ApiException('CALENDAR_CONNECTION_CHANGED', '권한 확인 중 연결 상태가 변경되었습니다. 다시 연결해 주세요.', 409);
  const id = existing?.id ?? randomId('cal_conn');
  const nextVersion = (existing?.auth_version ?? 0) + 1;
  const access = await encryptSecret(token.accessToken, config.secret, tokenAad(accountId, id, nextVersion, 'access'));
  let refresh: string | null = null;
  if (token.refreshToken) {
    refresh = await encryptSecret(token.refreshToken, config.secret, tokenAad(accountId, id, nextVersion, 'refresh'));
  } else if (existing?.encrypted_refresh_token) {
    const previous = await decryptSecret(existing.encrypted_refresh_token, config.secret, tokenAad(accountId, id, existing.auth_version, 'refresh'));
    refresh = await encryptSecret(previous, config.secret, tokenAad(accountId, id, nextVersion, 'refresh'));
  }
  await ensureAppAccount(db, accountId, now);
  const updated = await db.prepare(`INSERT INTO calendar_connections(
      id, account_id, provider, provider_subject, provider_email, status, auth_version, calendar_id, calendar_summary,
      scopes_json, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, created_at, updated_at
    ) VALUES (?, ?, 'google', ?, ?, 'connected', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, provider) DO UPDATE SET
      provider_subject = excluded.provider_subject,
      provider_email = excluded.provider_email,
      status = CASE WHEN calendar_connections.calendar_id IS NULL AND EXISTS (
        SELECT 1 FROM calendar_bootstrap_ops b WHERE b.connection_id=calendar_connections.id AND b.status IN ('pending','uncertain')
      ) THEN 'bootstrap_uncertain' ELSE 'connected' END,
      auth_version = excluded.auth_version,
      scopes_json = excluded.scopes_json,
      encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = excluded.encrypted_refresh_token,
      access_token_expires_at = excluded.access_token_expires_at,
      disconnected_at = NULL,
      updated_at = excluded.updated_at
    WHERE calendar_connections.auth_version = ?`)
    .bind(id, accountId, subject, email, nextVersion, JSON.stringify(token.scopes), access, refresh, token.expiresAt, now, now, expectedVersion)
    .run();
  if (updated.meta.changes !== 1) throw new ApiException('CALENDAR_CONNECTION_CHANGED', '권한 확인 중 연결 상태가 변경되었습니다.', 409);
}

async function refreshAccessToken(env: CalendarBindings, db: D1Database, row: ConnectionRow, fetcher: CalendarFetch): Promise<ConnectionRow | null> {
  const config = requireCalendarConfiguration(env);
  if (!row.encrypted_refresh_token) {
    await db.prepare(`UPDATE calendar_connections SET status = "needs_reauth", encrypted_access_token = NULL, updated_at = ?
      WHERE id = ? AND account_id = ? AND auth_version = ? AND status IN ('connected','needs_reauth','bootstrap_uncertain')`)
      .bind(new Date().toISOString(), row.id, row.account_id, row.auth_version)
      .run();
    return null;
  }
  const refreshToken = await decryptSecret(row.encrypted_refresh_token, config.secret, tokenAad(row.account_id, row.id, row.auth_version, 'refresh'));
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  let response: Response;
  try {
    response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await db.prepare(`UPDATE calendar_connections SET status = "needs_reauth", encrypted_access_token = NULL, updated_at = ?
      WHERE id = ? AND account_id = ? AND auth_version = ? AND status IN ('connected','needs_reauth','bootstrap_uncertain')`)
      .bind(new Date().toISOString(), row.id, row.account_id, row.auth_version)
      .run();
    return null;
  }
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return null;
  const scopes = parsed.data.scope ? normalizeGoogleScopes(parsed.data.scope.split(/\s+/).filter(Boolean)) : parseScopes(row.scopes_json);
  const access = await encryptSecret(parsed.data.access_token, config.secret, tokenAad(row.account_id, row.id, row.auth_version, 'access'));
  const refresh = parsed.data.refresh_token
    ? await encryptSecret(parsed.data.refresh_token, config.secret, tokenAad(row.account_id, row.id, row.auth_version, 'refresh'))
    : row.encrypted_refresh_token;
  const result = await db.prepare(`UPDATE calendar_connections
    SET status = CASE WHEN status = 'needs_reauth' THEN 'connected' ELSE status END, scopes_json = ?, encrypted_access_token = ?, encrypted_refresh_token = ?, access_token_expires_at = ?, updated_at = ?
    WHERE id = ? AND account_id = ? AND auth_version = ? AND status IN ('connected','needs_reauth','bootstrap_uncertain')`)
    .bind(JSON.stringify(scopes), access, refresh, expiresAt(parsed.data.expires_in), new Date().toISOString(), row.id, row.account_id, row.auth_version)
    .run();
  if (result.meta.changes !== 1) return null;
  return readConnection(db, row.account_id);
}

async function exchangeCodeForToken(
  config: NonNullable<ReturnType<typeof calendarConfiguration>>,
  code: string,
  verifier: string,
  requiredScopes: string[],
  fetcher: CalendarFetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: config.callbackUrl,
  });
  let response: Response;
  try {
    response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ApiException('CALENDAR_OAUTH_UNKNOWN', 'Calendar 권한 요청 결과를 확정할 수 없습니다. 다시 연결 전 상태를 확인해 주세요.', 503);
  }
  if (!response.ok) throw new ApiException('CALENDAR_OAUTH_REJECTED', 'Google Calendar 권한을 확인하지 못했습니다.', 401);
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ApiException('CALENDAR_OAUTH_INVALID_RESPONSE', 'Google Calendar 권한 응답을 검증하지 못했습니다.', 503);
  const scopes = parsed.data.scope ? normalizeGoogleScopes(parsed.data.scope.split(/\s+/).filter(Boolean)) : [...googleCalendarScopes];
  for (const scope of requiredScopes) {
    if (!scopes.includes(scope)) throw new ApiException('CALENDAR_SCOPE_MISSING', '필요한 Calendar 권한이 승인되지 않았습니다.', 403);
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: expiresAt(parsed.data.expires_in),
    scopes,
  };
}

async function fetchGoogleIdentity(accessToken: string, fetcher: CalendarFetch): Promise<{ sub: string; email?: string }> {
  const response = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new ApiException('CALENDAR_GOOGLE_IDENTITY_UNAVAILABLE', 'Google 계정 정보를 확인하지 못했습니다.', 401);
  const parsed = userInfoSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.email_verified === false) {
    throw new ApiException('CALENDAR_GOOGLE_IDENTITY_UNAVAILABLE', 'Google 계정 정보를 확인하지 못했습니다.', 401);
  }
  return { sub: parsed.data.sub, email: parsed.data.email };
}

async function requireGoogleLoginSubject(db: D1Database, accountId: string): Promise<string> {
  const row = await db.prepare('SELECT accountId FROM auth_account WHERE "userId" = ? AND providerId = ?')
    .bind(accountId, 'google')
    .first<{ accountId: string }>();
  if (!row) throw new ApiException('GOOGLE_IDENTITY_UNAVAILABLE', 'Google 로그인 정보를 확인한 뒤 Calendar를 연결해 주세요.', 403);
  return row.accountId;
}

async function readConnection(db: D1Database, accountId: string): Promise<ConnectionRow | null> {
  return db.prepare(`SELECT id, account_id, provider, provider_subject, provider_email, status, auth_version, calendar_id, calendar_summary,
    scopes_json, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, updated_at
    FROM calendar_connections WHERE account_id = ? AND provider = 'google'`)
    .bind(accountId)
    .first<ConnectionRow>();
}

async function ensureAppAccount(db: D1Database, accountId: string, now: string): Promise<void> {
  await db.prepare('INSERT INTO app_accounts(id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(accountId, now)
    .run();
}

async function cancelPendingRecoveryActions(db: D1Database, accountId: string, connectionId: string, connectionVersion: number): Promise<void> {
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_actions'").first<{ name: string }>();
  if (!table) return;
  await db.prepare(`UPDATE recovery_actions SET status = 'cancelled'
    WHERE account_id = ? AND connection_id = ? AND connection_version = ? AND status IN ('queued', 'executing')`)
    .bind(accountId, connectionId, connectionVersion)
    .run();
}

async function rotateEncryptedToken(env: CalendarBindings, row: ConnectionRow, nextVersion: number, kind: 'access' | 'refresh'): Promise<string> {
  const config = requireCalendarConfiguration(env);
  const ciphertext = kind === 'access' ? row.encrypted_access_token : row.encrypted_refresh_token;
  if (!ciphertext) throw new ApiException('CALENDAR_REAUTH_REQUIRED', 'Calendar 연결을 다시 확인해 주세요.', 401);
  const plaintext = await decryptSecret(ciphertext, config.secret, tokenAad(row.account_id, row.id, row.auth_version, kind));
  return encryptSecret(plaintext, config.secret, tokenAad(row.account_id, row.id, nextVersion, kind));
}

function requireCalendarConfiguration(env: CalendarBindings): NonNullable<ReturnType<typeof calendarConfiguration>> {
  const config = calendarConfiguration(env);
  if (!config) throw new ApiException('CALENDAR_NOT_CONFIGURED', 'Calendar 연결이 아직 설정되지 않았습니다.', 503);
  return config;
}

function summary(status: CalendarConnectionSummary['status']): CalendarConnectionSummary {
  return { configured: status !== 'not_configured', status, provider: 'google', connectionId: null, version: null, calendarId: null, calendarSummary: null, scopes: [], updatedAt: null };
}

function rowSummary(row: ConnectionRow, status: CalendarConnectionSummary['status'], scopes: string[]): CalendarConnectionSummary {
  return {
    configured: true,
    status,
    provider: 'google',
    connectionId: row.id,
    version: row.auth_version,
    calendarId: row.calendar_id,
    calendarSummary: row.calendar_summary,
    scopes,
    updatedAt: row.updated_at,
  };
}

function parseScopes(raw: string): string[] {
  const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

function normalizeGoogleScopes(scopes: string[]): string[] {
  return scopes.map((scope) => {
    if (scope === GOOGLE_USERINFO_EMAIL_SCOPE) return GOOGLE_EMAIL_SCOPE;
    if (scope === GOOGLE_USERINFO_PROFILE_SCOPE) return GOOGLE_PROFILE_SCOPE;
    return scope;
  });
}

function tokenAad(accountId: string, connectionId: string, version: number, kind: 'access' | 'refresh'): string {
  return `calendar:${kind}:${accountId}:${connectionId}:${version}`;
}

function oauthStateAad(stateHash: string, accountId: string): string {
  return `calendar:oauth-state:${accountId}:${stateHash}`;
}

function expiresAt(seconds: number | undefined): string | null {
  return seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null;
}

function isExpired(expires: string | null): boolean {
  return expires !== null && Date.parse(expires) <= Date.now() + 60_000;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let raw = '';
  for (const byte of new Uint8Array(digest)) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function failure(kind: CalendarProviderErrorKind, message: string): ConnectedCalendarProviderResult {
  return { ok: false, error: { kind, status: null, message } };
}

function providerFailure(kind: CalendarProviderErrorKind): ApiException {
  const statuses: Partial<Record<typeof kind, number>> = {
    not_configured: 503,
    not_connected: 401,
    calendar_missing: 409,
    reauth_required: 401,
    unknown: 503,
  };
  return new ApiException(`CALENDAR_${kind.toUpperCase()}`, 'Calendar 연결 상태를 확인해야 합니다.', statuses[kind] ?? 409);
}
