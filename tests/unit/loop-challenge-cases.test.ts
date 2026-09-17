import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildChangeSet } from '../../src/core/engine';
import { snapshotSchema, sourceSchema, type LiveProposalDraftV2 } from '../../src/core/contracts';
import type { EvaluationCase } from '../../src/evaluation/case';
import { getAcceptanceCases } from '../../src/evaluation/acceptance-cases';
import { getHeldoutCases } from '../../src/evaluation/heldout-cases';
import { evaluateQuality } from '../../src/evaluation/eval-quality';
import { evaluateProposal } from '../../src/evaluation/metrics';
import { loopChallengeCaseKinds, loopChallengeCases } from '../../src/evaluation/loop-challenge-cases';
import { assertModelInputBudget } from '../../src/server/model';

const corpusHash = (cases: EvaluationCase[]): string => createHash('sha256')
  .update(JSON.stringify(cases.map((test) => ({
    id: test.id,
    purpose: test.purpose,
    snapshot: test.snapshot,
    sources: test.sources.map((source) => ({
      id: source.id,
      hash: source.hash,
      relation: source.relation,
      targetSourceId: source.targetSourceId,
      answerTo: source.answerTo,
    })),
    expectation: test.expectation,
  }))))
  .digest('hex');

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const latestSource = (test: EvaluationCase) => test.sources[test.sources.length - 1]!;

function unchangedQuestion(question: string): LiveProposalDraftV2 {
  return {
    schemaVersion: 2,
    summary: '현재 근거만으로는 작업공간을 안전하게 갱신할 수 없어 확인 질문을 남깁니다.',
    questions: [question],
    facts: [],
    blocks: [],
    removedItems: [],
  };
}

function idealDraft(test: EvaluationCase): LiveProposalDraftV2 {
  const source = latestSource(test);
  switch (test.id) {
    case 'loop-empty-travel-baseline':
      return {
        schemaVersion: 2,
        summary: '최초 여수 워크숍 자료에서 여행 작업공간을 생성합니다.',
        questions: [],
        facts: [
          {
            operation: 'create',
            key: 'yeosu_traveler_count',
            targetFactKey: null,
            label: '참석자 수',
            value: 4,
            sourceId: source.id,
            quote: '참석자는 4명입니다.',
            semantic: { kind: 'count', unit: 'person' },
          },
          {
            operation: 'create',
            key: 'yeosu_gather_at',
            targetFactKey: null,
            label: '첫 일정 집합 시간',
            value: '2026-12-02 10:00',
            sourceId: source.id,
            quote: '첫 일정 집합 시간은 2026-12-02 10:00입니다.',
            semantic: { kind: 'date_time', date: '2026-12-02', time: '10:00' },
          },
          {
            operation: 'create',
            key: 'yeosu_transport_total_krw',
            targetFactKey: null,
            label: '공동 교통비 총액',
            value: 480000,
            sourceId: source.id,
            quote: '공동 교통비 총액은 480000원입니다.',
            semantic: { kind: 'money', unit: 'KRW' },
          },
        ],
        blocks: [
          {
            key: 'yeosu_schedule',
            type: 'schedule',
            title: '여수 일정',
            items: [{
              operation: 'create',
              targetItemId: null,
              key: 'gather',
              label: '첫 일정 집합',
              value: '2026-12-02 10:00',
              factKeys: ['yeosu_gather_at'],
              valueFactKey: 'yeosu_gather_at',
              calculation: null,
            }],
          },
          {
            key: 'yeosu_cost',
            type: 'cost',
            title: '여수 비용',
            items: [{
              operation: 'create',
              targetItemId: null,
              key: 'transport_share',
              label: '1인 교통비',
              value: '0',
              factKeys: ['yeosu_transport_total_krw', 'yeosu_traveler_count'],
              valueFactKey: null,
              calculation: { kind: 'divide', totalFactKey: 'yeosu_transport_total_krw', divisorFactKey: 'yeosu_traveler_count' },
            }],
          },
        ],
        removedItems: [],
      };
    case 'loop-travel-late-replacement-targets-prior-correction':
      return {
        schemaVersion: 2,
        summary: '최종 교체본에 따라 숙소 체크인을 다시 갱신합니다.',
        questions: [],
        facts: [{
          operation: 'update',
          key: 'lodging_checkin_at',
          targetFactKey: 'lodging_checkin_at',
          label: '숙소 체크인',
          value: '2026-11-14 17:30',
          sourceId: source.id,
          quote: '숙소 체크인은 2026-11-14 17:30입니다.',
          semantic: { kind: 'date_time', date: '2026-11-14', time: '17:30' },
        }],
        blocks: [{
          key: 'coastal_schedule',
          type: 'schedule',
          title: '강릉 일정',
          items: [{
            operation: 'update',
            targetItemId: 'item:coastal_schedule:lodging_checkin',
            key: 'lodging_checkin',
            label: '숙소 체크인',
            value: '2026-11-14 17:30',
            factKeys: ['lodging_checkin_at'],
            valueFactKey: 'lodging_checkin_at',
            calculation: null,
          }],
        }],
        removedItems: [],
      };
    case 'loop-travel-comma-money-integer-share':
      return {
        schemaVersion: 2,
        summary: '쉼표가 포함된 숙박비 총액을 숫자 사실로 갱신합니다.',
        questions: [],
        facts: [
          {
            operation: 'update',
            key: 'lodging_total_krw',
            targetFactKey: 'lodging_total_krw',
            label: '공동 숙박비 총액',
            value: 1234560,
            sourceId: source.id,
            quote: '공동 숙박비 총액은 1,234,560원입니다.',
            semantic: { kind: 'money', unit: 'KRW' },
          },
          {
            operation: 'update',
            key: 'traveler_count',
            targetFactKey: 'traveler_count',
            label: '참석자 수',
            value: 6,
            sourceId: source.id,
            quote: '참석자는 6명으로 유지합니다.',
            semantic: { kind: 'count', unit: 'person' },
          },
        ],
        blocks: [],
        removedItems: [],
      };
    case 'loop-travel-ambiguous-night-extension':
      return unchangedQuestion('1박 연장 후 렌터카 반납의 정확한 새 날짜와 시간을 확인해 주세요.');
    case 'loop-travel-locked-dinner-change-conflict':
      return {
        schemaVersion: 2,
        summary: '저녁 시간 정정이 잠긴 일정과 충돌합니다.',
        questions: [],
        facts: [{
          operation: 'update',
          key: 'dinner_at',
          targetFactKey: 'dinner_at',
          label: '저녁 식사',
          value: '2026-11-14 20:30',
          sourceId: source.id,
          quote: '저녁 식사는 2026-11-14 20:30입니다.',
          semantic: { kind: 'date_time', date: '2026-11-14', time: '20:30' },
        }],
        blocks: [{
          key: 'coastal_schedule',
          type: 'schedule',
          title: '강릉 일정',
          items: [{
            operation: 'update',
            targetItemId: 'item:coastal_schedule:dinner',
            key: 'dinner',
            label: '저녁 식사',
            value: '2026-11-14 20:30',
            factKeys: ['dinner_at'],
            valueFactKey: 'dinner_at',
            calculation: null,
          }],
        }],
        removedItems: [],
      };
    case 'loop-travel-addition-contradicts-cost':
      return {
        schemaVersion: 2,
        summary: '추가 자료의 숙박비가 기존 기준과 충돌합니다.',
        questions: [],
        facts: [{
          operation: 'update',
          key: 'lodging_total_krw',
          targetFactKey: 'lodging_total_krw',
          label: '공동 숙박비 총액',
          value: 1500000,
          sourceId: source.id,
          quote: '공동 숙박비 총액은 1500000원입니다.',
          semantic: { kind: 'money', unit: 'KRW' },
        }],
        blocks: [],
        removedItems: [],
      };
    default:
      throw new Error(`Missing loop challenge ideal draft for ${test.id}`);
  }
}

describe('loop challenge evaluation corpus', () => {
  it('exports six stable challenge cases with independent classifications', () => {
    expect(loopChallengeCases).toHaveLength(6);
    expect(new Set(loopChallengeCases.map((test) => test.id)).size).toBe(loopChallengeCases.length);
    expect(loopChallengeCases.every((test) => test.id.startsWith('loop-'))).toBe(true);
    expect(Object.keys(loopChallengeCaseKinds).sort()).toEqual(loopChallengeCases.map((test) => test.id).sort());
    expect(Object.values(loopChallengeCaseKinds).sort()).toEqual([
      'human_input',
      'human_input',
      'repair_candidate',
      'repair_candidate',
      'repair_candidate',
      'state_preservation',
    ].sort());
  });

  it('keeps snapshots and sources valid with real evidence slices and source targets', () => {
    const allSourceIds = new Set<string>();
    for (const test of loopChallengeCases) {
      snapshotSchema.parse(test.snapshot);
      expect(test.sources.length).toBeGreaterThanOrEqual(1);

      for (const source of test.sources) {
        sourceSchema.parse(source);
        expect(source.hash).toBe(sha256(source.text));
        expect(source.createdAt).toMatch(/^2026-09-10T/);
        expect(allSourceIds.has(source.id)).toBe(false);
        allSourceIds.add(source.id);
        if (source.relation === 'correction' || source.relation === 'replacement') {
          expect(source.targetSourceId).toBeTruthy();
          expect(test.sources.some((candidate) => candidate.id === source.targetSourceId)).toBe(true);
        }
      }

      const sourcesById = new Map(test.sources.map((source) => [source.id, source]));
      for (const fact of test.snapshot.facts) {
        const source = sourcesById.get(fact.evidence.sourceId);
        expect(source, `${test.id}:${fact.key}`).toBeTruthy();
        expect(source!.text.slice(fact.evidence.start, fact.evidence.end)).toBe(fact.evidence.quote);
      }
    }
  });

  it('is not a cosmetic duplicate of acceptance or held-out case definitions', () => {
    const priorCases = [...getAcceptanceCases(), ...getHeldoutCases()];
    const priorIds = new Set(priorCases.map((test) => test.id));
    const priorSourceTexts = new Set(priorCases.flatMap((test) => test.sources.map((source) => source.text)));

    for (const test of loopChallengeCases) {
      expect(priorIds.has(test.id)).toBe(false);
      expect(test.sources.some((source) => priorSourceTexts.has(source.text))).toBe(false);
    }
  });

  it('freezes meaningful expectations across repair, clarification, source conflict and protected-state paths', () => {
    expect(loopChallengeCases.filter((test) => loopChallengeCaseKinds[test.id] === 'repair_candidate').map((test) => test.id).sort()).toEqual([
      'loop-empty-travel-baseline',
      'loop-travel-comma-money-integer-share',
      'loop-travel-late-replacement-targets-prior-correction',
    ]);
    expect(loopChallengeCases.filter((test) => test.expectation.expectedOutcome === 'needs_input').map((test) => test.id).sort()).toEqual([
      'loop-travel-ambiguous-night-extension',
    ]);
    expect(loopChallengeCases.filter((test) => test.expectation.conflictExpected).map((test) => test.id).sort()).toEqual([
      'loop-travel-addition-contradicts-cost',
      'loop-travel-locked-dinner-change-conflict',
    ]);
    expect(loopChallengeCases.find((test) => test.id === 'loop-travel-comma-money-integer-share')?.expectation.expectedItems).toEqual({
      'item:coastal_cost:lodging_share': '205760',
    });
    expect(loopChallengeCases.find((test) => test.id === 'loop-travel-late-replacement-targets-prior-correction')?.sources.at(-1)?.targetSourceId).toBe('loop-late-supersede-prior-correction');
  });

  it('proves every expectation with an independently constructed valid draft without model calls', () => {
    for (const test of loopChallengeCases) {
      const proposal = buildChangeSet({
        snapshot: test.snapshot,
        sources: test.sources,
        draft: idealDraft(test),
        baseRevision: 1,
        baseSourceRevision: test.sources.length,
        id: `changeset:${test.id}`,
        now: '2026-09-10T03:00:00.000Z',
      });
      const metrics = evaluateProposal(test.snapshot, proposal, test.expectation);
      expect(evaluateQuality(metrics, test.expectation), test.id).toMatchObject({ qualityStatus: 'passed' });
    }
  });

  it('fits the model input budget for incremental and regenerate evaluation strategies', () => {
    for (const test of loopChallengeCases) {
      assertModelInputBudget({ purpose: test.purpose, snapshot: test.snapshot, sources: test.sources, strategy: 'incremental' });
      assertModelInputBudget({ purpose: test.purpose, snapshot: test.snapshot, sources: test.sources, strategy: 'regenerate' });
    }
  });

  it('freezes the corpus hash used by the suite wiring', () => {
    expect(corpusHash(loopChallengeCases)).toBe('5ac532f00287220828e22b28778938992d5053f106a59da8e6c07f673cde433e');
  });
});
