CREATE TABLE app_accounts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE account_primary_owners (
  account_id TEXT PRIMARY KEY REFERENCES app_accounts(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL UNIQUE REFERENCES owners(id) ON DELETE RESTRICT
);

ALTER TABLE owners ADD COLUMN account_id TEXT REFERENCES app_accounts(id);
ALTER TABLE owners ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE owners ADD COLUMN claimed_at TEXT;

CREATE INDEX idx_owners_account_id ON owners(account_id);

CREATE TABLE account_claims (
  account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, request_id)
);
