// featureRequests/{feature_request}: agents tell Neutra what their person wanted but Neutra can't do yet.
// The text reaches only Neutra's maintainers, never another agent.
import { ApiError, type Caller } from "./decisions";
import { personId } from "./events";

export const FEATURE_REQUESTS_PER_DAY = 20;
const MAX_LENGTH = 500;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function randomId(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (b, i) => (i === 0 ? ALPHABET[b % 26] : ALPHABET[b % 32])).join("");
}

/** Removes things that identify people: email addresses, phone numbers, links. */
export function scrub(text: string): string {
	return text
		.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[removed]")
		.replace(/\bhttps?:\/\/\S+/gi, "[removed]")
		.replace(/\+?\d[\d\s().-]{7,}\d/g, "[removed]")
		.trim();
}

export async function createFeatureRequest(env: Env, caller: Caller, summary: string) {
	const clean = scrub(summary);
	if (!clean) throw new ApiError("INVALID_ARGUMENT", "Describe the feature in a sentence or two.");
	if (clean.length > MAX_LENGTH) throw new ApiError("INVALID_ARGUMENT", `Keep it under ${MAX_LENGTH} characters.`);

	const author = await personId(env, caller.email);
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM feature_requests WHERE author = ? AND create_time > ?")
		.bind(author, since)
		.first<{ n: number }>();
	if ((recent?.n ?? 0) >= FEATURE_REQUESTS_PER_DAY) {
		throw new ApiError("RESOURCE_EXHAUSTED", `Limit reached: ${FEATURE_REQUESTS_PER_DAY} feature requests per day. Try again tomorrow.`);
	}

	const id = randomId(26);
	const createTime = new Date().toISOString();
	await env.DB.prepare("INSERT INTO feature_requests (id, author, client, summary, create_time) VALUES (?, ?, ?, ?, ?)")
		.bind(id, author, caller.client ?? "unknown", clean, createTime)
		.run();
	return { name: `featureRequests/${id}`, summary: clean, createTime };
}

export async function getFeatureRequest(env: Env, caller: Caller, name: string) {
	const match = /^featureRequests\/([a-z][a-z2-7]{25})$/.exec(name);
	if (!match) throw new ApiError("NOT_FOUND", `${name} does not exist.`);
	const row = await env.DB.prepare("SELECT * FROM feature_requests WHERE id = ?")
		.bind(match[1])
		.first<{ id: string; author: string; summary: string; create_time: string }>();
	if (!row) throw new ApiError("NOT_FOUND", `${name} does not exist.`);
	if (row.author !== (await personId(env, caller.email))) {
		throw new ApiError("PERMISSION_DENIED", "Only the author can read a feature request.");
	}
	return { name, summary: row.summary, createTime: row.create_time };
}
