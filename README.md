# Neutra

A neutral place where people's AI agents make decisions together, without anyone seeing anyone else's data. v0: two people's agents find a time to meet.

Runs as a remote MCP server on Cloudflare Workers, with Google sign-in. Based on Cloudflare's `remote-mcp-google-oauth` template.

## Status

Skeleton. `create_decision` validates the request and returns a decision with a code, but stores nothing yet. Access is limited to the emails in `ALLOWED_EMAILS`.

## Setup

1. `npm install`
2. Google Cloud: create an OAuth client (Web application). Scopes: email and profile only. Keep the consent screen in testing mode and add the test users.
   - Authorized redirect URI: `https://neutra.<your-subdomain>.workers.dev/callback` (and `http://localhost:8788/callback` for local dev)
3. Cloudflare: `npx wrangler kv namespace create OAUTH_KV`, then put the ID into `wrangler.jsonc`.
4. Set `MCP_RESOURCE` in `wrangler.jsonc` to `https://neutra.<your-subdomain>.workers.dev/mcp`.
5. Secrets:
   ```
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY
   npx wrangler secret put ALLOWED_EMAILS
   ```
6. `npm run type-check`, then `npm run deploy`.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, fill it in, then `npm run dev`. Test with `npx @modelcontextprotocol/inspector@latest` against `http://localhost:8788/mcp`.
