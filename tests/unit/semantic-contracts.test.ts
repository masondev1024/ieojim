import { describe, expect, it } from 'vitest';
import { buildChangeSet, resolveChangeSet } from '../../src/core/engine';
import { DomainError, emptySnapshot, liveDraftV2Schema, type LiveProposalDraftV2, type Snapshot, type Source } from '../../src/core/contracts';

const source = (id: string, text: string, relation: Source['relation'] = 'initial', targetSourceId: string | null = null): Source => ({
  id,
  text,
  title: `합성 자료 ${id}`,
  relation,
  targetSourceId,
  hash: `hash-${id}`,
  createdAt: '2026-09-09T00:00:00.000Z',
});

const initialSource = () => source('initial', '참석자는 4명입니다. 공동 고정비는 총 90만 원입니다. 팀 과제 마감은 10월 3일 23:59입니다.');

const initialDraft = (sourceId: string): LiveProposalDraftV2 => ({
  schemaVersion: 2,
  summary: 'typed initial',
  questions: [],
  facts: [
    { operation: 'create', targetFactKey: null, key: 'participants', label: '참석자 수', value: 4, sourceId, quote: '참석자는 4명입니다', semantic: { kind: 'count', unit: 'person' } },
    { operation: 'create', targetFactKey: null, key: 'fixed_total_cost', label: '공동 고정비 총액', value: 900000, sourceId, quote: '공동 고정비는 총 90만 원입니다', semantic: { kind: 'money', unit: 'KRW' } },
    { operation: 'create', targetFactKey: null, key: 'assignment_deadline', label: '과제 마감', value: '10월 3일 23:59', sourceId, quote: '팀 과제 마감은 10월 3일 23:59입니다', semantic: { kind: 'date_time', date: '10-03', time: '23:59' } },
  ],
  blocks: [
    {
      key: 'travel_cost',
      type: 'cost',
      title: '비용',
      items: [{
        operation: 'create',
        targetItemId: null,
        key: 'fixed_cost_share',
        label: '인당 고정비',
        value: '225000',
        factKeys: ['fixed_total_cost', 'participants'],
        valueFactKey: 'fixed_total_cost',
        calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participants' },
      }],
    },
    {
      key: 'assignment_schedule',
      type: 'schedule',
      title: '마감',
      items: [{
        operation: 'create',
        targetItemId: null,
        key: 'deadline',
        label: '과제 마감',
        value: '10월 3일 23:59',
        factKeys: ['assignment_deadline'],
        valueFactKey: 'assignment_deadline',
        calculation: null,
      }],
    },
  ],
  removedItems: [],
});

const fact = (snapshot: Snapshot, key: string) => {
  const found = snapshot.facts.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`missing fact ${key}`);
  return found;
};

const buildInitial = () => {
  const base = initialSource();
  const changeSet = buildChangeSet({ snapshot: emptySnapshot(), sources: [base], draft: initialDraft(base.id), baseRevision: 0, baseSourceRevision: 1 });
  return { base, snapshot: changeSet.next };
};

describe('semantic proposal contracts', () => {
  it('exports a strict live v2 schema with required fact and item operation targets', () => {
    expect(liveDraftV2Schema.safeParse({ summary: 'legacy', questions: [], facts: [], blocks: [], removedItems: [] }).success).toBe(false);
    expect(liveDraftV2Schema.safeParse(initialDraft('source-1')).success).toBe(true);
  });

  it('stores compact money, count and date_time metadata without changing scalar values', () => {
    const { snapshot } = buildInitial();

    expect(fact(snapshot, 'fixed_total_cost')).toMatchObject({ value: 900000, semantic: { kind: 'money', unit: 'KRW' } });
    expect(fact(snapshot, 'participants')).toMatchObject({ value: 4, semantic: { kind: 'count', unit: 'person' } });
    expect(fact(snapshot, 'assignment_deadline')).toMatchObject({ value: '10월 3일 23:59', semantic: { kind: 'date_time', date: '10-03', time: '23:59' } });
  });

  it('rejects recognized KRW and count facts that omit v2 semantics', () => {
    const base = initialSource();
    const draft = initialDraft(base.id);
    draft.facts[0]!.semantic = null;
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [base], draft, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);
  });

  it('rejects wrong units, approximate ranges, foreign currencies and negative numeric evidence', () => {
    const unitSource = source('unit', '참석자는 4명입니다.');
    const wrongUnit = initialDraft(unitSource.id);
    wrongUnit.facts = [{ operation: 'create', targetFactKey: null, key: 'participants', label: '참석자 수', value: 4, sourceId: unitSource.id, quote: '참석자는 4명입니다', semantic: { kind: 'count', unit: 'team' } }];
    wrongUnit.blocks = [];
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [unitSource], draft: wrongUnit, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);

    for (const [text, quote] of [
      ['공동 고정비는 약 90만 원입니다.', '공동 고정비는 약 90만 원입니다'],
      ['공동 고정비는 90만 원 또는 100만 원입니다.', '공동 고정비는 90만 원 또는 100만 원입니다'],
      ['공동 고정비는 USD 900입니다.', '공동 고정비는 USD 900입니다'],
      ['공동 고정비는 -900000원입니다.', '공동 고정비는 -900000원입니다'],
      ['공동 고정비는 1.5원입니다.', '공동 고정비는 1.5원입니다'],
      ['공동 고정비는 900000원이고 참석자는 4명입니다.', '공동 고정비는 900000원이고 참석자는 4명입니다'],
    ] as const) {
      const base = source(`money-${quote.length}`, text);
      const draft = initialDraft(base.id);
      draft.facts = [{ operation: 'create', targetFactKey: null, key: 'fixed_total_cost', label: '공동 고정비 총액', value: 900000, sourceId: base.id, quote, semantic: { kind: 'money', unit: 'KRW' } }];
      draft.blocks = [];
      expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [base], draft, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);
    }
  });

  it('validates explicit date and time fields against quote and value without inferring year or timezone', () => {
    const leap = source('leap', '휴무일은 02월 29일입니다.');
    const partialLeap = initialDraft(leap.id);
    partialLeap.facts = [{ operation: 'create', targetFactKey: null, key: 'leap_day', label: '휴무일', value: '02월 29일', sourceId: leap.id, quote: '휴무일은 02월 29일입니다', semantic: { kind: 'date_time', date: '02-29' } }];
    partialLeap.blocks = [];
    expect(buildChangeSet({ snapshot: emptySnapshot(), sources: [leap], draft: partialLeap, baseRevision: 0, baseSourceRevision: 1 }).next.facts[0]?.semantic).toMatchObject({ date: '02-29' });

    const iso = source('iso-date', '팀 과제 마감은 2026-10-03 23:59입니다.');
    const isoDraft = initialDraft(iso.id);
    isoDraft.facts = [{ operation: 'create', targetFactKey: null, key: 'iso_deadline', label: 'ISO 마감', value: '2026-10-03 23:59', sourceId: iso.id, quote: '팀 과제 마감은 2026-10-03 23:59입니다', semantic: { kind: 'date_time', date: '2026-10-03', time: '23:59' } }];
    isoDraft.blocks = [];
    expect(buildChangeSet({ snapshot: emptySnapshot(), sources: [iso], draft: isoDraft, baseRevision: 0, baseSourceRevision: 1 }).next.facts[0]?.semantic).toMatchObject({ date: '2026-10-03' });

    const invalidDate = initialDraft(leap.id);
    invalidDate.facts = [{ operation: 'create', targetFactKey: null, key: 'bad_date', label: '잘못된 날짜', value: '2025-02-29', sourceId: leap.id, quote: '휴무일은 02월 29일입니다', semantic: { kind: 'date_time', date: '2025-02-29' } }];
    invalidDate.blocks = [];
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [leap], draft: invalidDate, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);

    const invalidHour = initialDraft(initialSource().id);
    invalidHour.facts = [{ operation: 'create', targetFactKey: null, key: 'bad_time', label: '잘못된 시간', value: '24:00', sourceId: 'initial', quote: '팀 과제 마감은 10월 3일 23:59입니다', semantic: { kind: 'date_time', date: '10-03', time: '24:00' } }];
    invalidHour.blocks = [];
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [initialSource()], draft: invalidHour, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);

    const koreanTime = source('korean-time', '첫날 도착 시간은 오후 4시입니다.');
    const koreanTimeDraft = initialDraft(koreanTime.id);
    koreanTimeDraft.facts = [{ operation: 'create', targetFactKey: null, key: 'arrival_time', label: '도착 시간', value: '오후 4시', sourceId: koreanTime.id, quote: '첫날 도착 시간은 오후 4시입니다', semantic: { kind: 'date_time', time: '16:00' } }];
    koreanTimeDraft.blocks = [];
    expect(buildChangeSet({ snapshot: emptySnapshot(), sources: [koreanTime], draft: koreanTimeDraft, baseRevision: 0, baseSourceRevision: 1 }).next.facts[0]?.semantic).toMatchObject({ time: '16:00' });

    const valueMismatch = initialDraft(koreanTime.id);
    valueMismatch.facts = [{ operation: 'create', targetFactKey: null, key: 'arrival_time', label: '도착 시간', value: '오후 5시', sourceId: koreanTime.id, quote: '첫날 도착 시간은 오후 4시입니다', semantic: { kind: 'date_time', time: '16:00' } }];
    valueMismatch.blocks = [];
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [koreanTime], draft: valueMismatch, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);

    const timezone = source('timezone', '팀 과제 마감은 10월 3일 23:59 KST입니다.');
    const timezoneDraft = initialDraft(timezone.id);
    timezoneDraft.facts = [{ operation: 'create', targetFactKey: null, key: 'deadline', label: '마감', value: '10월 3일 23:59', sourceId: timezone.id, quote: '팀 과제 마감은 10월 3일 23:59 KST입니다', semantic: { kind: 'date_time', date: '10-03', time: '23:59', timezone: 'Asia/Seoul' } }];
    timezoneDraft.blocks = [];
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [timezone], draft: timezoneDraft, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);

    const singleDeadline = source('single-deadline', '팀 과제는 10월 3일까지 제출합니다.');
    const singleDeadlineDraft = initialDraft(singleDeadline.id);
    singleDeadlineDraft.facts = [{ operation: 'create', targetFactKey: null, key: 'deadline', label: '마감', value: '10월 3일까지', sourceId: singleDeadline.id, quote: '팀 과제는 10월 3일까지 제출합니다', semantic: { kind: 'date_time', date: '10-03' } }];
    singleDeadlineDraft.blocks = [];
    expect(buildChangeSet({ snapshot: emptySnapshot(), sources: [singleDeadline], draft: singleDeadlineDraft, baseRevision: 0, baseSourceRevision: 1 }).next.facts[0]?.semantic).toMatchObject({ date: '10-03' });

    const dateRange = source('date-range', '작업 기간은 10월 3일부터 10월 5일까지입니다.');
    const dateRangeDraft = initialDraft(dateRange.id);
    dateRangeDraft.facts = [{ operation: 'create', targetFactKey: null, key: 'period', label: '기간', value: '10월 3일부터 10월 5일까지', sourceId: dateRange.id, quote: '작업 기간은 10월 3일부터 10월 5일까지입니다', semantic: { kind: 'date_time', date: '10-03' } }];
    dateRangeDraft.blocks = [];
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [dateRange], draft: dateRangeDraft, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);

    const timeRange = source('time-range', '회의는 14:00부터 15:00까지입니다.');
    const timeRangeDraft = initialDraft(timeRange.id);
    timeRangeDraft.facts = [{ operation: 'create', targetFactKey: null, key: 'meeting', label: '회의', value: '14:00부터 15:00까지', sourceId: timeRange.id, quote: '회의는 14:00부터 15:00까지입니다', semantic: { kind: 'date_time', time: '14:00' } }];
    timeRangeDraft.blocks = [];
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [timeRange], draft: timeRangeDraft, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);
  });

  it('treats semantic metadata changes as source-governed updates and refuses erasure', () => {
    const { base, snapshot } = buildInitial();
    const erasureSource = source('semantic-erasure', '참석자는 4명입니다.', 'correction', base.id);
    const erasure = initialDraft(erasureSource.id);
    erasure.facts = [{ operation: 'update', targetFactKey: 'participants', key: 'participants', label: '참석자 수', value: 4, sourceId: erasureSource.id, quote: '참석자는 4명입니다', semantic: null }];
    erasure.blocks = [];
    expect(() => buildChangeSet({ snapshot, sources: [base, erasureSource], draft: erasure, baseRevision: 1, baseSourceRevision: 2 })).toThrow(DomainError);

    const addition = source('semantic-addition', '팀 과제 마감은 10월 3일 23:59입니다.', 'addition', null);
    const sameValueChangedSemantic = initialDraft(addition.id);
    sameValueChangedSemantic.facts = [{ operation: 'update', targetFactKey: 'assignment_deadline', key: 'assignment_deadline', label: '과제 마감', value: '2026년 10월 3일 23:59', sourceId: addition.id, quote: '팀 과제 마감은 2026년 10월 3일 23:59입니다', semantic: { kind: 'date_time', date: '2026-10-03', time: '23:59' } }];
    sameValueChangedSemantic.blocks = [];
    const additionWithYear = { ...addition, text: '팀 과제 마감은 2026년 10월 3일 23:59입니다.' };
    const changeSet = buildChangeSet({ snapshot, sources: [base, additionWithYear], draft: sameValueChangedSemantic, baseRevision: 1, baseSourceRevision: 2 });
    expect(changeSet.conflicts).toEqual([expect.objectContaining({ kind: 'source', factKey: 'assignment_deadline' })]);
    expect(fact(changeSet.next, 'assignment_deadline').semantic).toMatchObject({ date: '10-03', time: '23:59' });
  });

  it('preserves or applies semantic metadata when same-scalar source conflicts are resolved', () => {
    const { base, snapshot } = buildInitial();
    const addition = source('semantic-team-addition', '참석자는 4팀입니다.', 'addition', null);
    const draft = initialDraft(addition.id);
    draft.facts = [{ operation: 'update', targetFactKey: 'participants', key: 'participants', label: '참석자 수', value: 4, sourceId: addition.id, quote: '참석자는 4팀입니다', semantic: { kind: 'count', unit: 'team' } }];
    draft.blocks = [];

    const changeSet = buildChangeSet({ snapshot, sources: [base, addition], draft, baseRevision: 1, baseSourceRevision: 2 });
    const conflictId = changeSet.conflicts.find((conflict) => conflict.factKey === 'participants')?.id;
    expect(conflictId).toBeTruthy();

    const keepUser = resolveChangeSet(changeSet, snapshot, [{ conflictId: conflictId!, choice: 'keep_user' }]);
    expect(fact(keepUser, 'participants').semantic).toMatchObject({ kind: 'count', unit: 'person' });
    expect(fact(keepUser, 'participants').value).toBe(4);

    const useSource = resolveChangeSet(changeSet, snapshot, [{ conflictId: conflictId!, choice: 'use_source' }]);
    expect(fact(useSource, 'participants').semantic).toMatchObject({ kind: 'count', unit: 'team' });
    expect(fact(useSource, 'participants').value).toBe(4);
  });

  it('allows same-source same-value semantic enrichment for legacy facts without state churn', () => {
    const legacy = source('legacy', '참석자는 4명입니다. 공동 고정비는 총 900000원입니다.');
    const legacySnapshot = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [legacy],
      draft: {
        summary: 'legacy initial',
        questions: [],
        facts: [
          { key: 'participants', label: '참석자 수', value: 4, sourceId: legacy.id, quote: '참석자는 4명입니다' },
          { key: 'fixed_total_cost', label: '공동 고정비 총액', value: 900000, sourceId: legacy.id, quote: '공동 고정비는 총 900000원입니다' },
        ],
        blocks: [],
        removedItems: [],
      },
      baseRevision: 0,
      baseSourceRevision: 1,
    }).next;
    const enrich = initialDraft(legacy.id);
    enrich.facts = [
      { operation: 'update', targetFactKey: 'participants', key: 'participants', label: '참석자 수', value: 4, sourceId: legacy.id, quote: '참석자는 4명입니다', semantic: { kind: 'count', unit: 'person' } },
      { operation: 'update', targetFactKey: 'fixed_total_cost', key: 'fixed_total_cost', label: '공동 고정비 총액', value: 900000, sourceId: legacy.id, quote: '공동 고정비는 총 900000원입니다', semantic: { kind: 'money', unit: 'KRW' } },
    ];
    enrich.blocks = [];

    const changeSet = buildChangeSet({ snapshot: legacySnapshot, sources: [legacy], draft: enrich, baseRevision: 1, baseSourceRevision: 1 });
    expect(changeSet.changes).toHaveLength(0);
    expect(fact(changeSet.next, 'participants').semantic).toMatchObject({ kind: 'count', unit: 'person' });

    const wrongUnit = structuredClone(enrich);
    wrongUnit.facts[0]!.semantic = { kind: 'count', unit: 'team' };
    expect(() => buildChangeSet({ snapshot: legacySnapshot, sources: [legacy], draft: wrongUnit, baseRevision: 1, baseSourceRevision: 1 })).toThrow(DomainError);
  });

  it('requires exact v2 operation targets for updates, creates and removals', () => {
    const { base, snapshot } = buildInitial();
    const correction = source('correction', '참석자는 3명입니다. 공동 고정비는 총 90만 원입니다.', 'correction', base.id);
    const update = initialDraft(correction.id);
    update.facts = [
      { operation: 'update', targetFactKey: 'participants', key: 'participants', label: '참석자 수', value: 3, sourceId: correction.id, quote: '참석자는 3명입니다', semantic: { kind: 'count', unit: 'person' } },
      { operation: 'update', targetFactKey: 'fixed_total_cost', key: 'fixed_total_cost', label: '공동 고정비 총액', value: 900000, sourceId: correction.id, quote: '공동 고정비는 총 90만 원입니다', semantic: { kind: 'money', unit: 'KRW' } },
    ];
    update.blocks = [{
      key: 'travel_cost',
      type: 'cost',
      title: '비용',
      items: [{ operation: 'update', targetItemId: 'item:travel_cost:fixed_cost_share', key: 'fixed_cost_share', label: '인당 고정비', value: '300000', factKeys: ['fixed_total_cost', 'participants'], valueFactKey: 'fixed_total_cost', calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participants' } }],
    }];
    expect(buildChangeSet({ snapshot, sources: [base, correction], draft: update, baseRevision: 1, baseSourceRevision: 2 }).next.blocks[0]?.items[0]?.value).toBe('300000');

    const wrongTarget = structuredClone(update);
    wrongTarget.facts[0]!.targetFactKey = 'fixed_total_cost';
    expect(() => buildChangeSet({ snapshot, sources: [base, correction], draft: wrongTarget, baseRevision: 1, baseSourceRevision: 2 })).toThrow(DomainError);

    const duplicateItem = structuredClone(update);
    duplicateItem.blocks[0]!.items = [{ ...duplicateItem.blocks[0]!.items[0]!, operation: 'create', targetItemId: null, key: 'renamed_share' }];
    expect(() => buildChangeSet({ snapshot, sources: [base, correction], draft: duplicateItem, baseRevision: 1, baseSourceRevision: 2 })).toThrow(DomainError);

    const badRemoval = structuredClone(update);
    badRemoval.blocks = [];
    badRemoval.removedItems = [{ operation: 'remove', itemId: 'item:missing:item', sourceId: correction.id, quote: '참석자는 3명입니다' }];
    expect(() => buildChangeSet({ snapshot, sources: [base, correction], draft: badRemoval, baseRevision: 1, baseSourceRevision: 2 })).toThrow(DomainError);

    const duplicateRemoval = structuredClone(badRemoval);
    duplicateRemoval.removedItems = [
      { operation: 'remove', itemId: 'item:travel_cost:fixed_cost_share', sourceId: correction.id, quote: '참석자는 3명입니다' },
      { operation: 'remove', itemId: 'item:travel_cost:fixed_cost_share', sourceId: correction.id, quote: '참석자는 3명입니다' },
    ];
    expect(() => buildChangeSet({ snapshot, sources: [base, correction], draft: duplicateRemoval, baseRevision: 1, baseSourceRevision: 2 })).toThrow(DomainError);
  });

  it('rejects mixed typed and legacy calculation dependencies', () => {
    const base = source('mixed', '참석자는 4명입니다. 공동 고정비는 총 900000원입니다.');
    const draft = initialDraft(base.id);
    draft.facts = [
      { operation: 'create', targetFactKey: null, key: 'participants', label: '참석자 수', value: 4, sourceId: base.id, quote: '참석자는 4명입니다', semantic: null },
      { operation: 'create', targetFactKey: null, key: 'fixed_total_cost', label: '공동 고정비 총액', value: 900000, sourceId: base.id, quote: '공동 고정비는 총 900000원입니다', semantic: { kind: 'money', unit: 'KRW' } },
    ];

    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [base], draft, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);
  });

  it('supports household counts as strict cost-share denominators', () => {
    const base = source('household', '참여 가구 수는 5가구입니다. 공동 장보기 금액은 160000원입니다.');
    const draft = initialDraft(base.id);
    draft.facts = [
      { operation: 'create', targetFactKey: null, key: 'households', label: '참여 가구 수', value: 5, sourceId: base.id, quote: '참여 가구 수는 5가구입니다', semantic: { kind: 'count', unit: 'household' } },
      { operation: 'create', targetFactKey: null, key: 'market_total', label: '공동 장보기 금액', value: 160000, sourceId: base.id, quote: '공동 장보기 금액은 160000원입니다', semantic: { kind: 'money', unit: 'KRW' } },
    ];
    draft.blocks = [{
      key: 'market_cost',
      type: 'cost',
      title: '정산',
      items: [{
        operation: 'create',
        targetItemId: null,
        key: 'household_share',
        label: '가구별 분담금',
        value: '32000',
        factKeys: ['market_total', 'households'],
        valueFactKey: 'market_total',
        calculation: { kind: 'divide', totalFactKey: 'market_total', divisorFactKey: 'households' },
      }],
    }];

    expect(buildChangeSet({ snapshot: emptySnapshot(), sources: [base], draft, baseRevision: 0, baseSourceRevision: 1 }).next.blocks[0]?.items[0]?.value).toBe('32000');
  });

  it('preserves all-legacy numeric calculation behavior when neither operand has explicit semantics', () => {
    const legacy = source('legacy-unsupported-unit', '공동 총액은 160000원입니다. 분모 그룹 수는 4그룹입니다.');
    const draft = {
      summary: 'legacy unsupported unit',
      questions: [],
      facts: [
        { key: 'total', label: '공동 총액', value: 160000, sourceId: legacy.id, quote: '공동 총액은 160000원입니다' },
        { key: 'groups', label: '분모 그룹 수', value: 4, sourceId: legacy.id, quote: '분모 그룹 수는 4그룹입니다' },
      ],
      blocks: [{
        key: 'legacy_cost',
        type: 'cost' as const,
        title: '정산',
        items: [{ key: 'share', label: '그룹별 분담금', value: '40000', factKeys: ['total', 'groups'], valueFactKey: 'total', calculation: { kind: 'divide' as const, totalFactKey: 'total', divisorFactKey: 'groups' } }],
      }],
      removedItems: [],
    };

    expect(buildChangeSet({ snapshot: emptySnapshot(), sources: [legacy], draft, baseRevision: 0, baseSourceRevision: 1 }).next.blocks[0]?.items[0]?.value).toBe('40000');
  });

  it('uses deterministic evidence-only inference for unchanged legacy calculation operands without mutating facts', () => {
    const legacy = source('legacy-market', '참여 가구 수는 4가구입니다. 공동 장보기 금액은 160000원입니다.');
    const legacySnapshot = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [legacy],
      draft: {
        summary: 'legacy market',
        questions: [],
        facts: [
          { key: 'households', label: '참여 가구 수', value: 4, sourceId: legacy.id, quote: '참여 가구 수는 4가구입니다' },
          { key: 'market_total', label: '공동 장보기 금액', value: 160000, sourceId: legacy.id, quote: '공동 장보기 금액은 160000원입니다' },
        ],
        blocks: [{
          key: 'market_cost',
          type: 'cost',
          title: '정산',
          items: [{ key: 'household_share', label: '가구별 분담금', value: '40000', factKeys: ['market_total', 'households'], valueFactKey: 'market_total', calculation: { kind: 'divide', totalFactKey: 'market_total', divisorFactKey: 'households' } }],
        }],
        removedItems: [],
      },
      baseRevision: 0,
      baseSourceRevision: 1,
    }).next;
    const updateSource = source('legacy-market-update', '참여 가구 수는 5가구입니다.', 'correction', legacy.id);
    const update = initialDraft(updateSource.id);
    update.facts = [{ operation: 'update', targetFactKey: 'households', key: 'households', label: '참여 가구 수', value: 5, sourceId: updateSource.id, quote: '참여 가구 수는 5가구입니다', semantic: { kind: 'count', unit: 'household' } }];
    update.blocks = [{
      key: 'market_cost',
      type: 'cost',
      title: '정산',
      items: [{
        operation: 'update',
        targetItemId: 'item:market_cost:household_share',
        key: 'household_share',
        label: '가구별 분담금',
        value: '32000',
        factKeys: ['market_total', 'households'],
        valueFactKey: 'market_total',
        calculation: { kind: 'divide', totalFactKey: 'market_total', divisorFactKey: 'households' },
      }],
    }];

    const changeSet = buildChangeSet({ snapshot: legacySnapshot, sources: [legacy, updateSource], draft: update, baseRevision: 1, baseSourceRevision: 2 });
    expect(changeSet.next.blocks[0]?.items[0]?.value).toBe('32000');
    expect(fact(changeSet.next, 'market_total').semantic).toBeUndefined();
    expect(fact(changeSet.next, 'households').semantic).toMatchObject({ kind: 'count', unit: 'household' });
  });

  it('rejects evidence-only calculation inference when unchanged legacy operands are unsafe', () => {
    for (const [id, quote, value] of [
      ['unsupported-unit', '참여 그룹 수는 4그룹입니다', 4],
      ['wrong-value', '참여 가구 수는 4가구입니다', 5],
      ['range', '참여 가구 수는 4~5가구입니다', 4],
      ['foreign-total', '공동 장보기 금액은 USD 160000입니다', 160000],
    ] as const) {
      const base = source(id, `${quote}. 공동 장보기 금액은 160000원입니다.`);
      const draft = initialDraft(base.id);
      draft.facts = [
        { operation: 'create', targetFactKey: null, key: 'total', label: '총액', value: 160000, sourceId: base.id, quote: id === 'foreign-total' ? quote : '공동 장보기 금액은 160000원입니다', semantic: id === 'foreign-total' ? null : { kind: 'money', unit: 'KRW' } },
        { operation: 'create', targetFactKey: null, key: 'count', label: '수량', value, sourceId: base.id, quote, semantic: id === 'unsupported-unit' || id === 'wrong-value' || id === 'range' ? null : { kind: 'count', unit: 'household' } },
      ];
      draft.blocks = [{
        key: 'bad_cost',
        type: 'cost',
        title: '정산',
        items: [{
          operation: 'create',
          targetItemId: null,
          key: 'share',
          label: '분담금',
          value: '40000',
          factKeys: ['total', 'count'],
          valueFactKey: 'total',
          calculation: { kind: 'divide', totalFactKey: 'total', divisorFactKey: 'count' },
        }],
      }];
      expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [base], draft, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);
    }
  });
});
