import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIMITS } from '../src/core/contracts';
import { parseJsonc } from './deploy-readiness';
import { createStagingAdminClient } from './staging-admin-client';
import {
  isScheduledCronProjection,
  JsonObjectStreamParser,
  projectTailEvent,
  retainObservationSample,
  type ObservationReport,
  type SafeProjection,
} from './observe-staging';

type Target = 'staging';
type Mode = 'plan' | 'read-only' | 'pending-redispatch';
type SafeJson = string | number | boolean | null | SafeJson[] | { [key: string]: SafeJson };
type D1Rows = Record<string, SafeJson>[];

type Options = {
  target: Target;
  mode: Mode;
  allowRemoteMutation: boolean;
  baseUrl: string;
  durationSeconds: number;
  duplicateMessages: number;
};

export type PendingDrillReport = {
  schema: 'ieojim.staging-pending-drill.v1';
  target: Target;
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  remoteMutationAllowed: boolean;
  testIds: Record<string, string>;
  checks: Record<string, SafeJson>;
  warnings: string[];
  errors: string[];
  cleanup: { attempted: boolean; verified: boolean | null; retainedLedger: boolean | null };
};

export type PendingDrillDeps = {
  readConfig?: () => Promise<unknown>;
  executeD1?: (sql: string, mutates: boolean) => Promise<unknown>;
  executeD1Batch?: (statements: string[], mutates: boolean) => Promise<unknown>;
  sendQueueMessage?: (runId: string) => Promise<unknown>;
  observeLifecycle?: (durationSeconds: number, runId: string, action: (controls: LifecycleControls) => Promise<void>) => Promise<ObservationReport>;
  now?: () => string;
};

export type LifecycleControls = {
  waitForCronRedispatch: () => Promise<void>;
  waitForClaimed: () => Promise<void>;
};

const require = createRequire(import.meta.url);
const artifactDir = 'artifacts';
const configPath = 'wrangler.jsonc';
const expected = {
  accountId: 'd77fd515103009a324bebb3ac5b81fd9',
  workerName: 'ieojim-staging',
  d1Name: 'ieojim-staging',
  d1Id: '53421a70-d819-4ae6-9eb5-f558a119ea6b',
  queueName: 'ieojim-runs-staging',
  queueId: 'eb92190445074d2b90db7adf668e4112',
  rateLimitNamespaceId: '26090901',
  dailyBudgetMicroUsd: '250000',
  totalBudgetMicroUsd: '1000000',
  ownerDailyRuns: '10',
  baseUrl: 'https://ieojim-staging.masondev1024.workers.dev',
} as const;
const maxDurationSeconds = 600;
const maxDuplicateMessages = 3;
const testIdPattern = /^ops_(owner|ws|src|run|req|led|guard)_[a-f0-9]{32}$/;

const sourceText = '참석자는 4명입니다. 공동 고정비는 총 900000원입니다. 고정비는 참석자가 똑같이 나눕니다.';

export const buildPendingDrillPlan = (): Record<string, SafeJson> => ({
  pinnedStagingConfig: expected,
  preflight: [
    'verify staging worker, account, D1, queue, queue id, and write-rate namespace are pinned',
    'read only aggregate rows and ops_* residue without selecting source text, snapshots, cookies, or provider payloads',
  ],
  pendingRedispatchDrill: [
    'insert one ops_* owner/workspace/source/snapshot/run with a reserve budget ledger in the same D1 mutation batch',
    'leave the run in live pending status so the scheduled handler exercises its production pendingRunIds redispatch path',
    'after cron redispatch, send bounded duplicate queue messages for the same run id',
    'verify queue lifecycle telemetry has exactly one claimed event and at least one skipped duplicate event for the owned run',
    'verify D1 has one reserve ledger and no more than one actual ledger for the owned run',
    'delete only the owned workspace; retain budget ledger rows for audit and verify no owned workspace/source/run rows remain',
  ],
  paidCallBoundary: 'When the live queue consumer is healthy this can make one Gemini call. It must be run only with --allow-remote-mutation and an explicit staging budget window.',
  observationWindow: 'Default 420 seconds, maximum 600 seconds, matching the staging five-minute cron schedule with a bounded grace period.',
});

export const pendingReadOnlySql = (): string => `
SELECT 'schema' AS check_name,
  (SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'provenance_json') AS provenance_columns,
  (SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table', 'view') AND name IN ('owners', 'workspaces', 'sources', 'snapshots', 'runs', 'budget_ledger', 'content_storage_totals')) AS required_objects;
SELECT 'ops_residue' AS check_name,
  (SELECT COUNT(*) FROM workspaces WHERE id LIKE 'ops_ws_%') AS ops_workspaces,
  (SELECT COUNT(*) FROM runs WHERE id LIKE 'ops_run_%') AS ops_runs,
  (SELECT COUNT(*) FROM budget_ledger WHERE run_id LIKE 'ops_run_%' AND entry_type = 'reserve') AS retained_reserve_ledgers,
  (SELECT COUNT(*) FROM budget_ledger WHERE run_id LIKE 'ops_run_%' AND entry_type = 'actual') AS retained_actual_ledgers;
SELECT 'live_pending_aggregate' AS check_name,
  (SELECT COUNT(*) FROM runs WHERE mode = 'live' AND status = 'pending') AS pending_runs,
  (SELECT COUNT(*) FROM runs WHERE mode = 'live' AND status = 'running') AS running_runs,
  (SELECT COUNT(*) FROM runs WHERE mode = 'live' AND status = 'uncertain') AS uncertain_runs;
`.trim();

export const pendingSeedSql = (ids: Record<'owner' | 'workspace' | 'source' | 'run' | 'request' | 'ledger' | 'guard', string>, now: string): string => {
  return `${pendingSeedStatements(ids, now).join(';\n')};`;
};

export const pendingSeedStatements = (ids: Record<'owner' | 'workspace' | 'source' | 'run' | 'request' | 'ledger' | 'guard', string>, now: string): string[] => {
  assertTestIds(Object.values(ids));
  const future = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
  const day = `${now.slice(0, 10)}T00:00:00.000Z`;
  const sourceHash = createHash('sha256').update(sourceText).digest('hex');
  return [
    `INSERT INTO tx_guards (id, created_at) VALUES (${sqlString(ids.guard)}, ${sqlString(now)})`,
    `INSERT INTO owners (id, token_hash, created_at, last_seen_at) SELECT ${sqlString(ids.owner)}, ${sqlString(`hash:${ids.owner}`)}, ${sqlString(now)}, ${sqlString(now)} WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ${sqlString(ids.guard)})`,
    `INSERT INTO workspaces (id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, created_at, updated_at, expires_at) SELECT ${sqlString(ids.workspace)}, ${sqlString(ids.owner)}, 'ops pending drill', '여행 경비 계획', 0, 1, 0, ${sqlString(now)}, ${sqlString(now)}, ${sqlString(future)} WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ${sqlString(ids.guard)})`,
    `INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) SELECT ${sqlString(ids.workspace)}, 0, '{"facts":[],"blocks":[]}', 'ops_pending_drill', ${sqlString(now)} WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ${sqlString(ids.guard)})`,
    `INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at) SELECT ${sqlString(ids.source)}, ${sqlString(ids.workspace)}, 1, 'ops pending drill', 'initial', NULL, ${sqlString(sourceHash)}, ${sqlString(sourceText)}, ${sqlString(now)} WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ${sqlString(ids.guard)})`,
    `INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at)
SELECT ${sqlString(ids.ledger)}, ${sqlString(ids.owner)}, ${sqlString(ids.workspace)}, ${sqlString(ids.run)}, 'reserve', ${LIMITS.reserveMicroUsd}, ${sqlString(now)}
WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ${sqlString(ids.guard)})
  AND NOT EXISTS (SELECT 1 FROM budget_ledger WHERE entry_type = 'policy_violation')
  AND (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM budget_ledger WHERE entry_type = 'reserve' AND created_at >= ${sqlString(day)}) + ${LIMITS.reserveMicroUsd} <= ${expected.dailyBudgetMicroUsd}
  AND (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM budget_ledger WHERE entry_type = 'reserve') + ${LIMITS.reserveMicroUsd} <= ${expected.totalBudgetMicroUsd}
  AND (SELECT COUNT(*) FROM budget_ledger WHERE owner_id = ${sqlString(ids.owner)} AND entry_type = 'reserve' AND created_at >= ${sqlString(day)}) < ${expected.ownerDailyRuns}`,
    `INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, error, request_id, payload_hash, base_revision, base_source_revision, reserved_micro_usd, created_at, updated_at)
SELECT ${sqlString(ids.run)}, ${sqlString(ids.workspace)}, ${sqlString(ids.owner)}, ${sqlString(ids.source)}, 'pending', 'live', NULL, ${sqlString(ids.request)}, ${sqlString(`payload:${ids.request}`)}, 0, 1, ${LIMITS.reserveMicroUsd}, ${sqlString(now)}, ${sqlString(now)}
WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ${sqlString(ids.guard)})
  AND EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ${sqlString(ids.run)} AND entry_type = 'reserve')`,
    `INSERT INTO tx_abort (id) SELECT 'abort' WHERE NOT EXISTS (SELECT 1 FROM runs WHERE id = ${sqlString(ids.run)} AND status = 'pending')`,
    `DELETE FROM tx_guards WHERE id = ${sqlString(ids.guard)}`,
  ];
};

export const pendingOwnershipSql = (ids: Record<'owner' | 'workspace' | 'source' | 'run', string>): string => {
  assertTestIds(Object.values(ids));
  return `
SELECT 'owned_pending_run' AS check_name,
  (SELECT COUNT(*) FROM owners WHERE id = ${sqlString(ids.owner)}) AS owner_rows,
  (SELECT COUNT(*) FROM workspaces WHERE id = ${sqlString(ids.workspace)} AND owner_id = ${sqlString(ids.owner)}) AS workspace_rows,
  (SELECT COUNT(*) FROM sources WHERE id = ${sqlString(ids.source)} AND workspace_id = ${sqlString(ids.workspace)}) AS source_rows,
  (SELECT COUNT(*) FROM runs WHERE id = ${sqlString(ids.run)} AND workspace_id = ${sqlString(ids.workspace)} AND owner_id = ${sqlString(ids.owner)} AND status = 'pending' AND mode = 'live') AS pending_run_rows,
  (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ${sqlString(ids.run)} AND owner_id = ${sqlString(ids.owner)} AND entry_type = 'reserve' AND amount_micro_usd = ${LIMITS.reserveMicroUsd}) AS reserve_rows;
`.trim();
};

export const pendingPostRunSql = (runId: string): string => {
  assertTestIds([runId]);
  return `
SELECT 'run_state' AS check_name,
  (SELECT status FROM runs WHERE id = ${sqlString(runId)}) AS status,
  (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ${sqlString(runId)} AND entry_type = 'reserve') AS reserve_rows,
  (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ${sqlString(runId)} AND entry_type = 'actual') AS actual_rows,
  (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ${sqlString(runId)} AND entry_type = 'policy_violation') AS policy_violation_rows,
  (SELECT COUNT(*) FROM runs WHERE id = ${sqlString(runId)} AND provenance_json IS NOT NULL) AS provenance_rows;
`.trim();
};

export const pendingCleanupSql = (workspaceId: string): string => {
  assertTestIds([workspaceId]);
  return `DELETE FROM workspaces WHERE id = ${sqlString(workspaceId)};`;
};

export const pendingCancellationSql = (ids: Record<'owner' | 'workspace' | 'run', string>): string => {
  assertTestIds(Object.values(ids));
  return `UPDATE runs SET status = 'failed', error = 'ops pending drill cancelled before claim' WHERE id = ${sqlString(ids.run)} AND workspace_id = ${sqlString(ids.workspace)} AND owner_id = ${sqlString(ids.owner)} AND status = 'pending';`;
};

export const pendingCleanupVerificationSql = (ids: Record<'owner' | 'workspace' | 'source' | 'run', string>): string => {
  assertTestIds(Object.values(ids));
  return `
SELECT 'cleanup' AS check_name,
  (SELECT COUNT(*) FROM workspaces WHERE id = ${sqlString(ids.workspace)}) AS workspace_rows,
  (SELECT COUNT(*) FROM sources WHERE id = ${sqlString(ids.source)}) AS source_rows,
  (SELECT COUNT(*) FROM runs WHERE id = ${sqlString(ids.run)}) AS run_rows,
  (SELECT COUNT(*) FROM owners WHERE id = ${sqlString(ids.owner)}) AS owner_rows,
  (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ${sqlString(ids.run)} AND entry_type = 'reserve') AS retained_reserve_rows,
  (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ${sqlString(ids.run)} AND entry_type = 'actual') AS retained_actual_rows;
`.trim();
};

export const validatePendingStagingConfig = (config: unknown, baseUrl: string): string[] => {
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
  const vars = asObject(env.vars);
  if (stringValue(vars?.DAILY_BUDGET_MICRO_USD) !== expected.dailyBudgetMicroUsd) errors.push('staging_daily_budget_mismatch');
  if (stringValue(vars?.TOTAL_BUDGET_MICRO_USD) !== expected.totalBudgetMicroUsd) errors.push('staging_total_budget_mismatch');
  if (stringValue(vars?.OWNER_DAILY_RUNS) !== expected.ownerDailyRuns) errors.push('staging_owner_daily_runs_mismatch');
  return errors;
};

export const runPendingDrill = async (options: Options, deps: PendingDrillDeps = {}): Promise<PendingDrillReport> => {
  const report = initialReport(options);
  const now = deps.now ?? (() => new Date().toISOString());
  const execute = deps.executeD1 ?? ((sql, mutates) => executeD1(options, sql, mutates));
  let adminPromise: ReturnType<typeof createStagingAdminClient> | undefined;
  const admin = () => adminPromise ??= createStagingAdminClient({ allowRemoteMutation: options.allowRemoteMutation });
  const executeBatch = deps.executeD1Batch ?? (async (statements, mutates) => {
    const client = await admin();
    report.checks.atomicBatch = await client.verifyAtomicBatch();
    return client.query(statements, mutates);
  });
  const observeLifecycle = deps.observeLifecycle ?? observePendingLifecycle;
  const sendQueueMessage = deps.sendQueueMessage ?? (async (runId) => (await admin()).sendQueueMessage(runId));
  const config = deps.readConfig ? await deps.readConfig() : parseJsonc(await readFile(configPath, 'utf8'));
  const configErrors = validatePendingStagingConfig(config, options.baseUrl);
  if (configErrors.length > 0) {
    report.errors.push(...configErrors);
    report.finishedAt = now();
    return report;
  }

  try {
    if (options.mode === 'plan') {
      report.checks.plan = buildPendingDrillPlan();
      report.warnings.push('plan_only_no_remote_calls');
    } else if (options.mode === 'read-only') {
      const probe = await execute(pendingReadOnlySql(), false);
      report.checks.readOnly = sanitizeD1Result(probe);
      report.warnings.push(...readOnlyWarnings(probe));
    } else {
      requireMutation(options);
      await executePendingRedispatch(report, options, execute, executeBatch, observeLifecycle, sendQueueMessage, now);
    }
  } catch (error) {
    report.errors.push(safeError(error));
  }

  report.finishedAt = now();
  return report;
};

const executePendingRedispatch = async (
  report: PendingDrillReport,
  options: Options,
  execute: NonNullable<PendingDrillDeps['executeD1']>,
  executeBatch: NonNullable<PendingDrillDeps['executeD1Batch']>,
  observeLifecycle: NonNullable<PendingDrillDeps['observeLifecycle']>,
  sendQueueMessage: NonNullable<PendingDrillDeps['sendQueueMessage']>,
  now: () => string,
): Promise<void> => {
  const ids = {
    owner: testId('owner'),
    workspace: testId('ws'),
    source: testId('src'),
    run: testId('run'),
    request: testId('req'),
    ledger: testId('led'),
    guard: testId('guard'),
  };
  report.testIds = ids;
  try {
    const observation = await observeLifecycle(options.durationSeconds, ids.run, async ({ waitForCronRedispatch, waitForClaimed }) => {
      await executeBatch(pendingSeedStatements(ids, now()), true);
      const ownership = await execute(pendingOwnershipSql(ids), false);
      report.checks.ownership = sanitizeD1Result(ownership);
      expectOwnedPendingRun(ownership);
      await waitForCronRedispatch();
      await waitForClaimed();
      for (let index = 0; index < options.duplicateMessages; index += 1) {
        await sendQueueMessage(ids.run);
      }
      report.checks.duplicateMessagesSent = options.duplicateMessages;
    });
    report.checks.lifecycleObservation = observationSummary(observation, ids.run);
    expectCronRedispatched(observation);
    expectQueueLifecycle(observation, ids.run);

    const postRun = await execute(pendingPostRunSql(ids.run), false);
    report.checks.postRun = sanitizeD1Result(postRun);
    expectPostRunInvariants(postRun);
  } finally {
    await cleanupOwnedPendingFixture(report, execute, ids);
  }
};

const cleanupOwnedPendingFixture = async (
  report: PendingDrillReport,
  execute: NonNullable<PendingDrillDeps['executeD1']>,
  ids: Record<'owner' | 'workspace' | 'source' | 'run', string>,
): Promise<void> => {
  let status = await cleanupStatus(execute, ids.run);
  if (status === 'pending') {
    // Compete atomically with the consumer claim. Cancellation may only win
    // before a paid attempt; a losing race must preserve the running evidence.
    try { await execute(pendingCancellationSql(ids), true); }
    catch { report.errors.push('pending_cancellation_outcome_unknown'); }
    status = await cleanupStatus(execute, ids.run);
  }
  if (status === 'pending' || status === 'running' || status === null) {
    report.cleanup.attempted = false;
    report.cleanup.verified = false;
    report.cleanup.retainedLedger = null;
    report.errors.push(status === null ? 'cleanup_status_unknown' : 'run_not_terminal_cleanup_deferred');
    return;
  }
  report.cleanup.attempted = true;
  let cleanupFailed = false;
  try {
    await execute(pendingCleanupSql(ids.workspace), true);
  } catch {
    cleanupFailed = true;
    report.errors.push('cleanup_execute_failed');
  }
  try {
    const cleanup = await execute(pendingCleanupVerificationSql(ids), false);
    report.checks.cleanup = sanitizeD1Result(cleanup);
    const row = d1Rows(cleanup).find((candidate) => candidate.check_name === 'cleanup');
    const verified = row?.workspace_rows === 0 && row.source_rows === 0 && row.run_rows === 0 && row.retained_reserve_rows === 1;
    report.cleanup.verified = verified;
    report.cleanup.retainedLedger = row?.retained_reserve_rows === 1;
  } catch {
    report.cleanup.verified = false;
    report.cleanup.retainedLedger = null;
    report.errors.push('cleanup_verify_failed');
  }
  if (cleanupFailed || report.cleanup.verified !== true) report.errors.push('cleanup_unverified');
};

const executeD1 = (options: Options, sql: string, mutates: boolean): Promise<unknown> => new Promise((resolve, reject) => {
  if (mutates && !options.allowRemoteMutation) {
    reject(new Error('remote_mutation_not_allowed'));
    return;
  }
  const wranglerCli = require.resolve('wrangler');
  const child = spawn(process.execPath, [
    wranglerCli,
    'd1',
    'execute',
    'DB',
    '--env',
    options.target,
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

const observePendingLifecycle = (
  durationSeconds: number,
  runId: string,
  action: (controls: LifecycleControls) => Promise<void>,
): Promise<ObservationReport> => new Promise((resolve) => {
  const started = Date.now();
  const parser = new JsonObjectStreamParser();
  const report = initialObservationReport(new Date(started).toISOString(), durationSeconds);
  const wranglerCli = require.resolve('wrangler');
  let closed = false;
  let actionDone = false;
  let cronResolved = false;
  let claimedResolved = false;
  let cronReject: ((reason?: unknown) => void) | null = null;
  let cronResolve: (() => void) | null = null;
  let claimReject: ((reason?: unknown) => void) | null = null;
  let claimResolve: (() => void) | null = null;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(process.execPath, [wranglerCli, 'tail', '--env', 'staging', '--env-file', '.dev.vars.example', '--format', 'json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = (): void => {
    if (!child.killed) child.kill('SIGINT');
    if (!forceKill) forceKill = setTimeout(() => {
      if (!closed) {
        report.warnings.push('wrangler_tail_force_killed');
        child.kill('SIGKILL');
      }
    }, 5_000);
  };
  const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    clearTimeout(forceKill);
    if (!cronResolved && cronReject) cronReject(new Error('cron_wait_timeout'));
    if (!claimedResolved && claimReject) claimReject(new Error('claim_wait_timeout'));
    if (exitCode !== null && exitCode !== 0 && !report.timedOut && !lifecycleSatisfied(report, runId)) report.errors.push('wrangler_tail_exit_nonzero');
    report.exitCode = exitCode;
    report.signal = signal;
    report.finishedAt = new Date().toISOString();
    report.durationSeconds = Math.round((Date.now() - started) / 1000);
    resolve(report);
  };
  const timeout = setTimeout(() => {
    report.timedOut = true;
    stop();
  }, durationSeconds * 1000);
  const controls: LifecycleControls = {
    waitForCronRedispatch: () => new Promise<void>((resolveCron, rejectCron) => {
      if (cronResolved) {
        resolveCron();
        return;
      }
      cronResolve = resolveCron;
      cronReject = rejectCron;
    }),
    waitForClaimed: () => new Promise<void>((resolveClaim, rejectClaim) => {
      if (claimedResolved) {
        resolveClaim();
        return;
      }
      claimResolve = resolveClaim;
      claimReject = rejectClaim;
    }),
  };
  const maybeResolveCron = (projection: SafeProjection): void => {
    if (!isScheduledCronProjection(projection)) return;
    const redispatched = projection.telemetry.some((event) =>
      event.event === 'cron_recovery' &&
      event.outcome === 'completed' &&
      numberField(event, 'redispatchedRuns') >= 1 &&
      numberField(event, 'failedRedispatches') === 0);
    if (!redispatched) return;
    report.stoppedAfterCron = true;
    cronResolved = true;
    cronResolve?.();
  };
  const maybeResolveClaim = (projection: SafeProjection): void => {
    const claimed = projection.telemetry.some((event) =>
      event.event === 'run_lifecycle' && event.runId === runId && event.outcome === 'claimed');
    if (!claimed) return;
    claimedResolved = true;
    claimResolve?.();
  };
  const maybeStop = (): void => {
    if (actionDone && lifecycleSatisfied(report, runId)) stop();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    try {
      for (const object of parser.feed(chunk)) {
        const projection = projectTailEvent(object);
        if (!projection) {
          report.counts.ignoredRecords += 1;
          continue;
        }
        report.counts.invocations[projection.invocation.type] += 1;
        for (const event of projection.telemetry) report.counts.telemetry[event.event] += 1;
        retainObservationSample(report.samples, projection);
        maybeResolveCron(projection);
        maybeResolveClaim(projection);
        maybeStop();
      }
    } catch {
      report.counts.parseErrors += 1;
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {
    if (!report.warnings.includes('wrangler_tail_stderr_suppressed')) report.warnings.push('wrangler_tail_stderr_suppressed');
  });
  child.on('error', () => {
    report.errors.push('wrangler_tail_spawn_failed');
    finish(1, null);
  });
  child.on('close', finish);
  action(controls).catch((error: unknown) => {
    report.errors.push(safeError(error));
    actionDone = true;
    stop();
  }).then(() => {
    actionDone = true;
    maybeStop();
  });
});

const expectOwnedPendingRun = (value: unknown): void => {
  const row = d1Rows(value).find((candidate) => candidate.check_name === 'owned_pending_run');
  if (!row || row.owner_rows !== 1 || row.workspace_rows !== 1 || row.source_rows !== 1 || row.pending_run_rows !== 1 || row.reserve_rows !== 1) {
    throw new Error('owned_pending_run_not_verified');
  }
};

const expectCronRedispatched = (observation: ObservationReport): void => {
  if (observation.errors.length > 0) throw new Error('cron_observation_errors');
  if (!observation.stoppedAfterCron) throw new Error('cron_observation_missing');
  if (observation.counts.parseErrors > 0) throw new Error('cron_observation_parse_errors');
  const cron = observation.samples.flatMap((sample) => sample.telemetry).filter((event) => event.event === 'cron_recovery');
  if (!cron.some((event) => event.outcome === 'completed' && numberField(event, 'redispatchedRuns') >= 1 && numberField(event, 'failedRedispatches') === 0)) {
    throw new Error('pending_redispatch_not_verified');
  }
};

const expectQueueLifecycle = (observation: ObservationReport, runId: string): void => {
  if (observation.errors.length > 0) throw new Error('queue_observation_errors');
  if (observation.counts.parseErrors > 0) throw new Error('queue_observation_parse_errors');
  const lifecycle = observation.samples.flatMap((sample) => sample.telemetry)
    .filter((event) => event.event === 'run_lifecycle' && event.runId === runId);
  const claimed = lifecycle.filter((event) => event.outcome === 'claimed').length;
  const skipped = lifecycle.filter((event) => event.outcome === 'skipped').length;
  if (claimed !== 1) throw new Error(claimed > 1 ? 'duplicate_claim_detected' : 'queue_claim_not_verified');
  if (skipped < 1) throw new Error('duplicate_skip_not_verified');
};

const expectPostRunInvariants = (value: unknown): void => {
  const row = d1Rows(value).find((candidate) => candidate.check_name === 'run_state');
  if (!row) throw new Error('run_state_missing');
  if (row.status === 'pending') throw new Error('run_not_claimed');
  if (row.status === 'running') throw new Error('run_not_terminal');
  if (!['ready', 'needs_input', 'failed', 'uncertain'].includes(String(row.status))) throw new Error('run_terminal_status_mismatch');
  if (row.reserve_rows !== 1) throw new Error('reserve_ledger_mismatch');
  if (typeof row.actual_rows === 'number' && row.actual_rows > 1) throw new Error('duplicate_actual_ledger_detected');
  if (typeof row.policy_violation_rows === 'number' && row.policy_violation_rows > 1) throw new Error('duplicate_policy_ledger_detected');
  if (row.provenance_rows !== 1) throw new Error('provenance_not_recorded');
};

const cleanupStatus = async (execute: NonNullable<PendingDrillDeps['executeD1']>, runId: string): Promise<string | null> => {
  try {
    const state = await execute(pendingPostRunSql(runId), false);
    const row = d1Rows(state).find((candidate) => candidate.check_name === 'run_state');
    return typeof row?.status === 'string' ? row.status : null;
  } catch {
    return null;
  }
};

const readOnlyWarnings = (value: unknown): string[] => {
  const warnings: string[] = [];
  const schema = d1Rows(value).find((row) => row.check_name === 'schema');
  if (schema?.provenance_columns !== 1) warnings.push(`provenance_column_mismatch:${String(schema?.provenance_columns ?? 'missing')}`);
  if (schema?.required_objects !== 7) warnings.push(`required_object_mismatch:${String(schema?.required_objects ?? 'missing')}`);
  return warnings;
};

const observationSummary = (observation: ObservationReport, runId: string): SafeJson => {
  const lifecycle = observation.samples.flatMap((sample) => sample.telemetry)
    .filter((event) => event.event === 'run_lifecycle' && event.runId === runId);
  return {
    stoppedAfterCron: observation.stoppedAfterCron,
    timedOut: observation.timedOut,
    counts: observation.counts,
    runLifecycle: lifecycle,
    cronEvents: observation.samples.flatMap((sample) => sample.telemetry).filter((event) => event.event === 'cron_recovery'),
    warnings: observation.warnings,
    errors: observation.errors,
  };
};

const lifecycleSatisfied = (report: ObservationReport, runId: string): boolean => {
  const lifecycle = report.samples.flatMap((sample) => sample.telemetry)
    .filter((event) => event.event === 'run_lifecycle' && event.runId === runId);
  return lifecycle.filter((event) => event.outcome === 'claimed').length === 1 &&
    lifecycle.some((event) => event.outcome === 'skipped');
};

const initialObservationReport = (startedAt: string, durationSeconds: number): ObservationReport => ({
  schema: 'ieojim.staging-tail-observation.v1',
  startedAt,
  finishedAt: startedAt,
  durationSeconds,
  untilCron: false,
  stoppedAfterCron: false,
  timedOut: false,
  exitCode: null,
  signal: null,
  counts: {
    invocations: { scheduled: 0, queue: 0, fetch: 0, unknown: 0 },
    telemetry: { run_lifecycle: 0, cron_recovery: 0, ops_health: 0 },
    ignoredRecords: 0,
    parseErrors: 0,
  },
  samples: [],
  errors: [],
  warnings: [],
});

const sanitizeD1Result = (value: unknown): SafeJson => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value as SafeJson;
  if (Array.isArray(value)) return value.map(sanitizeD1Result);
  if (!isRecord(value)) return null;
  const sanitized: Record<string, SafeJson> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (['text', 'token_hash', 'response_json', 'snapshot_json', 'pending_changeset_json', 'provenance_json'].includes(key)) continue;
    sanitized[key] = sanitizeD1Result(entry);
  }
  return sanitized;
};

const d1Rows = (value: unknown): D1Rows => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((statement) => {
    if (!isRecord(statement) || !Array.isArray(statement.results)) return [];
    return statement.results.flatMap((row) => isRecord(row) ? [row as Record<string, SafeJson>] : []);
  });
};

const run = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const report = await runPendingDrill(options);
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, `staging-pending-drill-${options.mode}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outputPath: path, mode: report.mode, checks: report.checks, warnings: report.warnings, errors: report.errors, cleanup: report.cleanup }, null, 2));
  if (report.errors.length > 0) process.exitCode = 1;
};

const parseArgs = (args: string[]): Options => {
  let target: Target = 'staging';
  let mode: Mode = 'plan';
  let baseUrl: string = expected.baseUrl;
  let durationSeconds = 420;
  let duplicateMessages = 2;
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
      if (!['plan', 'read-only', 'pending-redispatch'].includes(value)) throw new Error('invalid_mode');
      mode = value as Mode;
    } else if (arg === '--base-url') {
      baseUrl = normalizeBaseUrl(args[index + 1]);
      index += 1;
    } else if (arg === '--duration-seconds') {
      const parsed = Number(args[index + 1]);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maxDurationSeconds) throw new Error('duration_seconds_out_of_range');
      durationSeconds = parsed;
      index += 1;
    } else if (arg === '--duplicate-messages') {
      const parsed = Number(args[index + 1]);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxDuplicateMessages) throw new Error('duplicate_messages_out_of_range');
      duplicateMessages = parsed;
      index += 1;
    }
  }
  return { target, mode, allowRemoteMutation, baseUrl, durationSeconds, duplicateMessages };
};

const requireMutation = (options: Options): void => {
  if (!options.allowRemoteMutation) throw new Error('remote_mutation_not_allowed');
};

const initialReport = (options: Options): PendingDrillReport => ({
  schema: 'ieojim.staging-pending-drill.v1',
  target: options.target,
  mode: options.mode,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  remoteMutationAllowed: options.allowRemoteMutation,
  testIds: {},
  checks: {},
  warnings: [],
  errors: [],
  cleanup: { attempted: false, verified: null, retainedLedger: null },
});

const normalizeBaseUrl = (value: string | undefined): string => {
  if (!value) throw new Error('base_url_missing');
  const url = new URL(value);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
};

const testId = (kind: 'owner' | 'ws' | 'src' | 'run' | 'req' | 'led' | 'guard'): string => `ops_${kind}_${randomUUID().replaceAll('-', '')}`;

const assertTestIds = (ids: string[]): void => {
  for (const id of ids) {
    if (!testIdPattern.test(id)) throw new Error('unsafe_test_id');
  }
};

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const numberField = (value: Record<string, SafeJson>, key: string): number =>
  typeof value[key] === 'number' ? value[key] : 0;

const safeError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'pending_drill_failed';
  if (/^[a-z0-9_]+(?::[a-z0-9_]+)?$/i.test(error.message)) return error.message;
  return 'pending_drill_failed';
};

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
