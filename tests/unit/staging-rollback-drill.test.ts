import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceView } from '../../src/core/contracts';
import {
  buildRollbackDrillPlan,
  type CapturedFetch,
  type PreparedWorkspace,
  pinnedVersions,
  rollbackCommand,
  rollbackLedgerSql,
  rollbackWithTimeout,
  runRollbackDrill,
  validateRollbackStagingConfig,
} from '../../scripts/staging-rollback-drill';
import { STAGING_ORIGIN } from '../../scripts/staging-live-smoke';

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

const baseOptions = {
  target: 'staging' as const,
  mode: 'plan' as const,
  allowRemoteMutation: false,
  baseUrl: STAGING_ORIGIN,
};

const workspace = (overrides: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id: 'ws_rollback_smoke',
  title: 'rollback smoke',
  purpose: '여행 경비 계획',
  sampleScenario: null,
  revision: 1,
  sourceRevision: 1,
  sources: [],
  snapshot: {
    facts: [{
      id: 'fact:participants',
      key: 'participants',
      label: '참석자 수',
      value: 4,
      evidence: { sourceId: 'src_rollback_smoke', quote: '참석자는 4명입니다.', start: 0, end: 11 },
      semantic: { kind: 'count', unit: 'person' },
    }, {
      id: 'fact:fixed_total_cost',
      key: 'fixed_total_cost',
      label: '공동 고정비',
      value: 900000,
      evidence: { sourceId: 'src_rollback_smoke', quote: '공동 고정비는 총 900000원입니다.', start: 12, end: 31 },
      semantic: { kind: 'money', unit: 'KRW' },
    }],
    blocks: [{
      id: 'block:cost',
      key: 'cost',
      type: 'cost',
      title: '비용',
      items: [{
        id: 'item:share',
        key: 'share',
        label: '1인당 비용',
        value: '225000',
        factKeys: ['fixed_total_cost', 'participants'],
        valueFactKey: 'fixed_total_cost',
        calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participants' },
        completed: false,
        locked: false,
        edited: false,
        stale: false,
      }],
    }],
  },
  pending: null,
  runs: [{ id: 'run_rollback_smoke', sourceId: 'src_rollback_smoke', status: 'applied', error: null, createdAt: '2026-09-09T00:00:00.000Z', costMicroUsd: 100, mode: 'live' }],
  history: [{ revision: 1, createdAt: '2026-09-09T00:00:01.000Z', reason: 'apply' }],
  expiresAt: '2026-09-16T00:00:00.000Z',
  ...overrides,
});

const ledgerRows = (overrides: Record<string, number> = {}) => [
  { results: [{ check_name: 'revision_state', revision: 1, source_revision: 1, current_snapshot_revision: 1, snapshot_rows: 2 }] },
  { results: [{ check_name: 'ledger_state', reserve_rows: 1, actual_rows: 1, policy_violation_rows: 0, ...overrides }] },
];

describe('staging rollback drill', () => {
  it('documents pinned compatible rollback boundaries and excludes the initial unsafe version', () => {
    const plan = buildRollbackDrillPlan();

    expect(JSON.stringify(plan)).toContain(pinnedVersions.accepted);
    expect(JSON.stringify(plan)).toContain(pinnedVersions.compatibleRollback);
    expect(JSON.stringify(plan)).toContain('99448e0c');
    expect(JSON.stringify(plan)).toContain('D1 rollback');
  });

  it('pins staging account, worker, D1, Queue, limiter, and origin before remote work', () => {
    expect(validateRollbackStagingConfig(goodConfig, STAGING_ORIGIN)).toEqual([]);
    expect(validateRollbackStagingConfig(goodConfig, 'https://evil.example.test')).toContain('staging_origin_mismatch');
    expect(validateRollbackStagingConfig({ env: { staging: { ...goodConfig.env.staging, name: 'other-worker' } } }, STAGING_ORIGIN)).toContain('staging_worker_mismatch');
  });

  it('generates only pinned rollback commands and rejects the excluded initial version', () => {
    expect(rollbackCommand(pinnedVersions.compatibleRollback, 'compatible rehearsal')).toEqual(expect.arrayContaining([
      'rollback',
      pinnedVersions.compatibleRollback,
      '--env',
      'staging',
      '--env-file',
      '.dev.vars.example',
      '--yes',
    ]));
    expect(() => rollbackCommand(pinnedVersions.excludedInitial, 'unsafe')).toThrow('unpinned_rollback_version');
  });

  it('cancels a hung rollback operation with a fixed safe timeout error', async () => {
    const cancel = vi.fn();

    await expect(rollbackWithTimeout(() => ({
      cancel,
      done: new Promise(() => undefined),
    }), 10)).rejects.toThrow('wrangler_rollback_timeout');

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('builds ledger verification SQL without selecting private source, token, snapshot, or provider payload fields', () => {
    const sql = rollbackLedgerSql('ws_rollback_smoke', 'run_rollback_smoke');

    expect(sql).toContain('revision_state');
    expect(sql).toContain('ledger_state');
    expect(sql).not.toMatch(/\btext\b/i);
    expect(sql).not.toContain('token_hash');
    expect(sql).not.toContain('snapshot_json');
    expect(sql).not.toContain('response_json');
    expect(() => rollbackLedgerSql("ws_bad'; DROP TABLE workspaces; --", 'run_rollback_smoke')).toThrow('unsafe_id');
  });

  it('does not run smoke or rollback work when staging config mismatches', async () => {
    const prepareWorkspace = vi.fn(preparedWorkspace());
    const rollback = vi.fn();
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => ({ env: { staging: { ...goodConfig.env.staging, account_id: 'bad' } } }),
      prepareWorkspace,
      rollback,
    });

    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(report.errors).toContain('staging_account_mismatch');
    expect(report.readinessVerified).toBe(false);
  });

  it('does not prepare a workspace when accepted deployment preflight is not 100 percent', async () => {
    const prepareWorkspace = vi.fn();
    const rollback = vi.fn();
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      readDeployments: async () => ({ result: [{ versions: [{ version_id: pinnedVersions.accepted, percentage: 50 }] }] }),
      readVersion: async (versionId: string) => versionMetadata(versionId),
      prepareWorkspace,
      rollback,
    });

    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(report.errors).toContain('deployment_version_not_100_percent');
    expect(report.fixture).toMatchObject({ workspaceId: null, runId: null, cleanupDeferred: false });
  });

  it('accepts the real wrangler deployments status single-object shape', async () => {
    const prepareWorkspace = vi.fn();
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      readDeployments: async () => ({ id: 'deployment_current', versions: [{ version_id: pinnedVersions.accepted, percentage: 100 }] }),
      readVersion: async (versionId: string) => versionMetadata(versionId),
      prepareWorkspace,
      rollback: async () => {
        throw new Error('stopafterpreflight');
      },
      executeD1: async () => ledgerRows(),
      fetch: async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/workspaces/create-cookie')) {
          return Response.json({}, { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } });
        }
        return Response.json(workspace(), { status: 200 });
      },
    });

    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(report.checks.versionPreflight).toMatchObject({ acceptedDeployment: { versionId: pinnedVersions.accepted, percentage: 100, found: true } });
  });

  it('does not treat a historical deployments list entry as current accepted 100 percent proof', async () => {
    const prepareWorkspace = vi.fn();
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      readDeployments: async () => ({ result: { deployments: [{ id: 'old', versions: [{ version_id: pinnedVersions.accepted, percentage: 100 }] }] } }),
      readVersion: async (versionId: string) => versionMetadata(versionId),
      prepareWorkspace,
    });

    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(report.errors).toContain('deployment_version_not_100_percent');
  });

  it.each([{ bindingNames: [] }, { bindingNames: ['DB'] }])('rejects incomplete compatible version bindings ($bindingNames)', async ({ bindingNames }) => {
    const prepareWorkspace = vi.fn();
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      readDeployments: async () => ({ id: 'deployment_current', versions: [{ version_id: pinnedVersions.accepted, percentage: 100 }] }),
      readVersion: async (versionId: string) => versionMetadata(versionId, bindingNames),
      prepareWorkspace,
    });

    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(report.errors).toContain('compatible_version_bindings_missing');
  });

  it('rejects rehearsal mode unless remote mutation is explicitly allowed', async () => {
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal' }, {
      readConfig: async () => goodConfig,
    });

    expect(report.errors).toContain('remote_mutation_not_allowed');
    expect(report.restore.attempted).toBe(false);
    expect(report.readinessVerified).toBe(false);
  });

  it('runs a mocked rollback rehearsal and restores accepted with safe retained-state checks', async () => {
    const rollbacks: string[] = [];
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/workspaces/create-cookie')) {
        return Response.json({}, { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } });
      }
      expect(new Headers(init?.headers).get('cookie')).toBe('ieojim_owner=private-owner');
      expect(String(input)).toBe(`${STAGING_ORIGIN}/api/workspaces/ws_rollback_smoke`);
      return Response.json(workspace(), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: fetchImpl,
      executeD1: async () => ledgerRows(),
      rollback: async (versionId) => {
        rollbacks.push(versionId);
        events.push(`rollback:${versionId}`);
        return { ok: true };
      },
      prepareWorkspace: preparedWorkspace(events),
    });

    expect(rollbacks).toEqual([pinnedVersions.compatibleRollback, pinnedVersions.accepted]);
    expect(events).toEqual([
      'prepare',
      `rollback:${pinnedVersions.compatibleRollback}`,
      `rollback:${pinnedVersions.accepted}`,
      'cleanup',
    ]);
    expect(report.errors).toEqual([]);
    expect(report.restore).toEqual({ attempted: true, verified: true });
    expect(report.cleanup).toEqual({ attempted: true, verified: true });
    expect(report.readinessVerified).toBe(true);
    expect(report.artifacts).toEqual(['artifacts/staging-rollback-smoke-safe.json']);
    expect(report.checks).toMatchObject({
      versionPreflight: { acceptedDeployment: { versionId: pinnedVersions.accepted, percentage: 100, found: true } },
      compatibleDeployment: { versionId: pinnedVersions.compatibleRollback, percentage: 100, found: true },
      acceptedDeployment: { versionId: pinnedVersions.accepted, percentage: 100, found: true },
      beforeRollback: { retained: true, revision: 1, reserveRows: 1, actualRows: 1 },
      compatible: { retained: true, hasTypedPerson4: true, hasTypedMoney900000: true, hasDivide225000: true },
      restoredAccepted: { retained: true },
    });
    expect(JSON.stringify(report)).not.toContain('ieojim_owner=private-owner');
    expect(JSON.stringify(report)).not.toContain('참석자는 4명입니다');
  });

  it.each([null, 'shared_cost_total', 'attendee_count'])('allows valid calculated item bindings with model-generated keys (%s)', async (valueFactKey) => {
    const renamed = workspace({
      snapshot: {
        ...workspace().snapshot,
        facts: workspace().snapshot.facts.map((fact) => fact.key === 'fixed_total_cost'
          ? { ...fact, key: 'shared_cost_total' }
          : fact.key === 'participants'
            ? { ...fact, key: 'attendee_count' }
            : fact),
        blocks: [{
          ...workspace().snapshot.blocks[0]!,
          items: [{
            ...workspace().snapshot.blocks[0]!.items[0]!,
            factKeys: ['shared_cost_total', 'attendee_count'],
            valueFactKey,
            calculation: { kind: 'divide', totalFactKey: 'shared_cost_total', divisorFactKey: 'attendee_count' },
          }],
        }],
      },
    });
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: async () => Response.json(renamed, { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } }),
      executeD1: async () => ledgerRows(),
      rollback: async () => ({ ok: true }),
      prepareWorkspace: preparedWorkspace(),
    });

    expect(report.errors).toEqual([]);
    expect(report.checks.compatible).toMatchObject({ hasDivide225000: true, retained: true });
    expect(report.readinessVerified).toBe(true);
  });

  it('always attempts accepted restore after compatible verification fails and does not claim readiness', async () => {
    const rollbacks: string[] = [];
    let d1Calls = 0;
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: async () => Response.json(workspace(), { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } }),
      executeD1: async () => {
        d1Calls += 1;
        return d1Calls === 2 ? ledgerRows({ actual_rows: 0 }) : ledgerRows();
      },
      rollback: async (versionId) => {
        rollbacks.push(versionId);
        return { ok: true };
      },
      prepareWorkspace: preparedWorkspace(),
    });

    expect(rollbacks).toEqual([pinnedVersions.compatibleRollback, pinnedVersions.accepted]);
    expect(report.restore).toEqual({ attempted: true, verified: true });
    expect(report.cleanup).toEqual({ attempted: true, verified: true });
    expect(report.errors).toContain('compatible_state_not_retained');
    expect(report.readinessVerified).toBe(false);
  });

  it('records restore failure separately and never marks readiness verified', async () => {
    const rollbacks: string[] = [];
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: async () => Response.json(workspace(), { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } }),
      executeD1: async () => ledgerRows(),
      rollback: async (versionId) => {
        rollbacks.push(versionId);
        if (versionId === pinnedVersions.accepted) throw new Error('raw provider restore detail');
        return { ok: true };
      },
      prepareWorkspace: preparedWorkspace(),
    });

    expect(rollbacks).toEqual([pinnedVersions.compatibleRollback, pinnedVersions.accepted]);
    expect(report.errors).toEqual(expect.arrayContaining(['accepted_restore_failed', 'accepted_restore_not_verified']));
    expect(report.restore).toEqual({ attempted: true, verified: false });
    expect(report.cleanup).toEqual({ attempted: true, verified: true });
    expect(report.readinessVerified).toBe(false);
    expect(JSON.stringify(report)).not.toContain('raw provider restore detail');
  });

  it('still restores accepted when the compatible rollback times out with unknown outcome', async () => {
    const rollbacks: string[] = [];
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: async () => Response.json(workspace(), { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } }),
      executeD1: async () => ledgerRows(),
      rollback: async (versionId) => {
        rollbacks.push(versionId);
        if (versionId === pinnedVersions.compatibleRollback) {
          await rollbackWithTimeout(() => ({ cancel: vi.fn(), done: new Promise(() => undefined) }), 10);
        }
        return { ok: true };
      },
      prepareWorkspace: preparedWorkspace(),
    });

    expect(rollbacks).toEqual([pinnedVersions.compatibleRollback, pinnedVersions.accepted]);
    expect(report.restore).toEqual({ attempted: true, verified: true });
    expect(report.errors).toContain('wrangler_rollback_timeout');
    expect(report.readinessVerified).toBe(false);
  });

  it('does not claim readiness when post-rollback deployment proof is missing', async () => {
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: async () => Response.json(workspace(), { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } }),
      executeD1: async () => ledgerRows(),
      rollback: async () => ({ ok: true }),
      waitForDeployment: async (versionId: string) => ({ versionId, percentage: versionId === pinnedVersions.compatibleRollback ? 50 : 100, found: true }),
      prepareWorkspace: preparedWorkspace(),
    });

    expect(report.restore).toEqual({ attempted: true, verified: true });
    expect(report.errors).toContain('deployment_version_not_100_percent');
    expect(report.readinessVerified).toBe(false);
  });

  it('fails retained-state verification when the typed calculation fingerprint changes', async () => {
    let fetches = 0;
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/workspaces/ws_rollback_smoke')) fetches += 1;
        const changed = fetches === 2
          ? workspace({ snapshot: { ...workspace().snapshot, blocks: [{ ...workspace().snapshot.blocks[0]!, items: [{ ...workspace().snapshot.blocks[0]!.items[0]!, valueFactKey: null }] }] } })
          : workspace();
        return Response.json(changed, { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } });
      },
      executeD1: async () => ledgerRows(),
      rollback: async () => ({ ok: true }),
      prepareWorkspace: preparedWorkspace(),
    });

    expect(report.restore).toEqual({ attempted: true, verified: true });
    expect(report.errors).toContain('compatible_state_not_retained');
    expect(report.readinessVerified).toBe(false);
  });

  it('fails retained-state verification when ids drift under the same counts and values', async () => {
    let fetches = 0;
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/workspaces/ws_rollback_smoke')) fetches += 1;
        const changed = fetches === 2
          ? workspace({ snapshot: { ...workspace().snapshot, facts: [{ ...workspace().snapshot.facts[0]!, id: 'fact:participants_changed' }, workspace().snapshot.facts[1]!] } })
          : workspace();
        return Response.json(changed, { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } });
      },
      executeD1: async () => ledgerRows(),
      rollback: async () => ({ ok: true }),
      prepareWorkspace: preparedWorkspace(),
    });

    expect(report.errors).toContain('compatible_state_not_retained');
    expect(report.readinessVerified).toBe(false);
  });

  it('fails retained-state verification when evidence drifts under the same counts and values', async () => {
    let fetches = 0;
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/workspaces/ws_rollback_smoke')) fetches += 1;
        const changed = fetches === 2
          ? workspace({ snapshot: { ...workspace().snapshot, facts: [{ ...workspace().snapshot.facts[0]!, evidence: { sourceId: 'src_rollback_smoke', quote: '다른 근거', start: 20, end: 25 } }, workspace().snapshot.facts[1]!] } })
          : workspace();
        return Response.json(changed, { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } });
      },
      executeD1: async () => ledgerRows(),
      rollback: async () => ({ ok: true }),
      prepareWorkspace: preparedWorkspace(),
    });

    expect(report.errors).toContain('compatible_state_not_retained');
    expect(report.readinessVerified).toBe(false);
  });

  it('does not claim readiness when cleanup after accepted restore is unverified', async () => {
    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: async () => Response.json(workspace(), { status: 200, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } }),
      executeD1: async () => ledgerRows(),
      rollback: async () => ({ ok: true }),
      prepareWorkspace: preparedWorkspace(undefined, false),
    });

    expect(report.restore).toEqual({ attempted: true, verified: true });
    expect(report.cleanup).toEqual({ attempted: true, verified: false });
    expect(report.errors).toContain('cleanup_unverified');
    expect(report.readinessVerified).toBe(false);
  });

  it('cleans up a default prepared workspace after a terminal source failure', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url });
      if (method === 'POST' && url.endsWith('/api/workspaces')) {
        return Response.json(workspace({ id: 'ws_terminal_prepare' }), { status: 201, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } });
      }
      if (method === 'POST' && url.endsWith('/api/workspaces/ws_terminal_prepare/sources')) {
        return Response.json({ error: { code: 'BAD_SOURCE' } }, { status: 422 });
      }
      if (method === 'DELETE' && url.endsWith('/api/workspaces/ws_terminal_prepare')) return new Response(null, { status: 204 });
      if (method === 'GET' && url.endsWith('/api/workspaces/ws_terminal_prepare')) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const report = await runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: fetchImpl,
      executeD1: async () => ledgerRows(),
      rollback: async () => ({ ok: true }),
    });

    expect(report.fixture).toMatchObject({ workspaceId: 'ws_terminal_prepare', runId: null, cleanupDeferred: false });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'DELETE', 'GET']);
    expect(report.errors).toContain('http_error:422');
  });

  it('records a default prepared workspace for deferred cleanup when polling times out', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url });
      if (method === 'POST' && url.endsWith('/api/workspaces')) {
        return Response.json(workspace({ id: 'ws_deferred_prepare', sourceRevision: 0, sources: [], runs: [] }), { status: 201, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } });
      }
      if (method === 'POST' && url.endsWith('/api/workspaces/ws_deferred_prepare/sources')) {
        return Response.json(workspace({ id: 'ws_deferred_prepare', runs: [{ id: 'run_deferred_prepare', sourceId: 'src_rollback_smoke', status: 'running', error: null, createdAt: '2026-09-09T00:00:00.000Z', costMicroUsd: null, mode: 'live' }] }));
      }
      if (method === 'GET' && url.endsWith('/api/workspaces/ws_deferred_prepare')) {
        return Response.json(workspace({ id: 'ws_deferred_prepare', pending: null, runs: [{ id: 'run_deferred_prepare', sourceId: 'src_rollback_smoke', status: 'running', error: null, createdAt: '2026-09-09T00:00:00.000Z', costMicroUsd: null, mode: 'live' }] }));
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const started = Date.now();
    vi.useFakeTimers();
    const promise = runRollbackDrill({ ...baseOptions, mode: 'rehearsal', allowRemoteMutation: true }, {
      readConfig: async () => goodConfig,
      ...preflightDeps(),
      fetch: fetchImpl,
      executeD1: async () => ledgerRows(),
      rollback: async () => ({ ok: true }),
    });
    await vi.advanceTimersByTimeAsync(91_000);
    vi.useRealTimers();
    const report = await promise;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.fixture).toMatchObject({ workspaceId: 'ws_deferred_prepare', runId: 'run_deferred_prepare', cleanupDeferred: true });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(report.errors).toContain('poll_timeout');
  });
});

function preflightDeps() {
  return {
    readDeployments: async () => ({ id: 'deployment_current', versions: [{ version_id: pinnedVersions.accepted, percentage: 100 }] }),
    readVersion: async (versionId: string) => versionMetadata(versionId),
    waitForDeployment: async (versionId: string) => ({ versionId, percentage: 100, found: true }),
  };
}

function preparedWorkspace(events: string[] = [], cleanupResult = true) {
  return async (fetchState: CapturedFetch): Promise<PreparedWorkspace> => {
    events.push('prepare');
    await fetchState.fetch(`${STAGING_ORIGIN}/api/workspaces/create-cookie`, { method: 'POST' });
    return {
      workspaceId: 'ws_rollback_smoke',
      runId: 'run_rollback_smoke',
      artifactPath: 'artifacts/staging-rollback-smoke-safe.json',
      cleanup: async () => {
        events.push('cleanup');
        return cleanupResult;
      },
    };
  };
}

function versionMetadata(id: string, bindingNames = ['DB', 'RUN_QUEUE', 'GEMINI_API_KEY', 'ASSETS', 'PUBLIC_WRITES']) {
  // Shape observed from wrangler versions view --json before any mutation.
  return { id, resources: { bindings: bindingNames.map((name) => ({ name })), script_runtime: { compatibility_date: '2026-09-07' } } };
}
