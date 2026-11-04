// Anonymous usage events: what happened, never who or when they are free.

export type EventType =
	| "decision_created"
	| "answer_submitted"
	| "invite_reply"
	| "decision_deleted"
	| "decision_expired"
	| "request_failed"
	| "handoff_opened";

async function digest(text: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A stable pseudonymous ID per person, so distinct people can be counted without storing emails. */
export async function personId(env: Env, email: string): Promise<string> {
	return (await digest(`${env.COOKIE_ENCRYPTION_KEY}:${email.trim().toLowerCase()}`)).slice(0, 16);
}

/** Records an event. Never throws: learning must not break the product. */
export async function recordEvent(
	env: Env,
	event: {
		type: EventType;
		decisionRef?: string | null;
		client?: string;
		email?: string;
		detail?: Record<string, string | number | boolean>;
	},
): Promise<void> {
	try {
		await env.DB.prepare(
			"INSERT INTO events (type, decision_ref, client, person, detail_json, create_time) VALUES (?, ?, ?, ?, ?, ?)",
		)
			.bind(
				event.type,
				event.decisionRef ?? null,
				event.client ?? "unknown",
				event.email ? await personId(env, event.email) : null,
				JSON.stringify(event.detail ?? {}),
				new Date().toISOString(),
			)
			.run();
	} catch (error) {
		console.error("recordEvent failed", error);
	}
}
