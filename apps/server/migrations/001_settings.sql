CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
);

INSERT INTO app_settings (id, value, updated_at) VALUES (
  1,
  '{"defaultCallLimits":{"maxDurationSeconds":300,"maxEstimatedCost":{"amountMinor":200,"currency":"USD"}},"transcriptRetentionDays":30}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
