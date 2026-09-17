import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

type WorkspaceSummary = { id: string; title: string };
type WorkspaceView = {
  id: string;
  title: string;
  sampleScenario: 'travel' | 'syllabus' | 'departure' | null;
  revision: number;
  sourceRevision: number;
  sources: Array<{ id: string; title: string; text: string }>;
  snapshot: Snapshot;
  pending: ChangeSet | null;
  history: Array<{ revision: number; reason: string }>;
};
type Snapshot = { facts: Fact[]; blocks: Block[] };
type Fact = { key: string; value: string | number };
type Block = { type: 'schedule' | 'cost' | 'checklist' | 'note'; items: BlockItem[] };
type BlockItem = { id: string; key: string; label: string; value: string; completed: boolean; locked: boolean; edited: boolean; stale: boolean };
type ChangeSet = {
  baseRevision: number;
  baseSourceRevision: number;
  proposalRevision: number;
  changes: Array<{ targetId: string; label: string; before: string; after: string; status: 'changed' | 'preserved' | 'needs_review'; evidence: Array<{ quote: string }> }>;
  conflicts: Array<{ id: string; itemId: string | null; kind: 'locked' | 'deletion' | 'source'; factKey: string | null }>;
};

const itemIds = {
  arrival: 'item:travel_schedule:arrival_day1',
  dinner: 'item:travel_schedule:dinner_day2',
  costShare: 'item:travel_cost:fixed_cost_share',
  shareMessage: 'item:travel_note:share_message',
  paperConfirmation: 'item:travel_checklist:paper_confirmation_print',
} as const;

const manualShareMessage = '민지야, 출발 전날 다시 정리된 내용만 보고 움직이면 돼. 내가 종이 확인서는 챙겨둘게.';

test.beforeAll(() => {
  mkdirSync('artifacts/departure-story-2026-09-14', { recursive: true });
});

test.afterEach(async ({ page }) => {
  await cleanupOwnedWorkspaces(page);
});

test('/app?example=departure waits for explicit sample creation', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET') {
      writes.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.goto('/app?example=departure');

  await expect(page).toHaveURL(/\/app\?example=departure$/);
  await expect(page.getByRole('heading', { name: /여행 준비,.*여기서 이어가세요/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '출발 전날 복합 체험 시작' }).first()).toBeVisible();
  await expect.poll(() => readWorkspaceSummaries(page).then((workspaces) => workspaces.length)).toBe(0);
  expect(writes).toEqual([]);

  const createResponse = page.waitForResponse((response) => response.url().endsWith('/api/workspaces/sample') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '출발 전날 복합 체험 시작' }).first().click();
  const createdResponse = await createResponse;
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json() as WorkspaceView;

  await expect(page).toHaveURL(new RegExp(`/app/workspaces/${created.id}$`));
  await expect(page.getByRole('heading', { name: '합성 예시: 출발 전날 변경' })).toBeVisible();
  expect(created.sampleScenario).toBe('departure');
  expect(created.revision).toBe(1);
  expect(created.sourceRevision).toBe(1);
  expect(writes).toEqual(['POST /api/workspaces/sample']);
});

test('departure sample applies selected conflicts, persists, and restores revision 1 content', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/app?example=departure');
  await page.getByRole('button', { name: '출발 전날 복합 체험 시작' }).first().click();
  await expect(page.getByRole('heading', { name: '합성 예시: 출발 전날 변경' })).toBeVisible();

  const workspaceId = workspaceIdFromUrl(page);
  const initial = await readWorkspace(page, workspaceId);
  expect(initial.sampleScenario).toBe('departure');
  expect(initial.revision).toBe(1);
  expect(initial.sourceRevision).toBe(1);
  expect(initial.pending).toBeNull();
  expect(item(initial, itemIds.dinner)).toMatchObject({ value: '오후 7시 약속', locked: true });
  expect(item(initial, itemIds.shareMessage)).toMatchObject({ value: manualShareMessage, edited: true });
  expect(item(initial, itemIds.paperConfirmation)).toMatchObject({ completed: true });
  expect(item(initial, itemIds.costShare).value).toBe('225000');
  expect(item(initial, itemIds.arrival).value).toBe('오전 10시 도착');

  const updateResponse = page.waitForResponse((response) => response.url().includes('/sample-update') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '출발 전날 정정 안내 불러오기' }).click();
  expect((await updateResponse).status()).toBe(200);
  await page.getByRole('navigation', { name: '작업 화면' }).getByRole('button', { name: '변경 검토', exact: true }).click();

  const review = reviewPanel(page);
  await expect(review.getByText('2개 확인이 필요한 선택이 남아 있습니다.')).toBeVisible();
  await expect(review.getByRole('button', { name: '확인한 변경 저장' })).toBeDisabled();
  await page.screenshot({ path: `artifacts/departure-story-2026-09-14/${testInfo.project.name}-workspace-review.png`, fullPage: true });

  const proposed = await readWorkspace(page, workspaceId);
  expect(proposed.revision).toBe(1);
  expect(proposed.sourceRevision).toBe(2);
  expect(proposed.sources).toHaveLength(2);
  expect(proposed.pending).not.toBeNull();
  expect(proposed.pending?.baseRevision).toBe(1);
  expect(proposed.pending?.baseSourceRevision).toBe(2);
  expect(proposed.pending?.conflicts).toHaveLength(2);
  expect(proposed.pending?.conflicts).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'locked', itemId: itemIds.dinner }),
    expect.objectContaining({ kind: 'deletion', itemId: itemIds.paperConfirmation }),
  ]));
  expect(changeFor(proposed, itemIds.dinner)).toMatchObject({
    before: '오후 7시 약속',
    after: '오후 8시 약속',
    status: 'needs_review',
  });
  expect(changeFor(proposed, itemIds.paperConfirmation)).toMatchObject({
    before: '출발 전 종이 확인서 출력',
    after: '',
    status: 'needs_review',
  });
  expect(changeFor(proposed, itemIds.dinner).evidence.map((entry) => entry.quote)).toContain('둘째 날 저녁 약속은 오후 8시로 변경해야 합니다');
  expect(changeFor(proposed, itemIds.paperConfirmation).evidence.map((entry) => entry.quote)).toContain('종이 확인서 출력 항목은 삭제해 주세요');

  expect(item(proposed, itemIds.dinner)).toMatchObject({ value: '오후 7시 약속', locked: true });
  expect(item(proposed, itemIds.paperConfirmation)).toMatchObject({ completed: true });
  expect(item(proposed, itemIds.shareMessage)).toMatchObject({ value: manualShareMessage, edited: true });
  expect(item(proposed, itemIds.arrival).value).toBe('오전 10시 도착');
  expect(item(proposed, itemIds.costShare).value).toBe('225000');

  await review.getByRole('group', { name: '둘째 날 저녁 확인 선택', exact: true }).getByRole('button', { name: '내 결정 유지' }).click();
  await expect(review.getByRole('button', { name: '확인한 변경 저장' })).toBeDisabled();
  await review.getByRole('group', { name: '종이 확인서 출력 확인 선택', exact: true }).getByRole('button', { name: '새 원문 값 사용' }).click();
  await expect(review.getByRole('button', { name: '확인한 변경 저장' })).toBeEnabled();

  const applyResponse = page.waitForResponse((response) => response.url().endsWith(`/api/workspaces/${workspaceId}/apply`) && response.request().method() === 'POST');
  await review.getByRole('button', { name: '확인한 변경 저장' }).click();
  expect((await applyResponse).status()).toBe(200);
  await expect(page.locator('.status-notice')).toContainText('확인한 변경을 저장했습니다.');

  const applied = await readWorkspace(page, workspaceId);
  expect(applied.revision).toBe(2);
  expect(applied.sourceRevision).toBe(2);
  expect(applied.pending).toBeNull();
  expect(applied.sources).toHaveLength(2);
  expect(fact(applied, 'participants').value).toBe(3);
  expect(item(applied, itemIds.arrival).value).toBe('오후 4시 도착');
  expect(item(applied, itemIds.costShare).value).toBe('300000');
  expect(item(applied, itemIds.dinner)).toMatchObject({ value: '오후 7시 약속', locked: true });
  expect(item(applied, itemIds.shareMessage)).toMatchObject({ value: manualShareMessage, edited: true });
  expect(findItem(applied, itemIds.paperConfirmation)).toBeUndefined();

  await page.reload();
  await expect(page.getByRole('heading', { name: '합성 예시: 출발 전날 변경' })).toBeVisible();
  const reloaded = await readWorkspace(page, workspaceId);
  expect(reloaded.revision).toBe(2);
  expect(item(reloaded, itemIds.arrival).value).toBe('오후 4시 도착');
  expect(findItem(reloaded, itemIds.paperConfirmation)).toBeUndefined();

  await page.getByRole('button', { name: '변경 이력', exact: true }).click();
  const restoreResponse = page.waitForResponse((response) => response.url().endsWith(`/api/workspaces/${workspaceId}/restore`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: /1번 저장된 계획 복원/ }).click();
  expect((await restoreResponse).status()).toBe(200);

  const restored = await readWorkspace(page, workspaceId);
  expect(restored.revision).toBeGreaterThan(reloaded.revision);
  expect(restored.sourceRevision).toBe(2);
  expect(restored.sources).toHaveLength(2);
  expect(restored.history).toEqual(expect.arrayContaining([
    expect.objectContaining({ revision: 1, reason: 'sample_initial' }),
    expect.objectContaining({ revision: restored.revision, reason: 'restore_1' }),
  ]));
  expect(fact(restored, 'participants').value).toBe(4);
  expect(item(restored, itemIds.arrival).value).toBe('오전 10시 도착');
  expect(item(restored, itemIds.costShare).value).toBe('225000');
  expect(item(restored, itemIds.dinner)).toMatchObject({ value: '오후 7시 약속', locked: true });
  expect(item(restored, itemIds.shareMessage)).toMatchObject({ value: manualShareMessage, edited: true });
  expect(item(restored, itemIds.paperConfirmation)).toMatchObject({ completed: true });
});

function reviewPanel(page: Page): Locator {
  return page.getByRole('complementary', { name: '변경 검토' });
}

function workspaceIdFromUrl(page: Page): string {
  const match = /\/app\/workspaces\/([^/?#]+)/.exec(page.url());
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

async function readWorkspaceSummaries(page: Page): Promise<WorkspaceSummary[]> {
  const response = await page.request.get(new URL('/api/workspaces', page.url()).toString());
  expect(response.status()).toBe(200);
  return await response.json() as WorkspaceSummary[];
}

async function readWorkspace(page: Page, workspaceId: string): Promise<WorkspaceView> {
  const response = await page.request.get(new URL(`/api/workspaces/${workspaceId}`, page.url()).toString());
  expect(response.status()).toBe(200);
  return await response.json() as WorkspaceView;
}

function fact(view: WorkspaceView, key: string): Fact {
  const found = view.snapshot.facts.find((candidate) => candidate.key === key);
  expect(found, `missing fact ${key}`).toBeTruthy();
  return found!;
}

function item(view: WorkspaceView, id: string): BlockItem {
  const found = findItem(view, id);
  expect(found, `missing item ${id}`).toBeTruthy();
  return found!;
}

function findItem(view: WorkspaceView, id: string): BlockItem | undefined {
  return view.snapshot.blocks.flatMap((block) => block.items).find((candidate) => candidate.id === id);
}

function changeFor(view: WorkspaceView, targetId: string): NonNullable<WorkspaceView['pending']>['changes'][number] {
  const found = view.pending?.changes.find((change) => change.targetId === targetId);
  expect(found, `missing change for ${targetId}`).toBeTruthy();
  return found!;
}

async function cleanupOwnedWorkspaces(page: Page) {
  if (!page.url().startsWith('http')) return;
  const origin = new URL(page.url()).origin;
  const listResponse = await page.request.get(new URL('/api/workspaces', origin).toString());
  expect(listResponse.status()).toBe(200);
  const workspaces = await listResponse.json() as WorkspaceSummary[];
  for (const workspace of workspaces) {
    const deleteResponse = await page.request.delete(new URL(`/api/workspaces/${workspace.id}`, origin).toString(), {
      headers: { Origin: origin },
    });
    expect([204, 404]).toContain(deleteResponse.status());
  }
  const afterCleanup = await page.request.get(new URL('/api/workspaces', origin).toString());
  expect(afterCleanup.status()).toBe(200);
  expect(await afterCleanup.json()).toEqual([]);
}
