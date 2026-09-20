import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => {
  const listed = await page.request.get('/api/workspaces');
  if (!listed.ok()) return;
  for (const workspace of await listed.json() as Array<{ id: string }>) {
    await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { origin: 'http://127.0.0.1:5174' } });
  }
});

for (const width of [1440, 1024, 768, 390, 320]) {
  test(`recovery progress shares both shell edges and preserves viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/recovery');
    await expect(page.locator('.recovery-assurance')).toBeVisible();
    const hero = (await page.locator('.recovery-hero').boundingBox())!;
    const progress = (await page.locator('.recovery-assurance').boundingBox())!;
    expect(progress.x).toBeCloseTo(hero.x, 0);
    expect(progress.x + progress.width).toBeCloseTo(hero.x + hero.width, 0);
    expect(progress.x).toBeGreaterThanOrEqual(14);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test('the first desktop screen exposes real schedule changes and preserves readable source access', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/recovery');
  const impact = page.getByRole('article', { name: '일정 변경 요약' });
  await expect(impact).toBeVisible();
  await expect(impact.getByRole('list', { name: '계산된 일정 변경' }).getByRole('listitem')).toHaveCount(4);
  const presentation = impact.getByRole('listitem').filter({ hasText: '금요일 발표' });
  await expect(presentation).toContainText('변경 전 9/18 16:00–17:00');
  await expect(presentation).toContainText('조정안 9/18 11:00–12:00');
  const expense = impact.getByRole('listitem').filter({ hasText: '경비 정리' });
  await expect(expense).toContainText('9/17 14:30–15:00');
  await expect(impact).toContainText('보호 일정 4개 유지');
  const rect = (await impact.boundingBox())!;
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.y + rect.height).toBeLessThanOrEqual(900);
  await expect(impact.locator('blockquote')).not.toBeVisible();
  await impact.getByText('새 안내와 근거 보기', { exact: true }).click();
  await expect(impact.locator('blockquote')).toContainText('금요일 발표는 16시에서 11시로 변경됩니다.');
  await expect(impact.getByRole('list', { name: '확인된 원문 근거' })).toBeVisible();
});

test('blocked mobile plans show the unchanged baseline without a successful impact list', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/recovery');
  await page.getByRole('button', { name: '변경 전 보기', exact: true }).click();
  await page.getByLabel('목요일 14:30–15:00 사용 가능').uncheck();
  const impact = page.getByRole('article', { name: '일정 변경 요약' });
  await expect(impact).toContainText('지금 조건으로는 옮길 수 없어요.');
  await expect(impact.getByRole('list', { name: '계산된 일정 변경' })).toHaveCount(0);
  await expect(page.locator('.recovery-success')).toHaveCount(0);
  await expect(page.locator('.recovery-day article > span:visible')).toHaveCount(8);
  await expect(page.getByRole('heading', { name: '변경 전', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '작업 공간으로 저장' })).toBeDisabled();
});

test('a dirty persisted draft cannot retain a successful impact summary', async ({ page }) => {
  await page.goto('/recovery');
  await page.getByRole('button', { name: '작업 공간으로 저장' }).click();
  await expect(page).toHaveURL(/\/recovery\/ws_/);
  await page.getByLabel('준비 시간(분)').fill('60');
  const impact = page.getByRole('article', { name: '일정 변경 요약' });
  await expect(impact).toContainText('바꾼 조건으로 다시 계산해 주세요.');
  await expect(impact.getByRole('list', { name: '계산된 일정 변경' })).toHaveCount(0);
  await expect(page.locator('.recovery-success')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeDisabled();
  await page.getByRole('button', { name: '변경 조건 다시 계산' }).click();
  await expect(impact.getByRole('list', { name: '계산된 일정 변경' })).toBeVisible();
});

test('optional email uses deliberate keyboard disclosure without sending anything', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/recovery');
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST') writes.push(request.url()); });
  const recipient = page.getByLabel('수신자', { exact: true });
  await expect(recipient).not.toBeVisible();
  const disclosure = page.locator('.recovery-email-disclosure > summary');
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(recipient).toBeVisible();
  await recipient.fill('draft@example.test');
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(recipient).not.toBeVisible();
  await page.keyboard.press('Enter');
  await expect(recipient).toHaveValue('draft@example.test');
  await expect(page.getByRole('button', { name: '이메일 발송 작업 등록' })).toBeDisabled();
  expect(writes).toEqual([]);
});

test('skip link is hidden until focused and reaches the main content', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/recovery');
  const skip = page.getByRole('link', { name: '본문으로 이동', exact: true });
  await expect(skip).toBeAttached();
  const hidden = (await skip.boundingBox())!;
  expect(hidden.y + hidden.height).toBeLessThanOrEqual(0);
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  const visible = (await skip.boundingBox())!;
  expect(visible.y).toBeGreaterThanOrEqual(0);
  expect(visible.x + visible.width).toBeLessThanOrEqual(320);
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});
