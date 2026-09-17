import { expect, request as playwrightRequest, test } from '@playwright/test';
import { workspaceExportSchema, type WorkspaceExport } from '../../src/core/export-contracts';
import type { Snapshot, Source } from '../../src/core/contracts';

test('remote static assets and API enforce browser security headers without creating an owner', async ({ request, page }) => {
  for (const path of ['/', '/app', '/login', '/settings', '/app/workspaces/not-owned', '/api/config', '/api/workspaces']) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['set-cookie']).toBeUndefined();
    if (path.startsWith('/api/')) expect(headers['cache-control']).toBe('no-store');
    else expect(headers['cache-control']).toContain('no-transform');
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /일정 하나 바뀌었다고/ })).toBeVisible();
  await expect(page.locator('script[src*="cloudflareinsights.com"]')).toHaveCount(0);
  const scriptSource = await page.locator('script[type="module"][src^="/assets/"]').getAttribute('src');
  expect(scriptSource).toBeTruthy();
  const scriptResponse = await request.get(scriptSource!, { headers: { 'Accept-Encoding': 'br, gzip' } });
  expect(scriptResponse.status()).toBe(200);
  expect(scriptResponse.headers()['cache-control']).not.toContain('no-transform');
  expect(['br', 'gzip']).toContain(scriptResponse.headers()['content-encoding']);
  const scene = page.getByTestId('continuity-scene');
  await scene.getByRole('button', { name: '변경 흐름 재생' }).click();
  await expect(scene).toHaveAttribute('data-scene-state', 'finished');
  await expect(scene).toHaveAttribute('data-scene-mode', 'webgl');
  await expect(scene.locator('canvas')).toHaveCount(1);
  await page.getByRole('link', { name: '체험용 예시 열기', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\?example=departure$/);
  await expect(page.getByRole('heading', { name: /여행 준비,.*여기서 이어가세요/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('remote account routes report provider availability honestly and keep guest entry usable', async ({ page, request }) => {
  const response = await request.get('/api/account');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  const account = await response.json() as { authAvailable: boolean; user: unknown; guestPreview: unknown; retentionDays: number };
  expect(account.user).toBeNull();
  expect(account.guestPreview).toBeNull();
  expect(account.retentionDays).toBe(7);
  expect(typeof account.authAvailable).toBe('boolean');
  await page.goto('/login');
  await expect(page.getByRole('link', { name: '게스트 작업 공간으로 이동' })).toBeVisible();
  if (account.authAvailable) {
    await expect(page.getByRole('button', { name: 'Google 로그인으로 이동' })).toBeEnabled();
  } else {
    await expect(page.getByText('지금은 Google 로그인을 사용할 수 없어요.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Google 로그인으로 이동' })).toHaveCount(0);
  }
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '계정과 게스트 작업 공간' })).toBeVisible();
  await expect(page.getByText('지금은 로그인 없이 사용 중이에요.')).toBeVisible();
});

test('remote guest current export is private no-store attachment with checksum and no internal fields', async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  let workspaceId: string | undefined;
  try {
    const createdResponse = await request.post('/api/workspaces/sample', {
      headers: { Origin: origin },
      data: { scenario: 'travel' },
    });
    expect(createdResponse.status()).toBe(201);
    const created = await createdResponse.json() as RemoteWorkspaceView;
    workspaceId = created.id;
    const firstItem = created.snapshot.blocks.flatMap((block) => block.items).at(0);
    expect(firstItem).toBeTruthy();

    const editedResponse = await request.patch(`/api/workspaces/${workspaceId}/items`, {
      headers: { Origin: origin },
      data: { baseRevision: created.revision, requestId: crypto.randomUUID(), itemId: firstItem!.id, value: '합성 검증: 직접 확정한 도착 안내', locked: true, completed: true },
    });
    expect(editedResponse.status()).toBe(200);
    const edited = await editedResponse.json() as RemoteWorkspaceView;

    const exportResponse = await request.get(`/api/workspaces/${workspaceId}/export`);
    expect(exportResponse.status()).toBe(200);
    expect(exportResponse.headers()['cache-control']).toBe('no-store');
    expect(exportResponse.headers()['content-disposition']).toBe('attachment; filename="ieojim-workspace.json"');
    expect(exportResponse.headers()['x-content-type-options']).toBe('nosniff');
    const exported = workspaceExportSchema.parse(await exportResponse.json());
    expect(exported.format).toBe('ieojim.workspace');
    expect(exported.version).toBe(1);
    expect(exported.content.workspace).toMatchObject({
      id: workspaceId,
      title: edited.title,
      purpose: edited.purpose,
      revision: edited.revision,
      sourceRevision: edited.sourceRevision,
      expiresAt: edited.expiresAt,
    });
    expect(exported.content.sources).toEqual(edited.sources);
    expect(exported.content.snapshot).toEqual(edited.snapshot);
    expect(exported.checksum).toEqual({
      algorithm: 'SHA-256',
      encoding: 'JSON.stringify(content), UTF-8',
      value: await sha256Hex(JSON.stringify(exported.content)),
    });
    expect(exported.content.snapshot.blocks.flatMap((block) => block.items).find((item) => item.id === firstItem!.id))
      .toMatchObject({ value: '합성 검증: 직접 확정한 도착 안내', locked: true, completed: true, edited: true });
    expect(Object.keys(exported.content).sort()).toEqual(['revisions', 'snapshot', 'sources', 'workspace']);
    expectNoInternalExportFields(exported);

    const foreign = await playwrightRequest.newContext({ baseURL });
    try {
      const foreignResponse = await foreign.get(`/api/workspaces/${workspaceId}/export`);
      expect(foreignResponse.status()).toBe(404);
      expect(foreignResponse.headers()['cache-control']).toBe('no-store');
    } finally {
      await foreign.dispose();
    }
  } finally {
    if (workspaceId) {
      const deleteResponse = await request.delete(`/api/workspaces/${workspaceId}`, { headers: { Origin: origin } });
      expect([204, 404]).toContain(deleteResponse.status());
    }
  }
});



type RemoteWorkspaceView = {
  id: string;
  title: string;
  purpose: string;
  revision: number;
  sourceRevision: number;
  sources: Source[];
  snapshot: Snapshot;
  expiresAt: string;
};

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function expectNoInternalExportFields(exported: WorkspaceExport): void {
  const serialized = JSON.stringify(exported);
  for (const forbidden of [
    'owner_id',
    'account_id',
    'token_hash',
    'pending_changeset',
    'pending_changeset_json',
    'pending_proposal_revision',
    'providerId',
    'accountId',
    'accessToken',
    'refreshToken',
    'idToken',
    'budget_ledger',
    'amount_micro_usd',
    'applied_commands',
    'response_json',
    'provenance_json',
  ]) expect(serialized).not.toContain(forbidden);
}
