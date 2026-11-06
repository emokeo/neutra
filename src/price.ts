// Price decisions: two people each tell Neutra one number in private, the most one would pay and the least
// the other would accept. If they overlap, both hear the price halfway between; if not, both hear only
// "no deal". The person answering never has their number stored; the starter's is sealed (see seal.ts).
//
// Nothing here may run when the module loads: decisions.ts and this file import each other.
import { sendEmail } from "./calendar";
import {
	type AnswerRow,
	answersOf,
	ApiError,
	ANSWER_DAYS,
	type Caller,
	combinedCode,
	type DecisionRow,
	firstName,
	iso,
	randomId,
	refresh,
	requestForCode,
	same,
	sha256,
} from "./decisions";
import { personId, recordEvent } from "./events";
import { checkCreateAnswer, checkCreateDecision, checkPriceAnswer, LIMITS, PRICE_ANSWERS_TODAY, priceAnswerLimit } from "./limits";
import { CLAUDE_DIRECTORY_URL } from "./links";
import { currencyCode, formatAmount, midpoint, minorDigits, otherCurrencyIn, parseAmount, plainAmount } from "./money";
import { sealLimit, unsealLimit } from "./seal";
import { formatDay } from "./time";
import { isAllowed } from "./utils";

/** Who pays: the starter picks their side, the other person gets the opposite. */
export type Side = "PAYS" | "RECEIVES";

/** What both sides see. Stored as terms_json. */
export type PriceTerms = {
	subject: string;
	details?: string;
	currency: string;
	unit?: string;
	starterSide: Side;
	rule: "MIDPOINT";
};

/** decision.price as sent by the starter (neutra.v1.PriceDecision, input fields). */
export type PriceInput = {
	subject: string;
	details?: string;
	currencyCode: string;
	unit?: string;
	answerBy?: string;
};

/** Exactly one is set: the field that matches the person's side. */
export type LimitInput = { minimumToAccept?: string | number; maximumToPay?: string | number };

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- The switch

export type PriceMode = "off" | "testers" | "open";

export function priceMode(env: Env): PriceMode {
	return env.PRICE_DECISIONS === "testers" || env.PRICE_DECISIONS === "open" ? env.PRICE_DECISIONS : "off";
}

/** Whether this person may start a price decision (and so sees the tool). */
export function canStartPrice(env: Env, email: string | undefined): boolean {
	const mode = priceMode(env);
	return mode === "open" || (mode === "testers" && !!email && isAllowed(email, env.ALLOWED_EMAILS));
}

function requireOn(env: Env): void {
	if (priceMode(env) === "off") throw new ApiError("FAILED_PRECONDITION", "Price requests aren't available yet.", "PRICE_OFF");
}

// ---- Words for each side

function other(side: Side): Side {
	return side === "PAYS" ? "RECEIVES" : "PAYS";
}

/** The answer field for a side: the payer sends a maximum, the receiver a minimum. */
export function fieldFor(side: Side): "maximumToPay" | "minimumToAccept" {
	return side === "PAYS" ? "maximumToPay" : "minimumToAccept";
}

/** "the most they'd pay" / "the least they'd accept". */
export function askFor(side: Side, who = "they"): string {
	return side === "PAYS" ? `the most ${who}'d pay` : `the least ${who}'d accept`;
}

export function termsOf(row: DecisionRow): PriceTerms {
	return JSON.parse(row.terms_json ?? "{}") as PriceTerms;
}

/** "Rent for the flat (utilities included)". */
export function subjectText(terms: PriceTerms): string {
	return `${terms.subject}${terms.details ? ` (${terms.details})` : ""}`;
}

/** "CHF per month", "EUR". */
function currencyAndUnit(terms: PriceTerms): string {
	return `${terms.currency}${terms.unit ? ` ${terms.unit}` : ""}`;
}

// ---- Checking what the starter sends

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** One line of text both sides read: trimmed, single spaces, within the length. */
function oneLine(value: string | undefined, field: string, max: number, example: string, min = 0): string | undefined {
	if (value === undefined || (min === 0 && value.trim() === "")) {
		if (min > 0) throw new ApiError("INVALID_ARGUMENT", `Send ${field}, e.g. "${example}".`);
		return undefined;
	}
	if (CONTROL.test(value)) {
		throw new ApiError("INVALID_ARGUMENT", `${field} must be one line, without line breaks or control characters, e.g. "${example}".`);
	}
	const text = value.trim().replace(/\s+/g, " ");
	if (text.length < min || text.length > max) {
		throw new ApiError(
			"INVALID_ARGUMENT",
			`${field} must be ${min ? `${min} to ${max}` : `at most ${max}`} characters; it has ${text.length}. For example: "${example}".`,
		);
	}
	return text;
}

/**
 * Whether the text gives away the starter's limit, e.g. a subject "Rent, max 1850". The other side reads
 * the terms, so they must not carry the number. Checks plain digits and numbers written with separators.
 */
function mentionsLimit(text: string, minor: number, currency: string): boolean {
	const whole = String(Math.floor(minor / 10 ** minorDigits(currency)));
	if (whole.length < 2) return false; // a one-digit limit would match house numbers and counts
	const runs: string[] = text.match(/\d+/g) ?? [];
	const numbers = (text.match(/\d+(?:['’,. ]\d+)*/g) ?? []).map((n) => n.replace(/['’, ]/g, ""));
	return (
		runs.includes(whole) ||
		numbers.some((n) => n.split(".")[0] === whole || n.replace(/\./g, "") === whole)
	);
}

/** The deadline: the end of the given day (UTC), 1 to 14 days ahead; without one, 14 days from now. */
function deadline(answerBy: string | undefined, now: number): number {
	const latest = now + ANSWER_DAYS * DAY_MS;
	if (answerBy === undefined) return latest;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(answerBy.trim());
	const day = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
	const valid = m && new Date(day).toISOString().slice(0, 10) === answerBy.trim();
	const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
	if (!valid || day < today + DAY_MS || day > today + ANSWER_DAYS * DAY_MS) {
		throw new ApiError(
			"INVALID_ARGUMENT",
			`answerBy must be a date from tomorrow to ${ANSWER_DAYS} days ahead, as "YYYY-MM-DD", e.g. "${iso(today + 7 * DAY_MS).slice(0, 10)}". Leave it out for ${ANSWER_DAYS} days.`,
		);
	}
	return Math.min(day + DAY_MS - 1, latest);
}

/** 'CHF 1,850 per month, the least you'd accept for "Rent"': worded to be read back to the person as it is. */
function limitText(side: Side, minor: number, terms: PriceTerms): string {
	return `${formatAmount(minor, terms.currency, terms.unit)}, ${askFor(side, "you")} for "${subjectText(terms)}"`;
}

/** The deadline as a day, "2026-11-17" (UTC), as the starter set it. */
function answerByOf(row: DecisionRow): string {
	return row.expire_time.slice(0, 10);
}

// ---- What callers see

export type PriceView = ReturnType<typeof priceView>;

/**
 * A price decision as the API shows it (neutra.v1.Decision with price): everything about the price inside
 * price, the rest in the same top-level fields as meetings. Never any limit: only the agreed price, once there is one.
 * The code and hand-off message are shown only to the starter, only at creation.
 */
export function priceView(row: DecisionRow, answers: AnswerRow[], caller: Caller, created?: { code: string; handoffMessage: string }) {
	const terms = termsOf(row);
	const yourSide = same(caller.email, row.starter_email) ? terms.starterSide : other(terms.starterSide);
	return {
		name: `decisions/${row.id}`,
		price: {
			subject: terms.subject,
			...(terms.details ? { details: terms.details } : {}),
			currencyCode: terms.currency,
			...(terms.unit ? { unit: terms.unit } : {}),
			answerBy: answerByOf(row),
			rule: terms.rule,
			yourSide,
			...(row.state === "AGREED" && row.agreed_minor !== null
				? {
						agreedPrice: plainAmount(row.agreed_minor, terms.currency),
						agreedPriceText: formatAmount(row.agreed_minor, terms.currency, terms.unit),
					}
				: {}),
		},
		state: row.state as "WAITING" | "AGREED" | "NO_MATCH" | "EXPIRED",
		participants: answers.map((a) => ({ displayName: a.author_name, role: a.role })),
		...(created ? { code: created.code, handoffMessage: created.handoffMessage } : {}),
		expireTime: row.expire_time,
		createTime: row.create_time,
	};
}

/**
 * The terms for whoever holds the code (the price part of get_decision's preview): what the hand-off message
 * says, from the reader's side. yourSide PAYS means send maximumToPay; RECEIVES, minimumToAccept.
 */
export function pricePreview(row: DecisionRow, caller: Caller) {
	const terms = termsOf(row);
	return {
		subject: terms.subject,
		...(terms.details ? { details: terms.details } : {}),
		currencyCode: terms.currency,
		...(terms.unit ? { unit: terms.unit } : {}),
		rule: terms.rule,
		yourSide: same(caller.email, row.starter_email) ? terms.starterSide : other(terms.starterSide),
	};
}

/** Why a meeting answer doesn't fit this request, and what to send instead. */
export function notAMeeting(row: DecisionRow): string {
	const terms = termsOf(row);
	const side = other(terms.starterSide);
	return `This is a price request ("${terms.subject}", ${currencyAndUnit(terms)}), not a meeting. Your person ${
		side === "PAYS" ? "pays" : "receives the money"
	}: ask them ${askFor(side)} and send answer.price.${fieldFor(side)}. Not counted as a try.`;
}

// ---- The message the starter forwards

export function priceHandoffMessage(p: {
	starterName: string;
	decisionId: string;
	code: string;
	connectorUrl: string;
	expires: string;
	terms: PriceTerms;
}): string {
	const home = p.connectorUrl.replace(/\/mcp$/, "");
	const host = home.replace(/^https?:\/\//, "");
	const who = firstName(p.starterName) || "Someone";
	const t = p.terms;
	// The person reading this is on the other side from the starter.
	const youPay = t.starterSide === "RECEIVES";
	const unit = t.unit ? ` ${t.unit}` : "";
	return `${who} wants to agree on a price with you through Neutra (${host}): ${subjectText(t)}, in ${currencyAndUnit(t)}. ${
		youPay ? `You pay; ${who} receives.` : `${who} pays; you receive.`
	}

You each tell Neutra one number in private: ${
		youPay
			? `you the most you'd pay, ${who} the least they'd accept. If yours is at least theirs`
			: `you the least you'd accept, ${who} the most they'd pay. If yours is at most theirs`
	}, the price is halfway between them. If not, you both hear only "no deal" and neither learns the other's number. You have one answer, so give your real ${
		youPay ? "maximum" : "minimum"
	}, not an opening offer. A deal isn't a contract: you two confirm it yourselves.

To answer:
1. Add Neutra to your AI assistant. In Claude it's in the connector directory: ${CLAUDE_DIRECTORY_URL}
Other assistants: add ${p.connectorUrl} as a custom connector. Steps: ${home}/r/${p.decisionId}
2. Tell your assistant: "Answer Neutra request ${combinedCode(p.decisionId, p.code)}. ${
		youPay ? "The most I'd pay" : "The least I'd accept"
	} is ${t.currency} …${unit}."

No AI assistant? Answer in your browser instead: ${home}/a/${p.decisionId}.${p.code}

Open until ${p.expires}.`;
}

// ---- Starting

export async function createPriceDecision(
	env: Env,
	caller: Caller,
	request: { price: PriceInput; starterAnswer: LimitInput; validateOnly?: boolean },
) {
	requireOn(env);
	const now = Date.now();
	const subject = oneLine(request.price.subject, "subject", 120, "Rent for the flat at Seestrasse 12", 3) as string;
	const details = oneLine(request.price.details, "details", 200, "utilities included");
	const unit = oneLine(request.price.unit, "unit", 30, "per month");
	const currency = currencyCode(request.price.currencyCode);
	const { minimumToAccept, maximumToPay } = request.starterAnswer;
	if ((minimumToAccept === undefined) === (maximumToPay === undefined)) {
		throw new ApiError(
			"INVALID_ARGUMENT",
			"Send exactly one of starterAnswer.price.minimumToAccept (the lowest your person would accept, if they receive the money) or starterAnswer.price.maximumToPay (the most they would pay, if they pay).",
		);
	}
	const starterSide: Side = maximumToPay !== undefined ? "PAYS" : "RECEIVES";
	const minor = parseAmount((maximumToPay ?? minimumToAccept) as string | number, currency);
	for (const [field, text] of [["subject", subject], ["details", details], ["unit", unit]] as const) {
		if (text && mentionsLimit(text, minor, currency)) {
			throw new ApiError(
				"INVALID_ARGUMENT",
				`The ${field} contains your person's limit. The other side reads the ${field}, so leave the number out and send the limit only as starterAnswer.price.${fieldFor(starterSide)}.`,
			);
		}
	}
	const expire = deadline(request.price.answerBy, now);
	const terms: PriceTerms = {
		subject,
		...(details ? { details } : {}),
		currency,
		...(unit ? { unit } : {}),
		starterSide,
		rule: "MIDPOINT",
	};
	const receivedLimit = limitText(starterSide, minor, terms);
	await checkCreateDecision(env, caller.email, now);
	if (request.validateOnly) {
		// Nothing stored and nothing counted: this is only for reading the number back to the person.
		return { validateOnly: true as const, receivedLimit };
	}

	const id = randomId(26);
	const code = randomId(12);
	const row: DecisionRow = {
		id,
		kind: "price",
		terms_json: JSON.stringify(terms),
		limit_sealed: await sealLimit(minor, code, id),
		agreed_minor: null,
		starter_email: caller.email,
		starter_name: caller.name,
		duration_seconds: 0,
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
		// The fixed deadline doubles as the last moment an answer can come; there are no times to pass.
		offered_until: iso(expire),
		create_time: iso(now),
		update_time: iso(now),
	};
	const answer: AnswerRow = {
		id: randomId(26),
		decision_id: id,
		author_email: caller.email,
		author_name: caller.name,
		role: "STARTER",
		windows_json: "[]",
		time_zone: null,
		create_time: iso(now),
	};
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO decisions (id, kind, terms_json, limit_sealed, starter_email, starter_name, duration_seconds, state, code_hash, code_used, stats_ref, expire_time, offered_until, create_time, update_time) VALUES (?, 'price', ?, ?, ?, ?, 0, 'WAITING', ?, 0, ?, ?, ?, ?, ?)",
		).bind(
			id,
			row.terms_json,
			row.limit_sealed,
			row.starter_email,
			row.starter_name,
			row.code_hash,
			row.stats_ref,
			row.expire_time,
			row.offered_until,
			row.create_time,
			row.update_time,
		),
		env.DB.prepare(
			"INSERT INTO answers (id, decision_id, author_email, author_name, role, windows_json, time_zone, create_time) VALUES (?, ?, ?, ?, 'STARTER', '[]', NULL, ?)",
		).bind(answer.id, id, answer.author_email, answer.author_name, answer.create_time),
	]);
	await recordEvent(env, {
		type: "decision_created",
		decisionRef: row.stats_ref,
		client: caller.client,
		email: caller.email,
		detail: { kind: "price" },
	});
	const handoffMessage = priceHandoffMessage({
		starterName: caller.name,
		decisionId: id,
		code,
		connectorUrl: env.MCP_RESOURCE,
		expires: formatDay(expire),
		terms,
	});
	// The code in its combined form, the one thing the other side needs.
	return { decision: priceView(row, [answer], caller, { code: combinedCode(id, code), handoffMessage }), receivedLimit };
}

// ---- Answering

/** An invalid price answer, said so the assistant knows nothing was used up. */
function notCounted(error: unknown): never {
	if (error instanceof ApiError && error.code === "INVALID_ARGUMENT") {
		throw new ApiError(error.code, `${error.message} Not counted.`, error.reason);
	}
	throw error;
}

export async function createPriceAnswer(
	env: Env,
	caller: Caller,
	request: { parent?: string; code: string; price: LimitInput; validateOnly?: boolean },
) {
	requireOn(env);
	const now = Date.now();
	const { row: loaded, code } = await requestForCode(env, caller, request.parent, request.code);
	// Decided before anything else happens with the request: nothing is bound or counted.
	if (loaded.kind !== "price") {
		throw new ApiError(
			"INVALID_ARGUMENT",
			`This is a meeting request from ${firstName(loaded.starter_name) || "someone"}, not a price. Ask your person when they're free and send their times as answer.meeting. Not counted as a try.`,
		);
	}
	const terms = termsOf(loaded);
	const side = other(terms.starterSide);
	const field = fieldFor(side);
	const value = request.price[field];
	if (value === undefined || request.price[fieldFor(other(side))] !== undefined) {
		throw new ApiError(
			"INVALID_ARGUMENT",
			`In this request your person ${side === "PAYS" ? "pays" : "receives the money"}, so send only answer.price.${field}: ${askFor(side)}. Not counted.`,
		);
	}
	const { row } = await refresh(env, loaded, now);
	if (row.state !== "WAITING" || row.code_used || row.attempts > 0) {
		throw new ApiError(
			"FAILED_PRECONDITION",
			row.state === "EXPIRED"
				? "This request has ended (EXPIRED). Ask the person who sent it to start a new one."
				: "This request has already been answered.",
		);
	}
	// Answers are always in the request's currency. A different one written into the amount is the likeliest
	// mistake (the person thought in euros), so it gets its own message.
	const elsewhere = typeof value === "string" ? otherCurrencyIn(value, terms.currency) : null;
	if (elsewhere) {
		throw new ApiError("INVALID_ARGUMENT", `This request is in ${terms.currency}; send just the number, e.g. "1700". Not counted.`);
	}
	let minor: number;
	try {
		minor = parseAmount(value, terms.currency);
	} catch (error) {
		notCounted(error);
	}
	await checkCreateAnswer(env, caller.email, row.starter_email, row.id, now);
	await checkPriceAnswer(env, caller.email, now);
	const receivedLimit = limitText(side, minor, terms);
	if (request.validateOnly) {
		return { validateOnly: true as const, receivedLimit };
	}

	let starterLimit: number;
	try {
		starterLimit = await unsealLimit(row.limit_sealed ?? "", code, row.id);
	} catch (error) {
		console.error("sealed limit unreadable", row.id, error);
		throw new ApiError("FAILED_PRECONDITION", "This request can't be answered any more. Ask the person who sent it to start a new one.");
	}
	const [minimum, maximum] = side === "PAYS" ? [starterLimit, minor] : [minor, starterLimit];
	const outcome = midpoint(minimum, maximum, terms.currency);
	const state = outcome.deal ? "AGREED" : "NO_MATCH";
	const agreed = outcome.deal ? outcome.price : null;
	const answerId = randomId(26);
	const claimId = randomId(16);
	const owned = "EXISTS (SELECT 1 FROM decisions WHERE id = ? AND claim_id = ?)";

	const person = await personId(env, caller.email);
	const dayAgo = iso(now - 24 * 60 * 60 * 1000);
	const detail = {
		kind: "price",
		outcome: outcome.deal ? "agreed" : "no_match",
		minutesSinceStart: Math.round((now - Date.parse(row.create_time)) / 60_000),
	};

	// Settles in one go: the one answer, the result, the starter's sealed limit gone, and the event that counts
	// toward the daily limit. Nothing outside Neutra happens before the result, so no in-between state is needed.
	// The guard lets only one answer in, and re-counts today's price answers inside the same write, so parallel
	// answers to different requests can't get past the daily limit either.
	const settled = await env.DB.batch([
		env.DB.prepare(
			`UPDATE decisions SET state = ?, agreed_minor = ?, limit_sealed = NULL, responder_email = ?, code_used = 1, attempts = attempts + 1, claim_id = ?, update_time = ?
			 WHERE id = ? AND state = 'WAITING' AND code_used = 0 AND attempts = 0 AND (${PRICE_ANSWERS_TODAY}) < ?`,
		).bind(state, agreed, caller.email, claimId, iso(now), row.id, person, dayAgo, LIMITS.priceAnswersPerDay),
		env.DB.prepare(
			`INSERT INTO answers (id, decision_id, author_email, author_name, role, windows_json, time_zone, create_time) SELECT ?, ?, ?, ?, 'RESPONDER', '[]', NULL, ? WHERE ${owned}`,
		).bind(answerId, row.id, caller.email, caller.name, iso(now), row.id, claimId),
		env.DB.prepare(
			`INSERT INTO events (type, decision_ref, client, person, detail_json, create_time) SELECT 'answer_submitted', ?, ?, ?, ?, ? WHERE ${owned}`,
		).bind(row.stats_ref, caller.client ?? "unknown", person, JSON.stringify(detail), iso(now), row.id, claimId),
		env.DB.prepare("UPDATE decisions SET claim_id = NULL WHERE id = ? AND claim_id = ?").bind(row.id, claimId),
	]);
	if (settled[0].meta.changes !== 1) {
		// Either someone answered first, or this person reached the daily limit in the meantime.
		const current = await env.DB.prepare("SELECT state FROM decisions WHERE id = ?").bind(row.id).first<{ state: string }>();
		if (current?.state === "WAITING") priceAnswerLimit();
		throw new ApiError("FAILED_PRECONDITION", "This request has already been answered.");
	}
	const next: DecisionRow = {
		...row,
		state,
		agreed_minor: agreed,
		limit_sealed: null,
		responder_email: caller.email,
		code_used: 1,
		attempts: 1,
		update_time: iso(now),
	};
	const answers = await answersOf(env, row.id);
	// The result email goes out now. If it fails, the result stands and the maintenance job tries again.
	try {
		await sendEmail(env, await priceNotice(env, next));
		await env.DB.prepare("UPDATE decisions SET notified = 1 WHERE id = ?").bind(row.id).run();
	} catch (error) {
		console.error("result email failed", row.id, error);
	}
	// The limit just sent isn't returned: limits never come back once submitted, not even your own.
	return { decision: priceView(next, answers, caller) };
}

// ---- Emails

type NoticeRow = Pick<DecisionRow, "id" | "state" | "starter_email" | "starter_name" | "responder_email" | "terms_json" | "agreed_minor" | "expire_time">;

/** The email for a price decision that has ended: the result to both people, or "nobody answered" to the starter. */
export async function priceNotice(env: Env, d: NoticeRow): Promise<{ to: string; subject: string; body: string }> {
	const terms = JSON.parse(d.terms_json ?? "{}") as PriceTerms;
	const starter = firstName(d.starter_name);
	if (d.state === "EXPIRED" || !d.responder_email) {
		return {
			to: d.starter_email,
			subject: "Your Neutra price request expired",
			body: `Hi ${starter},

Nobody answered your Neutra price request about ${terms.subject} by ${formatDay(Date.parse(d.expire_time))}.

If you still want to agree on a price, ask your assistant to start a new request and send the message again.

Neutra`,
		};
	}
	const responder = await env.DB.prepare("SELECT author_name FROM answers WHERE decision_id = ? AND role = 'RESPONDER'")
		.bind(d.id)
		.first<{ author_name: string }>();
	const responderName = responder?.author_name ?? "The other person";
	// One email to both, with both addresses visible: after a deal they settle the details between them.
	const to = `${d.starter_email}, ${d.responder_email}`;
	const hi = `Hi ${starter} and ${firstName(responderName)},`;
	if (d.state === "AGREED" && d.agreed_minor !== null) {
		return {
			to,
			subject: `Deal: ${terms.subject}`,
			body: `${hi}

You have a deal through Neutra: ${subjectText(terms)} at ${formatAmount(d.agreed_minor, terms.currency, terms.unit)}. That's halfway between the two numbers you each gave, so each of you can now work out the other's.

This is an agreement in principle only, not a contract, and no money has moved. Settle the details directly with each other:
${d.starter_name}: ${d.starter_email}
${responderName}: ${d.responder_email}

Neutra`,
		};
	}
	return {
		to,
		subject: `No deal: ${terms.subject}`,
		body: `${hi}

Your numbers for ${subjectText(terms)} didn't overlap, so there's no deal. Neither of you learned the other's number.

If you'd like to keep talking, write to each other directly or start a new request.

Neutra`,
	};
}
