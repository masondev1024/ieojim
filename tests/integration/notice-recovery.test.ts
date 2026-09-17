/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEventWrite } from '../../src/core/calendar-contracts';
import type { Snapshot, WorkspaceView } from '../../src/core/contracts';
import type { NoticeRecoveryRequest } from '../../src/core/notice-recovery';
import type { RecoveryView } from '../../src/core/recovery-api-contracts';
import { jsonHash, sha256Hex } from '../../src/server/crypto';
import { createApp } from '../../src/server/app';
import { processRecoveryAction, type RecoveryActionDeps } from '../../src/server/recovery/actions';
import { NoticeRecoveryStore } from '../../src/server/recovery/notice-store';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const testEnv = env as TestEnv;
const app = createApp();
const origin = 'http://127.0.0.1:5174';
const noticeText = '발표 일정이 2026-09-17T18:00-2026-09-17T19:00로 변경되었습니다.';
const sourceId = 'src_notice_origin';
const targetItemId = 'item_notice_target';

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('notice recovery bridge persistence and guards', () => {
  it('creates a derived recovery workspace without model runs and replays the same request to the same workspace', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external call'));
    const { cookie, workspace } = await seedOriginWorkspace();
    const beforeOrigin = await originStorageState(workspace.id);
    const command = noticeCommand(workspace);

    const created = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, command);
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    const view = await created.json() as RecoveryView;

    expect(view).toMatchObject({
      revision: 1,
      sourceRevision: 2,
      conditionRevision: 1,
      applied: false,
      actions: [],
      origin: {
        workspaceId: workspace.id,
        title: workspace.title,
        revision: 1,
        sourceRevision: 1,
        sourceId,
        targetItemId,
        preparationItemId: null,
        sourceMode: 'user',
        noticeText,
      },
    });
    expect(view.result.status).toBe('ready');
    expect((await getWorkspace(cookie, view.workspaceId)).runs).toEqual([]);
    expect(await scalar('SELECT COUNT(*) FROM runs WHERE workspace_id=?', view.workspaceId)).toBe(0);
    expect(await scalar('SELECT COUNT(*) FROM sources WHERE workspace_id=?', view.workspaceId)).toBe(2);
    expect(await scalar('SELECT COUNT(*) FROM recovery_origins WHERE recovery_workspace_id=?', view.workspaceId)).toBe(1);
    expect(await originStorageState(workspace.id)).toEqual(beforeOrigin);

    const replay = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, command);
    expect(replay.status).toBe(201);
    expect((await replay.json() as RecoveryView).workspaceId).toBe(view.workspaceId);
    expect(await scalar('SELECT COUNT(*) FROM workspaces')).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the origin guard row when the origin expires or is deleted and blocks writes', async () => {
    const { cookie, workspace } = await seedOriginWorkspace();
    const created = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, noticeCommand(workspace));
    const view = await created.json() as RecoveryView;

    await testEnv.DB.prepare('UPDATE workspaces SET expires_at=? WHERE id=?').bind('2000-01-01T00:00:00.000Z', workspace.id).run();
    const expiredRead = await request(`/api/workspaces/${view.workspaceId}/recovery`, cookie);
    expect(expiredRead.status).toBe(200);
    expect(await expiredRead.json()).toMatchObject({ applied: false, result: { status: 'missing_information', code: 'stale_origin' } });

    await testEnv.DB.prepare('DELETE FROM workspaces WHERE id=?').bind(workspace.id).run();
    expect(await scalar('SELECT COUNT(*) FROM recovery_origins WHERE recovery_workspace_id=?', view.workspaceId)).toBe(1);
    const deletedRead = await request(`/api/workspaces/${view.workspaceId}/recovery`, cookie);
    expect(deletedRead.status).toBe(200);
    expect(await deletedRead.json()).toMatchObject({ applied: false, result: { status: 'missing_information', code: 'stale_origin' } });

    const apply = await request(`/api/workspaces/${view.workspaceId}/recovery/apply`, cookie, {
      proposalId: view.proposalId,
      baseRevision: view.revision,
      conditionRevision: view.conditionRevision,
      requestId: crypto.randomUUID(),
    });
    expect(apply.status).toBe(409);
    expect(await apply.json()).toMatchObject({ error: { code: 'STALE_NOTICE_ORIGIN' } });
  });

  it('rejects idempotency conflicts for the notice creation request id', async () => {
    const { cookie, workspace } = await seedOriginWorkspace();
    const command = noticeCommand(workspace);
    expect((await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, command)).status).toBe(201);

    const conflict = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, {
      ...command,
      targetAfter: { start: '2026-09-17T19:00', end: '2026-09-17T20:00' },
    });

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await scalar('SELECT COUNT(*) FROM recovery_origins')).toBe(1);
  });

  it('returns stale_origin and blocks preview/apply when the origin source no longer exactly matches', async () => {
    const { cookie, workspace } = await seedOriginWorkspace();
    const created = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, noticeCommand(workspace));
    const view = await created.json() as RecoveryView;
    await testEnv.DB.prepare('UPDATE sources SET text=? WHERE id=?').bind(`정정됨: ${noticeText}`, sourceId).run();

    const read = await request(`/api/workspaces/${view.workspaceId}/recovery`, cookie);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ applied: false, result: { status: 'missing_information', code: 'stale_origin' } });

    const preview = await request(`/api/workspaces/${view.workspaceId}/recovery/preview`, cookie, {
      input: view.input,
      baseRevision: view.revision,
      conditionRevision: view.conditionRevision,
      requestId: crypto.randomUUID(),
    });
    expect(preview.status).toBe(409);
    expect(await preview.json()).toMatchObject({ error: { code: 'NOTICE_CONDITIONS_LOCKED' } });

    const apply = await request(`/api/workspaces/${view.workspaceId}/recovery/apply`, cookie, {
      proposalId: view.proposalId,
      baseRevision: view.revision,
      conditionRevision: view.conditionRevision,
      requestId: crypto.randomUUID(),
    });
    expect(apply.status).toBe(409);
    expect(await apply.json()).toMatchObject({ error: { code: 'STALE_NOTICE_ORIGIN' } });
    expect(await scalar('SELECT COUNT(*) FROM snapshots WHERE workspace_id=?', view.workspaceId)).toBe(2);
  });

  it('rejects preview for active notice origins because confirmed conditions are read-only', async () => {
    const { cookie, workspace } = await seedOriginWorkspace();
    const created = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, noticeCommand(workspace));
    const view = await created.json() as RecoveryView;

    const preview = await request(`/api/workspaces/${view.workspaceId}/recovery/preview`, cookie, {
      input: view.input,
      baseRevision: view.revision,
      conditionRevision: view.conditionRevision,
      requestId: crypto.randomUUID(),
    });

    expect(preview.status).toBe(409);
    expect(await preview.json()).toMatchObject({ error: { code: 'NOTICE_CONDITIONS_LOCKED' } });
  });

  it('rejects stale origin revisions before creation without partial derived writes', async () => {
    const { cookie, workspace } = await seedOriginWorkspace();
    const command = noticeCommand(workspace);
    await testEnv.DB.prepare('UPDATE workspaces SET revision=revision+1 WHERE id=?').bind(workspace.id).run();

    const response = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, command);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'STALE_WORKSPACE' } });
    expect(await scalar('SELECT COUNT(*) FROM workspaces')).toBe(1);
    expect(await scalar('SELECT COUNT(*) FROM recovery_origins')).toBe(0);
  });

  it('uses the atomic origin guard when the origin changes between read and create batch', async () => {
    const { cookie, workspace } = await seedOriginWorkspace();
    const ownerId = await ownerIdFromCookie(cookie);
    const command = noticeCommand(workspace);
    let raced = false;
    const racingDb = new Proxy(testEnv.DB, {
      get(target, key, receiver) {
        if (key === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await testEnv.DB.prepare('UPDATE workspaces SET revision=revision+1 WHERE id=?').bind(workspace.id).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;

    await expect(new NoticeRecoveryStore({ ...testEnv, DB: racingDb }).create({ id: ownerId, token: '', hash: '', isNew: false }, workspace.id, command))
      .rejects.toMatchObject({ code: 'NOTICE_RECOVERY_CONFLICT', status: 409 });
    expect(await scalar('SELECT COUNT(*) FROM workspaces')).toBe(1);
    expect(await scalar('SELECT COUNT(*) FROM recovery_origins')).toBe(0);
  });

  it('blocks cross-owner notice recovery creation at the workspace boundary', async () => {
    const { workspace } = await seedOriginWorkspace();
    const other = await request('/api/workspaces', undefined, { title: 'Other', purpose: 'Other owner' });
    const otherCookie = cookieFrom(other);

    const response = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, otherCookie, noticeCommand(workspace));

    expect(response.status).toBe(404);
    expect(await scalar('SELECT COUNT(*) FROM recovery_origins')).toBe(0);
  });

  it('rejects using a recovery workspace as the origin for another notice recovery', async () => {
    const { cookie, workspace } = await seedOriginWorkspace();
    const created = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, noticeCommand(workspace));
    const view = await created.json() as RecoveryView;
    const derived = await getWorkspace(cookie, view.workspaceId);

    const response = await request(`/api/workspaces/${derived.id}/recovery/from-notice`, cookie, {
      ...noticeCommand(derived),
      sourceId: derived.sources[0]!.id,
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'RECOVERY_ORIGIN_NOT_SUPPORTED' } });
    expect(await scalar('SELECT COUNT(*) FROM recovery_origins')).toBe(1);
  });

  it('cancels queued Calendar execution before provider lookup when the origin becomes stale', async () => {
    const { cookie, workspace } = await seedOriginWorkspace();
    const created = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, noticeCommand(workspace));
    const view = await created.json() as RecoveryView;
    const applied = await request(`/api/workspaces/${view.workspaceId}/recovery/apply`, cookie, {
      proposalId: view.proposalId,
      baseRevision: view.revision,
      conditionRevision: view.conditionRevision,
      requestId: crypto.randomUUID(),
    });
    expect(applied.status, JSON.stringify(await applied.clone().json())).toBe(200);
    const appliedView = await applied.json() as RecoveryView;
    const ownerId = await ownerIdFromCookie(cookie);
    const accountId = 'acct_notice_preflight';
    const connectionId = 'conn_notice_preflight';
    await seedQueuedCalendarAction({ ownerId, accountId, connectionId, workspaceId: view.workspaceId, baseRevision: appliedView.revision });
    await testEnv.DB.prepare('UPDATE sources SET hash=? WHERE id=?').bind('stale_notice_hash', sourceId).run();
    const getConnectedProvider = vi.fn<NonNullable<RecoveryActionDeps['getConnectedProvider']>>();

    expect(await processRecoveryAction(testEnv, 'act_notice_calendar', { getConnectedProvider })).toBe('conflict');

    expect(getConnectedProvider).not.toHaveBeenCalled();
    expect(await testEnv.DB.prepare('SELECT status FROM recovery_actions WHERE id=?').bind('act_notice_calendar').first('status')).toBe('conflict');
  });

  it('marks unreliable Calendar progress uncertain before provider lookup and preserves the raw record', async () => {
    const { cookie, workspace } = await seedOriginWorkspace();
    const created = await request(`/api/workspaces/${workspace.id}/recovery/from-notice`, cookie, noticeCommand(workspace));
    const view = await created.json() as RecoveryView;
    const applied = await request(`/api/workspaces/${view.workspaceId}/recovery/apply`, cookie, {
      proposalId: view.proposalId,
      baseRevision: view.revision,
      conditionRevision: view.conditionRevision,
      requestId: crypto.randomUUID(),
    });
    expect(applied.status, JSON.stringify(await applied.clone().json())).toBe(200);
    const appliedView = await applied.json() as RecoveryView;
    const ownerId = await ownerIdFromCookie(cookie);
    const accountId = 'acct_notice_progress';
    const connectionId = 'conn_notice_progress';
    const resultHash = await jsonHash(appliedView.result);
    if (appliedView.result.status !== 'ready') throw new Error('expected ready recovery result');
    const changedAction = appliedView.result.actions.find((action) => action.kind === 'reschedule' && action.itemId);
    if (!changedAction?.itemId) throw new Error('expected reschedule action');
    const progressEvent = progressPayloadEvent(changedAction.itemId);
    const cases = [
      ['malformed', '{', []],
      ['null', 'null', []],
      ['array', '[]', []],
      ['bad-completed', JSON.stringify({ completed: { [changedAction.itemId]: { eventId: progressEvent.eventId, etag: 'etag', payloadHash: '0'.repeat(64) } } }), [progressEvent]],
    ] as const;

    for (const [suffix, progressJson, events] of cases) {
      const actionId = `act_notice_progress_${suffix}`;
      await seedQueuedCalendarAction({
        ownerId,
        accountId,
        connectionId,
        workspaceId: view.workspaceId,
        baseRevision: appliedView.revision,
        actionId,
        progressJson,
        resultHash,
        events,
      });
      const getConnectedProvider = vi.fn<NonNullable<RecoveryActionDeps['getConnectedProvider']>>();

      expect(await processRecoveryAction(testEnv, actionId, {
        getConnectedProvider,
        // Exercise progress validation while the approved event is still in the future.
        now: () => '2026-09-15T00:00:00.000Z',
      })).toBe('uncertain');

      expect(getConnectedProvider).not.toHaveBeenCalled();
      expect(await testEnv.DB.prepare('SELECT status FROM recovery_actions WHERE id=?').bind(actionId).first('status')).toBe('uncertain');
      expect(await testEnv.DB.prepare('SELECT progress_json FROM recovery_actions WHERE id=?').bind(actionId).first('progress_json')).toBe(progressJson);
      await testEnv.DB.prepare('UPDATE recovery_actions SET status="cancelled" WHERE id=?').bind(actionId).run();
    }
  });
});

async function seedOriginWorkspace() {
  const created = await request('/api/workspaces', undefined, { title: 'Origin Notice', purpose: 'Prepare changed presentation' });
  const cookie = cookieFrom(created);
  const workspace = await created.json() as WorkspaceView;
  const snapshot = originSnapshot();
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO sources(id,workspace_id,source_revision,title,relation,target_source_id,hash,text,created_at) VALUES(?,?,1,?,"initial",NULL,?,?,?)')
      .bind(sourceId, workspace.id, '변경 안내문', await sha256Hex(noticeText), noticeText, '2026-09-15T00:00:00.000Z'),
    testEnv.DB.prepare('INSERT INTO snapshots(workspace_id,revision,snapshot_json,reason,created_at) VALUES(?,1,?,"manual_edit",?)')
      .bind(workspace.id, JSON.stringify(snapshot), '2026-09-15T00:00:00.000Z'),
    testEnv.DB.prepare('UPDATE workspaces SET revision=1,source_revision=1,current_snapshot_revision=1,updated_at=? WHERE id=?')
      .bind('2026-09-15T00:00:00.000Z', workspace.id),
  ]);
  return { cookie, workspace: await getWorkspace(cookie, workspace.id) };
}

function originSnapshot(): Snapshot {
  return {
    facts: [{
      id: 'fact_notice_target_time',
      key: 'notice_target_time',
      label: '발표 변경 시간',
      value: '2026-09-17T16:00-2026-09-17T17:00',
      evidence: { sourceId, quote: noticeText, start: 0, end: noticeText.length },
      semantic: null,
    }],
    blocks: [{
      id: 'block_schedule',
      key: 'schedule',
      type: 'schedule',
      title: '일정',
      items: [{
        id: targetItemId,
        key: 'presentation',
        label: '발표',
        value: '2026-09-17T16:00-2026-09-17T17:00',
        factKeys: ['notice_target_time'],
        valueFactKey: 'notice_target_time',
        calculation: null,
        completed: false,
        locked: false,
        edited: false,
        stale: false,
      }],
    }],
  };
}

function noticeCommand(workspace: WorkspaceView): NoticeRecoveryRequest {
  return {
    requestId: crypto.randomUUID(),
    baseRevision: workspace.revision,
    baseSourceRevision: workspace.sourceRevision,
    sourceId,
    targetItemId,
    targetBefore: { start: '2026-09-17T16:00', end: '2026-09-17T17:00' },
    targetAfter: { start: '2026-09-17T18:00', end: '2026-09-17T19:00' },
    preparation: {
      itemId: null,
      title: '발표 자료 점검',
      before: { start: '2026-09-17T14:00', end: '2026-09-17T15:00' },
      durationMinutes: 60,
      deadline: '2026-09-17T18:00',
    },
    travelMinutes: 30,
    horizon: { start: '2026-09-17T13:00', end: '2026-09-18T13:00' },
    workWindows: [{ label: '확인한 가능 시간', start: '2026-09-17T13:00', end: '2026-09-17T20:00' }],
    commitments: [],
    extraBusy: [],
    confirmed: true,
  };
}

async function getWorkspace(cookie: string, id: string) {
  return (await request(`/api/workspaces/${id}`, cookie)).json() as Promise<WorkspaceView>;
}

function request(path: string, cookie?: string, body?: unknown, method = body ? 'POST' : 'GET') {
  return app.request(`${origin}${path}`, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, testEnv);
}

function cookieFrom(response: Response): string {
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

async function scalar(sql: string, ...bindings: unknown[]): Promise<number> {
  return Number(await testEnv.DB.prepare(sql).bind(...bindings).first('COUNT(*)'));
}

async function originStorageState(workspaceId: string) {
  return testEnv.DB.prepare(`SELECT w.revision,w.source_revision,w.current_snapshot_revision,w.pending_changeset_json,
      (SELECT COUNT(*) FROM sources WHERE workspace_id=w.id) AS sources,
      (SELECT COUNT(*) FROM snapshots WHERE workspace_id=w.id) AS snapshots,
      (SELECT COUNT(*) FROM runs WHERE workspace_id=w.id) AS runs
    FROM workspaces w WHERE w.id=?`)
    .bind(workspaceId)
    .first();
}

async function ownerIdFromCookie(cookie: string): Promise<string> {
  const token = decodeURIComponent(cookie.split('=')[1]!);
  const owner = await testEnv.DB.prepare('SELECT id FROM owners WHERE token_hash=?')
    .bind(await sha256Hex(token))
    .first<{ id: string }>();
  if (!owner) throw new Error('missing owner');
  return owner.id;
}

async function seedQueuedCalendarAction(input: {
  ownerId: string;
  accountId: string;
  connectionId: string;
  workspaceId: string;
  baseRevision: number;
  actionId?: string;
  progressJson?: string;
  resultHash?: string;
  events?: ReadonlyArray<{ itemId: string; eventId: string; write: CalendarEventWrite }>;
}) {
  const now = '2026-09-15T00:00:00.000Z';
  const payload = {
    version: 1,
    kind: 'calendar',
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    accountId: input.accountId,
    connectionId: input.connectionId,
    connectionVersion: 1,
    calendarId: 'cal_notice_preflight',
    baseRevision: input.baseRevision,
    sourceRevision: 2,
    conditionRevision: 1,
    resultHash: input.resultHash ?? 'not-read-before-origin-guard',
    events: [...(input.events ?? [])],
    freeBusy: { timeMin: '2026-09-17T13:00:00+09:00', timeMax: '2026-09-18T13:00:00+09:00', calendarIds: ['primary', 'cal_notice_preflight'] },
  };
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO app_accounts(id,created_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING').bind(input.accountId, now),
    testEnv.DB.prepare('UPDATE owners SET account_id=? WHERE id=?').bind(input.accountId, input.ownerId),
    testEnv.DB.prepare(`INSERT INTO calendar_connections(id,account_id,provider,provider_subject,provider_email,status,auth_version,calendar_id,calendar_summary,scopes_json,created_at,updated_at)
      VALUES(?,?,'google',?,?, 'connected',1,'cal_notice_preflight','Ieojim','[]',?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(input.connectionId, input.accountId, 'subject-notice', 'notice@example.test', now, now),
    testEnv.DB.prepare(`INSERT INTO recovery_actions(id,workspace_id,owner_id,account_id,request_id,connection_id,connection_version,base_revision,source_revision,condition_revision,kind,payload_json,payload_hash,status,progress_json,message,attempts,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,'queued',0,?,?)`)
      .bind(input.actionId ?? 'act_notice_calendar', input.workspaceId, input.ownerId, input.accountId, crypto.randomUUID(), input.connectionId, 1, input.baseRevision, 2, 1, 'calendar', JSON.stringify(payload), await jsonHash(payload), input.progressJson ?? '{}', now, now),
  ]);
}

function progressPayloadEvent(itemId: string): { itemId: string; eventId: string; write: CalendarEventWrite } {
  const eventId = 'evt_notice_progress';
  return {
    itemId,
    eventId,
    write: {
      id: eventId,
      summary: 'Progress validation',
      description: 'progress validation fixture',
      start: { dateTime: '2026-09-17T18:00:00+09:00', timeZone: 'Asia/Seoul' },
      end: { dateTime: '2026-09-17T19:00:00+09:00', timeZone: 'Asia/Seoul' },
      extendedProperties: { private: { ieojimOperationId: 'progress-validation', ieojimPayloadHash: '1'.repeat(64) } },
    },
  };
}
