import type { Hono } from 'hono';
import { applyRecoverySchema, createRecoverySchema, emailRecoverySchema, executeRecoverySchema, previewRecoverySchema } from '../../core/recovery-api-contracts';
import { noticeRecoveryRequestSchema } from '../../core/notice-recovery';
import { checkCalendarVerificationSchema, configureCalendarWatchSchema } from '../../core/recovery-verification-contracts';
import { ApiException } from '../errors';
import { readJson, workspaceOwnerMiddleware, type AppBindings, type AppContext, type AppVariables } from '../http';
import { proposeRecoveryAction, type RecoveryActionDeps } from './actions';
import { NoticeRecoveryStore } from './notice-store';
import { RecoveryStore } from './store';
import { checkCalendarVerification, configureCalendarWatch } from './verification';

export function mountRecoveryRoutes(app: Hono<{ Bindings: AppBindings; Variables: AppVariables }>, deps: RecoveryActionDeps = {}): void {
  app.post('/api/recovery/workspaces', async (c) => {
    const command = await readJson(c, createRecoverySchema);
    return c.json(await store(c).create(c.var.owner, command.input, command.requestId), 201);
  });
  app.get('/api/workspaces/:id/recovery', workspaceOwnerMiddleware, async (c) => c.json(await store(c).read(c.var.owner.id, c.req.param('id'))));
  app.post('/api/workspaces/:id/recovery/preview', workspaceOwnerMiddleware, async (c) => {
    return c.json(await store(c).preview(c.var.owner.id, c.req.param('id'), await readJson(c, previewRecoverySchema)));
  });
  app.post('/api/workspaces/:id/recovery/apply', workspaceOwnerMiddleware, async (c) => {
    return c.json(await store(c).apply(c.var.owner.id, c.req.param('id'), await readJson(c, applyRecoverySchema)));
  });
  app.post('/api/workspaces/:id/recovery/from-notice', workspaceOwnerMiddleware, async (c) => {
    return c.json(await noticeStore(c).create(c.var.owner, c.req.param('id'), await readJson(c, noticeRecoveryRequestSchema)), 201);
  });
  app.post('/api/workspaces/:id/recovery/verification', workspaceOwnerMiddleware, async (c) => {
    if (!c.var.accountSession) throw new ApiException('ACCOUNT_REQUIRED', 'Calendar 재확인은 로그인한 계정에서 사용할 수 있습니다.', 401);
    return c.json(await checkCalendarVerification({ ...c.env, DB: c.var.requestDB }, c.var.owner.id,
      c.var.accountSession.user.id, c.req.param('id'), await readJson(c, checkCalendarVerificationSchema), deps));
  });
  app.post('/api/workspaces/:id/recovery/watch', workspaceOwnerMiddleware, async (c) => {
    if (!c.var.accountSession) throw new ApiException('ACCOUNT_REQUIRED', 'Calendar 반복 확인은 로그인한 계정에서 설정해 주세요.', 401);
    return c.json(await configureCalendarWatch({ ...c.env, DB: c.var.requestDB }, c.var.owner.id,
      c.var.accountSession.user.id, c.req.param('id'), await readJson(c, configureCalendarWatchSchema), deps));
  });
  for (const kind of ['calendar', 'email'] as const) {
    app.post(`/api/workspaces/:id/recovery/${kind}`, workspaceOwnerMiddleware, async (c) => {
      if (!c.var.accountSession) throw new ApiException('ACCOUNT_REQUIRED', '외부 반영은 로그인한 계정에서 승인해 주세요.', 401);
      const command = kind === 'email' ? await readJson(c, emailRecoverySchema) : await readJson(c, executeRecoverySchema);
      const env = { ...c.env, DB: c.var.requestDB };
      const view = await proposeRecoveryAction(env, c.var.owner.id, c.var.accountSession.user.id, c.req.param('id'), kind, command, {
        ...deps,
        dispatch: deps.dispatch ?? (async (actionId) => {
          try { await c.env.RUN_QUEUE.send({ actionId }); }
          catch { console.warn(JSON.stringify({ event: 'recovery_dispatch_deferred', actionId })); }
        }),
      });
      return c.json(view, 202);
    });
  }
}

const store = (c: AppContext) => new RecoveryStore({ ...c.env, DB: c.var.requestDB });
const noticeStore = (c: AppContext) => new NoticeRecoveryStore({ ...c.env, DB: c.var.requestDB });
