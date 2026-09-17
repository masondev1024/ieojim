/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuth2Tokens, OAuthProvider } from 'better-auth/oauth2';
import type { JWTVerifyGetKey } from 'jose';
import { authOptions, type AuthBindings } from '../../src/server/auth';
import { authProviderBudget } from '../../src/server/auth-provider-budget';

type TestEnv = Cloudflare.Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};
type JsonObject = Record<string, unknown>;
type TestGoogleOverrides = {
  validateAuthorizationCode?: OAuthProvider['validateAuthorizationCode'];
  getUserInfo?: OAuthProvider['getUserInfo'];
  jwks?: JWTVerifyGetKey;
};

type Pending<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };

const testEnv = env as TestEnv;
const baseURL = 'http://127.0.0.1:5174';
const secret = 'test-better-auth-secret-minimum-32-bytes';

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('authProviderBudget', () => {
  it('times out validateAuthorizationCode and discards late token results before sessions can be minted', async () => {
    const tokens = pending<OAuth2Tokens>();
    const auth = testAuth({ deadlineMs: 5, overrides: { validateAuthorizationCode: () => tokens.promise } });
    const callback = await startGoogleCallback(auth);

    const response = await auth.handler(callback.request);
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('location')).toContain('invalid_code');
    expect(await authSessionCount()).toBe(0);
    expect(await authUserCount()).toBe(0);

    tokens.resolve(validTokens());
    await settleLateProviderResult();
    expect(await authSessionCount()).toBe(0);
    expect(await authUserCount()).toBe(0);
  });

  it('times out getUserInfo and discards late profile results before users or sessions can be created', async () => {
    const userInfo = pending<Awaited<ReturnType<OAuthProvider['getUserInfo']>>>();
    const auth = testAuth({
      deadlineMs: 5,
      overrides: {
        validateAuthorizationCode: async () => validTokens(),
        getUserInfo: () => userInfo.promise,
      },
    });
    const callback = await startGoogleCallback(auth);

    const response = await auth.handler(callback.request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await authSessionCount()).toBe(0);
    expect(await authUserCount()).toBe(0);

    userInfo.resolve(validUserInfo());
    await settleLateProviderResult();
    expect(await authSessionCount()).toBe(0);
    expect(await authUserCount()).toBe(0);
  });

  it('times out Google idToken JWKS resolution and discards late keys before id-token sign-in can mint a session', async () => {
    const jwks = pending<Awaited<ReturnType<JWTVerifyGetKey>>>();
    const getUserInfo = vi.fn<OAuthProvider['getUserInfo']>(async () => validUserInfo());
    const auth = testAuth({
      deadlineMs: 5,
      overrides: {
        jwks: () => jwks.promise,
        getUserInfo,
      },
    });

    const response = await auth.handler(new Request(`${baseURL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ provider: 'google', idToken: { token: unsignedGoogleIdToken(), nonce: 'nonce' }, callbackURL: `${baseURL}/app` }),
    }));

    expect(response.status).toBe(401);
    expect(getUserInfo).not.toHaveBeenCalled();
    expect(await authSessionCount()).toBe(0);
    expect(await authUserCount()).toBe(0);

    jwks.resolve(await latePublicKey());
    await settleLateProviderResult();
    expect(await authSessionCount()).toBe(0);
    expect(await authUserCount()).toBe(0);
  });

  it('allows provider results that complete inside the deadline to create exactly one user session', async () => {
    const auth = testAuth({
      deadlineMs: 100,
      overrides: {
        validateAuthorizationCode: async () => validTokens(),
        getUserInfo: async () => validUserInfo(),
      },
    });
    const callback = await startGoogleCallback(auth);

    const response = await auth.handler(callback.request);

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('location')).toBe(`${baseURL}/app`);
    expect(await authSessionCount()).toBe(1);
    expect(await authUserCount()).toBe(1);
  });
});

function testAuth({ deadlineMs, overrides }: { deadlineMs: number; overrides: TestGoogleOverrides }) {
  const options = authOptions(authEnv());
  if (!options) throw new Error('expected auth options');
  return betterAuth({
    ...options,
    plugins: [testGoogleProvider(overrides), authProviderBudget({ deadlineMs })],
  } satisfies BetterAuthOptions);
}

function testGoogleProvider(overrides: TestGoogleOverrides): BetterAuthPlugin {
  return {
    id: 'ieojim-test-google-provider',
    init(ctx) {
      const provider = ctx.socialProviders.find((candidate) => candidate.id === 'google');
      if (!provider) throw new Error('expected google provider');
      if (overrides.validateAuthorizationCode) provider.validateAuthorizationCode = overrides.validateAuthorizationCode;
      if (overrides.getUserInfo) provider.getUserInfo = overrides.getUserInfo;
      if (overrides.jwks && provider.idToken && 'jwks' in provider.idToken) provider.idToken = { ...provider.idToken, jwks: overrides.jwks };
    },
  };
}

async function startGoogleCallback(auth: { handler(request: Request): Promise<Response> }) {
  const start = await auth.handler(new Request(`${baseURL}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ provider: 'google', callbackURL: `${baseURL}/app`, errorCallbackURL: `${baseURL}/auth/error`, disableRedirect: true }),
  }));
  expect(start.status).toBe(200);
  const body = await readJson(start);
  const state = new URL(String(body.url)).searchParams.get('state');
  expect(state).toBeTruthy();
  return {
    request: new Request(`${baseURL}/api/auth/callback/google?state=${state}&code=provider-code`, {
      headers: { cookie: cookieHeader(start) },
    }),
  };
}

function validTokens(): OAuth2Tokens {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    idToken: unsignedGoogleIdToken(),
    scopes: ['openid', 'email', 'profile'],
  };
}

function validUserInfo(): Awaited<ReturnType<OAuthProvider['getUserInfo']>> {
  return {
    user: {
      name: 'Provider User',
      email: 'provider@example.test',
      image: 'https://example.test/avatar.png',
      emailVerified: true,
    },
    data: {
      sub: 'google-subject-1',
      email: 'provider@example.test',
      email_verified: true,
      name: 'Provider User',
      picture: 'https://example.test/avatar.png',
    },
  };
}

function pending<T>(): Pending<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

const authEnv = (): AuthBindings => ({
  ...testEnv,
  APP_ENV: 'test',
  BETTER_AUTH_URL: baseURL,
  BETTER_AUTH_SECRET: secret,
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
});

const jsonHeaders = () => new Headers({
  'content-type': 'application/json',
  origin: baseURL,
});

const readJson = async (response: Response): Promise<JsonObject> => JSON.parse(await response.text()) as JsonObject;

const cookieHeader = (response: Response) => splitSetCookie(response.headers.get('set-cookie') ?? '')
  .map((cookie) => cookie.split(';')[0])
  .join('; ');

const splitSetCookie = (header: string) => header ? header.split(/,(?=\s*[^;,]+=)/).map((part) => part.trim()) : [];

const authSessionCount = async () => Number(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM auth_session').first('count'));
const authUserCount = async () => Number(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM auth_user').first('count'));

const settleLateProviderResult = () => new Promise((resolve) => setTimeout(resolve, 0));

const latePublicKey = async () => {
  const keyPair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  return keyPair.publicKey;
};

const unsignedGoogleIdToken = () => [
  base64UrlJson({ alg: 'RS256', kid: 'test-kid' }),
  base64UrlJson({ iss: 'https://accounts.google.com', aud: 'google-client-id', sub: 'google-subject-1', email: 'provider@example.test', email_verified: true, name: 'Provider User', picture: 'https://example.test/avatar.png', nonce: 'nonce' }),
  'signature',
].join('.');

const base64UrlJson = (value: JsonObject) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
