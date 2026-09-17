import { expect, it } from 'vitest';
import type { ProposalDraft, Snapshot } from '../../src/core/contracts';
import { summarizeProposalShape } from '../../src/evaluation/metrics';

it('distinguishes omitted observations from competing existing values without retaining content', () => {
  const snapshot: Snapshot = { facts: [{ id: 'fact:private', key: 'private_key', label: 'private label', value: 4, evidence: { sourceId: 'old', quote: 'private source', start: 0, end: 14 } }], blocks: [] };
  const draft: ProposalDraft = { summary: 'private summary', questions: ['private question'], facts: [{ key: 'private_key', label: 'private label', value: 7, sourceId: 'latest', quote: 'private evidence' }, { key: 'new_private_key', label: 'new private label', value: 'private value', sourceId: 'latest', quote: 'another private quote' }], blocks: [], removedItems: [] };
  const result = summarizeProposalShape(snapshot, draft, 'latest');
  expect(result).toMatchObject({ factObservations: 2, existingFactObservations: 1, changedExistingValues: 1, newFactObservations: 1, latestSourceObservations: 2, questions: 1 });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(Object.values(result).every((value) => typeof value === 'number')).toBe(true);
  expect(summarizeProposalShape(snapshot, { ...draft, facts: [] }, 'latest')).toMatchObject({ factObservations: 0, existingFactObservations: 0, changedExistingValues: 0, latestSourceObservations: 0 });
});
