import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.beforeAll(() => mkdirSync('artifacts/departure-story-2026-09-14', { recursive: true }));

test('departure preview uses evidence and both human choices without API calls', async ({ page }, testInfo) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const demo = page.locator('.departure-demo');
  await page.screenshot({ path: `artifacts/departure-story-2026-09-14/${testInfo.project.name}-landing-initial.png`, fullPage: true });
  await demo.getByRole('button', { name: '출발 전 변경 확인하기' }).click();
  const dinner = demo.getByRole('group', { name: '둘째 날 저녁 선택' });
  const paper = demo.getByRole('group', { name: '종이 확인서 출력 선택' });
  const compare = demo.getByRole('button', { name: '선택한 결과 비교' });
  await expect(dinner).toBeVisible();
  await expect(paper).toBeVisible();
  await expect(compare).toBeDisabled();
  const paperCard = demo.locator('.departure-demo__decision').filter({ has: page.getByRole('group', { name: '종이 확인서 출력 선택' }) });
  await paperCard.getByText('원문 근거 보기', { exact: true }).click();
  await expect(paperCard.getByText('종이 확인서 출력 항목은 삭제해 주세요', { exact: true })).toBeVisible();
  await paperCard.getByText('원문 근거 보기', { exact: true }).click();
  await dinner.getByRole('button', { name: '19시 약속 유지' }).focus();
  await page.keyboard.press('Enter');
  await expect(compare).toBeDisabled();
  await paper.getByRole('button', { name: '삭제 승인', exact: true }).click();
  await expect(compare).toBeEnabled();
  await compare.click();
  const result = demo.getByRole('region', { name: '선택 결과 미리보기' });
  await expect(result).toBeVisible();
  await expect(result.getByRole('article').filter({ hasText: '종이 확인서 출력' }).locator('p')).toContainText('삭제됨');
  await expect(result.getByText('직접 쓴 내용 유지', { exact: true })).toBeVisible();
  await expect(result.getByText('고정 유지', { exact: true })).toBeVisible();
  await expect(result.getByText('재검토 필요', { exact: true }).first()).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const control of await demo.getByRole('button').all()) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: `artifacts/departure-story-2026-09-14/${testInfo.project.name}-landing-result-${width}.png`, fullPage: true });
  }
  await paper.getByRole('button', { name: '완료 기록 유지' }).click();
  await expect(result).toHaveCount(0);
  await compare.click();
  await expect(result.getByText('완료 유지', { exact: true })).toBeVisible();
  await expect(result.getByRole('article').filter({ hasText: '종이 확인서 출력' }).locator('p')).not.toContainText('삭제됨');
  await demo.getByRole('button', { name: '다시 선택', exact: true }).click();
  await expect(result).toHaveCount(0);
  await expect(compare).toBeDisabled();
  expect(apiRequests).toEqual([]);
});

test('failed preview module keeps an honest error and usable workspace entry', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  await page.route(/\/departure-demo-model[^/]*\.(?:ts|js)(?:\?.*)?$/, (route) => route.abort('failed'));
  await page.goto('/');
  await page.getByRole('button', { name: '출발 전 변경 확인하기' }).click();
  await expect(page.locator('.departure-demo').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: '선택 결과 미리보기' })).toHaveCount(0);
  await page.getByRole('link', { name: '체험용 예시 열기', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\?example=departure$/);
  await expect(page.getByRole('button', { name: '출발 전날 복합 체험 시작' })).toBeVisible();
  expect(writes).toEqual([]);
});
