import { expect, test, type Page } from '@playwright/test';

test.afterEach(async ({ page }) => {
  if (!page.url().startsWith('http')) return;
  const origin = new URL(page.url()).origin;
  const response = await page.request.get('/api/workspaces');
  if (!response.ok()) return;
  const workspaces = await response.json() as Array<{ id: string }>;
  for (const workspace of workspaces) {
    const removed = await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { Origin: origin } });
    expect([204, 404]).toContain(removed.status());
  }
});

test('copies approved persisted differences after reload and hides the receipt after a manual edit', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await applyTravelChange(page);
  await page.reload();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  await page.getByRole('button', { name: '승인해 저장한 변경 보기', exact: true }).click();
  const preview = page.getByLabel('복사할 승인 저장 변경 요약 미리보기');
  await expect(preview).toContainText('225000');
  await expect(preview).toContainText('300000');
  await expect(preview).not.toContainText('합성 여행 정정 안내입니다');
  const text = await preview.inputValue();
  await page.getByRole('button', { name: '미리보기 내용 복사', exact: true }).click();
  await expect(page.getByText('변경 안내를 복사했습니다. 원하는 대화에 붙여넣으세요.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '계획', exact: true }).click();
  await page.locator('.block-schedule .item').first().getByRole('button', { name: '항목 편집' }).click();
  await page.getByLabel('항목 값').fill('내가 정한 도착 후 일정');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  await expect(page.getByRole('button', { name: '승인해 저장한 변경 보기', exact: true })).toHaveCount(0);
});

test('clipboard rejection retains the approved preview for manual copying', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
    } });
  });
  await applyTravelChange(page);
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  await page.getByRole('button', { name: '승인해 저장한 변경 보기', exact: true }).click();
  const preview = page.getByLabel('복사할 승인 저장 변경 요약 미리보기');
  await expect(preview).toContainText('300000');
  await page.getByRole('button', { name: '미리보기 내용 복사', exact: true }).click();
  await expect(page.getByText('브라우저가 클립보드 복사를 허용하지 않았습니다. 아래 미리보기에서 직접 복사해 주세요.')).toBeVisible();
  await expect(preview).toBeFocused();
  await expect(preview).toContainText('300000');
});

async function applyTravelChange(page: Page) {
  await page.goto('/app');
  await page.getByRole('button', { name: '체험용 여행 예시 시작', exact: true }).click();
  await page.getByRole('button', { name: '여행 변경 자료 체험', exact: true }).click();
  await page.getByRole('button', { name: '확인한 변경 저장', exact: true }).click();
  await expect(page.locator('.status-notice')).toHaveText('확인한 변경을 저장했습니다.');
}
