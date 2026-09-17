/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceView } from '../../src/core/contracts';
import { DEPARTURE_ITEM_KEYS, DEPARTURE_SCENARIO } from '../../src/core/departure-sample';
import { corePort } from '../../src/server/core-port';
import { WorkspaceStore } from '../../src/server/db';
import type { OwnerSession } from '../../src/server/http';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const testEnv = env as TestEnv;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('departure sample persistence', () => {
  it('creates, reloads, updates, applies once, restores content, and enforces owner isolation', async () => {
    const store = new WorkspaceStore(testEnv);
    const created = await store.createSample('owner-departure-a', 'departure', DEPARTURE_SCENARIO, corePort, ownerSession('owner-departure-a'));

    expect(created).toMatchObject({ sampleScenario: 'departure', revision: 1, sourceRevision: 1 });
    expect(created.sources).toHaveLength(1);
    expect(item(created, DEPARTURE_ITEM_KEYS.dinner)).toMatchObject({ value: '오후 7시 약속', locked: true });
    expect(item(created, DEPARTURE_ITEM_KEYS.shareMessage)).toMatchObject({ edited: true, stale: false });
    expect(item(created, DEPARTURE_ITEM_KEYS.paperConfirmation)).toMatchObject({ completed: true });

    const reloaded = await store.getWorkspace('owner-departure-a', created.id);
    expect(reloaded.sampleScenario).toBe('departure');
    expect(item(reloaded, DEPARTURE_ITEM_KEYS.dinner).locked).toBe(true);
    await expect(store.getWorkspace('owner-departure-b', created.id)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND', status: 404 });

    const updated = await store.createSampleUpdate('owner-departure-a', created.id, 'update', requestId(1), DEPARTURE_SCENARIO, corePort);
    expect(updated).toMatchObject({ revision: 1, sourceRevision: 2, sampleScenario: 'departure' });
    expect(updated.sources).toHaveLength(2);
    expect(updated.pending?.conflicts.map((conflict) => conflict.kind).sort()).toEqual(['deletion', 'locked']);
    expect(updated.runs[0]).toMatchObject({ mode: 'fixture', status: 'needs_input' });
    expect(item(updated, DEPARTURE_ITEM_KEYS.dinner).value).toBe('오후 7시 약속');
    expect(item(updated, DEPARTURE_ITEM_KEYS.costShare).value).toBe('225000');
    expect(updated.pending && item({ snapshot: updated.pending.next } as WorkspaceView, DEPARTURE_ITEM_KEYS.costShare).value).toBe('300000');

    await expect(store.createSampleUpdate('owner-departure-b', created.id, 'update', requestId(2), DEPARTURE_SCENARIO, corePort))
      .rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND', status: 404 });

    const pending = updated.pending!;
    const applyInput = {
      changeSetId: pending.id,
      baseRevision: updated.revision,
      baseSourceRevision: updated.sourceRevision,
      proposalRevision: pending.proposalRevision,
      requestId: requestId(3),
      resolutions: pending.conflicts.map((conflict) => ({ conflictId: conflict.id, choice: 'use_source' as const })),
    };
    const applied = await store.applyChangeSet('owner-departure-a', created.id, applyInput, corePort);
    const replayed = await store.applyChangeSet('owner-departure-a', created.id, applyInput, corePort);
    expect(replayed).toEqual(applied);
    expect(applied).toMatchObject({ revision: 2, sourceRevision: 2, pending: null, sampleScenario: 'departure' });
    expect(item(applied, DEPARTURE_ITEM_KEYS.dinner).value).toBe('오후 8시 약속');
    expect(hasItem(applied, DEPARTURE_ITEM_KEYS.paperConfirmation)).toBe(false);
    expect(applied.runs.find((run) => run.id === updated.runs[0]!.id)).toMatchObject({ status: 'applied' });

    const restored = await store.restoreSnapshot('owner-departure-a', created.id, {
      revision: 1,
      baseRevision: applied.revision,
      requestId: requestId(4),
    });
    expect(restored).toMatchObject({ revision: 3, sourceRevision: 2, sampleScenario: 'departure' });
    expect(restored.sources).toHaveLength(2);
    expect(item(restored, DEPARTURE_ITEM_KEYS.dinner)).toMatchObject({ value: '오후 7시 약속', locked: true });
    expect(item(restored, DEPARTURE_ITEM_KEYS.paperConfirmation).completed).toBe(true);
  });
});

const ownerSession = (id: string): OwnerSession => ({
  id,
  token: `${id}-token`,
  hash: `${id}-hash`,
  isNew: true,
});

const requestId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const item = (view: WorkspaceView, id: string) => {
  const found = view.snapshot.blocks.flatMap((block) => block.items).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing item ${id}`);
  return found;
};

const hasItem = (view: WorkspaceView, id: string) =>
  view.snapshot.blocks.flatMap((block) => block.items).some((candidate) => candidate.id === id);
