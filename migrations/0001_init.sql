-- Decisions and their answers. Available windows are deleted as soon as a decision is matched or ends.
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  starter_email TEXT NOT NULL,
  starter_name TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  state TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_used INTEGER NOT NULL DEFAULT 0,
  scheduled_start TEXT,
  scheduled_end TEXT,
  calendar_event_id TEXT,
  expire_time TEXT NOT NULL,
  create_time TEXT NOT NULL,
  update_time TEXT NOT NULL
);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL,
  role TEXT NOT NULL,
  windows_json TEXT NOT NULL,
  create_time TEXT NOT NULL
);

CREATE INDEX answers_by_decision ON answers(decision_id);
