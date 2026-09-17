-- Immutable user answers retain the exact earlier question context, separate
-- from source text so citations must still reference the user's actual answer.
ALTER TABLE sources ADD COLUMN answer_context_json TEXT;
DROP TRIGGER sources_storage_insert;
DROP TRIGGER sources_storage_update;
DROP TRIGGER sources_storage_delete;
DROP VIEW content_storage_totals;
CREATE VIEW content_storage_totals AS
SELECT COALESCE((SELECT SUM(length(CAST(title AS BLOB)) + length(CAST(purpose AS BLOB)) + length(CAST(COALESCE(pending_changeset_json, '') AS BLOB))) FROM workspaces), 0)
  + COALESCE((SELECT SUM(length(CAST(title AS BLOB)) + length(CAST(text AS BLOB)) + length(CAST(COALESCE(answer_context_json, '') AS BLOB))) FROM sources), 0)
  + COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB))) FROM snapshots), 0)
  + COALESCE((SELECT SUM(length(CAST(response_json AS BLOB))) FROM applied_commands), 0) AS content_bytes;
CREATE TRIGGER sources_storage_insert AFTER INSERT ON sources
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.title, '') AS BLOB)) + length(CAST(COALESCE(NEW.text, '') AS BLOB)) + length(CAST(COALESCE(NEW.answer_context_json, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER sources_storage_delete AFTER DELETE ON sources
BEGIN UPDATE storage_usage SET content_bytes = content_bytes - (length(CAST(COALESCE(OLD.title, '') AS BLOB)) + length(CAST(COALESCE(OLD.text, '') AS BLOB)) + length(CAST(COALESCE(OLD.answer_context_json, '') AS BLOB))) WHERE id = 1; END;
CREATE TRIGGER sources_storage_update AFTER UPDATE OF title, text, answer_context_json ON sources
WHEN (length(CAST(COALESCE(NEW.title, '') AS BLOB)) + length(CAST(COALESCE(NEW.text, '') AS BLOB)) + length(CAST(COALESCE(NEW.answer_context_json, '') AS BLOB))) <> (length(CAST(COALESCE(OLD.title, '') AS BLOB)) + length(CAST(COALESCE(OLD.text, '') AS BLOB)) + length(CAST(COALESCE(OLD.answer_context_json, '') AS BLOB)))
BEGIN UPDATE storage_usage SET content_bytes = content_bytes + (length(CAST(COALESCE(NEW.title, '') AS BLOB)) + length(CAST(COALESCE(NEW.text, '') AS BLOB)) + length(CAST(COALESCE(NEW.answer_context_json, '') AS BLOB))) - (length(CAST(COALESCE(OLD.title, '') AS BLOB)) + length(CAST(COALESCE(OLD.text, '') AS BLOB)) + length(CAST(COALESCE(OLD.answer_context_json, '') AS BLOB))) WHERE id = 1; END;
