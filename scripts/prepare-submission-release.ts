import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect as baseExpect, type Page } from '@playwright/test';
import type { WorkspaceView } from '../src/core/contracts';

// Each capture owns a fresh guest context. Never uses the operator's account data.
const origin = 'https://ieojim.jungseongheon.org';
const outputDir = 'artifacts/submission-release-2026-09-15/images';
const viewport = { width: 1600, height: 900 };
const expect = baseExpect.configure({ timeout: 15_000 });
const screenshots: Array<{ file: string; title: string; url: string; sha256: string; capturedAt: string; width: number; height: number; synthetic: true }> = [];

async function capture(page: Page, file: string, title: string, top = 0) {
  await page.evaluate(async (scrollTop) => {
    await document.fonts.ready;
    window.scrollTo({ top: scrollTop, behavior: 'instant' });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, top);
  const destination = `${outputDir}/${file}`;
  await page.screenshot({ path: destination, fullPage: false, animations: 'disabled' });
  screenshots.push({ file, title, url: page.url(), sha256: createHash('sha256').update(await readFile(destination)).digest('hex'), capturedAt: new Date().toISOString(), ...viewport, synthetic: true });
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: origin, viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const createdIds = new Set<string>();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500 && new URL(response.url()).origin === origin) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  let cleanup = false;
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('내 결정은 이어집니다.');
    await expect(page.getByRole('link', { name: '꽉 찬 일정 수습해 보기', exact: true })).toBeVisible();
    await capture(page, '01-hero.png', '업무·학업·생활의 변경 안내와 보호할 결정');

    await page.goto('/recovery');
    await expect(page.getByRole('heading', { name: '바뀐 일정과 지켜진 약속' })).toBeVisible();
    await page.getByRole('button', { name: '다음 목·금으로 새 체험', exact: true }).click();
    const deadline = await page.getByLabel('자료 제출 마감', { exact: true }).inputValue();
    expect(Date.parse(`${deadline}:00+09:00`)).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);
    const after = page.getByRole('region', { name: '조건을 만족하는 수습안', exact: true }).first();
    await expect(after.locator('article[data-moved="true"]')).toHaveCount(4);
    const boardTop = await page.locator('.recovery-grid').evaluate((element) => element.getBoundingClientRect().top + window.scrollY - 20);
    await capture(page, '02-recovery-chain.png', '발표 변경이 준비·이동·경비 일정으로 이어지는 네 가지 재배치', boardTop);

    await page.getByLabel('목요일 14:30 창 사용 가능').uncheck();
    await expect(page.getByRole('button', { name: '작업 공간으로 저장' })).toBeDisabled();
    await expect(page.getByRole('heading', { name: '지금 조건에서는 승인할 수 없습니다.' })).toBeVisible();
    await capture(page, '03-recovery-blocked.png', '조건을 만족할 수 없을 때 기존 일정을 보존하고 승인 차단', boardTop);

    await page.goto('/app?example=coordination');
    const creating = page.waitForResponse((response) => response.url().endsWith('/api/workspaces/sample') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '고객 미팅 변경 체험 시작', exact: true }).click();
    const response = await creating;
    expect(response.status()).toBe(201);
    const created = await response.json() as WorkspaceView;
    createdIds.add(created.id);
    await expect(page.getByRole('heading', { name: '합성 예시: 고객 미팅 변경', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '고객 미팅 정정 안내 불러오기', exact: true }).click();
    await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
    const review = page.getByRole('complementary', { name: '변경 검토' });
    await expect(review.getByRole('button', { name: '검토한 변경 반영' })).toBeDisabled();
    await review.getByRole('group', { name: '사전 보고 충돌 해결 선택', exact: true }).getByRole('button', { name: '내 결정 유지' }).click();
    await expect(review.getByRole('button', { name: '검토한 변경 반영' })).toBeDisabled();
    await review.getByRole('group', { name: '인쇄본 확인 충돌 해결 선택', exact: true }).getByRole('button', { name: '내 결정 유지' }).click();
    await expect(review.getByRole('button', { name: '검토한 변경 반영' })).toBeEnabled();
    await capture(page, '04-coordination-review.png', '원문 변경과 잠근 보고·완료한 인쇄 확인을 직접 검토');

    const applying = page.waitForResponse((result) => result.url().endsWith(`/api/workspaces/${created.id}/apply`) && result.request().method() === 'POST');
    await review.getByRole('button', { name: '검토한 변경 반영' }).click();
    expect((await applying).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { name: '합성 예시: 고객 미팅 변경', exact: true })).toBeVisible();
    const savedResponse = await context.request.get(`/api/workspaces/${created.id}`);
    expect(savedResponse.status()).toBe(200);
    const saved = await savedResponse.json() as WorkspaceView;
    const items = saved.snapshot.blocks.flatMap((block) => block.items);
    expect(items.find((item) => item.id.endsWith(':executive_briefing'))?.value).toBe('2026-09-18 13:00');
    expect(items.find((item) => item.id.endsWith(':check_print'))?.completed).toBe(true);
    expect(items.find((item) => item.id.endsWith(':prepare_materials'))?.preparation).toEqual({ version: 1, dueDate: '2026-09-17', durationMinutes: 90 });
    await page.getByRole('button', { name: '공유할 계획 확인', exact: true }).click();
    await expect(page.getByLabel('복사할 현재 저장된 계획 미리보기')).toContainText('준비 마감 2026-09-17, 예상 90분');
    await capture(page, '05-coordination-approved-plan.png', '승인 후 저장된 계획과 보호된 준비 설정');
    expect(errors).toEqual([]);
  } finally {
    try {
      for (const id of createdIds) {
        const deleted = await context.request.delete(`/api/workspaces/${id}`, { headers: { origin } });
        expect([204, 404]).toContain(deleted.status());
        expect((await context.request.get(`/api/workspaces/${id}`)).status()).toBe(404);
      }
      cleanup = true;
    } finally {
      await writeFile(`${outputDir}/manifest.json`, `${JSON.stringify({ origin, generatedAt: new Date().toISOString(), viewport, createdIds: [...createdIds], cleanup, screenshots, errors }, null, 2)}\n`);
      await context.close();
      await browser.close();
    }
  }
}

await main();
