import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const manifestVersion = 1;
const defaultMaxAttemptsPerTask = 3;
const defaultMaxNoProgress = 2;
const gateTimeoutMs = 10 * 60 * 1000;
const expectedVerifyScript = 'npm run typecheck && npm run lint && npm run test:unit && npm run test:integration && npm run build';
const safeVerifyScripts = {
  typecheck: 'tsc --noEmit',
  lint: 'eslint .',
  'test:unit': 'vitest run --config vitest.config.ts',
  'test:integration': 'vitest run --config vitest.integration.config.ts',
  build: 'vite build',
} as const;
const excludedDirectories = new Set(['.git', '.omx', 'artifacts', 'dist', 'node_modules', '.wrangler', 'private', 'playwright-report', 'test-results']);
const excludedFiles = new Set(['.dev.vars']);
const protectedPrefixes = ['tests/', 'src/evaluation/', 'scripts/loop/'];
const protectedFiles = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.integration.config.ts',
  'eslint.config.js',
  'vite.config.ts',
  'wrangler.jsonc',
  'scripts/eval-live.ts',
  'scripts/eval-feedback.ts',
  'scripts/loop.ts',
  'src/core/model-policy.ts',
];
const maxIdLength = 80;
const maxTitleLength = 200;
const maxObjectiveLength = 500;
const maxAcceptanceLength = 500;
const maxTasks = 200;

const taskSchema = z.object({
  id: z.string().min(1).max(maxIdLength).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  title: z.string().min(1).max(maxTitleLength),
  priority: z.number().int().positive(),
  dependsOn: z.array(z.string()).default([]),
  acceptance: z.array(z.string().min(1).max(maxAcceptanceLength)).default([]),
});

const manifestSchema = z.object({
  version: z.literal(manifestVersion),
  id: z.string().min(1).max(maxIdLength).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  objective: z.string().min(1).max(maxObjectiveLength),
  tasks: z.array(taskSchema).min(1).max(maxTasks),
  maxAttemptsPerTask: z.number().int().min(1).max(5).default(defaultMaxAttemptsPerTask),
  maxNoProgress: z.number().int().min(1).max(3).default(defaultMaxNoProgress),
});

const attemptSchema = z.object({
  attempt: z.number().int().positive(),
  executor: z.string(),
  runnerPid: z.number().int().positive(),
  reservedAt: z.string(),
  baseFingerprint: z.string(),
  verifyRunnerPid: z.number().int().positive().optional(),
  verifyProcessGroup: z.number().int().positive().optional(),
  verifyStartedAt: z.string().optional(),
  beforeGateFingerprint: z.string().optional(),
  afterGateFingerprint: z.string().optional(),
  gate: z.object({
    command: z.literal('npm run verify'),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    summary: z.string(),
  }).optional(),
  review: z.object({
    reviewer: z.string(),
    verdict: z.enum(['approve', 'reject']),
    reviewedAt: z.string(),
    fingerprint: z.string(),
  }).optional(),
});

const stateSchema = z.object({
  manifest: manifestSchema,
  phase: z.enum(['ready', 'in_progress', 'awaiting_review', 'halted', 'complete']),
  tasks: z.record(z.string(), z.object({
    status: z.enum(['pending', 'in_progress', 'awaiting_review', 'completed', 'rejected', 'blocked']),
    attempts: z.number().int().min(0),
    executor: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    lastAttempt: attemptSchema.optional(),
    attemptReceipts: z.array(attemptSchema).default([]),
    progressSignatures: z.array(z.string()),
  })),
  baseline: z.object({
    protectedFiles: z.record(z.string(), z.string()),
    verifyScript: z.string(),
  }),
  haltedReason: z.string().optional(),
  history: z.array(z.object({
    at: z.string(),
    event: z.string(),
    taskId: z.string().optional(),
    detail: z.string().optional(),
  })),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type LoopManifest = z.infer<typeof manifestSchema>;
export type LoopState = z.infer<typeof stateSchema>;
export type ReviewVerdict = 'approve' | 'reject';
export type LoopAction =
  | { type: 'work'; taskId: string; title: string; attempt: number; acceptance: string[] }
  | { type: 'review'; taskId: string; fingerprint: string }
  | { type: 'halted'; reason: string }
  | { type: 'complete' }
  | { type: 'wait'; reason: string };

export type GateResult = {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  infrastructureFailure?: boolean;
};

export type ControllerOptions = {
  root: string;
  now?: () => Date;
  token?: () => string;
  gateRunner?: (root: string, onSpawn: (pid: number) => Promise<void>) => Promise<GateResult>;
  processAlive?: (pid: number) => boolean;
};

type LoadedLoop = {
  state: LoopState;
  statePath: string;
};

export class LoopController {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly token: () => string;
  private readonly gateRunner: NonNullable<ControllerOptions['gateRunner']>;
  private readonly processAlive: (pid: number) => boolean;

  constructor(options: ControllerOptions) {
    this.root = resolve(options.root);
    this.now = options.now ?? (() => new Date());
    this.token = options.token ?? randomUUID;
    this.gateRunner = options.gateRunner ?? runNpmVerify;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
  }

  async init(planPath: string): Promise<LoopState> {
    const text = await readFile(resolve(this.root, planPath), 'utf8');
    const manifest = validateManifest(JSON.parse(text));
    const statePath = this.statePath(manifest.id);
    return this.withLock(manifest.id, async () => {
      await assertMissing(statePath, `loop ${manifest.id} already exists`);
      const baseline = await collectProtectedBaseline(this.root);
      const state = this.newState(manifest, baseline);
      await writeJsonAtomic(statePath, state);
      return state;
    });
  }

  async status(id: string): Promise<{ state: LoopState; action: LoopAction }> {
    return this.withLock(id, async () => {
      const loop = await this.load(id);
      const state = await this.enforceBaseline(loop.state);
      if (state.phase === 'halted') await writeJsonAtomic(loop.statePath, state);
      return { state, action: this.nextAction(state) };
    });
  }

  async next(id: string, executor: string): Promise<{ state: LoopState; action: LoopAction }> {
    return this.withLock(id, async () => {
      const loop = await this.load(id);
      let state = loop.state;
      state = await this.enforceBaseline(state);
      if (state.phase === 'halted' || state.phase === 'complete' || state.phase === 'awaiting_review' || state.phase === 'in_progress') {
        await writeJsonAtomic(loop.statePath, state);
        return { state, action: this.nextAction(state) };
      }

      const task = selectEligibleTask(state);
      if (!task) {
        state.phase = allTasksComplete(state) ? 'complete' : 'ready';
        state = record(state, this.isoNow(), state.phase === 'complete' ? 'complete' : 'waiting', undefined, state.phase === 'complete' ? 'all tasks completed' : 'no eligible task');
        await writeJsonAtomic(loop.statePath, state);
        return { state, action: this.nextAction(state) };
      }

      const runtimeTask = state.tasks[task.id];
      if (runtimeTask.attempts >= state.manifest.maxAttemptsPerTask) {
        state = halt(state, this.isoNow(), `task ${task.id} reached max attempts`);
        await writeJsonAtomic(loop.statePath, state);
        return { state, action: this.nextAction(state) };
      }

      const fingerprint = await createRepositoryFingerprint(this.root);
      runtimeTask.status = 'in_progress';
      runtimeTask.executor = executor;
      runtimeTask.startedAt = this.isoNow();
      runtimeTask.attempts += 1;
      const attemptReceipt = {
        attempt: runtimeTask.attempts,
        executor,
        runnerPid: process.pid,
        reservedAt: this.isoNow(),
        baseFingerprint: fingerprint.hash,
      };
      runtimeTask.lastAttempt = attemptReceipt;
      runtimeTask.attemptReceipts.push(attemptReceipt);
      state.phase = 'in_progress';
      state.updatedAt = this.isoNow();
      state = record(state, this.isoNow(), 'reserved', task.id, `attempt ${runtimeTask.attempts} reserved`);
      await writeJsonAtomic(loop.statePath, state);
      return { state, action: { type: 'work', taskId: task.id, title: task.title, attempt: runtimeTask.attempts, acceptance: task.acceptance } };
    });
  }

  async verify(id: string): Promise<{ state: LoopState; ok: boolean; summary: string }> {
    return this.withLock(id, async () => {
      const loop = await this.load(id);
      let state = await this.enforceBaseline(loop.state);
      if (state.phase === 'halted') {
        await writeJsonAtomic(loop.statePath, state);
        return { state, ok: false, summary: state.haltedReason ?? 'halted' };
      }
      const activeTask = findTaskByStatus(state, 'in_progress');
      if (!activeTask) {
        state = halt(state, this.isoNow(), 'verify requires exactly one in-progress task');
        await writeJsonAtomic(loop.statePath, state);
        return { state, ok: false, summary: state.haltedReason ?? 'halted' };
      }
      const runtimeTask = state.tasks[activeTask.id];
      const attempt = runtimeTask.lastAttempt;
      if (!attempt) throw new Error(`task ${activeTask.id} is missing attempt metadata`);

      let verifyScript: string;
      try {
        verifyScript = await validateVerifyGate(this.root);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state = halt(state, this.isoNow(), `protected baseline changed: ${message}`);
        await writeJsonAtomic(loop.statePath, state);
        return { state, ok: false, summary: state.haltedReason ?? 'halted' };
      }
      if (verifyScript !== state.baseline.verifyScript) {
        state = halt(state, this.isoNow(), 'verify gate changed during loop');
        await writeJsonAtomic(loop.statePath, state);
        return { state, ok: false, summary: state.haltedReason ?? 'halted' };
      }

      const before = await createRepositoryFingerprint(this.root);
      attempt.beforeGateFingerprint = before.hash;
      attempt.verifyRunnerPid = process.pid;
      attempt.verifyStartedAt = this.isoNow();
      state.updatedAt = this.isoNow();
      state = record(state, this.isoNow(), 'gate_started', activeTask.id, before.hash);
      await writeJsonAtomic(loop.statePath, state);

      const result = await runGateSafely(this.gateRunner, this.root, async (pid) => {
        attempt.verifyProcessGroup = pid;
        syncLastAttemptReceipt(runtimeTask);
        await writeJsonAtomic(loop.statePath, state);
      });
      const after = await createRepositoryFingerprint(this.root);
      const gateSummary = summarizeGate(result);
      attempt.afterGateFingerprint = after.hash;
      attempt.gate = {
        command: 'npm run verify',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: Math.trunc(result.durationMs),
        summary: gateSummary,
      };
      syncLastAttemptReceipt(runtimeTask);

      if (result.infrastructureFailure) {
        state = halt(state, this.isoNow(), 'verify infrastructure failure; inspect runner before resuming');
      } else if (before.hash !== after.hash) {
        state = halt(state, this.isoNow(), 'repository changed while verify gate was running');
      } else if (result.timedOut || result.exitCode !== 0) {
        runtimeTask.status = 'rejected';
        state.phase = 'ready';
        state = record(state, this.isoNow(), 'gate_failed', activeTask.id, gateSummary);
        state = applyProgressCap(state, activeTask.id, before.hash, this.isoNow());
      } else {
        runtimeTask.status = 'awaiting_review';
        state.phase = 'awaiting_review';
        state = record(state, this.isoNow(), 'awaiting_review', activeTask.id, before.hash);
      }
      state.updatedAt = this.isoNow();
      await writeJsonAtomic(loop.statePath, state);
      return { state, ok: state.phase === 'awaiting_review', summary: gateSummary };
    });
  }

  async review(id: string, taskId: string, verdict: ReviewVerdict, reviewer: string): Promise<{ state: LoopState; accepted: boolean }> {
    return this.withLock(id, async () => {
      const loop = await this.load(id);
      let state = await this.enforceBaseline(loop.state);
      if (state.phase === 'halted') {
        await writeJsonAtomic(loop.statePath, state);
        return { state, accepted: false };
      }
      const runtimeTask = state.tasks[taskId];
      if (!runtimeTask || runtimeTask.status !== 'awaiting_review' || !runtimeTask.lastAttempt?.afterGateFingerprint) {
        state = halt(state, this.isoNow(), `review target ${taskId} is not awaiting review`);
        await writeJsonAtomic(loop.statePath, state);
        return { state, accepted: false };
      }
      if (runtimeTask.lastAttempt.executor === reviewer) {
        state = halt(state, this.isoNow(), `reviewer ${reviewer} matches executor for ${taskId}`);
        await writeJsonAtomic(loop.statePath, state);
        return { state, accepted: false };
      }
      const current = await createRepositoryFingerprint(this.root);
      if (current.hash !== runtimeTask.lastAttempt.afterGateFingerprint) {
        state = halt(state, this.isoNow(), `stale review for ${taskId}: repository fingerprint changed`);
        await writeJsonAtomic(loop.statePath, state);
        return { state, accepted: false };
      }

      runtimeTask.lastAttempt.review = { reviewer, verdict, reviewedAt: this.isoNow(), fingerprint: current.hash };
      syncLastAttemptReceipt(runtimeTask);
      if (verdict === 'approve') {
        runtimeTask.status = 'completed';
        runtimeTask.completedAt = this.isoNow();
        state.phase = allTasksComplete(state) ? 'complete' : 'ready';
        state = record(state, this.isoNow(), 'approved', taskId, current.hash);
      } else {
        runtimeTask.status = 'rejected';
        state.phase = 'ready';
        state = record(state, this.isoNow(), 'review_rejected', taskId, current.hash);
        state = applyProgressCap(state, taskId, current.hash, this.isoNow());
      }
      state.updatedAt = this.isoNow();
      await writeJsonAtomic(loop.statePath, state);
      return { state, accepted: verdict === 'approve' };
    });
  }

  async recover(id: string): Promise<LoopState> {
    return this.withLock(id, async () => {
      const loop = await this.load(id);
      let state = await this.enforceBaseline(loop.state);
      if (state.phase === 'halted') {
        await writeJsonAtomic(loop.statePath, state);
        return state;
      }
      const active = findTaskByStatus(state, 'in_progress');
      if (!active) {
        await writeJsonAtomic(loop.statePath, state);
        return state;
      }
      const runtimeTask = state.tasks[active.id];
      const ownerPid = runtimeTask.lastAttempt?.verifyRunnerPid;
      const processGroup = runtimeTask.lastAttempt?.verifyProcessGroup;
      if (ownerPid && (this.processAlive(ownerPid) || (processGroup && this.processAlive(-processGroup)))) {
        await writeJsonAtomic(loop.statePath, state);
        return state;
      }
      if (ownerPid && !processGroup) {
        state = halt(state, this.isoNow(), 'interrupted verification outcome unknown: child process group was not recorded');
        await writeJsonAtomic(loop.statePath, state);
        return state;
      }
      // recover is an explicit operator attestation that the native executor is
      // idle; the short-lived next CLI PID cannot establish that itself.
      runtimeTask.status = 'rejected';
      state.phase = 'ready';
      state = record(state, this.isoNow(), 'recovered_interrupted_attempt', active.id, ownerPid ? `owner pid ${ownerPid} no longer alive` : 'no owner pid recorded');
      state = applyProgressCap(state, active.id, (await createRepositoryFingerprint(this.root)).hash, this.isoNow());
      state.updatedAt = this.isoNow();
      await writeJsonAtomic(loop.statePath, state);
      return state;
    });
  }

  statePath(id: string): string {
    return join(this.root, '.omx', 'loops', validateLoopId(id), 'state.json');
  }

  private newState(manifest: LoopManifest, baseline: LoopState['baseline']): LoopState {
    const tasks: LoopState['tasks'] = {};
    for (const task of manifest.tasks) {
      tasks[task.id] = { status: 'pending', attempts: 0, attemptReceipts: [], progressSignatures: [] };
    }
    const now = this.isoNow();
    return { manifest, phase: 'ready', tasks, baseline, history: [{ at: now, event: 'initialized' }], createdAt: now, updatedAt: now };
  }

  private async load(id: string): Promise<LoadedLoop> {
    const statePath = this.statePath(id);
    const state = stateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')));
    return { state, statePath };
  }

  nextAction(state: LoopState): LoopAction {
    if (state.phase === 'halted') return { type: 'halted', reason: state.haltedReason ?? 'loop halted' };
    if (state.phase === 'complete') return { type: 'complete' };
    const reviewTask = findTaskByStatus(state, 'awaiting_review');
    if (reviewTask) {
      const fingerprint = state.tasks[reviewTask.id].lastAttempt?.afterGateFingerprint ?? 'unknown';
      return { type: 'review', taskId: reviewTask.id, fingerprint };
    }
    const activeTask = findTaskByStatus(state, 'in_progress');
    if (activeTask) return { type: 'wait', reason: `task ${activeTask.id} is in progress` };
    const nextTask = selectEligibleTask(state);
    if (!nextTask) return allTasksComplete(state) ? { type: 'complete' } : { type: 'wait', reason: 'waiting for dependencies' };
    return { type: 'work', taskId: nextTask.id, title: nextTask.title, attempt: state.tasks[nextTask.id].attempts + 1, acceptance: nextTask.acceptance };
  }

  private async enforceBaseline(state: LoopState): Promise<LoopState> {
    let baseline: LoopState['baseline'];
    try {
      baseline = await collectProtectedBaseline(this.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return halt(state, this.isoNow(), `protected baseline changed: ${message}`);
    }
    const changed = diffBaseline(state.baseline.protectedFiles, baseline.protectedFiles);
    if (changed.length > 0) return halt(state, this.isoNow(), `protected baseline changed: ${changed.join(', ')}`);
    if (baseline.verifyScript !== state.baseline.verifyScript) return halt(state, this.isoNow(), 'verify gate changed during loop');
    return state;
  }

  private lockPath(id: string): string {
    return join(this.root, '.omx', 'loops', validateLoopId(id), '.lock');
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(id);
    await mkdir(dirname(lockPath), { recursive: true });
    const lock = await acquireLock(lockPath, this.token(), this.processAlive);
    try {
      return await operation();
    } finally {
      await releaseLock(lockPath, lock.token);
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

export function validateManifest(input: unknown): LoopManifest {
  const manifest = manifestSchema.parse(input);
  const seen = new Set<string>();
  for (const task of manifest.tasks) {
    if (seen.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    seen.add(task.id);
  }
  for (const task of manifest.tasks) {
    for (const dependency of task.dependsOn) {
      if (!seen.has(dependency)) throw new Error(`task ${task.id} depends on unknown task ${dependency}`);
    }
  }
  assertAcyclic(manifest.tasks);
  return {
    ...manifest,
    tasks: [...manifest.tasks].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)),
  };
}

export function validateLoopId(id: string): string {
  return z.string().min(1).max(maxIdLength).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).parse(id);
}

export async function validateVerifyGate(root: string): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};
  const verify = packageJson.scripts?.verify;
  if (verify !== expectedVerifyScript) throw new Error(`npm run verify must remain the fixed gate: ${expectedVerifyScript}`);
  for (const [scriptName, expectedCommand] of Object.entries(safeVerifyScripts)) {
    if (scripts[scriptName] !== expectedCommand) {
      throw new Error(`package script ${scriptName} must remain ${expectedCommand}`);
    }
    const preHook = `pre${scriptName}`;
    const postHook = `post${scriptName}`;
    if (preHook in scripts || postHook in scripts) {
      throw new Error(`package script ${scriptName} must not define npm pre/post hooks`);
    }
  }
  for (const hook of ['preverify', 'postverify']) {
    if (hook in scripts) {
      throw new Error('npm run verify must not define npm pre/post hooks');
    }
  }
  return verify;
}

export async function createRepositoryFingerprint(root: string): Promise<{ hash: string; files: Record<string, string> }> {
  const files = await listFingerprintFiles(root);
  const hashes: Record<string, string> = {};
  const aggregate = createHash('sha256');
  for (const path of files) {
    const data = await readFile(join(root, path));
    const fileHash = createHash('sha256').update(data).digest('hex');
    hashes[path] = fileHash;
    aggregate.update(path).update('\0').update(fileHash).update('\0');
  }
  return { hash: aggregate.digest('hex'), files: hashes };
}

export async function collectProtectedBaseline(root: string): Promise<LoopState['baseline']> {
  const verifyScript = await validateVerifyGate(root);
  const files = await listFingerprintFiles(root);
  const protectedHashes: Record<string, string> = {};
  for (const path of files) {
    if (isProtectedPath(path)) {
      protectedHashes[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
    }
  }
  return { protectedFiles: protectedHashes, verifyScript };
}

export function selectEligibleTask(state: LoopState): LoopManifest['tasks'][number] | null {
  return selectEligibleTaskWithStatus(state, 'pending') ?? selectEligibleTaskWithStatus(state, 'rejected');
}

function selectEligibleTaskWithStatus(state: LoopState, status: 'pending' | 'rejected'): LoopManifest['tasks'][number] | null {
  return state.manifest.tasks.find((task) => {
    const runtimeTask = state.tasks[task.id];
    return Boolean(
      runtimeTask
      && runtimeTask.status === status
      && runtimeTask.attempts < state.manifest.maxAttemptsPerTask
      && task.dependsOn.every((dependency) => state.tasks[dependency]?.status === 'completed'),
    );
  }) ?? null;
}

async function listFingerprintFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const rel = normalizePath(relative(root, fullPath));
      if (!rel || excludedFiles.has(rel) || excludedDirectories.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.') || entry.name.startsWith('.dev.vars')) continue;
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) {
        if (shouldFingerprint(rel)) throw new Error('reviewable project files must not be symlinks');
        continue;
      }
      if (info.isDirectory()) {
        await walk(fullPath);
      } else if (info.isFile() && shouldFingerprint(rel)) {
        files.push(rel);
      }
    }
  }
  await walk(root);
  return files.sort();
}

function shouldFingerprint(path: string): boolean {
  return /^(src|scripts|tests|public|docs|migrations)\//.test(path) || isProtectedPath(path) || /\.(ts|tsx|js|mjs|cjs|json|jsonc|sql|css|html|md)$/.test(path);
}

function isProtectedPath(path: string): boolean {
  if (protectedFiles.includes(path)) return true;
  if (protectedPrefixes.some((prefix) => path.startsWith(prefix))) return true;
  return path.startsWith('docs/evaluation/');
}

function diffBaseline(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, hash] of Object.entries(expected)) {
    if (actual[path] !== hash) changed.push(path);
  }
  for (const path of Object.keys(actual)) {
    if (!(path in expected) && isProtectedPath(path) && !path.startsWith('tests/')) changed.push(path);
  }
  return changed.sort();
}

function assertAcyclic(tasks: LoopManifest['tasks']) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`task dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
}

function findTaskByStatus(state: LoopState, status: LoopState['tasks'][string]['status']): LoopManifest['tasks'][number] | null {
  return state.manifest.tasks.find((task) => state.tasks[task.id]?.status === status) ?? null;
}

function allTasksComplete(state: LoopState): boolean {
  return state.manifest.tasks.every((task) => state.tasks[task.id]?.status === 'completed');
}

function applyProgressCap(state: LoopState, taskId: string, fingerprint: string, now: string): LoopState {
  const runtimeTask = state.tasks[taskId];
  runtimeTask.progressSignatures.push(fingerprint);
  runtimeTask.progressSignatures = runtimeTask.progressSignatures.slice(-state.manifest.maxNoProgress);
  if (runtimeTask.attempts >= state.manifest.maxAttemptsPerTask) return halt(state, now, `task ${taskId} reached max attempts`);
  if (runtimeTask.progressSignatures.length >= state.manifest.maxNoProgress && new Set(runtimeTask.progressSignatures).size === 1) {
    return halt(state, now, `task ${taskId} made no fingerprint progress for ${state.manifest.maxNoProgress} attempts`);
  }
  return state;
}

async function runGateSafely(gateRunner: NonNullable<ControllerOptions['gateRunner']>, root: string, onSpawn: (pid: number) => Promise<void>): Promise<GateResult> {
  const started = Date.now();
  try {
    return await gateRunner(root, onSpawn);
  } catch {
    return { exitCode: null, timedOut: false, durationMs: Date.now() - started, infrastructureFailure: true };
  }
}

function syncLastAttemptReceipt(runtimeTask: LoopState['tasks'][string]): void {
  const attempt = runtimeTask.lastAttempt;
  if (!attempt) return;
  const index = runtimeTask.attemptReceipts.findIndex((receipt) => receipt.attempt === attempt.attempt);
  if (index >= 0) runtimeTask.attemptReceipts[index] = { ...attempt };
  else runtimeTask.attemptReceipts.push({ ...attempt });
}

function halt(state: LoopState, now: string, reason: string): LoopState {
  state.phase = 'halted';
  state.haltedReason = reason;
  state.updatedAt = now;
  return record(state, now, 'halted', undefined, reason);
}

function record(state: LoopState, at: string, event: string, taskId?: string, detail?: string): LoopState {
  state.history.push({ at, event, taskId, detail });
  state.updatedAt = at;
  return state;
}

function summarizeGate(result: GateResult): string {
  if (result.infrastructureFailure) return 'verify runner infrastructure failure';
  if (result.timedOut) return `npm run verify timed out after ${Math.trunc(result.durationMs)}ms`;
  if (result.exitCode === 0) return 'npm run verify passed';
  return `npm run verify failed with exit code ${result.exitCode}`;
}

async function runNpmVerify(root: string, onSpawn: (pid: number) => Promise<void>): Promise<GateResult> {
  await validateVerifyGate(root);
  const started = Date.now();
  return new Promise((resolveResult) => {
    const child = spawn('npm', ['run', 'verify'], { cwd: root, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let infrastructureFailure = false;
    const recorded = child.pid ? onSpawn(child.pid).catch(() => {
      infrastructureFailure = true;
      killProcessGroup(child.pid, 'SIGKILL');
    }) : Promise.resolve();
    let killTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcessGroup(child.pid, 'SIGKILL');
      }, 2_000);
    }, gateTimeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-4000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      void recorded.then(() => resolveResult({ exitCode: null, timedOut: false, durationMs: Date.now() - started, stdout, stderr: error.message, infrastructureFailure: true }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      void recorded.then(() => resolveResult({ exitCode: timedOut ? null : code, timedOut, durationMs: Date.now() - started, stdout, stderr, infrastructureFailure }));
    });
  });
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
}

type LockInfo = { pid: number; token: string; createdAt: number };

async function acquireLock(lockPath: string, token: string, processAlive: (pid: number) => boolean): Promise<LockInfo> {
  const info: LockInfo = { pid: process.pid, token, createdAt: Date.now() };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify(info), { flag: 'wx' });
      return info;
    } catch (error) {
      if (!isFileExists(error)) throw error;
      const owner = await readLockInfo(lockPath);
      if (owner && !processAlive(owner.pid)) {
        await reclaimStaleLock(lockPath, owner.token, processAlive);
        continue;
      }
      throw new Error(`loop is locked by pid ${owner?.pid ?? 'unknown'}`, { cause: error });
    }
  }
  throw new Error('could not acquire loop lock');
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  const owner = await readLockInfo(lockPath);
  if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
}

async function reclaimStaleLock(lockPath: string, expectedToken: string, processAlive: (pid: number) => boolean): Promise<void> {
  // Claim inside the old directory before renaming it. Competing reclaimers
  // cannot both move the path after another runner has acquired a fresh lock.
  const claimPath = join(lockPath, 'reclaim');
  try {
    await mkdir(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('loop lock recovery already in progress; inspect its owner before resuming', { cause: error });
  }
  const current = await readLockInfo(lockPath);
  if (!current || current.token !== expectedToken || processAlive(current.pid)) {
    await rm(claimPath, { recursive: true, force: true });
    return;
  }
  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
    await rm(stalePath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  try {
    return z.object({ pid: z.number().int().positive(), token: z.string().min(1).max(200), createdAt: z.number().finite().nonnegative() })
      .parse(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  const file = await open(tempPath, 'r');
  await file.sync();
  await file.close();
  await rename(tempPath, path);
}

async function assertMissing(path: string, message: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function isFileExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
