/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { WorkspaceStore } from '../../src/server/db';
import type { WorkspaceView } from '../../src/core/contracts';
import type { AppBindings } from '../../src/server/http';

const app = createApp();
const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`http://local.test${path}`, {
  method, headers: { origin: 'http://local.test', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, testEnv);
const count = async (table: 'owners' | 'workspaces' | 'sources' | 'runs' | 'snapshots') =>
  (await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

beforeEach(async () => { await reset(); await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });

describe('anonymous admission boundary', () => {
  it('does not mint owners or cookies for anonymous config and list reads', async () => {
    for (let index = 0; index < 500; index++) {
      for (const path of ['/api/config', '/api/workspaces']) {
        const response = await request(path);
        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    }
    expect(await count('owners')).toBe(0);
  });

  it('validates creation before persisting a new anonymous owner', async () => {
    const response = await request('/api/workspaces', 'POST', { title: '', purpose: 'invalid' });
    expect(response.status).toBe(422);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await count('owners')).toBe(0);
    expect(await count('workspaces')).toBe(0);
  });

  it('does not mint identity for unknown-cookie private requests', async () => {
    const response = await request('/api/workspaces/not-mine', 'DELETE', undefined, 'ieojim_owner=unknown');
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBe('ieojim_owner=; Max-Age=0; Path=/');
    expect(await count('owners')).toBe(0);
  });

  it('creates and retains one owner on the first successful mutation', async () => {
    const created = await request('/api/workspaces', 'POST', { title: 'First', purpose: 'Travel' });
    expect(created.status).toBe(201);
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toContain('ieojim_owner=');
    const listed = await request('/api/workspaces', 'GET', undefined, cookie);
    expect((await listed.json() as unknown[])).toHaveLength(1);
    expect(await count('owners')).toBe(1);
  });

  it('limits cookie churn across normal and synthetic creation without leaking rows', async () => {
    for (let index = 0; index < 100; index++) {
      expect((await request('/api/workspaces', 'POST', { title: `Trial ${index}`, purpose: 'Travel' })).status).toBe(201);
    }
    const before = { owners: await count('owners'), workspaces: await count('workspaces'), snapshots: await count('snapshots') };
    const response = await request('/api/workspaces/sample', 'POST', { scenario: 'travel' });
    expect(response.status).toBe(429);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect({ owners: await count('owners'), workspaces: await count('workspaces'), snapshots: await count('snapshots') }).toEqual(before);
    expect(await count('sources')).toBe(0);
    expect(await count('runs')).toBe(0);
  }, 30000);

  it('serializes fresh-cookie races for the last global slot', async () => {
    await testEnv.DB.prepare('UPDATE storage_policy SET max_active_workspaces = 1').run();
    const responses = await Promise.all([
      request('/api/workspaces', 'POST', { title: 'A', purpose: 'Travel' }),
      request('/api/workspaces/sample', 'POST', { scenario: 'travel' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 429]);
    expect(await count('owners')).toBe(1);
    expect(await count('workspaces')).toBe(1);
    expect((await testEnv.DB.prepare('SELECT SUM(creations) AS n FROM admission_days').first<{ n: number }>())!.n).toBe(1);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM tx_guards').first<{ n: number }>())!.n).toBe(0);
  });

  it('does not refund daily admission when a workspace is deleted', async () => {
    await testEnv.DB.prepare('UPDATE storage_policy SET max_daily_creations = 1').run();
    const created = await request('/api/workspaces', 'POST', { title: 'A', purpose: 'Travel' });
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    const view = await created.json() as WorkspaceView;
    expect((await request(`/api/workspaces/${view.id}`, 'DELETE', undefined, cookie)).status).toBe(204);
    expect((await request('/api/workspaces', 'POST', { title: 'B', purpose: 'Travel' })).status).toBe(429);
    expect(await count('owners')).toBe(1);
    expect(await count('workspaces')).toBe(0);
  });

  it('rolls back owner, admission and every sample row when content storage is full', async () => {
    await testEnv.DB.prepare('UPDATE storage_policy SET max_content_bytes = 200').run();
    const response = await request('/api/workspaces/sample', 'POST', { scenario: 'travel' });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'SERVICE_STORAGE_LIMIT' } });
    expect(response.headers.get('set-cookie')).toBeNull();
    for (const table of ['owners', 'workspaces', 'sources', 'snapshots', 'runs'] as const) expect(await count(table)).toBe(0);
    expect(await storedBytes()).toBe(0);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM admission_days').first<{ n: number }>())!.n).toBe(0);
  });

  it('bounds source and cached-response growth atomically, while deletion remains possible', async () => {
    const created = await request('/api/workspaces', 'POST', { title: 'A', purpose: '여행🙂' });
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    const view = await created.json() as WorkspaceView;
    const bytesBefore = await storedBytes();
    await testEnv.DB.prepare('UPDATE storage_policy SET max_content_bytes = ?').bind(bytesBefore + 30).run();
    const response = await request(`/api/workspaces/${view.id}/sources`, 'POST', {
      title: '원문', text: '가'.repeat(100), relation: 'initial', targetSourceId: null, requestId: crypto.randomUUID(),
    }, cookie);
    expect(response.status).toBe(429);
    expect(await storedBytes()).toBe(bytesBefore);
    expect(await count('sources')).toBe(0);
    expect(await count('runs')).toBe(0);
    const after = await (await request(`/api/workspaces/${view.id}`, 'GET', undefined, cookie)).json() as WorkspaceView;
    expect([after.revision, after.sourceRevision]).toEqual([0, 0]);
    expect((await request(`/api/workspaces/${view.id}`, 'DELETE', undefined, cookie)).status).toBe(204);
    expect(await storedBytes()).toBe(0);
  });

  it('keeps snapshots and the current revision unchanged when the history cap is reached', async () => {
    await testEnv.DB.prepare('UPDATE storage_policy SET max_workspace_snapshots = 2').run();
    const created = await request('/api/workspaces/sample', 'POST', { scenario: 'travel' });
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    const view = await created.json() as WorkspaceView;
    const response = await request(`/api/workspaces/${view.id}/items`, 'PATCH', {
      itemId: view.snapshot.blocks[0].items[0].id, value: '내 수정', baseRevision: view.revision, requestId: crypto.randomUUID(),
    }, cookie);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_HISTORY_LIMIT' } });
    const after = await (await request(`/api/workspaces/${view.id}`, 'GET', undefined, cookie)).json() as WorkspaceView;
    expect(after.snapshot).toEqual(view.snapshot);
    expect(after.revision).toBe(view.revision);
    expect(await count('snapshots')).toBe(2);
  });

  it('accounts for UTF-8 content updates and cascading deletion without counter drift', async () => {
    const created = await request('/api/workspaces/sample', 'POST', { scenario: 'travel' });
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    const view = await created.json() as WorkspaceView;
    const before = await storedBytes();
    expect((await request(`/api/workspaces/${view.id}/items`, 'PATCH', {
      itemId: view.snapshot.blocks[0].items[0].id, value: '내 계획🙂', baseRevision: view.revision, requestId: crypto.randomUUID(),
    }, cookie)).status).toBe(200);
    expect(await storedBytes()).toBeGreaterThan(before);
    expect(await storedBytes()).toBe((await testEnv.DB.prepare('SELECT content_bytes FROM content_storage_totals').first<{ content_bytes: number }>())!.content_bytes);
    expect((await request(`/api/workspaces/${view.id}`, 'DELETE', undefined, cookie)).status).toBe(204);
    expect(await storedBytes()).toBe(0);
  });

  it('cleans only expired orphan owners without any retained cost ledger', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare("INSERT INTO owners(id, token_hash, created_at, last_seen_at) VALUES ('keep', 'keep-hash', '2000-01-01', '2000-01-01')"),
      testEnv.DB.prepare("INSERT INTO owners(id, token_hash, created_at, last_seen_at) VALUES ('remove', 'remove-hash', '2000-01-01', '2000-01-01')"),
      ...['reserve', 'actual', 'policy_violation'].map((kind) => testEnv.DB.prepare("INSERT INTO budget_ledger VALUES (?, 'keep', NULL, NULL, ?, 10, '2000-01-01')").bind(kind, kind)),
    ]);
    const before = await testEnv.DB.prepare('SELECT entry_type, COUNT(*) AS n, SUM(amount_micro_usd) AS amount FROM budget_ledger GROUP BY entry_type').all();
    await new WorkspaceStore(testEnv).expireAllWorkspaces();
    expect(await count('owners')).toBe(1);
    expect(await testEnv.DB.prepare("SELECT id FROM owners WHERE id = 'keep'").first()).toMatchObject({ id: 'keep' });
    expect((await testEnv.DB.prepare('SELECT entry_type, COUNT(*) AS n, SUM(amount_micro_usd) AS amount FROM budget_ledger GROUP BY entry_type').all()).results).toEqual(before.results);
  });

  it('fails closed before writes when deployed admission is missing or denies the request', async () => {
    const remoteRequest = (requestEnv: AppBindings) => app.request('https://public.test/api/workspaces', {
      method: 'POST', headers: { origin: 'https://public.test', 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
      body: JSON.stringify({ title: 'A', purpose: 'Travel' }),
    }, requestEnv);
    expect((await remoteRequest({ ...testEnv, APP_ENV: 'production', PUBLIC_WRITES: undefined } as unknown as AppBindings)).status).toBe(503);
    expect((await remoteRequest({ ...testEnv, APP_ENV: 'prodution', PUBLIC_WRITES: { limit: async () => ({ success: true }) } } as unknown as AppBindings)).status).toBe(503);
    const response = await remoteRequest({ ...testEnv, APP_ENV: 'production', PUBLIC_WRITES: { limit: async () => ({ success: false }) } } as unknown as AppBindings);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await count('owners')).toBe(0);
  });

  it('attaches API browser protections to errors and successful public reads', async () => {
    for (const response of [await request('/api/config'), await request('/api/workspaces/unknown')]) {
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});

const storedBytes = async () => (await testEnv.DB.prepare('SELECT content_bytes FROM storage_usage WHERE id = 1').first<{ content_bytes: number }>())!.content_bytes;
