/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import type { WorkspaceView } from '../../src/core/contracts';
import { createApp } from '../../src/server/app';
const app = createApp();
const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeEach(async () => { await reset(); await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
it('persists completed-source review, exact revision/idempotent reopen and historical restore', async () => {
  let cookie = '';
  async function call(path: string, method = 'GET', body?: unknown, status = 200) {
    const response = await app.request(`http://local.test${path}`, { method, headers: { cookie, origin: 'http://local.test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, testEnv);
    expect(response.status).toBe(status);
    cookie ||= response.headers.get('set-cookie')?.split(';')[0] ?? '';
    return await response.json() as WorkspaceView;
  }
  let view = await call('/api/workspaces/sample', 'POST', { scenario: 'travel' }, 201);
  const path = `/api/workspaces/${view.id}`;
  const itemId = 'item:travel_checklist:confirm_arrival';
  const item = (data: WorkspaceView) => data.snapshot.blocks.flatMap((block) => block.items).find((entry) => entry.id === itemId)!;
  view = await call(`${path}/items`, 'PATCH', { itemId, baseRevision: view.revision, requestId: crypto.randomUUID(), completed: true });
  const original = view;
  view = await call(`${path}/sample-update`, 'POST', { step: 'update', requestId: crypto.randomUUID() });
  view = await call(`${path}/apply`, 'POST', { changeSetId: view.pending!.id, proposalRevision: view.pending!.proposalRevision, baseRevision: view.revision, baseSourceRevision: view.sourceRevision, resolutions: [], requestId: crypto.randomUUID() });
  expect(item(view)).toMatchObject({ completed: true, stale: true });
  expect(item(await call(path))).toEqual(item(view));
  const reviewRevision = view.revision;
  const command = { itemId, baseRevision: view.revision, requestId: crypto.randomUUID(), completed: false, acknowledgeReview: true };
  const reopened = await call(`${path}/items`, 'PATCH', command);
  expect(item(reopened)).toMatchObject({ completed: false, stale: false });
  const replay = await call(`${path}/items`, 'PATCH', command);
  expect(replay).toEqual(reopened);
  await call(`${path}/items`, 'PATCH', { ...command, requestId: crypto.randomUUID(), completed: true }, 409);
  const restoredReview = await call(`${path}/restore`, 'POST', { revision: reviewRevision, baseRevision: reopened.revision, requestId: crypto.randomUUID() });
  expect(item(restoredReview)).toMatchObject({ completed: true, stale: true });
  const restoredOriginal = await call(`${path}/restore`, 'POST', { revision: original.revision, baseRevision: restoredReview.revision, requestId: crypto.randomUUID() });
  expect(item(restoredOriginal)).toEqual(item(original));
  expect(restoredOriginal.revision).toBe(restoredReview.revision + 1);
});
