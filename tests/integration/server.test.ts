/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, createExecutionContext, createMessageBatch, createScheduledController, env, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, type ChangeSet, type ProposalDraft, type Snapshot, type WorkspaceView } from '../../src/core/contracts';
import { createApp } from '../../src/server/app';
import type { CorePort, SampleScenario } from '../../src/server/core-port';
import { WorkspaceStore } from '../../src/server/db';
import worker from '../../src/server/index';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1]; GEMINI_API_KEY?: string };
type TestClient = {
  request(input: RequestInfo | URL, init?: RequestInit, requestEnv?: Cloudflare.Env): Response | Promise<Response>;
};

const core: CorePort = {
  buildChangeSet({ snapshot, draft, baseRevision, baseSourceRevision, id, now }) {
    const next: Snapshot = {
      facts: draft.facts.map((fact, index) => ({
        id: `fact_${fact.key}_${index}`,
        key: fact.key,
        label: fact.label,
        value: fact.value,
        evidence: { sourceId: fact.sourceId, quote: fact.quote, start: 0, end: fact.quote.length },
      })),
      blocks: draft.blocks.map((block, blockIndex) => ({
        id: snapshot.blocks.find((candidate) => candidate.key === block.key)?.id ?? `block_${blockIndex}`,
        key: block.key,
        type: block.type,
        title: block.title,
        items: block.items.map((item, itemIndex) => {
          const existing = snapshot.blocks.flatMap((candidate) => candidate.items).find((candidate) => candidate.key === item.key);
          return {
            id: existing?.id ?? `item_${item.key}_${itemIndex}`,
            key: item.key,
            label: item.label,
            value: item.value,
            factKeys: item.factKeys,
            valueFactKey: item.valueFactKey,
            calculation: item.calculation,
            completed: existing?.completed ?? false,
            locked: existing?.locked ?? false,
            edited: existing?.edited ?? false,
            stale: false,
          };
        }),
      })),
    };
    const lockedItem = snapshot.blocks.flatMap((block) => block.items).find((item) => item.locked && draft.summary.includes('conflict'));
    return {
      id: id ?? 'cs_test',
      baseRevision,
      baseSourceRevision,
      proposalRevision: 1,
      summary: draft.summary,
      questions: draft.questions,
      changes: [],
      conflicts: lockedItem ? [{ id: 'conflict_locked', itemId: lockedItem.id, kind: 'locked', factKey: null, message: 'locked conflict' }] : [],
      next,
      createdAt: now ?? new Date(0).toISOString(),
    };
  },
  resolveChangeSet(changeSet: ChangeSet) {
    return changeSet.next;
  },
  editItem(snapshot, request) {
    return {
      ...snapshot,
      blocks: snapshot.blocks.map((block) => ({
        ...block,
        items: block.items.map((item) => item.id === request.itemId ? {
          ...item,
          label: request.label ?? item.label,
          value: request.value ?? item.value,
          completed: request.completed ?? item.completed,
          locked: request.locked ?? item.locked,
          edited: true,
        } : item),
      })),
    };
  },
};

const sampleDraft = (sourceId: string, summary = 'initial'): ProposalDraft => ({
  summary,
  questions: [],
  facts: [{ key: 'participant_count', label: 'participants', value: 4, sourceId, quote: '4 people' }],
  blocks: [{
    key: 'checklist',
    type: 'checklist',
    title: 'Checklist',
    items: [{ key: 'book_train', label: 'Book train', value: 'Book train tickets', factKeys: [], valueFactKey: null, calculation: null }],
  }],
  removedItems: [],
});

const samples: Record<'travel' | 'syllabus', SampleScenario> = {
  travel: {
    title: 'Travel sample',
    purpose: 'Plan trip',
    initialText: '4 people travel.',
    updateText: '3 people travel.',
    conflictText: 'conflict with locked item.',
    initialDraft: (sourceId) => sampleDraft(sourceId),
    updateDraft: (sourceId) => sampleDraft(sourceId, 'update'),
    conflictDraft: (sourceId) => sampleDraft(sourceId, 'conflict'),
  },
  syllabus: {
    title: 'Syllabus sample',
    purpose: 'Track class',
    initialText: 'Assignment due Friday.',
    updateText: 'Assignment due Monday.',
    conflictText: 'conflict with locked deadline.',
    initialDraft: (sourceId) => sampleDraft(sourceId),
    updateDraft: (sourceId) => sampleDraft(sourceId, 'update'),
    conflictDraft: (sourceId) => sampleDraft(sourceId, 'conflict'),
  },
};

const app = createApp({ core, samples });
const realApp = createApp();

const testEnv = env as TestEnv;

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('persistent workspace API', () => {
  it('reports live unavailable when no API key is configured', async () => {
    const response = await get('/api/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ liveAvailable: false, maxSourceChars: 6000, retentionDays: 7 });
  });

  it('isolates workspaces by anonymous owner cookie', async () => {
    const created = await post('/api/workspaces', { title: 'Owner A', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    expect(created.response.status).toBe(201);

    const ownerAWorkspace = await get(`/api/workspaces/${createdBody.id}`, cookie);
    expect(ownerAWorkspace.status).toBe(200);

    const ownerBWorkspace = await get(`/api/workspaces/${createdBody.id}`);
    expect(ownerBWorkspace.status).toBe(404);
  });

  it('stores source without live run when API key is absent and suppresses duplicate source text', async () => {
    const created = await post('/api/workspaces', { title: 'Sources', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;

    const first = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Initial',
      text: 'four travelers, total fixed cost 900000',
      relation: 'initial',
      targetSourceId: null,
      requestId: '11111111-1111-4111-8111-111111111111',
    }, cookie);
    expect(first.response.status).toBe(200);
    const firstBody = first.body as WorkspaceView;
    expect(firstBody.sources).toHaveLength(1);
    expect(firstBody.runs[0]).toMatchObject({ status: 'failed', mode: 'live' });

    const replay = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Initial',
      text: 'four travelers, total fixed cost 900000',
      relation: 'initial',
      targetSourceId: null,
      requestId: '11111111-1111-4111-8111-111111111111',
    }, cookie);
    expect(replay.body).toEqual(firstBody);

    const conflict = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Changed payload',
      text: 'four travelers, total fixed cost 900000',
      relation: 'initial',
      targetSourceId: null,
      requestId: '11111111-1111-4111-8111-111111111111',
    }, cookie);
    expect(conflict.response.status).toBe(409);

    const duplicateText = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Same text new request',
      text: 'four travelers, total fixed cost 900000',
      relation: 'initial',
      targetSourceId: null,
      requestId: '22222222-2222-4222-8222-222222222222',
    }, cookie);
    const duplicateBody = duplicateText.body as WorkspaceView;
    expect(duplicateBody.sources).toHaveLength(1);
    expect(duplicateBody.sourceRevision).toBe(1);
  });

  it('validates source relation targets against the same workspace', async () => {
    const created = await post('/api/workspaces', { title: 'Relations', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;

    const initial = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Initial',
      text: 'first source',
      relation: 'initial',
      targetSourceId: null,
      requestId: '12121212-1212-4212-8212-121212121212',
    }, cookie);
    expect(initial.response.status).toBe(200);
    const initialBody = initial.body as WorkspaceView;

    const secondInitial = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Second initial',
      text: 'different second source',
      relation: 'initial',
      targetSourceId: null,
      requestId: '13131313-1313-4313-8313-131313131313',
    }, cookie);
    expect(secondInitial.response.status).toBe(422);
    expect(secondInitial.body).toMatchObject({ error: { code: 'BAD_SOURCE_RELATION' } });

    const missingTarget = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Correction without target',
      text: 'correction source',
      relation: 'correction',
      targetSourceId: null,
      requestId: '14141414-1414-4414-8414-141414141414',
    }, cookie);
    expect(missingTarget.response.status).toBe(422);
    expect(missingTarget.body).toMatchObject({ error: { code: 'BAD_SOURCE_RELATION' } });

    const acceptedCorrection = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Correction',
      text: 'correction source',
      relation: 'correction',
      targetSourceId: initialBody.sources[0].id,
      requestId: '15151515-1515-4515-8515-151515151515',
    }, cookie);
    expect(acceptedCorrection.response.status).toBe(200);
    expect((acceptedCorrection.body as WorkspaceView).sources).toHaveLength(2);
  });

  it('rejects stale edits without adding snapshots or idempotency records', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const itemId = createdBody.snapshot.blocks[0].items[0].id;

    const edit = await patch(`/api/workspaces/${createdBody.id}/items`, {
      baseRevision: 1,
      requestId: '33333333-3333-4333-8333-333333333333',
      itemId,
      completed: true,
    }, cookie);
    expect(edit.response.status).toBe(200);
    expect((edit.body as WorkspaceView).revision).toBe(2);

    const stale = await patch(`/api/workspaces/${createdBody.id}/items`, {
      baseRevision: 1,
      requestId: '44444444-4444-4444-8444-444444444444',
      itemId,
      completed: false,
    }, cookie);
    expect(stale.response.status).toBe(409);

    const snapshotCount = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE workspace_id = ?').bind(createdBody.id).first<{ count: number }>();
    const commandCount = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM applied_commands WHERE workspace_id = ?').bind(createdBody.id).first<{ count: number }>();
    expect(snapshotCount?.count).toBe(3);
    expect(commandCount?.count).toBe(1);
  });

  it('rolls back all dependent writes when concurrent edits race on the same revision', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const itemId = createdBody.snapshot.blocks[0].items[0].id;
    const restoreBatch = pauseNextBatches(2);

    const [first, second] = await Promise.all([
      patch(`/api/workspaces/${createdBody.id}/items`, {
        baseRevision: createdBody.revision,
        requestId: '21212121-2121-4121-8121-212121212121',
        itemId,
        value: 'first concurrent edit',
      }, cookie),
      patch(`/api/workspaces/${createdBody.id}/items`, {
        baseRevision: createdBody.revision,
        requestId: '22222222-3333-4222-8222-333333333333',
        itemId,
        value: 'second concurrent edit',
      }, cookie),
    ]);
    restoreBatch();

    expect([first.response.status, second.response.status].sort()).toEqual([200, 409]);
    const counts = await testEnv.DB.prepare('SELECT (SELECT revision FROM workspaces WHERE id = ?) AS revision, (SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?) AS snapshots, (SELECT COUNT(*) FROM applied_commands WHERE workspace_id = ?) AS commands, (SELECT COUNT(*) FROM tx_guards) AS guards')
      .bind(createdBody.id, createdBody.id, createdBody.id)
      .first<{ revision: number; snapshots: number; commands: number; guards: number }>();
    expect(counts).toMatchObject({ revision: 2, snapshots: 3, commands: 1, guards: 0 });
  });

  it('creates fixture pending changes and applies them as a new content revision only', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' }, undefined, realApp);
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const updated = await post(`/api/workspaces/${createdBody.id}/sample-update`, {
      step: 'update',
      requestId: '55555555-5555-4555-8555-555555555555',
    }, cookie, realApp);
    expect(updated.response.status).toBe(200);
    const updatedBody = updated.body as WorkspaceView;
    expect(updatedBody.pending).not.toBeNull();
    expect(updatedBody.runs[0]).toMatchObject({ mode: 'fixture', status: 'ready' });

    const applied = await post(`/api/workspaces/${createdBody.id}/apply`, {
      changeSetId: updatedBody.pending?.id,
      baseRevision: updatedBody.revision,
      baseSourceRevision: updatedBody.sourceRevision,
      proposalRevision: updatedBody.pending?.proposalRevision,
      requestId: '66666666-6666-4666-8666-666666666666',
      resolutions: [],
    }, cookie, realApp);
    expect(applied.response.status).toBe(200);
    const appliedBody = applied.body as WorkspaceView;
    expect(appliedBody.revision).toBe(2);
    expect(appliedBody.sourceRevision).toBe(2);
    expect(appliedBody.pending).toBeNull();
    expect(appliedBody.sources).toHaveLength(2);
    expect(appliedBody.snapshot.blocks.find((block) => block.key === 'travel_cost')?.items[0]?.value).toBe('300000');
  });

  it('marks only the applied proposal run as applied after a later proposal supersedes an earlier one', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' }, undefined, realApp);
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const first = await post(`/api/workspaces/${workspace.id}/sample-update`, {
      step: 'update',
      requestId: '25252525-2525-4525-8525-252525252525',
    }, cookie, realApp);
    expect(first.response.status).toBe(200);
    const firstView = first.body as WorkspaceView;
    const firstRunId = firstView.runs[0].id;
    expect(firstView.runs[0]).toMatchObject({ status: 'ready' });

    const second = await post(`/api/workspaces/${workspace.id}/sample-update`, {
      step: 'conflict',
      requestId: '26262626-2626-4626-8626-262626262626',
    }, cookie, realApp);
    expect(second.response.status).toBe(200);
    const secondView = second.body as WorkspaceView;
    const secondRunId = secondView.runs[0].id;
    expect(secondView.pending?.id).not.toBe(firstView.pending?.id);
    expect(secondView.runs.find((run) => run.id === firstRunId)).toMatchObject({
      status: 'failed',
      error: '새 제안으로 대체되어 이 실행 결과는 적용되지 않았습니다.',
    });

    const applied = await post(`/api/workspaces/${workspace.id}/apply`, {
      changeSetId: secondView.pending?.id,
      baseRevision: secondView.revision,
      baseSourceRevision: secondView.sourceRevision,
      proposalRevision: secondView.pending?.proposalRevision,
      requestId: '27272727-2727-4727-8727-272727272727',
      resolutions: [],
    }, cookie, realApp);
    expect(applied.response.status).toBe(200);
    const appliedView = applied.body as WorkspaceView;
    expect(appliedView.pending).toBeNull();
    expect(appliedView.runs.find((run) => run.id === secondRunId)).toMatchObject({ status: 'applied' });
    expect(appliedView.runs.find((run) => run.id === firstRunId)).toMatchObject({ status: 'failed' });

    const dbRuns = await testEnv.DB.prepare('SELECT id, status, changeset_id FROM runs WHERE workspace_id = ? ORDER BY created_at DESC')
      .bind(workspace.id)
      .all<{ id: string; status: string; changeset_id: string | null }>();
    const rows = dbRuns.results ?? [];
    expect(rows.find((run) => run.id === secondRunId)).toMatchObject({ status: 'applied', changeset_id: secondView.pending?.id });
    expect(rows.find((run) => run.id === firstRunId)).toMatchObject({ status: 'failed', changeset_id: firstView.pending?.id });
  });

  it('rejects apply when a pending changeset still has questions', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    await testEnv.DB.prepare('UPDATE workspaces SET pending_changeset_json = ?, pending_proposal_revision = 1 WHERE id = ?')
      .bind(JSON.stringify({
        id: 'cs_questions',
        baseRevision: createdBody.revision,
        baseSourceRevision: createdBody.sourceRevision,
        proposalRevision: 1,
        summary: 'needs answer',
        questions: ['어느 시간을 기준으로 할까요?'],
        changes: [],
        conflicts: [],
        next: createdBody.snapshot,
        createdAt: new Date(0).toISOString(),
      } satisfies ChangeSet), createdBody.id)
      .run();

    const response = await post(`/api/workspaces/${createdBody.id}/apply`, {
      changeSetId: 'cs_questions',
      baseRevision: createdBody.revision,
      baseSourceRevision: createdBody.sourceRevision,
      proposalRevision: 1,
      requestId: '77777777-7777-4777-8777-777777777777',
      resolutions: [],
    }, cookie);
    expect(response.response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { code: 'UNANSWERED_QUESTIONS' } });
  });

  it('does not enqueue or reserve when daily budget is already exhausted', async () => {
    const created = await post('/api/workspaces', { title: 'Budget', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const owner = await ownerFromCookie(cookie);
    await testEnv.DB.prepare(
      'INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES (?, ?, ?, ?, "reserve", ?, ?)',
    ).bind('ledger_existing', owner.id, createdBody.id, 'existing_run', 495000, new Date().toISOString()).run();
    const send = vi.spyOn(testEnv.RUN_QUEUE, 'send');

    const response = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Over budget',
      text: 'source that would need model',
      relation: 'initial',
      targetSourceId: null,
      requestId: '88888888-8888-4888-8888-888888888888',
    }, cookie, appWithLiveKey());

    expect(response.response.status).toBe(429);
    expect(response.body).toMatchObject({ error: { code: 'DAILY_BUDGET_EXCEEDED' } });
    expect(send).not.toHaveBeenCalled();
    const counts = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM sources WHERE workspace_id = ?) AS sources, (SELECT COUNT(*) FROM runs WHERE workspace_id = ?) AS runs')
      .bind(createdBody.id, createdBody.id)
      .first<{ sources: number; runs: number }>();
    expect(counts).toMatchObject({ sources: 0, runs: 0 });
  });

  it('enforces daily reserve budget globally across owners', async () => {
    const ownerA = await post('/api/workspaces', { title: 'Owner A budget', purpose: 'Plan travel' });
    const ownerACookie = cookieFrom(ownerA.response);
    const ownerABody = ownerA.body as WorkspaceView;
    const ownerAId = await ownerFromCookie(ownerACookie);
    await testEnv.DB.prepare(
      'INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES (?, ?, ?, ?, "reserve", ?, ?)',
    ).bind('ledger_global_existing', ownerAId.id, ownerABody.id, 'existing_global_run', 495000, new Date().toISOString()).run();

    const ownerB = await post('/api/workspaces', { title: 'Owner B budget', purpose: 'Plan travel' });
    const ownerBCookie = cookieFrom(ownerB.response);
    const ownerBBody = ownerB.body as WorkspaceView;
    const send = vi.spyOn(testEnv.RUN_QUEUE, 'send');

    const response = await post(`/api/workspaces/${ownerBBody.id}/sources`, {
      title: 'Blocked globally',
      text: 'source that would cross global daily budget',
      relation: 'initial',
      targetSourceId: null,
      requestId: '16161616-1616-4616-8616-161616161616',
    }, ownerBCookie, appWithLiveKey());

    expect(response.response.status).toBe(429);
    expect(response.body).toMatchObject({ error: { code: 'DAILY_BUDGET_EXCEEDED' } });
    expect(send).not.toHaveBeenCalled();
    const counts = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM sources WHERE workspace_id = ?) AS sources, (SELECT COUNT(*) FROM runs WHERE workspace_id = ?) AS runs, (SELECT COUNT(*) FROM budget_ledger WHERE workspace_id = ?) AS ledgers')
      .bind(ownerBBody.id, ownerBBody.id, ownerBBody.id)
      .first<{ sources: number; runs: number; ledgers: number }>();
    expect(counts).toMatchObject({ sources: 0, runs: 0, ledgers: 0 });
  });

  it('rolls back source and run writes when concurrent owners race for the final global budget slot', async () => {
    const ownerA = await post('/api/workspaces', { title: 'Budget race A', purpose: 'Plan travel' });
    const ownerACookie = cookieFrom(ownerA.response);
    const ownerABody = ownerA.body as WorkspaceView;
    const ownerB = await post('/api/workspaces', { title: 'Budget race B', purpose: 'Plan travel' });
    const ownerBCookie = cookieFrom(ownerB.response);
    const ownerBBody = ownerB.body as WorkspaceView;
    const client = appWithEnv({ GEMINI_API_KEY: 'test-key', DAILY_BUDGET_MICRO_USD: String(LIMITS.reserveMicroUsd) });
    const send = vi.spyOn(testEnv.RUN_QUEUE, 'send');
    const restoreBatch = pauseNextBatches(2);

    const [first, second] = await Promise.all([
      post(`/api/workspaces/${ownerABody.id}/sources`, {
        title: 'Budget race A source',
        text: 'budget race source A',
        relation: 'initial',
        targetSourceId: null,
        requestId: '23232323-2323-4323-8323-232323232323',
      }, ownerACookie, client),
      post(`/api/workspaces/${ownerBBody.id}/sources`, {
        title: 'Budget race B source',
        text: 'budget race source B',
        relation: 'initial',
        targetSourceId: null,
        requestId: '24242424-2424-4424-8424-242424242424',
      }, ownerBCookie, client),
    ]);
    restoreBatch();

    expect([first.response.status, second.response.status].sort()).toEqual([200, 409]);
    expect(send).toHaveBeenCalledTimes(1);
    const counts = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM runs WHERE status = "pending") AS pendingRuns, (SELECT COUNT(*) FROM budget_ledger WHERE entry_type = "reserve") AS reserves, (SELECT COUNT(*) FROM tx_guards) AS guards')
      .first<{ sources: number; pendingRuns: number; reserves: number; guards: number }>();
    expect(counts).toMatchObject({ sources: 1, pendingRuns: 1, reserves: 1, guards: 0 });
  });

  it('keeps stale model completion from publishing a pending changeset', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const owner = await ownerFromCookie(cookie);
    const store = new WorkspaceStore(testEnv);
    const requestId = 'run-stale-request';
    const payloadHash = 'hash';
    const updatedAt = new Date().toISOString();
    const run: Parameters<WorkspaceStore['completeRun']>[0] = {
      id: 'run_stale_complete',
      workspace_id: createdBody.id,
      owner_id: owner.id,
      source_id: createdBody.sources[0].id,
      status: 'running',
      mode: 'live',
      error: null,
      base_revision: createdBody.revision,
      base_source_revision: createdBody.sourceRevision,
      retry_count: 0,
      changeset_id: null,
      reserved_micro_usd: 11192,
      actual_micro_usd: null,
      created_at: new Date().toISOString(),
      updated_at: updatedAt,
    };
    await testEnv.DB.prepare(
      'INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, error, request_id, payload_hash, base_revision, base_source_revision, retry_count, reserved_micro_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(run.id, run.workspace_id, run.owner_id, run.source_id, run.status, run.mode, requestId, payloadHash, run.base_revision, run.base_source_revision, run.retry_count, run.reserved_micro_usd, run.created_at, updatedAt).run();

    await patch(`/api/workspaces/${createdBody.id}/items`, {
      baseRevision: createdBody.revision,
      requestId: '99999999-9999-4999-8999-999999999999',
      itemId: createdBody.snapshot.blocks[0].items[0].id,
      value: 'manual change',
    }, cookie);

    const outcome = await store.completeRun(run, {
      id: 'cs_stale',
      baseRevision: createdBody.revision,
      baseSourceRevision: createdBody.sourceRevision,
      proposalRevision: 1,
      summary: 'stale',
      questions: [],
      changes: [],
      conflicts: [],
      next: createdBody.snapshot,
      createdAt: new Date().toISOString(),
    }, 42);

    const workspace = await get(`/api/workspaces/${createdBody.id}`, cookie);
    const body = await workspace.json() as WorkspaceView;
    expect(body.pending).toBeNull();
    const runRow = await testEnv.DB.prepare('SELECT status, error FROM runs WHERE id = ?').bind(run.id).first<{ status: string; error: string }>();
    expect(runRow).toMatchObject({ status: 'failed', error: '작업 공간이 실행 중 변경되어 제안을 폐기했습니다.' });
    expect(outcome).toMatchObject({ outcome: 'discarded', status: 'failed', changesetId: null, reservedMicroUsd: run.reserved_micro_usd, actualMicroUsd: null });
    const actualLedger = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM budget_ledger WHERE run_id = ? AND entry_type = "actual"').bind(run.id).first<{ count: number }>();
    expect(actualLedger?.count).toBe(0);
  });

  it('pins run context to the run source revision', async () => {
    const created = await post('/api/workspaces', { title: 'Pinned sources', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const sourceResponse = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Initial',
      text: 'first live source',
      relation: 'initial',
      targetSourceId: null,
      requestId: '17171717-1717-4717-8717-171717171717',
    }, cookie, appWithLiveKey());
    const view = sourceResponse.body as WorkspaceView;
    const runRow = await testEnv.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(view.runs[0].id).first<Parameters<WorkspaceStore['runContext']>[0]>();
    expect(runRow).toBeTruthy();
    await testEnv.DB.prepare(
      'INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at) VALUES (?, ?, 2, ?, "addition", NULL, ?, ?, ?)',
    ).bind('src_late', createdBody.id, 'Late', 'late_hash', 'late source should not be visible', new Date().toISOString()).run();

    const context = await new WorkspaceStore(testEnv).runContext(runRow as Parameters<WorkspaceStore['runContext']>[0]);
    expect(context.sources.map((source) => source.id)).toEqual([view.sources[0].id]);
  });

  it('queue handler claims once and stores a ready proposal from mocked Gemini HTTP', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const prompt = await geminiPrompt(input, init);
      const source = prompt.sources[0];
      return geminiResponse(sampleDraftPlaceholder(source.id, source.text));
    });
    const created = await post('/api/workspaces', { title: 'Queue', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;

    const sourced = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Model source',
      text: 'model source',
      relation: 'initial',
      targetSourceId: null,
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }, cookie, appWithLiveKey());
    const sourceBody = sourced.body as WorkspaceView;
    const runId = sourceBody.runs[0]?.id;
    expect(sourceBody.runs[0]).toMatchObject({ status: 'pending', mode: 'live' });

    const batch = createMessageBatch('ieojim-runs', [{ id: 'msg1', timestamp: new Date(), body: { runId }, attempts: 1 }]);
    await worker.queue?.(batch, liveEnv());
    const afterFirst = await get(`/api/workspaces/${createdBody.id}`, cookie);
    const firstBody = await afterFirst.json() as WorkspaceView;
    expect(firstBody.pending?.summary).toBe('initial');
    expect(firstBody.runs[0]).toMatchObject({ status: 'ready', costMicroUsd: 15 });

    const duplicateBatch = createMessageBatch('ieojim-runs', [{ id: 'msg2', timestamp: new Date(), body: { runId }, attempts: 2 }]);
    await worker.queue?.(duplicateBatch, liveEnv());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs sanitized run lifecycle events with accurate cost and completion outcomes', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const prompt = await geminiPrompt(input, init);
      const source = prompt.sources[0];
      return geminiResponse(sampleDraftPlaceholder(source.id, source.text), 'resp_sensitive_model_response_id');
    });
    const created = await post('/api/workspaces', { title: 'Lifecycle logs', purpose: 'secret planning purpose' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const sourced = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Secret source',
      text: 'source secret text that must not be logged',
      relation: 'initial',
      targetSourceId: null,
      requestId: '39393939-3939-4939-8939-393939393939',
    }, cookie, appWithLiveKey());
    const runId = (sourced.body as WorkspaceView).runs[0].id;

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-log-1', timestamp: new Date(), body: { runId }, attempts: 1 }]), liveEnv());
    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-log-2', timestamp: new Date(), body: { runId }, attempts: 2 }]), liveEnv());

    const serializedLogs = info.mock.calls.map(([entry]) => String(entry));
    const events = serializedLogs.map((entry) => JSON.parse(entry) as Record<string, unknown>);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'run_lifecycle', runId, workspaceId: workspace.id, status: 'running', outcome: 'claimed', reservedMicroUsd: LIMITS.reserveMicroUsd, actualMicroUsd: null }),
      expect.objectContaining({ event: 'run_lifecycle', runId, workspaceId: workspace.id, status: 'ready', outcome: 'published', reservedMicroUsd: LIMITS.reserveMicroUsd, actualMicroUsd: 15, costSource: 'usage_reported', inputTokens: 4, outputTokens: 3 }),
      expect.objectContaining({ event: 'run_lifecycle', runId, status: 'skipped', outcome: 'skipped' }),
    ]));
    expect(events.find((event) => event.outcome === 'published')).toHaveProperty('changesetId');
    for (const entry of serializedLogs) {
      expect(entry).not.toContain('source secret text');
      expect(entry).not.toContain('secret planning purpose');
      expect(entry).not.toContain('test-key');
      expect(entry).not.toContain('resp_sensitive_model_response');
    }
  });

  it('logs reserve fallback when model token usage is unavailable', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const prompt = await geminiPrompt(input, init);
      const source = prompt.sources[0];
      const responseBody = {
        responseId: 'resp_without_usage',
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(sampleDraftPlaceholder(source.id, source.text)) }] }, finishReason: 'STOP' }],
      };
      return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const created = await post('/api/workspaces', { title: 'Fallback cost logs', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const sourced = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Model source',
      text: 'model source without usage',
      relation: 'initial',
      targetSourceId: null,
      requestId: '40404040-4040-4040-8040-404040404040',
    }, cookie, appWithLiveKey());
    const runId = (sourced.body as WorkspaceView).runs[0].id;

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-fallback-cost', timestamp: new Date(), body: { runId }, attempts: 1 }]), liveEnv());

    const published = info.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .find((event) => event.event === 'run_lifecycle' && event.outcome === 'published');
    expect(published).toMatchObject({
      runId,
      actualMicroUsd: LIMITS.reserveMicroUsd,
      costSource: 'reserve_fallback',
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('logs and retains under-reserve usage when model output is invalid', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const usageMetadata = { promptTokenCount: 6, candidatesTokenCount: 2, thoughtsTokenCount: 0, totalTokenCount: 8 };
    const observedCost = Math.ceil(usageMetadata.promptTokenCount * 0.75 + (usageMetadata.candidatesTokenCount + usageMetadata.thoughtsTokenCount) * 3.75);
    expect(observedCost).toBeLessThan(LIMITS.reserveMicroUsd);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      responseId: 'resp_invalid_under_reserve',
      candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      usageMetadata,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const created = await post('/api/workspaces', { title: 'Invalid under reserve', purpose: 'private purpose should not log' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const sourced = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Invalid source',
      text: 'private invalid source text should not log',
      relation: 'initial',
      targetSourceId: null,
      requestId: '41414141-4141-4141-8141-414141414141',
    }, cookie, appWithLiveKey());
    const runId = (sourced.body as WorkspaceView).runs[0].id;

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-invalid-under-reserve', timestamp: new Date(), body: { runId }, attempts: 1 }]), liveEnv());

    const run = await testEnv.DB.prepare('SELECT status, actual_micro_usd FROM runs WHERE id = ?').bind(runId).first<{ status: string; actual_micro_usd: number | null }>();
    expect(run).toMatchObject({ status: 'failed', actual_micro_usd: observedCost });
    const actualLedger = await testEnv.DB.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_micro_usd), 0) AS amount FROM budget_ledger WHERE run_id = ? AND entry_type = "actual"')
      .bind(runId)
      .first<{ count: number; amount: number }>();
    expect(actualLedger).toMatchObject({ count: 1, amount: observedCost });
    const failed = info.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes('"outcome":"failed"'));
    expect(failed).toBeTruthy();
    expect(JSON.parse(failed ?? '{}')).toMatchObject({
      runId,
      actualMicroUsd: observedCost,
      costSource: 'usage_reported',
      inputTokens: usageMetadata.promptTokenCount,
      outputTokens: usageMetadata.totalTokenCount - usageMetadata.promptTokenCount,
    });
    for (const entry of info.mock.calls.map(([value]) => String(value))) {
      expect(entry).not.toContain('private invalid source text');
      expect(entry).not.toContain('private purpose should not log');
      expect(entry).not.toContain('test-key');
      expect(entry).not.toContain('resp_invalid_under_reserve');
    }
  });

  it('logs observed usage when generation is discarded after a stale workspace change', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const usageMetadata = { promptTokenCount: 8, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 12 };
    const observedCost = Math.ceil(usageMetadata.promptTokenCount * 0.75 + (usageMetadata.candidatesTokenCount + usageMetadata.thoughtsTokenCount) * 3.75);
    let workspaceId = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const prompt = await geminiPrompt(input, init);
      const source = prompt.sources[0];
      await testEnv.DB.prepare('UPDATE workspaces SET revision = revision + 1 WHERE id = ?').bind(workspaceId).run();
      return geminiResponse(sampleDraftPlaceholder(source.id, source.text), 'resp_stale_after_generation', usageMetadata);
    });
    const created = await post('/api/workspaces', { title: 'Stale after generation', purpose: 'private stale purpose' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    workspaceId = workspace.id;
    const sourced = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Stale source',
      text: 'private stale source text',
      relation: 'initial',
      targetSourceId: null,
      requestId: '42424242-4242-4242-8242-424242424242',
    }, cookie, appWithLiveKey());
    const runId = (sourced.body as WorkspaceView).runs[0].id;

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-stale-after-generation', timestamp: new Date(), body: { runId }, attempts: 1 }]), liveEnv());

    const run = await testEnv.DB.prepare('SELECT status, actual_micro_usd FROM runs WHERE id = ?').bind(runId).first<{ status: string; actual_micro_usd: number | null }>();
    expect(run).toMatchObject({ status: 'failed', actual_micro_usd: observedCost });
    const actualLedger = await testEnv.DB.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_micro_usd), 0) AS amount FROM budget_ledger WHERE run_id = ? AND entry_type = "actual"')
      .bind(runId)
      .first<{ count: number; amount: number }>();
    expect(actualLedger).toMatchObject({ count: 1, amount: observedCost });
    const discarded = info.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes('"outcome":"discarded"'));
    expect(discarded).toBeTruthy();
    expect(JSON.parse(discarded ?? '{}')).toMatchObject({
      runId,
      actualMicroUsd: observedCost,
      costSource: 'usage_reported',
      inputTokens: usageMetadata.promptTokenCount,
      outputTokens: usageMetadata.totalTokenCount - usageMetadata.promptTokenCount,
    });
    for (const entry of info.mock.calls.map(([value]) => String(value))) {
      expect(entry).not.toContain('private stale source text');
      expect(entry).not.toContain('private stale purpose');
      expect(entry).not.toContain('test-key');
      expect(entry).not.toContain('resp_stale_after_generation');
    }
  });

  it('ignores a late completion for a run that is already ready without duplicating actual ledger', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const prompt = await geminiPrompt(input, init);
      const source = prompt.sources[0];
      return geminiResponse(sampleDraftPlaceholder(source.id, source.text));
    });
    const created = await post('/api/workspaces', { title: 'Late completion', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const sourced = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Model source',
      text: 'late completion source',
      relation: 'initial',
      targetSourceId: null,
      requestId: '28282828-2828-4828-8828-282828282828',
    }, cookie, appWithLiveKey());
    const runId = (sourced.body as WorkspaceView).runs[0].id;

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-late-1', timestamp: new Date(), body: { runId }, attempts: 1 }]), liveEnv());
    const readyRun = await testEnv.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<Parameters<WorkspaceStore['completeRun']>[0]>();
    expect(readyRun?.status).toBe('ready');
    const pendingBefore = await testEnv.DB.prepare('SELECT pending_changeset_json FROM workspaces WHERE id = ?').bind(workspace.id).first<{ pending_changeset_json: string }>();
    const ledgerBefore = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM budget_ledger WHERE run_id = ? AND entry_type = "actual"').bind(runId).first<{ count: number }>();
    expect(ledgerBefore?.count).toBe(1);

    const outcome = await new WorkspaceStore(testEnv).completeRun(readyRun as Parameters<WorkspaceStore['completeRun']>[0], {
      id: 'cs_late_duplicate',
      baseRevision: workspace.revision,
      baseSourceRevision: (sourced.body as WorkspaceView).sourceRevision,
      proposalRevision: 99,
      summary: 'late duplicate must not publish',
      questions: [],
      changes: [],
      conflicts: [],
      next: workspace.snapshot,
      createdAt: new Date().toISOString(),
    }, 99);

    const after = await testEnv.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>();
    const pendingAfter = await testEnv.DB.prepare('SELECT pending_changeset_json FROM workspaces WHERE id = ?').bind(workspace.id).first<{ pending_changeset_json: string }>();
    const ledgerAfter = await testEnv.DB.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_micro_usd), 0) AS amount FROM budget_ledger WHERE run_id = ? AND entry_type = "actual"').bind(runId).first<{ count: number; amount: number }>();
    expect(after?.status).toBe('ready');
    expect(outcome).toMatchObject({ outcome: 'ignored', status: 'ready', changesetId: readyRun?.changeset_id, reservedMicroUsd: LIMITS.reserveMicroUsd, actualMicroUsd: 15 });
    expect(pendingAfter?.pending_changeset_json).toBe(pendingBefore?.pending_changeset_json);
    expect(ledgerAfter).toMatchObject({ count: 1, amount: 15 });
  });

  it('queue handler records a known validation failure without pending changes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      responseId: 'resp_failed',
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const created = await post('/api/workspaces', { title: 'Queue error', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const sourced = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Model source',
      text: 'model source',
      relation: 'initial',
      targetSourceId: null,
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }, cookie, appWithLiveKey());
    const runId = (sourced.body as WorkspaceView).runs[0]?.id;

    const batch = createMessageBatch('ieojim-runs', [{ id: 'msg3', timestamp: new Date(), body: { runId }, attempts: 1 }]);
    await worker.queue?.(batch, liveEnv());

    const after = await get(`/api/workspaces/${createdBody.id}`, cookie);
    const body = await after.json() as WorkspaceView;
    expect(body.pending).toBeNull();
    expect(body.runs[0]).toMatchObject({ status: 'failed', error: 'AI가 만든 변경안의 근거나 계산을 확인하지 못해 적용하지 않았어요. 기존 내용은 그대로예요.' });
  });

  it('queue handler stops before paid HTTP when the run base is stale', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(geminiResponse(sampleDraftPlaceholder('unused', 'unused')));
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const sourced = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Live update',
      text: 'model source',
      relation: 'addition',
      targetSourceId: null,
      requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    }, cookie, appWithLiveKey());
    const sourceBody = sourced.body as WorkspaceView;
    await patch(`/api/workspaces/${createdBody.id}/items`, {
      baseRevision: createdBody.revision,
      requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      itemId: createdBody.snapshot.blocks[0].items[0].id,
      value: 'manual before queue',
    }, cookie);

    const batch = createMessageBatch('ieojim-runs', [{ id: 'msg4', timestamp: new Date(), body: { runId: sourceBody.runs[0]?.id }, attempts: 1 }]);
    await worker.queue?.(batch, liveEnv());

    expect(fetchMock).not.toHaveBeenCalled();
    const runRow = await testEnv.DB.prepare('SELECT status, error FROM runs WHERE id = ?').bind(sourceBody.runs[0]?.id).first<{ status: string; error: string }>();
    expect(runRow).toMatchObject({ status: 'failed', error: '작업 공간이 실행 전 변경되어 모델 호출을 중단했습니다.' });
  });

  it('queue handler stops before paid HTTP when an old run reservation is below the current model reserve', async () => {
    expect(LIMITS.reserveMicroUsd).toBeGreaterThan(11192);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(geminiResponse(sampleDraftPlaceholder('unused', 'unused')));
    const created = await post('/api/workspaces', { title: 'Old reservation', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const sourced = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Old reserved source',
      text: 'old reservation should not reach model',
      relation: 'initial',
      targetSourceId: null,
      requestId: '56565656-5656-4656-8656-565656565656',
    }, cookie, appWithLiveKey());
    const runId = (sourced.body as WorkspaceView).runs[0]?.id;
    await testEnv.DB.prepare('UPDATE runs SET reserved_micro_usd = ? WHERE id = ?').bind(11192, runId).run();

    const batch = createMessageBatch('ieojim-runs', [{ id: 'msg-old-reservation', timestamp: new Date(), body: { runId }, attempts: 1 }]);
    await worker.queue?.(batch, liveEnv());

    expect(fetchMock).not.toHaveBeenCalled();
    const runRow = await testEnv.DB.prepare('SELECT status, error, reserved_micro_usd FROM runs WHERE id = ?').bind(runId).first<{ status: string; error: string; reserved_micro_usd: number }>();
    expect(runRow).toMatchObject({ status: 'failed', reserved_micro_usd: 11192 });
    expect(runRow?.error).toContain('예약');
  });

  it('records over-reserve model usage as a global policy violation and blocks queued and future live calls', async () => {
    const overReserveUsage = {
      promptTokenCount: LIMITS.inputTokens,
      candidatesTokenCount: LIMITS.outputTokens + 1,
      thoughtsTokenCount: 0,
      totalTokenCount: LIMITS.inputTokens + LIMITS.outputTokens + 1,
    };
    const overReserveCost = Math.ceil(overReserveUsage.promptTokenCount * 0.75 + (overReserveUsage.candidatesTokenCount + overReserveUsage.thoughtsTokenCount) * 3.75);
    expect(overReserveCost).toBeGreaterThan(LIMITS.reserveMicroUsd);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const prompt = await geminiPrompt(input, init);
      const source = prompt.sources[0];
      return geminiResponse(sampleDraftPlaceholder(source.id, source.text), 'resp_over_reserve', overReserveUsage);
    });
    const send = vi.spyOn(testEnv.RUN_QUEUE, 'send');
    const created = await post('/api/workspaces', { title: 'Policy tripwire', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const first = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'First queued',
      text: 'first queued source',
      relation: 'initial',
      targetSourceId: null,
      requestId: '57575757-5757-4757-8757-575757575757',
    }, cookie, appWithLiveKey());
    const firstRunId = (first.body as WorkspaceView).runs[0].id;
    const otherCreated = await post('/api/workspaces', { title: 'Already queued', purpose: 'Plan travel' });
    const otherCookie = cookieFrom(otherCreated.response);
    const otherWorkspace = otherCreated.body as WorkspaceView;
    const second = await post(`/api/workspaces/${otherWorkspace.id}/sources`, {
      title: 'Second queued',
      text: 'second queued source',
      relation: 'initial',
      targetSourceId: null,
      requestId: '58585858-5858-4858-8858-585858585858',
    }, otherCookie, appWithLiveKey());
    const secondRunId = (second.body as WorkspaceView).runs[0].id;

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-over-reserve', timestamp: new Date(), body: { runId: firstRunId }, attempts: 1 }]), liveEnv());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstRun = await testEnv.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(firstRunId).first<Parameters<WorkspaceStore['recordModelUsage']>[0]>();
    expect(firstRun).toMatchObject({ status: 'failed', actual_micro_usd: overReserveCost, reserved_micro_usd: LIMITS.reserveMicroUsd });
    const violation = await testEnv.DB.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_micro_usd), 0) AS amount FROM budget_ledger WHERE run_id = ? AND entry_type = "policy_violation"')
      .bind(firstRunId)
      .first<{ count: number; amount: number }>();
    expect(violation).toMatchObject({ count: 1, amount: overReserveCost });
    const actualLedger = await testEnv.DB.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_micro_usd), 0) AS amount FROM budget_ledger WHERE run_id = ? AND entry_type = "actual"')
      .bind(firstRunId)
      .first<{ count: number; amount: number }>();
    expect(actualLedger).toMatchObject({ count: 1, amount: overReserveCost });

    const store = new WorkspaceStore(testEnv);
    await store.recordModelUsage(firstRun as Parameters<WorkspaceStore['recordModelUsage']>[0], { inputTokens: overReserveUsage.promptTokenCount, outputTokens: overReserveUsage.candidatesTokenCount, costMicroUsd: overReserveCost });
    const afterDuplicate = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ? AND entry_type = "policy_violation") AS violations, (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ? AND entry_type = "actual") AS actuals')
      .bind(firstRunId, firstRunId)
      .first<{ violations: number; actuals: number }>();
    expect(afterDuplicate).toMatchObject({ violations: 1, actuals: 1 });

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-after-policy', timestamp: new Date(), body: { runId: secondRunId }, attempts: 1 }]), liveEnv());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const secondRun = await testEnv.DB.prepare('SELECT status, error FROM runs WHERE id = ?').bind(secondRunId).first<{ status: string; error: string }>();
    expect(secondRun).toMatchObject({ status: 'failed' });
    expect(secondRun?.error).toContain('비용 정책 위반');

    const blocked = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Blocked after tripwire',
      text: 'new source after policy violation',
      relation: 'addition',
      targetSourceId: null,
      requestId: '59595959-5959-4959-8959-595959595959',
    }, cookie, appWithLiveKey());
    expect(blocked.response.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: { code: 'MODEL_BUDGET_POLICY_VIOLATION' } });
    expect(send).toHaveBeenCalledTimes(2);

    const deleted = await app.request(`http://local.test/api/workspaces/${workspace.id}`, {
      method: 'DELETE',
      headers: jsonHeaders(cookie),
    }, testEnv);
    expect(deleted.status).toBe(204);
    const retainedViolation = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM budget_ledger WHERE run_id = ? AND entry_type = "policy_violation"')
      .bind(firstRunId)
      .first<{ count: number }>();
    expect(retainedViolation?.count).toBe(1);
  });

  it('records over-reserve usage even when the model proposal fails validation', async () => {
    const overReserveUsage = {
      promptTokenCount: LIMITS.inputTokens,
      candidatesTokenCount: LIMITS.outputTokens + 1,
      thoughtsTokenCount: 0,
      totalTokenCount: LIMITS.inputTokens + LIMITS.outputTokens + 1,
    };
    const overReserveCost = Math.ceil(overReserveUsage.promptTokenCount * 0.75 + (overReserveUsage.candidatesTokenCount + overReserveUsage.thoughtsTokenCount) * 3.75);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      responseId: 'resp_invalid_over_reserve',
      candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      usageMetadata: overReserveUsage,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const created = await post('/api/workspaces', { title: 'Invalid over reserve', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const sourced = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Invalid output source',
      text: 'invalid output should still record observed usage',
      relation: 'initial',
      targetSourceId: null,
      requestId: '60606060-6060-4060-8060-606060606060',
    }, cookie, appWithLiveKey());
    const runId = (sourced.body as WorkspaceView).runs[0].id;

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-invalid-over-reserve', timestamp: new Date(), body: { runId }, attempts: 1 }]), liveEnv());

    const run = await testEnv.DB.prepare('SELECT status, error, actual_micro_usd FROM runs WHERE id = ?').bind(runId).first<{ status: string; error: string; actual_micro_usd: number | null }>();
    expect(run).toMatchObject({ status: 'failed', actual_micro_usd: overReserveCost });
    expect(run?.error).toContain('비용 정책 위반');
    const violation = await testEnv.DB.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_micro_usd), 0) AS amount FROM budget_ledger WHERE run_id = ? AND entry_type = "policy_violation"')
      .bind(runId)
      .first<{ count: number; amount: number }>();
    expect(violation).toMatchObject({ count: 1, amount: overReserveCost });
    const actual = await testEnv.DB.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_micro_usd), 0) AS amount FROM budget_ledger WHERE run_id = ? AND entry_type = "actual"')
      .bind(runId)
      .first<{ count: number; amount: number }>();
    expect(actual).toMatchObject({ count: 1, amount: overReserveCost });
    const after = await get(`/api/workspaces/${workspace.id}`, cookie);
    expect((await after.json() as WorkspaceView).pending).toBeNull();
  });

  it('allows only one explicit retry for the original run under concurrent requests', async () => {
    const created = await post('/api/workspaces', { title: 'Retry', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const sourceResponse = await post(`/api/workspaces/${createdBody.id}/sources`, {
      title: 'Initial',
      text: 'retry source',
      relation: 'initial',
      targetSourceId: null,
      requestId: '18181818-1818-4818-8818-181818181818',
    }, cookie);
    const failedRunId = (sourceResponse.body as WorkspaceView).runs[0].id;

    const [first, second] = await Promise.all([
      post(`/api/workspaces/${createdBody.id}/retry`, {
        runId: failedRunId,
        requestId: '19191919-1919-4919-8919-191919191919',
      }, cookie, appWithLiveKey()),
      post(`/api/workspaces/${createdBody.id}/retry`, {
        runId: failedRunId,
        requestId: '20202020-2020-4020-8020-202020202020',
      }, cookie, appWithLiveKey()),
    ]);

    expect([first.response.status, second.response.status].sort()).toEqual([200, 409]);
    const retryCount = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM runs WHERE retry_of_run_id = ?').bind(failedRunId).first<{ count: number }>();
    expect(retryCount?.count).toBe(1);
  });

  it('does not consume retry when live AI is unavailable and allows retry after the key is configured', async () => {
    const created = await post('/api/workspaces', { title: 'Retry key', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const sourceResponse = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Initial',
      text: 'retry once key is configured',
      relation: 'initial',
      targetSourceId: null,
      requestId: '30303030-3030-4030-8030-303030303030',
    }, cookie);
    const failedRunId = (sourceResponse.body as WorkspaceView).runs[0].id;
    const send = vi.spyOn(testEnv.RUN_QUEUE, 'send');

    const unavailable = await post(`/api/workspaces/${workspace.id}/retry`, {
      runId: failedRunId,
      requestId: '31313131-3131-4131-8131-313131313131',
    }, cookie);

    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body).toMatchObject({ error: { code: 'MODEL_UNAVAILABLE' } });
    expect(send).not.toHaveBeenCalled();
    const afterUnavailable = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM runs WHERE retry_of_run_id = ?) AS childRuns, (SELECT COUNT(*) FROM budget_ledger WHERE workspace_id = ?) AS ledgers, (SELECT COUNT(*) FROM applied_commands WHERE workspace_id = ? AND command_type = "retry_run") AS commands')
      .bind(failedRunId, workspace.id, workspace.id)
      .first<{ childRuns: number; ledgers: number; commands: number }>();
    expect(afterUnavailable).toMatchObject({ childRuns: 0, ledgers: 0, commands: 0 });

    const retry = await post(`/api/workspaces/${workspace.id}/retry`, {
      runId: failedRunId,
      requestId: '32323232-3232-4232-8232-323232323232',
    }, cookie, appWithLiveKey());

    expect(retry.response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const afterRetry = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM runs WHERE retry_of_run_id = ?')
      .bind(failedRunId)
      .first<{ count: number }>();
    expect(afterRetry?.count).toBe(1);
  });

  it('does not create a retry child or command when retry budget reservation is denied', async () => {
    const created = await post('/api/workspaces', { title: 'Retry budget', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const owner = await ownerFromCookie(cookie);
    const sourceResponse = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Initial',
      text: 'retry budget denial source',
      relation: 'initial',
      targetSourceId: null,
      requestId: '33333333-3333-4333-8333-333333333330',
    }, cookie);
    const failedRunId = (sourceResponse.body as WorkspaceView).runs[0].id;
    await testEnv.DB.prepare(
      'INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES (?, ?, ?, ?, "reserve", ?, ?)',
    ).bind('ledger_retry_existing', owner.id, workspace.id, 'existing_retry_budget', 495000, new Date().toISOString()).run();
    const send = vi.spyOn(testEnv.RUN_QUEUE, 'send');

    const denied = await post(`/api/workspaces/${workspace.id}/retry`, {
      runId: failedRunId,
      requestId: '34343434-3434-4434-8434-343434343434',
    }, cookie, appWithLiveKey());

    expect(denied.response.status).toBe(429);
    expect(denied.body).toMatchObject({ error: { code: 'DAILY_BUDGET_EXCEEDED' } });
    expect(send).not.toHaveBeenCalled();
    const counts = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM runs WHERE retry_of_run_id = ?) AS childRuns, (SELECT COUNT(*) FROM applied_commands WHERE workspace_id = ? AND command_type = "retry_run") AS commands')
      .bind(failedRunId, workspace.id)
      .first<{ childRuns: number; commands: number }>();
    expect(counts).toMatchObject({ childRuns: 0, commands: 0 });
  });

  it('replays the exact retry response for duplicate request ids', async () => {
    const created = await post('/api/workspaces', { title: 'Retry replay', purpose: 'Plan travel' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const sourceResponse = await post(`/api/workspaces/${workspace.id}/sources`, {
      title: 'Initial',
      text: 'retry idempotent response source',
      relation: 'initial',
      targetSourceId: null,
      requestId: '35353535-3535-4535-8535-353535353535',
    }, cookie);
    const failedRunId = (sourceResponse.body as WorkspaceView).runs[0].id;
    const requestId = '36363636-3636-4636-8636-363636363636';

    const first = await post(`/api/workspaces/${workspace.id}/retry`, { runId: failedRunId, requestId }, cookie, appWithLiveKey());
    const replay = await post(`/api/workspaces/${workspace.id}/retry`, { runId: failedRunId, requestId }, cookie, appWithLiveKey());

    expect(first.response.status).toBe(200);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect((first.body as WorkspaceView).runs.filter((run) => run.id !== failedRunId)).toHaveLength(1);
  });

  it('expires content rows while retaining non-content budget ledger', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const cookie = cookieFrom(created.response);
    const createdBody = created.body as WorkspaceView;
    const owner = await ownerFromCookie(cookie);
    await testEnv.DB.prepare(
      'INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES (?, ?, ?, ?, "reserve", 1, ?)',
    ).bind('ledger_retained', owner.id, createdBody.id, 'retained_run', new Date().toISOString()).run();
    await testEnv.DB.prepare('UPDATE workspaces SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00.000Z', createdBody.id).run();

    const expired = await get(`/api/workspaces/${createdBody.id}`, cookie);
    expect(expired.status).toBe(404);
    const sourceCount = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM sources WHERE workspace_id = ?').bind(createdBody.id).first<{ count: number }>();
    const ledgerCount = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM budget_ledger WHERE id = "ledger_retained"').first<{ count: number }>();
    expect(sourceCount?.count).toBe(0);
    expect(ledgerCount?.count).toBe(1);
  });

  it('extends only the selected workspace expiry on read so scheduled cleanup preserves it', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const selected = await post('/api/workspaces/sample', { scenario: 'travel' });
      const selectedCookie = cookieFrom(selected.response);
      const selectedBody = selected.body as WorkspaceView;
      const untouched = await post('/api/workspaces/sample', { scenario: 'travel' });
      const untouchedBody = untouched.body as WorkspaceView;
      await testEnv.DB.prepare('UPDATE workspaces SET expires_at = ? WHERE id IN (?, ?)')
        .bind('2026-01-01T00:00:01.000Z', selectedBody.id, untouchedBody.id)
        .run();

      const read = await get(`/api/workspaces/${selectedBody.id}`, selectedCookie);
      expect(read.status).toBe(200);
      const selectedExpiry = await testEnv.DB.prepare('SELECT expires_at FROM workspaces WHERE id = ?')
        .bind(selectedBody.id)
        .first<{ expires_at: string }>();
      const untouchedExpiry = await testEnv.DB.prepare('SELECT expires_at FROM workspaces WHERE id = ?')
        .bind(untouchedBody.id)
        .first<{ expires_at: string }>();
      expect(Date.parse(selectedExpiry?.expires_at ?? '')).toBeGreaterThan(Date.parse('2026-01-01T00:00:01.000Z'));
      expect(untouchedExpiry?.expires_at).toBe('2026-01-01T00:00:01.000Z');

      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
      const ctx = createExecutionContext();
      await worker.scheduled?.(createScheduledController(), testEnv, ctx);
      await waitOnExecutionContext(ctx);

      const counts = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM workspaces WHERE id = ?) AS selected, (SELECT COUNT(*) FROM workspaces WHERE id = ?) AS untouched')
        .bind(selectedBody.id, untouchedBody.id)
        .first<{ selected: number; untouched: number }>();
      expect(counts).toMatchObject({ selected: 1, untouched: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not move expiry backwards when a newer access wins after the workspace read', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    await testEnv.DB.prepare('UPDATE workspaces SET expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() + 60_000).toISOString(), workspace.id).run();
    const newerExpiry = new Date(Date.now() + LIMITS.retentionMs + 60_000).toISOString();
    const prepare = testEnv.DB.prepare.bind(testEnv.DB);
    const batch = testEnv.DB.batch.bind(testEnv.DB);
    const workspaceReads = new WeakSet<D1PreparedStatement>();
    let injected = false;
    const prepareSpy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((query) => {
      const statement = prepare(query);
      if (!query.startsWith('SELECT * FROM workspaces WHERE id =')) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'bind') return (...values: unknown[]) => {
            const bound = target.bind(...values);
            workspaceReads.add(bound);
            return bound;
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    // Private reads now execute inside an authorization-fenced batch. Inject
    // the newer access after that real SELECT, before the expiry extension.
    const batchSpy = vi.spyOn(testEnv.DB, 'batch').mockImplementation(async (statements) => {
      const result = await batch(statements);
      if (!injected && statements.some(statement => workspaceReads.has(statement))) {
        injected = true;
        await prepare('UPDATE workspaces SET expires_at = ? WHERE id = ?').bind(newerExpiry, workspace.id).run();
      }
      return result;
    });
    const read = await get(`/api/workspaces/${workspace.id}`, cookie);
    prepareSpy.mockRestore();
    batchSpy.mockRestore();
    expect(injected).toBe(true);
    expect(read.status).toBe(200);
    expect((await read.json() as WorkspaceView).expiresAt).toBe(newerExpiry);
    expect(await testEnv.DB.prepare('SELECT expires_at FROM workspaces WHERE id = ?').bind(workspace.id).first())
      .toMatchObject({ expires_at: newerExpiry });
  });

  it('scheduled cleanup expires workspaces globally without owner activity', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const createdBody = created.body as WorkspaceView;
    await testEnv.DB.prepare('UPDATE workspaces SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00.000Z', createdBody.id).run();

    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController(), testEnv, ctx);
    await waitOnExecutionContext(ctx);

    const workspaceCount = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE id = ?').bind(createdBody.id).first<{ count: number }>();
    expect(workspaceCount?.count).toBe(0);
    const event = info.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .find((candidate) => candidate.event === 'cron_recovery');
    expect(event).toMatchObject({ outcome: 'completed', timedOutRuns: 0, expiredWorkspaces: 1, pendingRuns: 0, redispatchedRuns: 0, failedRedispatches: 0 });
    expect(event?.durationMs).toEqual(expect.any(Number));
  });

  it('does not replay private response bodies after the workspace has expired', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const workspace = created.body as WorkspaceView;
    const cookie = cookieFrom(created.response);
    const command = { baseRevision: workspace.revision, requestId: crypto.randomUUID(), itemId: workspace.snapshot.blocks[0].items[0].id, value: 'private synthetic edit' };
    expect((await patch(`/api/workspaces/${workspace.id}/items`, command, cookie)).response.status).toBe(200);
    await testEnv.DB.prepare('UPDATE workspaces SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00.000Z', workspace.id).run();
    const replay = await patch(`/api/workspaces/${workspace.id}/items`, command, cookie);
    expect(replay.response.status).toBe(404);
    expect(JSON.stringify(replay.body)).not.toContain('private synthetic edit');
  });

  it('refuses a corrupt missing snapshot rather than presenting an empty workspace as valid', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const workspace = created.body as WorkspaceView;
    await testEnv.DB.prepare('DELETE FROM snapshots WHERE workspace_id = ? AND revision = ?').bind(workspace.id, workspace.revision).run();
    const response = await get(`/api/workspaces/${workspace.id}`, cookieFrom(created.response));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'SNAPSHOT_MISSING' } });
  });

  it('keeps durable pending dispatch after Queue send failure and redelivers it in scheduled recovery', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const created = await post('/api/workspaces', { title: 'Dispatch recovery', purpose: 'Synthetic outbox test' });
    const workspace = created.body as WorkspaceView;
    const cookie = cookieFrom(created.response);
    const send = vi.spyOn(testEnv.RUN_QUEUE, 'send').mockRejectedValueOnce(new Error('synthetic queue unavailable')).mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    const added = await post(`/api/workspaces/${workspace.id}/sources`, { title: 'Initial', text: 'synthetic dispatch source', relation: 'initial', targetSourceId: null, requestId: crypto.randomUUID() }, cookie, appWithLiveKey());
    expect(added.response.status).toBe(200);
    const view = added.body as WorkspaceView;
    expect(view.runs[0].status).toBe('pending');
    expect(view.sources).toHaveLength(1);
    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController(), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(send).toHaveBeenLastCalledWith({ runId: view.runs[0].id });
    const count = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ?').bind(workspace.id).first<{ count: number }>();
    expect(count?.count).toBe(1);
    const event = info.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .find((candidate) => candidate.event === 'cron_recovery');
    expect(event).toMatchObject({ outcome: 'completed', timedOutRuns: 0, expiredWorkspaces: 0, pendingRuns: 1, redispatchedRuns: 1, failedRedispatches: 0 });
  });

  it('logs partial cron redispatch failures without clearing pending runs', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const created = await post('/api/workspaces', { title: 'Partial dispatch', purpose: 'Synthetic partial dispatch test' });
    const workspace = created.body as WorkspaceView;
    const cookie = cookieFrom(created.response);
    const send = vi.spyOn(testEnv.RUN_QUEUE, 'send')
      .mockResolvedValueOnce({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } })
      .mockRejectedValueOnce(new Error('synthetic scheduled dispatch failure'));
    const added = await post(`/api/workspaces/${workspace.id}/sources`, { title: 'Initial', text: 'partial dispatch source', relation: 'initial', targetSourceId: null, requestId: crypto.randomUUID() }, cookie, appWithLiveKey());
    expect(added.response.status).toBe(200);
    const runId = (added.body as WorkspaceView).runs[0].id;

    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController(), testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(send).toHaveBeenLastCalledWith({ runId });
    const run = await testEnv.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>();
    expect(run?.status).toBe('pending');
    const event = info.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .find((candidate) => candidate.event === 'cron_recovery');
    expect(event).toMatchObject({ outcome: 'partial_redispatch_failure', timedOutRuns: 0, expiredWorkspaces: 0, pendingRuns: 1, redispatchedRuns: 0, failedRedispatches: 1 });
  });

  it('logs partial cron counters and rethrows when a recovery database stage fails', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const prepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((query) => {
      if (query.startsWith('DELETE FROM workspaces WHERE expires_at <= ? RETURNING id')) {
        return { bind: () => ({ all: async () => { throw new Error('synthetic expiry database failure'); } }) } as unknown as D1PreparedStatement;
      }
      return prepare(query);
    });

    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController(), testEnv, ctx);
    await expect(waitOnExecutionContext(ctx)).rejects.toThrow('synthetic expiry database failure');
    spy.mockRestore();

    const event = info.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .find((candidate) => candidate.event === 'cron_recovery');
    expect(event).toMatchObject({
      outcome: 'failed',
      timedOutRuns: 0,
      expiredWorkspaces: 0,
      pendingRuns: 0,
      redispatchedRuns: 0,
      failedRedispatches: 0,
      failedStage: 'expire_workspaces',
      errorName: 'Error',
    });
  });

  it('marks private API responses uncacheable and compares the complete request origin', async () => {
    expect((await get('/api/config')).headers.get('cache-control')).toBe('no-store');
    const response = await app.request('https://local.test/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://local.test' }, body: JSON.stringify({ title: 'cross scheme', purpose: 'must reject' }) }, testEnv);
    expect(response.status).toBe(403);
  });

  it('cannot rebase a stale proposal by submitting the current revision in the apply body', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' }, undefined, realApp);
    const workspace = created.body as WorkspaceView;
    const cookie = cookieFrom(created.response);
    const proposed = await post(`/api/workspaces/${workspace.id}/sample-update`, { step: 'update', requestId: crypto.randomUUID() }, cookie, realApp);
    const pending = (proposed.body as WorkspaceView).pending!;
    const edited = await patch(`/api/workspaces/${workspace.id}/items`, { itemId: workspace.snapshot.blocks[0].items[0].id, baseRevision: workspace.revision, requestId: crypto.randomUUID(), value: 'newer manual decision' }, cookie);
    const editedView = edited.body as WorkspaceView;
    const forged = await post(`/api/workspaces/${workspace.id}/apply`, { changeSetId: pending.id, proposalRevision: pending.proposalRevision, baseRevision: editedView.revision, baseSourceRevision: editedView.sourceRevision, requestId: crypto.randomUUID(), resolutions: [] }, cookie, realApp);
    expect(forged.response.status).toBe(409);
    const after = await get(`/api/workspaces/${workspace.id}`, cookie);
    expect((await after.json() as WorkspaceView).snapshot).toEqual(editedView.snapshot);
  });

  it('reports storage failure while recording a duplicate source as a server error, not an idempotency conflict', async () => {
    const created = await post('/api/workspaces', { title: 'Storage failure', purpose: 'Track a source' });
    const cookie = cookieFrom(created.response);
    const workspace = created.body as WorkspaceView;
    const source = { title: 'Initial', text: 'Keep this source.', relation: 'initial', targetSourceId: null, requestId: crypto.randomUUID() };
    expect((await post(`/api/workspaces/${workspace.id}/sources`, source, cookie)).response.status).toBe(200);
    const prepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((query) => {
      if (query.startsWith('INSERT INTO applied_commands')) {
        return { bind: () => ({ run: async () => { throw new Error('synthetic storage outage'); } }) } as unknown as D1PreparedStatement;
      }
      return prepare(query);
    });
    const failed = await post(`/api/workspaces/${workspace.id}/sources`, { ...source, requestId: crypto.randomUUID() }, cookie);
    expect(failed.response.status).toBe(500);
    expect(failed.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    spy.mockRestore();
    const stored = await get(`/api/workspaces/${workspace.id}`, cookie);
    expect((await stored.json() as WorkspaceView).sources).toHaveLength(1);
  });

  it('uses the same UTF-16 character units for individual and combined source limits', async () => {
    const created = await post('/api/workspaces', { title: 'Unicode limits', purpose: 'Synthetic quota boundary' });
    const workspace = created.body as WorkspaceView;
    const cookie = cookieFrom(created.response);
    for (let index = 0; index < 5; index += 1) {
      const text = '🧪'.repeat(2999) + `0${index}`;
      expect(text.length).toBe(6000);
      const result = await post(`/api/workspaces/${workspace.id}/sources`, { title: 'Unicode source', text, relation: index === 0 ? 'initial' : 'addition', targetSourceId: null, requestId: crypto.randomUUID() }, cookie);
      expect(result.response.status).toBe(index < 4 ? 200 : 413);
    }
  });

  it('rejects sample updates that would exceed source count without writing source run or command artifacts', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const workspace = created.body as WorkspaceView;
    const cookie = cookieFrom(created.response);
    for (let index = 1; index < LIMITS.maxSources; index += 1) {
      const result = await post(`/api/workspaces/${workspace.id}/sources`, {
        title: `Fill ${index}`,
        text: `unique fill source ${index}`,
        relation: 'addition',
        targetSourceId: null,
        requestId: crypto.randomUUID(),
      }, cookie);
      expect(result.response.status).toBe(200);
    }
    const before = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM sources WHERE workspace_id = ?) AS sources, (SELECT COUNT(*) FROM runs WHERE workspace_id = ?) AS runs, (SELECT COUNT(*) FROM applied_commands WHERE workspace_id = ?) AS commands')
      .bind(workspace.id, workspace.id, workspace.id)
      .first<{ sources: number; runs: number; commands: number }>();

    const update = await post(`/api/workspaces/${workspace.id}/sample-update`, {
      step: 'update',
      requestId: '37373737-3737-4737-8737-373737373737',
    }, cookie, realApp);

    expect(update.response.status).toBe(429);
    expect(update.body).toMatchObject({ error: { code: 'SOURCE_LIMIT' } });
    const after = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM sources WHERE workspace_id = ?) AS sources, (SELECT COUNT(*) FROM runs WHERE workspace_id = ?) AS runs, (SELECT COUNT(*) FROM applied_commands WHERE workspace_id = ?) AS commands')
      .bind(workspace.id, workspace.id, workspace.id)
      .first<{ sources: number; runs: number; commands: number }>();
    expect(after).toEqual(before);
  });

  it('validates initial fixture source length before sample workspace writes', async () => {
    const oversizedSamples: Record<'travel' | 'syllabus', SampleScenario> = {
      ...samples,
      travel: { ...samples.travel, initialText: 'x'.repeat(LIMITS.sourceChars + 1) },
    };
    const oversizedApp = createApp({ core, samples: oversizedSamples });

    const response = await post('/api/workspaces/sample', { scenario: 'travel' }, undefined, oversizedApp);

    expect(response.response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: 'SOURCE_TOO_LARGE' } });
    const counts = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM snapshots) AS snapshots, (SELECT COUNT(*) FROM runs) AS runs')
      .first<{ workspaces: number; sources: number; snapshots: number; runs: number }>();
    expect(counts).toMatchObject({ workspaces: 0, sources: 0, snapshots: 0, runs: 0 });
  });

  it('rejects sample updates that would exceed total source length without writing artifacts', async () => {
    const created = await post('/api/workspaces/sample', { scenario: 'travel' });
    const workspace = created.body as WorkspaceView;
    const cookie = cookieFrom(created.response);
    let remaining = LIMITS.totalSourceChars - workspace.sources[0].text.length - samples.travel.updateText.length + 1;
    let chunkIndex = 0;
    while (remaining > 0) {
      const chunkLength = Math.min(remaining, LIMITS.sourceChars);
      const fillerResponse = await post(`/api/workspaces/${workspace.id}/sources`, {
        title: `Near total limit ${chunkIndex}`,
        text: `${chunkIndex}`.padEnd(chunkLength, 'x'),
        relation: 'addition',
        targetSourceId: null,
        requestId: crypto.randomUUID(),
      }, cookie);
      expect(fillerResponse.response.status).toBe(200);
      remaining -= chunkLength;
      chunkIndex += 1;
    }
    const before = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM sources WHERE workspace_id = ?) AS sources, (SELECT COUNT(*) FROM runs WHERE workspace_id = ?) AS runs, (SELECT COUNT(*) FROM applied_commands WHERE workspace_id = ?) AS commands')
      .bind(workspace.id, workspace.id, workspace.id)
      .first<{ sources: number; runs: number; commands: number }>();

    const update = await post(`/api/workspaces/${workspace.id}/sample-update`, {
      step: 'update',
      requestId: '38383838-3838-4838-8838-383838383838',
    }, cookie, realApp);

    expect(update.response.status).toBe(413);
    expect(update.body).toMatchObject({ error: { code: 'SOURCE_TOTAL_LIMIT' } });
    const after = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM sources WHERE workspace_id = ?) AS sources, (SELECT COUNT(*) FROM runs WHERE workspace_id = ?) AS runs, (SELECT COUNT(*) FROM applied_commands WHERE workspace_id = ?) AS commands')
      .bind(workspace.id, workspace.id, workspace.id)
      .first<{ sources: number; runs: number; commands: number }>();
    expect(after).toEqual(before);
  });

  it('atomically enforces workspace quota across concurrent normal and sample creates', async () => {
    const first = await post('/api/workspaces', { title: 'Quota seed 0', purpose: 'Fill workspace quota' });
    const cookie = cookieFrom(first.response);
    for (let index = 1; index < 9; index += 1) {
      const created = await post('/api/workspaces', { title: `Quota seed ${index}`, purpose: 'Fill workspace quota' }, cookie);
      expect(created.response.status).toBe(201);
    }
    const restoreBatch = pauseNextBatches(2);

    const [normal, sample] = await Promise.all([
      post('/api/workspaces', { title: 'Final normal', purpose: 'Race for final slot' }, cookie),
      post('/api/workspaces/sample', { scenario: 'travel' }, cookie, realApp),
    ]);
    restoreBatch();

    expect([normal.response.status, sample.response.status].sort()).toEqual([201, 429]);
    const counts = await testEnv.DB.prepare('SELECT (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM snapshots LEFT JOIN workspaces ON snapshots.workspace_id = workspaces.id WHERE workspaces.id IS NULL) AS orphanSnapshots, (SELECT COUNT(*) FROM sources LEFT JOIN workspaces ON sources.workspace_id = workspaces.id WHERE workspaces.id IS NULL) AS orphanSources, (SELECT COUNT(*) FROM runs LEFT JOIN workspaces ON runs.workspace_id = workspaces.id WHERE workspaces.id IS NULL) AS orphanRuns')
      .first<{ workspaces: number; orphanSnapshots: number; orphanSources: number; orphanRuns: number }>();
    expect(counts).toMatchObject({ workspaces: 10, orphanSnapshots: 0, orphanSources: 0, orphanRuns: 0 });
  });
});

const get = async (path: string, cookie?: string) => app.request(`http://local.test${path}`, {
  headers: cookie ? { cookie } : {},
}, testEnv);

const post = async (path: string, body: unknown, cookie?: string, client: TestClient = app): Promise<{ response: Response; body: unknown }> => {
  const response = await client.request(`http://local.test${path}`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(body),
  }, testEnv);
  return { response, body: await json(response) };
};

const patch = async (path: string, body: unknown, cookie?: string): Promise<{ response: Response; body: unknown }> => {
  const response = await app.request(`http://local.test${path}`, {
    method: 'PATCH',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(body),
  }, testEnv);
  return { response, body: await json(response) };
};

const appWithLiveKey = (): TestClient => ({
  request: (input: RequestInfo | URL, init?: RequestInit, requestEnv?: Cloudflare.Env) =>
    app.request(input, init, liveEnv(requestEnv)),
});

const appWithEnv = (overrides: Record<string, unknown>): TestClient => ({
  request: (input: RequestInfo | URL, init?: RequestInit, requestEnv?: Cloudflare.Env) =>
    app.request(input, init, { ...liveEnv(requestEnv), ...overrides } as Cloudflare.Env),
});

const jsonHeaders = (cookie?: string): HeadersInit => ({
  'content-type': 'application/json',
  origin: 'http://local.test',
  ...(cookie ? { cookie } : {}),
});

const cookieFrom = (response: Response): string => {
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toBeTruthy();
  return cookie?.split(';')[0] ?? '';
};

const json = async (response: Response): Promise<Record<string, unknown>> => {
  if (response.status === 204) return {};
  return await response.json() as Record<string, unknown>;
};

const ownerFromCookie = async (cookie: string): Promise<{ id: string }> => {
  const token = cookie.split('=')[1];
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const owner = await testEnv.DB.prepare('SELECT id FROM owners WHERE token_hash = ?').bind(hash).first<{ id: string }>();
  expect(owner).toBeTruthy();
  return owner as { id: string };
};

const liveEnv = (base: Cloudflare.Env = testEnv): Cloudflare.Env => ({ ...base, GEMINI_API_KEY: 'test-key' } as Cloudflare.Env);

const pauseNextBatches = (count: number): () => void => {
  const original = testEnv.DB.batch.bind(testEnv.DB);
  let seen = 0;
  let release: (() => void) | null = null;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(testEnv.DB, 'batch').mockImplementation(async (statements) => {
    seen += 1;
    if (seen <= count) {
      if (seen === count) release?.();
      await barrier;
    }
    return original(statements);
  });
  return () => {
    release?.();
    spy.mockRestore();
  };
};

const sampleDraftPlaceholder = (sourceId: string, quote: string): ProposalDraft => ({
  schemaVersion: 2,
  summary: 'initial',
  questions: [],
  facts: [{ key: 'model_fact', label: 'Model fact', value: quote, sourceId, quote, operation: 'create', targetFactKey: null, semantic: null }],
  blocks: [{
    key: 'model_note',
    type: 'note',
    title: 'Model note',
    items: [{ key: 'model_item', label: 'Model item', value: quote, factKeys: ['model_fact'], valueFactKey: 'model_fact', calculation: null, operation: 'create', targetItemId: null }],
  }],
  removedItems: [],
});

const geminiPrompt = async (input: RequestInfo | URL, init?: RequestInit): Promise<{ sources: { id: string; text: string }[] }> => {
  const bodyText = typeof input === 'object' && 'text' in input ? await input.clone().text() : String(init?.body);
  const requestBody = JSON.parse(bodyText) as { contents: { role: string; parts: { text?: string }[] }[] };
  const userMessage = requestBody.contents.find((message) => message.role === 'user');
  expect(userMessage).toBeTruthy();
  const text = userMessage?.parts.find((part) => typeof part.text === 'string')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text ?? '{}') as { sources: { id: string; text: string }[] };
};

const geminiResponse = (
  draft: ProposalDraft,
  responseId = 'resp_test',
  usageMetadata = { promptTokenCount: 4, candidatesTokenCount: 1, thoughtsTokenCount: 2, totalTokenCount: 7 },
): Response => {
  const body = {
    responseId,
    candidates: [{
      content: { role: 'model', parts: [{ text: JSON.stringify(draft) }] },
      finishReason: 'STOP',
    }],
    usageMetadata,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
