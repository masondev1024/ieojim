import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { observeStaging } from './observe-staging';
import { parseJsonc } from './deploy-readiness';

type Target = 'staging';
type DrillMode = 'plan' | 'read-only' | 'expiry' | 'timeout';
type SafeJson = string | number | boolean | null | SafeJson[] | { [key: string]: SafeJson };
type D1Rows = Record<string, SafeJson>[];

export type Options = {
  target: Target;
  mode: DrillMode;
  allowRemoteMutation: boolean;
  baseUrl: string;
  durationSeconds: number;
};

export type Report = {
  schema: 'ieojim.staging-operational-drill.v1';
  target: Target;
  mode: DrillMode;
  startedAt: string;
  finishedAt: string;
  remoteMutationAllowed: boolean;
  testIds: Record<string, string>;
  checks: Record<string, SafeJson>;
  warnings: string[];
  errors: string[];
  artifacts: string[];
  cleanup: { attempted: boolean; verified: boolean | null };
};

export type DrillDeps = {
  readConfig?: () => Promise<unknown>;
  executeD1?: (sql: string, mutates: boolean) => Promise<unknown>;
  observe?: (durationSeconds: number, untilCron: boolean) => Promise<Awaited<ReturnType<typeof observeStaging>>>;
  now?: () => string;
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
  rateLimitNamespaceId: '26090901',
  baseUrl: 'https://ieojim-staging.masondev1024.workers.dev',
} as const;
const maxDurationSeconds = 1200;
const testIdPattern = /^ops_(owner|ws|src|run|req)_[a-f0-9]{32}$/;

export const buildPlan = (target: Target): Record<string, SafeJson> => ({
  target,
  pinnedStagingConfig: expected,
  remoteReadOnlyProbe: [
    'confirm required tables exist',
    'confirm runs.provenance_json exists after migration 0006',
    'read aggregate run, workspace, storage, and budget counters without source text or owner tokens',
  ],
  expiryDrill: [
    'insert one expired ops_* workspace through fixed D1 statements',
    'tail until the next scheduled cron projection succeeds',
    'verify the owned workspace row is exactly gone and delete only the now-orphan ops_* owner',
  ],
  timeoutDrill: [
    'insert one test-owned live running run with an old claimed_at through fixed D1 statements',
    'tail until the next scheduled cron projection succeeds',
    'verify the owned run status is exactly uncertain, then delete the workspace and only the now-orphan ops_* owner',
  ],
  excluded: [
    'pending redispatch/duplicate delivery is not auto-drilled here because redispatching a live pending run can invoke a paid model call when the queue consumer is healthy',
    'alert delivery is not proven until an external recipient/transport is selected',
    'rollback is limited to a verified compatible Worker version or a forward fix; D1 Time Travel is a separate incident procedure',
  ],
});

export const readOnlyHealthSql = (): string => `
SELECT 'required_tables' AS check_name, COUNT(*) AS observed, 10 AS expected
FROM sqlite_master
WHERE type IN ('table', 'view') AND name IN ('owners', 'workspaces', 'sources', 'snapshots', 'runs', 'applied_commands', 'budget_ledger', 'storage_policy', 'storage_usage', 'content_storage_totals');
SELECT 'run_provenance_column' AS check_name, COUNT(*) AS observed, 1 AS expected
FROM pragma_table_info('runs')
WHERE name = 'provenance_json';
SELECT 'storage_singletons' AS check_name,
  (SELECT COUNT(*) FROM storage_policy WHERE id = 1) AS storage_policy_rows,
  (SELECT COUNT(*) FROM storage_usage WHERE id = 1) AS storage_usage_rows;
SELECT 'safe_aggregates' AS check_name,
  (SELECT COUNT(*) FROM workspaces WHERE deleted_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS active_workspaces,
  (SELECT COUNT(*) FROM runs WHERE mode = 'live' AND status = 'pending') AS pending_runs,
  (SELECT COUNT(*) FROM runs WHERE mode = 'live' AND status = 'running') AS running_runs,
  (SELECT COUNT(*) FROM runs WHERE mode = 'live' AND status = 'uncertain') AS uncertain_runs,
  (SELECT COUNT(*) FROM budget_ledger WHERE entry_type = 'policy_violation') AS model_budget_policy_violations,
  (SELECT content_bytes FROM storage_usage WHERE id = 1) AS storage_content_bytes,
  (SELECT max_content_bytes FROM storage_policy WHERE id = 1) AS storage_max_content_bytes;
`.trim();

export const expiredWorkspaceSeedSql = (ids: Record<'owner' | 'workspace' | 'source', string>, now: string): string => {
  assertTestIds(Object.values(ids));
  return `
INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (${sqlString(ids.owner)}, ${sqlString(`hash:${ids.owner}`)}, ${sqlString(now)}, ${sqlString(now)});
INSERT INTO workspaces (id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, created_at, updated_at, expires_at) VALUES (${sqlString(ids.workspace)}, ${sqlString(ids.owner)}, 'ops expiry drill', 'ops expiry drill', 0, 1, 0, ${sqlString(now)}, ${sqlString(now)}, '2000-01-01T00:00:00.000Z');
INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) VALUES (${sqlString(ids.workspace)}, 0, '{"facts":[],"blocks":[]}', 'ops_expiry_drill', ${sqlString(now)});
INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at) VALUES (${sqlString(ids.source)}, ${sqlString(ids.workspace)}, 1, 'ops expiry drill', 'initial', NULL, ${sqlString(`hash:${ids.source}`)}, 'ops expiry drill source', ${sqlString(now)});
`.trim();
};

export const timeoutSeedSql = (ids: Record<'owner' | 'workspace' | 'source' | 'run' | 'request', string>, now: string): string => {
  assertTestIds(Object.values(ids));
  const old = new Date(Date.parse(now) - 2 * 60 * 1000).toISOString();
  const future = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
  return `
INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (${sqlString(ids.owner)}, ${sqlString(`hash:${ids.owner}`)}, ${sqlString(now)}, ${sqlString(now)});
INSERT INTO workspaces (id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, created_at, updated_at, expires_at) VALUES (${sqlString(ids.workspace)}, ${sqlString(ids.owner)}, 'ops timeout drill', 'ops timeout drill', 0, 1, 0, ${sqlString(now)}, ${sqlString(now)}, ${sqlString(future)});
INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) VALUES (${sqlString(ids.workspace)}, 0, '{"facts":[],"blocks":[]}', 'ops_timeout_drill', ${sqlString(now)});
INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at) VALUES (${sqlString(ids.source)}, ${sqlString(ids.workspace)}, 1, 'ops timeout drill', 'initial', NULL, ${sqlString(`hash:${ids.source}`)}, 'ops timeout drill source', ${sqlString(now)});
INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, error, request_id, payload_hash, base_revision, base_source_revision, reserved_micro_usd, claimed_at, created_at, updated_at) VALUES (${sqlString(ids.run)}, ${sqlString(ids.workspace)}, ${sqlString(ids.owner)}, ${sqlString(ids.source)}, 'running', 'live', NULL, ${sqlString(ids.request)}, ${sqlString(`payload:${ids.request}`)}, 0, 1, 1, ${sqlString(old)}, ${sqlString(old)}, ${sqlString(old)});
`.trim();
};

export const ownershipProofSql = (ids: Record<'owner' | 'workspace' | 'source', string>): string => {
  assertTestIds(Object.values(ids));
  return `
SELECT 'owned_workspace' AS check_name,
  (SELECT COUNT(*) FROM workspaces WHERE id = ${sqlString(ids.workspace)} AND owner_id = ${sqlString(ids.owner)}) AS workspace_rows,
  (SELECT COUNT(*) FROM sources WHERE id = ${sqlString(ids.source)} AND workspace_id = ${sqlString(ids.workspace)}) AS source_rows,
  (SELECT COUNT(*) FROM owners WHERE id = ${sqlString(ids.owner)}) AS owner_rows;
`.trim();
};

export const cleanupWorkspaceSql = (workspaceId: string, ownerId: string): string => {
  assertTestIds([workspaceId, ownerId]);
  return `
DELETE FROM workspaces WHERE id = ${sqlString(workspaceId)} AND owner_id = ${sqlString(ownerId)};
DELETE FROM owners WHERE id = ${sqlString(ownerId)}
  AND NOT EXISTS (SELECT 1 FROM workspaces WHERE owner_id = ${sqlString(ownerId)})
  AND NOT EXISTS (SELECT 1 FROM runs WHERE owner_id = ${sqlString(ownerId)})
  AND NOT EXISTS (SELECT 1 FROM applied_commands WHERE owner_id = ${sqlString(ownerId)})
  AND NOT EXISTS (SELECT 1 FROM budget_ledger WHERE owner_id = ${sqlString(ownerId)});
`.trim();
};

export const cleanupVerificationSql = (workspaceId: string, ownerId: string): string => {
  assertTestIds([workspaceId, ownerId]);
  return `
SELECT 'cleanup' AS check_name,
  (SELECT COUNT(*) FROM workspaces WHERE id = ${sqlString(workspaceId)}) AS workspace_rows,
  (SELECT COUNT(*) FROM owners WHERE id = ${sqlString(ownerId)}) AS owner_rows;
`.trim();
};

export const timeoutStatusSql = (runId: string): string => {
  assertTestIds([runId]);
  return `SELECT status, COUNT(*) AS count FROM runs WHERE id = ${sqlString(runId)} GROUP BY status;`;
};

export const workspaceRemainingSql = (workspaceId: string): string => {
  assertTestIds([workspaceId]);
  return `SELECT COUNT(*) AS remaining FROM workspaces WHERE id = ${sqlString(workspaceId)};`;
};

export const validateStagingConfig = (config: unknown, baseUrl: string): string[] => {
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

export const readOnlyProbeWarnings = (value: unknown): string[] => {
  const warnings: string[] = [];
  for (const row of d1Rows(value)) {
    if (row.check_name === 'required_tables' || row.check_name === 'run_provenance_column') {
      if (row.observed !== row.expected) warnings.push(`${String(row.check_name)}_mismatch:${String(row.observed)}_of_${String(row.expected)}`);
    }
    if (row.check_name === 'storage_singletons') {
      if (row.storage_policy_rows !== 1) warnings.push(`storage_policy_singleton_mismatch:${String(row.storage_policy_rows)}`);
      if (row.storage_usage_rows !== 1) warnings.push(`storage_usage_singleton_mismatch:${String(row.storage_usage_rows)}`);
    }
  }
  return warnings;
};

export const runDrill = async (options: Options, deps: DrillDeps = {}): Promise<Report> => {
  const report = initialReport(options);
  const execute = deps.executeD1 ?? ((sql, mutates) => executeD1(options, sql, mutates));
  const observe = deps.observe ?? observeStaging;
  const now = deps.now ?? (() => new Date().toISOString());
  const config = deps.readConfig ? await deps.readConfig() : parseJsonc(await readFile(configPath, 'utf8'));
  const configErrors = validateStagingConfig(config, options.baseUrl);
  if (configErrors.length > 0) {
    report.errors.push(...configErrors);
    report.finishedAt = now();
    return report;
  }

  try {
    if (options.mode === 'plan') {
      report.checks.plan = buildPlan(options.target);
      report.warnings.push('plan_only_no_remote_calls');
    } else if (options.mode === 'read-only') {
      const probe = await execute(readOnlyHealthSql(), false);
      report.checks.readOnlyProbe = sanitizeD1Result(probe);
      report.warnings.push(...readOnlyProbeWarnings(probe));
    } else if (options.mode === 'expiry') {
      requireMutation(options);
      await runExpiryDrill(options, report, execute, observe, now);
    } else {
      requireMutation(options);
      await runTimeoutDrill(options, report, execute, observe, now);
    }
  } catch (error) {
    report.errors.push(safeError(error));
  }
  report.finishedAt = now();
  return report;
};

const run = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const report = await runDrill(options);
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, `staging-operational-drill-${options.mode}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outputPath: path, mode: report.mode, checks: report.checks, warnings: report.warnings, errors: report.errors, cleanup: report.cleanup }, null, 2));
  if (report.errors.length > 0) process.exitCode = 1;
};

const runExpiryDrill = async (
  options: Options,
  report: Report,
  execute: NonNullable<DrillDeps['executeD1']>,
  observe: NonNullable<DrillDeps['observe']>,
  now: () => string,
): Promise<void> => {
  const ids = { owner: testId('owner'), workspace: testId('ws'), source: testId('src') };
  report.testIds = ids;
  try {
    await execute(expiredWorkspaceSeedSql(ids, now()), true);
    const ownership = await execute(ownershipProofSql(ids), false);
    report.checks.ownership = sanitizeD1Result(ownership);
    expectOwnedFixture(ownership);
    const observation = await observe(options.durationSeconds, true);
    report.checks.observation = observationSummary(observation);
    expectCronObservation(observation);
    const postCron = await execute(workspaceRemainingSql(ids.workspace), false);
    report.checks.postCronWorkspace = sanitizeD1Result(postCron);
    expectWorkspaceGone(postCron);
  } finally {
    await cleanupOwnedFixture(report, execute, ids.workspace, ids.owner);
  }
};

const runTimeoutDrill = async (
  options: Options,
  report: Report,
  execute: NonNullable<DrillDeps['executeD1']>,
  observe: NonNullable<DrillDeps['observe']>,
  now: () => string,
): Promise<void> => {
  const ids = { owner: testId('owner'), workspace: testId('ws'), source: testId('src'), run: testId('run'), request: testId('req') };
  report.testIds = ids;
  try {
    await execute(timeoutSeedSql(ids, now()), true);
    const ownership = await execute(ownershipProofSql(ids), false);
    report.checks.ownership = sanitizeD1Result(ownership);
    expectOwnedFixture(ownership);
    const observation = await observe(options.durationSeconds, true);
    report.checks.observation = observationSummary(observation);
    expectCronObservation(observation);
    const afterCron = await execute(timeoutStatusSql(ids.run), false);
    report.checks.postCronRun = sanitizeD1Result(afterCron);
    expectRunStatus(afterCron, 'uncertain');
  } finally {
    await cleanupOwnedFixture(report, execute, ids.workspace, ids.owner);
  }
};

const cleanupOwnedFixture = async (
  report: Report,
  execute: NonNullable<DrillDeps['executeD1']>,
  workspaceId: string,
  ownerId: string,
): Promise<void> => {
  report.cleanup.attempted = true;
  let cleanupFailed = false;
  try {
    await execute(cleanupWorkspaceSql(workspaceId, ownerId), true);
  } catch {
    cleanupFailed = true;
    report.errors.push('cleanup_execute_failed');
  }
  try {
    const cleanupCheck = await execute(cleanupVerificationSql(workspaceId, ownerId), false);
    report.checks.cleanup = sanitizeD1Result(cleanupCheck);
    const rows = cleanupRows(cleanupCheck);
    report.cleanup.verified = rows.workspaceRows === 0 && rows.ownerRows === 0;
  } catch {
    report.cleanup.verified = false;
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
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
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

const expectOwnedFixture = (value: unknown): void => {
  const row = d1Rows(value).find((candidate) => candidate.check_name === 'owned_workspace');
  if (!row || row.workspace_rows !== 1 || row.source_rows !== 1 || row.owner_rows !== 1) throw new Error('owned_fixture_not_verified');
};

const expectCronObservation = (observation: Awaited<ReturnType<typeof observeStaging>>): void => {
  if (observation.errors.length > 0) throw new Error('cron_observation_errors');
  if (!observation.stoppedAfterCron) throw new Error('cron_observation_missing');
  if (observation.counts.parseErrors > 0) throw new Error('cron_observation_parse_errors');
  if (observation.counts.telemetry.cron_recovery < 1) throw new Error('cron_recovery_telemetry_missing');
  const cronEvents = observation.samples
    .flatMap((sample) => sample.telemetry)
    .filter((event) => event.event === 'cron_recovery');
  if (!cronEvents.some((event) => event.outcome === 'completed')) throw new Error('cron_recovery_outcome_not_completed');
};

const expectWorkspaceGone = (value: unknown): void => {
  const remaining = firstNumber(value, 'remaining');
  if (remaining !== 0) throw new Error('expired_workspace_remaining');
};

const expectRunStatus = (value: unknown, expectedStatus: string): void => {
  const rows = d1Rows(value);
  if (rows.length !== 1 || rows[0]?.status !== expectedStatus || rows[0]?.count !== 1) throw new Error('run_status_mismatch');
};

const cleanupRows = (value: unknown): { workspaceRows: number | null; ownerRows: number | null } => ({
  workspaceRows: firstNumber(value, 'workspace_rows'),
  ownerRows: firstNumber(value, 'owner_rows'),
});

const firstNumber = (value: unknown, key: string): number | null => {
  for (const row of d1Rows(value)) {
    const entry = row[key];
    if (typeof entry === 'number') return entry;
  }
  return null;
};

const sanitizeD1Result = (value: unknown): SafeJson => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value as SafeJson;
  if (Array.isArray(value)) return value.map(sanitizeD1Result);
  if (!isRecord(value)) return null;
  const sanitized: Record<string, SafeJson> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (['text', 'token_hash', 'response_json', 'snapshot_json', 'pending_changeset_json'].includes(key)) continue;
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

const observationSummary = (observation: Awaited<ReturnType<typeof observeStaging>>): SafeJson => ({
  stoppedAfterCron: observation.stoppedAfterCron,
  timedOut: observation.timedOut,
  counts: observation.counts,
  cronEvents: observation.samples
    .flatMap((sample) => sample.telemetry)
    .filter((event) => event.event === 'cron_recovery' || event.event === 'ops_health'),
  warnings: observation.warnings,
  errors: observation.errors,
});

const parseArgs = (args: string[]): Options => {
  let target: Target = 'staging';
  let mode: DrillMode = 'plan';
  let baseUrl: string = expected.baseUrl;
  let durationSeconds = 330;
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
      if (!['plan', 'read-only', 'expiry', 'timeout'].includes(value)) throw new Error('invalid_mode');
      mode = value as DrillMode;
    } else if (arg === '--base-url') {
      baseUrl = normalizeBaseUrl(args[index + 1]);
      index += 1;
    } else if (arg === '--duration-seconds') {
      const parsed = Number(args[index + 1]);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maxDurationSeconds) throw new Error('duration_seconds_out_of_range');
      durationSeconds = parsed;
      index += 1;
    }
  }
  return { target, mode, allowRemoteMutation, baseUrl, durationSeconds };
};

const normalizeBaseUrl = (value: string | undefined): string => {
  if (!value) throw new Error('base_url_missing');
  const url = new URL(value);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
};

const initialReport = (options: Options): Report => ({
  schema: 'ieojim.staging-operational-drill.v1',
  target: options.target,
  mode: options.mode,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  remoteMutationAllowed: options.allowRemoteMutation,
  testIds: {},
  checks: {},
  warnings: [],
  errors: [],
  artifacts: [],
  cleanup: { attempted: false, verified: null },
});

const requireMutation = (options: Options): void => {
  if (!options.allowRemoteMutation) throw new Error('remote_mutation_not_allowed');
};

const testId = (kind: 'owner' | 'ws' | 'src' | 'run' | 'req'): string => `ops_${kind}_${randomUUID().replaceAll('-', '')}`;

const assertTestIds = (ids: string[]): void => {
  for (const id of ids) {
    if (!testIdPattern.test(id)) throw new Error('unsafe_test_id');
  }
};

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const safeError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'operational_drill_failed';
  if (/^[a-z0-9_]+(?::[a-z0-9_]+)?$/i.test(error.message)) return error.message;
  return 'operational_drill_failed';
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
