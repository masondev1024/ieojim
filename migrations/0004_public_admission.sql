-- Admission limits protect public anonymous use independently of model billing.
-- content_bytes counts UTF-8 application content, NOT SQLite pages/index overhead.
-- Counters and content writes share the caller's D1 transaction. Deletion refunds
-- storage only; daily creation/command admission is never refunded.
CREATE TABLE storage_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_active_workspaces INTEGER NOT NULL CHECK (max_active_workspaces >= 0),
  max_daily_creations INTEGER NOT NULL CHECK (max_daily_creations >= 0),
  max_daily_commands INTEGER NOT NULL CHECK (max_daily_commands >= 0),
  max_workspace_snapshots INTEGER NOT NULL CHECK (max_workspace_snapshots >= 2),
  max_workspace_commands INTEGER NOT NULL CHECK (max_workspace_commands >= 1),
  max_content_bytes INTEGER NOT NULL CHECK (max_content_bytes >= 0)
);
INSERT INTO storage_policy VALUES (1, 200, 100, 2000, 201, 300, 52428800);
CREATE TABLE admission_days (
  day TEXT PRIMARY KEY,
  creations INTEGER NOT NULL DEFAULT 0 CHECK (creations >= 0),
  commands INTEGER NOT NULL DEFAULT 0 CHECK (commands >= 0)
);
CREATE TABLE storage_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0)
);
CREATE INDEX idx_budget_entry_created ON budget_ledger(entry_type, created_at);
CREATE INDEX idx_commands_workspace_created ON applied_commands(workspace_id, created_at);
CREATE INDEX idx_workspaces_expiry ON workspaces(expires_at);

CREATE VIEW content_storage_totals AS
SELECT COALESCE((SELECT SUM(length(CAST(COALESCE(title, '') AS BLOB)) + length(CAST(COALESCE(purpose, '') AS BLOB)) + length(CAST(COALESCE(pending_changeset_json, '') AS BLOB))) FROM workspaces), 0)
  + COALESCE((SELECT SUM(length(CAST(COALESCE(title, '') AS BLOB)) + length(CAST(COALESCE(text, '') AS BLOB))) FROM sources), 0)
  + COALESCE((SELECT SUM(length(CAST(COALESCE(snapshot_json, '') AS BLOB))) FROM snapshots), 0)
  + COALESCE((SELECT SUM(length(CAST(COALESCE(response_json, '') AS BLOB))) FROM applied_commands), 0) AS content_bytes;
INSERT INTO storage_usage SELECT 1, content_bytes FROM content_storage_totals;
-- Preserve pre-migration content, even if already above the new cap. New growth
-- is rejected; shrinking and deletion remain available.
CREATE TRIGGER storage_usage_limit AFTER UPDATE OF content_bytes ON storage_usage
WHEN NEW.content_bytes > OLD.content_bytes AND NEW.content_bytes > (SELECT max_content_bytes FROM storage_policy WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'IEOJIM_STORAGE_LIMIT'); END;

CREATE TRIGGER workspace_admission BEFORE INSERT ON workspaces
-- Avoid nested CASE ... END: remote D1 /query currently splits that trigger
-- before its final END, although local SQLite accepts it. WHERE is equivalent.
BEGIN
  SELECT RAISE(ABORT, 'IEOJIM_ADMISSION_LIMIT') WHERE (SELECT COUNT(*) FROM workspaces WHERE deleted_at IS NULL AND expires_at > NEW.created_at) >=
    (SELECT max_active_workspaces FROM storage_policy WHERE id = 1);
  INSERT INTO admission_days(day, creations) VALUES (substr(NEW.created_at, 1, 10), 1)
    ON CONFLICT(day) DO UPDATE SET creations = creations + 1;
  SELECT RAISE(ABORT, 'IEOJIM_ADMISSION_LIMIT') WHERE (SELECT creations FROM admission_days WHERE day = substr(NEW.created_at, 1, 10)) >
    (SELECT max_daily_creations FROM storage_policy WHERE id = 1);
END;

CREATE TRIGGER command_admission BEFORE INSERT ON applied_commands
BEGIN
  SELECT RAISE(ABORT, 'IEOJIM_HISTORY_LIMIT') WHERE (SELECT COUNT(*) FROM applied_commands WHERE workspace_id = NEW.workspace_id) >=
    (SELECT max_workspace_commands FROM storage_policy WHERE id = 1);
  INSERT INTO admission_days(day, commands) VALUES (substr(NEW.created_at, 1, 10), 1)
    ON CONFLICT(day) DO UPDATE SET commands = commands + 1;
  SELECT RAISE(ABORT, 'IEOJIM_ADMISSION_LIMIT') WHERE (SELECT commands FROM admission_days WHERE day = substr(NEW.created_at, 1, 10)) >
    (SELECT max_daily_commands FROM storage_policy WHERE id = 1);
END;

CREATE TRIGGER snapshot_admission BEFORE INSERT ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'IEOJIM_HISTORY_LIMIT') WHERE (SELECT COUNT(*) FROM snapshots WHERE workspace_id = NEW.workspace_id) >=
    (SELECT max_workspace_snapshots FROM storage_policy WHERE id = 1);
END;

CREATE TRIGGER workspaces_storage_insert AFTER INSERT ON workspaces
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.title, '') AS BLOB)) + length(CAST(COALESCE(NEW.purpose, '') AS BLOB)) + length(CAST(COALESCE(NEW.pending_changeset_json, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER workspaces_storage_delete AFTER DELETE ON workspaces
BEGIN UPDATE storage_usage SET content_bytes = content_bytes - (length(CAST(COALESCE(OLD.title, '') AS BLOB)) + length(CAST(COALESCE(OLD.purpose, '') AS BLOB)) + length(CAST(COALESCE(OLD.pending_changeset_json, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER workspaces_storage_update AFTER UPDATE OF title, purpose, pending_changeset_json ON workspaces
WHEN (length(CAST(COALESCE(NEW.title, '') AS BLOB)) + length(CAST(COALESCE(NEW.purpose, '') AS BLOB)) + length(CAST(COALESCE(NEW.pending_changeset_json, '') AS BLOB))) <> (length(CAST(COALESCE(OLD.title, '') AS BLOB)) + length(CAST(COALESCE(OLD.purpose, '') AS BLOB)) + length(CAST(COALESCE(OLD.pending_changeset_json, '') AS BLOB)))
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.title, '') AS BLOB)) + length(CAST(COALESCE(NEW.purpose, '') AS BLOB)) + length(CAST(COALESCE(NEW.pending_changeset_json, '') AS BLOB))) - (length(CAST(COALESCE(OLD.title, '') AS BLOB)) + length(CAST(COALESCE(OLD.purpose, '') AS BLOB)) + length(CAST(COALESCE(OLD.pending_changeset_json, '') AS BLOB))) WHERE id = 1; END;

CREATE TRIGGER sources_storage_insert AFTER INSERT ON sources
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.title, '') AS BLOB)) + length(CAST(COALESCE(NEW.text, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER sources_storage_delete AFTER DELETE ON sources
BEGIN UPDATE storage_usage SET content_bytes = content_bytes - (length(CAST(COALESCE(OLD.title, '') AS BLOB)) + length(CAST(COALESCE(OLD.text, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER sources_storage_update AFTER UPDATE OF title, text ON sources
WHEN (length(CAST(COALESCE(NEW.title, '') AS BLOB)) + length(CAST(COALESCE(NEW.text, '') AS BLOB))) <> (length(CAST(COALESCE(OLD.title, '') AS BLOB)) + length(CAST(COALESCE(OLD.text, '') AS BLOB)))
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.title, '') AS BLOB)) + length(CAST(COALESCE(NEW.text, '') AS BLOB))) - (length(CAST(COALESCE(OLD.title, '') AS BLOB)) + length(CAST(COALESCE(OLD.text, '') AS BLOB))) WHERE id = 1; END;

CREATE TRIGGER snapshots_storage_insert AFTER INSERT ON snapshots
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.snapshot_json, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER snapshots_storage_delete AFTER DELETE ON snapshots
BEGIN UPDATE storage_usage SET content_bytes = content_bytes - (length(CAST(COALESCE(OLD.snapshot_json, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER snapshots_storage_update AFTER UPDATE OF snapshot_json ON snapshots
WHEN (length(CAST(COALESCE(NEW.snapshot_json, '') AS BLOB))) <> (length(CAST(COALESCE(OLD.snapshot_json, '') AS BLOB)))
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.snapshot_json, '') AS BLOB))) - (length(CAST(COALESCE(OLD.snapshot_json, '') AS BLOB))) WHERE id = 1; END;

CREATE TRIGGER applied_commands_storage_insert AFTER INSERT ON applied_commands
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.response_json, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER applied_commands_storage_delete AFTER DELETE ON applied_commands
BEGIN UPDATE storage_usage SET content_bytes = content_bytes - (length(CAST(COALESCE(OLD.response_json, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER applied_commands_storage_update AFTER UPDATE OF response_json ON applied_commands
WHEN (length(CAST(COALESCE(NEW.response_json, '') AS BLOB))) <> (length(CAST(COALESCE(OLD.response_json, '') AS BLOB)))
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.response_json, '') AS BLOB))) - (length(CAST(COALESCE(OLD.response_json, '') AS BLOB))) WHERE id = 1; END;
