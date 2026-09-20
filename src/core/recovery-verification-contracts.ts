import { z } from 'zod';

export const CALENDAR_WATCH_INTERVAL_MS = 15 * 60 * 1000;
export const CALENDAR_WATCH_DURATION_MS = 24 * 60 * 60 * 1000;
export const CALENDAR_WATCH_MAX_FAILURES = 3;

export type CalendarVerificationStatus = 'not_checked' | 'checking' | 'matched' | 'drifted' | 'unavailable' | 'stale';
export type CalendarVerificationEvent = {
  itemId: string;
  title: string;
  status: 'matched' | 'changed' | 'missing' | 'unavailable';
  differences: Array<'title' | 'time' | 'description' | 'identity' | 'version'>;
};

/** An observation of an exact approved action, not a new approval or execution. */
export type CalendarVerificationView = {
  actionId: string;
  status: CalendarVerificationStatus;
  message: string;
  checkedAt: string | null;
  events: CalendarVerificationEvent[];
  watch: {
    enabled: boolean;
    expiresAt: string | null;
    nextCheckAt: string | null;
    consecutiveFailures: number;
    stoppedReason: string | null;
  };
};

const verificationBaseSchema = z.object({
  actionId: z.string().min(1).max(100),
  baseRevision: z.number().int().nonnegative(),
  conditionRevision: z.number().int().positive(),
  requestId: z.string().uuid(),
}).strict();

export const checkCalendarVerificationSchema = verificationBaseSchema;
export const configureCalendarWatchSchema = z.discriminatedUnion('enabled', [
  verificationBaseSchema.extend({ enabled: z.literal(true), consent: z.literal(true) }).strict(),
  verificationBaseSchema.extend({ enabled: z.literal(false) }).strict(),
]);
export type CheckCalendarVerificationCommand = z.infer<typeof checkCalendarVerificationSchema>;
export type ConfigureCalendarWatchCommand = z.infer<typeof configureCalendarWatchSchema>;
