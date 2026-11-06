// Bindings and secrets available to the Worker.
// `env` from "cloudflare:workers" and the handler's `env` argument share this one declaration.

declare namespace Cloudflare {
	interface Env {
		MCP_RESOURCE: string;
		ACCESS_MODE?: "allowlist" | "open";
		// Price decisions: "off" (the default), "testers" (only ALLOWED_EMAILS can start one) or "open".
		PRICE_DECISIONS?: "off" | "testers" | "open";
		OAUTH_KV: KVNamespace;
		DB: D1Database;
		GOOGLE_CLIENT_ID: string;
		GOOGLE_CLIENT_SECRET: string;
		COOKIE_ENCRYPTION_KEY: string;
		HOSTED_DOMAIN?: string;
		ALLOWED_EMAILS: string;
		INVITER_REFRESH_TOKEN: string;
	}
}

interface Env extends Cloudflare.Env {}
