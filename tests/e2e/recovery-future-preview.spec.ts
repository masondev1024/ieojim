import { expect, test, type Page } from '@playwright/test';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';

const origin = 'http://127.0.0.1:5174';

async function freezeBrowserClock(page: Page, iso: string) {
  await page.addInitScript(`
    {
      const fixed = ${JSON.stringify(iso)};
      const RealDate = Date;
      class MockDate extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [fixed]));
        }
        static now() {
          return new RealDate(fixed).getTime();
        }
      }
      Object.setPrototypeOf(MockDate, RealDate);
      globalThis.Date = MockDate;
    }
  `);
}

test.afterEach(async ({ page }) => {
  const listed = await page.request.get('/api/workspaces');
  if (!listed.ok()) return;
  for (const workspace of await listed.json() as Array<{ id: string }>) {
    await page.request.delete(`/api/workspaces/${workspace.id}`, { headers: { origin } });
  }
});

test('future recovery preview is explicit and survives save, recompute, approve and reload', async ({ page }) => {
  await freezeBrowserClock(page, '2030-01-02T00:00:00.000Z');
  await page.goto('/recovery');

  await expect(page.getByText('목 9/17 · 금 9/18')).toBeVisible();
  await page.getByRole('button', { name: '다음 목·금으로 새 체험' }).click();
  await expect(page.getByText('목 1/3 · 금 1/4')).toBeVisible();
  await expect(page.getByRole('region', { name: '조건을 만족하는 일정 조정안', exact: true }).first()).toContainText('15:30–17:00');
  await page.getByRole('button', { name: '미리보기에서 적용' }).click();
  await expect(page.getByRole('button', { name: '미리보기에서 적용' })).toBeDisabled();
  await page.getByLabel('준비 시간(분)').fill('60');
  await expect(page.getByRole('button', { name: '미리보기에서 적용' })).toBeEnabled();
  await page.getByRole('button', { name: '체험용 기준으로 복원' }).click();
  await expect(page.getByLabel('준비 시간(분)')).toHaveValue('90');
  await expect(page.getByLabel('자료 제출 마감')).toHaveValue('2030-01-04T10:00');
  await expect(page.getByRole('button', { name: '미리보기에서 적용' })).toBeEnabled();

  await page.getByRole('button', { name: '작업 공간으로 저장' }).click();
  await expect(page).toHaveURL(/\/recovery\/ws_/);
  const workspaceId = new URL(page.url()).pathname.split('/').at(-1)!;
  const saved = await (await page.request.get(`/api/workspaces/${workspaceId}/recovery`)).json() as { input: { now: string; change: { preparationDeadline: string } } };
  expect(saved.input).toMatchObject({ now: '2030-01-03T14:00', change: { preparationDeadline: '2030-01-04T10:00' } });

  await page.getByLabel('준비 시간(분)').fill('60');
  await page.getByRole('button', { name: '변경 조건 다시 계산' }).click();
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeEnabled();
  await page.getByRole('button', { name: '조정안 적용하기' }).click();
  await expect(page.getByRole('button', { name: '조정안 적용하기' })).toBeDisabled();
  await page.reload();
  await expect(page.getByText('목 1/3 · 금 1/4')).toBeVisible();
  await expect(page.getByLabel('준비 시간(분)')).toHaveValue('60');
  const reloaded = await (await page.request.get(`/api/workspaces/${workspaceId}/recovery`)).json() as { applied: boolean; input: { now: string; change: { preparationDeadline: string } } };
  expect(reloaded).toMatchObject({ applied: true, input: { now: '2030-01-03T14:00', change: { preparationDeadline: '2030-01-04T10:00' } } });
});

test('future preview does not mutate an existing fixed-date saved workspace', async ({ page }) => {
  await freezeBrowserClock(page, '2030-01-02T00:00:00.000Z');
  const created = await page.request.post('/api/recovery/workspaces', {
    headers: { origin },
    data: { input: createRecoveryExample(), requestId: crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const fixed = await created.json() as { workspaceId: string };

  await page.goto(`/recovery/${fixed.workspaceId}`);
  await expect(page.getByText('목 9/17 · 금 9/18')).toBeVisible();
  await page.getByRole('button', { name: '다음 목·금으로 새 체험' }).click();
  await expect(page).toHaveURL(/\/recovery$/);
  await expect(page.getByText('목 1/3 · 금 1/4')).toBeVisible();

  const oldWorkspace = await (await page.request.get(`/api/workspaces/${fixed.workspaceId}/recovery`)).json() as { input: { now: string; change: { preparationDeadline: string } } };
  expect(oldWorkspace.input).toMatchObject({ now: '2026-09-17T14:00', change: { preparationDeadline: '2026-09-18T10:00' } });
});
