-- Anonymous usage events for learning, and bookkeeping for expiry emails.
ALTER TABLE decisions ADD COLUMN stats_ref TEXT;
ALTER TABLE decisions ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;

-- No names, emails or times: a random reference per decision, the assistant's name,
-- and a pseudonymous person ID, so steps can be counted and connected.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  decision_ref TEXT,
  client TEXT,
  person TEXT,
  detail_json TEXT NOT NULL,
  create_time TEXT NOT NULL
);

CREATE INDEX events_by_time ON events(create_time);
