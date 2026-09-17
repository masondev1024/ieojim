import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { WorkspaceView } from '../../src/core/contracts';
const output = 'artifacts/product-utility-2026-09-16/local';
test.beforeAll(() => mkdirSync(output, { recursive: true }));

for (const width of [1440, 390, 320]) {
  test(`materials preview is honest, keyboard usable and API silent at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const api: string[] = [];
    const model: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url());
      if (request.url().includes('materials-demo-model')) model.push(request.url());
    });
    await page.goto('/');
    const demo = page.locator('.materials-demo');
    await expect(demo.getByRole('button', { name: '바뀐 준비 확인하기' })).toBeVisible();
    expect(model).toEqual([]);
    await page.screenshot({ path: `${output}/landing-${width}.png`, fullPage: true });
    await demo.getByRole('button', { name: '바뀐 준비 확인하기' }).focus();
    await page.keyboard.press('Enter');
    await expect(demo.getByText('이전 완료 · 다시 확인 필요', { exact: true })).toBeVisible();
    await demo.getByRole('button', { name: '다시 할 일로 표시', exact: true }).click();
    await expect(demo.getByRole('status')).toContainText('수정본 검토가 다시 할 일로 바뀌었어요');
    await demo.getByRole('button', { name: '수정본도 확인했어요' }).click();
    await expect(demo.getByRole('status')).toContainText('확인 후 완료 유지');
    await expect(demo.getByRole('status')).toContainText('미리보기');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/materials-result-${width}.png`, fullPage: true });
    await page.locator("#outcome-preview").screenshot({ path: `${output}/materials-detail-${width}.png` });
    expect(api).toEqual([]);
  });
}

test('failed materials module retains a real entry and never invents results', async ({ page }) => {
  await page.route('**/*materials-demo-model*', (route) => route.abort());
  await page.goto('/');
  const demo = page.locator('.materials-demo');
  await demo.getByRole('button', { name: '바뀐 준비 확인하기' }).click();
  await expect(demo.getByRole('alert')).toBeVisible();
  await expect(demo.getByRole('region', { name: '자료 변경 영향' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '내 안내로 시작하기', exact: true }).first()).toHaveAttribute('href', '/app?template=custom');
});

test('completed source changes can be reopened with lost-response replay and survive reload', async ({ page }) => {
  const headers = { origin: 'http://127.0.0.1:5174' };
  const created = await page.request.post('/api/workspaces/sample', { headers, data: { scenario: 'coordination' } });
  expect(created.status()).toBe(201);
  let view = await created.json() as WorkspaceView;
  const path = `/api/workspaces/${view.id}`;
  const itemId = 'item:meeting_preparation:prepare_materials';
  try {
    let response = await page.request.patch(`${path}/items`, { headers, data: { itemId, completed: true, baseRevision: view.revision, requestId: crypto.randomUUID() } });
    expect(response.status()).toBe(200);
    response = await page.request.post(`${path}/sample-update`, { headers, data: { step: 'update', requestId: crypto.randomUUID() } });
    expect(response.status()).toBe(200); view = await response.json() as WorkspaceView;
    response = await page.request.post(`${path}/apply`, { headers, data: { changeSetId: view.pending!.id, proposalRevision: view.pending!.proposalRevision, baseRevision: view.revision, baseSourceRevision: view.sourceRevision, requestId: crypto.randomUUID(), resolutions: view.pending!.conflicts.map((conflict) => ({ conflictId: conflict.id, choice: 'keep_user' })) } });
    expect(response.status()).toBe(200); view = await response.json() as WorkspaceView;
    await page.goto(`/app/workspaces/${view.id}`);
    const row = page.getByRole('article', { name: '준비 항목: 발표자료 정리 · 준비 설정', exact: true });
    await expect(row.getByText('확인 필요', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: '확인했어요, 완료 유지' })).toBeVisible();
    const requests: unknown[] = [];
    await page.route(`**${path}/items`, async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        const committed = await route.fetch(); expect(committed.status()).toBe(200);
        await route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: '테스트 응답 유실' } } });
      } else await route.continue();
    });
    await row.getByRole('button', { name: '다시 할 일로 표시' }).click();
    await expect(row.getByRole('alert')).toBeVisible();
    await row.getByRole('button', { name: '다시 할 일로 표시' }).click();
    await expect(row.getByRole('status')).toHaveText('다시 할 일로 저장됨');
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
    await page.reload();
    await expect(row.getByRole('button', { name: '다시 할 일로 표시' })).toHaveCount(0);
    const saved = await (await page.request.get(path)).json() as WorkspaceView;
    expect(saved.revision).toBe(view.revision + 1);
    expect(saved.snapshot.blocks.flatMap((block) => block.items).find((item) => item.id === itemId)).toMatchObject({ completed: false, stale: false });
    await page.screenshot({ path: `${output}/reopened-workspace.png`, fullPage: true });
  } finally { await page.request.delete(path, { headers }); }
});
