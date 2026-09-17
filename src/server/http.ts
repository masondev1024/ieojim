import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { LIMITS } from '../core/contracts';
import { ApiException, toApiException } from './errors';
import { randomId, randomToken, sha256Hex } from './crypto';
import { AccountStore } from './account-store';
import { authorizedDatabase } from './authorized-database';
import { hasAccountCookie, resolveAccountSession, type AuthBindings, type VerifiedAccountSession } from './auth';

const OWNER_COOKIE = 'ieojim_owner';
const MAX_JSON_BYTES = 128 * 1024;

export type AppBindings = Cloudflare.Env & AuthBindings & {
  PUBLIC_WRITES?: { limit(options: { key: string }): Promise<{ success: boolean }> };
};
export type AppVariables = { owner: OwnerSession; accountSession: VerifiedAccountSession | null; requestDB: D1Database };
export type AppContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;

export type OwnerSession = { id: string; token: string; hash: string; isNew: boolean; credentialVersion?: number };

type OwnerRow = { id: string; token_hash: string; credential_version: number };

export const nowIso = (): string => new Date().toISOString();
export const expiresFrom = (now: string): string => new Date(Date.parse(now) + LIMITS.retentionMs).toISOString();

export const parseIntEnv = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiException('INVALID_SERVER_CONFIG', '서비스 사용 한도 설정을 확인해야 합니다.', 503);
  }
  return parsed;
};

export const readJson = async <T>(c: AppContext, schema: z.ZodType<T>): Promise<T> => {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiException('UNSUPPORTED_MEDIA_TYPE', 'Content-Type은 application/json이어야 합니다.', 415);
  }

  const body = await readLimitedBody(c.req.raw, MAX_JSON_BYTES);
  return schema.parse(JSON.parse(body));
};

export const protectUnsafeRequest: MiddlewareHandler<{ Bindings: AppBindings; Variables: AppVariables }> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    await next();
    return;
  }
  const origin = c.req.header('origin');
  if (origin !== new URL(c.req.url).origin) {
    throw new ApiException('CSRF_BLOCKED', '동일 출처 요청만 허용됩니다.', 403);
  }
  await admitPublicRequest(c);
  await next();
};

// OAuth callbacks are GET requests but consume provider/DB work too. They use
// the same fail-closed admission policy without imposing a browser Origin.
export async function admitPublicRequest(c: AppContext, lane = 'writes'): Promise<void> {
  const localEnvironment = ['development', 'test'].includes(c.env.APP_ENV) &&
    (isLocalhost(c.req.url) || new URL(c.req.url).hostname.endsWith('.test'));
  if (!localEnvironment) {
    if (!['staging', 'production'].includes(c.env.APP_ENV)) {
      throw new ApiException('INVALID_SERVER_CONFIG', '서비스 실행 환경 설정을 확인해야 합니다.', 503);
    }
    const limiter = c.env.PUBLIC_WRITES;
    const ip = c.req.header('cf-connecting-ip');
    if (!limiter || !ip) throw new ApiException('ADMISSION_UNAVAILABLE', '현재 새 요청을 처리할 수 없습니다. 잠시 후 다시 시도하세요.', 503);
    let success: boolean;
    try { ({ success } = await limiter.limit({ key: `${lane}:${await sha256Hex(ip)}` })); }
    catch { throw new ApiException('ADMISSION_UNAVAILABLE', '현재 새 요청을 처리할 수 없습니다. 잠시 후 다시 시도하세요.', 503); }
    if (!success) {
      c.header('Retry-After', '60');
      throw new ApiException('REQUEST_RATE_LIMIT', '요청이 많습니다. 잠시 후 다시 시도하세요.', 429);
    }
  }
}

export const ownerMiddleware: MiddlewareHandler<{ Bindings: AppBindings; Variables: AppVariables }> = async (c, next) => {
  // Public configuration is independent of anonymous identity, including HEAD.
  if (c.req.path === '/api/config') { await next(); return; }
  const session = await resolveAccountSession(c.env, c.req.raw);
  c.set('accountSession', session);
  if (session) {
    const accountDB = authorizedDatabase(c.env.DB, { kind: 'account', accountId: session.user.id, sessionId: session.sessionId });
    const primary = await new AccountStore(accountDB).ensureAccount(session.user.id);
    const ownerId = primary.ownerId;
    c.set('owner', { id: ownerId, token: '', hash: '', isNew: false });
    c.set('requestDB', authorizedDatabase(c.env.DB, { kind: 'account', accountId: session.user.id, sessionId: session.sessionId, ownerId }));
    await next();
    return;
  }
  // An expired/revoked account session cannot silently execute as a guest.
  if (hasAccountCookie(c.req.raw.headers)) throw new ApiException('SESSION_EXPIRED', '로그인이 만료되었습니다. 다시 로그인해 주세요.', 401);
  const incoming = getCookie(c, OWNER_COOKIE);
  const now = nowIso();
  let owner: OwnerSession | null = null;

  if (incoming) {
    const hash = await sha256Hex(incoming);
    const row = await c.env.DB.prepare('SELECT id, token_hash, credential_version FROM owners WHERE token_hash = ? AND account_id IS NULL').bind(hash).first<OwnerRow>();
    if (!row) clearOwnerCookie(c);
    if (row) {
      owner = { id: row.id, token: incoming, hash: row.token_hash, isNew: false, credentialVersion: row.credential_version };
      const before = new Date(Date.parse(now) - 60 * 60 * 1000).toISOString();
      await c.env.DB.prepare('UPDATE owners SET last_seen_at = ? WHERE id = ? AND last_seen_at < ? AND token_hash = ? AND credential_version = ? AND account_id IS NULL').bind(now, row.id, before, hash, row.credential_version).run();
    }
  }

  if (!owner) {
    if (['GET', 'HEAD'].includes(c.req.method) && c.req.path === '/api/workspaces') return c.json([]);
    const createsWorkspace = c.req.method === 'POST' && ['/api/workspaces', '/api/workspaces/sample', '/api/recovery/workspaces'].includes(c.req.path);
    if (!createsWorkspace) throw new ApiException('WORKSPACE_NOT_FOUND', '작업 공간을 찾을 수 없습니다.', 404);
    const token = randomToken();
    const hash = await sha256Hex(token);
    const id = randomId('own');
    // The store persists this candidate in the same transaction as creation.
    owner = { id, token, hash, isNew: true };
  }

  c.set('owner', owner);
  c.set('requestDB', authorizedDatabase(c.env.DB, {
    kind: 'guest', ownerId: owner.id, tokenHash: owner.hash, credentialVersion: owner.credentialVersion ?? 0, candidate: owner.isNew,
  }));
  await next();
  if (owner.isNew && c.res.status >= 400) return;
  setCookie(c, OWNER_COOKIE, owner.token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: !isLocalhost(c.req.url),
    path: '/',
    maxAge: Math.floor(LIMITS.retentionMs / 1000),
  });
};

// Registered on concrete workspace routes so :id belongs to this match.
export const workspaceOwnerMiddleware: MiddlewareHandler<{ Bindings: AppBindings; Variables: AppVariables }> = async (c, next) => {
  const session = c.var.accountSession;
  if (!session) { await next(); return; }
  const db = authorizedDatabase(c.env.DB, { kind: 'account', accountId: session.user.id, sessionId: session.sessionId });
  const row = await db.prepare(`SELECT w.owner_id FROM workspaces w JOIN owners o ON o.id = w.owner_id
    WHERE w.id = ? AND o.account_id = ? AND w.deleted_at IS NULL AND w.expires_at > ?`)
    .bind(c.req.param('id'), session.user.id, nowIso()).first<{ owner_id: string }>();
  if (!row) throw new ApiException('WORKSPACE_NOT_FOUND', '작업 공간을 찾을 수 없습니다.', 404);
  c.set('owner', { id: row.owner_id, token: '', hash: '', isNew: false });
  c.set('requestDB', authorizedDatabase(c.env.DB, { kind: 'account', accountId: session.user.id, sessionId: session.sessionId, ownerId: row.owner_id }));
  await next();
};

export const clearOwnerCookie = (c: AppContext): void => {
  deleteCookie(c, OWNER_COOKIE, { path: '/' });
};

export const errorJson = (error: unknown) => {
  const apiError = toApiException(error);
  return { body: { error: { code: apiError.code, message: apiError.message } }, status: apiError.status as 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503 };
};

const readLimitedBody = async (request: Request, maxBytes: number): Promise<string> => {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new ApiException('BODY_TOO_LARGE', '요청 본문이 허용 크기를 초과했습니다.', 413);
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiException('BODY_TOO_LARGE', '요청 본문이 허용 크기를 초과했습니다.', 413);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

const isLocalhost = (url: string): boolean => {
  const hostname = new URL(url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
};
