import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { WorkspaceView } from '../../src/core/contracts';

const screenshots = 'artifacts/horizontal-product-2026-09-14';
test.beforeAll(() => mkdirSync(screenshots, { recursive: true }));
test.afterEach(async ({ page }) => {
  const response = await page.request.get('/api/workspaces');
  if (!response.ok()) return;
  const workspaces = await response.json() as Array<{ id: string }>;
  for (const workspace of workspaces) {
    await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { origin: 'http://127.0.0.1:5174' } });
  }
});

test('generic landing offers three contexts and creates only a user-requested empty real workspace', async ({ page }) => {
  const apiRequests: string[] = [];
  const previewRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    if (request.url().includes('coordination-demo-model')) previewRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('일정 하나 바뀌었다고,처음부터 다시 짜지 마세요.');
  for (const [scenario, label] of [['coordination', '업무·프로젝트'], ['syllabus', '학업·과제'], ['departure', '생활·약속']]) {
    await expect(contextLink(page, scenario!, label!)).toBeVisible();
  }
  expect(apiRequests).toEqual([]);
  expect(previewRequests).toEqual([]);
  await page.screenshot({ path: `${screenshots}/landing-desktop.png`, fullPage: true });
  await page.screenshot({ path: `${screenshots}/landing-desktop-viewport.png` });
  await page.getByRole('link', { name: '내 안내로 시작하기', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\?template=custom$/);
  await expect(page.getByRole('heading', { name: /내 계획,.*여기서 이어가세요/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '직접 설정', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(apiRequests.filter((request) => request.startsWith('POST'))).toEqual([]);
  await page.getByLabel('작업 이름', { exact: true }).fill('나의 발표 준비');
  await page.getByRole('textbox', { name: '목적', exact: true }).fill('새 공지의 일정과 준비 항목을 확인하고 내 결정을 보존한다.');
  const creating = page.waitForResponse((response) => response.url().endsWith('/api/workspaces') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  const response = await creating;
  expect(response.status()).toBe(201);
  const created = await response.json() as WorkspaceView;
  expect(created.title).toBe('나의 발표 준비');
  expect(created.sampleScenario).toBeNull();
  expect(created.sources).toEqual([]);
  expect(created.runs).toEqual([]);
  expect(created.snapshot.blocks).toEqual([]);
  expect(apiRequests.filter((request) => request.startsWith('POST'))).toEqual(['POST /api/workspaces']);
});

for (const entry of [
  { scenario: 'coordination', label: '업무·프로젝트', button: '고객 미팅 변경 체험 시작' },
  { scenario: 'syllabus', label: '학업·과제', button: '과제 예시 열기' },
  { scenario: 'departure', label: '생활·약속', button: '출발 전날 복합 체험 시작' },
] as const) {
  test(`${entry.label} entry selects its own sample without creating it on navigation`, async ({ page }) => {
    const writes: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.method());
    });
    await page.goto('/');
    await contextLink(page, entry.scenario, entry.label).click();
    await expect(page).toHaveURL(new RegExp(`/app\\?example=${entry.scenario}$`));
    const start = page.getByRole('button', { name: entry.button, exact: true });
    await expect(start).toBeVisible();
    expect(writes).toEqual([]);
    const creating = page.waitForResponse((response) => response.url().endsWith('/api/workspaces/sample') && response.request().method() === 'POST');
    await start.click();
    const response = await creating;
    expect(response.status()).toBe(201);
    const created = await response.json() as WorkspaceView;
    expect(created.sampleScenario).toBe(entry.scenario);
    expect(created.sources).toHaveLength(1);
    expect(created.snapshot.blocks.length).toBeGreaterThan(0);
    expect(writes).toEqual(['POST']);
    await page.reload();
    await expect(page.getByRole('heading', { name: created.title, exact: true })).toBeVisible();
    const reloaded = await page.request.get(`/api/workspaces/${created.id}`);
    expect((await reloaded.json() as WorkspaceView).sampleScenario).toBe(entry.scenario);
  });
}

test('generic, travel and meeting drafts remain separate through switches and a created workspace', async ({ page }) => {
  await page.goto('/app?template=custom');
  await page.getByLabel('작업 이름', { exact: true }).fill('개인 프로젝트 초안');
  await page.getByRole('textbox', { name: '목적', exact: true }).fill('안내 변경을 따라가며 완료 기록을 지킨다.');
  await page.getByRole('button', { name: '여행 계획', exact: true }).click();
  await page.getByLabel('작업 이름', { exact: true }).fill('가족 약속');
  await page.getByRole('button', { name: '미팅 준비', exact: true }).click();
  await page.getByLabel('작업 이름', { exact: true }).fill('발표 미팅');
  await page.getByRole('button', { name: '직접 설정', exact: true }).click();
  await expect(page.getByLabel('작업 이름', { exact: true })).toHaveValue('개인 프로젝트 초안');
  await expect(page.getByRole('textbox', { name: '목적', exact: true })).toHaveValue('안내 변경을 따라가며 완료 기록을 지킨다.');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '개인 프로젝트 초안', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '최근 작업 보기', exact: true }).click();
  await expect(page.getByLabel('작업 이름', { exact: true })).toHaveValue('개인 프로젝트 초안');
  await page.getByRole('button', { name: '미팅 준비', exact: true }).click();
  await expect(page.getByLabel('작업 이름', { exact: true })).toHaveValue('발표 미팅');
  await page.getByRole('button', { name: '여행 계획', exact: true }).click();
  await expect(page.getByLabel('작업 이름', { exact: true })).toHaveValue('가족 약속');
});

test('unrecognized entry parameters fall back to generic setup without writes', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.method());
  });
  await page.goto('/app?template=%3Cscript%3E&example=unknown');
  await expect(page.getByRole('heading', { name: /내 계획,.*여기서 이어가세요/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '직접 설정', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: '어떤 예시로 시작할까요?', exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test('meeting preview requires both human decisions and remains API-silent', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByText('고정한 일정과 완료 기록을 바꾸려 할 때', { exact: true }).click();
  const preview = page.locator('.coordination-demo');
  await preview.getByRole('button', { name: '미팅 변경 보기', exact: true }).focus();
  await page.keyboard.press('Enter');
  const briefing = preview.getByRole('group', { name: '사전 보고 선택', exact: true });
  const print = preview.getByRole('group', { name: '인쇄본 확인 선택', exact: true });
  const compare = preview.getByRole('button', { name: '검증된 결과 보기', exact: true });
  await expect(compare).toBeDisabled();
  await briefing.getByRole('button', { name: '내 결정 유지', exact: true }).click();
  await expect(compare).toBeDisabled();
  await print.getByRole('button', { name: '새 안내 반영', exact: true }).click();
  await compare.click();
  await expect(preview.getByRole('heading', { name: '미팅 선택 결과', exact: true })).toBeVisible();
  const results = preview.getByRole('region', { name: '미팅 선택 결과', exact: true });
  const resultRow = (label: string) => results.locator('article').filter({ has: page.locator('strong', { hasText: label }) });
  await expect(resultRow('고객 미팅')).toContainText('2026-09-18 16:00');
  await expect(resultRow('사전 보고').locator('p')).toHaveText('2026-09-18 13:00');
  await expect(resultRow('인쇄본 확인')).toContainText('삭제됨');
  await expect(resultRow('발표자료 정리')).toContainText('준비 마감 2026-09-17');
  await expect(resultRow('발표자료 정리')).toContainText('예상 90분');
  await expect(resultRow('발표자료 정리')).toContainText('재검토 필요');
  await page.screenshot({ path: `${screenshots}/meeting-result.png`, fullPage: true });
  await results.screenshot({ path: `${screenshots}/meeting-result-detail.png` });
  await briefing.getByRole('button', { name: '새 안내 반영', exact: true }).click();
  await expect(preview.getByRole('heading', { name: '미팅 선택 결과', exact: true })).toHaveCount(0);
  await compare.click();
  await expect(preview.getByRole('heading', { name: '미팅 선택 결과', exact: true })).toBeVisible();
  await expect(resultRow('사전 보고')).toContainText('2026-09-18 15:00');
  await expect(resultRow('사전 보고')).toContainText('고정 유지');
  expect(apiRequests).toEqual([]);
});

test('failed meeting preview keeps a usable real-source entry and never claims a result', async ({ page }) => {
  await page.route('**/*coordination-demo-model*', (route) => route.abort());
  await page.goto('/');
  await page.getByText('고정한 일정과 완료 기록을 바꾸려 할 때', { exact: true }).click();
  const preview = page.locator('.coordination-demo');
  await preview.getByRole('button', { name: '미팅 변경 보기', exact: true }).click();
  await expect(preview.getByRole('alert')).toBeVisible();
  await expect(preview.getByRole('heading', { name: '미팅 선택 결과', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '내 안내로 시작하기', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\?template=custom$/);
  await expect(page.getByRole('button', { name: '만들기', exact: true })).toBeVisible();
});

test('mobile generic entry and academic context stay readable at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: '내 안내로 시작하기', exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/landing-mobile.png`, fullPage: true });
  await page.screenshot({ path: `${screenshots}/landing-mobile-viewport.png` });
  await contextLink(page, 'syllabus', '학업·과제').click();
  await expect(page.getByRole('heading', { name: /과제 준비,.*여기서 이어가세요/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/academic-mobile.png`, fullPage: true });
});

function contextLink(page: Page, scenario: string, label: string) {
  return page.locator(`a[href="/app?example=${scenario}"]`).filter({ hasText: label }).first();
}
