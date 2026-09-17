import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const runId = String(process.pid);
const runtimeDir = join(root, '.wrangler', 'e2e-runtime', runId);
const assetsPath = join(runtimeDir, 'assets');
const configPath = join(runtimeDir, 'wrangler.jsonc');
const persistPath = join(root, '.wrangler', 'state-e2e', runId);
const apiPort = '8788';
const webPort = '5174';
const apiTarget = `http://127.0.0.1:${apiPort}`;
const wranglerCli = join(root, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js');
const viteCli = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const fixturePath = join(root, '.wrangler', 'e2e-runtime', 'account-fixtures.json');
const authSecret = randomBytes(32).toString('base64url');
const children = new Set<ChildProcess>();
let shuttingDown = false;

const e2eConfig = {
  $schema: join(root, 'node_modules', 'wrangler', 'config-schema.json'),
  name: 'ieojim-e2e',
  main: join(root, 'src', 'server', 'index.ts'),
  compatibility_date: '2026-09-07',
  compatibility_flags: ['nodejs_compat'],
  assets: {
    directory: assetsPath,
    binding: 'ASSETS',
    not_found_handling: 'single-page-application',
    run_worker_first: ['/api/*'],
  },
  d1_databases: [{
    binding: 'DB',
    database_name: 'ieojim-e2e-local',
    database_id: '11111111-1111-1111-1111-111111111111',
    migrations_dir: join(root, 'migrations'),
  }],
  queues: {
    producers: [{ binding: 'RUN_QUEUE', queue: 'ieojim-e2e-runs' }],
    consumers: [{ queue: 'ieojim-e2e-runs', max_batch_size: 1, max_batch_timeout: 1, max_retries: 3 }],
  },
  triggers: { crons: ['*/5 * * * *'] },
  vars: {
    APP_ENV: 'test',
    MODEL: 'gemini-3.8-flash',
    DAILY_BUDGET_MICRO_USD: '500000',
    TOTAL_BUDGET_MICRO_USD: '15000000',
    OWNER_DAILY_RUNS: '10',
  },
  observability: { enabled: true, head_sampling_rate: 1, redact_query_string: true },
};

async function main() {
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  // Keep later builds from triggering a Worker reload during browser requests.
  await cp(join(root, 'dist'), assetsPath, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(e2eConfig, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(runtimeDir, '.dev.vars'), `GEMINI_API_KEY=\nBETTER_AUTH_URL=http://127.0.0.1:${webPort}\nBETTER_AUTH_SECRET=${authSecret}\nGOOGLE_CLIENT_ID=e2e-google-client\nGOOGLE_CLIENT_SECRET=e2e-google-secret\n`, { mode: 0o600 });

  await runToCompletion(process.execPath, [
    wranglerCli,
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--config',
    configPath,
    '--persist-to',
    persistPath,
  ]);

  await seedAccountFixtures();

  start(process.execPath, [wranglerCli, 'dev', '--local', '--config', configPath, '--port', apiPort, '--persist-to', persistPath, '--log-level', 'warn']);
  start(process.execPath, [viteCli, '--host', '127.0.0.1'], {
    VITE_DEV_PORT: webPort,
    VITE_API_TARGET: apiTarget,
  });
}

// Synthetic, isolated browser fixtures; there is no application test-login API.
// Cookie signing secrets and rows exist only in this runner's temporary D1.
async function seedAccountFixtures() {
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const statements: string[] = [];
  const fixtures = Array.from({ length: 10 }, (_, index) => {
    const id = `e2e-account-${index}`;
    const name = `시험 계정 ${index}`;
    const email = `account-${index}@example.test`;
    statements.push(`INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('${id}','${name}','${email}',1,'${now}','${now}');`);
    const cookies = Array.from({ length: 2 }, (_, sessionIndex) => {
      const token = randomBytes(32).toString('base64url');
      const signature = createHmac('sha256', authSecret).update(token).digest('base64');
      statements.push(`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES('${id}-session-${sessionIndex}','${token}','${id}','${expiry}','${now}','${now}');`);
      return `ieojim-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
    });
    return { id, name, email, cookie: cookies[0], alternateCookie: cookies[1] };
  });
  const sqlFile = join(runtimeDir, 'account-fixtures.sql');
  await writeFile(sqlFile, statements.join('\n'), { mode: 0o600 });
  await runToCompletion(process.execPath, [wranglerCli, 'd1', 'execute', 'DB', '--local', '--config', configPath, '--persist-to', persistPath, '--file', sqlFile]);
  await writeFile(fixturePath, JSON.stringify(fixtures), { mode: 0o600 });
}

function start(command: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = trackedSpawn(command, args, env);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown) void shutdown(code ?? (signal ? 1 : 0));
  });
  return child;
}

function trackedSpawn(command: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    env: childEnv(env),
    stdio: 'inherit',
  });
  children.add(child);
  child.once('error', (error) => {
    children.delete(child);
    console.error(error.message);
    if (!shuttingDown) void shutdown(1);
  });
  return child;
}

function runToCompletion(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = trackedSpawn(command, args, { CI: process.env.CI ?? '1' });
    child.once('exit', (code) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'signal'}`));
    });
  });
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries({ ...process.env, ...extra })
    .filter(([key]) => !['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'CLOUDFLARE_INCLUDE_PROCESS_ENV'].includes(key))) as NodeJS.ProcessEnv;
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  return env;
}

async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  const exits = [...children].map(waitForExit);
  for (const child of children) child.kill('SIGTERM');
  await Promise.race([Promise.allSettled(exits), sleep(2_000)]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await cleanup();
  process.exit(code);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function cleanup() {
  await Promise.allSettled([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(persistPath, { recursive: true, force: true }),
    rm(fixturePath, { force: true }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupSync() {
  for (const path of [runtimeDir, persistPath, fixturePath]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Exit cleanup is best-effort; async shutdown performs the normal cleanup path.
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(0));
}

process.once('exit', cleanupSync);

await main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await shutdown(1);
});
