import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Source } from '../../src/core/contracts';
import { buildRecoveryScenario, createRecoveryExample, RECOVERY_SAMPLE_SOURCE_TEXT } from '../../src/core/schedule-recovery-sample';
import { repairSchedule, validateReadyResult } from '../../src/core/schedule-repair';
import type { RecoveryInput, RecoveryReadyResult } from '../../src/core/scheduling-contracts';
import { buildChangeSet, resolveChangeSet } from '../../src/core/engine';

const event = (input: RecoveryInput, eventId: string) => input.events.find((candidate) => candidate.id === eventId);
const after = (result: RecoveryReadyResult, eventId: string) => result.after.find((candidate) => candidate.id === eventId);

describe('deterministic schedule repair', () => {
  it('repairs the approved presentation scenario without moving protected events', () => {
    const input = createRecoveryExample();
    const result = repairSchedule(input);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    expect(after(result, 'event:presentation')).toMatchObject({ start: '2026-09-18T11:00', end: '2026-09-18T12:00' });
    expect(after(result, 'event:presentation_travel')).toMatchObject({ start: '2026-09-18T10:00', end: '2026-09-18T11:00' });
    expect(after(result, 'event:presentation_prep')).toMatchObject({ start: '2026-09-17T15:30', end: '2026-09-17T17:00' });
    expect(after(result, 'event:expense_admin')).toMatchObject({ start: '2026-09-17T14:30', end: '2026-09-17T15:00' });
    expect(after(result, 'event:personal_1700')).toMatchObject({ start: event(input, 'event:personal_1700')?.start, end: event(input, 'event:personal_1700')?.end });
    expect(validateReadyResult(input, result)).toEqual({ valid: true, blockers: [] });
  });

  it('uses minute-level search so a non-30-minute slot is not missed', () => {
    const input = createRecoveryExample({
      workWindows: [
        { label: '목요일 비정렬 창', start: '2026-09-17T14:10', end: '2026-09-17T17:00' },
        { label: '금요일 근무', start: '2026-09-18T09:00', end: '2026-09-18T18:00' },
      ],
      events: createRecoveryExample().events.map((candidate) => {
        if (candidate.id === 'event:thu_fixed_1400') return { ...candidate, start: '2026-09-17T14:10', end: '2026-09-17T14:40' };
        if (candidate.id === 'event:expense_admin') return { ...candidate, start: '2026-09-17T16:00', end: '2026-09-17T16:20', movableWindow: { start: '2026-09-17T14:10', end: '2026-09-17T17:00', durationMinutes: 20 } };
        return candidate;
      }),
    });
    const result = repairSchedule({ ...input, change: { ...input.change, preparationDurationMinutes: 80 } });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    expect(after(result, 'event:expense_admin')).toMatchObject({ start: '2026-09-17T14:40', end: '2026-09-17T15:00' });
    expect(after(result, 'event:presentation_prep')).toMatchObject({ start: '2026-09-17T15:30', end: '2026-09-17T16:50' });
  });

  it('distinguishes infeasible protected targets from ordinary no-slot failures', () => {
    const protectedPresentation = createRecoveryExample({
      events: createRecoveryExample().events.map((candidate) => candidate.id === 'event:presentation' ? { ...candidate, locked: true } : candidate),
    });
    expect(repairSchedule(protectedPresentation)).toMatchObject({ status: 'infeasible', code: 'target_protected' });

    const noSlot = createRecoveryExample({ change: { ...createRecoveryExample().change, preparationDurationMinutes: 120 } });
    expect(repairSchedule(noSlot)).toMatchObject({ status: 'infeasible', code: 'no_continuous_preparation_window' });
  });

  it('distinguishes unsupported scope, missing confirmed relations, and malformed evidence', () => {
    expect(repairSchedule(createRecoveryExample({
      horizon: { start: '2026-09-17T14:00', end: '2026-09-20T14:01' },
    }))).toMatchObject({ status: 'unsupported', code: 'horizon_too_large' });

    const unconfirmed = createRecoveryExample({
      relations: createRecoveryExample().relations.map((relation) => relation.id === 'relation:deadline' ? { ...relation, confirmed: false } : relation),
    });
    expect(repairSchedule(unconfirmed)).toMatchObject({ status: 'missing_information', code: 'unconfirmed_relations' });

    const badEvidence = createRecoveryExample({
      sources: [{ id: 'source:presentation_change', text: RECOVERY_SAMPLE_SOURCE_TEXT.replace('11시', '12시') }],
    });
    expect(repairSchedule(badEvidence)).toMatchObject({ status: 'invalid_input', code: 'invalid_evidence' });
  });

  it('rejects malformed source dates and final schedules that overlap protected intervals', () => {
    expect(repairSchedule(createRecoveryExample({ now: '2026-09-31T14:00' }))).toMatchObject({ status: 'invalid_input' });

    const input = createRecoveryExample();
    const ready = repairSchedule(input);
    if (ready.status !== 'ready') throw new Error(ready.message);
    const corrupted: RecoveryReadyResult = {
      ...ready,
      after: ready.after.map((candidate) => candidate.id === 'event:personal_1700' ? { ...candidate, start: '2026-09-17T16:00', end: '2026-09-17T17:00' } : candidate),
    };
    const validation = validateReadyResult(input, corrupted);
    expect(validation.valid).toBe(false);
    if (!validation.valid) expect(validation.blockers.map((blocker) => blocker.code)).toContain('protected_event_changed');
  });

  it('builds an honest existing sample scenario from recovery input without registry drift', () => {
    const scenario = buildRecoveryScenario(createRecoveryExample());
    const draft = scenario.initialDraft('source:initial_conditions');

    expect(scenario.title).toContain('합성 예시');
    expect(scenario.initialText).toContain('금요일 발표 2026-09-18T16:00-2026-09-18T17:00');
    expect(draft.blocks.map((block) => block.type)).toEqual(['schedule', 'cost', 'checklist', 'note']);
    expect(draft.blocks[0]?.items.find((item) => item.key === 'event_presentation')).toMatchObject({
      value: '2026-09-18T16:00-2026-09-18T17:00',
    });
  });

  it('keeps recovery target item ids present when the scenario is materialized', () => {
    const input = createRecoveryExample();
    const scenario = buildRecoveryScenario(input);
    const source: Source = {
      id: 'source:initial_conditions',
      text: scenario.initialText,
      title: scenario.title,
      relation: 'initial',
      targetSourceId: null,
      hash: 'hash',
      createdAt: '2026-09-17T14:00:00.000Z',
    };
    const changes = buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [source],
      draft: scenario.initialDraft(source.id),
      baseRevision: 0,
      baseSourceRevision: 1,
      id: 'cs:recovery',
    });
    const snapshot = scenario.prepareInitialSnapshot?.(resolveChangeSet(changes, emptySnapshot(), [])) ?? resolveChangeSet(changes, emptySnapshot(), []);
    const itemIds = new Set(snapshot.blocks.flatMap((block) => block.items.map((item) => item.id)));
    const result = repairSchedule(input);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    for (const action of result.actions) {
      if (action.kind === 'reschedule') expect(itemIds.has(action.itemId ?? '')).toBe(true);
    }
  });
});
