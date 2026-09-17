-- Content-free model request provenance. Historical and fixture runs remain
-- unknown; no backfill is attempted because raw request bodies are not stored.
ALTER TABLE runs ADD COLUMN provenance_json TEXT
  CHECK (
    provenance_json IS NULL
    OR (json_valid(provenance_json) AND length(CAST(provenance_json AS BLOB)) <= 4096)
  );
