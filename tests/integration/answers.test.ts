/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, createMessageBatch, env, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import type { ChangeSet, WorkspaceView } from '../../src/core/contracts';
import worker from '../../src/server/index';

const app = createApp();
const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
async function request(path: string, method: string, body: unknown, cookie?: string, bindings = testEnv) {
  return app.request(`http://local.test${path}`, {
    method, headers: { origin: 'http://local.test', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, bindings);
}
beforeEach(async () => { await reset(); await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
afterEach(() => vi.restoreAllMocks());

async function questionWorkspace() {
  const response = await request('/api/workspaces', 'POST', { title: '질문', purpose: '인원 확인' });
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const created = await response.json() as WorkspaceView;
  const sourceResponse = await request(`/api/workspaces/${created.id}/sources`, 'POST', {
    title: '첫 자료', text: '참석 인원은 아직 정해지지 않았습니다.', relation: 'initial', targetSourceId: null, requestId: crypto.randomUUID(),
  }, cookie);
  const view = await sourceResponse.json() as WorkspaceView;
  const pending: ChangeSet = { id: 'cs_question', baseRevision: view.revision, baseSourceRevision: view.sourceRevision, proposalRevision: 1,
    summary: '인원을 확인해 주세요.', questions: ['참석자는 몇 명인가요?'], changes: [], conflicts: [], next: view.snapshot, createdAt: new Date().toISOString() };
  await testEnv.DB.batch([
    testEnv.DB.prepare('UPDATE workspaces SET pending_changeset_json = ?, pending_proposal_revision = 1 WHERE id = ?').bind(JSON.stringify(pending), view.id),
    testEnv.DB.prepare('UPDATE runs SET status = "needs_input", changeset_id = ? WHERE id = ?').bind(pending.id, view.runs[0].id),
  ]);
  const answerTo = { changeSetId: pending.id, proposalRevision: 1, baseRevision: view.revision, baseSourceRevision: view.sourceRevision };
  const input = { title: '확인 질문에 대한 답변', text: '참석자는 4명입니다.', relation: 'addition', targetSourceId: null, requestId: crypto.randomUUID(), answerTo };
  return { view, cookie, pending, input };
}

describe('question answer lineage', () => {
  it('stores the answer with server-owned question context and supersedes the old proposal atomically', async () => {
    const { view, cookie, pending, input } = await questionWorkspace();
    const response = await request(`/api/workspaces/${view.id}/sources`, 'POST', input, cookie);
    expect(response.status).toBe(200);
    const answered = await response.json() as WorkspaceView;
    expect(answered.sources.at(-1)).toMatchObject({ text: input.text, relation: 'addition', answerTo: { ...input.answerTo, questions: pending.questions } });
    expect(answered.pending).toBeNull();
    expect(answered.sourceRevision).toBe(view.sourceRevision + 1);
    expect(answered.runs.find(({ id }) => id === view.runs[0].id)?.status).toBe('failed');
    const reread = await (await request(`/api/workspaces/${view.id}`, 'GET', undefined, cookie)).json() as WorkspaceView;
    expect(reread.sources).toEqual(answered.sources);
    expect(reread.pending).toBeNull();
    const replay = await request(`/api/workspaces/${view.id}/sources`, 'POST', input, cookie);
    expect(await replay.json()).toEqual(answered);
  });

  it('rejects a stale or forged question reference without appending data', async () => {
    const { view, cookie, input } = await questionWorkspace();
    for (const answerTo of [{ ...input.answerTo, changeSetId: 'foreign' }, { ...input.answerTo, baseRevision: 9 }]) {
      const response = await request(`/api/workspaces/${view.id}/sources`, 'POST', { ...input, answerTo }, cookie);
      expect(response.status).toBe(409);
    }
    const reread = await (await request(`/api/workspaces/${view.id}`, 'GET', undefined, cookie)).json() as WorkspaceView;
    expect(reread.sources).toHaveLength(1);
    expect(reread.pending?.questions).toHaveLength(1);
  });

  it('allows only one answer to the same proposal under concurrent requests', async () => {
    const { view, cookie, input } = await questionWorkspace();
    const responses = await Promise.all([1, 2].map((n) => request(`/api/workspaces/${view.id}/sources`, 'POST', {
      ...input, text: `참석자는 ${n}명입니다.`, requestId: crypto.randomUUID(),
    }, cookie)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const reread = await (await request(`/api/workspaces/${view.id}`, 'GET', undefined, cookie)).json() as WorkspaceView;
    expect(reread.sources).toHaveLength(2);
  });

  it('keeps the old pending question when an answer is rejected by storage admission', async () => {
    const { view, cookie, input } = await questionWorkspace();
    await testEnv.DB.prepare('UPDATE storage_policy SET max_content_bytes = 0').run();
    const response = await request(`/api/workspaces/${view.id}/sources`, 'POST', input, cookie);
    expect(response.status).toBe(429);
    const reread = await (await request(`/api/workspaces/${view.id}`, 'GET', undefined, cookie)).json() as WorkspaceView;
    expect(reread.pending?.id).toBe(input.answerTo.changeSetId);
    expect(reread.sources).toHaveLength(1);
    expect(reread.runs[0].status).toBe('needs_input');
  });

  it('rejects an oversized assembled live input before reserving money or storing source', async () => {
    const response = await request('/api/workspaces', 'POST', { title: '큰 자료', purpose: '여행' });
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const view = await response.json() as WorkspaceView;
    const result = await request(`/api/workspaces/${view.id}/sources`, 'POST', {
      title: '원문', text: '가'.repeat(6000), relation: 'initial', targetSourceId: null, requestId: crypto.randomUUID(),
    }, cookie, { ...testEnv, GEMINI_API_KEY: 'synthetic-not-a-secret' } as typeof testEnv);
    expect(result.status).toBe(413);
    expect(await result.json()).toMatchObject({ error: { code: 'MODEL_INPUT_TOO_LARGE' } });
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM budget_ledger').first<{ n: number }>())!.n).toBe(0);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>())!.n).toBe(0);
  });

  it('does not consume the explicit retry slot for an input that cannot be sent', async () => {
    const created = await request('/api/workspaces', 'POST', { title: '자료 보관', purpose: '여행' });
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    const view = await created.json() as WorkspaceView;
    const stored = await (await request(`/api/workspaces/${view.id}/sources`, 'POST', {
      title: '원문', text: '가'.repeat(6000), relation: 'initial', targetSourceId: null, requestId: crypto.randomUUID(),
    }, cookie)).json() as WorkspaceView;
    const result = await request(`/api/workspaces/${view.id}/retry`, 'POST', {
      runId: stored.runs[0].id, requestId: crypto.randomUUID(),
    }, cookie, { ...testEnv, GEMINI_API_KEY: 'synthetic-not-a-secret' } as typeof testEnv);
    expect(result.status).toBe(413);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM budget_ledger').first<{ n: number }>())!.n).toBe(0);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE retry_of_run_id IS NOT NULL').first<{ n: number }>())!.n).toBe(0);
  });

  it('runs a new answer through the mocked provider, review and atomic apply', async () => {
    const { view, cookie, input, pending } = await questionWorkspace();
    const bindings = { ...testEnv, GEMINI_API_KEY: 'synthetic-not-a-secret' } as typeof testEnv;
    const answered = await (await request(`/api/workspaces/${view.id}/sources`, 'POST', input, cookie, bindings)).json() as WorkspaceView;
    expect(answered.pending).toBeNull();
    const source = answered.sources.at(-1)!;
    const run = answered.runs.find((candidate) => candidate.sourceId === source.id)!;
    expect(run.status).toBe('pending');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const modelRequest = JSON.parse(String(init?.body));
      const modelData = JSON.parse(modelRequest.contents[0].parts[0].text);
      expect(modelData.sources.at(-1).answerTo.questions).toEqual(pending.questions);
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
        schemaVersion: 2, summary: '참석 인원 확인', questions: [], facts: [{ key: 'participants', label: '참석 인원', value: 4, sourceId: source.id, quote: input.text, operation: 'create', targetFactKey: null, semantic: { kind: 'count', unit: 'person' } }], blocks: [], removedItems: [],
      }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 0, totalTokenCount: 200 } }), { status: 200 });
    });
    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'answer-message', timestamp: new Date(), body: { runId: run.id }, attempts: 1 }]), bindings);
    const ready = await (await request(`/api/workspaces/${view.id}`, 'GET', undefined, cookie)).json() as WorkspaceView;
    expect(ready.pending?.questions).toEqual([]);
    expect(ready.pending?.id).not.toBe(pending.id);
    const result = await request(`/api/workspaces/${view.id}/apply`, 'POST', {
      changeSetId: ready.pending!.id, proposalRevision: ready.pending!.proposalRevision,
      baseRevision: ready.revision, baseSourceRevision: ready.sourceRevision, requestId: crypto.randomUUID(), resolutions: [],
    }, cookie);
    expect(result.status).toBe(200);
    const applied = await result.json() as WorkspaceView;
    expect(applied.snapshot.facts).toContainEqual(expect.objectContaining({ key: 'participants', value: 4 }));
    expect(applied.pending).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
