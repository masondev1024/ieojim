import { MAX_EXPORT_BYTES, workspaceExportContentSchema, workspaceExportSchema, type WorkspaceExport } from '../core/export-contracts';
import { snapshotSchema, sourceAnswerSchema, type Source } from '../core/contracts';
import { sha256Hex } from './crypto';
import { ApiException } from './errors';
import { nowIso } from './http';

type WorkspaceExportRow = {
  id: string;
  title: string;
  purpose: string;
  revision: number;
  source_revision: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

type SourceExportRow = {
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

type SnapshotExportRow = { revision: number; reason: string; created_at: string; snapshot_json: string };

const textEncoder = new TextEncoder();

export async function exportWorkspace(db: D1Database, ownerId: string, workspaceId: string): Promise<WorkspaceExport> {
  const observedAt = nowIso();
  const [workspaceResult, sourcesResult, snapshotResult, revisionsResult] = await db.batch([
    db.prepare(
      `SELECT id, title, purpose, revision, source_revision, created_at, updated_at, expires_at
       FROM workspaces
       WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND expires_at > ?`,
    ).bind(workspaceId, ownerId, observedAt),
    db.prepare(
      `SELECT sources.id, sources.source_revision, sources.title, sources.relation, sources.target_source_id,
        sources.hash, sources.text, sources.created_at, sources.answer_context_json
       FROM sources
       JOIN workspaces ON workspaces.id = sources.workspace_id
       WHERE workspaces.id = ? AND workspaces.owner_id = ? AND workspaces.deleted_at IS NULL AND workspaces.expires_at > ?
       ORDER BY sources.source_revision ASC`,
    ).bind(workspaceId, ownerId, observedAt),
    db.prepare(
      `SELECT snapshots.revision, snapshots.reason, snapshots.created_at, snapshots.snapshot_json
       FROM snapshots
       JOIN workspaces ON workspaces.id = snapshots.workspace_id AND workspaces.current_snapshot_revision = snapshots.revision
       WHERE workspaces.id = ? AND workspaces.owner_id = ? AND workspaces.deleted_at IS NULL AND workspaces.expires_at > ?`,
    ).bind(workspaceId, ownerId, observedAt),
    db.prepare(
      `SELECT snapshots.revision, snapshots.reason, snapshots.created_at, snapshots.snapshot_json
       FROM snapshots
       JOIN workspaces ON workspaces.id = snapshots.workspace_id
       WHERE workspaces.id = ? AND workspaces.owner_id = ? AND workspaces.deleted_at IS NULL AND workspaces.expires_at > ?
         AND snapshots.revision IN (workspaces.current_snapshot_revision, workspaces.current_snapshot_revision - 1)
       ORDER BY snapshots.revision ASC`,
    ).bind(workspaceId, ownerId, observedAt),
  ]);

  const workspace = firstResult<WorkspaceExportRow>(workspaceResult);
  if (!workspace) throw new ApiException('WORKSPACE_NOT_FOUND', '작업 공간을 찾을 수 없습니다.', 404);
  const snapshotRow = firstResult<SnapshotExportRow>(snapshotResult);
  if (!snapshotRow) throw new ApiException('EXPORT_UNAVAILABLE', '내보낼 현재 내용을 확인하지 못했습니다.', 500);

  try {
    const snapshot = snapshotSchema.parse(JSON.parse(snapshotRow.snapshot_json));
    const sources = ((sourcesResult.results ?? []) as SourceExportRow[]).map(sourceFromRow);
    for (const source of sources) {
      if (source.hash !== await sha256Hex(source.text)) throw new Error('Source content does not match its immutable hash.');
    }
    const revisions = ((revisionsResult.results ?? []) as SnapshotExportRow[]).map(revisionFromRow);
    const content = workspaceExportContentSchema.parse({
      workspace: {
        id: workspace.id,
        title: workspace.title,
        purpose: workspace.purpose,
        revision: workspace.revision,
        sourceRevision: workspace.source_revision,
        createdAt: workspace.created_at,
        updatedAt: workspace.updated_at,
        expiresAt: workspace.expires_at,
      },
      sources,
      snapshot,
      revisions,
    });
    const contentJson = JSON.stringify(content);
    if (textEncoder.encode(contentJson).byteLength > MAX_EXPORT_BYTES) {
      throw new ApiException('WORKSPACE_EXPORT_TOO_LARGE', '현재 작업 공간 내보내기 크기가 한도를 초과했습니다.', 413);
    }

    const exported = workspaceExportSchema.parse({
      format: 'ieojim.workspace',
      version: 1,
      exportedAt: observedAt,
      content,
      checksum: {
        algorithm: 'SHA-256',
        encoding: 'JSON.stringify(content), UTF-8',
        value: await sha256Hex(contentJson),
      },
    });
    if (textEncoder.encode(JSON.stringify(exported)).byteLength > MAX_EXPORT_BYTES) {
      throw new ApiException('WORKSPACE_EXPORT_TOO_LARGE', '현재 작업 공간 내보내기 크기가 한도를 초과했습니다.', 413);
    }
    return exported;
  } catch (error) {
    if (error instanceof ApiException) throw error;
    throw new ApiException('EXPORT_UNAVAILABLE', '내보낼 현재 내용이 손상되었습니다.', 500);
  }
}

function firstResult<T>(result: D1Result<unknown>): T | null {
  return ((result.results ?? [])[0] as T | undefined) ?? null;
}

function revisionFromRow(row: SnapshotExportRow) {
  return {
    revision: row.revision,
    reason: row.reason,
    createdAt: row.created_at,
    snapshot: snapshotSchema.parse(JSON.parse(row.snapshot_json)),
  };
}

function sourceFromRow(row: SourceExportRow): Source {
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    relation: row.relation,
    targetSourceId: row.target_source_id,
    hash: row.hash,
    createdAt: row.created_at,
    ...(row.answer_context_json ? { answerTo: sourceAnswerSchema.parse(JSON.parse(row.answer_context_json)) } : {}),
  };
}
