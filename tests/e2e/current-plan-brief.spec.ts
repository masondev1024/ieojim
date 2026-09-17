import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

type ExportPayload = Record<string, unknown> & { checksum: Record<string, unknown> };

test.afterEach(async ({ page }) => {
  await cleanupOwnedWorkspaces(page);
});

test('loads the current-plan brief only after explicit request and keeps pending updates and notes out by default', async ({ page }) => {
  const exportRequests: string[] = [];
  await page.route('**/api/workspaces/*/export', async (route) => {
    exportRequests.push(new URL(route.request().url()).pathname);
    await route.continue();
  });

  await page.goto('/app');
  await startTravelSample(page);
  await expect(page.getByRole('heading', { name: '합성 예시: 제주 가족 여행' })).toBeVisible();
  await expect.poll(() => exportRequests.length).toBe(0);

  await page.getByRole('button', { name: '여행 변경 자료 체험', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('체험용 변경 자료로 검토 화면을 만들었습니다.');
  await expect.poll(() => exportRequests.length).toBe(0);

  await page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true }).click();
  const preview = currentPlanPreview(page);
  await expect(preview).toBeVisible();
  expect(exportRequests).toHaveLength(1);

  const text = await preview.inputValue();
  expect(text).toContain('현재 저장된 계획');
  expect(text).toContain('버전 1');
  expect(text).toContain('오전 10시 도착');
  expect(text).toMatch(/225,?000(?:원)?/);
  expect(text).not.toContain('오후 4시');
  expect(text).not.toContain('300,000원');
  expect(text).not.toContain('300000');
  expect(text).not.toContain('공유 문장');
  expect(text).toContain('메모 1개는 기본 제외했습니다.');
  expect(text).toContain('검토 중인 AI 변경 후보는 포함하지 않았습니다.');
});

test('includes note blocks only after the notes option is deliberately enabled', async ({ page }) => {
  await page.goto('/app');
  await startTravelSample(page);

  await page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true }).click();
  const preview = currentPlanPreview(page);
  await expect(preview).toBeVisible();
  expect(await preview.inputValue()).not.toContain('공유 문장');
  await expect(page.locator('.current-plan-brief').getByRole('status')).toContainText('메모 1개는 제외했습니다.');

  await page.getByLabel('메모 포함').check();
  await expect(page.locator('.current-plan-brief').getByRole('status')).toContainText('메모 1개를 포함했습니다.');
  const text = await preview.inputValue();
  expect(text).toContain('메모');
  expect(text).toContain('공유 문장');
  expect(text).toContain('첫날 오전 10시에 도착하고, 공동 고정비는 4명이 동일하게 나눕니다.');
  expect(text).not.toContain('메모 1개는 기본 제외했습니다.');
});

test('copies the exact preview text from the active workspace export', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/app');
  await startTravelSample(page);
  const workspaceId = activeWorkspaceId(page);
  const exportPaths: string[] = [];
  await page.route('**/api/workspaces/*/export', async (route) => {
    exportPaths.push(new URL(route.request().url()).pathname);
    await route.continue();
  });

  await page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true }).click();
  const preview = currentPlanPreview(page);
  await expect(preview).toContainText('현재 저장된 계획');
  const text = await preview.inputValue();

  await page.getByRole('button', { name: '미리보기 내용 복사', exact: true }).click();
  await expect(page.locator('.current-plan-brief').getByRole('status')).toContainText('현재 저장된 계획을 복사했습니다.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  expect(exportPaths).toEqual([`/api/workspaces/${workspaceId}/export`]);
});

test('saved plan preview stays readable at desktop and narrow mobile sizes', async ({ page }, testInfo) => {
  const capturePrefix = testInfo.project.name === 'chromium' ? '' : `${testInfo.project.name}-`;
  mkdirSync('artifacts/product-desire-2026-09-13', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app');
  await startTravelSample(page);
  await page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true }).click();
  await expect(currentPlanPreview(page)).toContainText('오전 10시 도착');
  await page.screenshot({ path: `artifacts/product-desire-2026-09-13/${capturePrefix}plan-1440.png`, fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(currentPlanPreview(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/product-desire-2026-09-13/${capturePrefix}plan-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: '미리보기 닫기', exact: true }).click();
  await expect(currentPlanPreview(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('keeps the preview selectable and focused when clipboard copy is rejected', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
      },
    });
  });

  await page.goto('/app');
  await startTravelSample(page);
  await page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true }).click();
  const preview = currentPlanPreview(page);
  await expect(preview).toContainText(/225,?000(?:원)?/);

  await page.getByRole('button', { name: '미리보기 내용 복사', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('브라우저가 클립보드 복사를 허용하지 않았습니다.');
  await expect(preview).toBeFocused();
  await expect(preview).toContainText('현재 저장된 계획');
});

test('refuses corrupted or wrong-workspace export responses before showing a preview', async ({ page }) => {
  await page.goto('/app');
  await startTravelSample(page);
  const workspaceId = activeWorkspaceId(page);
  const other = await createSampleWorkspace(page, 'syllabus');
  const currentExport = await readWorkspaceExport(page, workspaceId);
  const otherExport = await readWorkspaceExport(page, other.id);
  const corrupted = {
    ...currentExport,
    checksum: { ...currentExport.checksum, value: '0'.repeat(64) },
  };

  let mode: 'corrupted' | 'wrong-workspace' = 'corrupted';
  await page.route(`**/api/workspaces/${workspaceId}/export`, async (route) => {
    await fulfillJson(route, mode === 'corrupted' ? corrupted : otherExport);
  });

  await page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('체크섬이 맞지 않습니다.');
  await expect(currentPlanPreview(page)).toHaveCount(0);

  mode = 'wrong-workspace';
  await page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('현재 작업 공간과 일치하지 않습니다.');
  await expect(currentPlanPreview(page)).toHaveCount(0);
});

test('ignores a late export response after the workspace revision changes', async ({ page }) => {
  await page.goto('/app');
  await startTravelSample(page);
  const workspaceId = activeWorkspaceId(page);
  const oldExport = await readWorkspaceExport(page, workspaceId);
  let releaseExport: (() => void) | null = null;
  let delayedOnce = false;

  await page.route(`**/api/workspaces/${workspaceId}/export`, async (route) => {
    if (delayedOnce) {
      await route.continue();
      return;
    }
    delayedOnce = true;
    await new Promise<void>((resolve) => { releaseExport = resolve; });
    await fulfillJson(route, oldExport).catch(() => undefined);
  });

  await page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true }).click();
  await expect.poll(() => Boolean(releaseExport)).toBe(true);

  await page.locator('.block-schedule .item').first().getByRole('button', { name: '항목 편집' }).click();
  await page.getByLabel('항목 값').fill('직접 수정한 도착 일정');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('직접 수정한 도착 일정')).toBeVisible();

  releaseExport!();
  await expect(currentPlanPreview(page)).toHaveCount(0);

  await page.getByRole('button', { name: '동행자에게 보낼 계획', exact: true }).click();
  const preview = currentPlanPreview(page);
  await expect(preview).toContainText('직접 수정한 도착 일정');
  expect(await preview.inputValue()).not.toContain('오전 10시 도착');
});

async function startTravelSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: '체험용 여행 예시 시작', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/workspaces\/[^/]+$/);
  await expect(page.getByRole('heading', { name: '합성 예시: 제주 가족 여행', exact: true })).toBeVisible();
}

function currentPlanPreview(page: Page): Locator {
  return page.getByLabel('복사할 현재 저장된 계획 미리보기');
}

function activeWorkspaceId(page: Page): string {
  const match = new URL(page.url()).pathname.match(/\/app\/workspaces\/([^/]+)/);
  const id = match?.[1];
  expect(id).toBeTruthy();
  return id as string;
}

async function createSampleWorkspace(page: Page, scenario: 'travel' | 'syllabus'): Promise<{ id: string }> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post('/api/workspaces/sample', { headers: { Origin: origin }, data: { scenario } });
  expect(response.status()).toBe(201);
  return await response.json() as { id: string };
}

async function readWorkspaceExport(page: Page, workspaceId: string): Promise<ExportPayload> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/export`);
  expect(response.status()).toBe(200);
  return await response.json() as ExportPayload;
}

async function fulfillJson(route: Route, payload: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function cleanupOwnedWorkspaces(page: Page): Promise<void> {
  if (!page.url().startsWith('http')) return;
  const origin = new URL(page.url()).origin;
  const response = await page.request.get('/api/workspaces');
  if (!response.ok()) return;
  const workspaces = await response.json() as Array<{ id: string }>;
  for (const workspace of workspaces) {
    const removed = await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { Origin: origin } });
    expect([204, 404]).toContain(removed.status());
  }
}
