CREATE TABLE IF NOT EXISTS recovery_origins (
  recovery_workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  origin_owner_id TEXT NOT NULL,
  origin_workspace_id TEXT NOT NULL,
  origin_revision INTEGER NOT NULL,
  origin_source_revision INTEGER NOT NULL,
  origin_source_id TEXT NOT NULL,
  origin_source_hash TEXT NOT NULL,
  origin_target_item_id TEXT NOT NULL,
  origin_preparation_item_id TEXT,
  source_mode TEXT NOT NULL CHECK(source_mode IN ('live','fixture','user')),
  origin_json TEXT NOT NULL,
  notice_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_origins_origin_lookup
  ON recovery_origins(origin_owner_id, origin_workspace_id, origin_revision, origin_source_revision, origin_source_id, origin_source_hash);
