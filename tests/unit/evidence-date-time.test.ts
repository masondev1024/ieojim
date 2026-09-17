import { describe, expect, it } from 'vitest';
import type { Fact, Source } from '../../src/core/contracts';
import { readEvidenceDateTime } from '../../src/core/evidence-date-time';

function evidence(quote: string, value = quote, semantic: Fact['semantic'] = null) {
  const prefix = '모든 시각은 한국 시간입니다. 마감: ';
  const source: Source = { id: 's1', text: `${prefix}${quote}.`, title: '안내', relation: 'initial', targetSourceId: null, hash: 'test', createdAt: '2026-09-16T00:00:00Z' };
  const fact: Fact = { id: 'f1', key: 'deadline', label: '준비 마감', value, semantic, evidence: { sourceId: source.id, start: prefix.length, end: prefix.length + quote.length, quote } };
  return { fact, source };
}

describe('evidence date read without rewriting AI output', () => {
  it.each([
    ['2026년 9월 23일 10:00', '2026-09-23T10:00', '2026-09-23T10:00'],
    ['2026년9월23일오후 2시 30분', '2026-09-23 14:30', '2026-09-23T14:30'],
    ['2028-02-29 00:00', '2028년 2월 29일 오전 12시', '2028-02-29T00:00'],
    ['2026년 9월 23일 오후 12시', '2026-09-23T12:00', '2026-09-23T12:00'],
    ['2026-09-23 10:00 KST', '2026년 9월 23일 10:00 Asia/Seoul', '2026-09-23T10:00'],
  ])('reads matching complete literals: %s', (quote, value, expected) => {
    const { fact, source } = evidence(quote, value);
    const before = JSON.stringify({ fact, source });
    expect(readEvidenceDateTime(fact, [source])).toEqual({ value: expected, method: 'verified_literal' });
    expect(JSON.stringify({ fact, source })).toBe(before);
  });

  it.each([
    '같은 날 11:00', '내일 10:00', '9월 23일 10:00', '2026-09-23', '10:00',
    '2026-09-23 10:00~11:00', '2026-09-23 10:00부터 11:00까지',
    '2026-09-23 10:00 또는 2026-09-23 11:00', '약 2026-09-23 10:00',
    '2026-09-23 10:00 아님', '2026-09-23 10:00 취소', '2026-09-23 10:00 이전',
    '2026-02-29 10:00', '2026-04-31 10:00', '2026-13-01 10:00',
    '2026-09-23 24:00', '2026-09-23 10:60', '2026년 9월 23일 오후 13시',
    '2026-09-23 10:00 UTC', '2026-09-23T10:00+09:00',
    '2026-09-23 10:00 KST UTC', '2026-09-23 10:00:59',
    '2026-09-23 10:00\n2026-09-23 10:00',
  ])('does not derive a scalar from unsupported or ambiguous text: %s', (text) => {
    const { fact, source } = evidence(text);
    expect(readEvidenceDateTime(fact, [source])).toBeNull();
  });

  it.each([
    ['2026-09-23 10:00', '2026-09-24 10:00'],
    ['2026-09-23 10:00', '2026-09-23 11:00'],
    ['2026-09-23 10:00 KST', '2026-09-23 10:00'],
    ['회의는 2026-09-23 10:00 취소', '2026-09-23 10:00'],
  ])('refuses quote/display mismatch or omitted context', (quote, value) => {
    const { fact, source } = evidence(quote, value);
    expect(readEvidenceDateTime(fact, [source])).toBeNull();
  });

  it('uses verified existing semantic without filling missing fields', () => {
    const { fact, source } = evidence('발표는 2026년 9월 23일 10:00입니다', '2026-09-23T10:00', { kind: 'date_time', date: '2026-09-23', time: '10:00' });
    expect(readEvidenceDateTime(fact, [source])).toEqual({ value: '2026-09-23T10:00', method: 'stored_semantic' });
    fact.semantic = { kind: 'date_time', date: '2026-09-23' };
    expect(readEvidenceDateTime(fact, [source])).toBeNull();
  });

  it('never repairs invalid supplied semantics or inherits global timezone', () => {
    const { fact, source } = evidence('2026년 9월 23일 10:00');
    fact.semantic = { kind: 'date_time', date: '2026-09-24', time: '10:00' };
    expect(readEvidenceDateTime(fact, [source])).toBeNull();
    fact.semantic = { kind: 'date_time', date: '2026-09-23', time: '10:00', timezone: 'Asia/Seoul' };
    expect(readEvidenceDateTime(fact, [source])).toBeNull();
    fact.semantic = { kind: 'money', unit: 'KRW' };
    expect(readEvidenceDateTime(fact, [source])).toBeNull();
  });

  it('refuses missing sources, forged quotes, invalid offsets and number values', () => {
    const { fact, source } = evidence('2026-09-23 10:00');
    expect(readEvidenceDateTime(fact, [])).toBeNull();
    expect(readEvidenceDateTime(fact, [{ ...source, text: '다른 안내' }])).toBeNull();
    for (const start of [-1, 0.5, 9999]) expect(readEvidenceDateTime({ ...fact, evidence: { ...fact.evidence, start } }, [source])).toBeNull();
    expect(readEvidenceDateTime({ ...fact, value: 20260923 }, [source])).toBeNull();
  });
});
