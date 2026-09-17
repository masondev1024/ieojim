import { createApp } from './app';
import { cleanAuthenticationMetadata } from './auth-maintenance';
import { DomainError, LIMITS } from '../core/contracts';
import { corePort } from './core-port';
import { WorkspaceStore } from './db';
import { ApiException, ModelOutputError, type ModelUsage } from './errors';
import { generateProposal } from './model';
import { collectOpsHealth } from './ops-health';
import { durationSince, logCronEvent, logOpsHealthEvent, logRunEvent } from './telemetry';
import { processRecoveryAction, recoverPendingRecoveryActions } from './recovery/actions';
import { cleanCalendarOAuthStates } from './calendar/store';

const app = createApp();

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    const store = new WorkspaceStore(env);

    for (const message of batch.messages) {
      const body = message.body as { runId?: string; actionId?: string };
      if (typeof body?.actionId === 'string' && body.actionId.length <= 100) {
        await processRecoveryAction(env, body.actionId);
        message.ack();
        continue;
      }
      if (!body?.runId) {
        message.ack();
        continue;
      }
      const run = await store.claimRun(body.runId);
      if (!run) {
        logRunEvent({ event: 'run_lifecycle', runId: body.runId, status: 'skipped', outcome: 'skipped' });
        message.ack();
        continue;
      }
      logRunEvent({
        event: 'run_lifecycle',
        runId: run.id,
        workspaceId: run.workspace_id,
        status: 'running',
        outcome: 'claimed',
        durationMs: durationSince(run.created_at),
        reservedMicroUsd: run.reserved_micro_usd,
        actualMicroUsd: run.actual_micro_usd,
      });
      let knownUsage: ModelUsage | null = null;
      try {
        if (await store.hasModelBudgetPolicyViolation()) {
          throw new ApiException('MODEL_BUDGET_POLICY_VIOLATION', '모델 비용 정책 위반이 감지되어 수동 점검 전까지 라이브 실행을 중단합니다.', 503);
        }
        const context = await store.runContext(run);
        if (run.reserved_micro_usd < LIMITS.reserveMicroUsd) {
          throw new ApiException('MODEL_RESERVATION_MISMATCH', '모델 비용 기준이 변경되어 이전 예약으로 실행할 수 없습니다. 새 실행이 필요합니다.', 409);
        }
        const generated = await generateProposal({
          purpose: context.workspace.purpose,
          snapshot: context.snapshot,
          sources: context.sources,
          strategy: 'incremental',
        }, {
          apiKey: (env as Cloudflare.Env & { GEMINI_API_KEY?: string }).GEMINI_API_KEY,
          model: env.MODEL,
          beforeRequest: async (provenance) => {
            if (!await store.recordRunProvenance(run, provenance)) {
              throw new ApiException('MODEL_PROVENANCE_UNAVAILABLE', '모델 요청 추적 정보를 저장하지 못해 호출을 중단했습니다.', 503);
            }
          },
        });
        const usage = usageFromGenerated(generated);
        knownUsage = usage;
        if (await store.recordModelUsage(run, usage)) {
          await store.markRun(run.id, 'failed', '모델 비용 정책 위반이 감지되어 수동 점검 전까지 라이브 실행을 중단합니다.');
          logRunEvent({
            event: 'run_lifecycle',
            runId: run.id,
            workspaceId: run.workspace_id,
            status: 'failed',
            outcome: 'failed',
            durationMs: durationSince(run.created_at),
            reservedMicroUsd: run.reserved_micro_usd,
            actualMicroUsd: usage.costMicroUsd,
            ...usageTelemetryFields(usage),
            errorCode: 'MODEL_BUDGET_POLICY_VIOLATION',
          });
          message.ack();
          continue;
        }
        const changeSet = corePort.buildChangeSet({
          snapshot: context.snapshot,
          sources: context.sources,
          draft: generated.draft,
          baseRevision: context.workspace.revision,
          baseSourceRevision: context.workspace.source_revision,
          now: new Date().toISOString(),
        });
        const outcome = await store.completeRun(run, changeSet, generated.costMicroUsd);
        logRunEvent({
          event: 'run_lifecycle',
          runId: run.id,
          workspaceId: run.workspace_id,
          status: outcome.status,
          outcome: outcome.outcome,
          durationMs: outcome.durationMs,
          reservedMicroUsd: outcome.reservedMicroUsd,
          actualMicroUsd: outcome.actualMicroUsd,
          ...usageTelemetryFields(knownUsage),
          changesetId: outcome.changesetId,
        });
      } catch (error) {
        if (error instanceof ApiException && error.code === 'STALE_RUN_BASE') {
          await store.markRun(run.id, 'failed', '작업 공간이 실행 전 변경되어 모델 호출을 중단했습니다.');
          logRunEvent({
            event: 'run_lifecycle',
            runId: run.id,
            workspaceId: run.workspace_id,
            status: 'failed',
            outcome: 'failed',
            durationMs: durationSince(run.created_at),
            reservedMicroUsd: run.reserved_micro_usd,
            actualMicroUsd: null,
            ...usageTelemetryFields(knownUsage),
            errorCode: error.code,
          });
          message.ack();
          continue;
        }
        const observedUsage = usageFromModelError(error);
        knownUsage ??= observedUsage;
        if (observedUsage && await store.recordModelUsage(run, observedUsage)) {
          await store.markRun(run.id, 'failed', '모델 비용 정책 위반이 감지되어 수동 점검 전까지 라이브 실행을 중단합니다.');
          logRunEvent({
            event: 'run_lifecycle',
            runId: run.id,
            workspaceId: run.workspace_id,
            status: 'failed',
            outcome: 'failed',
            durationMs: durationSince(run.created_at),
            reservedMicroUsd: run.reserved_micro_usd,
            actualMicroUsd: observedUsage.costMicroUsd,
            ...usageTelemetryFields(observedUsage),
            errorCode: 'MODEL_BUDGET_POLICY_VIOLATION',
          });
          message.ack();
          continue;
        }
        if (error instanceof ApiException && ['MODEL_UNAVAILABLE', 'UNSUPPORTED_MODEL', 'MODEL_INPUT_TOO_LARGE', 'MODEL_PRICING_EXPIRED', 'MODEL_RESERVATION_MISMATCH', 'MODEL_BUDGET_POLICY_VIOLATION', 'MODEL_PROVENANCE_UNAVAILABLE'].includes(error.code)) {
          await store.markRun(run.id, 'failed', error.message);
          logRunEvent({
            event: 'run_lifecycle',
            runId: run.id,
            workspaceId: run.workspace_id,
            status: 'failed',
            outcome: 'failed',
            durationMs: durationSince(run.created_at),
            reservedMicroUsd: run.reserved_micro_usd,
            actualMicroUsd: knownUsage?.costMicroUsd ?? null,
            ...usageTelemetryFields(knownUsage),
            errorCode: error.code,
          });
          message.ack();
          continue;
        }
        if (error instanceof ModelOutputError || error instanceof DomainError) {
          // An observed response rejected by deterministic validation is a known
          // failure. Keep measured usage; do not expose model/source error text.
          await store.markRun(run.id, 'failed', 'AI가 만든 변경안의 근거나 계산을 확인하지 못해 적용하지 않았어요. 기존 내용은 그대로예요.');
          logRunEvent({
            event: 'run_lifecycle', runId: run.id, workspaceId: run.workspace_id,
            status: 'failed', outcome: 'failed', durationMs: durationSince(run.created_at),
            reservedMicroUsd: run.reserved_micro_usd, actualMicroUsd: knownUsage?.costMicroUsd ?? null,
            ...usageTelemetryFields(knownUsage), errorCode: error.code,
          });
          message.ack();
          continue;
        }
        await store.markRun(run.id, 'uncertain', 'AI 응답을 받았는지 확인하지 못했어요. 중복 호출을 막기 위해 자동으로 다시 요청하지 않아요.');
        logRunEvent({
          event: 'run_lifecycle',
          runId: run.id,
          workspaceId: run.workspace_id,
          status: 'uncertain',
          outcome: 'uncertain',
          durationMs: durationSince(run.created_at),
          reservedMicroUsd: run.reserved_micro_usd,
          actualMicroUsd: knownUsage?.costMicroUsd ?? null,
          ...usageTelemetryFields(knownUsage),
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      }
      message.ack();
    }
  },
  async scheduled(event, env, ctx) {
    const store = new WorkspaceStore(env);
    // The external-action outbox has its own recovery boundary; it must not
    // suppress the existing model run recovery if a provider is unavailable.
    ctx.waitUntil(cleanCalendarOAuthStates(env.DB).catch(() => {
      console.error(JSON.stringify({ event: 'calendar_oauth_cleanup_failed' }));
    }));
    ctx.waitUntil(recoverPendingRecoveryActions(env).then((result) => {
      console.info(JSON.stringify({ event: 'recovery_outbox', ...result }));
    }).catch(() => {
      console.error(JSON.stringify({ event: 'recovery_outbox_failed' }));
    }));
    ctx.waitUntil((async () => {
      const startedAt = Date.now();
      // Authentication cleanup must not delay or suppress paid-run recovery.
      const authCleanup = cleanAuthenticationMetadata(env.DB).catch(() => {
        console.error(JSON.stringify({ event: 'authentication_cleanup_failed' }));
      });
      let timedOutRuns = 0;
      let expiredWorkspaces = 0;
      let pendingRuns = 0;
      let redispatchedRuns = 0;
      let failedRedispatches = 0;
      let failedStage: 'mark_timed_out_runs' | 'expire_workspaces' | 'list_pending_runs' | 'redispatch_runs' | undefined;
      try {
        failedStage = 'mark_timed_out_runs';
        timedOutRuns = await store.markTimedOutRuns();
        failedStage = 'expire_workspaces';
        expiredWorkspaces = await store.expireAllWorkspaces();
        failedStage = 'list_pending_runs';
        const runIds = await store.pendingRunIds(25);
        pendingRuns = runIds.length;
        failedStage = 'redispatch_runs';
        const redispatches = await Promise.allSettled(runIds.map((runId) => env.RUN_QUEUE.send({ runId })));
        redispatchedRuns = redispatches.filter((result) => result.status === 'fulfilled').length;
        failedRedispatches = redispatches.filter((result) => result.status === 'rejected').length;
        logCronEvent({
          event: 'cron_recovery',
          outcome: failedRedispatches > 0 ? 'partial_redispatch_failure' : 'completed',
          timedOutRuns,
          expiredWorkspaces,
          pendingRuns,
          redispatchedRuns,
          failedRedispatches,
          durationMs: Date.now() - startedAt,
        });
        await logOpsHealthSafely(env, shouldReconcileStorage(event.scheduledTime));
        await authCleanup;
      } catch (error) {
        logCronEvent({
          event: 'cron_recovery',
          outcome: 'failed',
          timedOutRuns,
          expiredWorkspaces,
          pendingRuns,
          redispatchedRuns,
          failedRedispatches,
          failedStage,
          errorName: error instanceof Error ? error.name : 'unknown',
          durationMs: Date.now() - startedAt,
        });
        await logOpsHealthSafely(env, shouldReconcileStorage(event.scheduledTime));
        await authCleanup;
        throw error;
      }
    })());
  },
} satisfies ExportedHandler<Cloudflare.Env>;

const usageFromGenerated = (generated: { inputTokens: number | null; outputTokens: number | null; costMicroUsd: number }): ModelUsage => ({
  inputTokens: generated.inputTokens,
  outputTokens: generated.outputTokens,
  costMicroUsd: generated.costMicroUsd,
});

const usageFromModelError = (error: unknown): ModelUsage | null => {
  return error instanceof ModelOutputError ? error.usage : null;
};

const usageTelemetryFields = (usage: ModelUsage | null): { costSource?: 'usage_reported' | 'reserve_fallback'; inputTokens?: number | null; outputTokens?: number | null } => {
  if (!usage) return {};
  return {
    costSource: usage.inputTokens !== null && usage.outputTokens !== null ? 'usage_reported' : 'reserve_fallback',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
};

const logOpsHealthSafely = async (env: Cloudflare.Env, includeStorageReconciliation: boolean): Promise<void> => {
  const startedAt = Date.now();
  try {
    const snapshot = await collectOpsHealth(env.DB, { includeStorageReconciliation });
    logOpsHealthEvent({
      event: 'ops_health',
      outcome: 'evaluated',
      severity: snapshot.severity,
      checks: snapshot.checks,
      operatorReviewRequired: snapshot.operatorReviewRequired,
      observedAt: snapshot.observedAt,
      pendingRuns: snapshot.pendingRuns,
      oldestPendingAgeSeconds: snapshot.oldestPendingAgeSeconds,
      runningRuns: snapshot.runningRuns,
      oldestRunningAgeSeconds: snapshot.oldestRunningAgeSeconds,
      uncertainRuns: snapshot.uncertainRuns,
      modelBudgetPolicyViolations: snapshot.modelBudgetPolicyViolations,
      storageContentBytes: snapshot.storageContentBytes,
      storageMaxContentBytes: snapshot.storageMaxContentBytes,
      storageUsedRatio: snapshot.storageUsedRatio,
      storageReconciliationDeltaBytes: snapshot.storageReconciliationDeltaBytes,
      admissionsToday: snapshot.admissionsToday,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logOpsHealthEvent({
      event: 'ops_health',
      outcome: 'failed',
      severity: 'critical',
      checks: ['ops_health_collection_failed'],
      operatorReviewRequired: true,
      observedAt: new Date().toISOString(),
      errorName: error instanceof Error ? error.name : 'unknown',
      durationMs: Date.now() - startedAt,
    });
  }
};

const shouldReconcileStorage = (scheduledTime: number): boolean => {
  const scheduledAt = new Date(scheduledTime);
  return scheduledAt.getUTCHours() === 0 && scheduledAt.getUTCMinutes() < 5;
};
