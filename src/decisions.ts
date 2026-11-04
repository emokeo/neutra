// Decisions and answers: storage, matching and the rules from the v0 API.
import { createEvent, deleteEvent, eventExists, getReplies, newEventId, type InviteReply } from "./calendar";
import { recordEvent } from "./events";
import { checkCreateAnswer, checkCreateDecision } from "./limits";
import { formatRange, isValidTimeZone, parseTimestamp } from "./time";

export type Caller = { email: string; name: string; client?: string };
export type Interval = { startTime: string; endTime: string };

export type State = "WAITING" | "NO_MATCH" | "INVITE_SENT" | "ACCEPTED" | "DECLINED" | "EXPIRED";
// Internal only: an answer is being processed. Shown to callers as WAITING.
type StoredState = State | "MATCHING";

/** An error with a google.rpc canonical code, as in the API's error table. */
export type ErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "FAILED_PRECONDITION" | "INVALID_ARGUMENT" | "RESOURCE_EXHAUSTED";

export class ApiError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

type DecisionRow = {
	id: string;
	starter_email: string;
	starter_name: string;
	duration_seconds: number;
	state: StoredState;
	code_hash: string;
	code_used: number;
	responder_email: string | null;
	attempts: number;
	stats_ref: string | null;
	notified: number;
	scheduled_start: string | null;
	scheduled_end: string | null;
	calendar_event_id: string | null;
	claim_id: string | null;
	pending_event_id: string | null;
	expire_time: string;
	offered_until: string | null;
	create_time: string;
	update_time: string;
};

type AnswerRow = {
	id: string;
	decision_id: string;
	author_email: string;
	author_name: string;
	role: "STARTER" | "RESPONDER";
	windows_json: string;
	time_zone: string | null;
	create_time: string;
};

const MAX_DAYS_AHEAD = 30;
export const ANSWER_DAYS = 14; // every request stays open this long, whatever the starter's times
const MIN_LEAD_MS = 60 * 60 * 1000; // a matched meeting starts at least 1 hour from now
const SLOT_MS = 15 * 60 * 1000; // matched times start on a quarter hour
const MAX_DURATION_S = 24 * 60 * 60;
const MIN_DURATION_S = 15 * 60;
export const MAX_ANSWERS = 3; // the responder's first answer plus 2 retries after "no match"
const MIN_BREADTH = 2; // every answer must cover at least twice the meeting duration

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function randomId(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	// First character is a letter, as AIP-122 asks for resource IDs.
	return Array.from(bytes, (b, i) => (i === 0 ? ALPHABET[b % 26] : ALPHABET[b % 32])).join("");
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function parseDuration(duration: string): number {
	const seconds = /^\d+s$/.test(duration) ? Number(duration.slice(0, -1)) : Number.NaN;
	if (!Number.isInteger(seconds) || seconds < MIN_DURATION_S || seconds > MAX_DURATION_S) {
		throw new ApiError("INVALID_ARGUMENT", 'Duration must be between 15 minutes and 24 hours, in seconds, e.g. "3600s".');
	}
	return seconds;
}

function parseWindows(windows: Interval[], now: number, timeZone?: string): { start: number; end: number }[] {
	if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
		throw new ApiError("INVALID_ARGUMENT", `"${timeZone}" is not a time zone. Use an IANA name, e.g. "Europe/Zurich".`);
	}
	const limit = now + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;
	return windows.map((w) => {
		const start = parseTimestamp(w.startTime, timeZone);
		const end = parseTimestamp(w.endTime, timeZone);
		if (start === null || end === null) {
			throw new ApiError(
				"INVALID_ARGUMENT",
				'Send local times with a timeZone (e.g. "2026-11-04T18:00" and "Europe/Zurich"), or timestamps with an offset (e.g. "2026-11-04T18:00:00+01:00").',
			);
		}
		if (end <= start) {
			throw new ApiError("INVALID_ARGUMENT", "Each window needs a startTime before its endTime.");
		}
		if (end <= now || start > limit) {
			throw new ApiError("INVALID_ARGUMENT", `Windows must lie between now and ${MAX_DAYS_AHEAD} days ahead.`);
		}
		return { start, end };
	});
}

/** The message the starter forwards. Plain text, so it reads well in any chat app. */
/** One thing to paste: "neutra:<decision id>.<code>". */
export function combinedCode(decisionId: string, code: string): string {
	return `neutra:${decisionId}.${code}`;
}

/** Splits a combined code back into decision ID and code, or returns null. */
// Pasted text often brings quotes or a full stop with it.
export function splitCombinedCode(value: string): { id: string; code: string } | null {
	const m = /^[\s"'“”‘’(]*neutra:([a-z][a-z2-7]{25})\.([a-z][a-z2-7]{11})[\s"'“”‘’).,;!]*$/i.exec(value);
	if (m) return { id: m[1].toLowerCase(), code: m[2].toLowerCase() };
	if (/neutra:/i.test(value)) {
		throw new ApiError("INVALID_ARGUMENT", 'The code looks incomplete. Copy it exactly as in the message: "neutra:" followed by 26 characters, a dot and 12 more.');
	}
	return null;
}

/** The message the starter forwards. Plain text, so it reads well in any chat app. */
export function handoffMessage(p: { starterName: string; decisionId: string; code: string; connectorUrl: string }): string {
	const home = p.connectorUrl.replace(/\/mcp$/, "");
	return `${p.starterName} would like to meet you. 👋
Neutra is a scheduling service for AI assistants. You each tell your own assistant when you're free, and Neutra finds a time that fits both, without either of you sharing your calendar. When it finds one, you both get a calendar invite from neutra.invites@gmail.com.

To answer:
1. Add Neutra to your AI assistant (once, about a minute): ${home}/r/${p.decisionId}
2. Paste this to your assistant, with when you're free:
"Answer Neutra request ${combinedCode(p.decisionId, p.code)}. I'm free: …"

Neutra only uses your name and email from Google sign-in, to send you the invite. No AI on Neutra's side sees your times.`;
}

/** Total time covered by the windows, counting overlaps once. */
function coverage(windows: { start: number; end: number }[]): number {
	const sorted = [...windows].sort((a, b) => a.start - b.start);
	let total = 0;
	let end = -Infinity;
	for (const w of sorted) {
		if (w.end <= end) continue;
		total += w.end - Math.max(w.start, end);
		end = w.end;
	}
	return total;
}

// Narrow answers would let repeated tries map the other person's free times.
// Only time where a meeting could actually happen counts: from an hour from now to the 30-day limit,
// in pieces at least as long as the meeting. Otherwise past or tiny windows would pad the total.
function requireBreadth(windows: { start: number; end: number }[], durationSeconds: number, now: number): void {
	const from = now + MIN_LEAD_MS;
	const to = now + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;
	const usable = windows
		.map((w) => ({ start: Math.max(w.start, from), end: Math.min(w.end, to) }))
		.filter((w) => w.end - w.start >= durationSeconds * 1000);
	if (coverage(usable) < MIN_BREADTH * durationSeconds * 1000) {
		throw new ApiError(
			"INVALID_ARGUMENT",
			`The windows must cover at least ${MIN_BREADTH} times the meeting duration in total. Offer more of the times you're free.`,
		);
	}
}

/** The earliest common slot of the given length, or null. */
export function findMatch(
	a: { start: number; end: number }[],
	b: { start: number; end: number }[],
	durationMs: number,
	now: number,
): { start: number; end: number } | null {
	let best: { start: number; end: number } | null = null;
	for (const x of a) {
		for (const y of b) {
			const earliest = Math.max(x.start, y.start, now + MIN_LEAD_MS);
			const start = Math.ceil(earliest / SLOT_MS) * SLOT_MS;
			const end = start + durationMs;
			if (end <= Math.min(x.end, y.end) && (!best || start < best.start)) {
				best = { start, end };
			}
		}
	}
	return best;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

async function load(env: Env, id: string): Promise<DecisionRow> {
	const row = await env.DB.prepare("SELECT * FROM decisions WHERE id = ?").bind(id).first<DecisionRow>();
	if (!row) throw new ApiError("NOT_FOUND", `decisions/${id} does not exist.`);
	return row;
}

function idFromName(name: string): string {
	const match = /^decisions\/([a-z][a-z2-7]{25})$/.exec(name);
	if (!match) throw new ApiError("NOT_FOUND", `${name} does not exist.`);
	return match[1];
}

async function answersOf(env: Env, id: string): Promise<AnswerRow[]> {
	const { results } = await env.DB.prepare("SELECT * FROM answers WHERE decision_id = ? ORDER BY create_time")
		.bind(id)
		.all<AnswerRow>();
	return results;
}

/** Moves a decision on only if no one else moved it first. */
async function setState(env: Env, id: string, from: StoredState, state: StoredState, now: number): Promise<boolean> {
	const result = await env.DB.prepare("UPDATE decisions SET state = ?, update_time = ? WHERE id = ? AND state = ?")
		.bind(state, iso(now), id, from)
		.run();
	return result.meta.changes === 1;
}

/** Brings a decision up to date: expiry, and the invite replies from the calendar. */
async function refresh(
	env: Env,
	row: DecisionRow,
	now: number,
): Promise<{ row: DecisionRow; replies: Map<string, InviteReply> }> {
	let replies = new Map<string, InviteReply>();
	if (row.state === "WAITING" && now > Date.parse(row.expire_time)) {
		if (await setState(env, row.id, "WAITING", "EXPIRED", now)) {
			await env.DB.prepare("UPDATE answers SET windows_json = '[]' WHERE decision_id = ?").bind(row.id).run();
			await recordEvent(env, { type: "decision_expired", decisionRef: row.stats_ref, detail: { answered: !!row.responder_email } });
		}
		row = { ...row, state: "EXPIRED", update_time: iso(now) };
	}
	if (row.calendar_event_id && (row.state === "INVITE_SENT" || row.state === "ACCEPTED" || row.state === "DECLINED")) {
		replies = await getReplies(env, row.calendar_event_id);
		const all = [...replies.values()];
		const next: State = all.some((r) => r === "DECLINED")
			? "DECLINED"
			: all.length > 0 && all.every((r) => r === "ACCEPTED")
				? "ACCEPTED"
				: "INVITE_SENT";
		if (next !== row.state && (await setState(env, row.id, row.state, next, now))) {
			if (next !== "INVITE_SENT") {
				await recordEvent(env, { type: "invite_reply", decisionRef: row.stats_ref, detail: { state: next } });
			}
			row = { ...row, state: next, update_time: iso(now) };
		}
	}
	return { row, replies };
}

const INVITED: StoredState[] = ["INVITE_SENT", "ACCEPTED", "DECLINED"];

function view(
	row: DecisionRow,
	answers: AnswerRow[],
	replies: Map<string, InviteReply>,
	caller: Caller,
	code?: string,
	handoffMessage?: string,
) {
	const isStarter = same(caller.email, row.starter_email);
	const isResponder = !!row.responder_email && same(caller.email, row.responder_email);
	const timeZone = answers.find((a) => same(a.author_email, caller.email))?.time_zone ?? "UTC";
	const name = `decisions/${row.id}`;
	return {
		name,
		meeting: {
			duration: `${row.duration_seconds}s`,
			...(row.scheduled_start && row.scheduled_end && INVITED.includes(row.state)
				? {
						scheduledTime: { startTime: row.scheduled_start, endTime: row.scheduled_end },
						// The meeting time in the caller's own time zone, ready to show.
						scheduledTimeLocal: formatRange(Date.parse(row.scheduled_start), Date.parse(row.scheduled_end), timeZone),
					}
				: {}),
		},
		participants: answers.map((a) => ({
			displayName: a.author_name,
			role: a.role,
			...(replies.size ? { inviteReply: replies.get(a.author_email.toLowerCase()) ?? "NEEDS_ACTION" } : {}),
		})),
		state: (row.state === "MATCHING" ? "WAITING" : row.state) as State,
		...(isResponder && (row.state === "WAITING" || row.state === "MATCHING") ? { remainingAttempts: MAX_ANSWERS - row.attempts } : {}),
		// The code is shown only to the starter, only at creation (it is stored hashed).
		...(isStarter && code
			? {
					code,
					handoffMessage,
				}
			: {}),
		// Only the starter sees the deadline (as before; it no longer depends on their times).
		...(isStarter ? { expireTime: row.expire_time } : {}),
		createTime: row.create_time,
		updateTime: row.update_time,
	};
}

export async function createDecision(
	env: Env,
	caller: Caller,
	request: { durationSeconds: string; starterWindows: Interval[]; timeZone?: string },
) {
	const now = Date.now();
	await checkCreateDecision(env, caller.email, now);
	const durationSeconds = parseDuration(request.durationSeconds);
	const windows = parseWindows(request.starterWindows, now, request.timeZone);
	requireBreadth(windows, durationSeconds, now);
	const lastStart = Math.max(...windows.map((w) => w.end)) - durationSeconds * 1000;
	if (lastStart < now + MIN_LEAD_MS) {
		throw new ApiError("INVALID_ARGUMENT", "None of the windows leaves room for the meeting at least an hour from now.");
	}
	// A fixed deadline: if it followed the starter's times, the other person could work out when they end.
	const expire = now + ANSWER_DAYS * 24 * 60 * 60 * 1000;
	const offeredUntil = Math.min(lastStart, now + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000);

	const id = randomId(26);
	const code = randomId(12);
	const row: DecisionRow = {
		id,
		starter_email: caller.email,
		starter_name: caller.name,
		duration_seconds: durationSeconds,
		state: "WAITING",
		code_hash: await sha256(code),
		code_used: 0,
		responder_email: null,
		attempts: 0,
		stats_ref: randomId(16),
		notified: 0,
		scheduled_start: null,
		scheduled_end: null,
		calendar_event_id: null,
		claim_id: null,
		pending_event_id: null,
		expire_time: iso(expire),
		offered_until: iso(offeredUntil),
		create_time: iso(now),
		update_time: iso(now),
	};
	const answer: AnswerRow = {
		id: randomId(26),
		decision_id: id,
		author_email: caller.email,
		author_name: caller.name,
		role: "STARTER",
		windows_json: JSON.stringify(windows),
		time_zone: request.timeZone ?? null,
		create_time: iso(now),
	};
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO decisions (id, starter_email, starter_name, duration_seconds, state, code_hash, code_used, stats_ref, expire_time, offered_until, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
		).bind(
			id,
			row.starter_email,
			row.starter_name,
			durationSeconds,
			"WAITING",
			row.code_hash,
			row.stats_ref,
			row.expire_time,
			row.offered_until,
			row.create_time,
			row.update_time,
		),
		env.DB.prepare(
			"INSERT INTO answers (id, decision_id, author_email, author_name, role, windows_json, time_zone, create_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(answer.id, id, answer.author_email, answer.author_name, answer.role, answer.windows_json, answer.time_zone, answer.create_time),
	]);
	await recordEvent(env, {
		type: "decision_created",
		decisionRef: row.stats_ref,
		client: caller.client,
		email: caller.email,
		detail: { durationSeconds, windows: windows.length, localTimes: !!request.timeZone },
	});
	return {
		...view(
			row,
			[answer],
			new Map(),
			caller,
			code,
			handoffMessage({ starterName: caller.name, decisionId: id, code, connectorUrl: env.MCP_RESOURCE }),
		),
		// What Neutra understood, in the starter's own zone, so the agent can confirm it with them.
		receivedWindows: windows.map((w) => formatRange(w.start, w.end, request.timeZone)),
	};
}

export async function getDecision(env: Env, caller: Caller, name: string) {
	const id = idFromName(name);
	const loaded = await load(env, id);
	const answers = await answersOf(env, id);
	if (!answers.some((a) => same(a.author_email, caller.email))) {
		throw new ApiError("PERMISSION_DENIED", "Only the decision's participants can read it.");
	}
	const { row, replies } = await refresh(env, loaded, Date.now());
	return view(row, answers, replies, caller);
}

export async function deleteDecision(env: Env, caller: Caller, name: string): Promise<void> {
	const row = await load(env, idFromName(name));
	if (!same(row.starter_email, caller.email)) {
		throw new ApiError("PERMISSION_DENIED", "Only the person who started the decision can delete it.");
	}
	if (row.state === "MATCHING") {
		// An invite may be on its way; deleting now could leave it behind.
		throw new ApiError("FAILED_PRECONDITION", "An answer to this decision is being processed. Try again in a moment.");
	}
	if (row.calendar_event_id) {
		await deleteEvent(env, row.calendar_event_id);
	}
	// Guarded too: an answer may have claimed the decision since it was read.
	const deleted = await env.DB.batch([
		env.DB.prepare(
			"DELETE FROM answers WHERE decision_id = ? AND EXISTS (SELECT 1 FROM decisions WHERE id = ? AND state != 'MATCHING')",
		).bind(row.id, row.id),
		env.DB.prepare("DELETE FROM decisions WHERE id = ? AND state != 'MATCHING'").bind(row.id),
	]);
	if (deleted[1].meta.changes !== 1) {
		throw new ApiError("FAILED_PRECONDITION", "An answer to this decision is being processed. Try again in a moment.");
	}
	await recordEvent(env, {
		type: "decision_deleted",
		decisionRef: row.stats_ref,
		client: caller.client,
		email: caller.email,
		detail: { stateBefore: row.state },
	});
}

export async function createAnswer(
	env: Env,
	caller: Caller,
	request: { parent?: string; code: string; windows: Interval[]; timeZone?: string },
) {
	const now = Date.now();
	// Either the combined code alone, or the decision name plus the code.
	const combined = splitCombinedCode(request.code);
	const id = combined ? combined.id : idFromName(request.parent ?? "");
	if (combined && request.parent && idFromName(request.parent) !== combined.id) {
		throw new ApiError("INVALID_ARGUMENT", "The decision name and the combined code don't match.");
	}
	const code = combined ? combined.code : request.code;
	const loaded = await load(env, id);
	// Check who is calling before doing anything else with the decision.
	if (same(loaded.starter_email, caller.email)) {
		throw new ApiError("PERMISSION_DENIED", "The starter already answered when creating the decision.");
	}
	if ((await sha256(code.trim().toLowerCase())) !== loaded.code_hash) {
		throw new ApiError("PERMISSION_DENIED", "The code is wrong.");
	}
	// The code binds to the first person who answers with it.
	if (loaded.responder_email && !same(loaded.responder_email, caller.email)) {
		throw new ApiError("PERMISSION_DENIED", "This code is already used by someone else.");
	}
	const { row } = await refresh(env, loaded, now);
	if (row.state === "MATCHING") {
		throw new ApiError("FAILED_PRECONDITION", "Another answer to this decision is being processed. Try again in a moment.");
	}
	if (row.state !== "WAITING" || row.code_used || row.attempts >= MAX_ANSWERS) {
		throw new ApiError("FAILED_PRECONDITION", `The decision is ${row.state}, not WAITING.`);
	}
	const windows = parseWindows(request.windows, now, request.timeZone);
	requireBreadth(windows, row.duration_seconds, now);
	await checkCreateAnswer(env, caller.email, row.starter_email, id, now);
	const starter = (await answersOf(env, id)).find((a) => a.role === "STARTER");
	if (!starter) throw new ApiError("FAILED_PRECONDITION", "The decision has no starter answer.");

	const attempts = row.attempts + 1;
	const answer: AnswerRow = {
		id: randomId(26),
		decision_id: id,
		author_email: caller.email,
		author_name: caller.name,
		role: "RESPONDER",
		windows_json: "[]", // the responder's times are never kept
		time_zone: request.timeZone ?? null,
		create_time: iso(now),
	};
	const match = findMatch(JSON.parse(starter.windows_json), windows, row.duration_seconds * 1000, now);
	const claimId = randomId(16);
	const eventId = match ? newEventId() : null;
	// Without a match the answer settles at once; with one it waits in MATCHING until the invite is out.
	const firstState: StoredState = match ? "MATCHING" : attempts >= MAX_ANSWERS ? "NO_MATCH" : "WAITING";
	const owned = "EXISTS (SELECT 1 FROM decisions WHERE id = ? AND claim_id = ?)";

	// Claim the decision for this answer. Only one answer at a time gets past this,
	// so parallel calls can't send two invites or get around the try limit.
	// Every later write checks the claim, so a stale call can't overwrite a newer state.
	const claimed = await env.DB.batch([
		env.DB.prepare(
			"UPDATE decisions SET state = ?, code_used = ?, claim_id = ?, pending_event_id = ?, responder_email = ?, attempts = attempts + 1, scheduled_start = ?, scheduled_end = ?, update_time = ? WHERE id = ? AND state = 'WAITING' AND code_used = 0 AND attempts = ? AND (responder_email IS NULL OR lower(responder_email) = lower(?))",
		).bind(
			firstState,
			firstState === "NO_MATCH" ? 1 : 0,
			claimId,
			eventId,
			caller.email,
			match ? iso(match.start) : null,
			match ? iso(match.end) : null,
			iso(now),
			id,
			row.attempts,
			caller.email,
		),
		env.DB.prepare(`DELETE FROM answers WHERE decision_id = ? AND role = 'RESPONDER' AND ${owned}`).bind(id, id, claimId),
		env.DB.prepare(
			`INSERT INTO answers (id, decision_id, author_email, author_name, role, windows_json, time_zone, create_time) SELECT ?, ?, ?, ?, 'RESPONDER', '[]', ?, ? WHERE ${owned}`,
		).bind(answer.id, id, answer.author_email, answer.author_name, answer.time_zone, answer.create_time, id, claimId),
		// Once settled, the starter's times go too.
		...(firstState === "NO_MATCH"
			? [env.DB.prepare(`UPDATE answers SET windows_json = '[]' WHERE decision_id = ? AND ${owned}`).bind(id, id, claimId)]
			: []),
		...(match ? [] : [env.DB.prepare("UPDATE decisions SET claim_id = NULL WHERE id = ? AND claim_id = ?").bind(id, claimId)]),
	]);
	if (claimed[0].meta.changes !== 1) {
		throw new ApiError("FAILED_PRECONDITION", "Another answer to this decision is being processed. Try again in a moment.");
	}

	let next: DecisionRow = {
		...row,
		state: firstState,
		code_used: firstState === "NO_MATCH" ? 1 : 0,
		responder_email: caller.email,
		attempts,
		update_time: iso(now),
	};
	if (match && eventId) {
		// A claimed try always counts, even if the invite fails: giving it back would let repeated
		// failures reveal which times match for free. Anything unclear is left in MATCHING for the
		// maintenance job, which finishes the answer if the invite exists and otherwise opens the request again.
		const failed = new ApiError(
			"FAILED_PRECONDITION",
			"Neutra couldn't confirm the invite. Check get_decision in about 20 minutes: either the invite went out, or the request is open for another try.",
		);

		try {
			await createEvent(env, {
				id: eventId,
				summary: `${row.starter_name} & ${caller.name}`,
				start: iso(match.start),
				end: iso(match.end),
				attendees: [row.starter_email, caller.email],
			});
		} catch (error) {
			console.error("invite failed", id, error);
			// The request may have reached Google anyway. Only a confirmed invite is finished here.
			if ((await eventExists(env, eventId).catch(() => false)) !== true) throw failed;
		}

		let finished = false;
		try {
			const result = await env.DB.batch([
				env.DB.prepare(`UPDATE answers SET windows_json = '[]' WHERE decision_id = ? AND ${owned}`).bind(id, id, claimId),
				env.DB.prepare(
					"UPDATE decisions SET state = 'INVITE_SENT', code_used = 1, calendar_event_id = pending_event_id, pending_event_id = NULL, claim_id = NULL, update_time = ? WHERE id = ? AND claim_id = ?",
				).bind(iso(now), id, claimId),
			]);
			finished = result[1].meta.changes === 1;
		} catch (error) {
			// It may have been saved anyway; if not, the job finishes it (the invite exists).
			console.error("saving the answer failed", id, error);
		}
		if (!finished) {
			const current = await load(env, id).catch(() => null);
			if (current?.state === "MATCHING" && current.claim_id === claimId) throw failed;
			if (current?.calendar_event_id !== eventId) {
				// The job took over this slow answer before the invite existed. Take the invite back.
				await deleteEvent(env, eventId).catch((error) => console.error("untracked invite", id, eventId, error));
				throw failed;
			}
		}
		next = {
			...next,
			state: "INVITE_SENT",
			code_used: 1,
			scheduled_start: iso(match.start),
			scheduled_end: iso(match.end),
			calendar_event_id: eventId,
		};
	}

	await recordEvent(env, {
		type: "answer_submitted",
		decisionRef: row.stats_ref,
		client: caller.client,
		email: caller.email,
		detail: {
			attempt: attempts,
			outcome: match ? "match" : next.state === "NO_MATCH" ? "no_match" : "retry",
			minutesSinceStart: Math.round((now - Date.parse(row.create_time)) / 60_000),
			localTimes: !!request.timeZone,
		},
	});
	return {
		answer: {
			name: `decisions/${id}/answers/${answer.id}`,
			author: caller.name,
			createTime: answer.create_time,
		},
		decision: view(next, [starter, answer], new Map(), caller),
		receivedWindows: windows.map((w) => formatRange(w.start, w.end, request.timeZone)),
	};
}

export async function getAnswer(env: Env, caller: Caller, name: string) {
	const match = /^(decisions\/[a-z][a-z2-7]{25})\/answers\/([a-z][a-z2-7]{25})$/.exec(name);
	if (!match) throw new ApiError("NOT_FOUND", `${name} does not exist.`);
	const row = await env.DB.prepare("SELECT * FROM answers WHERE id = ? AND decision_id = ?")
		.bind(match[2], idFromName(match[1]))
		.first<AnswerRow>();
	if (!row) throw new ApiError("NOT_FOUND", `${name} does not exist.`);
	if (!same(row.author_email, caller.email)) {
		throw new ApiError("PERMISSION_DENIED", "Only the author can read an answer.");
	}
	const windows: { start: number; end: number }[] = JSON.parse(row.windows_json);
	return {
		name,
		author: row.author_name,
		meeting: { availableWindows: windows.map((w) => ({ startTime: iso(w.start), endTime: iso(w.end) })) },
		createTime: row.create_time,
	};
}
