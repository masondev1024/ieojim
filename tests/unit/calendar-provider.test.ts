import { describe, expect, it, vi } from 'vitest';
import { calendarEventWriteSchema, deterministicCalendarEventId, GOOGLE_CALENDAR_APP_CREATED_SCOPE } from '../../src/core/calendar-contracts';
import { createGoogleCalendarProvider } from '../../src/server/calendar/provider';
import { bootstrapCalendar } from '../../src/server/calendar/store';
import { encryptSecret } from '../../src/server/calendar/secrets';

const event = async () => ({
  id: await deterministicCalendarEventId('operation-1'),
  summary: '자료 준비',
  description: '승인된 준비 시간',
  start: { dateTime: '2026-09-17T15:30:00+09:00', timeZone: 'Asia/Seoul' as const },
  end: { dateTime: '2026-09-17T17:00:00+09:00', timeZone: 'Asia/Seoul' as const },
  extendedProperties: { private: { ieojimOperationId: 'operation-1', ieojimPayloadHash: 'a'.repeat(64) } },
});

const providerEvent = async (overrides: Record<string, unknown> = {}) => ({
  ...(await event()),
  etag: '"etag-1"',
  htmlLink: 'https://calendar.google.com/event',
  ...overrides,
});

describe('Google Calendar provider adapter', () => {
  it('uses deterministic app-owned event payloads and rejects attendees/reminders in writes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(await providerEvent()));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });

    const inserted = await provider.insertEvent('calendar-1', await event());

    expect(inserted).toMatchObject({ ok: true, value: { summary: '자료 준비', etag: '"etag-1"' } });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/calendar-1/events?sendUpdates=none');
    expect(init.headers).toMatchObject({ authorization: 'Bearer access-token' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      id: await deterministicCalendarEventId('operation-1'),
      extendedProperties: { private: { ieojimOperationId: 'operation-1' } },
    });
    const invalidEvent = { ...(await event()), attendees: [{ email: 'other@example.test' }] };
    expect(() => calendarEventWriteSchema.parse(invalidEvent)).toThrow();
  });

  it.each([
    [409, 'duplicate'],
    [412, 'stale'],
    [404, 'not_found'],
  ] as const)('maps provider status %s to an explicit %s result', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status }));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });

    await expect(provider.updateEvent('calendar-1', 'event-1', await event(), '"old"')).resolves.toMatchObject({
      ok: false,
      error: { kind, status },
    });
  });

  it('treats unknown transport outcome as non-retryable uncertainty', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('synthetic disconnect'));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });

    await expect(provider.getEvent('calendar-1', 'event-1')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unknown', status: null },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete or errored freeBusy responses', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ calendars: { 'calendar-a': { busy: [] } } }))
      .mockResolvedValueOnce(Response.json({ calendars: { 'calendar-a': { errors: [{ reason: 'notFound' }], busy: [] } } }));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });
    const input = {
      timeMin: '2026-09-17T09:00:00+09:00',
      timeMax: '2026-09-17T18:00:00+09:00',
      calendarIds: ['calendar-a', 'calendar-b'],
    };

    await expect(provider.freeBusy(input)).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_provider_response' } });
    await expect(provider.freeBusy({ ...input, calendarIds: ['calendar-a'] })).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_provider_response' } });
  });

  it('lists bounded concrete busy events and fails closed on paginated inventory', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        items: [
          { id: 'evt_busy', etag: '"busy"', status: 'confirmed', start: { dateTime: '2026-09-17T15:30:00+09:00' }, end: { dateTime: '2026-09-17T16:00:00+09:00' } },
          { id: 'evt_free', etag: '"free"', transparency: 'transparent', start: { dateTime: '2026-09-17T16:00:00+09:00' }, end: { dateTime: '2026-09-17T16:30:00+09:00' } },
          { id: 'evt_cancelled', etag: '"cancelled"', status: 'cancelled', start: { dateTime: '2026-09-17T16:30:00+09:00' }, end: { dateTime: '2026-09-17T17:00:00+09:00' } },
        ],
      }))
      .mockResolvedValueOnce(Response.json({ nextPageToken: 'more', items: [] }));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });

    await expect(provider.listBusyEvents('calendar-1', {
      timeMin: '2026-09-17T14:00:00+09:00',
      timeMax: '2026-09-17T18:00:00+09:00',
    })).resolves.toEqual({
      ok: true,
      value: { events: [{ id: 'evt_busy', etag: '"busy"', status: 'confirmed', start: '2026-09-17T15:30:00+09:00', end: '2026-09-17T16:00:00+09:00', transparent: false }] },
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/calendar/v3/calendars/calendar-1/events?');
    expect(url).toContain('singleEvents=true');
    expect(url).toContain('maxResults=250');
    expect(init.method).toBe('GET');

    await expect(provider.listBusyEvents('calendar-1', {
      timeMin: '2026-09-17T14:00:00+09:00',
      timeMax: '2026-09-17T18:00:00+09:00',
    })).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_provider_response' } });
  });

  it('fails closed when event inventory contains all-day or unordered events', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ items: [{ id: 'all_day', etag: '"all"', start: { date: '2026-09-17' }, end: { date: '2026-09-18' } }] }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: 'bad_order', etag: '"bad"', start: { dateTime: '2026-09-17T16:00:00+09:00' }, end: { dateTime: '2026-09-17T15:00:00+09:00' } }] }));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });
    const window = { timeMin: '2026-09-17T14:00:00+09:00', timeMax: '2026-09-17T18:00:00+09:00' };

    await expect(provider.listBusyEvents('calendar-1', window)).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_provider_response' } });
    await expect(provider.listBusyEvents('calendar-1', window)).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_provider_response' } });
  });

  it('rejects freeBusy and event timestamps without valid offsets or start-before-end ordering', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ calendars: { 'calendar-a': { busy: [{ start: '2026-09-17T10:00:00+09:00', end: '2026-09-17T09:00:00+09:00' }] } } }))
      .mockResolvedValueOnce(Response.json(await providerEvent({ start: { dateTime: '2026-09-17T15:30:00', timeZone: 'Asia/Seoul' } })));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });

    await expect(provider.freeBusy({
      timeMin: '2026-09-17T09:00:00+09:00',
      timeMax: '2026-09-17T18:00:00+09:00',
      calendarIds: ['calendar-a'],
    })).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_provider_response' } });
    await expect(provider.getEvent('calendar-a', 'event-a')).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_provider_response' } });
  });

  it('requires bootstrap calendar creation response to preserve the app marker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      id: 'ieojim-calendar-id',
      summary: 'Ieojim',
      description: 'different-marker',
    }));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });

    await expect(provider.createAppCalendar('Ieojim', 'ieojim:connection:cal_conn_123')).resolves.toEqual({
      ok: true,
      value: { id: 'ieojim-calendar-id', summary: 'Ieojim', description: 'different-marker' },
    });
  });

  it('flags provider events with attendees or reminders as conflicts', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(await providerEvent({ attendees: [{ email: 'person@example.test' }] })));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });

    await expect(provider.getEvent('calendar-1', 'event-1')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
    });
  });

  it('reads calendar metadata for manual adoption without event writes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      id: 'ieojim-calendar-id',
      summary: 'Ieojim',
      description: 'ieojim:connection:cal_conn_123',
    }));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });

    await expect(provider.getCalendar('ieojim-calendar-id')).resolves.toEqual({
      ok: true,
      value: { id: 'ieojim-calendar-id', summary: 'Ieojim', description: 'ieojim:connection:cal_conn_123' },
    });
    expect(fetcher).toHaveBeenCalledWith('https://www.googleapis.com/calendar/v3/calendars/ieojim-calendar-id', expect.objectContaining({ method: 'GET' }));
  });

  it('keeps Gmail sending behind the separate sensitive scope', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: [], fetcher });

    await expect(provider.sendEmail({ to: 'a@example.test', subject: '변경 안내', body: '본문', operationId: 'mail-1' })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'forbidden', status: 403 },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends Korean Gmail content as MIME and requires provider message id', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'gmail-message-1' }))
      .mockResolvedValueOnce(Response.json({}));
    const provider = createGoogleCalendarProvider({ accessToken: 'access-token', scopes: ['https://www.googleapis.com/auth/gmail.send'], fetcher });

    await expect(provider.sendEmail({ to: 'a@example.test', subject: '금요일 발표 변경', body: '본문입니다.', operationId: 'mail-1' })).resolves.toMatchObject({
      ok: true,
      value: { providerMessageId: 'gmail-message-1' },
    });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const raw = JSON.parse(String(init.body)).raw as string;
    const decoded = Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
    expect(decoded).toContain('MIME-Version: 1.0');
    expect(decoded).toContain('Subject: =?UTF-8?B?');
    expect(decoded).toContain('Content-Transfer-Encoding: base64');
    expect(Buffer.from(decoded.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString('utf8')).toBe('본문입니다.');

    await expect(provider.sendEmail({ to: 'a@example.test', subject: '금요일 발표 변경', body: '본문입니다.', operationId: 'mail-2' })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid_provider_response' },
    });
  });
});

describe('Calendar bootstrap guardrails', () => {
  it('does not recreate when a local pending bootstrap operation already exists', async () => {
    const secret = 'unit-calendar-secret-more-than-32-characters';
    const db = await fakeBootstrapDb({ secret, pendingStatus: 'pending' });
    const fetcher = vi.fn<typeof fetch>();

    await expect(bootstrapCalendar(env(secret), db, 'account-1', fetcher)).rejects.toMatchObject({ code: 'CALENDAR_UNKNOWN' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.updates).toContain('bootstrap_uncertain');
  });

  it('rejects a successful calendar create response that does not echo the app marker', async () => {
    const secret = 'unit-calendar-secret-more-than-32-characters';
    const db = await fakeBootstrapDb({ secret });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      id: 'ieojim-calendar-id',
      summary: 'Ieojim',
      description: 'wrong-marker',
    }));

    await expect(bootstrapCalendar(env(secret), db, 'account-1', fetcher)).rejects.toMatchObject({ code: 'CALENDAR_INVALID_PROVIDER_RESPONSE' });
    expect(db.updates).toContain('bootstrap_uncertain');
    expect(db.updates).not.toContain('bootstrap_failed');
  });
});

type FakeBootstrapDb = D1Database & { updates: string[] };

async function fakeBootstrapDb(options: { secret: string; pendingStatus?: 'pending' | 'uncertain' }): Promise<FakeBootstrapDb> {
  const row = {
    id: 'cal_conn_123',
    account_id: 'account-1',
    provider: 'google',
    provider_subject: 'google-subject',
    provider_email: 'calendar@example.test',
    status: 'connected',
    auth_version: 1,
    calendar_id: null,
    calendar_summary: null,
    scopes_json: JSON.stringify([GOOGLE_CALENDAR_APP_CREATED_SCOPE]),
    encrypted_access_token: await encryptSecret('access-token', options.secret, 'calendar:access:account-1:cal_conn_123:1'),
    encrypted_refresh_token: null,
    access_token_expires_at: '2999-01-01T00:00:00.000Z',
    updated_at: '2026-09-15T00:00:00.000Z',
  };
  const updates: string[] = [];
  const db = {
    updates,
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async first() {
          if (sql.includes('FROM calendar_connections')) return row;
          if (sql.includes('FROM calendar_bootstrap_ops') && sql.includes("status IN ('pending', 'uncertain')")) {
            return options.pendingStatus ? { status: options.pendingStatus } : null;
          }
          return null;
        },
        async run() {
          if (/SET status = ['"]bootstrap_uncertain['"]/.test(sql)) updates.push('bootstrap_uncertain');
          if (sql.includes('INSERT INTO calendar_bootstrap_ops')) updates.push('bootstrap_pending');
          if (sql.includes('SET status = "failed"')) updates.push('bootstrap_failed');
          void values;
          return { meta: { changes: 1, duration: 0, size_after: 0, rows_read: 0, rows_written: 1, last_row_id: 0, changed_db: true }, results: [], success: true } as D1Result;
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db as unknown as FakeBootstrapDb;
}

function env(secret: string) {
  return {
    DB: {} as D1Database,
    APP_ENV: 'test',
    BETTER_AUTH_URL: 'http://127.0.0.1:5174',
    BETTER_AUTH_SECRET: secret,
    GOOGLE_CLIENT_ID: 'calendar-client',
    GOOGLE_CLIENT_SECRET: 'calendar-secret',
  };
}
