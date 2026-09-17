import { expect, test, type Locator, type Page } from '@playwright/test';

test.afterEach(async ({ page }) => {
  await cleanupOwnedWorkspaces(page);
});

test('travel sample preserves user work, applies reviewed updates, resolves conflicts, restores history, and deletes data', async ({ page }) => {
  await page.goto('/app');
  await startSample(page, '여행 예시');

  await expect(page.getByRole('heading', { name: '합성 예시: 제주 가족 여행' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('준비된 체험용 예시');
  await expect(page.getByText('체험용 · 반영됨')).toBeVisible();
  await expect(costItem(page).getByText('225,000원')).toBeVisible();
  await expect(page.getByText('오전 10시 도착')).toBeVisible();
  await expect(page.getByText('자동 계산')).toBeVisible();
  await page.screenshot({ path: 'artifacts/premium-workspace-desktop.png', fullPage: false });
  await page.getByRole('button', { name: '변경 이력', exact: true }).click();
  await expect(page.getByText('체험용 예시 시작')).toBeVisible();
  await page.getByRole('button', { name: '계획', exact: true }).click();

  await firstChecklistItem(page).getByRole('button', { name: '완료 처리' }).click();
  await expect(firstChecklistItem(page).getByText('완료')).toBeVisible();

  const note = noteItem(page);
  await note.getByRole('button', { name: '항목 편집' }).click();
  await page.getByLabel('항목 값').fill('직접 고친 공유 안내입니다. 도착 변경만 확인하고 문장은 보존합니다.');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('직접 고친 공유 안내입니다.')).toBeVisible();
  await expect(noteItem(page).getByText('직접 수정')).toBeVisible();

  const dinner = scheduleItemByText(page, '둘째 날 저녁');
  await dinner.getByRole('button', { name: '고정' }).click();
  await expect(dinner.getByText('고정')).toBeVisible();

  await page.getByRole('button', { name: '여행 변경 자료 체험' }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  await expect(changeRow(page, '인당 고정비').locator('.before-after p').nth(1).getByText('300000')).toBeVisible();
  await expect(changeRow(page, '첫날 도착').locator('.before-after p').nth(1).getByText('오후 4시')).toBeVisible();
  await expect(changeRow(page, '둘째 날 저녁').getByText('보존됨')).toBeVisible();

  await page.getByRole('button', { name: '확인한 변경 저장' }).click();
  await expect(costItem(page).getByText('300,000원')).toBeVisible();
  await expect(page.getByText('오후 4시 도착')).toBeVisible();
  await expect(page.getByText('직접 고친 공유 안내입니다.')).toBeVisible();
  await expect(firstChecklistItem(page).getByText('완료')).toBeVisible();
  await expect(dinner.getByText('고정')).toBeVisible();

  await page.getByRole('button', { name: '고정한 약속 변경 보기', exact: true }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  await expect(page.getByText('확인이 필요한 변경')).toBeVisible();
  await expect(page.getByRole('complementary', { name: '변경 검토' }).locator('.change-row.needs_review .change-state')).toBeVisible();
  await page.getByRole('button', { name: '내 결정 유지' }).click();
  await page.getByRole('button', { name: '확인한 변경 저장' }).click();
  await expect(dinner.getByText('오후 7시 약속')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: '합성 예시: 제주 가족 여행' })).toBeVisible();
  await expect(page.getByText('직접 고친 공유 안내입니다.')).toBeVisible();
  await expect(costItem(page).getByText('300,000원')).toBeVisible();

  await page.getByRole('button', { name: '변경 이력', exact: true }).click();
  await page.getByRole('button', { name: /1번 저장된 계획 복원/ }).click();
  await expect(costItem(page).getByText('225,000원')).toBeVisible();
  await expect(page.getByText('오전 10시 도착')).toBeVisible();
  await page.getByRole('button', { name: '변경 이력', exact: true }).click();
  await expect(page.getByText('이전 내용 복원')).toBeVisible();

  await deleteActiveWorkspace(page);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText('아직 저장된 작업 공간이 없습니다.')).toBeVisible();
});

test('syllabus sample uses the same review and apply flow for deadline changes', async ({ page }) => {
  await page.goto('/app');
  await startSample(page, '과제 예시');

  await expect(page.getByRole('heading', { name: '합성 예시: 데이터 공학 과제' })).toBeVisible();
  await expect(scheduleItemByText(page, '팀 과제 마감').locator('.item-value').getByText('10월 3일 23:59')).toBeVisible();
  await page.getByRole('button', { name: '과제 마감 변경 체험' }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  await expect(changeRow(page, '과제 마감').locator('.before-after p').nth(1).getByText('10월 10일 23:59')).toBeVisible();
  await page.getByRole('button', { name: '확인한 변경 저장' }).click();
  await expect(scheduleItemByText(page, '팀 과제 마감').locator('.item-value').getByText('10월 10일 23:59')).toBeVisible();
  await expect(page.locator('.block-note .item-value').getByText('보고서와 실행 로그를 10월 10일 23:59까지 제출합니다.')).toBeVisible();
});

test('mobile workspace layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/app');
  await startSample(page, '여행 예시');

  const tabs = page.getByRole('navigation', { name: '작업 화면' });
  await expect(page.getByTestId('workspace-plan')).toBeVisible();
  await expect(page.getByTestId('workspace-source')).toBeHidden();
  await expect(page.getByTestId('workspace-review')).toBeHidden();
  await expect(costItem(page).getByText('225,000원')).toBeVisible();

  await tabs.getByRole('button', { name: '변경 검토', exact: true }).click();
  await expect(page.getByTestId('workspace-review')).toBeVisible();
  await expect(page.getByTestId('workspace-plan')).toBeHidden();
  await tabs.getByRole('button', { name: '원문', exact: true }).click();
  await expect(page.getByLabel('원문 내용')).toBeVisible();
  await expect(page.getByTestId('workspace-review')).toBeHidden();
  await tabs.getByRole('button', { name: '계획', exact: true }).click();
  await expect(costItem(page).getByText('225,000원')).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);
});

async function startSample(page: Page, name: '여행 예시' | '과제 예시') {
  await page.getByRole('button', { name: name === '여행 예시' ? /체험용 여행 예시 시작|여행 예시/ : /과제 예시/ }).click();
}

function firstChecklistItem(page: Page): Locator {
  return page.locator('.block-checklist .item').first();
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

function changeRow(page: Page, text: string): Locator {
  return page.locator('.change-row').filter({ hasText: text }).first();
}

async function deleteActiveWorkspace(page: Page) {
  await page.getByRole('button', { name: '변경 이력', exact: true }).click();
  const button = page.getByRole('button', { name: '작업 공간 삭제' });
  await button.click();
  await page.getByRole('button', { name: '영구 삭제' }).click();
}

async function cleanupOwnedWorkspaces(page: Page) {
  if (!page.url().startsWith('http')) return;
  const listResponse = await page.request.get(new URL('/api/workspaces', page.url()).toString());
  expect([200]).toContain(listResponse.status());
  const workspaces = await listResponse.json() as Array<{ id: string }>;
  for (const workspace of workspaces) {
    const deleteResponse = await page.request.delete(new URL(`/api/workspaces/${workspace.id}`, page.url()).toString(), { headers: { Origin: new URL(page.url()).origin } });
    expect([204, 404]).toContain(deleteResponse.status());
  }
}
