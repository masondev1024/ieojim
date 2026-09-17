import { emptySnapshot, LIMITS, snapshotSchema, type Snapshot, type WorkspaceView } from '../../core/contracts';
import { buildNoticeRecoverySeed, noticeRecoveryRequestSchema, type NoticeRecoveryOrigin } from '../../core/notice-recovery';
import type { RecoveryView } from '../../core/recovery-api-contracts';
import { recoveryInputSchema, type RecoveryInput } from '../../core/scheduling-contracts';
import { repairSchedule } from '../../core/schedule-repair';
import { jsonHash, randomId, sha256Hex } from '../crypto';
import { WorkspaceStore } from '../db';
import { ApiException } from '../errors';
import { expiresFrom, nowIso, type AppBindings, type OwnerSession } from '../http';
import { RecoveryStore } from './store';

const OWNER_BUCKET_OWNER_IDS_SQL = 'SELECT id FROM owners WHERE id = ? OR (account_id IS NOT NULL AND account_id = (SELECT account_id FROM owners WHERE id = ?))';

export class NoticeRecoveryStore {
  constructor(private readonly env: AppBindings) {}

  async create(owner: OwnerSession, originWorkspaceId: string, raw: unknown): Promise<RecoveryView> {
    const command = noticeRecoveryRequestSchema.parse(raw);
    const payloadHash = await jsonHash({ kind: 'notice_recovery_create', originWorkspaceId, command });
    const replay = await this.replay(owner.id, command.requestId, payloadHash);
    if (replay) return new RecoveryStore(this.env).read(owner.id, replay.workspaceId);

    const originWorkspace = await new WorkspaceStore(this.env).getWorkspace(owner.id, originWorkspaceId);
    await this.assertOriginIsNotRecoveryWorkspace(originWorkspace.id);
    const workspaceId = randomId('ws');
    const noticeSourceId = randomId('src');
    const conditionSourceId = randomId('src');
    const seed = buildNoticeRecoverySeed(originWorkspace, command, { workspaceId, noticeSourceId, conditionSourceId });
    const origin = this.validateSeed(originWorkspace, seed.origin);
    const input = recoveryInputSchema.parse(seed.input);
    const snapshot = snapshotSchema.parse(seed.snapshot);
    this.assertSeedIdentity(input, seed, { workspaceId, noticeSourceId, conditionSourceId });
    const result = repairSchedule(input);
    if (result.status === 'invalid_input' || result.status === 'unsupported') {
      throw new ApiException('INVALID_NOTICE_RECOVERY', result.message, 422);
    }
    assertRecoveryItemIds(snapshot, result);
    if (seed.noticeText.length > LIMITS.sourceChars || seed.conditionText.length > LIMITS.sourceChars ||
        seed.noticeText.length + seed.conditionText.length > LIMITS.totalSourceChars) {
      throw new ApiException('SOURCE_LIMIT', '저장할 안내문과 확인 조건의 크기 한도에 도달했습니다.', 413);
    }

    const now = nowIso();
    const proposalId = randomId('repair');
    const noticeHash = await sha256Hex(seed.noticeText);
    const conditionHash = await sha256Hex(seed.conditionText);
    const originJson = JSON.stringify(origin);
    const view: RecoveryView = {
      workspaceId,
      revision: 1,
      sourceRevision: 2,
      conditionRevision: 1,
      input,
      result,
      proposalId,
      applied: false,
      actions: [],
      origin,
    };
    const guardId = randomId('guard');

    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO tx_guards(id,created_at) SELECT ?,? FROM workspaces ow JOIN sources os ON os.workspace_id=ow.id AND os.id=?
            WHERE ow.id=? AND ow.owner_id=? AND ow.deleted_at IS NULL AND ow.expires_at>? AND ow.revision=? AND ow.source_revision=?
              AND ow.pending_changeset_json IS NULL AND os.hash=? AND os.text=? AND NOT EXISTS(SELECT 1 FROM recovery_profiles rp WHERE rp.workspace_id=ow.id)
              AND (SELECT COUNT(*) FROM workspaces WHERE owner_id IN (${OWNER_BUCKET_OWNER_IDS_SQL}) AND deleted_at IS NULL AND expires_at > ?) < 10`,
        ).bind(guardId, now, origin.sourceId, origin.workspaceId, owner.id, now, origin.revision, origin.sourceRevision, origin.sourceHash, seed.noticeText, owner.id, owner.id, now),
        ...this.newOwnerStatements(owner, guardId, now),
        this.env.DB.prepare(
          'INSERT INTO workspaces(id,owner_id,title,purpose,revision,source_revision,current_snapshot_revision,created_at,updated_at,expires_at) SELECT ?,?,?,?,?,?,?,?, ?, ? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)',
        ).bind(workspaceId, owner.id, seed.title, seed.purpose, 1, 2, 1, now, now, expiresFrom(now), guardId),
        this.env.DB.prepare('INSERT INTO sources(id,workspace_id,source_revision,title,relation,target_source_id,hash,text,created_at) SELECT ?,?,1,?,"initial",NULL,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(noticeSourceId, workspaceId, '기준 안내문', noticeHash, seed.noticeText, now, guardId),
        this.env.DB.prepare('INSERT INTO sources(id,workspace_id,source_revision,title,relation,target_source_id,hash,text,created_at) SELECT ?,?,2,?,"addition",?,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(conditionSourceId, workspaceId, '사용자가 확인한 실행 조건', noticeSourceId, conditionHash, seed.conditionText, now, guardId),
        this.env.DB.prepare('INSERT INTO snapshots(workspace_id,revision,snapshot_json,reason,created_at) SELECT ?,0,?,"created",? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(workspaceId, JSON.stringify(emptySnapshot()), now, guardId),
        this.env.DB.prepare('INSERT INTO snapshots(workspace_id,revision,snapshot_json,reason,created_at) SELECT ?,1,?,"notice_recovery_initial",? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(workspaceId, JSON.stringify(snapshot), now, guardId),
        this.env.DB.prepare('INSERT INTO recovery_profiles(workspace_id,condition_revision,base_revision,base_source_revision,input_json,proposal_id,applied_revision,updated_at) SELECT ?,1,1,2,?,?,NULL,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(workspaceId, JSON.stringify(input), proposalId, now, guardId),
        this.env.DB.prepare('INSERT INTO recovery_versions(workspace_id,condition_revision,input_json,source_id,created_at) SELECT ?,1,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(workspaceId, JSON.stringify(input), conditionSourceId, now, guardId),
        this.env.DB.prepare(`INSERT INTO recovery_origins(recovery_workspace_id,origin_owner_id,origin_workspace_id,origin_revision,origin_source_revision,origin_source_id,origin_source_hash,origin_target_item_id,origin_preparation_item_id,source_mode,origin_json,notice_text,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)`)
          .bind(workspaceId, owner.id, origin.workspaceId, origin.revision, origin.sourceRevision, origin.sourceId, origin.sourceHash, origin.targetItemId, origin.preparationItemId, origin.sourceMode, originJson, origin.noticeText, now, guardId),
        this.env.DB.prepare('INSERT INTO recovery_requests(owner_id,request_id,workspace_id,payload_hash,response_json,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(owner.id, command.requestId, workspaceId, payloadHash, JSON.stringify(view), now, guardId),
        this.env.DB.prepare('INSERT INTO tx_abort(id) SELECT "abort" WHERE NOT EXISTS(SELECT 1 FROM tx_guards WHERE id=?)').bind(guardId),
        this.env.DB.prepare('DELETE FROM tx_guards WHERE id=?').bind(guardId),
      ]);
    } catch (error) {
      const saved = await this.replay(owner.id, command.requestId, payloadHash);
      if (saved) return new RecoveryStore(this.env).read(owner.id, saved.workspaceId);
      if (error instanceof ApiException) throw error;
      if (isTransactionAbortError(error)) {
        if (await this.ownerBucketIsFull(owner.id, now)) {
          throw new ApiException('WORKSPACE_LIMIT', '작업 공간 한도를 초과했습니다.', 429);
        }
        throw new ApiException('NOTICE_RECOVERY_CONFLICT', '기준 안내 작업 공간이 바뀌어 일정 조정 작업을 만들지 못했습니다. 다시 불러와 주세요.', 409);
      }
      throw error;
    }
    return new RecoveryStore(this.env).read(owner.id, workspaceId);
  }

  private validateSeed(workspace: WorkspaceView, origin: NoticeRecoveryOrigin): NoticeRecoveryOrigin {
    if (origin.workspaceId !== workspace.id || origin.revision !== workspace.revision || origin.sourceRevision !== workspace.sourceRevision || workspace.pending) {
      throw new ApiException('STALE_NOTICE_ORIGIN', '기준 안내 작업 공간의 버전이 맞지 않습니다. 다시 불러와 주세요.', 409);
    }
    const source = workspace.sources.find((entry) => entry.id === origin.sourceId);
    if (!source || source.hash !== origin.sourceHash || source.text !== origin.noticeText) {
      throw new ApiException('INVALID_NOTICE_ORIGIN', '선택한 안내 원문 근거가 현재 작업 공간 원문과 일치하지 않습니다.', 422);
    }
    if (!workspace.snapshot.blocks.flatMap((block) => block.items).some((item) => item.id === origin.targetItemId)) {
      throw new ApiException('INVALID_NOTICE_ORIGIN', '조정할 일정을 현재 작업 공간에서 찾지 못했어요. 최신 화면에서 다시 선택해 주세요.', 422);
    }
    if (origin.preparationItemId && !workspace.snapshot.blocks.flatMap((block) => block.items).some((item) => item.id === origin.preparationItemId)) {
      throw new ApiException('INVALID_NOTICE_ORIGIN', '준비 항목을 현재 작업 공간에서 찾을 수 없습니다.', 422);
    }
    return origin;
  }

  private assertSeedIdentity(input: RecoveryInput, seed: ReturnType<typeof buildNoticeRecoverySeed>, ids: { workspaceId: string; noticeSourceId: string; conditionSourceId: string }): void {
    if (input.workspaceId !== ids.workspaceId || input.baseRevision !== 1 || input.sourceRevision !== 2) {
      throw new ApiException('INVALID_NOTICE_RECOVERY', '계획의 기준 버전이 맞지 않아요. 최신 작업 공간에서 다시 확인해 주세요.', 422);
    }
    const notice = input.sources.find((source) => source.id === ids.noticeSourceId);
    const condition = input.sources.find((source) => source.id === ids.conditionSourceId);
    if (!notice || notice.text !== seed.noticeText || !condition || condition.text !== seed.conditionText || input.sources.length !== 2) {
      throw new ApiException('INVALID_NOTICE_RECOVERY', '일정 조정에 사용한 안내문이 저장할 원문과 달라요. 원래 작업 공간에서 다시 확인해 주세요.', 422);
    }
  }

  private async replay(ownerId: string, requestId: string, payloadHash: string): Promise<{ workspaceId: string } | null> {
    const row = await this.env.DB.prepare('SELECT workspace_id,payload_hash FROM recovery_requests WHERE owner_id=? AND request_id=?')
      .bind(ownerId, requestId)
      .first<{ workspace_id: string; payload_hash: string }>();
    if (!row) return null;
    if (row.payload_hash !== payloadHash) throw new ApiException('IDEMPOTENCY_CONFLICT', '같은 요청 번호로 다른 안내 일정 조정 작업을 만들 수 없습니다.', 409);
    return { workspaceId: row.workspace_id };
  }

  private newOwnerStatements(owner: OwnerSession, guardId: string, now: string): D1PreparedStatement[] {
    if (!owner.isNew) return [];
    return [this.env.DB.prepare('INSERT INTO owners(id,token_hash,created_at,last_seen_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
      .bind(owner.id, owner.hash, now, now, guardId)];
  }

  private async ownerBucketIsFull(ownerId: string, now: string): Promise<boolean> {
    const count = await this.env.DB.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE owner_id IN (${OWNER_BUCKET_OWNER_IDS_SQL}) AND deleted_at IS NULL AND expires_at > ?`)
      .bind(ownerId, ownerId, now)
      .first<number>('count');
    return (count ?? 0) >= 10;
  }

  private async assertOriginIsNotRecoveryWorkspace(originWorkspaceId: string): Promise<void> {
    const profile = await this.env.DB.prepare('SELECT 1 FROM recovery_profiles WHERE workspace_id=?')
      .bind(originWorkspaceId)
      .first<{ '1': number }>();
    if (profile) {
      throw new ApiException('RECOVERY_ORIGIN_NOT_SUPPORTED', '일정 조정안에서는 새 일정 조정안을 만들 수 없습니다. 원래 안내 작업 공간에서 시작해 주세요.', 422);
    }
  }
}

function isTransactionAbortError(error: unknown): boolean {
  return error instanceof Error && /CHECK constraint failed/i.test(error.message);
}

function assertRecoveryItemIds(snapshot: Snapshot, result: ReturnType<typeof repairSchedule>): void {
  if (result.status !== 'ready') return;
  const itemIds = new Set(snapshot.blocks.flatMap((block) => block.items).map((item) => item.id));
  const missing = result.actions.find((action) => action.itemId !== null && !itemIds.has(action.itemId));
  if (missing?.itemId) {
    throw new ApiException('INVALID_NOTICE_RECOVERY', '계산한 일정이 저장할 계획과 맞지 않아 적용하지 않았어요. 원래 작업 공간에서 다시 확인해 주세요.', 422);
  }
}
