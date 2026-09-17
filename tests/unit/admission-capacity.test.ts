import { describe, expect, it } from 'vitest';
import { describeAdmissionCapacity, extractCapacityObservation } from '../../scripts/admission-capacity';

const settings = { DAILY_BUDGET_MICRO_USD: '250000', TOTAL_BUDGET_MICRO_USD: '1000000', OWNER_DAILY_RUNS: '10' };
const usage = { reserved_total_micro_usd: 97440, reserved_today_micro_usd: 0, model_budget_policy_violations: 0 };

describe('operator admission capacity', () => {
  it('keeps historical reservations charged even when actual usage is much lower', () => {
    const report = describeAdmissionCapacity(settings, { ...usage, recorded_cost_total_micro_usd: 11601 });
    expect(report.configured).toMatchObject({ globalDailySlotsFromEmptyLedger: 10, globalTotalSlotsFromEmptyLedger: 41 });
    expect(report.remainingAtObservation).toMatchObject({ globalDailySlots: 10, globalTotalSlots: 37, globalBudgetAdmissibleSlots: 10 });
  });
  it('uses the smaller total allowance and preserves the policy stop', () => {
    expect(describeAdmissionCapacity(settings, { ...usage, reserved_total_micro_usd: 990000 }).remainingAtObservation.globalBudgetAdmissibleSlots).toBe(0);
    expect(describeAdmissionCapacity(settings, { ...usage, model_budget_policy_violations: 1 }).remainingAtObservation)
      .toMatchObject({ blockedByPolicy: true, globalBudgetAdmissibleSlots: 0, globalTotalSlots: 37 });
  });
  it('rejects invalid policy or inconsistent observations rather than assuming free capacity', () => {
    expect(() => describeAdmissionCapacity({ ...settings, TOTAL_BUDGET_MICRO_USD: 'NaN' }, usage)).toThrow();
    expect(() => describeAdmissionCapacity(settings, { ...usage, reserved_today_micro_usd: 100000 })).toThrow();
    expect(() => describeAdmissionCapacity(settings, usage, 0)).toThrow();
  });
  it('rejects import summaries, failed queries and duplicate budget rows', () => {
    expect(() => extractCapacityObservation([{ success: true, results: [{ 'Rows written': 0 }] }])).toThrow();
    expect(() => extractCapacityObservation([{ success: false, results: [usage] }])).toThrow();
    expect(() => extractCapacityObservation([{ success: true, results: [usage, usage, { observed_at_utc: '2026-09-12T00:00:00.000Z' }] }])).toThrow();
    expect(extractCapacityObservation([{ success: true, results: [usage, { observed_at_utc: '2026-09-12T00:00:00.000Z' }] }]))
      .toEqual({ observedAt: '2026-09-12T00:00:00.000Z', usage });
  });
});
