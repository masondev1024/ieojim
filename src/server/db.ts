import {
  applySchema,
  emptySnapshot,
  LIMITS,
  sourceAnswerSchema,
  restoreSchema,
  type ChangeSet,
  type ItemPreparation,
  type SampleScenarioName,
  type RunStatus,
  type RunSummary,
  type Snapshot,
  type Source,
  type SourceAnswer,
  type WorkspaceSummary,
  type WorkspaceView,
} from '../core/contracts';
import type { CorePort, SampleScenario, SampleScenarioKey } from './core-port';
import { jsonHash, randomId, sha256Hex } from './crypto';
import { ApiException, budgetAdmissionError, type ModelUsage } from './errors';
import { attachRecoverySource } from '../core/recovery-lineage';
import { recoveryInputSchema } from '../core/scheduling-contracts';
import { buildRecoveryEdits } from '../core/recovery-edits';
import { expiresFrom, nowIso, parseIntEnv, type OwnerSession } from './http';
import { assertModelInputBudget, type ModelRequestProvenance } from './model';
import { recoveryOriginCurrentGuardSql } from './recovery/origin';

type WorkspaceRow = {
  id: string;
  title: string;
  purpose: string;
  revision: number;
  source_revision: number;
  current_snapshot_revision: number;
  pending_changeset_json: string | null;
  pending_proposal_revision: number;
  sample_scenario: string | null;
  updated_at: string;
  expires_at: string;
};

type SourceRow = {
  id: string;
  source_revision: number;
  title: string;
  relation: Source['relation'];
  target_source_id: string | null;
  hash: string;
  text: string;
  created_at: string;
  answer_context_json: string | null;
};

type SnapshotMetadataRow = { revision: number; reason: string; created_at: string };
type RunRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  source_id: string;
  status: RunStatus;
  mode: 'live' | 'fixture';
  error: string | null;
  created_at: string;
  updated_at: string;
  reserved_micro_usd: number;
  actual_micro_usd: number | null;
  base_revision: number;
  base_source_revision: number;
  retry_count: number;
  changeset_id: string | null;
  provenance_json?: string | null;
};
type CommandRow = { workspace_id: string; payload_hash: string; response_json: string };
type StoreEnv = Cloudflare.Env & { GEMINI_API_KEY?: string };
type BatchOutcome = { results: D1Result<unknown>[]; replay: WorkspaceView | null };
export type CompleteRunOutcome =
  | { outcome: 'published'; status: 'ready' | 'needs_input'; changesetId: string; reservedMicroUsd: number; actualMicroUsd: number; durationMs: number | null; supersededRuns: number }
  | { outcome: 'discarded'; status: 'failed'; changesetId: null; reservedMicroUsd: number; actualMicroUsd: number | null; durationMs: number | null; supersededRuns: 0 }
  | { outcome: 'ignored'; status: RunStatus | 'missing'; changesetId: string | null; reservedMicroUsd: number; actualMicroUsd: number | null; durationMs: number | null; supersededRuns: 0 };
type SnapshotCommandOptions = {
  clearPending?: boolean;
  expectedSourceRevision?: number;
  pendingChangeSetId?: string;
  pendingProposalRevision?: number;
  recoveryConditionRevision?: number;
};

export type RecoverySeed = { requestId: string; inputJson: string; proposalId: string };

const SUPERSEDED_RUN_MESSAGE = '새 제안으로 대체되어 이 실행 결과는 적용되지 않았습니다.';
const MODEL_BUDGET_POLICY_VIOLATION = 'MODEL_BUDGET_POLICY_VIOLATION';
const NO_MODEL_BUDGET_POLICY_VIOLATION_SQL = 'NOT EXISTS (SELECT 1 FROM budget_ledger WHERE entry_type = "policy_violation")';
const OWNER_BUCKET_OWNER_IDS_SQL = 'SELECT id FROM owners WHERE id = ? OR (account_id IS NOT NULL AND account_id = (SELECT account_id FROM owners WHERE id = ?))';

export type AddSourceInput = {
  title: string;
  text: string;
  relation: Source['relation'];
  targetSourceId: string | null;
  requestId: string;
  answerTo?: Omit<SourceAnswer, 'questions'>;
};

export type EditInput = {
  baseRevision: number;
  requestId: string;
  itemId: string;
  label?: string;
  value?: string;
  completed?: boolean;
  locked?: boolean;
  preparation?: ItemPreparation;
  acknowledgeReview?: true;
};

export class WorkspaceStore {
  constructor(private readonly env: StoreEnv) {}

  async listWorkspaces(ownerId: string): Promise<WorkspaceSummary[]> {
    await this.expireOwnerWorkspaces(ownerId);
    const result = await this.env.DB.prepare(
      'SELECT id, title, updated_at, revision FROM workspaces WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC',
    ).bind(ownerId).all<{ id: string; title: string; updated_at: string; revision: number }>();
    return (result.results ?? []).map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at, revision: row.revision }));
  }

  async createWorkspace(ownerId: string, title: string, purpose: string, owner?: OwnerSession): Promise<WorkspaceView> {
    await this.expireOwnerWorkspaces(ownerId);
    const now = nowIso();
    const id = randomId('ws');
    const expiresAt = expiresFrom(now);
    const guardId = randomId('guard');
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO tx_guards (id, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM workspaces WHERE owner_id IN (${OWNER_BUCKET_OWNER_IDS_SQL}) AND deleted_at IS NULL AND expires_at > ?) < 10`,
        ).bind(guardId, now, ownerId, ownerId, now),
        ...this.newOwnerStatements(ownerId, owner, guardId, now),
        this.env.DB.prepare(
          'INSERT INTO workspaces (id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, created_at, updated_at, expires_at) SELECT ?, ?, ?, ?, 0, 0, 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(id, ownerId, title, purpose, now, now, expiresAt, guardId),
        this.env.DB.prepare('INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) SELECT ?, 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
          .bind(id, JSON.stringify(emptySnapshot()), 'created', now, guardId),
        this.abortIfMissing(guardId),
        this.env.DB.prepare('DELETE FROM tx_guards WHERE id = ?').bind(guardId),
      ]);
    } catch (error) {
      if (!isTransactionAbortError(error)) throw error;
      throw new ApiException('WORKSPACE_LIMIT', '작업 공간 한도를 초과했습니다.', 429);
    }
    return this.getWorkspace(ownerId, id);
  }

  async getWorkspace(ownerId: string, workspaceId: string): Promise<WorkspaceView> {
    const row = await this.getWorkspaceRow(ownerId, workspaceId);
    return this.viewFromRow(await this.touchWorkspaceAccess(ownerId, row));
  }

  async deleteWorkspace(ownerId: string, workspaceId: string): Promise<void> {
    const row = await this.getWorkspaceRow(ownerId, workspaceId);
    await this.env.DB.prepare('DELETE FROM workspaces WHERE id = ? AND owner_id = ?')
      .bind(row.id, ownerId)
      .run();
  }

  async addSource(ownerId: string, workspaceId: string, input: AddSourceInput, enqueue: (runId: string) => Promise<void>): Promise<WorkspaceView> {
    const payloadHash = await jsonHash({ workspaceId, ...input });
    const replay = await this.replay(ownerId, input.requestId, payloadHash);
    if (replay) return replay;

    const row = await this.getWorkspaceRow(ownerId, workspaceId);
    const answerTo = this.answerContext(row, input);
    // Same words answering a different question are a distinct observation.
    const existingHash = await sha256Hex(answerTo ? JSON.stringify({ text: input.text, answerTo }) : input.text);
    const existing = await this.env.DB.prepare('SELECT id FROM sources WHERE workspace_id = ? AND hash = ?')
      .bind(workspaceId, existingHash)
      .first<{ id: string }>();
    if (existing) return this.recordIdempotent(ownerId, workspaceId, input.requestId, 'add_source_duplicate', payloadHash, await this.viewFromRow(row));

    await this.validateSourceRelation(workspaceId, row.source_revision, input.relation, input.targetSourceId);
    await this.assertSourceLimits(workspaceId, input.text);
    const now = nowIso();
    const sourceId = randomId('src');
    const runId = randomId('run');
    const nextSourceRevision = row.source_revision + 1;
    const source: Source = {
      id: sourceId,
      title: input.title,
      text: input.text,
      relation: input.relation,
      targetSourceId: input.targetSourceId,
      hash: existingHash,
      createdAt: now,
      ...(answerTo ? { answerTo } : {}),
    };

    const liveAvailable = Boolean(this.env.GEMINI_API_KEY);
    if (liveAvailable) {
      assertModelInputBudget({ purpose: row.purpose, snapshot: await this.currentSnapshot(row), sources: [...await this.listSources(row.id), source] });
    }
    const budget = liveAvailable ? await this.checkBudget(ownerId, workspaceId) : { allowed: false, reason: 'MODEL_UNAVAILABLE' };
    if (liveAvailable && !budget.allowed) throw budgetAdmissionError(budget.reason);
    const runStatus: RunStatus = liveAvailable && budget.allowed ? 'pending' : 'failed';
    const runError = liveAvailable ? budget.reason : 'GEMINI_API_KEY가 없어 라이브 AI 실행을 사용할 수 없습니다.';
    const reserved = runStatus === 'pending' ? LIMITS.reserveMicroUsd : 0;
    const currentRuns = answerTo ? (await this.listRuns(row.id)).map((run) => run.changeset_id === answerTo.changeSetId ? supersedePendingRun(run, now) : run) : undefined;
    const nextView = await this.previewViewWithSourceRun(answerTo ? { ...row, pending_changeset_json: null } : row, source, {
      id: runId,
      workspace_id: workspaceId,
      owner_id: ownerId,
      source_id: sourceId,
      status: runStatus,
      mode: 'live',
      error: runError,
      created_at: now,
      updated_at: now,
      reserved_micro_usd: reserved,
      actual_micro_usd: null,
      base_revision: row.revision,
      base_source_revision: nextSourceRevision,
      retry_count: 0,
      changeset_id: null,
    }, currentRuns);

    const guardId = randomId('guard');
    const answerGuard = answerTo ? ' AND revision = ? AND pending_proposal_revision = ? AND json_extract(pending_changeset_json, "$.id") = ?' : '';
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO tx_guards (id, created_at) SELECT ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ? AND source_revision = ?${answerGuard}`,
      ).bind(guardId, now, workspaceId, ownerId, now, row.source_revision, ...(answerTo ? [answerTo.baseRevision, answerTo.proposalRevision, answerTo.changeSetId] : [])),
    ];
    if (reserved > 0) {
      statements.push(this.env.DB.prepare(
        `INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) SELECT ?, ?, ?, ?, "reserve", ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?) AND ${NO_MODEL_BUDGET_POLICY_VIOLATION_SQL} AND (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM budget_ledger WHERE entry_type = "reserve" AND created_at >= ?) + ? <= ? AND (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM budget_ledger WHERE entry_type = "reserve") + ? <= ? AND (SELECT COUNT(*) FROM budget_ledger WHERE owner_id IN (${OWNER_BUCKET_OWNER_IDS_SQL}) AND entry_type = "reserve" AND created_at >= ?) < ?`,
      ).bind(randomId('led'), ownerId, workspaceId, runId, reserved, now, guardId, dayStart(now), reserved, parseIntEnv(this.env.DAILY_BUDGET_MICRO_USD, 500_000), reserved, parseIntEnv(this.env.TOTAL_BUDGET_MICRO_USD, 15_000_000), ownerId, ownerId, dayStart(now), parseIntEnv(this.env.OWNER_DAILY_RUNS, 10)));
    }
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at, answer_context_json) SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND source_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)${reserved > 0 ? ' AND EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ? AND entry_type = "reserve")' : ''}`,
      ).bind(...(reserved > 0
        ? [sourceId, nextSourceRevision, input.title, input.relation, input.targetSourceId, existingHash, input.text, now, answerTo ? JSON.stringify(answerTo) : null, workspaceId, ownerId, row.source_revision, guardId, runId]
        : [sourceId, nextSourceRevision, input.title, input.relation, input.targetSourceId, existingHash, input.text, now, answerTo ? JSON.stringify(answerTo) : null, workspaceId, ownerId, row.source_revision, guardId])),
      this.env.DB.prepare(
        `INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, error, request_id, payload_hash, base_revision, base_source_revision, reserved_micro_usd, created_at, updated_at) SELECT ?, id, owner_id, ?, ?, "live", ?, ?, ?, revision, ?, ?, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND source_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)${reserved > 0 ? ' AND EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ? AND entry_type = "reserve")' : ''}`,
      ).bind(...(reserved > 0
        ? [runId, sourceId, runStatus, runError, input.requestId, payloadHash, nextSourceRevision, reserved, now, now, workspaceId, ownerId, row.source_revision, guardId, runId]
        : [runId, sourceId, runStatus, runError, input.requestId, payloadHash, nextSourceRevision, reserved, now, now, workspaceId, ownerId, row.source_revision, guardId])),
      this.env.DB.prepare(
        `UPDATE workspaces SET source_revision = source_revision + 1, ${answerTo ? 'pending_changeset_json = NULL,' : ''} updated_at = ?, expires_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND source_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)${reserved > 0 ? ' AND EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ? AND entry_type = "reserve")' : ''}`,
      ).bind(...(reserved > 0
        ? [now, expiresFrom(now), workspaceId, ownerId, row.source_revision, guardId, runId]
        : [now, expiresFrom(now), workspaceId, ownerId, row.source_revision, guardId])),
      this.env.DB.prepare(
        'INSERT INTO applied_commands (id, owner_id, workspace_id, request_id, command_type, payload_hash, response_json, created_at) SELECT ?, owner_id, id, ?, ?, ?, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND source_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
      ).bind(randomId('cmd'), input.requestId, 'add_source', payloadHash, JSON.stringify(nextView), now, workspaceId, ownerId, nextSourceRevision, guardId),
      ...(answerTo ? [this.env.DB.prepare('UPDATE runs SET status = "failed", error = ?, updated_at = ? WHERE workspace_id = ? AND changeset_id = ? AND status IN ("ready", "needs_input") AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
        .bind(SUPERSEDED_RUN_MESSAGE, now, workspaceId, answerTo.changeSetId, guardId)] : []),
      this.abortIfMissing(guardId),
      ...(reserved > 0 ? [this.abortIfMissingLedger(runId)] : []),
      this.env.DB.prepare('DELETE FROM tx_guards WHERE id = ?').bind(guardId),
    );

    const outcome = await this.batchOrReplay(ownerId, input.requestId, payloadHash, statements);
    if (outcome.replay) return outcome.replay;
    const batch = outcome.results;
    const ledgerIndex = reserved > 0 ? 1 : -1;
    const sourceIndex = reserved > 0 ? 2 : 1;
    if (!changed(batch[sourceIndex])) {
      if (reserved > 0 && !changed(batch[ledgerIndex])) throw new ApiException('BUDGET_RESERVATION_FAILED', '모델 실행 예산을 예약하지 못했습니다.', 429);
      throw new ApiException('STALE_SOURCE_REVISION', '소스 목록이 변경되었습니다. 새로고침 후 다시 시도하세요.', 409);
    }
    const ledgerReserved = reserved === 0 || changed(batch[ledgerIndex]);
    if (runStatus === 'pending' && !ledgerReserved) {
      throw new ApiException('BUDGET_RESERVATION_FAILED', '모델 실행 예산을 예약하지 못했습니다.', 429);
    }
    if (runStatus === 'pending') await enqueue(runId);
    return nextView;
  }

  async editItem(ownerId: string, workspaceId: string, input: EditInput, core: CorePort): Promise<WorkspaceView> {
    const payloadHash = await jsonHash({ workspaceId, ...input });
    const replay = await this.replay(ownerId, input.requestId, payloadHash);
    if (replay) return replay;
    const row = await this.getWorkspaceRow(ownerId, workspaceId);
    if (row.revision !== input.baseRevision) throw new ApiException('STALE_REVISION', '작업 공간이 변경되었습니다. 새로고침 후 다시 시도하세요.', 409);
    const current = await this.currentSnapshot(row);
    const nextSnapshot = core.editItem(current, input);
    return this.writeSnapshotCommand(ownerId, row, input.requestId, 'edit_item', payloadHash, nextSnapshot, 'manual_edit', input.baseRevision);
  }

  async applyChangeSet(ownerId: string, workspaceId: string, input: unknown, core: CorePort): Promise<WorkspaceView> {
    const parsed = applySchema.parse(input);
    const payloadHash = await jsonHash({ workspaceId, ...parsed });
    const replay = await this.replay(ownerId, parsed.requestId, payloadHash);
    if (replay) return replay;
    const row = await this.getWorkspaceRow(ownerId, workspaceId);
    const changeSet = this.parsePending(row);
    if (!changeSet || changeSet.id !== parsed.changeSetId || changeSet.proposalRevision !== parsed.proposalRevision) {
      throw new ApiException('CHANGESET_NOT_FOUND', '적용할 제안을 찾을 수 없습니다.', 404);
    }
    if (changeSet.questions.length > 0) {
      throw new ApiException('UNANSWERED_QUESTIONS', '답해야 할 질문이 남아 있어 제안을 적용할 수 없습니다.', 422);
    }
    if (row.revision !== parsed.baseRevision || row.source_revision !== parsed.baseSourceRevision ||
        changeSet.baseRevision !== row.revision || changeSet.baseSourceRevision !== row.source_revision) {
      throw new ApiException('STALE_REVISION', '제안 기준 버전이 현재 작업 공간과 다릅니다.', 409);
    }
    const current = await this.currentSnapshot(row);
    const nextSnapshot = core.resolveChangeSet(changeSet, current, parsed.resolutions);
    return this.writeSnapshotCommand(ownerId, row, parsed.requestId, 'apply_changeset', payloadHash, nextSnapshot, 'apply_changeset', parsed.baseRevision, {
      clearPending: true,
      expectedSourceRevision: parsed.baseSourceRevision,
      pendingChangeSetId: parsed.changeSetId,
      pendingProposalRevision: parsed.proposalRevision,
    });
  }

  async restoreSnapshot(ownerId: string, workspaceId: string, input: unknown): Promise<WorkspaceView> {
    const parsed = restoreSchema.parse(input);
    const payloadHash = await jsonHash({ workspaceId, ...parsed });
    const replay = await this.replay(ownerId, parsed.requestId, payloadHash);
    if (replay) return replay;
    const row = await this.getWorkspaceRow(ownerId, workspaceId);
    if (row.revision !== parsed.baseRevision) throw new ApiException('STALE_REVISION', '작업 공간이 변경되었습니다. 새로고침 후 다시 시도하세요.', 409);
    const snapshot = await this.env.DB.prepare('SELECT snapshot_json FROM snapshots WHERE workspace_id = ? AND revision = ?')
      .bind(workspaceId, parsed.revision)
      .first<{ snapshot_json: string }>();
    if (!snapshot) throw new ApiException('SNAPSHOT_NOT_FOUND', '복원할 기록을 찾을 수 없습니다.', 404);
    return this.writeSnapshotCommand(ownerId, row, parsed.requestId, 'restore_snapshot', payloadHash, JSON.parse(snapshot.snapshot_json) as Snapshot, `restore_${parsed.revision}`, parsed.baseRevision);
  }

  async createSample(ownerId: string, scenarioKey: SampleScenarioKey | null, scenario: SampleScenario, core: CorePort, owner?: OwnerSession, recovery?: RecoverySeed): Promise<WorkspaceView> {
    const recoveryHash = recovery ? await jsonHash({ kind: 'recovery_create', input: recovery.inputJson }) : null;
    if (recovery && recoveryHash) {
      const previous = await this.replay(ownerId, recovery.requestId, recoveryHash);
      if (previous) return previous;
    }
    await this.expireOwnerWorkspaces(ownerId);
    this.assertSourceTextLimit(scenario.initialText);
    const now = nowIso();
    const workspaceId = randomId('ws');
    const sourceId = randomId('src');
    const runId = randomId('run');
    const source = await this.makeSource(sourceId, scenario.initialText, scenario.title, 'initial', null, now);
    const changeSet = core.buildChangeSet({
      snapshot: emptySnapshot(),
      sources: [source],
      draft: scenario.initialDraft(sourceId),
      baseRevision: 0,
      baseSourceRevision: 1,
      id: randomId('cs'),
      now,
    });
    const recoveryInputJson = recovery ? JSON.stringify(attachRecoverySource(recoveryInputSchema.parse({ ...JSON.parse(recovery.inputJson), workspaceId, baseRevision: 1, sourceRevision: 1 }), sourceId, source.text)) : null;
    const snapshot = scenario.prepareInitialSnapshot?.(core.resolveChangeSet(changeSet, emptySnapshot(), [])) ?? core.resolveChangeSet(changeSet, emptySnapshot(), []);
    const view = this.assembleView({
      id: workspaceId,
      title: scenario.title,
      purpose: scenario.purpose,
      revision: 1,
      source_revision: 1,
      current_snapshot_revision: 1,
      pending_changeset_json: null,
      pending_proposal_revision: 0,
      sample_scenario: scenarioKey,
      updated_at: now,
      expires_at: expiresFrom(now),
    }, [source], snapshot, [{
      id: runId,
      workspace_id: workspaceId,
      owner_id: ownerId,
      source_id: sourceId,
      status: 'applied',
      mode: 'fixture',
      error: null,
      created_at: now,
      updated_at: now,
      reserved_micro_usd: 0,
      actual_micro_usd: 0,
      base_revision: 0,
      base_source_revision: 1,
      retry_count: 0,
      changeset_id: changeSet.id,
    }], [{ revision: 0, reason: 'created', created_at: now }, { revision: 1, reason: 'sample_initial', created_at: now }]);

    const guardId = randomId('guard');
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO tx_guards (id, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM workspaces WHERE owner_id IN (${OWNER_BUCKET_OWNER_IDS_SQL}) AND deleted_at IS NULL AND expires_at > ?) < 10`,
        ).bind(guardId, now, ownerId, ownerId, now),
        ...this.newOwnerStatements(ownerId, owner, guardId, now),
        this.env.DB.prepare(
          'INSERT INTO workspaces (id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, sample_scenario, created_at, updated_at, expires_at) SELECT ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(workspaceId, ownerId, scenario.title, scenario.purpose, scenarioKey, now, now, expiresFrom(now), guardId),
        this.env.DB.prepare('INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at) SELECT ?, ?, 1, ?, "initial", NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
          .bind(sourceId, workspaceId, scenario.title, source.hash, source.text, now, guardId),
        this.env.DB.prepare('INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) SELECT ?, 0, ?, "created", ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
          .bind(workspaceId, JSON.stringify(emptySnapshot()), now, guardId),
        this.env.DB.prepare('INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) SELECT ?, 1, ?, "sample_initial", ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
          .bind(workspaceId, JSON.stringify(snapshot), now, guardId),
        this.env.DB.prepare(
          'INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, error, request_id, payload_hash, base_revision, base_source_revision, changeset_id, actual_micro_usd, created_at, updated_at) SELECT ?, ?, ?, ?, "applied", "fixture", NULL, ?, ?, 0, 1, ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(runId, workspaceId, ownerId, sourceId, randomId('req'), await jsonHash(view), changeSet.id, now, now, guardId),
        ...(recovery ? [
          this.env.DB.prepare('INSERT INTO recovery_profiles (workspace_id, condition_revision, base_revision, base_source_revision, input_json, proposal_id, applied_revision, updated_at) SELECT ?, 1, 1, 1, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
            .bind(workspaceId, recoveryInputJson, recovery.proposalId, now, guardId),
          this.env.DB.prepare('INSERT INTO recovery_versions (workspace_id, condition_revision, input_json, source_id, created_at) SELECT ?, 1, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
            .bind(workspaceId, recoveryInputJson, sourceId, now, guardId),
          this.env.DB.prepare('INSERT INTO applied_commands (id, owner_id, workspace_id, request_id, command_type, payload_hash, response_json, created_at) SELECT ?, ?, ?, ?, "recovery_create", ?, ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
            .bind(randomId('cmd'), ownerId, workspaceId, recovery.requestId, recoveryHash, JSON.stringify(view), now, guardId),
        ] : []),
        this.abortIfMissing(guardId),
        this.env.DB.prepare('DELETE FROM tx_guards WHERE id = ?').bind(guardId),
      ]);
    } catch (error) {
      if (recovery && recoveryHash && isUniqueConstraintError(error)) {
        const previous = await this.replay(ownerId, recovery.requestId, recoveryHash);
        if (previous) return previous;
      }
      if (!isTransactionAbortError(error)) throw error;
      throw new ApiException('WORKSPACE_LIMIT', '작업 공간 한도를 초과했습니다.', 429);
    }
    return view;
  }

  async applyRecoveryEdits(ownerId: string, workspaceId: string, input: {
    requestId: string; baseRevision: number; sourceRevision: number; conditionRevision: number;
    proposalId: string; edits: Array<{ itemId: string; value: string; preparation?: ItemPreparation }>;
  }, core: CorePort): Promise<WorkspaceView> {
    const payloadHash = await jsonHash({ kind: 'recovery_apply', workspaceId, ...input });
    const previous = await this.replay(ownerId, input.requestId, payloadHash);
    if (previous) return previous;
    const row = await this.getWorkspaceRow(ownerId, workspaceId);
    if (row.revision !== input.baseRevision || row.source_revision !== input.sourceRevision || row.pending_changeset_json) {
      throw new ApiException('STALE_REVISION', '기준 계획이 바뀌었습니다. 최신 조건으로 다시 검토해 주세요.', 409);
    }
    const profile = await this.env.DB.prepare('SELECT proposal_id,input_json FROM recovery_profiles WHERE workspace_id = ? AND condition_revision = ? AND base_revision = ? AND applied_revision IS NULL')
      .bind(workspaceId, input.conditionRevision, input.baseRevision).first<{ proposal_id: string; input_json: string }>();
    if (!profile || profile.proposal_id !== input.proposalId) throw new ApiException('STALE_REVISION', '검토한 일정 조건이 바뀌었습니다.', 409);
    const reason = await this.env.DB.prepare('SELECT reason FROM snapshots WHERE workspace_id=? AND revision=?').bind(workspaceId, row.current_snapshot_revision).first<string>('reason');
    if (!['sample_initial', 'notice_recovery_initial', 'recovery_approved'].includes(reason ?? '')) throw new ApiException('PROTECTED_SCHEDULE', '직접 편집하거나 복원한 계획 위에는 기존 일정 조정안을 덮어쓸 수 없습니다.', 409);
    const expected = buildRecoveryEdits(recoveryInputSchema.parse(JSON.parse(profile.input_json)));
    if (await jsonHash(expected) !== await jsonHash(input.edits)) throw new ApiException('INVALID_RECOVERY', '승인한 조건에서 계산된 값과 변경 요청이 다릅니다.', 422);
    if (input.edits.length > 31 || new Set(input.edits.map((edit) => edit.itemId)).size !== input.edits.length) throw new ApiException('INVALID_RECOVERY', '일정 변경 항목을 확인해 주세요.', 422);
    let snapshot = await this.currentSnapshot(row);
    for (const edit of input.edits) {
      const item = snapshot.blocks.flatMap((block) => block.items).find((entry) => entry.id === edit.itemId);
      if (!item || item.locked || item.completed) throw new ApiException('PROTECTED_SCHEDULE', '고정하거나 완료한 일정은 자동 배치로 변경할 수 없습니다.', 409);
      snapshot = core.editItem(snapshot, { ...edit, requestId: input.requestId, baseRevision: input.baseRevision });
    }
    return this.writeSnapshotCommand(ownerId, row, input.requestId, 'recovery_apply', payloadHash, snapshot, 'recovery_approved', input.baseRevision, {
      expectedSourceRevision: input.sourceRevision, recoveryConditionRevision: input.conditionRevision,
    });
  }

  async createSampleUpdate(ownerId: string, workspaceId: string, step: 'update' | 'conflict', requestId: string, scenario: SampleScenario, core: CorePort): Promise<WorkspaceView> {
    const payloadHash = await jsonHash({ workspaceId, step, requestId });
    const replay = await this.replay(ownerId, requestId, payloadHash);
    if (replay) return replay;
    const row = await this.getWorkspaceRow(ownerId, workspaceId);
    if (!row.sample_scenario) throw new ApiException('NOT_SYNTHETIC_WORKSPACE', '샘플 업데이트는 샘플 작업 공간에서만 사용할 수 있습니다.', 422);
    const sourceText = step === 'update' ? scenario.updateText : scenario.conflictText;
    const draft = step === 'update' ? scenario.updateDraft : scenario.conflictDraft;
    await this.assertSourceLimits(workspaceId, sourceText);
    const now = nowIso();
    const sourceId = randomId('src');
    const existingSources = await this.listSources(workspaceId);
    const source = await this.makeSource(sourceId, sourceText, step === 'update' ? 'sample update' : 'sample conflict', 'correction', existingSources[0]?.id ?? null, now);
    const sources = [...existingSources, source];
    const changeSet = core.buildChangeSet({
      snapshot: await this.currentSnapshot(row),
      sources,
      draft: draft(sourceId),
      baseRevision: row.revision,
      baseSourceRevision: row.source_revision + 1,
      id: randomId('cs'),
      now,
    });
    changeSet.proposalRevision = row.pending_proposal_revision + 1;
    const runId = randomId('run');
    const currentRuns = await this.listRuns(workspaceId);
    const supersededRuns = currentRuns.map((run) => supersedePendingRun(run, now));
    const nextView = await this.previewViewWithSourceRun({ ...row, pending_changeset_json: JSON.stringify(changeSet), pending_proposal_revision: row.pending_proposal_revision + 1 }, source, {
      id: runId,
      workspace_id: workspaceId,
      owner_id: ownerId,
      source_id: sourceId,
      status: changeSet.conflicts.length ? 'needs_input' : 'ready',
      mode: 'fixture',
      error: null,
      created_at: now,
      updated_at: now,
      reserved_micro_usd: 0,
      actual_micro_usd: 0,
      base_revision: row.revision,
      base_source_revision: row.source_revision + 1,
      retry_count: 0,
      changeset_id: changeSet.id,
    }, supersededRuns);

    const guardId = randomId('guard');
    const outcome = await this.batchOrReplay(ownerId, requestId, payloadHash, [
      this.env.DB.prepare(
        'INSERT INTO tx_guards (id, created_at) SELECT ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ? AND source_revision = ?',
      ).bind(guardId, now, workspaceId, ownerId, now, row.source_revision),
      this.env.DB.prepare(
        'INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at) SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND source_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
      ).bind(source.id, row.source_revision + 1, source.title, source.relation, source.targetSourceId, source.hash, source.text, now, workspaceId, ownerId, row.source_revision, guardId),
      this.env.DB.prepare(
        'UPDATE runs SET status = "failed", error = ?, updated_at = ? WHERE workspace_id = ? AND status IN ("ready", "needs_input") AND (changeset_id IS NULL OR changeset_id <> ?) AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
      ).bind(SUPERSEDED_RUN_MESSAGE, now, workspaceId, changeSet.id, guardId),
      this.env.DB.prepare(
        'INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, error, request_id, payload_hash, base_revision, base_source_revision, changeset_id, actual_micro_usd, created_at, updated_at) SELECT ?, id, owner_id, ?, ?, "fixture", NULL, ?, ?, revision, ?, ?, 0, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND source_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
      ).bind(runId, source.id, changeSet.conflicts.length ? 'needs_input' : 'ready', requestId, payloadHash, row.source_revision + 1, changeSet.id, now, now, workspaceId, ownerId, row.source_revision, guardId),
      this.env.DB.prepare(
        'UPDATE workspaces SET source_revision = source_revision + 1, pending_changeset_json = ?, pending_proposal_revision = pending_proposal_revision + 1, updated_at = ?, expires_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND source_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
      ).bind(JSON.stringify(changeSet), now, expiresFrom(now), workspaceId, ownerId, row.source_revision, guardId),
      this.env.DB.prepare(
        'INSERT INTO applied_commands (id, owner_id, workspace_id, request_id, command_type, payload_hash, response_json, created_at) SELECT ?, owner_id, id, ?, "sample_update", ?, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND source_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
      ).bind(randomId('cmd'), requestId, payloadHash, JSON.stringify(nextView), now, workspaceId, ownerId, row.source_revision + 1, guardId),
      this.abortIfMissing(guardId),
      this.env.DB.prepare('DELETE FROM tx_guards WHERE id = ?').bind(guardId),
    ]);
    if (outcome.replay) return outcome.replay;
    const batch = outcome.results;
    if (!changed(batch[1])) throw new ApiException('STALE_SOURCE_REVISION', '소스 목록이 변경되었습니다. 새로고침 후 다시 시도하세요.', 409);
    return nextView;
  }

  async retryRun(ownerId: string, workspaceId: string, runId: string, requestId: string, enqueue: (runId: string) => Promise<void>): Promise<WorkspaceView> {
    const payloadHash = await jsonHash({ workspaceId, runId, requestId });
    const replay = await this.replay(ownerId, requestId, payloadHash);
    if (replay) return replay;
    const row = await this.getWorkspaceRow(ownerId, workspaceId);
    const original = await this.env.DB.prepare('SELECT * FROM runs WHERE id = ? AND workspace_id = ? AND owner_id = ?')
      .bind(runId, workspaceId, ownerId)
      .first<RunRow>();
    if (!original) throw new ApiException('RUN_NOT_FOUND', '실행 기록을 찾을 수 없습니다.', 404);
    if (!['failed', 'uncertain'].includes(original.status)) throw new ApiException('RUN_NOT_RETRYABLE', '이 실행은 재시도할 수 없습니다.', 422);
    const existingRetry = await this.env.DB.prepare('SELECT id FROM runs WHERE retry_of_run_id = ?').bind(runId).first<{ id: string }>();
    if (existingRetry || original.retry_count > 0) throw new ApiException('RETRY_LIMIT_REACHED', '실패한 AI 작업을 다시 요청하는 것은 한 번만 가능해요.', 429);
    if (!this.env.GEMINI_API_KEY) throw new ApiException('MODEL_UNAVAILABLE', 'GEMINI_API_KEY가 없어 라이브 AI 실행을 사용할 수 없습니다.', 503);
    assertModelInputBudget({ purpose: row.purpose, snapshot: await this.currentSnapshot(row), sources: await this.listSources(row.id) });
    const budget = await this.checkBudget(ownerId, workspaceId);
    if (!budget.allowed) throw budgetAdmissionError(budget.reason);
    const now = nowIso();
    const retryId = randomId('run');
    const reserved = LIMITS.reserveMicroUsd;
    const retryRun: RunRow = {
      id: retryId,
      workspace_id: workspaceId,
      owner_id: ownerId,
      source_id: original.source_id,
      status: 'pending',
      mode: 'live',
      error: null,
      created_at: now,
      updated_at: now,
      reserved_micro_usd: reserved,
      actual_micro_usd: null,
      base_revision: row.revision,
      base_source_revision: row.source_revision,
      retry_count: 1,
      changeset_id: null,
    };
    const view = this.assembleView(row, await this.listSources(row.id), await this.currentSnapshot(row), [retryRun, ...await this.listRuns(row.id)], await this.listHistory(row.id));
    const guardId = randomId('guard');
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        'INSERT INTO tx_guards (id, created_at) SELECT ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ?',
      ).bind(guardId, now, workspaceId, ownerId, now),
      this.env.DB.prepare(
        `INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) SELECT ?, ?, ?, ?, "reserve", ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?) AND ${NO_MODEL_BUDGET_POLICY_VIOLATION_SQL} AND (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM budget_ledger WHERE entry_type = "reserve" AND created_at >= ?) + ? <= ? AND (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM budget_ledger WHERE entry_type = "reserve") + ? <= ? AND (SELECT COUNT(*) FROM budget_ledger WHERE owner_id IN (${OWNER_BUCKET_OWNER_IDS_SQL}) AND entry_type = "reserve" AND created_at >= ?) < ?`,
      ).bind(randomId('led'), ownerId, workspaceId, retryId, reserved, now, guardId, dayStart(now), reserved, parseIntEnv(this.env.DAILY_BUDGET_MICRO_USD, 500_000), reserved, parseIntEnv(this.env.TOTAL_BUDGET_MICRO_USD, 15_000_000), ownerId, ownerId, dayStart(now), parseIntEnv(this.env.OWNER_DAILY_RUNS, 10)),
    ];
    statements.push(
      this.env.DB.prepare(
        'INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, error, request_id, payload_hash, base_revision, base_source_revision, retry_of_run_id, retry_count, reserved_micro_usd, created_at, updated_at) SELECT ?, id, owner_id, ?, "pending", "live", NULL, ?, ?, revision, source_revision, ?, 1, ?, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?) AND EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ? AND entry_type = "reserve")',
      ).bind(retryId, original.source_id, requestId, payloadHash, runId, reserved, now, now, workspaceId, ownerId, guardId, retryId),
      this.env.DB.prepare(
        'INSERT INTO applied_commands (id, owner_id, workspace_id, request_id, command_type, payload_hash, response_json, created_at) SELECT ?, owner_id, id, ?, "retry_run", ?, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?) AND EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ? AND entry_type = "reserve")',
      ).bind(randomId('cmd'), requestId, payloadHash, JSON.stringify(view), now, workspaceId, ownerId, guardId, retryId),
      this.abortIfMissing(guardId),
      this.abortIfMissingLedger(retryId),
      this.env.DB.prepare('DELETE FROM tx_guards WHERE id = ?').bind(guardId),
    );
    const outcome = await this.batchOrReplay(ownerId, requestId, payloadHash, statements);
    if (outcome.replay) return outcome.replay;
    const ledger = await this.env.DB.prepare('SELECT id FROM budget_ledger WHERE run_id = ? AND entry_type = "reserve"').bind(retryId).first<{ id: string }>();
    if (!ledger) {
      throw new ApiException('BUDGET_RESERVATION_FAILED', '모델 실행 예산을 예약하지 못했습니다.', 429);
    }
    await enqueue(retryId);
    return view;
  }

  async claimRun(runId: string): Promise<RunRow | null> {
    const now = nowIso();
    const result = await this.env.DB.prepare('UPDATE runs SET status = "running", claimed_at = ?, updated_at = ? WHERE id = ? AND status = "pending"')
      .bind(now, now, runId)
      .run();
    if (!changed(result)) return null;
    return this.env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<RunRow>();
  }

  async hasModelBudgetPolicyViolation(): Promise<boolean> {
    const row = await this.env.DB.prepare('SELECT id FROM budget_ledger WHERE entry_type = "policy_violation" LIMIT 1').first<{ id: string }>();
    return Boolean(row);
  }

  async recordModelUsage(run: RunRow, usage: ModelUsage): Promise<boolean> {
    if (usage.inputTokens === null || usage.outputTokens === null) return false;
    const now = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE runs SET actual_micro_usd = COALESCE(actual_micro_usd, ?), updated_at = ? WHERE id = ?',
      ).bind(usage.costMicroUsd, now, run.id),
      this.env.DB.prepare(
        'INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) SELECT ?, ?, ?, ?, "actual", ?, ? WHERE NOT EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ? AND entry_type = "actual")',
      ).bind(`actual:${run.id}`, run.owner_id, run.workspace_id, run.id, usage.costMicroUsd, now, run.id),
      this.env.DB.prepare(
        'INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) SELECT ?, ?, ?, ?, "policy_violation", ?, ? WHERE ? > ? AND NOT EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ? AND entry_type = "policy_violation")',
      ).bind(`policy:${run.id}`, run.owner_id, run.workspace_id, run.id, usage.costMicroUsd, now, usage.costMicroUsd, run.reserved_micro_usd, run.id),
    ]);
    return usage.costMicroUsd > run.reserved_micro_usd;
  }

  async recordRunProvenance(run: RunRow, provenance: ModelRequestProvenance): Promise<boolean> {
    const now = nowIso();
    const provenanceJson = JSON.stringify(provenance);
    try {
      const result = await this.env.DB.prepare(
        `UPDATE runs SET provenance_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND owner_id = ? AND base_revision = ? AND base_source_revision = ? AND status = "running" AND mode = "live" AND provenance_json IS NULL
          AND EXISTS (SELECT 1 FROM workspaces WHERE id = runs.workspace_id AND owner_id = runs.owner_id AND deleted_at IS NULL AND expires_at > ? AND revision = runs.base_revision AND source_revision = runs.base_source_revision)`,
      ).bind(provenanceJson, now, run.id, run.workspace_id, run.owner_id, run.base_revision, run.base_source_revision, now).run();
      return changed(result);
    } catch {
      return false;
    }
  }

  async completeRun(run: RunRow, changeSet: ChangeSet, actualMicroUsd: number): Promise<CompleteRunOutcome> {
    const now = nowIso();
    const guardId = randomId('guard');
    try {
      const batch = await this.env.DB.batch([
        this.env.DB.prepare(
          'INSERT INTO tx_guards (id, created_at) SELECT ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ? AND revision = ? AND source_revision = ? AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = "running")',
        ).bind(guardId, now, run.workspace_id, run.owner_id, now, changeSet.baseRevision, changeSet.baseSourceRevision, run.id),
        this.env.DB.prepare(
          'UPDATE runs SET status = "failed", error = ?, updated_at = ? WHERE workspace_id = ? AND status IN ("ready", "needs_input") AND (changeset_id IS NULL OR changeset_id <> ?) AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(SUPERSEDED_RUN_MESSAGE, now, run.workspace_id, changeSet.id, guardId),
        this.env.DB.prepare(
          'UPDATE workspaces SET pending_changeset_json = json_set(?, "$.proposalRevision", pending_proposal_revision + 1), pending_proposal_revision = pending_proposal_revision + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND revision = ? AND source_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(JSON.stringify(changeSet), now, run.workspace_id, run.owner_id, changeSet.baseRevision, changeSet.baseSourceRevision, guardId),
        this.env.DB.prepare(
          'UPDATE runs SET status = ?, error = NULL, changeset_id = ?, actual_micro_usd = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = "running" AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(changeSet.conflicts.length ? 'needs_input' : 'ready', changeSet.id, actualMicroUsd, now, now, run.id, guardId),
        this.env.DB.prepare(
          'INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) SELECT ?, ?, ?, ?, "actual", ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ? AND entry_type = "actual")',
        ).bind(`actual:${run.id}`, run.owner_id, run.workspace_id, run.id, actualMicroUsd, now, guardId, run.id),
        this.abortIfMissing(guardId),
        this.env.DB.prepare('DELETE FROM tx_guards WHERE id = ?').bind(guardId),
      ]);
      return {
        outcome: 'published',
        status: changeSet.conflicts.length ? 'needs_input' : 'ready',
        changesetId: changeSet.id,
        reservedMicroUsd: run.reserved_micro_usd,
        actualMicroUsd,
        durationMs: durationBetween(run.created_at, now),
        supersededRuns: batch[1]?.meta.changes ?? 0,
      };
    } catch (error) {
      if (!isTransactionAbortError(error)) throw error;
      const current = await this.env.DB.prepare('SELECT status, changeset_id, actual_micro_usd FROM runs WHERE id = ?').bind(run.id).first<{ status: RunStatus; changeset_id: string | null; actual_micro_usd: number | null }>();
      if (current?.status === 'running') {
        await this.markRun(run.id, 'failed', '작업 공간이 실행 중 변경되어 제안을 폐기했습니다.');
        return {
          outcome: 'discarded',
          status: 'failed',
          changesetId: null,
          reservedMicroUsd: run.reserved_micro_usd,
          actualMicroUsd: current.actual_micro_usd,
          durationMs: durationBetween(run.created_at, nowIso()),
          supersededRuns: 0,
        };
      }
      return {
        outcome: 'ignored',
        status: current?.status ?? 'missing',
        changesetId: current?.changeset_id ?? null,
        reservedMicroUsd: run.reserved_micro_usd,
        actualMicroUsd: current?.actual_micro_usd ?? null,
        durationMs: durationBetween(run.created_at, now),
        supersededRuns: 0,
      };
    }
  }

  async markRun(runId: string, status: RunStatus, error: string): Promise<void> {
    const now = nowIso();
    await this.env.DB.prepare('UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .bind(status, error, now, runId)
      .run();
  }

  async pendingRunIds(limit: number): Promise<string[]> {
    const result = await this.env.DB.prepare('SELECT id FROM runs WHERE status = "pending" ORDER BY created_at ASC LIMIT ?')
      .bind(limit)
      .all<{ id: string }>();
    return (result.results ?? []).map((row) => row.id);
  }

  async markTimedOutRuns(): Promise<number> {
    const cutoff = new Date(Date.now() - 70_000).toISOString();
    const result = await this.env.DB.prepare('UPDATE runs SET status = "uncertain", error = "외부 모델 호출 결과를 확정할 수 없습니다.", updated_at = ? WHERE status = "running" AND claimed_at < ?')
      .bind(nowIso(), cutoff)
      .run();
    return result.meta.changes ?? 0;
  }

  async expireAllWorkspaces(): Promise<number> {
    const result = await this.env.DB.prepare('DELETE FROM workspaces WHERE expires_at <= ? RETURNING id')
      .bind(nowIso())
      .all<{ id: string }>();
    await this.env.DB.prepare(`DELETE FROM owners WHERE last_seen_at < ?
      AND account_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspaces WHERE owner_id = owners.id)
      AND NOT EXISTS (SELECT 1 FROM runs WHERE owner_id = owners.id)
      AND NOT EXISTS (SELECT 1 FROM applied_commands WHERE owner_id = owners.id)
      AND NOT EXISTS (SELECT 1 FROM budget_ledger WHERE owner_id = owners.id)`)
      .bind(new Date(Date.now() - LIMITS.retentionMs).toISOString()).run();
    await this.env.DB.prepare('DELETE FROM admission_days WHERE day < ?')
      .bind(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)).run();
    return result.results?.length ?? 0;
  }

  private newOwnerStatements(ownerId: string, owner: OwnerSession | undefined, guardId: string, now: string): D1PreparedStatement[] {
    if (!owner?.isNew) return [];
    return [this.env.DB.prepare('INSERT INTO owners (id, token_hash, created_at, last_seen_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
      .bind(ownerId, owner.hash, now, now, guardId)];
  }

  async runContext(run: RunRow): Promise<{ workspace: WorkspaceRow; snapshot: Snapshot; sources: Source[] }> {
    const workspace = await this.env.DB.prepare(
      'SELECT * FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ? AND revision = ? AND source_revision = ?',
    ).bind(run.workspace_id, run.owner_id, nowIso(), run.base_revision, run.base_source_revision).first<WorkspaceRow>();
    if (!workspace) throw new ApiException('STALE_RUN_BASE', '실행 기준 버전이 현재 작업 공간과 다릅니다.', 409);
    return { workspace, snapshot: await this.currentSnapshot(workspace), sources: await this.listSources(run.workspace_id, run.base_source_revision) };
  }

  private async writeSnapshotCommand(
    ownerId: string,
    row: WorkspaceRow,
    requestId: string,
    commandType: string,
    payloadHash: string,
    snapshot: Snapshot,
    reason: string,
    expectedRevision: number,
    options: SnapshotCommandOptions = {},
  ): Promise<WorkspaceView> {
    const now = nowIso();
    const nextRevision = row.revision + 1;
    const clearPending = options.clearPending ?? false;
    const runs = await this.listRuns(row.id);
    const responseRuns = clearPending && options.pendingChangeSetId ? runs.map((run) => run.changeset_id === options.pendingChangeSetId && ['ready', 'needs_input'].includes(run.status) ? { ...run, status: 'applied' as RunStatus, updated_at: now } : run) : runs;
    const nextView = this.assembleView({ ...row, revision: nextRevision, current_snapshot_revision: nextRevision, pending_changeset_json: clearPending ? null : row.pending_changeset_json, updated_at: now, expires_at: expiresFrom(now) }, await this.listSources(row.id), snapshot, responseRuns, [
      ...await this.listHistory(row.id),
      { revision: nextRevision, reason, created_at: now },
    ]);
    const guardId = randomId('guard');
    let guardSql = 'INSERT INTO tx_guards (id, created_at) SELECT ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ? AND revision = ?';
    const guardBindings: unknown[] = [guardId, now, row.id, ownerId, now, expectedRevision];
    if (options.expectedSourceRevision !== undefined) {
      guardSql += ' AND source_revision = ?';
      guardBindings.push(options.expectedSourceRevision);
    }
    if (options.pendingChangeSetId !== undefined) {
      guardSql += ' AND pending_changeset_json IS NOT NULL AND json_extract(pending_changeset_json, "$.id") = ? AND pending_proposal_revision = ?';
      guardBindings.push(options.pendingChangeSetId, options.pendingProposalRevision ?? -1);
    }
    if (options.recoveryConditionRevision !== undefined) {
      guardSql += ' AND pending_changeset_json IS NULL AND EXISTS (SELECT 1 FROM recovery_profiles rp WHERE rp.workspace_id = workspaces.id AND rp.condition_revision = ? AND rp.applied_revision IS NULL)';
      guardBindings.push(options.recoveryConditionRevision);
      guardSql += ` ${recoveryOriginCurrentGuardSql('workspaces.id')}`;
      guardBindings.push(now);
    }
    const outcome = await this.batchOrReplay(ownerId, requestId, payloadHash, [
      this.env.DB.prepare(guardSql).bind(...guardBindings),
      this.env.DB.prepare(
        'INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) SELECT id, revision + 1, ?, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
      ).bind(JSON.stringify(snapshot), reason, now, row.id, ownerId, expectedRevision, guardId),
      this.env.DB.prepare(
        `UPDATE workspaces SET revision = revision + 1, current_snapshot_revision = revision + 1, pending_changeset_json = ${clearPending ? 'NULL' : 'pending_changeset_json'}, updated_at = ?, expires_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)`,
      ).bind(now, expiresFrom(now), row.id, ownerId, expectedRevision, guardId),
      this.env.DB.prepare(
        'INSERT INTO applied_commands (id, owner_id, workspace_id, request_id, command_type, payload_hash, response_json, created_at) SELECT ?, owner_id, id, ?, ?, ?, ?, ? FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
      ).bind(randomId('cmd'), requestId, commandType, payloadHash, JSON.stringify(nextView), now, row.id, ownerId, nextRevision, guardId),
      ...(clearPending && options.pendingChangeSetId ? [this.env.DB.prepare('UPDATE runs SET status = "applied", updated_at = ? WHERE workspace_id = ? AND changeset_id = ? AND status IN ("ready", "needs_input")')
        .bind(now, row.id, options.pendingChangeSetId)] : []),
      ...(options.recoveryConditionRevision !== undefined ? [this.env.DB.prepare('UPDATE recovery_profiles SET applied_revision = ?, updated_at = ? WHERE workspace_id = ? AND condition_revision = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
        .bind(nextRevision, now, row.id, options.recoveryConditionRevision, guardId)] : []),
      this.abortIfMissing(guardId),
      this.env.DB.prepare('DELETE FROM tx_guards WHERE id = ?').bind(guardId),
    ]);
    if (outcome.replay) return outcome.replay;
    const batch = outcome.results;
    if (!changed(batch[1]) || !changed(batch[2]) || !changed(batch[3])) throw new ApiException('STALE_REVISION', '작업 공간이 변경되었습니다. 새로고침 후 다시 시도하세요.', 409);
    return nextView;
  }

  private async getWorkspaceRow(ownerId: string, workspaceId: string): Promise<WorkspaceRow> {
    await this.expireOwnerWorkspaces(ownerId);
    const row = await this.env.DB.prepare(
      'SELECT * FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ?',
    ).bind(workspaceId, ownerId, nowIso()).first<WorkspaceRow>();
    if (!row) throw new ApiException('WORKSPACE_NOT_FOUND', '작업 공간을 찾을 수 없습니다.', 404);
    return row;
  }

  private async viewFromRow(row: WorkspaceRow): Promise<WorkspaceView> {
    return this.assembleView(row, await this.listSources(row.id), await this.currentSnapshot(row), await this.listRuns(row.id), await this.listHistory(row.id));
  }

  private async touchWorkspaceAccess(ownerId: string, row: WorkspaceRow): Promise<WorkspaceRow> {
    const now = nowIso();
    const nextExpiry = expiresFrom(now);
    if (Date.parse(row.expires_at) >= Date.parse(nextExpiry)) return row;
    const updated = await this.env.DB.prepare(
      'UPDATE workspaces SET expires_at = MAX(expires_at, ?) WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ? RETURNING *',
    ).bind(nextExpiry, row.id, ownerId, now).first<WorkspaceRow>();
    if (!updated) throw new ApiException('WORKSPACE_NOT_FOUND', '작업 공간을 찾을 수 없습니다.', 404);
    return updated;
  }

  private assembleView(row: WorkspaceRow, sources: Source[], snapshot: Snapshot, runs: RunRow[], history: SnapshotMetadataRow[]): WorkspaceView {
    return {
      id: row.id,
      title: row.title,
      purpose: row.purpose,
      sampleScenario: isSampleScenarioName(row.sample_scenario) ? row.sample_scenario : null,
      revision: row.revision,
      sourceRevision: row.source_revision,
      sources,
      snapshot,
      pending: this.parsePending(row),
      runs: runs.map(toRunSummary),
      history: history.map((item) => ({ revision: item.revision, createdAt: item.created_at, reason: item.reason })),
      expiresAt: row.expires_at,
    };
  }

  private async previewViewWithSourceRun(row: WorkspaceRow, source: Source, run: RunRow, existingRuns?: RunRow[]): Promise<WorkspaceView> {
    return this.assembleView({ ...row, source_revision: row.source_revision + 1, updated_at: run.created_at, expires_at: expiresFrom(run.created_at) }, [...await this.listSources(row.id), source], await this.currentSnapshot(row), [run, ...(existingRuns ?? await this.listRuns(row.id))], await this.listHistory(row.id));
  }

  private async listSources(workspaceId: string, maxSourceRevision?: number): Promise<Source[]> {
    const result = await this.env.DB.prepare(`SELECT * FROM sources WHERE workspace_id = ?${maxSourceRevision === undefined ? '' : ' AND source_revision <= ?'} ORDER BY source_revision ASC`)
      .bind(...(maxSourceRevision === undefined ? [workspaceId] : [workspaceId, maxSourceRevision]))
      .all<SourceRow>();
    return (result.results ?? []).map(sourceFromRow);
  }

  private async currentSnapshot(row: WorkspaceRow): Promise<Snapshot> {
    const snapshot = await this.env.DB.prepare('SELECT snapshot_json FROM snapshots WHERE workspace_id = ? AND revision = ?')
      .bind(row.id, row.current_snapshot_revision)
      .first<{ snapshot_json: string }>();
    if (!snapshot) throw new ApiException('SNAPSHOT_MISSING', '저장된 계획을 읽지 못했어요. 다시 불러와도 같다면 운영자에게 문의해 주세요.', 500);
    return JSON.parse(snapshot.snapshot_json) as Snapshot;
  }

  private async listRuns(workspaceId: string): Promise<RunRow[]> {
    const result = await this.env.DB.prepare('SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20')
      .bind(workspaceId)
      .all<RunRow>();
    return result.results ?? [];
  }

  private async listHistory(workspaceId: string): Promise<SnapshotMetadataRow[]> {
    const result = await this.env.DB.prepare('SELECT revision, reason, created_at FROM snapshots WHERE workspace_id = ? ORDER BY revision ASC')
      .bind(workspaceId)
      .all<SnapshotMetadataRow>();
    return result.results ?? [];
  }

  private parsePending(row: WorkspaceRow): ChangeSet | null {
    return row.pending_changeset_json ? JSON.parse(row.pending_changeset_json) as ChangeSet : null;
  }

  private async replay(ownerId: string, requestId: string, payloadHash: string): Promise<WorkspaceView | null> {
    const existing = await this.env.DB.prepare('SELECT workspace_id, payload_hash, response_json FROM applied_commands WHERE owner_id = ? AND request_id = ?')
      .bind(ownerId, requestId)
      .first<CommandRow>();
    if (!existing) return null;
    await this.getWorkspaceRow(ownerId, existing.workspace_id);
    if (existing.payload_hash !== payloadHash) throw new ApiException('IDEMPOTENCY_CONFLICT', '같은 requestId에 다른 payload가 사용되었습니다.', 409);
    return JSON.parse(existing.response_json) as WorkspaceView;
  }

  private async recordIdempotent(ownerId: string, workspaceId: string, requestId: string, commandType: string, payloadHash: string, view: WorkspaceView): Promise<WorkspaceView> {
    try {
      await this.env.DB.prepare(
        'INSERT INTO applied_commands (id, owner_id, workspace_id, request_id, command_type, payload_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(randomId('cmd'), ownerId, workspaceId, requestId, commandType, payloadHash, JSON.stringify(view), nowIso()).run();
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const replay = await this.replay(ownerId, requestId, payloadHash);
      if (replay) return replay;
      throw new ApiException('IDEMPOTENCY_CONFLICT', '같은 requestId 처리 결과를 확정할 수 없습니다.', 409);
    }
    return view;
  }

  private async batchOrReplay(ownerId: string, requestId: string, payloadHash: string, statements: D1PreparedStatement[]): Promise<BatchOutcome> {
    try {
      return { results: await this.env.DB.batch(statements), replay: null };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const replay = await this.replay(ownerId, requestId, payloadHash);
        if (replay) return { results: [], replay };
        throw new ApiException('IDEMPOTENCY_CONFLICT', '같은 requestId 처리 결과를 확정할 수 없습니다.', 409);
      }
      if (isTransactionAbortError(error)) {
        throw new ApiException('CONCURRENT_MUTATION', '동시 변경으로 요청을 처리하지 못했습니다. 새로고침 후 다시 시도하세요.', 409);
      }
      throw error;
    }
  }

  private async assertSourceLimits(workspaceId: string, nextText: string): Promise<void> {
    this.assertSourceTextLimit(nextText);
    const rows = await this.env.DB.prepare('SELECT text FROM sources WHERE workspace_id = ?')
      .bind(workspaceId)
      .all<{ text: string }>();
    if (rows.results.length >= LIMITS.maxSources) throw new ApiException('SOURCE_LIMIT', '소스 개수 한도를 초과했습니다.', 429);
    // Match the contract's JavaScript UTF-16 length, including astral characters.
    const total = rows.results.reduce((sum, source) => sum + source.text.length, 0);
    if (total + nextText.length > LIMITS.totalSourceChars) throw new ApiException('SOURCE_TOTAL_LIMIT', '전체 소스 길이 한도를 초과했습니다.', 413);
  }

  private answerContext(row: WorkspaceRow, input: AddSourceInput): SourceAnswer | undefined {
    if (!input.answerTo) return undefined;
    if (input.relation !== 'addition' || input.targetSourceId !== null) {
      throw new ApiException('INVALID_ANSWER_RELATION', '질문 답변은 새로운 추가 정보로 저장해야 합니다.', 422);
    }
    const pending = this.parsePending(row);
    const reference = input.answerTo;
    if (!pending?.questions.length || pending.id !== reference.changeSetId || pending.proposalRevision !== reference.proposalRevision ||
      pending.baseRevision !== reference.baseRevision || pending.baseSourceRevision !== reference.baseSourceRevision ||
      row.revision !== reference.baseRevision || row.source_revision !== reference.baseSourceRevision) {
      throw new ApiException('STALE_QUESTION', '질문의 기준이 변경되었습니다. 현재 변경안을 확인해 주세요.', 409);
    }
    return { ...reference, questions: [...pending.questions] };
  }

  private assertSourceTextLimit(nextText: string): void {
    if (nextText.length > LIMITS.sourceChars) throw new ApiException('SOURCE_TOO_LARGE', '소스 길이 한도를 초과했습니다.', 413);
  }

  private async checkBudget(ownerId: string, workspaceId: string): Promise<{ allowed: boolean; reason: string | null }> {
    const dailyCap = parseIntEnv(this.env.DAILY_BUDGET_MICRO_USD, 500_000);
    const totalCap = parseIntEnv(this.env.TOTAL_BUDGET_MICRO_USD, 15_000_000);
    const dailyRunCap = parseIntEnv(this.env.OWNER_DAILY_RUNS, 10);
    const start = dayStart(nowIso());
    const daily = await this.env.DB.prepare('SELECT COALESCE(SUM(amount_micro_usd), 0) AS amount FROM budget_ledger WHERE entry_type = "reserve" AND created_at >= ?')
      .bind(start)
      .first<{ amount: number }>();
    const ownerDaily = await this.env.DB.prepare(`SELECT COUNT(*) AS count FROM budget_ledger WHERE owner_id IN (${OWNER_BUCKET_OWNER_IDS_SQL}) AND entry_type = "reserve" AND created_at >= ?`)
      .bind(ownerId, ownerId, start)
      .first<{ count: number }>();
    const total = await this.env.DB.prepare('SELECT COALESCE(SUM(amount_micro_usd), 0) AS amount FROM budget_ledger WHERE entry_type = "reserve"')
      .first<{ amount: number }>();
    const workspace = await this.env.DB.prepare('SELECT id FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ?')
      .bind(workspaceId, ownerId, nowIso())
      .first<{ id: string }>();
    if (!workspace) throw new ApiException('WORKSPACE_NOT_FOUND', '작업 공간을 찾을 수 없습니다.', 404);
    if (await this.hasModelBudgetPolicyViolation()) return { allowed: false, reason: MODEL_BUDGET_POLICY_VIOLATION };
    if ((ownerDaily?.count ?? 0) >= dailyRunCap) return { allowed: false, reason: 'OWNER_DAILY_RUN_LIMIT' };
    if ((daily?.amount ?? 0) + LIMITS.reserveMicroUsd > dailyCap) return { allowed: false, reason: 'DAILY_BUDGET_EXCEEDED' };
    if ((total?.amount ?? 0) + LIMITS.reserveMicroUsd > totalCap) return { allowed: false, reason: 'TOTAL_BUDGET_EXCEEDED' };
    return { allowed: true, reason: null };
  }

  private async expireOwnerWorkspaces(ownerId: string): Promise<void> {
    await this.env.DB.prepare('DELETE FROM workspaces WHERE owner_id = ? AND expires_at <= ?')
      .bind(ownerId, nowIso())
      .run();
  }

  private async validateSourceRelation(workspaceId: string, currentSourceRevision: number, relation: Source['relation'], targetSourceId: string | null): Promise<void> {
    if (relation === 'initial') {
      if (currentSourceRevision !== 0) throw new ApiException('BAD_SOURCE_RELATION', 'initial 소스는 첫 소스에만 사용할 수 있습니다.', 422);
      if (targetSourceId) throw new ApiException('BAD_SOURCE_RELATION', 'initial 소스는 대상 소스를 지정할 수 없습니다.', 422);
      return;
    }
    if (relation === 'correction' || relation === 'replacement') {
      if (!targetSourceId) throw new ApiException('BAD_SOURCE_RELATION', '수정/대체 소스는 같은 작업 공간의 대상 소스가 필요합니다.', 422);
    }
    if (!targetSourceId) return;
    const target = await this.env.DB.prepare('SELECT id FROM sources WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, targetSourceId)
      .first<{ id: string }>();
    if (!target) throw new ApiException('BAD_SOURCE_RELATION', '대상 소스를 찾을 수 없습니다.', 422);
  }

  private abortIfMissing(guardId: string): D1PreparedStatement {
    return this.env.DB.prepare('INSERT INTO tx_abort (id) SELECT "abort" WHERE NOT EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
      .bind(guardId);
  }

  private abortIfMissingLedger(runId: string): D1PreparedStatement {
    return this.env.DB.prepare('INSERT INTO tx_abort (id) SELECT "abort" WHERE NOT EXISTS (SELECT 1 FROM budget_ledger WHERE run_id = ? AND entry_type = "reserve")')
      .bind(runId);
  }

  private async makeSource(id: string, text: string, title: string, relation: Source['relation'], targetSourceId: string | null, createdAt: string): Promise<Source> {
    return { id, text, title, relation, targetSourceId, hash: await sha256Hex(text), createdAt };
  }
}

const changed = (result: D1Result<unknown>): boolean => (result.meta.changes ?? 0) > 0;
const dayStart = (iso: string): string => `${iso.slice(0, 10)}T00:00:00.000Z`;
const durationBetween = (startedAt: string, endedAt: string): number | null => {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
};
const isUniqueConstraintError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return /UNIQUE constraint failed/i.test(error.message);
};
const isTransactionAbortError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return /CHECK constraint failed/i.test(error.message);
};
const supersedePendingRun = (run: RunRow, updatedAt: string): RunRow =>
  ['ready', 'needs_input'].includes(run.status)
    ? { ...run, status: 'failed', error: SUPERSEDED_RUN_MESSAGE, updated_at: updatedAt }
    : run;

const isSampleScenarioName = (value: string | null): value is SampleScenarioName =>
  value === 'travel' || value === 'syllabus' || value === 'departure' || value === 'coordination';

const sourceFromRow = (row: SourceRow): Source => ({
  id: row.id,
  title: row.title,
  text: row.text,
  relation: row.relation,
  targetSourceId: row.target_source_id,
  hash: row.hash,
  createdAt: row.created_at,
  ...(row.answer_context_json ? { answerTo: sourceAnswerSchema.parse(JSON.parse(row.answer_context_json)) } : {}),
});

const toRunSummary = (row: RunRow): RunSummary => ({
  id: row.id,
  sourceId: row.source_id,
  status: row.status,
  error: row.error,
  createdAt: row.created_at,
  costMicroUsd: row.actual_micro_usd ?? (row.reserved_micro_usd || null),
  mode: row.mode,
});
