import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonObject = Record<string, unknown>;

type CheckResult = {
  ok: boolean;
  ready: boolean;
  target: 'staging' | 'production';
  errors: string[];
  missingExternalInputs: string[];
  warnings: string[];
};

const configPath = resolve('wrangler.jsonc');
const placeholderD1Ids = new Set([
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000102',
]);
const placeholderRateLimitNamespaces = new Set(['100001', '100002']);
const requiredVars = ['APP_ENV', 'MODEL', 'DAILY_BUDGET_MICRO_USD', 'TOTAL_BUDGET_MICRO_USD', 'OWNER_DAILY_RUNS'];
const allZeroAccountId = '00000000000000000000000000000000';
const allZeroUuid = '00000000-0000-0000-0000-000000000000';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const accountIdPattern = /^[0-9a-f]{32}$/;

export function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingCommas(stripJsoncComments(text)));
}

export function evaluateDeploymentConfig(config: JsonObject, target: 'staging' | 'production'): CheckResult {
  const errors: string[] = [];
  const missingExternalInputs: string[] = [];
  const warnings: string[] = [];
  const envs = asObject(config.env);
  const env = envs ? asObject(envs[target]) : null;

  if (!env) {
    return { ok: false, ready: false, target, errors: [`env.${target} is missing`], missingExternalInputs, warnings };
  }

  const name = stringValue(env.name);
  if (!name) errors.push(`env.${target}.name is required`);
  if (target === 'staging' && name !== 'ieojim-staging') warnings.push(`env.${target}.name is not ieojim-staging`);
  if (target === 'production' && name !== 'ieojim') warnings.push(`env.${target}.name is not ieojim`);

  const accountId = stringValue(env.account_id);
  if (!accountId) {
    missingExternalInputs.push(`env.${target}.account_id`);
  } else {
    if (!accountIdPattern.test(accountId)) errors.push(`env.${target}.account_id must be a 32-character lowercase hex Cloudflare account id`);
    if (accountId === allZeroAccountId) errors.push(`env.${target}.account_id must not be all zeroes`);
  }

  checkAssets(env, target, errors);
  checkVars(env, target, errors);
  checkD1(config, env, target, errors, missingExternalInputs);
  checkQueue(env, target, errors);
  checkRateLimit(env, target, errors, missingExternalInputs);
  checkCron(env, target, errors);
  checkObservability(env, target, errors);
  if (envs) checkEnvironmentIsolation(envs, target, errors);
  addRemoteVerificationWarnings(target, warnings);

  return {
    ok: errors.length === 0,
    ready: errors.length === 0 && missingExternalInputs.length === 0,
    target,
    errors,
    missingExternalInputs,
    warnings,
  };
}

function checkAssets(env: JsonObject, target: string, errors: string[]) {
  const assets = asObject(env.assets);
  if (!assets) {
    errors.push(`env.${target}.assets is required because assets are not inherited`);
    return;
  }
  if (stringValue(assets.directory) !== './dist') errors.push(`env.${target}.assets.directory must be ./dist`);
  if (stringValue(assets.binding) !== 'ASSETS') errors.push(`env.${target}.assets.binding must be ASSETS`);
  const runWorkerFirst = Array.isArray(assets.run_worker_first) ? assets.run_worker_first : [];
  if (!runWorkerFirst.includes('/api/*')) errors.push(`env.${target}.assets.run_worker_first must include /api/*`);
}

function checkVars(env: JsonObject, target: 'staging' | 'production', errors: string[]) {
  const vars = asObject(env.vars);
  if (!vars) {
    errors.push(`env.${target}.vars is required because vars are not inherited`);
    return;
  }
  for (const key of requiredVars) {
    if (!stringValue(vars[key])) errors.push(`env.${target}.vars.${key} is required`);
  }
  if (stringValue(vars.APP_ENV) !== target) errors.push(`env.${target}.vars.APP_ENV must be ${target}`);
  if (stringValue(vars.MODEL) !== 'gemini-3.8-flash') errors.push(`env.${target}.vars.MODEL must be gemini-3.8-flash`);
  if ('GEMINI_API_KEY' in vars) errors.push(`env.${target}.vars must not contain GEMINI_API_KEY; use a Worker secret`);
}

function checkD1(config: JsonObject, env: JsonObject, target: 'staging' | 'production', errors: string[], missingExternalInputs: string[]) {
  const databases = arrayOfObjects(env.d1_databases);
  if (databases.length !== 1) {
    errors.push(`env.${target}.d1_databases must contain exactly one DB binding`);
    return;
  }
  const database = databases[0];
  const expectedName = target === 'staging' ? 'ieojim-staging' : 'ieojim-production';
  const databaseId = stringValue(database.database_id);
  if (stringValue(database.binding) !== 'DB') errors.push(`env.${target}.d1_databases[0].binding must be DB`);
  if (stringValue(database.database_name) !== expectedName) errors.push(`env.${target}.d1_databases[0].database_name must be ${expectedName}`);
  if (stringValue(database.migrations_dir) !== 'migrations') errors.push(`env.${target}.d1_databases[0].migrations_dir must be migrations`);
  if (!databaseId) {
    missingExternalInputs.push(`env.${target}.d1_databases[0].database_id`);
  } else if (placeholderD1Ids.has(databaseId)) {
    missingExternalInputs.push(`env.${target}.d1_databases[0].database_id placeholder ${databaseId}`);
  } else {
    if (!uuidPattern.test(databaseId)) errors.push(`env.${target}.d1_databases[0].database_id must be a UUID`);
    if (databaseId === allZeroUuid) errors.push(`env.${target}.d1_databases[0].database_id must not be all zeroes`);
    if (arrayOfObjects(config.d1_databases).some((entry) => stringValue(entry.database_id) === databaseId)) {
      errors.push(`env.${target}.d1_databases[0].database_id must not reuse the top-level local DB id`);
    }
  }
  if (String(database.database_name).includes('local') || String(database.database_name).includes('development')) {
    errors.push(`env.${target}.d1_databases[0].database_name must not reference local/development`);
  }
}

function checkQueue(env: JsonObject, target: 'staging' | 'production', errors: string[]) {
  const queues = asObject(env.queues);
  const expectedQueue = target === 'staging' ? 'ieojim-runs-staging' : 'ieojim-runs-production';
  const producers = queues ? arrayOfObjects(queues.producers) : [];
  const consumers = queues ? arrayOfObjects(queues.consumers) : [];
  if (!queues) errors.push(`env.${target}.queues is required because queues are not inherited`);
  if (producers.length !== 1) errors.push(`env.${target}.queues.producers must contain exactly one producer`);
  if (consumers.length !== 1) errors.push(`env.${target}.queues.consumers must contain exactly one consumer`);
  const producer = producers[0];
  const consumer = consumers[0];
  if (producer && stringValue(producer.binding) !== 'RUN_QUEUE') errors.push(`env.${target}.queues.producers[0].binding must be RUN_QUEUE`);
  if (producer && stringValue(producer.queue) !== expectedQueue) errors.push(`env.${target}.queues.producers[0].queue must be ${expectedQueue}`);
  if (consumer && stringValue(consumer.queue) !== expectedQueue) errors.push(`env.${target}.queues.consumers[0].queue must be ${expectedQueue}`);
  if (consumer && numberValue(consumer.max_batch_size) !== 1) errors.push(`env.${target}.queues.consumers[0].max_batch_size must be 1`);
  if (consumer && numberValue(consumer.max_batch_timeout) !== 1) errors.push(`env.${target}.queues.consumers[0].max_batch_timeout must be 1`);
  if (consumer && numberValue(consumer.max_retries) !== 3) errors.push(`env.${target}.queues.consumers[0].max_retries must be 3`);
  if (consumer && numberValue(consumer.max_concurrency) !== 1) errors.push(`env.${target}.queues.consumers[0].max_concurrency must be 1`);
}

function checkCron(env: JsonObject, target: 'staging' | 'production', errors: string[]) {
  const triggers = asObject(env.triggers);
  const crons = triggers && Array.isArray(triggers.crons) ? triggers.crons : [];
  if (!crons.includes('*/5 * * * *')) errors.push(`env.${target}.triggers.crons must include */5 * * * *`);
}

function checkObservability(env: JsonObject, target: 'staging' | 'production', errors: string[]) {
  const observability = asObject(env.observability);
  if (!observability) {
    errors.push(`env.${target}.observability is required`);
    return;
  }
  if (observability.enabled !== true) errors.push(`env.${target}.observability.enabled must be true`);
  const sampling = numberValue(observability.head_sampling_rate);
  if (sampling === null || sampling <= 0 || sampling > 1) errors.push(`env.${target}.observability.head_sampling_rate must be greater than 0 and at most 1`);
}

function checkEnvironmentIsolation(envs: JsonObject, target: 'staging' | 'production', errors: string[]) {
  const otherTarget = target === 'staging' ? 'production' : 'staging';
  const targetEnv = asObject(envs[target]);
  const otherEnv = asObject(envs[otherTarget]);
  if (!targetEnv || !otherEnv) return;

  const targetDatabaseId = firstDatabaseId(targetEnv);
  const otherDatabaseId = firstDatabaseId(otherEnv);
  if (targetDatabaseId && otherDatabaseId && targetDatabaseId === otherDatabaseId) {
    errors.push(`env.${target}.d1_databases[0].database_id must differ from env.${otherTarget}.d1_databases[0].database_id`);
  }

  const targetNamespaceId = rateLimitNamespaceId(targetEnv);
  const otherNamespaceId = rateLimitNamespaceId(otherEnv);
  if (targetNamespaceId && otherNamespaceId && targetNamespaceId === otherNamespaceId) {
    errors.push(`env.${target}.ratelimits.PUBLIC_WRITES.namespace_id must differ from env.${otherTarget}.ratelimits.PUBLIC_WRITES.namespace_id`);
  }
}

function addRemoteVerificationWarnings(target: 'staging' | 'production', warnings: string[]) {
  warnings.push(`${target} Worker secret GEMINI_API_KEY presence unchecked`);
  warnings.push(`${target} D1 remote database existence and migrations unchecked`);
  warnings.push(`${target} Queue producer/consumer provisioning unchecked`);
  warnings.push(`${target} Rate Limiting account namespace selection/collision unchecked`);
  warnings.push(`${target} cron/observability/alert delivery unchecked`);
}

function firstDatabaseId(env: JsonObject): string | null {
  return stringValue(arrayOfObjects(env.d1_databases)[0]?.database_id);
}

function rateLimitNamespaceId(env: JsonObject): string | null {
  return stringValue(arrayOfObjects(env.ratelimits).find((entry) => stringValue(entry.name) === 'PUBLIC_WRITES')?.namespace_id);
}

function checkRateLimit(env: JsonObject, target: 'staging' | 'production', errors: string[], missingExternalInputs: string[]) {
  const ratelimits = arrayOfObjects(env.ratelimits);
  const limiter = ratelimits.find((entry) => stringValue(entry.name) === 'PUBLIC_WRITES');
  if (!limiter) {
    errors.push(`env.${target}.ratelimits must include PUBLIC_WRITES`);
    return;
  }
  const namespaceId = stringValue(limiter.namespace_id);
  if (!namespaceId || !/^[1-9][0-9]*$/.test(namespaceId)) {
    errors.push(`env.${target}.ratelimits.PUBLIC_WRITES.namespace_id must be a positive integer string`);
  } else if (placeholderRateLimitNamespaces.has(namespaceId)) {
    missingExternalInputs.push(`env.${target}.ratelimits.PUBLIC_WRITES.namespace_id placeholder ${namespaceId}`);
  }
  const simple = asObject(limiter.simple);
  if (!simple) {
    errors.push(`env.${target}.ratelimits.PUBLIC_WRITES.simple is required`);
    return;
  }
  if (numberValue(simple.limit) !== 60) errors.push(`env.${target}.ratelimits.PUBLIC_WRITES.simple.limit must be 60`);
  if (numberValue(simple.period) !== 60) errors.push(`env.${target}.ratelimits.PUBLIC_WRITES.simple.period must be 60`);
}

function stripJsoncComments(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (inString) {
      output += current;
      const wasEscaped = escaped;
      escaped = current === '\\' ? !escaped : false;
      if (current !== '\\') escaped = false;
      if (current === '"' && !wasEscaped) inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function removeTrailingCommas(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    if (inString) {
      output += current;
      const wasEscaped = escaped;
      escaped = current === '\\' ? !escaped : false;
      if (current !== '\\') escaped = false;
      if (current === '"' && !wasEscaped) inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === ',') {
      let cursor = index + 1;
      while (/\s/.test(text[cursor] ?? '')) cursor += 1;
      if (text[cursor] === '}' || text[cursor] === ']') continue;
    }
    output += current;
  }
  return output;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function arrayOfObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const object = asObject(entry);
    return object ? [object] : [];
  }) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const targetArg = process.argv.find((arg) => arg.startsWith('--target='));
  const target = targetArg?.slice('--target='.length);
  const allowUnprovisioned = args.has('--allow-unprovisioned');
  if (target !== 'staging' && target !== 'production') {
    console.error('Usage: tsx scripts/deploy-readiness.ts --target=staging|production [--allow-unprovisioned]');
    process.exitCode = 2;
    return;
  }
  const parsed = asObject(parseJsonc(await readFile(configPath, 'utf8')));
  if (!parsed) throw new Error('wrangler.jsonc must contain a JSON object');
  const result = evaluateDeploymentConfig(parsed, target);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || (!allowUnprovisioned && !result.ready)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
