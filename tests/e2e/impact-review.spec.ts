import { expect, test, type Locator, type Page } from '@playwright/test';

test.afterEach(async ({ page }) => {
  await cleanupOwnedWorkspaces(page);
});

test('review panel combines impact, related items, evidence, and protected user state', async ({ page }) => {
  await page.goto('/app');
  await startSample(page, '여행 예시');

  await firstChecklistItem(page).getByRole('button', { name: '완료 처리' }).click();
  await expect(firstChecklistItem(page).getByText('완료')).toBeVisible();
  await noteItem(page).getByRole('button', { name: '항목 편집' }).click();
  await page.getByLabel('항목 값').fill('직접 고친 공유 안내입니다. 문장은 유지하고 도착 변경만 확인합니다.');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(noteItem(page).getByText('직접 수정')).toBeVisible();
  const dinner = scheduleItemByText(page, '둘째 날 저녁');
  await dinner.getByRole('button', { name: '고정' }).click();
  await expect(dinner.getByText('고정')).toBeVisible();

  await page.getByRole('button', { name: '여행 변경 자료 체험' }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();

  const review = reviewPanel(page);
  await expect(review.getByRole('region', { name: '변경 영향 요약' })).toBeVisible();
  await expect(review.locator('.impact-meter.changed strong')).not.toHaveText('0');
  await expect(review.locator('.impact-meter.preserved strong')).not.toHaveText('0');
  await expect(review.locator('.impact-meter.needs_review strong')).not.toHaveText('0');
  await expect(review.getByText(/저장하면 .*항목 변경/)).toBeVisible();

  const ledger = review.getByRole('region', { name: '보호 상태' });
  await expect(ledger.getByText('공유 문장')).toBeVisible();
  await expect(ledger.getByText('직접 수정')).toBeVisible();
  await expect(ledger.getByText('도착 시간 확인')).toBeVisible();
  await expect(ledger.getByText('완료')).toBeVisible();
  await expect(ledger.getByText('둘째 날 저녁')).toBeVisible();
  await expect(ledger.getByText('고정')).toBeVisible();

  const participantChange = changeRow(page, '참석자 수');
  await expect(participantChange.getByText('비용 1개')).toBeVisible();
  await expect(participantChange.getByText('체크리스트 1개')).toBeVisible();
  await expect(participantChange.getByText('안내 1개')).toBeVisible();
  await expect(participantChange.getByText('영향 항목')).toBeVisible();

  const arrivalChange = changeRow(page, '첫날 도착 시간');
  await arrivalChange.getByText('근거 보기').click();
  await expect(arrivalChange.getByText('첫날 도착 시간은 오후 4시로 늦어졌습니다')).toBeVisible();
  await expect(review.getByRole('button', { name: '확인한 변경 저장' })).toBeEnabled();
});

test('locked keep-user resolution previews and applies preserved value with stale review state', async ({ page }) => {
  await page.goto('/app');
  await startSample(page, '여행 예시');
  const dinner = scheduleItemByText(page, '둘째 날 저녁');
  await dinner.getByRole('button', { name: '고정' }).click();
  await expect(dinner.getByText('고정')).toBeVisible();

  await page.getByRole('button', { name: '고정한 약속 변경 보기', exact: true }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();

  const review = reviewPanel(page);
  await expect(review.locator('.impact-meter.blocked strong')).toHaveText('1');
  await expect(review.getByText('1개 확인이 필요한 선택이 남아 있습니다.')).toBeVisible();
  await expect(review.getByRole('button', { name: '확인한 변경 저장' })).toBeDisabled();

  await review.getByRole('button', { name: '내 결정 유지' }).click();
  await expect(review.locator('.impact-meter.ready strong')).toHaveText('0');
  await expect(review.getByRole('region', { name: '보호 상태' }).getByText('기존 값은 유지되고 확인 대상으로 남습니다.')).toBeVisible();
  await expect(review.getByText('저장하면 확인 필요 유지 1개입니다.')).toBeVisible();
  await expect(review.getByRole('button', { name: '확인한 변경 저장' })).toBeEnabled();
  await review.getByRole('button', { name: '확인한 변경 저장' }).click();

  const resolvedDinner = scheduleItemByText(page, '둘째 날 저녁');
  await expect(resolvedDinner.getByText('오후 7시 약속')).toBeVisible();
  await expect(resolvedDinner.getByText('고정')).toBeVisible();
  await expect(resolvedDinner.getByText('확인 필요')).toBeVisible();
});

test('locked use-source resolution previews and applies new value while preserving the lock', async ({ page }) => {
  await page.goto('/app');
  await startSample(page, '여행 예시');
  const dinner = scheduleItemByText(page, '둘째 날 저녁');
  await dinner.getByRole('button', { name: '고정' }).click();
  await expect(dinner.getByText('고정')).toBeVisible();

  await page.getByRole('button', { name: '고정한 약속 변경 보기', exact: true }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  const review = reviewPanel(page);
  await review.getByRole('button', { name: '새 원문 값 사용' }).click();

  await expect(review.getByRole('region', { name: '보호 상태' }).getByText('저장 후 값: 오후 8시 약속')).toBeVisible();
  await expect(review.getByText('저장하면 항목 변경 1개입니다.')).toBeVisible();
  await review.getByRole('button', { name: '확인한 변경 저장' }).click();

  const resolvedDinner = scheduleItemByText(page, '둘째 날 저녁');
  await expect(resolvedDinner.getByText('오후 8시 약속')).toBeVisible();
  await expect(resolvedDinner.getByText('고정')).toBeVisible();
  await expect(resolvedDinner.getByText('확인 필요')).toHaveCount(0);
});

test('completed protected deletion previews deletion and removes the item when source wins', async ({ page }) => {
  await page.goto('/app');
  await startSample(page, '과제 예시');
  const reproScript = checklistItemByText(page, '재현 스크립트 확인');
  await reproScript.getByRole('button', { name: '완료 처리' }).click();
  await expect(reproScript.getByText('완료')).toBeVisible();

  await page.getByRole('button', { name: '과제 변경 확인하기' }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  const review = reviewPanel(page);
  await expect(review.getByText('1개 확인이 필요한 선택이 남아 있습니다.')).toBeVisible();
  await review.getByRole('button', { name: '새 원문 값 사용' }).click();

  await expect(review.getByRole('region', { name: '보호 상태' }).getByText('저장 후 이 항목은 삭제됩니다.')).toBeVisible();
  await expect(review.getByText('저장하면 삭제 1개입니다.')).toBeVisible();
  await review.getByRole('button', { name: '확인한 변경 저장' }).click();

  await expect(page.getByRole('status')).toHaveText('확인한 변경을 저장했습니다.');
  await expect(checklistItemByText(page, '재현 스크립트 확인')).toHaveCount(0);
});

test('mobile impact review stays readable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/app');
  await startSample(page, '여행 예시');
  await firstChecklistItem(page).getByRole('button', { name: '완료 처리' }).click();
  await expect(firstChecklistItem(page).getByText('완료')).toBeVisible();
  await page.getByRole('button', { name: '여행 변경 자료 체험' }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();

  await expect(page.getByTestId('workspace-review')).toBeVisible();
  await expect(page.getByTestId('workspace-plan')).toBeHidden();
  await expect(reviewPanel(page).getByRole('region', { name: '변경 영향 요약' })).toBeVisible();
  await expect(changeRow(page, '참석자 수').getByText('영향 항목')).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);

  await page.screenshot({ path: 'artifacts/premium-impact-review-mobile.png', fullPage: true });
});

test('desktop review scrolls by keyboard while the current plan remains available for comparison', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/app');
  await startSample(page, '여행 예시');
  await page.getByRole('button', { name: '여행 변경 자료 체험' }).click();
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();
  const review = reviewPanel(page);
  const currentArrival = scheduleItemByText(page, '첫날 도착').locator('.item-value');
  await expect(currentArrival).toBeInViewport({ ratio: 1 });
  await review.focus();
  const beforeScroll = await review.evaluate((element) => element.scrollTop);
  await page.keyboard.press('PageDown');
  await expect.poll(() => review.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeScroll);
  const cost = changeRow(page, '인당 고정비').locator('.before-after');
  await cost.scrollIntoViewIfNeeded();
  await expect(cost).toBeInViewport({ ratio: 1 });
  await expect(currentArrival).toBeInViewport({ ratio: 1 });
  await expect(currentArrival).toContainText('오전 10시 도착');
  await page.keyboard.press('Tab');
  await expect(review).not.toBeFocused();
});

async function startSample(page: Page, name: '여행 예시' | '과제 예시') {
  await page.getByRole('button', { name: name === '여행 예시' ? /체험용 여행 예시 시작|여행 예시/ : /과제 예시/ }).click();
}

function reviewPanel(page: Page): Locator {
  return page.getByRole('complementary', { name: '변경 검토' });
}

function firstChecklistItem(page: Page): Locator {
  return page.locator('.block-checklist .item').first();
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

function changeRow(page: Page, text: string): Locator {
  return page.locator('.change-row').filter({ hasText: text }).first();
}

async function cleanupOwnedWorkspaces(page: Page) {
  if (!page.url().startsWith('http')) return;
  const origin = new URL(page.url()).origin;
  const listResponse = await page.request.get(new URL('/api/workspaces', origin).toString());
  expect(listResponse.status()).toBe(200);
  const workspaces = await listResponse.json() as Array<{ id: string }>;
  for (const workspace of workspaces) {
    const deleteResponse = await page.request.delete(new URL(`/api/workspaces/${workspace.id}`, origin).toString(), { headers: { Origin: origin } });
    expect([204, 404]).toContain(deleteResponse.status());
  }
}
