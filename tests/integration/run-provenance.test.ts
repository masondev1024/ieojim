/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, createMessageBatch, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type ProposalDraft } from '../../src/core/contracts';
import { LIMITS } from '../../src/core/contracts';
import { WorkspaceStore } from '../../src/server/db';
import worker from '../../src/server/index';
import type { ModelRequestProvenance } from '../../src/server/model';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1]; GEMINI_API_KEY?: string };
type SeededRun = {
  runId: string;
  workspaceId: string;
  ownerId: string;
  sourceId: string;
};

const testEnv = env as TestEnv;
const createdAt = '2026-09-09T00:00:00.000Z';

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('run request provenance persistence', () => {
  it('keeps a transport failure uncertain and does not call again on duplicate delivery', async () => {
    const seeded = await seedPendingRun();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('private transport failure'));
    const deliver = async (attempts: number) => worker.queue?.(createMessageBatch('ieojim-runs', [{ id: `msg-transport-${attempts}`, timestamp: new Date(), body: { runId: seeded.runId }, attempts }]), liveEnv());
    await deliver(1);
    const row = await testEnv.DB.prepare('SELECT status, error, actual_micro_usd FROM runs WHERE id = ?').bind(seeded.runId).first<{ status: string; error: string; actual_micro_usd: number | null }>();
    expect(row).toMatchObject({ status: 'uncertain', actual_micro_usd: null });
    expect(row?.error).not.toContain('private');
    await deliver(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['invalid-output', 'invalid-evidence'] as const)('records known %s rejection as failed, preserves usage and never repeats a duplicate call', async (failure) => {
    const seeded = await seedPendingRun();
    const draft = sampleDraft(seeded.sourceId, 'private source text');
    if (failure === 'invalid-output') draft.summary = 'x'.repeat(601);
    else draft.facts[0].quote = 'private unsupported evidence';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => geminiResponse(draft));
    const deliver = async (attempts: number) => worker.queue?.(createMessageBatch('ieojim-runs', [{ id: `msg-known-${attempts}`, timestamp: new Date(), body: { runId: seeded.runId }, attempts }]), liveEnv());

    await deliver(1);

    const row = await testEnv.DB.prepare('SELECT status, error, actual_micro_usd FROM runs WHERE id = ?').bind(seeded.runId).first<{ status: string; error: string; actual_micro_usd: number }>();
    expect(row?.status).toBe('failed');
    expect(row?.actual_micro_usd).toBeGreaterThan(0);
    expect(row?.error).not.toContain('private');
    const view = await new WorkspaceStore(testEnv).getWorkspace(seeded.ownerId, seeded.workspaceId);
    expect(view.snapshot).toEqual(emptySnapshot());
    expect(view.pending).toBeNull();
    await deliver(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('adds nullable provenance to existing live and fixture runs without rewriting their fields', async () => {
    await reset();
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS.filter((migration) => migration.name <= '0005_source_answers.sql'));
    const seeded = await seedPendingRun();
    await testEnv.DB.prepare(
      'INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, error, request_id, payload_hash, base_revision, base_source_revision, changeset_id, actual_micro_usd, created_at, updated_at) VALUES (?, ?, ?, ?, "ready", "fixture", NULL, ?, ?, 0, 1, ?, 0, ?, ?)',
    ).bind('fixture-run', seeded.workspaceId, seeded.ownerId, seeded.sourceId, crypto.randomUUID(), 'fixture-payload', 'fixture-changeset', createdAt, createdAt).run();

    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS.filter((migration) => migration.name === '0006_run_provenance.sql'));

    const rows = await testEnv.DB.prepare('SELECT id, status, mode, base_revision, base_source_revision, provenance_json FROM runs ORDER BY id')
      .all<{ id: string; status: string; mode: string; base_revision: number; base_source_revision: number; provenance_json: string | null }>();
    expect(rows.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seeded.runId, status: 'pending', mode: 'live', base_revision: 0, base_source_revision: 1, provenance_json: null }),
      expect.objectContaining({ id: 'fixture-run', status: 'ready', mode: 'fixture', base_revision: 0, base_source_revision: 1, provenance_json: null }),
    ]));
  });

  it('guards provenance JSON validity and size at the database boundary', async () => {
    const seeded = await seedPendingRun();
    await expect(testEnv.DB.prepare('UPDATE runs SET provenance_json = ? WHERE id = ?').bind('not-json', seeded.runId).run()).rejects.toThrow();
    await expect(testEnv.DB.prepare('UPDATE runs SET provenance_json = ? WHERE id = ?').bind(JSON.stringify({ value: 'x'.repeat(4096) }), seeded.runId).run()).rejects.toThrow();
  });

  it('stores provenance write-once and rejects stale base revision matches', async () => {
    const seeded = await seedPendingRun();
    const store = new WorkspaceStore(testEnv);
    const claimed = await store.claimRun(seeded.runId);
    expect(claimed).toBeTruthy();
    const provenance = sampleProvenance();

    expect(await store.recordRunProvenance(claimed!, provenance)).toBe(true);
    expect(await store.recordRunProvenance(claimed!, { ...provenance, requestSha256: 'b'.repeat(64) })).toBe(false);
    expect(await store.recordRunProvenance({ ...claimed!, id: 'missing-run' }, provenance)).toBe(false);
    expect(await store.recordRunProvenance({ ...claimed!, base_revision: 99 }, provenance)).toBe(false);

    const row = await testEnv.DB.prepare('SELECT provenance_json FROM runs WHERE id = ?').bind(seeded.runId).first<{ provenance_json: string }>();
    expect(JSON.parse(row!.provenance_json)).toMatchObject({ requestSha256: 'a'.repeat(64), modelId: 'gemini-3.8-flash' });

    const stale = await seedPendingRun();
    const staleClaimed = await store.claimRun(stale.runId);
    expect(staleClaimed).toBeTruthy();
    await testEnv.DB.prepare('UPDATE workspaces SET revision = revision + 1 WHERE id = ?').bind(stale.workspaceId).run();
    expect(await store.recordRunProvenance(staleClaimed!, provenance)).toBe(false);

    const expired = await seedPendingRun({ expiresAt: '2000-01-01T00:00:00.000Z' });
    const expiredClaimed = await store.claimRun(expired.runId);
    expect(expiredClaimed).toBeTruthy();
    expect(await store.recordRunProvenance(expiredClaimed!, provenance)).toBe(false);
  });

  it('persists provenance before fetch and hashes the exact outbound body', async () => {
    const seeded = await seedPendingRun();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const row = await testEnv.DB.prepare('SELECT provenance_json FROM runs WHERE id = ?').bind(seeded.runId).first<{ provenance_json: string | null }>();
      expect(row?.provenance_json).toBeTruthy();
      const provenance = JSON.parse(row!.provenance_json!) as ModelRequestProvenance;
      expect(provenance.requestSha256).toBe(await sha256Hex(String(init?.body)));
      expect(provenance).toMatchObject({
        schemaVersion: 1,
        modelId: 'gemini-3.8-flash',
        strategy: 'incremental',
        sourceCount: 1,
        snapshotFactCount: 0,
        snapshotBlockCount: 0,
        snapshotItemCount: 0,
      });
      expect(JSON.stringify(provenance)).not.toContain('private source text');
      return geminiResponse(sampleDraft(seeded.sourceId, 'private source text'));
    });

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-provenance', timestamp: new Date(), body: { runId: seeded.runId }, attempts: 1 }]), liveEnv());

    expect(fetch).toHaveBeenCalledTimes(1);
    const run = await testEnv.DB.prepare('SELECT status, provenance_json FROM runs WHERE id = ?').bind(seeded.runId).first<{ status: string; provenance_json: string }>();
    expect(run?.status).toBe('ready');
    expect(JSON.parse(run!.provenance_json)).toHaveProperty('instructionSha256');
  });

  it('marks the run failed and skips fetch when provenance cannot be written', async () => {
    const seeded = await seedPendingRun();
    await testEnv.DB.prepare('UPDATE runs SET provenance_json = ? WHERE id = ?').bind(JSON.stringify(sampleProvenance()), seeded.runId).run();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(geminiResponse(sampleDraft(seeded.sourceId, 'private source text')));

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-provenance-failure', timestamp: new Date(), body: { runId: seeded.runId }, attempts: 1 }]), liveEnv());

    expect(fetch).not.toHaveBeenCalled();
    const run = await testEnv.DB.prepare('SELECT status, error, actual_micro_usd FROM runs WHERE id = ?').bind(seeded.runId).first<{ status: string; error: string; actual_micro_usd: number | null }>();
    expect(run).toMatchObject({ status: 'failed', error: '모델 요청 추적 정보를 저장하지 못해 호출을 중단했습니다.', actual_micro_usd: null });
  });

  it('catches a D1 provenance write abort and skips fetch', async () => {
    const seeded = await seedPendingRun();
    await testEnv.DB.prepare(`CREATE TRIGGER provenance_test_abort BEFORE UPDATE OF provenance_json ON runs
      WHEN NEW.id = '${seeded.runId}'
      BEGIN SELECT RAISE(ABORT, 'IEOJIM_TEST_PROVENANCE_ABORT'); END;`).run();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(geminiResponse(sampleDraft(seeded.sourceId, 'private source text')));

    await worker.queue?.(createMessageBatch('ieojim-runs', [{ id: 'msg-provenance-trigger-failure', timestamp: new Date(), body: { runId: seeded.runId }, attempts: 1 }]), liveEnv());

    expect(fetch).not.toHaveBeenCalled();
    const run = await testEnv.DB.prepare('SELECT status, error, provenance_json FROM runs WHERE id = ?').bind(seeded.runId).first<{ status: string; error: string; provenance_json: string | null }>();
    expect(run).toMatchObject({ status: 'failed', error: '모델 요청 추적 정보를 저장하지 못해 호출을 중단했습니다.', provenance_json: null });
  });

  it('deletes provenance through workspace cascade and never rewrites it during restore', async () => {
    const seeded = await seedPendingRun();
    const store = new WorkspaceStore(testEnv);
    const claimed = await store.claimRun(seeded.runId);
    expect(claimed).toBeTruthy();
    expect(await store.recordRunProvenance(claimed!, sampleProvenance())).toBe(true);
    const beforeRestore = await testEnv.DB.prepare('SELECT provenance_json FROM runs WHERE id = ?').bind(seeded.runId).first<{ provenance_json: string }>();

    await store.restoreSnapshot(seeded.ownerId, seeded.workspaceId, {
      revision: 0,
      baseRevision: 0,
      requestId: crypto.randomUUID(),
    });
    const afterRestore = await testEnv.DB.prepare('SELECT provenance_json FROM runs WHERE id = ?').bind(seeded.runId).first<{ provenance_json: string }>();
    expect(afterRestore?.provenance_json).toBe(beforeRestore?.provenance_json);

    await store.deleteWorkspace(seeded.ownerId, seeded.workspaceId);
    const remaining = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM runs WHERE id = ?').bind(seeded.runId).first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });
});

async function seedPendingRun(options: { expiresAt?: string } = {}): Promise<SeededRun> {
  const ownerId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)').bind(ownerId, `hash-${ownerId}`, createdAt, createdAt),
    testEnv.DB.prepare('INSERT INTO workspaces (id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, 0, 1, 0, ?, ?, ?)').bind(workspaceId, ownerId, 'Private workspace', 'private purpose text', createdAt, createdAt, options.expiresAt ?? '2099-01-01T00:00:00.000Z'),
    testEnv.DB.prepare('INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) VALUES (?, 0, ?, ?, ?)').bind(workspaceId, JSON.stringify(emptySnapshot()), 'created', createdAt),
    testEnv.DB.prepare('INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at) VALUES (?, ?, 1, ?, "initial", NULL, ?, ?, ?)').bind(sourceId, workspaceId, 'Private source', 'source-hash', 'private source text', createdAt),
    testEnv.DB.prepare('INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, error, request_id, payload_hash, base_revision, base_source_revision, reserved_micro_usd, created_at, updated_at) VALUES (?, ?, ?, ?, "pending", "live", NULL, ?, ?, 0, 1, ?, ?, ?)').bind(runId, workspaceId, ownerId, sourceId, crypto.randomUUID(), 'payload-hash', LIMITS.reserveMicroUsd, createdAt, createdAt),
  ]);
  return { runId, workspaceId, ownerId, sourceId };
}

function sampleProvenance(): ModelRequestProvenance {
  return {
    schemaVersion: 1,
    modelId: 'gemini-3.8-flash',
    strategy: 'incremental',
    requestSha256: 'a'.repeat(64),
    instructionSha256: 'c'.repeat(64),
    localSchemaSha256: 'd'.repeat(64),
    generationConfigSha256: 'e'.repeat(64),
    modelPolicySha256: 'f'.repeat(64),
    requestBytes: 100,
    instructionBytes: 50,
    localSchemaBytes: 75,
    generationConfigBytes: 25,
    sourceCount: 1,
    totalSourceTextBytes: 19,
    snapshotFactCount: 0,
    snapshotBlockCount: 0,
    snapshotItemCount: 0,
  };
}

const sampleDraft = (sourceId: string, quote: string): ProposalDraft => ({
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

function geminiResponse(draft: ProposalDraft): Response {
  return new Response(JSON.stringify({
    responseId: 'resp_test',
    candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(draft) }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, thoughtsTokenCount: 2, totalTokenCount: 7 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const liveEnv = (): Cloudflare.Env => ({ ...testEnv, GEMINI_API_KEY: 'test-key' } as Cloudflare.Env);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
