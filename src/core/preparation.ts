import type { BlockItem, Snapshot } from './contracts';

export type PreparationStatus = 'completed' | 'needs_review' | 'overdue' | 'today' | 'upcoming' | 'unscheduled';

export type PreparationItem = {
  itemId: string;
  blockId: string;
  blockTitle: string;
  label: string;
  value: string;
  dueDate: string | null;
  durationMinutes: number | null;
  status: PreparationStatus;
  provenance: 'user';
};

export function getPreparationItems(snapshot: Snapshot, referenceDate: string): PreparationItem[] {
  const today = parseDateOnly(referenceDate);
  const items: PreparationItem[] = [];
  for (const block of snapshot.blocks) {
    if (block.type !== 'checklist') continue;
    for (const item of block.items) {
      const preparationVersion = item.preparation ? (item.preparation as { version?: unknown }).version : undefined;
      const hasInvalidPreparation = Boolean(item.preparation) &&
        (preparationVersion !== 1 || !validNullableDate(item.preparation?.dueDate) || !validNullableDuration(item.preparation?.durationMinutes));
      const rawDueDate = item.preparation?.dueDate ?? null;
      const rawDuration = item.preparation?.durationMinutes ?? null;
      const dueDate = validDateOnly(rawDueDate) ? rawDueDate : null;
      const durationMinutes = validDuration(rawDuration) ? rawDuration : null;
      items.push({
        itemId: item.id,
        blockId: block.id,
        blockTitle: block.title,
        label: item.label,
        value: item.value,
        dueDate,
        durationMinutes,
        status: preparationStatus(item, dueDate, today, hasInvalidPreparation),
        provenance: 'user',
      });
    }
  }
  return items.sort(comparePreparationItems);
}

function preparationStatus(item: BlockItem, dueDate: string | null, today: Date | null, hasInvalidPreparation: boolean): PreparationStatus {
  if (item.stale || hasInvalidPreparation) return 'needs_review';
  if (item.completed) return 'completed';
  if (!dueDate || !today) return 'unscheduled';
  const due = parseDateOnly(dueDate);
  if (!due) return 'unscheduled';
  const deltaDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (deltaDays < 0) return 'overdue';
  if (deltaDays === 0) return 'today';
  return 'upcoming';
}

function comparePreparationItems(left: PreparationItem, right: PreparationItem): number {
  const statusRank: Record<PreparationStatus, number> = {
    needs_review: 0,
    overdue: 1,
    today: 2,
    upcoming: 3,
    unscheduled: 4,
    completed: 5,
  };
  const leftDate = left.dueDate ?? '9999-12-31';
  const rightDate = right.dueDate ?? '9999-12-31';
  return statusRank[left.status] - statusRank[right.status] ||
    leftDate.localeCompare(rightDate) ||
    left.blockTitle.localeCompare(right.blockTitle) ||
    left.label.localeCompare(right.label);
}

function validDateOnly(value: string | null): value is string {
  return typeof value === 'string' && parseDateOnly(value) !== null;
}

function validDuration(value: number | null): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1440;
}

function validNullableDate(value: string | null | undefined): boolean {
  return value === null || value === undefined || validDateOnly(value);
}

function validNullableDuration(value: number | null | undefined): boolean {
  return value === null || value === undefined || validDuration(value);
}

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}
