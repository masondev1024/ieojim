import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { WorkspaceView } from '../../src/core/contracts';

const evidenceDir = 'artifacts/assistant-preparation-2026-09-14';
test.beforeAll(() => mkdirSync(evidenceDir, { recursive: true }));
test.afterEach(async ({ page }) => {
  const response = await page.request.get('/api/workspaces');
  if (!response.ok()) return;
  const summaries = await response.json() as Array<{ id: string }>;
  for (const workspace of summaries) await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { origin: 'http://127.0.0.1:5174' } });
});

test('corporate entry is read-only until the user creates a real workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.method());
  });
  await page.goto('/assistants');
  await expect(page.getByRole('heading', { name: '미팅 안내가 바뀌어도 준비 업무를 처음부터 다시 짜지 않아요.' })).toBeVisible();
  await expect(page.getByRole('link', { name: '실제 미팅 안내로 시작' })).toHaveAttribute('href', '/app?template=coordination');
  await page.screenshot({ path: `${evidenceDir}/assistant-desktop.png`, fullPage: true });
  await page.getByRole('link', { name: '실제 미팅 안내로 시작' }).click();
  await expect(page.getByLabel('작업 이름', { exact: true })).toHaveValue('외부 미팅 준비');
  expect(writes).toEqual([]);
  const creating = page.waitForResponse((response) => response.url().endsWith('/api/workspaces') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  const response = await creating;
  expect(response.status()).toBe(201);
  const created = await response.json() as WorkspaceView;
  expect(created.sampleScenario).toBeNull();
  expect(created.purpose).toMatch(/미팅/);
  expect(created.sources).toEqual([]);
  expect(created.runs).toEqual([]);
  await expect(page).toHaveURL(new RegExp(`/app/workspaces/${created.id}$`));
});

test('corporate synthetic changes require both choices and preserve preparation across reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await startSample(page);
  const id = page.url().split('/').at(-1)!;
  const initial = await readWorkspace(page, id);
  expect(initial.sampleScenario).toBe('coordination');
  const original = find(initial, 'prepare_materials').preparation;
  expect(original).toEqual({ version: 1, dueDate: '2026-09-17', durationMinutes: 90 });
  await page.getByRole('button', { name: '공유할 계획 확인', exact: true }).click();
  await expect(page.getByLabel('복사할 현재 저장된 계획 미리보기')).toContainText('준비 마감 2026-09-17, 예상 90분');
  await page.getByRole('button', { name: '미리보기 닫기', exact: true }).click();
  await page.screenshot({ path: `${evidenceDir}/workspace-initial.png`, fullPage: true });
  await page.getByRole('button', { name: '고객 미팅 정정 안내 불러오기', exact: true }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  const review = page.getByRole('complementary', { name: '변경 검토' });
  await expect(review.getByRole('button', { name: '확인한 변경 저장' })).toBeDisabled();
  await review.getByRole('group', { name: '사전 보고 확인 선택', exact: true }).getByRole('button', { name: '내 결정 유지' }).click();
  await expect(review.getByRole('button', { name: '확인한 변경 저장' })).toBeDisabled();
  await review.getByRole('group', { name: '인쇄본 확인 확인 선택', exact: true }).getByRole('button', { name: '내 결정 유지' }).click();
  await page.screenshot({ path: `${evidenceDir}/workspace-review.png`, fullPage: true });
  const applying = page.waitForResponse((response) => response.url().endsWith(`/api/workspaces/${id}/apply`) && response.request().method() === 'POST');
  await review.getByRole('button', { name: '확인한 변경 저장' }).click();
  expect((await applying).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('heading', { name: '합성 예시: 고객 미팅 변경', exact: true })).toBeVisible();
  const saved = await readWorkspace(page, id);
  expect(find(saved, 'prepare_materials')).toMatchObject({ preparation: original, stale: true });
  expect(find(saved, 'executive_briefing').value).toBe('2026-09-18 13:00');
  expect(find(saved, 'check_print').completed).toBe(true);
  expect(saved.pending).toBeNull();
  await page.screenshot({ path: `${evidenceDir}/workspace-saved.png`, fullPage: true });
  const materials = page.getByRole('article', { name: '준비 항목: 발표자료 정리 · 준비 설정', exact: true });
  const acknowledgements: Array<{ requestId: string; baseRevision: number; acknowledgeReview?: boolean }> = [];
  await page.route(`**/api/workspaces/${id}/items`, async (route) => {
    const command = route.request().postDataJSON() as typeof acknowledgements[number];
    if (command.acknowledgeReview) {
      acknowledgements.push(command);
      if (acknowledgements.length === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '합성 확인 저장 실패입니다.' } }) });
        return;
      }
    }
    await route.continue();
  });
  await materials.getByRole('button', { name: '준비 내용 확인 완료' }).click();
  await expect(materials.getByRole('alert')).toContainText('확인 완료 저장 실패');
  expect(find(await readWorkspace(page, id), 'prepare_materials').stale).toBe(true);
  const room = page.getByRole('article', { name: '준비 항목: 회의실 확인 · 준비 설정', exact: true });
  await room.getByLabel('예상 시간(분)', { exact: true }).fill('20');
  await room.getByRole('button', { name: '준비 저장', exact: true }).click();
  await expect(room.getByRole('status')).toHaveText('저장됨');
  await materials.getByRole('button', { name: '준비 내용 확인 완료' }).click();
  await expect(materials.getByRole('status')).toHaveText('확인 완료로 저장됨');
  expect(acknowledgements).toHaveLength(2);
  expect(acknowledgements[1]!.baseRevision).toBe(acknowledgements[0]!.baseRevision + 1);
  expect(acknowledgements[1]!.requestId).not.toBe(acknowledgements[0]!.requestId);
  await page.reload();
  await expect(materials.getByRole('button', { name: '준비 내용 확인 완료' })).toHaveCount(0);
  expect(find(await readWorkspace(page, id), 'prepare_materials')).toEqual({ ...find(saved, 'prepare_materials'), stale: false });
});

test('corporate entry stays usable at mobile width without navigation writes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/assistants');
  await expect(page.getByRole('link', { name: '체험용 고객 미팅 보기', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidenceDir}/assistant-mobile.png`, fullPage: true });
  await page.getByRole('link', { name: '체험용 고객 미팅 보기', exact: true }).click();
  await expect(page.getByRole('button', { name: /고객 미팅.*체험/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const response = await page.request.get('/api/workspaces');
  expect(await response.json()).toHaveLength(0);
  await page.getByRole('button', { name: /고객 미팅.*체험/ }).click();
  await expect(page.getByRole('region', { name: '준비 업무', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidenceDir}/workspace-mobile.png`, fullPage: true });
});

test('preparation saves only acknowledged values, retains failed input and another row draft', async ({ page }) => {
  await startSample(page);
  const id = page.url().split('/').at(-1)!;
  const materials = page.getByRole('article', { name: '준비 항목: 발표자료 정리 · 준비 설정', exact: true });
  const room = page.getByRole('article', { name: '준비 항목: 회의실 확인 · 준비 설정', exact: true });
  await materials.getByLabel('예상 시간(분)', { exact: true }).fill('75');
  await room.getByLabel('예상 시간(분)', { exact: true }).fill('25');
  const requests: Array<{ requestId: string; preparation: unknown }> = [];
  await page.route(`**/api/workspaces/${id}/items`, async (route) => {
    requests.push(route.request().postDataJSON() as { requestId: string; preparation: unknown });
    if (requests.length === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '합성 저장 실패입니다.' } }) });
    else await route.continue();
  });
  const failing = page.waitForResponse((response) => response.url().endsWith(`/api/workspaces/${id}/items`) && response.status() === 503);
  await materials.getByRole('button', { name: '준비 저장', exact: true }).click();
  await failing;
  await expect(materials.getByLabel('예상 시간(분)', { exact: true })).toHaveValue('75');
  expect(find(await readWorkspace(page, id), 'prepare_materials').preparation?.durationMinutes).toBe(90);
  const saving = page.waitForResponse((response) => response.url().endsWith(`/api/workspaces/${id}/items`) && response.status() === 200);
  await materials.getByRole('button', { name: '준비 저장', exact: true }).click();
  await saving;
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(find(await readWorkspace(page, id), 'prepare_materials').preparation?.durationMinutes).toBe(75);
  await expect(room.getByLabel('예상 시간(분)', { exact: true })).toHaveValue('25');
  await page.reload();
  await expect(page.getByRole('heading', { name: '합성 예시: 고객 미팅 변경', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '준비 항목: 발표자료 정리 · 준비 설정', exact: true }).getByLabel('예상 시간(분)', { exact: true })).toHaveValue('75');
});

test('clearing preparation retries a lost response without creating another revision', async ({ page }) => {
  await startSample(page);
  const id = page.url().split('/').at(-1)!;
  const before = await readWorkspace(page, id);
  const materials = page.getByRole('article', { name: '준비 항목: 발표자료 정리 · 준비 설정', exact: true });
  const requests: unknown[] = [];
  await page.route(`**/api/workspaces/${id}/items`, async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '합성 응답 유실입니다.' } }) });
    } else await route.continue();
  });
  await materials.getByRole('button', { name: '준비 설정 비우기' }).click();
  await expect(materials.getByRole('alert')).toContainText('저장 실패');
  expect((await readWorkspace(page, id)).revision).toBe(before.revision + 1);
  await materials.getByRole('button', { name: '준비 설정 비우기' }).click();
  await expect(materials.getByRole('status')).toHaveText('저장됨');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  const after = await readWorkspace(page, id);
  expect(after.revision).toBe(before.revision + 1);
  expect(find(after, 'prepare_materials').preparation).toBeUndefined();
});

async function startSample(page: Page) {
  await page.goto('/app?example=coordination');
  await page.getByRole('button', { name: /고객 미팅.*체험/ }).click();
  await expect(page.getByRole('heading', { name: '합성 예시: 고객 미팅 변경', exact: true })).toBeVisible();
}
async function readWorkspace(page: Page, id: string): Promise<WorkspaceView> {
  const response = await page.request.get(`/api/workspaces/${id}`);
  expect(response.status()).toBe(200);
  return await response.json() as WorkspaceView;
}
function find(view: WorkspaceView, key: string) {
  const item = view.snapshot.blocks.flatMap((block) => block.items).find((entry) => entry.key === key);
  expect(item).toBeDefined();
  return item!;
}
