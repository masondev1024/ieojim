import { describe, expect, it } from 'vitest';
import { actionMatchesPlan, assuranceMessage, latestCalendarAction } from '../../src/client/recovery/recovery-assurance';
import { planFromRecoveryView } from '../../src/client/recovery/recovery-model';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';
import { repairSchedule } from '../../src/core/schedule-repair';
import type { RecoveryView } from '../../src/core/recovery-api-contracts';
import { checkCalendarVerificationSchema, configureCalendarWatchSchema } from '../../src/core/recovery-verification-contracts';

function view(): RecoveryView {
  const input = createRecoveryExample();
  return {
    workspaceId: 'ws_assurance', revision: 2, sourceRevision: 1, conditionRevision: 1,
    input, result: repairSchedule(input), proposalId: 'proposal', applied: true,
    actions: [{ id: 'act_1', kind: 'calendar', status: 'verified', message: '실행 당시 재조회 확인',
      createdAt: '2026-09-19T00:00:00Z', baseRevision: 2, sourceRevision: 1, conditionRevision: 1 }],
  };
}

describe('change assurance status', () => {
  it('never presents local approval as a persisted or external success', () => {
    expect(assuranceMessage(undefined, true, false)).toContain('미리보기');
    expect(assuranceMessage({ ...view(), applied: false }, true, false)).toContain('적용해 주세요');
  });

  it('does not use an old approved action to confirm a new plan', () => {
    const current = view();
    current.revision = 3;
    expect(actionMatchesPlan(current.actions[0]!, current)).toBe(false);
    expect(planFromRecoveryView(current).external.calendar).toBe('needs_review');
    expect(assuranceMessage(current, true, false)).toContain('따로 선택');
  });

  it.each(['drifted', 'unavailable', 'stale'] as const)('keeps historical verified but warns about %s observation', (status) => {
    const current = view();
    current.actions[0]!.verification = { actionId: 'act_1', status, message: '다시 확인할 내용이 있어요.', checkedAt: '2026-09-19T00:15:00Z', events: [],
      watch: { enabled: false, expiresAt: null, nextCheckAt: null, consecutiveFailures: 0, stoppedReason: status } };
    expect(planFromRecoveryView(current).external.calendar).toBe('needs_review');
    expect(current.actions[0]!.status).toBe('verified');
    expect(assuranceMessage(current, true, false)).toBe('다시 확인할 내용이 있어요.');
  });

  it('describes a matched observation at the last check, without promising continuous consistency', () => {
    const current = view();
    current.actions[0]!.verification = { actionId: 'act_1', status: 'matched', message: '', checkedAt: '2026-09-19T00:15:00Z', events: [],
      watch: { enabled: true, expiresAt: '2026-09-20T00:15:00Z', nextCheckAt: '2026-09-19T00:30:00Z', consecutiveFailures: 0, stoppedReason: null } };
    expect(assuranceMessage(current, true, false)).toContain('마지막 재확인');
    expect(assuranceMessage(current, true, true)).toContain('다시 계산');
  });

  it('selects the last action deterministically and leaves historical order intact', () => {
    const current = view();
    current.actions.push({ ...current.actions[0]!, id: 'act_2' });
    expect(latestCalendarAction(current)?.id).toBe('act_2');
    expect(current.actions[0]!.id).toBe('act_1');
  });
});

describe('verification consent contracts', () => {
  const command = { actionId: 'act_1', baseRevision: 2, conditionRevision: 1, requestId: '22222222-2222-4222-8222-222222222222' };
  it('requires explicit true consent to enable and permits disabling without consent', () => {
    expect(configureCalendarWatchSchema.safeParse({ ...command, enabled: true }).success).toBe(false);
    expect(configureCalendarWatchSchema.safeParse({ ...command, enabled: true, consent: false }).success).toBe(false);
    expect(configureCalendarWatchSchema.safeParse({ ...command, enabled: true, consent: true }).success).toBe(true);
    expect(configureCalendarWatchSchema.safeParse({ ...command, enabled: false }).success).toBe(true);
  });
  it('rejects caller-supplied execution destinations or arbitrary cadence', () => {
    expect(checkCalendarVerificationSchema.safeParse({ ...command, calendarId: 'primary' }).success).toBe(false);
    expect(configureCalendarWatchSchema.safeParse({ ...command, enabled: true, consent: true, interval: 1 }).success).toBe(false);
  });
});
