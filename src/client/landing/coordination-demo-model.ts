import { emptySnapshot, type BlockItem, type Change, type Evidence, type Snapshot, type Source } from '../../core/contracts';
import { COORDINATION_SCENARIO } from '../../core/coordination-sample';
import { buildChangeSet, resolveChangeSet } from '../../core/engine';

export type CoordinationChoice = 'keep_user' | 'use_source';

export type CoordinationEvidence = {
  title: string;
  quote: string;
};

export type CoordinationChange = {
  id: string;
  label: string;
  before: string;
  after: string;
  evidence: CoordinationEvidence[];
};

export type CoordinationDecision = CoordinationChange & {
  kind: 'locked' | 'deletion';
};

export type CoordinationPreservedPreparation = {
  label: string;
  dueDate: string | null;
  durationMinutes: number | null;
  needsReview: boolean;
};

export type CoordinationPreservedNote = {
  label: string;
  value: string;
  needsReview: boolean;
};

export type CoordinationResultRow = {
  id: string;
  label: string;
  before: string;
  after: string;
  state: string[];
};

export type CoordinationDemoModel = {
  source: { title: string; text: string };
  changes: CoordinationChange[];
  decisions: CoordinationDecision[];
  preservedPreparations: CoordinationPreservedPreparation[];
  preservedNote: CoordinationPreservedNote;
  resolve: (choices: Record<string, CoordinationChoice>) => CoordinationResultRow[];
};

// This module is loaded only after an explicit preview action. It never calls an
// API, model, database or persistence layer; it uses the same fixture and core
// engine as the saved coordination sample.
export async function createCoordinationDemo(): Promise<CoordinationDemoModel> {
  const now = '2026-09-14T00:00:00.000Z';
  const initialSource = await makeSource('coordination_preview_initial', COORDINATION_SCENARIO.initialText, '처음 정리한 고객 미팅 안내', null, now);
  const original = buildChangeSet({
    snapshot: emptySnapshot(),
    sources: [initialSource],
    draft: COORDINATION_SCENARIO.initialDraft(initialSource.id),
    baseRevision: 0,
    baseSourceRevision: 1,
    id: 'coordination_preview_initial_changes',
    now,
  });
  const initial = COORDINATION_SCENARIO.prepareInitialSnapshot(resolveChangeSet(original, emptySnapshot(), []));
  const correction = await makeSource('coordination_preview_correction', COORDINATION_SCENARIO.updateText, '고객 미팅 정정 안내', initialSource.id, now);
  const sources = new Map([initialSource, correction].map((source) => [source.id, source]));
  const proposal = buildChangeSet({
    snapshot: initial,
    sources: [...sources.values()],
    draft: COORDINATION_SCENARIO.updateDraft(correction.id),
    baseRevision: 1,
    baseSourceRevision: 2,
    id: 'coordination_preview_correction_changes',
    now,
  });
  const changeTargets = [
    itemByKey(initial, 'client_meeting').id,
    itemByKey(initial, 'prepare_materials').id,
    itemByKey(initial, 'confirm_room').id,
  ];
  const changes = changeTargets.map((id) => projectChange(requiredChange(proposal.changes, id), sources));
  const decisions = proposal.conflicts.map((conflict) => {
    if (!conflict.itemId || (conflict.kind !== 'locked' && conflict.kind !== 'deletion')) throw new Error('Unexpected coordination conflict.');
    const change = projectChange(requiredChange(proposal.changes, conflict.itemId), sources);
    return {
      ...change,
      id: conflict.id,
      kind: conflict.kind,
      after: conflict.kind === 'deletion' ? '완료한 항목 삭제' : change.after,
    };
  });
  if (decisions.length !== 2) throw new Error('Coordination fixture must expose exactly two protected conflicts.');
  const preservedPreparations = ['prepare_materials', 'confirm_room'].map((key) => {
    const item = itemByKey(proposal.next, key);
    return {
      label: item.label,
      dueDate: item.preparation?.dueDate ?? null,
      durationMinutes: item.preparation?.durationMinutes ?? null,
      needsReview: item.stale,
    };
  });
  const note = itemByKey(proposal.next, 'attendee_draft');
  return {
    source: { title: correction.title, text: correction.text },
    changes,
    decisions,
    preservedPreparations,
    preservedNote: { label: note.label, value: note.value, needsReview: note.stale },
    resolve(choices: Record<string, CoordinationChoice>): CoordinationResultRow[] {
      const entries = Object.entries(choices);
      if (entries.length !== proposal.conflicts.length || entries.some(([id, choice]) => !proposal.conflicts.some((conflict) => conflict.id === id) || !['keep_user', 'use_source'].includes(choice))) {
        throw new Error('Invalid coordination decision.');
      }
      const snapshot = resolveChangeSet(proposal, initial, entries.map(([conflictId, choice]) => ({ conflictId, choice })));
      return [
        'client_meeting',
        'executive_briefing',
        'prepare_materials',
        'confirm_room',
        'check_print',
        'attendee_draft',
      ].map((key) => projectResult(initial, snapshot, key));
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
  if (!item) throw new Error(`Coordination fixture is missing ${key}.`);
  return item;
}

function requiredChange(changes: Change[], id: string): Change {
  const change = changes.find((candidate) => candidate.targetId === id);
  if (!change) throw new Error('Coordination change is missing.');
  return change;
}

function projectChange(change: Change, sources: Map<string, Source>): CoordinationChange {
  return {
    id: change.targetId,
    label: change.label,
    before: change.before,
    after: change.after,
    evidence: change.evidence.map((evidence) => projectEvidence(evidence, sources)),
  };
}

function projectEvidence(evidence: Evidence, sources: Map<string, Source>): CoordinationEvidence {
  const source = sources.get(evidence.sourceId);
  if (!source || source.text.slice(evidence.start, evidence.end) !== evidence.quote) throw new Error('Coordination evidence does not match the source.');
  return { title: source.title, quote: evidence.quote };
}

function projectResult(initial: Snapshot, result: Snapshot, key: string): CoordinationResultRow {
  const before = itemByKey(initial, key);
  const after = result.blocks.flatMap((block) => block.items).find((item) => item.id === before.id);
  return {
    id: before.id,
    label: before.label,
    before: before.value,
    after: after ? after.value : '삭제됨',
    state: after ? [
      after.locked ? '고정 유지' : null,
      after.completed ? '완료 유지' : null,
      after.edited ? '직접 쓴 내용 유지' : null,
      after.stale ? '재검토 필요' : null,
      after.preparation?.dueDate ? `준비 마감 ${after.preparation.dueDate}` : null,
      after.preparation?.durationMinutes ? `예상 ${after.preparation.durationMinutes}분` : null,
    ].filter((value): value is string => value !== null) : ['삭제 승인됨'],
  };
}

