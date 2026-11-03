-- Neutra funnel for the last 14 days. Run with the "Stats" workflow, or:
-- npx wrangler d1 execute neutra --remote --file scripts/funnel.sql
WITH recent AS (
  SELECT * FROM events WHERE create_time > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
),
decisions_started AS (SELECT DISTINCT decision_ref FROM recent WHERE type = 'decision_created'),
answered AS (SELECT DISTINCT decision_ref FROM recent WHERE type = 'answer_submitted'),
matched AS (
  SELECT DISTINCT decision_ref FROM recent
  WHERE type = 'answer_submitted' AND json_extract(detail_json, '$.outcome') = 'match'
)
SELECT 'decisions started' AS step, COUNT(*) AS n FROM decisions_started
UNION ALL SELECT 'answered by the second person', COUNT(*) FROM answered WHERE decision_ref IN (SELECT decision_ref FROM decisions_started)
UNION ALL SELECT 'time found', COUNT(*) FROM matched WHERE decision_ref IN (SELECT decision_ref FROM decisions_started)
UNION ALL SELECT 'invite accepted by both', COUNT(DISTINCT decision_ref) FROM recent WHERE type = 'invite_reply' AND json_extract(detail_json, '$.state') = 'ACCEPTED'
UNION ALL SELECT 'distinct starters', COUNT(DISTINCT person) FROM recent WHERE type = 'decision_created'
UNION ALL SELECT 'distinct responders', COUNT(DISTINCT person) FROM recent WHERE type = 'answer_submitted'
UNION ALL SELECT 'requests (creates + answers)', COUNT(*) FROM recent WHERE type IN ('decision_created', 'answer_submitted')
UNION ALL SELECT 'failed requests', COUNT(*) FROM recent WHERE type = 'request_failed'
UNION ALL SELECT 'requests by ' || COALESCE(client, 'unknown'), COUNT(*) FROM recent WHERE type IN ('decision_created', 'answer_submitted') GROUP BY client;
