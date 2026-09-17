import { z } from 'zod';
import { evidenceSchema } from './contracts';

export const LOCAL_MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const MAX_REPAIR_EVENTS = 30;
export const MAX_REPAIR_HORIZON_MINUTES = 2 * 24 * 60;

export const scheduleRelationKindSchema = z.enum(['required_for', 'deadline', 'travel_before', 'time_change']);
export const scheduleEventKindSchema = z.enum(['fixed', 'flex', 'preparation', 'travel', 'presentation', 'busy']);
export const scheduleAuthoritySchema = z.enum(['user_confirmed', 'source_confirmed', 'ai_suggested']);
export const repairStatusSchema = z.enum(['ready', 'invalid_input', 'missing_information', 'unsupported', 'infeasible']);

export const localMinuteSchema = z.string().regex(LOCAL_MINUTE_PATTERN).refine((value) => parseLocalMinute(value) !== null, 'Expected a real local minute in YYYY-MM-DDTHH:mm format');

export const scheduleIntervalSchema = z.object({
  start: localMinuteSchema,
  end: localMinuteSchema,
}).strict().refine((value) => {
  const start = parseLocalMinute(value.start);
  const end = parseLocalMinute(value.end);
  return start !== null && end !== null && start < end;
}, 'Schedule interval end must be after start');

export const recoverySourceSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(6000),
}).strict();

export const scheduleEvidenceRefSchema = evidenceSchema.extend({
  authority: scheduleAuthoritySchema,
  relationId: z.string().min(1).max(100).nullable(),
}).strict();

export const scheduleMovableWindowSchema = scheduleIntervalSchema.extend({
  durationMinutes: z.number().int().min(1).max(24 * 60),
}).strict();

export const scheduleEventSchema = scheduleIntervalSchema.extend({
  id: z.string().min(1).max(100),
  itemId: z.string().min(1).max(100).nullable(),
  title: z.string().min(1).max(160),
  kind: scheduleEventKindSchema,
  locked: z.boolean(),
  completed: z.boolean(),
  moved: z.boolean().optional(),
  evidence: z.array(scheduleEvidenceRefSchema).max(8),
  movableWindow: scheduleMovableWindowSchema.nullable(),
}).strict();

export const scheduleWorkWindowSchema = scheduleIntervalSchema.extend({
  label: z.string().min(1).max(80),
}).strict();

export const scheduleRelationSchema = z.object({
  id: z.string().min(1).max(100),
  kind: scheduleRelationKindSchema,
  fromEventId: z.string().min(1).max(100),
  toEventId: z.string().min(1).max(100).nullable(),
  confirmed: z.boolean(),
  evidence: z.array(scheduleEvidenceRefSchema).min(1).max(8),
}).strict();

export const recoveryChangeSchema = z.object({
  presentationEventId: z.string().min(1).max(100),
  presentationInterval: scheduleIntervalSchema,
  travelEventId: z.string().min(1).max(100),
  travelDurationMinutes: z.number().int().min(1).max(24 * 60),
  preparationEventId: z.string().min(1).max(100),
  preparationDurationMinutes: z.number().int().min(1).max(24 * 60),
  preparationDeadline: localMinuteSchema,
  confirmedByRelationIds: z.array(z.string().min(1).max(100)).min(3).max(12),
}).strict();

export const recoveryInputSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).max(100),
  workspaceId: z.string().min(1).max(100),
  baseRevision: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative(),
  timezone: z.literal('Asia/Seoul'),
  sources: z.array(recoverySourceSchema).min(1).max(12),
  now: localMinuteSchema,
  horizon: scheduleIntervalSchema,
  workWindows: z.array(scheduleWorkWindowSchema).min(1).max(8),
  events: z.array(scheduleEventSchema).min(1).max(60),
  relations: z.array(scheduleRelationSchema).max(24),
  change: recoveryChangeSchema,
}).strict();

export type LocalMinute = string;
export type ScheduleInterval = z.infer<typeof scheduleIntervalSchema>;
export type RecoverySource = z.infer<typeof recoverySourceSchema>;
export type ScheduleEvidenceRef = z.infer<typeof scheduleEvidenceRefSchema>;
export type ScheduleEvent = z.infer<typeof scheduleEventSchema>;
export type ScheduleRelation = z.infer<typeof scheduleRelationSchema>;
export type RecoveryInput = z.infer<typeof recoveryInputSchema>;
export type RepairStatus = z.infer<typeof repairStatusSchema>;

export type RecoveryAction =
  | {
    kind: 'reschedule';
    eventId: string;
    itemId: string | null;
    title: string;
    before: ScheduleInterval;
    after: ScheduleInterval;
    reason: string;
    evidence: ScheduleEvidenceRef[];
  }
  | {
    kind: 'preserve';
    eventId: string;
    itemId: string | null;
    title: string;
    interval: ScheduleInterval;
    reason: string;
    evidence: ScheduleEvidenceRef[];
  };

export type RecoveryBlocker = {
  code: string;
  message: string;
  eventIds: string[];
};

export type RecoveryReadyResult = {
  status: 'ready';
  summary: string;
  timezone: 'Asia/Seoul';
  baseRevision: number;
  sourceRevision: number;
  before: ScheduleEvent[];
  after: ScheduleEvent[];
  actions: RecoveryAction[];
  blockers: [];
  metrics: {
    movedEvents: number;
    protectedEvents: number;
    preparationMinutesSecured: number;
    deadline: LocalMinute;
  };
};

export type RecoveryStoppedResult = {
  status: Exclude<RepairStatus, 'ready'>;
  code: string;
  message: string;
  blockers: RecoveryBlocker[];
};

export type RecoveryResult = RecoveryReadyResult | RecoveryStoppedResult;

export function parseLocalMinute(value: string): number | null {
  const match = LOCAL_MINUTE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  if (hour > 23 || minute > 59) return null;
  const timestamp = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  ) return null;
  return Math.floor(timestamp / 60_000);
}

export function formatLocalMinute(value: number): LocalMinute {
  const date = new Date(value * 60_000);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function intervalMinutes(interval: ScheduleInterval): number {
  const start = parseLocalMinute(interval.start);
  const end = parseLocalMinute(interval.end);
  if (start === null || end === null) return Number.NaN;
  return end - start;
}
