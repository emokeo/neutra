// Simulates the Google endpoints Neutra calls: token refresh and Calendar events.
import { vi } from "vitest";

export type FakeEvent = { summary: string; start: string; end: string; attendees: { email: string; responseStatus: string }[] };

export function fakeGoogle() {
	const events = new Map<string, FakeEvent>();
	const emails: { raw: string }[] = [];
	let next = 1;
	// Set to make the next event creation fail: "before" fails without creating, "after" creates and then fails.
	const failures = { create: null as null | "before" | "after", read: false };
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

		if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fake-token" });
		if (url.hostname === "gmail.googleapis.com") {
			const { raw } = JSON.parse(String(init?.body));
			emails.push({ raw: Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") });
			return json({ id: `msg${emails.length}` });
		}

		const match = /\/calendar\/v3\/calendars\/primary\/events(?:\/([^/?]+))?/.exec(url.pathname);
		if (!match) return json({ error: "unexpected URL" }, 500);
		const id = match[1] && decodeURIComponent(match[1]);

		if (method === "POST" && !id) {
			const body = JSON.parse(String(init?.body));
			const eventId: string = body.id ?? `evt${next++}`;
			if (failures.create === "before") {
				failures.create = null;
				return json({ error: "backend error" }, 503);
			}
			if (events.has(eventId)) return json({ error: "duplicate" }, 409);
			events.set(eventId, {
				summary: body.summary,
				start: body.start.dateTime,
				end: body.end.dateTime,
				attendees: body.attendees.map((a: { email: string }) => ({ email: a.email, responseStatus: "needsAction" })),
			});
			if (failures.create === "after") {
				failures.create = null;
				return json({ error: "backend error" }, 503);
			}
			return json({ id: eventId });
		}
		if (method === "GET" && id) {
			if (failures.read) return json({ error: "backend error" }, 503);
			const event = events.get(id);
			return event ? json(event) : json({}, 404);
		}
		if (method === "DELETE" && id) {
			return events.delete(id) ? new Response(null, { status: 204 }) : json({}, 410);
		}
		return json({ error: "unexpected request" }, 500);
	});

	/** Sets an attendee's reply, as if they clicked Yes or No in their calendar. */
	function reply(eventId: string, email: string, responseStatus: "accepted" | "declined") {
		const attendee = events.get(eventId)?.attendees.find((a) => a.email === email);
		if (attendee) attendee.responseStatus = responseStatus;
	}

	return { fetch, events, emails, reply, failures };
}
