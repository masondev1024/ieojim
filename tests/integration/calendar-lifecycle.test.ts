/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE, GOOGLE_EMAIL_SCOPE, GOOGLE_OPENID_SCOPE, GOOGLE_PROFILE_SCOPE } from '../../src/core/calendar-contracts';
import { adoptUncertainCalendar, bootstrapCalendar, cleanCalendarOAuthStates, disconnectCalendar, getConnectedProvider } from '../../src/server/calendar/store';
import { encryptSecret } from '../../src/server/calendar/secrets';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const testEnv = env as TestEnv;
const secret = 'calendar-lifecycle-secret-more-than-32-characters';
const runtime = () => ({
  ...testEnv,
  APP_ENV: 'test',
  BETTER_AUTH_URL: 'http://127.0.0.1:5174',
  BETTER_AUTH_SECRET: secret,
  GOOGLE_CLIENT_ID: 'calendar-client',
  GOOGLE_CLIENT_SECRET: 'calendar-secret',
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('Calendar connection lifecycle failure modes', () => {
  it('cleans expired OAuth secrets without deleting an active handshake', async () => {
    const connection = await seedConnection({ accountId: 'account-oauth-cleanup' });
    await testEnv.DB.batch(['2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'].map((expiry, index) =>
      testEnv.DB.prepare(`INSERT INTO calendar_oauth_states(state_hash,account_id,session_id,code_verifier_ciphertext,scopes_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?)`).bind(`state-${index}`, connection.accountId, 'session', 'encrypted-verifier', '[]', '2000-01-01T00:00:00.000Z', expiry)));
    expect(await cleanCalendarOAuthStates(testEnv.DB)).toBe(1);
    expect(await testEnv.DB.prepare('SELECT state_hash FROM calendar_oauth_states').first('state_hash')).toBe('state-1');
  });

  it('uses the refreshed scope set immediately instead of retaining an old grant', async () => {
    const connection = await seedConnection({ accountId: 'account-refresh-scopes', expiresAt: '2000-01-01T00:00:00.000Z' });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ access_token: 'refreshed', expires_in: 3600, scope: GOOGLE_CALENDAR_APP_CREATED_SCOPE }));
    const result = await getConnectedProvider(runtime(), connection.accountId, { fetcher, db: testEnv.DB });
    expect(result).toMatchObject({ ok: true, value: { scopes: [GOOGLE_CALENDAR_APP_CREATED_SCOPE] } });
    expect(await testEnv.DB.prepare('SELECT scopes_json FROM calendar_connections WHERE account_id=?').bind(connection.accountId).first('scopes_json')).toBe(JSON.stringify([GOOGLE_CALENDAR_APP_CREATED_SCOPE]));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes an expired token twice using the stable connection version AAD', async () => {
    const connection = await seedConnection({ accountId: 'account-refresh-twice', expiresAt: '2000-01-01T00:00:00.000Z' });
    const tokenCalls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        tokenCalls.push(String((init?.body as URLSearchParams).get('refresh_token')));
        const count = tokenCalls.length;
        return Response.json({
          access_token: `access-${count}`,
          refresh_token: `refresh-${count}`,
          expires_in: 3600,
          token_type: 'Bearer',
          scope: connection.scopes.join(' '),
        });
      }
      if (url === 'https://www.googleapis.com/calendar/v3/calendars/app-calendar') {
        return Response.json({ id: 'app-calendar', summary: 'Ieojim', description: 'marker' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await expect(getConnectedProvider(runtime(), connection.accountId, { fetcher, db: testEnv.DB })).resolves.toMatchObject({ ok: true });
    await expireConnection(connection.accountId);
    const refreshedAgain = await getConnectedProvider(runtime(), connection.accountId, { fetcher, db: testEnv.DB });
    expect(refreshedAgain).toMatchObject({ ok: true });
    if (!refreshedAgain.ok) throw new Error(refreshedAgain.error.message);
    await refreshedAgain.value.provider.getCalendar('app-calendar');

    expect(tokenCalls).toEqual(['refresh-0', 'refresh-1']);
    const row = await connectionRow(connection.accountId);
    expect(row).toMatchObject({ status: 'connected', auth_version: 1 });
    const calendarCall = fetcher.mock.calls.find(([input]) => String(input).includes('/calendars/app-calendar'));
    expect(calendarCall?.[1]?.headers).toMatchObject({ authorization: 'Bearer access-2' });
  });

  it('does not resurrect a disconnected connection when a refresh finishes late', async () => {
    const connection = await seedConnection({ accountId: 'account-refresh-disconnect', expiresAt: '2000-01-01T00:00:00.000Z' });
    const deferred: { release?: (response: Response) => void } = {};
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => {
      deferred.release = resolve;
    }));

    const pending = getConnectedProvider(runtime(), connection.accountId, { fetcher, db: testEnv.DB });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await disconnectCalendar(runtime(), testEnv.DB, connection.accountId);
    deferred.release?.(Response.json({
      access_token: 'late-access',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: connection.scopes.join(' '),
    }));

    await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: 'reauth_required' } });
    expect(await connectionRow(connection.accountId)).toMatchObject({ status: 'disconnected', auth_version: 2, encrypted_access_token: null });
  });

  it('creates at most one app calendar when bootstrap requests race', async () => {
    const connection = await seedConnection({ accountId: 'account-bootstrap-race', calendarId: null });
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { description: string };
      return Response.json({ id: 'race-calendar', summary: 'Ieojim', description: payload.description });
    });

    const results = await Promise.allSettled([
      bootstrapCalendar(runtime(), testEnv.DB, connection.accountId, fetcher),
      bootstrapCalendar(runtime(), testEnv.DB, connection.accountId, fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM calendar_bootstrap_ops').first('COUNT(*)')).toBe(1);
    expect(await connectionRow(connection.accountId)).toMatchObject({ status: 'connected', calendar_id: 'race-calendar' });
  });

  it('blocks automatic bootstrap and allows manual adoption after provider success but local commit conflict', async () => {
    const connection = await seedConnection({ accountId: 'account-bootstrap-lost-commit', calendarId: null });
    let marker = '';
    const raceDb = dbWithCommitRace(testEnv.DB, () => rotateConnectionVersion(connection.accountId, 2));
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === 'https://www.googleapis.com/calendar/v3/calendars' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { description: string };
        marker = payload.description;
        return Response.json({ id: 'lost-calendar', summary: 'Ieojim', description: marker });
      }
      if (url === 'https://www.googleapis.com/calendar/v3/calendars/lost-calendar') {
        return Response.json({ id: 'lost-calendar', summary: 'Ieojim', description: marker });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await expect(bootstrapCalendar(runtime(), raceDb, connection.accountId, fetcher)).rejects.toMatchObject({ code: 'CALENDAR_CONNECTION_CHANGED' });
    await expect(bootstrapCalendar(runtime(), testEnv.DB, connection.accountId, fetcher)).rejects.toMatchObject({ code: 'CALENDAR_UNKNOWN' });
    await expect(adoptUncertainCalendar(runtime(), testEnv.DB, connection.accountId, 'lost-calendar', fetcher)).resolves.toMatchObject({
      status: 'connected',
      calendarId: 'lost-calendar',
    });
    expect(await connectionRow(connection.accountId)).toMatchObject({ status: 'connected', calendar_id: 'lost-calendar', auth_version: 3 });
  });

  it('does not expose another account connection through provider lookup', async () => {
    const first = await seedConnection({ accountId: 'account-isolation-a', connectionId: 'cal_conn_a', calendarId: 'calendar-a' });
    await seedAppAccount('account-isolation-b');
    const fetcher = vi.fn<typeof fetch>();

    await expect(getConnectedProvider(runtime(), first.accountId, { fetcher, db: testEnv.DB })).resolves.toMatchObject({ ok: true });
    await expect(getConnectedProvider(runtime(), 'account-isolation-b', { fetcher, db: testEnv.DB })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'not_connected' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

async function seedConnection(options: {
  accountId: string;
  connectionId?: string;
  calendarId?: string | null;
  expiresAt?: string | null;
}) {
  const connectionId = options.connectionId ?? 'cal_conn_lifecycle';
  const accountId = options.accountId;
  const scopes = [
    GOOGLE_OPENID_SCOPE,
    GOOGLE_EMAIL_SCOPE,
    GOOGLE_PROFILE_SCOPE,
    GOOGLE_CALENDAR_APP_CREATED_SCOPE,
    GOOGLE_CALENDAR_FREEBUSY_SCOPE,
  ];
  await seedAppAccount(accountId);
  await testEnv.DB.prepare(`INSERT INTO calendar_connections(
    id, account_id, provider, provider_subject, provider_email, status, auth_version, calendar_id, calendar_summary,
    scopes_json, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, created_at, updated_at
  ) VALUES (?, ?, 'google', ?, ?, 'connected', 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      connectionId,
      accountId,
      `subject-${accountId}`,
      `${accountId}@example.test`,
      options.calendarId === undefined ? 'app-calendar' : options.calendarId,
      options.calendarId === null ? null : 'Ieojim',
      JSON.stringify(scopes),
      await encryptSecret('access-0', secret, tokenAad(accountId, connectionId, 1, 'access')),
      await encryptSecret('refresh-0', secret, tokenAad(accountId, connectionId, 1, 'refresh')),
      options.expiresAt ?? '2999-01-01T00:00:00.000Z',
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  return { accountId, connectionId, scopes };
}

async function seedAppAccount(accountId: string) {
  await testEnv.DB.prepare('INSERT INTO app_accounts(id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(accountId, new Date().toISOString())
    .run();
}

async function expireConnection(accountId: string) {
  await testEnv.DB.prepare('UPDATE calendar_connections SET access_token_expires_at = ? WHERE account_id = ?')
    .bind('2000-01-01T00:00:00.000Z', accountId)
    .run();
}

async function rotateConnectionVersion(accountId: string, version: number) {
  const row = await connectionRow(accountId);
  if (!row) throw new Error(`Missing connection for ${accountId}`);
  await testEnv.DB.prepare(`UPDATE calendar_connections SET auth_version = ?, encrypted_access_token = ?, encrypted_refresh_token = ?, updated_at = ?
    WHERE account_id = ?`)
    .bind(
      version,
      await encryptSecret(`access-v${version}`, secret, tokenAad(accountId, row.id, version, 'access')),
      await encryptSecret(`refresh-v${version}`, secret, tokenAad(accountId, row.id, version, 'refresh')),
      new Date().toISOString(),
      accountId,
    )
    .run();
}

async function connectionRow(accountId: string) {
  return testEnv.DB.prepare(`SELECT id, status, auth_version, calendar_id, encrypted_access_token
    FROM calendar_connections WHERE account_id = ?`)
    .bind(accountId)
    .first<{ id: string; status: string; auth_version: number; calendar_id: string | null; encrypted_access_token: string | null }>();
}

function tokenAad(accountId: string, connectionId: string, version: number, kind: 'access' | 'refresh'): string {
  return `calendar:${kind}:${accountId}:${connectionId}:${version}`;
}

async function waitFor(assertion: () => void | Promise<void>) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 1000) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function dbWithCommitRace(db: D1Database, beforeFirstBatch: () => Promise<void>): D1Database {
  let raced = false;
  return {
    prepare: db.prepare.bind(db),
    dump: db.dump?.bind(db),
    exec: db.exec?.bind(db),
    async batch(statements) {
      if (!raced) {
        raced = true;
        await beforeFirstBatch();
      }
      return db.batch(statements);
    },
  } as D1Database;
}
