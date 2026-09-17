import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { BlockItem, Fact, RunSummary, WorkspaceView } from '../src/core/contracts';

export const STAGING_ORIGIN = 'https://ieojim-staging.masondev1024.workers.dev';

const SOURCE_TEXT = '참석자는 4명입니다. 공동 고정비는 총 900000원입니다. 고정비는 참석자가 똑같이 나눕니다.';
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;
const HTTP_TIMEOUT_MS = 10_000;
const HOOK_TIMEOUT_MS = 45_000;
const MAX_HOOK_TIMEOUT_MS = 60_000;

type FetchLike = typeof fetch;
type SmokeStep = { name: string; status: number; ok: boolean };
type FailureStage = 'smoke' | 'cleanup';
type FailureReason =
  | 'cleanup_failed'
  | 'http_error'
  | 'hook_timeout'
  | 'invalid_json'
  | 'missing_owner_cookie'
  | 'missing_pending_changeset'
  | 'missing_source_or_run'
  | 'missing_typed_krw_money'
  | 'missing_typed_person_count'
  | 'missing_225000_share'
  | 'apply_verification_failed'
  | 'run_failed'
  | 'run_needs_input'
  | 'run_uncertain'
  | 'poll_timeout'
  | 'request_timeout'
  | 'unknown';
type SmokeArtifact = {
  schemaVersion: 1;
  origin: typeof STAGING_ORIGIN;
  startedAt: string;
  completedAt: string | null;
  sourceSha256: string;
  workspaceId: string | null;
  sourceId: string | null;
  runId: string | null;
  steps: SmokeStep[];
  run: {
    finalStatus: RunSummary['status'] | null;
    costMicroUsd: number | null;
    mode: RunSummary['mode'] | null;
  };
  assertions: {
    typedCount: boolean;
    typedMoney: boolean;
    share225000: boolean;
    applied: boolean;
    deleted404: boolean;
    cleanupVerified: boolean;
  };
  failure: { stage: FailureStage; reason: FailureReason } | null;
};

export type StagingLiveSmokeOptions = {
  fetch?: FetchLike;
  artifactDir?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  httpTimeoutMs?: number;
  hookTimeoutMs?: number;
  afterReady?: (state: { workspaceId: string; runId: string; artifactPath: string }) => Promise<void> | void;
  afterApplied?: (state: { workspaceId: string; runId: string; artifactPath: string }) => Promise<void> | void;
};

export type StagingLiveSmokeResult = {
  artifactPath: string;
  workspaceId: string;
  runId: string;
};

export async function runStagingLiveSmoke(options: StagingLiveSmokeOptions = {}): Promise<StagingLiveSmokeResult> {
  const fetchImpl = options.fetch ?? fetch;
  const artifactDir = options.artifactDir ?? 'artifacts';
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = `${artifactDir}/staging-live-smoke-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`;
  const artifact: SmokeArtifact = {
    schemaVersion: 1,
    origin: STAGING_ORIGIN,
    startedAt: new Date().toISOString(),
    completedAt: null,
    sourceSha256: createHash('sha256').update(SOURCE_TEXT).digest('hex'),
    workspaceId: null,
    sourceId: null,
    runId: null,
    steps: [],
    run: { finalStatus: null, costMicroUsd: null, mode: null },
    assertions: { typedCount: false, typedMoney: false, share225000: false, applied: false, deleted404: false, cleanupVerified: false },
    failure: null,
  };
  const persist = async () => writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  await persist();

  let cookie: string | null = null;
  let result: StagingLiveSmokeResult | null = null;
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;
  try {
    const created = await requestJson<WorkspaceView>(fetchImpl, 'POST', '/api/workspaces', {
      title: `staging-live-smoke-${Date.now()}`,
      purpose: '여행 경비 계획',
    }, { artifact, timeoutMs: options.httpTimeoutMs });
    cookie = created.cookie;
    artifact.workspaceId = created.body.id;
    await persist();
    if (!cookie) throw new SmokeError('missing_owner_cookie');

    const sourced = await requestJson<WorkspaceView>(fetchImpl, 'POST', `/api/workspaces/${created.body.id}/sources`, {
      title: '합성 라이브 스모크 입력',
      text: SOURCE_TEXT,
      relation: 'initial',
      targetSourceId: null,
      requestId: randomUUID(),
    }, { artifact, cookie, timeoutMs: options.httpTimeoutMs });
    artifact.sourceId = sourced.body.sources.at(-1)?.id ?? null;
    artifact.runId = sourced.body.runs.find((run) => run.sourceId === artifact.sourceId)?.id ?? sourced.body.runs[0]?.id ?? null;
    if (!artifact.sourceId || !artifact.runId) throw new SmokeError('missing_source_or_run');
    const runId = artifact.runId;
    await persist();

    const ready = await pollReady(fetchImpl, created.body.id, runId, cookie, artifact, persist, options);
    const run = ready.runs.find((candidate) => candidate.id === runId);
    artifact.run = { finalStatus: run?.status ?? null, costMicroUsd: run?.costMicroUsd ?? null, mode: run?.mode ?? null };
    assertReadyWorkspace(ready, artifact);
    await persist();
    await runHook(options.afterReady, { workspaceId: created.body.id, runId, artifactPath }, options);

    const pending = ready.pending;
    if (!pending) throw new SmokeError('missing_pending_changeset');
    await requestJson<WorkspaceView>(fetchImpl, 'POST', `/api/workspaces/${created.body.id}/apply`, {
      changeSetId: pending.id,
      proposalRevision: pending.proposalRevision,
      baseRevision: ready.revision,
      baseSourceRevision: ready.sourceRevision,
      requestId: randomUUID(),
      resolutions: [],
    }, { artifact, cookie, timeoutMs: options.httpTimeoutMs });
    const applied = await requestJson<WorkspaceView>(fetchImpl, 'GET', `/api/workspaces/${created.body.id}`, undefined, { artifact, cookie, timeoutMs: options.httpTimeoutMs });
    artifact.assertions.applied = applied.body.revision === ready.revision + 1 &&
      applied.body.sourceRevision === ready.sourceRevision &&
      applied.body.pending === null &&
      applied.body.snapshot.facts.some((fact) => isPersonCount(fact)) &&
      applied.body.snapshot.facts.some((fact) => isKrwMoney(fact)) &&
      hasShare225000(applied.body.snapshot.blocks.flatMap((block) => block.items));
    if (!artifact.assertions.applied) throw new SmokeError('apply_verification_failed');
    artifact.completedAt = new Date().toISOString();
    await persist();
    await runHook(options.afterApplied, { workspaceId: created.body.id, runId, artifactPath }, options);
    result = { artifactPath, workspaceId: created.body.id, runId };
  } catch (error) {
    primaryFailure = error;
    artifact.failure = { stage: 'smoke', reason: safeReason(error) };
    await persist();
  } finally {
    if (artifact.workspaceId && cookie) {
      try {
        await requestEmpty(fetchImpl, 'DELETE', `/api/workspaces/${artifact.workspaceId}`, { artifact, cookie, allowedStatuses: [204, 404], timeoutMs: options.httpTimeoutMs });
        const deleted = await requestEmpty(fetchImpl, 'GET', `/api/workspaces/${artifact.workspaceId}`, { artifact, cookie, allowedStatuses: [404], timeoutMs: options.httpTimeoutMs });
        artifact.assertions.deleted404 = deleted.status === 404;
        artifact.assertions.cleanupVerified = artifact.assertions.deleted404;
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
        artifact.failure = { stage: 'cleanup', reason: 'cleanup_failed' };
      } finally {
        artifact.completedAt = artifact.completedAt ?? new Date().toISOString();
        await persist();
      }
    } else if (artifact.workspaceId) {
      artifact.assertions.cleanupVerified = false;
      artifact.completedAt = artifact.completedAt ?? new Date().toISOString();
      await persist();
    }
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (!result) throw new Error('missing_smoke_result');
  return result;
}

async function pollReady(
  fetchImpl: FetchLike,
  workspaceId: string,
  runId: string,
  cookie: string,
  artifact: SmokeArtifact,
  persist: () => Promise<void>,
  options: StagingLiveSmokeOptions,
): Promise<WorkspaceView> {
  const deadline = Date.now() + (options.pollTimeoutMs ?? POLL_TIMEOUT_MS);
  while (Date.now() <= deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const response = await requestJson<WorkspaceView>(fetchImpl, 'GET', `/api/workspaces/${workspaceId}`, undefined, { artifact, cookie, timeoutMs: remainingMs });
    const run = response.body.runs.find((candidate) => candidate.id === runId);
    artifact.run.finalStatus = run?.status ?? null;
    artifact.run.costMicroUsd = run?.costMicroUsd ?? null;
    artifact.run.mode = run?.mode ?? null;
    await persist();
    if (run?.status === 'ready' && response.body.pending) return response.body;
    if (run?.status === 'failed') throw new SmokeError('run_failed');
    if (run?.status === 'uncertain') throw new SmokeError('run_uncertain');
    if (run?.status === 'needs_input') throw new SmokeError('run_needs_input');
    await delay(Math.min(options.pollIntervalMs ?? POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throw new SmokeError('poll_timeout');
}

function assertReadyWorkspace(view: WorkspaceView, artifact: SmokeArtifact): void {
  if (!view.pending) throw new SmokeError('missing_pending_changeset');
  artifact.assertions.typedCount = view.pending.next.facts.some((fact) => isPersonCount(fact));
  artifact.assertions.typedMoney = view.pending.next.facts.some((fact) => isKrwMoney(fact));
  artifact.assertions.share225000 = hasShare225000(view.pending.next.blocks.flatMap((block) => block.items));
  if (!artifact.assertions.typedCount) throw new SmokeError('missing_typed_person_count');
  if (!artifact.assertions.typedMoney) throw new SmokeError('missing_typed_krw_money');
  if (!artifact.assertions.share225000) throw new SmokeError('missing_225000_share');
}

function isPersonCount(fact: Fact): boolean {
  return fact.value === 4 && fact.semantic?.kind === 'count' && fact.semantic.unit === 'person';
}

function isKrwMoney(fact: Fact): boolean {
  return fact.value === 900000 && fact.semantic?.kind === 'money' && fact.semantic.unit === 'KRW';
}

function hasShare225000(items: BlockItem[]): boolean {
  return items.some((item) => item.value === '225000' && item.calculation?.kind === 'divide');
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  method: string,
  path: string,
  body: unknown,
  options: { artifact: SmokeArtifact; cookie?: string | null; allowedStatuses?: number[]; timeoutMs?: number },
): Promise<{ body: T; cookie: string | null; status: number }> {
  const response = await request(fetchImpl, method, path, body, options);
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SmokeError('invalid_json');
  }
  return { body: parsed as T, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? options.cookie ?? null, status: response.status };
}

async function requestEmpty(
  fetchImpl: FetchLike,
  method: string,
  path: string,
  options: { artifact: SmokeArtifact; cookie?: string | null; allowedStatuses?: number[]; timeoutMs?: number },
): Promise<Response> {
  return request(fetchImpl, method, path, undefined, options);
}

async function request(
  fetchImpl: FetchLike,
  method: string,
  path: string,
  body: unknown,
  options: { artifact: SmokeArtifact; cookie?: string | null; allowedStatuses?: number[]; timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MS));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${STAGING_ORIGIN}${path}`, {
      method,
      headers: {
        Origin: STAGING_ORIGIN,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new SmokeError('request_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const allowed = options.allowedStatuses ?? [200, 201];
  options.artifact.steps.push({ name: `${method} ${path.replace(/\/ws_[^/]+|\/run_[^/]+/g, '/:id')}`, status: response.status, ok: allowed.includes(response.status) });
  if (!allowed.includes(response.status)) throw new SmokeError('http_error');
  return response;
}

async function runHook(
  hook: StagingLiveSmokeOptions['afterReady'],
  state: { workspaceId: string; runId: string; artifactPath: string },
  options: StagingLiveSmokeOptions,
): Promise<void> {
  if (!hook) return;
  const timeoutMs = Math.max(1, Math.min(options.hookTimeoutMs ?? HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS));
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      hook(state),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new SmokeError('hook_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SmokeError extends Error {
  constructor(public reason: FailureReason) {
    super(reason);
    this.name = 'SmokeError';
  }
}

function safeReason(error: unknown): FailureReason {
  if (error instanceof SmokeError) return error.reason;
  if (error instanceof Error && error.name === 'AbortError') return 'request_timeout';
  return 'unknown';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runStagingLiveSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(safeReason(error));
      process.exitCode = 1;
    });
}
