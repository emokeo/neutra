// Decisions and answers: storage, matching and the rules from the v0 API.
import { createEvent, deleteEvent, getReplies, type InviteReply } from "./calendar";

export type Caller = { email: string; name: string };
export type Interval = { startTime: string; endTime: string };

export type State = "WAITING" | "NO_MATCH" | "INVITE_SENT" | "ACCEPTED" | "DECLINED" | "EXPIRED";

/** An error with a google.rpc canonical code, as in the API's error table. */
export type ErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "FAILED_PRECONDITION" | "INVALID_ARGUMENT";

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
	create_time: string;
};

const MAX_DAYS_AHEAD = 30;
const MIN_LEAD_MS = 60 * 60 * 1000; // a matched meeting starts at least 1 hour from now
const SLOT_MS = 15 * 60 * 1000; // matched times start on a quarter hour
const MAX_DURATION_S = 24 * 60 * 60;

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

function parseWindows(windows: Interval[], now: number): { start: number; end: number }[] {
	const limit = now + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;
	return windows.map((w) => {
		const start = Date.parse(w.startTime);
		const end = Date.parse(w.endTime);
		if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
			throw new ApiError("INVALID_ARGUMENT", "Each window needs a startTime before its endTime.");
		}
		if (end <= now || start > limit) {
			throw new ApiError("INVALID_ARGUMENT", `Windows must lie between now and ${MAX_DAYS_AHEAD} days ahead.`);
		}
		return { start, end };
	});
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
			row = { ...row, state: next, update_time: iso(now) };
		}
	}
	return { row, replies };
}

function view(row: DecisionRow, answers: AnswerRow[], replies: Map<string, InviteReply>, caller: Caller, code?: string) {
	const isStarter = same(caller.email, row.starter_email);
	const name = `decisions/${row.id}`;
	return {
		name,
		meeting: {
			duration: `${row.duration_seconds}s`,
			...(row.scheduled_start && row.scheduled_end
				? { scheduledTime: { startTime: row.scheduled_start, endTime: row.scheduled_end } }
				: {}),
		},
		participants: answers.map((a) => ({
			displayName: a.author_name,
			role: a.role,
			...(replies.size ? { inviteReply: replies.get(a.author_email.toLowerCase()) ?? "NEEDS_ACTION" } : {}),
		})),
		state: row.state,
		// The code is shown only to the starter, only at creation (it is stored hashed).
		...(isStarter && code
			? {
					code,
					handoffMessage: `${row.starter_name} would like to find a time to meet. Give this to your AI assistant: Neutra decision ${name}, code ${code}. If your assistant doesn't have the Neutra connector yet, add it first.`,
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
	request: { durationSeconds: string; starterWindows: Interval[] },
) {
	const now = Date.now();
	const durationSeconds = parseDuration(request.durationSeconds);
	const windows = parseWindows(request.starterWindows, now);
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
		create_time: iso(now),
	};
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO decisions (id, starter_email, starter_name, duration_seconds, state, code_hash, code_used, expire_time, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
		).bind(id, row.starter_email, row.starter_name, durationSeconds, "WAITING", row.code_hash, row.expire_time, row.create_time, row.update_time),
		env.DB.prepare(
			"INSERT INTO answers (id, decision_id, author_email, author_name, role, windows_json, create_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(answer.id, id, answer.author_email, answer.author_name, answer.role, answer.windows_json, answer.create_time),
	]);
	return view(row, [answer], new Map(), caller, code);
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
	await env.DB.batch([
		env.DB.prepare("DELETE FROM answers WHERE decision_id = ?").bind(row.id),
		env.DB.prepare("DELETE FROM decisions WHERE id = ?").bind(row.id),
	]);
}

export async function createAnswer(
	env: Env,
	caller: Caller,
	request: { parent: string; code: string; windows: Interval[] },
) {
	const now = Date.now();
	const id = idFromName(request.parent);
	const loaded = await load(env, id);
	const { row } = await refresh(env, loaded, now);
	if (same(row.starter_email, caller.email)) {
		throw new ApiError("PERMISSION_DENIED", "The starter already answered when creating the decision.");
	}
	if (row.code_used || (await sha256(request.code.trim().toLowerCase())) !== row.code_hash) {
		throw new ApiError("PERMISSION_DENIED", "The code is wrong or was already used.");
	}
	if (row.state !== "WAITING") {
		throw new ApiError("FAILED_PRECONDITION", `The decision is ${row.state}, not WAITING.`);
	}
	const windows = parseWindows(request.windows, now);
	const starter = (await answersOf(env, id)).find((a) => a.role === "STARTER");
	if (!starter) throw new ApiError("FAILED_PRECONDITION", "The decision has no starter answer.");

	const answer: AnswerRow = {
		id: randomId(26),
		decision_id: id,
		author_email: caller.email,
		author_name: caller.name,
		role: "RESPONDER",
		windows_json: JSON.stringify(windows),
		create_time: iso(now),
	};
	const match = findMatch(JSON.parse(starter.windows_json), windows, row.duration_seconds * 1000, now);

	let next: DecisionRow = { ...row, code_used: 1, update_time: iso(now) };
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
			scheduled_start: iso(match.start),
			scheduled_end: iso(match.end),
			calendar_event_id: eventId,
		};
	} else {
		next = { ...next, state: "NO_MATCH" };
	}

	// The decision is settled either way: nobody's windows are kept.
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO answers (id, decision_id, author_email, author_name, role, windows_json, create_time) VALUES (?, ?, ?, ?, ?, '[]', ?)",
		).bind(answer.id, id, answer.author_email, answer.author_name, answer.role, answer.create_time),
		env.DB.prepare("UPDATE answers SET windows_json = '[]' WHERE decision_id = ?").bind(id),
		env.DB.prepare(
			"UPDATE decisions SET state = ?, code_used = 1, scheduled_start = ?, scheduled_end = ?, calendar_event_id = ?, update_time = ? WHERE id = ?",
		).bind(next.state, next.scheduled_start, next.scheduled_end, next.calendar_event_id, next.update_time, id),
	]);

	return {
		answer: {
			name: `decisions/${id}/answers/${answer.id}`,
			author: caller.name,
			createTime: answer.create_time,
		},
		decision: view(next, [starter, answer], new Map(), caller),
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
