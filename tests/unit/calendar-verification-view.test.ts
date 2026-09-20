import { describe, expect, it } from 'vitest';
import type { RecoveryActionView } from '../../src/core/recovery-api-contracts';
import { calendarVerificationCopy, eventDifferenceText, latestVerification, originalExecutionCopy, watchSummary } from '../../src/client/recovery/calendar-verification-view';

describe('calendar verification view copy', () => {
  it('keeps original execution success separate from current not-checked state', () => {
    const action: RecoveryActionView = {
      id: 'action-calendar',
      kind: 'calendar',
      status: 'verified',
      message: 'Calendar readback matched.',
      createdAt: '2026-09-19T00:00:00.000Z',
      verifiedEvents: 4,
      totalEvents: 4,
    };

    expect(originalExecutionCopy(action)).toMatchObject({
      tone: 'success',
      title: '처리 직후 4/4개 이벤트를 확인했습니다.',
    });
    expect(latestVerification(action)).toMatchObject({
      status: 'not_checked',
      checkedAt: null,
      watch: { enabled: false },
    });
    expect(calendarVerificationCopy(latestVerification(action).status).tone).toBe('neutral');
  });

  it('does not present drift, unavailable, or stale checks as green success', () => {
    expect(calendarVerificationCopy('matched')).toMatchObject({ tone: 'success', label: '마지막 확인 일치' });
    expect(calendarVerificationCopy('drifted')).toMatchObject({ tone: 'danger', label: '외부 변경 발견' });
    expect(calendarVerificationCopy('unavailable')).toMatchObject({ tone: 'warning', label: '조회 실패' });
    expect(calendarVerificationCopy('stale')).toMatchObject({ tone: 'warning', label: '기준 변경' });
  });

  it('summarizes read-only watch state and failure count without implying writes', () => {
    const action: RecoveryActionView = {
      id: 'action-calendar',
      kind: 'calendar',
      status: 'verified',
      message: 'ok',
      createdAt: '2026-09-19T00:00:00.000Z',
      verification: {
        actionId: 'action-calendar',
        status: 'unavailable',
        message: 'provider timeout',
        checkedAt: '2026-09-19T01:00:00.000Z',
        events: [],
        watch: {
          enabled: true,
          expiresAt: '2026-09-20T00:00:00.000Z',
          nextCheckAt: '2026-09-19T01:15:00.000Z',
          consecutiveFailures: 2,
          stoppedReason: null,
        },
      },
    };

    expect(watchSummary(latestVerification(action))).toContain('읽기 전용 반복 확인 중');
    expect(watchSummary(latestVerification(action))).not.toContain('반영');
  });

  it('shows changed event fields as review targets', () => {
    expect(eventDifferenceText({
      itemId: 'event-a',
      title: '발표 준비',
      status: 'changed',
      differences: ['title', 'time', 'version'],
    })).toBe('제목, 시간, 버전');
    expect(eventDifferenceText({
      itemId: 'event-b',
      title: '자료 제출',
      status: 'matched',
      differences: [],
    })).toBe('승인한 값과 같습니다.');
    expect(eventDifferenceText({
      itemId: 'event-c',
      title: '고객 발표',
      status: 'missing',
      differences: [],
    })).toBe('Calendar에서 승인한 이벤트를 찾지 못했습니다.');
    expect(eventDifferenceText({
      itemId: 'event-d',
      title: '이동',
      status: 'unavailable',
      differences: [],
    })).toBe('이 이벤트는 다시 읽지 못했습니다.');
    expect(eventDifferenceText({
      itemId: 'event-e',
      title: '외부 수정',
      status: 'changed',
      differences: [],
    })).toBe('외부 변경이 감지됐지만 바뀐 항목을 특정하지 못했습니다.');
  });
});
