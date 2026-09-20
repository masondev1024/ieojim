import { expect, test, type Page } from '@playwright/test';
import type { RecoveryActionView, RecoveryView } from '../../src/core/recovery-api-contracts';
import type { CalendarVerificationView } from '../../src/core/recovery-verification-contracts';

test.afterEach(async ({ page }) => {
  const listed = await page.request.get('/api/workspaces');
  if (!listed.ok()) return;
  for (const workspace of await listed.json() as Array<{ id: string }>) {
    await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { origin: 'http://127.0.0.1:5174' } });
  }
});

async function openSource(page: Page, clipboardText: string, denied = false) {
  await page.addInitScript(({ text, denied }) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => {
      document.documentElement.dataset.clipboardReads = String(Number(document.documentElement.dataset.clipboardReads ?? 0) + 1);
      if (denied) throw new DOMException('Denied', 'NotAllowedError');
      return text;
    } } });
  }, { text: clipboardText, denied });
  await page.goto('/app');
  await page.getByRole('button', { name: /체험용 여행 예시 시작|여행 예시/ }).click();
  await page.getByRole('button', { name: '원문', exact: true }).click();
}

test('clipboard preview preserves the draft and never saves or calls AI on import', async ({ page }) => {
  await openSource(page, '발표 장소가 3층으로 바뀌었습니다.');
  const source = page.getByRole('textbox', { name: '원문 내용', exact: true });
  await source.fill('아직 보내지 않은 내 초안');
  expect(await page.locator('html').getAttribute('data-clipboard-reads')).toBeNull();
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST') writes.push(request.url()); });
  await page.getByRole('button', { name: '클립보드에서 원문 읽기' }).click();
  await expect(page.getByLabel('클립보드에서 읽은 원문 미리보기')).toHaveValue('발표 장소가 3층으로 바뀌었습니다.');
  await expect(source).toHaveValue('아직 보내지 않은 내 초안');
  await page.getByRole('button', { name: '이 내용 가져오기' }).click();
  await expect(source).toHaveValue('아직 보내지 않은 내 초안');
  await page.getByRole('button', { name: '작성 중인 원문을 바꾸기' }).click();
  await expect(source).toHaveValue('발표 장소가 3층으로 바뀌었습니다.');
  expect(writes).toEqual([]);
});

test('clipboard denial offers manual paste and a changed draft blocks stale replacement', async ({ page }) => {
  await openSource(page, '새 안내', true);
  await page.getByRole('button', { name: '클립보드에서 원문 읽기' }).click();
  await expect(page.getByRole('alert')).toContainText('직접 붙여넣어');
  const source = page.getByRole('textbox', { name: '원문 내용', exact: true });
  await source.fill('보존할 초안');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => '새 안내' }, configurable: true }));
  await page.getByRole('button', { name: '클립보드에서 원문 읽기' }).click();
  await page.getByRole('button', { name: '이 내용 가져오기' }).click();
  await source.fill('방금 수정한 초안');
  await page.getByRole('button', { name: '작성 중인 원문을 바꾸기' }).click();
  await expect(source).toHaveValue('방금 수정한 초안');
  await expect(page.getByRole('alert')).toContainText('작성 중인 원문이 바뀌었습니다');
});

async function verifiedFixture(page: Page) {
  await page.goto('/recovery');
  await page.getByRole('button', { name: '작업 공간으로 저장' }).click();
  await expect(page).toHaveURL(/\/recovery\/ws_/);
  await page.getByRole('button', { name: '조정안 적용하기' }).click();
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeDisabled();
  const workspaceId = new URL(page.url()).pathname.split('/').at(-1)!;
  const action: RecoveryActionView = { id: 'act_browser_fixture', kind: 'calendar', status: 'verified', message: '테스트 provider에서 반영 직후 확인', createdAt: '2026-09-19T00:00:00Z', verifiedEvents: 4, totalEvents: 4, baseRevision: 2, sourceRevision: 1, conditionRevision: 1 };
  const actions = [action];
  await page.route(`**/api/workspaces/${workspaceId}/recovery`, async (route) => {
    const response = await route.fetch();
    const view = await response.json() as RecoveryView;
    await route.fulfill({ response, json: { ...view, actions } });
  });
  await page.route('**/api/calendar/status', (route) => route.fulfill({ json: { configured: true, status: 'connected', provider: 'google', connectionId: 'test_conn', version: 1, calendarId: 'test_cal', calendarSummary: '테스트 Calendar', scopes: [], updatedAt: null } }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Calendar 상태 다시 확인' })).toBeEnabled();
  return { action, actions, workspaceId };
}

function observation(status: CalendarVerificationView['status']): CalendarVerificationView {
  return { actionId: 'act_browser_fixture', status, message: status === 'drifted' ? 'Calendar에서 달라진 일정을 확인해 주세요.' : '마지막 확인에서 일정 4개가 일치했어요.', checkedAt: '2026-09-19T00:15:00Z',
    events: [{ itemId: 'item_fixture', title: '고객 발표', status: status === 'drifted' ? 'missing' : 'matched', differences: [] }],
    watch: { enabled: false, expiresAt: null, nextCheckAt: null, consecutiveFailures: 0, stoppedReason: null } };
}

test('new Calendar drift warns without erasing historical success or offering a blind rewrite', async ({ page }) => {
  const { action } = await verifiedFixture(page);
  const requests: unknown[] = [];
  await page.route('**/recovery/verification', async (route) => {
    requests.push(route.request().postDataJSON());
    action.verification = observation('drifted');
    await route.fulfill({ json: action.verification });
  });
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Calendar 상태 다시 확인' }).click();
  const panel = page.locator('.calendar-verification');
  await expect(panel).toContainText('외부 변경 발견');
  await expect(panel).toContainText('처리 직후 4/4개');
  await panel.getByText(/이벤트별 확인 결과 \d+개 보기/).click();
  await expect(panel).toContainText('삭제됨');
  await expect(panel).not.toContainText('승인한 값과 같습니다.');
  await expect(page.getByRole('button', { name: 'Calendar 반영 작업 등록' })).toBeDisabled();
  expect(requests).toHaveLength(1);
  await panel.screenshot({ path: 'artifacts/change-assurance-2026-09-19/desktop-verification.png' });
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.screenshot({ path: 'artifacts/change-assurance-2026-09-19/mobile-drift.png', fullPage: true });
  await panel.screenshot({ path: 'artifacts/change-assurance-2026-09-19/mobile-verification.png' });
});

test('watch requires deliberate consent and has an explicit stop control', async ({ page }) => {
  const { action } = await verifiedFixture(page);
  const commands: Array<{ enabled: boolean; consent?: boolean }> = [];
  await page.route('**/recovery/watch', async (route) => {
    const command = route.request().postDataJSON() as { enabled: boolean; consent?: boolean };
    commands.push(command);
    action.verification = { ...observation('matched'), watch: { enabled: command.enabled, expiresAt: '2026-09-20T00:15:00Z', nextCheckAt: command.enabled ? '2026-09-19T00:30:00Z' : null, consecutiveFailures: 0, stoppedReason: command.enabled ? null : 'disabled' } };
    await route.fulfill({ json: action.verification });
  });
  const panel = page.locator('.calendar-verification');
  const enable = panel.getByRole('button', { name: '반복 확인 켜기' });
  await expect(enable).toBeDisabled();
  await panel.getByRole('checkbox').check();
  expect(commands).toHaveLength(0);
  await enable.click();
  await expect(panel.getByRole('button', { name: '반복 확인 끄기' })).toBeEnabled();
  expect(commands[0]).toMatchObject({ enabled: true, consent: true });
  await panel.getByRole('button', { name: '반복 확인 끄기' }).click();
  await expect(panel).toContainText('사용자가 반복 확인을 껐습니다');
  expect(commands[1]).toMatchObject({ enabled: false });
});

test('a newer failed action cannot be presented as the older verified action', async ({ page }) => {
  const { action, actions } = await verifiedFixture(page);
  actions.push({ ...action, id: 'act_newer_conflict', status: 'conflict', message: '새 승인 작업은 외부 충돌로 중단됨', createdAt: '2026-09-19T01:00:00Z' });
  await page.reload();
  await expect(page.locator('.recovery-assurance')).toContainText('반영을 마치지 못했어요');
  await expect(page.locator('.calendar-verification')).toHaveCount(0);
  await expect(page.locator('.recovery-action-log')).toContainText('새 승인 작업은 외부 충돌로 중단됨');
});

test('misrouted verification response cannot mark this action matched', async ({ page }) => {
  await verifiedFixture(page);
  await page.route('**/recovery/verification', (route) => route.fulfill({ json: { ...observation('matched'), actionId: 'another_action' } }));
  await page.getByRole('button', { name: 'Calendar 상태 다시 확인' }).click();
  await expect(page.getByRole('button', { name: 'Calendar 상태 다시 확인' })).toBeEnabled();
  await expect(page.locator('.calendar-verification__badge')).toHaveText('다시 확인 전');
});

test('stale approval still allows stopping an existing watch', async ({ page }) => {
  const { action } = await verifiedFixture(page);
  action.baseRevision = 1;
  action.verification = { ...observation('matched'), watch: { enabled: true, expiresAt: '2026-09-20T00:15:00Z', nextCheckAt: '2026-09-19T00:30:00Z', consecutiveFailures: 0, stoppedReason: null } };
  await page.route('**/recovery/watch', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ enabled: false });
    action.verification = { ...observation('stale'), watch: { ...action.verification!.watch, enabled: false, nextCheckAt: null, stoppedReason: 'disabled' } };
    await route.fulfill({ json: action.verification });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Calendar 상태 다시 확인' })).toBeDisabled();
  await page.getByRole('button', { name: '반복 확인 끄기' }).click();
  await expect(page.locator('.calendar-verification')).toContainText('사용자가 반복 확인을 껐습니다');
});

test('a poll started before manual cancellation cannot replace the displayed observation', async ({ page }) => {
  const { action, workspaceId } = await verifiedFixture(page);
  action.verification = { ...observation('matched'), watch: { enabled: true, expiresAt: '2026-09-20T00:15:00Z', nextCheckAt: '2026-09-19T00:30:00Z', consecutiveFailures: 0, stoppedReason: null } };
  await page.clock.install();
  await page.reload();
  await expect(page.getByRole('button', { name: '반복 확인 끄기' })).toBeEnabled();
  let releasePoll!: () => void;
  let releaseStop!: () => void;
  let pollStarted!: () => void;
  let stopStarted!: () => void;
  const pollGate = new Promise<void>((resolve) => { releasePoll = resolve; });
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  const polling = new Promise<void>((resolve) => { pollStarted = resolve; });
  const stopping = new Promise<void>((resolve) => { stopStarted = resolve; });
  await page.route(`**/api/workspaces/${workspaceId}/recovery`, async (route) => {
    const response = await route.fetch();
    const base = await response.json() as RecoveryView;
    const captured = { ...base, actions: [{ ...action, verification: { ...action.verification!, message: '수동 요청 전에 시작한 오래된 조회' } }] };
    pollStarted();
    await pollGate;
    await route.fulfill({ json: captured }).catch(() => undefined);
  });
  await page.route('**/recovery/watch', async (route) => {
    stopStarted();
    await stopGate;
    action.verification = { ...observation('matched'), watch: { ...action.verification!.watch, enabled: false, nextCheckAt: null, stoppedReason: 'user_disabled' } };
    await route.fulfill({ json: action.verification }).catch(() => undefined);
  });
  try {
    await page.clock.runFor(30_001);
    await polling;
    await page.getByRole('button', { name: '반복 확인 끄기' }).click();
    await stopping;
    const received = page.waitForResponse((response) => response.url().endsWith(`/${workspaceId}/recovery`));
    releasePoll();
    await received;
    await page.clock.runFor(100);
    await expect(page.locator('.calendar-verification')).not.toContainText('수동 요청 전에 시작한 오래된 조회');
  } finally {
    releasePoll();
    releaseStop();
  }
  await expect(page.locator('.calendar-verification')).toContainText('사용자가 반복 확인을 껐습니다');
  await expect(page.getByRole('button', { name: '반복 확인 끄기' })).toHaveCount(0);
});
