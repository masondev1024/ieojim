ALTER TABLE runs ADD COLUMN changeset_id TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_workspace_changeset
  ON runs(workspace_id, changeset_id);
