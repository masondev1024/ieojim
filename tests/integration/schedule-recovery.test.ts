/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceView } from '../../src/core/contracts';
import type { RecoveryView } from '../../src/core/recovery-api-contracts';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';
import { createApp } from '../../src/server/app';

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const app = createApp();
const origin = 'http://127.0.0.1:5174';
const fixture = createRecoveryExample;

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

it('creates a guest recovery workspace through the real app, preserves source lineage, and reloads without model or external calls', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external call'));
  const { cookie, view } = await create();
  expect(view).toMatchObject({ revision: 1, sourceRevision: 1, conditionRevision: 1, applied: false, actions: [], result: { status: 'ready' } });
  const workspace = await getWorkspace(cookie, view.workspaceId);
  expect(new Set(workspace.snapshot.blocks.map((block) => block.type))).toEqual(new Set(['schedule', 'cost', 'checklist', 'note']));
  for (const evidence of view.input.relations.flatMap((relation) => relation.evidence)) {
    const source = workspace.sources.find((entry) => entry.id === evidence.sourceId);
    expect(source?.text.slice(evidence.start, evidence.end)).toBe(evidence.quote);
  }
  expect(await (await request(`/api/workspaces/${view.workspaceId}/recovery`, cookie)).json()).toEqual(view);
  expect((await request(`/api/workspaces/${view.workspaceId}/recovery`)).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
  const calendarStatus = await request('/api/calendar/status');
  expect(calendarStatus.status).toBe(200);
  expect(await calendarStatus.json()).toMatchObject({ status: 'not_configured', configured: false, connectionId: null });
});

it('applies a recomputed proposal exactly once as manual schedule values, retaining observations and protected items', async () => {
  const { cookie, view } = await create();
  const before = await getWorkspace(cookie, view.workspaceId);
  const command = applyCommand(view);
  const response = await request(`/api/workspaces/${view.workspaceId}/recovery/apply`, cookie, command);
  expect(response.status).toBe(200);
  const applied = await response.json() as RecoveryView;
  expect(applied).toMatchObject({ revision: 2, sourceRevision: 1, conditionRevision: 1, applied: true });
  expect(await (await request(`/api/workspaces/${view.workspaceId}/recovery/apply`, cookie, command)).json()).toEqual(applied);
  const after = await getWorkspace(cookie, view.workspaceId);
  expect(after.snapshot.facts).toEqual(before.snapshot.facts);
  const items = after.snapshot.blocks.flatMap((block) => block.items);
  const prep = items.find((item) => item.id === 'item:recovery_schedule:event_presentation_prep');
  expect(prep).toMatchObject({ value: '2026-09-17 15:30 ~ 2026-09-17 17:00', edited: true });
  for (const protectedItem of before.snapshot.blocks.flatMap((block) => block.items).filter((item) => item.locked || item.completed)) {
    expect(items.find((item) => item.id === protectedItem.id)).toEqual(protectedItem);
  }
  const receipts = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE workspace_id=? AND command_type="recovery_apply"').bind(view.workspaceId).first('n');
  expect(receipts).toBe(1);
});

it('persists infeasible edited conditions and invalidates a prior proposal without modifying the snapshot', async () => {
  const { cookie, view } = await create();
  const input = fixture();
  input.change.preparationDurationMinutes = 240;
  const command = { input, baseRevision: 1, conditionRevision: 1, requestId: crypto.randomUUID() };
  const response = await request(`/api/workspaces/${view.workspaceId}/recovery/preview`, cookie, command);
  expect(response.status).toBe(200);
  const updated = await response.json() as RecoveryView;
  expect(updated).toMatchObject({ revision: 1, sourceRevision: 2, conditionRevision: 2, applied: false, result: { status: 'infeasible' } });
  expect(await (await request(`/api/workspaces/${view.workspaceId}/recovery/preview`, cookie, command)).json()).toEqual(updated);
  expect((await request(`/api/workspaces/${view.workspaceId}/recovery/apply`, cookie, applyCommand(view))).status).toBe(422);
  expect((await getWorkspace(cookie, view.workspaceId)).revision).toBe(1);
});

it('rejects stale revisions and direct edits instead of rebuilding a plan over user decisions', async () => {
  const { cookie, view } = await create();
  const edit = await request(`/api/workspaces/${view.workspaceId}/items`, cookie, { baseRevision: 1, requestId: crypto.randomUUID(), itemId: 'item:recovery_schedule:event_expense_admin', value: '직접 정한 새로운 시간' }, 'PATCH');
  expect(edit.status).toBe(200);
  expect((await request(`/api/workspaces/${view.workspaceId}/recovery/apply`, cookie, applyCommand(view))).status).toBe(409);
  const refresh = await request(`/api/workspaces/${view.workspaceId}/recovery/preview`, cookie, { input: fixture(), baseRevision: 2, conditionRevision: 1, requestId: crypto.randomUUID() });
  expect(refresh.status).toBe(409);
  expect(await refresh.json()).toMatchObject({ error: { code: 'STALE_RECOVERY_BASE' } });
});

it('uses applied slots as the next baseline and restores content without claiming to undo external actions', async () => {
  const { cookie, view } = await create();
  await request(`/api/workspaces/${view.workspaceId}/recovery/apply`, cookie, applyCommand(view));
  const input = fixture();
  input.change.preparationDurationMinutes = 60;
  const preview = await request(`/api/workspaces/${view.workspaceId}/recovery/preview`, cookie, { input, baseRevision: 2, conditionRevision: 1, requestId: crypto.randomUUID() });
  expect(preview.status).toBe(200);
  const updated = await preview.json() as RecoveryView;
  expect(updated.input.events.find((event) => event.id === 'event:expense_admin')?.start).toBe('2026-09-17T14:30');
  expect(updated.result.status).toBe('ready');
  const restore = await request(`/api/workspaces/${view.workspaceId}/restore`, cookie, { baseRevision: 2, revision: 1, requestId: crypto.randomUUID() });
  expect(restore.status).toBe(200);
  const reloaded = await (await request(`/api/workspaces/${view.workspaceId}/recovery`, cookie)).json() as RecoveryView;
  expect(reloaded).toMatchObject({ revision: 3, sourceRevision: 2, applied: false });
});

it('rejects forged evidence and unsupported horizon without persisting a guest identity', async () => {
  const input = fixture();
  input.relations[0]!.evidence[0]!.quote = 'forged';
  expect((await request('/api/recovery/workspaces', undefined, { input, requestId: crypto.randomUUID() })).status).toBe(422);
  const tooLong = fixture({ horizon: { start: '2026-09-17T14:00', end: '2026-09-24T14:00' } });
  expect((await request('/api/recovery/workspaces', undefined, { input: tooLong, requestId: crypto.randomUUID() })).status).toBe(422);
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM workspaces').first('COUNT(*)')).toBe(0);
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM owners').first('COUNT(*)')).toBe(0);
});

it('denies external action requests by guests and denies cross-origin mutation', async () => {
  const { cookie, view } = await create();
  const command = { baseRevision: 1, conditionRevision: 1, requestId: crypto.randomUUID(), approved: true };
  expect((await request(`/api/workspaces/${view.workspaceId}/recovery/calendar`, cookie, command)).status).toBe(401);
  const crossOrigin = await app.request(`${origin}/api/recovery/workspaces`, { method: 'POST', headers: { origin: 'https://unrelated.test', 'content-type': 'application/json' }, body: JSON.stringify({ input: fixture(), requestId: crypto.randomUUID() }) }, testEnv);
  expect(crossOrigin.status).toBe(403);
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM recovery_actions').first('COUNT(*)')).toBe(0);
});

async function create() {
  const response = await request('/api/recovery/workspaces', undefined, { input: fixture(), requestId: crypto.randomUUID() });
  const view = await response.json() as RecoveryView;
  expect(response.status, JSON.stringify(view)).toBe(201);
  return { view, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
}

function applyCommand(view: RecoveryView) {
  return { proposalId: view.proposalId, baseRevision: view.revision, conditionRevision: view.conditionRevision, requestId: crypto.randomUUID() };
}

async function getWorkspace(cookie: string, id: string) {
  return (await request(`/api/workspaces/${id}`, cookie)).json() as Promise<WorkspaceView>;
}

function request(path: string, cookie?: string, body?: unknown, method = body ? 'POST' : 'GET') {
  return app.request(`${origin}${path}`, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, testEnv);
}
