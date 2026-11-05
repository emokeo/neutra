-- Neutra funnel for the last 14 days, plus the goal count. Run with the "Stats" workflow.
-- One short query per row (D1 limits UNION ALL). TEAM_IDS is replaced by the workflow with the
-- person IDs of ALLOWED_EMAILS (you and your testers). RECENT is the 14-day window.
SELECT 'decisions started' AS step, COUNT(DISTINCT decision_ref) AS n FROM events WHERE type = 'decision_created' AND RECENT;
SELECT 'message opened (link)' AS step, COUNT(DISTINCT decision_ref) AS n FROM events WHERE type = 'handoff_opened' AND RECENT;
SELECT 'answered by the second person' AS step, COUNT(DISTINCT decision_ref) AS n FROM events WHERE type = 'answer_submitted' AND RECENT;
SELECT 'time found' AS step, COUNT(DISTINCT decision_ref) AS n FROM events WHERE type = 'answer_submitted' AND json_extract(detail_json, '$.outcome') = 'match' AND RECENT;
SELECT 'invite accepted by both' AS step, COUNT(DISTINCT decision_ref) AS n FROM events WHERE type = 'invite_reply' AND json_extract(detail_json, '$.state') = 'ACCEPTED' AND RECENT;
SELECT 'distinct starters' AS step, COUNT(DISTINCT person) AS n FROM events WHERE type = 'decision_created' AND RECENT;
SELECT 'distinct responders' AS step, COUNT(DISTINCT person) AS n FROM events WHERE type = 'answer_submitted' AND RECENT;
SELECT 'failed requests' AS step, COUNT(*) AS n FROM events WHERE type = 'request_failed' AND RECENT;
SELECT 'answers or requests too narrow (rejected, retry possible)' AS step, COUNT(*) AS n FROM events WHERE type = 'request_failed' AND json_extract(detail_json, '$.reason') = 'TOO_NARROW' AND RECENT;
SELECT 'requests by ' || COALESCE(client, 'unknown') AS step, COUNT(*) AS n FROM events WHERE type IN ('decision_created', 'answer_submitted') AND RECENT GROUP BY client;
SELECT 'outside starters (without you and testers)' AS step, COUNT(DISTINCT person) AS n FROM events WHERE type = 'decision_created' AND person NOT IN (TEAM_IDS) AND RECENT;
SELECT 'answered in the browser (no assistant)' AS step, COUNT(DISTINCT decision_ref) AS n FROM events WHERE type = 'answer_submitted' AND client = 'web' AND RECENT;
-- The goal counts requests from assistants, so answers on the web page don't count toward it.
SELECT 'outside requests from assistants, all time (goal: 1,000)' AS step, COUNT(*) AS n FROM events WHERE type IN ('decision_created', 'answer_submitted') AND client != 'web' AND person NOT IN (TEAM_IDS);
