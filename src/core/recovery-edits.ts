import { DomainError, type ItemPreparation } from './contracts';
import { repairSchedule } from './schedule-repair';
import type { RecoveryInput } from './scheduling-contracts';

export type RecoveryEdit = { itemId: string; value: string; preparation?: ItemPreparation };
export const recoverySlotText = (slot: { start: string; end: string }): string => `${slot.start.replace('T', ' ')} ~ ${slot.end.replace('T', ' ')}`;

export function buildRecoveryEdits(input: RecoveryInput): RecoveryEdit[] {
  const result = repairSchedule(input);
  if (result.status !== 'ready') throw new DomainError('INVALID_RECOVERY', result.message, 422);
  const edits: RecoveryEdit[] = result.actions.filter((action) => action.kind === 'reschedule').map((action) => {
    if (!action.itemId) throw new DomainError('INVALID_RECOVERY', '저장할 일정 항목이 연결되지 않았습니다.', 422);
    return { itemId: action.itemId, value: recoverySlotText(action.after) };
  });
  edits.push({
    itemId: 'item:recovery_checklist:event_presentation_prep',
    value: `${input.change.preparationDurationMinutes}분 연속 준비 · ${input.change.preparationDeadline} 전 완료`,
    preparation: { version: 1, dueDate: input.change.preparationDeadline.slice(0, 10), durationMinutes: input.change.preparationDurationMinutes },
  });
  return edits;
}
