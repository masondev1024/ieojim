import type { RecoveryActionView, RecoveryView } from '../../core/recovery-api-contracts';

export function actionMatchesPlan(action: RecoveryActionView, view: RecoveryView): boolean {
  return view.applied &&
    (action.baseRevision === undefined || action.baseRevision === view.revision) &&
    (action.sourceRevision === undefined || action.sourceRevision === view.sourceRevision) &&
    (action.conditionRevision === undefined || action.conditionRevision === view.conditionRevision);
}

export function latestCalendarAction(view: RecoveryView | undefined): RecoveryActionView | undefined {
  return view?.actions.filter((action) => action.kind === 'calendar')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
}

export function calendarNeedsReview(action: RecoveryActionView | null | undefined): boolean {
  return ['drifted', 'unavailable', 'stale'].includes(action?.verification?.status ?? '');
}

export function assuranceMessage(view: RecoveryView | undefined, feasible: boolean, dirty: boolean): string {
  if (dirty) return '조건이 바뀌었어요. 다시 계산한 뒤 적용해 주세요.';
  if (!feasible) return '지금 조건을 모두 지킬 수 없어 반영을 멈췄어요. 확인이 필요한 조건을 먼저 살펴보세요.';
  if (!view) return '지금은 화면에서만 계산한 미리보기예요. 저장 전에는 내 계획과 캘린더가 바뀌지 않아요.';
  if (!view.applied) return '조정안을 저장했어요. 바뀔 내용을 확인하고 적용해 주세요.';
  const action = latestCalendarAction(view);
  if (!action || !actionMatchesPlan(action, view)) return '이어짐에 적용했어요. 캘린더에도 반영하려면 아래에서 따로 선택해 주세요.';
  if (action.status === 'queued' || action.status === 'executing') return '캘린더에 반영 중이에요. 실제 저장한 값을 확인하면 처리 결과가 표시돼요.';
  if (calendarNeedsReview(action)) return action.verification!.message;
  if (action.status === 'verified') {
    if (action.verification?.status === 'matched') return '마지막 재확인에서 승인한 일정과 일치했어요. 이후 변경 여부는 다음 확인 때 알 수 있어요.';
    return '캘린더 반영 직후 저장한 값을 확인했어요. 이후 바뀐 내용이 있는지도 다시 확인할 수 있어요.';
  }
  return '캘린더 반영을 마치지 못했어요. 처리 기록을 확인해 주세요.';
}
