import { describe, expect, it } from 'vitest';
import { createDepartureDemo } from '../../src/client/landing/departure-demo-model';

describe('departure landing model', () => {
  it('projects real correction evidence and refuses unresolved decisions', async () => {
    const model = await createDepartureDemo();
    expect(model.decisions.map((decision) => decision.kind).sort()).toEqual(['deletion', 'locked']);
    expect(model.changes).toHaveLength(3);
    expect(model.changes.some((change) => change.before === '225,000원' && change.after === '300,000원')).toBe(true);
    for (const change of [...model.changes, ...model.decisions]) {
      expect(change.evidence.length).toBeGreaterThan(0);
      expect(change.evidence.some((evidence) => model.source.text.includes(evidence.quote))).toBe(true);
    }
    expect(model.preservedNote.needsReview).toBe(true);
    expect(() => model.resolve({})).toThrow();
    expect(() => model.resolve({ [model.decisions[0]!.id]: 'keep_user' })).toThrow();
    expect(() => model.resolve({ unknown: 'use_source' })).toThrow();
  });

  it.each([
    ['keep_user', 'keep_user'], ['keep_user', 'use_source'],
    ['use_source', 'keep_user'], ['use_source', 'use_source'],
  ] as const)('projects dinner=%s and deletion=%s without changing the protected note', async (dinnerChoice, deletionChoice) => {
    const model = await createDepartureDemo();
    const dinner = model.decisions.find((decision) => decision.kind === 'locked')!;
    const paper = model.decisions.find((decision) => decision.kind === 'deletion')!;
    const result = model.resolve({ [dinner.id]: dinnerChoice, [paper.id]: deletionChoice });
    const dinnerResult = result.find((row) => row.label === dinner.label)!;
    expect(dinnerResult.after).toContain(dinnerChoice === 'keep_user' ? '오후 7시' : '오후 8시');
    expect(dinnerResult.state).toContain('고정 유지');
    const paperResult = result.find((row) => row.label === paper.label)!;
    expect(paperResult.after === '삭제됨').toBe(deletionChoice === 'use_source');
    if (deletionChoice === 'keep_user') expect(paperResult.state).toContain('완료 유지');
    const note = result.find((row) => row.label === model.preservedNote.label)!;
    expect(note.after).toBe(model.preservedNote.value);
    expect(note.state).toEqual(expect.arrayContaining(['직접 쓴 내용 유지', '재검토 필요']));
    const again = model.resolve({ [dinner.id]: 'keep_user', [paper.id]: 'keep_user' });
    expect(again.find((row) => row.label === paper.label)?.after).not.toBe('삭제됨');
    expect(again.find((row) => row.label === dinner.label)?.after).toContain('오후 7시');
  });
});
