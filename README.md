# Neutra

A neutral place where people's AI agents make decisions together, without anyone seeing anyone else's data. v0: two people's agents find a time to meet.

Runs as a remote MCP server on Cloudflare Workers, with Google sign-in. Based on Cloudflare's `remote-mcp-google-oauth` template.

- MCP endpoint: `https://neutra.neutra-dev.workers.dev/mcp`
- Home and privacy pages: `/` and `/privacy`

## Status

v0 logic: five tools (`create_decision`, `create_answer`, `get_decision`, `delete_decision`, `get_answer`) backed by D1. A match sends a calendar invite from Neutra's Gmail account. Access is limited to the emails in `ALLOWED_EMAILS`. Not yet: the expiry job and the two failure emails.

## Deploy

Every push to `main` is type-checked and deployed by GitHub Actions (`.github/workflows/deploy.yml`). Migrations in `migrations/` are applied before each deploy. Changes go through pull requests; the check runs on every pull request.

## Setup (done once)

**Cloudflare**
- Account ID and the `MCP_RESOURCE` address are in `wrangler.jsonc`.
- API token: "Edit Cloudflare Workers" template plus **D1: Edit**.
- The D1 database (EU jurisdiction) and the `OAUTH_KV` namespace were created by the manual workflow `.github/workflows/setup.yml`; their IDs are in `wrangler.jsonc`.

**Google Cloud** (project `neutra`)
- Google Auth Platform: audience External, publishing status **In production** (testing mode makes refresh tokens expire after 7 days). Branding: home page and privacy links above, authorized domain `neutra-dev.workers.dev`.
- Web client with redirect URIs `https://neutra.neutra-dev.workers.dev/callback` and `https://developers.google.com/oauthplayground` (add `http://localhost:8788/callback` for local dev).
- Google Calendar API enabled.
- Sign-in asks only for email and profile; access is restricted by `ALLOWED_EMAILS`, not by Google.

**Inviter** (`neutra.invites@gmail.com`)
- Refresh token with scope `https://www.googleapis.com/auth/calendar.events`, obtained via the OAuth 2.0 Playground using the web client's own credentials.

**GitHub secrets** (Settings → Secrets and variables → Actions)

| Secret | What |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Web client |
| `COOKIE_ENCRYPTION_KEY` | Any long random string |
| `ALLOWED_EMAILS` | Comma-separated emails of the test users |
| `INVITER_REFRESH_TOKEN` | Inviter's refresh token |

## Local development

`npm install`, copy `.dev.vars.example` to `.dev.vars` and fill it in, then `npm run dev`. Test with `npx @modelcontextprotocol/inspector@latest` against `http://localhost:8788/mcp`.
