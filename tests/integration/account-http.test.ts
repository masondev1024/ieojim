/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { makeSignature } from 'better-auth/crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { createAuthentication } from '../../src/server/auth';
import { authorizedDatabase } from '../../src/server/authorized-database';
import { sha256Hex } from '../../src/server/crypto';
import type { AccountState } from '../../src/core/account-contracts';
import type { WorkspaceView } from '../../src/core/contracts';

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const origin = 'http://127.0.0.1:5174';
const secret = 'isolated-http-test-secret-more-than-32-characters';
const runtime = () => ({ ...testEnv, APP_ENV: 'test', BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });
const app = createApp();
beforeEach(async () => { await reset(); await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });

async function identity(email: string, userId?: string) {
  const context = await createAuthentication(runtime())!.$context;
  const id = userId ?? (await context.internalAdapter.createUser({ name: email.split('@')[0], email, emailVerified: true }, { method: 'test' })).id;
  const session = await context.internalAdapter.createSession(id);
  return { userId: id, sessionId: session.id, cookie: `ieojim-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, secret)}`)}` };
}
function request(path: string, cookie = '', method = 'GET', body?: unknown, originHeader = origin, bindings = runtime()) {
  return app.request(new Request(`${origin}${path}`, { method, headers: { cookie, origin: originHeader, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }), undefined, bindings);
}
async function guest() {
  const response = await request('/api/workspaces/sample', '', 'POST', { scenario: 'travel' });
  expect(response.status).toBe(201);
  return { cookie: response.headers.getSetCookie().find(c => c.startsWith('ieojim_owner='))!.split(';')[0], workspace: await response.json() as WorkspaceView };
}
async function preview(cookie: string) {
  const response = await request('/api/account', cookie);
  expect(response.status).toBe(200);
  return (await response.json() as AccountState).guestPreview!;
}
async function claim(cookie: string) {
  const before = await preview(cookie);
  const input = { requestId: crypto.randomUUID(), previewHash: before.previewHash };
  const response = await request('/api/account/claim', cookie, 'POST', input);
  expect(response.status).toBe(200);
  return { input, response };
}

it('keeps guest creation available and account/login honestly disabled without provider configuration', async () => {
  const bindings = { ...runtime(), BETTER_AUTH_SECRET: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' };
  const account = await request('/api/account', '', 'GET', undefined, origin, bindings);
  expect(await account.json()).toMatchObject({ authAvailable: false, user: null, guestPreview: null, retentionDays: 7 });
  const login = await request('/api/account/login', '', 'POST', {}, origin, bindings);
  expect(login.status).toBe(503);
  expect(await login.json()).toMatchObject({ error: { code: 'AUTH_UNAVAILABLE' } });
  expect((await request('/api/workspaces', '', 'POST', { title: 'Guest', purpose: 'Unconfigured auth' }, origin, bindings)).status).toBe(201);
});

it('reports auth unavailable on noncanonical deployed hosts while retaining guest access', async () => {
  const canonical = 'https://ieojim.example.test';
  const legacy = 'https://ieojim-staging.masondev1024.workers.dev';
  const bindings = { ...runtime(), APP_ENV: 'staging', BETTER_AUTH_URL: canonical };
  const account = await app.request(new Request(`${legacy}/api/account`), undefined, bindings);
  expect(account.status).toBe(200);
  expect(await account.json()).toMatchObject({ authAvailable: false, user: null, guestPreview: null, retentionDays: 7 });

  const created = await app.request(new Request(`${legacy}/api/workspaces/sample`, {
    method: 'POST',
    headers: { origin: legacy, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.20' },
    body: JSON.stringify({ scenario: 'travel' }),
  }), undefined, { ...bindings, PUBLIC_WRITES: { limit: async () => ({ success: true }) } });
  expect(created.status).toBe(201);
  expect(created.headers.getSetCookie().find(cookie => cookie.startsWith('ieojim_owner='))).toBeTruthy();
});

it('keeps auth available through the repo-owned local dev proxy pair', async () => {
  const response = await app.request(new Request('http://127.0.0.1:8788/api/account'), undefined, runtime());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ authAvailable: true, user: null, guestPreview: null, retentionDays: 7 });
});

it('shares a primary owner between devices and isolates other accounts on real item endpoints', async () => {
  const a = await identity('a@example.test');
  const a2 = await identity('a@example.test', a.userId);
  const b = await identity('b@example.test');
  const created = await request('/api/workspaces/sample', a.cookie, 'POST', { scenario: 'travel' });
  expect(created.status).toBe(201);
  const workspace = await created.json() as WorkspaceView;
  expect((await request(`/api/workspaces/${workspace.id}`, a2.cookie)).status).toBe(200);
  expect((await request('/api/workspaces', a2.cookie)).status).toBe(200);
  expect((await request(`/api/workspaces/${workspace.id}`, b.cookie)).status).toBe(404);
  const item = workspace.snapshot.blocks.flatMap(block => block.items)[0];
  const edit = { baseRevision: workspace.revision, requestId: crypto.randomUUID(), itemId: item.id, value: 'Unauthorized edit' };
  expect((await request(`/api/workspaces/${workspace.id}/items`, b.cookie, 'PATCH', edit)).status).toBe(404);
  expect((await request(`/api/workspaces/${workspace.id}`, b.cookie, 'DELETE')).status).toBe(404);
  expect((await request(`/api/workspaces/${workspace.id}/items`, a2.cookie, 'PATCH', edit)).status).toBe(200);
});

it('requires explicit claim and resolves a claimed guest bucket for detail, edit and replay', async () => {
  const g = await guest();
  const a = await identity('claim@example.test');
  const combined = `${a.cookie}; ${g.cookie}`;
  expect(await (await request('/api/workspaces', combined)).json()).toEqual([]);
  expect((await request(`/api/workspaces/${g.workspace.id}`, combined)).status).toBe(404);
  const accepted = await claim(combined);
  expect(await accepted.response.json()).toEqual({ claimedCount: 1, workspaceIds: [g.workspace.id] });
  expect(await (await request('/api/account/claim', a.cookie, 'POST', accepted.input)).json()).toEqual({ claimedCount: 1, workspaceIds: [g.workspace.id] });
  expect((await request(`/api/workspaces/${g.workspace.id}`, a.cookie)).status).toBe(200);
  const item = g.workspace.snapshot.blocks.flatMap(block => block.items)[0];
  expect((await request(`/api/workspaces/${g.workspace.id}/items`, a.cookie, 'PATCH', {
    baseRevision: g.workspace.revision, requestId: crypto.randomUUID(), itemId: item.id, locked: true,
  })).status).toBe(200);
  expect((await request(`/api/workspaces/${g.workspace.id}`, g.cookie)).status).toBe(404);
  const b = await identity('foreign@example.test');
  expect((await request('/api/account/claim', `${b.cookie}; ${g.cookie}`, 'POST', accepted.input)).status).toBe(409);
});

it('durably logs out only the current session and rejects replay of its old cookie', async () => {
  const a = await identity('logout@example.test');
  const other = await identity('logout@example.test', a.userId);
  const loggedOut = await request('/api/account/logout', a.cookie, 'POST');
  expect(loggedOut.status).toBe(204);
  expect(await testEnv.DB.prepare('SELECT id FROM auth_session WHERE id = ?').bind(a.sessionId).first()).toBeNull();
  expect((await request('/api/workspaces', a.cookie)).status).toBe(401);
  expect((await request('/api/workspaces', other.cookie)).status).toBe(200);
  expect(await (await request('/api/account', a.cookie)).json()).toMatchObject({ user: null });
});

it('revokes other devices while preserving the current session and unrelated accounts', async () => {
  const a = await identity('revoke@example.test');
  const other = await identity('revoke@example.test', a.userId);
  const b = await identity('untouched@example.test');
  expect(await (await request('/api/account/revoke-other-sessions', a.cookie, 'POST')).json()).toEqual({ revoked: true });
  expect((await request('/api/workspaces', other.cookie)).status).toBe(401);
  expect((await request('/api/workspaces', a.cookie)).status).toBe(200);
  expect((await request('/api/workspaces', b.cookie)).status).toBe(200);
});

it('never falls back to guest writes for expired, revoked or tampered account cookies', async () => {
  const g = await guest();
  const a = await identity('expired@example.test');
  await testEnv.DB.prepare('UPDATE auth_session SET "expiresAt" = ? WHERE id = ?').bind(new Date(0).toISOString(), a.sessionId).run();
  for (const cookie of [a.cookie, `${a.cookie}tampered`, 'ieojim-auth.session_token=invalid.signature']) {
    expect((await request('/api/workspaces', `${cookie}; ${g.cookie}`, 'POST', { title: 'Must not create', purpose: 'No fallback' })).status).toBe(401);
  }
  expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM workspaces').first('count')).toBe(1);
});

it('enforces CSRF on all account mutations and does not expose password/linking endpoints', async () => {
  const a = await identity('csrf@example.test');
  for (const path of ['login', 'logout', 'claim', 'revoke-other-sessions']) {
    expect((await request(`/api/account/${path}`, a.cookie, 'POST', {}, 'https://evil.test')).status).toBe(403);
  }
  for (const path of ['sign-in/email', 'sign-up/email', 'link-social', 'delete-user']) {
    expect((await request(`/api/auth/${path}`, a.cookie, 'POST')).status).toBe(404);
  }
});

it('starts only Google OAuth with fixed callback URLs and rejects provider/redirect injection', async () => {
  expect((await request('/api/account/login', '', 'POST', { provider: 'github', callbackURL: 'https://evil.test' })).status).toBe(422);
  const login = await request('/api/account/login', '', 'POST');
  expect(login.status).toBe(200);
  const url = new URL((await login.json() as { url: string }).url);
  expect(url.origin).toBe('https://accounts.google.com');
  expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/callback/google`);
  expect(url.searchParams.get('scope')).toBe('openid email profile');
  expect(url.searchParams.get('include_granted_scopes')).toBeNull();
  const row = await testEnv.DB.prepare('SELECT value FROM auth_verification WHERE identifier = ?').bind(url.searchParams.get('state')).first<{ value: string }>();
  expect(JSON.parse(row!.value)).toMatchObject({ callbackURL: `${origin}/settings`, errorURL: `${origin}/login?error=oauth` });
});

it('exposes only safe account state and rejects guest claim without a verified session', async () => {
  const a = await identity('safe@example.test');
  const state = await (await request('/api/account', a.cookie)).json() as AccountState;
  expect(state.user?.email).toBe('safe@example.test');
  expect(JSON.stringify(state)).not.toMatch(/session_token|accessToken|refreshToken|idToken|providerId|codeVerifier|test-secret/i);
  expect((await request('/api/account/claim', '', 'POST', { requestId: crypto.randomUUID(), previewHash: 'a'.repeat(64) })).status).toBe(401);
});

it('fences a guest write prepared before claim when it executes after credential revocation', async () => {
  const g = await guest();
  const token = g.cookie.slice('ieojim_owner='.length);
  const hash = await sha256Hex(token);
  const owner = await testEnv.DB.prepare('SELECT id, credential_version FROM owners WHERE token_hash = ?').bind(hash).first<{ id: string; credential_version: number }>();
  const guarded = authorizedDatabase(testEnv.DB, { kind: 'guest', ownerId: owner!.id, tokenHash: hash, credentialVersion: owner!.credential_version });
  const prepared = guarded.prepare('UPDATE workspaces SET title = ? WHERE id = ?').bind('Unauthorized late edit', g.workspace.id);
  const a = await identity('fence@example.test');
  await claim(`${a.cookie}; ${g.cookie}`);
  await expect(prepared.run()).rejects.toMatchObject({ code: 'SESSION_CHANGED', status: 401 });
  expect(await testEnv.DB.prepare('SELECT title FROM workspaces WHERE id = ?').bind(g.workspace.id).first('title')).toBe(g.workspace.title);
});

it('rolls back a prepared account batch after server-side session revocation', async () => {
  const a = await identity('batch@example.test');
  const guarded = authorizedDatabase(testEnv.DB, { kind: 'account', accountId: a.userId, sessionId: a.sessionId });
  const insert = guarded.prepare('INSERT INTO tx_guards(id,created_at) VALUES (?,?)').bind('must-not-exist', new Date().toISOString());
  await testEnv.DB.prepare('DELETE FROM auth_session WHERE id = ?').bind(a.sessionId).run();
  await expect(guarded.batch([insert])).rejects.toMatchObject({ code: 'SESSION_CHANGED', status: 401 });
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM tx_guards').first('COUNT(*)')).toBe(0);
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM authz_assertions').first('COUNT(*)')).toBe(0);
});

it('normalizes missing, unknown and replayed callback state to the product login failure', async () => {
  const login = await request('/api/account/login', '', 'POST');
  const target = new URL((await login.json() as { url: string }).url);
  const state = target.searchParams.get('state')!;
  const cookies = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
  await testEnv.DB.prepare('DELETE FROM auth_verification WHERE identifier = ?').bind(state).run();
  for (const query of ['', '?code=unused&state=unknown', `?code=unused&state=${encodeURIComponent(state)}`]) {
    const response = await request(`/api/auth/callback/google${query}`, cookies);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${origin}/login?error=oauth`);
  }
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM auth_session').first('COUNT(*)')).toBe(0);
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM auth_user').first('COUNT(*)')).toBe(0);
});

it('mounts the Google OAuth callback through createApp and returns a verified account session', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      return Response.json({
        access_token: 'mounted-access-token',
        token_type: 'Bearer',
        scope: 'openid email profile',
        id_token: unsignedGoogleIdToken('mounted@example.test', 'google-mounted-subject'),
      });
    }
    throw new Error(`unexpected provider fetch: ${String(input)}`);
  });
  try {
    const login = await request('/api/account/login', '', 'POST');
    expect(login.status).toBe(200);
    const target = new URL((await login.json() as { url: string }).url);
    const state = target.searchParams.get('state')!;
    const cookies = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');

    const callback = await request(`/api/auth/callback/google?state=${encodeURIComponent(state)}&code=mounted-code`, cookies);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${origin}/settings`);
    const sessionCookie = callback.headers.getSetCookie().find(cookie => /ieojim-auth\.session_token=/.test(cookie));
    expect(sessionCookie).toBeTruthy();

    const account = await request('/api/account', sessionCookie!.split(';')[0]);
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({
      authAvailable: true,
      user: { email: 'mounted@example.test', name: 'Mounted User' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
  }
});

it('rate-limits deployed OAuth callbacks before provider processing without requiring Origin', async () => {
  const remoteEnv = { ...runtime(), APP_ENV: 'staging', BETTER_AUTH_URL: 'https://public.test', PUBLIC_WRITES: { limit: async () => ({ success: false }) } };
  const response = await app.request(new Request('https://public.test/api/auth/callback/google?state=unknown', {
    headers: { 'cf-connecting-ip': '192.0.2.8' },
  }), undefined, remoteEnv);
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
});

it('reports account usage across a claimed bucket and preserves consumed runs after workspace deletion', async () => {
  expect((await request('/api/account/usage')).status).toBe(401);
  const g = await guest();
  const a = await identity('usage-a@example.test');
  const b = await identity('usage-b@example.test');
  const primary = await (await request('/api/workspaces/sample', a.cookie, 'POST', { scenario: 'travel' })).json() as WorkspaceView;
  await claim(`${a.cookie}; ${g.cookie}`);
  await testEnv.DB.prepare(`INSERT INTO budget_ledger(id,owner_id,workspace_id,run_id,entry_type,amount_micro_usd,created_at)
    SELECT ?,owner_id,id,NULL,'reserve',1,? FROM workspaces WHERE id=?`)
    .bind('usage-preserved-reserve', new Date().toISOString(), g.workspace.id).run();
  const beforeExpiry = await testEnv.DB.prepare('SELECT expires_at FROM workspaces WHERE id=?').bind(primary.id).first('expires_at');
  const usage = await request('/api/account/usage', a.cookie);
  expect(usage.status).toBe(200);
  expect(await usage.json()).toMatchObject({ activeWorkspaces: { used: 2, limit: 10 }, aiRunsToday: { used: 1, limit: 10 } });
  expect(await (await request('/api/account/usage', b.cookie)).json()).toMatchObject({ activeWorkspaces: { used: 0 }, aiRunsToday: { used: 0 } });
  expect((await request(`/api/workspaces/${g.workspace.id}`, a.cookie, 'DELETE')).status).toBe(204);
  expect(await (await request('/api/account/usage', a.cookie)).json()).toMatchObject({ activeWorkspaces: { used: 1 }, aiRunsToday: { used: 1 } });
  expect(await testEnv.DB.prepare('SELECT expires_at FROM workspaces WHERE id=?').bind(primary.id).first('expires_at')).toBe(beforeExpiry);
});

it('downloads the current owned plan with headers and refuses revoked guest or account export', async () => {
  const g = await guest();
  const item = g.workspace.snapshot.blocks.flatMap(block => block.items)[0];
  expect((await request(`/api/workspaces/${g.workspace.id}/items`, g.cookie, 'PATCH', {
    baseRevision: g.workspace.revision, requestId: crypto.randomUUID(), itemId: item.id, value: 'Protected export content', locked: true,
  })).status).toBe(200);
  const guestExport = await request(`/api/workspaces/${g.workspace.id}/export`, g.cookie);
  expect(guestExport.status).toBe(200);
  expect(guestExport.headers.get('content-disposition')).toContain('attachment;');
  expect(guestExport.headers.get('cache-control')).toBe('no-store');
  const exported = await guestExport.json() as { format: string; content: { workspace: { id: string; revision: number }; snapshot: WorkspaceView['snapshot'] }; checksum: { value: string } };
  expect(exported.format).toBe('ieojim.workspace');
  expect(exported.content.workspace).toMatchObject({ id: g.workspace.id, revision: g.workspace.revision + 1 });
  expect(exported.content.snapshot.blocks.flatMap(block => block.items).find(candidate => candidate.id === item.id)).toMatchObject({ value: 'Protected export content', locked: true, edited: true });
  expect(await sha256Hex(JSON.stringify(exported.content))).toBe(exported.checksum.value);
  const a = await identity('export-a@example.test');
  expect((await request(`/api/workspaces/${g.workspace.id}/export`, a.cookie)).status).toBe(404);
  await claim(`${a.cookie}; ${g.cookie}`);
  expect((await request(`/api/workspaces/${g.workspace.id}/export`, g.cookie)).status).toBe(404);
  expect((await request(`/api/workspaces/${g.workspace.id}/export`, a.cookie)).status).toBe(200);
  await testEnv.DB.prepare('DELETE FROM auth_session WHERE id=?').bind(a.sessionId).run();
  expect((await request(`/api/workspaces/${g.workspace.id}/export`, a.cookie)).status).toBe(401);
  expect((await request('/api/account/usage', a.cookie)).status).toBe(401);
});

const unsignedGoogleIdToken = (email: string, sub: string) => [
  base64UrlJson({ alg: 'RS256', kid: 'mounted-test-kid' }),
  base64UrlJson({
    iss: 'https://accounts.google.com',
    aud: 'test-client',
    sub,
    email,
    email_verified: true,
    name: 'Mounted User',
    picture: 'https://example.test/mounted.png',
  }),
  'signature',
].join('.');

const base64UrlJson = (value: Record<string, unknown>) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
