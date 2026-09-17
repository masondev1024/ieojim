import { ApiException } from './errors';

export type DatabaseAuthority =
  | { kind: 'guest'; ownerId: string; tokenHash: string; credentialVersion: number; candidate?: boolean }
  | { kind: 'account'; accountId: string; sessionId: string; ownerId?: string };

/**
 * Request-only authorization fence. Every statement shares one D1 transaction
 * with its credential check, closing claim/revocation races after middleware.
 * Internal Queue/cron stores deliberately use the original database instead.
 */
export function authorizedDatabase(database: D1Database, authority: DatabaseAuthority): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

  function assertion(): D1PreparedStatement {
    if (authority.kind === 'guest') {
      return database.prepare(`INSERT INTO authz_assertions (valid) SELECT 0 WHERE NOT (
        EXISTS (SELECT 1 FROM owners WHERE id = ? AND token_hash = ? AND credential_version = ? AND account_id IS NULL)
        OR (? = 1 AND NOT EXISTS (SELECT 1 FROM owners WHERE id = ?)))`)
        .bind(authority.ownerId, authority.tokenHash, authority.credentialVersion, authority.candidate ? 1 : 0, authority.ownerId);
    }
    return database.prepare(`INSERT INTO authz_assertions (valid) SELECT 0 WHERE NOT (
      EXISTS (SELECT 1 FROM auth_session s JOIN auth_user u ON u.id = s."userId"
        WHERE s.id = ? AND s."userId" = ? AND s."expiresAt" > ? AND u."emailVerified" = 1)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM owners WHERE id = ? AND account_id = ?)))`)
      .bind(authority.sessionId, authority.accountId, new Date().toISOString(), authority.ownerId ?? null, authority.ownerId ?? null, authority.accountId);
  }

  async function execute<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    try {
      const result = await database.batch<T>([assertion(), ...statements.map((statement) => originals.get(statement) ?? statement)]);
      return result.slice(1);
    } catch (error) {
      if (isAuthorizationFailure(error)) throw new ApiException('SESSION_CHANGED', '로그인 상태가 변경되었습니다. 화면을 다시 열어 주세요.', 401);
      throw error;
    }
  }

  function wrap(original: D1PreparedStatement): D1PreparedStatement {
    const statement = new Proxy(original, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === 'all' || key === 'run') return async () => (await execute([target]))[0];
        if (key === 'first') return async (column?: string) => {
          const first = (await execute<Record<string, unknown>>([target]))[0]?.results[0];
          if (!first) return null;
          if (column === undefined) return first;
          if (!(column in first)) throw new Error('Requested database column does not exist.');
          return first[column];
        };
        // This port supports the prepared methods used by WorkspaceStore and
        // AccountStore. Never silently bypass the fence through another method.
        if (key === 'raw') return () => { throw new Error('raw() is not supported by the authorized request database.'); };
        return Reflect.get(target, key, target);
      },
    });
    originals.set(statement, original);
    return statement;
  }

  return new Proxy(database, {
    get(target, key) {
      if (key === 'prepare') return (query: string) => wrap(target.prepare(query));
      if (key === 'batch') return execute;
      if (['exec', 'dump', 'withSession'].includes(String(key))) return () => { throw new Error('This operation is not supported by the authorized request database.'); };
      return Reflect.get(target, key, target);
    },
  });
}

function isAuthorizationFailure(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++, cause = cause.cause) {
    if (cause.message.includes('IEOJIM_AUTHORIZATION')) return true;
  }
  return false;
}
