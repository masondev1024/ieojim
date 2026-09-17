import { describe, expect, it } from 'vitest';
import { JsonObjectStreamParser, isScheduledCronProjection, projectTailEvent, retainObservationSample, type SafeProjection } from '../../scripts/observe-staging';

describe('staging tail observer', () => {
  it('parses fragmented pretty JSON without leaking request headers or cookies', () => {
    const raw = JSON.stringify({
      outcome: 'ok',
      eventTimestamp: 1790000000000,
      event: {
        request: {
          url: 'https://staging.example.test/api/workspaces',
          headers: { cookie: 'ieojim_owner=secret', authorization: 'Bearer secret' },
          body: 'private body',
        },
      },
      logs: [{
        level: 'info',
        message: [JSON.stringify({
          event: 'run_lifecycle',
          runId: 'run_1',
          workspaceId: 'workspace_1',
          status: 'ready',
          outcome: 'published',
          durationMs: 42,
          errorName: 'Ignored',
          requestHeaders: { cookie: 'secret' },
        })],
      }],
    }, null, 2);
    const parser = new JsonObjectStreamParser();
    const parsed = [
      ...parser.feed(raw.slice(0, 17)),
      ...parser.feed(raw.slice(17, 91)),
      ...parser.feed(raw.slice(91)),
    ];

    expect(parsed).toHaveLength(1);
    const projected = projectTailEvent(parsed[0]);

    expect(projected).toMatchObject({
      invocation: { type: 'fetch', outcome: 'ok', observedAt: '2026-09-21T14:13:20.000Z' },
      telemetry: [{ event: 'run_lifecycle', runId: 'run_1', workspaceId: 'workspace_1', status: 'ready', outcome: 'published', durationMs: 42 }],
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('cookie');
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('private body');
    expect(serialized).not.toContain('requestHeaders');
  });

  it('classifies real scheduled telemetry and keeps only allowed cron and ops fields', () => {
    const projected = projectTailEvent({
      outcome: 'ok',
      eventTimestamp: '2026-09-09T00:00:00.000Z',
      event: { cron: '*/5 * * * *', scheduledTime: 1788912000000 },
      logs: [{
        message: [
          JSON.stringify({ event: 'cron_recovery', outcome: 'completed', timedOutRuns: 0, expiredWorkspaces: 0, pendingRuns: 1, redispatchedRuns: 1, failedRedispatches: 0, durationMs: 12, workspaceTitle: 'private' }),
          JSON.stringify({ event: 'ops_health', outcome: 'evaluated', severity: 'warning', checks: ['pending_age_warning'], operatorReviewRequired: false, observedAt: '2026-09-09T00:00:00.000Z', pendingRuns: 1, durationMs: 4, request: { headers: 'secret' } }),
        ],
      }],
    });

    expect(projected?.invocation.type).toBe('scheduled');
    expect(isScheduledCronProjection(projected!)).toBe(true);
    expect(projected?.telemetry).toEqual([
      { event: 'cron_recovery', outcome: 'completed', timedOutRuns: 0, expiredWorkspaces: 0, pendingRuns: 1, redispatchedRuns: 1, failedRedispatches: 0, durationMs: 12 },
      { event: 'ops_health', outcome: 'evaluated', severity: 'warning', checks: ['pending_age_warning'], operatorReviewRequired: false, observedAt: '2026-09-09T00:00:00.000Z', pendingRuns: 1, durationMs: 4 },
    ]);
    expect(JSON.stringify(projected)).not.toContain('private');
    expect(JSON.stringify(projected)).not.toContain('secret');
  });

  it('distinguishes queue invocations and ignores non-telemetry log payloads', () => {
    const projected = projectTailEvent({
      outcome: 'ok',
      event: { queue: 'ieojim-runs-staging', batchSize: 1 },
      logs: [
        { message: ['plain text', JSON.stringify({ event: 'unknown', cookie: 'secret' })] },
        { message: [JSON.stringify({ event: 'run_lifecycle', runId: 'run_2', status: 'running', outcome: 'claimed', reservedMicroUsd: 3752 })] },
      ],
    });

    expect(projected?.invocation.type).toBe('queue');
    expect(projected?.telemetry).toEqual([{ event: 'run_lifecycle', runId: 'run_2', status: 'running', outcome: 'claimed', reservedMicroUsd: 3752 }]);
    expect(JSON.stringify(projected)).not.toContain('secret');
  });

  it('retains the terminal cron sample after more than twenty earlier fetch samples', () => {
    const samples: SafeProjection[] = [];
    for (let index = 0; index < 25; index += 1) {
      retainObservationSample(samples, { invocation: { type: 'fetch', outcome: 'ok' }, telemetry: [] });
    }
    retainObservationSample(samples, {
      invocation: { type: 'scheduled', outcome: 'ok' },
      telemetry: [{ event: 'cron_recovery', outcome: 'completed', timedOutRuns: 1, expiredWorkspaces: 0, pendingRuns: 0, redispatchedRuns: 0, failedRedispatches: 0, durationMs: 1 }],
    });

    expect(samples).toHaveLength(20);
    expect(samples.at(-1)?.invocation.type).toBe('scheduled');
    expect(samples.flatMap((sample) => sample.telemetry)).toContainEqual(expect.objectContaining({ event: 'cron_recovery', outcome: 'completed' }));
  });
});
