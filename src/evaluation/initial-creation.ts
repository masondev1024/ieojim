import { createHash } from 'node:crypto';
import { resolveChangeSet } from '../core/engine';
import {
  emptySnapshot,
  snapshotSchema,
  sourceSchema,
  type BlockItem,
  type ChangeSet,
  type Fact,
  type FactSemantic,
  type Snapshot,
  type Source,
} from '../core/contracts';
import type { EvaluationCase } from './case';
import type { EvaluationMetrics } from './metrics';

type FactAlias = string;

export type InitialCreationExpectedFact = {
  alias: FactAlias;
  value: string | number;
  semantic: FactSemantic;
  evidence: {
    sourceId: string;
    quote: string;
  };
};

export type InitialCreationExpectedScheduleItem = {
  alias: string;
  value: string;
  dateTimeFactAlias: FactAlias;
};

export type InitialCreationExpectedDerivedCostItem = {
  alias: string;
  value: string;
  moneyFactAlias: FactAlias;
  countFactAlias: FactAlias;
};

export type InitialCreationExpectation = {
  facts: InitialCreationExpectedFact[];
  scheduleItems: InitialCreationExpectedScheduleItem[];
  derivedCostItems: InitialCreationExpectedDerivedCostItem[];
  allowOnlyExpectedFacts?: boolean;
  allowOnlyExpectedItems?: boolean;
};

type SourceInput = {
  id: string;
  title: string;
  text: string;
  relation?: Source['relation'];
  targetSourceId?: string | null;
  createdAt?: string;
};

const CREATED_AT = '2026-09-11T00:00:00.000Z';

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

const source = (input: SourceInput): Source => sourceSchema.parse({
  id: input.id,
  title: input.title,
  text: input.text,
  relation: input.relation ?? 'initial',
  targetSourceId: input.targetSourceId ?? null,
  hash: hashText(input.text),
  createdAt: input.createdAt ?? CREATED_AT,
});

function sameSemantic(left: FactSemantic | null | undefined, right: FactSemantic): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === 'money' && right.kind === 'money') return left.unit === right.unit;
  if (left.kind === 'count' && right.kind === 'count') return left.unit === right.unit;
  if (left.kind === 'date_time' && right.kind === 'date_time') {
    return left.date === right.date && left.time === right.time && left.timezone === right.timezone;
  }
  return false;
}

const sameValue = (left: string | number, right: string | number): boolean => String(left) === String(right);

const supportedQuote = (actual: string, expected: string): boolean =>
  actual.length > 0 && expected.length > 0 && (actual.includes(expected) || expected.includes(actual));

const allItems = (snapshot: Snapshot): BlockItem[] => snapshot.blocks.flatMap((block) => block.items);

const hasEmptyBaseline = (snapshot: Snapshot): boolean => snapshot.facts.length === 0 && snapshot.blocks.length === 0;

function metrics(input: Partial<EvaluationMetrics> = {}): EvaluationMetrics {
  return {
    outcome: 'incorrect',
    factChecksPassed: 0,
    factChecksTotal: 0,
    itemChecksPassed: 0,
    itemChecksTotal: 0,
    protectedStateLosses: 0,
    unexpectedItemChanges: 0,
    conflicts: 0,
    questions: 0,
    snapshotChanged: false,
    ...input,
  };
}

function matchingFacts(snapshot: Snapshot, expected: InitialCreationExpectedFact): Fact[] {
  return snapshot.facts.filter((fact) =>
    sameValue(fact.value, expected.value) &&
    sameSemantic(fact.semantic, expected.semantic) &&
    fact.evidence.sourceId === expected.evidence.sourceId &&
    supportedQuote(fact.evidence.quote, expected.evidence.quote));
}

function countUnsupportedFacts(snapshot: Snapshot, expectation: InitialCreationExpectation, factsByAlias: Map<FactAlias, Fact>): number {
  if (expectation.allowOnlyExpectedFacts === false) return 0;
  const supported = new Set(expectation.facts.flatMap((expected) => {
    const fact = factsByAlias.get(expected.alias);
    return fact ? [fact.id] : [];
  }));
  return snapshot.facts.filter((fact) => !supported.has(fact.id)).length;
}

function countUnsupportedItems(snapshot: Snapshot, matchedItemIds: Set<string>, expectation: InitialCreationExpectation): number {
  if (expectation.allowOnlyExpectedItems === false) return 0;
  return allItems(snapshot).filter((item) => !matchedItemIds.has(item.id)).length;
}

function matchScheduleItem(snapshot: Snapshot, expected: InitialCreationExpectedScheduleItem, factsByAlias: Map<FactAlias, Fact>): BlockItem[] {
  const dateTimeFact = factsByAlias.get(expected.dateTimeFactAlias);
  if (!dateTimeFact || dateTimeFact.semantic?.kind !== 'date_time') return [];
  return snapshot.blocks
    .filter((block) => block.type === 'schedule')
    .flatMap((block) => block.items)
    .filter((item) =>
      item.value === expected.value &&
      item.valueFactKey === dateTimeFact.key &&
      item.factKeys.includes(dateTimeFact.key) &&
      item.calculation === null);
}

function matchDerivedCostItem(snapshot: Snapshot, expected: InitialCreationExpectedDerivedCostItem, factsByAlias: Map<FactAlias, Fact>): BlockItem[] {
  const moneyFact = factsByAlias.get(expected.moneyFactAlias);
  const countFact = factsByAlias.get(expected.countFactAlias);
  if (!moneyFact || !countFact || moneyFact.semantic?.kind !== 'money' || countFact.semantic?.kind !== 'count') return [];
  return snapshot.blocks
    .filter((block) => block.type === 'cost')
    .flatMap((block) => block.items)
    .filter((item) =>
      item.value === expected.value &&
      item.calculation?.kind === 'divide' &&
      item.calculation.totalFactKey === moneyFact.key &&
      item.calculation.divisorFactKey === countFact.key &&
      item.factKeys.includes(moneyFact.key) &&
      item.factKeys.includes(countFact.key));
}

export function evaluateInitialCreation(
  before: Snapshot,
  proposal: ChangeSet,
  expected: InitialCreationExpectation,
): EvaluationMetrics {
  const baseTotals = {
    factChecksTotal: expected.facts.length,
    itemChecksTotal: expected.scheduleItems.length + expected.derivedCostItems.length,
    conflicts: proposal.conflicts.length,
    questions: proposal.questions.length,
  };
  const snapshotChanged = JSON.stringify(before) !== JSON.stringify(proposal.next);

  if (!hasEmptyBaseline(before)) {
    return metrics({ ...baseTotals, unexpectedItemChanges: 1, snapshotChanged });
  }
  if (proposal.questions.length > 0) {
    return metrics({ ...baseTotals, outcome: 'needs_input', snapshotChanged });
  }

  let after: Snapshot;
  try {
    after = resolveChangeSet(proposal, before, []);
  } catch {
    return metrics({ ...baseTotals, snapshotChanged });
  }

  const factsByAlias = new Map<FactAlias, Fact>();
  let factChecksPassed = 0;
  for (const expectedFact of expected.facts) {
    const matches = matchingFacts(after, expectedFact);
    if (matches.length === 1) {
      factChecksPassed += 1;
      factsByAlias.set(expectedFact.alias, matches[0]);
    }
  }

  const matchedItemIds = new Set<string>();
  let itemChecksPassed = 0;
  for (const expectedItem of expected.scheduleItems) {
    const matches = matchScheduleItem(after, expectedItem, factsByAlias);
    if (matches.length === 1) {
      itemChecksPassed += 1;
      matchedItemIds.add(matches[0].id);
    }
  }
  for (const expectedItem of expected.derivedCostItems) {
    const matches = matchDerivedCostItem(after, expectedItem, factsByAlias);
    if (matches.length === 1) {
      itemChecksPassed += 1;
      matchedItemIds.add(matches[0].id);
    }
  }

  const unexpectedItemChanges = countUnsupportedFacts(after, expected, factsByAlias) + countUnsupportedItems(after, matchedItemIds, expected);
  const passed = proposal.conflicts.length === 0 &&
    factChecksPassed === expected.facts.length &&
    itemChecksPassed === expected.scheduleItems.length + expected.derivedCostItems.length &&
    unexpectedItemChanges === 0;

  return metrics({
    ...baseTotals,
    outcome: passed ? 'completed' : 'incorrect',
    factChecksPassed,
    itemChecksPassed,
    unexpectedItemChanges,
    snapshotChanged: JSON.stringify(before) !== JSON.stringify(after),
  });
}

const initialTravelSource = source({
  id: 'initial-travel-semantic-v2-source',
  title: '평가 전용 합성 여수 여행 최초 자료 v2',
  text: [
    '여수 워크숍 최초 안내 v2입니다.',
    '참석자는 4명입니다.',
    '첫 일정 집합 시간은 2026-12-02 10:00입니다.',
    '공동 교통비 총액은 480000원입니다.',
  ].join('\n'),
});

const initialTravelExpectation: InitialCreationExpectation = {
  facts: [
    {
      alias: 'traveler_count',
      value: 4,
      semantic: { kind: 'count', unit: 'person' },
      evidence: { sourceId: initialTravelSource.id, quote: '참석자는 4명입니다.' },
    },
    {
      alias: 'gather_at',
      value: '2026-12-02 10:00',
      semantic: { kind: 'date_time', date: '2026-12-02', time: '10:00' },
      evidence: { sourceId: initialTravelSource.id, quote: '첫 일정 집합 시간은 2026-12-02 10:00입니다.' },
    },
    {
      alias: 'transport_total_krw',
      value: 480000,
      semantic: { kind: 'money', unit: 'KRW' },
      evidence: { sourceId: initialTravelSource.id, quote: '공동 교통비 총액은 480000원입니다.' },
    },
  ],
  scheduleItems: [{ alias: 'gather_schedule', value: '2026-12-02 10:00', dateTimeFactAlias: 'gather_at' }],
  derivedCostItems: [{ alias: 'transport_share', value: '120000', moneyFactAlias: 'transport_total_krw', countFactAlias: 'traveler_count' }],
};

export const initialCreationCases: Array<EvaluationCase & { initialExpectation: InitialCreationExpectation }> = [{
  id: 'initial-travel-semantic-v2',
  purpose: '빈 작업공간에서 최초 여행 자료를 타입이 있는 사실, 정확히 하나의 집합 일정, 하나의 1인 교통비로 구성한다.',
  snapshot: emptySnapshot(),
  sources: [initialTravelSource],
  expectation: {
    facts: {
      traveler_count: 4,
      gather_at: '2026-12-02 10:00',
      transport_total_krw: 480000,
    },
    affectedFactKeys: [],
    conflictExpected: false,
    expectedItems: {
      gather_schedule: '2026-12-02 10:00',
      transport_share: '120000',
    },
  },
  initialExpectation: initialTravelExpectation,
}].map((test) => ({
  ...test,
  snapshot: snapshotSchema.parse(test.snapshot),
}));
