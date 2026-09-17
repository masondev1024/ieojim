import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { AuthenticatedAccount } from '../core/account-contracts';
import { ApiException } from './errors';
import { authProviderBudget } from './auth-provider-budget';

export type AuthBindings = {
  DB: D1Database;
  APP_ENV: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};
export type VerifiedAccountSession = {
  user: AuthenticatedAccount;
  sessionId: string;
  expiresAt: string;
};

type AuthConfiguration = { origin: string; secret: string; clientId: string; clientSecret: string };

export function authConfiguration(env: AuthBindings): AuthConfiguration | null {
  const { BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = env;
  if (!baseURL || !secret || !clientId || !clientSecret) return null;
  let url: URL;
  try { url = new URL(baseURL); } catch { throw invalidConfiguration(); }
  const local = ['development', 'test'].includes(env.APP_ENV) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || secret.length < 32 ||
      (!local && url.protocol !== 'https:') || (local && !['https:', 'http:'].includes(url.protocol))) throw invalidConfiguration();
  return { origin: url.origin, secret, clientId, clientSecret };
}

// Pinned library owns OAuth state, PKCE, provider identity validation and signed
// cookies. Application ownership and usage ledgers remain a separate boundary.
export function authOptions(env: AuthBindings): BetterAuthOptions | null {
  const config = authConfiguration(env);
  if (!config) return null;
  return {
    appName: '이어짐',
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.secret,
    database: env.DB,
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        disableDefaultScope: true,
        scope: ['openid', 'email', 'profile'],
        includeGrantedScopes: false,
        prompt: 'select_account',
      },
    },
    user: { modelName: 'auth_user', deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    session: {
      modelName: 'auth_session',
      expiresIn: 7 * 24 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: 'auth_account',
      encryptOAuthTokens: true,
      accountLinking: { enabled: false, disableImplicitLinking: true },
      storeStateStrategy: 'database',
      skipStateCookieCheck: false,
      storeAccountCookie: false,
    },
    verification: { modelName: 'auth_verification' },
    advanced: {
      cookiePrefix: 'ieojim-auth',
      useSecureCookies: config.origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      trustedProxyHeaders: false,
    },
    onAPIError: { errorURL: `${config.origin}/login` },
    plugins: [authProviderBudget()],
    telemetry: { enabled: false },
    // Never forward library messages/arguments: they can contain OAuth payloads.
    logger: { level: 'warn', log: (level) => console.warn(JSON.stringify({ event: 'authentication_library', level })) },
  };
}

export function createAuthentication(env: AuthBindings, requestUrl?: string) {
  const options = authOptions(env);
  if (!options) return null;
  if (requestUrl && !isCanonicalAuthOrigin(env, new URL(requestUrl).origin, String(options.baseURL))) throw invalidConfiguration();
  return betterAuth(options);
}

function isCanonicalAuthOrigin(env: AuthBindings, incoming: string, configured: string): boolean {
  if (incoming === configured) return true;
  if (!['development', 'test'].includes(env.APP_ENV)) return false;
  // Vite's existing same-origin proxy rewrites only the exact browser Origin.
  // Recognize the two repo-owned loopback pairs; never trust forwarded headers.
  return (configured === 'http://127.0.0.1:5173' && incoming === 'http://127.0.0.1:8787') ||
    (configured === 'http://127.0.0.1:5174' && incoming === 'http://127.0.0.1:8788');
}

export function isAuthAvailableForRequest(env: AuthBindings, requestUrl: string): boolean {
  const config = authConfiguration(env);
  return config ? isCanonicalAuthOrigin(env, new URL(requestUrl).origin, config.origin) : false;
}

export function canonicalAuthHeaders(env: AuthBindings, request: Request): Headers {
  const config = authConfiguration(env);
  const incoming = new URL(request.url);
  if (!config || !isCanonicalAuthOrigin(env, incoming.origin, config.origin)) throw invalidConfiguration();
  const headers = new Headers(request.headers);
  if (headers.get('origin') === incoming.origin) headers.set('origin', config.origin);
  headers.delete('content-length');
  return headers;
}

export function canonicalAuthRequest(env: AuthBindings, request: Request): Request {
  const headers = canonicalAuthHeaders(env, request);
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, authConfiguration(env)!.origin);
  return new Request(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: request.redirect });
}

export function hasAccountCookie(headers: Headers): boolean {
  return /(?:^|;\s*)(?:__Secure-)?ieojim-auth\.session_token=/.test(headers.get('cookie') ?? '');
}

export async function resolveAccountSession(env: AuthBindings, request: Request): Promise<VerifiedAccountSession | null> {
  if (!hasAccountCookie(request.headers)) return null;
  const auth = createAuthentication(env, request.url);
  if (!auth) throw new ApiException('AUTH_UNAVAILABLE', '현재 로그인을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', 503);
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result) return null;
  if (!result.user.emailVerified) throw new ApiException('ACCOUNT_NOT_VERIFIED', 'Google 계정 인증을 다시 확인해 주세요.', 403);
  return {
    user: { id: result.user.id, name: result.user.name, email: result.user.email },
    sessionId: result.session.id,
    expiresAt: result.session.expiresAt.toISOString(),
  };
}

const invalidConfiguration = () => new ApiException('INVALID_AUTH_CONFIG', '로그인 연결을 확인해야 합니다. 잠시 후 다시 시도해 주세요.', 503);
