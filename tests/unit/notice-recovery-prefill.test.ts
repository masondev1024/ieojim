import { describe, expect, it } from 'vitest';
import type { BlockItem, Fact, Source, WorkspaceView } from '../../src/core/contracts';
import { buildNoticeSetupPrefill } from '../../src/client/recovery/notice-recovery-prefill';

describe('notice recovery setup prefill', () => {
  it('reuses one eligible source-backed target and saved preparation duration', () => {
    const view = workspace();
    const prefill = buildNoticeSetupPrefill(view, 'source:notice', '', '');

    expect(prefill.targetItemId).toBe('item:presentation');
    expect(prefill.targetAfterStart).toMatchObject({
      value: '2026-09-18T11:00',
      provenance: { label: '원문 근거에서 가져옴' },
    });
    expect(prefill.prepItemId).toBe('item:prep');
    expect(prefill.prepDurationMinutes).toMatchObject({
      value: '90',
      provenance: { label: '준비 설정에서 가져옴' },
    });
    expect(prefill.prepDueDate).toMatchObject({
      label: '준비 설정에 저장된 마감일',
      detail: '발표자료 준비: 2026-09-18',
    });
  });

  it('does not trust a semantic date that disagrees with the quoted source text', () => {
    const view = workspace({
      facts: [dateFact('fact:presentation', 'presentation_time', '발표 시간', '발표는 2026년 9월 16일 14:00에서 16:00으로 변경됩니다.', '2026-10-21', '16:00')],
    });
    const prefill = buildNoticeSetupPrefill(view, 'source:notice', '', '');

    expect(prefill.targetItemId).toBeNull();
    expect(prefill.targetAfterStart).toBeNull();
  });

  it('leaves partial dates, time-only facts, travel time and availability for the user', () => {
    const view = workspace({
      facts: [{
        ...dateFact('fact:presentation', 'presentation_time', '발표 시간', '발표는 9월 18일 11:00입니다.', '2026-09-18', '11:00'),
        semantic: { kind: 'date_time', date: '09-18', time: '11:00' },
      }],
    });
    const prefill = buildNoticeSetupPrefill(view, 'source:notice', '', '');

    expect(prefill.targetAfterStart).toBeNull();
    expect(prefill).not.toHaveProperty('travelMinutes');
    expect(prefill).not.toHaveProperty('workWindows');
  });

  it('does not select protected target or preparation items', () => {
    const view = workspace({
      presentation: { completed: true },
      prep: { stale: true },
    });
    const prefill = buildNoticeSetupPrefill(view, 'source:notice', '', '');

    expect(prefill.targetItemId).toBeNull();
    expect(prefill.prepItemId).toBeNull();
    expect(prefill.prepDurationMinutes).toBeNull();
  });

  it('rejects unsupported timezone metadata', () => {
    const view = workspace({
      facts: [{
        ...dateFact('fact:presentation', 'presentation_time', '발표 시간', '발표는 2026-09-18 11:00입니다.', '2026-09-18', '11:00'),
        semantic: { kind: 'date_time', date: '2026-09-18', time: '11:00', timezone: 'America/Los_Angeles' } as unknown as Fact['semantic'],
      }],
    });
    const prefill = buildNoticeSetupPrefill(view, 'source:notice', '', '');

    expect(prefill.targetItemId).toBeNull();
    expect(prefill.targetAfterStart).toBeNull();
  });

  it('does not choose the first instant when an item has multiple distinct date-time facts', () => {
    const view = workspace({
      facts: [
        dateFact('fact:presentation-start', 'presentation_start', '발표 시작', '발표는 2026-09-18 11:00입니다.', '2026-09-18', '11:00'),
        dateFact('fact:presentation-deadline', 'presentation_deadline', '발표 자료 마감', '발표 자료는 2026-09-17 18:00까지입니다.', '2026-09-17', '18:00'),
      ],
      presentation: { factKeys: ['presentation_start', 'presentation_deadline'], valueFactKey: null },
    });
    const prefill = buildNoticeSetupPrefill(view, 'source:notice', '', '');

    expect(prefill.targetItemId).toBeNull();
    expect(prefill.targetAfterStart).toBeNull();
  });

  it('does not treat an unbound deadline fact as a schedule start', () => {
    const view = workspace({
      facts: [
        dateFact('fact:presentation-deadline', 'presentation_deadline', '발표 자료 마감', '발표 자료는 2026-09-17 18:00까지입니다.', '2026-09-17', '18:00'),
      ],
      presentation: { factKeys: ['presentation_deadline'], valueFactKey: null },
    });
    const prefill = buildNoticeSetupPrefill(view, 'source:notice', '', '');

    expect(prefill.targetItemId).toBeNull();
    expect(prefill.targetAfterStart).toBeNull();
  });

  it('rejects before-and-after ranges instead of inventing which instant is the changed start', () => {
    const quote = '발표는 2026-09-18 14:00에서 2026-09-18 11:00로 변경됩니다.';
    const view = workspace({
      facts: [
        dateFact('fact:presentation-before', 'presentation_before', '변경 전 발표 시간', quote, '2026-09-18', '14:00'),
        dateFact('fact:presentation-after', 'presentation_after', '변경 후 발표 시간', quote, '2026-09-18', '11:00'),
      ],
      presentation: { factKeys: ['presentation_before', 'presentation_after'], valueFactKey: null },
    });
    const prefill = buildNoticeSetupPrefill(view, 'source:notice', '', '');

    expect(prefill.targetItemId).toBeNull();
    expect(prefill.targetAfterStart).toBeNull();
  });
});

const sourceText = '발표는 2026-09-18 11:00입니다. 발표 자료는 2026-09-17 18:00까지입니다. 발표는 2026-09-18 14:00에서 2026-09-18 11:00로 변경됩니다.';

function workspace(overrides: {
  facts?: Fact[];
  presentation?: Partial<BlockItem>;
  prep?: Partial<BlockItem>;
} = {}): WorkspaceView {
  const source: Source = {
    id: 'source:notice',
    title: '변경 안내',
    text: sourceText,
    relation: 'initial',
    targetSourceId: null,
    hash: 'hash-notice',
    createdAt: '2026-09-16T00:00:00.000Z',
  };
  const facts = overrides.facts ?? [
    dateFact('fact:presentation', 'presentation_time', '발표 시간', '발표는 2026-09-18 11:00입니다.', '2026-09-18', '11:00'),
  ];
  return {
    id: 'workspace:notice',
    title: '발표 준비',
    purpose: '변경 안내를 반영한다.',
    sampleScenario: null,
    revision: 1,
    sourceRevision: 1,
    sources: [source],
    snapshot: {
      facts,
      blocks: [
        {
          id: 'block:schedule',
          key: 'schedule',
          type: 'schedule',
          title: '일정',
          items: [
            item('item:presentation', 'presentation', '고객 발표', '발표 시간', ['presentation_time'], 'presentation_time', overrides.presentation),
          ],
        },
        {
          id: 'block:checklist',
          key: 'checklist',
          type: 'checklist',
          title: '준비',
          items: [
            item('item:prep', 'prep', '발표자료 준비', '자료 정리', [], null, {
              preparation: { version: 1, dueDate: '2026-09-18', durationMinutes: 90 },
              ...overrides.prep,
            }),
          ],
        },
      ],
    },
    pending: null,
    runs: [],
    history: [],
    expiresAt: '2026-09-23T00:00:00.000Z',
  };
}

function item(id: string, key: string, label: string, value: string, factKeys: string[], valueFactKey: string | null, overrides: Partial<BlockItem> = {}): BlockItem {
  return {
    id,
    key,
    label,
    value,
    factKeys,
    valueFactKey,
    calculation: null,
    completed: false,
    locked: false,
    edited: false,
    stale: false,
    ...overrides,
  };
}

function dateFact(id: string, key: string, label: string, quote: string, date: string, time: string): Fact {
  return {
    id,
    key,
    label,
    value: `${date}T${time}`,
    evidence: {
      sourceId: 'source:notice',
      quote,
      start: sourceText.indexOf(quote),
      end: sourceText.indexOf(quote) + quote.length,
    },
    semantic: { kind: 'date_time', date, time },
  };
}
