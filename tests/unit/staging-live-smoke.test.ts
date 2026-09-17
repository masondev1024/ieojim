import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChangeSet, Source, WorkspaceView } from '../../src/core/contracts';
import { runStagingLiveSmoke, STAGING_ORIGIN } from '../../scripts/staging-live-smoke';

const source: Source = {
  id: 'src_live_smoke',
  title: '합성 라이브 스모크 입력',
  text: 'private source must not appear in artifacts',
  relation: 'initial',
  targetSourceId: null,
  hash: 'source-hash',
  createdAt: '2026-09-09T00:00:00.000Z',
};

const pending: ChangeSet = {
  id: 'cs_live_smoke',
  baseRevision: 0,
  baseSourceRevision: 1,
  proposalRevision: 1,
  summary: '정산 초안',
  questions: [],
  changes: [],
  conflicts: [],
  createdAt: '2026-09-09T00:00:01.000Z',
  next: {
    facts: [
      { id: 'fact:participants', key: 'participants', label: '참석자 수', value: 4, evidence: { sourceId: source.id, quote: '참석자는 4명입니다.', start: 0, end: 11 }, semantic: { kind: 'count', unit: 'person' } },
      { id: 'fact:fixed_total_cost', key: 'fixed_total_cost', label: '공동 고정비', value: 900000, evidence: { sourceId: source.id, quote: '공동 고정비는 총 900000원입니다.', start: 12, end: 31 }, semantic: { kind: 'money', unit: 'KRW' } },
    ],
    blocks: [{
      id: 'block:cost',
      key: 'cost',
      type: 'cost',
      title: '비용',
      items: [{
        id: 'item:fixed_cost_share',
        key: 'fixed_cost_share',
        label: '1인당 고정비',
        value: '225000',
        factKeys: ['fixed_total_cost', 'participants'],
        valueFactKey: 'fixed_total_cost',
        calculation: { kind: 'divide', totalFactKey: 'fixed_total_cost', divisorFactKey: 'participants' },
        completed: false,
        locked: false,
        edited: false,
        stale: false,
      }],
    }],
  },
};

function workspace(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id: 'ws_live_smoke',
    title: 'smoke',
    purpose: '여행 경비 계획',
    sampleScenario: null,
    revision: 0,
    sourceRevision: 1,
    sources: [source],
    snapshot: { facts: [], blocks: [] },
    pending: null,
    runs: [{ id: 'run_live_smoke', sourceId: source.id, status: 'pending', error: null, createdAt: '2026-09-09T00:00:00.000Z', costMicroUsd: null, mode: 'live' }],
    history: [],
    expiresAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('staging live smoke tool', () => {
  it('runs a mocked staging smoke flow and writes only safe artifact fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ieojim-staging-smoke-'));
    const calls: Array<{ url: string; method: string; cookie: string | null; body: unknown }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const cookie = new Headers(init?.headers).get('cookie');
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url, method, cookie, body });
      expect(url.startsWith(STAGING_ORIGIN)).toBe(true);
      expect(new Headers(init?.headers).get('origin')).toBe(STAGING_ORIGIN);

      if (method === 'POST' && url.endsWith('/api/workspaces')) {
        return Response.json(workspace({ sourceRevision: 0, sources: [], runs: [] }), {
          status: 201,
          headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' },
        });
      }
      if (method === 'POST' && url.endsWith('/api/workspaces/ws_live_smoke/sources')) return Response.json(workspace());
      if (method === 'GET' && url.endsWith('/api/workspaces/ws_live_smoke')) {
        if (calls.some((call) => call.method === 'DELETE')) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
        if (calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/workspaces/ws_live_smoke/apply'))) return Response.json(workspace({ revision: 1, pending: null, snapshot: pending.next }));
        const getCount = calls.filter((call) => call.method === 'GET' && call.url.endsWith('/api/workspaces/ws_live_smoke')).length;
        return Response.json(workspace(getCount < 2 ? {} : {
          pending,
          runs: [{ id: 'run_live_smoke', sourceId: source.id, status: 'ready', error: null, createdAt: '2026-09-09T00:00:00.000Z', costMicroUsd: 450, mode: 'live' }],
        }));
      }
      if (method === 'POST' && url.endsWith('/api/workspaces/ws_live_smoke/apply')) return Response.json(workspace({ pending: null }));
      if (method === 'DELETE' && url.endsWith('/api/workspaces/ws_live_smoke')) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const fetchImpl = mockFetch as unknown as typeof fetch;
    const afterApplied = vi.fn();

    try {
      const result = await runStagingLiveSmoke({ fetch: fetchImpl, artifactDir: directory, pollIntervalMs: 0, pollTimeoutMs: 1_000, afterApplied });
      expect(result).toMatchObject({ workspaceId: 'ws_live_smoke', runId: 'run_live_smoke' });
      expect(mockFetch).toHaveBeenCalledTimes(8);
      expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'GET', 'GET', 'POST', 'GET', 'DELETE', 'GET']);
      expect(calls.slice(1).every((call) => call.cookie === 'ieojim_owner=private-owner')).toBe(true);
      expect(calls[4]?.body).toMatchObject({ changeSetId: pending.id, proposalRevision: pending.proposalRevision, baseRevision: 0, baseSourceRevision: 1 });
      expect(afterApplied).toHaveBeenCalledWith({ workspaceId: 'ws_live_smoke', runId: 'run_live_smoke', artifactPath: result.artifactPath });

      const artifactText = await readFile(result.artifactPath, 'utf8');
      const artifact = JSON.parse(artifactText);
      expect(artifact).toMatchObject({
        origin: STAGING_ORIGIN,
        workspaceId: 'ws_live_smoke',
        sourceId: source.id,
        runId: 'run_live_smoke',
        run: { finalStatus: 'ready', costMicroUsd: 450, mode: 'live' },
        assertions: { typedCount: true, typedMoney: true, share225000: true, applied: true, deleted404: true, cleanupVerified: true },
        failure: null,
      });
      expect(artifactText).not.toContain('ieojim_owner=private-owner');
      expect(artifactText).not.toContain('private source must not appear');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('aborts a hung HTTP request with a safe failure reason', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ieojim-staging-smoke-'));
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    try {
      await expect(runStagingLiveSmoke({ fetch: fetchImpl, artifactDir: directory, httpTimeoutMs: 10 })).rejects.toThrow('request_timeout');
      const artifactText = await onlyArtifact(directory);
      expect(JSON.parse(artifactText)).toMatchObject({ failure: { stage: 'smoke', reason: 'request_timeout' } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('caps a hung hook and still cleans up', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ieojim-staging-smoke-'));
    const { fetchImpl } = flowFetch();
    try {
      await expect(runStagingLiveSmoke({
        fetch: fetchImpl,
        artifactDir: directory,
        pollIntervalMs: 0,
        hookTimeoutMs: 10,
        afterApplied: () => new Promise(() => undefined),
      })).rejects.toThrow('hook_timeout');
      const artifact = JSON.parse(await onlyArtifact(directory));
      expect(artifact).toMatchObject({ failure: { stage: 'smoke', reason: 'hook_timeout' }, assertions: { cleanupVerified: true } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists created workspace id before a missing cookie failure and marks cleanup unverified', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ieojim-staging-smoke-'));
    const fetchImpl = vi.fn(async () => Response.json(workspace({ sourceRevision: 0, sources: [], runs: [] }), { status: 201 })) as unknown as typeof fetch;
    try {
      await expect(runStagingLiveSmoke({ fetch: fetchImpl, artifactDir: directory })).rejects.toThrow('missing_owner_cookie');
      const artifact = JSON.parse(await onlyArtifact(directory));
      expect(artifact).toMatchObject({
        workspaceId: 'ws_live_smoke',
        failure: { stage: 'smoke', reason: 'missing_owner_cookie' },
        assertions: { cleanupVerified: false, deleted404: false },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not persist raw upstream error text or secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ieojim-staging-smoke-'));
    const fetchImpl = vi.fn(async () => {
      throw new Error('private-provider-detail ieojim_owner=secret-cookie raw-source-text');
    }) as unknown as typeof fetch;
    try {
      await expect(runStagingLiveSmoke({ fetch: fetchImpl, artifactDir: directory })).rejects.toThrow('private-provider-detail');
      const artifactText = await onlyArtifact(directory);
      expect(JSON.parse(artifactText)).toMatchObject({ failure: { stage: 'smoke', reason: 'unknown' } });
      expect(artifactText).not.toContain('private-provider-detail');
      expect(artifactText).not.toContain('ieojim_owner=secret-cookie');
      expect(artifactText).not.toContain('raw-source-text');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires the post-apply GET to show persisted revision and applied typed state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ieojim-staging-smoke-'));
    const { fetchImpl } = flowFetch({ staleAfterApply: true });
    try {
      await expect(runStagingLiveSmoke({ fetch: fetchImpl, artifactDir: directory, pollIntervalMs: 0 })).rejects.toThrow('apply_verification_failed');
      const artifact = JSON.parse(await onlyArtifact(directory));
      expect(artifact).toMatchObject({ failure: { stage: 'smoke', reason: 'apply_verification_failed' }, assertions: { applied: false, cleanupVerified: true } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports cleanup failure with a fixed reason', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ieojim-staging-smoke-'));
    const { fetchImpl } = flowFetch({ cleanupStatus: 500 });
    try {
      await expect(runStagingLiveSmoke({ fetch: fetchImpl, artifactDir: directory, pollIntervalMs: 0 })).rejects.toThrow('http_error');
      const artifact = JSON.parse(await onlyArtifact(directory));
      expect(artifact).toMatchObject({ failure: { stage: 'cleanup', reason: 'cleanup_failed' }, assertions: { applied: true, cleanupVerified: false } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function flowFetch(options: { staleAfterApply?: boolean; cleanupStatus?: number } = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'POST' && url.endsWith('/api/workspaces')) {
      return Response.json(workspace({ sourceRevision: 0, sources: [], runs: [] }), { status: 201, headers: { 'set-cookie': 'ieojim_owner=private-owner; Path=/; HttpOnly' } });
    }
    if (method === 'POST' && url.endsWith('/api/workspaces/ws_live_smoke/sources')) return Response.json(workspace());
    if (method === 'GET' && url.endsWith('/api/workspaces/ws_live_smoke')) {
      if (calls.some((call) => call.method === 'DELETE')) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
      if (calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/workspaces/ws_live_smoke/apply'))) {
        return Response.json(options.staleAfterApply ? workspace({ pending }) : workspace({ revision: 1, pending: null, snapshot: pending.next }));
      }
      return Response.json(workspace({ pending, runs: [{ id: 'run_live_smoke', sourceId: source.id, status: 'ready', error: null, createdAt: '2026-09-09T00:00:00.000Z', costMicroUsd: 450, mode: 'live' }] }));
    }
    if (method === 'POST' && url.endsWith('/api/workspaces/ws_live_smoke/apply')) return Response.json(workspace({ pending: null }));
    if (method === 'DELETE' && url.endsWith('/api/workspaces/ws_live_smoke')) return new Response(null, { status: options.cleanupStatus ?? 204 });
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { fetchImpl: mockFetch as unknown as typeof fetch, calls };
}

async function onlyArtifact(directory: string): Promise<string> {
  const entries = await readdir(directory);
  const artifacts = entries.filter((entry) => entry.startsWith('staging-live-smoke-'));
  expect(artifacts).toHaveLength(1);
  return readFile(join(directory, artifacts[0]!), 'utf8');
}
