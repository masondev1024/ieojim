import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChangeSet } from '../../src/core/engine';
import { DomainError, emptySnapshot, type LiveProposalDraftV2, type Source } from '../../src/core/contracts';
import { MODEL_POLICY } from '../../src/core/model-policy';
import { generateProposal } from '../../src/server/model';

const model = MODEL_POLICY.id;

const noticeText = '제품 검토 회의는 2026년 9월 23일 16:00~17:00에서 같은 날 11:00~12:00으로 변경되었습니다. 모든 시각은 한국 표준시(Asia/Seoul)입니다.';
const source = (text = noticeText, id = 'notice_date_source'): Source => ({
  id,
  title: '제품 검토 회의 변경 안내',
  text,
  relation: 'initial',
  targetSourceId: null,
  hash: `hash-${id}`,
  createdAt: '2026-09-16T00:00:00.000Z',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notice date model contract', () => {
  it('instructs the model not to cast ranges or relative dates as scalar date_time facts', async () => {
    let requestBody: unknown = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return Response.json({
        responseId: 'synthetic-date-contract',
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(emptyDraft()) }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, thoughtsTokenCount: 2, totalTokenCount: 22 },
      });
    }));

    await generateProposal({ purpose: '변경 안내를 정리합니다.', snapshot: emptySnapshot(), sources: [source()] }, {
      apiKey: 'synthetic-test-key',
      model,
    });

    const instruction = (requestBody as { systemInstruction: { parts: Array<{ text: string }> } }).systemInstruction.parts[0]!.text;
    expect(instruction).toContain('Ranges, relative dates like 같은 날, or quotes with multiple instants are not scalar date_time facts');
    expect(instruction).toContain('NEVER inherit timezone from another sentence or wider context');
    expect(instruction).toContain('omit timezone even if the full source says KST/Asia/Seoul elsewhere');
    expect(instruction).toContain('For new untyped facts only, keep verbatim source text with semantic:null');
    expect(instruction).toContain('prose items with valueFactKey:null');
    expect(instruction).toContain('If that would erase an existing typed semantic, keep state unchanged and ask a clear question');
  });

  it('accepts one explicitly supported Korean date-time scalar', () => {
    const base = source('검토 자료 정리는 2026년 9월 23일 10:00까지 완료해야 합니다.', 'single_deadline');
    const changeSet = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [base],
      draft: {
        ...emptyDraft(),
        facts: [{
          operation: 'create',
          targetFactKey: null,
          key: 'prep_deadline',
          label: '검토 자료 정리 마감',
          value: '2026년 9월 23일 10:00',
          sourceId: base.id,
          quote: '2026년 9월 23일 10:00까지 완료해야 합니다',
          semantic: { kind: 'date_time', date: '2026-09-23', time: '10:00' },
        }],
      },
      baseRevision: 0,
      baseSourceRevision: 1,
    });

    expect(changeSet.next.facts[0]).toMatchObject({ key: 'prep_deadline', semantic: { kind: 'date_time', date: '2026-09-23', time: '10:00' } });
  });

  it('omits timezone for a scalar deadline when timezone appears only elsewhere in the source', () => {
    const base = source('모든 시각은 한국 표준시(Asia/Seoul)입니다. 검토 자료 정리는 2026년 9월 23일 10:00까지 완료해야 합니다.', 'global_timezone_deadline');
    const changeSet = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [base],
      draft: {
        ...emptyDraft(),
        facts: [{
          operation: 'create',
          targetFactKey: null,
          key: 'prep_deadline',
          label: '검토 자료 정리 마감',
          value: '2026년 9월 23일 10:00',
          sourceId: base.id,
          quote: '2026년 9월 23일 10:00',
          semantic: { kind: 'date_time', date: '2026-09-23', time: '10:00' },
        }],
      },
      baseRevision: 0,
      baseSourceRevision: 1,
    });

    expect(changeSet.next.facts[0]?.semantic).toEqual({ kind: 'date_time', date: '2026-09-23', time: '10:00' });
  });

  it('rejects scalar timezone inherited from a separate global sentence', () => {
    const base = source('모든 시각은 한국 표준시(Asia/Seoul)입니다. 검토 자료 정리는 2026년 9월 23일 10:00까지 완료해야 합니다.', 'global_timezone_rejected');
    const draft = {
      ...emptyDraft(),
      facts: [{
        operation: 'create',
        targetFactKey: null,
        key: 'prep_deadline',
        label: '검토 자료 정리 마감',
        value: '2026-09-23 10:00',
        sourceId: base.id,
        quote: '2026년 9월 23일 10:00',
        semantic: { kind: 'date_time', date: '2026-09-23', time: '10:00', timezone: 'Asia/Seoul' },
      }],
    } satisfies LiveProposalDraftV2;

    expectDomainCode(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [base], draft, baseRevision: 0, baseSourceRevision: 1 }), 'SEMANTIC_EVIDENCE_MISMATCH');
  });

  it('rejects the archived relative-date time range when miscast as one scalar date_time fact', () => {
    const base = source();
    const draft = {
      ...emptyDraft(),
      facts: [{
        operation: 'create',
        targetFactKey: null,
        key: 'meeting_changed_start',
        label: '변경 후 시작',
        value: '2026년 9월 23일 11:00',
        sourceId: base.id,
        quote: '같은 날 11:00~12:00으로 변경되었습니다',
        semantic: { kind: 'date_time', date: '2026-09-23', time: '11:00' },
      }],
    } satisfies LiveProposalDraftV2;

    expectDomainCode(() => buildChangeSet({ snapshot: emptySnapshot(), sources: [base], draft, baseRevision: 0, baseSourceRevision: 1 }), 'SEMANTIC_EVIDENCE_MISMATCH');
  });

  it('preserves the archived range as untyped source text and prose, without invented normalized intervals', () => {
    const base = source();
    const quote = '제품 검토 회의는 2026년 9월 23일 16:00~17:00에서 같은 날 11:00~12:00으로 변경되었습니다';
    const changeSet = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [base],
      draft: {
        ...emptyDraft(),
        facts: [{
          operation: 'create',
          targetFactKey: null,
          key: 'meeting_change_notice',
          label: '제품 검토 회의 변경 문장',
          value: quote,
          sourceId: base.id,
          quote,
          semantic: null,
        }],
        blocks: [{
          key: 'meeting_schedule',
          type: 'schedule',
          title: '회의 일정',
          items: [{
            operation: 'create',
            targetItemId: null,
            key: 'meeting_change_notice',
            label: '제품 검토 회의 변경',
            value: quote,
            factKeys: ['meeting_change_notice'],
            valueFactKey: null,
            calculation: null,
          }],
        }],
      },
      baseRevision: 0,
      baseSourceRevision: 1,
    });

    expect(changeSet.next.facts[0]).toMatchObject({ key: 'meeting_change_notice', value: quote, semantic: null });
    expect(changeSet.next.blocks[0]?.items[0]).toMatchObject({ value: quote, valueFactKey: null, completed: false, locked: false, edited: false, stale: false });
    expect(JSON.stringify(changeSet.next)).not.toContain('2026-09-23T11:00');
  });

  it('rejects typed semantic erasure and leaves the typed snapshot object unchanged', () => {
    const base = source('검토 자료 정리는 2026년 9월 23일 10:00까지 완료해야 합니다.', 'typed_base');
    const initial = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [base],
      draft: {
        ...emptyDraft(),
        facts: [{
          operation: 'create',
          targetFactKey: null,
          key: 'prep_deadline',
          label: '검토 자료 정리 마감',
          value: '2026년 9월 23일 10:00',
          sourceId: base.id,
          quote: '2026년 9월 23일 10:00까지 완료해야 합니다',
          semantic: { kind: 'date_time', date: '2026-09-23', time: '10:00' },
        }],
      },
      baseRevision: 0,
      baseSourceRevision: 1,
    }).next;
    const before = structuredClone(initial);
    const correction: Source = { ...source('검토 자료 정리는 같은 날 오전까지 완료합니다.', 'typed_correction'), relation: 'correction', targetSourceId: base.id };
    const erasure = {
      ...emptyDraft(),
      facts: [{
        operation: 'update',
        targetFactKey: 'prep_deadline',
        key: 'prep_deadline',
        label: '검토 자료 정리 마감',
        value: '같은 날 오전까지',
        sourceId: correction.id,
        quote: '검토 자료 정리는 같은 날 오전까지 완료합니다',
        semantic: null,
      }],
    } satisfies LiveProposalDraftV2;

    expectDomainCode(() => buildChangeSet({ snapshot: initial, sources: [base, correction], draft: erasure, baseRevision: 1, baseSourceRevision: 2 }), 'SEMANTIC_ERASURE');
    expect(initial).toEqual(before);
  });
});

function emptyDraft(): LiveProposalDraftV2 {
  return { schemaVersion: 2, summary: '합성 날짜 계약', questions: [], facts: [], blocks: [], removedItems: [] };
}

function expectDomainCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected DomainError ${code}`);
}
