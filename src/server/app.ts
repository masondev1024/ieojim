import { Hono } from 'hono';
import {
  addSourceSchema,
  applySchema,
  createWorkspaceSchema,
  editItemSchema,
  LIMITS,
  restoreSchema,
  retrySchema,
  sampleScenarioSchema,
  sampleUpdateSchema,
  type AppConfig,
  type SampleScenarioName,
} from '../core/contracts';
import { corePort, sampleScenarios, type CorePort, type SampleScenarios } from './core-port';
import { WorkspaceStore } from './db';
import { ApiException } from './errors';
import { AccountStore } from './account-store';
import { mountAccountRoutes } from './account-routes';
import { exportWorkspace } from './workspace-export';
import { mountCalendarRoutes } from './calendar/routes';
import { mountRecoveryRoutes } from './recovery/routes';
import type { RecoveryActionDeps } from './recovery/actions';
import { admitPublicRequest, errorJson, ownerMiddleware, workspaceOwnerMiddleware, protectUnsafeRequest, readJson, type AppBindings, type AppVariables, type AppContext } from './http';

export type AppDeps = {
  core?: CorePort;
  samples?: Partial<SampleScenarios>;
  recovery?: RecoveryActionDeps;
};

export const createApp = (deps: AppDeps = {}) => {
  const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

  app.onError((error, c) => {
    const apiError = errorJson(error);
    if (apiError.status === 500) console.error(JSON.stringify({ event: 'api_error', code: apiError.body.error.code }));
    return c.json(apiError.body, apiError.status);
  });

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    await next();
  });
  app.use('/api/*', protectUnsafeRequest);
  mountAccountRoutes(app);
  mountCalendarRoutes(app);
  app.use('/api/*', ownerMiddleware);
  mountRecoveryRoutes(app, deps.recovery);

  app.get('/api/config', (c) => {
    const body: AppConfig = {
      liveAvailable: Boolean((c.env as AppBindings & { GEMINI_API_KEY?: string }).GEMINI_API_KEY),
      maxSourceChars: LIMITS.sourceChars,
      retentionDays: Math.floor(LIMITS.retentionMs / (24 * 60 * 60 * 1000)),
    };
    return c.json(body);
  });

  app.get('/api/workspaces', async (c) => {
    if (c.var.accountSession) return c.json(await new AccountStore(c.var.requestDB).listAccountWorkspaces(c.var.accountSession.user.id));
    return c.json(await store(c).listWorkspaces(c.var.owner.id));
  });

  app.post('/api/workspaces', async (c) => {
    const input = await readJson(c, createWorkspaceSchema);
    return c.json(await store(c).createWorkspace(c.var.owner.id, input.title, input.purpose, c.var.owner), 201);
  });

  app.post('/api/workspaces/sample', async (c) => {
    const input = await readJson(c, sampleScenarioSchema);
    const core = resolveCore(deps);
    return c.json(await store(c).createSample(c.var.owner.id, input.scenario, resolveSample(deps, input.scenario), core, c.var.owner), 201);
  });

  app.get('/api/workspaces/:id', workspaceOwnerMiddleware, async (c) => {
    return c.json(await store(c).getWorkspace(c.var.owner.id, c.req.param('id')));
  });

  app.get('/api/workspaces/:id/export', workspaceOwnerMiddleware, async (c) => {
    await admitPublicRequest(c, 'exports');
    const exported = await exportWorkspace(c.var.requestDB, c.var.owner.id, c.req.param('id'));
    c.header('Content-Disposition', 'attachment; filename="ieojim-workspace.json"');
    return c.json(exported);
  });

  app.delete('/api/workspaces/:id', workspaceOwnerMiddleware, async (c) => {
    await store(c).deleteWorkspace(c.var.owner.id, c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/api/workspaces/:id/sources', workspaceOwnerMiddleware, async (c) => {
    const input = await readJson(c, addSourceSchema);
    return c.json(await store(c).addSource(c.var.owner.id, c.req.param('id'), input, (runId) => dispatchOrDefer(c.env, runId)));
  });

  app.patch('/api/workspaces/:id/items', workspaceOwnerMiddleware, async (c) => {
    const input = await readJson(c, editItemSchema);
    const core = resolveCore(deps);
    return c.json(await store(c).editItem(c.var.owner.id, c.req.param('id'), input, core));
  });

  app.post('/api/workspaces/:id/apply', workspaceOwnerMiddleware, async (c) => {
    const input = await readJson(c, applySchema);
    const core = resolveCore(deps);
    return c.json(await store(c).applyChangeSet(c.var.owner.id, c.req.param('id'), input, core));
  });

  app.post('/api/workspaces/:id/restore', workspaceOwnerMiddleware, async (c) => {
    const input = await readJson(c, restoreSchema);
    return c.json(await store(c).restoreSnapshot(c.var.owner.id, c.req.param('id'), input));
  });

  app.post('/api/workspaces/:id/retry', workspaceOwnerMiddleware, async (c) => {
    const input = await readJson(c, retrySchema);
    return c.json(await store(c).retryRun(c.var.owner.id, c.req.param('id'), input.runId, input.requestId, (runId) => dispatchOrDefer(c.env, runId)));
  });

  app.post('/api/workspaces/:id/sample-update', workspaceOwnerMiddleware, async (c) => {
    const input = await readJson(c, sampleUpdateSchema);
    const workspace = await store(c).getWorkspace(c.var.owner.id, c.req.param('id'));
    if (!workspace.sampleScenario) throw new ApiException('NOT_SYNTHETIC_WORKSPACE', '샘플 업데이트는 샘플 작업 공간에서만 사용할 수 있습니다.', 422);
    const core = resolveCore(deps);
    return c.json(await store(c).createSampleUpdate(c.var.owner.id, c.req.param('id'), input.step, input.requestId, resolveSample(deps, workspace.sampleScenario), core));
  });

  app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'API 경로를 찾을 수 없습니다.' } }, 404));
  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
};

const resolveCore = (deps: AppDeps): CorePort => deps.core ?? corePort;

const resolveSample = (deps: AppDeps, scenario: SampleScenarioName) => deps.samples?.[scenario] ?? sampleScenarios[scenario];

const store = (c: AppContext) => new WorkspaceStore({ ...c.env, DB: c.var.requestDB });

const dispatchOrDefer = async (env: AppBindings, runId: string): Promise<void> => {
  try {
    await env.RUN_QUEUE.send({ runId });
  } catch {
    // The pending run is already durable. Scheduled recovery re-delivers its ID;
    // the database claim prevents a second paid call if delivery was uncertain.
    console.warn(JSON.stringify({ event: 'run_dispatch_deferred', runId }));
  }
};
