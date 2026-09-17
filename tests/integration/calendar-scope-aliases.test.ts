/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_CALENDAR_FREEBUSY_SCOPE,
  GOOGLE_EMAIL_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  GOOGLE_OPENID_SCOPE,
  GOOGLE_PROFILE_SCOPE,
} from '../../src/core/calendar-contracts';
import { createAuthentication } from '../../src/server/auth';
import { beginCalendarOAuth, completeCalendarOAuth, getConnectedProvider } from '../../src/server/calendar/store';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const testEnv = env as TestEnv;
const origin = 'http://127.0.0.1:5174';
const secret = 'calendar-scope-alias-secret-more-than-32-characters';
const runtime = () => ({
  ...testEnv,
  APP_ENV: 'test',
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: secret,
  GOOGLE_CLIENT_ID: 'calendar-client',
  GOOGLE_CLIENT_SECRET: 'calendar-secret',
});

const GOOGLE_USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const GOOGLE_USERINFO_PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile';

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('Google Calendar scope aliases', () => {
  it('accepts canonical Google userinfo aliases for the requested email and profile identity scopes', async () => {
    const account = await identity('calendar-alias@example.test', 'google-alias-subject');
    const oauth = await beginCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId);
    const fetcher = providerFetch('google-alias-subject', [
      GOOGLE_OPENID_SCOPE,
      GOOGLE_USERINFO_EMAIL_SCOPE,
      GOOGLE_USERINFO_PROFILE_SCOPE,
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
      GOOGLE_CALENDAR_FREEBUSY_SCOPE,
    ]);

    await expect(completeCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId, stateFrom(oauth.url), 'calendar-code', fetcher))
      .resolves.toMatchObject({ status: 'calendar_missing' });

    const scopes = await storedScopes(account.userId);
    expect(scopes).toEqual([
      GOOGLE_OPENID_SCOPE,
      GOOGLE_EMAIL_SCOPE,
      GOOGLE_PROFILE_SCOPE,
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
      GOOGLE_CALENDAR_FREEBUSY_SCOPE,
    ]);
  });

  it('still rejects grants that omit an exact required Calendar scope', async () => {
    const account = await identity('calendar-missing@example.test', 'google-missing-subject');
    const oauth = await beginCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId);
    const fetcher = providerFetch('google-missing-subject', [
      GOOGLE_OPENID_SCOPE,
      GOOGLE_USERINFO_EMAIL_SCOPE,
      GOOGLE_USERINFO_PROFILE_SCOPE,
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
    ]);

    await expect(completeCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId, stateFrom(oauth.url), 'calendar-code', fetcher))
      .rejects.toMatchObject({ code: 'CALENDAR_SCOPE_MISSING' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM calendar_connections').first('COUNT(*)')).toBe(0);
  });

  it('does not treat identity aliases as an approved Gmail send grant', async () => {
    const account = await identity('calendar-gmail@example.test', 'google-gmail-subject');
    const initialOAuth = await beginCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId);
    await completeCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId, stateFrom(initialOAuth.url), 'calendar-code', providerFetch('google-gmail-subject', [
      GOOGLE_OPENID_SCOPE,
      GOOGLE_USERINFO_EMAIL_SCOPE,
      GOOGLE_USERINFO_PROFILE_SCOPE,
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
      GOOGLE_CALENDAR_FREEBUSY_SCOPE,
    ]));
    const emailOAuth = await beginCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId, { includeEmail: true });
    const fetcher = providerFetch('google-gmail-subject', [
      GOOGLE_OPENID_SCOPE,
      GOOGLE_USERINFO_EMAIL_SCOPE,
      GOOGLE_USERINFO_PROFILE_SCOPE,
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
      GOOGLE_CALENDAR_FREEBUSY_SCOPE,
    ]);

    await expect(completeCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId, stateFrom(emailOAuth.url), 'email-code', fetcher))
      .rejects.toMatchObject({ code: 'CALENDAR_SCOPE_MISSING' });
    expect(await storedScopes(account.userId)).not.toContain(GOOGLE_GMAIL_SEND_SCOPE);
  });

  it('normalizes canonical identity aliases consistently when an expired token refreshes', async () => {
    const account = await identity('calendar-refresh-alias@example.test', 'google-refresh-alias-subject');
    const oauth = await beginCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId);
    await completeCalendarOAuth(runtime(), testEnv.DB, account.userId, account.sessionId, stateFrom(oauth.url), 'calendar-code', providerFetch('google-refresh-alias-subject', [
      GOOGLE_OPENID_SCOPE,
      GOOGLE_USERINFO_EMAIL_SCOPE,
      GOOGLE_USERINFO_PROFILE_SCOPE,
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
      GOOGLE_CALENDAR_FREEBUSY_SCOPE,
    ]));
    await testEnv.DB.prepare('UPDATE calendar_connections SET access_token_expires_at = ? WHERE account_id = ?')
      .bind('2000-01-01T00:00:00.000Z', account.userId)
      .run();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      access_token: 'refreshed-calendar-access-token',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: [
        GOOGLE_OPENID_SCOPE,
        GOOGLE_USERINFO_EMAIL_SCOPE,
        GOOGLE_USERINFO_PROFILE_SCOPE,
        GOOGLE_CALENDAR_APP_CREATED_SCOPE,
        GOOGLE_CALENDAR_FREEBUSY_SCOPE,
      ].join(' '),
    }));

    await expect(getConnectedProvider(runtime(), account.userId, { fetcher, requireCalendar: false, db: testEnv.DB }))
      .resolves.toMatchObject({
        ok: true,
        value: {
          scopes: [
            GOOGLE_OPENID_SCOPE,
            GOOGLE_EMAIL_SCOPE,
            GOOGLE_PROFILE_SCOPE,
            GOOGLE_CALENDAR_APP_CREATED_SCOPE,
            GOOGLE_CALENDAR_FREEBUSY_SCOPE,
          ],
        },
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0]?.[1]?.body as URLSearchParams).get('grant_type')).toBe('refresh_token');
    expect(await storedScopes(account.userId)).toEqual([
      GOOGLE_OPENID_SCOPE,
      GOOGLE_EMAIL_SCOPE,
      GOOGLE_PROFILE_SCOPE,
      GOOGLE_CALENDAR_APP_CREATED_SCOPE,
      GOOGLE_CALENDAR_FREEBUSY_SCOPE,
    ]);
  });
});

async function identity(email: string, googleSubject: string) {
  const context = await createAuthentication(runtime())!.$context;
  const user = await context.internalAdapter.createUser({ name: email.split('@')[0], email, emailVerified: true }, { method: 'test' });
  await context.internalAdapter.createAccount({ userId: user.id, providerId: 'google', accountId: googleSubject, scope: 'openid email profile' });
  const session = await context.internalAdapter.createSession(user.id);
  return {
    userId: user.id,
    sessionId: session.id,
  };
}

function stateFrom(url: string): string {
  const state = new URL(url).searchParams.get('state');
  if (!state) throw new Error('Missing OAuth state');
  return state;
}

async function storedScopes(accountId: string): Promise<string[]> {
  const raw = await testEnv.DB.prepare('SELECT scopes_json FROM calendar_connections WHERE account_id = ?')
    .bind(accountId)
    .first<string>('scopes_json');
  return JSON.parse(String(raw)) as string[];
}

function providerFetch(subject: string, scopes: string[]): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({
        access_token: 'calendar-access-token',
        refresh_token: 'calendar-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: scopes.join(' '),
      });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return Response.json({ sub: subject, email: `${subject}@example.test`, email_verified: true });
    }
    throw new Error(`unexpected provider fetch ${url}`);
  }) as typeof fetch;
}
