-- Price decisions: each side gives one limit; Neutra reports only the agreed price or "no deal".
-- kind: 'meeting' or 'price'. Existing decisions are meetings.
ALTER TABLE decisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'meeting';
-- subject, details, currency, unit, starterSide ("PAYS" or "RECEIVES") and rule, as shown to both sides.
ALTER TABLE decisions ADD COLUMN terms_json TEXT;
-- The starter's limit, encrypted with a key made from the request code (stored only as a hash),
-- so a copy of the database can't reveal it. Cleared as soon as the request settles or ends.
-- The answering person's limit is never stored at all.
ALTER TABLE decisions ADD COLUMN limit_sealed TEXT;
-- The agreed price in the currency's smallest unit (e.g. cents), only after a deal.
ALTER TABLE decisions ADD COLUMN agreed_minor INTEGER;
