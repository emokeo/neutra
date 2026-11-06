import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerRequest, readDecision, startDecision } from "../src/handlers";
import { fakeGoogle } from "./fake-calendar";
import { FakeD1 } from "./fake-d1";

const anna = { email: "anna@example.com", name: "Anna" };
const ben = { email: "ben@example.com", name: "Ben" };
const annaFree = { availableWindows: [{ startTime: "2026-11-04T17:00:00Z", endTime: "2026-11-04T20:00:00Z" }] };
const rent = { subject: "Rent for the flat", currencyCode: "CHF", unit: "per month" };

let env: Env;
let db: FakeD1;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-03T08:00:00Z"));
	vi.stubGlobal("fetch", fakeGoogle().fetch);
	db = new FakeD1();
	env = {
		DB: db,
		GOOGLE_CLIENT_ID: "id",
		GOOGLE_CLIENT_SECRET: "secret",
		INVITER_REFRESH_TOKEN: "refresh",
		MCP_RESOURCE: "https://neutra.example.dev/mcp",
		COOKIE_ENCRYPTION_KEY: "test-key",
		PRICE_DECISIONS: "open",
	} as unknown as Env;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const count = () => (db.db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n;

async function refused(promise: Promise<unknown>, code: string, text: string) {
	await expect(promise).rejects.toMatchObject({ code, message: expect.stringContaining(text) });
}

describe("create_decision", () => {
	it("starts a meeting from decision.meeting, as before", async () => {
		const result = await startDecision(env, anna, { decision: { meeting: { duration: "3600s" } }, starterAnswer: { meeting: annaFree } }, true);
		expect(result).toMatchObject({ state: "WAITING", meeting: { duration: "3600s" } });
		expect(result).not.toHaveProperty("kind");
		expect(result.nextStep).toContain("exactly as written");
	});

	it("starts a price decision from decision.price", async () => {
		const result = await startDecision(env, anna, { decision: { price: rent }, starterAnswer: { price: { minimumToAccept: "1700" } } }, true);
		// neutra.v1.CreateDecisionResponse.
		expect(Object.keys(result)).toEqual(["decision", "receivedLimit", "nextStep"]);
		expect(result).toMatchObject({
			decision: { state: "WAITING", price: { currencyCode: "CHF" }, code: expect.stringMatching(/^neutra:/), handoffMessage: expect.stringContaining("agree on a price") },
			receivedLimit: "CHF 1,700 per month, the least you'd accept for \"Rent for the flat\"",
		});
		expect(result.nextStep).toContain("Show the handoffMessage exactly as written.");
		const check = await startDecision(
			env,
			anna,
			{ decision: { price: rent }, starterAnswer: { price: { minimumToAccept: "1700" } }, validateOnly: true },
			true,
		);
		expect(Object.keys(check)).toEqual(["receivedLimit", "nextStep"]);
		expect(check).toMatchObject({ receivedLimit: expect.stringContaining("CHF 1,700 per month"), nextStep: expect.stringContaining("Read this back") });
		expect(count()).toBe(1);
	});

	it("asks for exactly one kind, with a matching starterAnswer", async () => {
		await refused(startDecision(env, anna, { decision: {}, starterAnswer: { meeting: annaFree } }, true), "INVALID_ARGUMENT", "exactly one of decision.meeting");
		await refused(
			startDecision(env, anna, { decision: { meeting: { duration: "3600s" }, price: rent }, starterAnswer: { meeting: annaFree } }, true),
			"INVALID_ARGUMENT",
			"exactly one of decision.meeting",
		);
		await refused(
			startDecision(env, anna, { decision: { price: rent }, starterAnswer: { meeting: annaFree } }, true),
			"INVALID_ARGUMENT",
			"A price decision takes starterAnswer.price",
		);
		await refused(
			startDecision(env, anna, { decision: { meeting: { duration: "3600s" } }, starterAnswer: { price: { maximumToPay: "10" } } }, true),
			"INVALID_ARGUMENT",
			"A meeting decision takes starterAnswer.meeting",
		);
		await refused(
			startDecision(env, anna, { decision: { meeting: { duration: "3600s" } }, starterAnswer: { meeting: annaFree }, validateOnly: true }, true),
			"INVALID_ARGUMENT",
			"validateOnly is only for price decisions",
		);
		expect(count()).toBe(0);
	});

	it("refuses a price decision from someone who may not start one", async () => {
		await refused(
			startDecision(env, anna, { decision: { price: rent }, starterAnswer: { price: { minimumToAccept: "1700" } } }, false),
			"FAILED_PRECONDITION",
			"Price requests aren't available yet.",
		);
		expect(count()).toBe(0);
	});
});

describe("create_answer and get_decision", () => {
	it("route by what is sent", async () => {
		const started = await startDecision(env, anna, { decision: { price: rent }, starterAnswer: { price: { minimumToAccept: "1700" } } }, true);
		if (!("decision" in started) || !started.decision) throw new Error("expected a decision");
		const { name, code } = started.decision as { name: string; code: string };
		await refused(answerRequest(env, ben, { code, answer: {} }), "INVALID_ARGUMENT", "exactly one of answer.meeting");
		// neutra.v1.GetDecisionResponse: a preview by code.
		const preview = await readDecision(env, ben, { code });
		expect(Object.keys(preview)).toEqual(["preview", "nextStep"]);
		expect(preview).toMatchObject({ preview: { from: "Anna", open: true, price: { yourSide: "PAYS" } } });
		await refused(readDecision(env, ben, {}), "INVALID_ARGUMENT", "Send name or code.");
		await refused(readDecision(env, ben, { name, code }), "INVALID_ARGUMENT", "not both");
		const check = await answerRequest(env, ben, { code, answer: { price: { maximumToPay: "1800" } }, validateOnly: true });
		expect(check).toEqual({ receivedLimit: "CHF 1,800 per month, the most you'd pay for \"Rent for the flat\"", nextStep: expect.stringContaining("Read this back") });
		// neutra.v1.CreateAnswerResponse, without the limit.
		const answered = await answerRequest(env, ben, { code, answer: { price: { maximumToPay: "1800" } } });
		expect(Object.keys(answered)).toEqual(["decision", "nextStep"]);
		expect(answered).toMatchObject({ decision: { state: "AGREED", price: { agreedPriceText: "CHF 1,750 per month" } }, nextStep: expect.stringContaining("deal on Rent for the flat at CHF 1,750 per month") });
		// By name, a participant gets the decision.
		const read = await readDecision(env, anna, { name });
		expect(Object.keys(read)).toEqual(["decision", "nextStep"]);
		expect(read).toMatchObject({ decision: { name, state: "AGREED", price: { yourSide: "RECEIVES" } } });
	});
});
