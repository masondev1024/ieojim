import { describe, expect, it } from 'vitest';
import { GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE, GOOGLE_GMAIL_SEND_SCOPE, deterministicCalendarEventId, type CalendarProvider, type CalendarProviderResult, type ConnectedCalendarProvider, type FreeBusyResult } from '../../src/core/calendar-contracts';
import { createRecoveryExample } from '../../src/core/schedule-recovery-sample';
import { repairSchedule } from '../../src/core/schedule-repair';
import { buildCalendarPayload, buildEmailPayload } from '../../src/server/recovery/actions';

const workspace = { id: 'ws_recovery', owner_id: 'owner_1', revision: 3, source_revision: 2, deleted_at: null, expires_at: '2026-09-20T00:00:00.000Z' };
const profile = { workspace_id: workspace.id, condition_revision: 4, base_revision: 3, base_source_revision: 2, input_json: '{}', proposal_id: 'repair_1', applied_revision: 3 };
const provider: CalendarProvider = {
  freeBusy: async (): Promise<CalendarProviderResult<FreeBusyResult>> => ({ ok: true, value: { blocks: [] } }),
  listBusyEvents: async () => ({ ok: true, value: { events: [] } }) as const,
  getCalendar: async () => ({ ok: true, value: { id: 'cal_ieojim', summary: 'Ieojim', description: null } }) as const,
  getEvent: async () => ({ ok: false, error: { kind: 'not_found', status: 404, message: 'missing' } }) as const,
  insertEvent: async () => { throw new Error('not used'); },
  updateEvent: async () => { throw new Error('not used'); },
  createAppCalendar: async () => { throw new Error('not used'); },
  sendEmail: async () => { throw new Error('not used'); },
};

function connection(scopes = [GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE, GOOGLE_GMAIL_SEND_SCOPE]): ConnectedCalendarProvider {
  return { provider, connectionId: 'conn_1', version: 7, calendarId: 'cal_ieojim', scopes };
}

describe('recovery action payloads', () => {
  it('derives calendar writes only from the recomputed ready recovery result', async () => {
    const input = createRecoveryExample();
    const result = repairSchedule(input);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);

    const payload = await buildCalendarPayload({ workspace, ownerId: 'owner_1', accountId: 'acct_1', profile, input, result, connection: connection() });

    expect(payload.events.map((event) => event.itemId).sort()).toEqual([
      'item:recovery_schedule:event_expense_admin',
      'item:recovery_schedule:event_presentation',
      'item:recovery_schedule:event_presentation_prep',
      'item:recovery_schedule:event_presentation_travel',
    ].sort());
    const prep = payload.events.find((event) => event.itemId === 'item:recovery_schedule:event_presentation_prep')!;
    expect(prep.write.start).toEqual({ dateTime: '2026-09-17T15:30:00+09:00', timeZone: 'Asia/Seoul' });
    expect(prep.write.end).toEqual({ dateTime: '2026-09-17T17:00:00+09:00', timeZone: 'Asia/Seoul' });
    expect(prep.eventId).toBe(await deterministicCalendarEventId(`${workspace.id}:conn_1:item:recovery_schedule:event_presentation_prep`));
    expect(prep.write.extendedProperties.private.ieojimOperationId).toBe(`${workspace.id}:4:item:recovery_schedule:event_presentation_prep`);
    expect(prep.write.extendedProperties.private.ieojimPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.freeBusy).toEqual({ timeMin: '2026-09-17T14:00:00+09:00', timeMax: '2026-09-19T14:00:00+09:00', calendarIds: ['primary', 'cal_ieojim'] });
  });

  it('fails closed when Calendar or Gmail scopes are missing', async () => {
    const input = createRecoveryExample();
    const result = repairSchedule(input);
    if (result.status !== 'ready') throw new Error(result.message);
    await expect(buildCalendarPayload({ workspace, ownerId: 'owner_1', accountId: 'acct_1', profile, input, result, connection: connection([GOOGLE_CALENDAR_APP_CREATED_SCOPE]) })).rejects.toMatchObject({ code: 'CALENDAR_SCOPE_MISSING' });

    expect(() => buildEmailPayload({
      workspace,
      ownerId: 'owner_1',
      accountId: 'acct_1',
      profile,
      connection: connection([GOOGLE_CALENDAR_APP_CREATED_SCOPE, GOOGLE_CALENDAR_FREEBUSY_SCOPE]),
      command: { baseRevision: 3, conditionRevision: 4, requestId: '00000000-0000-4000-8000-000000000999', approved: true, recipient: 'presenter@example.com', subject: '변경 안내', body: '본문입니다.' },
    })).toThrow(expect.objectContaining({ code: 'GMAIL_SCOPE_MISSING' }));
  });

  it('preserves exact approved email recipient subject body and operation id', () => {
    const payload = buildEmailPayload({
      workspace,
      ownerId: 'owner_1',
      accountId: 'acct_1',
      profile,
      connection: connection(),
      command: { baseRevision: 3, conditionRevision: 4, requestId: '00000000-0000-4000-8000-000000000123', approved: true, recipient: 'presenter@example.com', subject: '금요일 발표 변경', body: '승인한 본문만 전송합니다.' },
    });

    expect(payload).toMatchObject({
      kind: 'email',
      workspaceId: workspace.id,
      recipient: 'presenter@example.com',
      subject: '금요일 발표 변경',
      body: '승인한 본문만 전송합니다.',
      operationId: `${workspace.id}:4:email:00000000-0000-4000-8000-000000000123`,
    });
  });
});
