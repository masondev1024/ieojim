CREATE TABLE calendar_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'google'),
  provider_subject TEXT NOT NULL,
  provider_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reauth', 'disconnected', 'bootstrap_uncertain')),
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  calendar_id TEXT,
  calendar_summary TEXT,
  scopes_json TEXT NOT NULL CHECK (length(scopes_json) <= 2048),
  token_type TEXT NOT NULL DEFAULT 'Bearer' CHECK (token_type = 'Bearer'),
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  access_token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disconnected_at TEXT,
  UNIQUE(account_id, provider)
);

CREATE INDEX idx_calendar_connections_account ON calendar_connections(account_id, provider, status);

CREATE TABLE calendar_oauth_states (
  state_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL DEFAULT 0,
  code_verifier_ciphertext TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (length(scopes_json) <= 2048),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX idx_calendar_oauth_states_account ON calendar_oauth_states(account_id, session_id, expires_at);
CREATE INDEX idx_calendar_oauth_states_expiry ON calendar_oauth_states(expires_at);

CREATE TABLE calendar_bootstrap_ops (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'uncertain', 'failed')),
  marker TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  provider_calendar_id TEXT,
  UNIQUE(connection_id, operation_id)
);

CREATE INDEX idx_calendar_bootstrap_connection ON calendar_bootstrap_ops(connection_id, status);
CREATE UNIQUE INDEX calendar_bootstrap_one_open ON calendar_bootstrap_ops(connection_id)
  WHERE status IN ('pending','uncertain');
