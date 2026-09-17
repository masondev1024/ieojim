CREATE TABLE recovery_profiles (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  condition_revision INTEGER NOT NULL CHECK(condition_revision > 0),
  base_revision INTEGER NOT NULL,
  base_source_revision INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  applied_revision INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE recovery_versions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  condition_revision INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, condition_revision)
);
CREATE TABLE recovery_requests (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, request_id)
);
CREATE TABLE recovery_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  condition_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('calendar','email')),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','executing','verified','accepted','uncertain','conflict','failed','cancelled')),
  progress_json TEXT NOT NULL DEFAULT '{}',
  message TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, request_id)
);
CREATE INDEX recovery_actions_pending ON recovery_actions(status, updated_at);
CREATE UNIQUE INDEX recovery_actions_one_active ON recovery_actions(workspace_id)
  WHERE status IN ('queued','executing','uncertain');
CREATE TABLE recovery_calendar_events (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  etag TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id, connection_id, item_id)
);
