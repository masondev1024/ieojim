/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { Hono } from 'hono';
import { makeSignature } from 'better-auth/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE, GOOGLE_EMAIL_SCOPE, GOOGLE_GMAIL_SEND_SCOPE, GOOGLE_OPENID_SCOPE, GOOGLE_PROFILE_SCOPE, type CalendarConnectResponse } from '../../src/core/calendar-contracts';
import { createAuthentication } from '../../src/server/auth';
import { mountCalendarRoutes } from '../../src/server/calendar/routes';
import { errorJson, protectUnsafeRequest, type AppBindings, type AppVariables } from '../../src/server/http';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const testEnv = env as TestEnv;
const origin = 'http://127.0.0.1:5174';
const secret = 'calendar-test-secret-more-than-32-characters';
const runtime = () => ({ ...testEnv, APP_ENV: 'test', BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'calendar-client', GOOGLE_CLIENT_SECRET: 'calendar-secret' });
const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

app.onError((error, c) => {
  const apiError = errorJson(error);
  return c.json(apiError.body, apiError.status);
});
app.use('/api/*', protectUnsafeRequest);
mountCalendarRoutes(app);

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('Calendar connection routes', () => {
  it('requires a verified account and reports not configured without leaking config detail', async () => {
    const account = await identity('calendar-status@example.test', 'google-status-subject');
    const disabled = await request('/api/calendar/status', account.cookie, 'GET', undefined, origin, { ...runtime(), GOOGLE_CLIENT_SECRET: '' });

    expect((await request('/api/calendar/status')).status).toBe(401);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ configured: false, status: 'not_configured', connectionId: null });
  });

  it('starts separate OAuth with DB-backed state and fixed Calendar scopes', async () => {
    const account = await identity('calendar-connect@example.test', 'google-connect-subject');
    const response = await request('/api/calendar/connect', account.cookie, 'POST');
    const body = await response.json() as CalendarConnectResponse;
    const url = new URL(body.url);

    expect(response.status).toBe(200);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/api/calendar/callback`);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
      GOOGLE_CALENDAR_FREEBUSY_SCOPE,
      GOOGLE_EMAIL_SCOPE,
      GOOGLE_OPENID_SCOPE,
      GOOGLE_PROFILE_SCOPE,
    ].sort());
    const stateHash = await sha256Hex(url.searchParams.get('state')!);
    const row = await testEnv.DB.prepare('SELECT code_verifier_ciphertext, used_at FROM calendar_oauth_states WHERE state_hash = ?')
      .bind(stateHash)
      .first<{ code_verifier_ciphertext: string; used_at: string | null }>();
    expect(row).toMatchObject({ used_at: null });
    expect(row?.code_verifier_ciphertext).toMatch(/^v1\./);
  });

  it('adds gmail.send only through an explicit second grant after Calendar is connected', async () => {
    const account = await identity('calendar-email@example.test', 'google-email-subject');
    const premature = await request('/api/calendar/connect', account.cookie, 'POST', { includeEmail: true });
    expect(premature.status).toBe(409);

    const target = await startOAuth(account.cookie);
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-email-subject'));
    await request(`/api/calendar/callback?state=${encodeURIComponent(target.searchParams.get('state')!)}&code=calendar`, account.cookie);

    const emailGrant = await request('/api/calendar/connect', account.cookie, 'POST', { includeEmail: true });
    const url = new URL(((await emailGrant.json()) as CalendarConnectResponse).url);
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('scope')).toContain(GOOGLE_GMAIL_SEND_SCOPE);
    expect(url.searchParams.get('scope')).toContain(GOOGLE_CALENDAR_APP_CREATED_SCOPE);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-email-subject', true));
    await request(`/api/calendar/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=email`, account.cookie);
    const scopes = JSON.parse(String(await testEnv.DB.prepare('SELECT scopes_json FROM calendar_connections WHERE account_id = ?').bind(account.userId).first('scopes_json'))) as string[];
    expect(scopes).toContain(GOOGLE_GMAIL_SEND_SCOPE);
    expect(scopes).toContain(GOOGLE_CALENDAR_APP_CREATED_SCOPE);
  });

  it('adopts only a bootstrap-uncertain app calendar whose description matches the operation marker', async () => {
    const account = await identity('calendar-adopt@example.test', 'google-adopt-subject');
    const target = await startOAuth(account.cookie);
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-adopt-subject'));
    await request(`/api/calendar/callback?state=${encodeURIComponent(target.searchParams.get('state')!)}&code=calendar`, account.cookie);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('unknown calendar create outcome'));
    expect((await request('/api/calendar/bootstrap', account.cookie, 'POST')).status).toBe(503);
    const marker = await testEnv.DB.prepare('SELECT marker FROM calendar_bootstrap_ops WHERE account_id = ? AND status = ?')
      .bind(account.userId, 'uncertain')
      .first<string>('marker');

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ id: 'wrong-calendar', summary: 'Wrong', description: 'not-ieojim' }));
    expect((await request('/api/calendar/adopt', account.cookie, 'POST', { calendarId: 'wrong-calendar' })).status).toBe(409);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ id: 'ieojim-adopted', summary: 'Ieojim', description: marker }));
    const adopted = await request('/api/calendar/adopt', account.cookie, 'POST', { calendarId: 'ieojim-adopted' });
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toMatchObject({ status: 'connected', calendarId: 'ieojim-adopted' });
  });

  it('exchanges OAuth code only for the logged-in Google subject and stores encrypted tokens', async () => {
    const account = await identity('calendar-callback@example.test', 'google-callback-subject');
    const target = await startOAuth(account.cookie);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-callback-subject'));

    const callback = await request(`/api/calendar/callback?state=${encodeURIComponent(target.searchParams.get('state')!)}&code=calendar-code`, account.cookie);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${origin}/recovery?calendar=connected`);
    const row = await testEnv.DB.prepare('SELECT status, provider_subject, encrypted_access_token, encrypted_refresh_token, calendar_id FROM calendar_connections WHERE account_id = ?')
      .bind(account.userId)
      .first<{ status: string; provider_subject: string; encrypted_access_token: string; encrypted_refresh_token: string; calendar_id: string | null }>();
    expect(row).toMatchObject({ status: 'connected', provider_subject: 'google-callback-subject', calendar_id: null });
    expect(row?.encrypted_access_token).toMatch(/^v1\./);
    expect(row?.encrypted_refresh_token).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain('calendar-access-token');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects callback replay, subject mismatch, and revoked sessions without creating a connection', async () => {
    const account = await identity('calendar-replay@example.test', 'google-replay-subject');
    const target = await startOAuth(account.cookie);
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('wrong-google-subject'));
    const state = encodeURIComponent(target.searchParams.get('state')!);

    expect((await request(`/api/calendar/callback?state=${state}&code=bad`, account.cookie)).headers.get('location')).toBe(`${origin}/recovery?calendar=error`);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM calendar_connections').first('COUNT(*)')).toBe(0);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-replay-subject'));
    expect((await request(`/api/calendar/callback?state=${state}&code=replay`, account.cookie)).headers.get('location')).toBe(`${origin}/recovery?calendar=error`);

    const revoked = await identity('calendar-revoked@example.test', 'google-revoked-subject');
    const revokedTarget = await startOAuth(revoked.cookie);
    await testEnv.DB.prepare('DELETE FROM auth_session WHERE id = ?').bind(revoked.sessionId).run();
    expect((await request(`/api/calendar/callback?state=${encodeURIComponent(revokedTarget.searchParams.get('state')!)}&code=revoked`, revoked.cookie)).headers.get('location')).toBe(`${origin}/recovery?calendar=error`);
  });

  it('bootstraps one app calendar and blocks repeat after uncertain creation outcome', async () => {
    const account = await identity('calendar-bootstrap@example.test', 'google-bootstrap-subject');
    const target = await startOAuth(account.cookie);
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-bootstrap-subject'));
    expect((await request(`/api/calendar/callback?state=${encodeURIComponent(target.searchParams.get('state')!)}&code=ok`, account.cookie)).status).toBe(302);

    vi.restoreAllMocks();
    const calendarFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_request, init) => {
      const created = JSON.parse(String(init?.body)) as { description: string };
      return Response.json({ id: 'ieojim-calendar-id', summary: 'Ieojim', description: created.description });
    });
    const bootstrap = await request('/api/calendar/bootstrap', account.cookie, 'POST');
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({ status: 'connected', created: true, calendarId: 'ieojim-calendar-id', version: 2 });
    expect(calendarFetch).toHaveBeenCalledTimes(1);

    const second = await request('/api/calendar/bootstrap', account.cookie, 'POST');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ created: false, calendarId: 'ieojim-calendar-id' });

    const uncertain = await identity('calendar-uncertain@example.test', 'google-uncertain-subject');
    const uncertainTarget = await startOAuth(uncertain.cookie);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-uncertain-subject'));
    await request(`/api/calendar/callback?state=${encodeURIComponent(uncertainTarget.searchParams.get('state')!)}&code=ok`, uncertain.cookie);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('unknown calendar create outcome'));
    expect((await request('/api/calendar/bootstrap', uncertain.cookie, 'POST')).status).toBe(503);
    expect((await request('/api/calendar/bootstrap', uncertain.cookie, 'POST')).status).toBe(503);
    expect(await testEnv.DB.prepare('SELECT status FROM calendar_connections WHERE account_id = ?').bind(uncertain.userId).first('status')).toBe('bootstrap_uncertain');
  });

  it('keeps a malformed successful bootstrap uncertain and does not create again', async () => {
    const account = await identity('calendar-marker@example.test', 'google-marker-subject');
    const target = await startOAuth(account.cookie);
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-marker-subject'));
    await request(`/api/calendar/callback?state=${encodeURIComponent(target.searchParams.get('state')!)}&code=ok`, account.cookie);
    vi.restoreAllMocks();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'created-but-untrusted', summary: 'Ieojim', description: 'wrong-marker' }));
    expect((await request('/api/calendar/bootstrap', account.cookie, 'POST')).status).toBe(409);
    expect((await request('/api/calendar/bootstrap', account.cookie, 'POST')).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await testEnv.DB.prepare('SELECT status FROM calendar_connections WHERE account_id=?').bind(account.userId).first('status')).toBe('bootstrap_uncertain');
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-marker-subject'));
    const reconnect = await startOAuth(account.cookie);
    await request(`/api/calendar/callback?state=${encodeURIComponent(reconnect.searchParams.get('state')!)}&code=reconnect`, account.cookie);
    expect(await testEnv.DB.prepare('SELECT status FROM calendar_connections WHERE account_id=?').bind(account.userId).first('status')).toBe('bootstrap_uncertain');
    const marker = await testEnv.DB.prepare('SELECT marker FROM calendar_bootstrap_ops WHERE account_id=?').bind(account.userId).first<string>('marker');
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'recovered-calendar', summary: 'Ieojim', description: marker }));
    expect((await request('/api/calendar/adopt', account.cookie, 'POST', { calendarId: 'recovered-calendar' })).status).toBe(200);
  });

  it('does not let an OAuth callback started before disconnect revive the connection', async () => {
    const account = await identity('calendar-late-oauth@example.test', 'google-late-subject');
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-late-subject'));
    const first = await startOAuth(account.cookie);
    await request(`/api/calendar/callback?state=${encodeURIComponent(first.searchParams.get('state')!)}&code=ok`, account.cookie);
    const late = await startOAuth(account.cookie);
    await request('/api/calendar/disconnect', account.cookie, 'POST');
    const callback = await request(`/api/calendar/callback?state=${encodeURIComponent(late.searchParams.get('state')!)}&code=late`, account.cookie);
    expect(callback.headers.get('location')).toContain('calendar=error');
    expect(await testEnv.DB.prepare('SELECT status FROM calendar_connections WHERE account_id=?').bind(account.userId).first('status')).toBe('disconnected');
    expect(await testEnv.DB.prepare('SELECT encrypted_access_token FROM calendar_connections WHERE account_id=?').bind(account.userId).first('encrypted_access_token')).toBeNull();
  });

  it('disconnects by wiping local tokens and cancelling pending recovery actions when that table exists', async () => {
    const account = await identity('calendar-disconnect@example.test', 'google-disconnect-subject');
    const target = await startOAuth(account.cookie);
    vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch('google-disconnect-subject'));
    await request(`/api/calendar/callback?state=${encodeURIComponent(target.searchParams.get('state')!)}&code=ok`, account.cookie);
    const row = await testEnv.DB.prepare('SELECT id, auth_version FROM calendar_connections WHERE account_id = ?')
      .bind(account.userId)
      .first<{ id: string; auth_version: number }>();
    await testEnv.DB.prepare(`INSERT INTO owners(id, token_hash, account_id, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind('owner-calendar-disconnect', 'owner-calendar-disconnect-hash', account.userId, new Date().toISOString(), new Date().toISOString())
      .run();
    await testEnv.DB.prepare(`INSERT INTO workspaces(id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, 0, 1, 0, ?, ?, ?)`)
      .bind('workspace-calendar-disconnect', 'owner-calendar-disconnect', 'Calendar disconnect', 'pending action', new Date().toISOString(), new Date().toISOString(), '2099-01-01T00:00:00.000Z')
      .run();
    await testEnv.DB.prepare('INSERT INTO recovery_profiles(workspace_id, condition_revision, base_revision, base_source_revision, input_json, proposal_id, updated_at) VALUES (?, 1, 0, 1, ?, ?, ?)')
      .bind('workspace-calendar-disconnect', '{}', 'repair-calendar-disconnect', new Date().toISOString())
      .run();
    await testEnv.DB.prepare(`INSERT INTO recovery_actions(
      id, workspace_id, owner_id, account_id, request_id, connection_id, connection_version, base_revision, source_revision,
      condition_revision, kind, payload_json, payload_hash, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1, 'calendar', '{}', ?, 'queued', ?, ?)`)
      .bind('action-1', 'workspace-calendar-disconnect', 'owner-calendar-disconnect', account.userId, crypto.randomUUID(), row!.id, row!.auth_version, 'a'.repeat(64), new Date().toISOString(), new Date().toISOString())
      .run();

    const disconnected = await request('/api/calendar/disconnect', account.cookie, 'POST');

    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({ disconnected: true, status: 'not_connected' });
    expect(await testEnv.DB.prepare('SELECT encrypted_access_token FROM calendar_connections WHERE account_id = ?').bind(account.userId).first('encrypted_access_token')).toBeNull();
    expect(await testEnv.DB.prepare('SELECT status FROM recovery_actions WHERE id = ?').bind('action-1').first('status')).toBe('cancelled');
  });
});

async function identity(email: string, googleSubject: string) {
  const context = await createAuthentication(runtime())!.$context;
  const user = await context.internalAdapter.createUser({ name: email.split('@')[0], email, emailVerified: true }, { method: 'test' });
  await context.internalAdapter.createAccount({ userId: user.id, providerId: 'google', accountId: googleSubject, scope: 'openid email profile' });
  const session = await context.internalAdapter.createSession(user.id);
  return { userId: user.id, sessionId: session.id, cookie: `ieojim-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, secret)}`)}` };
}

async function startOAuth(cookie: string): Promise<URL> {
  const response = await request('/api/calendar/connect', cookie, 'POST');
  expect(response.status).toBe(200);
  return new URL(((await response.json()) as CalendarConnectResponse).url);
}

function request(path: string, cookie = '', method = 'GET', body?: unknown, originHeader = origin, bindings = runtime()) {
  return app.request(new Request(`${origin}${path}`, {
    method,
    headers: { cookie, origin: originHeader, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }), undefined, bindings);
}

function providerFetch(subject: string, includeEmailScope = false): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({
        access_token: 'calendar-access-token',
        refresh_token: 'calendar-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: [
          GOOGLE_OPENID_SCOPE,
          GOOGLE_EMAIL_SCOPE,
          GOOGLE_PROFILE_SCOPE,
          GOOGLE_CALENDAR_APP_CREATED_SCOPE,
          GOOGLE_CALENDAR_FREEBUSY_SCOPE,
          ...(includeEmailScope ? [GOOGLE_GMAIL_SEND_SCOPE] : []),
        ].join(' '),
      });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return Response.json({ sub: subject, email: `${subject}@example.test`, email_verified: true });
    }
    throw new Error(`unexpected provider fetch ${url}`);
  }) as typeof fetch;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
