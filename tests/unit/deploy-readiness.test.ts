import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { evaluateDeploymentConfig, parseJsonc } from '../../scripts/deploy-readiness';

const validAccountId = '1234567890abcdef1234567890abcdef';
const stagingDatabaseId = '11111111-2222-4333-8444-555555555555';
const productionDatabaseId = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function validEnv(target: 'staging' | 'production', overrides: Record<string, unknown> = {}) {
  const databaseId = target === 'staging' ? stagingDatabaseId : productionDatabaseId;
  return {
    name: target === 'staging' ? 'ieojim-staging' : 'ieojim',
    account_id: validAccountId,
    assets: { directory: './dist', binding: 'ASSETS', run_worker_first: ['/api/*'] },
    vars: { APP_ENV: target, MODEL: 'gemini-3.8-flash', DAILY_BUDGET_MICRO_USD: '500000', TOTAL_BUDGET_MICRO_USD: '15000000', OWNER_DAILY_RUNS: '10' },
    d1_databases: [{ binding: 'DB', database_name: target === 'staging' ? 'ieojim-staging' : 'ieojim-production', database_id: databaseId, migrations_dir: 'migrations' }],
    queues: { producers: [{ binding: 'RUN_QUEUE', queue: target === 'staging' ? 'ieojim-runs-staging' : 'ieojim-runs-production' }], consumers: [{ queue: target === 'staging' ? 'ieojim-runs-staging' : 'ieojim-runs-production', max_batch_size: 1, max_batch_timeout: 1, max_retries: 3, max_concurrency: 1 }] },
    ratelimits: [{ name: 'PUBLIC_WRITES', namespace_id: target === 'staging' ? '700001' : '700002', simple: { limit: 60, period: 60 } }],
    triggers: { crons: ['*/5 * * * *'] },
    observability: { enabled: true, head_sampling_rate: 1 },
    ...overrides,
  };
}

it.each(['staging', 'production'] as const)('keeps %s structurally valid but unprovisioned until external Cloudflare IDs are set', (target) => {
  const environment = validEnv(target, {
    account_id: undefined,
    d1_databases: [{ binding: 'DB', database_name: target === 'staging' ? 'ieojim-staging' : 'ieojim-production', database_id: target === 'staging' ? '00000000-0000-0000-0000-000000000101' : '00000000-0000-0000-0000-000000000102', migrations_dir: 'migrations' }],
    ratelimits: [{ name: 'PUBLIC_WRITES', namespace_id: target === 'staging' ? '100001' : '100002', simple: { limit: 60, period: 60 } }],
  });
  const result = evaluateDeploymentConfig({ env: { [target]: environment } }, target);
  expect(result.ok).toBe(true);
  expect(result.ready).toBe(false);
  expect(result.errors).toEqual([]);
  expect(result.missingExternalInputs).toEqual(expect.arrayContaining([
    `env.${target}.account_id`,
    expect.stringMatching(new RegExp(`env\\.${target}\\.d1_databases\\[0\\]\\.database_id placeholder`)),
    expect.stringMatching(new RegExp(`env\\.${target}\\.ratelimits\\.PUBLIC_WRITES\\.namespace_id placeholder`)),
  ]));
});

it('keeps the repository environment configuration structurally valid as provisioning progresses', async () => {
  const config = parseJsonc(await readFile('wrangler.jsonc', 'utf8')) as Record<string, unknown>;
  for (const target of ['staging', 'production'] as const) expect(evaluateDeploymentConfig(config, target).errors).toEqual([]);
});

it('fails closed when production points at development storage or omits queue concurrency', () => {
  const result = evaluateDeploymentConfig({
    env: {
      production: {
        name: 'ieojim',
        account_id: 'real-account',
        assets: { directory: './dist', binding: 'ASSETS', run_worker_first: ['/api/*'] },
        vars: { APP_ENV: 'production', MODEL: 'gemini-3.8-flash', DAILY_BUDGET_MICRO_USD: '500000', TOTAL_BUDGET_MICRO_USD: '15000000', OWNER_DAILY_RUNS: '10' },
        d1_databases: [{ binding: 'DB', database_name: 'ieojim-local', database_id: 'real-d1', migrations_dir: 'migrations' }],
        queues: { producers: [{ binding: 'RUN_QUEUE', queue: 'ieojim-runs-production' }], consumers: [{ queue: 'ieojim-runs-production', max_batch_size: 1, max_batch_timeout: 1, max_retries: 3 }] },
        ratelimits: [{ name: 'PUBLIC_WRITES', namespace_id: '777777', simple: { limit: 60, period: 60 } }],
      },
    },
  }, 'production');
  expect(result.ready).toBe(false);
  expect(result.errors).toEqual(expect.arrayContaining([
    'env.production.account_id must be a 32-character lowercase hex Cloudflare account id',
    'env.production.d1_databases[0].database_name must be ieojim-production',
    'env.production.d1_databases[0].database_name must not reference local/development',
    'env.production.d1_databases[0].database_id must be a UUID',
    'env.production.queues.consumers[0].max_concurrency must be 1',
  ]));
});

it.each([
  ['malformed account', { account_id: 'real-account' }, 'env.production.account_id must be a 32-character lowercase hex Cloudflare account id'],
  ['all-zero account', { account_id: '00000000000000000000000000000000' }, 'env.production.account_id must not be all zeroes'],
  ['malformed database id', { d1_databases: [{ binding: 'DB', database_name: 'ieojim-production', database_id: 'real-d1', migrations_dir: 'migrations' }] }, 'env.production.d1_databases[0].database_id must be a UUID'],
  ['all-zero database id', { d1_databases: [{ binding: 'DB', database_name: 'ieojim-production', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }] }, 'env.production.d1_databases[0].database_id must not be all zeroes'],
])('rejects unsafe Cloudflare identifiers: %s', (_name, override, expected) => {
  const result = evaluateDeploymentConfig({ env: { production: validEnv('production', override) } }, 'production');
  expect(result.ok).toBe(false);
  expect(result.ready).toBe(false);
  expect(result.errors).toContain(expected);
});

it('rejects staging and production sharing the same D1 database or rate-limit namespace', () => {
  const config = {
    env: {
      staging: validEnv('staging', {
        d1_databases: [{ binding: 'DB', database_name: 'ieojim-staging', database_id: productionDatabaseId, migrations_dir: 'migrations' }],
        ratelimits: [{ name: 'PUBLIC_WRITES', namespace_id: '700002', simple: { limit: 60, period: 60 } }],
      }),
      production: validEnv('production'),
    },
  };
  const result = evaluateDeploymentConfig(config, 'production');
  expect(result.ok).toBe(false);
  expect(result.ready).toBe(false);
  expect(result.errors).toEqual(expect.arrayContaining([
    'env.production.d1_databases[0].database_id must differ from env.staging.d1_databases[0].database_id',
    'env.production.ratelimits.PUBLIC_WRITES.namespace_id must differ from env.staging.ratelimits.PUBLIC_WRITES.namespace_id',
  ]));
});

it('reports structurally valid remote ids as locally ready while keeping external release checks explicit', () => {
  const result = evaluateDeploymentConfig({
    env: {
      staging: validEnv('staging'),
      production: validEnv('production'),
    },
  }, 'production');

  expect(result.ok).toBe(true);
  expect(result.ready).toBe(true);
  expect(result.missingExternalInputs).toEqual([]);
  expect(result.warnings).toEqual([
    'production Worker secret GEMINI_API_KEY presence unchecked',
    'production D1 remote database existence and migrations unchecked',
    'production Queue producer/consumer provisioning unchecked',
    'production Rate Limiting account namespace selection/collision unchecked',
    'production cron/observability/alert delivery unchecked',
  ]);
});
