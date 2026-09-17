import { z } from 'zod';

export const GOOGLE_CALENDAR_APP_CREATED_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const GOOGLE_CALENDAR_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
export const GOOGLE_OPENID_SCOPE = 'openid';
export const GOOGLE_EMAIL_SCOPE = 'email';
export const GOOGLE_PROFILE_SCOPE = 'profile';
export const GOOGLE_GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export const googleCalendarScopes = [
  GOOGLE_OPENID_SCOPE,
  GOOGLE_EMAIL_SCOPE,
  GOOGLE_PROFILE_SCOPE,
  GOOGLE_CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_CALENDAR_FREEBUSY_SCOPE,
] as const;

export type CalendarConnectionStatus = 'not_configured' | 'not_connected' | 'connected' | 'calendar_missing' | 'needs_reauth' | 'bootstrap_uncertain';
export type CalendarProviderName = 'google';

export type CalendarConnectionSummary = {
  configured: boolean;
  status: CalendarConnectionStatus;
  provider: CalendarProviderName;
  connectionId: string | null;
  version: number | null;
  calendarId: string | null;
  calendarSummary: string | null;
  scopes: string[];
  updatedAt: string | null;
};

export type CalendarConnectResponse = { url: string };
export type CalendarBootstrapResponse = CalendarConnectionSummary & { created: boolean };
export type CalendarDisconnectResponse = CalendarConnectionSummary & { disconnected: boolean };

export const calendarEmptyBodySchema = z.object({}).strict();
export const calendarConnectSchema = z.object({ includeEmail: z.boolean().optional().default(false) }).strict();
export const calendarAdoptSchema = z.object({ calendarId: z.string().trim().min(1).max(512) }).strict();

export const calendarDateTimeSchema = z.object({
  dateTime: z.string().datetime({ offset: true }),
  timeZone: z.literal('Asia/Seoul'),
}).strict();

export const calendarEventPrivatePropertiesSchema = z.object({
  ieojimOperationId: z.string().min(1).max(160),
  ieojimPayloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const calendarEventWriteBaseSchema = z.object({
  id: z.string().min(5).max(1024).regex(/^[a-v0-9]+$/),
  summary: z.string().trim().min(1).max(160),
  description: z.string().max(1200).optional(),
  start: calendarDateTimeSchema,
  end: calendarDateTimeSchema,
  extendedProperties: z.object({ private: calendarEventPrivatePropertiesSchema }).strict(),
}).strict();
export const calendarEventWriteSchema = calendarEventWriteBaseSchema
  .refine((event) => Date.parse(event.start.dateTime) < Date.parse(event.end.dateTime), 'Calendar event end must be after start');
export type CalendarEventWrite = z.infer<typeof calendarEventWriteSchema>;

export const calendarEventReadSchema = calendarEventWriteBaseSchema.extend({
  etag: z.string().min(1).max(240),
  htmlLink: z.string().url().optional(),
}).strict().refine((event) => Date.parse(event.start.dateTime) < Date.parse(event.end.dateTime), 'Calendar event end must be after start');
export type CalendarEventRead = z.infer<typeof calendarEventReadSchema>;

export const freeBusyRequestSchema = z.object({
  timeMin: z.string().datetime({ offset: true }),
  timeMax: z.string().datetime({ offset: true }),
  calendarIds: z.array(z.string().min(1).max(512)).min(1).max(10),
}).strict().refine((request) => Date.parse(request.timeMin) < Date.parse(request.timeMax), 'freeBusy timeMax must be after timeMin');
export type FreeBusyRequest = z.infer<typeof freeBusyRequestSchema>;

export type FreeBusyBlock = { calendarId: string; start: string; end: string };
export type FreeBusyResult = { blocks: FreeBusyBlock[] };

export type CalendarBusyEvent = {
  id: string;
  etag: string;
  start: string;
  end: string;
  status?: string;
  transparent?: boolean;
};
export type CalendarBusyEventsRequest = { timeMin: string; timeMax: string };
export type CalendarBusyEventsResult = { events: CalendarBusyEvent[] };

export const calendarEmailSchema = z.object({
  to: z.string().email().max(254),
  subject: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4000),
  operationId: z.string().min(1).max(160),
}).strict();
export type CalendarEmail = z.infer<typeof calendarEmailSchema>;

export type CalendarProviderErrorKind =
  | 'not_configured'
  | 'not_connected'
  | 'calendar_missing'
  | 'reauth_required'
  | 'forbidden'
  | 'duplicate'
  | 'stale'
  | 'conflict'
  | 'not_found'
  | 'invalid_provider_response'
  | 'unknown';

export type CalendarProviderFailure = {
  ok: false;
  error: { kind: CalendarProviderErrorKind; status: number | null; message: string };
};
export type CalendarProviderSuccess<T> = { ok: true; value: T };
export type CalendarProviderResult<T> = CalendarProviderSuccess<T> | CalendarProviderFailure;

export type GmailSendResult = { providerMessageId: string; acceptedAt: string };

export type CalendarProvider = {
  freeBusy(input: FreeBusyRequest): Promise<CalendarProviderResult<FreeBusyResult>>;
  listBusyEvents(calendarId: string, input: CalendarBusyEventsRequest): Promise<CalendarProviderResult<CalendarBusyEventsResult>>;
  getCalendar(calendarId: string): Promise<CalendarProviderResult<{ id: string; summary: string; description: string | null }>>;
  getEvent(calendarId: string, eventId: string): Promise<CalendarProviderResult<CalendarEventRead>>;
  insertEvent(calendarId: string, event: CalendarEventWrite): Promise<CalendarProviderResult<CalendarEventRead>>;
  updateEvent(calendarId: string, eventId: string, event: CalendarEventWrite, etag: string): Promise<CalendarProviderResult<CalendarEventRead>>;
  createAppCalendar(summary: string, marker: string): Promise<CalendarProviderResult<{ id: string; summary: string; description: string | null }>>;
  sendEmail(input: CalendarEmail): Promise<CalendarProviderResult<GmailSendResult>>;
};

export type ConnectedCalendarProvider = {
  provider: CalendarProvider;
  connectionId: string;
  version: number;
  calendarId: string;
  scopes: string[];
};

export type ConnectedCalendarProviderResult = CalendarProviderResult<ConnectedCalendarProvider>;

export const deterministicCalendarEventId = async (operationId: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operationId));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `ieojim${hex}`;
};
