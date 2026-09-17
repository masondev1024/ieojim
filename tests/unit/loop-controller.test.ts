import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopController, validateManifest, type GateResult } from '../../scripts/loop/controller';

let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `ieojim-loop-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'tests', 'unit'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      'test:unit': 'vitest run --config vitest.config.ts',
      'test:integration': 'vitest run --config vitest.integration.config.ts',
      build: 'vite build',
      verify: 'npm run typecheck && npm run lint && npm run test:unit && npm run test:integration && npm run build',
    },
  }, null, 2));
  await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n');
  await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'vitest.integration.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'eslint.config.js'), 'export default [];\n');
  await writeFile(join(root, 'vite.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'wrangler.jsonc'), '{}\n');
  await writeFile(join(root, 'src', 'engine.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'scripts', 'existing.ts'), 'export const script = 1;\n');
  await writeFile(join(root, 'tests', 'unit', 'existing.test.ts'), 'export const test = 1;\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loop manifest validation', () => {
  it('rejects duplicate ids, unknown dependencies, and dependency cycles', () => {
    const baseTask = { id: 'a', title: 'A', priority: 1, dependsOn: [], acceptance: ['done'] };
    expect(() => validateManifest({ version: 1, id: 'loop', objective: 'ship', tasks: [baseTask, baseTask] })).toThrow('duplicate task id a');
    expect(() => validateManifest({ version: 1, id: 'loop', objective: 'ship', tasks: [{ ...baseTask, dependsOn: ['missing'] }] })).toThrow('depends on unknown task missing');
    expect(() => validateManifest({
      version: 1,
      id: 'loop',
      objective: 'ship',
      tasks: [
        { ...baseTask, id: 'a', dependsOn: ['b'] },
        { ...baseTask, id: 'b', dependsOn: ['a'] },
      ],
    })).toThrow('dependency cycle');
  });
});

describe('loop controller', () => {
  it('reserves tasks by priority and dependency readiness, then completes the DAG after review', async () => {
    await writePlan('plan.json', [
      task('root-b', 2),
      task('root-a', 1),
      task('child', 1, ['root-a']),
    ]);
    const controller = newController(gatePass());
    await controller.init('plan.json');

    const first = await controller.next('loop', 'executor-a');
    expect(first.action).toMatchObject({ type: 'work', taskId: 'root-a', attempt: 1 });
    const verified = await controller.verify('loop');
    expect(verified.ok).toBe(true);
    const approved = await controller.review('loop', 'root-a', 'approve', 'reviewer-a');
    expect(approved.state.tasks['root-a'].status).toBe('completed');

    const second = await controller.next('loop', 'executor-b');
    expect(second.action).toMatchObject({ type: 'work', taskId: 'child' });
    await controller.verify('loop');
    await controller.review('loop', 'child', 'approve', 'reviewer-a');
    await controller.next('loop', 'executor-b');
    await controller.verify('loop');
    const final = await controller.review('loop', 'root-b', 'approve', 'reviewer-a');
    expect(final.state.phase).toBe('complete');
  });

  it('does not complete a task when the fixed verify gate fails and allows independent work next', async () => {
    await writePlan('plan.json', [task('a', 1), task('b', 2)]);
    const controller = newController(async () => ({ exitCode: 1, timedOut: false, durationMs: 10, stderr: 'synthetic failure' }));
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');

    const verified = await controller.verify('loop');
    expect(verified.ok).toBe(false);
    expect(verified.summary).not.toContain('synthetic failure');
    expect(verified.state.tasks.a.status).toBe('rejected');
    expect(verified.state.tasks.a.status).not.toBe('completed');
    const next = await controller.next('loop', 'executor-b');
    expect(next.action).toMatchObject({ type: 'work', taskId: 'b' });
  });

  it('halts on stale review when the repository fingerprint no longer matches the verified result', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass());
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    await controller.verify('loop');
    await writeFile(join(root, 'docs-note.md'), 'changed after verification\n');

    const reviewed = await controller.review('loop', 'a', 'approve', 'reviewer-a');
    expect(reviewed.state.phase).toBe('halted');
    expect(reviewed.state.haltedReason).toContain('stale review');
  });

  it('halts when protected baseline criteria or the verify gate changes during a loop', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass());
    await controller.init('plan.json');
    await writeFile(join(root, 'package.json'), JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        'test:unit': 'vitest run --config vitest.config.ts',
        'test:integration': 'vitest run --config vitest.integration.config.ts',
        build: 'vite build',
        verify: 'npm run test:unit',
      },
    }, null, 2));

    const result = await controller.next('loop', 'executor-a');
    expect(result.state.phase).toBe('halted');
    expect(result.state.haltedReason).toContain('npm run verify must remain the fixed gate');
  });

  it('rejects npm pre/post hooks around the fixed verify gate', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    await writeFile(join(root, 'package.json'), JSON.stringify({
      scripts: {
        preverify: 'node injected.js',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        'test:unit': 'vitest run --config vitest.config.ts',
        'test:integration': 'vitest run --config vitest.integration.config.ts',
        build: 'vite build',
        verify: 'npm run typecheck && npm run lint && npm run test:unit && npm run test:integration && npm run build',
      },
    }, null, 2));
    const controller = newController(gatePass());
    await expect(controller.init('plan.json')).rejects.toThrow('npm run verify must not define npm pre/post hooks');
  });

  it('allows ordinary source edits but halts when existing tests change during a loop', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass());
    await controller.init('plan.json');
    await writeFile(join(root, 'src', 'engine.ts'), 'export const value = 2;\n');
    const reserved = await controller.next('loop', 'executor-a');
    expect(reserved.action).toMatchObject({ type: 'work', taskId: 'a' });
    await writeFile(join(root, 'tests', 'unit', 'existing.test.ts'), 'export const test = 2;\n');
    const verified = await controller.verify('loop');
    expect(verified.state.phase).toBe('halted');
    expect(verified.state.haltedReason).toContain('tests/unit/existing.test.ts');
  });

  it('halts after repeated identical failed progress reaches maxNoProgress', async () => {
    await writePlan('plan.json', [task('a', 1)], { maxAttemptsPerTask: 5, maxNoProgress: 2 });
    const controller = newController(async () => ({ exitCode: 1, timedOut: false, durationMs: 10, stderr: 'same failure' }));
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    await controller.verify('loop');
    await controller.next('loop', 'executor-a');
    const secondFailure = await controller.verify('loop');

    expect(secondFailure.state.phase).toBe('halted');
    expect(secondFailure.state.haltedReason).toContain('no fingerprint progress');
    expect(secondFailure.state.tasks.a.attemptReceipts).toHaveLength(2);
  });

  it('recovers an interrupted in-flight task only when the recorded runner is no longer alive', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const alive = newController(gatePass(), () => true);
    await alive.init('plan.json');
    await alive.next('loop', 'executor-a');
    await markVerifyStarted(12345);
    const unchanged = await alive.recover('loop');
    expect(unchanged.tasks.a.status).toBe('in_progress');

    const dead = newController(gatePass(), () => false);
    const recovered = await dead.recover('loop');
    expect(recovered.tasks.a.status).toBe('rejected');
    expect(recovered.phase).toBe('ready');
  });

  it('recovers a reserved attempt before verify and applies the final-attempt cap', async () => {
    await writePlan('plan.json', [task('a', 1)], { maxAttemptsPerTask: 1 });
    const controller = newController(gatePass());
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    const recovered = await controller.recover('loop');
    expect(recovered.phase).toBe('halted');
    expect(recovered.haltedReason).toContain('max attempts');
    expect((await controller.next('loop', 'executor-a')).action.type).toBe('halted');
  });

  it('resumes reserved work within the attempt limit after explicit idle recovery', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass());
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    expect((await controller.recover('loop')).phase).toBe('ready');
    expect((await controller.next('loop', 'executor-b')).action).toMatchObject({ type: 'work', attempt: 2 });
  });

  it('does not recover when the detached verify group remains alive after its controller exits', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass(), (pid) => pid === -54321);
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    await markVerifyStarted(12345, 54321);
    expect((await controller.recover('loop')).tasks.a.status).toBe('in_progress');
  });

  it('halts rather than guessing if controller death left child identity unrecorded', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass(), () => false);
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    await markVerifyStarted(12345, null);
    expect((await controller.recover('loop')).haltedReason).toContain('outcome unknown');
  });

  it('records the spawned verifier group before the gate can complete', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = new LoopController({ root, gateRunner: async (_root, onSpawn) => {
      await onSpawn(54321);
      const state = JSON.parse(await readFile(join(root, '.omx/loops/loop/state.json'), 'utf8'));
      expect(state.tasks.a.lastAttempt.verifyProcessGroup).toBe(54321);
      return { exitCode: 0, timedOut: false, durationMs: 1 };
    } });
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    expect((await controller.verify('loop')).ok).toBe(true);
  });

  it('halts safely on runner infrastructure errors without recording arbitrary error messages', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(async () => { throw new Error('synthetic-private-secret'); });
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    const result = await controller.verify('loop');
    expect(result.state.haltedReason).toContain('infrastructure');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-secret');
  });

  it('binds review to shipped binary assets and rejects new code symlinks', async () => {
    await mkdir(join(root, 'public'));
    await writeFile(join(root, 'public/logo.png'), Buffer.from([1, 2, 3]));
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass());
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    await controller.verify('loop');
    await writeFile(join(root, 'public/logo.png'), Buffer.from([4, 5, 6]));
    expect((await controller.review('loop', 'a', 'approve', 'reviewer')).state.haltedReason).toContain('stale review');
    await symlink(join(root, 'src/engine.ts'), join(root, 'src/alias.ts'));
    expect((await controller.status('loop')).state.haltedReason).toContain('symlinks');
  });

  it('allows prompt implementation repair and retains failure evidence through a passing correction', async () => {
    await mkdir(join(root, 'src/server'));
    await writeFile(join(root, 'src/server/model.ts'), 'before');
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(async () => ({
      exitCode: (await readFile(join(root, 'src/server/model.ts'), 'utf8')) === 'corrected' ? 0 : 1,
      timedOut: false, durationMs: 1,
    }));
    await controller.init('plan.json');
    await controller.next('loop', 'executor');
    expect((await controller.verify('loop')).ok).toBe(false);
    await controller.next('loop', 'executor');
    await writeFile(join(root, 'src/server/model.ts'), 'corrected');
    expect((await controller.verify('loop')).ok).toBe(true);
    const reviewed = await controller.review('loop', 'a', 'approve', 'reviewer');
    expect(reviewed.state.phase).toBe('complete');
    expect(reviewed.state.tasks.a.attemptReceipts.map((attempt) => attempt.gate?.exitCode)).toEqual([1, 0]);
  });

  it('rejects duplicate concurrent operations while a live lock is present', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = new LoopController({
      root,
      gateRunner: async () => gatePass()(),
      processAlive: () => true,
      now: () => new Date('2026-09-12T00:00:00.000Z'),
      token: () => 'test-token',
    });
    await controller.init('plan.json');
    await mkdir(join(root, '.omx', 'loops', 'loop', '.lock'), { recursive: true });
    await writeFile(join(root, '.omx', 'loops', 'loop', '.lock', 'owner.json'), JSON.stringify({ pid: 12345, token: 'other', createdAt: 1 }));

    await expect(controller.status('loop')).rejects.toThrow('loop is locked by pid 12345');
  });

  it('serializes concurrent stale-lock recovery and reserves the task only once', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass(), (pid) => pid === process.pid);
    await controller.init('plan.json');
    const lock = join(root, '.omx/loops/loop/.lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 12345, token: 'dead-owner', createdAt: 1 }));
    await Promise.allSettled([controller.next('loop', 'executor-a'), controller.next('loop', 'executor-b')]);
    const status = await controller.status('loop');
    expect(status.state.tasks.a.attempts).toBe(1);
    expect(status.state.tasks.a.status).toBe('in_progress');
  });

  it('does not guess ownership or steal malformed locks', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass(), () => false);
    await controller.init('plan.json');
    const lock = join(root, '.omx/loops/loop/.lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), '{"pid":0}');
    await expect(controller.status('loop')).rejects.toThrow('locked by pid unknown');
    expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe('{"pid":0}');
  });

  it('rejects path traversal ids before resolving state paths', async () => {
    const controller = newController(gatePass());
    await expect(controller.status('../escape')).rejects.toThrow();
  });

  it('supports the documented node --import tsx CLI init and status flow', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const init = await runCli(['init', '--plan', 'plan.json']);
    expect(init.exitCode).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({ ok: true, state: { id: 'loop', phase: 'ready' }, nextAction: { type: 'work', taskId: 'a' } });

    const status = await runCli(['status', '--id', 'loop']);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, state: { id: 'loop', phase: 'ready' }, nextAction: { type: 'work', taskId: 'a' } });
  });

  it('prevents self-review when the reviewer matches the recorded executor identity', async () => {
    await writePlan('plan.json', [task('a', 1)]);
    const controller = newController(gatePass());
    await controller.init('plan.json');
    await controller.next('loop', 'executor-a');
    await controller.verify('loop');

    const reviewed = await controller.review('loop', 'a', 'approve', 'executor-a');
    expect(reviewed.state.phase).toBe('halted');
    expect(reviewed.state.haltedReason).toContain('matches executor');
  });
});

function newController(gateRunner: () => Promise<GateResult>, processAlive?: (pid: number) => boolean) {
  return new LoopController({
    root,
    gateRunner: async () => gateRunner(),
    processAlive,
    now: () => new Date('2026-09-12T00:00:00.000Z'),
    token: () => 'test-token',
  });
}

function gatePass() {
  return async () => ({ exitCode: 0, timedOut: false, durationMs: 10 });
}

function runCli(args: string[]) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolveResult) => {
    execFile(process.execPath, [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('../../scripts/loop.ts', import.meta.url)),
      ...args,
    ], { cwd: root }, (error, stdout, stderr) => {
      resolveResult({ exitCode: error && 'code' in error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

async function writePlan(path: string, tasks: ReturnType<typeof task>[], overrides: Record<string, unknown> = {}) {
  await writeFile(join(root, path), JSON.stringify({
    version: 1,
    id: 'loop',
    objective: 'test loop',
    tasks,
    ...overrides,
  }, null, 2));
}

function task(id: string, priority: number, dependsOn: string[] = []) {
  return { id, title: `Task ${id}`, priority, dependsOn, acceptance: [`${id} accepted`] };
}

async function markVerifyStarted(pid: number, group: number | null = pid) {
  const statePath = join(root, '.omx', 'loops', 'loop', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    tasks: {
      a: {
        lastAttempt: { verifyRunnerPid?: number; verifyStartedAt?: string; verifyProcessGroup?: number };
        attemptReceipts: Array<{ verifyRunnerPid?: number; verifyStartedAt?: string; verifyProcessGroup?: number }>;
      };
    };
  };
  state.tasks.a.lastAttempt.verifyRunnerPid = pid;
  state.tasks.a.lastAttempt.verifyStartedAt = '2026-09-12T00:00:00.000Z';
  state.tasks.a.attemptReceipts[0].verifyRunnerPid = pid;
  state.tasks.a.attemptReceipts[0].verifyStartedAt = '2026-09-12T00:00:00.000Z';
  if (group) {
    state.tasks.a.lastAttempt.verifyProcessGroup = group;
    state.tasks.a.attemptReceipts[0].verifyProcessGroup = group;
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
