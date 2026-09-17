/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import type { WorkspaceView } from '../../src/core/contracts';
import { COORDINATION_ITEM_KEYS as keys, COORDINATION_SCENARIO as scenario } from '../../src/core/coordination-sample';
import { corePort } from '../../src/server/core-port';
import { WorkspaceStore } from '../../src/server/db';

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const find = (view: WorkspaceView, id: string) => view.snapshot.blocks.flatMap((block) => block.items).find((item) => item.id === id);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

it('persists the corporate scenario, applies both decisions once, and restores preparation as a new revision', async () => {
  const store = new WorkspaceStore(testEnv);
  const owner = { id: 'coordination-owner', token: 'synthetic-owner-token', hash: 'synthetic-owner-hash', isNew: true };
  const created = await store.createSample(owner.id, 'coordination', scenario, corePort, owner);
  const reloaded = await store.getWorkspace(owner.id, created.id);
  expect(reloaded.sampleScenario).toBe('coordination');
  expect(find(reloaded, keys.materials)?.preparation).toEqual({ version: 1, dueDate: '2026-09-17', durationMinutes: 90 });
  await expect(store.getWorkspace('different-owner', created.id)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

  const proposed = await store.createSampleUpdate(owner.id, created.id, 'update', crypto.randomUUID(), scenario, corePort);
  expect(proposed.pending?.conflicts).toHaveLength(2);
  const pending = proposed.pending!;
  const request = {
    changeSetId: pending.id, baseRevision: proposed.revision, baseSourceRevision: proposed.sourceRevision,
    proposalRevision: pending.proposalRevision, requestId: crypto.randomUUID(),
    resolutions: pending.conflicts.map((conflict) => ({ conflictId: conflict.id, choice: 'keep_user' as const })),
  };
  const applied = await store.applyChangeSet(owner.id, created.id, request, corePort);
  expect(await store.applyChangeSet(owner.id, created.id, request, corePort)).toEqual(applied);
  expect(find(applied, keys.materials)).toMatchObject({ value: '2026-09-16 18:00까지 발표자료 정리', stale: true, preparation: { dueDate: '2026-09-17', durationMinutes: 90 } });
  expect(find(applied, keys.briefing)?.value).toBe('2026-09-18 13:00');
  expect(find(applied, keys.print)?.completed).toBe(true);
  const restored = await store.restoreSnapshot(owner.id, created.id, { revision: created.revision, baseRevision: applied.revision, requestId: crypto.randomUUID() });
  expect(restored.revision).toBe(applied.revision + 1);
  expect(restored.sourceRevision).toBe(proposed.sourceRevision);
  expect(find(restored, keys.materials)).toMatchObject({ value: '2026-09-17 18:00까지 발표자료 정리', stale: false, preparation: { dueDate: '2026-09-17', durationMinutes: 90 } });
});
