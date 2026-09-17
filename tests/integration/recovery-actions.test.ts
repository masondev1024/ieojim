/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import { createAuthentication } from '../../src/server/auth';
import { createApp } from '../../src/server/app';
import type { RecoveryView } from '../../src/core/recovery-api-contracts';
import {
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_CALENDAR_FREEBUSY_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  type CalendarEmail,
  type CalendarEventRead,
  type CalendarEventWrite,
  type CalendarProvider,
  type CalendarProviderErrorKind,
  type ConnectedCalendarProvider,
  type FreeBusyRequest,
  type FreeBusyResult,
} from '../../src/core/calendar-contracts';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';
import { repairSchedule } from '../../src/core/schedule-repair';
import { jsonHash } from '../../src/server/crypto';
import type { AppBindings } from '../../src/server/http';
import { buildCalendarPayload, buildEmailPayload, processRecoveryAction, type RecoveryActionDeps } from '../../src/server/recovery/actions';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const testEnv = env as TestEnv;
const now = '2026-09-17T05:00:00.000Z';
const accountId = 'acct_recovery_action';
const ownerId = 'owner_recovery_action';
const workspaceId = 'ws_recovery_action';
const connectionId = 'conn_recovery_action';
const calendarId = 'cal_ieojim';

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('recovery action processing', () => {
  it('persists exact approval once through authenticated routes, then processes the queued action', async () => {
    const provider = fakeProvider();
    const secret = 'recovery-route-test-secret-more-than-32-characters';
    const origin = 'http://127.0.0.1:5174';
    const bindings = { ...runtime(), BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' };
    const context = await createAuthentication(bindings)!.$context;
    const user = await context.internalAdapter.createUser({ name: 'Recovery Test', email: 'route@example.test', emailVerified: true }, { method: 'test' });
    const session = await context.internalAdapter.createSession(user.id);
    const cookie = `ieojim-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, secret)}`)}`;
    const dispatch = vi.fn<(id: string) => Promise<void>>().mockResolvedValue();
    const app = createApp({ recovery: { ...deps(provider), dispatch } });
    const post = (path: string, body: unknown) => app.request(`${origin}${path}`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }, bindings);
    const created = await post('/api/recovery/workspaces', { input: createRecoveryExample(), requestId: crypto.randomUUID() });
    expect(created.status).toBe(201);
    const view = await created.json() as RecoveryView;
    await seedBase();
    await testEnv.DB.prepare('UPDATE calendar_connections SET account_id=? WHERE id=?').bind(user.id, connectionId).run();
    const path = `/api/workspaces/${view.workspaceId}/recovery`;
    const unapproved = { baseRevision: 1, conditionRevision: 1, requestId: crypto.randomUUID(), approved: true };
    expect((await post(`${path}/calendar`, unapproved)).status).toBe(409);
    expect((await post(`${path}/apply`, { proposalId: view.proposalId, baseRevision: 1, conditionRevision: 1, requestId: crypto.randomUUID() })).status).toBe(200);
    const command = { ...unapproved, baseRevision: 2, requestId: crypto.randomUUID() };
    const approved = await post(`${path}/calendar`, command);
    expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(202);
    const queued = await approved.json() as RecoveryView;
    expect(queued.actions).toHaveLength(1);
    expect((await post(`${path}/calendar`, command)).status).toBe(202);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM recovery_actions WHERE workspace_id=?').bind(view.workspaceId).first('COUNT(*)')).toBe(1);
    expect(await processRecoveryAction(bindings, queued.actions[0]!.id, deps(provider))).toBe('verified');
    expect(await processRecoveryAction(bindings, queued.actions[0]!.id, deps(provider))).toBeNull();
    expect(provider.insertCalls).toHaveLength(4);
    await context.internalAdapter.deleteSession(session.token);
    expect((await post(`${path}/calendar`, { ...command, requestId: crypto.randomUUID() })).status).toBe(401);
  });

  it('refuses a queued plan whose first changed slot has already started in real time', async () => {
    const provider = fakeProvider();
    const id = await seedCalendarAction(provider);
    expect(await processRecoveryAction(runtime(), id, { ...deps(provider), now: () => '2026-09-17T06:00:00.000Z' })).toBe('conflict');
    expect(provider.freeBusyCalls).toHaveLength(0);
    expect(provider.insertCalls).toHaveLength(0);
  });

  it('writes approved Calendar events only after primary freeBusy and independent readback', async () => {
    const provider = fakeProvider();
    const actionId = await seedCalendarAction(provider);

    const status = await processRecoveryAction(runtime(), actionId, deps(provider));

    expect(status).toBe('verified');
    expect(provider.freeBusyCalls).toEqual([{ timeMin: '2026-09-17T14:00:00+09:00', timeMax: '2026-09-19T14:00:00+09:00', calendarIds: ['primary', calendarId] }]);
    expect(provider.insertCalls.length).toBe(4);
    expect(provider.getEventCalls.length).toBe(4);
    expect(await actionStatus(actionId)).toBe('verified');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM recovery_calendar_events WHERE workspace_id=?').bind(workspaceId).first('count')).toBe(4);
  });

  it('treats primary Calendar busy blocks as conflicts before writing', async () => {
    const provider = fakeProvider({
      freeBusyBlocks: [{ calendarId: 'primary', start: '2026-09-17T15:45:00+09:00', end: '2026-09-17T16:15:00+09:00' }],
    });
    const actionId = await seedCalendarAction(provider);

    const status = await processRecoveryAction(runtime(), actionId, deps(provider));

    expect(status).toBe('conflict');
    expect(provider.insertCalls).toHaveLength(0);
    expect(await actionStatus(actionId)).toBe('conflict');
  });

  it('reconciles an unknown insert by reading the deterministic event once instead of reinserting', async () => {
    const provider = fakeProvider({ firstInsertUnknown: true });
    const actionId = await seedCalendarAction(provider);

    const status = await processRecoveryAction(runtime(), actionId, deps(provider));

    expect(status).toBe('verified');
    expect(provider.insertCalls.length).toBe(4);
    expect(provider.getEventCalls.length).toBe(5);
    expect(await actionStatus(actionId)).toBe('verified');
  });

  it('marks provider 412 stale updates as conflict without accepting a read reconciliation', async () => {
    const provider = fakeProvider({ updateStale: true });
    const actionId = await seedCalendarAction(provider);
    const payload = await calendarPayload(provider);
    const first = payload.events[0]!;
    await testEnv.DB.prepare(`INSERT INTO recovery_calendar_events(workspace_id,connection_id,item_id,event_id,etag,payload_json)
      VALUES(?,?,?,?,?,?)`)
      .bind(workspaceId, connectionId, first.itemId, first.eventId, 'old-etag', JSON.stringify({ write: first.write }))
      .run();
    // Preflight still sees the approved version; PATCH races with a later edit.
    provider.events.set(first.eventId, { ...first.write, etag: 'old-etag' });

    const status = await processRecoveryAction(runtime(), actionId, deps(provider));

    expect(status).toBe('conflict');
    expect(provider.updateCalls).toHaveLength(1);
    expect(await actionStatus(actionId)).toBe('conflict');
  });

  it('detects an already edited mapped event before issuing any writes', async () => {
    const provider = fakeProvider();
    const actionId = await seedCalendarAction(provider);
    const first = (await calendarPayload(provider)).events[0]!;
    await testEnv.DB.prepare(`INSERT INTO recovery_calendar_events(workspace_id,connection_id,item_id,event_id,etag,payload_json)
      VALUES(?,?,?,?,?,?)`).bind(workspaceId, connectionId, first.itemId, first.eventId, 'old-etag', JSON.stringify({ write: first.write })).run();
    provider.events.set(first.eventId, { ...first.write, etag: 'edited-etag' });
    expect(await processRecoveryAction(runtime(), actionId, deps(provider))).toBe('conflict');
    expect(provider.updateCalls).toHaveLength(0);
    expect(provider.insertCalls).toHaveLength(0);
  });

  it('blocks an unmapped busy event in the app calendar even when primary is free', async () => {
    const provider = fakeProvider();
    const actionId = await seedCalendarAction(provider);
    const first = (await calendarPayload(provider)).events[0]!;
    provider.events.set('another-event', { ...first.write, id: 'another-event', etag: 'another-etag' });
    expect(await processRecoveryAction(runtime(), actionId, deps(provider))).toBe('conflict');
    expect(provider.insertCalls).toHaveLength(0);
  });

  it('updates verified app-owned events without treating their old slots as unrelated busy events', async () => {
    const provider = fakeProvider();
    const actionId = await seedCalendarAction(provider);
    const payload = await calendarPayload(provider);
    for (const event of payload.events) {
      const old = { ...event.write, summary: `이전 ${event.write.summary}` };
      provider.events.set(event.eventId, { ...old, etag: 'old-etag' });
      await testEnv.DB.prepare(`INSERT INTO recovery_calendar_events(workspace_id,connection_id,item_id,event_id,etag,payload_json)
        VALUES(?,?,?,?,?,?)`).bind(workspaceId, connectionId, event.itemId, event.eventId, 'old-etag', JSON.stringify({ write: old })).run();
    }
    expect(await processRecoveryAction(runtime(), actionId, deps(provider))).toBe('verified');
    expect(provider.insertCalls).toHaveLength(0);
    expect(provider.updateCalls).toHaveLength(4);
  });

  it('does not overwrite a cancellation that happens during a partial Calendar write', async () => {
    const provider = fakeProvider({
      afterInsert: async () => {
        await testEnv.DB.prepare("UPDATE recovery_actions SET status='cancelled' WHERE id=?").bind('act_calendar').run();
      },
    });
    const actionId = await seedCalendarAction(provider, 'act_calendar');

    const status = await processRecoveryAction(runtime(), actionId, deps(provider));

    expect(status).toBe('cancelled');
    expect(provider.insertCalls).toHaveLength(1);
    expect(await actionStatus(actionId)).toBe('cancelled');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM recovery_calendar_events WHERE workspace_id=?').bind(workspaceId).first('count')).toBe(1);
  });

  it('stores accepted Gmail receipt and never retries an unknown send outcome', async () => {
    const acceptedProvider = fakeProvider({ emailReceipt: { providerMessageId: 'gmail-msg-1', acceptedAt: '2026-09-17T06:01:00.000Z' } });
    const acceptedAction = await seedEmailAction(acceptedProvider, 'act_email_ok');

    expect(await processRecoveryAction(runtime(), acceptedAction, deps(acceptedProvider))).toBe('accepted');
    const progress = JSON.parse(String(await testEnv.DB.prepare('SELECT progress_json FROM recovery_actions WHERE id=?').bind(acceptedAction).first('progress_json'))) as { receipt: { providerMessageId: string } };
    expect(progress.receipt.providerMessageId).toBe('gmail-msg-1');

    const unknownProvider = fakeProvider({ emailUnknown: true });
    const unknownAction = await seedEmailAction(unknownProvider, 'act_email_unknown');
    expect(await processRecoveryAction(runtime(), unknownAction, deps(unknownProvider))).toBe('uncertain');
    expect(await processRecoveryAction(runtime(), unknownAction, deps(unknownProvider))).toBeNull();
    expect(unknownProvider.emailCalls).toHaveLength(1);
    expect(await actionStatus(unknownAction)).toBe('uncertain');
  });
});

async function seedCalendarAction(provider: FakeProvider, actionId = 'act_calendar'): Promise<string> {
  await seedBase();
  const payload = await calendarPayload(provider);
  await insertAction(actionId, 'calendar', payload);
  return actionId;
}

async function seedEmailAction(provider: FakeProvider, actionId: string): Promise<string> {
  await seedBase();
  const payload = buildEmailPayload({
    workspace: workspaceRow(),
    ownerId,
    accountId,
    profile: profileRow(),
    connection: connection(provider),
    command: {
      baseRevision: 3,
      conditionRevision: 4,
      requestId: crypto.randomUUID(),
      approved: true,
      recipient: 'presenter@example.com',
      subject: '금요일 발표 변경',
      body: '승인한 본문입니다.',
    },
  });
  await insertAction(actionId, 'email', payload);
  return actionId;
}

async function calendarPayload(provider: FakeProvider) {
  const input = createRecoveryExample({ workspaceId, baseRevision: 3, sourceRevision: 2 });
  const result = repairSchedule(input);
  if (result.status !== 'ready') throw new Error(result.message);
  return buildCalendarPayload({ workspace: workspaceRow(), ownerId, accountId, profile: profileRow(), input, result, connection: connection(provider) });
}

async function seedBase(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO app_accounts(id, created_at) VALUES(?, ?) ON CONFLICT(id) DO NOTHING').bind(accountId, now),
    testEnv.DB.prepare('INSERT INTO owners(id, token_hash, account_id, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .bind(ownerId, 'owner_hash', accountId, now, now),
    testEnv.DB.prepare(`INSERT INTO workspaces(id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, created_at, updated_at, expires_at)
      VALUES(?, ?, 'Recovery', 'Calendar action', 3, 2, 3, ?, ?, '2099-01-01T00:00:00.000Z') ON CONFLICT(id) DO NOTHING`)
      .bind(workspaceId, ownerId, now, now),
    testEnv.DB.prepare(`INSERT INTO calendar_connections(id, account_id, provider, provider_subject, provider_email, status, auth_version, calendar_id, calendar_summary, scopes_json,
      encrypted_access_token, encrypted_refresh_token, access_token_expires_at, created_at, updated_at)
      VALUES(?, ?, 'google', 'google-subject', 'calendar@example.test', 'connected', 7, ?, 'Ieojim', ?, 'token', 'refresh', '2099-01-01T00:00:00.000Z', ?, ?)
      ON CONFLICT(id) DO UPDATE SET status='connected', auth_version=7, calendar_id=excluded.calendar_id, scopes_json=excluded.scopes_json`)
      .bind(connectionId, accountId, calendarId, JSON.stringify([GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE, GOOGLE_GMAIL_SEND_SCOPE]), now, now),
    testEnv.DB.prepare(`INSERT INTO recovery_profiles(workspace_id, condition_revision, base_revision, base_source_revision, input_json, proposal_id, applied_revision, updated_at)
      VALUES(?, 4, 3, 2, ?, 'proposal_1', 3, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET input_json=excluded.input_json, applied_revision=3, condition_revision=4`)
      .bind(workspaceId, JSON.stringify(createRecoveryExample({ workspaceId, baseRevision: 3, sourceRevision: 2 })), now),
  ]);
}

async function insertAction(actionId: string, kind: 'calendar' | 'email', payload: unknown): Promise<void> {
  await testEnv.DB.prepare(`INSERT INTO recovery_actions(
    id, workspace_id, owner_id, account_id, request_id, connection_id, connection_version, base_revision, source_revision,
    condition_revision, kind, payload_json, payload_hash, status, progress_json, message, attempts, created_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, 7, 3, 2, 4, ?, ?, ?, 'queued', '{}', 'queued', 0, ?, ?)`)
    .bind(actionId, workspaceId, ownerId, accountId, crypto.randomUUID(), connectionId, kind, JSON.stringify(payload), await jsonHash(payload), now, now)
    .run();
}

function runtime(): AppBindings {
  return { ...testEnv, APP_ENV: 'test' } as unknown as AppBindings;
}

function deps(provider: FakeProvider): RecoveryActionDeps {
  return {
    now: () => now,
    getConnectedProvider: async () => ({ ok: true, value: connection(provider) }),
  };
}

function connection(provider: CalendarProvider): ConnectedCalendarProvider {
  return {
    provider,
    connectionId,
    version: 7,
    calendarId,
    scopes: [GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE, GOOGLE_GMAIL_SEND_SCOPE],
  };
}

function workspaceRow() {
  return { id: workspaceId, owner_id: ownerId, revision: 3, source_revision: 2, deleted_at: null, expires_at: '2099-01-01T00:00:00.000Z' };
}

function profileRow() {
  return { workspace_id: workspaceId, condition_revision: 4, base_revision: 3, base_source_revision: 2, input_json: '{}', proposal_id: 'proposal_1', applied_revision: 3 };
}

async function actionStatus(actionId: string): Promise<string | null> {
  return testEnv.DB.prepare('SELECT status FROM recovery_actions WHERE id=?').bind(actionId).first('status');
}

type FakeProvider = CalendarProvider & {
  events: Map<string, CalendarEventRead>;
  freeBusyCalls: FreeBusyRequest[];
  getEventCalls: string[];
  insertCalls: CalendarEventWrite[];
  updateCalls: Array<{ eventId: string; etag: string }>;
  emailCalls: CalendarEmail[];
};

function fakeProvider(options: {
  freeBusyBlocks?: FreeBusyResult['blocks'];
  firstInsertUnknown?: boolean;
  updateStale?: boolean;
  afterInsert?: () => Promise<void>;
  emailUnknown?: boolean;
  emailReceipt?: { providerMessageId: string; acceptedAt: string };
} = {}): FakeProvider {
  const events = new Map<string, CalendarEventRead>();
  const provider: FakeProvider = {
    events,
    freeBusyCalls: [],
    getEventCalls: [],
    insertCalls: [],
    updateCalls: [],
    emailCalls: [],
    async freeBusy(input) {
      provider.freeBusyCalls.push(input);
      return { ok: true, value: { blocks: options.freeBusyBlocks ?? [] } };
    },
    async listBusyEvents() {
      return { ok: true, value: { events: Array.from(events.values()).map((event) => ({ id: event.id, etag: event.etag, start: event.start.dateTime, end: event.end.dateTime })) } };
    },
    async getCalendar(id) {
      return { ok: true, value: { id, summary: 'Ieojim', description: null } };
    },
    async getEvent(_calendarId, eventId) {
      provider.getEventCalls.push(eventId);
      const event = events.get(eventId);
      return event ? { ok: true, value: event } : failure('not_found', 404);
    },
    async insertEvent(_calendarId, event) {
      provider.insertCalls.push(event);
      const read = { ...event, etag: `etag-${provider.insertCalls.length}` };
      events.set(event.id, read);
      await options.afterInsert?.();
      if (options.firstInsertUnknown && provider.insertCalls.length === 1) return failure('unknown', null);
      return { ok: true, value: read };
    },
    async updateEvent(_calendarId, eventId, event, etag) {
      provider.updateCalls.push({ eventId, etag });
      if (options.updateStale) return failure('stale', 412);
      const read = { ...event, etag: `etag-updated-${provider.updateCalls.length}` };
      events.set(eventId, read);
      return { ok: true, value: read };
    },
    async createAppCalendar() {
      throw new Error('not used');
    },
    async sendEmail(input) {
      provider.emailCalls.push(input);
      if (options.emailUnknown) return failure('unknown', null);
      return { ok: true, value: options.emailReceipt ?? { providerMessageId: 'fake-message-id', acceptedAt: now } };
    },
  };
  return provider;
}

function failure(kind: CalendarProviderErrorKind, status: number | null) {
  return { ok: false, error: { kind, status, message: 'fake provider failure' } } as const;
}
