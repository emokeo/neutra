// Bindings and secrets available to the Worker.
// `env` from "cloudflare:workers" and the handler's `env` argument share this one declaration.

declare namespace Cloudflare {
	interface Env {
		MCP_RESOURCE: string;
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
