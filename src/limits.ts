// Rate limits: keep Neutra usable for everyone and make probing or spamming impractical.
import { ApiError, type ErrorReason } from "./decisions";
import { personId } from "./events";

export const LIMITS = {
	/** Decisions one person may start per 24 hours. */
	decisionsPerDay: 50,
	/** Answers (including retries) one person may send per hour. */
	answersPerHour: 100,
	/** Decisions from the same starter one person may answer per 24 hours, so a starter can't probe someone with many decisions. */
	answeredFromSameStarterPerDay: 3,
	/** Price requests one person may answer per 24 hours, from anyone (each with all its tries). Each answer tells its starter something
	 * (deal or no deal), so many requests to the same person could otherwise narrow down their number. */
	priceAnswersPerDay: 3,
};

const HOUR = 60 * 60 * 1000;

function tooMany(what: string, reason?: ErrorReason): never {
	throw new ApiError("RESOURCE_EXHAUSTED", `Limit reached: ${what}. Try again later.`, reason);
}

export async function checkCreateDecision(env: Env, email: string, now = Date.now()): Promise<void> {
	const since = new Date(now - 24 * HOUR).toISOString();
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM decisions WHERE starter_email = ? COLLATE NOCASE AND create_time > ?")
		.bind(email, since)
		.first<{ n: number }>();
	if ((row?.n ?? 0) >= LIMITS.decisionsPerDay) tooMany(`${LIMITS.decisionsPerDay} new decisions per day`);
}

export async function checkCreateAnswer(env: Env, email: string, starterEmail: string, decisionId: string, now = Date.now()): Promise<void> {
	const person = await personId(env, email);
	const hourAgo = new Date(now - HOUR).toISOString();
	const answers = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE person = ? AND type = 'answer_submitted' AND create_time > ?")
		.bind(person, hourAgo)
		.first<{ n: number }>();
	if ((answers?.n ?? 0) >= LIMITS.answersPerHour) tooMany(`${LIMITS.answersPerHour} answers per hour`, "ANSWER_LIMIT");

	const dayAgo = new Date(now - 24 * HOUR).toISOString();
	const sameStarter = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM decisions WHERE starter_email = ? COLLATE NOCASE AND responder_email = ? COLLATE NOCASE AND id != ? AND create_time > ?",
	)
		.bind(starterEmail, email, decisionId, dayAgo)
		.first<{ n: number }>();
	if ((sameStarter?.n ?? 0) >= LIMITS.answeredFromSameStarterPerDay) {
		tooMany(`${LIMITS.answeredFromSameStarterPerDay} decisions from the same person per day`, "SAME_STARTER_LIMIT");
	}
}

/**
 * Price requests answered count from the anonymous events, like the hourly limit: answer rows go when a decision
 * is deleted, and deleting a settled request must not give the answer back. Requests, not tries, count, so a
 * request with several answers doesn't use up the day; the request being answered is left out, so its own
 * later tries are never refused by this limit. Parameters: person, since, the request's stats_ref.
 */
export const PRICE_REQUESTS_TODAY =
	"SELECT COUNT(DISTINCT decision_ref) FROM events WHERE person = ? AND type = 'answer_submitted' AND json_extract(detail_json, '$.kind') = 'price' AND create_time > ? AND decision_ref IS NOT ?";

export async function checkPriceAnswer(env: Env, email: string, decisionRef: string | null, now = Date.now()): Promise<void> {
	const row = await env.DB.prepare(PRICE_REQUESTS_TODAY.replace("COUNT(DISTINCT decision_ref)", "COUNT(DISTINCT decision_ref) AS n"))
		.bind(await personId(env, email), new Date(now - 24 * HOUR).toISOString(), decisionRef)
		.first<{ n: number }>();
	if ((row?.n ?? 0) >= LIMITS.priceAnswersPerDay) priceAnswerLimit();
}

export function priceAnswerLimit(): never {
	tooMany(`${LIMITS.priceAnswersPerDay} price requests answered per day, so nobody can work out a person's number with many requests`, "PRICE_ANSWER_LIMIT");
}
