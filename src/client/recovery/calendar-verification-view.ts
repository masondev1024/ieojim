import type { RecoveryActionView } from '../../core/recovery-api-contracts';
import type { CalendarVerificationEvent, CalendarVerificationStatus, CalendarVerificationView } from '../../core/recovery-verification-contracts';

export type CalendarVerificationTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export type CalendarVerificationCopy = {
  label: string;
  tone: CalendarVerificationTone;
  title: string;
  detail: string;
};

const statusCopy: Record<CalendarVerificationStatus, CalendarVerificationCopy> = {
  not_checked: {
    label: '다시 확인 전',
    tone: 'neutral',
    title: '현재 Calendar 상태는 아직 다시 읽지 않았습니다.',
    detail: '실행 당시 확인 기록과 지금의 Calendar 상태를 따로 보여줍니다.',
  },
  checking: {
    label: '확인 중',
    tone: 'progress',
    title: '승인한 이벤트를 다시 읽고 있습니다.',
    detail: '확인 중에는 외부 일정을 수정하지 않습니다.',
  },
  matched: {
    label: '마지막 확인 일치',
    tone: 'success',
    title: '마지막 확인 때 Calendar가 승인한 내용과 일치했습니다.',
    detail: '이어짐이 만든 이벤트만 다시 읽어 확인했습니다.',
  },
  drifted: {
    label: '외부 변경 발견',
    tone: 'danger',
    title: '승인 뒤 Calendar에서 달라진 내용이 있습니다.',
    detail: '자동으로 덮어쓰지 않습니다. 바뀐 이벤트를 확인한 뒤 다시 결정해야 합니다.',
  },
  unavailable: {
    label: '조회 실패',
    tone: 'warning',
    title: 'Calendar 상태를 확인하지 못했습니다.',
    detail: '네트워크나 권한 문제일 수 있습니다. 실패는 일치로 처리하지 않습니다.',
  },
  stale: {
    label: '기준 변경',
    tone: 'warning',
    title: '승인 기준이 바뀌어 이 확인을 사용할 수 없습니다.',
    detail: '최신 계획이나 연결 상태를 기준으로 다시 확인해야 합니다.',
  },
};

export function calendarVerificationCopy(status: CalendarVerificationStatus): CalendarVerificationCopy {
  return statusCopy[status];
}

export function originalExecutionCopy(action: RecoveryActionView): CalendarVerificationCopy {
  if (action.status === 'verified') {
    const total = typeof action.totalEvents === 'number' ? action.totalEvents : null;
    const verified = typeof action.verifiedEvents === 'number' ? action.verifiedEvents : null;
    return {
      label: '실행 당시 확인',
      tone: 'success',
      title: total && verified !== null ? `처리 직후 ${verified}/${total}개 이벤트를 확인했습니다.` : '처리 직후 Calendar 반영을 확인했습니다.',
      detail: action.message || '승인한 작업이 외부 Calendar에 반영됐던 기록입니다.',
    };
  }
  if (action.status === 'accepted') {
    return {
      label: '접수됨',
      tone: 'warning',
      title: '외부 시스템이 요청을 접수했습니다.',
      detail: '접수는 저장 확인과 다릅니다. 다시 읽어 확인해야 합니다.',
    };
  }
  if (action.status === 'failed' || action.status === 'conflict' || action.status === 'uncertain') {
    return {
      label: '재검토 필요',
      tone: 'danger',
      title: '실행 당시에도 확인이 끝나지 않았습니다.',
      detail: action.message || '외부 처리 기록을 확인해 주세요.',
    };
  }
  return {
    label: '처리 전',
    tone: 'neutral',
    title: '아직 처리 완료 기록이 없습니다.',
    detail: action.message || 'Calendar 반영이 끝난 뒤 다시 확인할 수 있습니다.',
  };
}

export function latestVerification(action: RecoveryActionView): CalendarVerificationView {
  return action.verification ?? {
    actionId: action.id,
    status: 'not_checked',
    message: '아직 현재 Calendar 상태를 다시 확인하지 않았습니다.',
    checkedAt: null,
    events: [],
    watch: {
      enabled: false,
      expiresAt: null,
      nextCheckAt: null,
      consecutiveFailures: 0,
      stoppedReason: null,
    },
  };
}

export function eventStatusLabel(status: CalendarVerificationEvent['status']): string {
  const labels: Record<CalendarVerificationEvent['status'], string> = {
    matched: '일치',
    changed: '달라짐',
    missing: '삭제됨',
    unavailable: '확인 실패',
  };
  return labels[status];
}

export function eventDifferenceText(event: CalendarVerificationEvent): string {
  if (event.status === 'missing') return 'Calendar에서 승인한 이벤트를 찾지 못했습니다.';
  if (event.status === 'unavailable') return '이 이벤트는 다시 읽지 못했습니다.';
  if (event.status === 'changed' && event.differences.length === 0) return '외부 변경이 감지됐지만 바뀐 항목을 특정하지 못했습니다.';
  if (event.differences.length === 0) return '승인한 값과 같습니다.';
  const labels: Record<CalendarVerificationEvent['differences'][number], string> = {
    title: '제목',
    time: '시간',
    description: '메모',
    identity: '이벤트 식별자',
    version: '버전',
  };
  return event.differences.map((difference) => labels[difference]).join(', ');
}

export function watchSummary(verification: CalendarVerificationView): string {
  if (verification.watch.enabled) {
    const expiresAt = verification.watch.expiresAt ? formatKoreanDateTime(verification.watch.expiresAt) : '만료 시간 미정';
    const nextCheckAt = verification.watch.nextCheckAt ? formatKoreanDateTime(verification.watch.nextCheckAt) : '다음 확인 대기 중';
    return `읽기 전용 반복 확인 중 · 다음 예약 ${nextCheckAt} · ${expiresAt}까지`;
  }
  if (verification.watch.stoppedReason) return `반복 확인 중지 · ${watchStoppedReason(verification.watch.stoppedReason)}`;
  return '반복 확인 꺼짐';
}

export function watchStoppedReason(reason: string): string {
  const labels: Record<string, string> = {
    expired: '24시간 확인 시간이 끝났습니다.',
    disconnected: 'Calendar 연결이 해제됐습니다.',
    stale: '승인 기준이 바뀌었습니다.',
    drifted: '외부 변경이 발견됐습니다.',
    failures: '연속 조회 실패가 3회 발생했습니다.',
    disabled: '사용자가 반복 확인을 껐습니다.',
    user_disabled: '사용자가 반복 확인을 껐습니다.',
    drift_detected: '외부 변경이 발견됐습니다.',
    attention_needed: '외부 변경이 발견됐습니다.',
    transient_failure_limit: '연속 조회 실패가 3회 발생했습니다.',
    local_stale: '승인한 계획이나 조건이 바뀌었습니다.',
    origin_stale: '기준 안내나 원래 계획이 바뀌었습니다.',
    workspace_unavailable: '작업 공간이 삭제되었거나 보관 기간이 끝났습니다.',
    connection_changed: 'Calendar 연결이 바뀌었습니다.',
    connection_unavailable: 'Calendar 연결이 바뀌었거나 다시 인증이 필요합니다.',
    not_connected: 'Calendar 연결이 해제됐습니다.',
    reauth_required: 'Calendar를 다시 연결해야 합니다.',
    forbidden: 'Calendar 조회 권한을 확인해야 합니다.',
    scope_missing: 'Calendar 조회 권한이 없습니다.',
    calendar_missing: '연결한 Calendar를 찾지 못했습니다.',
    watch_expired: '설정한 기간 안에 더 확인할 시간이 없습니다.',
  };
  return labels[reason] ?? '확인을 계속할 수 없어 중지했습니다. 위 안내를 확인해 주세요.';
}

export function formatKoreanDateTime(value: string | null): string {
  if (!value) return '확인 전';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
