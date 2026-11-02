-- The code binds to the first person who answers; they get up to 3 answers in total.
ALTER TABLE decisions ADD COLUMN responder_email TEXT;
ALTER TABLE decisions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
