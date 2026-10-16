CREATE TABLE llm_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL
);
CREATE TABLE llm_credentials (
  provider TEXT PRIMARY KEY CHECK (provider IN ('openai', 'anthropic')),
  encrypted_value TEXT NOT NULL
);
