import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildChangeSet } from '../../src/core/engine';
import { emptySnapshot, snapshotSchema, sourceSchema, type ChangeSet, type LiveProposalDraftV2, type Snapshot } from '../../src/core/contracts';
import { evaluateInitialCreation, initialCreationCases } from '../../src/evaluation/initial-creation';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const testCase = initialCreationCases[0]!;
const source = testCase.sources[0]!;

type KeySet = {
  people: string;
  gather: string;
  total: string;
  scheduleItem: string;
  costItem: string;
};

const firstKeys: KeySet = {
  people: 'people',
  gather: 'gather_time',
  total: 'transport_total',
  scheduleItem: 'meet',
  costItem: 'share',
};

function draft(keys: KeySet, options: { extra?: boolean; scalarQuotes?: boolean; reorderedDateSemantic?: boolean } = {}): LiveProposalDraftV2 {
  return {
    schemaVersion: 2,
    summary: '최초 여행 자료를 구조화합니다.',
    questions: [],
    facts: [
      {
        operation: 'create',
        key: keys.people,
        targetFactKey: null,
        label: '참석자 수',
        value: 4,
        sourceId: source.id,
        quote: options.scalarQuotes ? '4명' : '참석자는 4명입니다.',
        semantic: { kind: 'count', unit: 'person' },
      },
      {
        operation: 'create',
        key: keys.gather,
        targetFactKey: null,
        label: '첫 일정 집합 시간',
        value: '2026-12-02 10:00',
        sourceId: source.id,
        quote: options.scalarQuotes ? '2026-12-02 10:00' : '첫 일정 집합 시간은 2026-12-02 10:00입니다.',
        semantic: options.reorderedDateSemantic
          ? { kind: 'date_time', time: '10:00', date: '2026-12-02' }
          : { kind: 'date_time', date: '2026-12-02', time: '10:00' },
      },
      {
        operation: 'create',
        key: keys.total,
        targetFactKey: null,
        label: '공동 교통비 총액',
        value: 480000,
        sourceId: source.id,
        quote: options.scalarQuotes ? '480000원' : '공동 교통비 총액은 480000원입니다.',
        semantic: { kind: 'money', unit: 'KRW' },
      },
      ...(options.extra ? [{
        operation: 'create' as const,
        key: 'unsupported_note',
        targetFactKey: null,
        label: '지원되지 않는 메모',
        value: '여수 워크숍 최초 안내 v2',
        sourceId: source.id,
        quote: '여수 워크숍 최초 안내 v2입니다.',
        semantic: null,
      }] : []),
    ],
    blocks: [
      {
        key: 'schedule',
        type: 'schedule',
        title: '일정',
        items: [{
          operation: 'create',
          targetItemId: null,
          key: keys.scheduleItem,
          label: '첫 일정 집합',
          value: '2026-12-02 10:00',
          factKeys: [keys.gather],
          valueFactKey: keys.gather,
          calculation: null,
        }],
      },
      {
        key: 'cost',
        type: 'cost',
        title: '비용',
        items: [{
          operation: 'create',
          targetItemId: null,
          key: keys.costItem,
          label: '1인 교통비',
          value: '0',
          factKeys: [keys.total, keys.people],
          valueFactKey: null,
          calculation: { kind: 'divide', totalFactKey: keys.total, divisorFactKey: keys.people },
        }],
      },
      ...(options.extra ? [{
        key: 'note',
        type: 'note' as const,
        title: '메모',
        items: [{
          operation: 'create' as const,
          targetItemId: null,
          key: 'unsupported',
          label: '지원되지 않는 항목',
          value: '출처에 있지만 기대하지 않은 항목',
          factKeys: ['unsupported_note'],
          valueFactKey: 'unsupported_note',
          calculation: null,
        }],
      }] : []),
    ],
    removedItems: [],
  };
}

function proposalFromDraft(input: LiveProposalDraftV2): ChangeSet {
  return buildChangeSet({
    snapshot: emptySnapshot(),
    sources: testCase.sources,
    draft: input,
    baseRevision: 0,
    baseSourceRevision: testCase.sources.length,
    id: 'changeset:initial-travel-semantic-v2:test',
    now: '2026-09-11T01:00:00.000Z',
  });
}

function validProposal(keys: KeySet = firstKeys): ChangeSet {
  return proposalFromDraft(draft(keys));
}

function expectIncorrect(proposal: ChangeSet, before: Snapshot = emptySnapshot()) {
  const metrics = evaluateInitialCreation(before, proposal, testCase.initialExpectation);
  expect(metrics.outcome).toBe('incorrect');
  return metrics;
}

describe('initial creation evaluation', () => {
  it('exports a versioned initial creation case with valid source records', () => {
    expect(initialCreationCases.map((candidate) => candidate.id)).toEqual(['initial-travel-semantic-v2']);
    snapshotSchema.parse(testCase.snapshot);
    sourceSchema.parse(source);
    expect(source.hash).toBe(sha256(source.text));
    expect(testCase.snapshot).toEqual(emptySnapshot());
    expect(testCase.initialExpectation.facts).toHaveLength(3);
    expect(testCase.initialExpectation.scheduleItems).toHaveLength(1);
    expect(testCase.initialExpectation.derivedCostItems).toHaveLength(1);
  });

  it('passes two valid proposals that use different fact and item keys', () => {
    const alternativeKeys: KeySet = {
      people: 'traveler_count_v2',
      gather: 'meeting_time_v2',
      total: 'transport_budget_v2',
      scheduleItem: 'arrival_meeting_v2',
      costItem: 'transport_share_v2',
    };

    for (const proposal of [validProposal(firstKeys), validProposal(alternativeKeys)]) {
      expect(evaluateInitialCreation(emptySnapshot(), proposal, testCase.initialExpectation)).toMatchObject({
        outcome: 'completed',
        factChecksPassed: 3,
        factChecksTotal: 3,
        itemChecksPassed: 2,
        itemChecksTotal: 2,
        unexpectedItemChanges: 0,
      });
    }
  });

  it('passes scalar evidence quotes and reordered semantic fields when the source and typed value match', () => {
    const proposal = proposalFromDraft(draft(firstKeys, { scalarQuotes: true, reorderedDateSemantic: true }));

    expect(evaluateInitialCreation(emptySnapshot(), proposal, testCase.initialExpectation)).toMatchObject({
      outcome: 'completed',
      factChecksPassed: 3,
      itemChecksPassed: 2,
      unexpectedItemChanges: 0,
    });
  });

  it('rejects duplicate fact matches because aliases would be ambiguous', () => {
    const proposal = validProposal();
    proposal.next.facts.push({
      ...proposal.next.facts.find((fact) => fact.key === firstKeys.people)!,
      id: 'fact:duplicate_people',
      key: 'duplicate_people',
    });

    const metrics = expectIncorrect(proposal);
    expect(metrics.factChecksPassed).toBe(2);
    expect(metrics.unexpectedItemChanges).toBe(3);
  });

  it('rejects wrong amount semantics even when the numeric value is right', () => {
    const proposal = validProposal();
    proposal.next.facts.find((fact) => fact.key === firstKeys.total)!.semantic = { kind: 'count', unit: 'person' };

    const metrics = expectIncorrect(proposal);
    expect(metrics.factChecksPassed).toBeLessThan(metrics.factChecksTotal);
    expect(metrics.itemChecksPassed).toBeLessThan(metrics.itemChecksTotal);
  });

  it('rejects facts with unsupported source evidence', () => {
    const proposal = validProposal();
    proposal.next.facts.find((fact) => fact.key === firstKeys.gather)!.evidence.sourceId = 'unsupported-source';

    const metrics = expectIncorrect(proposal);
    expect(metrics.factChecksPassed).toBe(2);
    expect(metrics.itemChecksPassed).toBe(1);
  });

  it('rejects a schedule item that does not reference the matched datetime fact', () => {
    const proposal = validProposal();
    const scheduleItem = proposal.next.blocks.find((block) => block.type === 'schedule')!.items[0]!;
    scheduleItem.valueFactKey = firstKeys.people;
    scheduleItem.factKeys = [firstKeys.people];

    const metrics = expectIncorrect(proposal);
    expect(metrics.factChecksPassed).toBe(3);
    expect(metrics.itemChecksPassed).toBe(1);
  });

  it('rejects a derived cost item with the wrong calculation relationship', () => {
    const proposal = validProposal();
    const costItem = proposal.next.blocks.find((block) => block.type === 'cost')!.items[0]!;
    costItem.calculation = { kind: 'divide', totalFactKey: firstKeys.people, divisorFactKey: firstKeys.total };

    const metrics = expectIncorrect(proposal);
    expect(metrics.factChecksPassed).toBeLessThan(metrics.factChecksTotal);
    expect(metrics.itemChecksPassed).toBeLessThan(metrics.itemChecksTotal);
  });

  it('rejects unsupported extra facts and items', () => {
    const proposal = proposalFromDraft(draft(firstKeys, { extra: true }));

    const metrics = expectIncorrect(proposal);
    expect(metrics.factChecksPassed).toBe(3);
    expect(metrics.itemChecksPassed).toBe(2);
    expect(metrics.unexpectedItemChanges).toBe(2);
  });

  it('rejects non-empty baselines because this evaluator is only for initial creation', () => {
    const before = structuredClone(validProposal().next);
    const metrics = expectIncorrect(validProposal(), before);

    expect(metrics.unexpectedItemChanges).toBe(1);
    expect(metrics.factChecksPassed).toBe(0);
  });
});
