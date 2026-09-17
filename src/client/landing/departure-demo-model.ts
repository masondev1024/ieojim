import { emptySnapshot, type BlockItem, type Change, type Evidence, type Snapshot, type Source } from '../../core/contracts';
import { buildChangeSet, resolveChangeSet } from '../../core/engine';
import { DEPARTURE_SCENARIO } from '../../core/departure-sample';
import type { DepartureChange, DepartureChoice, DepartureDemoModel, DepartureEvidence, DepartureResultRow } from './departure-demo-types';

// This module is loaded only after an explicit preview action. It never persists
// data or calls the model; the server sample uses the same fixture and engine.
export async function createDepartureDemo(): Promise<DepartureDemoModel> {
  const now = '2026-09-14T00:00:00.000Z';
  const initialSource = await makeSource('departure_preview_initial', DEPARTURE_SCENARIO.initialText, '처음 정리한 여행 안내', null, now);
  const original = buildChangeSet({
    snapshot: emptySnapshot(), sources: [initialSource],
    draft: DEPARTURE_SCENARIO.initialDraft(initialSource.id),
    baseRevision: 0, baseSourceRevision: 1, id: 'departure_preview_initial_changes', now,
  });
  const initial = DEPARTURE_SCENARIO.prepareInitialSnapshot(resolveChangeSet(original, emptySnapshot(), []));
  const correction = await makeSource('departure_preview_correction', DEPARTURE_SCENARIO.updateText, '출발 전날 정정 안내', initialSource.id, now);
  const sources = new Map([initialSource, correction].map((source) => [source.id, source]));
  const proposal = buildChangeSet({
    snapshot: initial, sources: [...sources.values()],
    draft: DEPARTURE_SCENARIO.updateDraft(correction.id),
    baseRevision: 1, baseSourceRevision: 2, id: 'departure_preview_correction_changes', now,
  });
  const initialItems = initial.blocks.flatMap((block) => block.items);
  const participants = initial.facts.find((fact) => fact.key === 'participants');
  if (!participants) throw new Error('Departure fixture is missing participants.');
  const changeTargets = [participants.id, itemByKey(initial, 'arrival_day1').id, itemByKey(initial, 'fixed_cost_share').id];
  const changes = changeTargets.map((id) => projectChange(requiredChange(proposal.changes, id), sources, initialItems));
  const decisions = proposal.conflicts.map((conflict) => {
    if (!conflict.itemId || (conflict.kind !== 'locked' && conflict.kind !== 'deletion')) throw new Error('Unexpected departure conflict.');
    const change = projectChange(requiredChange(proposal.changes, conflict.itemId), sources, initialItems);
    return {
      ...change, id: conflict.id, kind: conflict.kind,
      after: conflict.kind === 'deletion' ? '완료한 항목 삭제' : change.after,
      keepLabel: conflict.kind === 'deletion' ? '완료 기록 유지' : '19시 약속 유지',
      sourceLabel: conflict.kind === 'deletion' ? '삭제 승인' : '20시로 변경',
    };
  });
  const note = itemByKey(proposal.next, 'share_message');
  return {
    source: { title: correction.title, text: correction.text },
    changes,
    decisions,
    preservedNote: { label: note.label, value: note.value, needsReview: note.stale },
    resolve(choices: Record<string, DepartureChoice>): DepartureResultRow[] {
      const entries = Object.entries(choices);
      if (entries.some(([id, choice]) => !proposal.conflicts.some((conflict) => conflict.id === id) || !['keep_user', 'use_source'].includes(choice))) {
        throw new Error('Invalid departure decision.');
      }
      const snapshot = resolveChangeSet(proposal, initial, entries.map(([conflictId, choice]) => ({ conflictId, choice })));
      return ['arrival_day1', 'fixed_cost_share', 'dinner_day2', 'paper_confirmation_print', 'share_message'].map((key) => projectResult(initial, snapshot, key));
    },
  };
}

async function makeSource(id: string, text: string, title: string, targetSourceId: string | null, createdAt: string): Promise<Source> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { id, text, title, hash, targetSourceId, createdAt, relation: targetSourceId ? 'correction' : 'initial' };
}

function itemByKey(snapshot: Snapshot, key: string): BlockItem {
  const item = snapshot.blocks.flatMap((block) => block.items).find((candidate) => candidate.key === key);
  if (!item) throw new Error(`Departure fixture is missing ${key}.`);
  return item;
}

function requiredChange(changes: Change[], id: string): Change {
  const change = changes.find((candidate) => candidate.targetId === id);
  if (!change) throw new Error('Departure change is missing.');
  return change;
}

function projectChange(change: Change, sources: Map<string, Source>, items: BlockItem[]): DepartureChange {
  const item = items.find((candidate) => candidate.id === change.targetId);
  return {
    id: change.targetId, label: change.label,
    before: displayValue(change.before, item?.key), after: displayValue(change.after, item?.key),
    evidence: change.evidence.map((evidence) => projectEvidence(evidence, sources)),
  };
}

function projectEvidence(evidence: Evidence, sources: Map<string, Source>): DepartureEvidence {
  const source = sources.get(evidence.sourceId);
  if (!source || source.text.slice(evidence.start, evidence.end) !== evidence.quote) throw new Error('Departure evidence does not match the source.');
  return { title: source.title, quote: evidence.quote };
}

function projectResult(initial: Snapshot, result: Snapshot, key: string): DepartureResultRow {
  const before = itemByKey(initial, key);
  const after = result.blocks.flatMap((block) => block.items).find((item) => item.id === before.id);
  return {
    id: before.id, label: before.label,
    before: displayValue(before.value, key), after: after ? displayValue(after.value, key) : '삭제됨',
    state: after ? [
      after.locked ? '고정 유지' : null,
      after.completed ? '완료 유지' : null,
      after.edited ? '직접 쓴 내용 유지' : null,
      after.stale ? '재검토 필요' : null,
    ].filter((value): value is string => value !== null) : ['삭제 승인됨'],
  };
}

function displayValue(value: string, key: string | undefined): string {
  // Currency is fixed by this synthetic fixture, never inferred from user input.
  return key === 'fixed_cost_share' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
    ? `${new Intl.NumberFormat('ko-KR').format(Number(value))}원`
    : value;
}
