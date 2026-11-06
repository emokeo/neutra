import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiError, createAnswer, createDecision, deleteDecision, getAnswer, getDecision, requestPreview } from "../src/decisions";
import { codeNextStep, priceNextStep, SERVER_INSTRUCTIONS, serverInstructions } from "../src/guidance";
import { runMaintenance } from "../src/maintenance";
import { canStartPrice, createPriceAnswer, createPriceDecision } from "../src/price";
import { fakeGoogle } from "./fake-calendar";
import { FakeD1 } from "./fake-d1";

const anna = { email: "anna@example.com", name: "Anna Muster", client: "Claude" };
const ben = { email: "ben@example.com", name: "Ben Beispiel", client: "Muse" };
const eve = { email: "eve@example.com", name: "Eve" };
const NOW = "2026-11-03T08:00:00Z";

let env: Env;
let db: FakeD1;
let google: ReturnType<typeof fakeGoogle>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	google = fakeGoogle();
	vi.stubGlobal("fetch", google.fetch);
	db = new FakeD1();
	env = {
		DB: db,
		GOOGLE_CLIENT_ID: "id",
		GOOGLE_CLIENT_SECRET: "secret",
		INVITER_REFRESH_TOKEN: "refresh",
		MCP_RESOURCE: "https://neutra.example.dev/mcp",
		COOKIE_ENCRYPTION_KEY: "test-key",
		ALLOWED_EMAILS: "anna@example.com",
		PRICE_DECISIONS: "open",
	} as unknown as Env;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const rent = { subject: "Rent for the flat at Seestrasse 12", details: "utilities included", currencyCode: "chf", unit: "per month" };

/** Anna lets the flat: she receives the money and accepts at least 1700 a month. */
async function annaLets(minimum: string | number = "1700") {
	const result = await createPriceDecision(env, anna, { price: rent, starterAnswer: { minimumToAccept: minimum } });
	if (result.validateOnly) throw new Error("expected a decision");
	// decision.code is the combined form, "neutra:<id>.<code>".
	const combined = result.decision.code as string;
	return { ...result, name: result.decision.name, combined, secret: combined.split(".")[1] };
}

/** "neutra:<id>.<code>" for a decision started directly. */
function codeOf(result: Awaited<ReturnType<typeof createPriceDecision>>): string {
	if (result.validateOnly) throw new Error("expected a decision");
	return result.decision.code as string;
}

async function rejects(promise: Promise<unknown>, code: ApiError["code"], text?: string) {
	const error = await promise.then(
		() => null,
		(e) => e,
	);
	expect(error).toMatchObject({ code });
	if (text) expect(error.message).toContain(text);
	return error as ApiError;
}

const row = () => db.db.prepare("SELECT * FROM decisions").get() as Record<string, unknown>;

describe("starting a price decision", () => {
	it("stores the terms, seals the limit and returns a hand-off message", async () => {
		const d = await annaLets("1850");
		expect(d.name).toMatch(/^decisions\/[a-z][a-z2-7]{25}$/);
		expect(d.receivedLimit).toBe('CHF 1,850 per month, the least you\'d accept for "Rent for the flat at Seestrasse 12 (utilities included)"');
		const stored = row();
		expect(stored.kind).toBe("price");
		expect(JSON.parse(stored.terms_json as string)).toEqual({
			subject: rent.subject,
			details: rent.details,
			currency: "CHF",
			unit: "per month",
			starterSide: "RECEIVES",
			rule: "MIDPOINT",
		});
		expect(stored.limit_sealed).toBeTruthy();
		expect(JSON.stringify(stored)).not.toContain("1850");
		expect(JSON.stringify(stored)).not.toContain("185000");
		expect(stored.duration_seconds).toBe(0);
		expect(stored.offered_until).toBe(stored.expire_time);
	});

	it("shows no amount in the view", async () => {
		const d = await annaLets("1850");
		const id = d.name.split("/")[1];
		// neutra.v1.Decision: every price field inside price, the rest as for meetings.
		expect(d.decision).toEqual({
			name: d.name,
			price: {
				subject: rent.subject,
				details: rent.details,
				currencyCode: "CHF",
				unit: "per month",
				answerBy: "2026-11-17",
				rule: "MIDPOINT",
				yourSide: "RECEIVES",
			},
			state: "WAITING",
			participants: [{ displayName: "Anna Muster", role: "STARTER" }],
			code: `neutra:${id}.${d.secret}`,
			handoffMessage: expect.stringContaining("agree on a price"),
			expireTime: "2026-11-17T08:00:00.000Z",
			createTime: "2026-11-03T08:00:00.000Z",
		});
		expect(JSON.stringify(d.decision)).not.toContain("1850");
	});

	it("writes the hand-off message for the paying side", async () => {
		const d = await annaLets();
		const id = d.name.split("/")[1];
		expect(d.decision.handoffMessage).toBe(`Anna wants to agree on a price with you through Neutra (neutra.example.dev): Rent for the flat at Seestrasse 12 (utilities included), in CHF per month. You pay; Anna receives.

You each tell Neutra one number in private: you the most you'd pay, Anna the least they'd accept. If yours is at least theirs, the price is halfway between them. If not, you both hear only "no deal" and neither learns the other's number. You have one answer, so give your real maximum, not an opening offer. A deal isn't a contract: you two confirm it yourselves.

To answer:
1. Add Neutra to your AI assistant. In Claude it's in the connector directory: https://claude.ai/directory/connectors/neutra
Other assistants: add https://neutra.example.dev/mcp as a custom connector. Steps: https://neutra.example.dev/r/${id}
2. Tell your assistant: "Answer Neutra request neutra:${id}.${d.secret}. The most I'd pay is CHF … per month."

No AI assistant? Answer in your browser instead: https://neutra.example.dev/a/${id}.${d.secret}

Open until Tue 17 Nov.`);
	});

	it("writes the mirror message when the starter pays", async () => {
		const d = await createPriceDecision(env, anna, { price: { subject: "Old bike", currencyCode: "EUR" }, starterAnswer: { maximumToPay: "120" } });
		if (d.validateOnly) throw new Error("expected a decision");
		const message = d.decision.handoffMessage as string;
		expect(message).toContain("Old bike, in EUR. Anna pays; you receive.");
		expect(message).toContain("you the least you'd accept, Anna the most they'd pay. If yours is at most theirs");
		expect(message).toContain("give your real minimum");
		expect(message).toContain(`The least I'd accept is EUR ….`);
		expect(d.receivedLimit).toBe('EUR 120, the most you\'d pay for "Old bike"');
	});

	it("with validateOnly, reads the limit back and stores nothing", async () => {
		const result = await createPriceDecision(env, anna, { price: rent, starterAnswer: { minimumToAccept: "1850.5" }, validateOnly: true });
		expect(result).toEqual({ validateOnly: true, receivedLimit: 'CHF 1,850.50 per month, the least you\'d accept for "Rent for the flat at Seestrasse 12 (utilities included)"' });
		expect((db.db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n).toBe(0);
		expect((db.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(0);
	});

	it("refuses unclear terms, saying what to send", async () => {
		const start = (price: object, starterAnswer: object = { minimumToAccept: "1700" }) =>
			createPriceDecision(env, anna, { price: { ...rent, ...price } as typeof rent, starterAnswer });
		await rejects(start({ subject: "ab" }), "INVALID_ARGUMENT", "3 to 120 characters");
		await rejects(start({ subject: "Rent\nfor the flat" }), "INVALID_ARGUMENT", "one line");
		await rejects(start({ unit: "x".repeat(31) }), "INVALID_ARGUMENT", "at most 30");
		await rejects(start({ currencyCode: "Fr." }), "INVALID_ARGUMENT", "ISO 4217");
		await rejects(start({}, {}), "INVALID_ARGUMENT", "exactly one of");
		await rejects(start({}, { minimumToAccept: "1700", maximumToPay: "1900" }), "INVALID_ARGUMENT", "exactly one of");
		await rejects(start({}, { minimumToAccept: "1'700" }), "INVALID_ARGUMENT", "isn't a plain amount");
		await rejects(start({ answerBy: "2026-11-03" }), "INVALID_ARGUMENT", "from tomorrow to 14 days");
		await rejects(start({ answerBy: "2026-11-18" }), "INVALID_ARGUMENT", "from tomorrow to 14 days");
		await rejects(start({ answerBy: "2026-11-31" }), "INVALID_ARGUMENT", "YYYY-MM-DD");
	});

	it("refuses terms that give the limit away", async () => {
		await rejects(
			createPriceDecision(env, anna, { price: { ...rent, details: "not under 1'700" }, starterAnswer: { minimumToAccept: "1700" } }),
			"INVALID_ARGUMENT",
			"The details contains your person's limit",
		);
		await rejects(
			createPriceDecision(env, anna, { price: { ...rent, subject: "Rent, at least 1700 francs" }, starterAnswer: { minimumToAccept: "1700.00" } }),
			"INVALID_ARGUMENT",
			"leave the number out",
		);
	});

	it("takes a deadline from the starter, at the end of that day", async () => {
		const d = await createPriceDecision(env, anna, { price: { ...rent, answerBy: "2026-11-10" }, starterAnswer: { minimumToAccept: "1700" } });
		if (d.validateOnly) throw new Error("expected a decision");
		expect(d.decision.expireTime).toBe("2026-11-10T23:59:59.999Z");
		expect(d.decision.price.answerBy).toBe("2026-11-10");
		expect(d.decision.handoffMessage).toContain("Open until Tue 10 Nov.");
	});
});

describe("answering a price request", () => {
	it("makes a deal at the midpoint and emails both people", async () => {
		const d = await annaLets("1700");
		const result = await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1850" } });
		if (result.validateOnly) throw new Error("expected an answer");
		expect(result.decision).toMatchObject({
			state: "AGREED",
			price: { agreedPrice: "1775.00", agreedPriceText: "CHF 1,775 per month", yourSide: "PAYS", currencyCode: "CHF" },
		});
		expect(result.decision.participants.map((p) => p.role)).toEqual(["STARTER", "RESPONDER"]);
		// Limits never come back once sent, not even your own; the starter's code only at creation.
		expect(result).not.toHaveProperty("receivedLimit");
		expect(result.decision).not.toHaveProperty("code");
		expect(JSON.stringify(result)).not.toMatch(/1850|1,850|1700|1,700/);
		expect(row()).toMatchObject({ state: "AGREED", agreed_minor: 177500, limit_sealed: null, code_used: 1, attempts: 1, notified: 1 });

		expect(google.emails).toHaveLength(1);
		const email = google.emails[0].raw;
		expect(email).toContain("To: anna@example.com, ben@example.com");
		expect(email).toContain("You have a deal through Neutra: Rent for the flat at Seestrasse 12 (utilities included) at CHF 1,775 per month.");
		expect(email).toContain("not a contract");
		expect(email).not.toContain("1,700");
		expect(email).not.toContain("1,850");

		// Anna sees the same result.
		expect(await getDecision(env, anna, d.name)).toMatchObject({ state: "AGREED", price: { agreedPriceText: "CHF 1,775 per month", yourSide: "RECEIVES" } });
		const answerId = (db.db.prepare("SELECT id FROM answers WHERE role = 'RESPONDER'").get() as { id: string }).id;
		const answerName = `${d.name}/answers/${answerId}`;
		expect(await getAnswer(env, ben, answerName)).toEqual({ name: answerName, price: {}, createTime: "2026-11-03T08:00:00.000Z" });
	});

	it("agrees at the limit when both give the same number, and keeps whole amounts whole", async () => {
		const d = await annaLets("1800");
		const same = await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1800" } });
		expect(same.decision).toMatchObject({ price: { agreedPrice: "1800.00" } });
		const other = await annaLets("1700");
		const odd = await createPriceAnswer(env, eve, { code: other.combined, price: { maximumToPay: "1851" } });
		expect(odd.decision).toMatchObject({ price: { agreedPriceText: "CHF 1,776 per month" } });
	});

	it("says only 'no deal' when the numbers don't overlap", async () => {
		const d = await annaLets("1900");
		const result = await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1800" } });
		expect(result.decision).toMatchObject({ state: "NO_MATCH" });
		expect(result.decision?.price).not.toHaveProperty("agreedPrice");
		expect(JSON.stringify(result)).not.toContain("1900");
		expect(row()).toMatchObject({ state: "NO_MATCH", agreed_minor: null, limit_sealed: null });
		expect(google.emails[0].raw).toContain("Subject: =?UTF-8?B?");
		expect(google.emails[0].raw).toContain("didn't overlap, so there's no deal. Neither of you learned the other's number.");
		expect(google.emails[0].raw).not.toContain("1,900");
	});

	it("takes one answer only, and never from the starter", async () => {
		const d = await annaLets();
		await rejects(createPriceAnswer(env, anna, { code: d.combined, price: { minimumToAccept: "1600" } }), "PERMISSION_DENIED");
		await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1600" } });
		await rejects(createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1800" } }), "FAILED_PRECONDITION", "already been answered");
		await rejects(createPriceAnswer(env, eve, { code: d.combined, price: { maximumToPay: "1800" } }), "FAILED_PRECONDITION", "already been answered");
	});

	it("lets only one of two answers at the same moment through", async () => {
		const d = await annaLets();
		const results = await Promise.allSettled([
			createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1800" } }),
			createPriceAnswer(env, eve, { code: d.combined, price: { maximumToPay: "1900" } }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect((db.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE role = 'RESPONDER'").get() as { n: number }).n).toBe(1);
	});

	it("refuses a meeting answer to a price request, and the other way round, without counting", async () => {
		const d = await annaLets();
		await rejects(
			createAnswer(env, ben, { code: d.combined, windows: [{ startTime: "2026-11-04T17:00:00Z", endTime: "2026-11-04T20:00:00Z" }] }),
			"INVALID_ARGUMENT",
			'This is a price request ("Rent for the flat at Seestrasse 12", CHF per month), not a meeting. Your person pays: ask them the most they\'d pay and send answer.price.maximumToPay. Not counted as a try.',
		);
		expect(row()).toMatchObject({ state: "WAITING", attempts: 0, responder_email: null });

		const meeting = await createDecision(env, anna, {
			durationSeconds: "3600s",
			starterWindows: [{ startTime: "2026-11-04T17:00:00Z", endTime: "2026-11-04T20:00:00Z" }],
		});
		await rejects(
			createPriceAnswer(env, ben, { parent: meeting.name, code: meeting.code!, price: { maximumToPay: "10" } }),
			"INVALID_ARGUMENT",
			"This is a meeting request from Anna, not a price. Ask your person when they're free and send their times as answer.meeting. Not counted as a try.",
		);
		const after = await createAnswer(env, ben, {
			parent: meeting.name,
			code: meeting.code!,
			windows: [{ startTime: "2026-11-06T09:00:00Z", endTime: "2026-11-06T12:00:00Z" }],
		});
		expect(after.decision.remainingAttempts).toBe(2);
	});

	it("names the right field for the person's side, without counting", async () => {
		const d = await annaLets();
		await rejects(
			createPriceAnswer(env, ben, { code: d.combined, price: { minimumToAccept: "1800" } }),
			"INVALID_ARGUMENT",
			"In this request your person pays, so send only answer.price.maximumToPay: the most they'd pay. Not counted.",
		);
		await rejects(createPriceAnswer(env, ben, { code: d.combined, price: { minimumToAccept: "1", maximumToPay: "1800" } }), "INVALID_ARGUMENT");
		expect(row()).toMatchObject({ state: "WAITING", attempts: 0 });
	});

	it("reads amounts in the request's currency, and says so when another is written in", async () => {
		const d = await annaLets();
		await rejects(
			createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "EUR 1700" } }),
			"INVALID_ARGUMENT",
			'This request is in CHF; send just the number, e.g. "1700". Not counted.',
		);
		await rejects(createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "€1700" } }), "INVALID_ARGUMENT", "This request is in CHF");
		await rejects(
			createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "CHF 1700" } }),
			"INVALID_ARGUMENT",
			"isn't a plain amount. Send digits with an optional dot, e.g. \"1850\" or \"1850.50\". Not counted.",
		);
		await rejects(createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1700.555" } }), "INVALID_ARGUMENT", "Not counted.");
		// A dot for thousands is never quietly read as decimals.
		await rejects(
			createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1.700" } }),
			"INVALID_ARGUMENT",
			'CHF takes at most 2 decimals; got "1.700". If you meant 1700, send "1700". Not counted.',
		);
		expect(row()).toMatchObject({ state: "WAITING", attempts: 0 });
	});

	it("with validateOnly, reads the number back in the request's currency and binds nothing", async () => {
		const d = await annaLets();
		const check = await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1700" }, validateOnly: true });
		expect(check).toEqual({ validateOnly: true, receivedLimit: 'CHF 1,700 per month, the most you\'d pay for "Rent for the flat at Seestrasse 12 (utilities included)"' });
		expect(row()).toMatchObject({ state: "WAITING", attempts: 0, responder_email: null, code_used: 0 });
		// Someone else can still answer: nothing was bound.
		const result = await createPriceAnswer(env, eve, { code: d.combined, price: { maximumToPay: "1700" } });
		expect(result.decision).toMatchObject({ state: "AGREED" });
	});

	it("records what happened, never an amount or a name", async () => {
		const d = await annaLets("1700");
		await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1850" } });
		const events = db.db.prepare("SELECT type, client, detail_json FROM events ORDER BY id").all() as { type: string; detail_json: string }[];
		expect(events.map((e) => e.type)).toEqual(["decision_created", "answer_submitted"]);
		expect(JSON.parse(events[0].detail_json)).toEqual({ kind: "price" });
		expect(JSON.parse(events[1].detail_json)).toMatchObject({ kind: "price", outcome: "agreed" });
		const everything = JSON.stringify(events);
		for (const secret of ["1700", "1850", "1775", "170000", "185000", "177500", "Anna", "Ben", "Rent", d.secret]) {
			expect(everything).not.toContain(secret);
		}
	});

	it("allows 3 price answers per person per day, from anyone, even if a request is deleted", async () => {
		const first = await annaLets("100");
		await createPriceAnswer(env, ben, { code: first.combined, price: { maximumToPay: "50" } });
		// Deleting a settled request removes its answer, but not from the count.
		await deleteDecision(env, anna, first.name);
		for (const minimum of ["200", "300"]) {
			const d = await annaLets(minimum);
			await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "50" } });
		}
		const fourth = codeOf(await createPriceDecision(env, eve, { price: rent, starterAnswer: { minimumToAccept: "400" } }));
		const error = await rejects(
			createPriceAnswer(env, ben, { code: fourth, price: { maximumToPay: "50" } }),
			"RESOURCE_EXHAUSTED",
			"3 price answers per day",
		);
		expect(error.reason).toBe("PRICE_ANSWER_LIMIT");
		// A day later it's fine again.
		vi.setSystemTime(new Date("2026-11-04T08:01:00Z"));
		await createPriceAnswer(env, ben, { code: fourth, price: { maximumToPay: "50" } });
	});

	it("holds the daily limit when answers to different requests arrive at the same moment", async () => {
		const requests = [];
		for (const minimum of ["100", "200", "300", "400", "500"]) requests.push(await annaLets(minimum));
		const results = await Promise.allSettled(
			requests.map((d) => createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "50" } })),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
		expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.reason)).toEqual([
			"PRICE_ANSWER_LIMIT",
			"PRICE_ANSWER_LIMIT",
		]);
		// The refused ones are still open, with their sealed limit.
		const open = db.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE state = 'WAITING' AND limit_sealed IS NOT NULL").get() as { n: number };
		expect(open.n).toBe(2);
	});

	it("keeps the result when the email fails, and the job sends it later", async () => {
		const d = await annaLets("1700");
		const realFetch = google.fetch.getMockImplementation()!;
		google.fetch.mockImplementation(async (input, init) => {
			if (String(input).includes("gmail")) return new Response("{}", { status: 503 });
			return realFetch(input, init);
		});
		const result = await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1850" } });
		expect(result.decision?.state).toBe("AGREED");
		expect(row().notified).toBe(0);
		google.fetch.mockImplementation(realFetch);

		// Not straight away: the answer itself may still be sending it.
		expect(await runMaintenance(env, Date.parse("2026-11-03T08:02:00Z"))).toMatchObject({ notified: 0 });
		expect(await runMaintenance(env, Date.parse("2026-11-03T08:10:00Z"))).toMatchObject({ notified: 1 });
		expect(google.emails).toHaveLength(1);
		expect(google.emails[0].raw).toContain("To: anna@example.com, ben@example.com");
		expect(google.emails[0].raw).toContain("at CHF 1,775 per month");
		expect(await runMaintenance(env, Date.parse("2026-11-03T08:30:00Z"))).toMatchObject({ notified: 0 });
	});
});

describe("get_decision with a code", () => {
	it("previews a price request from the reader's side, without binding the code", async () => {
		const d = await annaLets("1850");
		const { preview, isStarter } = await requestPreview(env, ben, d.combined);
		expect(preview).toEqual({
			from: "Anna",
			answerBy: "2026-11-17",
			open: true,
			price: {
				subject: rent.subject,
				details: rent.details,
				currencyCode: "CHF",
				unit: "per month",
				rule: "MIDPOINT",
				yourSide: "PAYS",
			},
		});
		expect(isStarter).toBe(false);
		expect(JSON.stringify(preview)).not.toContain("1850");
		expect(row()).toMatchObject({ responder_email: null, attempts: 0, code_used: 0 });
		expect(codeNextStep(preview, false)).toContain("answer.price.maximumToPay");
		expect(codeNextStep(preview, false)).toContain("without suggesting a number");

		// The starter sees their own side, and is told the other person answers.
		const own = await requestPreview(env, anna, d.combined);
		expect(own.preview.price).toMatchObject({ yourSide: "RECEIVES" });
		expect(codeNextStep(own.preview, own.isStarter)).toContain("the other person answers it");
	});

	it("previews a meeting request", async () => {
		const meeting = await createDecision(env, anna, {
			durationSeconds: "3600s",
			starterWindows: [{ startTime: "2026-11-04T17:00:00Z", endTime: "2026-11-04T20:00:00Z" }],
		});
		const { preview } = await requestPreview(env, ben, `neutra:${meeting.name.split("/")[1]}.${meeting.code}`);
		expect(preview).toEqual({ from: "Anna", answerBy: "2026-11-17", open: true, meeting: { duration: "3600s" } });
		expect(codeNextStep(preview, false)).toContain("answer.meeting");
	});

	it("shows outsiders only that a request is no longer open, never its result", async () => {
		const d = await annaLets("1700");
		await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1850" } });
		const { preview } = await requestPreview(env, eve, d.combined);
		expect(preview.open).toBe(false);
		expect(JSON.stringify(preview)).not.toMatch(/AGREED|1,775|1775/);
		// The same code with its last character changed to a different one.
		const last = d.combined.slice(-1);
		await rejects(requestPreview(env, eve, `${d.combined.slice(0, -1)}${last === "a" ? "b" : "a"}`), "PERMISSION_DENIED");
		await rejects(requestPreview(env, eve, d.secret), "INVALID_ARGUMENT", "whole code");
	});
});

describe("ending a price request", () => {
	it("expires unanswered after the deadline, clears the sealed limit and tells the starter", async () => {
		const d = await annaLets();
		expect(await runMaintenance(env, Date.parse("2026-11-17T08:15:00Z"))).toMatchObject({ expired: 1, notified: 1 });
		expect(row()).toMatchObject({ state: "EXPIRED", limit_sealed: null });
		expect(google.emails).toHaveLength(1);
		expect(google.emails[0].raw).toContain("To: anna@example.com");
		expect(google.emails[0].raw).toContain("Nobody answered your Neutra price request about Rent for the flat at Seestrasse 12 by Tue 17 Nov.");
		vi.setSystemTime(new Date("2026-11-17T08:20:00Z"));
		await rejects(createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1800" } }), "FAILED_PRECONDITION", "has ended");
	});

	it("clears the sealed limit when expiry is noticed on reading", async () => {
		const d = await annaLets();
		vi.setSystemTime(new Date("2026-11-17T08:01:00Z"));
		expect((await getDecision(env, anna, d.name)).state).toBe("EXPIRED");
		expect(row().limit_sealed).toBeNull();
	});

	it("deletes a deal 7 days after it was made", async () => {
		const d = await annaLets("1700");
		await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1850" } });
		await runMaintenance(env, Date.parse("2026-11-10T07:00:00Z"));
		expect((db.db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n).toBe(1);
		await runMaintenance(env, Date.parse("2026-11-10T09:00:00Z"));
		expect((db.db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n).toBe(0);
		expect((db.db.prepare("SELECT COUNT(*) AS n FROM answers").get() as { n: number }).n).toBe(0);
	});

	it("can be deleted by the starter while waiting", async () => {
		const d = await annaLets();
		await rejects(deleteDecision(env, ben, d.name), "PERMISSION_DENIED");
		await deleteDecision(env, anna, d.name);
		expect((db.db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n).toBe(0);
	});
});

describe("the PRICE_DECISIONS switch", () => {
	it("off: nobody may start one, and price answers are refused", async () => {
		const d = await annaLets();
		env.PRICE_DECISIONS = "off";
		expect(canStartPrice(env, anna.email)).toBe(false);
		await rejects(createPriceDecision(env, anna, { price: rent, starterAnswer: { minimumToAccept: "1" } }), "FAILED_PRECONDITION", "Price requests aren't available yet.");
		await rejects(createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1800" } }), "FAILED_PRECONDITION", "Price requests aren't available yet.");
		// Unset counts as off.
		delete (env as { PRICE_DECISIONS?: string }).PRICE_DECISIONS;
		expect(canStartPrice(env, anna.email)).toBe(false);
	});

	it("testers: only the allowlist may start one, anyone with the code may answer", async () => {
		env.PRICE_DECISIONS = "testers";
		expect(canStartPrice(env, anna.email)).toBe(true);
		expect(canStartPrice(env, ben.email)).toBe(false);
		const d = await annaLets();
		const result = await createPriceAnswer(env, ben, { code: d.combined, price: { maximumToPay: "1800" } });
		expect(result.decision).toMatchObject({ state: "AGREED" });
	});

	it("open: everyone may start one", () => {
		expect(canStartPrice(env, ben.email)).toBe(true);
	});

	it("leaves the briefing exactly as it was while off, and adds the price rules when on", () => {
		expect(serverInstructions({ answer: false, start: false })).toBe(SERVER_INSTRUCTIONS);
		const on = serverInstructions({ answer: true, start: true });
		expect(on).toContain("agree privately: on a meeting time, or on a price");
		expect(on).toContain("use create_decision with decision.price and starterAnswer.price");
		expect(on).toContain("Never infer or suggest one.");
		expect(on).toContain("Share your person's available times only through Neutra");
		const answerOnly = serverInstructions({ answer: true, start: false });
		expect(answerOnly).not.toContain("decision.price");
		expect(answerOnly).toContain("call get_decision with the code first");
	});
});

describe("next steps for price decisions", () => {
	const view = { price: { subject: "Rent", agreedPriceText: "CHF 1,775 per month" }, expireTime: "2026-11-17T08:00:00.000Z" };
	it("say what to tell the person, in plain words", () => {
		expect(priceNextStep("create_decision", { ...view, state: "WAITING" })).toContain("Show the handoffMessage exactly as written.");
		expect(priceNextStep("get_decision", { ...view, state: "WAITING" })).toBe("Waiting for the other side. Both of you get the result by email.");
		expect(priceNextStep("create_answer", { ...view, state: "AGREED" })).toContain(
			"Tell your person: deal on Rent at CHF 1,775 per month. This is an agreement in principle only, not a contract",
		);
		expect(priceNextStep("create_answer", { ...view, state: "NO_MATCH" })).toContain("neither side learned the other's number");
		expect(priceNextStep("get_decision", { ...view, state: "EXPIRED" })).toBe("Nobody answered by Tue 17 Nov. Your person can start a new request.");
	});
});
