import { describe, expect, it } from 'vitest';
import type { ProposalDraft, Snapshot, Source } from '../../src/core/contracts';
import { DomainError, emptySnapshot } from '../../src/core/contracts';
import { buildChangeSet, editItem, resolveChangeSet } from '../../src/core/engine';
import { getSample } from '../../src/core/samples';

const makeSource = (id: string, text: string, relation: Source['relation'] = 'initial', targetSourceId: string | null = null): Source => ({
  id,
  text,
  title: `합성 자료 ${id}`,
  relation,
  targetSourceId,
  hash: `hash-${id}`,
  createdAt: `2026-09-08T00:00:0${id.length}.000Z`,
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const item = (snapshot: Snapshot, id: string) => {
  const found = snapshot.blocks.flatMap((block) => block.items).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing item ${id}`);
  return found;
};

const fact = (snapshot: Snapshot, key: string) => {
  const found = snapshot.facts.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`missing fact ${key}`);
  return found;
};

const buildTravelInitial = () => {
  const sample = getSample('travel');
  const source = makeSource('travel-initial', sample.initialText);
  const changeSet = buildChangeSet({
    snapshot: emptySnapshot(),
    sources: [source],
    draft: sample.initialDraft(source.id),
    baseRevision: 0,
    baseSourceRevision: 1,
    id: 'cs-initial',
    now: '2026-09-08T00:00:00.000Z',
  });
  return { sample, source, snapshot: changeSet.next, changeSet };
};

describe('core change engine', () => {
  it('builds the travel initial workspace with evidence-backed deterministic cost calculation', () => {
    const { source, snapshot, changeSet } = buildTravelInitial();

    expect(changeSet.conflicts).toEqual([]);
    expect(fact(snapshot, 'participants').value).toBe(4);
    expect(item(snapshot, 'item:travel_cost:fixed_cost_share').value).toBe('225000');
    expect(item(snapshot, 'item:travel_schedule:arrival_day1').id).toBe('item:travel_schedule:arrival_day1');
    expect(source.text.slice(fact(snapshot, 'fixed_total_cost').evidence.start, fact(snapshot, 'fixed_total_cost').evidence.end)).toBe(
      fact(snapshot, 'fixed_total_cost').evidence.quote,
    );
  });

  it('preserves completed, edited and locked user state when a correction updates dependent facts', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    let userSnapshot = editItem(snapshot, {
      baseRevision: 1,
      requestId: uuid(1),
      itemId: 'item:travel_checklist:confirm_arrival',
      completed: true,
    });
    userSnapshot = editItem(userSnapshot, {
      baseRevision: 2,
      requestId: uuid(2),
      itemId: 'item:travel_note:share_message',
      value: '우리 일정은 제가 다시 정리해서 공유할게요.',
    });
    userSnapshot = editItem(userSnapshot, {
      baseRevision: 3,
      requestId: uuid(3),
      itemId: 'item:travel_schedule:dinner_day2',
      locked: true,
    });

    const updateSource = makeSource('travel-update', sample.updateText, 'correction', source.id);
    const changeSet = buildChangeSet({
      snapshot: userSnapshot,
      sources: [source, updateSource],
      draft: sample.updateDraft(updateSource.id),
      baseRevision: 4,
      baseSourceRevision: 2,
      id: 'cs-update',
      now: '2026-09-08T00:01:00.000Z',
    });

    expect(changeSet.conflicts).toEqual([]);
    expect(fact(changeSet.next, 'participants').value).toBe(3);
    expect(item(changeSet.next, 'item:travel_cost:fixed_cost_share').value).toBe('300000');
    expect(item(changeSet.next, 'item:travel_schedule:arrival_day1').value).toBe('오후 4시 도착');
    expect(item(changeSet.next, 'item:travel_checklist:confirm_arrival').completed).toBe(true);
    expect(item(changeSet.next, 'item:travel_note:share_message').value).toBe('우리 일정은 제가 다시 정리해서 공유할게요.');
    expect(item(changeSet.next, 'item:travel_note:share_message').stale).toBe(true);
    expect(item(changeSet.next, 'item:travel_schedule:dinner_day2').locked).toBe(true);
    expect(changeSet.changes.some((change) => change.status === 'preserved')).toBe(true);
  });

  it('blocks a source update that conflicts with a locked item until an explicit resolution is supplied', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const locked = editItem(snapshot, { baseRevision: 1, requestId: uuid(4), itemId: 'item:travel_schedule:dinner_day2', locked: true });
    const conflictSource = makeSource('travel-conflict', sample.conflictText, 'correction', source.id);
    const changeSet = buildChangeSet({
      snapshot: locked,
      sources: [source, conflictSource],
      draft: sample.conflictDraft(conflictSource.id),
      baseRevision: 2,
      baseSourceRevision: 2,
      id: 'cs-conflict',
      now: '2026-09-08T00:02:00.000Z',
    });

    expect(changeSet.conflicts).toHaveLength(1);
    expect(changeSet.conflicts[0]?.kind).toBe('locked');
    expect(item(changeSet.next, 'item:travel_schedule:dinner_day2').value).toBe('오후 7시 약속');
    expect(() => resolveChangeSet(changeSet, locked, [])).toThrow(DomainError);

    const keepUser = resolveChangeSet(changeSet, locked, [{ conflictId: changeSet.conflicts[0]!.id, choice: 'keep_user' }]);
    expect(item(keepUser, 'item:travel_schedule:dinner_day2').value).toBe('오후 7시 약속');
    expect(item(keepUser, 'item:travel_schedule:dinner_day2').stale).toBe(true);

    const useSource = resolveChangeSet(changeSet, locked, [{ conflictId: changeSet.conflicts[0]!.id, choice: 'use_source' }]);
    expect(item(useSource, 'item:travel_schedule:dinner_day2').value).toBe('오후 8시 약속');
    expect(item(useSource, 'item:travel_schedule:dinner_day2').locked).toBe(true);
    expect(item(useSource, 'item:travel_schedule:dinner_day2').stale).toBe(false);
  });

  it('does not recompute a locked calculated item before conflict resolution', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const lockedCost = editItem(snapshot, { baseRevision: 1, requestId: uuid(7), itemId: 'item:travel_cost:fixed_cost_share', locked: true });
    const updateSource = makeSource('travel-update', sample.updateText, 'correction', source.id);
    const changeSet = buildChangeSet({
      snapshot: lockedCost,
      sources: [source, updateSource],
      draft: sample.updateDraft(updateSource.id),
      baseRevision: 2,
      baseSourceRevision: 2,
    });

    expect(changeSet.conflicts.some((conflict) => conflict.kind === 'locked' && conflict.itemId === 'item:travel_cost:fixed_cost_share')).toBe(true);
    expect(item(changeSet.next, 'item:travel_cost:fixed_cost_share').value).toBe('225000');
    const applied = resolveChangeSet(changeSet, lockedCost, [
      { conflictId: changeSet.conflicts.find((conflict) => conflict.itemId === 'item:travel_cost:fixed_cost_share')!.id, choice: 'use_source' },
    ]);
    expect(item(applied, 'item:travel_cost:fixed_cost_share').value).toBe('300000');
  });

  it('does not duplicate stable items when the same correction is processed again', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const updateSource = makeSource('travel-update', sample.updateText, 'correction', source.id);
    const first = buildChangeSet({
      snapshot,
      sources: [source, updateSource],
      draft: sample.updateDraft(updateSource.id),
      baseRevision: 1,
      baseSourceRevision: 2,
    }).next;
    const second = buildChangeSet({
      snapshot: first,
      sources: [source, updateSource],
      draft: sample.updateDraft(updateSource.id),
      baseRevision: 2,
      baseSourceRevision: 2,
    }).next;

    const ids = second.blocks.flatMap((block) => block.items.map((candidate) => candidate.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 'item:travel_schedule:arrival_day1')).toHaveLength(1);
  });

  it('treats omitted blocks and items as preserved state, not implicit deletion', () => {
    const { source, snapshot } = buildTravelInitial();
    const partialDraft: ProposalDraft = {
      summary: '부분 변경',
      questions: [],
      facts: [{ key: 'arrival_time_day1', label: '첫날 도착 시간', value: '오전 10시', sourceId: source.id, quote: '첫날 도착 시간은 오전 10시입니다' }],
      blocks: [
        {
          key: 'travel_schedule',
          type: 'schedule',
          title: '일정',
          items: [{ key: 'arrival_day1', label: '첫날 도착', value: '오전 10시 도착', factKeys: ['arrival_time_day1'], valueFactKey: 'arrival_time_day1', calculation: null }],
        },
      ],
      removedItems: [],
    };
    const changeSet = buildChangeSet({ snapshot, sources: [source], draft: partialDraft, baseRevision: 1, baseSourceRevision: 1 });

    expect(item(changeSet.next, 'item:travel_schedule:dinner_day2').value).toBe('오후 7시 약속');
    expect(item(changeSet.next, 'item:travel_cost:fixed_cost_share').value).toBe('225000');
    expect(item(changeSet.next, 'item:travel_note:share_message').value).toContain('첫날 오전 10시');
  });

  it('marks omitted non-calculated dependent items stale and conflicts omitted locked items', () => {
    const { source, snapshot } = buildTravelInitial();
    const lockedSchedule = editItem(snapshot, { baseRevision: 1, requestId: uuid(8), itemId: 'item:travel_schedule:arrival_day1', locked: true });
    const correction = makeSource('arrival-correction', '합성 정정입니다. 첫날 도착 시간은 오후 4시로 늦어졌습니다.', 'correction', source.id);
    const factsOnly: ProposalDraft = {
      summary: '도착 시간만 정정',
      questions: [],
      facts: [{ key: 'arrival_time_day1', label: '첫날 도착 시간', value: '오후 4시', sourceId: correction.id, quote: '첫날 도착 시간은 오후 4시로 늦어졌습니다' }],
      blocks: [],
      removedItems: [],
    };
    const changeSet = buildChangeSet({ snapshot: lockedSchedule, sources: [source, correction], draft: factsOnly, baseRevision: 2, baseSourceRevision: 2 });

    expect(changeSet.conflicts.some((conflict) => conflict.kind === 'locked' && conflict.itemId === 'item:travel_schedule:arrival_day1')).toBe(true);
    expect(item(changeSet.next, 'item:travel_schedule:arrival_day1').value).toBe('오전 10시 도착');
    expect(item(changeSet.next, 'item:travel_note:share_message').stale).toBe(true);
    expect(changeSet.changes.some((change) => change.targetId === 'item:travel_note:share_message' && change.status === 'needs_review')).toBe(true);
  });

  it('uses the same engine for the syllabus deadline scenario and protects completed deletions', () => {
    const sample = getSample('syllabus');
    const initialSource = makeSource('syllabus-initial', sample.initialText);
    const initial = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [initialSource],
      draft: sample.initialDraft(initialSource.id),
      baseRevision: 0,
      baseSourceRevision: 1,
    }).next;

    const updateSource = makeSource('syllabus-update', sample.updateText, 'correction', initialSource.id);
    const updated = buildChangeSet({
      snapshot: initial,
      sources: [initialSource, updateSource],
      draft: sample.updateDraft(updateSource.id),
      baseRevision: 1,
      baseSourceRevision: 2,
    }).next;
    expect(item(updated, 'item:assignment_schedule:deadline').value).toBe('10월 10일 23:59');

    const completed = editItem(updated, {
      baseRevision: 2,
      requestId: uuid(5),
      itemId: 'item:assignment_checklist:repro_script',
      completed: true,
    });
    const conflictSource = makeSource('syllabus-conflict', sample.conflictText, 'correction', initialSource.id);
    const deletion = buildChangeSet({
      snapshot: completed,
      sources: [initialSource, updateSource, conflictSource],
      draft: sample.conflictDraft(conflictSource.id),
      baseRevision: 3,
      baseSourceRevision: 3,
    });

    expect(deletion.conflicts[0]?.kind).toBe('deletion');
    expect(item(deletion.next, 'item:assignment_checklist:repro_script').completed).toBe(true);
    const resolved = resolveChangeSet(deletion, completed, [{ conflictId: deletion.conflicts[0]!.id, choice: 'use_source' }]);
    expect(resolved.blocks.flatMap((block) => block.items).some((candidate) => candidate.id === 'item:assignment_checklist:repro_script')).toBe(false);
  });

  it('rejects a draft that updates and removes the same item in one bundle', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const draft = sample.updateDraft(source.id);
    draft.removedItems.push({ itemId: 'item:travel_schedule:arrival_day1', sourceId: source.id, quote: '첫날 도착 시간은 오전 10시입니다' });
    expect(() => buildChangeSet({ snapshot, sources: [source], draft, baseRevision: 1, baseSourceRevision: 1 })).toThrow(DomainError);
  });

  it('rejects nonexistent evidence, unknown fact references, impossible division and block type mutation', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    expect(() =>
      buildChangeSet({
        snapshot: emptySnapshot(),
        sources: [source],
        draft: { ...sample.initialDraft(source.id), facts: [{ key: 'bad', label: 'Bad', value: 'x', sourceId: source.id, quote: '없는 문장' }] },
        baseRevision: 0,
        baseSourceRevision: 1,
      }),
    ).toThrow(DomainError);

    const badReference = structuredClone(sample.updateDraft(source.id));
    badReference.blocks[0]!.items[0]!.factKeys = ['missing_fact'];
    expect(() =>
      buildChangeSet({ snapshot, sources: [source], draft: badReference, baseRevision: 1, baseSourceRevision: 1 }),
    ).toThrow(DomainError);

    const impossibleDivision: ProposalDraft = {
      summary: 'bad calc',
      questions: [],
      facts: [{ key: 'zero_people', label: 'Zero people', value: 0, sourceId: source.id, quote: '참석자는 4명입니다' }],
      blocks: [
        {
          key: 'bad_cost',
          type: 'cost',
          title: 'Bad',
          items: [
            {
              key: 'divide_zero',
              label: 'Divide zero',
              value: '0',
              factKeys: ['fixed_total_cost', 'zero_people'],
              valueFactKey: 'fixed_total_cost',
              calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'zero_people' },
            },
          ],
        },
      ],
      removedItems: [],
    };
    expect(() => buildChangeSet({ snapshot, sources: [source], draft: impossibleDivision, baseRevision: 1, baseSourceRevision: 1 })).toThrow(DomainError);

    const typeMutation = structuredClone(sample.updateDraft(source.id));
    typeMutation.blocks[0]!.type = 'note';
    expect(() => buildChangeSet({ snapshot, sources: [source], draft: typeMutation, baseRevision: 1, baseSourceRevision: 1 })).toThrow(DomainError);
  });

  it('rejects duplicate draft fact, block, and item keys before applying a proposal', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const duplicateFacts = structuredClone(sample.initialDraft(source.id));
    duplicateFacts.facts.push({ ...duplicateFacts.facts[0]!, label: '중복 참석자 수' });
    expect(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [source], draft: duplicateFacts, baseRevision: 0, baseSourceRevision: 1 })).toThrow(DomainError);

    const duplicateBlocks = structuredClone(sample.updateDraft(source.id));
    duplicateBlocks.blocks.push({ ...duplicateBlocks.blocks[0]!, title: '중복 일정' });
    expect(() => buildChangeSet({ snapshot, sources: [source], draft: duplicateBlocks, baseRevision: 1, baseSourceRevision: 1 })).toThrow(DomainError);

    const duplicateItems = structuredClone(sample.updateDraft(source.id));
    duplicateItems.blocks[0]!.items.push({ ...duplicateItems.blocks[0]!.items[0]!, label: '중복 도착' });
    expect(() => buildChangeSet({ snapshot, sources: [source], draft: duplicateItems, baseRevision: 1, baseSourceRevision: 1 })).toThrow(DomainError);
  });

  it('rejects malformed existing snapshots and inconsistent value references', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const malformedSnapshot = structuredClone(snapshot);
    malformedSnapshot.blocks[0]!.items[0]!.id = 'item:other:block';
    expect(() =>
      buildChangeSet({
        snapshot: malformedSnapshot,
        sources: [source],
        draft: sample.updateDraft(source.id),
        baseRevision: 1,
        baseSourceRevision: 1,
      }),
    ).toThrow(DomainError);

    const missingValueFactDependency = structuredClone(sample.updateDraft(source.id));
    missingValueFactDependency.blocks[0]!.items[0]!.factKeys = [];
    expect(() =>
      buildChangeSet({
        snapshot,
        sources: [source],
        draft: missingValueFactDependency,
        baseRevision: 1,
        baseSourceRevision: 1,
      }),
    ).toThrow(DomainError);

    const missingCalculationDependency = structuredClone(sample.updateDraft(source.id));
    missingCalculationDependency.blocks[1]!.items[0]!.factKeys = ['fixed_total_cost'];
    expect(() =>
      buildChangeSet({
        snapshot,
        sources: [source],
        draft: missingCalculationDependency,
        baseRevision: 1,
        baseSourceRevision: 1,
      }),
    ).toThrow(DomainError);
  });

  it('rejects numeric facts when a clear evidence quote contains a different number', () => {
    const source = makeSource('numeric-source', '참석자는 4명입니다. 공동 고정비는 900,000원입니다.');
    expect(() =>
      buildChangeSet({
        snapshot: emptySnapshot(),
        sources: [source],
        draft: {
          summary: '숫자 근거 불일치',
          questions: [],
          facts: [{ key: 'participants', label: '참석자 수', value: 3, sourceId: source.id, quote: '참석자는 4명입니다' }],
          blocks: [],
          removedItems: [],
        },
        baseRevision: 0,
        baseSourceRevision: 1,
      }),
    ).toThrow(DomainError);
  });

  it('rejects strict numeric string facts when a clear evidence quote contains a different number', () => {
    const source = makeSource('numeric-string-source', '참석자는 4명입니다.');
    expect(() =>
      buildChangeSet({
        snapshot: emptySnapshot(),
        sources: [source],
        draft: {
          summary: '숫자 문자열 근거 불일치',
          questions: [],
          facts: [{ key: 'participants', label: '참석자 수', value: '3', sourceId: source.id, quote: '참석자는 4명입니다' }],
          blocks: [],
          removedItems: [],
        },
        baseRevision: 0,
        baseSourceRevision: 1,
      }),
    ).toThrow(DomainError);
  });

  it('accepts supported numeric evidence formatting such as comma-separated currency', () => {
    const source = makeSource('currency-source', '공동 고정비는 900,000원입니다.');
    const changeSet = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [source],
      draft: {
        summary: '통화 형식 정규화',
        questions: [],
        facts: [{ key: 'fixed_total_cost', label: '공동 고정비 총액', value: 900000, sourceId: source.id, quote: '공동 고정비는 900,000원입니다' }],
        blocks: [],
        removedItems: [],
      },
      baseRevision: 0,
      baseSourceRevision: 1,
    });

    expect(fact(changeSet.next, 'fixed_total_cost').value).toBe(900000);
  });

  it('does not treat unrelated Korean syllables as numeric ambiguity markers', () => {
    const source = makeSource('central-budget-source', '중앙 예산 900,000원입니다.');
    const changeSet = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [source],
      draft: {
        summary: '중앙 예산',
        questions: [],
        facts: [{ key: 'central_budget', label: '중앙 예산', value: 900000, sourceId: source.id, quote: '중앙 예산 900,000원입니다' }],
        blocks: [],
        removedItems: [],
      },
      baseRevision: 0,
      baseSourceRevision: 1,
    });

    expect(fact(changeSet.next, 'central_budget').value).toBe(900000);
  });

  it('rejects ambiguous numeric evidence instead of treating simple number presence as proof', () => {
    const source = makeSource('ambiguous-number', '4명 중 한 명이 빠져 참석자는 3명입니다.');
    expect(() =>
      buildChangeSet({
        snapshot: emptySnapshot(),
        sources: [source],
        draft: {
          summary: '복합 숫자 근거',
          questions: [],
          facts: [{ key: 'participants', label: '참석자 수', value: 3, sourceId: source.id, quote: '4명 중 한 명이 빠져 참석자는 3명입니다' }],
          blocks: [],
          removedItems: [],
        },
        baseRevision: 0,
        baseSourceRevision: 1,
      }),
    ).toThrow(DomainError);
  });

  it('rejects targeted correction facts that rename an existing fact identity with the same label', () => {
    const { source, snapshot } = buildTravelInitial();
    const correction = makeSource('renamed-participants', '합성 정정입니다. 참석자는 3명으로 변경됐습니다.', 'correction', source.id);

    expect(() =>
      buildChangeSet({
        snapshot,
        sources: [source, correction],
        draft: {
          summary: '기존 참석자 수를 다른 key로 정정하려는 제안',
          questions: [],
          facts: [{ key: 'participants_new', label: '참석자 수', value: 3, sourceId: correction.id, quote: '참석자는 3명으로 변경됐습니다' }],
          blocks: [],
          removedItems: [],
        },
        baseRevision: 1,
        baseSourceRevision: 2,
      }),
    ).toThrow(DomainError);
  });

  it('does not auto-merge unrelated same-label facts from ordinary additions', () => {
    const { source, snapshot } = buildTravelInitial();
    const addition = makeSource('other-day-addition', '셋째 날 참석자 수는 2명입니다.', 'addition', null);
    const changeSet = buildChangeSet({
      snapshot,
      sources: [source, addition],
      draft: {
        summary: '다른 엔티티의 같은 label 사실 추가',
        questions: [],
        facts: [{ key: 'participants_day3', label: '참석자 수', value: 2, sourceId: addition.id, quote: '셋째 날 참석자 수는 2명입니다' }],
        blocks: [],
        removedItems: [],
      },
      baseRevision: 1,
      baseSourceRevision: 2,
    });

    expect(fact(changeSet.next, 'participants').value).toBe(4);
    expect(fact(changeSet.next, 'participants_day3').value).toBe(2);
  });

  it('surfaces ambiguous contradictory additions as source conflicts instead of silently overwriting', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const addition = makeSource('late-addition', sample.updateText, 'addition', null);
    const changeSet = buildChangeSet({
      snapshot,
      sources: [source, addition],
      draft: sample.updateDraft(addition.id),
      baseRevision: 1,
      baseSourceRevision: 2,
    });

    expect(changeSet.conflicts.some((conflict) => conflict.kind === 'source' && conflict.factKey === 'participants')).toBe(true);
    expect(fact(changeSet.next, 'participants').value).toBe(4);
  });

  it('does not allow an addition with targetSourceId to overwrite an existing fact', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const addition = makeSource('targeted-addition', sample.updateText, 'addition', source.id);
    const changeSet = buildChangeSet({
      snapshot,
      sources: [source, addition],
      draft: sample.updateDraft(addition.id),
      baseRevision: 1,
      baseSourceRevision: 2,
    });

    expect(changeSet.conflicts.some((conflict) => conflict.kind === 'source' && conflict.factKey === 'participants')).toBe(true);
    expect(fact(changeSet.next, 'participants').value).toBe(4);
    expect(item(changeSet.next, 'item:travel_cost:fixed_cost_share').value).toBe('225000');
  });

  it('requires corrections and replacements to target the source behind the fact they change', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const wrongTarget = makeSource('wrong-target', sample.updateText, 'correction', 'missing-source');
    expect(() =>
      buildChangeSet({
        snapshot,
        sources: [source, wrongTarget],
        draft: sample.updateDraft(wrongTarget.id),
        baseRevision: 1,
        baseSourceRevision: 2,
      }),
    ).toThrow(DomainError);

    const untargeted = makeSource('untargeted-replacement', sample.updateText, 'replacement', null);
    expect(() =>
      buildChangeSet({
        snapshot,
        sources: [source, untargeted],
        draft: sample.updateDraft(untargeted.id),
        baseRevision: 1,
        baseSourceRevision: 2,
      }),
    ).toThrow(DomainError);
  });

  it('recomputes unprotected dependent items when a source conflict is resolved with use_source', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const addition = makeSource('targeted-addition', sample.updateText, 'addition', source.id);
    const changeSet = buildChangeSet({
      snapshot,
      sources: [source, addition],
      draft: sample.updateDraft(addition.id),
      baseRevision: 1,
      baseSourceRevision: 2,
    });
    const resolved = resolveChangeSet(
      changeSet,
      snapshot,
      changeSet.conflicts.map((conflict) => ({ conflictId: conflict.id, choice: 'use_source' })),
    );

    expect(fact(resolved, 'participants').value).toBe(3);
    expect(fact(resolved, 'arrival_time_day1').value).toBe('오후 4시');
    expect(item(resolved, 'item:travel_cost:fixed_cost_share').value).toBe('300000');
    expect(item(resolved, 'item:travel_schedule:arrival_day1').value).toBe('오후 4시 도착');
  });

  it('keeps facts and dependent items consistent when a source conflict is resolved with keep_user', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const addition = makeSource('targeted-addition', sample.updateText, 'addition', source.id);
    const changeSet = buildChangeSet({
      snapshot,
      sources: [source, addition],
      draft: sample.updateDraft(addition.id),
      baseRevision: 1,
      baseSourceRevision: 2,
    });
    expect(item(changeSet.next, 'item:travel_schedule:arrival_day1').value).toBe('오전 10시 도착');

    const resolved = resolveChangeSet(
      changeSet,
      snapshot,
      changeSet.conflicts.map((conflict) => ({ conflictId: conflict.id, choice: 'keep_user' })),
    );

    expect(fact(resolved, 'participants').value).toBe(4);
    expect(fact(resolved, 'arrival_time_day1').value).toBe('오전 10시');
    expect(item(resolved, 'item:travel_cost:fixed_cost_share').value).toBe('225000');
    expect(item(resolved, 'item:travel_schedule:arrival_day1').value).toBe('오전 10시 도착');
  });

  it('marks free-text items stale when source conflict choices are mixed', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const addition = makeSource('targeted-addition', sample.updateText, 'addition', source.id);
    const changeSet = buildChangeSet({
      snapshot,
      sources: [source, addition],
      draft: sample.updateDraft(addition.id),
      baseRevision: 1,
      baseSourceRevision: 2,
    });
    const resolved = resolveChangeSet(changeSet, snapshot, [
      { conflictId: changeSet.conflicts.find((conflict) => conflict.factKey === 'participants')!.id, choice: 'use_source' },
      { conflictId: changeSet.conflicts.find((conflict) => conflict.factKey === 'arrival_time_day1')!.id, choice: 'keep_user' },
    ]);

    expect(fact(resolved, 'participants').value).toBe(3);
    expect(fact(resolved, 'arrival_time_day1').value).toBe('오전 10시');
    expect(item(resolved, 'item:travel_cost:fixed_cost_share').value).toBe('300000');
    expect(item(resolved, 'item:travel_note:share_message').value).toContain('첫날 오전 10시');
    expect(item(resolved, 'item:travel_note:share_message').stale).toBe(true);
  });

  it('keeps edited dependent text stale when source conflicts are resolved with use_source', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const edited = editItem(snapshot, {
      baseRevision: 1,
      requestId: uuid(9),
      itemId: 'item:travel_note:share_message',
      value: '직접 다듬은 안내 문장',
    });
    const addition = makeSource('targeted-addition', sample.updateText, 'addition', source.id);
    const changeSet = buildChangeSet({
      snapshot: edited,
      sources: [source, addition],
      draft: sample.updateDraft(addition.id),
      baseRevision: 2,
      baseSourceRevision: 2,
    });
    const resolved = resolveChangeSet(
      changeSet,
      edited,
      changeSet.conflicts.map((conflict) => ({ conflictId: conflict.id, choice: 'use_source' })),
    );

    expect(item(resolved, 'item:travel_note:share_message').value).toBe('직접 다듬은 안내 문장');
    expect(item(resolved, 'item:travel_note:share_message').edited).toBe(true);
    expect(item(resolved, 'item:travel_note:share_message').stale).toBe(true);
  });

  it('keeps locked dependent items stale when source conflicts are resolved with use_source', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const locked = editItem(snapshot, { baseRevision: 1, requestId: uuid(10), itemId: 'item:travel_schedule:arrival_day1', locked: true });
    const addition = makeSource('targeted-addition', sample.updateText, 'addition', source.id);
    const changeSet = buildChangeSet({
      snapshot: locked,
      sources: [source, addition],
      draft: sample.updateDraft(addition.id),
      baseRevision: 2,
      baseSourceRevision: 2,
    });
    const resolved = resolveChangeSet(
      changeSet,
      locked,
      changeSet.conflicts.map((conflict) => ({ conflictId: conflict.id, choice: 'use_source' })),
    );

    expect(fact(resolved, 'arrival_time_day1').value).toBe('오후 4시');
    expect(item(resolved, 'item:travel_schedule:arrival_day1').value).toBe('오전 10시 도착');
    expect(item(resolved, 'item:travel_schedule:arrival_day1').locked).toBe(true);
    expect(item(resolved, 'item:travel_schedule:arrival_day1').stale).toBe(true);
  });

  it('does not apply a change set while model questions remain unanswered', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const updateSource = makeSource('travel-update', sample.updateText, 'correction', source.id);
    const draft = sample.updateDraft(updateSource.id);
    draft.questions = ['참석자 3명 변경을 확정할까요?'];
    const changeSet = buildChangeSet({
      snapshot,
      sources: [source, updateSource],
      draft,
      baseRevision: 1,
      baseSourceRevision: 2,
    });

    expect(() => resolveChangeSet(changeSet, snapshot, [])).toThrow(DomainError);
  });

  it('keeps stable ids across label changes and marks edited dependent text stale', () => {
    const { sample, source, snapshot } = buildTravelInitial();
    const edited = editItem(snapshot, {
      baseRevision: 1,
      requestId: uuid(6),
      itemId: 'item:travel_note:share_message',
      value: '직접 다듬은 안내 문장',
    });
    const updateSource = makeSource('travel-update', sample.updateText, 'correction', source.id);
    const draft = sample.updateDraft(updateSource.id);
    draft.blocks.find((block) => block.key === 'travel_note')!.items[0]!.label = '카톡 공유 문장';
    const changeSet = buildChangeSet({
      snapshot: edited,
      sources: [source, updateSource],
      draft,
      baseRevision: 2,
      baseSourceRevision: 2,
    });

    const note = item(changeSet.next, 'item:travel_note:share_message');
    expect(note.id).toBe('item:travel_note:share_message');
    expect(note.label).toBe('공유 문장');
    expect(note.value).toBe('직접 다듬은 안내 문장');
    expect(note.stale).toBe(true);
  });
});
