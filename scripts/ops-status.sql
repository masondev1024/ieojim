-- Read-only aggregates. Never select source text, workspace titles, owner tokens,
-- cached responses or model output. Timestamps and daily budgets use UTC.
SELECT
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS observed_at_utc,
  COUNT(*) FILTER (WHERE deleted_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS active_workspaces,
  COUNT(*) FILTER (WHERE deleted_at IS NOT NULL OR expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS awaiting_deletion
FROM workspaces;

SELECT
  status,
  COUNT(*) AS run_count,
  CAST(MAX(MAX(0, (julianday('now') - julianday(COALESCE(claimed_at, created_at))) * 86400)) AS INTEGER) AS oldest_age_seconds
FROM runs
WHERE mode = 'live' AND status IN ('pending', 'running', 'uncertain')
GROUP BY status
ORDER BY status;

SELECT status, COUNT(*) AS runs_updated_last_24h
FROM runs
WHERE mode = 'live' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
GROUP BY status
ORDER BY status;

-- Reservations limit admission; they are not a provider invoice hard cap.
-- Never add both columns together or subtract recorded cost from reservations.
-- Recorded cost can be a conservative reservation fallback when usage is unknown.
SELECT
  COALESCE(SUM(amount_micro_usd) FILTER (WHERE entry_type = 'reserve'), 0) AS reserved_total_micro_usd,
  COALESCE(SUM(amount_micro_usd) FILTER (WHERE entry_type = 'reserve' AND created_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now')), 0) AS reserved_today_micro_usd,
  COALESCE(SUM(amount_micro_usd) FILTER (WHERE entry_type = 'actual'), 0) AS recorded_cost_total_micro_usd,
  COUNT(*) FILTER (WHERE entry_type = 'reserve') AS reservation_count,
  COUNT(*) FILTER (WHERE entry_type = 'actual') AS recorded_cost_count,
  COUNT(*) FILTER (WHERE entry_type = 'policy_violation') AS model_budget_policy_violations,
  COUNT(*) FILTER (WHERE entry_type = 'policy_violation') > 0 AS live_calls_blocked_by_cost_policy
FROM budget_ledger;

-- Includes reservations whose workspace/run was deleted. Unknown is not free.
SELECT COUNT(*) AS reservations_without_recorded_cost,
  COALESCE(SUM(reservation.amount_micro_usd), 0) AS unobserved_reserved_micro_usd
FROM budget_ledger AS reservation
WHERE reservation.entry_type = 'reserve'
  AND NOT EXISTS (
    SELECT 1 FROM budget_ledger AS observation
    WHERE observation.run_id = reservation.run_id AND observation.entry_type = 'actual'
  );

SELECT
  usage.content_bytes AS storage_content_bytes,
  policy.max_content_bytes AS storage_max_content_bytes,
  ROUND(CAST(usage.content_bytes AS REAL) / NULLIF(policy.max_content_bytes, 0), 4) AS storage_used_ratio,
  usage.content_bytes - totals.content_bytes AS storage_reconciliation_delta_bytes
FROM storage_usage AS usage
JOIN storage_policy AS policy ON policy.id = usage.id
CROSS JOIN content_storage_totals AS totals
WHERE usage.id = 1;

SELECT
  strftime('%Y-%m-%d', 'now') AS day,
  COALESCE(day.creations, 0) AS creations_today,
  policy.max_daily_creations,
  COALESCE(day.commands, 0) AS commands_today,
  policy.max_daily_commands
FROM storage_policy AS policy
LEFT JOIN admission_days AS day ON day.day = strftime('%Y-%m-%d', 'now')
WHERE policy.id = 1;
