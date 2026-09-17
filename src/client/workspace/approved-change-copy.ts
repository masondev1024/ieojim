import type { Block, BlockItem, Fact, Snapshot } from '../../core/contracts';
import type { WorkspaceExport } from '../../core/export-contracts';

export type ApprovedRevisionCopyResult =
  | { ok: true; text: string; revision: number; changeCount: number }
  | { ok: false; reason: 'not_current_workspace' | 'not_approved_revision' | 'missing_base_revision' | 'no_diff'; message: string };

type ItemEntry = { block: Block; item: BlockItem };
type FactDiff = { label: string; before: string; after: string };
type ItemDiff = { blockTitle: string; label: string; before: string; after: string; stateChanges: string[] };

export function buildApprovedRevisionCopyText(
  exported: WorkspaceExport,
  currentWorkspaceId: string,
  currentRevision: number,
): ApprovedRevisionCopyResult {
  const { workspace } = exported.content;
  const revisions = exported.content.revisions ?? [];
  if (workspace.id !== currentWorkspaceId || workspace.revision !== currentRevision) {
    return {
      ok: false,
      reason: 'not_current_workspace',
      message: '현재 작업 공간과 내려받은 승인 기록이 일치하지 않습니다. 최신 저장 계획에서 다시 확인해 주세요.',
    };
  }

  const current = revisions.find((revision) => revision.revision === workspace.revision);
  if (!current || current.reason !== 'apply_changeset') {
    return {
      ok: false,
      reason: 'not_approved_revision',
      message: '현재 저장된 계획은 사용자가 승인해 저장한 변경 기록이 아닙니다. 직접 수정, 복원, 처음 만든 계획은 승인 변경 안내로 복사하지 않습니다.',
    };
  }

  const previous = revisions.find((revision) => revision.revision === workspace.revision - 1);
  if (!previous) {
    return {
      ok: false,
      reason: 'missing_base_revision',
      message: '승인 직전 저장된 계획을 찾지 못했습니다. 이전 저장 계획 없이는 전후 변경을 추정하지 않습니다.',
    };
  }

  const factDiffs = diffFacts(previous.snapshot, current.snapshot);
  const itemDiffs = diffItems(previous.snapshot, current.snapshot);
  const changeCount = factDiffs.length + itemDiffs.length;
  if (changeCount === 0) {
    return {
      ok: false,
      reason: 'no_diff',
      message: '승인 직전 저장된 계획과 현재 저장된 계획 사이의 실제 변경을 찾지 못했습니다.',
    };
  }

  const lines = [
    `${workspace.title} — 변경 안내`,
    `확정 시각: ${formatDateTime(current.createdAt)}`,
    `저장된 계획: ${previous.revision} → ${current.revision}`,
    '',
  ];

  if (itemDiffs.length > 0) {
    lines.push('변경된 항목');
    for (const [index, diff] of itemDiffs.entries()) {
      lines.push(
        `${index + 1}. [${diff.blockTitle}] ${diff.label}`,
        `   이전: ${formatField(diff.before)}`,
        `   이후: ${formatField(diff.after)}`,
      );
      if (diff.stateChanges.length > 0) lines.push(`   상태: ${diff.stateChanges.join(', ')}`);
    }
    lines.push('');
  }

  if (factDiffs.length > 0) {
    lines.push('변경된 근거 값');
    for (const [index, diff] of factDiffs.entries()) {
      lines.push(
        `${index + 1}. ${diff.label}`,
        `   이전: ${formatField(diff.before)}`,
        `   이후: ${formatField(diff.after)}`,
      );
    }
    lines.push('');
  }

  return { ok: true, text: lines.join('\n'), revision: workspace.revision, changeCount };
}

function diffFacts(previous: Snapshot, current: Snapshot): FactDiff[] {
  const previousFacts = new Map(previous.facts.map((fact) => [fact.key, fact]));
  const currentFacts = new Map(current.facts.map((fact) => [fact.key, fact]));
  const keys = new Set([...previousFacts.keys(), ...currentFacts.keys()]);
  const diffs: FactDiff[] = [];
  for (const key of [...keys].sort()) {
    const before = previousFacts.get(key);
    const after = currentFacts.get(key);
    if (sameFact(before, after)) continue;
    diffs.push({
      label: after?.label ?? before?.label ?? key,
      before: before ? formatFactValue(before) : '(없음)',
      after: after ? formatFactValue(after) : '(삭제됨)',
    });
  }
  return diffs;
}

function diffItems(previous: Snapshot, current: Snapshot): ItemDiff[] {
  const previousItems = indexItems(previous);
  const currentItems = indexItems(current);
  const ids = new Set([...previousItems.keys(), ...currentItems.keys()]);
  const diffs: ItemDiff[] = [];
  for (const id of [...ids].sort()) {
    const before = previousItems.get(id);
    const after = currentItems.get(id);
    const stateChanges = itemStateChanges(before?.item, after?.item);
    if (before && after && before.item.label === after.item.label && before.item.value === after.item.value && stateChanges.length === 0) continue;
    diffs.push({
      blockTitle: after?.block.title ?? before?.block.title ?? '항목',
      label: after?.item.label ?? before?.item.label ?? id,
      before: before ? before.item.value : '(없음)',
      after: after ? after.item.value : '(삭제됨)',
      stateChanges,
    });
  }
  return diffs;
}

function indexItems(snapshot: Snapshot): Map<string, ItemEntry> {
  const items = new Map<string, ItemEntry>();
  for (const block of snapshot.blocks) {
    for (const item of block.items) items.set(item.id, { block, item });
  }
  return items;
}

function sameFact(before: Fact | undefined, after: Fact | undefined): boolean {
  if (!before || !after) return before === after;
  return before.label === after.label && String(before.value) === String(after.value);
}

function formatFactValue(fact: Fact): string {
  return String(fact.value);
}

function itemStateChanges(before: BlockItem | undefined, after: BlockItem | undefined): string[] {
  if (!before || !after) return [];
  return [
    flagChange('완료', before.completed, after.completed),
    flagChange('잠금', before.locked, after.locked),
    flagChange('사용자 수정', before.edited, after.edited),
    flagChange('다시 확인 표시', before.stale, after.stale),
  ].filter((value): value is string => Boolean(value));
}

function flagChange(label: string, before: boolean, after: boolean): string | null {
  if (before === after) return null;
  return `${label} ${formatBoolean(before)}→${formatBoolean(after)}`;
}

function formatBoolean(value: boolean): string {
  return value ? '예' : '아니오';
}

function formatField(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '(빈 값)';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
