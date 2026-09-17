import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkspaceView } from '../src/core/contracts';
import { parseJsonc } from './deploy-readiness';
import { STAGING_ORIGIN } from './staging-live-smoke';

type Target = 'staging';
type Mode = 'plan' | 'rehearsal';
type SafeJson = string | number | boolean | null | SafeJson[] | { [key: string]: SafeJson };
type D1Rows = Record<string, SafeJson>[];
type DeploymentProof = { versionId: string; percentage: number; found: boolean };
type VersionMetadataProof = { versionId: string; found: boolean; bindingsAvailable: boolean; bindingCount: number; compatibilityDate: string | null };
type PrepareFailureKind = 'terminal' | 'deferred';

export type RollbackDrillOptions = {
  target: Target;
  mode: Mode;
  allowRemoteMutation: boolean;
  baseUrl: string;
};

export type CapturedFetch = { fetch: typeof fetch; cookie: () => string | null };

export type PreparedWorkspace = {
  workspaceId: string;
  runId: string;
  artifactPath: string | null;
  cleanup: () => Promise<boolean>;
};

export type RollbackDrillReport = {
  schema: 'ieojim.staging-rollback-drill.v1';
  target: Target;
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  remoteMutationAllowed: boolean;
  pinnedVersions: typeof pinnedVersions;
  checks: Record<string, SafeJson>;
  warnings: string[];
  errors: string[];
  artifacts: string[];
  fixture: { workspaceId: string | null; runId: string | null; cleanupDeferred: boolean };
  restore: { attempted: boolean; verified: boolean | null };
  cleanup: { attempted: boolean; verified: boolean | null };
  readinessVerified: boolean;
};

export type RollbackDrillDeps = {
  readConfig?: () => Promise<unknown>;
  prepareWorkspace?: (fetchState: CapturedFetch) => Promise<PreparedWorkspace>;
  rollback?: (versionId: string, message: string) => Promise<unknown>;
  executeD1?: (sql: string) => Promise<unknown>;
  readDeployments?: () => Promise<unknown>;
  readVersion?: (versionId: string) => Promise<unknown>;
  waitForDeployment?: (versionId: string) => Promise<DeploymentProof>;
  fetch?: typeof fetch;
  now?: () => string;
};

const require = createRequire(import.meta.url);
const artifactDir = 'artifacts';
const configPath = 'wrangler.jsonc';
const pollTimeoutMs = 90_000;
const pollIntervalMs = 2_000;
const deploymentPollTimeoutMs = 120_000;
const deploymentPollIntervalMs = 2_000;
const rollbackTimeoutMs = 45_000;
const sourceText = '참석자는 4명입니다. 공동 고정비는 총 900000원입니다. 고정비는 참석자가 똑같이 나눕니다.';

export const pinnedVersions = {
  accepted: '67ee7fe4-b11e-49fc-bdab-13803ee99db5',
  compatibleRollback: '0d84cbbe-9343-4468-847b-dd50870617ca',
  excludedInitial: '99448e0c',
} as const;

const expected = {
  accountId: 'd77fd515103009a324bebb3ac5b81fd9',
  workerName: 'ieojim-staging',
  d1Name: 'ieojim-staging',
  d1Id: '53421a70-d819-4ae6-9eb5-f558a119ea6b',
  queueName: 'ieojim-runs-staging',
  rateLimitNamespaceId: '26090901',
  baseUrl: STAGING_ORIGIN,
} as const;

export const buildRollbackDrillPlan = (): Record<string, SafeJson> => ({
  pinnedStagingConfig: expected,
  pinnedVersions,
  preflight: [
    'verify the local wrangler staging config points to the pinned account, worker, D1, queue, and origin',
    'verify the accepted Worker version is the current 100 percent deployment before any mutation',
    'verify the compatible rollback Worker version metadata and bindings are available before any mutation',
    'create and apply one live smoke workspace through the public API, retaining only safe ids',
    'verify revision, source revision, raw-text-free full snapshot fingerprint, typed calculations, expiry, and ledger aggregate before changing Worker versions',
  ],
  rehearsal: [
    'keep the smoke workspace alive under this runner for the full rollback and restore sequence',
    'rollback only to the verified same-schema compatible Worker version',
    'prove the compatible Worker version is deployed at 100 percent before reading application state',
    'verify the already-applied smoke workspace is still readable and its source revision, typed data fingerprint, expiry, and ledger counts are retained',
    'always rollback back to the accepted Worker version in finally, prove it is deployed at 100 percent, verify retained state again, then cleanup the smoke workspace',
  ],
  excluded: [
    'the initial 99448e0c line is intentionally excluded because it is not the verified compatible rollback target',
    'D1 rollback and Time Travel are not part of this Worker-version rehearsal',
    'cookies, owner tokens, raw source text, model payloads, and SQL result details are not written to the report',
  ],
});

export const rollbackCommand = (versionId: string, message: string): string[] => {
  assertPinnedVersion(versionId);
  const wranglerCli = require.resolve('wrangler');
  return [
    process.execPath,
    wranglerCli,
    'rollback',
    versionId,
    '--env',
    'staging',
    '--env-file',
    '.dev.vars.example',
    '--message',
    message,
    '--yes',
  ];
};

export const rollbackWithTimeout = (
  start: () => { done: Promise<unknown>; cancel: () => void },
  timeoutMs = rollbackTimeoutMs,
): Promise<unknown> => new Promise((resolve, reject) => {
  const operation = start();
  const timeout = setTimeout(() => {
    operation.cancel();
    reject(new Error('wrangler_rollback_timeout'));
  }, timeoutMs);
  operation.done.then(
    (value) => {
      clearTimeout(timeout);
      resolve(value);
    },
    (error: unknown) => {
      clearTimeout(timeout);
      reject(error);
    },
  );
});

export const rollbackLedgerSql = (workspaceId: string, runId: string): string => {
  assertSafeId(workspaceId, /^ws_[a-zA-Z0-9_-]+$/);
  assertSafeId(runId, /^run_[a-zA-Z0-9_-]+$/);
  return `
SELECT 'revision_state' AS check_name,
  (SELECT revision FROM workspaces WHERE id = ${sqlString(workspaceId)}) AS revision,
  (SELECT source_revision FROM workspaces WHERE id = ${sqlString(workspaceId)}) AS source_revision,
  (SELECT current_snapshot_revision FROM workspaces WHERE id = ${sqlString(workspaceId)}) AS current_snapshot_revision,
  (SELECT COUNT(*) FROM snapshots WHERE workspace_id = ${sqlString(workspaceId)}) AS snapshot_rows;
SELECT 'ledger_state' AS check_name,
  (SELECT COUNT(*) FROM budget_ledger WHERE workspace_id = ${sqlString(workspaceId)} AND run_id = ${sqlString(runId)} AND entry_type = 'reserve') AS reserve_rows,
  (SELECT COUNT(*) FROM budget_ledger WHERE workspace_id = ${sqlString(workspaceId)} AND run_id = ${sqlString(runId)} AND entry_type = 'actual') AS actual_rows,
  (SELECT COUNT(*) FROM budget_ledger WHERE workspace_id = ${sqlString(workspaceId)} AND run_id = ${sqlString(runId)} AND entry_type = 'policy_violation') AS policy_violation_rows;
`.trim();
};

export const validateRollbackStagingConfig = (config: unknown, baseUrl: string): string[] => {
  const errors: string[] = [];
  const root = asObject(config);
  const env = asObject(asObject(root?.env)?.staging);
  if (!env) return ['wrangler_staging_env_missing'];
  if (baseUrl !== expected.baseUrl) errors.push('staging_origin_mismatch');
  if (stringValue(env.account_id) !== expected.accountId) errors.push('staging_account_mismatch');
  if (stringValue(env.name) !== expected.workerName) errors.push('staging_worker_mismatch');
  const d1 = arrayOfObjects(env.d1_databases)[0];
  if (!d1 || stringValue(d1.database_name) !== expected.d1Name || stringValue(d1.database_id) !== expected.d1Id) errors.push('staging_d1_mismatch');
  const queues = asObject(env.queues);
  const producer = arrayOfObjects(queues?.producers)[0];
  const consumer = arrayOfObjects(queues?.consumers)[0];
  if (!producer || !consumer || stringValue(producer.queue) !== expected.queueName || stringValue(consumer.queue) !== expected.queueName) errors.push('staging_queue_mismatch');
  const limiter = arrayOfObjects(env.ratelimits).find((entry) => stringValue(entry.name) === 'PUBLIC_WRITES');
  if (stringValue(limiter?.namespace_id) !== expected.rateLimitNamespaceId) errors.push('staging_ratelimit_mismatch');
  return errors;
};

export const runRollbackDrill = async (options: RollbackDrillOptions, deps: RollbackDrillDeps = {}): Promise<RollbackDrillReport> => {
  const now = deps.now ?? (() => new Date().toISOString());
  const report = initialReport(options, now());
  const config = deps.readConfig ? await deps.readConfig() : parseJsonc(await readFile(configPath, 'utf8'));
  const configErrors = validateRollbackStagingConfig(config, options.baseUrl);
  if (configErrors.length > 0) {
    report.errors.push(...configErrors);
    report.finishedAt = now();
    return report;
  }

  try {
    if (options.mode === 'plan') {
      report.checks.plan = buildRollbackDrillPlan();
      report.warnings.push('plan_only_no_remote_calls');
    } else {
      requireMutation(options);
      await executeRollbackRehearsal(report, deps);
    }
  } catch (error) {
    report.errors.push(safeError(error));
  }

  report.restore.verified = report.restore.verified ?? false;
  report.cleanup.verified = report.cleanup.verified ?? false;
  report.readinessVerified = report.errors.length === 0 &&
    report.restore.verified === true &&
    report.cleanup.verified === true &&
    report.checks.compatible !== undefined;
  report.finishedAt = now();
  return report;
};

const executeRollbackRehearsal = async (report: RollbackDrillReport, deps: RollbackDrillDeps): Promise<void> => {
  const prepareWorkspace = deps.prepareWorkspace ?? ((fetchState: CapturedFetch) => prepareAppliedSmokeWorkspace(fetchState, {
    onWorkspace: (state) => {
      report.fixture.workspaceId = state.workspaceId;
      report.fixture.runId = state.runId;
    },
    onCleanupDeferred: () => {
      report.fixture.cleanupDeferred = true;
    },
  }));
  const rollback = deps.rollback ?? rollbackWorkerVersion;
  const executeD1 = deps.executeD1 ?? executeD1Default;
  const readDeployments = deps.readDeployments ?? readWorkerDeployments;
  const readVersion = deps.readVersion ?? readWorkerVersion;
  const waitForDeployment = deps.waitForDeployment ?? ((versionId) => waitForWorkerDeployment(versionId, readDeployments));
  const fetchState = captureOwnerCookie(deps.fetch ?? fetch);
  let prepared: PreparedWorkspace | null = null;
  let restored = false;

  try {
    const preflight = await verifyVersionPreflight(readDeployments, readVersion);
    report.checks.versionPreflight = preflight;
    prepared = await prepareWorkspace(fetchState);
    report.fixture.workspaceId = prepared.workspaceId;
    report.fixture.runId = prepared.runId;
    if (prepared.artifactPath) report.artifacts.push(prepared.artifactPath);
    const baseline = await verifyWorkspaceState('beforeRollback', prepared.workspaceId, prepared.runId, fetchState, executeD1, null);
    report.checks.beforeRollback = baseline.safe;

    try {
      await rollback(pinnedVersions.compatibleRollback, 'ieojim staging compatible rollback rehearsal');
      const compatibleDeployment = await waitForDeployment(pinnedVersions.compatibleRollback);
      report.checks.compatibleDeployment = compatibleDeployment;
      expectDeploymentProof(compatibleDeployment, pinnedVersions.compatibleRollback);
      const compatible = await verifyWorkspaceState('compatible', prepared.workspaceId, prepared.runId, fetchState, executeD1, baseline.state);
      report.checks.compatible = compatible.safe;
    } finally {
      report.restore.attempted = true;
      try {
        await rollback(pinnedVersions.accepted, 'ieojim staging restore accepted after rollback rehearsal');
        const acceptedDeployment = await waitForDeployment(pinnedVersions.accepted);
        report.checks.acceptedDeployment = acceptedDeployment;
        expectDeploymentProof(acceptedDeployment, pinnedVersions.accepted);
        const restoredState = await verifyWorkspaceState('restoredAccepted', prepared.workspaceId, prepared.runId, fetchState, executeD1, baseline.state);
        report.checks.restoredAccepted = restoredState.safe;
        report.restore.verified = true;
        restored = true;
      } catch {
        report.restore.verified = false;
        report.errors.push('accepted_restore_failed');
      }
    }
  } finally {
    if (prepared) await cleanupPreparedWorkspace(report, prepared);
  }

  if (!restored) throw new Error('accepted_restore_not_verified');
};

const prepareAppliedSmokeWorkspace = async (
  fetchState: CapturedFetch,
  hooks: { onWorkspace: (state: { workspaceId: string | null; runId: string | null }) => void; onCleanupDeferred: () => void },
): Promise<PreparedWorkspace> => {
  let workspaceId: string | null = null;
  let runId: string | null = null;
  try {
    const created = await requestJson<WorkspaceView>(fetchState, 'POST', '/api/workspaces', {
      title: `staging-rollback-drill-${Date.now()}`,
      purpose: '여행 경비 계획',
    });
    workspaceId = created.id;
    hooks.onWorkspace({ workspaceId, runId });
    if (!fetchState.cookie()) throw new PrepareError('owner_cookie_missing', 'terminal');

    const sourced = await requestJson<WorkspaceView>(fetchState, 'POST', `/api/workspaces/${workspaceId}/sources`, {
      title: '합성 롤백 리허설 입력',
      text: sourceText,
      relation: 'initial',
      targetSourceId: null,
      requestId: randomUUID(),
    }).catch((error: unknown) => {
      throw new PrepareError(safeError(error), 'terminal');
    });
    const sourceId = sourced.sources.at(-1)?.id ?? null;
    runId = sourced.runs.find((run) => run.sourceId === sourceId)?.id ?? sourced.runs[0]?.id ?? null;
    hooks.onWorkspace({ workspaceId, runId });
    if (!runId) throw new PrepareError('smoke_run_missing', 'terminal');

    const ready = await pollReady(fetchState, workspaceId, runId);
    if (!ready.pending) throw new PrepareError('pending_changeset_missing', 'terminal');
    await requestJson<WorkspaceView>(fetchState, 'POST', `/api/workspaces/${workspaceId}/apply`, {
      changeSetId: ready.pending.id,
      proposalRevision: ready.pending.proposalRevision,
      baseRevision: ready.revision,
      baseSourceRevision: ready.sourceRevision,
      requestId: randomUUID(),
      resolutions: [],
    });
    const applied = await requestJson<WorkspaceView>(fetchState, 'GET', `/api/workspaces/${workspaceId}`);
    if (applied.revision !== ready.revision + 1 || applied.pending !== null || !hasRequiredTypedState(applied)) throw new PrepareError('apply_verification_failed', 'terminal');

    const appliedWorkspaceId = workspaceId;
    return {
      workspaceId: appliedWorkspaceId,
      runId,
      artifactPath: null,
      cleanup: () => cleanupWorkspace(fetchState, appliedWorkspaceId),
    };
  } catch (error) {
    if (workspaceId && isTerminalPrepareFailure(error)) {
      await cleanupWorkspace(fetchState, workspaceId).catch(() => false);
    } else if (workspaceId) {
      hooks.onCleanupDeferred();
    }
    throw error;
  }
};

const pollReady = async (fetchState: CapturedFetch, workspaceId: string, runId: string): Promise<WorkspaceView> => {
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() <= deadline) {
    const view = await requestJson<WorkspaceView>(fetchState, 'GET', `/api/workspaces/${workspaceId}`);
    const run = view.runs.find((candidate) => candidate.id === runId);
    if (run?.status === 'ready' && view.pending) return view;
    if (run?.status === 'failed') throw new PrepareError('run_failed', 'terminal');
    if (run?.status === 'uncertain') throw new PrepareError('run_uncertain', 'terminal');
    if (run?.status === 'needs_input') throw new PrepareError('run_needs_input', 'terminal');
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new PrepareError('poll_timeout', 'deferred');
};

const cleanupPreparedWorkspace = async (report: RollbackDrillReport, prepared: PreparedWorkspace): Promise<void> => {
  report.cleanup.attempted = true;
  try {
    report.cleanup.verified = await prepared.cleanup();
  } catch {
    report.cleanup.verified = false;
    report.errors.push('cleanup_failed');
  }
  if (report.cleanup.verified !== true) report.errors.push('cleanup_unverified');
};

const verifyWorkspaceState = async (
  label: string,
  workspaceId: string,
  runId: string,
  fetchState: CapturedFetch,
  executeD1: NonNullable<RollbackDrillDeps['executeD1']>,
  baseline: RetainedState | null,
): Promise<{ state: RetainedState; safe: SafeJson }> => {
  const view = await fetchWorkspace(fetchState, workspaceId);
  const ledger = await executeD1(rollbackLedgerSql(workspaceId, runId));
  const state = retainedState(view, ledger);
  const comparisons = compareRetainedState(state, baseline ?? state);
  if (comparisons.length > 0) throw new Error(`${label}_state_not_retained`);
  return { state, safe: safeState(state, comparisons) };
};

const verifyVersionPreflight = async (
  readDeployments: NonNullable<RollbackDrillDeps['readDeployments']>,
  readVersion: NonNullable<RollbackDrillDeps['readVersion']>,
): Promise<SafeJson> => {
  const accepted = deploymentProof(await readDeployments(), pinnedVersions.accepted);
  expectDeploymentProof(accepted, pinnedVersions.accepted);
  const compatibleVersion = await readVersion(pinnedVersions.compatibleRollback);
  const compatible = versionMetadataProof(compatibleVersion, pinnedVersions.compatibleRollback);
  if (!compatible.found) throw new Error('compatible_version_metadata_missing');
  if (!compatible.bindingsAvailable) throw new Error('compatible_version_bindings_missing');
  return {
    acceptedDeployment: accepted,
    compatibleVersion: compatible,
  };
};

const captureOwnerCookie = (fetchImpl: typeof fetch): CapturedFetch => {
  let cookie: string | null = null;
  return {
    fetch: (async (input, init) => {
      const response = await fetchImpl(input, init);
      const nextCookie = response.headers.get('set-cookie')?.split(';')[0] ?? null;
      if (nextCookie) cookie = nextCookie;
      return response;
    }) as typeof fetch,
    cookie: () => cookie,
  };
};

const fetchWorkspace = async (fetchState: CapturedFetch, workspaceId: string): Promise<WorkspaceView> =>
  requestJson<WorkspaceView>(fetchState, 'GET', `/api/workspaces/${workspaceId}`);

type RetainedState = {
  revision: number;
  sourceRevision: number;
  facts: number;
  blocks: number;
  items: number;
  pending: boolean;
  expiresAtMs: number;
  d1Revision: number | null;
  d1SourceRevision: number | null;
  d1SnapshotRows: number | null;
  reserveRows: number | null;
  actualRows: number | null;
  policyViolationRows: number | null;
  snapshotFingerprint: string;
  hasTypedPerson4: boolean;
  hasTypedMoney900000: boolean;
  hasDivide225000: boolean;
};

const retainedState = (view: WorkspaceView, ledger: unknown): RetainedState => {
  const revision = d1Rows(ledger).find((row) => row.check_name === 'revision_state');
  const ledgerState = d1Rows(ledger).find((row) => row.check_name === 'ledger_state');
  return {
    revision: view.revision,
    sourceRevision: view.sourceRevision,
    facts: view.snapshot.facts.length,
    blocks: view.snapshot.blocks.length,
    items: view.snapshot.blocks.reduce((total, block) => total + block.items.length, 0),
    pending: view.pending !== null,
    expiresAtMs: Date.parse(view.expiresAt),
    d1Revision: numberOrNull(revision?.revision),
    d1SourceRevision: numberOrNull(revision?.source_revision),
    d1SnapshotRows: numberOrNull(revision?.snapshot_rows),
    reserveRows: numberOrNull(ledgerState?.reserve_rows),
    actualRows: numberOrNull(ledgerState?.actual_rows),
    policyViolationRows: numberOrNull(ledgerState?.policy_violation_rows),
    snapshotFingerprint: snapshotFingerprint(view),
    hasTypedPerson4: view.snapshot.facts.some((fact) => fact.value === 4 && fact.semantic?.kind === 'count' && fact.semantic.unit === 'person'),
    hasTypedMoney900000: view.snapshot.facts.some((fact) => fact.value === 900000 && fact.semantic?.kind === 'money' && fact.semantic.unit === 'KRW'),
    hasDivide225000: hasRequiredDivideItem(view),
  };
};

const compareRetainedState = (state: RetainedState, baseline: RetainedState): string[] => {
  const errors: string[] = [];
  for (const key of ['revision', 'sourceRevision', 'facts', 'blocks', 'items', 'pending', 'd1Revision', 'd1SourceRevision', 'd1SnapshotRows', 'reserveRows', 'actualRows', 'policyViolationRows', 'snapshotFingerprint'] as const) {
    if (state[key] !== baseline[key]) errors.push(`${key}_changed`);
  }
  if (!Number.isFinite(state.expiresAtMs) || state.expiresAtMs < baseline.expiresAtMs) errors.push('expiry_decreased');
  if (!hasCompleteRetainedState(state)) errors.push('workspace_state_incomplete');
  if (state.d1Revision !== state.revision || state.d1SourceRevision !== state.sourceRevision || (state.d1SnapshotRows ?? 0) < 1) errors.push('d1_revision_mismatch');
  if (state.reserveRows !== 1 || state.actualRows !== 1 || state.policyViolationRows !== 0) errors.push('ledger_mismatch');
  return errors;
};

const safeState = (state: RetainedState, comparisons: string[]): SafeJson => ({
  revision: state.revision,
  sourceRevision: state.sourceRevision,
  factCount: state.facts,
  blockCount: state.blocks,
  itemCount: state.items,
  pending: state.pending,
  expiryRetained: true,
  d1RevisionMatchesApi: state.d1Revision === state.revision && state.d1SourceRevision === state.sourceRevision,
  snapshotRows: state.d1SnapshotRows,
  reserveRows: state.reserveRows,
  actualRows: state.actualRows,
  policyViolationRows: state.policyViolationRows,
  snapshotFingerprint: state.snapshotFingerprint,
  hasTypedPerson4: state.hasTypedPerson4,
  hasTypedMoney900000: state.hasTypedMoney900000,
  hasDivide225000: state.hasDivide225000,
  retained: comparisons.length === 0,
});

const requestJson = async <T>(fetchState: CapturedFetch, method: string, path: string, body?: unknown): Promise<T> => {
  const response = await request(fetchState, method, path, body, [200, 201]);
  return response.json() as Promise<T>;
};

const requestEmpty = async (fetchState: CapturedFetch, method: string, path: string, allowedStatuses: number[]): Promise<Response> =>
  request(fetchState, method, path, undefined, allowedStatuses);

const request = async (fetchState: CapturedFetch, method: string, path: string, body: unknown, allowedStatuses: number[]): Promise<Response> => {
  const cookie = fetchState.cookie();
  const response = await fetchState.fetch(`${STAGING_ORIGIN}${path}`, {
    method,
    headers: {
      Origin: STAGING_ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!allowedStatuses.includes(response.status)) throw new Error(`http_error:${response.status}`);
  return response;
};

const rollbackWorkerVersion = (versionId: string, message: string): Promise<unknown> => {
  const [command, ...args] = rollbackCommand(versionId, message);
  return rollbackWithTimeout(() => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    return {
      cancel: () => {
        child.kill('SIGTERM');
      },
      done: new Promise((resolve, reject) => {
        child.on('error', () => reject(new Error('wrangler_rollback_spawn_failed')));
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`wrangler_rollback_failed:${code ?? 'signal'}`));
          else resolve({ ok: true });
        });
      }),
    };
  });
};

const readWorkerDeployments = (): Promise<unknown> => runWranglerJson(['deployments', 'status', '--env', 'staging', '--env-file', '.dev.vars.example', '--json']);

const readWorkerVersion = (versionId: string): Promise<unknown> => {
  assertPinnedVersion(versionId);
  return runWranglerJson(['versions', 'view', versionId, '--env', 'staging', '--env-file', '.dev.vars.example', '--json']);
};

const waitForWorkerDeployment = async (
  versionId: string,
  readDeployments: NonNullable<RollbackDrillDeps['readDeployments']>,
): Promise<DeploymentProof> => {
  const deadline = Date.now() + deploymentPollTimeoutMs;
  while (Date.now() <= deadline) {
    const proof = deploymentProof(await readDeployments(), versionId);
    if (proof.found && proof.percentage === 100) return proof;
    await delay(Math.min(deploymentPollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error('deployment_version_timeout');
};

const runWranglerJson = (args: string[]): Promise<unknown> => new Promise((resolve, reject) => {
  const wranglerCli = require.resolve('wrangler');
  const child = spawn(process.execPath, [wranglerCli, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, killSignal: 'SIGKILL' });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stderr.resume();
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.on('error', () => reject(new Error('wrangler_json_spawn_failed')));
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new Error(`wrangler_json_failed:${code ?? 'signal'}`));
      return;
    }
    try {
      resolve(JSON.parse(stdout));
    } catch {
      reject(new Error('wrangler_json_parse_failed'));
    }
  });
});

const executeD1Default = (sql: string): Promise<unknown> => new Promise((resolve, reject) => {
  const wranglerCli = require.resolve('wrangler');
  const child = spawn(process.execPath, [
    wranglerCli,
    'd1',
    'execute',
    'DB',
    '--env',
    'staging',
    '--remote',
    '--json',
    '--env-file',
    '.dev.vars.example',
    '--command',
    sql,
  ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, killSignal: 'SIGKILL' });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stderr.resume();
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.on('error', () => reject(new Error('wrangler_d1_spawn_failed')));
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new Error(`wrangler_d1_execute_failed:${code ?? 'signal'}`));
      return;
    }
    try {
      resolve(JSON.parse(stdout));
    } catch {
      reject(new Error('wrangler_d1_json_parse_failed'));
    }
  });
});

const run = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const report = await runRollbackDrill(options);
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, `staging-rollback-drill-${options.mode}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outputPath: path, mode: report.mode, warnings: report.warnings, errors: report.errors, restore: report.restore, cleanup: report.cleanup, readinessVerified: report.readinessVerified }, null, 2));
  if (report.errors.length > 0 || !report.readinessVerified) process.exitCode = report.mode === 'plan' && report.errors.length === 0 ? 0 : 1;
};

const parseArgs = (args: string[]): RollbackDrillOptions => {
  let target: Target = 'staging';
  let mode: Mode = 'plan';
  let baseUrl: string = expected.baseUrl;
  let allowRemoteMutation = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--allow-remote-mutation') allowRemoteMutation = true;
    else if (arg.startsWith('--target=')) {
      const value = arg.slice('--target='.length);
      if (value !== 'staging') throw new Error('only_staging_supported');
      target = value;
    } else if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (!['plan', 'rehearsal'].includes(value)) throw new Error('invalid_mode');
      mode = value as Mode;
    } else if (arg === '--base-url') {
      baseUrl = normalizeBaseUrl(args[index + 1]);
      index += 1;
    }
  }
  return { target, mode, allowRemoteMutation, baseUrl };
};

const initialReport = (options: RollbackDrillOptions, now: string): RollbackDrillReport => ({
  schema: 'ieojim.staging-rollback-drill.v1',
  target: options.target,
  mode: options.mode,
  startedAt: now,
  finishedAt: now,
  remoteMutationAllowed: options.allowRemoteMutation,
  pinnedVersions,
  checks: {},
  warnings: [],
  errors: [],
  artifacts: [],
  fixture: { workspaceId: null, runId: null, cleanupDeferred: false },
  restore: { attempted: false, verified: null },
  cleanup: { attempted: false, verified: null },
  readinessVerified: false,
});

const requireMutation = (options: RollbackDrillOptions): void => {
  if (!options.allowRemoteMutation) throw new Error('remote_mutation_not_allowed');
};

const assertPinnedVersion = (versionId: string): void => {
  if (versionId !== pinnedVersions.accepted && versionId !== pinnedVersions.compatibleRollback) throw new Error('unpinned_rollback_version');
};

const assertSafeId = (value: string, pattern: RegExp): void => {
  if (!pattern.test(value)) throw new Error('unsafe_id');
};

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const d1Rows = (value: unknown): D1Rows => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((statement) => {
    if (!isRecord(statement) || !Array.isArray(statement.results)) return [];
    return statement.results.flatMap((row) => isRecord(row) ? [row as Record<string, SafeJson>] : []);
  });
};

const numberOrNull = (value: unknown): number | null => typeof value === 'number' ? value : null;

const cleanupWorkspace = async (fetchState: CapturedFetch, workspaceId: string): Promise<boolean> => {
  await requestEmpty(fetchState, 'DELETE', `/api/workspaces/${workspaceId}`, [204, 404]);
  const deleted = await requestEmpty(fetchState, 'GET', `/api/workspaces/${workspaceId}`, [404]);
  return deleted.status === 404;
};

class PrepareError extends Error {
  constructor(message: string, public kind: PrepareFailureKind) {
    super(message);
    this.name = 'PrepareError';
  }
}

const isTerminalPrepareFailure = (error: unknown): boolean =>
  error instanceof PrepareError && error.kind === 'terminal';

const hasRequiredTypedState = (view: WorkspaceView): boolean => {
  const state = retainedState(view, []);
  return hasCompleteRetainedState(state);
};

const hasCompleteRetainedState = (state: RetainedState): boolean =>
  state.revision >= 1 &&
  state.sourceRevision >= 1 &&
  state.facts >= 1 &&
  state.items >= 1 &&
  state.hasTypedPerson4 &&
  state.hasTypedMoney900000 &&
  state.hasDivide225000;

const snapshotFingerprint = (view: WorkspaceView): string => {
  const snapshot = {
    facts: view.snapshot.facts
      .map((fact) => ({
        id: fact.id,
        key: fact.key,
        label: fact.label,
        value: fact.value,
        semantic: fact.semantic ?? null,
        evidence: fact.evidence,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    blocks: view.snapshot.blocks
    .map((block) => ({
      id: block.id,
      key: block.key,
      title: block.title,
      type: block.type,
      items: block.items
        .map((item) => ({
          id: item.id,
          key: item.key,
          label: item.label,
          value: item.value,
          factKeys: [...item.factKeys].sort(),
          valueFactKey: item.valueFactKey,
          calculation: item.calculation,
          completed: item.completed,
          locked: item.locked,
          edited: item.edited,
          stale: item.stale,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
};

const hasRequiredDivideItem = (view: WorkspaceView): boolean => {
  const moneyKey = view.snapshot.facts.find((fact) => fact.value === 900000 && fact.semantic?.kind === 'money' && fact.semantic.unit === 'KRW')?.key;
  const personKey = view.snapshot.facts.find((fact) => fact.value === 4 && fact.semantic?.kind === 'count' && fact.semantic.unit === 'person')?.key;
  if (!moneyKey || !personKey) return false;
  return view.snapshot.blocks.flatMap((block) => block.items).some((item) =>
    item.value === '225000' &&
    (item.valueFactKey === null || item.factKeys.includes(item.valueFactKey)) &&
    item.factKeys.includes(moneyKey) &&
    item.factKeys.includes(personKey) &&
    item.calculation?.kind === 'divide' &&
    item.calculation.totalFactKey === moneyKey &&
    item.calculation.divisorFactKey === personKey);
};

const deploymentProof = (value: unknown, versionId: string): DeploymentProof => {
  const candidates = deploymentVersionCandidates(value);
  const match = candidates.find((candidate) => candidate.versionId === versionId && candidate.percentage === 100);
  return match ?? { versionId, percentage: 0, found: false };
};

const deploymentVersionCandidates = (value: unknown): DeploymentProof[] => {
  const root = unwrapApiResult(value);
  const rootObject = asObject(root);
  const deployments = rootObject && Array.isArray(rootObject.versions) ? [rootObject] : [];
  return deployments.flatMap((deployment) => {
    const deploymentObj = asObject(deployment);
    const versions = arrayValue(deploymentObj?.versions);
    return versions.flatMap((entry) => {
      const obj = asObject(entry);
      const version = asObject(obj?.version);
      const versionId = stringValue(obj?.version_id) ?? stringValue(version?.id) ?? stringValue(obj?.id);
      const percentage = numberValue(obj?.percentage);
      return versionId && percentage !== null ? [{ versionId, percentage, found: true }] : [];
    });
  });
};

const versionMetadataProof = (value: unknown, versionId: string): VersionMetadataProof => {
  const result = asObject(unwrapApiResult(value));
  const resources = asObject(result?.resources);
  const bindings = arrayValue(resources?.bindings);
  const bindingNames = new Set(bindings.map((binding) => stringValue(asObject(binding)?.name)));
  return {
    versionId,
    found: stringValue(result?.id) === versionId || stringValue(result?.version_id) === versionId,
    bindingsAvailable: ['DB', 'RUN_QUEUE', 'GEMINI_API_KEY', 'ASSETS', 'PUBLIC_WRITES'].every((name) => bindingNames.has(name)),
    bindingCount: bindings.length,
    compatibilityDate: stringValue(asObject(resources?.script_runtime)?.compatibility_date),
  };
};

const expectDeploymentProof = (proof: DeploymentProof, versionId: string): void => {
  if (!proof.found || proof.versionId !== versionId || proof.percentage !== 100) throw new Error('deployment_version_not_100_percent');
};

const unwrapApiResult = (value: unknown): unknown => {
  const root = asObject(value);
  return root && 'result' in root ? root.result : value;
};

const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const numberValue = (value: unknown): number | null => typeof value === 'number' ? value : null;

const normalizeBaseUrl = (value: string | undefined): string => {
  if (!value) throw new Error('base_url_missing');
  const url = new URL(value);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
};

const safeError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'rollback_drill_failed';
  if (/^[a-z0-9_]+(?::[a-z0-9_]+)?$/i.test(error.message)) return error.message;
  return 'rollback_drill_failed';
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const arrayOfObjects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.flatMap((entry) => asObject(entry) ? [entry as Record<string, unknown>] : []) : [];

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().catch((error: unknown) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
