PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  source_revision INTEGER NOT NULL DEFAULT 0,
  current_snapshot_revision INTEGER NOT NULL DEFAULT 0,
  pending_changeset_json TEXT,
  pending_proposal_revision INTEGER NOT NULL DEFAULT 0,
  sample_scenario TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner_updated
  ON workspaces(owner_id, deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_source_id TEXT,
  hash TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, hash)
);

CREATE INDEX IF NOT EXISTS idx_sources_workspace_revision
  ON sources(workspace_id, source_revision);

CREATE TABLE IF NOT EXISTS snapshots (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, revision)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  error TEXT,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  base_source_revision INTEGER NOT NULL,
  retry_of_run_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
  actual_micro_usd INTEGER,
  claimed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_status_created
  ON runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_owner_created
  ON runs(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_retry_of
  ON runs(retry_of_run_id);

CREATE TABLE IF NOT EXISTS applied_commands (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, request_id)
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  workspace_id TEXT,
  run_id TEXT,
  entry_type TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_budget_owner_created
  ON budget_ledger(owner_id, created_at);
