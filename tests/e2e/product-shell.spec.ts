import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

type WorkspaceSummary = { id: string; title: string };

test.beforeAll(() => {
  mkdirSync('artifacts', { recursive: true });
});

test.afterEach(async ({ page }) => {
  await cleanupOwnedWorkspaces(page);
});

test('landing waits for explicit workspace entry before making API requests', async ({ page }) => {
  const apiRequests: string[] = [];
  const eagerSceneRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(`${request.method()} ${url.pathname}`);
    if (isThreeRuntimeRequest(request.url())) eagerSceneRequests.push(request.url());
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '일정 하나 바뀌었다고, 처음부터 다시 짜지 마세요.' })).toBeVisible();
  await expect(page.getByRole('link', { name: '체험용 예시 열기' }).first()).toBeVisible();
  const scene = page.getByTestId('continuity-scene');
  await expect(scene).toHaveAttribute('data-scene-mode', /static|reduced-motion/);
  await page.waitForTimeout(250);
  expect(apiRequests).toEqual([]);
  expect(eagerSceneRequests).toEqual([]);

  const preview = page.locator('.departure-demo');
  await preview.getByRole('button', { name: '출발 전 변경 확인하기', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(preview.getByRole('group', { name: '둘째 날 저녁 선택' })).toBeVisible();
  await expect(preview.getByRole('group', { name: '종이 확인서 출력 선택' })).toBeVisible();
  await expect(preview.getByRole('button', { name: '선택한 결과 비교', exact: true })).toBeDisabled();
  expect(apiRequests).toEqual([]);
  expect(eagerSceneRequests).toEqual([]);

  await page.screenshot({ path: 'artifacts/premium-landing-desktop.png', fullPage: false });
  await scene.getByRole('button', { name: '변경 흐름 재생' }).click();
  await page.waitForTimeout(1_900);
  if ((await scene.getAttribute('data-scene-mode')) === 'webgl' && (await scene.getAttribute('data-scene-state')) === 'finished') {
    await page.screenshot({ path: 'artifacts/premium-landing-webgl.png', fullPage: false });
  }

  await page.getByRole('link', { name: '체험용 예시 열기' }).first().click();

  await expect(page).toHaveURL(/\/app\?example=departure$/);
  await expect(page.getByRole('heading', { name: /여행 준비,.*여기서 이어가세요/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '출발 전날 복합 체험 시작' })).toBeVisible();
  await expect.poll(() => apiRequests.some((entry) => entry.endsWith('/api/config'))).toBe(true);
  await expect.poll(() => apiRequests.some((entry) => entry.endsWith('/api/workspaces'))).toBe(true);
  expect(apiRequests.filter((entry) => entry === 'POST /api/workspaces/sample')).toEqual([]);

  await page.getByRole('button', { name: '출발 전날 복합 체험 시작' }).click();
  await expect(page.getByRole('heading', { name: '합성 예시: 출발 전날 변경' })).toBeVisible();
  expect(apiRequests.filter((entry) => entry === 'POST /api/workspaces/sample')).toHaveLength(1);
});

test('workspace home lists saved workspaces without auto-opening one', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const created = await createWorkspaceViaApi(page, '자동 열림 방지', '홈은 저장된 작업을 선택 목록으로 보여준다.');

  await page.addInitScript((id) => localStorage.setItem('ieojim:selected-workspace', id), created.id);
  await page.goto('/app');

  await expect(page.getByRole('heading', { name: /내 계획,.*여기서 이어가세요/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /자동 열림 방지/ })).toBeVisible();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: '자동 열림 방지' })).toHaveCount(0);
  await expect(page.locator('[data-testid="workspace-app"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="workspace-home"]')).toBeVisible();
  await page.screenshot({ path: 'artifacts/premium-home-desktop.png', fullPage: false });

  await page.getByRole('button', { name: /자동 열림 방지/ }).click();

  await expect(page).toHaveURL(new RegExp(`/app/workspaces/${created.id}$`));
  await expect(page.getByRole('heading', { name: '자동 열림 방지' })).toBeVisible();
});

test('travel entry prepares an editable template and preserves separate drafts without creating on navigation', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.method());
  });
  await page.goto('/');
  await page.getByRole('link', { name: '내 여행 정리하기', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\?template=travel$/);
  await expect(page.getByLabel('작업 이름')).toHaveValue('우리 여행');
  await page.getByLabel('작업 이름').fill('제주 동행');
  await page.getByRole('textbox', { name: '목적', exact: true }).fill('우리 가족의 일정과 비용을 정리한다.');
  await page.getByRole('button', { name: '직접 설정', exact: true }).click();
  await page.getByLabel('작업 이름').fill('과제 모음');
  await page.getByRole('button', { name: '여행 계획', exact: true }).click();
  await expect(page.getByLabel('작업 이름')).toHaveValue('제주 동행');
  await expect(page.getByRole('textbox', { name: '목적', exact: true })).toHaveValue('우리 가족의 일정과 비용을 정리한다.');
  expect(writes).toEqual([]);
  const createResponse = page.waitForResponse((response) => response.url().endsWith('/api/workspaces') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  expect((await createResponse).status()).toBe(201);
  await expect(page.getByRole('heading', { name: '제주 동행', exact: true })).toBeVisible();
  await expect(page.getByTestId('workspace-source')).toBeVisible();
  await page.getByRole('button', { name: '최근 작업 보기', exact: true }).click();
  await expect(page.getByLabel('작업 이름')).toHaveValue('제주 동행');
  await page.getByRole('button', { name: '직접 설정', exact: true }).click();
  await expect(page.getByLabel('작업 이름')).toHaveValue('과제 모음');
  expect(writes).toEqual(['POST']);
});

test('create and sample flows navigate to deep links that survive reload, back, and forward', async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: /내 계획,.*여기서 이어가세요/ })).toBeVisible();

  await page.getByLabel('작업 이름').fill('라우팅 검증');
  await page.getByLabel('목적').fill('생성한 작업의 deep link 이동과 브라우저 히스토리를 검증한다.');
  await page.getByRole('button', { name: '만들기' }).click();

  await expect(page).toHaveURL(/\/app\/workspaces\/[^/]+$/);
  const createdUrl = page.url();
  await expect(page.getByRole('heading', { name: '라우팅 검증' })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(createdUrl);
  await expect(page.getByRole('heading', { name: '라우팅 검증' })).toBeVisible();

  await page.getByRole('button', { name: '최근 작업 보기' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: /내 계획,.*여기서 이어가세요/ })).toBeVisible();

  await page.getByRole('button', { name: '체험용 여행 예시 시작', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/workspaces\/[^/]+$/);
  const sampleUrl = page.url();
  await expect(page.getByRole('heading', { name: '합성 예시: 제주 가족 여행' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: /내 계획,.*여기서 이어가세요/ })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(createdUrl);
  await expect(page.getByRole('heading', { name: '라우팅 검증' })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: /내 계획,.*여기서 이어가세요/ })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(sampleUrl);
  await expect(page.getByRole('heading', { name: '합성 예시: 제주 가족 여행' })).toBeVisible();
});

test('continuity scene remains readable and replayable with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const scene = page.getByTestId('continuity-scene');
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute('data-scene-mode', 'reduced-motion');
  await expect(scene.getByText(/4명.*3명/)).toBeVisible();
  await expect(scene.getByText('DAY 02 · 19:00')).toBeVisible();

  await scene.getByRole('button', { name: '변경 흐름 재생' }).click();

  await expect(scene).toHaveAttribute('data-scene-state', 'finished');
  await expect(sceneValueCard(scene, '1인 비용')).toHaveAttribute('data-state', 'changed');
  await expect(sceneValueCard(scene, '1인 비용').getByText('300,000원', { exact: true })).toBeVisible();

  await scene.getByRole('button', { name: '초기화' }).click();
  await expect(scene).toHaveAttribute('data-scene-state', 'idle');
  await expect(sceneValueCard(scene, '1인 비용').getByText('225,000원', { exact: true })).toBeVisible();
});

test('continuity scene falls back when WebGL is unavailable and still replays the change', async ({ page }) => {
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext as (
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown,
    ) => RenderingContext | null;
    HTMLCanvasElement.prototype.getContext = function getContext(
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown,
    ) {
      if (contextId === 'webgl' || contextId === 'webgl2') return null;
      return originalGetContext.call(this, contextId, options);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  await page.goto('/');

  const scene = page.getByTestId('continuity-scene');
  await expect(scene).toHaveAttribute('data-scene-mode', 'static');
  await expect(scene.getByText(/4명.*3명/)).toBeVisible();
  await expect(sceneValueCard(scene, '1인 비용').getByText('225,000원', { exact: true })).toBeVisible();

  await scene.getByRole('button', { name: '변경 흐름 재생' }).click();

  await expect(scene).toHaveAttribute('data-scene-state', 'finished');
  await expect(sceneValueCard(scene, '1인 비용')).toHaveAttribute('data-state', 'changed');
  await expect(sceneValueCard(scene, '1인 비용').getByText('300,000원', { exact: true })).toBeVisible();
});

test('landing and workspace home do not overflow at 320px mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '일정 하나 바뀌었다고, 처음부터 다시 짜지 마세요.' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: 'artifacts/premium-landing-mobile.png', fullPage: false });

  await page.getByRole('link', { name: '체험용 예시 열기' }).first().click();
  await expect(page.getByRole('heading', { name: /여행 준비,.*여기서 이어가세요/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

async function createWorkspaceViaApi(page: Page, title: string, purpose: string): Promise<WorkspaceSummary> {
  const response = await page.request.post(new URL('/api/workspaces', 'http://127.0.0.1:5174').toString(), {
    data: { title, purpose },
    headers: { Origin: 'http://127.0.0.1:5174' },
  });
  expect(response.status()).toBe(201);
  return await response.json() as WorkspaceSummary;
}

test('scene pauses explicitly and stops work while offscreen', async ({ page }) => {
  await page.goto('/');
  const scene = page.getByTestId('continuity-scene');
  await scene.getByRole('button', { name: '변경 흐름 재생' }).click();
  await scene.getByRole('button', { name: '변경 흐름 일시정지' }).click();
  await expect(scene).toHaveAttribute('data-scene-state', 'paused');
  await page.waitForTimeout(1_800);
  await expect(scene).toHaveAttribute('data-scene-state', 'paused');
  await scene.getByRole('button', { name: '변경 흐름 재생' }).click();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(scene).not.toBeInViewport();
  await expect(scene.locator('canvas')).toHaveCount(0);
  await page.waitForTimeout(1_800);
  await expect(scene).toHaveAttribute('data-scene-state', 'playing');
  await scene.scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('data-scene-state', 'finished');
  await expect(scene.getByText('DAY 02 · 19:00')).toBeVisible();
});

test('failed 3D chunk does not break the scene controls or workspace entry', async ({ page }) => {
  await page.route(/ContinuityCanvas/, (route) => route.abort('failed'));
  await page.goto('/');
  const scene = page.getByTestId('continuity-scene');
  await scene.getByRole('button', { name: '변경 흐름 재생' }).click();
  await expect(scene).toHaveAttribute('data-scene-state', 'finished');
  await expect(scene).toHaveAttribute('data-scene-mode', 'static');
  await expect(sceneValueCard(scene, '1인 비용')).toHaveAttribute('data-state', 'changed');
  await page.getByRole('link', { name: '체험용 예시 열기', exact: true }).first().click();
  await expect(page.getByTestId('workspace-home')).toBeVisible();
});

test('WebGL context loss keeps the readable fallback and guest entry available', async ({ page }) => {
  await page.goto('/');
  const scene = page.getByTestId('continuity-scene');
  await scene.getByRole('button', { name: '변경 흐름 재생' }).click();
  await expect(scene).toHaveAttribute('data-scene-state', 'finished');
  // Context-loss simulation needs an actual GPU or Chromium software WebGL2 context.
  test.skip(await scene.getAttribute('data-scene-mode') !== 'webgl', 'WebGL2 unavailable in this browser; fallback is covered separately.');
  await expect(scene.locator('canvas')).toHaveCount(1);
  const lost = await scene.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    extension?.loseContext();
    return Boolean(extension);
  });
  expect(lost).toBe(true);
  await expect(scene).toHaveAttribute('data-scene-mode', 'static');
  await expect(scene.getByText('DAY 02 · 19:00')).toBeVisible();
  await scene.getByRole('button', { name: '변경 흐름 초기화' }).click();
  await expect(scene).toHaveAttribute('data-scene-state', 'idle');
  await page.getByRole('link', { name: '체험용 예시 열기', exact: true }).first().click();
  await expect(page.getByTestId('workspace-home')).toBeVisible();
});

async function cleanupOwnedWorkspaces(page: Page) {
  if (!page.url().startsWith('http')) return;
  const origin = new URL(page.url()).origin;
  const listResponse = await page.request.get(new URL('/api/workspaces', origin).toString());
  expect(listResponse.status()).toBe(200);
  const workspaces = await listResponse.json() as WorkspaceSummary[];
  for (const workspace of workspaces) {
    const deleteResponse = await page.request.delete(new URL(`/api/workspaces/${workspace.id}`, origin).toString(), {
      headers: { Origin: origin },
    });
    expect([204, 404]).toContain(deleteResponse.status());
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

function sceneValueCard(scene: ReturnType<Page['getByTestId']>, label: string) {
  return scene.locator('article').filter({ hasText: label });
}

function isThreeRuntimeRequest(rawUrl: string): boolean {
  const decoded = decodeURIComponent(rawUrl);
  return decoded.includes('@react-three') || decoded.includes('/three') || decoded.includes('three.module') || decoded.includes('ContinuityCanvas');
}
