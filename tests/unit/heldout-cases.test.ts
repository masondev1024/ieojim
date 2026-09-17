import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { snapshotSchema, sourceSchema } from '../../src/core/contracts';
import { getSample } from '../../src/core/samples';
import { getHeldoutCases } from '../../src/evaluation/heldout-cases';
import { assertModelInputBudget } from '../../src/server/model';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('held-out evaluation cases', () => {
  const cases = getHeldoutCases();

  it('exports at least fifteen unique cases separate from sample buttons', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(new Set(cases.map((test) => test.id)).size).toBe(cases.length);
    expect(cases.every((test) => test.id.startsWith('heldout-'))).toBe(true);

    const sampleTexts = new Set([
      getSample('travel').initialText,
      getSample('travel').updateText,
      getSample('travel').conflictText,
      getSample('syllabus').initialText,
      getSample('syllabus').updateText,
      getSample('syllabus').conflictText,
    ]);
    expect(cases.flatMap((test) => test.sources).some((source) => sampleTexts.has(source.text))).toBe(false);
  });

  it('keeps every snapshot and source within the product schemas with valid hashes and evidence slices', () => {
    const allSourceIds = new Set<string>();

    for (const test of cases) {
      snapshotSchema.parse(test.snapshot);
      expect(test.sources.length).toBeGreaterThanOrEqual(2);

      for (const source of test.sources) {
        sourceSchema.parse(source);
        expect(source.hash).toBe(sha256(source.text));
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

  it('contains meaningful expectations for outcomes, facts, items, conflicts and ambiguity', () => {
    const needsInput = cases.filter((test) => test.expectation.expectedOutcome === 'needs_input');
    const conflictCases = cases.filter((test) => test.expectation.conflictExpected);
    const completedCases = cases.filter((test) => !test.expectation.conflictExpected && test.expectation.expectedOutcome !== 'needs_input');
    const numericFactCases = cases.filter((test) => Object.values(test.expectation.facts).some((value) => typeof value === 'number'));
    const itemCases = cases.filter((test) => Object.keys(test.expectation.expectedItems ?? {}).length > 0);

    expect(needsInput.map((test) => test.id).sort()).toEqual(['heldout-ambiguous-budget-split', 'heldout-travel-numeric-ambiguity']);
    expect(needsInput.every((test) => test.expectation.requireUnchangedSnapshot === true)).toBe(true);
    expect(conflictCases.length).toBeGreaterThanOrEqual(5);
    expect(completedCases.length).toBeGreaterThanOrEqual(8);
    expect(numericFactCases.length).toBeGreaterThanOrEqual(7);
    expect(itemCases.length).toBeGreaterThanOrEqual(8);

    for (const test of conflictCases) {
      const factKeys = new Set(test.snapshot.facts.map((fact) => fact.key));
      expect((test.expectation.expectedConflictFactKeys ?? []).every((key) => factKeys.has(key))).toBe(true);
      if (test.expectation.expectedConflictItemIds) {
        const itemIds = new Set(test.snapshot.blocks.flatMap((block) => block.items.map((item) => item.id)));
        expect(test.expectation.expectedConflictItemIds.every((id) => itemIds.has(id))).toBe(true);
      }
    }

    expect(cases.find((test) => test.id === 'heldout-addition-source-conflict')?.expectation.expectedConflictFactKeys).toEqual(['registered_people']);
    expect(cases.find((test) => test.id === 'heldout-source-target-mismatch')?.expectation.expectedConflictFactKeys).toEqual(['seat_count']);
    expect(cases.find((test) => test.id === 'heldout-deliverable-existing-id-replacement')?.expectation).toMatchObject({
      facts: { mlops_deliverable: '실행 로그' },
      affectedFactKeys: ['mlops_deliverable'],
      expectedItems: { 'item:mlops_checklist:report': '실행 로그 제출' },
    });
    expect(cases.some((test) => test.id === 'heldout-new-deliverable-addition')).toBe(false);
    expect(cases.some((test) => test.sources.some((source) => source.relation === 'addition'))).toBe(true);
    expect(cases.some((test) => test.sources.some((source) => source.relation === 'replacement'))).toBe(true);
    expect(cases.some((test) => test.sources.length >= 3 && test.sources.some((source) => source.targetSourceId && source.targetSourceId !== test.sources[0].id))).toBe(true);
  });

  it('seeds completed, edited and locked user state in baselines without losing deterministic IDs', () => {
    const items = cases.flatMap((test) => test.snapshot.blocks.flatMap((block) => block.items.map((item) => ({ testId: test.id, block, item }))));
    expect(items.some(({ item }) => item.completed)).toBe(true);
    expect(items.some(({ item }) => item.edited)).toBe(true);
    expect(items.some(({ item }) => item.locked)).toBe(true);

    for (const { block, item } of items) {
      expect(item.id).toBe(`item:${block.key}:${item.key}`);
    }
  });

  it('fits the model input budget for both evaluation strategies', () => {
    for (const test of cases) {
      assertModelInputBudget({ purpose: test.purpose, snapshot: test.snapshot, sources: test.sources, strategy: 'incremental' });
      assertModelInputBudget({ purpose: test.purpose, snapshot: test.snapshot, sources: test.sources, strategy: 'regenerate' });
    }
  });

  it('returns a fresh clone so live evaluation output cannot mutate the frozen case definitions', () => {
    const first = getHeldoutCases();
    first[0].snapshot.facts[0].value = 'mutated-by-test';
    first[0].sources[0].text = 'mutated source';
    const second = getHeldoutCases();
    expect(second[0].snapshot.facts[0].value).not.toBe('mutated-by-test');
    expect(second[0].sources[0].text).not.toBe('mutated source');
  });
});
