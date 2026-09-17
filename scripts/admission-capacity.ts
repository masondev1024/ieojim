import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { LIMITS } from '../src/core/contracts';
import { parseJsonc } from './deploy-readiness';

const integer = z.number().int().nonnegative().safe();
const positiveSetting = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(integer.positive());
const usageSchema = z.object({
  reserved_total_micro_usd: integer,
  reserved_today_micro_usd: integer,
  model_budget_policy_violations: integer,
}).refine((usage) => usage.reserved_today_micro_usd <= usage.reserved_total_micro_usd, 'Daily reservations cannot exceed total reservations.');
const policySchema = z.object({
  DAILY_BUDGET_MICRO_USD: positiveSetting,
  TOTAL_BUDGET_MICRO_USD: positiveSetting,
  OWNER_DAILY_RUNS: positiveSetting,
});

export function describeAdmissionCapacity(settings: unknown, observation: unknown, reserveMicroUsd = LIMITS.reserveMicroUsd) {
  const policy = policySchema.parse(settings);
  const usage = usageSchema.parse(observation);
  integer.positive().parse(reserveMicroUsd);
  const slots = (cap: number, used: number) => Math.floor(Math.max(0, cap - used) / reserveMicroUsd);
  const dailyRemaining = slots(policy.DAILY_BUDGET_MICRO_USD, usage.reserved_today_micro_usd);
  const totalRemaining = slots(policy.TOTAL_BUDGET_MICRO_USD, usage.reserved_total_micro_usd);
  const blockedByPolicy = usage.model_budget_policy_violations > 0;
  return {
    reserveMicroUsdPerRun: reserveMicroUsd,
    configured: {
      dailyMicroUsd: policy.DAILY_BUDGET_MICRO_USD,
      totalMicroUsd: policy.TOTAL_BUDGET_MICRO_USD,
      globalDailySlotsFromEmptyLedger: slots(policy.DAILY_BUDGET_MICRO_USD, 0),
      globalTotalSlotsFromEmptyLedger: slots(policy.TOTAL_BUDGET_MICRO_USD, 0),
      ownerDailyRunLimit: policy.OWNER_DAILY_RUNS,
    },
    observedReservations: usage,
    remainingAtObservation: {
      globalDailySlots: dailyRemaining,
      globalTotalSlots: totalRemaining,
      globalBudgetAdmissibleSlots: blockedByPolicy ? 0 : Math.min(dailyRemaining, totalRemaining),
      blockedByPolicy,
    },
    limitations: [
      'Projection uses local configuration and an earlier aggregate observation; it does not verify the deployed configuration or reserve a slot.',
      'Reservations are cumulative admission counters. Actual recorded cost does not refund admission capacity and is not subtracted here.',
      'Owner usage, authentication, storage limits, input bounds, provider quota and in-flight requests can further restrict admission.',
      'Reservation budgets are not provider invoice hard caps. Daily boundaries use UTC.',
    ],
  };
}

export function extractCapacityObservation(value: unknown) {
  const batches = z.array(z.object({ success: z.literal(true), results: z.array(z.record(z.string(), z.unknown())) })).parse(value);
  const rows = batches.flatMap((batch) => batch.results);
  const budgets = rows.filter((row) => 'reserved_total_micro_usd' in row);
  const timestamps = rows.filter((row) => 'observed_at_utc' in row);
  if (budgets.length !== 1 || timestamps.length !== 1) throw new Error('Expected exactly one budget aggregate and observation timestamp.');
  const observedAt = z.string().datetime().parse(timestamps[0].observed_at_utc);
  return { observedAt, usage: usageSchema.parse(budgets[0]) };
}

async function main() {
  const { values } = parseArgs({ options: {
    target: { type: 'string', default: 'staging' },
    'usage-file': { type: 'string' },
  } });
  if (values.target !== 'staging' || !values['usage-file']) throw new Error('Use --target staging --usage-file <ops-status aggregate JSON>.');
  const config = z.object({ env: z.object({ staging: z.object({ vars: z.unknown() }) }) })
    .parse(parseJsonc(await readFile('wrangler.jsonc', 'utf8')));
  const observed = extractCapacityObservation(JSON.parse(await readFile(values['usage-file'], 'utf8')));
  console.log(JSON.stringify({
    schema: 'ieojim.admission-capacity.v1',
    target: 'staging',
    configurationSource: 'local wrangler.jsonc',
    observedAt: observed.observedAt,
    ...describeAdmissionCapacity(config.env.staging.vars, observed.usage),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => {
    console.error('Capacity report rejected: verify target, local configuration and complete read-only aggregate JSON.');
    process.exitCode = 1;
  });
}
