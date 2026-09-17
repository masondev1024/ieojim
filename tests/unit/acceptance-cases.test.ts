import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildChangeSet } from '../../src/core/engine';
import { snapshotSchema, sourceSchema, type LiveProposalDraftV2 } from '../../src/core/contracts';
import type { EvaluationCase } from '../../src/evaluation/case';
import { getAcceptanceCases } from '../../src/evaluation/acceptance-cases';
import { evaluateQuality } from '../../src/evaluation/eval-quality';
import { evaluateProposal } from '../../src/evaluation/metrics';

const ACCEPTANCE_CORPUS_SHA256 = 'af23574ed7580c1758c3853a5abe3a2d3581f79931540feb8ebbeaa9c6855e88';

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

const itemIds = (test: EvaluationCase) => new Set(test.snapshot.blocks.flatMap((block) => block.items.map((item) => item.id)));
const factKeys = (test: EvaluationCase) => new Set(test.snapshot.facts.map((fact) => fact.key));
const latestSource = (test: EvaluationCase) => test.sources[test.sources.length - 1];

function idealDraft(test: EvaluationCase): LiveProposalDraftV2 {
  const source = latestSource(test);
  const unchangedQuestion = (question: string): LiveProposalDraftV2 => ({
    schemaVersion: 2,
    summary: '근거가 현재 작업공간에 바로 적용하기에 불충분하여 확인 질문을 남깁니다.',
    questions: [question],
    facts: [],
    blocks: [],
    removedItems: [],
  });

  switch (test.id) {
    case 'accept-travel-same-entity-contradictory-addition':
      return {
        schemaVersion: 2,
        summary: '같은 숙소 체크인 시간에 상충하는 추가 근거를 감지했습니다.',
        questions: [],
        facts: [{
          operation: 'update',
          key: 'hotel_checkin_at',
          targetFactKey: 'hotel_checkin_at',
          label: '숙소 체크인',
          value: '2026-10-03 17:00',
          sourceId: source.id,
          quote: '숙소 체크인은 2026-10-03 17:00',
          semantic: { kind: 'date_time', date: '2026-10-03', time: '17:00' },
        }],
        blocks: [{
          key: 'travel_schedule',
          type: 'schedule',
          title: '여행 일정',
          items: [{
            operation: 'update',
            targetItemId: 'item:travel_schedule:hotel_checkin',
            key: 'hotel_checkin',
            label: '숙소 체크인',
            value: '2026-10-03 17:00',
            factKeys: ['hotel_checkin_at'],
            valueFactKey: 'hotel_checkin_at',
            calculation: null,
          }],
        }],
        removedItems: [],
      };
    case 'accept-travel-targeted-checkin-correction':
      return {
        schemaVersion: 2,
        summary: '정정 근거에 따라 숙소 체크인 시간을 갱신합니다.',
        questions: [],
        facts: [{
          operation: 'update',
          key: 'hotel_checkin_at',
          targetFactKey: 'hotel_checkin_at',
          label: '숙소 체크인',
          value: '2026-10-03 16:30',
          sourceId: source.id,
          quote: '숙소 체크인은 2026-10-03 16:30으로 확정되었습니다.',
          semantic: { kind: 'date_time', date: '2026-10-03', time: '16:30' },
        }],
        blocks: [{
          key: 'travel_schedule',
          type: 'schedule',
          title: '여행 일정',
          items: [{
            operation: 'update',
            targetItemId: 'item:travel_schedule:hotel_checkin',
            key: 'hotel_checkin',
            label: '숙소 체크인',
            value: '2026-10-03 16:30',
            factKeys: ['hotel_checkin_at'],
            valueFactKey: 'hotel_checkin_at',
            calculation: null,
          }],
        }],
        removedItems: [],
      };
    case 'accept-travel-different-entity-same-attribute':
      return unchangedQuestion('셔틀버스 출발 정보를 KTX 출발 항목과 별도 항목으로 추가할까요?');
    case 'accept-travel-ambiguous-quantity-and-time':
      return unchangedQuestion('공동 고정비 30의 단위와 저녁의 정확한 날짜 및 시간을 확인해 주세요.');
    case 'accept-travel-targeted-departure-evidence':
      return {
        schemaVersion: 2,
        summary: '정정 근거에 따라 KTX 출발 시간을 갱신합니다.',
        questions: [],
        facts: [{
          operation: 'update',
          key: 'ktx_departure_at',
          targetFactKey: 'ktx_departure_at',
          label: 'KTX 출발',
          value: '2026-10-03 08:30',
          sourceId: source.id,
          quote: '첫째 날 KTX 101편 출발은 2026-10-03 08:30입니다.',
          semantic: { kind: 'date_time', date: '2026-10-03', time: '08:30' },
        }],
        blocks: [{
          key: 'travel_schedule',
          type: 'schedule',
          title: '여행 일정',
          items: [{
            operation: 'update',
            targetItemId: 'item:travel_schedule:ktx_departure',
            key: 'ktx_departure',
            label: 'KTX 출발',
            value: '2026-10-03 08:30',
            factKeys: ['ktx_departure_at'],
            valueFactKey: 'ktx_departure_at',
            calculation: null,
          }],
        }],
        removedItems: [],
      };
    case 'accept-travel-locked-dinner-conflict':
      return {
        schemaVersion: 2,
        summary: '저녁 시간 정정 근거가 잠긴 사용자 일정과 충돌합니다.',
        questions: [],
        facts: [{
          operation: 'update',
          key: 'dinner_at',
          targetFactKey: 'dinner_at',
          label: '둘째 날 저녁',
          value: '2026-10-04 19:30',
          sourceId: source.id,
          quote: '둘째 날 저녁 식사는 2026-10-04 19:30입니다.',
          semantic: { kind: 'date_time', date: '2026-10-04', time: '19:30' },
        }],
        blocks: [{
          key: 'travel_schedule',
          type: 'schedule',
          title: '여행 일정',
          items: [{
            operation: 'update',
            targetItemId: 'item:travel_schedule:dinner',
            key: 'dinner',
            label: '둘째 날 저녁',
            value: '2026-10-04 19:30',
            factKeys: ['dinner_at'],
            valueFactKey: 'dinner_at',
            calculation: null,
          }],
        }],
        removedItems: [],
      };
    case 'accept-travel-completed-checklist-preserved':
      return {
        schemaVersion: 2,
        summary: '준비물 상태 표현을 정정하고 완료 여부는 유지합니다.',
        questions: [],
        facts: [{
          operation: 'update',
          key: 'passport_copy_status',
          targetFactKey: 'passport_copy_status',
          label: '여권 사본 제출',
          value: '완료 후 원본 지참 확인',
          sourceId: source.id,
          quote: '여권 사본 제출은 완료 후 원본 지참 확인으로 표시합니다.',
          semantic: null,
        }],
        blocks: [{
          key: 'travel_checklist',
          type: 'checklist',
          title: '여행 준비',
          items: [{
            operation: 'update',
            targetItemId: 'item:travel_checklist:passport_copy',
            key: 'passport_copy',
            label: '여권 사본 제출',
            value: '완료 후 원본 지참 확인',
            factKeys: ['passport_copy_status'],
            valueFactKey: 'passport_copy_status',
            calculation: null,
          }],
        }],
        removedItems: [],
      };
    case 'accept-travel-edited-note-stale':
      return {
        schemaVersion: 2,
        summary: '체크인 시간을 갱신하고 사용자가 쓴 관련 메모는 보존합니다.',
        questions: [],
        facts: [{
          operation: 'update',
          key: 'hotel_checkin_at',
          targetFactKey: 'hotel_checkin_at',
          label: '숙소 체크인',
          value: '2026-10-03 14:30',
          sourceId: source.id,
          quote: '숙소 체크인은 2026-10-03 14:30으로 앞당겨졌습니다.',
          semantic: { kind: 'date_time', date: '2026-10-03', time: '14:30' },
        }],
        blocks: [{
          key: 'travel_schedule',
          type: 'schedule',
          title: '여행 일정',
          items: [{
            operation: 'update',
            targetItemId: 'item:travel_schedule:hotel_checkin',
            key: 'hotel_checkin',
            label: '숙소 체크인',
            value: '2026-10-03 14:30',
            factKeys: ['hotel_checkin_at'],
            valueFactKey: 'hotel_checkin_at',
            calculation: null,
          }],
        }],
        removedItems: [],
      };
    case 'accept-travel-derived-krw-count':
      return {
        schemaVersion: 2,
        summary: '참석자 수 정정에 따라 1인 고정비를 재계산합니다.',
        questions: [],
        facts: [
          {
            operation: 'update',
            key: 'participant_count',
            targetFactKey: 'participant_count',
            label: '참석자 수',
            value: 4,
            sourceId: source.id,
            quote: '참석자는 4명입니다.',
            semantic: { kind: 'count', unit: 'person' },
          },
          {
            operation: 'update',
            key: 'fixed_cost_total_krw',
            targetFactKey: 'fixed_cost_total_krw',
            label: '공동 고정비 총액',
            value: 900000,
            sourceId: source.id,
            quote: '공동 고정비 총액은 900000원으로 유지합니다.',
            semantic: { kind: 'money', unit: 'KRW' },
          },
        ],
        blocks: [],
        removedItems: [],
      };
    case 'accept-travel-protected-deletion-conflict':
      return {
        schemaVersion: 2,
        summary: '완료된 여권 사본 항목 삭제가 사용자 상태와 충돌합니다.',
        questions: [],
        facts: [],
        blocks: [],
        removedItems: [{
          operation: 'remove',
          itemId: 'item:travel_checklist:passport_copy',
          sourceId: source.id,
          quote: '여권 사본 제출 항목은 이번 워크숍 준비 목록에서 제외합니다.',
        }],
      };
    case 'accept-assignment-targeted-deadline-replacement':
      return {
        schemaVersion: 2,
        summary: '대체 공지에 따라 과제 마감을 갱신합니다.',
        questions: [],
        facts: [
          {
            operation: 'update',
            key: 'assignment_deadline_at',
            targetFactKey: 'assignment_deadline_at',
            label: '최종 제출 마감',
            value: '2026-10-12 18:00',
            sourceId: source.id,
            quote: '최종 제출 마감은 2026-10-12 18:00입니다.',
            semantic: { kind: 'date_time', date: '2026-10-12', time: '18:00' },
          },
          {
            operation: 'update',
            key: 'deliverables',
            targetFactKey: 'deliverables',
            label: '제출물',
            value: '보고서와 실행 로그',
            sourceId: source.id,
            quote: '제출물은 보고서와 실행 로그입니다.',
            semantic: null,
          },
        ],
        blocks: [{
          key: 'assignment_schedule',
          type: 'schedule',
          title: '과제 일정',
          items: [{
            operation: 'update',
            targetItemId: 'item:assignment_schedule:deadline',
            key: 'deadline',
            label: '최종 제출 마감',
            value: '2026-10-12 18:00',
            factKeys: ['assignment_deadline_at'],
            valueFactKey: 'assignment_deadline_at',
            calculation: null,
          }],
        }],
        removedItems: [],
      };
    case 'accept-assignment-different-team-ambiguous':
      return unchangedQuestion('B반 팀 수와 리허설 논의가 현재 과제 기준안에 적용되는지 확인해 주세요.');
    default:
      throw new Error(`Missing ideal draft for ${test.id}`);
  }
}

describe('acceptance corpus freeze', () => {
  const cases = getAcceptanceCases();

  it('contains exactly twelve stable, distinct synthetic cases', () => {
    expect(cases).toHaveLength(12);
    expect(new Set(cases.map((test) => test.id)).size).toBe(12);
    expect(cases.every((test) => test.id.startsWith('accept-'))).toBe(true);
    expect(cases.some((test) => test.id.includes('travel'))).toBe(true);
    expect(cases.some((test) => test.id.includes('assignment'))).toBe(true);
  });

  it('keeps baselines and source records valid with fixed synthetic hashes and dates', () => {
    for (const test of cases) {
      expect(() => snapshotSchema.parse(test.snapshot)).not.toThrow();
      expect(test.sources.length).toBeGreaterThanOrEqual(2);
      for (const source of test.sources) {
        expect(() => sourceSchema.parse(source)).not.toThrow();
        expect(source.hash).toBe(createHash('sha256').update(source.text).digest('hex'));
        expect(source.createdAt).toMatch(/^2026-09-0[12]T/);
        if (source.relation === 'initial' || source.relation === 'addition') {
          expect(source.targetSourceId).toBeNull();
        } else {
          expect(source.targetSourceId).toBe(test.sources[0].id);
        }
      }
    }
  });

  it('uses real immutable evidence offsets from stored source text', () => {
    for (const test of cases) {
      const sources = new Map(test.sources.map((source) => [source.id, source]));
      const ranges = new Set<string>();
      for (const fact of test.snapshot.facts) {
        const source = sources.get(fact.evidence.sourceId);
        expect(source).toBeDefined();
        expect(source?.text.slice(fact.evidence.start, fact.evidence.end)).toBe(fact.evidence.quote);
        expect(fact.semantic?.kind === 'date_time' ? fact.semantic.timezone : undefined).toBeUndefined();
        ranges.add(`${fact.evidence.sourceId}:${fact.evidence.start}:${fact.evidence.end}`);
      }
      expect(ranges.size).toBe(test.snapshot.facts.length);
    }
  });

  it('proves every baseline and ideal draft is supported by the core engine', () => {
    for (const test of cases) {
      snapshotSchema.parse(test.snapshot);
      const proposal = buildChangeSet({
        snapshot: test.snapshot,
        sources: test.sources,
        draft: idealDraft(test),
        baseRevision: 1,
        baseSourceRevision: test.sources.length,
        id: `changeset:${test.id}`,
        now: '2026-09-09T00:00:00.000Z',
      });
      const metrics = evaluateProposal(test.snapshot, proposal, test.expectation);
      expect(evaluateQuality(metrics, test.expectation), test.id).toMatchObject({ qualityStatus: 'passed' });
    }
  });

  it('anchors gold expectations to existing stable IDs and precise conflict targets', () => {
    for (const test of cases) {
      const ids = itemIds(test);
      const keys = factKeys(test);
      for (const itemId of Object.keys(test.expectation.expectedItems ?? {})) {
        expect(ids.has(itemId), `${test.id} expected item ${itemId}`).toBe(true);
      }
      for (const itemId of test.expectation.expectedConflictItemIds ?? []) {
        expect(ids.has(itemId), `${test.id} conflict item ${itemId}`).toBe(true);
      }
      for (const key of test.expectation.expectedConflictFactKeys ?? []) {
        expect(keys.has(key), `${test.id} conflict fact ${key}`).toBe(true);
      }
      for (const key of test.expectation.affectedFactKeys) {
        expect(keys.has(key), `${test.id} affected fact ${key}`).toBe(true);
      }
      if (test.expectation.conflictExpected) {
        expect([
          ...(test.expectation.expectedConflictItemIds ?? []),
          ...(test.expectation.expectedConflictFactKeys ?? []),
        ].length).toBeGreaterThan(0);
      }
    }
  });

  it('requires unchanged snapshots for ambiguous or different-entity cases', () => {
    const unchangedCases = cases.filter((test) => test.expectation.requireUnchangedSnapshot);
    expect(unchangedCases.map((test) => test.id).sort()).toEqual([
      'accept-assignment-different-team-ambiguous',
      'accept-travel-ambiguous-quantity-and-time',
      'accept-travel-different-entity-same-attribute',
    ]);
    for (const test of unchangedCases) {
      expect(test.expectation.expectedOutcome).toBe('needs_input');
      expect(test.expectation.facts).toEqual({});
      expect(test.expectation.affectedFactKeys).toEqual([]);
      expect(test.expectation.conflictExpected).toBe(false);
    }
  });

  it('freezes the acceptance corpus hash using the live evaluation corpus algorithm', () => {
    expect(corpusHash(cases)).toBe(ACCEPTANCE_CORPUS_SHA256);
  });
});
