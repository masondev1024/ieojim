import { describe, expect, it } from 'vitest';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';
import { repairSchedule } from '../../src/core/schedule-repair';
import { buildEmailDraft, createLocalRecoveryPlan, defaultRecoveryDraft, planFromRecoveryView } from '../../src/client/recovery/recovery-model';
import type { RecoveryView } from '../../src/core/recovery-api-contracts';

describe('recovery client model', () => {
  it('keeps accepted external actions distinct from verified application', () => {
    const input = createRecoveryExample();
    const result = repairSchedule(input);
    if (result.status !== 'ready') throw new Error(result.message);

    const view: RecoveryView = {
      workspaceId: 'workspace:recovery-demo',
      revision: 8,
      sourceRevision: 3,
      conditionRevision: 2,
      input,
      result,
      proposalId: 'proposal_1',
      applied: true,
      actions: [
        { id: 'action_calendar', kind: 'calendar', status: 'verified', message: 'Calendar readback matched.', createdAt: '2026-09-15T00:00:00.000Z' },
        { id: 'action_email', kind: 'email', status: 'accepted', message: 'Provider accepted the send request.', createdAt: '2026-09-15T00:01:00.000Z' },
      ],
    };

    const plan = planFromRecoveryView(view);

    expect(plan.external.calendar).toBe('applied');
    expect(plan.external.email).toBe('accepted');
  });

  it('builds a minimal change-only email draft without private schedule details', () => {
    const draft = buildEmailDraft(createLocalRecoveryPlan(defaultRecoveryDraft));

    expect(draft.recipient).toBe('');
    expect(draft.body).toContain('새 발표 시간: 금요일 11:00–12:00');
    expect(draft.body).toContain('자료 제출 기준: 금요일 10:00');
    expect(draft.body).not.toMatch(/개인|경비|준비 확보|이동한 작업|보호/);
  });
});
