import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';

test.afterEach(async ({ page }) => {
  const listed = await page.request.get('/api/workspaces');
  if (!listed.ok()) return;
  for (const workspace of await listed.json() as Array<{ id: string }>) {
    await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { origin: 'http://127.0.0.1:5174' } });
  }
});

test('the dense schedule computes four moves and refuses the blocked 90-minute scenario without saving', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/recovery');
  await expect(page.getByRole('heading', { name: '일정 하나 바뀌었다고, 처음부터 다시 짜지 마세요.' })).toBeVisible();
  const after = page.getByRole('region', { name: '조건을 만족하는 일정 조정안', exact: true }).first();
  await expect(after.locator('article[data-moved="true"]')).toHaveCount(4);
  await expect(after.locator('article').filter({ hasText: '발표자료 준비' })).toContainText('15:30–17:00');
  await expect(after.locator('article').filter({ hasText: '경비 정리' })).toContainText('14:30–15:00');
  expect(await (await page.request.get('/api/workspaces')).json()).toEqual([]);
  await page.screenshot({ path: 'artifacts/change-recovery-2026-09-15/desktop.png', fullPage: true });
  await page.getByLabel('목요일 14:30–15:00 사용 가능').uncheck();
  await expect(page.getByRole('heading', { name: '지금 조건에서는 적용할 수 없습니다.' })).toBeVisible();
  await expect(page.getByRole('button', { name: '미리보기에서 적용' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '작업 공간으로 저장' })).toBeDisabled();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/change-recovery-2026-09-15/mobile-blocked.png', fullPage: true });
});

test('save, dirty edit, recompute, approve and reload stay in the same workspace', async ({ page }) => {
  await page.goto('/recovery');
  await page.getByRole('button', { name: '작업 공간으로 저장' }).click();
  await expect(page).toHaveURL(/\/recovery\/ws_/);
  const savedUrl = page.url();
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeEnabled();
  const initial = await (await page.request.get('/api/workspaces')).json() as Array<{ id: string }>;
  expect(initial).toHaveLength(1);
  const id = initial[0]!.id;
  await page.getByLabel('준비 시간(분)').fill('120');
  await page.getByLabel('준비 시간(분)').fill('60');
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeDisabled();
  const beforePreview = await (await page.request.get(`/api/workspaces/${id}/recovery`)).json() as { conditionRevision: number };
  expect(beforePreview.conditionRevision).toBe(1);
  await page.getByRole('button', { name: '변경 조건 다시 계산' }).click();
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeEnabled();
  await page.getByRole('button', { name: '조정안 적용하기' }).click();
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('준비 시간(분)')).toHaveValue('60');
  await expect(page).toHaveURL(savedUrl);
  const saved = await (await page.request.get(`/api/workspaces/${id}/recovery`)).json() as { revision: number; conditionRevision: number; applied: boolean; actions: unknown[] };
  expect(saved).toMatchObject({ revision: 2, conditionRevision: 2, applied: true, actions: [] });
  expect(await (await page.request.get('/api/workspaces')).json()).toHaveLength(1);
  await expect(page.getByLabel('수신자', { exact: true })).toHaveValue('');
});

test('a lost preview response can be retried without duplicating the condition revision', async ({ page }) => {
  await page.goto('/recovery');
  await page.getByRole('button', { name: '작업 공간으로 저장' }).click();
  await expect(page).toHaveURL(/\/recovery\/ws_/);
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeEnabled();
  let loseResponse = true;
  await page.route('**/recovery/preview', async (route) => {
    if (!loseResponse) return route.continue();
    loseResponse = false;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByLabel('준비 시간(분)').fill('60');
  await page.getByRole('button', { name: '변경 조건 다시 계산' }).click();
  await expect(page.getByRole('button', { name: '변경 조건 다시 계산' })).toBeEnabled();
  await expect(page.getByLabel('준비 시간(분)')).toHaveValue('60');
  await page.getByRole('button', { name: '변경 조건 다시 계산' }).click();
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeEnabled();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const saved = await (await page.request.get(`/api/workspaces/${id}/recovery`)).json() as { conditionRevision: number };
  expect(saved.conditionRevision).toBe(2);
});

test('persisted recovery clears private content when the signed-in identity changes on focus', async ({ page, context }) => {
  const accounts = JSON.parse(readFileSync('.wrangler/e2e-runtime/account-fixtures.json', 'utf8')) as Array<{ cookie: string }>;
  const setAccount = (index: number) => context.addCookies([{ name: 'ieojim-auth.session_token', value: accounts[index]!.cookie.split('=', 2)[1]!.split(';')[0]!, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await setAccount(5);
  const created = await page.request.post('/api/recovery/workspaces', { headers: { origin: 'http://127.0.0.1:5174' }, data: { input: createRecoveryExample(), requestId: crypto.randomUUID() } });
  expect(created.status()).toBe(201);
  const saved = await created.json() as { workspaceId: string };
  try {
    await page.goto(`/recovery/${saved.workspaceId}`);
    await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeEnabled();
    await page.getByText('이메일 작성·확인', { exact: true }).click();
    await page.getByLabel('수신자', { exact: true }).fill('private-draft@example.test');
    await setAccount(6);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page).toHaveURL(/\/app$/, { timeout: 3000 });
    await expect(page.getByRole('button', { name: '조정안 적용하기' })).toHaveCount(0);
    await expect(page.getByLabel('수신자', { exact: true })).toHaveCount(0);
  } finally {
    await setAccount(5);
    await page.request.delete(`/api/workspaces/${saved.workspaceId}`, { headers: { origin: 'http://127.0.0.1:5174' } });
  }
});

test('identity broadcast leaves recovery and discards a delayed recalculation response', async ({ page }) => {
  await page.goto('/recovery');
  await page.getByRole('button', { name: '작업 공간으로 저장' }).click();
  await expect(page).toHaveURL(/\/recovery\/ws_/);
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeEnabled();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/recovery/preview', async (route) => {
    const response = await route.fetch();
    await delayed;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.getByLabel('준비 시간(분)').fill('60');
  await page.getByRole('button', { name: '변경 조건 다시 계산' }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ieojim-identity-change', { detail: { type: 'identity-change', reason: 'logout', sourceId: 'another-tab' } })));
  try {
    await expect(page).toHaveURL(/\/app$/, { timeout: 3000 });
  } finally { release(); }
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '이메일 발송 작업 등록' })).toHaveCount(0);
});
