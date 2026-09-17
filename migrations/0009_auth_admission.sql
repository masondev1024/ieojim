-- Pilot admission bounds for authentication metadata, independent of AI spend.
CREATE TABLE auth_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_accounts INTEGER NOT NULL CHECK (max_accounts > 0),
  max_sessions INTEGER NOT NULL CHECK (max_sessions > 0),
  max_sessions_per_account INTEGER NOT NULL CHECK (max_sessions_per_account > 0),
  max_pending_verifications INTEGER NOT NULL CHECK (max_pending_verifications > 0),
  max_daily_logins INTEGER NOT NULL CHECK (max_daily_logins > 0)
);
INSERT INTO auth_policy VALUES (1, 200, 2000, 20, 1000, 1000);
CREATE TABLE auth_admission_days (
  day TEXT PRIMARY KEY,
  login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (login_attempts >= 0)
);
CREATE TRIGGER auth_user_admission BEFORE INSERT ON auth_user
BEGIN
  SELECT RAISE(ABORT, 'IEOJIM_AUTH_POLICY_MISSING') WHERE NOT EXISTS (SELECT 1 FROM auth_policy WHERE id = 1);
  SELECT RAISE(ABORT, 'IEOJIM_AUTH_ADMISSION_LIMIT') WHERE (SELECT COUNT(*) FROM auth_user) >= (SELECT max_accounts FROM auth_policy WHERE id = 1);
END;
CREATE TRIGGER auth_session_admission BEFORE INSERT ON auth_session
BEGIN
  SELECT RAISE(ABORT, 'IEOJIM_AUTH_POLICY_MISSING') WHERE NOT EXISTS (SELECT 1 FROM auth_policy WHERE id = 1);
  DELETE FROM auth_session WHERE "expiresAt" <= NEW."createdAt";
  SELECT RAISE(ABORT, 'IEOJIM_AUTH_ADMISSION_LIMIT') WHERE (SELECT COUNT(*) FROM auth_session) >= (SELECT max_sessions FROM auth_policy WHERE id = 1);
  SELECT RAISE(ABORT, 'IEOJIM_AUTH_ADMISSION_LIMIT') WHERE (SELECT COUNT(*) FROM auth_session WHERE "userId" = NEW."userId") >= (SELECT max_sessions_per_account FROM auth_policy WHERE id = 1);
END;
CREATE TRIGGER auth_verification_admission BEFORE INSERT ON auth_verification
BEGIN
  SELECT RAISE(ABORT, 'IEOJIM_AUTH_POLICY_MISSING') WHERE NOT EXISTS (SELECT 1 FROM auth_policy WHERE id = 1);
  DELETE FROM auth_verification WHERE "expiresAt" <= NEW."createdAt";
  SELECT RAISE(ABORT, 'IEOJIM_AUTH_ADMISSION_LIMIT') WHERE (SELECT COUNT(*) FROM auth_verification) >= (SELECT max_pending_verifications FROM auth_policy WHERE id = 1);
  INSERT INTO auth_admission_days(day, login_attempts) VALUES (substr(NEW."createdAt", 1, 10), 1)
    ON CONFLICT(day) DO UPDATE SET login_attempts = login_attempts + 1;
  SELECT RAISE(ABORT, 'IEOJIM_AUTH_ADMISSION_LIMIT') WHERE (SELECT login_attempts FROM auth_admission_days WHERE day = substr(NEW."createdAt", 1, 10)) > (SELECT max_daily_logins FROM auth_policy WHERE id = 1);
END;
