import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

type InvocationType = 'scheduled' | 'queue' | 'fetch' | 'unknown';
type SafeJson = string | number | boolean | null | SafeJson[] | { [key: string]: SafeJson };

type SafeInvocation = {
  type: InvocationType;
  outcome?: string;
  observedAt?: string;
};

type SafeTelemetry = Record<string, SafeJson> & {
  event: 'run_lifecycle' | 'cron_recovery' | 'ops_health';
};

export type SafeProjection = {
  invocation: SafeInvocation;
  telemetry: SafeTelemetry[];
};

export type ObservationReport = {
  schema: 'ieojim.staging-tail-observation.v1';
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  untilCron: boolean;
  stoppedAfterCron: boolean;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  counts: {
    invocations: Record<InvocationType, number>;
    telemetry: Record<SafeTelemetry['event'], number>;
    ignoredRecords: number;
    parseErrors: number;
  };
  samples: SafeProjection[];
  errors: string[];
  warnings: string[];
};

const require = createRequire(import.meta.url);
const defaultDurationSeconds = 120;
const maxDurationSeconds = 1200;
const maxSamples = 20;
const outputDir = 'artifacts';

const allowedTelemetryFields = {
  run_lifecycle: new Set(['event', 'runId', 'workspaceId', 'status', 'outcome', 'durationMs', 'reservedMicroUsd', 'actualMicroUsd', 'costSource', 'inputTokens', 'outputTokens', 'changesetId', 'errorCode', 'errorName']),
  cron_recovery: new Set(['event', 'outcome', 'timedOutRuns', 'expiredWorkspaces', 'pendingRuns', 'redispatchedRuns', 'failedRedispatches', 'failedStage', 'errorName', 'durationMs']),
  ops_health: new Set(['event', 'outcome', 'severity', 'checks', 'operatorReviewRequired', 'observedAt', 'pendingRuns', 'oldestPendingAgeSeconds', 'runningRuns', 'oldestRunningAgeSeconds', 'uncertainRuns', 'modelBudgetPolicyViolations', 'storageContentBytes', 'storageMaxContentBytes', 'storageUsedRatio', 'storageReconciliationDeltaBytes', 'admissionsToday', 'durationMs', 'errorName']),
} as const;

export class JsonObjectStreamParser {
  private buffer = '';
  private start = -1;
  private cursor = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;

  feed(chunk: string): unknown[] {
    const parsed: unknown[] = [];
    this.buffer += chunk;
    for (let index = this.cursor; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (this.start === -1) {
        if (char === '{' || char === '[') {
          this.start = index;
          this.depth = 1;
        }
        continue;
      }
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (char === '\\') {
          this.escaped = true;
        } else if (char === '"') {
          this.inString = false;
        }
        continue;
      }
      if (char === '"') {
        this.inString = true;
      } else if (char === '{' || char === '[') {
        this.depth += 1;
      } else if (char === '}' || char === ']') {
        this.depth -= 1;
        if (this.depth === 0) {
          parsed.push(JSON.parse(this.buffer.slice(this.start, index + 1)));
          this.buffer = this.buffer.slice(index + 1);
          index = -1;
          this.start = -1;
          this.cursor = 0;
        }
      }
    }
    if (this.start === -1) {
      this.buffer = this.buffer.trimStart();
      this.cursor = 0;
    } else {
      this.cursor = this.buffer.length;
    }
    return parsed;
  }
}

export const projectTailEvent = (value: unknown): SafeProjection | null => {
  if (!isRecord(value)) return null;
  const invocation = projectInvocation(value);
  const telemetry = extractTelemetry(value);
  if (invocation.type === 'unknown' && telemetry.length === 0) return null;
  return { invocation, telemetry };
};

export const isScheduledCronProjection = (projection: SafeProjection): boolean =>
  projection.invocation.type === 'scheduled' && projection.telemetry.some((event) => event.event === 'cron_recovery' || event.event === 'ops_health');

export const retainObservationSample = (samples: SafeProjection[], projection: SafeProjection): void => {
  samples.push(projection);
  if (samples.length > maxSamples) samples.shift();
};

const projectInvocation = (value: Record<string, unknown>): SafeInvocation => {
  const event = isRecord(value.event) ? value.event : {};
  return {
    type: classifyInvocation(value, event),
    outcome: typeof value.outcome === 'string' ? value.outcome : undefined,
    observedAt: timestampToIso(value.eventTimestamp ?? value.timestamp ?? value.wallTime),
  };
};

const classifyInvocation = (value: Record<string, unknown>, event: Record<string, unknown>): InvocationType => {
  const type = value.eventType ?? value.type;
  if (type === 'scheduled' || type === 'queue' || type === 'fetch') return type;
  if ('cron' in event || 'scheduledTime' in event) return 'scheduled';
  if ('queue' in event || 'batchSize' in event || 'messages' in event) return 'queue';
  if ('request' in event) return 'fetch';
  return 'unknown';
};

const extractTelemetry = (value: Record<string, unknown>): SafeTelemetry[] => {
  const logs = Array.isArray(value.logs) ? value.logs : [];
  const projected: SafeTelemetry[] = [];
  for (const log of logs) {
    if (!isRecord(log)) continue;
    const messages = Array.isArray(log.message) ? log.message : [log.message];
    for (const message of messages) {
      if (typeof message !== 'string') continue;
      const parsed = parseJsonObject(message);
      const telemetry = projectTelemetry(parsed);
      if (telemetry) projected.push(telemetry);
    }
  }
  return projected;
};

const projectTelemetry = (value: unknown): SafeTelemetry | null => {
  if (!isRecord(value)) return null;
  const event = value.event;
  if (event !== 'run_lifecycle' && event !== 'cron_recovery' && event !== 'ops_health') return null;
  const allowed = allowedTelemetryFields[event];
  const projected: Record<string, SafeJson> = { event };
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'event' || !allowed.has(key) || !isSafeJson(entry)) continue;
    projected[key] = entry;
  }
  return projected as SafeTelemetry;
};

const run = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const report = await observeStaging(options.durationSeconds, options.untilCron);
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, `staging-observation-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    outputPath,
    durationSeconds: report.durationSeconds,
    counts: report.counts,
    stoppedAfterCron: report.stoppedAfterCron,
    timedOut: report.timedOut,
    exitCode: report.exitCode,
    signal: report.signal,
    warnings: report.warnings,
    errors: report.errors,
  }, null, 2));
  if (report.errors.length > 0) process.exitCode = 1;
};

export const observeStaging = (durationSeconds: number, untilCron: boolean): Promise<ObservationReport> => new Promise((resolve) => {
  const started = Date.now();
  const parser = new JsonObjectStreamParser();
  const report = initialReport(new Date(started).toISOString(), durationSeconds, untilCron);
  let childClosed = false;
  const wranglerCli = require.resolve('wrangler');
  const child = spawn(process.execPath, [wranglerCli, 'tail', '--env', 'staging', '--env-file', '.dev.vars.example', '--format', 'json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (childClosed) return;
    childClosed = true;
    clearTimeout(timeout);
    if (exitCode !== null && exitCode !== 0 && !report.timedOut && !report.stoppedAfterCron) {
      report.errors.push('wrangler_tail_exit_nonzero');
    }
    report.exitCode = exitCode;
    report.signal = signal;
    report.finishedAt = new Date().toISOString();
    report.durationSeconds = Math.round((Date.now() - started) / 1000);
    resolve(report);
  };
  const stop = (): void => {
    if (!child.killed) child.kill('SIGINT');
  };
  const timeout = setTimeout(() => {
    report.timedOut = true;
    stop();
  }, durationSeconds * 1000);

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
        if (untilCron && isScheduledCronProjection(projection)) {
          report.stoppedAfterCron = true;
          stop();
        }
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
});

const initialReport = (startedAt: string, durationSeconds: number, untilCron: boolean): ObservationReport => ({
  schema: 'ieojim.staging-tail-observation.v1',
  startedAt,
  finishedAt: startedAt,
  durationSeconds,
  untilCron,
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

const parseArgs = (args: string[]): { durationSeconds: number; untilCron: boolean } => {
  let durationSeconds = defaultDurationSeconds;
  let untilCron = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--until-cron') untilCron = true;
    else if (arg === '--duration-seconds') {
      const next = Number(args[index + 1]);
      if (!Number.isInteger(next) || next <= 0 || next > maxDurationSeconds) throw new Error(`--duration-seconds must be an integer from 1 to ${maxDurationSeconds}`);
      durationSeconds = next;
      index += 1;
    }
  }
  return { durationSeconds, untilCron };
};

const parseJsonObject = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const timestampToIso = (value: unknown): string | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeJson = (value: unknown): value is SafeJson => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isSafeJson);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isSafeJson);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'staging observation failed');
    process.exitCode = 1;
  });
}
