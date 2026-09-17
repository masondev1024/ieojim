import { expect, test, type Page } from '@playwright/test';
import type { WorkspaceView } from '../../src/core/contracts';

test('notice recovery setup prefills only evidence-backed fields and keeps approval manual', async ({ page }) => {
  const workspace = prefillWorkspace();
  await page.route(`**/api/workspaces/${workspace.id}`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspace) });
  });

  await page.goto(`/app/workspaces/${workspace.id}/recovery/setup`);

  await expect(page.getByRole('group', { name: '바뀐 일정' }).getByLabel('고객 발표')).toBeChecked();
  const changed = interval(page, '변경된 일정 시간');
  await expect(changed.getByLabel('시작')).toHaveValue('2026-09-18T11:00');
  await expect(changed.getByLabel('끝')).toHaveValue('');
  await expect(changed.getByText('자동 채움 · 원문 근거에서 가져옴')).toBeVisible();

  await page.getByText('준비·이동·다른 일정 확인').click();
  await expect(page.getByRole('group', { name: '기존 준비 항목' }).getByLabel('발표자료 준비')).toBeChecked();
  await expect(page.getByLabel('준비 시간(분)')).toHaveValue('90');
  await expect(page.getByText('참고 · 준비 설정에 저장된 마감일')).toBeVisible();
  await expect(page.getByLabel('일정 직전 이동(분)')).toHaveValue('');

  await page.getByText('가용 시간과 확인').click();
  await expect(page.getByRole('button', { name: '일정 조정 작업 공간 만들기' })).toBeDisabled();
  await expect(page.getByText('저장된 근거와 준비 설정에서')).toBeVisible();
});

function interval(page: Page, label: string) {
  return page.locator('.notice-interval').filter({ hasText: label }).first();
}

function prefillWorkspace(): WorkspaceView {
  const sourceText = [
    '고객 발표는 2026-09-18 11:00에 진행합니다.',
    '내부 회의는 2026-09-17 10:00부터 2026-09-17 11:00까지입니다.',
  ].join(' ');
  const presentationQuote = '고객 발표는 2026-09-18 11:00에 진행합니다.';
  return {
    id: 'ws_notice_prefill',
    title: '고객 발표 준비',
    purpose: '바뀐 안내에 맞춰 준비 시간을 확인한다.',
    sampleScenario: null,
    revision: 3,
    sourceRevision: 1,
    sources: [{
      id: 'source:notice',
      title: '고객 발표 안내',
      text: sourceText,
      relation: 'initial',
      targetSourceId: null,
      hash: 'hash_notice_prefill',
      createdAt: '2026-09-16T00:00:00.000Z',
    }],
    snapshot: {
      facts: [{
        id: 'fact:presentation',
        key: 'presentation_time',
        label: '고객 발표 시간',
        value: '2026-09-18T11:00',
        evidence: {
          sourceId: 'source:notice',
          quote: presentationQuote,
          start: sourceText.indexOf(presentationQuote),
          end: sourceText.indexOf(presentationQuote) + presentationQuote.length,
        },
        semantic: { kind: 'date_time', date: '2026-09-18', time: '11:00' },
      }],
      blocks: [
        {
          id: 'block:schedule',
          key: 'schedule',
          type: 'schedule',
          title: '일정',
          items: [
            item('item:presentation', 'presentation', '고객 발표', '11시 발표', ['presentation_time'], 'presentation_time'),
          ],
        },
        {
          id: 'block:checklist',
          key: 'checklist',
          type: 'checklist',
          title: '준비',
          items: [
            { ...item('item:prep', 'prep', '발표자료 준비', '자료 정리', [], null), preparation: { version: 1, dueDate: '2026-09-18', durationMinutes: 90 } },
          ],
        },
      ],
    },
    pending: null,
    runs: [{ id: 'run_prefill', sourceId: 'source:notice', status: 'applied', error: null, createdAt: '2026-09-16T00:00:00.000Z', costMicroUsd: 10, mode: 'live' }],
    history: [{ revision: 3, createdAt: '2026-09-16T00:00:00.000Z', reason: 'manual_edit' }],
    expiresAt: '2026-09-23T00:00:00.000Z',
  };
}

test('notice recovery setup clears auto provenance across source, target and preparation switches', async ({ page }) => {
  const workspace = switchWorkspace();
  await page.route(`**/api/workspaces/${workspace.id}`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspace) });
  });

  await page.goto(`/app/workspaces/${workspace.id}/recovery/setup`);
  await expect(page.getByLabel('근거 원문')).toHaveValue('source:other');
  await expect(interval(page, '변경된 일정 시간').getByLabel('시작')).toHaveValue('');
  await page.getByLabel('근거 원문').selectOption('source:notice');
  await expect(page.getByRole('group', { name: '바뀐 일정' }).getByLabel('고객 발표')).not.toBeChecked();
  await page.getByRole('group', { name: '바뀐 일정' }).getByText('고객 발표').click();
  await expect(page.getByRole('group', { name: '바뀐 일정' }).getByLabel('고객 발표')).toBeChecked();
  await expect(interval(page, '변경된 일정 시간').getByLabel('시작')).toHaveValue('2026-09-18T11:00');

  await interval(page, '변경된 일정 시간').getByLabel('끝').fill('2026-09-18T12:00');
  await page.getByText('가용 시간과 확인').click();
  await page.getByLabel('위 시간, 준비 조건, 다른 일정, 가용 시간을 내가 확인했습니다.').check();

  await page.getByRole('group', { name: '바뀐 일정' }).getByText('예비 리허설').click();
  await expect(interval(page, '변경된 일정 시간').getByLabel('시작')).toHaveValue('2026-09-19T09:00');
  await expect(interval(page, '변경된 일정 시간').getByLabel('끝')).toHaveValue('');
  await expect(page.getByLabel('위 시간, 준비 조건, 다른 일정, 가용 시간을 내가 확인했습니다.')).not.toBeChecked();

  await page.getByText('준비·이동·다른 일정 확인').click();
  await expect(page.getByLabel('준비 시간(분)')).toHaveValue('');
  await page.getByRole('group', { name: '기존 준비 항목' }).getByText('발표자료 준비', { exact: true }).click();
  await expect(page.getByLabel('준비 시간(분)')).toHaveValue('90');
  await page.getByRole('group', { name: '기존 준비 항목' }).getByText('리허설 자료 준비').click();
  await expect(page.getByLabel('준비 시간(분)')).toHaveValue('30');
  await expect(page.getByText('리허설 자료 준비에 저장된 준비 시간')).toBeVisible();
  await expect(page.getByText('발표자료 준비에 저장된 준비 시간')).toHaveCount(0);

  await page.getByLabel('근거 원문').selectOption('source:other');
  await expect(page.getByRole('group', { name: '바뀐 일정' }).getByLabel('고객 발표')).not.toBeChecked();
  await expect(interval(page, '변경된 일정 시간').getByLabel('시작')).toHaveValue('');
  await expect(page.getByText('원문 근거에서 가져옴')).toHaveCount(0);
  await expect(page.getByLabel('위 시간, 준비 조건, 다른 일정, 가용 시간을 내가 확인했습니다.')).not.toBeChecked();
});

function item(id: string, key: string, label: string, value: string, factKeys: string[], valueFactKey: string | null) {
  return { id, key, label, value, factKeys, valueFactKey, calculation: null, completed: false, locked: false, edited: false, stale: false };
}

function switchWorkspace(): WorkspaceView {
  const sourceText = [
    '고객 발표는 2026-09-18 11:00에 진행합니다.',
    '예비 리허설은 2026-09-19 09:00에 진행합니다.',
  ].join(' ');
  const presentationQuote = '고객 발표는 2026-09-18 11:00에 진행합니다.';
  const rehearsalQuote = '예비 리허설은 2026-09-19 09:00에 진행합니다.';
  return {
    id: 'ws_notice_switch',
    title: '전환 경계 확인',
    purpose: '선택 전환 중 이전 자동 채움이 남지 않는다.',
    sampleScenario: null,
    revision: 4,
    sourceRevision: 2,
    sources: [
      {
        id: 'source:notice',
        title: '발표 안내',
        text: sourceText,
        relation: 'initial',
        targetSourceId: null,
        hash: 'hash_notice_switch',
        createdAt: '2026-09-16T00:00:00.000Z',
      },
      {
        id: 'source:other',
        title: '다른 안내',
        text: '아직 일정으로 연결하지 않은 별도 안내입니다.',
        relation: 'addition',
        targetSourceId: null,
        hash: 'hash_other_switch',
        createdAt: '2026-09-16T00:00:00.000Z',
      },
    ],
    snapshot: {
      facts: [
        {
          id: 'fact:presentation',
          key: 'presentation_time',
          label: '고객 발표 시간',
          value: '2026-09-18T11:00',
          evidence: { sourceId: 'source:notice', quote: presentationQuote, start: sourceText.indexOf(presentationQuote), end: sourceText.indexOf(presentationQuote) + presentationQuote.length },
          semantic: { kind: 'date_time', date: '2026-09-18', time: '11:00' },
        },
        {
          id: 'fact:rehearsal',
          key: 'rehearsal_time',
          label: '예비 리허설 시간',
          value: '2026-09-19T09:00',
          evidence: { sourceId: 'source:notice', quote: rehearsalQuote, start: sourceText.indexOf(rehearsalQuote), end: sourceText.indexOf(rehearsalQuote) + rehearsalQuote.length },
          semantic: { kind: 'date_time', date: '2026-09-19', time: '09:00' },
        },
      ],
      blocks: [
        {
          id: 'block:schedule',
          key: 'schedule',
          type: 'schedule',
          title: '일정',
          items: [
            item('item:presentation', 'presentation', '고객 발표', '11시 발표', ['presentation_time'], 'presentation_time'),
            item('item:rehearsal', 'rehearsal', '예비 리허설', '9시 리허설', ['rehearsal_time'], 'rehearsal_time'),
          ],
        },
        {
          id: 'block:checklist',
          key: 'checklist',
          type: 'checklist',
          title: '준비',
          items: [
            { ...item('item:prep', 'prep', '발표자료 준비', '자료 정리', [], null), preparation: { version: 1, dueDate: '2026-09-18', durationMinutes: 90 } },
            { ...item('item:rehearsal-prep', 'rehearsal_prep', '리허설 자료 준비', '리허설 자료 정리', [], null), preparation: { version: 1, dueDate: '2026-09-19', durationMinutes: 30 } },
          ],
        },
      ],
    },
    pending: null,
    runs: [{ id: 'run_switch', sourceId: 'source:notice', status: 'applied', error: null, createdAt: '2026-09-16T00:00:00.000Z', costMicroUsd: 10, mode: 'live' }],
    history: [{ revision: 4, createdAt: '2026-09-16T00:00:00.000Z', reason: 'manual_edit' }],
    expiresAt: '2026-09-23T00:00:00.000Z',
  };
}


test('manual edits and deliberate clears stay untouched and remove automatic provenance', async ({ page }) => {
  const workspace = prefillWorkspace();
  await page.route(`**/api/workspaces/${workspace.id}`, (route) => route.fulfill({ status: 200, json: workspace }));
  await page.goto(`/app/workspaces/${workspace.id}/recovery/setup`);
  const changed = interval(page, '변경된 일정 시간');
  await expect(changed.getByLabel('시작')).toHaveValue('2026-09-18T11:00');
  await changed.getByLabel('시작').fill('');
  await changed.getByLabel('끝').fill('2026-09-18T12:00');
  await expect(changed.getByLabel('시작')).toHaveValue('');
  await expect(changed.getByText('자동 채움 · 원문 근거에서 가져옴')).toHaveCount(0);
  await page.getByText('준비·이동·다른 일정 확인', { exact: true }).click();
  await page.getByLabel('준비 시간(분)', { exact: true }).fill('45');
  await page.getByLabel('준비 마감', { exact: true }).fill('2026-09-18T10:00');
  await expect(page.getByLabel('준비 시간(분)', { exact: true })).toHaveValue('45');
  await expect(page.getByText('발표자료 준비에 저장된 준비 시간', { exact: true })).toHaveCount(0);
  await page.getByLabel('준비 시간(분)', { exact: true }).fill('');
  await page.getByLabel('일정 직전 이동(분)', { exact: true }).fill('20');
  await expect(page.getByLabel('준비 시간(분)', { exact: true })).toHaveValue('');
});
