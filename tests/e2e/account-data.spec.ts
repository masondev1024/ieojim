import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { AccountUsage } from '../../src/core/account-contracts';
import type { WorkspaceView } from '../../src/core/contracts';
import { workspaceExportSchema, type WorkspaceExport } from '../../src/core/export-contracts';

type AccountFixture = { id: string; name: string; email: string; cookie: string; alternateCookie: string };
type StoredCookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];

const authCookieName = 'ieojim-auth.session_token';
const authCookiePrefix = `${authCookieName}=`;
const ownerCookieName = 'ieojim_owner';
const fixturesPath = '.wrangler/e2e-runtime/account-fixtures.json';

let accountFixtures: AccountFixture[] | null = null;

test('settings shows real account usage after creating and claiming workspaces', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(8);
  const accountContext = await signedContext(browser, origin, account.cookie);
  const guestContext = await browser.newContext({ baseURL: origin });
  const page = await accountContext.newPage();
  const createdIds: string[] = [];

  try {
    const accountWorkspace = await createWorkspace(accountContext, origin, '계정 사용량 검증', '계정 작업 공간 수와 만료 시각을 설정 화면에서 확인한다.');
    createdIds.push(accountWorkspace.id);
    const guestWorkspace = await createWorkspace(guestContext, origin, '이관 후 사용량 검증', '게스트에서 계정으로 옮긴 뒤 사용량 목록에 보여야 한다.');
    createdIds.push(guestWorkspace.id);
    await addCookie(accountContext, origin, await readRequiredCookie(guestContext, ownerCookieName));

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '사용량과 보관' })).toBeVisible();
    await expect(page.getByText('계정 사용량 검증')).toBeVisible();
    await expect(page.getByText(`대상 계정: ${account.name}`)).toBeVisible();

    await page.getByLabel('위 작업 공간을 현재 로그인된 계정으로 옮기는 것을 확인했습니다.').check();
    await page.getByRole('button', { name: '위 작업 공간 옮기기' }).click();

    await expect(page.getByRole('link', { name: /이관 후 사용량 검증/ })).toBeVisible();
    const usage = await readAccountUsage(accountContext);
    expect(usage.workspaces.map((workspace) => workspace.title)).toEqual(expect.arrayContaining(['계정 사용량 검증', '이관 후 사용량 검증']));
    const usageRegion = page.getByLabel('계정 사용량');
    await expect(usageRegion).toContainText(`${usage.activeWorkspaces.used} / ${usage.activeWorkspaces.limit}`);
    await expect(usageRegion).toContainText(`${usage.aiRunsToday.used} / ${usage.aiRunsToday.limit}`);
    await expect(usageRegion).toContainText('UTC');
    await expect(page.getByRole('link', { name: /계정 사용량 검증/ })).toHaveAttribute('href', `/app/workspaces/${accountWorkspace.id}`);
    await expect(page.getByRole('link', { name: /이관 후 사용량 검증/ })).toHaveAttribute('href', `/app/workspaces/${guestWorkspace.id}`);
  } finally {
    for (const id of createdIds) await deleteWorkspace(accountContext, origin, id);
    await Promise.all([accountContext.close(), guestContext.close()]);
  }
});

test('settings rejects malformed usage without keeping previous private counts', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(8);
  const context = await signedContext(browser, origin, account.alternateCookie);
  const page = await context.newPage();
  let workspaceId: string | null = null;
  let malformedUsage = false;

  await page.route('**/api/account/usage', async (route) => {
    if (malformedUsage) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ asOf: 'not-a-date', activeWorkspaces: { used: 99, limit: 0 }, workspaces: [] }),
      });
      return;
    }
    await route.continue();
  });

  try {
    const workspace = await createWorkspace(context, origin, '사용량 형식 검증', '이전 사용량이 오류 뒤 화면에 남지 않아야 한다.');
    workspaceId = workspace.id;
    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: '사용량과 보관' })).toBeVisible();
    const initialUsage = await readAccountUsage(context);
    const previousActiveCount = `${initialUsage.activeWorkspaces.used} / ${initialUsage.activeWorkspaces.limit}`;
    await expect(page.getByLabel('계정 사용량')).toContainText(previousActiveCount);

    malformedUsage = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await expect(page.getByRole('alert')).toContainText('계정 정보를 확인하지 못했어요. 다시 불러와 주세요.');
    await expect(page.getByLabel('계정 사용량')).toHaveCount(0);
    await expect(page.getByText(previousActiveCount)).toHaveCount(0);
    await expect(page.getByText('99 / 0')).toHaveCount(0);
    await expect(page.getByText('0 / 0')).toHaveCount(0);

    malformedUsage = false;
    await page.getByRole('button', { name: '사용량 다시 불러오기' }).click();

    await expect(page.getByLabel('계정 사용량')).toBeVisible();
    await expect(page.getByText('0 / 0')).toHaveCount(0);
  } finally {
    if (workspaceId) await deleteWorkspace(context, origin, workspaceId);
    await context.close();
  }
});

test('guest settings do not call the account usage API and remain mobile readable', async ({ page }, testInfo) => {
  expectBaseUrl(testInfo.project.use.baseURL);
  const usageRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/account/usage') usageRequests.push(request.url());
  });
  await page.setViewportSize({ width: 320, height: 900 });

  await page.goto('/settings');

  await expect(page.getByRole('heading', { name: '계정과 게스트 작업 공간' })).toBeVisible();
  await expect(page.getByText('로그인 없이 만든 작업은 이 브라우저에서만 열 수 있어요. 7일 동안 열거나 수정하지 않으면 삭제될 수 있어요.')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(usageRequests).toEqual([]);
});

test('workspace export downloads verified current plan and source JSON without private fields', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(9);
  const context = await signedContext(browser, origin, account.cookie, { viewport: { width: 320, height: 900 } });
  const page = await context.newPage();
  let workspaceId: string | null = null;

  try {
    const sample = await createSampleWorkspace(context, origin, 'travel');
    workspaceId = sample.id;
    const firstItem = sample.snapshot.blocks.flatMap((block) => block.items).at(0);
    expect(firstItem).toBeTruthy();
    const edited = await patchItem(context, origin, sample.id, sample.revision, firstItem!.id, { locked: true, completed: true });

    await page.goto(`/app/workspaces/${sample.id}`);
    await page.getByRole('button', { name: '변경 이력', exact: true }).click();
    await expect(page.getByRole('button', { name: '현재 계획·원문 내려받기' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '현재 계획·원문 내려받기' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`ieojim-workspace-${sample.id}.json`);
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
    const payload = workspaceExportSchema.parse(JSON.parse(readFileSync(downloadedPath!, 'utf8'))) as WorkspaceExport;
    expect(payload.content.workspace.id).toBe(sample.id);
    expect(payload.content.workspace.revision).toBe(edited.revision);
    expect(payload.content.sources.length).toBeGreaterThan(0);
    expect(payload.checksum.value).toBe(sha256Hex(JSON.stringify(payload.content)));
    expect(payload.content.snapshot.blocks.flatMap((block) => block.items).some((item) => item.locked && item.completed)).toBe(true);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/owner(Id|_id)|account(Id|_id)|token|session|ledger|command/i);
    expect(serialized).not.toContain('pending');

    const foreign = await signedContext(browser, origin, fixture(8).alternateCookie);
    try {
      const forbidden = await foreign.request.get(`/api/workspaces/${sample.id}/export`);
      expect([401, 404]).toContain(forbidden.status());
    } finally {
      await foreign.close();
    }
  } finally {
    if (workspaceId) await deleteWorkspace(context, origin, workspaceId);
    await context.close();
  }
});

test('workspace export refuses unauthorized or malformed responses and cancels after leaving the workspace', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(9);
  const context = await signedContext(browser, origin, account.cookie);
  const page = await context.newPage();
  let workspaceId: string | null = null;

  try {
    const workspace = await createWorkspace(context, origin, '내려받기 실패 검증', '실패 응답은 파일로 저장하지 않는다.');
    workspaceId = workspace.id;
    await page.goto(`/app/workspaces/${workspace.id}`);
    await page.getByRole('button', { name: '변경 이력', exact: true }).click();

    let responseMode: 'unauthorized' | 'malformed' | 'delayed' = 'unauthorized';
    let releaseDelayed: (() => void) | null = null;
    await page.route(`**/api/workspaces/${workspace.id}/export`, async (route) => {
      if (responseMode === 'unauthorized') {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'LOGIN_REQUIRED', message: '로그인 후 이용할 수 있습니다.' } }) });
        return;
      }
      if (responseMode === 'malformed') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ format: 'wrong' }) });
        return;
      }
      await new Promise<void>((resolve) => { releaseDelayed = resolve; });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(await makeExportPayload(workspace)) });
    });

    let download = await clickAndMaybeDownload(page);
    expect(download).toBe(false);
    await expect(page.getByRole('alert')).toContainText('로그인 후 이용할 수 있습니다.');

    responseMode = 'malformed';
    download = await clickAndMaybeDownload(page);
    expect(download).toBe(false);
    await expect(page.getByRole('alert')).toContainText('내려받기 응답 형식이 올바르지 않습니다.');

    responseMode = 'delayed';
    const noDownload = page.waitForEvent('download', { timeout: 800 }).then(() => true).catch(() => false);
    await page.getByRole('button', { name: '현재 계획·원문 내려받기' }).click();
    await expect.poll(() => Boolean(releaseDelayed)).toBe(true);
    await page.goto('/app');
    releaseDelayed!();
    expect(await noDownload).toBe(false);
  } finally {
    if (workspaceId) await deleteWorkspace(context, origin, workspaceId);
    await context.close();
  }
});

function fixture(index: 8 | 9): AccountFixture {
  accountFixtures ??= JSON.parse(readFileSync(fixturesPath, 'utf8')) as AccountFixture[];
  const value = accountFixtures[index];
  expect(value, `missing account fixture ${index}`).toBeTruthy();
  return value;
}

function expectBaseUrl(baseURL: string | undefined): string {
  expect(baseURL).toBeTruthy();
  return new URL(baseURL as string).origin;
}

async function signedContext(browser: Browser, origin: string, cookie: string, options: { viewport?: { width: number; height: number } } = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: origin, viewport: options.viewport });
  await addAuthCookie(context, origin, cookie);
  return context;
}

async function addAuthCookie(context: BrowserContext, origin: string, cookie: string): Promise<void> {
  const raw = cookie.startsWith(authCookiePrefix) ? cookie.slice(authCookiePrefix.length) : cookie;
  await addCookie(context, origin, { name: authCookieName, value: raw.split(';', 1)[0], httpOnly: true });
}

async function addCookie(context: BrowserContext, origin: string, cookie: Pick<StoredCookie, 'name' | 'value'> & Partial<StoredCookie>): Promise<void> {
  await context.addCookies([{ name: cookie.name, value: cookie.value, domain: new URL(origin).hostname, path: '/', httpOnly: cookie.httpOnly ?? true, sameSite: 'Lax' }]);
}

async function readRequiredCookie(context: BrowserContext, name: string): Promise<StoredCookie> {
  const cookie = (await context.cookies()).find((candidate) => candidate.name === name);
  expect(cookie, `missing cookie ${name}`).toBeTruthy();
  return cookie as StoredCookie;
}

async function createWorkspace(context: BrowserContext, origin: string, title: string, purpose: string): Promise<WorkspaceView> {
  const response = await context.request.post('/api/workspaces', { headers: { Origin: origin }, data: { title, purpose } });
  expect(response.status()).toBe(201);
  return await response.json() as WorkspaceView;
}

async function createSampleWorkspace(context: BrowserContext, origin: string, scenario: 'travel' | 'syllabus'): Promise<WorkspaceView> {
  const response = await context.request.post('/api/workspaces/sample', { headers: { Origin: origin }, data: { scenario } });
  expect(response.status()).toBe(201);
  return await response.json() as WorkspaceView;
}

async function patchItem(
  context: BrowserContext,
  origin: string,
  workspaceId: string,
  baseRevision: number,
  itemId: string,
  patch: { locked?: boolean; completed?: boolean },
): Promise<WorkspaceView> {
  const response = await context.request.patch(`/api/workspaces/${workspaceId}/items`, {
    headers: { Origin: origin },
    data: { baseRevision, requestId: crypto.randomUUID(), itemId, ...patch },
  });
  expect(response.status()).toBe(200);
  return await response.json() as WorkspaceView;
}

async function deleteWorkspace(context: BrowserContext, origin: string, workspaceId: string): Promise<void> {
  const response = await context.request.delete(`/api/workspaces/${workspaceId}`, { headers: { Origin: origin } });
  expect([204, 404]).toContain(response.status());
}

async function readAccountUsage(context: BrowserContext): Promise<AccountUsage> {
  const response = await context.request.get('/api/account/usage');
  expect(response.status()).toBe(200);
  return await response.json() as AccountUsage;
}

async function clickAndMaybeDownload(page: Page): Promise<boolean> {
  const download = page.waitForEvent('download', { timeout: 800 }).then(() => true).catch(() => false);
  await page.getByRole('button', { name: '현재 계획·원문 내려받기' }).click();
  return await download;
}

async function makeExportPayload(workspace: WorkspaceView): Promise<WorkspaceExport> {
  const content = {
    workspace: {
      id: workspace.id,
      title: workspace.title,
      purpose: workspace.purpose,
      revision: workspace.revision,
      sourceRevision: workspace.sourceRevision,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
      expiresAt: workspace.expiresAt,
    },
    sources: workspace.sources,
    snapshot: workspace.snapshot,
  };
  return {
    format: 'ieojim.workspace',
    version: 1,
    exportedAt: '2026-09-10T00:00:00.000Z',
    content,
    checksum: { algorithm: 'SHA-256', encoding: 'JSON.stringify(content), UTF-8', value: sha256Hex(JSON.stringify(content)) },
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}
