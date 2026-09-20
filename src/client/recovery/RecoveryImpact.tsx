import type { ReactNode } from 'react';
import { ArrowDown, ShieldCheck } from 'lucide-react';
import type { RecoveryEvent, RecoveryPlan } from './recovery-types';
import './recovery-impact.css';

export default function RecoveryImpact({ plan, dirty, evidence }: { plan: RecoveryPlan; dirty: boolean; evidence: ReactNode }) {
  const ready = plan.feasible && !dirty;
  const changed = plan.after.filter((event) => plan.movedEventIds.includes(event.id));
  return (
    <article className="recovery-impact" aria-label="일정 변경 요약" data-state={dirty ? 'dirty' : ready ? 'ready' : 'blocked'}>
      <header>
        <span>{ready ? `계산된 변경 ${changed.length}건` : '조건 확인 필요'}</span>
        <h2>{dirty ? '바꾼 조건으로 다시 계산해 주세요.' : ready ? '바뀌는 일정, 한눈에 보기' : '지금 조건으로는 옮길 수 없어요.'}</h2>
      </header>
      {ready ? <ul aria-label="계산된 일정 변경">
        {changed.map((event) => {
          const before = plan.before.find((item) => item.id === event.id);
          return <li key={event.id}>
            <strong>{event.title}</strong>
            <div>
              {before ? <span className="recovery-impact__before"><span className="recovery-impact__label">변경 전 </span>{intervalLabel(before)}</span> : null}
              <span className="recovery-impact__after"><ArrowDown size={13} aria-hidden="true" /><span className="recovery-impact__label">조정안 </span>{intervalLabel(event)}</span>
            </div>
          </li>;
        })}
      </ul> : <p className="recovery-impact__blocked">{dirty ? '아래 일정표는 마지막 계산 결과예요. 다시 계산하기 전에는 적용할 수 없어요.' : '기존 일정은 그대로 두었어요. 아래에서 막힌 조건을 확인하고 다시 계산해 보세요.'}</p>}
      <p className="recovery-impact__protected"><ShieldCheck size={17} aria-hidden="true" /> 보호 일정 {plan.summary.protectedCount}개 유지</p>
      <details className="recovery-evidence-details">
        <summary>새 안내와 근거 보기</summary>
        <blockquote>{plan.changedNotice}</blockquote>
        {evidence}
      </details>
    </article>
  );
}

function intervalLabel(event: RecoveryEvent): string {
  const startDay = dateLabel(event.start);
  const endDay = event.start.slice(0, 10) === event.end.slice(0, 10) ? '' : `${dateLabel(event.end)} `;
  return `${startDay} ${event.start.slice(11, 16)}–${endDay}${event.end.slice(11, 16)}`;
}

function dateLabel(value: string): string {
  return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
}
