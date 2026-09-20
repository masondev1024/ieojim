import { describe, expect, it } from 'vitest';
import {
  CALENDAR_WATCH_DURATION_MS,
  CALENDAR_WATCH_INTERVAL_MS,
  CALENDAR_WATCH_MAX_FAILURES,
  checkCalendarVerificationSchema,
  configureCalendarWatchSchema,
} from '../../src/core/recovery-verification-contracts';

describe('recovery verification contracts', () => {
  it('requires explicit consent only when enabling the Calendar watch', () => {
    const base = { actionId: 'act_1', baseRevision: 3, conditionRevision: 4, requestId: '00000000-0000-4000-8000-000000000001' };

    expect(configureCalendarWatchSchema.safeParse({ ...base, enabled: true }).success).toBe(false);
    expect(configureCalendarWatchSchema.parse({ ...base, enabled: true, consent: true })).toMatchObject({ enabled: true, consent: true });
    expect(configureCalendarWatchSchema.parse({ ...base, enabled: false })).toMatchObject({ enabled: false });
  });

  it('keeps manual checks separate from watch configuration', () => {
    const command = { actionId: 'act_1', baseRevision: 3, conditionRevision: 4, requestId: '00000000-0000-4000-8000-000000000002' };

    expect(checkCalendarVerificationSchema.parse(command)).toEqual(command);
    expect(checkCalendarVerificationSchema.safeParse({ ...command, enabled: true, consent: true }).success).toBe(false);
  });

  it('caps the watch loop to the documented interval, duration, and failure count', () => {
    expect(CALENDAR_WATCH_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(CALENDAR_WATCH_DURATION_MS).toBe(24 * 60 * 60 * 1000);
    expect(CALENDAR_WATCH_MAX_FAILURES).toBe(3);
  });
});
