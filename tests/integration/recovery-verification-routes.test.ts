/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import { createAuthentication } from '../../src/server/auth';
import { createApp } from '../../src/server/app';
import { processRecoveryAction } from '../../src/server/recovery/actions';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';
import { GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE, type CalendarEventRead, type CalendarProvider } from '../../src/core/calendar-contracts';
import type { RecoveryView } from '../../src/core/recovery-api-contracts';
import type { CalendarVerificationView } from '../../src/core/recovery-verification-contracts';
import type { AppBindings } from '../../src/server/http';

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const origin = 'http://127.0.0.1:5174';
const now = '2026-09-17T05:00:00.000Z';
beforeEach(async () => { vi.restoreAllMocks(); await reset(); await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });

async function fixture() {
  const bindings: AppBindings = { ...testEnv, APP_ENV: 'development', BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: 'verification-route-fixture-secret-more-than-32-chars', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' };
  const context = await createAuthentication(bindings)!.$context;
  const user = await context.internalAdapter.createUser({ name: 'Verification Fixture', email: 'verify@example.test', emailVerified: true }, { method: 'test' });
  const session = await context.internalAdapter.createSession(user.id);
  const cookie = `ieojim-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, bindings.BETTER_AUTH_SECRET!)}`)}`;
  const events = new Map<string, CalendarEventRead>();
  let beforeRead: (() => Promise<void>) | null = null;
  const provider: CalendarProvider = {
    freeBusy: vi.fn(async () => ({ ok: true as const, value: { blocks: [] } })),
    listBusyEvents: vi.fn(async () => ({ ok: true as const, value: { events: [] } })),
    getCalendar: vi.fn(async (id) => ({ ok: true as const, value: { id, summary: 'Test', description: null } })),
    getEvent: vi.fn(async (_calendarId, id) => {
      await beforeRead?.();
      const event = events.get(id);
      return event ? { ok: true as const, value: event } : { ok: false as const, error: { kind: 'not_found' as const, status: 404, message: 'missing' } };
    }),
    insertEvent: vi.fn(async (_calendarId, event) => { const saved = { ...event, etag: `etag-${event.id}` }; events.set(event.id, saved); return { ok: true as const, value: saved }; }),
    updateEvent: vi.fn(async () => { throw new Error('Unexpected write'); }),
    createAppCalendar: vi.fn(async () => { throw new Error('Unexpected create'); }),
    sendEmail: vi.fn(async () => { throw new Error('Unexpected mail'); }),
  };
  const scopes = [GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE];
  let currentTime = now;
  const deps = { now: () => currentTime, dispatch: vi.fn(async () => {}), getConnectedProvider: async () => ({ ok: true as const, value: { provider, connectionId: 'conn_routes', version: 1, calendarId: 'cal_routes', scopes } }) };
  const app = createApp({ recovery: deps });
  const post = (path: string, body: unknown, auth = cookie) => app.request(`${origin}${path}`, { method: 'POST', headers: { origin, cookie: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }, bindings);
  const created = await post('/api/recovery/workspaces', { input: createRecoveryExample(), requestId: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const initial = await created.json() as RecoveryView;
  const path = `/api/workspaces/${initial.workspaceId}/recovery`;
  const applied = await post(`${path}/apply`, { proposalId: initial.proposalId, baseRevision: initial.revision, conditionRevision: initial.conditionRevision, requestId: crypto.randomUUID() });
  expect(applied.status).toBe(200);
  const view = await applied.json() as RecoveryView;
  await testEnv.DB.prepare(`INSERT INTO calendar_connections(id,account_id,provider,provider_subject,status,auth_version,calendar_id,scopes_json,created_at,updated_at)
    VALUES('conn_routes',?,'google','subject_routes','connected',1,'cal_routes',?,?,?)`).bind(user.id, JSON.stringify(scopes), now, now).run();
  const queued = await post(`${path}/calendar`, { baseRevision: view.revision, conditionRevision: view.conditionRevision, requestId: crypto.randomUUID(), approved: true });
  expect(queued.status).toBe(202);
  const actionId = (await queued.json() as RecoveryView).actions[0]!.id;
  expect(await processRecoveryAction(bindings, actionId, deps)).toBe('verified');
  vi.mocked(provider.getEvent).mockClear();
  vi.mocked(provider.insertEvent).mockClear();
  return { app, bindings, context, session, cookie, post, path, actionId, view, provider, events,
    beforeRead: (callback: () => Promise<void>) => { beforeRead = callback; },
    advance: () => { currentTime = new Date(Date.parse(currentTime) + 61_000).toISOString(); },
    command: () => ({ actionId, baseRevision: view.revision, conditionRevision: view.conditionRevision, requestId: crypto.randomUUID() }) };
}

describe('authenticated Calendar verification routes', () => {
  it('completes approved execution, then reads back without issuing another write and exposes observation on reload', async () => {
    const f = await fixture();
    const response = await f.post(`${f.path}/verification`, f.command());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'matched', actionId: f.actionId });
    expect(f.provider.getEvent).toHaveBeenCalledTimes(4);
    expect(f.provider.insertEvent).not.toHaveBeenCalled();
    expect(f.provider.updateEvent).not.toHaveBeenCalled();
    expect(f.provider.sendEmail).not.toHaveBeenCalled();
    const loaded = await f.app.request(`${origin}${f.path}`, { headers: { cookie: f.cookie } }, f.bindings);
    expect((await loaded.json() as RecoveryView).actions[0]).toMatchObject({ status: 'verified', verification: { status: 'matched' } });
    expect(f.provider.getEvent).toHaveBeenCalledTimes(4);
  });

  it('requires consent and owner identity before any provider reads', async () => {
    const f = await fixture();
    expect((await f.post(`${f.path}/watch`, { ...f.command(), enabled: true })).status).toBe(422);
    expect((await f.post(`${f.path}/verification`, f.command(), '')).status).toBe(404);
    expect(f.provider.getEvent).not.toHaveBeenCalled();
    const other = await f.context.internalAdapter.createUser({ name: 'Other', email: 'other@example.test', emailVerified: true }, { method: 'test' });
    const session = await f.context.internalAdapter.createSession(other.id);
    const cookie = `ieojim-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, f.bindings.BETTER_AUTH_SECRET!)}`)}`;
    expect((await f.post(`${f.path}/verification`, f.command(), cookie)).status).toBe(404);
    expect(f.provider.getEvent).not.toHaveBeenCalled();
  });

  it('rejects session revocation during a read instead of publishing a matched result', async () => {
    const f = await fixture();
    f.beforeRead(async () => { await f.context.internalAdapter.deleteSession(f.session.token); });
    expect((await f.post(`${f.path}/verification`, f.command())).status).toBe(401);
    const row = await testEnv.DB.prepare('SELECT status FROM recovery_calendar_verifications WHERE action_id=?').bind(f.actionId).first<{ status: string }>();
    expect(row?.status).not.toBe('matched');
    expect(f.provider.insertEvent).not.toHaveBeenCalled();
  });

  it('keeps duplicate request receipts dated and detects later drift through a new explicit request', async () => {
    const f = await fixture();
    const command = f.command();
    const first = await f.post(`${f.path}/verification`, command);
    const original = await first.json() as CalendarVerificationView;
    const firstEvent = f.events.values().next().value!;
    firstEvent.summary = '외부에서 바꾼 제목';
    const replay = await f.post(`${f.path}/verification`, command);
    expect(await replay.json()).toEqual(original);
    expect(f.provider.getEvent).toHaveBeenCalledTimes(4);
    f.advance();
    const fresh = await f.post(`${f.path}/verification`, f.command());
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ status: 'drifted' });
  });
});
