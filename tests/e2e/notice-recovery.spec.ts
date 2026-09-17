import { expect, test, type Page } from '@playwright/test';
import type { WorkspaceView } from '../../src/core/contracts';
import type { RecoveryView } from '../../src/core/recovery-api-contracts';

test('notice setup keeps native date controls and source navigation readable at 320px', async ({ page }) => {
  const workspace = noticeWorkspace();
  await page.route(`**/api/workspaces/${workspace.id}`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspace) });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/app/workspaces/${workspace.id}/recovery/setup`);
  await expect(page.getByRole('heading', { name: '바뀐 일정에 맞춰, 준비할 시간까지 확인해요.' })).toBeVisible();
  await expect(page.getByRole('link', { name: '← 원래 작업 공간으로' })).toHaveAttribute('href', `/app/workspaces/${workspace.id}`);
  await page.getByText('준비·이동·다른 일정 확인', { exact: true }).click();
  await page.getByText('가용 시간과 확인', { exact: true }).click();
  await page.getByLabel('계획 기준 시간').fill('2026-10-21T08:00');
  await expect(page.getByLabel('계획 기준 시간')).toHaveValue('2026-10-21T08:00');
  expect(await page.locator('input[type="datetime-local"]').evaluateAll((inputs) => inputs.every((input) => {
    const box = input.getBoundingClientRect();
    return box.width === 0 || (box.left >= 0 && box.right <= window.innerWidth);
  }))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/notice-recovery-release-2026-09-15/setup-mobile.png', fullPage: false });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.screenshot({ path: 'artifacts/notice-recovery-release-2026-09-15/setup-desktop.png', fullPage: false });
});

test('notice recovery setup requires confirmed real workspace fields and reuses the request id on retry', async ({ page }) => {
  const workspace = noticeWorkspace();
  const recovery = noticeRecoveryView();
  const posts: Array<{ requestId: string; body: Record<string, unknown> }> = [];
  let failOnce = true;

  await page.route(`**/api/workspaces/${workspace.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspace) });
  });
  await page.route(`**/api/workspaces/${workspace.id}/recovery/from-notice`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push({ requestId: String(body.requestId), body });
    if (failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'REQUEST_FAILED', message: '일시적으로 저장하지 못했습니다.' } }) });
      return;
    }
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(recovery) });
  });

  await page.goto(`/app/workspaces/${workspace.id}/recovery/setup`);
  await expect(page.getByRole('heading', { name: '바뀐 일정에 맞춰, 준비할 시간까지 확인해요.' })).toBeVisible();
  await expect(page.getByText('체험용 예시 원문')).toHaveCount(0);
  await expect(page.getByText('AI로 정리한 내 안내문')).toBeVisible();
  await expect(page.getByText('금요일 발표')).toHaveCount(0);
  await page.getByText('가용 시간과 확인', { exact: true }).click();
  await expect(page.getByRole('button', { name: '일정 조정 작업 공간 만들기' })).toBeDisabled();
  await expect(page.getByText('아직 확인할 값이 있습니다.')).toBeVisible();
  await page.getByText('가용 시간과 확인', { exact: true }).click();

  await page.getByRole('group', { name: '바뀐 일정' }).getByText('고객 운영 점검').click();
  await fillInterval(page, '기존 일정 시간', '2026-10-21T14:00', '2026-10-21T15:00');
  await page.getByRole('button', { name: /점검 변경 시간 2026-10-21T16:00/ }).click();
  await interval(page, '변경된 일정 시간').getByLabel('끝').fill('2026-10-21T17:00');
  await page.getByText('준비·이동·다른 일정 확인').click();
  await page.getByRole('group', { name: '기존 준비 항목' }).getByText('점검 자료 정리').click();
  await fillInterval(page, '준비 기존 시간', '2026-10-21T12:30', '2026-10-21T13:30');
  await page.getByLabel('준비 시간(분)').fill('60');
  await page.getByLabel('준비 마감').fill('2026-10-21T13:00');
  await page.getByLabel('일정 직전 이동(분)').fill('30');
  await fillInterval(page, '내부 승인 회의 시간', '2026-10-21T10:00', '2026-10-21T11:00');
  await page.getByText('가용 시간과 확인').click();
  await page.getByLabel('계획 기준 시간').fill('2026-10-21T08:00');
  await page.getByRole('button', { name: '가용 시간 추가' }).click();
  const availability = page.locator('.notice-dynamic-row').last();
  await availability.getByLabel('이름').fill('오후 작업 가능');
  await availability.getByLabel('시작').fill('2026-10-21T13:00');
  await availability.getByLabel('끝').fill('2026-10-21T18:00');
  await page.getByLabel('조정 범위 끝').fill('2026-10-21T23:00');
  await page.getByLabel('위 시간, 준비 조건, 다른 일정, 가용 시간을 내가 확인했습니다.').check();
  await expect(page.getByRole('button', { name: '일정 조정 작업 공간 만들기' })).toBeEnabled();

  await page.getByLabel('일정 직전 이동(분)').fill('35');
  await expect(page.getByLabel('위 시간, 준비 조건, 다른 일정, 가용 시간을 내가 확인했습니다.')).not.toBeChecked();
  await page.getByLabel('일정 직전 이동(분)').fill('30');
  await page.getByLabel('위 시간, 준비 조건, 다른 일정, 가용 시간을 내가 확인했습니다.').check();

  await page.getByRole('button', { name: '일정 조정 작업 공간 만들기' }).click();
  await expect(page.getByRole('alert')).toContainText('일시적으로 저장하지 못했습니다.');
  await page.getByRole('button', { name: '일정 조정 작업 공간 만들기' }).click();
  await expect(page).toHaveURL(new RegExp(`/recovery/${recovery.workspaceId}$`));
  expect(posts).toHaveLength(2);
  expect(posts[0]!.requestId).toBe(posts[1]!.requestId);
  expect(posts[1]!.body).toMatchObject({
    baseRevision: 7,
    baseSourceRevision: 3,
    sourceId: 'source:ops-notice',
    targetItemId: 'item:ops-check',
    travelMinutes: 30,
    confirmed: true,
  });
  expect(posts[1]!.body).toHaveProperty('commitments');
});

test('notice recovery setup clears private content after an identity change and ignores a delayed read', async ({ page }) => {
  const workspace = noticeWorkspace();
  let release!: () => void;
  let requestStarted!: () => void;
  const requestObserved = new Promise<void>((resolve) => { requestStarted = resolve; });
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/workspaces/${workspace.id}`, async (route) => {
    requestStarted();
    await delayed;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspace) }).catch(() => undefined);
  });

  await page.goto(`/app/workspaces/${workspace.id}/recovery/setup`);
  await requestObserved;
  await expect(page.getByRole('heading', { name: '원문과 현재 계획을 불러오는 중입니다.' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ieojim-identity-change', { detail: { type: 'identity-change', reason: 'logout', sourceId: 'test' } })));
  release();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText('고객 운영 점검')).toHaveCount(0);
});

test('notice recovery setup reports stale server creation without falling back to demo data', async ({ page }) => {
  const workspace = noticeWorkspace();
  await page.route(`**/api/workspaces/${workspace.id}`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspace) });
  });
  await page.route(`**/api/workspaces/${workspace.id}/recovery/from-notice`, async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STALE_REVISION', message: '원문 또는 계획이 먼저 바뀌었습니다.' } }) });
  });

  await fillValidNoticeSetup(page, workspace.id);
  await page.getByRole('button', { name: '일정 조정 작업 공간 만들기' }).click();
  await expect(page.getByRole('alert')).toContainText('원문 또는 계획이 먼저 바뀌었습니다.');
  await expect(page).toHaveURL(new RegExp(`/app/workspaces/${workspace.id}/recovery/setup$`));
  await expect(page.getByText('금요일 발표')).toHaveCount(0);
});

async function fillValidNoticeSetup(page: Page, workspaceId: string) {
  await page.goto(`/app/workspaces/${workspaceId}/recovery/setup`);
  await page.getByRole('group', { name: '바뀐 일정' }).getByText('고객 운영 점검').click();
  await fillInterval(page, '기존 일정 시간', '2026-10-21T14:00', '2026-10-21T15:00');
  await page.getByRole('button', { name: /점검 변경 시간 2026-10-21T16:00/ }).click();
  await interval(page, '변경된 일정 시간').getByLabel('끝').fill('2026-10-21T17:00');
  await page.getByText('준비·이동·다른 일정 확인').click();
  await page.getByRole('group', { name: '기존 준비 항목' }).getByText('점검 자료 정리').click();
  await fillInterval(page, '준비 기존 시간', '2026-10-21T12:30', '2026-10-21T13:30');
  await page.getByLabel('준비 시간(분)').fill('60');
  await page.getByLabel('준비 마감').fill('2026-10-21T13:00');
  await page.getByLabel('일정 직전 이동(분)').fill('30');
  await fillInterval(page, '내부 승인 회의 시간', '2026-10-21T10:00', '2026-10-21T11:00');
  await page.getByText('가용 시간과 확인').click();
  await page.getByLabel('계획 기준 시간').fill('2026-10-21T08:00');
  await page.getByRole('button', { name: '가용 시간 추가' }).click();
  const availability = page.locator('.notice-dynamic-row').last();
  await availability.getByLabel('이름').fill('오후 작업 가능');
  await availability.getByLabel('시작').fill('2026-10-21T13:00');
  await availability.getByLabel('끝').fill('2026-10-21T18:00');
  await page.getByLabel('조정 범위 끝').fill('2026-10-21T23:00');
  await page.getByLabel('위 시간, 준비 조건, 다른 일정, 가용 시간을 내가 확인했습니다.').check();
}

async function fillInterval(page: Page, label: string, start: string, end: string) {
  const group = interval(page, label);
  await group.getByLabel('시작').fill(start);
  await group.getByLabel('끝').fill(end);
}

function interval(page: Page, label: string) {
  return page.locator('.notice-interval').filter({ hasText: label }).first();
}

function noticeWorkspace(): WorkspaceView {
  const sourceText = '변경된 운영 점검은 2026년 10월 21일 16:00입니다. 점검 자료는 2026년 10월 21일 13:00까지 준비해 주세요.';
  const quote = '변경된 운영 점검은 2026년 10월 21일 16:00입니다';
  return {
    id: 'ws_notice_real',
    title: '운영 점검 계획',
    purpose: '고객 안내 변경에 맞춰 저장된 계획을 복구한다.',
    sampleScenario: null,
    revision: 7,
    sourceRevision: 3,
    sources: [{
      id: 'source:ops-notice',
      title: '고객 운영 안내',
      text: sourceText,
      relation: 'initial',
      targetSourceId: null,
      hash: 'hash_ops_notice',
      createdAt: '2026-09-15T00:00:00.000Z',
    }],
    snapshot: {
      facts: [{
        id: 'fact:ops-time',
        key: 'ops_time',
        label: '점검 변경 시간',
        value: '2026-10-21T16:00',
        evidence: { sourceId: 'source:ops-notice', quote, start: sourceText.indexOf(quote), end: sourceText.indexOf(quote) + quote.length },
        semantic: { kind: 'date_time', date: '2026-10-21', time: '16:00' },
      }],
      blocks: [
        {
          id: 'block:schedule',
          key: 'schedule',
          type: 'schedule',
          title: '확정 일정',
          items: [
            item('item:ops-check', 'ops_check', '고객 운영 점검', '기존 14:00, 변경 16:00', ['ops_time'], 'ops_time'),
            item('item:internal-approval', 'internal_approval', '내부 승인 회의', '오전 10:00 고정 회의', [], null),
          ],
        },
        {
          id: 'block:checklist',
          key: 'checklist',
          type: 'checklist',
          title: '준비 업무',
          items: [
            { ...item('item:ops-prep', 'ops_prep', '점검 자료 정리', '고객 공유 자료 업데이트', [], null), preparation: { version: 1, dueDate: '2026-10-21', durationMinutes: 60 } },
          ],
        },
      ],
    },
    pending: null,
    runs: [{ id: 'run_live_notice', sourceId: 'source:ops-notice', status: 'applied', error: null, createdAt: '2026-09-15T00:00:00.000Z', costMicroUsd: 10, mode: 'live' }],
    history: [{ revision: 7, createdAt: '2026-09-15T00:00:00.000Z', reason: 'manual_edit' }],
    expiresAt: '2026-09-22T00:00:00.000Z',
  };
}

function item(id: string, key: string, label: string, value: string, factKeys: string[], valueFactKey: string | null) {
  return { id, key, label, value, factKeys, valueFactKey, calculation: null, completed: false, locked: false, edited: false, stale: false };
}

function noticeRecoveryView(): RecoveryView {
  return {
    workspaceId: 'ws_recovery_notice',
    revision: 1,
    sourceRevision: 1,
    conditionRevision: 1,
    proposalId: 'proposal_notice',
    applied: false,
    actions: [],
    input: {
      version: 1,
      requestId: '00000000-0000-4000-8000-000000000001',
      workspaceId: 'ws_recovery_notice',
      baseRevision: 1,
      sourceRevision: 1,
      timezone: 'Asia/Seoul',
      sources: [{ id: 'source:ops-notice', text: '운영 점검은 2026년 9월 16일 14:00에서 16:00으로 변경됩니다.' }],
      now: '2026-09-15T09:00',
      horizon: { start: '2026-09-15T09:00', end: '2026-10-21T09:00' },
      workWindows: [{ label: '오후 작업 가능', start: '2026-10-21T13:00', end: '2026-10-21T18:00' }],
      events: [],
      relations: [],
      change: {
        presentationEventId: 'event:ops',
        presentationInterval: { start: '2026-10-21T16:00', end: '2026-10-21T17:00' },
        travelEventId: 'event:travel',
        travelDurationMinutes: 30,
        preparationEventId: 'event:prep',
        preparationDurationMinutes: 60,
        preparationDeadline: '2026-10-21T13:00',
        confirmedByRelationIds: ['time', 'travel', 'deadline'],
      },
    },
    result: { status: 'missing_information', code: 'test', message: 'test view', blockers: [] },
  };
}
