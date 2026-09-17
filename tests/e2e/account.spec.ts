import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { AccountState } from '../../src/core/account-contracts';
import type { WorkspaceView } from '../../src/core/contracts';

type AccountFixture = { id: string; name: string; email: string; cookie: string; alternateCookie: string };
type StoredCookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];

const authCookieName = 'ieojim-auth.session_token';
const authCookiePrefix = `${authCookieName}=`;
const ownerCookieName = 'ieojim_owner';
const fixturesPath = '.wrangler/e2e-runtime/account-fixtures.json';

let accountFixtures: AccountFixture[] | null = null;

test.beforeAll(() => {
  mkdirSync('artifacts', { recursive: true });
});

test('login page starts OAuth through the server and never performs external Google I/O', async ({ page }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const googleRequests: string[] = [];
  await page.route('https://accounts.google.com/**', async (route) => {
    googleRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'blocked by e2e' });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/login?error=oauth&error_description=raw-server-text');

  await expect(page.getByRole('heading', { name: '내 계획, 다른 기기에서도 이어서.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Google 로그인을 마치지 못했어요. 다시 시도하거나 로그인 없이 계속 사용할 수 있어요.');
  await expect(page.getByText('raw-server-text')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Google 로그인으로 이동' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/account-login.png', fullPage: false });

  const loginResponsePromise = page.waitForResponse((response) =>
    response.url() === `${origin}/api/account/login` && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Google 로그인으로 이동' }).click();

  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status()).toBe(200);
  await expect.poll(() => googleRequests.length).toBeGreaterThanOrEqual(1);
  expect(googleRequests.every((url) => new URL(url).origin === 'https://accounts.google.com')).toBe(true);
  expect(new URL(googleRequests[0]).searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/callback/google`);
});

test('guest workspaces are not claimed automatically and require explicit confirmed transfer', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(0);
  const guest = await browser.newContext({ baseURL: origin });
  const accountOnly = await signedContext(browser, origin, account.cookie);
  const claimContext = await browser.newContext({ baseURL: origin });
  const claimPage = await claimContext.newPage();
  let workspaceId: string | null = null;

  try {
    const workspace = await createWorkspace(guest, origin, '게스트 이관 검증', '계정 이전은 사용자가 명시적으로 확인한 뒤에만 실행된다.');
    workspaceId = workspace.id;
    const guestOwner = await readRequiredCookie(guest, ownerCookieName);
    await addCookie(claimContext, origin, guestOwner);
    await addAuthCookie(claimContext, origin, account.cookie);

    const beforeAccountRead = await accountOnly.request.get(`/api/workspaces/${workspace.id}`);
    expect(beforeAccountRead.status()).toBe(404);

    await claimPage.setViewportSize({ width: 1280, height: 900 });
    await claimPage.goto('/settings');

    await expect(claimPage.getByRole('heading', { name: '계정과 게스트 작업 공간' })).toBeVisible();
    await expect(claimPage.getByText(account.name, { exact: true })).toBeVisible();
    await expect(claimPage.getByText(`대상 계정: ${account.name}`)).toBeVisible();
    await expect(claimPage.getByText('게스트 이관 검증')).toBeVisible();
    await expect(claimPage.getByRole('button', { name: '위 작업 공간 옮기기' })).toBeDisabled();
    await claimPage.screenshot({ path: 'artifacts/account-settings-desktop.png', fullPage: false });

    await claimPage.getByLabel('위 작업 공간을 현재 로그인된 계정으로 옮기는 것을 확인했습니다.').check();
    await expect(claimPage.getByRole('button', { name: '위 작업 공간 옮기기' })).toBeEnabled();
    await claimPage.getByRole('button', { name: '위 작업 공간 옮기기' }).click();

    await expect.poll(async () => (await accountOnly.request.get(`/api/workspaces/${workspace.id}`)).status()).toBe(200);
    await expect(claimPage.getByRole('region', { name: '게스트 작업 공간 옮기기' }).getByText('게스트 이관 검증')).toHaveCount(0);
    await expect(claimPage.getByRole('region', { name: '사용량과 보관' }).getByText('게스트 이관 검증')).toBeVisible();
    await expect(claimPage.locator('.account-success[role="status"]')).toHaveText('1개 작업 공간을 계정으로 옮겼습니다.');

    const oldGuest = await browser.newContext({ baseURL: origin });
    try {
      await addCookie(oldGuest, origin, guestOwner);
      expect((await oldGuest.request.get(`/api/workspaces/${workspace.id}`)).status()).toBe(404);
    } finally {
      await oldGuest.close();
    }
  } finally {
    if (workspaceId) await deleteWorkspace(accountOnly, origin, workspaceId);
    await Promise.all([guest.close(), accountOnly.close(), claimContext.close()]);
  }
});

test('accepted claim can be retried with the same request id after a lost response', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(1);
  const guest = await browser.newContext({ baseURL: origin });
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  let workspaceId: string | null = null;
  const requestIds: string[] = [];

  try {
    const workspace = await createWorkspace(guest, origin, '끊긴 응답 재시도', '서버 수락 뒤 응답이 끊겨도 같은 요청으로 재시도한다.');
    workspaceId = workspace.id;
    await addCookie(context, origin, await readRequiredCookie(guest, ownerCookieName));
    await addAuthCookie(context, origin, account.cookie);

    let failFirstClaimResponse = true;
    await page.route('**/api/account/claim', async (route) => {
      const payload = route.request().postDataJSON() as { requestId?: string };
      if (payload.requestId) requestIds.push(payload.requestId);
      if (failFirstClaimResponse) {
        failFirstClaimResponse = false;
        const accepted = await route.fetch();
        await accepted.body();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.goto('/settings');
    await expect(page.getByText('끊긴 응답 재시도')).toBeVisible();
    await page.getByLabel('위 작업 공간을 현재 로그인된 계정으로 옮기는 것을 확인했습니다.').check();
    await page.getByRole('button', { name: '위 작업 공간 옮기기' }).click();

    await expect(page.getByRole('alert')).toContainText('계정 요청을 처리하지 못했습니다.');
    await expect(page.getByRole('button', { name: '위 작업 공간 옮기기' })).toBeEnabled();
    await page.getByRole('button', { name: '위 작업 공간 옮기기' }).click();

    await expect.poll(async () => (await context.request.get(`/api/workspaces/${workspace.id}`)).status()).toBe(200);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).toBe(requestIds[0]);
  } finally {
    if (workspaceId) await deleteWorkspace(context, origin, workspaceId);
    await Promise.all([guest.close(), context.close()]);
  }
});

test('stale guest preview refreshes and requires renewed consent before claim', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(2);
  const guest = await browser.newContext({ baseURL: origin });
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  const createdIds: string[] = [];

  try {
    const first = await createWorkspace(guest, origin, '이전 미리보기', '첫 번째 게스트 작업 공간');
    createdIds.push(first.id);
    const guestOwner = await readRequiredCookie(guest, ownerCookieName);
    await addCookie(context, origin, guestOwner);
    await addAuthCookie(context, origin, account.cookie);

    await page.goto('/settings');
    await expect(page.getByText('이전 미리보기')).toBeVisible();
    await page.getByLabel('위 작업 공간을 현재 로그인된 계정으로 옮기는 것을 확인했습니다.').check();
    await expect(page.getByRole('button', { name: '위 작업 공간 옮기기' })).toBeEnabled();

    const guestOnly = await browser.newContext({ baseURL: origin });
    try {
      await addCookie(guestOnly, origin, guestOwner);
      const second = await createWorkspace(guestOnly, origin, '새로 추가된 미리보기', '미리보기 해시가 바뀌어야 하는 두 번째 작업 공간');
      createdIds.push(second.id);
    } finally {
      await guestOnly.close();
    }

    await page.getByRole('button', { name: '위 작업 공간 옮기기' }).click();

    await expect(page.getByText('새로 추가된 미리보기')).toBeVisible();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('위 작업 공간을 현재 로그인된 계정으로 옮기는 것을 확인했습니다.')).not.toBeChecked();
    await expect(page.getByRole('button', { name: '위 작업 공간 옮기기' })).toBeDisabled();

    await page.getByLabel('위 작업 공간을 현재 로그인된 계정으로 옮기는 것을 확인했습니다.').check();
    await page.getByRole('button', { name: '위 작업 공간 옮기기' }).click();
    for (const id of createdIds) {
      await expect.poll(async () => (await context.request.get(`/api/workspaces/${id}`)).status()).toBe(200);
    }
  } finally {
    for (const id of createdIds) await deleteWorkspace(context, origin, id);
    await Promise.all([guest.close(), context.close()]);
  }
});

test('logout clears private UI, auth cookie, and current-account workspace access', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(3);
  const context = await signedContext(browser, origin, account.cookie);
  const page = await context.newPage();
  let workspaceId: string | null = null;

  try {
    const workspace = await createWorkspace(context, origin, '로그아웃 접근 검증', '로그아웃 후 계정 작업 공간은 현재 브라우저에서 읽히지 않아야 한다.');
    workspaceId = workspace.id;
    await page.goto('/settings');
    await expect(page.getByText(account.email)).toBeVisible();

    await page.getByRole('button', { name: '로그아웃', exact: true }).click();

    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { name: /내 계획,.*여기서 이어가세요/ })).toBeVisible();
    expect((await context.cookies()).some((cookie) => cookie.name === authCookieName)).toBe(false);
    expect((await page.request.get(`/api/workspaces/${workspace.id}`)).status()).toBe(404);
  } finally {
    if (workspaceId) {
      const cleanup = await signedContext(browser, origin, account.alternateCookie);
      await deleteWorkspace(cleanup, origin, workspaceId);
      await cleanup.close();
    }
    await context.close();
  }
});

test('revoking other sessions keeps the current device and makes the alternate session unauthorized', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(4);
  const current = await signedContext(browser, origin, account.cookie);
  const alternate = await signedContext(browser, origin, account.alternateCookie);
  const page = await current.newPage();

  try {
    expect((await alternate.request.get('/api/account')).status()).toBe(200);
    await page.goto('/settings');
    await page.getByRole('button', { name: '다른 기기에서 로그아웃' }).click();

    await expect(page.getByRole('button', { name: '다른 기기에서 로그아웃' })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveText('다른 기기에서 로그아웃했어요.');
    const currentState = await readAccountState(current);
    expect(currentState.user?.id).toBe(account.id);
    const staleWrite = await alternate.request.post('/api/account/revoke-other-sessions', { headers: { Origin: origin }, data: {} });
    expect(staleWrite.status()).toBe(401);
  } finally {
    await Promise.all([current.close(), alternate.close()]);
  }
});

test('workspace reloads to home when the signed-in identity changes on focus', async ({ browser }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const first = fixture(5);
  const second = fixture(6);
  const context = await signedContext(browser, origin, first.cookie);
  const page = await context.newPage();
  let workspaceId: string | null = null;

  try {
    const workspace = await createWorkspace(context, origin, '계정 전환 감지', '다른 계정 쿠키가 들어오면 기존 작업 화면을 유지하지 않는다.');
    workspaceId = workspace.id;
    await page.goto(`/app/workspaces/${workspace.id}`);
    await expect(page.getByRole('heading', { name: '계정 전환 감지' })).toBeVisible();
    await addAuthCookie(context, origin, second.cookie);

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { name: /내 계획,.*여기서 이어가세요/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '계정 전환 감지' })).toHaveCount(0);
  } finally {
    if (workspaceId) {
      const cleanup = await signedContext(browser, origin, first.cookie);
      await deleteWorkspace(cleanup, origin, workspaceId);
      await cleanup.close();
    }
    await context.close();
  }
});

test('mobile login and settings remain readable, keyboard reachable, and overflow-free at 320px', async ({ browser, page }, testInfo) => {
  const origin = expectBaseUrl(testInfo.project.use.baseURL);
  const account = fixture(7);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route('**/api/account', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authAvailable: false, provider: 'google', user: null, sessionExpiresAt: null, guestPreview: null, retentionDays: 7 } satisfies AccountState),
    });
  });

  await page.goto('/login');

  await expect(page.getByRole('heading', { name: '내 계획, 다른 기기에서도 이어서.' })).toBeVisible();
  await expect(page.getByText('지금은 Google 로그인을 사용할 수 없어요.')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const guestEntry = page.getByRole('link', { name: '게스트 작업 공간으로 이동' });
  await guestEntry.focus();
  await expect(guestEntry).toBeFocused();

  const guest = await browser.newContext({ baseURL: origin, viewport: { width: 320, height: 900 } });
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 320, height: 900 } });
  const settingsPage = await context.newPage();
  let workspaceId: string | null = null;

  try {
    const workspace = await createWorkspace(guest, origin, '모바일 이관 검증', '320px 화면에서도 계정 이전 확인이 가능해야 한다.');
    workspaceId = workspace.id;
    await addCookie(context, origin, await readRequiredCookie(guest, ownerCookieName));
    await addAuthCookie(context, origin, account.cookie);
    await settingsPage.goto('/settings');

    await expect(settingsPage.getByRole('heading', { name: '계정과 게스트 작업 공간' })).toBeVisible();
    await expect(settingsPage.getByText('모바일 이관 검증')).toBeVisible();
    await expectNoHorizontalOverflow(settingsPage);
    await settingsPage.screenshot({ path: 'artifacts/account-claim-mobile.png', fullPage: false });

    const consent = settingsPage.getByLabel('위 작업 공간을 현재 로그인된 계정으로 옮기는 것을 확인했습니다.');
    await consent.focus();
    await expect(consent).toBeFocused();
    await settingsPage.keyboard.press('Space');
    await expect(consent).toBeChecked();
    await expect(settingsPage.getByRole('button', { name: '위 작업 공간 옮기기' })).toBeEnabled();
  } finally {
    if (workspaceId) await deleteWorkspace(guest, origin, workspaceId);
    await Promise.all([guest.close(), context.close()]);
  }
});

function fixture(index: number): AccountFixture {
  accountFixtures ??= JSON.parse(readFileSync(fixturesPath, 'utf8')) as AccountFixture[];
  const value = accountFixtures[index];
  expect(value, `missing account fixture ${index}`).toBeTruthy();
  return value;
}

function expectBaseUrl(baseURL: string | undefined): string {
  expect(baseURL).toBeTruthy();
  return new URL(baseURL as string).origin;
}

async function signedContext(browser: Browser, origin: string, cookie: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: origin });
  await addAuthCookie(context, origin, cookie);
  return context;
}

async function addAuthCookie(context: BrowserContext, origin: string, cookie: string): Promise<void> {
  const raw = cookie.startsWith(authCookiePrefix) ? cookie.slice(authCookiePrefix.length) : cookie;
  await addCookie(context, origin, {
    name: authCookieName,
    value: raw.split(';', 1)[0],
    domain: new URL(origin).hostname,
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  });
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

async function deleteWorkspace(context: BrowserContext, origin: string, workspaceId: string): Promise<void> {
  const response = await context.request.delete(`/api/workspaces/${workspaceId}`, { headers: { Origin: origin } });
  expect([204, 404]).toContain(response.status());
}

async function readAccountState(context: BrowserContext): Promise<AccountState> {
  const response = await context.request.get('/api/account');
  expect(response.status()).toBe(200);
  return await response.json() as AccountState;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}
