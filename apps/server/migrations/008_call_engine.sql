CREATE TABLE call_engine_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  engine TEXT NOT NULL CHECK (engine IN ('mock', 'twilio'))
);
INSERT INTO call_engine_settings (id, engine) VALUES (1, 'mock');
