CREATE TABLE dialogue_phrases (
  phrase_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  language TEXT NOT NULL CHECK (language IN ('es-ES', 'ru-RU', 'en-US', 'pl-PL')),
  template TEXT NOT NULL,
  PRIMARY KEY (phrase_id, version, language)
);
