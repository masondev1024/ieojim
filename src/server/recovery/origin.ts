import type { NoticeRecoveryOrigin } from '../../core/notice-recovery';
import type { RecoveryResult } from '../../core/scheduling-contracts';
import { ApiException } from '../errors';
import { nowIso } from '../http';

export type RecoveryOriginRow = {
  recovery_workspace_id: string;
  origin_owner_id: string;
  origin_workspace_id: string;
  origin_revision: number;
  origin_source_revision: number;
  origin_source_id: string;
  origin_source_hash: string;
  origin_target_item_id: string;
  origin_preparation_item_id: string | null;
  source_mode: NoticeRecoveryOrigin['sourceMode'];
  origin_json: string;
  notice_text: string;
};

export type OriginRead = {
  origin: NoticeRecoveryOrigin | null;
  current: boolean;
};

export function recoveryOriginCurrentGuardSql(recoveryWorkspaceExpression: string): string {
  return `AND (
    NOT EXISTS (SELECT 1 FROM recovery_origins ro WHERE ro.recovery_workspace_id = ${recoveryWorkspaceExpression})
    OR EXISTS (
      SELECT 1 FROM recovery_origins ro
      JOIN workspaces ow ON ow.id = ro.origin_workspace_id AND ow.owner_id = ro.origin_owner_id
      JOIN sources os ON os.workspace_id = ow.id AND os.id = ro.origin_source_id
      WHERE ro.recovery_workspace_id = ${recoveryWorkspaceExpression}
        AND ow.deleted_at IS NULL
        AND ow.expires_at > ?
        AND ow.revision = ro.origin_revision
        AND ow.source_revision = ro.origin_source_revision
        AND ow.pending_changeset_json IS NULL
        AND os.hash = ro.origin_source_hash
        AND os.text = ro.notice_text
    )
  )`;
}

export async function readOriginState(db: D1Database, ownerId: string, recoveryWorkspaceId: string, now = nowIso()): Promise<OriginRead> {
  const row = await readOriginRow(db, ownerId, recoveryWorkspaceId);
  if (!row) return { origin: null, current: true };
  const origin = parseOrigin(row);
  return { origin, current: await isOriginRowCurrent(db, row, origin, now) };
}

export async function hasRecoveryOrigin(db: D1Database, ownerId: string, recoveryWorkspaceId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM recovery_origins ro JOIN workspaces rw ON rw.id=ro.recovery_workspace_id
    WHERE ro.recovery_workspace_id=? AND rw.owner_id=? AND rw.deleted_at IS NULL`)
    .bind(recoveryWorkspaceId, ownerId)
    .first<{ '1': number }>();
  return Boolean(row);
}

export async function assertOriginStillCurrent(db: D1Database, ownerId: string, recoveryWorkspaceId: string, now = nowIso()): Promise<void> {
  const state = await readOriginState(db, ownerId, recoveryWorkspaceId, now);
  if (!state.current) throw staleOriginException();
}

export function staleOriginResult(): RecoveryResult {
  return {
    status: 'missing_information',
    code: 'stale_origin',
    message: '기준 안내 작업 공간의 원문이나 결정 상태가 바뀌었습니다. 출처 작업 공간에서 새 일정 조정안을 만들어 주세요.',
    blockers: [],
  };
}

export function staleOriginException(): ApiException {
  return new ApiException('STALE_NOTICE_ORIGIN', '기준 안내 작업 공간의 원문이나 결정 상태가 바뀌었습니다. 출처 작업 공간에서 새 일정 조정안을 만들어 주세요.', 409);
}

async function readOriginRow(db: D1Database, ownerId: string, recoveryWorkspaceId: string): Promise<RecoveryOriginRow | null> {
  return db.prepare(`SELECT ro.* FROM recovery_origins ro JOIN workspaces rw ON rw.id=ro.recovery_workspace_id
    WHERE ro.recovery_workspace_id=? AND rw.owner_id=? AND rw.deleted_at IS NULL`)
    .bind(recoveryWorkspaceId, ownerId)
    .first<RecoveryOriginRow>();
}

function parseOrigin(row: RecoveryOriginRow): NoticeRecoveryOrigin {
  const parsed = JSON.parse(row.origin_json) as NoticeRecoveryOrigin;
  if (parsed.workspaceId !== row.origin_workspace_id ||
      parsed.revision !== row.origin_revision ||
      parsed.sourceRevision !== row.origin_source_revision ||
      parsed.sourceId !== row.origin_source_id ||
      parsed.sourceHash !== row.origin_source_hash ||
      parsed.targetItemId !== row.origin_target_item_id ||
      parsed.preparationItemId !== row.origin_preparation_item_id ||
      parsed.sourceMode !== row.source_mode ||
      parsed.noticeText !== row.notice_text) {
    throw new ApiException('RECOVERY_ORIGIN_CORRUPT', '저장된 안내와 일정 조정 기준이 맞지 않아요. 원래 안내에서 다시 만들어 주세요.', 500);
  }
  return parsed;
}

async function isOriginRowCurrent(db: D1Database, row: RecoveryOriginRow, origin: NoticeRecoveryOrigin, now: string): Promise<boolean> {
  const current = await db.prepare(`SELECT os.text, os.hash FROM workspaces ow JOIN sources os ON os.workspace_id=ow.id AND os.id=?
    WHERE ow.id=? AND ow.owner_id=? AND ow.deleted_at IS NULL AND ow.expires_at>? AND ow.revision=? AND ow.source_revision=? AND ow.pending_changeset_json IS NULL`)
    .bind(row.origin_source_id, row.origin_workspace_id, row.origin_owner_id, now, row.origin_revision, row.origin_source_revision)
    .first<{ text: string; hash: string }>();
  if (!current || current.hash !== row.origin_source_hash) return false;
  return current.text === origin.noticeText;
}
