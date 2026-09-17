import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  cleanupWorkspaceSql,
  expiredWorkspaceSeedSql,
  readOnlyHealthSql,
  readOnlyProbeWarnings,
  runDrill,
  timeoutSeedSql,
  validateStagingConfig,
  workspaceRemainingSql,
  type Options,
} from '../../scripts/staging-operational-drill';

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
    },
  },
};

const baseOptions: Options = {
  target: 'staging',
  mode: 'plan',
  allowRemoteMutation: false,
  baseUrl: 'https://ieojim-staging.masondev1024.workers.dev',
  durationSeconds: 1,
};

const successfulObservation = {
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
    telemetry: { run_lifecycle: 0, cron_recovery: 1, ops_health: 1 },
    ignoredRecords: 0,
    parseErrors: 0,
  },
  samples: [{
    invocation: { type: 'scheduled' as const, outcome: 'ok', observedAt: '2026-09-09T00:00:01.000Z' },
    telemetry: [{ event: 'cron_recovery' as const, outcome: 'completed', timedOutRuns: 1, expiredWorkspaces: 0, pendingRuns: 0, redispatchedRuns: 0, failedRedispatches: 0, durationMs: 12 }],
  }],
  errors: [],
  warnings: [],
};

describe('staging operational drill helpers', () => {
  it('pins the staging origin, account, worker, D1, Queue and rate-limit namespace', () => {
    expect(validateStagingConfig(goodConfig, baseOptions.baseUrl)).toEqual([]);
    expect(validateStagingConfig(goodConfig, 'https://evil.example.test')).toContain('staging_origin_mismatch');
    expect(validateStagingConfig({ env: { staging: { ...goodConfig.env.staging, account_id: 'bad' } } }, baseOptions.baseUrl)).toContain('staging_account_mismatch');
  });

  it('builds read-only health SQL without selecting private content columns', () => {
    const sql = readOnlyHealthSql();

    expect(sql).toContain('required_tables');
    expect(sql).toContain('run_provenance_column');
    expect(sql).toContain('safe_aggregates');
    expect(sql).not.toMatch(/\bSELECT\s+text\b/i);
    expect(sql).not.toContain('token_hash');
    expect(sql).not.toContain('response_json');
    expect(sql).not.toContain('snapshot_json');
  });

  it('constructs mutation SQL from ops-owned ids only', () => {
    const ids = {
      owner: 'ops_owner_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      workspace: 'ops_ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      source: 'ops_src_cccccccccccccccccccccccccccccccc',
      run: 'ops_run_dddddddddddddddddddddddddddddddd',
      request: 'ops_req_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    };

    expect(expiredWorkspaceSeedSql(ids, '2026-09-09T00:00:00.000Z')).toContain('ops_expiry_drill');
    expect(timeoutSeedSql(ids, '2026-09-09T00:00:00.000Z')).toContain("'running', 'live'");
    expect(cleanupWorkspaceSql(ids.workspace, ids.owner)).toContain('NOT EXISTS (SELECT 1 FROM budget_ledger');
    expect(workspaceRemainingSql(ids.workspace)).toContain('COUNT(*) AS remaining');
    expect(() => timeoutSeedSql({ ...ids, run: 'run_user_supplied' }, '2026-09-09T00:00:00.000Z')).toThrow('unsafe_test_id');
    expect(() => cleanupWorkspaceSql("ops_ws_bad'; DROP TABLE workspaces; --", ids.owner)).toThrow('unsafe_test_id');
  });

  it('surfaces remote schema mismatches as explicit warnings', () => {
    expect(readOnlyProbeWarnings([
      { results: [{ check_name: 'required_tables', observed: 10, expected: 10 }] },
      { results: [{ check_name: 'run_provenance_column', observed: 0, expected: 1 }] },
      { results: [{ check_name: 'storage_singletons', storage_policy_rows: 1, storage_usage_rows: 0 }] },
    ])).toEqual([
      'run_provenance_column_mismatch:0_of_1',
      'storage_usage_singleton_mismatch:0',
    ]);
  });

  it('does not execute probes when pinned staging config is wrong', async () => {
    let executed = false;
    const report = await runDrill({ ...baseOptions, mode: 'read-only' }, {
      readConfig: async () => ({ env: { staging: { ...goodConfig.env.staging, name: 'other-worker' } } }),
      executeD1: async () => {
        executed = true;
        return [];
      },
    });

    expect(executed).toBe(false);
    expect(report.errors).toContain('staging_worker_mismatch');
  });

  it('fails an expiry drill when cron observation is unsuccessful, then still verifies cleanup', async () => {
    const calls: string[] = [];
    const report = await runDrill({ ...baseOptions, mode: 'expiry', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      now: () => '2026-09-09T00:00:00.000Z',
      observe: async () => ({ ...successfulObservation, stoppedAfterCron: false, errors: ['tail_failed'] }),
      executeD1: async (sql) => {
        calls.push(sql);
        if (sql.includes('owned_workspace')) return [{ results: [{ check_name: 'owned_workspace', workspace_rows: 1, source_rows: 1, owner_rows: 1 }] }];
        if (sql.includes('COUNT(*) AS remaining')) return [{ results: [{ remaining: 1 }] }];
        if (sql.includes('cleanup')) return [{ results: [{ check_name: 'cleanup', workspace_rows: 0, owner_rows: 0 }] }];
        return [{ results: [] }];
      },
    });

    expect(report.errors).toContain('cron_observation_errors');
    expect(report.errors).not.toContain('cleanup_unverified');
    expect(report.cleanup.verified).toBe(true);
    expect(calls.some((sql) => sql.includes('DELETE FROM owners'))).toBe(true);
  });

  it('fails an expiry drill when the owned workspace remains after cron', async () => {
    const report = await runDrill({ ...baseOptions, mode: 'expiry', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      now: () => '2026-09-09T00:00:00.000Z',
      observe: async () => successfulObservation,
      executeD1: async (sql) => {
        if (sql.includes('owned_workspace')) return [{ results: [{ check_name: 'owned_workspace', workspace_rows: 1, source_rows: 1, owner_rows: 1 }] }];
        if (sql.includes('COUNT(*) AS remaining')) return [{ results: [{ remaining: 1 }] }];
        if (sql.includes('cleanup')) return [{ results: [{ check_name: 'cleanup', workspace_rows: 0, owner_rows: 0 }] }];
        return [{ results: [] }];
      },
    });

    expect(report.errors).toContain('expired_workspace_remaining');
    expect(report.cleanup.verified).toBe(true);
  });

  it('fails a timeout drill when cron recovery telemetry is not completed even if the row state is correct', async () => {
    const failedCronObservation = {
      ...successfulObservation,
      samples: [{
        invocation: { type: 'scheduled' as const, outcome: 'ok', observedAt: '2026-09-09T00:00:01.000Z' },
        telemetry: [{ event: 'cron_recovery' as const, outcome: 'failed', timedOutRuns: 1, expiredWorkspaces: 0, pendingRuns: 0, redispatchedRuns: 0, failedRedispatches: 0, durationMs: 12 }],
      }],
    };
    const report = await runDrill({ ...baseOptions, mode: 'timeout', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      now: () => '2026-09-09T00:00:00.000Z',
      observe: async () => failedCronObservation,
      executeD1: async (sql) => {
        if (sql.includes('owned_workspace')) return [{ results: [{ check_name: 'owned_workspace', workspace_rows: 1, source_rows: 1, owner_rows: 1 }] }];
        if (sql.includes('GROUP BY status')) return [{ results: [{ status: 'uncertain', count: 1 }] }];
        if (sql.includes('cleanup')) return [{ results: [{ check_name: 'cleanup', workspace_rows: 0, owner_rows: 0 }] }];
        return [{ results: [] }];
      },
    });

    expect(report.errors).toContain('cron_recovery_outcome_not_completed');
    expect(report.errors).not.toContain('run_status_mismatch');
    expect(report.cleanup.verified).toBe(true);
  });

  it('fails a timeout drill on wrong run status and cleanup execution errors without leaking raw transport details', async () => {
    const report = await runDrill({ ...baseOptions, mode: 'timeout', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      now: () => '2026-09-09T00:00:00.000Z',
      observe: async () => successfulObservation,
      executeD1: async (sql, mutates) => {
        if (sql.includes('owned_workspace')) return [{ results: [{ check_name: 'owned_workspace', workspace_rows: 1, source_rows: 1, owner_rows: 1 }] }];
        if (sql.includes('GROUP BY status')) return [{ results: [{ status: 'running', count: 1 }] }];
        if (sql.includes('DELETE FROM workspaces') && mutates) throw new Error('raw provider details must not leak');
        if (sql.includes('cleanup')) return [{ results: [{ check_name: 'cleanup', workspace_rows: 1, owner_rows: 1 }] }];
        return [{ results: [] }];
      },
    });

    expect(report.errors).toEqual(expect.arrayContaining(['run_status_mismatch', 'cleanup_execute_failed', 'cleanup_unverified']));
    expect(JSON.stringify(report)).not.toContain('raw provider details');
  });

  it('documents the paid-call and compatible-rollback boundaries', () => {
    const plan = buildPlan('staging');
    expect(JSON.stringify(plan)).toContain('paid model call');
    expect(JSON.stringify(plan)).toContain('external recipient');
    expect(JSON.stringify(plan)).toContain('verified compatible Worker version');
  });
});
