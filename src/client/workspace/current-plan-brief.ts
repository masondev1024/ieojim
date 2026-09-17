import type { Block, BlockItem, Fact } from '../../core/contracts';
import type { WorkspaceExport } from '../../core/export-contracts';

export type CurrentPlanBriefOptions = {
  workspaceId: string;
  currentRevision: number;
  includeNotes?: boolean;
};

export type CurrentPlanBriefResult =
  | { ok: true; text: string; revision: number; includedNoteCount: number; omittedNoteCount: number; itemCount: number }
  | { ok: false; reason: 'not_current_workspace' | 'empty_snapshot'; message: string };

const blockTypeLabels: Record<Block['type'], string> = {
  schedule: '일정',
  cost: '비용',
  checklist: '준비할 일',
  note: '메모',
};

const orderedBlockTypes: Block['type'][] = ['schedule', 'cost', 'checklist', 'note'];

export function buildCurrentPlanBriefText(exported: WorkspaceExport, options: CurrentPlanBriefOptions): CurrentPlanBriefResult {
  const { workspace, snapshot } = exported.content;
  if (workspace.id !== options.workspaceId || workspace.revision !== options.currentRevision) {
    return {
      ok: false,
      reason: 'not_current_workspace',
      message: '현재 작업 공간과 저장된 계획 버전이 일치하지 않습니다. 최신 화면에서 다시 불러와 주세요.',
    };
  }

  const currentRevision = exported.content.revisions?.find((revision) => revision.revision === workspace.revision);
  const includeNotes = options.includeNotes === true;
  const includedBlocks = snapshot.blocks.filter((block) => includeNotes || block.type !== 'note');
  const noteBlocks = snapshot.blocks.filter((block) => block.type === 'note');
  const factsByKey = new Map(snapshot.facts.map((fact) => [fact.key, fact]));
  const itemCount = includedBlocks.reduce((count, block) => count + block.items.length, 0);
  const omittedNoteCount = includeNotes ? 0 : noteBlocks.reduce((count, block) => count + block.items.length, 0);
  if (itemCount === 0 && omittedNoteCount === 0) {
    return {
      ok: false,
      reason: 'empty_snapshot',
      message: '복사할 저장 계획이 아직 없습니다. 먼저 계획 항목을 저장해 주세요.',
    };
  }

  const lines = [
    `${formatField(workspace.title)} 현재 저장된 계획`,
    '',
  ];

  for (const type of orderedBlockTypes) {
    if (type === 'note' && !includeNotes) continue;
    const blocks = includedBlocks.filter((block) => block.type === type);
    if (blocks.length === 0) continue;
    lines.push(blockTypeLabels[type]);
    for (const block of blocks) {
      if (blocks.length > 1 || block.title !== blockTypeLabels[type]) lines.push(`[${formatField(block.title)}]`);
      if (block.items.length === 0) {
        lines.push('- 저장된 항목 없음');
        continue;
      }
      for (const item of block.items) {
        lines.push(`- ${formatField(item.label)}: ${formatItemValue(item, factsByKey)}`);
        const state = formatItemState(item);
        if (state) lines.push(`  상태: ${state}`);
      }
    }
    lines.push('');
  }

  if (omittedNoteCount > 0) {
    lines.push(itemCount === 0
      ? `메모 ${omittedNoteCount}개만 저장되어 있어 기본 보기에는 표시할 항목이 없습니다. 필요한 경우 메모 포함을 켜고 다시 확인하세요.`
      : `메모 ${omittedNoteCount}개는 기본 제외했습니다. 필요한 경우 메모 포함을 켜고 다시 확인하세요.`);
    lines.push('');
  }

  lines.push(`저장 정보: ${formatRevisionReason(currentRevision?.reason)} · 버전 ${workspace.revision} · ${formatDateTime(currentRevision?.createdAt ?? workspace.updatedAt)}`);
  lines.push('검토 중인 AI 변경 후보는 포함하지 않았습니다.');

  return {
    ok: true,
    text: trimBlankLines(lines).join('\n'),
    revision: workspace.revision,
    includedNoteCount: includeNotes ? noteBlocks.reduce((count, block) => count + block.items.length, 0) : 0,
    omittedNoteCount,
    itemCount,
  };
}

function formatItemValue(item: BlockItem, factsByKey: Map<string, Fact>): string {
  const value = formatField(item.value);
  if (isSafePlainInteger(value) && itemRepresentsKrw(item, factsByKey)) return formatKrw(Number(value));
  return value;
}

function itemRepresentsKrw(item: BlockItem, factsByKey: Map<string, Fact>): boolean {
  if (item.edited) return false;
  const valueFact = item.valueFactKey ? factsByKey.get(item.valueFactKey) : null;
  if (valueFact?.semantic?.kind === 'money' && valueFact.semantic.unit === 'KRW') return true;
  if (!item.calculation) return false;
  const totalFact = factsByKey.get(item.calculation.totalFactKey);
  const divisorFact = factsByKey.get(item.calculation.divisorFactKey);
  return totalFact?.semantic?.kind === 'money' &&
    totalFact.semantic.unit === 'KRW' &&
    divisorFact?.semantic?.kind === 'count';
}

function isSafePlainInteger(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric);
}

function formatItemState(item: BlockItem): string {
  const state = [
    item.locked ? '고정됨' : null,
    item.completed ? '완료됨' : null,
    item.edited ? '직접 수정됨' : null,
    item.stale ? '다시 확인 필요' : null,
    item.preparation?.dueDate ? `준비 마감 ${item.preparation.dueDate}` : null,
    item.preparation?.durationMinutes ? `예상 ${item.preparation.durationMinutes}분` : null,
  ].filter((value): value is string => Boolean(value));
  return state.join(', ');
}

function formatRevisionReason(reason: string | undefined): string {
  if (!reason) return '저장된 내용';
  if (reason === 'created') return '처음 만든 저장 내용';
  if (reason === 'sample_initial') return '체험용 예시로 만든 저장 내용';
  if (reason === 'apply_changeset') return '확인한 변경을 저장';
  if (reason === 'manual_edit') return '직접 수정해 저장';
  if (reason.startsWith('restore_')) return '이전 내용을 복원해 저장';
  return '저장된 내용';
}

function formatField(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '(빈 값)';
}

function formatKrw(value: number): string {
  return `${new Intl.NumberFormat('ko-KR').format(value)}원`;
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

function trimBlankLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1] === '') copy.pop();
  return copy;
}
