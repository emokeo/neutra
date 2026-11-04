-- Requests now stay open a fixed time (14 days), so when one ends says nothing about the starter's times.
-- offered_until: the last moment the starter's times allow a meeting to start; used to email the starter.
ALTER TABLE decisions ADD COLUMN offered_until TEXT;
UPDATE decisions SET offered_until = expire_time WHERE offered_until IS NULL;
