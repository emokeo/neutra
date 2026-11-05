// Calendar invites and short notice emails, sent from Neutra's own Google account (the "inviter").
// The inviter's refresh token is a secret; users' calendars are never accessed.

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type InviteReply = "NEEDS_ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE";

// Reused across calls in the same isolate until shortly before it expires.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(env: Env): Promise<string> {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: env.INVITER_REFRESH_TOKEN,
		}),
	});
	if (!response.ok) {
		throw new Error(`Inviter token refresh failed: ${response.status}`);
	}
	const { access_token, expires_in } = (await response.json()) as { access_token: string; expires_in?: number };
	cachedToken = { token: access_token, expiresAt: Date.now() + (expires_in ?? 3000) * 1000 };
	return access_token;
}

/** A Google API call with the inviter's token; on 401 the cached token is dropped and the call retried once. */
async function google(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
	const call = async () =>
		fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await accessToken(env)}` } });
	let response = await call();
	if (response.status === 401) {
		cachedToken = null;
		response = await call();
	}
	return response;
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** An event ID Neutra chooses itself (Google accepts base32hex IDs), so a half-finished answer can be traced. */
export function newEventId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => BASE32HEX[b % 32]).join("");
}

/** Creates the event under the given ID. If it already exists (a retried call), that counts as done. */
export async function createEvent(
	env: Env,
	event: { id: string; summary: string; start: string; end: string; attendees: string[] },
): Promise<string> {
	const response = await google(env, `${CALENDAR}?sendUpdates=all`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: event.id,
			summary: event.summary,
			description: `Arranged by Neutra (${env.MCP_RESOURCE.replace(/^https?:\/\//, "").replace(/\/mcp$/, "")}): found without either of you sharing your calendar.`,
			start: { dateTime: event.start },
			end: { dateTime: event.end },
			attendees: event.attendees.map((email) => ({ email })),
		}),
	});
	if (!response.ok && response.status !== 409) {
		throw new Error(`Creating the calendar event failed: ${response.status}`);
	}
	return event.id;
}

/** Whether the event exists (and isn't cancelled). */
export async function eventExists(env: Env, eventId: string): Promise<boolean> {
	const response = await google(env, `${CALENDAR}/${encodeURIComponent(eventId)}`);
	if (response.status === 404 || response.status === 410) return false;
	if (!response.ok) throw new Error(`Reading the calendar event failed: ${response.status}`);
	const { status } = (await response.json()) as { status?: string };
	return status !== "cancelled";
}

/** Each attendee's reply, keyed by lowercase email. */
export async function getReplies(env: Env, eventId: string): Promise<Map<string, InviteReply>> {
	const response = await google(env, `${CALENDAR}/${encodeURIComponent(eventId)}`);
	if (!response.ok) {
		throw new Error(`Reading the calendar event failed: ${response.status}`);
	}
	const { attendees = [] } = (await response.json()) as {
		attendees?: { email: string; responseStatus: string }[];
	};
	const replies = new Map<string, InviteReply>();
	for (const a of attendees) {
		const reply =
			a.responseStatus === "accepted"
				? "ACCEPTED"
				: a.responseStatus === "declined"
					? "DECLINED"
					: a.responseStatus === "tentative"
						? "TENTATIVE"
						: "NEEDS_ACTION";
		replies.set(a.email.toLowerCase(), reply);
	}
	return replies;
}

/** Removes the event. With notify, Google sends both people a cancellation; without, it's quiet cleanup. */
export async function deleteEvent(env: Env, eventId: string, notify = true): Promise<void> {
	const response = await google(env, `${CALENDAR}/${encodeURIComponent(eventId)}?sendUpdates=${notify ? "all" : "none"}`, {
		method: "DELETE",
	});
	if (!response.ok && response.status !== 404 && response.status !== 410) {
		throw new Error(`Cancelling the calendar event failed: ${response.status}`);
	}
}

function base64Url(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sends a plain-text email from the inviter account (needs the gmail.send scope). */
export async function sendEmail(env: Env, email: { to: string; subject: string; body: string }): Promise<void> {
	const subject = `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(email.subject)))}?=`;
	const raw = [`To: ${email.to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8", "", email.body].join("\r\n");
	const response = await google(env, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ raw: base64Url(raw) }),
	});
	if (!response.ok) {
		throw new Error(`Sending the email failed: ${response.status}`);
	}
}
