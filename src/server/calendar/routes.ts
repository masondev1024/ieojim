import type { Hono } from 'hono';
import { calendarAdoptSchema, calendarConnectSchema, calendarEmptyBodySchema, type CalendarConnectionSummary } from '../../core/calendar-contracts';
import { authorizedDatabase } from '../authorized-database';
import { authConfiguration, resolveAccountSession } from '../auth';
import { ApiException } from '../errors';
import { admitPublicRequest, readJson, type AppBindings, type AppContext, type AppVariables } from '../http';
import { adoptUncertainCalendar, beginCalendarOAuth, bootstrapCalendar, calendarStatus, completeCalendarOAuth, disconnectCalendar } from './store';

export function mountCalendarRoutes(app: Hono<{ Bindings: AppBindings; Variables: AppVariables }>): void {
  app.get('/api/calendar/status', async (c) => {
    if (!authConfiguration(c.env)) return c.json(notConfiguredSummary());
    const session = await requireCalendarSession(c);
    return c.json(await calendarStatus(c.env, calendarDB(c, session), session.user.id));
  });

  app.post('/api/calendar/connect', async (c) => {
    const input = await readJson(c, calendarConnectSchema);
    const session = await requireCalendarSession(c);
    return c.json(await beginCalendarOAuth(c.env, calendarDB(c, session), session.user.id, session.sessionId, input));
  });

  app.post('/api/calendar/connect-email', async (c) => {
    await readJson(c, calendarEmptyBodySchema);
    const session = await requireCalendarSession(c);
    return c.json(await beginCalendarOAuth(c.env, calendarDB(c, session), session.user.id, session.sessionId, { includeEmail: true }));
  });

  app.get('/api/calendar/callback', async (c) => {
    await admitPublicRequest(c, 'calendar-oauth-callback');
    const state = c.req.query('state');
    const code = c.req.query('code');
    const origin = authConfiguration(c.env)?.origin ?? new URL(c.req.url).origin;
    if (!state || !code) return c.redirect(`${origin}/recovery?calendar=error`);
    try {
      const session = await requireCalendarSession(c);
      await completeCalendarOAuth(c.env, calendarDB(c, session), session.user.id, session.sessionId, state, code);
      return c.redirect(`${origin}/recovery?calendar=connected`);
    } catch {
      return c.redirect(`${origin}/recovery?calendar=error`);
    }
  });

  app.post('/api/calendar/bootstrap', async (c) => {
    await readJson(c, calendarEmptyBodySchema);
    const session = await requireCalendarSession(c);
    const result = await bootstrapCalendar(c.env, calendarDB(c, session), session.user.id);
    return c.json({ ...result.summary, created: result.created });
  });

  app.post('/api/calendar/adopt', async (c) => {
    const input = await readJson(c, calendarAdoptSchema);
    const session = await requireCalendarSession(c);
    return c.json(await adoptUncertainCalendar(c.env, calendarDB(c, session), session.user.id, input.calendarId));
  });

  app.post('/api/calendar/disconnect', async (c) => {
    await readJson(c, calendarEmptyBodySchema);
    const session = await requireCalendarSession(c);
    const summary = await disconnectCalendar(c.env, calendarDB(c, session), session.user.id);
    return c.json({ ...summary, disconnected: true });
  });
}

async function requireCalendarSession(c: AppContext) {
  const session = await resolveAccountSession(c.env, c.req.raw);
  if (!session) throw new ApiException('LOGIN_REQUIRED', '로그인 후 이용할 수 있습니다.', 401);
  return session;
}

function calendarDB(c: AppContext, session: Awaited<ReturnType<typeof requireCalendarSession>>): D1Database {
  return authorizedDatabase(c.env.DB, { kind: 'account', accountId: session.user.id, sessionId: session.sessionId });
}

function notConfiguredSummary(): CalendarConnectionSummary {
  return {
    configured: false,
    status: 'not_configured',
    provider: 'google',
    connectionId: null,
    version: null,
    calendarId: null,
    calendarSummary: null,
    scopes: [],
    updatedAt: null,
  };
}
