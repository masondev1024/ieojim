import type { Hono } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { z } from 'zod';
import { claimGuestSchema, type AccountState } from '../core/account-contracts';
import { AccountStore } from './account-store';
import { readAccountUsage } from './account-usage';
import { authorizedDatabase } from './authorized-database';
import { authConfiguration, canonicalAuthHeaders, canonicalAuthRequest, createAuthentication, isAuthAvailableForRequest, resolveAccountSession, type VerifiedAccountSession } from './auth';
import { sha256Hex } from './crypto';
import { ApiException } from './errors';
import { admitPublicRequest, clearOwnerCookie, parseIntEnv, readJson, type AppBindings, type AppContext, type AppVariables } from './http';

const emptyBody = z.object({}).strict();

export function mountAccountRoutes(app: Hono<{ Bindings: AppBindings; Variables: AppVariables }>): void {
  // Only the provider callback is exposed. Social login bodies and redirect
  // destinations are constructed by our server; linking/password/admin routes
  // from the library are intentionally not part of the product API.
  app.get('/api/auth/callback/google', async (c) => {
    const auth = requireAuth(c);
    await admitPublicRequest(c, 'oauth-callback');
    const origin = authConfiguration(c.env)!.origin;
    const response = await auth.handler(canonicalAuthRequest(c.env, c.req.raw));
    // State failures cannot recover the per-login error URL. Normalize all
    // failures so provider details never appear in the product address bar.
    if (response.headers.get('location') === `${origin}/settings`) return response;
    copyCookies(c, response);
    return c.redirect(`${origin}/login?error=oauth`);
  });
  app.all('/api/auth/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'API 경로를 찾을 수 없습니다.' } }, 404));

  app.get('/api/account', async (c) => {
    const available = isAuthAvailableForRequest(c.env, c.req.url);
    const session = available ? await resolveAccountSession(c.env, c.req.raw) : null;
    const body: AccountState = {
      authAvailable: available, provider: 'google', user: session?.user ?? null,
      sessionExpiresAt: session?.expiresAt ?? null, guestPreview: null, retentionDays: 7,
    };
    if (session) body.guestPreview = await accountStore(c, session).previewGuest(session.user.id, await guestHash(c));
    else clearAccountCookies(c);
    return c.json(body);
  });

  app.post('/api/account/login', async (c) => {
    await readJson(c, emptyBody);
    const auth = requireAuth(c);
    const origin = authConfiguration(c.env)!.origin;
    const headers = canonicalAuthHeaders(c.env, c.req.raw);
    headers.delete('content-length');
    const request = new Request(`${origin}/api/auth/sign-in/social`, {
      method: 'POST', headers,
      body: JSON.stringify({ provider: 'google', callbackURL: `${origin}/settings`, errorCallbackURL: `${origin}/login?error=oauth`, disableRedirect: true }),
    });
    const response = await auth.handler(request);
    copyCookies(c, response);
    if (!response.ok) throw new ApiException('LOGIN_UNAVAILABLE', '로그인을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.', 503);
    const body = await response.json() as { url?: string };
    if (!body.url || new URL(body.url).origin !== 'https://accounts.google.com') throw new ApiException('LOGIN_UNAVAILABLE', '로그인 연결을 확인해 주세요.', 503);
    return c.json({ url: body.url });
  });

  app.get('/api/account/usage', async (c) => {
    const session = await requireSession(c);
    return c.json(await readAccountUsage(sessionDB(c, session), session.user.id, parseIntEnv(c.env.OWNER_DAILY_RUNS, 10)));
  });

  app.post('/api/account/logout', async (c) => {
    await readJson(c, emptyBody);
    const auth = requireAuth(c);
    const session = await resolveAccountSession(c.env, c.req.raw);
    // Better Auth signOut clears cookies even if a DB delete fails. Confirm
    // durable revocation first so the product never reports a false logout.
    if (session) await sessionDB(c, session).prepare('DELETE FROM auth_session WHERE id = ? AND "userId" = ?')
      .bind(session.sessionId, session.user.id).run();
    copyCookies(c, await auth.api.signOut({ headers: canonicalAuthHeaders(c.env, c.req.raw), asResponse: true }));
    clearAccountCookies(c);
    return c.body(null, 204);
  });

  app.post('/api/account/revoke-other-sessions', async (c) => {
    await readJson(c, emptyBody);
    const session = await requireSession(c);
    await sessionDB(c, session).prepare('DELETE FROM auth_session WHERE "userId" = ? AND id <> ?')
      .bind(session.user.id, session.sessionId).run();
    return c.json({ revoked: true });
  });

  app.post('/api/account/claim', async (c) => {
    const input = await readJson(c, claimGuestSchema);
    const session = await requireSession(c);
    const result = await accountStore(c, session).claimGuest(session.user.id, await guestHash(c), input);
    clearOwnerCookie(c);
    return c.json(result);
  });
}

const sessionDB = (c: AppContext, session: VerifiedAccountSession) => authorizedDatabase(c.env.DB, {
  kind: 'account', accountId: session.user.id, sessionId: session.sessionId,
});
const accountStore = (c: AppContext, session: VerifiedAccountSession) => new AccountStore(sessionDB(c, session));
const guestHash = async (c: AppContext): Promise<string | null> => {
  const token = getCookie(c, 'ieojim_owner');
  return token ? sha256Hex(token) : null;
};
const requireAuth = (c: AppContext) => {
  const auth = createAuthentication(c.env, c.req.url);
  if (!auth) throw new ApiException('AUTH_UNAVAILABLE', '로그인 연결을 준비하고 있습니다. 게스트로 먼저 이용할 수 있습니다.', 503);
  return auth;
};
const requireSession = async (c: AppContext) => {
  const session = await resolveAccountSession(c.env, c.req.raw);
  if (!session) throw new ApiException('LOGIN_REQUIRED', '로그인 후 이용할 수 있습니다.', 401);
  return session;
};
function copyCookies(c: AppContext, response: Response): void {
  for (const cookie of response.headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
}
function clearAccountCookies(c: AppContext): void {
  for (const prefix of ['ieojim-auth', '__Secure-ieojim-auth']) {
    for (const name of ['session_token', 'session_data']) deleteCookie(c, `${prefix}.${name}`, { path: '/', secure: prefix.startsWith('__Secure-'), httpOnly: true, sameSite: 'Lax' });
  }
}
