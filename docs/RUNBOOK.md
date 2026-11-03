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

## Numbers
- Actions → *Stats* → Run workflow: the 14-day funnel (started, answered, matched, accepted, distinct people, requests per assistant).
- Feature requests: Cloudflare dashboard → D1 → neutra → Console: `SELECT * FROM feature_requests ORDER BY create_time DESC`.

## If the Gmail account is suspended
Invites and emails stop; decisions still work but nobody gets an invite. Short term: create a new account, a new inviter key (above), update the secret. Long term: a Google Workspace account on Neutra's own domain.

## Dependencies
Actions → *Create lockfile* → Run workflow opens a PR with `package-lock.json`. Needs, once: Settings → Actions → General → *Allow GitHub Actions to create and approve pull requests*. The bot's PR doesn't start the check by itself; close and reopen it.
