import { describe, expect, it } from 'vitest';
import { createAnchoredRecoveryExample, createFutureRecoveryExample, createRecoveryExample, nextFutureRecoveryThursday } from '../../src/core/schedule-recovery-sample';
import { repairSchedule } from '../../src/core/schedule-repair';
import { createRecoveryInput, draftFromRecoveryInput } from '../../src/client/recovery/recovery-model';

describe('future recovery preview fixture', () => {
  it('keeps the frozen recovery fixture unchanged by default', () => {
    const input = createRecoveryExample();

    expect(input.now).toBe('2026-09-17T14:00');
    expect(input.change.preparationDeadline).toBe('2026-09-18T10:00');
    expect(input.events.find((event) => event.id === 'event:presentation')?.start).toBe('2026-09-18T16:00');
  });

  it('chooses the next Thursday 14:00 KST with at least a 24 hour buffer', () => {
    expect(nextFutureRecoveryThursday(() => new Date('2030-01-02T00:00:00.000Z'))).toBe('2030-01-03T14:00');
    expect(nextFutureRecoveryThursday(() => new Date('2030-01-03T04:30:00.000Z'))).toBe('2030-01-10T14:00');
  });

  it('shifts every recovery time while preserving identities and source evidence', () => {
    const input = createFutureRecoveryExample(() => new Date('2030-01-02T00:00:00.000Z'));
    const result = repairSchedule(input);

    expect(input).toMatchObject({
      now: '2030-01-03T14:00',
      horizon: { start: '2030-01-03T14:00', end: '2030-01-05T14:00' },
      change: {
        presentationInterval: { start: '2030-01-04T11:00', end: '2030-01-04T12:00' },
        preparationDeadline: '2030-01-04T10:00',
      },
    });
    expect(input.events.find((event) => event.id === 'event:expense_admin')).toMatchObject({
      itemId: 'item:recovery_schedule:event_expense_admin',
      start: '2030-01-03T16:00',
      movableWindow: { start: '2030-01-03T14:00', end: '2030-01-03T17:00' },
    });
    for (const entry of input.relations.flatMap((relation) => relation.evidence)) {
      const source = input.sources.find((candidate) => candidate.id === entry.sourceId);
      expect(source?.text.slice(entry.start, entry.end)).toBe(entry.quote);
    }
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    expect(result.after.find((event) => event.id === 'event:presentation_prep')).toMatchObject({ start: '2030-01-03T15:30', end: '2030-01-03T17:00' });
  });

  it('rejects invalid anchors instead of silently producing impossible dates', () => {
    expect(() => createAnchoredRecoveryExample('2030-01-04T14:00')).toThrow(/Thursday/);
    expect(() => createAnchoredRecoveryExample('2030-01-03T13:00')).toThrow(/Thursday 14:00/);
    expect(() => createAnchoredRecoveryExample('2030-02-31T14:00')).toThrow(/valid local minute/);
  });

  it('keeps local edits on the selected anchored base, including the 14:30 counterfactual', () => {
    const base = createAnchoredRecoveryExample('2030-01-03T14:00');
    const draft = { ...draftFromRecoveryInput(base), availability1430: false };
    const input = createRecoveryInput(draft, base);

    expect(input.change.preparationDeadline).toBe('2030-01-04T10:00');
    expect(input.events.find((event) => event.id === 'event:counterfactual_1430_busy')).toMatchObject({
      start: '2030-01-03T14:30',
      end: '2030-01-03T15:00',
    });
    expect(repairSchedule(input)).toMatchObject({ status: 'infeasible' });
  });
});
