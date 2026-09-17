import { describe, expect, it } from 'vitest';
import { createCoordinationDemo } from '../../src/client/landing/coordination-demo-model';

describe('coordination landing model', () => {
  it('projects real correction evidence and refuses unresolved decisions', async () => {
    const model = await createCoordinationDemo();
    expect(model.decisions.map((decision) => decision.kind).sort()).toEqual(['deletion', 'locked']);
    expect(model.changes.map((change) => change.label)).toEqual(expect.arrayContaining(['고객 미팅', '발표자료 정리', '회의실 확인']));
    expect(model.changes.some((change) => change.before.includes('14:00') && change.after.includes('16:00'))).toBe(true);
    expect(model.changes.some((change) => change.before.includes('2026-09-17') && change.after.includes('2026-09-16'))).toBe(true);
    for (const change of [...model.changes, ...model.decisions]) {
      expect(change.evidence.length).toBeGreaterThan(0);
      expect(change.evidence.some((evidence) => model.source.text.includes(evidence.quote))).toBe(true);
    }
    expect(model.preservedPreparations).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '발표자료 정리', dueDate: '2026-09-17', durationMinutes: 90, needsReview: true }),
      expect.objectContaining({ label: '회의실 확인', dueDate: '2026-09-17', durationMinutes: 15, needsReview: true }),
    ]));
    expect(model.preservedNote).toMatchObject({ label: '참석자 안내', needsReview: true });
    expect(() => model.resolve({})).toThrow();
    expect(() => model.resolve({ [model.decisions[0]!.id]: 'keep_user' })).toThrow();
    expect(() => model.resolve({ unknown: 'use_source' })).toThrow();
  });

  it.each([
    ['keep_user', 'keep_user'], ['keep_user', 'use_source'],
    ['use_source', 'keep_user'], ['use_source', 'use_source'],
  ] as const)('projects briefing=%s and print=%s without losing user-owned prep or note', async (briefingChoice, printChoice) => {
    const model = await createCoordinationDemo();
    const briefing = model.decisions.find((decision) => decision.kind === 'locked')!;
    const print = model.decisions.find((decision) => decision.kind === 'deletion')!;
    const result = model.resolve({ [briefing.id]: briefingChoice, [print.id]: printChoice });
    const briefingResult = result.find((row) => row.label === briefing.label)!;
    expect(briefingResult.after).toContain(briefingChoice === 'keep_user' ? '13:00' : '15:00');
    expect(briefingResult.state).toContain('고정 유지');
    const printResult = result.find((row) => row.label === print.label)!;
    expect(printResult.after === '삭제됨').toBe(printChoice === 'use_source');
    if (printChoice === 'keep_user') expect(printResult.state).toContain('완료 유지');
    const materials = result.find((row) => row.label === '발표자료 정리')!;
    expect(materials.after).toContain('2026-09-16');
    expect(materials.state).toEqual(expect.arrayContaining(['준비 마감 2026-09-17', '예상 90분', '재검토 필요']));
    const note = result.find((row) => row.label === model.preservedNote.label)!;
    expect(note.after).toBe(model.preservedNote.value);
    expect(note.state).toEqual(expect.arrayContaining(['직접 쓴 내용 유지', '재검토 필요']));
  });
});
