/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { makeSignature } from 'better-auth/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authConfiguration, authOptions, createAuthentication, resolveAccountSession, type AuthBindings } from '../../src/server/auth';

type TestEnv = Cloudflare.Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};
type JsonRecord = Record<string, unknown>;
type VerificationRow = { identifier: string; value: string; expiresAt: string };

const testEnv = env as TestEnv;
const baseURL = 'http://127.0.0.1:5174';
const secret = 'test-better-auth-secret-minimum-32-bytes';

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('Better Auth runtime configuration', () => {
  it('keeps authentication disabled until every required runtime binding is configured', async () => {
    const disabled = authEnv({ BETTER_AUTH_URL: undefined });

    expect(authConfiguration(disabled)).toBeNull();
    expect(authOptions(disabled)).toBeNull();
    expect(createAuthentication(disabled)).toBeNull();
    await expect(resolveAccountSession(disabled, accountRequest())).resolves.toBeNull();
    await expect(resolveAccountSession(disabled, accountRequest('ieojim-auth.session_token=present.signature')))
      .rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE', status: 503 });
  });

  it('rejects unsafe origins and request/baseURL mismatches', () => {
    expectInvalidConfiguration(() => authConfiguration(authEnv({ APP_ENV: 'production', BETTER_AUTH_URL: 'http://auth.example.com' })));
    expectInvalidConfiguration(() => createAuthentication(authEnv(), `${baseURL.replace('5174', '5175')}/api/account/session`));
  });

  it('pins session behavior to fixed server-side sessions without cookie cache refresh', () => {
    const options = authOptions(authEnv());

    expect(options?.baseURL).toBe(baseURL);
    expect(options?.basePath).toBe('/api/auth');
    expect(options?.session).toMatchObject({
      modelName: 'auth_session',
      expiresIn: 7 * 24 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    });
    expect(options?.advanced).toMatchObject({ cookiePrefix: 'ieojim-auth', useSecureCookies: false });
  });
});

describe('Better Auth D1 session runtime', () => {
  it('resolves a valid signed session cookie from DB and rejects expired, tampered, and revoked sessions', async () => {
    const auth = createAuthentication(authEnv(), `${baseURL}/api/account/session`);
    expect(auth).not.toBeNull();
    const context = await auth!.$context;
    const user = await context.internalAdapter.createUser({
      email: 'verified@example.test',
      emailVerified: true,
      name: 'Verified User',
      image: null,
    }, { method: 'test' });
    const session = await context.internalAdapter.createSession(user.id, false, {
      ipAddress: '127.0.0.1',
      userAgent: 'auth-runtime-test',
    });
    const cookie = await sessionCookie(session.token);

    await expect(resolveAccountSession(authEnv(), accountRequest(cookie))).resolves.toEqual({
      user: { id: user.id, name: 'Verified User', email: 'verified@example.test' },
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
    });

    await expect(resolveAccountSession(authEnv(), accountRequest(cookie.replace(/.$/, 'x')))).resolves.toBeNull();

    await testEnv.DB.prepare('UPDATE auth_session SET expiresAt = ? WHERE token = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), session.token)
      .run();
    await expect(resolveAccountSession(authEnv(), accountRequest(cookie))).resolves.toBeNull();

    const activeSession = await context.internalAdapter.createSession(user.id);
    const activeCookie = await sessionCookie(activeSession.token);
    await context.internalAdapter.deleteSession(activeSession.token);
    await expect(resolveAccountSession(authEnv(), accountRequest(activeCookie))).resolves.toBeNull();
  });

  it('rejects unverified account sessions before returning an application account identity', async () => {
    const auth = createAuthentication(authEnv(), `${baseURL}/api/account/session`);
    const context = await auth!.$context;
    const user = await context.internalAdapter.createUser({
      email: 'unverified@example.test',
      emailVerified: false,
      name: 'Unverified User',
      image: null,
    }, { method: 'test' });
    const session = await context.internalAdapter.createSession(user.id);

    await expect(resolveAccountSession(authEnv(), accountRequest(await sessionCookie(session.token))))
      .rejects.toMatchObject({ code: 'ACCOUNT_NOT_VERIFIED', status: 403 });
  });

  it('uses the configured auth schema through normal user, session, account, and verification adapter methods', async () => {
    const auth = createAuthentication(authEnv(), `${baseURL}/api/account/session`);
    const context = await auth!.$context;
    const user = await context.internalAdapter.createUser({
      email: 'methods@example.test',
      emailVerified: true,
      name: 'Method User',
      image: null,
    }, { method: 'test' });
    const account = await context.internalAdapter.createAccount({
      userId: user.id,
      providerId: 'google',
      accountId: 'google-method-user',
      scope: 'openid email profile',
    });
    const session = await context.internalAdapter.createSession(user.id);
    const verification = await context.internalAdapter.createVerificationValue({
      identifier: 'runtime-method-state',
      value: JSON.stringify({ callbackURL: `${baseURL}/app`, codeVerifier: 'verifier', expiresAt: Date.now() + 60_000 }),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(await context.internalAdapter.findUserByEmail('methods@example.test')).toMatchObject({ user: { id: user.id } });
    expect(await context.internalAdapter.findAccountByKey({ providerId: 'google', accountId: 'google-method-user' })).toMatchObject({ id: account.id });
    expect(await context.internalAdapter.findSession(session.token)).toMatchObject({ session: { id: session.id }, user: { id: user.id } });
    expect(await context.internalAdapter.findVerificationValue('runtime-method-state')).toMatchObject({ id: verification.id });
  });

  it('enforces same-email and provider identity uniqueness at the D1 schema boundary', async () => {
    const now = new Date().toISOString();
    await testEnv.DB.prepare('INSERT INTO auth_user (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('auth_user_a', 'A', 'unique@example.test', 1, null, now, now)
      .run();
    await expect(testEnv.DB.prepare('INSERT INTO auth_user (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('auth_user_b', 'B', 'unique@example.test', 1, null, now, now)
      .run()).rejects.toThrow();

    await testEnv.DB.prepare('INSERT INTO auth_user (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('auth_user_c', 'C', 'identity-a@example.test', 1, null, now, now)
      .run();
    await testEnv.DB.prepare('INSERT INTO auth_user (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('auth_user_d', 'D', 'identity-b@example.test', 1, null, now, now)
      .run();
    await testEnv.DB.prepare('INSERT INTO auth_account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('auth_account_a', 'same-google-subject', 'google', 'auth_user_c', now, now)
      .run();
    await expect(testEnv.DB.prepare('INSERT INTO auth_account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('auth_account_b', 'same-google-subject', 'google', 'auth_user_d', now, now)
      .run()).rejects.toThrow();
  });
});

describe('Better Auth social sign-in state handling', () => {
  it('creates DB-backed OAuth state with PKCE and rejects invalid callback state before provider IO', async () => {
    const auth = createAuthentication(authEnv(), `${baseURL}/api/auth/sign-in/social`);
    const response = await auth!.handler(new Request(`${baseURL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ provider: 'google', callbackURL: `${baseURL}/app`, errorCallbackURL: `${baseURL}/auth/error`, disableRedirect: true }),
    }));
    const payload = await response.json() as JsonRecord;
    const redirectURL = new URL(String(payload.url));
    const state = redirectURL.searchParams.get('state');
    const codeChallenge = redirectURL.searchParams.get('code_challenge');

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ redirect: false });
    expect(redirectURL.hostname).toBe('accounts.google.com');
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

    const stored = await testEnv.DB.prepare('SELECT identifier, value, expiresAt FROM auth_verification WHERE identifier = ?')
      .bind(state)
      .first<VerificationRow>();
    const statePayload = JSON.parse(stored?.value ?? '{}') as JsonRecord;
    expect(stored).toMatchObject({ identifier: state });
    expect(statePayload).toMatchObject({ callbackURL: `${baseURL}/app`, oauthState: state });
    expect(typeof statePayload.codeVerifier).toBe('string');
    expect(new Date(stored!.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider IO should not happen for invalid OAuth state'));
    const invalid = await auth!.handler(new Request(`${baseURL}/api/auth/callback/google?state=missing-state&code=fake-code`));

    expect(invalid.status).toBeGreaterThanOrEqual(300);
    expect(invalid.status).toBeLessThan(400);
    expect(invalid.headers.get('location')).toContain('state_mismatch');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects replayed callback state after DB state consumption before provider IO', async () => {
    const auth = createAuthentication(authEnv(), `${baseURL}/api/auth/sign-in/social`);
    const response = await auth!.handler(new Request(`${baseURL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ provider: 'google', callbackURL: `${baseURL}/app`, errorCallbackURL: `${baseURL}/auth/error`, disableRedirect: true }),
    }));
    const payload = await response.json() as JsonRecord;
    const state = new URL(String(payload.url)).searchParams.get('state');
    expect(state).toBeTruthy();
    await testEnv.DB.prepare('DELETE FROM auth_verification WHERE identifier = ?').bind(state).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider IO should not happen for replayed OAuth state'));
    const replay = await auth!.handler(new Request(`${baseURL}/api/auth/callback/google?state=${state}&code=fake-code`));

    expect(replay.status).toBeGreaterThanOrEqual(300);
    expect(replay.status).toBeLessThan(400);
    expect(replay.headers.get('location')).toContain('state_mismatch');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const authEnv = (overrides: Partial<TestEnv> = {}): AuthBindings => ({
  ...testEnv,
  APP_ENV: 'test',
  BETTER_AUTH_URL: baseURL,
  BETTER_AUTH_SECRET: secret,
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  ...overrides,
});

const jsonHeaders = () => new Headers({
  'content-type': 'application/json',
  origin: baseURL,
});

const accountRequest = (cookie?: string) => new Request(`${baseURL}/api/account/session`, cookie ? { headers: { cookie } } : undefined);

const sessionCookie = async (token: string) => `ieojim-auth.session_token=${token}.${await makeSignature(token, secret)}`;

const expectInvalidConfiguration = (action: () => unknown) => {
  try {
    action();
    throw new Error('expected invalid auth configuration');
  } catch (error) {
    expect(error).toMatchObject({ code: 'INVALID_AUTH_CONFIG', status: 503 });
  }
};
