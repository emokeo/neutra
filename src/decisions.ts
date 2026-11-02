// Decisions and answers: storage, matching and the rules from the v0 API.
import { createEvent, deleteEvent, getReplies, type InviteReply } from "./calendar";
import { recordEvent } from "./events";
import { checkCreateAnswer, checkCreateDecision } from "./limits";
import { formatDay, formatRange, isValidTimeZone, parseTimestamp } from "./time";

export type Caller = { email: string; name: string; client?: string };
export type Interval = { startTime: string; endTime: string };

export type State = "WAITING" | "NO_MATCH" | "INVITE_SENT" | "ACCEPTED" | "DECLINED" | "EXPIRED";

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
	state: State;
	code_hash: string;
	code_used: number;
	responder_email: string | null;
	attempts: number;
	stats_ref: string | null;
	notified: number;
	scheduled_start: string | null;
	scheduled_end: string | null;
	calendar_event_id: string | null;
	expire_time: string;
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
const MIN_LEAD_MS = 60 * 60 * 1000; // a matched meeting starts at least 1 hour from now
const SLOT_MS = 15 * 60 * 1000; // matched times start on a quarter hour
const MAX_DURATION_S = 24 * 60 * 60;
const MAX_ANSWERS = 3; // the responder's first answer plus 2 retries after "no match"
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
	const seconds = Number(duration.slice(0, -1));
	if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_DURATION_S) {
		throw new ApiError("INVALID_ARGUMENT", "Duration must be between 1 second and 24 hours, e.g. \"3600s\".");
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
export function handoffMessage(p: {
	starterName: string;
	decisionName: string;
	code: string;
	connectorUrl: string;
	expires: string;
}): string {
	const home = p.connectorUrl.replace(/\/mcp$/, "").replace(/^https?:\/\//, "");
	return `${p.starterName} would like to meet you. 👋
Neutra finds a time that works for both of you, without either of you sharing your calendar. When it finds one, you both get a calendar invite.

To answer, paste this to your AI assistant:
"Connect the Neutra connector at ${p.connectorUrl}, then answer Neutra request ${p.decisionName} with code ${p.code}. I'm free: …"

The first time, your assistant asks you to sign in with Google. Neutra only uses your name and email, to send you the invite. No AI on Neutra's side sees your times.

If your assistant can't add connectors from chat, add it once under Settings → Connectors. Works until ${p.expires} · ${home}`;
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
function requireBreadth(windows: { start: number; end: number }[], durationSeconds: number): void {
	if (coverage(windows) < MIN_BREADTH * durationSeconds * 1000) {
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

async function setState(env: Env, id: string, state: State, now: number): Promise<void> {
	await env.DB.prepare("UPDATE decisions SET state = ?, update_time = ? WHERE id = ?").bind(state, iso(now), id).run();
}

/** Brings a decision up to date: expiry, and the invite replies from the calendar. */
async function refresh(
	env: Env,
	row: DecisionRow,
	now: number,
): Promise<{ row: DecisionRow; replies: Map<string, InviteReply> }> {
	let replies = new Map<string, InviteReply>();
	if (row.state === "WAITING" && now > Date.parse(row.expire_time)) {
		await setState(env, row.id, "EXPIRED", now);
		await env.DB.prepare("UPDATE answers SET windows_json = '[]' WHERE decision_id = ?").bind(row.id).run();
		await recordEvent(env, { type: "decision_expired", decisionRef: row.stats_ref, detail: { answered: !!row.responder_email } });
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
		if (next !== row.state) {
			await setState(env, row.id, next, now);
			if (next !== "INVITE_SENT") {
				await recordEvent(env, { type: "invite_reply", decisionRef: row.stats_ref, detail: { state: next } });
			}
			row = { ...row, state: next, update_time: iso(now) };
		}
	}
	return { row, replies };
}

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
			...(row.scheduled_start && row.scheduled_end
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
		state: row.state,
		...(isResponder && row.state === "WAITING" ? { remainingAttempts: MAX_ANSWERS - row.attempts } : {}),
		// The code is shown only to the starter, only at creation (it is stored hashed).
		...(isStarter && code
			? {
					code,
					handoffMessage,
				}
			: {}),
		expireTime: row.expire_time,
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
	requireBreadth(windows, durationSeconds);
	const lastStart = Math.max(...windows.map((w) => w.end)) - durationSeconds * 1000;
	if (lastStart < now + MIN_LEAD_MS) {
		throw new ApiError("INVALID_ARGUMENT", "None of the windows leaves room for the meeting at least an hour from now.");
	}
	const expire = Math.min(lastStart, now + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000);

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
		expire_time: iso(expire),
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
			"INSERT INTO decisions (id, starter_email, starter_name, duration_seconds, state, code_hash, code_used, stats_ref, expire_time, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
		).bind(
			id,
			row.starter_email,
			row.starter_name,
			durationSeconds,
			"WAITING",
			row.code_hash,
			row.stats_ref,
			row.expire_time,
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
			handoffMessage({
				starterName: caller.name,
				decisionName: `decisions/${id}`,
				code,
				connectorUrl: env.MCP_RESOURCE,
				expires: formatDay(expire, request.timeZone),
			}),
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
	if (row.calendar_event_id) {
		await deleteEvent(env, row.calendar_event_id);
	}
	await recordEvent(env, {
		type: "decision_deleted",
		decisionRef: row.stats_ref,
		client: caller.client,
		email: caller.email,
		detail: { stateBefore: row.state },
	});
	await env.DB.batch([
		env.DB.prepare("DELETE FROM answers WHERE decision_id = ?").bind(row.id),
		env.DB.prepare("DELETE FROM decisions WHERE id = ?").bind(row.id),
	]);
}

export async function createAnswer(
	env: Env,
	caller: Caller,
	request: { parent: string; code: string; windows: Interval[]; timeZone?: string },
) {
	const now = Date.now();
	const id = idFromName(request.parent);
	const loaded = await load(env, id);
	const { row } = await refresh(env, loaded, now);
	if (same(row.starter_email, caller.email)) {
		throw new ApiError("PERMISSION_DENIED", "The starter already answered when creating the decision.");
	}
	if ((await sha256(request.code.trim().toLowerCase())) !== row.code_hash) {
		throw new ApiError("PERMISSION_DENIED", "The code is wrong.");
	}
	// The code binds to the first person who answers with it.
	if (row.responder_email && !same(row.responder_email, caller.email)) {
		throw new ApiError("PERMISSION_DENIED", "This code is already used by someone else.");
	}
	if (row.state !== "WAITING" || row.code_used) {
		throw new ApiError("FAILED_PRECONDITION", `The decision is ${row.state}, not WAITING.`);
	}
	const windows = parseWindows(request.windows, now, request.timeZone);
	requireBreadth(windows, row.duration_seconds);
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

	let next: DecisionRow = { ...row, responder_email: caller.email, attempts, update_time: iso(now) };
	if (match) {
		const eventId = await createEvent(env, {
			summary: `${row.starter_name} & ${caller.name}`,
			start: iso(match.start),
			end: iso(match.end),
			attendees: [row.starter_email, caller.email],
		});
		next = {
			...next,
			state: "INVITE_SENT",
			code_used: 1,
			scheduled_start: iso(match.start),
			scheduled_end: iso(match.end),
			calendar_event_id: eventId,
		};
	} else if (attempts >= MAX_ANSWERS) {
		next = { ...next, state: "NO_MATCH", code_used: 1 };
	}
	const settled = next.state !== "WAITING";

	await env.DB.batch([
		env.DB.prepare("DELETE FROM answers WHERE decision_id = ? AND role = 'RESPONDER'").bind(id),
		env.DB.prepare(
			"INSERT INTO answers (id, decision_id, author_email, author_name, role, windows_json, time_zone, create_time) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)",
		).bind(answer.id, id, answer.author_email, answer.author_name, answer.role, answer.time_zone, answer.create_time),
		// Once settled, the starter's times go too.
		...(settled ? [env.DB.prepare("UPDATE answers SET windows_json = '[]' WHERE decision_id = ?").bind(id)] : []),
		env.DB.prepare(
			"UPDATE decisions SET state = ?, code_used = ?, responder_email = ?, attempts = ?, scheduled_start = ?, scheduled_end = ?, calendar_event_id = ?, update_time = ? WHERE id = ?",
		).bind(
			next.state,
			next.code_used,
			next.responder_email,
			next.attempts,
			next.scheduled_start,
			next.scheduled_end,
			next.calendar_event_id,
			next.update_time,
			id,
		),
	]);

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
