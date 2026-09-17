import type { RecoveryInput, ScheduleEvent, ScheduleInterval } from './scheduling-contracts';

export type ScheduleImpact = {
  directEventIds: string[];
  protectedEvents: ScheduleEvent[];
  movableCandidates: ScheduleEvent[];
  busyEvents: ScheduleEvent[];
};

export function analyzeScheduleImpact(input: RecoveryInput): ScheduleImpact {
  const directEventIds = [
    input.change.presentationEventId,
    input.change.travelEventId,
    input.change.preparationEventId,
  ];
  const direct = new Set(directEventIds);
  const protectedEvents = input.events.filter((event) => event.locked || event.completed || !direct.has(event.id));
  const movableCandidates = input.events.filter((event) =>
    event.movableWindow !== null &&
    !event.locked &&
    !event.completed &&
    event.start >= input.now &&
    !direct.has(event.id)
  );
  const busyEvents = input.events.filter((event) => !direct.has(event.id));

  return { directEventIds, protectedEvents, movableCandidates, busyEvents };
}

export function overlaps(left: ScheduleInterval, right: ScheduleInterval): boolean {
  return left.start < right.end && right.start < left.end;
}

export function containsInterval(container: ScheduleInterval, inner: ScheduleInterval): boolean {
  return container.start <= inner.start && inner.end <= container.end;
}
