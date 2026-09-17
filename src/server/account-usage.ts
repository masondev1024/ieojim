import type { AccountUsage } from '../core/account-contracts';

const workspaceLimit = 10;
const retentionDays = 7;

type WorkspaceUsageRow = {
  id: string;
  title: string;
  revision: number;
  source_revision: number;
  updated_at: string;
  expires_at: string;
};
type RunUsageRow = { used: number };

export async function readAccountUsage(
  db: D1Database,
  accountId: string,
  dailyRunLimit: number,
  now = new Date(),
): Promise<AccountUsage> {
  const asOf = now.toISOString();
  const dayStart = utcDayStart(now).toISOString();
  const resetAt = nextUtcMidnight(now).toISOString();
  const [workspaceResult, runResult] = await db.batch([
    db.prepare(`
      SELECT workspaces.id, workspaces.title, workspaces.revision, workspaces.source_revision, workspaces.updated_at, workspaces.expires_at
      FROM workspaces
      JOIN owners ON owners.id = workspaces.owner_id
      WHERE owners.account_id = ?
        AND workspaces.deleted_at IS NULL
        AND workspaces.expires_at > ?
      ORDER BY workspaces.updated_at DESC, workspaces.id ASC
    `).bind(accountId, asOf),
    db.prepare(`
      SELECT COUNT(*) AS used
      FROM budget_ledger
      JOIN owners ON owners.id = budget_ledger.owner_id
      WHERE owners.account_id = ?
        AND budget_ledger.entry_type = 'reserve'
        AND budget_ledger.created_at >= ?
    `).bind(accountId, dayStart),
  ]);
  const workspaces = ((workspaceResult.results ?? []) as WorkspaceUsageRow[]).map((workspace) => ({
    id: workspace.id,
    title: workspace.title,
    revision: workspace.revision,
    sourceRevision: workspace.source_revision,
    updatedAt: workspace.updated_at,
    expiresAt: workspace.expires_at,
  }));
  const runRows = (runResult.results ?? []) as RunUsageRow[];
  const usedRuns = runRows[0]?.used ?? 0;

  return {
    asOf,
    retentionDays,
    activeWorkspaces: { used: workspaces.length, limit: workspaceLimit },
    aiRunsToday: { used: usedRuns, limit: normalizeLimit(dailyRunLimit), resetAt },
    workspaces,
  };
}

function utcDayStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function nextUtcMidnight(date: Date) {
  const start = utcDayStart(date);
  start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

function normalizeLimit(limit: number) {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}
