CREATE TABLE IF NOT EXISTS tx_guards (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tx_abort (
  id TEXT NOT NULL CHECK (id <> 'abort')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_single_retry
  ON runs(retry_of_run_id)
  WHERE retry_of_run_id IS NOT NULL;
