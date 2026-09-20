/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '../../src/core/calendar-contracts';
import { CALENDAR_WATCH_INTERVAL_MS } from '../../src/core/recovery-verification-contracts';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';
import { repairSchedule } from '../../src/core/schedule-repair';
import { jsonHash } from '../../src/server/crypto';
import type { AppBindings } from '../../src/server/http';
import { buildCalendarPayload, type RecoveryActionDeps } from '../../src/server/recovery/actions';
import { checkCalendarVerification, configureCalendarWatch, recoverCalendarVerifications } from '../../src/server/recovery/verification';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

type FakeProvider = CalendarProvider & {
  events: Map<string, CalendarEventRead>;
  freeBusyCalls: FreeBusyRequest[];
  getEventCalls: string[];
  insertCalls: CalendarEventWrite[];
  updateCalls: Array<{ eventId: string; etag: string }>;
  emailCalls: CalendarEmail[];
};

const testEnv = env as TestEnv;
const now = '2026-09-17T05:00:00.000Z';
const accountId = 'acct_recovery_verification';
const ownerId = 'owner_recovery_verification';
const workspaceId = 'ws_recovery_verification';
const connectionId = 'conn_recovery_verification';
const calendarId = 'cal_recovery_verification';

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('Calendar post-execution verification', () => {
  it('manual check reads verified events without provider writes and preserves the historical action', async () => {
    const provider = fakeProvider();
    const actionId = await seedVerifiedCalendarAction(provider);

    const view = await checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(actionId), deps(provider));

    expect(view.status).toBe('matched');
    expect(view.events).toHaveLength(4);
    expect(view.events.every((event) => event.status === 'matched')).toBe(true);
    expect(provider.getEventCalls).toHaveLength(4);
    expect(provider.insertCalls).toHaveLength(0);
    expect(provider.updateCalls).toHaveLength(0);
    expect(provider.emailCalls).toHaveLength(0);
    expect(await testEnv.DB.prepare('SELECT status FROM recovery_actions WHERE id=?').bind(actionId).first('status')).toBe('verified');
  });

  it('detects an external Calendar edit against the latest approved payload and pauses attention', async () => {
    const provider = fakeProvider();
    const actionId = await seedVerifiedCalendarAction(provider);
    const first = Array.from(provider.events.values())[0]!;
    provider.events.set(first.id, { ...first, summary: `${first.summary} 외부 수정`, etag: 'etag-user-edit' });

    const view = await checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(actionId), deps(provider));

    expect(view.status).toBe('drifted');
    expect(view.watch.enabled).toBe(false);
    expect(view.events.some((event) => event.status === 'changed' && event.differences.includes('title') && event.differences.includes('version'))).toBe(true);
  });

  it('detects a deleted approved event without recreating it', async () => {
    const provider = fakeProvider();
    const actionId = await seedVerifiedCalendarAction(provider);
    const deleted = Array.from(provider.events.keys())[0]!;
    provider.events.delete(deleted);

    const view = await checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(actionId), deps(provider));

    expect(view.status).toBe('drifted');
    expect(view.events.some((event) => event.status === 'missing')).toBe(true);
    expect(provider.insertCalls).toHaveLength(0);
    expect(provider.updateCalls).toHaveLength(0);
  });

  it('stops before provider reads when the local workspace revision is stale', async () => {
    const provider = fakeProvider();
    const actionId = await seedVerifiedCalendarAction(provider);
    await testEnv.DB.prepare('UPDATE workspaces SET revision=revision+1 WHERE id=?').bind(workspaceId).run();

    const view = await checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(actionId), deps(provider));

    expect(view.status).toBe('stale');
    expect(view.watch.enabled).toBe(false);
    expect(provider.getEventCalls).toHaveLength(0);
  });

  it('stops before provider reads when the saved Calendar mapping belongs to another action', async () => {
    const provider = fakeProvider();
    const actionId = await seedVerifiedCalendarAction(provider);
    await testEnv.DB.prepare('UPDATE recovery_calendar_events SET payload_json=? WHERE workspace_id=? AND connection_id=?')
      .bind(JSON.stringify({ actionId: 'another-action' }), workspaceId, connectionId)
      .run();

    const view = await checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(actionId), deps(provider));

    expect(view.status).toBe('unavailable');
    expect(view.watch.stoppedReason).toBe('mapping_mismatch');
    expect(provider.getEventCalls).toHaveLength(0);
  });

  it('requires explicit watch consent before scheduled recovery performs provider reads', async () => {
    const provider = fakeProvider();
    await seedVerifiedCalendarAction(provider);

    const recovered = await recoverCalendarVerifications(runtime(), deps(provider));

    expect(recovered).toEqual({ claimed: 0, matched: 0, attention: 0 });
    expect(provider.getEventCalls).toHaveLength(0);
  });

  it('enables a bounded opt-in watch and schedules the next read after a match', async () => {
    const provider = fakeProvider();
    const actionId = await seedVerifiedCalendarAction(provider);
    const configured = await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(actionId), enabled: true, consent: true }, deps(provider));
    expect(configured.watch.enabled).toBe(true);

    const recovered = await recoverCalendarVerifications(runtime(), deps(provider));
    const row = await verificationRow(actionId);

    expect(recovered.matched).toBe(1);
    expect(row.status).toBe('matched');
    expect(row.watch_enabled).toBe(1);
    expect(row.next_check_at).toBe(new Date(Date.parse(now) + CALENDAR_WATCH_INTERVAL_MS).toISOString());
  });

  it('serializes duplicate cron claims through the verification row lease', async () => {
    const provider = fakeProvider();
    const actionId = await seedVerifiedCalendarAction(provider);
    await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(actionId), enabled: true, consent: true }, deps(provider));
    await testEnv.DB.prepare("UPDATE recovery_calendar_verifications SET status='checking', claim_token='other', claimed_at=?, next_check_at=? WHERE action_id=?")
      .bind(now, now, actionId)
      .run();

    const recovered = await recoverCalendarVerifications(runtime(), deps(provider));

    expect(recovered.claimed).toBe(0);
    expect(provider.getEventCalls).toHaveLength(0);
  });

  it('bounds transient read failures and stops the watch after three failures', async () => {
    const provider = fakeProvider({ getUnknown: true });
    const actionId = await seedVerifiedCalendarAction(provider);
    await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(actionId), enabled: true, consent: true }, deps(provider));

    await recoverCalendarVerifications(runtime(), deps(provider, now));
    await testEnv.DB.prepare('UPDATE recovery_calendar_verifications SET next_check_at=? WHERE action_id=?').bind(now, actionId).run();
    await recoverCalendarVerifications(runtime(), deps(provider, now));
    await testEnv.DB.prepare('UPDATE recovery_calendar_verifications SET next_check_at=? WHERE action_id=?').bind(now, actionId).run();
    await recoverCalendarVerifications(runtime(), deps(provider, now));
    const row = await verificationRow(actionId);

    expect(row.status).toBe('unavailable');
    expect(row.watch_enabled).toBe(0);
    expect(row.consecutive_failures).toBe(3);
    expect(row.stopped_reason).toBe('transient_failure_limit');
    expect(provider.insertCalls).toHaveLength(0);
    expect(provider.updateCalls).toHaveLength(0);
  });

  it('pauses watch on auth failure and disable remains available after connection drift', async () => {
    const provider = fakeProvider();
    const actionId = await seedVerifiedCalendarAction(provider);
    await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(actionId), enabled: true, consent: true }, deps(provider));
    const authFailed = await recoverCalendarVerifications(runtime(), {
      now: () => now,
      getConnectedProvider: async () => failure('reauth_required', 401),
    });
    expect(authFailed.attention).toBe(1);

    await testEnv.DB.prepare('UPDATE calendar_connections SET auth_version=auth_version+1 WHERE id=?').bind(connectionId).run();
    const disabled = await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(actionId), requestId: crypto.randomUUID(), enabled: false }, deps(provider));

    expect(disabled.watch.enabled).toBe(false);
    expect(disabled.watch.stoppedReason).toBe('user_disabled');
  });

  it('counts provider initialization failures instead of resetting the retry budget', async () => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(id), enabled: true, consent: true }, deps(provider));
    for (const minute of [0, 15, 75]) {
      await recoverCalendarVerifications(runtime(), { now: () => new Date(Date.parse(now) + minute * 60_000).toISOString(), getConnectedProvider: async () => failure('unknown', 503) });
    }
    expect(await verificationRow(id)).toMatchObject({ watch_enabled: 0, consecutive_failures: 3, stopped_reason: 'transient_failure_limit' });
    expect(provider.getEventCalls).toHaveLength(0);
  });

  it('stops reading after user cancellation during the first event read and discards the late result', async () => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    const read = provider.getEvent;
    provider.getEvent = async (...args) => {
      const result = await read(...args);
      await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(id), enabled: false }, deps(provider));
      return result;
    };
    const result = await checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(id), deps(provider));
    expect(result.status).not.toBe('matched');
    expect(result.status).not.toBe('checking');
    expect(result.watch.enabled).toBe(false);
    expect(provider.getEventCalls).toHaveLength(1);
  });

  it('does not reuse an earlier matched observation after cancelling an in-flight recheck', async () => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    expect((await checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(id), deps(provider))).status).toBe('matched');
    const later = new Date(Date.parse(now) + 61_000).toISOString();
    const read = provider.getEvent;
    provider.getEvent = async (...args) => {
      const result = await read(...args);
      await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(id), enabled: false }, deps(provider, later));
      return result;
    };
    const result = await checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(id), deps(provider, later));
    expect(result.status).toBe('not_checked');
    expect(result.checkedAt).toBeNull();
    expect(result.events).toEqual([]);
    expect(result.message).not.toContain('일치');
  });

  it('stops subsequent reads when authorization changes mid-check', async () => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    const read = provider.getEvent;
    provider.getEvent = async (...args) => {
      const result = await read(...args);
      await testEnv.DB.prepare("UPDATE calendar_connections SET status='disconnected',auth_version=auth_version+1 WHERE id=?").bind(connectionId).run();
      return result;
    };
    const result = await checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(id), deps(provider));
    expect(result.status).toBe('unavailable');
    expect(provider.getEventCalls).toHaveLength(1);
    expect((await verificationRow(id)).status).not.toBe('matched');
  });

  it.each([
    'UPDATE workspaces SET revision=revision+1 WHERE id=?',
    'UPDATE workspaces SET source_revision=source_revision+1 WHERE id=?',
    'UPDATE recovery_profiles SET condition_revision=condition_revision+1 WHERE workspace_id=?',
  ])('atomically rejects a basis change between the final read and publication: %s', async (sql) => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    let raced = false;
    const db = publicationRaceDatabase(testEnv.DB, async () => { raced = true; await testEnv.DB.prepare(sql).bind(workspaceId).run(); });
    const result = await checkCalendarVerification({ ...runtime(), DB: db }, ownerId, accountId, workspaceId, command(id), deps(provider));
    expect(raced).toBe(true);
    expect(result.status).toBe('stale');
    expect((await verificationRow(id)).status).toBe('stale');
    expect(provider.getEventCalls).toHaveLength(4);
  });

  it('atomically rejects auth version changes between the last read and publication', async () => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    const db = publicationRaceDatabase(testEnv.DB, async () => {
      await testEnv.DB.prepare('UPDATE calendar_connections SET auth_version=auth_version+1 WHERE id=?').bind(connectionId).run();
    });
    const result = await checkCalendarVerification({ ...runtime(), DB: db }, ownerId, accountId, workspaceId, command(id), deps(provider));
    expect(result.status).toBe('unavailable');
    expect((await verificationRow(id)).status).not.toBe('matched');
  });

  it('expires an opted-in watch without extending workspace retention and deletes it with the workspace', async () => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(id), enabled: true, consent: true }, deps(provider));
    await recoverCalendarVerifications(runtime(), deps(provider, '2026-09-18T06:00:00.000Z'));
    expect(await verificationRow(id)).toMatchObject({ watch_enabled: 0, next_check_at: null, stopped_reason: 'watch_expired' });
    expect(provider.getEventCalls).toHaveLength(0);
    expect(await testEnv.DB.prepare('SELECT expires_at FROM workspaces WHERE id=?').bind(workspaceId).first('expires_at')).toBe('2099-01-01T00:00:00.000Z');
    await testEnv.DB.prepare('DELETE FROM workspaces WHERE id=?').bind(workspaceId).run();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM recovery_calendar_verifications').first('count')).toBe(0);
  });

  it('rejects an elapsed horizon and an untrusted payload before querying a provider', async () => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    await expect(configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(id), enabled: true, consent: true }, deps(provider, '2026-09-20T00:00:00.000Z'))).rejects.toMatchObject({ code: 'CALENDAR_WATCH_WINDOW_CLOSED' });
    await testEnv.DB.prepare("UPDATE recovery_actions SET payload_hash=? WHERE id=?").bind('f'.repeat(64), id).run();
    await expect(checkCalendarVerification(runtime(), ownerId, accountId, workspaceId, command(id), deps(provider))).rejects.toMatchObject({ code: 'CALENDAR_VERIFICATION_HASH_MISMATCH' });
    expect(provider.getEventCalls).toHaveLength(0);
  });

  it('allows cancellation with a full request ledger and a corrupt action payload', async () => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(id), enabled: true, consent: true }, deps(provider));
    await testEnv.DB.batch(Array.from({ length: 200 }, (_, index) => testEnv.DB.prepare('INSERT INTO recovery_requests(owner_id,request_id,workspace_id,payload_hash,response_json,created_at) VALUES(?,?,?,?,?,?)')
      .bind(ownerId, `capacity-${index}`, workspaceId, 'hash', '{}', now)));
    await testEnv.DB.prepare("UPDATE recovery_actions SET payload_json='bad json' WHERE id=?").bind(id).run();
    const result = await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(id), enabled: false }, deps(provider));
    expect(result.watch.enabled).toBe(false);
    expect(provider.getEventCalls).toHaveLength(0);
  });

  it('serializes two actual simultaneous cron executions', async () => {
    const provider = fakeProvider();
    const id = await seedVerifiedCalendarAction(provider);
    await configureCalendarWatch(runtime(), ownerId, accountId, workspaceId, { ...command(id), enabled: true, consent: true }, deps(provider));
    let reached!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = provider.getEvent;
    provider.getEvent = async (...args) => { reached(); await gate; return read(...args); };
    const first = recoverCalendarVerifications(runtime(), deps(provider));
    await started;
    try { expect((await recoverCalendarVerifications(runtime(), deps(provider))).claimed).toBe(0); }
    finally { release(); }
    expect((await first).matched).toBe(1);
    expect(provider.getEventCalls).toHaveLength(4);
  });
});

function publicationRaceDatabase(db: D1Database, mutate: () => Promise<void>): D1Database {
  let injected = false;
  return new Proxy(db, { get(target, key) {
    if (key !== 'prepare') return Reflect.get(target, key, target);
    return (query: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(inner, method) {
        if (method === 'bind') return (...values: unknown[]) => wrap(inner.bind(...values));
        if (method === 'run' && query.includes('SET status=?, last_result_json=?') && query.includes('AND EXISTS')) return async () => {
          if (!injected) { injected = true; await mutate(); }
          return inner.run();
        };
        const value = Reflect.get(inner, method, inner);
        return typeof value === 'function' ? value.bind(inner) : value;
      } });
      return wrap(target.prepare(query));
    };
  } });
}

function command(actionId: string) {
  return { actionId, baseRevision: 3, conditionRevision: 4, requestId: crypto.randomUUID() };
}

async function seedVerifiedCalendarAction(provider: FakeProvider, actionId = 'act_calendar_verification'): Promise<string> {
  await seedBase();
  const payload = await calendarPayload(provider);
  await testEnv.DB.prepare(`INSERT INTO recovery_actions(
    id, workspace_id, owner_id, account_id, request_id, connection_id, connection_version, base_revision, source_revision,
    condition_revision, kind, payload_json, payload_hash, status, progress_json, message, attempts, created_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, 7, 3, 2, 4, 'calendar', ?, ?, 'verified', ?, 'verified', 1, ?, ?)`)
    .bind(actionId, workspaceId, ownerId, accountId, crypto.randomUUID(), connectionId, JSON.stringify(payload), await jsonHash(payload), progressJson(payload), now, now)
    .run();
  let i = 0;
  for (const event of payload.events) {
    i += 1;
    const read: CalendarEventRead = { ...event.write, etag: `etag-${i}` };
    provider.events.set(event.eventId, read);
    await testEnv.DB.prepare(`INSERT INTO recovery_calendar_events(workspace_id,connection_id,item_id,event_id,etag,payload_json)
      VALUES(?,?,?,?,?,?)`)
      .bind(workspaceId, connectionId, event.itemId, event.eventId, read.etag, JSON.stringify({ actionId, hash: await jsonHash(event.write), write: event.write }))
      .run();
  }
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
      VALUES(?, ?, 'Recovery verification', 'Calendar verification', 3, 2, 3, ?, ?, '2099-01-01T00:00:00.000Z') ON CONFLICT(id) DO NOTHING`)
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

function progressJson(payload: Awaited<ReturnType<typeof calendarPayload>>): string {
  return JSON.stringify({ completed: Object.fromEntries(payload.events.map((event, index) => [event.itemId, { eventId: event.eventId, etag: `etag-${index + 1}`, payloadHash: 'a'.repeat(64) }])) });
}

function runtime(): AppBindings {
  return { ...testEnv, APP_ENV: 'test' } as unknown as AppBindings;
}

function deps(provider: FakeProvider, currentNow = now): RecoveryActionDeps {
  return { now: () => currentNow, getConnectedProvider: async () => ({ ok: true, value: connection(provider) }) };
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

async function verificationRow(actionId: string) {
  const row = await testEnv.DB.prepare('SELECT * FROM recovery_calendar_verifications WHERE action_id=?').bind(actionId).first<{
    status: string; watch_enabled: number; next_check_at: string | null; consecutive_failures: number; stopped_reason: string | null;
  }>();
  if (!row) throw new Error('missing verification row');
  return row;
}

function fakeProvider(options: { getUnknown?: boolean } = {}): FakeProvider {
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
      return { ok: true, value: { blocks: [] } };
    },
    async listBusyEvents() {
      return { ok: true, value: { events: [] } };
    },
    async getCalendar(id) {
      return { ok: true, value: { id, summary: 'Ieojim', description: null } };
    },
    async getEvent(_calendarId, eventId) {
      provider.getEventCalls.push(eventId);
      if (options.getUnknown) return failure('unknown', null);
      const event = events.get(eventId);
      return event ? { ok: true, value: event } : failure('not_found', 404);
    },
    async insertEvent(_calendarId, event) {
      provider.insertCalls.push(event);
      return { ok: true, value: { ...event, etag: 'inserted' } };
    },
    async updateEvent(_calendarId, eventId, _event, etag) {
      provider.updateCalls.push({ eventId, etag });
      return failure('unknown', null);
    },
    async createAppCalendar() {
      throw new Error('not used');
    },
    async sendEmail(input) {
      provider.emailCalls.push(input);
      return { ok: true, value: { providerMessageId: 'fake-message-id', acceptedAt: now } };
    },
  };
  return provider;
}

function failure(kind: CalendarProviderErrorKind, status: number | null) {
  return { ok: false as const, error: { kind, status, message: kind } };
}
