import type { BlockItem, Fact, Source, WorkspaceView } from '../../core/contracts';
import { readEvidenceDateTime } from '../../core/evidence-date-time';

export type Provenance = { label: string; detail: string };

export type SetupPrefill = {
  targetItemId: string | null;
  targetAfterStart: { value: string; provenance: Provenance } | null;
  prepItemId: string | null;
  prepDurationMinutes: { value: string; provenance: Provenance } | null;
  prepDueDate: Provenance | null;
};

type ItemEntry = { item: BlockItem };
type StrictDateTimeFact = { value: string; provenance: Provenance };

export type NoticeDateSuggestion = { id: string; label: string; value: string; quote: string; method: 'stored_semantic' | 'verified_literal' };

export function buildNoticeDateSuggestions(workspace: WorkspaceView, sourceId: string): NoticeDateSuggestion[] {
  return workspace.snapshot.facts.flatMap((fact) => {
    if (fact.evidence.sourceId !== sourceId) return [];
    const date = readEvidenceDateTime(fact, workspace.sources);
    return date ? [{ id: fact.id, label: fact.label, value: date.value, quote: fact.evidence.quote, method: date.method }] : [];
  });
}

export function buildNoticeSetupPrefill(workspace: WorkspaceView, sourceId: string, selectedTargetId: string, selectedPreparationId: string): SetupPrefill {
  const scheduleItems = itemsOf(workspace, 'schedule');
  const checklistItems = itemsOf(workspace, 'checklist');
  const eligibleTargets = scheduleItems.filter(({ item }) => !isProtected(item) && uniqueBoundDateTime(workspace, item, sourceId) !== null);
  const targetItemId = selectedTargetId || (eligibleTargets.length === 1 ? eligibleTargets[0]!.item.id : null);
  const target = targetItemId ? scheduleItems.find(({ item }) => item.id === targetItemId && !isProtected(item))?.item ?? null : null;
  const targetAfterStart = target ? uniqueBoundDateTime(workspace, target, sourceId) : null;

  const eligiblePreparations = checklistItems.filter(({ item }) => !isProtected(item) && Boolean(item.preparation?.durationMinutes));
  const prepItemId = selectedPreparationId || (eligiblePreparations.length === 1 ? eligiblePreparations[0]!.item.id : null);
  const prep = prepItemId ? checklistItems.find(({ item }) => item.id === prepItemId && !isProtected(item))?.item ?? null : null;
  const prepDurationMinutes = prep?.preparation?.durationMinutes
    ? { value: String(prep.preparation.durationMinutes), provenance: { label: '준비 설정에서 가져옴', detail: `${prep.label}에 저장된 준비 시간` } }
    : null;
  const prepDueDate = prep?.preparation?.dueDate
    ? { label: '준비 설정에 저장된 마감일', detail: `${prep.label}: ${prep.preparation.dueDate}` }
    : null;

  return { targetItemId, targetAfterStart, prepItemId, prepDurationMinutes, prepDueDate };
}

function itemsOf(workspace: WorkspaceView, type: string): ItemEntry[] {
  return workspace.snapshot.blocks
    .filter((block) => block.type === type)
    .flatMap((block) => block.items.map((item) => ({ item })));
}

function isProtected(item: BlockItem): boolean {
  return item.locked || item.completed || item.edited || item.stale;
}

function uniqueBoundDateTime(workspace: WorkspaceView, item: BlockItem, sourceId: string): StrictDateTimeFact | null {
  const values = itemValueDateTimes(workspace, item, sourceId);
  const distinct = new Map(values.map((value) => [value.value, value]));
  return distinct.size === 1 ? [...distinct.values()][0]! : null;
}

function itemValueDateTimes(workspace: WorkspaceView, item: BlockItem, sourceId: string): StrictDateTimeFact[] {
  if (!item.valueFactKey) return [];
  return workspace.snapshot.facts
    .filter((fact) => fact.key === item.valueFactKey)
    .flatMap((fact) => strictDateTimeFact(workspace.sources, fact, sourceId));
}

function strictDateTimeFact(sources: Source[], fact: Fact, sourceId: string): StrictDateTimeFact[] {
  if (fact.evidence.sourceId !== sourceId) return [];
  const date = readEvidenceDateTime(fact, sources);
  if (!date) return [];
  return [{
    value: date.value,
    provenance: { label: date.method === 'verified_literal' ? '원문에서 날짜 형식 확인' : '원문 근거에서 가져옴', detail: `${fact.label}: "${fact.evidence.quote}"` },
  }];
}
