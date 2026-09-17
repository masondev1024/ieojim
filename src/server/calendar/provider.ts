import { z } from 'zod';
import {
  calendarEmailSchema,
  calendarEventReadSchema,
  calendarEventWriteSchema,
  freeBusyRequestSchema,
  GOOGLE_GMAIL_SEND_SCOPE,
  type CalendarEmail,
  type CalendarBusyEvent,
  type CalendarBusyEventsRequest,
  type CalendarBusyEventsResult,
  type CalendarEventRead,
  type CalendarEventWrite,
  type CalendarProvider,
  type CalendarProviderFailure,
  type CalendarProviderResult,
  type FreeBusyRequest,
  type FreeBusyResult,
  type GmailSendResult,
} from '../../core/calendar-contracts';

type Fetcher = typeof fetch;

type GoogleProviderOptions = {
  accessToken: string;
  scopes: string[];
  fetcher?: Fetcher;
};

const eventResponseSchema = z.object({
  id: z.string(),
  etag: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  start: z.object({ dateTime: z.string().datetime({ offset: true }), timeZone: z.string().optional() }).passthrough(),
  end: z.object({ dateTime: z.string().datetime({ offset: true }), timeZone: z.string().optional() }).passthrough(),
  extendedProperties: z.object({
    private: z.record(z.string(), z.string()).optional(),
  }).optional(),
  attendees: z.array(z.unknown()).optional(),
  reminders: z.object({ useDefault: z.boolean().optional(), overrides: z.array(z.unknown()).optional() }).passthrough().optional(),
  htmlLink: z.string().url().optional(),
}).passthrough();

const freeBusyResponseSchema = z.object({
  calendars: z.record(z.string(), z.object({
    errors: z.array(z.unknown()).optional(),
    busy: z.array(z.object({ start: z.string(), end: z.string() }).strict()).max(200),
  }).passthrough()),
}).passthrough();

const calendarResponseSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().nullable().optional(),
}).passthrough();

const busyEventsResponseSchema = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(z.object({
    id: z.string().min(1),
    etag: z.string().min(1),
    status: z.string().optional(),
    transparency: z.string().optional(),
    start: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).passthrough(),
    end: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).passthrough(),
  }).passthrough()).max(250),
}).passthrough();

const gmailSendResponseSchema = z.object({ id: z.string().min(1) }).passthrough();

export function createGoogleCalendarProvider(options: GoogleProviderOptions): CalendarProvider {
  const fetcher = options.fetcher ?? fetch;
  const headers = () => ({ authorization: `Bearer ${options.accessToken}`, accept: 'application/json' });

  return {
    async freeBusy(input: FreeBusyRequest): Promise<CalendarProviderResult<FreeBusyResult>> {
      const parsed = freeBusyRequestSchema.parse(input);
      return requestJson(fetcher, 'https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          timeMin: parsed.timeMin,
          timeMax: parsed.timeMax,
          items: parsed.calendarIds.map((id) => ({ id })),
        }),
        redirect: 'manual',
      }, freeBusyResponseSchema, (response) => ({
        blocks: normalizeFreeBusy(parsed.calendarIds, response),
      }));
    },

    async getCalendar(calendarId: string): Promise<CalendarProviderResult<{ id: string; summary: string; description: string | null }>> {
      return requestJson(fetcher, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, {
        method: 'GET',
        headers: headers(),
        redirect: 'manual',
      }, calendarResponseSchema, (calendar) => ({ id: calendar.id, summary: calendar.summary, description: calendar.description ?? null }));
    },

    async listBusyEvents(calendarId: string, input: CalendarBusyEventsRequest): Promise<CalendarProviderResult<CalendarBusyEventsResult>> {
      const parsed = z.object({
        timeMin: z.string().datetime({ offset: true }),
        timeMax: z.string().datetime({ offset: true }),
      }).strict().refine((request) => Date.parse(request.timeMin) < Date.parse(request.timeMax), 'timeMax must be after timeMin').parse(input);
      const url = new URL(eventsUrl(calendarId));
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('showDeleted', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '250');
      url.searchParams.set('timeMin', parsed.timeMin);
      url.searchParams.set('timeMax', parsed.timeMax);
      return requestJson(fetcher, url.toString(), {
        method: 'GET',
        headers: headers(),
        redirect: 'manual',
      }, busyEventsResponseSchema, normalizeBusyEvents);
    },

    async getEvent(calendarId: string, eventId: string): Promise<CalendarProviderResult<CalendarEventRead>> {
      return requestJson(fetcher, eventUrl(calendarId, eventId), { method: 'GET', headers: headers(), redirect: 'manual' }, eventResponseSchema, normalizeEvent);
    },

    async insertEvent(calendarId: string, event: CalendarEventWrite): Promise<CalendarProviderResult<CalendarEventRead>> {
      const parsed = calendarEventWriteSchema.parse(event);
      return requestJson(fetcher, `${eventsUrl(calendarId)}?sendUpdates=none`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ ...parsed, reminders: { useDefault: false } }),
        redirect: 'manual',
      }, eventResponseSchema, normalizeEvent);
    },

    async updateEvent(calendarId: string, eventId: string, event: CalendarEventWrite, etag: string): Promise<CalendarProviderResult<CalendarEventRead>> {
      const parsed = calendarEventWriteSchema.parse(event);
      return requestJson(fetcher, `${eventUrl(calendarId, eventId)}?sendUpdates=none`, {
        method: 'PUT',
        headers: { ...headers(), 'content-type': 'application/json', 'if-match': etag },
        body: JSON.stringify({ ...parsed, reminders: { useDefault: false } }),
        redirect: 'manual',
      }, eventResponseSchema, normalizeEvent);
    },

    async createAppCalendar(summary: string, marker: string): Promise<CalendarProviderResult<{ id: string; summary: string; description: string | null }>> {
      return requestJson(fetcher, 'https://www.googleapis.com/calendar/v3/calendars', {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ summary, description: marker, timeZone: 'Asia/Seoul' }),
        redirect: 'manual',
      }, calendarResponseSchema, (calendar) => ({ id: calendar.id, summary: calendar.summary, description: calendar.description ?? null }));
    },

    async sendEmail(input: CalendarEmail): Promise<CalendarProviderResult<GmailSendResult>> {
      const parsed = calendarEmailSchema.parse(input);
      if (!options.scopes.includes(GOOGLE_GMAIL_SEND_SCOPE)) {
        return failure('forbidden', 403, 'Gmail send scope has not been explicitly granted.');
      }
      const body = base64MimeText(parsed.body);
      const raw = base64Url(new TextEncoder().encode([
        'MIME-Version: 1.0',
        `To: ${parsed.to}`,
        `Subject: ${encodeHeader(parsed.subject)}`,
        `X-Ieojim-Operation-Id: ${sanitizeHeader(parsed.operationId)}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        body,
      ].join('\r\n')));
      return requestJson(fetcher, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
        redirect: 'manual',
      }, gmailSendResponseSchema, (response) => ({ providerMessageId: response.id, acceptedAt: new Date().toISOString() }));
    },
  };
}

async function requestJson<TWire, TValue>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  schema: z.ZodType<TWire>,
  normalize: (wire: TWire) => TValue,
): Promise<CalendarProviderResult<TValue>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(8000) });
  } catch {
    return failure('unknown', null, 'Provider request outcome is unknown.');
  }
  if (!response.ok) return failure(statusKind(response.status), response.status, 'Provider rejected the request.');
  let raw: unknown;
  try { raw = await response.json(); }
  catch { return failure('invalid_provider_response', response.status, 'Provider response was not valid JSON.'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return failure('invalid_provider_response', response.status, 'Provider response did not match the expected contract.');
  try {
    return { ok: true, value: normalize(parsed.data) };
  } catch (error) {
    if (error instanceof ProviderNormalizationError) return failure(error.kind, response.status, error.message);
    return failure('invalid_provider_response', response.status, 'Provider response did not match the expected contract.');
  }
}

function normalizeEvent(wire: z.infer<typeof eventResponseSchema>): CalendarEventRead {
  if ((wire.attendees?.length ?? 0) > 0 || wire.reminders?.useDefault === true || (wire.reminders?.overrides?.length ?? 0) > 0) {
    throw new ProviderNormalizationError('conflict', 'Provider event now contains attendees or reminders outside Ieojim control.');
  }
  return calendarEventReadSchema.parse({
    id: wire.id,
    etag: wire.etag,
    summary: wire.summary,
    description: wire.description,
    start: { dateTime: wire.start.dateTime, timeZone: wire.start.timeZone ?? 'Asia/Seoul' },
    end: { dateTime: wire.end.dateTime, timeZone: wire.end.timeZone ?? 'Asia/Seoul' },
    extendedProperties: { private: wire.extendedProperties?.private ?? {} },
    htmlLink: wire.htmlLink,
  });
}

function normalizeFreeBusy(calendarIds: string[], wire: z.infer<typeof freeBusyResponseSchema>): FreeBusyResult['blocks'] {
  for (const calendarId of calendarIds) {
    const calendar = wire.calendars[calendarId];
    if (!calendar || (calendar.errors?.length ?? 0) > 0) {
      throw new ProviderNormalizationError('invalid_provider_response', 'Provider did not return a complete freeBusy result.');
    }
  }
  return Object.entries(wire.calendars).flatMap(([calendarId, calendar]) => {
    if (!calendarIds.includes(calendarId)) return [];
    return calendar.busy.map((block) => {
      const parsed = z.object({
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
      }).strict().refine((value) => Date.parse(value.start) < Date.parse(value.end), 'busy end must be after start').parse(block);
      return { calendarId, start: parsed.start, end: parsed.end };
    });
  });
}

function normalizeBusyEvents(wire: z.infer<typeof busyEventsResponseSchema>): CalendarBusyEventsResult {
  if (wire.nextPageToken) {
    throw new ProviderNormalizationError('invalid_provider_response', 'Provider event inventory exceeded the bounded page size.');
  }
  return { events: wire.items.flatMap((item): CalendarBusyEvent[] => {
    if (item.status === 'cancelled' || item.transparency === 'transparent') return [];
    if (item.start.date || item.end.date || !item.start.dateTime || !item.end.dateTime) {
      throw new ProviderNormalizationError('invalid_provider_response', 'Provider returned an all-day or ambiguous event in the execution window.');
    }
    const parsed = z.object({
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
    }).strict().refine((value) => Date.parse(value.start) < Date.parse(value.end), 'event end must be after start').parse({
      start: item.start.dateTime,
      end: item.end.dateTime,
    });
    return [{
      id: item.id,
      etag: item.etag,
      start: parsed.start,
      end: parsed.end,
      status: item.status,
      transparent: item.transparency === 'transparent',
    }];
  }) };
}

class ProviderNormalizationError extends Error {
  constructor(public readonly kind: CalendarProviderFailure['error']['kind'], message: string) {
    super(message);
    this.name = 'ProviderNormalizationError';
  }
}

function eventsUrl(calendarId: string): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

function eventUrl(calendarId: string, eventId: string): string {
  return `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
}

function statusKind(status: number): CalendarProviderFailure['error']['kind'] {
  if (status === 401) return 'reauth_required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'duplicate';
  if (status === 412) return 'stale';
  return 'unknown';
}

function failure(kind: CalendarProviderFailure['error']['kind'], status: number | null, message: string): CalendarProviderFailure {
  return { ok: false, error: { kind, status, message } };
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeader(value: string): string {
  const clean = sanitizeHeader(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${base64Standard(new TextEncoder().encode(clean))}?=`;
}

function base64MimeText(value: string): string {
  return base64Standard(new TextEncoder().encode(value)).replace(/.{1,76}/g, '$&\r\n').trim();
}

function base64Url(bytes: Uint8Array): string {
  return base64Standard(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64Standard(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}
