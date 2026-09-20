import { useState } from 'react';
import { CalendarCheck, Clock3, Eye, RefreshCw, ShieldAlert } from 'lucide-react';
import type { RecoveryActionView } from '../../core/recovery-api-contracts';
import {
  calendarVerificationCopy,
  eventDifferenceText,
  eventStatusLabel,
  formatKoreanDateTime,
  latestVerification,
  originalExecutionCopy,
  watchSummary,
} from './calendar-verification-view';
import './calendar-verification.css';

type CalendarVerificationPanelProps = {
  action: RecoveryActionView;
  disabled: boolean;
  canCheck: boolean;
  onCheck: () => void;
  onWatch: (enabled: boolean) => void;
};

export default function CalendarVerificationPanel({ action, disabled, canCheck, onCheck, onWatch }: CalendarVerificationPanelProps) {
  const [watchConsent, setWatchConsent] = useState(false);
  const execution = originalExecutionCopy(action);
  const verification = latestVerification(action);
  const verificationState = calendarVerificationCopy(verification.status);
  const checkedAt = verification.checkedAt ? formatKoreanDateTime(verification.checkedAt) : '아직 확인 전';
  const watchEnabled = verification.watch.enabled;
  const checkDisabled = disabled || !canCheck || verification.status === 'checking';
  const canEnableWatch = !disabled && canCheck && watchConsent && !watchEnabled;
  const canDisableWatch = !disabled && watchEnabled;

  function enableWatch() {
    if (!canEnableWatch) return;
    onWatch(true);
    setWatchConsent(false);
  }

  function disableWatch() {
    if (!canDisableWatch) return;
    onWatch(false);
  }

  return (
    <section className="calendar-verification" aria-labelledby={`calendar-verification-title-${action.id}`}>
      <div className="calendar-verification__header">
        <div>
          <p className="calendar-verification__kicker">캘린더 재확인</p>
          <h3 id={`calendar-verification-title-${action.id}`}>승인한 일정이 아직 그대로인지 확인</h3>
        </div>
        <span className="calendar-verification__badge" data-tone={verificationState.tone}>{verificationState.label}</span>
      </div>

      <div className="calendar-verification__states" aria-label="실행 당시 확인과 현재 확인 결과">
        <article data-tone={execution.tone}>
          <CalendarCheck size={18} aria-hidden="true" />
          <div>
            <span>{execution.label}</span>
            <strong>{execution.title}</strong>
            <p>{execution.detail}</p>
          </div>
        </article>
        <article data-tone={verificationState.tone}>
          <Eye size={18} aria-hidden="true" />
          <div>
            <span>마지막 재확인</span>
            <strong>{verificationState.title}</strong>
            <p>{verification.message || verificationState.detail}</p>
            <small>확인 시각: {checkedAt}</small>
          </div>
        </article>
      </div>

      <div className="calendar-verification__controls">
        <button type="button" onClick={onCheck} disabled={checkDisabled}>
          <RefreshCw size={16} aria-hidden="true" />
          Calendar 상태 다시 확인
        </button>
        {!watchEnabled ? (
          <div className="calendar-verification__watch-consent">
            <label className="calendar-verification__watch">
              <input
                type="checkbox"
                checked={watchConsent}
                disabled={disabled || !canCheck}
                onChange={(event) => setWatchConsent(event.currentTarget.checked)}
              />
              <span>최대 24시간 동안 승인한 Calendar 이벤트만 주기적으로 읽어 확인하는 데 동의합니다.</span>
            </label>
            <button type="button" className="calendar-verification__secondary" disabled={!canEnableWatch} onClick={enableWatch}>반복 확인 켜기</button>
          </div>
        ) : (
          <button type="button" className="calendar-verification__secondary" disabled={!canDisableWatch} onClick={disableWatch}>반복 확인 끄기</button>
        )}
        {!canCheck ? <p className="calendar-verification__hint">현재 기준이 바뀌었거나 Calendar 연결을 확인해야 해서 재확인은 잠시 막혀 있습니다. {watchEnabled ? '켜 둔 반복 확인은 끌 수 있습니다.' : '기준과 연결을 확인한 뒤 반복 확인을 켤 수 있습니다.'}</p> : null}
        <p className="calendar-verification__hint">반복 확인은 15분 간격으로 예약합니다. 조회가 몰리거나 연결이 불안정하면 늦어질 수 있습니다.</p>
      </div>

      <div className="calendar-verification__watch-status">
        <Clock3 size={16} aria-hidden="true" />
        <span>{watchSummary(verification)}</span>
        {verification.watch.consecutiveFailures > 0 ? <small>연속 실패 {verification.watch.consecutiveFailures}회</small> : null}
      </div>

      {verification.events.length > 0 ? (
        <details className="calendar-verification__event-details">
          <summary>이벤트별 확인 결과 {verification.events.length}개 보기</summary>
          <ul className="calendar-verification__events" aria-label="Calendar 이벤트 확인 결과">
            {verification.events.map((event) => (
              <li key={event.itemId} data-status={event.status}>
                <div>
                  <strong>{event.title}</strong>
                  <span>{eventStatusLabel(event.status)}</span>
                </div>
                <p>{eventDifferenceText(event)}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="calendar-verification__empty">아직 표시할 이벤트별 재확인 결과가 없습니다.</p>
      )}

      {verification.status === 'drifted' || verification.status === 'unavailable' || verification.status === 'stale' ? (
        <p className="calendar-verification__guard" role="status">
          <ShieldAlert size={16} aria-hidden="true" />
          이 패널은 Calendar를 다시 읽기만 합니다. 외부에서 달라진 값은 자동으로 덮어쓰지 않습니다.
        </p>
      ) : null}
    </section>
  );
}

export type { CalendarVerificationPanelProps };
