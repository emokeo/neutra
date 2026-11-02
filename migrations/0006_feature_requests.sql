-- What people ask Neutra to do next. Only a pseudonymous author ID is kept, never a name or email.
CREATE TABLE feature_requests (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  client TEXT,
  summary TEXT NOT NULL,
  create_time TEXT NOT NULL
);

CREATE INDEX feature_requests_by_author ON feature_requests(author, create_time);
