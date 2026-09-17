import { describe, expect, it } from 'vitest';
import { buildApprovedRevisionCopyText } from '../../src/client/workspace/approved-change-copy';
import type { Snapshot } from '../../src/core/contracts';
import type { WorkspaceExport } from '../../src/core/export-contracts';

const previousSnapshot: Snapshot = {
  facts: [{
    id: 'fact_participants',
    key: 'participants',
    label: '참가 인원',
    value: 4,
    evidence: { sourceId: 'src_private', quote: '4명', start: 0, end: 2 },
  }],
  blocks: [{
    id: 'block_cost',
    key: 'cost',
    type: 'cost',
    title: '비용',
    items: [{
      id: 'item_share',
      key: 'share',
      label: '1인 부담',
      value: '225000',
      factKeys: ['participants'],
      valueFactKey: null,
      calculation: null,
      completed: false,
      locked: false,
      edited: false,
      stale: false,
    }],
  }],
};

const currentSnapshot: Snapshot = {
  facts: [{
    ...previousSnapshot.facts[0]!,
    value: 3,
    evidence: { sourceId: 'src_private', quote: '3명', start: 3, end: 5 },
  }],
  blocks: [{
    ...previousSnapshot.blocks[0]!,
    items: [{
      ...previousSnapshot.blocks[0]!.items[0]!,
      value: '300000',
      completed: true,
    }],
  }],
};

const exported = (overrides: Partial<WorkspaceExport['content']> = {}): WorkspaceExport => {
  const content: WorkspaceExport['content'] = {
    workspace: {
      id: 'ws_approved',
      title: '제주 여행',
      purpose: '여행 변경 검토',
      revision: 4,
      sourceRevision: 2,
      createdAt: '2026-09-12T08:00:00.000Z',
      updatedAt: '2026-09-12T08:30:00.000Z',
      expiresAt: '2026-09-19T08:30:00.000Z',
    },
    sources: [{
      id: 'src_private',
      title: '비공개 원문',
      text: '4명 3명',
      relation: 'correction',
      targetSourceId: null,
      hash: 'hash',
      createdAt: '2026-09-12T08:20:00.000Z',
    }],
    snapshot: currentSnapshot,
    revisions: [
      { revision: 3, reason: 'manual_edit', createdAt: '2026-09-12T08:10:00.000Z', snapshot: previousSnapshot },
      { revision: 4, reason: 'apply_changeset', createdAt: '2026-09-12T08:30:00.000Z', snapshot: currentSnapshot },
    ],
    ...overrides,
  };
  return {
    format: 'ieojim.workspace',
    version: 1,
    exportedAt: '2026-09-12T08:31:00.000Z',
    content,
    checksum: { algorithm: 'SHA-256', encoding: 'JSON.stringify(content), UTF-8', value: '0'.repeat(64) },
  };
};

describe('approved revision copy text', () => {
  it('formats only actual before/after differences from the approved revision and its base snapshot', () => {
    const result = buildApprovedRevisionCopyText(exported(), 'ws_approved', 4);

    expect(result).toMatchObject({ ok: true, revision: 4, changeCount: 2 });
    expect(result.ok && result.text).toContain('제주 여행 — 변경 안내');
    expect(result.ok && result.text).toContain('저장된 계획: 3 → 4');
    expect(result.ok && result.text).toContain('이전: 225000');
    expect(result.ok && result.text).toContain('이후: 300000');
    expect(result.ok && result.text).toContain('상태: 완료 아니오→예');
    expect(result.ok && result.text).toContain('참가 인원');
    expect(result.ok && result.text).not.toContain('src_private');
    expect(result.ok && result.text).not.toContain('budget_ledger');
    expect(result.ok && result.text).not.toContain('account');
    expect(result.ok && result.text).not.toContain('사용자 값 유지');
  });

  it('refuses current revisions that are not saved apply revisions', () => {
    const result = buildApprovedRevisionCopyText(exported({
      revisions: [
        { revision: 3, reason: 'manual_edit', createdAt: '2026-09-12T08:10:00.000Z', snapshot: previousSnapshot },
        { revision: 4, reason: 'restore_2', createdAt: '2026-09-12T08:30:00.000Z', snapshot: currentSnapshot },
      ],
    }), 'ws_approved', 4);

    expect(result).toMatchObject({ ok: false, reason: 'not_approved_revision' });
  });

  it('rejects stale workspace or revision before producing copyable text', () => {
    expect(buildApprovedRevisionCopyText(exported(), 'ws_other', 4))
      .toMatchObject({ ok: false, reason: 'not_current_workspace' });
    expect(buildApprovedRevisionCopyText(exported(), 'ws_approved', 5))
      .toMatchObject({ ok: false, reason: 'not_current_workspace' });
  });

  it('does not infer before/after values when the base revision is missing', () => {
    const result = buildApprovedRevisionCopyText(exported({
      revisions: [{ revision: 4, reason: 'apply_changeset', createdAt: '2026-09-12T08:30:00.000Z', snapshot: currentSnapshot }],
    }), 'ws_approved', 4);

    expect(result).toMatchObject({ ok: false, reason: 'missing_base_revision' });
    expect(result.ok ? '' : result.message).toContain('추정하지 않습니다');
  });

  it('does not copy preserved items when the two persisted snapshots are identical', () => {
    const result = buildApprovedRevisionCopyText(exported({
      snapshot: previousSnapshot,
      revisions: [
        { revision: 3, reason: 'manual_edit', createdAt: '2026-09-12T08:10:00.000Z', snapshot: previousSnapshot },
        { revision: 4, reason: 'apply_changeset', createdAt: '2026-09-12T08:30:00.000Z', snapshot: previousSnapshot },
      ],
    }), 'ws_approved', 4);

    expect(result).toMatchObject({ ok: false, reason: 'no_diff' });
  });
});
