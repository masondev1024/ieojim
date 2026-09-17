import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Source } from '../../src/core/contracts';
import { buildChangeSet, resolveChangeSet } from '../../src/core/engine';
import { buildRecoveryScenario, createRecoveryExample, RECOVERY_SAMPLE_SOURCE_TEXT } from '../../src/core/schedule-recovery-sample';
import { repairSchedule } from '../../src/core/schedule-repair';
import type { RecoveryInput, ScheduleEvent } from '../../src/core/scheduling-contracts';

describe('schedule recovery boundary contracts', () => {
  it('moves a flexible task conflicting with the new presentation even when preparation already fits', () => {
    const input = createRecoveryExample();
    input.change.preparationDurationMinutes = 30;
    const flex = input.events.find((event) => event.id === 'event:expense_admin')!;
    Object.assign(flex, { start: '2026-09-18T11:00', end: '2026-09-18T11:30', movableWindow: { start: '2026-09-18T12:00', end: '2026-09-18T13:00', durationMinutes: 30 } });
    const result = repairSchedule(input);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    expect(result.after.find((event) => event.id === flex.id)).toMatchObject({ start: '2026-09-18T12:00', end: '2026-09-18T12:30' });
  });

  it('does not move an already started flexible task to manufacture a preparation slot', () => {
    const input = createRecoveryExample();
    input.now = '2026-09-17T16:00';
    input.change.preparationDurationMinutes = 60;
    Object.assign(input.events.find((event) => event.id === 'event:expense_admin')!, {
      start: '2026-09-17T15:30', end: '2026-09-17T16:30',
      movableWindow: { start: '2026-09-18T12:00', end: '2026-09-18T13:00', durationMinutes: 60 },
    });
    expect(repairSchedule(input).status).toBe('infeasible');
  });

  it('does not shorten a flexible task through a conflicting duration constraint', () => {
    const input = createRecoveryExample();
    input.events.find((event) => event.id === 'event:expense_admin')!.movableWindow!.durationMinutes = 1;
    expect(repairSchedule(input)).toMatchObject({ status: 'invalid_input', code: 'flex_duration_mismatch' });
  });

  it('returns unsupported when the repair input contains more than thirty events', () => {
    const result = repairSchedule(withExtraBusyEvents(createRecoveryExample(), 23));

    expect(result).toMatchObject({ status: 'unsupported', code: 'too_many_events' });
  });

  it('materializes every repair-supported event into schedule blocks', () => {
    const input = withExtraBusyEvents(createRecoveryExample(), 22);
    const scenario = buildRecoveryScenario(input);
    const draft = scenario.initialDraft('source:initial_conditions');

    expect(input.events).toHaveLength(30);
    expect(draft.blocks.filter((block) => block.type === 'schedule').flatMap((block) => block.items)).toHaveLength(30);
  });

  it('finds a fifteen-minute aligned preparation slot without rounding to a thirty-minute grid', () => {
    const input = createRecoveryExample({
      workWindows: [
        { label: '목요일 15분 창', start: '2026-09-17T14:15', end: '2026-09-17T16:45' },
        { label: '금요일 근무', start: '2026-09-18T09:00', end: '2026-09-18T18:00' },
      ],
      events: createRecoveryExample().events.map((event) => {
        if (event.id === 'event:thu_fixed_1400') return { ...event, start: '2026-09-17T14:15', end: '2026-09-17T14:45' };
        if (event.id === 'event:thu_fixed_1500') return { ...event, start: '2026-09-17T16:15', end: '2026-09-17T16:45' };
        if (event.id === 'event:expense_admin') return { ...event, start: '2026-09-17T14:45', end: '2026-09-17T15:15', movableWindow: { start: '2026-09-17T14:15', end: '2026-09-17T16:45', durationMinutes: 30 } };
        return event;
      }),
    });

    const result = repairSchedule({ ...input, change: { ...input.change, preparationDurationMinutes: 60 } });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    expect(result.after.find((event) => event.id === 'event:presentation_prep')).toMatchObject({ start: '2026-09-17T15:15', end: '2026-09-17T16:15' });
  });

  it('does not rely on hard-coded demo event ids when repairing the scenario', () => {
    const renamed = renameCoreEvents(createRecoveryExample());

    const result = repairSchedule(renamed);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    expect(result.actions.filter((action) => action.kind === 'reschedule').map((action) => action.eventId)).toEqual(
      expect.arrayContaining(['custom:presentation', 'custom:travel', 'custom:prep']),
    );
  });

  it('preserves completed non-target events while moving impacted target events', () => {
    const input = createRecoveryExample({
      events: [
        ...createRecoveryExample().events,
        busyEvent({
          id: 'event:completed_after_hours',
          title: '완료된 사후 정리',
          start: '2026-09-18T18:00',
          end: '2026-09-18T18:30',
          locked: false,
          completed: true,
        }),
      ],
    });

    const result = repairSchedule(input);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: 'preserve', eventId: 'event:completed_after_hours' }));
  });

  it('requires all relation kinds before automatic recovery', () => {
    const input = createRecoveryExample({
      change: { ...createRecoveryExample().change, confirmedByRelationIds: ['relation:time_change', 'relation:deadline', 'relation:travel_before'] },
    });

    expect(repairSchedule(input)).toMatchObject({ status: 'missing_information', code: 'missing_required_relation_kinds' });
  });

  it('rejects evidence whose relation id is forged even when the quote text matches', () => {
    const input = createRecoveryExample({
      events: createRecoveryExample().events.map((event) => event.id === 'event:presentation'
        ? { ...event, evidence: event.evidence.map((entry) => ({ ...entry, relationId: 'relation:deadline' })) }
        : event),
    });

    expect(repairSchedule(input)).toMatchObject({ status: 'invalid_input', code: 'invalid_evidence' });
  });

  it('rejects a computed repair that would leave a movable flex item overlapping the new presentation', () => {
    const input = createRecoveryExample({
      events: [
        ...createRecoveryExample().events,
        busyEvent({
          id: 'event:flex_collision',
          title: '옮기기 어려운 고객 확인',
          start: '2026-09-18T11:00',
          end: '2026-09-18T12:00',
          locked: false,
          movableWindow: { start: '2026-09-18T11:00', end: '2026-09-18T12:00', durationMinutes: 60 },
        }),
      ],
    });

    expect(repairSchedule(input)).toMatchObject({ status: 'infeasible', code: 'no_continuous_preparation_window' });
  });

  it('keeps all materialized recovery action item ids stable in the resolved snapshot', () => {
    const input = withExtraBusyEvents(createRecoveryExample(), 22);
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
      id: 'cs:recovery-boundary',
    });
    const snapshot = scenario.prepareInitialSnapshot?.(resolveChangeSet(changes, emptySnapshot(), [])) ?? resolveChangeSet(changes, emptySnapshot(), []);
    const itemIds = new Set(snapshot.blocks.flatMap((block) => block.items.map((item) => item.id)));
    const result = repairSchedule(input);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    expect(result.actions.filter((action) => action.kind === 'reschedule').every((action) => itemIds.has(action.itemId ?? ''))).toBe(true);
  });
});

function withExtraBusyEvents(input: RecoveryInput, count: number): RecoveryInput {
  return {
    ...input,
    events: [
      ...input.events,
      ...Array.from({ length: count }, (_, index) => busyEvent({
        id: `event:extra_busy_${index}`,
        title: `추가 보호 일정 ${index + 1}`,
        start: `2026-09-19T${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 === 0 ? '00' : '30'}`,
        end: `2026-09-19T${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 === 0 ? '30' : '59'}`,
      })),
    ],
  };
}

function busyEvent(overrides: Partial<ScheduleEvent>): ScheduleEvent {
  return {
    id: 'event:extra',
    title: '추가 일정',
    kind: 'busy',
    start: '2026-09-19T00:00',
    end: '2026-09-19T00:30',
    locked: true,
    completed: false,
    moved: false,
    evidence: [],
    movableWindow: null,
    ...overrides,
    itemId: overrides.itemId ?? `item:recovery_schedule:${String(overrides.id ?? 'event_extra').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
  };
}

function renameCoreEvents(input: RecoveryInput): RecoveryInput {
  const replacements = new Map([
    ['event:presentation', 'custom:presentation'],
    ['event:presentation_travel', 'custom:travel'],
    ['event:presentation_prep', 'custom:prep'],
  ]);
  const rename = (id: string) => replacements.get(id) ?? id;
  return {
    ...input,
    events: input.events.map((event) => {
      const id = rename(event.id);
      return { ...event, id, itemId: `item:recovery_schedule:${id.replace(/[^a-zA-Z0-9_-]/g, '_')}` };
    }),
    relations: input.relations.map((relation) => ({
      ...relation,
      fromEventId: rename(relation.fromEventId),
      toEventId: relation.toEventId ? rename(relation.toEventId) : null,
    })),
    change: {
      ...input.change,
      presentationEventId: 'custom:presentation',
      travelEventId: 'custom:travel',
      preparationEventId: 'custom:prep',
    },
    sources: [{ id: 'source:presentation_change', text: RECOVERY_SAMPLE_SOURCE_TEXT }],
  };
}
