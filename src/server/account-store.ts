import type { ClaimGuestInput, GuestClaimPreview, GuestClaimResult, GuestClaimWorkspace } from '../core/account-contracts';
import { jsonHash, randomId, randomToken, sha256Hex } from './crypto';
import { ApiException } from './errors';
import { nowIso } from './http';

export type AccountOwner = { accountId: string; ownerId: string; credentialVersion: number };
export type AccountWorkspaceSummary = GuestClaimWorkspace & { updatedAt: string };

type OwnerRow = { id: string; credential_version: number };
type WorkspaceRow = { id: string; title: string; revision: number; source_revision: number; updated_at: string };
type ClaimRow = { payload_hash: string; response_json: string };
type PreviewPayload = {
  schemaVersion: 1;
  accountId: string;
  ownerId: string;
  ownerCredentialVersion: number;
  workspaces: GuestClaimWorkspace[];
  retentionDays: 7;
};

const MAX_ACCOUNT_WORKSPACES = 10;
const RETENTION_DAYS = 7;

export class AccountStore {
  constructor(private readonly db: D1Database) {}

  async ensureAccount(userId: string): Promise<AccountOwner> {
    const existing = await this.getPrimaryOwner(userId);
    if (existing) return existing;

    const now = nowIso();
    const ownerId = randomId('own');
    const tokenHash = await sha256Hex(`account-primary:${randomToken()}`);
    const guardId = randomId('guard');

    try {
      await this.db.batch([
        this.db.prepare('INSERT INTO app_accounts (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
          .bind(userId, now),
        this.db.prepare('INSERT INTO tx_guards (id, created_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM account_primary_owners WHERE account_id = ?)')
          .bind(guardId, now, userId),
        this.db.prepare(
          'INSERT INTO owners (id, token_hash, created_at, last_seen_at, account_id, credential_version, claimed_at) SELECT ?, ?, ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(ownerId, tokenHash, now, now, userId, now, guardId),
        this.db.prepare(
          'INSERT INTO account_primary_owners (account_id, owner_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(userId, ownerId, guardId),
        this.abortIfMissing(guardId),
        this.db.prepare('DELETE FROM tx_guards WHERE id = ?').bind(guardId),
      ]);
    } catch (error) {
      if (!isTransactionAbortError(error) && !isUniqueConstraintError(error)) throw error;
    }

    const created = await this.getPrimaryOwner(userId);
    if (!created) throw new ApiException('ACCOUNT_UNAVAILABLE', '계정 소유자 정보를 준비하지 못했습니다.', 503);
    return created;
  }

  async getPrimaryOwner(userId: string): Promise<AccountOwner | null> {
    const row = await this.db.prepare(
      `SELECT account_primary_owners.account_id, account_primary_owners.owner_id, owners.credential_version
       FROM account_primary_owners
       JOIN owners ON owners.id = account_primary_owners.owner_id
       WHERE account_primary_owners.account_id = ?`,
    ).bind(userId).first<{ account_id: string; owner_id: string; credential_version: number }>();
    return row ? { accountId: row.account_id, ownerId: row.owner_id, credentialVersion: row.credential_version } : null;
  }

  async listAccountWorkspaces(userId: string): Promise<AccountWorkspaceSummary[]> {
    await this.ensureAccount(userId);
    const rows = await this.db.prepare(
      `SELECT workspaces.id, workspaces.title, workspaces.revision, workspaces.source_revision, workspaces.updated_at
       FROM workspaces
       JOIN owners ON owners.id = workspaces.owner_id
       WHERE owners.account_id = ? AND workspaces.deleted_at IS NULL AND workspaces.expires_at > ?
       ORDER BY workspaces.updated_at DESC`,
    ).bind(userId, nowIso()).all<WorkspaceRow>();
    return (rows.results ?? []).map(toAccountWorkspace);
  }

  async previewGuest(userId: string, guestTokenHash: string | null): Promise<GuestClaimPreview | null> {
    await this.ensureAccount(userId);
    if (!guestTokenHash) return null;

    const payload = await this.previewPayload(userId, guestTokenHash);
    if (!payload) return null;
    return {
      previewHash: await previewHash(payload),
      workspaces: payload.workspaces,
      retentionDays: RETENTION_DAYS,
    };
  }

  async claimGuest(userId: string, guestTokenHash: string | null, input: ClaimGuestInput): Promise<GuestClaimResult> {
    await this.ensureAccount(userId);
    const payloadHash = await jsonHash({ previewHash: input.previewHash });
    const replay = await this.replayClaim(userId, input.requestId, payloadHash);
    if (replay) return replay;
    if (!guestTokenHash) throw new ApiException('GUEST_CLAIM_STALE', '이전 게스트 세션을 확인할 수 없습니다.', 409);

    const payload = await this.previewPayload(userId, guestTokenHash);
    if (!payload || await previewHash(payload) !== input.previewHash) {
      const staleReplay = await this.replayClaim(userId, input.requestId, payloadHash);
      if (staleReplay) return staleReplay;
      throw new ApiException('GUEST_CLAIM_STALE', '게스트 작업 공간이 변경되었습니다. 다시 확인해 주세요.', 409);
    }

    const accountWorkspaceCount = await this.activeAccountWorkspaceCount(userId);
    if (accountWorkspaceCount + payload.workspaces.length > MAX_ACCOUNT_WORKSPACES) {
      const capReplay = await this.replayClaim(userId, input.requestId, payloadHash);
      if (capReplay) return capReplay;
      throw new ApiException('ACCOUNT_WORKSPACE_LIMIT', '계정 작업 공간 한도를 초과합니다.', 409);
    }

    const now = nowIso();
    const guardId = randomId('guard');
    const response: GuestClaimResult = {
      claimedCount: payload.workspaces.length,
      workspaceIds: payload.workspaces.map((workspace) => workspace.id),
    };
    const rotatedHash = await sha256Hex(`claimed:${randomToken()}`);
    const tupleGuards = payload.workspaces.map(() => 'EXISTS (SELECT 1 FROM workspaces WHERE owner_id = owners.id AND id = ? AND title = ? AND revision = ? AND source_revision = ? AND deleted_at IS NULL AND expires_at > ?)');
    const guardSql = [
      'INSERT INTO tx_guards (id, created_at)',
      'SELECT ?, ? FROM owners',
      'WHERE token_hash = ? AND account_id IS NULL AND credential_version = ?',
      'AND (SELECT COUNT(*) FROM workspaces WHERE owner_id = owners.id AND deleted_at IS NULL AND expires_at > ?) = ?',
      `AND (SELECT COUNT(*) FROM workspaces JOIN owners account_owners ON account_owners.id = workspaces.owner_id WHERE account_owners.account_id = ? AND workspaces.deleted_at IS NULL AND workspaces.expires_at > ?) + ? <= ${MAX_ACCOUNT_WORKSPACES}`,
      ...tupleGuards.map((guard) => `AND ${guard}`),
    ].join(' ');
    const tupleBindings = payload.workspaces.flatMap((workspace) => [workspace.id, workspace.title, workspace.revision, workspace.sourceRevision, now]);

    try {
      const results = await this.db.batch([
        this.db.prepare(guardSql)
          .bind(guardId, now, guestTokenHash, payload.ownerCredentialVersion, now, payload.workspaces.length, userId, now, payload.workspaces.length, ...tupleBindings),
        this.db.prepare(
          'UPDATE owners SET account_id = ?, credential_version = credential_version + 1, claimed_at = ?, token_hash = ? WHERE id = ? AND account_id IS NULL AND credential_version = ? AND EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(userId, now, rotatedHash, payload.ownerId, payload.ownerCredentialVersion, guardId),
        this.db.prepare(
          'INSERT INTO account_claims (account_id, request_id, payload_hash, response_json, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)',
        ).bind(userId, input.requestId, payloadHash, JSON.stringify(response), now, guardId),
        this.abortIfMissing(guardId),
        this.abortIfMissingClaim(userId, input.requestId),
        this.db.prepare('DELETE FROM tx_guards WHERE id = ?').bind(guardId),
      ]);
      if (!changed(results[1]) || !changed(results[2])) {
        throw new ApiException('GUEST_CLAIM_STALE', '게스트 작업 공간을 계정으로 이전하지 못했습니다.', 409);
      }
      return response;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.replayClaim(userId, input.requestId, payloadHash);
        if (existing) return existing;
        throw new ApiException('IDEMPOTENCY_CONFLICT', '같은 requestId에 다른 계정 이전 요청이 사용되었습니다.', 409);
      }
      if (error instanceof ApiException) throw error;
      if (isTransactionAbortError(error)) {
        const existing = await this.replayClaim(userId, input.requestId, payloadHash);
        if (existing) return existing;
        throw new ApiException('GUEST_CLAIM_STALE', '게스트 작업 공간이 변경되었습니다. 다시 확인해 주세요.', 409);
      }
      throw error;
    }
  }

  private async previewPayload(accountId: string, guestTokenHash: string): Promise<PreviewPayload | null> {
    const owner = await this.db.prepare(
      'SELECT id, credential_version FROM owners WHERE token_hash = ? AND account_id IS NULL',
    ).bind(guestTokenHash).first<OwnerRow>();
    if (!owner) return null;

    const rows = await this.db.prepare(
      `SELECT id, title, revision, source_revision, updated_at
       FROM workspaces
       WHERE owner_id = ? AND deleted_at IS NULL AND expires_at > ?
       ORDER BY updated_at DESC, id ASC`,
    ).bind(owner.id, nowIso()).all<WorkspaceRow>();
    return {
      schemaVersion: 1,
      accountId,
      ownerId: owner.id,
      ownerCredentialVersion: owner.credential_version,
      workspaces: (rows.results ?? []).map(toGuestClaimWorkspace),
      retentionDays: RETENTION_DAYS,
    };
  }

  private async activeAccountWorkspaceCount(accountId: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM workspaces
       JOIN owners ON owners.id = workspaces.owner_id
       WHERE owners.account_id = ? AND workspaces.deleted_at IS NULL AND workspaces.expires_at > ?`,
    ).bind(accountId, nowIso()).first<{ count: number }>();
    return row?.count ?? 0;
  }

  private async replayClaim(accountId: string, requestId: string, payloadHash: string): Promise<GuestClaimResult | null> {
    const row = await this.db.prepare(
      'SELECT payload_hash, response_json FROM account_claims WHERE account_id = ? AND request_id = ?',
    ).bind(accountId, requestId).first<ClaimRow>();
    if (!row) return null;
    if (row.payload_hash !== payloadHash) throw new ApiException('IDEMPOTENCY_CONFLICT', '같은 requestId에 다른 계정 이전 요청이 사용되었습니다.', 409);
    return JSON.parse(row.response_json) as GuestClaimResult;
  }

  private abortIfMissing(guardId: string): D1PreparedStatement {
    return this.db.prepare('INSERT INTO tx_abort (id) SELECT "abort" WHERE NOT EXISTS (SELECT 1 FROM tx_guards WHERE id = ?)')
      .bind(guardId);
  }

  private abortIfMissingClaim(accountId: string, requestId: string): D1PreparedStatement {
    return this.db.prepare('INSERT INTO tx_abort (id) SELECT "abort" WHERE NOT EXISTS (SELECT 1 FROM account_claims WHERE account_id = ? AND request_id = ?)')
      .bind(accountId, requestId);
  }
}

const toGuestClaimWorkspace = (row: WorkspaceRow): GuestClaimWorkspace => ({
  id: row.id,
  title: row.title,
  revision: row.revision,
  sourceRevision: row.source_revision,
});

const toAccountWorkspace = (row: WorkspaceRow): AccountWorkspaceSummary => ({
  ...toGuestClaimWorkspace(row),
  updatedAt: row.updated_at,
});

const previewHash = async (payload: PreviewPayload): Promise<string> => sha256Hex(JSON.stringify(payload));
const changed = (result: D1Result<unknown>): boolean => (result.meta.changes ?? 0) > 0;

const isUniqueConstraintError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return /UNIQUE constraint failed/i.test(error.message);
};

const isTransactionAbortError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return /CHECK constraint failed/i.test(error.message);
};
