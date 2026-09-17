import { describe, expect, it } from 'vitest';
import { buildCurrentPlanBriefText } from '../../src/client/workspace/current-plan-brief';
import type { Snapshot } from '../../src/core/contracts';
import type { WorkspaceExport } from '../../src/core/export-contracts';

const snapshot: Snapshot = {
  facts: [
    {
      id: 'fact_total_cost',
      key: 'fixed_total_cost',
      label: '공동 고정비 총액',
      value: 900000,
      evidence: { sourceId: 'src_current', quote: '공동 고정비는 총 900000원입니다.', start: 0, end: 21 },
      semantic: { kind: 'money', unit: 'KRW' },
    },
    {
      id: 'fact_people',
      key: 'participant_count',
      label: '참가 인원',
      value: 3,
      evidence: { sourceId: 'src_current', quote: '참가 인원은 3명입니다.', start: 22, end: 34 },
      semantic: { kind: 'count', unit: 'person' },
    },
  ],
  blocks: [
    {
      id: 'block_schedule',
      key: 'schedule',
      type: 'schedule',
      title: '일정',
      items: [
        {
          id: 'item_dinner',
          key: 'dinner',
          label: '2일차 저녁 식사',
          value: '19:00, 기존 예약 유지',
          factKeys: [],
          valueFactKey: null,
          calculation: null,
          completed: false,
          locked: true,
          edited: false,
          stale: false,
        },
      ],
    },
    {
      id: 'block_cost',
      key: 'cost',
      type: 'cost',
      title: '비용',
      items: [
        {
          id: 'item_share',
          key: 'per_person',
          label: '1인 부담',
          value: '300000',
          factKeys: ['fixed_total_cost', 'participant_count'],
          valueFactKey: null,
          calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participant_count' },
          completed: true,
          locked: false,
          edited: false,
          stale: false,
        },
      ],
    },
    {
      id: 'block_checklist',
      key: 'checklist',
      type: 'checklist',
      title: '준비할 일',
      items: [
        {
          id: 'item_confirm',
          key: 'confirm',
          label: '변경된 인원 확인',
          value: '민수 불참 반영',
          factKeys: ['participant_count'],
          valueFactKey: null,
          calculation: null,
          completed: false,
          locked: false,
          edited: false,
          stale: true,
        },
      ],
    },
    {
      id: 'block_note',
      key: 'note',
      type: 'note',
      title: '개인 메모',
      items: [
        {
          id: 'item_private_note',
          key: 'private',
          label: '개인 확인',
          value: '카드 영수증은 따로 보관',
          factKeys: [],
          valueFactKey: null,
          calculation: null,
          completed: false,
          locked: false,
          edited: false,
          stale: false,
        },
      ],
    },
  ],
};

const exported = (overrides: Partial<WorkspaceExport['content']> = {}): WorkspaceExport => {
  const content: WorkspaceExport['content'] = {
    workspace: {
      id: 'ws_current',
      title: '제주 여행',
      purpose: '여행 변경 공유',
      revision: 5,
      sourceRevision: 3,
      createdAt: '2026-09-12T08:00:00.000Z',
      updatedAt: '2026-09-12T09:00:00.000Z',
      expiresAt: '2026-09-19T09:00:00.000Z',
    },
    sources: [
      {
        id: 'src_current',
        title: '현재 원문',
        text: '공동 고정비는 총 900000원입니다. 참가 인원은 3명입니다.',
        relation: 'correction',
        targetSourceId: null,
        hash: 'hash',
        createdAt: '2026-09-12T08:45:00.000Z',
      },
    ],
    snapshot,
    revisions: [
      { revision: 4, reason: 'apply_changeset', createdAt: '2026-09-12T08:30:00.000Z', snapshot: { facts: [], blocks: [] } },
      { revision: 5, reason: 'manual_edit', createdAt: '2026-09-12T09:00:00.000Z', snapshot },
    ],
    ...overrides,
  };
  return {
    format: 'ieojim.workspace',
    version: 1,
    exportedAt: '2026-09-12T09:01:00.000Z',
    content,
    checksum: { algorithm: 'SHA-256', encoding: 'JSON.stringify(content), UTF-8', value: '0'.repeat(64) },
  };
};

describe('current plan brief text', () => {
  it('formats the current saved snapshot without claiming manual edits were approved', () => {
    const result = buildCurrentPlanBriefText(exported(), { workspaceId: 'ws_current', currentRevision: 5 });

    expect(result).toMatchObject({ ok: true, revision: 5, itemCount: 3, omittedNoteCount: 1 });
    expect(result.ok && result.text).toContain('제주 여행 현재 저장된 계획');
    expect(result.ok && result.text).toContain('일정');
    expect(result.ok && result.text).toContain('- 2일차 저녁 식사: 19:00, 기존 예약 유지');
    expect(result.ok && result.text).toContain('상태: 고정됨');
    expect(result.ok && result.text).toContain('비용');
    expect(result.ok && result.text).toContain('- 1인 부담: 300,000원');
    expect(result.ok && result.text).toContain('상태: 완료됨');
    expect(result.ok && result.text).toContain('준비할 일');
    expect(result.ok && result.text).toContain('상태: 다시 확인 필요');
    expect(result.ok && result.text).toContain('저장 정보: 직접 수정해 저장 · 버전 5');
    expect(result.ok && result.text).toContain('검토 중인 AI 변경 후보는 포함하지 않았습니다');
    expect(result.ok && result.text).not.toContain('모두 승인');
    expect(result.ok && result.text).not.toContain('카드 영수증');
    expect(result.ok && result.text).not.toContain('공동 고정비 총액');
    expect(result.ok && result.text).not.toContain('참가 인원');
  });

  it('includes notes only when the user opts in', () => {
    const withoutNotes = buildCurrentPlanBriefText(exported(), { workspaceId: 'ws_current', currentRevision: 5, includeNotes: false });
    const withNotes = buildCurrentPlanBriefText(exported(), { workspaceId: 'ws_current', currentRevision: 5, includeNotes: true });

    expect(withoutNotes).toMatchObject({ ok: true, omittedNoteCount: 1, includedNoteCount: 0 });
    expect(withoutNotes.ok && withoutNotes.text).not.toContain('카드 영수증');
    expect(withNotes).toMatchObject({ ok: true, omittedNoteCount: 0, includedNoteCount: 1 });
    expect(withNotes.ok && withNotes.text).toContain('메모');
    expect(withNotes.ok && withNotes.text).toContain('- 개인 확인: 카드 영수증은 따로 보관');
  });

  it('rejects stale workspace or revision before producing copyable text', () => {
    expect(buildCurrentPlanBriefText(exported(), { workspaceId: 'ws_other', currentRevision: 5 }))
      .toMatchObject({ ok: false, reason: 'not_current_workspace' });
    expect(buildCurrentPlanBriefText(exported(), { workspaceId: 'ws_current', currentRevision: 6 }))
      .toMatchObject({ ok: false, reason: 'not_current_workspace' });
  });

  it('uses the exported current snapshot even when the previous revision has different values', () => {
    const result = buildCurrentPlanBriefText(exported({
      revisions: [
        { revision: 4, reason: 'apply_changeset', createdAt: '2026-09-12T08:30:00.000Z', snapshot: { facts: [], blocks: [] } },
        { revision: 5, reason: 'manual_edit', createdAt: '2026-09-12T09:00:00.000Z', snapshot },
      ],
    }), { workspaceId: 'ws_current', currentRevision: 5 });

    expect(result.ok && result.text).toContain('- 1인 부담: 300,000원');
    expect(result.ok && result.text).not.toContain('225,000원');
  });

  it('preserves arbitrary numeric user-edited cost values without KRW semantics', () => {
    const customSnapshot: Snapshot = {
      facts: [],
      blocks: [{
        id: 'block_cost',
        key: 'cost',
        type: 'cost',
        title: '비용',
        items: [{
          id: 'item_points',
          key: 'points',
          label: '마일리지 차감',
          value: '300000',
          factKeys: [],
          valueFactKey: null,
          calculation: null,
          completed: false,
          locked: false,
          edited: true,
          stale: false,
        }],
      }],
    };

    const result = buildCurrentPlanBriefText(exported({
      snapshot: customSnapshot,
      revisions: [{ revision: 5, reason: 'manual_edit', createdAt: '2026-09-12T09:00:00.000Z', snapshot: customSnapshot }],
    }), { workspaceId: 'ws_current', currentRevision: 5 });

    expect(result.ok && result.text).toContain('- 마일리지 차감: 300000');
    expect(result.ok && result.text).not.toContain('300,000원');
  });

  it('preserves manually edited numeric values even when stale KRW calculation metadata remains', () => {
    const manualSnapshot: Snapshot = {
      facts: snapshot.facts,
      blocks: [{
        id: 'block_cost',
        key: 'cost',
        type: 'cost',
        title: '비용',
        items: [{
          id: 'item_share',
          key: 'per_person',
          label: '1인 부담',
          value: '300000',
          factKeys: ['fixed_total_cost', 'participant_count'],
          valueFactKey: null,
          calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participant_count' },
          completed: false,
          locked: false,
          edited: true,
          stale: false,
        }],
      }],
    };

    const result = buildCurrentPlanBriefText(exported({
      snapshot: manualSnapshot,
      revisions: [{ revision: 5, reason: 'manual_edit', createdAt: '2026-09-12T09:00:00.000Z', snapshot: manualSnapshot }],
    }), { workspaceId: 'ws_current', currentRevision: 5 });

    expect(result.ok && result.text).toContain('- 1인 부담: 300000');
    expect(result.ok && result.text).not.toContain('300,000원');
  });

  it('does not reformat unsafe or leading-zero numeric strings as KRW', () => {
    const unsafeSnapshot: Snapshot = {
      facts: snapshot.facts,
      blocks: [{
        id: 'block_cost',
        key: 'cost',
        type: 'cost',
        title: '비용',
        items: [
          {
            id: 'item_unsafe',
            key: 'unsafe',
            label: '큰 숫자 코드',
            value: '9007199254740993',
            factKeys: ['fixed_total_cost', 'participant_count'],
            valueFactKey: null,
            calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participant_count' },
            completed: false,
            locked: false,
            edited: false,
            stale: false,
          },
          {
            id: 'item_leading_zero',
            key: 'leading_zero',
            label: '예약 코드',
            value: '000123',
            factKeys: ['fixed_total_cost', 'participant_count'],
            valueFactKey: null,
            calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participant_count' },
            completed: false,
            locked: false,
            edited: false,
            stale: false,
          },
        ],
      }],
    };

    const result = buildCurrentPlanBriefText(exported({
      snapshot: unsafeSnapshot,
      revisions: [{ revision: 5, reason: 'apply_changeset', createdAt: '2026-09-12T09:00:00.000Z', snapshot: unsafeSnapshot }],
    }), { workspaceId: 'ws_current', currentRevision: 5 });

    expect(result.ok && result.text).toContain('- 큰 숫자 코드: 9007199254740993');
    expect(result.ok && result.text).toContain('- 예약 코드: 000123');
    expect(result.ok && result.text).not.toContain('9,007,199,254,740,992원');
    expect(result.ok && result.text).not.toContain('123원');
  });

  it('omits contradictory source facts from the companion brief', () => {
    const contradictorySnapshot: Snapshot = {
      facts: [{
        id: 'fact_people',
        key: 'participant_count',
        label: '참가 인원',
        value: 4,
        evidence: { sourceId: 'src_current', quote: '참가 인원은 4명입니다.', start: 22, end: 34 },
        semantic: { kind: 'count', unit: 'person' },
      }],
      blocks: [{
        id: 'block_checklist',
        key: 'checklist',
        type: 'checklist',
        title: '준비할 일',
        items: [{
          id: 'item_confirm',
          key: 'confirm',
          label: '공유할 인원',
          value: '최종 참석 3명',
          factKeys: ['participant_count'],
          valueFactKey: null,
          calculation: null,
          completed: false,
          locked: false,
          edited: true,
          stale: false,
        }],
      }],
    };

    const result = buildCurrentPlanBriefText(exported({
      snapshot: contradictorySnapshot,
      revisions: [{ revision: 5, reason: 'manual_edit', createdAt: '2026-09-12T09:00:00.000Z', snapshot: contradictorySnapshot }],
    }), { workspaceId: 'ws_current', currentRevision: 5 });

    expect(result.ok && result.text).toContain('- 공유할 인원: 최종 참석 3명');
    expect(result.ok && result.text).not.toContain('참가 인원');
    expect(result.ok && result.text).not.toContain('4명');
  });

  it('does not permanently fail when only notes exist and notes are excluded by default', () => {
    const notesOnlySnapshot: Snapshot = {
      facts: [],
      blocks: [snapshot.blocks[3]!],
    };

    const withoutNotes = buildCurrentPlanBriefText(exported({
      snapshot: notesOnlySnapshot,
      revisions: [{ revision: 5, reason: 'manual_edit', createdAt: '2026-09-12T09:00:00.000Z', snapshot: notesOnlySnapshot }],
    }), { workspaceId: 'ws_current', currentRevision: 5 });
    const withNotes = buildCurrentPlanBriefText(exported({
      snapshot: notesOnlySnapshot,
      revisions: [{ revision: 5, reason: 'manual_edit', createdAt: '2026-09-12T09:00:00.000Z', snapshot: notesOnlySnapshot }],
    }), { workspaceId: 'ws_current', currentRevision: 5, includeNotes: true });

    expect(withoutNotes).toMatchObject({ ok: true, itemCount: 0, omittedNoteCount: 1 });
    expect(withoutNotes.ok && withoutNotes.text).toContain('메모 1개만 저장되어 있어 기본 보기에는 표시할 항목이 없습니다');
    expect(withNotes).toMatchObject({ ok: true, itemCount: 1, includedNoteCount: 1 });
    expect(withNotes.ok && withNotes.text).toContain('- 개인 확인: 카드 영수증은 따로 보관');
  });
});
