import type { RunStatus } from '../core/contracts';

type RunOutcome = 'claimed' | 'published' | 'discarded' | 'ignored' | 'failed' | 'uncertain' | 'skipped';
type CostSource = 'usage_reported' | 'reserve_fallback';
type CronOutcome = 'completed' | 'partial_redispatch_failure' | 'failed';
type CronStage = 'mark_timed_out_runs' | 'expire_workspaces' | 'list_pending_runs' | 'redispatch_runs';
type OpsHealthOutcome = 'evaluated' | 'failed';
type OpsHealthSeverity = 'ok' | 'warning' | 'critical';

export type RunTelemetry = {
  event: 'run_lifecycle';
  runId: string;
  workspaceId?: string;
  status: RunStatus | 'missing' | 'skipped';
  outcome: RunOutcome;
  durationMs?: number | null;
  reservedMicroUsd?: number;
  actualMicroUsd?: number | null;
  costSource?: CostSource;
  inputTokens?: number | null;
  outputTokens?: number | null;
  changesetId?: string | null;
  errorCode?: string;
  errorName?: string;
};

export type CronTelemetry = {
  event: 'cron_recovery';
  outcome: CronOutcome;
  timedOutRuns: number;
  expiredWorkspaces: number;
  pendingRuns: number;
  redispatchedRuns: number;
  failedRedispatches: number;
  failedStage?: CronStage;
  errorName?: string;
  durationMs: number;
};

export type OpsHealthTelemetry = {
  event: 'ops_health';
  outcome: OpsHealthOutcome;
  severity: OpsHealthSeverity;
  checks: string[];
  operatorReviewRequired: boolean;
  observedAt: string;
  pendingRuns?: number;
  oldestPendingAgeSeconds?: number | null;
  runningRuns?: number;
  oldestRunningAgeSeconds?: number | null;
  uncertainRuns?: number;
  modelBudgetPolicyViolations?: number;
  storageContentBytes?: number;
  storageMaxContentBytes?: number;
  storageUsedRatio?: number;
  storageReconciliationDeltaBytes?: number;
  admissionsToday?: {
    creations: number;
    maxDailyCreations: number;
    commands: number;
    maxDailyCommands: number;
  };
  durationMs: number;
  errorName?: string;
};

export const logRunEvent = (event: RunTelemetry): void => {
  console.info(JSON.stringify(compact(event)));
};

export const logCronEvent = (event: CronTelemetry): void => {
  console.info(JSON.stringify(compact(event)));
};

export const logOpsHealthEvent = (event: OpsHealthTelemetry): void => {
  console.info(JSON.stringify(compact(event)));
};

export const durationSince = (startedAt: string, endedAt: number = Date.now()): number | null => {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, endedAt - started) : null;
};

const compact = <T extends Record<string, unknown>>(event: T): Partial<T> =>
  Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as Partial<T>;
