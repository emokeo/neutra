# Neutra

A neutral place where people's AI agents make decisions together, without anyone seeing anyone else's data. v0: two people's agents find a time to meet.

Runs as a remote MCP server on Cloudflare Workers, with Google sign-in. Based on Cloudflare's `remote-mcp-google-oauth` template.

## Status

v0 logic: five tools (`create_decision`, `create_answer`, `get_decision`, `delete_decision`, `get_answer`) backed by D1. A match sends a calendar invite from Neutra's Gmail account. Access is limited to the emails in `ALLOWED_EMAILS`. Not yet: the expiry job and the two failure emails.

## Setup

1. `npm install`
2. Google Cloud: create an OAuth client (Web application). Scopes: email and profile only. Keep the consent screen in testing mode and add the test users.
   - Authorized redirect URI: `https://neutra.<your-subdomain>.workers.dev/callback` (and `http://localhost:8788/callback` for local dev)
3. Cloudflare: `npx wrangler kv namespace create OAUTH_KV` and `npx wrangler d1 create neutra`, then put both IDs into `wrangler.jsonc`.
4. Inviter: a Gmail account that sends the invites. With the same OAuth client, get a refresh token for that account with the scope `https://www.googleapis.com/auth/calendar.events` (e.g. via the OAuth 2.0 Playground with "Use your own OAuth credentials"). Store it as `INVITER_REFRESH_TOKEN`.
5. Set `MCP_RESOURCE` in `wrangler.jsonc` to `https://neutra.<your-subdomain>.workers.dev/mcp`.
6. Secrets:
   ```
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY
   npx wrangler secret put ALLOWED_EMAILS
   npx wrangler secret put INVITER_REFRESH_TOKEN
   ```
7. `npm run type-check`, then `npm run deploy`.

## Automatic deploy

Every push to `main` is type-checked and deployed by GitHub Actions (`.github/workflows/deploy.yml`). Set these repository secrets once (GitHub → Settings → Secrets and variables → Actions):

`CLOUDFLARE_API_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, `ALLOWED_EMAILS`, `INVITER_REFRESH_TOKEN`

Database migrations in `migrations/` are applied before each deploy.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, fill it in, then `npm run dev`. Test with `npx @modelcontextprotocol/inspector@latest` against `http://localhost:8788/mcp`.
