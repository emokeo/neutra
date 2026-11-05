// Signed cookies for the web answer page. No server-side sessions: the cookie itself says who signed in,
// signed with COOKIE_ENCRYPTION_KEY so it can't be forged, and it expires after an hour.

export const SESSION_COOKIE = "__Host-neutra-web";
export const LOGIN_COOKIE = "__Host-neutra-login";
export const SESSION_SECONDS = 60 * 60;
export const LOGIN_SECONDS = 10 * 60;

export type WebSession = { email: string; name: string };

function base64url(bytes: Uint8Array): string {
	let text = "";
	for (const b of bytes) text += String.fromCharCode(b);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
	const text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, purpose: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	// The purpose keeps a login cookie from being accepted as a session, and the other way round.
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${purpose}:${data}`));
	return base64url(new Uint8Array(signature));
}

function equal(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** "payload.signature", where payload is base64url JSON with an expiry in seconds ("x"). */
export async function sign(secret: string, purpose: string, payload: Record<string, unknown>, seconds: number, now = Date.now()) {
	const data = base64url(new TextEncoder().encode(JSON.stringify({ ...payload, x: Math.floor(now / 1000) + seconds })));
	return `${data}.${await hmac(secret, purpose, data)}`;
}

/** The payload, or null if the value is missing, forged or expired. */
export async function verify<T>(secret: string, purpose: string, value: string | undefined, now = Date.now()): Promise<T | null> {
	if (!value) return null;
	const [data, signature, extra] = value.split(".");
	if (!data || !signature || extra !== undefined) return null;
	if (!equal(signature, await hmac(secret, purpose, data))) return null;
	try {
		const payload = JSON.parse(new TextDecoder().decode(fromBase64url(data))) as T & { x?: number };
		if (typeof payload.x !== "number" || payload.x * 1000 < now) return null;
		return payload;
	} catch {
		return null;
	}
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
	for (const part of (header ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}

/** A __Host- cookie: HTTPS only, this host only, not readable by scripts. */
export function cookie(name: string, value: string, seconds: number): string {
	return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
