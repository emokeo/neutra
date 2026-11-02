// Calendar invites and short notice emails, sent from Neutra's own Google account (the "inviter").
// The inviter's refresh token is a secret; users' calendars are never accessed.

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type InviteReply = "NEEDS_ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE";

async function accessToken(env: Env): Promise<string> {
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
	const { access_token } = (await response.json()) as { access_token: string };
	return access_token;
}

export async function createEvent(
	env: Env,
	event: { summary: string; start: string; end: string; attendees: string[] },
): Promise<string> {
	const response = await fetch(`${CALENDAR}?sendUpdates=all`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await accessToken(env)}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			summary: event.summary,
			description: "Arranged by Neutra.",
			start: { dateTime: event.start },
			end: { dateTime: event.end },
			attendees: event.attendees.map((email) => ({ email })),
		}),
	});
	if (!response.ok) {
		throw new Error(`Creating the calendar event failed: ${response.status}`);
	}
	const { id } = (await response.json()) as { id: string };
	return id;
}

/** Each attendee's reply, keyed by lowercase email. */
export async function getReplies(env: Env, eventId: string): Promise<Map<string, InviteReply>> {
	const response = await fetch(`${CALENDAR}/${encodeURIComponent(eventId)}`, {
		headers: { Authorization: `Bearer ${await accessToken(env)}` },
	});
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

/** Cancels the event; Google notifies the attendees. */
export async function deleteEvent(env: Env, eventId: string): Promise<void> {
	const response = await fetch(`${CALENDAR}/${encodeURIComponent(eventId)}?sendUpdates=all`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${await accessToken(env)}` },
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
	const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
		method: "POST",
		headers: { Authorization: `Bearer ${await accessToken(env)}`, "Content-Type": "application/json" },
		body: JSON.stringify({ raw: base64Url(raw) }),
	});
	if (!response.ok) {
		throw new Error(`Sending the email failed: ${response.status}`);
	}
}
