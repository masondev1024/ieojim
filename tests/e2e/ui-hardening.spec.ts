import { expect, test, type Locator } from '@playwright/test';

async function textLineCount(locator: Locator) {
  return locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size;
  });
}

test.afterEach(async ({ page }) => {
  const response = await page.request.get('/api/workspaces');
  if (!response.ok()) return;
  for (const workspace of await response.json() as Array<{ id: string }>) {
    await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { origin: 'http://127.0.0.1:5174' } });
  }
});

for (const width of [1440, 1024, 768, 390, 320]) {
  test(`recovery time ranges remain readable without splitting at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/recovery');
    await expect(page.locator('.recovery-day article > span')).toHaveCount(16);
    await page.evaluate(() => document.fonts.ready);
    const views = width <= 560 ? ['조정안 보기', '변경 전 보기'] : [null];
    for (const view of views) {
      if (view) {
        const button = page.getByRole('button', { name: view, exact: true });
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
      }
      const times = page.locator('.recovery-day article > span:visible');
      await expect(times).toHaveCount(width <= 560 ? 8 : 16);
      for (const time of await times.all()) {
        expect(await textLineCount(time), await time.textContent() ?? 'time range').toBe(1);
        expect(await time.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('recovery navigation and condition toggles have usable touch targets after route changes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await page.getByRole('link', { name: '일정 조정안 보기' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  for (const link of await page.locator('.recovery-nav a').all()) {
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const toggle = page.getByLabel('목요일 14:30–15:00 사용 가능');
  const label = page.locator('label').filter({ has: toggle });
  expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: '작업 공간으로 저장' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: '지금 조건에서는 적용할 수 없습니다.' })).toBeVisible();
});

test('recovery progress band stays aligned with the product content width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/recovery');
  const heroBox = (await page.locator('.recovery-hero').boundingBox())!;
  const assuranceBox = (await page.locator('.recovery-assurance').boundingBox())!;
  expect(Math.round(assuranceBox.x)).toBe(Math.round(heroBox.x));
  expect(Math.round(assuranceBox.width)).toBe(Math.round(heroBox.width));
});

test('exact email approval follows its readable fields in the same action panel', async ({ page }) => {
  await page.goto('/recovery');
  await page.getByText('이메일 작성·확인', { exact: true }).click();
  const checkbox = page.getByLabel('표시된 수신자, 제목, 본문 그대로 확인');
  await expect(checkbox).toBeVisible();
  const panel = page.locator('.recovery-action-card').filter({ has: checkbox });
  await expect(panel.getByLabel('수신자', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('본문', { exact: true })).toBeVisible();
  expect(await checkbox.evaluate((element) => {
    const body = element.closest('.recovery-action-card')?.querySelector('textarea');
    return Boolean(body && body.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await expect(page.getByRole('button', { name: '이메일 발송 작업 등록' })).toBeDisabled();
});

test('recovery comparison reflows for enlarged text without clipping times or fields', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/recovery');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const view of ['조정안 보기', '변경 전 보기']) {
    const button = page.getByRole('button', { name: view, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const times = page.locator('.recovery-day article > span:visible');
    await expect(times).toHaveCount(8);
    for (const time of await times.all()) {
      expect(await textLineCount(time)).toBe(1);
      expect(await time.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  }
  await page.getByText('이메일 작성·확인', { exact: true }).click();
  const recipient = page.getByLabel('수신자', { exact: true });
  const box = (await recipient.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
});

test('mobile preparation heading and saved plan stay readable with enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/app?example=coordination');
  await page.getByRole('button', { name: '고객 미팅 변경 체험 시작', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/workspaces\//);
  const heading = page.locator('.preparation-board__toggle strong');
  await expect(heading).toBeVisible();
  expect(await textLineCount(heading)).toBe(1);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const tabs = page.getByRole('navigation', { name: '작업 화면' });
  for (const button of await tabs.getByRole('button').all()) {
    const rect = (await button.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(320);
  }
});
