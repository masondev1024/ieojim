import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect as baseExpect, type BrowserContext, type Locator, type Page } from '@playwright/test';

type WorkspaceView = {
  id: string;
  title: string;
  sampleScenario: 'travel' | 'syllabus' | 'departure' | null;
  revision: number;
  sourceRevision: number;
  snapshot: {
    blocks: Array<{ type: string; items: Array<{ id: string; label: string; value: string; locked: boolean; completed: boolean; edited?: boolean; stale?: boolean }> }>;
  };
};
type WorkspaceSummary = { id: string };
type CleanupResult = { attempted: number; deleted: number };
type ScreenshotManifestEntry = {
  order: number;
  file: string;
  title: string;
  url: string;
  width: number;
  height: number;
  sha256: string;
  describesSynthetic: true;
  capturedAt: string;
};

const defaultBaseUrl = 'https://ieojim.jungseongheon.org';
const outputDir = path.resolve('artifacts/submission');
const viewport = { width: 1600, height: 900 };
const expect = baseExpect.configure({ timeout: 15_000 });

async function main() {
  const baseUrl = readBaseUrl();
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: baseUrl, viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const createdWorkspaceIds = new Set<string>();
  const pageErrors: string[] = [];
  let cleanupResult: CleanupResult | null = null;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  try {
    await mkdir(outputDir, { recursive: true });
    const screenshots: ScreenshotManifestEntry[] = [];

    await page.goto('/');
    await expect(page.getByRole('heading', { name: '새 안내를 반영해도, 내 결정은 이어집니다.' })).toBeVisible();
    await expect(page.getByText('잠근 저녁과 완료한 종이 확인은 사용자가 선택')).toBeVisible();
    screenshots.push(await capture(page, 1, '01-departure-hero.png', '대표 랜딩: 출발 전날 변경과 보호된 결정'));

    await page.goto('/app?example=departure');
    await expect(page).toHaveURL(/\/app\?example=departure$/);
    await expect(page.getByRole('heading', { name: /여행 준비,.*여기서 이어가세요/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '출발 전날 복합 체험 시작' }).first()).toBeVisible();
    screenshots.push(await capture(page, 2, '02-departure-explicit-start.png', '명시적 시작: 출발 전날 합성 체험 생성 전'));

    const createResponse = page.waitForResponse((response) => response.url().endsWith('/api/workspaces/sample') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '출발 전날 복합 체험 시작' }).first().click();
    const createdResponse = await createResponse;
    expect(createdResponse.status()).toBe(201);
    const created = await createdResponse.json() as WorkspaceView;
    createdWorkspaceIds.add(created.id);
    await expect(page).toHaveURL(new RegExp(`/app/workspaces/${created.id}$`));
    await expect(page.getByRole('heading', { name: '합성 예시: 출발 전날 변경' })).toBeVisible();
    await expect(scheduleItemByText(page, '둘째 날 저녁').getByText('고정')).toBeVisible();
    await expect(checklistItemByText(page, '종이 확인서 출력').getByText('완료')).toBeVisible();
    await expect(noteItem(page).getByText('민지야, 출발 전날 다시 정리된 내용만 보고 움직이면 돼.')).toBeVisible();
    await expect(page.getByRole('button', { name: '출발 전날 정정 안내 불러오기' })).toBeEnabled();
    screenshots.push(await capture(page, 3, '03-departure-seeded-plan.png', '저장된 예시: 잠근 저녁, 완료한 준비, 직접 고친 메모', [], 450));

    const updateResponse = page.waitForResponse((response) => response.url().includes('/sample-update') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '출발 전날 정정 안내 불러오기' }).click();
    expect((await updateResponse).status()).toBe(200);
    await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
    const review = reviewPanel(page);
    await expect(review.getByText('2개 충돌 선택이 남아 있습니다.')).toBeVisible();
    await expect(review.getByRole('group', { name: '둘째 날 저녁 충돌 해결 선택', exact: true })).toBeVisible();
    await expect(review.getByRole('group', { name: '종이 확인서 출력 충돌 해결 선택', exact: true })).toBeVisible();
    await expect(changeRow(page, '둘째 날 저녁').locator('.before-after').getByText('오후 8시 약속')).toBeVisible();
    await expect(review.getByText('종이 확인서 출력 · 출발 전 종이 확인서 출력 → 삭제 요청')).toBeVisible();
    await expect(review.getByRole('button', { name: '검토한 변경 반영' })).toBeDisabled();
    screenshots.push(await capture(page, 4, '04-departure-two-conflicts.png', '변경 검토: 둘째 날 저녁과 종이 확인서 두 선택', [
      review.getByRole('region', { name: '검토 우선순위' }),
      review.getByRole('group', { name: '둘째 날 저녁 충돌 해결 선택', exact: true }),
      review.getByRole('group', { name: '종이 확인서 출력 충돌 해결 선택', exact: true }),
    ]));

    await review.getByRole('group', { name: '둘째 날 저녁 충돌 해결 선택', exact: true }).getByRole('button', { name: '내 결정 유지' }).click();
    await expect(review.getByRole('button', { name: '검토한 변경 반영' })).toBeDisabled();
    await review.getByRole('group', { name: '종이 확인서 출력 충돌 해결 선택', exact: true }).getByRole('button', { name: '원문 기준 사용' }).click();
    await expect(review.getByRole('button', { name: '검토한 변경 반영' })).toBeEnabled();
    const applyResponse = page.waitForResponse((response) => response.url().endsWith(`/api/workspaces/${created.id}/apply`) && response.request().method() === 'POST');
    await review.getByRole('button', { name: '검토한 변경 반영' }).click();
    expect((await applyResponse).status()).toBe(200);
    await expect(page.locator('.status-notice')).toContainText('선택한 기준으로 변경 묶음을 반영했습니다.');
    await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '계획', exact: true }).click();
    await expect(scheduleItemByText(page, '둘째 날 저녁').getByText('오후 7시 약속')).toBeVisible();
    await expect(costItem(page).getByText('300,000원')).toBeVisible();
    await expect(checklistItemByText(page, '종이 확인서 출력')).toHaveCount(0);
    await page.getByLabel('메모 포함').check();
    await page.getByRole('button', { name: '동행자에게 보낼 계획' }).click();
    await expect(page.getByLabel('복사할 현재 저장된 계획 미리보기')).toBeVisible();
    await expect(page.getByLabel('복사할 현재 저장된 계획 미리보기')).toHaveValue(/민지야/);
    screenshots.push(await capture(page, 5, '05-departure-applied-brief.png', '반영 결과: 저녁 유지, 완료 항목 삭제, 현재 계획 브리프'));

    if (pageErrors.length > 0) {
      throw new Error(`Browser errors during submission capture: ${pageErrors.join(' | ')}`);
    }

    cleanupResult = await cleanupOwnedWorkspaces(context, baseUrl);
    await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({
      baseUrl,
      viewport,
      generatedAt: new Date().toISOString(),
      createdWorkspaceIds: [...createdWorkspaceIds],
      cleanup: cleanupResult,
      screenshots,
    }, null, 2));
  } finally {
    try {
      if (!cleanupResult) await cleanupOwnedWorkspaces(context, baseUrl);
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

function readBaseUrl(): string {
  const index = process.argv.indexOf('--base-url');
  if (index === -1) return defaultBaseUrl;
  const value = process.argv[index + 1];
  if (!value) throw new Error('--base-url requires a value');

  const normalized = value.replace(/\/$/, '');
  const url = new URL(normalized);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('--base-url override is limited to loopback hosts; omit it to use authorized staging.');
  }
  return url.origin;
}

async function capture(page: Page, order: number, file: string, title: string, focusTargets: Locator[] = [], scrollY = 0): Promise<ScreenshotManifestEntry> {
  const target = path.join(outputDir, file);
  await page.evaluate(async (y) => {
    await document.fonts.ready;
    window.scrollTo({ top: y, behavior: 'instant' });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, scrollY);
  if (focusTargets.length > 0) {
    const inspector = page.getByTestId('workspace-review');
    await inspector.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
    const inspectorBox = await inspector.boundingBox();
    if (!inspectorBox) throw new Error('Review inspector is not visible.');
    const availableHeight = await inspector.evaluate((element) => element.clientHeight);
    const boxes = await Promise.all(focusTargets.map(async (target) => {
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      if (!box) throw new Error('Screenshot focus target has no visible bounds.');
      return box;
    }));
    const top = Math.min(...boxes.map((box) => box.y));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    if (bottom - top > availableHeight - 120) throw new Error(`Screenshot ${order} focus height ${bottom - top} exceeds the readable inspector.`);
    await inspector.evaluate((element, y) => element.scrollTo({ top: y, behavior: 'instant' }), Math.max(0, top - inspectorBox.y - 60));
    for (const target of focusTargets) await expect(target).toBeInViewport({ ratio: 1 });
  }
  await page.screenshot({ path: target, fullPage: false, animations: 'disabled' });
  const bytes = await readFile(target);
  return {
    order,
    file,
    title,
    url: page.url(),
    width: viewport.width,
    height: viewport.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    describesSynthetic: true,
    capturedAt: new Date().toISOString(),
  };
}

async function cleanupOwnedWorkspaces(context: BrowserContext, baseUrl: string): Promise<CleanupResult> {
  const list = await context.request.get(new URL('/api/workspaces', baseUrl).toString());
  expect(list.status(), 'Owned capture workspace cleanup requires a verified list response').toBe(200);
  const workspaces = await list.json() as WorkspaceSummary[];
  let deleted = 0;
  for (const workspace of workspaces) {
    const response = await context.request.delete(new URL(`/api/workspaces/${workspace.id}`, baseUrl).toString(), {
      headers: { Origin: new URL(baseUrl).origin },
    });
    expect([204, 404]).toContain(response.status());
    if (response.status() === 204) deleted += 1;
  }
  return { attempted: workspaces.length, deleted };
}

function costItem(page: Page): Locator {
  return page.locator('.block-cost .item').filter({ hasText: '인당 고정비' }).first();
}

function noteItem(page: Page): Locator {
  return page.locator('.block-note .item').filter({ hasText: '공유 문장' }).first();
}

function scheduleItemByText(page: Page, text: string): Locator {
  return page.locator('.block-schedule .item').filter({ hasText: text }).first();
}

function checklistItemByText(page: Page, text: string): Locator {
  return page.locator('.block-checklist .item').filter({ hasText: text }).first();
}

function reviewPanel(page: Page): Locator {
  return page.getByRole('complementary', { name: '변경 검토' });
}

function changeRow(page: Page, text: string): Locator {
  return page.locator('.change-row').filter({ has: page.locator('.change-head').getByText(text, { exact: true }) });
}

await main();
