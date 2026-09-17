import { describe, expect, it } from 'vitest';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';
import { repairSchedule } from '../../src/core/schedule-repair';
import { buildEmailDraft, planFromRecoveryView } from '../../src/client/recovery/recovery-model';
import type { RecoveryView } from '../../src/core/recovery-api-contracts';

function noticeView(): RecoveryView {
  const input = createRecoveryExample();
  input.events = input.events.map((event) => ({
    ...event,
    title: event.id === input.change.presentationEventId ? '프로젝트 검토 회의' : event.title,
  }));
  return {
    workspaceId: 'derived-workspace', revision: 1, sourceRevision: 2, conditionRevision: 1,
    input, result: repairSchedule(input), proposalId: 'notice-proposal', applied: false, actions: [],
    origin: {
      workspaceId: 'origin-workspace', title: '검토 회의 변경 안내', revision: 3, sourceRevision: 2,
      sourceId: 'notice-source', sourceHash: 'recorded-hash', targetItemId: 'meeting-item',
      preparationItemId: null, sourceMode: 'live', noticeText: '검토 회의가 2026년 9월 18일 오전 11시로 바뀝니다.',
    },
  };
}

describe('source-linked recovery display', () => {
  it('uses the stored notice and confirmed conditions instead of demo explanations', () => {
    const view = noticeView();
    const plan = planFromRecoveryView(view);
    expect(plan.changedNotice).toBe(view.origin!.noticeText);
    expect(plan.confirmedConstraints.join('\n')).not.toContain('금요일 09:00');
    expect(plan.confirmedConstraints.join('\n')).toContain('2026-09-18 11:00');
    expect(plan.summary.preparationWindow).toContain('2026-09-17');
    expect(plan.summary.draftRecipients).toEqual([]);
  });

  it('derives outgoing draft times and title from the approved input without private commitments', () => {
    const draft = buildEmailDraft(planFromRecoveryView(noticeView()));
    expect(draft.title).toBe('프로젝트 검토 회의 시간 변경 확인');
    expect(draft.body).toContain('2026-09-18 11:00–2026-09-18 12:00');
    expect(draft.recipient).toBe('');
    expect(draft.body).not.toMatch(/금요일 발표|고정 상담|경비 정리|개인 고정/);
  });

  it('surfaces origin staleness even when the server has no event-level blockers', () => {
    const view = noticeView();
    view.result = { status: 'missing_information', code: 'stale_origin', message: '원래 안내가 바뀌었습니다.', blockers: [] };
    const plan = planFromRecoveryView(view);
    expect(plan.feasible).toBe(false);
    expect(plan.violations).toEqual([{ code: 'stale_origin', message: '원래 안내가 바뀌었습니다.', blockers: [] }]);
    expect(plan.approval.approved).toBe(false);
  });
});
