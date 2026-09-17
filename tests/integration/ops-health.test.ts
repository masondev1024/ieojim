/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, createExecutionContext, createScheduledController, env, reset, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectOpsHealth } from '../../src/server/ops-health';
import worker from '../../src/server/index';

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('ops health diagnostics', () => {
  it.each(['storage_policy', 'storage_usage'] as const)('reports missing %s as critical rather than healthy zero usage', async (table) => {
    await testEnv.DB.prepare(`DELETE FROM ${table} WHERE id = 1`).run();
    const health = await collectOpsHealth(testEnv.DB, { includeStorageReconciliation: true });
    expect(health.severity).toBe('critical');
    expect(health.operatorReviewRequired).toBe(true);
    expect(health.checks).toContain(`${table}_missing`);
    if (table === 'storage_usage') {
      expect(health.checks).toContain('storage_reconciliation_unavailable');
      expect(health.storageReconciliationDeltaBytes).toBeUndefined();
    }
  });

  it('requires operator review for storage drift even without uncertain runs or budget violations', async () => {
    await testEnv.DB.prepare('UPDATE storage_usage SET content_bytes = 1 WHERE id = 1').run();
    const health = await collectOpsHealth(testEnv.DB, { includeStorageReconciliation: true });
    expect(health.severity).toBe('critical');
    expect(health.checks).toContain('storage_counter_drift');
    expect(health.operatorReviewRequired).toBe(true);
  });

  it('flags old pending, uncertain, budget policy and storage cap without selecting private content', async () => {
    await seedOwnerAndWorkspace();
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, request_id, payload_hash, base_revision, base_source_revision, reserved_micro_usd, created_at, updated_at)
        VALUES ('run_pending_old', 'workspace_ops', 'owner_ops', 'source_ops', 'pending', 'live', 'request_pending', 'hash_pending', 0, 1, 1000, ?, ?)
      `).bind(new Date(Date.now() - 11 * 60 * 1000).toISOString(), new Date(Date.now() - 11 * 60 * 1000).toISOString()),
      testEnv.DB.prepare(`
        INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, request_id, payload_hash, base_revision, base_source_revision, reserved_micro_usd, created_at, updated_at)
        VALUES ('run_uncertain', 'workspace_ops', 'owner_ops', 'source_ops', 'uncertain', 'live', 'request_uncertain', 'hash_uncertain', 0, 1, 1000, ?, ?)
      `).bind(new Date().toISOString(), new Date().toISOString()),
      testEnv.DB.prepare(`
        INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at)
        VALUES ('policy_ops', 'owner_ops', 'workspace_ops', 'run_uncertain', 'policy_violation', 10, ?)
      `).bind(new Date().toISOString()),
    ]);
    const usage = await testEnv.DB.prepare('SELECT content_bytes FROM storage_usage WHERE id = 1').first<{ content_bytes: number }>();
    await testEnv.DB.prepare('UPDATE storage_policy SET max_content_bytes = ? WHERE id = 1').bind(Math.max(1, usage!.content_bytes)).run();

    const health = await collectOpsHealth(testEnv.DB, { includeStorageReconciliation: true });

    expect(health.severity).toBe('critical');
    expect(health.checks).toEqual(expect.arrayContaining([
      'pending_age_critical',
      'uncertain_runs_operator_review',
      'model_budget_policy_violation_operator_review',
      'storage_content_near_cap_critical',
    ]));
    expect(health.operatorReviewRequired).toBe(true);
    expect(health.pendingRuns).toBe(1);
    expect(health.uncertainRuns).toBe(1);
    expect(health.modelBudgetPolicyViolations).toBe(1);
    expect(health.storageReconciliationDeltaBytes).toBe(0);
    expect(JSON.stringify(health)).not.toContain('private source text');
    expect(JSON.stringify(health)).not.toContain('owner-token');
  });

  it('logs a content-free ops health event after scheduled recovery marks timed out runs uncertain', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await seedOwnerAndWorkspace();
    await testEnv.DB.prepare(`
      INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, request_id, payload_hash, base_revision, base_source_revision, reserved_micro_usd, claimed_at, created_at, updated_at)
      VALUES ('run_running_old', 'workspace_ops', 'owner_ops', 'source_ops', 'running', 'live', 'request_running', 'hash_running', 0, 1, 1000, ?, ?, ?)
    `).bind('2026-09-08T23:58:00.000Z', '2026-09-08T23:57:59.000Z', '2026-09-08T23:58:00.000Z').run();

    try {
      const ctx = createExecutionContext();
      await worker.scheduled?.(createScheduledController(), testEnv, ctx);
      await waitOnExecutionContext(ctx);
    } finally {
      vi.useRealTimers();
    }

    const events = info.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'cron_recovery')).toMatchObject({ outcome: 'completed', timedOutRuns: 1 });
    expect(events.find((event) => event.event === 'ops_health')).toMatchObject({
      outcome: 'evaluated',
      severity: 'critical',
      checks: expect.arrayContaining(['uncertain_runs_operator_review']),
      operatorReviewRequired: true,
      uncertainRuns: 1,
      storageReconciliationDeltaBytes: 0,
    });
    expect(JSON.stringify(events)).not.toContain('private source text');
    expect(JSON.stringify(events)).not.toContain('owner-token');
  });

  it('does not fail scheduled recovery when ops diagnostics cannot read the database', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const prepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((query) => {
      if (query.includes('COUNT(*) FILTER') && query.includes('uncertain_count')) {
        return { bind: () => ({ first: async () => { throw new Error('synthetic ops health failure'); } }) } as unknown as D1PreparedStatement;
      }
      return prepare(query);
    });

    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController(), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    spy.mockRestore();

    const events = info.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'cron_recovery')).toMatchObject({ outcome: 'completed' });
    expect(events.find((event) => event.event === 'ops_health')).toMatchObject({
      outcome: 'failed',
      severity: 'critical',
      checks: ['ops_health_collection_failed'],
      operatorReviewRequired: true,
      errorName: 'Error',
    });
  });
});

const seedOwnerAndWorkspace = async (): Promise<void> => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES ('owner_ops', 'owner-token', ?, ?)")
      .bind(new Date().toISOString(), new Date().toISOString()),
    testEnv.DB.prepare(`
      INSERT INTO workspaces (id, owner_id, title, purpose, created_at, updated_at, expires_at)
      VALUES ('workspace_ops', 'owner_ops', 'private title', 'private purpose', ?, ?, ?)
    `).bind(new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()),
    testEnv.DB.prepare(`
      INSERT INTO sources (id, workspace_id, source_revision, title, relation, hash, text, created_at)
      VALUES ('source_ops', 'workspace_ops', 1, 'private source title', 'initial', 'source_hash_ops', 'private source text', ?)
    `).bind(new Date().toISOString()),
    testEnv.DB.prepare(`
      INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at)
      VALUES ('workspace_ops', 0, '{"blocks":[],"facts":[]}', 'private snapshot reason', ?)
    `).bind(new Date().toISOString()),
  ]);
};
