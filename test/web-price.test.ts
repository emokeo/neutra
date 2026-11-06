import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleHandler } from "../src/google-handler";
import { createPriceDecision } from "../src/price";
import { WebAnswer } from "../src/web-answer";
import { readTypedAmount } from "../src/web-price";
import { SESSION_COOKIE, sign } from "../src/web-session";
import { fakeGoogle } from "./fake-calendar";
import { FakeD1 } from "./fake-d1";

// The steps page records a visit after answering, which needs an execution context.
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

const anna = { email: "anna@example.com", name: "Anna Muster" };
const ben = { email: "ben@example.com", name: "Ben" };
const KEY = "test-key";

let env: Env;
let db: FakeD1;
let google: ReturnType<typeof fakeGoogle>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-03T08:00:00Z"));
	google = fakeGoogle();
	vi.stubGlobal("fetch", google.fetch);
	db = new FakeD1();
	env = {
		DB: db,
		GOOGLE_CLIENT_ID: "id",
		GOOGLE_CLIENT_SECRET: "secret",
		INVITER_REFRESH_TOKEN: "refresh",
		MCP_RESOURCE: "https://neutra.example.dev/mcp",
		COOKIE_ENCRYPTION_KEY: KEY,
		ACCESS_MODE: "open",
		PRICE_DECISIONS: "open",
	} as unknown as Env;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** Anna lets the flat for at least the given amount a month. Returns the link token "<id>.<code>". */
async function start(minimum = "1700"): Promise<string> {
	const d = await createPriceDecision(env, anna, {
		price: { subject: "Rent for the flat", details: "utilities included", currency: "CHF", unit: "per month" },
		starterAnswer: { minimumToAccept: minimum },
	});
	if (d.validateOnly) throw new Error("expected a decision");
	return `${d.name.split("/")[1]}.${d.code}`;
}

async function as(person: { email: string; name: string }): Promise<string> {
	return `${SESSION_COOKIE}=${await sign(KEY, "web-session", { e: person.email, n: person.name }, 3600)}`;
}

function get(path: string, cookie?: string) {
	return WebAnswer.request(path, { headers: cookie ? { cookie } : {} }, env);
}

function post(path: string, cookie: string, fields: [string, string][]) {
	return WebAnswer.request(
		path,
		{
			method: "POST",
			headers: { cookie, origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
		},
		env,
	);
}

const state = () => (db.db.prepare("SELECT state FROM decisions").get() as { state: string }).state;

describe("typed amounts", () => {
	it("accepts what people type", () => {
		for (const typed of ["1700", "1'700", "1’700", "1 700", "1,700", "1700.-", "CHF 1700", "1700 chf", "chf1'700.00"]) {
			expect(readTypedAmount(typed, "CHF")).toEqual({ minor: 170000 });
		}
		expect(readTypedAmount("1,700.50", "CHF")).toEqual({ minor: 170050 });
		expect(readTypedAmount("150 000", "JPY")).toEqual({ minor: 150000 });
	});

	it("asks for a dot when a comma marks the decimals", () => {
		expect(readTypedAmount("1,70", "CHF")).toEqual({ error: "Use a dot for decimals, e.g. 1700.50, and enter the amount again." });
		expect(readTypedAmount("1700,50", "CHF")).toMatchObject({ error: expect.stringContaining("Use a dot") });
	});

	it("says what to change for anything else", () => {
		expect(readTypedAmount("", "CHF")).toEqual({ error: "Enter an amount." });
		expect(readTypedAmount("EUR 1700", "CHF")).toEqual({ error: "This request is in CHF. Enter just the number." });
		expect(readTypedAmount("€1700", "CHF")).toMatchObject({ error: expect.stringContaining("This request is in CHF") });
		expect(readTypedAmount("about 1700", "CHF")).toEqual({ error: "Enter the amount in digits, e.g. 1700 or 1700.50." });
		expect(readTypedAmount("0", "CHF")).toEqual({ error: "Enter an amount above 0." });
		expect(readTypedAmount("1700.505", "CHF")).toEqual({ error: "Enter at most 2 decimals." });
		expect(readTypedAmount("1500.5", "JPY")).toEqual({ error: "JPY amounts have no decimals. Enter a whole number." });
	});
});

describe("web answer page for a price", () => {
	it("introduces the request before sign-in", async () => {
		const token = await start();
		const html = await (await get(`/a/${token}`)).text();
		expect(html).toContain("<h1>Anna would like to agree on a price with you</h1>");
		expect(html).toContain("Rent for the flat (utilities included) · answer by Tue 17 Nov");
		expect(html).toContain("Give the most you'd pay for Rent for the flat.");
		expect(html).toContain("to email you the result");
		expect(html).not.toContain("1700");
	});

	it("shows one amount field with the currency before it and the unit after it", async () => {
		const token = await start();
		const html = await (await get(`/a/${token}`, await as(ben))).text();
		expect(html).toContain(`<label class="big" for="amount">The most you'd pay</label>`);
		expect(html).toContain('<span>CHF</span><input id="amount" name="amount" inputmode="decimal"');
		expect(html).toContain("<span>per month</span>");
		expect(html).toContain('<input type="hidden" name="step" value="confirm">');
		expect(html).toContain("The result goes to this address.");
		expect(html).not.toContain('name="day"');
	});

	it("shows the amount once more before sending, and sends nothing yet", async () => {
		const token = await start();
		const res = await post(`/a/${token}`, await as(ben), [
			["amount", "1'850"],
			["step", "confirm"],
		]);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("The most you&#39;d pay: CHF 1,850 per month. You can&#39;t change it after sending.");
		expect(html).toContain('<input type="hidden" name="amount" value="1850.00">');
		expect(html).toContain('name="step" value="send">Send</button>');
		expect(html).toContain('name="step" value="change">Change</button>');
		expect(state()).toBe("WAITING");
		expect(google.emails).toHaveLength(0);
	});

	it("goes back to the form, with the amount, to change it", async () => {
		const token = await start();
		const res = await post(`/a/${token}`, await as(ben), [
			["amount", "1850.00"],
			["step", "change"],
		]);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('value="1850.00"');
		expect(state()).toBe("WAITING");
	});

	it("keeps what was typed and says what to fix", async () => {
		const token = await start();
		const res = await post(`/a/${token}`, await as(ben), [
			["amount", "1,70"],
			["step", "confirm"],
		]);
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain("Use a dot for decimals");
		expect(html).toContain('value="1,70"');
	});

	it("sends on Send and shows the deal", async () => {
		const token = await start("1700");
		const cookie = await as(ben);
		const res = await post(`/a/${token}`, cookie, [
			["amount", "1850.00"],
			["step", "send"],
		]);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(`http://localhost/a/${token}`);
		expect(state()).toBe("AGREED");
		const html = await (await get(`/a/${token}`, cookie)).text();
		expect(html).toContain("You have a deal");
		expect(html).toContain(
			"Deal: CHF 1,775 per month for Rent for the flat.</strong></p><p>That's halfway between your two numbers. This isn't a contract: settle the details with Anna directly; you both got an email.",
		);
		expect(google.emails).toHaveLength(1);

		// Sending again (a reload or a second click) changes nothing.
		await post(`/a/${token}`, cookie, [
			["amount", "9999"],
			["step", "send"],
		]);
		expect((db.db.prepare("SELECT agreed_minor FROM decisions").get() as { agreed_minor: number }).agreed_minor).toBe(177500);
	});

	it("says 'no deal' without either number", async () => {
		const token = await start("1900");
		const cookie = await as(ben);
		await post(`/a/${token}`, cookie, [
			["amount", "1800"],
			["step", "send"],
		]);
		const html = await (await get(`/a/${token}`, cookie)).text();
		expect(html).toContain("No deal: your numbers didn't overlap. Neither of you learns the other's number.");
		expect(html).not.toContain("1,900");
		expect(html).not.toContain("1900");
	});

	it("tells the starter it's their own request", async () => {
		const token = await start();
		expect(await (await get(`/a/${token}`, await as(anna))).text()).toContain("Send the link to the other person: they answer it, not you.");
	});

	it("says so when price requests are switched off", async () => {
		const token = await start();
		env.PRICE_DECISIONS = "off";
		const res = await post(`/a/${token}`, await as(ben), [
			["amount", "1800"],
			["step", "send"],
		]);
		expect(res.status).toBe(503);
		expect(await res.text()).toContain("Price requests aren&#39;t available right now");
		expect(state()).toBe("WAITING");
	});

	it("has a steps page that speaks of a price", async () => {
		const token = await start();
		const [id] = token.split(".");
		const html = await (await GoogleHandler.request(`/r/${id}`, {}, env, ctx)).text();
		expect(html).toContain("Anna would like to agree on a price with you");
		expect(html).toContain("enter your number");
		expect(html).not.toContain("add the times you're free");
	});
});
