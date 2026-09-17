import { expect, request as playwrightRequest, test } from '@playwright/test';

const service = 'https://ieojim.jungseongheon.org';
const portfolio = 'https://jungseongheon.org';

test('public privacy and terms pages load directly with protected HTML headers and readable mobile layout', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  for (const [path, title] of [['/privacy', '개인정보 처리 안내'], ['/terms', '서비스 이용 조건']]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-transform');
    expect(await response.text()).not.toContain('static.cloudflareinsights.com');
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'masondev1024@gmail.com' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('apex entry redirects exactly, without forwarding query data or changing portfolio paths', async ({ request }) => {
  for (const path of ['/ieojim', '/ieojim/', '/ieojim?private=synthetic', '/ieojim/?next=https://example.invalid']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request.fetch(`${portfolio}${path}`, { method, maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers().location).toBe(`${service}/`);
    }
  }
  for (const path of ['/', '/portfolio/']) {
    const response = await request.get(`${portfolio}${path}`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers().location).toBeUndefined();
  }
  for (const path of ['/ieojimX', '/ieojim/nested', '/IEOJIM']) {
    const response = await request.get(`${portfolio}${path}`, { maxRedirects: 0 });
    expect(response.headers().location).toBeUndefined();
  }
  const post = await request.post(`${portfolio}/ieojim`, { maxRedirects: 0 });
  expect(post.headers().location).toBeUndefined();
});

test('legacy workers.dev guest can still create, read and delete its own workspace', async ({ page }) => {
  const origin = 'https://ieojim-staging.masondev1024.workers.dev';
  const legacy = await playwrightRequest.newContext({ baseURL: origin });
  let id: string | undefined;
  try {
    expect((await legacy.get('/')).status()).toBe(200);
    const account = await legacy.get('/api/account');
    expect(account.status()).toBe(200);
    expect(await account.json()).toMatchObject({ authAvailable: false, user: null });
    await page.goto(`${origin}/login`);
    await expect(page.getByRole('button', { name: 'Google 로그인으로 이동' })).toHaveCount(0);
    await page.goto(`${origin}/settings`);
    await expect(page.getByRole('link', { name: 'Google 로그인으로 이동' })).toHaveCount(0);
    const created = await legacy.post('/api/workspaces/sample', {
      headers: { Origin: origin }, data: { scenario: 'travel' },
    });
    expect(created.status()).toBe(201);
    id = (await created.json() as { id: string }).id;
    const cookie = created.headers()['set-cookie'];
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    expect((await legacy.get(`/api/workspaces/${id}`)).status()).toBe(200);
    expect((await legacy.get(`${service}/api/workspaces/${id}`)).status()).toBe(404);
  } finally {
    try {
      if (id) expect((await legacy.delete(`/api/workspaces/${id}`, { headers: { Origin: origin } })).status()).toBe(204);
    } finally { await legacy.dispose(); }
  }
});

test('parent domain is not a trusted write origin and guest cookies remain host-only', async ({ request, baseURL }) => {
  expect(baseURL).toBe(service);
  const rejected = await request.post('/api/workspaces/sample', {
    headers: { Origin: portfolio }, data: { scenario: 'travel' },
  });
  expect(rejected.status()).toBe(403);
  expect(await rejected.json()).toMatchObject({ error: { code: 'CSRF_BLOCKED' } });
  expect(rejected.headers()['set-cookie']).toBeUndefined();

  let id: string | undefined;
  try {
    const created = await request.post('/api/workspaces/sample', {
      headers: { Origin: service }, data: { scenario: 'travel' },
    });
    expect(created.status()).toBe(201);
    id = (await created.json() as { id: string }).id;
    const cookie = created.headers()['set-cookie'];
    expect(cookie).toContain('ieojim_owner=');
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    const oldHost = await request.get(`https://ieojim-staging.masondev1024.workers.dev/api/workspaces/${id}`);
    expect(oldHost.status()).toBe(404);
  } finally {
    if (id) expect((await request.delete(`/api/workspaces/${id}`, { headers: { Origin: service } })).status()).toBe(204);
  }
});

test('IEOJIM landing keeps entry usable at 320px without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: '이어짐 홈', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /일정 하나 바뀌었다고/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: '체험용 예시 열기', exact: true }).first().click();
  await expect(page).toHaveURL(`${service}/app?example=departure`);
  await expect(page.getByRole('heading', { name: /여행 준비,.*여기서 이어가세요/ })).toBeVisible();
});
