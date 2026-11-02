-- Fast counting for rate limits.
CREATE INDEX events_by_person ON events(person, type, create_time);
CREATE INDEX decisions_by_starter ON decisions(starter_email, create_time);
