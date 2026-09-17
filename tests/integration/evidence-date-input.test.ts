/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, createMessageBatch, env, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveProposalDraftV2, WorkspaceView } from '../../src/core/contracts';
import { buildNoticeSetupPrefill, buildNoticeDateSuggestions } from '../../src/client/recovery/notice-recovery-prefill';
import { createApp } from '../../src/server/app';
import worker from '../../src/server/index';

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const runtime = () => ({ ...testEnv, GEMINI_API_KEY: 'synthetic-test-key', MODEL: 'gemini-3.8-flash' as const });
const app = createApp();
beforeEach(async () => { await reset(); await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());

it('reads dates from actual persisted untyped model facts without changing the stored snapshot or adding paid calls', async () => {
  let cookie = '';
  async function call(path: string, method = 'GET', body?: unknown, status = 200) {
    const response = await app.request(`http://local.test${path}`, { method, headers: { cookie, origin: 'http://local.test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, runtime());
    expect(response.status).toBe(status);
    cookie ||= response.headers.get('set-cookie')?.split(';')[0] ?? '';
    return await response.json() as WorkspaceView;
  }
  vi.spyOn(testEnv.RUN_QUEUE, 'send');
  let view = await call('/api/workspaces', 'POST', { title: '날짜 확인', purpose: '발표 시간 확인' }, 201);
  const path = `/api/workspaces/${view.id}`;
  view = await call(`${path}/sources`, 'POST', { title: '발표 안내', text: '발표는 2026년 10월 21일 16:00입니다.', relation: 'initial', targetSourceId: null, requestId: crypto.randomUUID() });
  const sourceId = view.sources[0]!.id;
  const draft: LiveProposalDraftV2 = {
    schemaVersion: 2, summary: '발표 시간', questions: [], removedItems: [],
    facts: [{ key: 'presentation', label: '발표 시간', value: '2026년 10월 21일 16:00', quote: '2026년 10월 21일 16:00', sourceId, operation: 'create', targetFactKey: null, semantic: null }],
    blocks: [{ key: 'schedule', type: 'schedule', title: '일정', items: [{ key: 'presentation', label: '발표', value: '2026년 10월 21일 16:00', factKeys: ['presentation'], valueFactKey: 'presentation', calculation: null, operation: 'create', targetItemId: null }] }],
  };
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(draft) }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 0, totalTokenCount: 200 },
  }), { headers: { 'content-type': 'application/json' } }));
  const runId = view.runs[0]!.id;
  const deliver = (attempts: number) => worker.queue?.(createMessageBatch('ieojim-runs', [{ id: `date-${attempts}`, timestamp: new Date(), body: { runId }, attempts }]), runtime());
  await deliver(1);
  view = await call(path);
  expect(view.pending!.next.facts[0]!.semantic).toBeNull();
  view = await call(`${path}/apply`, 'POST', { changeSetId: view.pending!.id, proposalRevision: view.pending!.proposalRevision, baseRevision: view.revision, baseSourceRevision: view.sourceRevision, resolutions: [], requestId: crypto.randomUUID() });
  const saved = JSON.stringify(view.snapshot);
  const reloaded = await call(path);
  expect(buildNoticeSetupPrefill(reloaded, sourceId, '', '').targetAfterStart).toMatchObject({ value: '2026-10-21T16:00', provenance: { label: '원문에서 날짜 형식 확인' } });
  expect(buildNoticeDateSuggestions(reloaded, sourceId)).toMatchObject([{ value: '2026-10-21T16:00', method: 'verified_literal' }]);
  expect(JSON.stringify(reloaded.snapshot)).toBe(saved);
  expect((await call(path)).snapshot).toEqual(view.snapshot);
  expect((await call(path)).revision).toBe(view.revision);
  await deliver(2);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(draft.facts[0]!.semantic).toBeNull();
});
