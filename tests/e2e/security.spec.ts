import { expect, test } from '@playwright/test';
import type { WorkspaceView } from '../../src/core/contracts';

test('a separate browser owner cannot read, edit, or delete a private workspace', async ({ page, browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const created = await page.request.post('/api/workspaces/sample', { headers: { Origin: origin }, data: { scenario: 'travel' } });
  expect(created.status()).toBe(201);
  const workspace = await created.json() as WorkspaceView;
  const stranger = await browser.newContext({ baseURL: origin });
  try {
    const url = `/api/workspaces/${workspace.id}`;
    expect((await stranger.request.get(url)).status()).toBe(404);
    expect((await stranger.request.patch(`${url}/items`, {
      headers: { Origin: origin },
      data: { baseRevision: workspace.revision, requestId: crypto.randomUUID(), itemId: workspace.snapshot.blocks[0].items[0].id, value: 'unauthorized overwrite' },
    })).status()).toBe(404);
    expect((await stranger.request.delete(url, { headers: { Origin: origin } })).status()).toBe(404);
    const unchanged = await page.request.get(url);
    expect(unchanged.status()).toBe(200);
    expect((await unchanged.json() as WorkspaceView).snapshot).toEqual(workspace.snapshot);
    const cookies = await page.context().cookies();
    const owner = cookies.find((cookie) => cookie.name === 'ieojim_owner');
    expect(owner?.httpOnly).toBe(true);
    expect(owner?.sameSite).toBe('Lax');
  } finally {
    await stranger.close();
    expect((await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { Origin: origin } })).status()).toBe(204);
  }
});

test('the development proxy preserves rejection of foreign and missing origins', async ({ request }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const unsafeHeaders: Record<string, string>[] = [{ Origin: 'https://attacker.invalid' }, {}];
  for (const headers of unsafeHeaders) {
    const response = await request.post('/api/workspaces/sample', { headers, data: { scenario: 'travel' } });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'CSRF_BLOCKED' } });
  }
  // A valid origin reaches validation; it is not exempted from the API contract.
  const malformed = await request.post('/api/workspaces/sample', { headers: { Origin: origin }, data: {} });
  expect(malformed.status()).toBe(422);
});

test('untrusted workspace text is displayed literally and survives reload without executing HTML', async ({ page }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const title = '<img src=x onerror=alert(1)> 합성 입력';
  let dialogCount = 0;
  page.on('dialog', async (dialog) => { dialogCount += 1; await dialog.dismiss(); });
  const created = await page.request.post('/api/workspaces', { headers: { Origin: origin }, data: { title, purpose: '합성 입력을 HTML이 아닌 자료로 보관합니다.' } });
  expect(created.status()).toBe(201);
  const workspace = await created.json() as WorkspaceView;
  try {
    await page.goto(`/app/workspaces/${workspace.id}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(dialogCount).toBe(0);
    await expect(page.getByRole('button', { name: /변경 자료 체험/ })).toHaveCount(0);
  } finally {
    expect((await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { Origin: origin } })).status()).toBe(204);
  }
});

function expectBaseUrl(baseURL: string | undefined): string {
  expect(baseURL).toBeTruthy();
  return new URL(baseURL as string).origin;
}
