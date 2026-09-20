import type { RecoveryPlan } from './recovery-types';
import { actionMatchesPlan, assuranceMessage, calendarNeedsReview, latestCalendarAction } from './recovery-assurance';
import './recovery-assurance.css';

export default function RecoveryAssurance({ plan, dirty }: { plan: RecoveryPlan; dirty: boolean }) {
  const view = plan.server;
  const action = latestCalendarAction(view);
  const current = Boolean(view && action && actionMatchesPlan(action, view) && !dirty);
  const applied = Boolean(view?.applied && !dirty);
  const attention = current && calendarNeedsReview(action);
  const steps = [
    { title: '변경 영향 계산', state: plan.feasible && !dirty ? 'done' : 'attention', detail: `${plan.protectedEventIds.length}개 보호 일정 유지` },
    { title: '이어짐에 적용', state: applied ? 'done' : 'waiting', detail: applied ? '승인한 계획 저장' : view ? '내 확인 대기' : '미리보기' },
    { title: '캘린더에 반영', state: attention ? 'attention' : current && action?.status === 'verified' ? 'done' : current && ['queued', 'executing'].includes(action?.status ?? '') ? 'pending' : 'waiting', detail: attention ? '반영 후 재확인 필요' : current && action?.status === 'verified' ? '반영 당시 재조회 확인' : '별도 연결·승인 필요' },
    { title: '이후 상태 확인', state: attention ? 'attention' : current && action?.verification?.status === 'matched' ? 'done' : 'waiting', detail: attention ? '다시 확인할 내용 있음' : current && action?.verification?.status === 'matched' ? '마지막 조회 기준 일치' : '필요할 때 켜기' },
  ];
  return (
    <section className="recovery-assurance" aria-label="변경 반영 진행 상황">
      <h2>바뀐 계획, 어디까지 반영됐나요?</h2>
      <p>{assuranceMessage(view, plan.feasible, dirty)}</p>
      <ol>{steps.map((step, index) => (
        <li key={step.title} data-state={step.state}>
          <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <div><strong>{step.title}</strong><small>{step.detail}</small></div>
        </li>
      ))}</ol>
    </section>
  );
}
