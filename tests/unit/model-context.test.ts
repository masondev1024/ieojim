import { describe, expect, it } from 'vitest';
import type { Fact, Snapshot, Source } from '../../src/core/contracts';
import { buildModelContext } from '../../src/server/model-context';

const source: Source = {
  id: 'source-1',
  title: '원문',
  text: '참석자는 4명입니다. 총액은 900000원입니다.',
  relation: 'initial',
  targetSourceId: null,
  hash: 'synthetic',
  createdAt: '2026-09-09T00:00:00.000Z',
};

const answerSource: Source = {
  id: 'answer-1',
  title: '답변',
  text: '참석자는 3명입니다.',
  relation: 'addition',
  targetSourceId: null,
  hash: 'synthetic-answer',
  createdAt: '2026-09-09T00:01:00.000Z',
  answerTo: {
    changeSetId: 'changeset-1',
    proposalRevision: 2,
    baseRevision: 4,
    baseSourceRevision: 3,
    questions: ['참석자는 몇 명인가요?'],
  },
};

const fact: Fact = {
  id: 'fact:participants',
  key: 'participants',
  label: '참석자 수',
  value: 4,
  evidence: { sourceId: source.id, quote: '참석자는 4명입니다.', start: 0, end: 11 },
};

const snapshot: Snapshot = {
  facts: [fact],
  blocks: [{
    id: 'block:cost',
    key: 'cost',
    type: 'cost',
    title: '비용',
    items: [{
      id: 'item:cost:share',
      key: 'share',
      label: '1인당 비용',
      value: '225000',
      factKeys: ['participants'],
      valueFactKey: null,
      calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participants' },
      completed: true,
      locked: true,
      edited: true,
      stale: false,
    }],
  }],
};
const projectedSource = {
  id: source.id,
  title: source.title,
  text: source.text,
  relation: source.relation,
  targetSourceId: source.targetSourceId,
};
const projectedAnswerSource = {
  id: answerSource.id,
  title: answerSource.title,
  text: answerSource.text,
  relation: answerSource.relation,
  targetSourceId: answerSource.targetSourceId,
  answerTo: answerSource.answerTo,
};

describe('model context packaging', () => {
  it('returns the complete current request data in full mode', () => {
    const result = buildModelContext({ purpose: '여행 계획', snapshot, sources: [source, answerSource] });
    expect(result).toMatchObject({ requestedMode: 'full', effectiveMode: 'full' });
    expect(result.selectedBytes).toBe(result.fullBytes);
    expect(result.data).toEqual({ purpose: '여행 계획', snapshot, sources: [projectedSource, projectedAnswerSource] });
  });

  it('removes only reconstructable fact evidence quotes in compact mode', () => {
    const result = buildModelContext({ purpose: '여행 계획', snapshot, sources: [source, answerSource] }, 'compact');
    expect(result).toMatchObject({ requestedMode: 'compact', effectiveMode: 'compact' });
    expect(result.selectedBytes).toBeLessThan(result.fullBytes);
    expect(result.data).toMatchObject({
      purpose: '여행 계획',
      sources: [projectedSource, projectedAnswerSource],
      snapshot: {
        facts: [{
          id: fact.id,
          key: fact.key,
          label: fact.label,
          value: fact.value,
          evidence: { sourceId: source.id, start: 0, end: 11 },
        }],
        blocks: snapshot.blocks,
      },
    });
    const compactFact = (result.data as { snapshot: { facts: Array<{ evidence: Record<string, unknown> }> } }).snapshot.facts[0];
    expect(compactFact?.evidence).not.toHaveProperty('quote');
  });

  it('falls back to full mode when a quote cannot be reconstructed from the source slice', () => {
    const broken: Snapshot = {
      ...snapshot,
      facts: [{ ...fact, evidence: { ...fact.evidence, start: 1, end: 11 } }],
    };
    const result = buildModelContext({ purpose: '여행 계획', snapshot: broken, sources: [source] }, 'compact');
    expect(result).toMatchObject({ requestedMode: 'compact', effectiveMode: 'full' });
    expect(result.data).toEqual({ purpose: '여행 계획', snapshot: broken, sources: [projectedSource] });
    expect(result.selectedBytes).toBe(result.fullBytes);
  });

  it('falls back to full mode when evidence cites a source outside the package', () => {
    const result = buildModelContext({ purpose: '여행 계획', snapshot, sources: [] }, 'compact');
    expect(result).toMatchObject({ requestedMode: 'compact', effectiveMode: 'full' });
    expect(result.selectedBytes).toBe(result.fullBytes);
  });

  it('falls back to full mode when source IDs are duplicated', () => {
    const duplicate: Source = { ...source, title: '중복 원문' };
    const result = buildModelContext({ purpose: '여행 계획', snapshot, sources: [source, duplicate] }, 'compact');
    expect(result).toMatchObject({ requestedMode: 'compact', effectiveMode: 'full' });
    expect(result.selectedBytes).toBe(result.fullBytes);
  });

  it('falls back to full mode when offsets are not valid UTF-16 slice bounds', () => {
    const broken = {
      ...snapshot,
      facts: [{ ...fact, evidence: { ...fact.evidence, start: 0.5 } }],
    } as Snapshot;
    const result = buildModelContext({ purpose: '여행 계획', snapshot: broken, sources: [source] }, 'compact');
    expect(result).toMatchObject({ requestedMode: 'compact', effectiveMode: 'full' });
    expect(result.selectedBytes).toBe(result.fullBytes);
  });

  it('keeps full mode when compacting would not reduce bytes', () => {
    const empty: Snapshot = { facts: [], blocks: [] };
    const result = buildModelContext({ purpose: '빈 작업', snapshot: empty, sources: [] }, 'compact');
    expect(result).toMatchObject({ requestedMode: 'compact', effectiveMode: 'full' });
    expect(result.data).toEqual({ purpose: '빈 작업', snapshot: empty, sources: [] });
    expect(result.selectedBytes).toBe(result.fullBytes);
  });
});
