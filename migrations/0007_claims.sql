-- Which answer is being processed (claim_id), and the invite it is about to send (pending_event_id),
-- so a crash between the invite and the database write can be finished instead of lost.
ALTER TABLE decisions ADD COLUMN claim_id TEXT;
ALTER TABLE decisions ADD COLUMN pending_event_id TEXT;
