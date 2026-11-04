// Rate limits: keep Neutra usable for everyone and make probing or spamming impractical.
import { ApiError } from "./decisions";
import { personId } from "./events";

export const LIMITS = {
	/** Decisions one person may start per 24 hours. */
	decisionsPerDay: 50,
	/** Answers (including retries) one person may send per hour. */
	answersPerHour: 100,
	/** Decisions from the same starter one person may answer per 24 hours, so a starter can't probe someone with many decisions. */
	answeredFromSameStarterPerDay: 3,
};

const HOUR = 60 * 60 * 1000;

function tooMany(what: string): never {
	throw new ApiError("RESOURCE_EXHAUSTED", `Limit reached: ${what}. Try again later.`);
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
	if ((answers?.n ?? 0) >= LIMITS.answersPerHour) tooMany(`${LIMITS.answersPerHour} answers per hour`);

	const dayAgo = new Date(now - 24 * HOUR).toISOString();
	const sameStarter = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM decisions WHERE starter_email = ? COLLATE NOCASE AND responder_email = ? COLLATE NOCASE AND id != ? AND create_time > ?",
	)
		.bind(starterEmail, email, decisionId, dayAgo)
		.first<{ n: number }>();
	if ((sameStarter?.n ?? 0) >= LIMITS.answeredFromSameStarterPerDay) {
		tooMany(`${LIMITS.answeredFromSameStarterPerDay} decisions from the same person per day`);
	}
}
