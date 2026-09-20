CREATE TABLE recovery_calendar_verifications (
  action_id TEXT PRIMARY KEY REFERENCES recovery_actions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('not_checked','checking','matched','drifted','unavailable','stale')),
  last_result_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT,
  watch_enabled INTEGER NOT NULL DEFAULT 0 CHECK(watch_enabled IN (0,1)),
  watch_expires_at TEXT,
  next_check_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  stopped_reason TEXT,
  claim_token TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX recovery_calendar_verifications_due
  ON recovery_calendar_verifications(watch_enabled, next_check_at, status);

CREATE INDEX recovery_calendar_verifications_workspace
  ON recovery_calendar_verifications(owner_id, workspace_id, updated_at);

CREATE INDEX recovery_calendar_verifications_connection
  ON recovery_calendar_verifications(account_id, connection_id, connection_version);

CREATE INDEX recovery_requests_workspace ON recovery_requests(workspace_id);
