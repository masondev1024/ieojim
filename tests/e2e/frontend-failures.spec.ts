import { expect, test, type Page, type Route } from '@playwright/test';
import type { WorkspaceView } from '../../src/core/contracts';

test('failed manual edit keeps the draft open and retries the same intent with the same request id', async ({ page }) => {
  const initial = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Original memo' });
  const saved = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 2, value: 'Draft after failure' });
  const patchBodies: Array<{ baseRevision: number; requestId: string; value: string }> = [];
  let patchAttempts = 0;

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(initial)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') return fulfillJson(route, initial);
    if (request.method() === 'PATCH' && url.pathname === '/api/workspaces/workspace-a/items') {
      patchAttempts += 1;
      patchBodies.push(request.postDataJSON());
      if (patchAttempts === 1) {
        return fulfillJson(route, { error: { code: 'REQUEST_FAILED', message: 'synthetic edit failure' } }, 500);
      }
      return fulfillJson(route, saved);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await expect(page.getByRole('heading', { name: 'Workspace A' })).toBeVisible();

  await page.getByRole('button', { name: '항목 편집' }).click();
  await page.getByLabel('항목 값').fill('Draft after failure');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText('synthetic edit failure');
  await expect(page.getByLabel('항목 값')).toHaveValue('Draft after failure');

  await page.getByRole('button', { name: '저장', exact: true }).click();

  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Draft after failure')).toBeVisible();
  await expect(page.getByLabel('항목 값')).toHaveCount(0);
  expect(patchBodies).toHaveLength(2);
  expect(patchBodies[1]).toMatchObject({ baseRevision: 1, value: 'Draft after failure' });
  expect(patchBodies[1].requestId).toBe(patchBodies[0].requestId);
});

test('stale revision conflict keeps the draft focused for correction', async ({ page }) => {
  const initial = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Original memo' });

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(initial)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') return fulfillJson(route, initial);
    if (request.method() === 'PATCH' && url.pathname === '/api/workspaces/workspace-a/items') {
      return fulfillJson(route, { error: { code: 'STALE_REVISION', message: 'synthetic stale revision' } }, 409);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '항목 편집' }).click();
  const valueField = page.getByLabel('항목 값');
  await valueField.fill('Draft after conflict');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText('synthetic stale revision');
  await expect(valueField).toHaveValue('Draft after conflict');
  await expect(valueField).toBeFocused();
});

test('changing a failed draft creates a new manual edit request id', async ({ page }) => {
  const initial = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Original memo' });
  const patchBodies: Array<{ requestId: string; value: string }> = [];

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(initial)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') return fulfillJson(route, initial);
    if (request.method() === 'PATCH' && url.pathname === '/api/workspaces/workspace-a/items') {
      patchBodies.push(request.postDataJSON());
      return fulfillJson(route, { error: { code: 'REQUEST_FAILED', message: 'synthetic edit failure' } }, 500);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '항목 편집' }).click();
  await page.getByLabel('항목 값').fill('First failed draft');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('synthetic edit failure');

  await page.getByLabel('항목 값').fill('Second failed draft');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  expect(patchBodies).toHaveLength(2);
  expect(patchBodies[0].value).toBe('First failed draft');
  expect(patchBodies[1].value).toBe('Second failed draft');
  expect(patchBodies[1].requestId).not.toBe(patchBodies[0].requestId);
});

test('stale first load cannot win an A to B to A workspace selection race', async ({ page }) => {
  const oldWorkspaceA = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Old Workspace A memo' });
  const workspaceB = workspaceView({ id: 'workspace-b', title: 'Workspace B', revision: 1, value: 'Workspace B memo' });
  const currentWorkspaceA = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 2, value: 'Current Workspace A memo' });
  const firstALoad = { release: null as (() => void) | null };
  let workspaceAReads = 0;

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(oldWorkspaceA), workspaceSummary(workspaceB)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-b') return fulfillJson(route, workspaceB);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') {
      workspaceAReads += 1;
      if (workspaceAReads === 1) {
        await new Promise<void>((resolve) => { firstALoad.release = resolve; });
        return fulfillJson(route, oldWorkspaceA);
      }
      return fulfillJson(route, currentWorkspaceA);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await expect.poll(() => workspaceAReads).toBe(1);
  await page.getByRole('button', { name: /Workspace B/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace B' })).toBeVisible();
  await page.getByRole('button', { name: /Workspace A/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace A' })).toBeVisible();
  await expect(page.getByText('Current Workspace A memo')).toBeVisible();

  const releaseFirstLoad = firstALoad.release;
  if (!releaseFirstLoad) throw new Error('first workspace A load was not captured');
  releaseFirstLoad();
  await page.waitForTimeout(100);

  await expect(page.getByText('Current Workspace A memo')).toBeVisible();
  await expect(page.getByText('Old Workspace A memo')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ieojim:selected-workspace'))).toBe('workspace-a');
});

test('manual drafts are scoped by workspace even when item ids match', async ({ page }) => {
  const workspaceA = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Workspace A memo', itemId: 'shared-item-id' });
  const workspaceB = workspaceView({ id: 'workspace-b', title: 'Workspace B', revision: 1, value: 'Workspace B memo', itemId: 'shared-item-id' });

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(workspaceA), workspaceSummary(workspaceB)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') return fulfillJson(route, workspaceA);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-b') return fulfillJson(route, workspaceB);
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '항목 편집' }).click();
  await page.getByLabel('항목 값').fill('Unsaved Workspace A draft');

  await page.getByRole('button', { name: /Workspace B/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace B' })).toBeVisible();
  await expect(page.getByText('Workspace B memo')).toBeVisible();
  await expect(page.getByLabel('항목 값')).toHaveCount(0);

  await page.getByRole('button', { name: /Workspace A/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace A' })).toBeVisible();
  await expect(page.getByLabel('항목 값')).toHaveValue('Unsaved Workspace A draft');
});

test('stale poll from a previous workspace cannot overwrite the selected workspace or storage', async ({ page }) => {
  const workspaceA = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Workspace A memo', runStatus: 'pending' });
  const staleWorkspaceA = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Stale Workspace A memo', runStatus: 'pending' });
  const workspaceB = workspaceView({ id: 'workspace-b', title: 'Workspace B', revision: 3, value: 'Workspace B memo' });
  let workspaceAReads = 0;
  const stalePoll = { release: null as (() => void) | null };

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(workspaceA), workspaceSummary(workspaceB)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-b') return fulfillJson(route, workspaceB);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') {
      workspaceAReads += 1;
      if (workspaceAReads === 1) return fulfillJson(route, workspaceA);
      await new Promise<void>((resolve) => { stalePoll.release = resolve; });
      return fulfillJson(route, staleWorkspaceA);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await expect(page.getByRole('heading', { name: 'Workspace A' })).toBeVisible();

  await expect.poll(() => page.evaluate(() => localStorage.getItem('ieojim:selected-workspace'))).toBe('workspace-a');
  await expect.poll(() => workspaceAReads, { timeout: 4_000 }).toBe(2);
  await page.getByRole('button', { name: /Workspace B/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace B' })).toBeVisible();

  const releasePoll = stalePoll.release;
  if (!releasePoll) throw new Error('stale poll request was not captured');
  releasePoll();
  await page.waitForTimeout(100);

  await expect(page.getByRole('heading', { name: 'Workspace B' })).toBeVisible();
  await expect(page.getByText('Workspace B memo')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ieojim:selected-workspace'))).toBe('workspace-b');
});

test('same-base delayed pending poll cannot overwrite a newer ready proposal', async ({ page }) => {
  const initial = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, sourceRevision: 2, value: 'Workspace A memo', runStatus: 'pending' });
  const delayedPending = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, sourceRevision: 2, value: 'Workspace A memo', runStatus: 'pending' });
  const ready = workspaceView({
    id: 'workspace-a',
    title: 'Workspace A',
    revision: 1,
    sourceRevision: 2,
    value: 'Workspace A memo',
    runStatus: 'ready',
    pendingAfter: 'Ready proposal memo',
  });
  let workspaceAReads = 0;
  const delayedPoll = { release: null as (() => void) | null };

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(initial)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') {
      workspaceAReads += 1;
      if (workspaceAReads === 1) return fulfillJson(route, initial);
      if (workspaceAReads === 2) {
        await new Promise<void>((resolve) => { delayedPoll.release = resolve; });
        return fulfillJson(route, delayedPending);
      }
      return fulfillJson(route, ready);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await expect(page.getByText('체험용 · 대기 중')).toBeVisible();
  await expect.poll(() => workspaceAReads, { timeout: 7_000 }).toBeGreaterThanOrEqual(3);
  await expect(page.getByText('체험용 · 검토 가능')).toBeVisible();
  await page.getByRole('button', { name: '변경 검토', exact: true }).click();
  await expect(page.locator('.change-list').getByText('Ready proposal memo')).toBeVisible();

  const releaseDelayedPoll = delayedPoll.release;
  if (!releaseDelayedPoll) throw new Error('delayed pending poll was not captured');
  releaseDelayedPoll();
  await page.waitForTimeout(100);

  await expect(page.getByText('체험용 · 검토 가능')).toBeVisible();
  await expect(page.locator('.change-list').getByText('Ready proposal memo')).toBeVisible();
  await expect(page.getByText('체험용 · 대기 중')).toHaveCount(0);
});

test('older poll sequence cannot reject a delayed manual edit with a newer content revision', async ({ page }) => {
  const initial = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Workspace A memo', runStatus: 'pending' });
  const saved = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 2, value: 'Saved manual value', runStatus: 'pending' });
  let readsDuringPatch = 0;
  const delayedPatch = { release: null as (() => void) | null };

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(initial)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') {
      if (delayedPatch.release) {
        readsDuringPatch += 1;
        return fulfillJson(route, { ...initial, runs: initial.runs.map((run) => ({ ...run, status: 'running' })) });
      }
      return fulfillJson(route, initial);
    }
    if (request.method() === 'PATCH' && url.pathname === '/api/workspaces/workspace-a/items') {
      await new Promise<void>((resolve) => { delayedPatch.release = resolve; });
      return fulfillJson(route, saved);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '항목 편집' }).click();
  await page.getByLabel('항목 값').fill('Saved manual value');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => readsDuringPatch, { timeout: 7_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.getByText('체험용 · 처리 중')).toBeVisible();

  const releasePatch = delayedPatch.release;
  if (!releasePatch) throw new Error('manual edit patch was not captured');
  releasePatch();

  await expect(page.getByText('Saved manual value')).toBeVisible();
  await expect(page.getByText('저장된 계획 2')).toBeVisible();
  await expect(page.getByLabel('항목 값')).toHaveCount(0);
});

test('delayed delete completion cannot clear a workspace selected after the delete started', async ({ page }) => {
  const workspaceA = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Workspace A memo' });
  const workspaceB = workspaceView({ id: 'workspace-b', title: 'Workspace B', revision: 1, value: 'Workspace B memo' });
  const delayedDelete = { release: null as (() => void) | null };

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(workspaceA), workspaceSummary(workspaceB)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') return fulfillJson(route, workspaceA);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-b') return fulfillJson(route, workspaceB);
    if (request.method() === 'DELETE' && url.pathname === '/api/workspaces/workspace-a') {
      await new Promise<void>((resolve) => { delayedDelete.release = resolve; });
      return route.fulfill({ status: 204, body: '' });
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '변경 이력', exact: true }).click();
  await page.getByRole('button', { name: '작업 공간 삭제' }).click();
  await page.getByRole('button', { name: '영구 삭제' }).click();
  await page.getByRole('button', { name: /Workspace B/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace B' })).toBeVisible();

  const releaseDelete = delayedDelete.release;
  if (!releaseDelete) throw new Error('delete request was not captured');
  releaseDelete();
  await page.waitForTimeout(100);

  await expect(page.getByRole('heading', { name: 'Workspace B' })).toBeVisible();
  await expect(page.getByText('Workspace B memo')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ieojim:selected-workspace'))).toBe('workspace-b');
});

test('source post-refresh side effects cannot clear text typed after switching workspaces', async ({ page }) => {
  const workspaceA = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Workspace A memo' });
  const workspaceAWithSource = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, sourceRevision: 2, value: 'Workspace A memo', runStatus: 'pending' });
  const workspaceB = workspaceView({ id: 'workspace-b', title: 'Workspace B', revision: 1, value: 'Workspace B memo' });
  const delayedListRefresh = { release: null as (() => void) | null };
  let sourceSubmitted = false;

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') {
      if (sourceSubmitted && !delayedListRefresh.release) {
        await new Promise<void>((resolve) => { delayedListRefresh.release = resolve; });
      }
      return fulfillJson(route, [workspaceSummary(workspaceAWithSource), workspaceSummary(workspaceB)]);
    }
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') return fulfillJson(route, workspaceA);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-b') return fulfillJson(route, workspaceB);
    if (request.method() === 'POST' && url.pathname === '/api/workspaces/workspace-a/sources') {
      sourceSubmitted = true;
      return fulfillJson(route, workspaceAWithSource);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '원문', exact: true }).click();
  await page.getByLabel('원문 내용').fill('Workspace A source text');
  await page.getByRole('button', { name: '원문 저장하고 AI 검토' }).click();
  await page.getByRole('button', { name: /Workspace B/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace B' })).toBeVisible();
  await page.getByRole('button', { name: '원문', exact: true }).click();
  await page.getByLabel('원문 내용').fill('Workspace B draft typed after switch');

  const releaseListRefresh = delayedListRefresh.release;
  if (!releaseListRefresh) throw new Error('post-source workspace list refresh was not captured');
  releaseListRefresh();
  await page.waitForTimeout(100);

  await expect(page.getByRole('heading', { name: 'Workspace B' })).toBeVisible();
  await expect(page.getByLabel('원문 내용')).toHaveValue('Workspace B draft typed after switch');
});

test('question answer mode submits proposal lineage without sending server-owned questions', async ({ page }) => {
  const questions = ['참석자는 몇 명인가요?'];
  const initial = workspaceView({
    id: 'workspace-a',
    title: 'Workspace A',
    revision: 1,
    sourceRevision: 2,
    value: 'Workspace A memo',
    runStatus: 'needs_input',
    pendingAfter: 'Workspace A memo',
    questions,
  });
  const answered = workspaceView({
    id: 'workspace-a',
    title: 'Workspace A',
    revision: 1,
    sourceRevision: 3,
    value: 'Workspace A memo',
    runStatus: 'pending',
  });
  answered.sources.push({
    id: 'source-answer',
    text: '참석자는 4명입니다.',
    title: '확인 질문에 대한 답변',
    relation: 'addition',
    targetSourceId: null,
    hash: 'answer-hash',
    createdAt: '2026-09-09T00:01:00.000Z',
    answerTo: {
      changeSetId: initial.pending!.id,
      proposalRevision: initial.pending!.proposalRevision,
      baseRevision: initial.pending!.baseRevision,
      baseSourceRevision: initial.pending!.baseSourceRevision,
      questions,
    },
  });
  const sourceBodies: Array<Record<string, unknown>> = [];

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(initial)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') return fulfillJson(route, initial);
    if (request.method() === 'POST' && url.pathname === '/api/workspaces/workspace-a/sources') {
      sourceBodies.push(request.postDataJSON());
      return fulfillJson(route, answered);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '변경 검토', exact: true }).click();
  await expect(page.getByText('참석자는 몇 명인가요?')).toBeVisible();
  await page.getByRole('button', { name: '추가 정보로 답변' }).click();

  await expect(page.getByLabel('답변 중인 확인 질문')).toContainText('참석자는 몇 명인가요?');
  await expect(page.getByLabel('관계')).toHaveValue('addition');
  await expect(page.getByLabel('관계')).toBeDisabled();
  await expect(page.getByLabel('바꿀 원문')).toHaveValue('');
  await expect(page.getByLabel('바꿀 원문')).toBeDisabled();
  await expect(page.getByLabel('원문 내용')).toBeFocused();

  await page.getByLabel('원문 내용').fill('참석자는 4명입니다.');
  await page.getByRole('button', { name: '원문 저장하고 AI 검토' }).click();

  expect(sourceBodies).toHaveLength(1);
  expect(sourceBodies[0]).toMatchObject({
    title: '확인 질문에 대한 답변',
    text: '참석자는 4명입니다.',
    relation: 'addition',
    targetSourceId: null,
    answerTo: {
      changeSetId: initial.pending!.id,
      proposalRevision: initial.pending!.proposalRevision,
      baseRevision: initial.pending!.baseRevision,
      baseSourceRevision: initial.pending!.baseSourceRevision,
    },
  });
  expect((sourceBodies[0].answerTo as Record<string, unknown>).questions).toBeUndefined();
  await expect(page.getByLabel('답변 중인 확인 질문')).toHaveCount(0);
  await page.getByRole('button', { name: '변경 검토', exact: true }).click();
  await expect(page.getByText('새 원문을 넣으면 AI가 찾은 변경 후보와 원문 근거가 여기에 표시됩니다.')).toBeVisible();
});

test('stale question answer mode clears without losing typed source text', async ({ page }) => {
  const questions = ['참석자는 몇 명인가요?'];
  const initial = workspaceView({
    id: 'workspace-a',
    title: 'Workspace A',
    revision: 1,
    sourceRevision: 2,
    value: 'Workspace A memo',
    runStatus: 'pending',
    pendingAfter: 'Workspace A memo',
    questions,
  });
  const noLongerPending = workspaceView({
    id: 'workspace-a',
    title: 'Workspace A',
    revision: 1,
    sourceRevision: 3,
    value: 'Workspace A memo',
    runStatus: 'ready',
  });
  const submitted = workspaceView({
    id: 'workspace-a',
    title: 'Workspace A',
    revision: 1,
    sourceRevision: 4,
    value: 'Workspace A memo',
    runStatus: 'pending',
  });
  let workspaceReads = 0;
  const sourceBodies: Array<Record<string, unknown>> = [];

  await mockApi(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/config') return fulfillJson(route, configPayload);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(initial)]);
    if (request.method() === 'GET' && url.pathname === '/api/workspaces/workspace-a') {
      workspaceReads += 1;
      return fulfillJson(route, workspaceReads === 1 ? initial : noLongerPending);
    }
    if (request.method() === 'POST' && url.pathname === '/api/workspaces/workspace-a/sources') {
      sourceBodies.push(request.postDataJSON());
      return fulfillJson(route, submitted);
    }
    throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
  });

  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '변경 검토', exact: true }).click();
  await page.getByRole('button', { name: '추가 정보로 답변' }).click();
  await page.getByLabel('원문 내용').fill('참석자는 4명입니다.');

  await expect.poll(() => workspaceReads, { timeout: 7_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByLabel('답변 중인 확인 질문')).toHaveCount(0);
  await expect(page.getByLabel('원문 내용')).toHaveValue('참석자는 4명입니다.');

  await page.getByRole('button', { name: '원문 저장하고 AI 검토' }).click();
  expect(sourceBodies).toHaveLength(1);
  expect(sourceBodies[0].answerTo).toBeUndefined();
});

test('returning home while a post-create list refresh is pending releases the old busy state', async ({ page }) => {
  const created = workspaceView({ id: 'workspace-a', title: 'Created workspace', revision: 0, value: '' });
  const delayed = { release: null as (() => void) | null };
  let accepted = false;
  await mockApi(page, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/config') return fulfillJson(route, configPayload);
    if (pathname === '/api/workspaces' && route.request().method() === 'POST') {
      accepted = true;
      return fulfillJson(route, created, 201);
    }
    if (pathname === '/api/workspaces') {
      if (accepted) await new Promise<void>((resolve) => { delayed.release = resolve; });
      return fulfillJson(route, accepted ? [workspaceSummary(created)] : []);
    }
    if (pathname === '/api/workspaces/workspace-a') return fulfillJson(route, created);
    throw new Error(`Unexpected request: ${pathname}`);
  });
  await page.goto('/app');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/workspaces\/workspace-a$/);
  await expect.poll(() => Boolean(delayed.release)).toBe(true);
  await page.goBack();
  await expect(page.getByTestId('workspace-home')).toBeVisible();
  await expect(page.getByRole('button', { name: '만들기', exact: true })).toBeEnabled();
  delayed.release!();
  await expect(page.getByRole('button', { name: /Created workspace/ })).toBeVisible();
  await expect(page).toHaveURL(/\/app$/);
});

test('a delayed list refresh after restore cannot change the panel the user selected', async ({ page }) => {
  const initial = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 2, value: 'Current memo' });
  initial.history = [{ revision: 1, createdAt: '2026-09-09T00:00:00.000Z', reason: 'created' }];
  const restored = { ...initial, revision: 3, snapshot: { ...initial.snapshot, blocks: workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 3, value: 'Restored memo' }).snapshot.blocks } };
  const delayed = { release: null as (() => void) | null };
  let restoreAccepted = false;
  await mockApi(page, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/config') return fulfillJson(route, configPayload);
    if (pathname === '/api/workspaces') {
      if (restoreAccepted) await new Promise<void>((resolve) => { delayed.release = resolve; });
      return fulfillJson(route, [workspaceSummary(restoreAccepted ? restored : initial)]);
    }
    if (pathname === '/api/workspaces/workspace-a/restore') {
      restoreAccepted = true;
      return fulfillJson(route, restored);
    }
    if (pathname === '/api/workspaces/workspace-a') return fulfillJson(route, initial);
    throw new Error(`Unexpected request: ${pathname}`);
  });
  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '변경 이력', exact: true }).click();
  await page.getByRole('button', { name: '1번 저장된 계획 복원' }).click();
  await expect(page.getByText('Restored memo')).toBeVisible();
  await expect.poll(() => Boolean(delayed.release)).toBe(true);
  await page.getByRole('button', { name: '변경 이력', exact: true }).click();
  delayed.release!();
  await expect(page.getByRole('button', { name: '작업 공간 삭제' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '변경 이력', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('workspace-history')).toBeVisible();
});

test('source drafts stay with their workspace across selection and home navigation', async ({ page }) => {
  const workspaceA = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'A memo' });
  const workspaceB = workspaceView({ id: 'workspace-b', title: 'Workspace B', revision: 1, value: 'B memo' });
  await mockApi(page, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/config') return fulfillJson(route, configPayload);
    if (pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(workspaceA), workspaceSummary(workspaceB)]);
    if (pathname === '/api/workspaces/workspace-a') return fulfillJson(route, workspaceA);
    if (pathname === '/api/workspaces/workspace-b') return fulfillJson(route, workspaceB);
    throw new Error(`Unexpected request: ${pathname}`);
  });
  await page.goto('/app/workspaces/workspace-a');
  await page.getByRole('button', { name: '원문', exact: true }).click();
  await page.getByLabel('원문 내용').fill('A에서 작성 중인 정정 안내');
  await page.getByLabel('관계').selectOption('replacement');
  await page.getByLabel('바꿀 원문').selectOption({ index: 1 });
  const sourceTarget = await page.getByLabel('바꿀 원문').inputValue();
  const reloadedSource = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspaces/workspace-a');
  await page.getByRole('button', { name: /Workspace A/ }).click();
  await reloadedSource;
  await expect(page.getByLabel('원문 내용')).toBeEnabled();
  await expect(page.getByLabel('원문 내용')).toHaveValue('A에서 작성 중인 정정 안내');
  await expect(page.getByLabel('관계')).toHaveValue('replacement');
  await expect(page.getByLabel('바꿀 원문')).toHaveValue(sourceTarget);
  await page.getByRole('button', { name: /Workspace B/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace B' })).toBeVisible();
  await page.getByRole('button', { name: '원문', exact: true }).click();
  await expect(page.getByLabel('원문 내용')).toHaveValue('');
  await page.getByLabel('원문 내용').fill('B의 별도 자료');
  await page.getByRole('button', { name: '최근 작업 보기' }).click();
  await expect(page.getByTestId('workspace-home')).toBeVisible();
  await page.getByRole('button', { name: /Workspace A/ }).click();
  await page.getByRole('button', { name: '원문', exact: true }).click();
  await expect(page.getByLabel('원문 내용')).toHaveValue('A에서 작성 중인 정정 안내');
  await expect(page.getByLabel('관계')).toHaveValue('replacement');
  await expect(page.getByLabel('바꿀 원문')).toHaveValue(sourceTarget);
  await page.getByRole('button', { name: /Workspace B/ }).click();
  await expect(page.getByLabel('원문 내용')).toHaveValue('B의 별도 자료');
});

test('failed deep link never leaves the previous workspace under the new address', async ({ page }) => {
  const workspaceA = workspaceView({ id: 'workspace-a', title: 'Workspace A', revision: 1, value: 'Private A memo' });
  const deleted = workspaceView({ id: 'deleted-workspace', title: 'Deleted workspace', revision: 1, value: 'Deleted memo' });
  await mockApi(page, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/config') return fulfillJson(route, configPayload);
    if (pathname === '/api/workspaces') return fulfillJson(route, [workspaceSummary(workspaceA), workspaceSummary(deleted)]);
    if (pathname === '/api/workspaces/workspace-a') return fulfillJson(route, workspaceA);
    if (pathname === '/api/workspaces/deleted-workspace') {
      return fulfillJson(route, { error: { code: 'NOT_FOUND', message: '작업 공간을 찾을 수 없습니다.' } }, 404);
    }
    throw new Error(`Unexpected request: ${pathname}`);
  });
  await page.goto('/app/workspaces/workspace-a');
  await expect(page.getByText('Private A memo')).toBeVisible();
  await page.getByRole('button', { name: /Deleted workspace/ }).click();
  await expect(page).toHaveURL(/\/app\/workspaces\/deleted-workspace$/);
  await expect(page.getByRole('alert')).toContainText('작업 공간을 찾을 수 없습니다.');
  await expect(page.getByRole('heading', { name: 'Workspace A', exact: true })).toHaveCount(0);
  await expect(page.getByText('Private A memo')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ieojim:selected-workspace'))).toBe('workspace-a');
  await page.goBack();
  await expect(page.getByText('Private A memo')).toBeVisible();
});

async function mockApi(page: Page, handler: (route: Route) => Promise<void>) {
  await page.route('**/api/**', async (route) => {
    if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/account') {
      return fulfillJson(route, { authAvailable: false, provider: 'google', user: null, sessionExpiresAt: null, guestPreview: null, retentionDays: 7 });
    }
    return handler(route);
  });
}

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

const configPayload = { liveAvailable: false, maxSourceChars: 6000, retentionDays: 7 };

function workspaceSummary(view: WorkspaceView) {
  return { id: view.id, title: view.title, updatedAt: view.expiresAt, revision: view.revision };
}

function workspaceView(input: { id: string; title: string; revision: number; value: string; sourceRevision?: number; runStatus?: 'pending' | 'ready' | 'needs_input' | 'applied'; pendingAfter?: string; questions?: string[]; itemId?: string }): WorkspaceView {
  const sourceRevision = input.sourceRevision ?? 1;
  const sourceId = `source-${input.id}`;
  const itemId = input.itemId ?? `item-${input.id}`;
  const factKey = `fact_${input.id.replace('-', '_')}`;
  const proposedValue = input.pendingAfter ?? input.value;
  return {
    id: input.id,
    title: input.title,
    purpose: 'Synthetic workspace for frontend failure coverage.',
    sampleScenario: null,
    revision: input.revision,
    sourceRevision,
    sources: [{
      id: sourceId,
      text: `${input.title} source text with evidence.`,
      title: `${input.title} Source`,
      relation: 'initial',
      targetSourceId: null,
      hash: `${input.id}-hash`,
      createdAt: '2026-09-09T00:00:00.000Z',
    }],
    snapshot: {
      facts: [{
        id: `fact-${input.id}`,
        key: factKey,
        label: 'Memo fact',
        value: input.value,
        evidence: { sourceId, quote: input.title, start: 0, end: input.title.length },
      }],
      blocks: [{
        id: `block-${input.id}`,
        key: `block_${input.id.replace('-', '_')}`,
        type: 'note',
        title: 'Notes',
        items: [{
          id: itemId,
          key: `item_${input.id.replace('-', '_')}`,
          label: 'Memo',
          value: input.value,
          factKeys: [factKey],
          valueFactKey: factKey,
          calculation: null,
          completed: false,
          locked: false,
          edited: false,
          stale: false,
        }],
      }],
    },
    pending: input.pendingAfter || input.questions ? {
      id: `changeset-${input.id}`,
      baseRevision: input.revision,
      baseSourceRevision: sourceRevision,
      proposalRevision: 1,
      summary: 'Synthetic ready proposal',
      questions: input.questions ?? [],
      changes: [{
        id: `change-${input.id}`,
        targetId: itemId,
        label: 'Memo',
        before: input.value,
        after: proposedValue,
        status: 'changed',
        reason: 'Synthetic same-base ready proposal.',
        evidence: [{ sourceId, quote: input.title, start: 0, end: input.title.length }],
      }],
      conflicts: [],
      next: {
        facts: [],
        blocks: [{
          id: `next-block-${input.id}`,
          key: `next_block_${input.id.replace('-', '_')}`,
          type: 'note',
          title: 'Notes',
          items: [{
            id: itemId,
            key: `item_${input.id.replace('-', '_')}`,
            label: 'Memo',
            value: proposedValue,
            factKeys: [],
            valueFactKey: null,
            calculation: null,
            completed: false,
            locked: false,
            edited: false,
            stale: false,
          }],
        }],
      },
      createdAt: '2026-09-09T00:00:00.000Z',
    } : null,
    runs: input.runStatus ? [{
      id: `run-${input.id}`,
      sourceId,
      status: input.runStatus,
      error: null,
      createdAt: '2026-09-09T00:00:00.000Z',
      costMicroUsd: 0,
      mode: 'fixture',
    }] : [],
    history: [],
    expiresAt: '2026-09-16T00:00:00.000Z',
  };
}
