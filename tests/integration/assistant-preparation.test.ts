/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceView } from '../../src/core/contracts';
import { workspaceExportSchema, type WorkspaceExport } from '../../src/core/export-contracts';
import { sha256Hex } from '../../src/server/crypto';
import { createApp } from '../../src/server/app';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
type Preparation = { version: 1; dueDate: string | null; durationMinutes: number | null };
type ItemView = WorkspaceView['snapshot']['blocks'][number]['items'][number] & { preparation?: Preparation };

type ApiResult<T = unknown> = { response: Response; body: T };

const app = createApp();
const testEnv = env as TestEnv;

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('assistant preparation checklist metadata', () => {
  it('stores metadata-only checklist patches, reloads them, and replays the same request idempotently', async () => {
    const { workspace, cookie } = await createTravelWorkspace();
    const item = checklistItem(workspace, 'confirm_arrival');
    const request = {
      baseRevision: workspace.revision,
      requestId: '10101010-1010-4010-8010-101010101010',
      itemId: item.id,
      preparation: { version: 1, dueDate: '2026-09-21', durationMinutes: 45 },
    };

    const edited = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, request, cookie);
    expect(edited.response.status).toBe(200);
    expect(preparationOf(edited.body, item.id)).toEqual(request.preparation);
    expect(itemById(edited.body, item.id)).toMatchObject({ label: item.label, value: item.value, completed: item.completed, locked: item.locked });

    const reloaded = await get<WorkspaceView>(`/api/workspaces/${workspace.id}`, cookie);
    expect(reloaded.response.status).toBe(200);
    expect(preparationOf(reloaded.body, item.id)).toEqual(request.preparation);

    const replay = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, request, cookie);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(edited.body);
  });

  it('rejects the same requestId with a different preparation payload', async () => {
    const { workspace, cookie } = await createTravelWorkspace();
    const item = checklistItem(workspace, 'confirm_arrival');
    const requestId = '11111111-1111-4111-8111-111111111110';

    const first = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId,
      itemId: item.id,
      preparation: { version: 1, dueDate: '2026-09-21', durationMinutes: 45 },
    }, cookie);
    expect(first.response.status).toBe(200);

    const conflict = await patch(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId,
      itemId: item.id,
      preparation: { version: 1, dueDate: '2026-09-22', durationMinutes: 45 },
    }, cookie);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('rejects stale base revisions without writing a preparation snapshot', async () => {
    const { workspace, cookie } = await createTravelWorkspace();
    const item = checklistItem(workspace, 'confirm_arrival');

    const current = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId: '12121212-1212-4212-8212-121212121210',
      itemId: item.id,
      completed: true,
    }, cookie);
    expect(current.response.status).toBe(200);

    const stale = await patch(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId: '13131313-1313-4313-8313-131313131310',
      itemId: item.id,
      preparation: { version: 1, dueDate: '2026-09-21', durationMinutes: 30 },
    }, cookie);
    expect(stale.response.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'STALE_REVISION' } });

    const reloaded = await get<WorkspaceView>(`/api/workspaces/${workspace.id}`, cookie);
    expect(itemById(reloaded.body, item.id)).not.toHaveProperty('preparation');
  });

  it('blocks preparation edits from a different owner', async () => {
    const { workspace } = await createTravelWorkspace();
    const foreign = await post<WorkspaceView>('/api/workspaces/sample', { scenario: 'travel' });
    const foreignCookie = cookieFrom(foreign.response);
    const item = checklistItem(workspace, 'confirm_arrival');

    const blocked = await patch(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId: '14141414-1414-4414-8414-141414141410',
      itemId: item.id,
      preparation: { version: 1, dueDate: '2026-09-21', durationMinutes: 45 },
    }, foreignCookie);

    expect(blocked.response.status).toBe(404);
    expect(blocked.body).toMatchObject({ error: { code: 'WORKSPACE_NOT_FOUND' } });
  });

  it.each([
    ['bad date', { version: 1, dueDate: '2026-02-30', durationMinutes: 45 }],
    ['bad duration low', { version: 1, dueDate: '2026-09-21', durationMinutes: 0 }],
    ['bad duration high', { version: 1, dueDate: '2026-09-21', durationMinutes: 1441 }],
    ['bad version', { version: 2, dueDate: '2026-09-21', durationMinutes: 45 }],
  ])('rejects invalid preparation metadata: %s', async (_case, preparation) => {
    const { workspace, cookie } = await createTravelWorkspace();
    const item = checklistItem(workspace, 'confirm_arrival');

    const rejected = await patch(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId: crypto.randomUUID(),
      itemId: item.id,
      preparation,
    }, cookie);

    expect(rejected.response.status).toBe(422);
  });

  it('rejects preparation metadata on non-checklist items and normalizes all-null preparation to clear', async () => {
    const { workspace, cookie } = await createTravelWorkspace();
    const checklist = checklistItem(workspace, 'confirm_arrival');
    const schedule = itemFromBlock(workspace, 'schedule', 'arrival_day1');

    const nonChecklist = await patch(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId: '15151515-1515-4515-8515-151515151510',
      itemId: schedule.id,
      preparation: { version: 1, dueDate: '2026-09-21', durationMinutes: 45 },
    }, cookie);
    expect(nonChecklist.response.status).toBe(422);

    const set = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId: '16161616-1616-4616-8616-161616161610',
      itemId: checklist.id,
      preparation: { version: 1, dueDate: '2026-09-21', durationMinutes: 45 },
    }, cookie);
    expect(set.response.status).toBe(200);

    const cleared = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: set.body.revision,
      requestId: '17171717-1717-4717-8717-171717171710',
      itemId: checklist.id,
      preparation: { version: 1, dueDate: null, durationMinutes: null },
    }, cookie);
    expect(cleared.response.status).toBe(200);
    expect(itemById(cleared.body, checklist.id)).not.toHaveProperty('preparation');
  });

  it('preserves preparation metadata through export and snapshot restore', async () => {
    const { workspace, cookie } = await createTravelWorkspace();
    const item = checklistItem(workspace, 'confirm_arrival');
    const preparation = { version: 1, dueDate: '2026-09-21', durationMinutes: 45 };

    const prepared = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId: '18181818-1818-4818-8818-181818181810',
      itemId: item.id,
      preparation,
    }, cookie);
    expect(prepared.response.status).toBe(200);

    const exported = await get<WorkspaceExport>(`/api/workspaces/${workspace.id}/export`, cookie);
    expect(exported.response.status).toBe(200);
    const parsedExport = workspaceExportSchema.parse(exported.body);
    const exportedItem = itemById({ ...prepared.body, snapshot: parsedExport.content.snapshot }, item.id);
    expect(exportedItem.preparation).toEqual({ version: 1, dueDate: '2026-09-21', durationMinutes: 45 });
    expect(parsedExport.checksum).toMatchObject({
      algorithm: 'SHA-256',
      encoding: 'JSON.stringify(content), UTF-8',
      value: await sha256Hex(JSON.stringify(parsedExport.content)),
    });

    const changed = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: prepared.body.revision,
      requestId: '19191919-1919-4919-8919-191919191910',
      itemId: item.id,
      value: '임시로 바꾼 준비 문구',
    }, cookie);
    expect(changed.response.status).toBe(200);

    const restored = await post<WorkspaceView>(`/api/workspaces/${workspace.id}/restore`, {
      revision: prepared.body.revision,
      baseRevision: changed.body.revision,
      requestId: '20202020-2020-4020-8020-202020202010',
    }, cookie);
    expect(restored.response.status).toBe(200);
    expect(preparationOf(restored.body, item.id)).toEqual(preparation);
    expect(itemById(restored.body, item.id).value).toBe(item.value);
  });

  it('preserves user-owned preparation metadata after a source correction and accepted fixture proposal', async () => {
    const { workspace, cookie } = await createTravelWorkspace();
    const item = checklistItem(workspace, 'confirm_arrival');
    const preparation = { version: 1, dueDate: '2026-09-21', durationMinutes: 45 };

    const prepared = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId: '21212121-2121-4121-8121-212121212110',
      itemId: item.id,
      preparation,
    }, cookie);
    expect(prepared.response.status).toBe(200);

    const correction = await post<WorkspaceView>(`/api/workspaces/${workspace.id}/sources`, {
      title: '도착 준비 정정',
      text: '합성 정정입니다. 도착 준비 담당자는 그대로 유지합니다.',
      relation: 'correction',
      targetSourceId: firstSourceId(prepared.body),
      requestId: '22222222-2222-4222-8222-222222222210',
    }, cookie);
    expect(correction.response.status).toBe(200);
    expect(preparationOf(correction.body, item.id)).toEqual(preparation);

    const proposed = await post<WorkspaceView>(`/api/workspaces/${workspace.id}/sample-update`, {
      step: 'update',
      requestId: '23232323-2323-4323-8323-232323232310',
    }, cookie);
    expect(proposed.response.status).toBe(200);
    expect(proposed.body.pending).not.toBeNull();

    const applied = await post<WorkspaceView>(`/api/workspaces/${workspace.id}/apply`, {
      changeSetId: proposed.body.pending?.id,
      proposalRevision: proposed.body.pending?.proposalRevision,
      baseRevision: proposed.body.revision,
      baseSourceRevision: proposed.body.sourceRevision,
      requestId: '24242424-2424-4424-8424-242424242410',
      resolutions: [],
    }, cookie);
    expect(applied.response.status).toBe(200);
    const preserved = itemFromBlock(applied.body, 'checklist', 'confirm_arrival');
    expect(preserved.value).toContain('오후 4시');
    expect(preserved.preparation).toEqual(preparation);
  });

  it('keeps stale review on preparation-only edits and clears it only with explicit acknowledgement', async () => {
    const { workspace, cookie } = await createTravelWorkspace();
    const item = checklistItem(workspace, 'confirm_arrival');

    const prepared = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: workspace.revision,
      requestId: '25252525-2525-4525-8525-252525252510',
      itemId: item.id,
      preparation: { version: 1, dueDate: '2026-09-21', durationMinutes: 45 },
    }, cookie);
    expect(prepared.response.status).toBe(200);

    const proposed = await post<WorkspaceView>(`/api/workspaces/${workspace.id}/sample-update`, {
      step: 'update',
      requestId: '26262626-2626-4626-8626-262626262610',
    }, cookie);
    expect(proposed.response.status).toBe(200);

    const applied = await post<WorkspaceView>(`/api/workspaces/${workspace.id}/apply`, {
      changeSetId: proposed.body.pending?.id,
      proposalRevision: proposed.body.pending?.proposalRevision,
      baseRevision: proposed.body.revision,
      baseSourceRevision: proposed.body.sourceRevision,
      requestId: '27272727-2727-4727-8727-272727272710',
      resolutions: [],
    }, cookie);
    expect(applied.response.status).toBe(200);
    expect(itemById(applied.body, item.id)).toMatchObject({ stale: true, preparation: { version: 1, dueDate: '2026-09-21', durationMinutes: 45 } });

    const preparationOnly = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: applied.body.revision,
      requestId: '28282828-2828-4828-8828-282828282810',
      itemId: item.id,
      preparation: { version: 1, dueDate: '2026-09-22', durationMinutes: 60 },
    }, cookie);
    expect(preparationOnly.response.status).toBe(200);
    expect(itemById(preparationOnly.body, item.id)).toMatchObject({ stale: true, preparation: { version: 1, dueDate: '2026-09-22', durationMinutes: 60 } });

    const acknowledged = await patch<WorkspaceView>(`/api/workspaces/${workspace.id}/items`, {
      baseRevision: preparationOnly.body.revision,
      requestId: '29292929-2929-4929-8929-292929292910',
      itemId: item.id,
      acknowledgeReview: true,
    }, cookie);
    expect(acknowledged.response.status).toBe(200);
    expect(itemById(acknowledged.body, item.id)).toMatchObject({
      stale: false,
      preparation: { version: 1, dueDate: '2026-09-22', durationMinutes: 60 },
      completed: item.completed,
      locked: item.locked,
      edited: item.edited,
    });
  });
});

async function createTravelWorkspace(): Promise<{ workspace: WorkspaceView; cookie: string }> {
  const created = await post<WorkspaceView>('/api/workspaces/sample', { scenario: 'travel' });
  expect(created.response.status).toBe(201);
  return { workspace: created.body, cookie: cookieFrom(created.response) };
}

async function get<T = unknown>(path: string, cookie?: string): Promise<ApiResult<T>> {
  const response = await app.request(`http://local.test${path}`, { headers: cookie ? { cookie } : undefined }, testEnv);
  return { response, body: await json<T>(response) };
}

async function post<T = unknown>(path: string, body: unknown, cookie?: string): Promise<ApiResult<T>> {
  const response = await app.request(`http://local.test${path}`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(body),
  }, testEnv);
  return { response, body: await json<T>(response) };
}

async function patch<T = unknown>(path: string, body: unknown, cookie?: string): Promise<ApiResult<T>> {
  const response = await app.request(`http://local.test${path}`, {
    method: 'PATCH',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(body),
  }, testEnv);
  return { response, body: await json<T>(response) };
}

function jsonHeaders(cookie?: string): HeadersInit {
  return {
    'content-type': 'application/json',
    origin: 'http://local.test',
    ...(cookie ? { cookie } : {}),
  };
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toBeTruthy();
  return cookie?.split(';')[0] ?? '';
}

async function json<T>(response: Response): Promise<T> {
  if (response.status === 204) return {} as T;
  return await response.json() as T;
}

function checklistItem(workspace: WorkspaceView, key: string): ItemView {
  return itemFromBlock(workspace, 'checklist', key);
}

function itemFromBlock(workspace: WorkspaceView, type: string, key: string): ItemView {
  const item = workspace.snapshot.blocks.find((block) => block.type === type)?.items.find((candidate) => candidate.key === key) as ItemView | undefined;
  expect(item).toBeTruthy();
  return item as ItemView;
}

function itemById(workspace: WorkspaceView, itemId: string): ItemView {
  const item = workspace.snapshot.blocks.flatMap((block) => block.items).find((candidate) => candidate.id === itemId) as ItemView | undefined;
  expect(item).toBeTruthy();
  return item as ItemView;
}

function preparationOf(workspace: WorkspaceView, itemId: string): Preparation | undefined {
  return itemById(workspace, itemId).preparation;
}

function firstSourceId(workspace: WorkspaceView): string {
  const source = workspace.sources[0];
  expect(source).toBeTruthy();
  return source?.id ?? '';
}
