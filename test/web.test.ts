import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecision } from "../src/decisions";
import { WebAnswer, webCallback } from "../src/web-answer";
import { durationText, rowsToWindows } from "../src/web-form";
import { LOGIN_COOKIE, SESSION_COOKIE, sign, verify } from "../src/web-session";
import { fakeGoogle } from "./fake-calendar";
import { FakeD1 } from "./fake-d1";

const anna = { email: "anna@example.com", name: "Anna Muster" };
const ben = { email: "ben@example.com", name: "Ben" };
const eve = { email: "eve@example.com", name: "Eve" };
const NOW = "2026-11-03T08:00:00Z";
const KEY = "test-key";

let env: Env;
let google: ReturnType<typeof fakeGoogle>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	google = fakeGoogle();
	vi.stubGlobal("fetch", google.fetch);
	env = {
		DB: new FakeD1(),
		GOOGLE_CLIENT_ID: "id",
		GOOGLE_CLIENT_SECRET: "secret",
		INVITER_REFRESH_TOKEN: "refresh",
		MCP_RESOURCE: "https://neutra.example.dev/mcp",
		COOKIE_ENCRYPTION_KEY: KEY,
		ACCESS_MODE: "open",
	} as unknown as Env;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** Anna asks for an hour; she's free Wednesday 17:00–20:00 UTC. Returns the link token "<id>.<code>". */
async function start(): Promise<string> {
	const d = await createDecision(env, anna, {
		durationSeconds: "3600s",
		starterWindows: [{ startTime: "2026-11-04T17:00:00Z", endTime: "2026-11-04T20:00:00Z" }],
	});
	return `${d.name.split("/")[1]}.${d.code}`;
}

async function as(person: { email: string; name: string }): Promise<string> {
	return `${SESSION_COOKIE}=${await sign(KEY, "web-session", { e: person.email, n: person.name }, 3600)}`;
}

function get(path: string, cookie?: string) {
	return WebAnswer.request(path, { headers: cookie ? { cookie } : {} }, env);
}

function post(path: string, cookie: string, fields: [string, string][], origin = "http://localhost") {
	return WebAnswer.request(
		path,
		{
			method: "POST",
			headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
		},
		env,
	);
}

const row = (day: string, from: string, to: string): [string, string][] => [
	["day", day],
	["from", from],
	["to", to],
];

describe("form rows", () => {
	it("turns filled rows into local windows and skips empty ones", () => {
		expect(
			rowsToWindows([
				{ day: "2026-11-04", from: "18:00", to: "21:00" },
				{ day: "", from: "", to: "" },
				{ day: "2026-11-05", from: "22:00", to: "00:00" },
			]),
		).toEqual({
			windows: [
				{ startTime: "2026-11-04T18:00", endTime: "2026-11-04T21:00" },
				// "to 00:00" means until midnight.
				{ startTime: "2026-11-05T22:00", endTime: "2026-11-06T00:00" },
			],
		});
	});

	it("says what to fix", () => {
		expect(rowsToWindows([{ day: "", from: "", to: "" }])).toEqual({ error: "Add at least one time when you're free." });
		expect(rowsToWindows([{ day: "2026-11-04", from: "18:00", to: "" }])).toEqual({ error: "Fill in the day, from and to for time 1." });
		expect(rowsToWindows([{ day: "2026-11-04", from: "18:00", to: "17:00" }])).toMatchObject({ error: expect.stringContaining("ends before it starts") });
		expect(rowsToWindows([{ day: "4.11.2026", from: "18:00", to: "19:00" }])).toMatchObject({ error: expect.stringContaining("can't read") });
	});

	it("words durations", () => {
		expect(durationText(3600)).toBe("1 hour");
		expect(durationText(1800)).toBe("30 minutes");
		expect(durationText(5400)).toBe("1 hour 30 minutes");
		expect(durationText(7200)).toBe("2 hours");
	});
});

describe("signed cookies", () => {
	it("accept their own value and refuse changed, expired or other-purpose ones", async () => {
		const value = await sign(KEY, "web-session", { e: "ben@example.com" }, 60);
		expect(await verify(KEY, "web-session", value)).toMatchObject({ e: "ben@example.com" });
		expect(await verify(KEY, "web-login", value)).toBeNull();
		expect(await verify("other-key", "web-session", value)).toBeNull();
		const [data, signature] = value.split(".");
		const forged = btoa(JSON.stringify({ e: "eve@example.com", x: 9999999999 })).replace(/=+$/, "");
		expect(await verify(KEY, "web-session", `${forged}.${signature}`)).toBeNull();
		expect(await verify(KEY, "web-session", `${data}.x${signature.slice(1)}`)).toBeNull();
		vi.setSystemTime(new Date(Date.parse(NOW) + 61_000));
		expect(await verify(KEY, "web-session", value)).toBeNull();
	});
});

describe("web answer page", () => {
	it("shows the request and a sign-in button, without caching or a referrer to other sites", async () => {
		const token = await start();
		const res = await get(`/a/${token}`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Anna would like to meet you");
		expect(html).toContain("1 hour · answer by Tue 17 Nov");
		expect(html).toContain(`href="/a/${token}/signin"`);
		expect(res.headers.get("referrer-policy")).toBe("same-origin");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("doesn't work with a wrong code or a broken link", async () => {
		const token = await start();
		const [id] = token.split(".");
		expect((await get(`/a/${id}.aaaaaaaaaaaa`)).status).toBe(404);
		expect((await get(`/a/${id}`)).status).toBe(404);
	});

	it("sends people to Google sign-in with a state the callback checks", async () => {
		const token = await start();
		const res = await get(`/a/${token}/signin`);
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location")!);
		expect(location.origin).toBe("https://accounts.google.com");
		expect(location.searchParams.get("state")).toMatch(/^web\./);
		expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/callback");
		expect(location.searchParams.get("prompt")).toBe("select_account");
		expect(res.headers.get("set-cookie")).toContain(`${LOGIN_COOKIE}=`);
	});

	it("shows the form once signed in, and sends an invite when a time fits", async () => {
		const token = await start();
		const cookie = await as(ben);
		const form = await (await get(`/a/${token}`, cookie)).text();
		expect(form).toContain('name="day"');
		expect(form).toContain("Signed in as ben@example.com");

		const res = await post(`/a/${token}`, cookie, [...row("2026-11-04", "18:00", "21:00"), ["tz", "UTC"]]);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(`http://localhost/a/${token}`);
		expect(google.events.size).toBe(1);

		const result = await (await get(`/a/${token}`, cookie)).text();
		expect(result).toContain("A time fits");
		expect(result).toContain("Wed 4 Nov, 18:00–19:00 (UTC)");
	});

	it("says when no time fits yet, with the tries left", async () => {
		const token = await start();
		const cookie = await as(ben);
		const res = await post(`/a/${token}`, cookie, [...row("2026-11-06", "09:00", "12:00"), ["tz", "UTC"]]);
		expect(res.status).toBe(303);
		const html = await (await get(`/a/${token}`, cookie)).text();
		expect(html).toContain("No time fits yet");
		expect(html).toContain("2 tries left");
		expect(google.events.size).toBe(0);
	});

	it("asks for more times when the answer is too narrow, keeping what was entered", async () => {
		const token = await start();
		const res = await post(`/a/${token}`, await as(ben), [...row("2026-11-04", "18:00", "19:00"), ["tz", "UTC"]]);
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain("Add more times: together at least 2 hours");
		expect(html).toContain('value="2026-11-04"');
	});

	it("points at the row to fix", async () => {
		const token = await start();
		const res = await post(`/a/${token}`, await as(ben), [...row("2026-11-04", "18:00", ""), ["tz", "UTC"]]);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Fill in the day, from and to for time 1.");
	});

	it("refuses answers sent from another site", async () => {
		const token = await start();
		const cookie = await as(ben);
		const res = await post(`/a/${token}`, cookie, [...row("2026-11-04", "18:00", "21:00"), ["tz", "UTC"]], "https://evil.example");
		expect(res.status).toBe(403);
		// What browsers send for a form on a page with "no-referrer", or from a sandboxed frame.
		expect((await post(`/a/${token}`, cookie, [...row("2026-11-04", "18:00", "21:00"), ["tz", "UTC"]], "null")).status).toBe(403);
		expect(google.events.size).toBe(0);
		expect(await (await get(`/a/${token}`, cookie)).text()).not.toContain("No time fits yet");
	});

	it("needs a sign-in to answer", async () => {
		const token = await start();
		const res = await WebAnswer.request(
			`/a/${token}`,
			{ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "day=2026-11-04&from=18:00&to=21:00" },
			env,
		);
		expect(res.status).toBe(303);
		expect(google.events.size).toBe(0);
	});

	it("tells the starter it's their own request, and others that someone else answered", async () => {
		const token = await start();
		expect(await (await get(`/a/${token}`, await as(anna))).text()).toContain("This is your own request");
		await post(`/a/${token}`, await as(ben), [...row("2026-11-06", "09:00", "12:00"), ["tz", "UTC"]]);
		expect(await (await get(`/a/${token}`, await as(eve))).text()).toContain("Someone else already answered");
	});
});

describe("web sign-in callback", () => {
	async function callback(state: string, login?: string) {
		return webCallback(
			new Request(`http://localhost/callback?state=${state}&code=abc`, { headers: login ? { cookie: `${LOGIN_COOKIE}=${login}` } : {} }),
			env,
		);
	}

	it("refuses a state this browser didn't start", async () => {
		const token = await start();
		expect((await callback("web.123")).status).toBe(400);
		const login = await sign(KEY, "web-login", { s: "web.123", t: token }, 600);
		expect((await callback("web.456", login)).status).toBe(400);
	});

	it("signs the person in and goes back to the request", async () => {
		const token = await start();
		const calendar = google.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.startsWith("https://accounts.google.com/o/oauth2/token")) return Response.json({ access_token: "user-token" });
				if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) {
					return Response.json({ id: "1", name: "Ben", email: "ben@example.com", verified_email: true });
				}
				return calendar(input, init);
			}),
		);
		const login = await sign(KEY, "web-login", { s: "web.123", t: token }, 600);
		const res = await callback("web.123", login);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(`http://localhost/a/${token}`);
		const session = /__Host-neutra-web=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
		expect(await verify(KEY, "web-session", session)).toMatchObject({ e: "ben@example.com", n: "Ben" });
	});
});
