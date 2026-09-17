type Severity = 'ok' | 'warning' | 'critical';

type RunAges = {
  pending_count: number;
  oldest_pending_age_seconds: number | null;
  running_count: number;
  oldest_running_age_seconds: number | null;
  uncertain_count: number;
};

type StorageSnapshot = {
  content_bytes: number;
  max_content_bytes: number;
  policy_present: boolean;
  usage_present: boolean;
};

type AdmissionSnapshot = {
  creations: number;
  max_daily_creations: number;
  commands: number;
  max_daily_commands: number;
};

type BudgetSnapshot = {
  policy_violations: number;
};

export type OpsHealthSnapshot = {
  observedAt: string;
  severity: Severity;
  checks: string[];
  operatorReviewRequired: boolean;
  pendingRuns: number;
  oldestPendingAgeSeconds: number | null;
  runningRuns: number;
  oldestRunningAgeSeconds: number | null;
  uncertainRuns: number;
  modelBudgetPolicyViolations: number;
  storageContentBytes: number;
  storageMaxContentBytes: number;
  storageUsedRatio: number;
  storageReconciliationDeltaBytes?: number;
  admissionsToday: {
    creations: number;
    maxDailyCreations: number;
    commands: number;
    maxDailyCommands: number;
  };
};

type CollectOptions = {
  includeStorageReconciliation?: boolean;
};

const PENDING_WARNING_SECONDS = 5 * 60;
const PENDING_CRITICAL_SECONDS = 10 * 60;
const RUNNING_UNCERTAIN_SECONDS = 70;
const STORAGE_WARNING_RATIO = 0.8;
const STORAGE_CRITICAL_RATIO = 0.95;
const ADMISSION_WARNING_RATIO = 0.8;
const ADMISSION_CRITICAL_RATIO = 1;

export const collectOpsHealth = async (db: D1Database, options: CollectOptions = {}): Promise<OpsHealthSnapshot> => {
  const observedAt = new Date().toISOString();
  const today = observedAt.slice(0, 10);
  const [runs, storage, budget, admission] = await Promise.all([
    runAges(db, observedAt),
    storageSnapshot(db),
    budgetSnapshot(db),
    admissionSnapshot(db, today),
  ]);
  const storageReconciliationDeltaBytes = options.includeStorageReconciliation
    ? await storageReconciliationDelta(db)
    : undefined;
  const storageUsedRatio = storage.max_content_bytes === 0
    ? (storage.content_bytes > 0 ? Number.POSITIVE_INFINITY : 0)
    : storage.content_bytes / storage.max_content_bytes;
  const checks: string[] = [];
  let severity: Severity = 'ok';

  const raise = (next: Severity, code: string): void => {
    checks.push(code);
    if (next === 'critical' || (next === 'warning' && severity === 'ok')) severity = next;
  };

  if (!storage.policy_present) raise('critical', 'storage_policy_missing');
  if (!storage.usage_present) raise('critical', 'storage_usage_missing');
  if (options.includeStorageReconciliation && storageReconciliationDeltaBytes === undefined) {
    raise('critical', 'storage_reconciliation_unavailable');
  }

  if ((runs.oldest_pending_age_seconds ?? 0) > PENDING_CRITICAL_SECONDS) {
    raise('critical', 'pending_age_critical');
  } else if ((runs.oldest_pending_age_seconds ?? 0) > PENDING_WARNING_SECONDS) {
    raise('warning', 'pending_age_warning');
  }
  if ((runs.oldest_running_age_seconds ?? 0) >= RUNNING_UNCERTAIN_SECONDS) raise('critical', 'running_timeout_uncertain');
  if (runs.uncertain_count > 0) raise('critical', 'uncertain_runs_operator_review');
  if (budget.policy_violations > 0) raise('critical', 'model_budget_policy_violation_operator_review');
  if (storage.content_bytes > storage.max_content_bytes) {
    raise('critical', 'storage_content_over_cap');
  } else if (storageUsedRatio >= STORAGE_CRITICAL_RATIO) {
    raise('critical', 'storage_content_near_cap_critical');
  } else if (storageUsedRatio >= STORAGE_WARNING_RATIO) {
    raise('warning', 'storage_content_near_cap_warning');
  }
  if (storageReconciliationDeltaBytes !== undefined && storageReconciliationDeltaBytes !== 0) raise('critical', 'storage_counter_drift');
  raiseAdmissionCheck(admission.creations, admission.max_daily_creations, 'admission_creations', raise);
  raiseAdmissionCheck(admission.commands, admission.max_daily_commands, 'admission_commands', raise);

  return {
    observedAt,
    severity,
    checks,
    operatorReviewRequired: (severity as Severity) === 'critical',
    pendingRuns: runs.pending_count,
    oldestPendingAgeSeconds: runs.oldest_pending_age_seconds,
    runningRuns: runs.running_count,
    oldestRunningAgeSeconds: runs.oldest_running_age_seconds,
    uncertainRuns: runs.uncertain_count,
    modelBudgetPolicyViolations: budget.policy_violations,
    storageContentBytes: storage.content_bytes,
    storageMaxContentBytes: storage.max_content_bytes,
    storageUsedRatio,
    storageReconciliationDeltaBytes,
    admissionsToday: {
      creations: admission.creations,
      maxDailyCreations: admission.max_daily_creations,
      commands: admission.commands,
      maxDailyCommands: admission.max_daily_commands,
    },
  };
};

const raiseAdmissionCheck = (
  used: number,
  limit: number,
  prefix: 'admission_creations' | 'admission_commands',
  raise: (severity: Severity, code: string) => void,
): void => {
  if (limit === 0) {
    if (used > 0) raise('critical', `${prefix}_over_daily_cap`);
    return;
  }
  const ratio = used / limit;
  if (ratio >= ADMISSION_CRITICAL_RATIO) raise('critical', `${prefix}_daily_cap_reached`);
  else if (ratio >= ADMISSION_WARNING_RATIO) raise('warning', `${prefix}_daily_cap_warning`);
};

const runAges = async (db: D1Database, observedAt: string): Promise<RunAges> => {
  const row = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
      CAST(MAX(CASE WHEN status = 'pending' THEN MAX(0, (julianday(?) - julianday(created_at)) * 86400) END) AS INTEGER) AS oldest_pending_age_seconds,
      COUNT(*) FILTER (WHERE status = 'running') AS running_count,
      CAST(MAX(CASE WHEN status = 'running' THEN MAX(0, (julianday(?) - julianday(COALESCE(claimed_at, created_at))) * 86400) END) AS INTEGER) AS oldest_running_age_seconds,
      COUNT(*) FILTER (WHERE status = 'uncertain') AS uncertain_count
    FROM runs
    WHERE mode = 'live' AND status IN ('pending', 'running', 'uncertain')
  `).bind(observedAt, observedAt).first<RunAges>();
  return {
    pending_count: Number(row?.pending_count ?? 0),
    oldest_pending_age_seconds: nullableNumber(row?.oldest_pending_age_seconds),
    running_count: Number(row?.running_count ?? 0),
    oldest_running_age_seconds: nullableNumber(row?.oldest_running_age_seconds),
    uncertain_count: Number(row?.uncertain_count ?? 0),
  };
};

const storageSnapshot = async (db: D1Database): Promise<StorageSnapshot> => {
  const row = await db.prepare(`
    SELECT
      (SELECT content_bytes FROM storage_usage WHERE id = 1) AS content_bytes,
      (SELECT max_content_bytes FROM storage_policy WHERE id = 1) AS max_content_bytes
  `).first<StorageSnapshot>();
  return {
    content_bytes: Number(row?.content_bytes ?? 0),
    max_content_bytes: Number(row?.max_content_bytes ?? 0),
    policy_present: row?.max_content_bytes !== null && row?.max_content_bytes !== undefined,
    usage_present: row?.content_bytes !== null && row?.content_bytes !== undefined,
  };
};

const budgetSnapshot = async (db: D1Database): Promise<BudgetSnapshot> => {
  const row = await db.prepare("SELECT COUNT(*) AS policy_violations FROM budget_ledger WHERE entry_type = 'policy_violation'")
    .first<BudgetSnapshot>();
  return { policy_violations: Number(row?.policy_violations ?? 0) };
};

const admissionSnapshot = async (db: D1Database, today: string): Promise<AdmissionSnapshot> => {
  const row = await db.prepare(`
    SELECT
      COALESCE(day.creations, 0) AS creations,
      policy.max_daily_creations,
      COALESCE(day.commands, 0) AS commands,
      policy.max_daily_commands
    FROM storage_policy AS policy
    LEFT JOIN admission_days AS day ON day.day = ?
    WHERE policy.id = 1
  `).bind(today).first<AdmissionSnapshot>();
  return {
    creations: Number(row?.creations ?? 0),
    max_daily_creations: Number(row?.max_daily_creations ?? 0),
    commands: Number(row?.commands ?? 0),
    max_daily_commands: Number(row?.max_daily_commands ?? 0),
  };
};

const storageReconciliationDelta = async (db: D1Database): Promise<number | undefined> => {
  const row = await db.prepare(`
    SELECT usage.content_bytes - totals.content_bytes AS delta
    FROM storage_usage AS usage
    CROSS JOIN content_storage_totals AS totals
    WHERE usage.id = 1
  `).first<{ delta: number }>();
  return row?.delta === null || row?.delta === undefined ? undefined : Number(row.delta);
};

const nullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};
