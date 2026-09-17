import { expect, test, type Page } from '@playwright/test';
import type { BlockItem, Fact, WorkspaceView } from '../../src/core/contracts';

test('notice setup uses verified untyped source dates only after clear evidence', async ({ page }) => {
  const workspace = verifiedLiteralWorkspace();
  await page.route(`**/api/workspaces/${workspace.id}`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspace) });
  });

  await page.goto(`/app/workspaces/${workspace.id}/recovery/setup`);
  await page.getByLabel('근거 원문').selectOption('source:notice');

  await expect(page.getByRole('group', { name: '바뀐 일정' }).getByLabel('고객 발표')).toBeChecked();
  await expect(interval(page, '변경된 일정 시간').getByLabel('시작')).toHaveValue('2026-09-18T11:00');

  await page.getByText('준비·이동·다른 일정 확인').click();
  await page.getByRole('group', { name: '기존 준비 항목' }).getByText('발표자료 준비').click();
  await page.getByRole('button', { name: '마감으로 입력: 발표자료 마감 2026-09-17T18:00' }).click();
  await expect(page.getByLabel('준비 마감', { exact: true })).toHaveValue('2026-09-17T18:00');
  await expect(page.getByText('입력 근거 · 원문 근거를 골라 입력함')).toBeVisible();
  await expect(page.locator('#notice-prep-deadline-evidence')).toContainText('2026-09-17 18:00');

  await page.getByLabel('준비 마감', { exact: true }).fill('2026-09-17T20:00');
  await expect(page.getByText('원문 근거를 골라 입력함')).toHaveCount(0);
  await page.getByLabel('준비 마감', { exact: true }).fill('');
  await expect(page.getByText('원문 근거를 골라 입력함')).toHaveCount(0);

  await page.getByRole('button', { name: '마감으로 입력: 발표자료 마감 2026-09-17T18:00' }).click();
  await expect(page.getByLabel('준비 마감', { exact: true })).toHaveValue('2026-09-17T18:00');
  await page.getByRole('group', { name: '기존 준비 항목' }).getByText('리허설 자료 준비').click();
  await expect(page.getByLabel('준비 마감', { exact: true })).toHaveValue('');
  await expect(page.locator('#notice-prep-deadline-evidence')).toHaveCount(0);

  await page.getByLabel('준비 마감', { exact: true }).fill('2026-09-19T20:00');
  await page.getByRole('group', { name: '준비 작업' }).getByLabel('새 준비 작업 만들기').check();
  await expect(page.getByLabel('준비 마감', { exact: true })).toHaveValue('2026-09-19T20:00');
  await page.getByRole('button', { name: '마감으로 입력: 발표자료 마감 2026-09-17T18:00' }).click();
  await page.getByLabel('근거 원문').selectOption('source:other');
  await expect(page.getByLabel('준비 마감', { exact: true })).toHaveValue('');
});

test('notice setup does not offer mismatched, partial or ranged date evidence', async ({ page }) => {
  const workspace = invalidDateWorkspace();
  await page.route(`**/api/workspaces/${workspace.id}`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspace) });
  });

  await page.goto(`/app/workspaces/${workspace.id}/recovery/setup`);
  await page.getByLabel('근거 원문').selectOption('source:notice');

  await expect(page.getByRole('group', { name: '바뀐 일정' }).getByLabel('고객 발표')).not.toBeChecked();
  await page.getByRole('group', { name: '바뀐 일정' }).getByText('고객 발표').click();
  await expect(interval(page, '변경된 일정 시간').getByLabel('시작')).toHaveValue('');

  await page.getByText('준비·이동·다른 일정 확인').click();
  await page.getByRole('group', { name: '기존 준비 항목' }).getByText('발표자료 준비').click();
  await expect(page.locator('[aria-label="준비 마감 제안"]')).toHaveCount(0);
});

function interval(page: Page, label: string) {
  return page.locator('.notice-interval').filter({ hasText: label }).first();
}

function verifiedLiteralWorkspace(): WorkspaceView {
  const sourceText = [
    '고객 발표는 2026-09-18 11:00에 진행합니다.',
    '발표자료 마감은 2026-09-17 18:00까지입니다.',
    '리허설 자료 마감은 2026-09-19 17:00까지입니다.',
  ].join(' ');
  const presentationQuote = '2026-09-18 11:00';
  const prepQuote = '2026-09-17 18:00';
  const rehearsalQuote = '2026-09-19 17:00';
  return workspaceBase('ws_evidence_dates', sourceText, [
    fact('fact:presentation', 'presentation_time', '고객 발표 시간', '2026-09-18T11:00', presentationQuote, sourceText),
    fact('fact:prep-deadline', 'prep_deadline', '발표자료 마감', '2026-09-17T18:00', prepQuote, sourceText),
    fact('fact:rehearsal-deadline', 'rehearsal_deadline', '리허설 자료 마감', '2026-09-19T17:00', rehearsalQuote, sourceText),
  ]);
}

function invalidDateWorkspace(): WorkspaceView {
  const sourceText = [
    '고객 발표는 2026-09-18 11:00에 진행합니다.',
    '발표는 2026-09-18 14:00에서 2026-09-18 11:00로 변경됩니다.',
    '발표자료 마감은 9월 17일 18:00까지입니다.',
  ].join(' ');
  const presentationQuote = '고객 발표는 2026-09-18 11:00에 진행합니다.';
  const rangeQuote = '발표는 2026-09-18 14:00에서 2026-09-18 11:00로 변경됩니다.';
  const partialQuote = '발표자료 마감은 9월 17일 18:00까지입니다.';
  const badPresentation = fact('fact:presentation', 'presentation_time', '고객 발표 시간', '2026-10-21T11:00', presentationQuote, sourceText, {
    kind: 'date_time',
    date: '2026-10-21',
    time: '11:00',
  });
  const range = fact('fact:range', 'prep_deadline', '발표 변경 범위', '2026-09-18T11:00', rangeQuote, sourceText);
  const partial = fact('fact:partial', 'prep_partial', '발표자료 마감', '09-17T18:00', partialQuote, sourceText, {
    kind: 'date_time',
    date: '09-17',
    time: '18:00',
  });
  return workspaceBase('ws_invalid_dates', sourceText, [badPresentation, range, partial], { prepFactKeys: ['prep_deadline', 'prep_partial'] });
}

function workspaceBase(id: string, sourceText: string, facts: Fact[], options: { prepFactKeys?: string[] } = {}): WorkspaceView {
  return {
    id,
    title: '근거 날짜 입력',
    purpose: '원문 근거가 확실한 날짜만 입력한다.',
    sampleScenario: null,
    revision: 5,
    sourceRevision: 1,
    sources: [
      { id: 'source:notice', title: '변경 안내', text: sourceText, relation: 'initial', targetSourceId: null, hash: `${id}:hash`, createdAt: '2026-09-16T00:00:00.000Z' },
      { id: 'source:other', title: '다른 안내', text: '검증된 날짜가 없는 다른 안내입니다.', relation: 'addition', targetSourceId: null, hash: `${id}:other`, createdAt: '2026-09-16T00:00:00.000Z' },
    ],
    snapshot: {
      facts,
      blocks: [
        { id: 'block:schedule', key: 'schedule', type: 'schedule', title: '일정', items: [item('item:presentation', 'presentation', '고객 발표', '발표 시간', ['presentation_time'], 'presentation_time')] },
        {
          id: 'block:checklist', key: 'checklist', type: 'checklist', title: '준비', items: [
            item('item:prep', 'prep', '발표자료 준비', '자료 정리', options.prepFactKeys ?? ['prep_deadline'], null, { preparation: { version: 1, dueDate: '2026-09-17', durationMinutes: 90 } }),
            item('item:rehearsal-prep', 'rehearsal_prep', '리허설 자료 준비', '리허설 자료 정리', ['rehearsal_deadline'], null, { preparation: { version: 1, dueDate: '2026-09-19', durationMinutes: 30 } }),
          ],
        },
      ],
    },
    pending: null,
    runs: [{ id: `${id}:run`, sourceId: 'source:notice', status: 'applied', error: null, createdAt: '2026-09-16T00:00:00.000Z', costMicroUsd: 10, mode: 'live' }],
    history: [{ revision: 5, createdAt: '2026-09-16T00:00:00.000Z', reason: 'manual_edit' }],
    expiresAt: '2026-09-23T00:00:00.000Z',
  };
}

function item(id: string, key: string, label: string, value: string, factKeys: string[], valueFactKey: string | null, overrides: Partial<BlockItem> = {}): BlockItem {
  return { id, key, label, value, factKeys, valueFactKey, calculation: null, completed: false, locked: false, edited: false, stale: false, ...overrides };
}

function fact(id: string, key: string, label: string, value: string, quote: string, sourceText: string, semantic: Fact['semantic'] = null): Fact {
  return {
    id,
    key,
    label,
    value,
    evidence: { sourceId: 'source:notice', quote, start: sourceText.indexOf(quote), end: sourceText.indexOf(quote) + quote.length },
    semantic,
  };
}
