import { describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarProvider } from '../../src/server/calendar/provider';

const event = {
  id: 'ieojimabcde', etag: 'etag-a', summary: '자료 준비',
  start: { dateTime: '2026-09-20T09:00:00+09:00' }, end: { dateTime: '2026-09-20T10:00:00+09:00' },
  extendedProperties: { private: { ieojimOperationId: 'op-1' } },
};

describe('verification of deleted or cancelled Google events', () => {
  it.each([{ id: event.id, status: 'cancelled' }, { ...event, status: 'cancelled' }])('never normalizes a cancelled event as a matching active event', async (wire) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire));
    const provider = createGoogleCalendarProvider({ accessToken: 'test-token', scopes: [], fetcher });
    await expect(provider.getEvent('test-calendar', event.id)).resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.method).toBe('GET');
  });
  it('treats a gone event response as missing, without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 410 }));
    const provider = createGoogleCalendarProvider({ accessToken: 'test-token', scopes: [], fetcher });
    await expect(provider.getEvent('test-calendar', event.id)).resolves.toMatchObject({ ok: false, error: { kind: 'not_found', status: 410 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not accept an event changed to tentative as approved confirmed state', async () => {
    const provider = createGoogleCalendarProvider({ accessToken: 'test-token', scopes: [], fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...event, status: 'tentative' })) });
    await expect(provider.getEvent('test-calendar', event.id)).resolves.toMatchObject({ ok: false, error: { kind: 'conflict' } });
  });
});
