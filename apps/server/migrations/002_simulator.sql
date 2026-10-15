CREATE TABLE review_plans (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);
CREATE TABLE call_attempts (
  id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  internal TEXT NOT NULL CHECK (json_valid(internal)),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  replay_floor INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_active_call ON call_attempts (active) WHERE active = 1;
CREATE TABLE call_events (
  attempt_id TEXT NOT NULL REFERENCES call_attempts(id),
  sequence INTEGER NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (attempt_id, sequence)
);
CREATE TABLE commands (
  key TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  body TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES call_attempts(id)
);
