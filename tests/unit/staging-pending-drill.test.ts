import { describe, expect, it } from 'vitest';
import {
  buildPendingDrillPlan,
  pendingCleanupSql,
  pendingCleanupVerificationSql,
  pendingOwnershipSql,
  pendingPostRunSql,
  pendingReadOnlySql,
  pendingSeedSql,
  runPendingDrill,
  validatePendingStagingConfig,
} from '../../scripts/staging-pending-drill';
import type { ObservationReport } from '../../scripts/observe-staging';

const goodConfig = {
  env: {
    staging: {
      account_id: 'd77fd515103009a324bebb3ac5b81fd9',
      name: 'ieojim-staging',
      d1_databases: [{ binding: 'DB', database_name: 'ieojim-staging', database_id: '53421a70-d819-4ae6-9eb5-f558a119ea6b' }],
      queues: {
        producers: [{ binding: 'RUN_QUEUE', queue: 'ieojim-runs-staging' }],
        consumers: [{ queue: 'ieojim-runs-staging' }],
      },
      ratelimits: [{ name: 'PUBLIC_WRITES', namespace_id: '26090901' }],
      vars: { DAILY_BUDGET_MICRO_USD: '250000', TOTAL_BUDGET_MICRO_USD: '1000000', OWNER_DAILY_RUNS: '10' },
    },
  },
};

const baseOptions = {
  target: 'staging' as const,
  mode: 'plan' as const,
  allowRemoteMutation: false,
  baseUrl: 'https://ieojim-staging.masondev1024.workers.dev',
  durationSeconds: 1,
  duplicateMessages: 2,
};

const ids = {
  owner: 'ops_owner_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  workspace: 'ops_ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  source: 'ops_src_cccccccccccccccccccccccccccccccc',
  run: 'ops_run_dddddddddddddddddddddddddddddddd',
  request: 'ops_req_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  ledger: 'ops_led_ffffffffffffffffffffffffffffffff',
  guard: 'ops_guard_11111111111111111111111111111111',
};

const cronObservation: ObservationReport = {
  schema: 'ieojim.staging-tail-observation.v1' as const,
  startedAt: '2026-09-09T00:00:00.000Z',
  finishedAt: '2026-09-09T00:00:01.000Z',
  durationSeconds: 1,
  untilCron: true,
  stoppedAfterCron: true,
  timedOut: false,
  exitCode: 0,
  signal: null,
  counts: {
    invocations: { scheduled: 1, queue: 0, fetch: 0, unknown: 0 },
    telemetry: { run_lifecycle: 0, cron_recovery: 1, ops_health: 0 },
    ignoredRecords: 0,
    parseErrors: 0,
  },
  samples: [{
    invocation: { type: 'scheduled' as const, outcome: 'ok', observedAt: '2026-09-09T00:00:01.000Z' },
    telemetry: [{ event: 'cron_recovery' as const, outcome: 'completed', timedOutRuns: 0, expiredWorkspaces: 0, pendingRuns: 1, redispatchedRuns: 1, failedRedispatches: 0, durationMs: 12 }],
  }],
  errors: [],
  warnings: [],
};

const queueObservationFor = (runId: string): ObservationReport => ({
  ...cronObservation,
  untilCron: false,
  stoppedAfterCron: true,
  counts: {
    invocations: { scheduled: 0, queue: 3, fetch: 0, unknown: 0 },
    telemetry: { run_lifecycle: 3, cron_recovery: 0, ops_health: 0 },
    ignoredRecords: 0,
    parseErrors: 0,
  },
  samples: [
    ...cronObservation.samples,
    {
      invocation: { type: 'queue' as const, outcome: 'ok', observedAt: '2026-09-09T00:00:02.000Z' },
      telemetry: [
        { event: 'run_lifecycle' as const, runId, workspaceId: ids.workspace, status: 'running' as const, outcome: 'claimed' as const, reservedMicroUsd: 24360, actualMicroUsd: null },
        { event: 'run_lifecycle' as const, runId, workspaceId: ids.workspace, status: 'skipped' as const, outcome: 'skipped' as const },
        { event: 'run_lifecycle' as const, runId, workspaceId: ids.workspace, status: 'skipped' as const, outcome: 'skipped' as const },
      ],
    },
  ],
});

describe('staging pending redispatch drill', () => {
  it('documents the bounded paid-call and duplicate-delivery recovery path', () => {
    const plan = buildPendingDrillPlan();

    expect(JSON.stringify(plan)).toContain('same D1 mutation batch');
    expect(JSON.stringify(plan)).toContain('exactly one claimed');
    expect(JSON.stringify(plan)).toContain('one Gemini call');
    expect(JSON.stringify(plan)).toContain('Default 420 seconds');
  });

  it('pins staging account, worker, D1, Queue, and origin before any remote work', () => {
    expect(validatePendingStagingConfig(goodConfig, baseOptions.baseUrl)).toEqual([]);
    expect(validatePendingStagingConfig(goodConfig, 'https://evil.example.test')).toContain('staging_origin_mismatch');
    expect(validatePendingStagingConfig({ env: { staging: { ...goodConfig.env.staging, queues: { producers: [], consumers: [] } } } }, baseOptions.baseUrl)).toContain('staging_queue_mismatch');
  });

  it('builds read-only checks without selecting private source, snapshot, provenance, command, or token fields', () => {
    const sql = pendingReadOnlySql();

    expect(sql).toContain('ops_residue');
    expect(sql).toContain('live_pending_aggregate');
    expect(sql).not.toMatch(/\btext\b/i);
    expect(sql).not.toContain('token_hash');
    expect(sql).not.toContain('snapshot_json');
    expect(sql).not.toContain('response_json');
    expect(sql).not.toMatch(/\bSELECT\s+provenance_json\b/i);
  });

  it('creates the owned pending fixture with a reserve ledger and rejects unsafe ids', () => {
    const sql = pendingSeedSql(ids, '2026-09-09T00:00:00.000Z');

    expect(sql).toContain("'pending', 'live'");
    expect(sql).toContain("'reserve'");
    expect(sql).toContain('policy_violation');
    expect(sql).toContain('250000');
    expect(sql).toContain('1000000');
    expect(sql).toContain('24360');
    expect(sql).toContain('5290338220a3a50f9fbd85600a0c95e63db7160e8c9ec0f844ede7ebe96ba461');
    expect(pendingOwnershipSql(ids)).toContain('owned_pending_run');
    expect(pendingPostRunSql(ids.run)).toContain('actual_rows');
    expect(pendingCleanupSql(ids.workspace)).toContain('DELETE FROM workspaces');
    expect(pendingCleanupVerificationSql(ids)).toContain('retained_reserve_rows');
    expect(() => pendingSeedSql({ ...ids, run: "ops_run_bad'; DROP TABLE runs; --" }, '2026-09-09T00:00:00.000Z')).toThrow('unsafe_test_id');
  });

  it('does not mutate remote state when staging config mismatches', async () => {
    let executed = false;
    const report = await runPendingDrill({ ...baseOptions, mode: 'read-only' }, {
      readConfig: async () => ({ env: { staging: { ...goodConfig.env.staging, database_id: 'wrong', name: 'wrong-worker' } } }),
      executeD1: async () => {
        executed = true;
        return [];
      },
    });

    expect(executed).toBe(false);
    expect(report.errors).toContain('staging_worker_mismatch');
  });

  it('runs the mocked pending redispatch flow and records only safe report fields', async () => {
    const sqlCalls: Array<{ sql: string; mutates: boolean }> = [];
    const queueMessages: string[] = [];
    let observeCalls = 0;
    const report = await runPendingDrill({ ...baseOptions, mode: 'pending-redispatch', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      now: () => '2026-09-09T00:00:00.000Z',
      executeD1: async (sql, mutates) => {
        sqlCalls.push({ sql, mutates });
        if (sql.includes('owned_pending_run')) return [{ results: [{ check_name: 'owned_pending_run', owner_rows: 1, workspace_rows: 1, source_rows: 1, pending_run_rows: 1, reserve_rows: 1 }] }];
        if (sql.includes('run_state')) return [{ results: [{ check_name: 'run_state', status: 'ready', reserve_rows: 1, actual_rows: 1, policy_violation_rows: 0, provenance_rows: 1 }] }];
        if (sql.includes('cleanup')) return [{ results: [{ check_name: 'cleanup', workspace_rows: 0, source_rows: 0, run_rows: 0, owner_rows: 1, retained_reserve_rows: 1, retained_actual_rows: 1 }] }];
        return [{ results: [] }];
      },
      executeD1Batch: async (statements, mutates) => {
        sqlCalls.push({ sql: statements.join(';\n'), mutates });
        return [{ results: [] }];
      },
      sendQueueMessage: async (runId) => {
        queueMessages.push(runId);
        return { success: true };
      },
      observeLifecycle: async (_seconds, runId, action) => {
        observeCalls += 1;
        await action({ waitForCronRedispatch: async () => undefined, waitForClaimed: async () => undefined });
        return queueObservationFor(runId);
      },
    });

    expect(report.errors).toEqual([]);
    expect(report.cleanup).toEqual({ attempted: true, verified: true, retainedLedger: true });
    expect(queueMessages).toHaveLength(2);
    expect(observeCalls).toBe(1);
    expect(sqlCalls.some((call) => call.mutates && call.sql.includes('budget_ledger'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('참석자는 4명입니다');
    expect(JSON.stringify(report)).not.toContain('token_hash');
    expect(JSON.stringify(report)).not.toContain('provenance_json');
  });

  it('fails when queue telemetry shows duplicate claims or missing skipped duplicates, then still cleans up', async () => {
    const badQueueObservation = (runId: string) => ({
      ...queueObservationFor(runId),
      samples: [
        ...cronObservation.samples,
        {
          invocation: { type: 'queue' as const, outcome: 'ok', observedAt: '2026-09-09T00:00:02.000Z' },
          telemetry: [
            { event: 'run_lifecycle' as const, runId, status: 'running' as const, outcome: 'claimed' as const },
            { event: 'run_lifecycle' as const, runId, status: 'running' as const, outcome: 'claimed' as const },
          ],
        },
      ],
    });
    const queueMessages: string[] = [];
    const report = await runPendingDrill({ ...baseOptions, mode: 'pending-redispatch', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      now: () => '2026-09-09T00:00:00.000Z',
      executeD1: async (sql) => {
        if (sql.includes('owned_pending_run')) return [{ results: [{ check_name: 'owned_pending_run', owner_rows: 1, workspace_rows: 1, source_rows: 1, pending_run_rows: 1, reserve_rows: 1 }] }];
        if (sql.includes('run_state')) return [{ results: [{ check_name: 'run_state', status: 'ready', reserve_rows: 1, actual_rows: 1, policy_violation_rows: 0, provenance_rows: 1 }] }];
        if (sql.includes('cleanup')) return [{ results: [{ check_name: 'cleanup', workspace_rows: 0, source_rows: 0, run_rows: 0, owner_rows: 1, retained_reserve_rows: 1, retained_actual_rows: 0 }] }];
        return [{ results: [] }];
      },
      executeD1Batch: async () => [{ results: [] }],
      sendQueueMessage: async (runId) => {
        queueMessages.push(runId);
        return { success: true };
      },
      observeLifecycle: async (_seconds, runId, action) => {
        await action({ waitForCronRedispatch: async () => undefined, waitForClaimed: async () => undefined });
        return badQueueObservation(runId);
      },
    });

    expect(report.errors).toContain('duplicate_claim_detected');
    expect(report.cleanup.verified).toBe(true);
  });

  it.each(['failed', 'running'])('cancels pending cleanup with a claim CAS, then handles %s safely', async (afterCancellation) => {
    let status = 'pending';
    const mutations: string[] = [];
    const report = await runPendingDrill({ ...baseOptions, mode: 'pending-redispatch', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      executeD1Batch: async () => [],
      executeD1: async (sql, mutates) => {
        if (mutates) mutations.push(sql);
        if (sql.includes('owned_pending_run')) return [{ results: [{ check_name: 'owned_pending_run', owner_rows: 1, workspace_rows: 1, source_rows: 1, pending_run_rows: 1, reserve_rows: 1 }] }];
        if (sql.startsWith('UPDATE runs')) { status = afterCancellation; return []; }
        if (sql.includes('run_state')) return [{ results: [{ check_name: 'run_state', status }] }];
        if (sql.includes("'cleanup'")) return [{ results: [{ check_name: 'cleanup', workspace_rows: 0, source_rows: 0, run_rows: 0, retained_reserve_rows: 1 }] }];
        return [];
      },
      observeLifecycle: async (_seconds, _runId, action) => {
        await action({ waitForCronRedispatch: async () => { throw new Error('observation_failed'); }, waitForClaimed: async () => undefined });
        throw new Error('unreachable');
      },
    });
    expect(mutations.some((sql) => sql.startsWith('UPDATE runs') && sql.includes("status = 'pending'"))).toBe(true);
    expect(mutations.some((sql) => sql.startsWith('DELETE FROM workspaces'))).toBe(afterCancellation === 'failed');
    expect(report.cleanup.verified).toBe(afterCancellation === 'failed');
  });

  it('defers cleanup when the run is still running', async () => {
    const report = await runPendingDrill({ ...baseOptions, mode: 'pending-redispatch', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      now: () => '2026-09-09T00:00:00.000Z',
      executeD1: async (sql) => {
        if (sql.includes('owned_pending_run')) return [{ results: [{ check_name: 'owned_pending_run', owner_rows: 1, workspace_rows: 1, source_rows: 1, pending_run_rows: 1, reserve_rows: 1 }] }];
        if (sql.includes('run_state')) return [{ results: [{ check_name: 'run_state', status: 'running', reserve_rows: 1, actual_rows: 0, policy_violation_rows: 0, provenance_rows: 1 }] }];
        throw new Error('unexpected_cleanup_delete');
      },
      executeD1Batch: async () => [{ results: [] }],
      sendQueueMessage: async () => ({ success: true }),
      observeLifecycle: async (_seconds, runId, action) => {
        await action({ waitForCronRedispatch: async () => undefined, waitForClaimed: async () => undefined });
        return queueObservationFor(runId);
      },
    });

    expect(report.errors).toEqual(expect.arrayContaining(['run_not_terminal', 'run_not_terminal_cleanup_deferred']));
    expect(report.cleanup).toEqual({ attempted: false, verified: false, retainedLedger: null });
  });

  it('rejects mutation mode unless remote mutation is explicitly allowed', async () => {
    const report = await runPendingDrill({ ...baseOptions, mode: 'pending-redispatch', allowRemoteMutation: false }, {
      readConfig: async () => goodConfig,
    });

    expect(report.errors).toContain('remote_mutation_not_allowed');
    expect(report.cleanup.attempted).toBe(false);
  });
});
