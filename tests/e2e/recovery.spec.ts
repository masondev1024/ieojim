import { expect, test, type Page } from '@playwright/test';

test.afterEach(async ({ page }) => {
  await cleanupOwnedWorkspaces(page);
});

test('explicit workspace load releases busy state after an invalid server response and can be retried', async ({ page }) => {
  await page.goto('/app');
  await startSample(page, '여행 예시');
  await startSample(page, '과제 예시');

  let failedOnce = false;
  await page.route('**/api/workspaces/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    const isWorkspaceRead = route.request().method() === 'GET' && /^\/api\/workspaces\/[^/]+$/.test(requestUrl.pathname);
    if (isWorkspaceRead && !failedOnce) {
      failedOnce = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'not-json' });
      return;
    }
    await route.fallback();
  });

  await page.getByRole('button', { name: /합성 예시: 제주 가족 여행/ }).click();
  await expect(page.getByRole('alert')).toContainText('서버 응답 형식이 올바르지 않습니다.');
  await expect(page.getByRole('button', { name: /여행 예시/ })).toBeEnabled();

  await page.getByRole('button', { name: /합성 예시: 제주 가족 여행/ }).click();
  await expect(page.getByRole('heading', { name: '합성 예시: 제주 가족 여행' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('retry is disabled while live AI is unavailable without consuming a recovery attempt', async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByText('게스트 체험 가능')).toBeVisible();
  await startSample(page, '여행 예시');
  await page.getByRole('button', { name: '원문', exact: true }).click();
  await page.getByLabel('원문 내용').fill('추가 준비물: 접이식 우산을 챙긴다.');
  await page.getByRole('button', { name: '원문 저장하고 AI 검토' }).click();
  await expect(page.getByText('실제 AI · 처리 실패')).toBeVisible();
  const retry = page.getByRole('button', { name: '재시도', exact: true });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAttribute('title', '실제 AI 처리가 연결되면 다시 요청할 수 있습니다.');
});

test('polling refresh keeps the source form relation, target, and draft text intact', async ({ page }) => {
  await page.goto('/app');
  await startSample(page, '여행 예시');

  let makeNextWorkspaceReadPending = true;
  await page.route('**/api/workspaces/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    const isWorkspaceRead = route.request().method() === 'GET' && /^\/api\/workspaces\/[^/]+$/.test(requestUrl.pathname);
    if (!isWorkspaceRead || !makeNextWorkspaceReadPending) {
      await route.fallback();
      return;
    }

    makeNextWorkspaceReadPending = false;
    const response = await route.fetch();
    const workspace = await response.json() as {
      runs: Array<Record<string, unknown>>;
    };
    const pendingWorkspace = {
      ...workspace,
      runs: [{ ...(workspace.runs[0] ?? {}), status: 'pending' }],
    };
    await route.fulfill({ response, json: pendingWorkspace });
  });

  await page.getByRole('button', { name: /합성 예시: 제주 가족 여행/ }).click();
  await expect(page.getByText('체험용 · 대기 중')).toBeVisible();

  await page.getByRole('button', { name: '원문', exact: true }).click();
  await page.getByLabel('관계').selectOption('replacement');
  await page.getByLabel('바꿀 원문').selectOption({ index: 1 });
  await page.getByLabel('원문 내용').fill('작성 중인 정정 자료입니다. polling 중에도 이 문장은 유지되어야 합니다.');

  await expect(page.getByText('체험용 · 반영됨')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel('관계')).toHaveValue('replacement');
  await expect(page.getByLabel('바꿀 원문')).not.toHaveValue('');
  await expect(page.getByLabel('원문 내용')).toHaveValue('작성 중인 정정 자료입니다. polling 중에도 이 문장은 유지되어야 합니다.');
});

async function startSample(page: Page, name: '여행 예시' | '과제 예시') {
  await page.getByRole('button', { name: name === '여행 예시' ? /체험용 여행 예시 시작|여행 예시/ : /과제 예시/ }).click();
}

async function cleanupOwnedWorkspaces(page: Page) {
  if (!page.url().startsWith('http')) return;
  const origin = new URL(page.url()).origin;
  const listResponse = await page.request.get(new URL('/api/workspaces', origin).toString());
  expect(listResponse.status()).toBe(200);
  const workspaces = await listResponse.json() as Array<{ id: string }>;
  for (const workspace of workspaces) {
    const deleteResponse = await page.request.delete(new URL(`/api/workspaces/${workspace.id}`, origin).toString(), {
      headers: { Origin: origin },
    });
    expect([204, 404]).toContain(deleteResponse.status());
  }
}
