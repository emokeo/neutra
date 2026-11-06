# Neutra runbook

## Changes and deploys
- All changes go through pull requests. The `check` job (type check + tests) runs on every PR.
- Merging to `main` deploys automatically: migrations in `migrations/` run first, then the Worker.
- **Migrations only add** (new tables, columns, indexes). Never rename, change or drop in a migration: the old code must keep working against the new schema while a deploy is in progress or after a rollback.

## Rolling back
1. **Code:** Cloudflare dashboard → Workers & Pages → neutra → Deployments → pick the previous version → *Rollback*. Or `npx wrangler rollback`.
2. **Data:** D1 keeps point-in-time history (Time Travel). `npx wrangler d1 time-travel info neutra` shows the current bookmark; `npx wrangler d1 time-travel restore neutra --timestamp=<ISO time>` restores. This overwrites everything written since, so only for real damage.
3. Revert the PR on GitHub so `main` matches what runs.

## Daily health check
`.github/workflows/health.yml` runs every morning and fails (GitHub emails you) when:
- the home page is down,
- the inviter key is refused or lacks `calendar.events` / `gmail.send`,
- failure emails have been stuck for over an hour,
- answers have been stuck for over an hour (the 15-minute job couldn't reach Google to finish them),
- requests failed with an internal error in the last 24 hours.

## The inviter key (neutra.invites@gmail.com)
When the health check says the key is refused or missing a permission:
1. Incognito window, signed in as neutra.invites@gmail.com → developers.google.com/oauthplayground.
2. Gear → *Use your own OAuth credentials* → the web client's ID and secret.
3. *Input your own scopes*: `https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send` → *Authorize APIs* → *Advanced* → *Go to Neutra* → allow.
4. *Exchange authorization code for tokens* → copy the refresh token → GitHub secret `INVITER_REFRESH_TOKEN`.
5. Re-run the last deploy (Actions → Check and deploy → Re-run) so the Worker gets the new secret.

## Opening up or closing access
- `ACCESS_MODE` in `wrangler.jsonc`: `"allowlist"` (only `ALLOWED_EMAILS`) or `"open"` (any verified Google account). Change it in a PR.
- To add a tester while on the allowlist: update the `ALLOWED_EMAILS` secret (comma-separated) and re-run the deploy. Removing someone takes effect on their next request.

## Price decisions (PRICE_DECISIONS)
`PRICE_DECISIONS` in `wrangler.jsonc` switches them. Change it in a PR; merging deploys it.
- `"off"` (the default): `create_price_decision` isn't offered, price answers are refused ("Price requests aren't available yet."), and the briefing and every tool (texts and inputs) are exactly as without the feature (checked by `test/tools.test.ts`).
- `"testers"`: only the emails in `ALLOWED_EMAILS` see `create_price_decision`. Anyone holding a code can answer, since the person answering is usually not a tester.
- `"open"`: everyone can start one.

Switching back to `"off"` while price requests are open: they can't be answered any more and expire after their deadline (the starter gets the usual "nobody answered" email). Nothing else is needed.

Check how they're used: D1 Console, `SELECT state, COUNT(*) FROM decisions WHERE kind = 'price' GROUP BY state`. Amounts are never in the events or logs; the agreed price is kept 7 days, then deleted with the decision.

## Numbers
The anonymous usage events identify people by a scrambled ID derived from `COOKIE_ENCRYPTION_KEY`. Replacing that key makes returning people count as new in the stats.
- Actions → *Stats* → Run workflow: the 14-day funnel (started, answered, matched, accepted, distinct people, requests per assistant). "web" means answered on the browser page; those don't count toward the 1,000 goal.
- Feature requests: Cloudflare dashboard → D1 → neutra → Console: `SELECT * FROM feature_requests ORDER BY create_time DESC`.

## If the Gmail account is suspended
Invites and emails stop; decisions still work but nobody gets an invite. Short term: create a new account, a new inviter key (above), update the secret. Long term: a Google Workspace account on Neutra's own domain.

## Dependencies
Actions → *Create lockfile* → Run workflow opens a PR with `package-lock.json`. Needs, once: Settings → Actions → General → *Allow GitHub Actions to create and approve pull requests*. The bot's PR doesn't start the check by itself; close and reopen it.

## The domain (neutra.day)
Registered in Cloudflare (auto-renew on) and attached to the Worker as a Custom Domain: Workers & Pages → neutra → Settings → Domains & Routes. If it lapses, every connected assistant loses Neutra. Google sign-in needs `neutra.day` as an authorized domain (Google Auth Platform → Branding) and `https://neutra.day/callback` as a redirect URI (Clients → the web client).
