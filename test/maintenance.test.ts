import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnswer, createDecision, getDecision } from "../src/decisions";
import { runMaintenance } from "../src/maintenance";
import { FakeD1 } from "./fake-d1";
import { fakeGoogle } from "./fake-calendar";

const anna = { email: "anna@example.com", name: "Anna Muster", client: "Claude" };
const ben = { email: "ben@example.com", name: "Ben Beispiel", client: "Muse" };
const window = (start: string, end: string) => ({ startTime: start, endTime: end });
const annaFree = [window("2026-11-04T17:00:00Z", "2026-11-04T20:00:00Z")];
const benFree = [window("2026-11-04T18:10:00Z", "2026-11-04T21:00:00Z")];
const benBusyThen = [window("2026-11-06T09:00:00Z", "2026-11-06T12:00:00Z")];

let db: FakeD1;
let env: Env;
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
		COOKIE_ENCRYPTION_KEY: "test-key",
	} as unknown as Env;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const start = () => createDecision(env, anna, { durationSeconds: "3600s", starterWindows: annaFree });
const at = (iso: string) => {
	vi.setSystemTime(new Date(iso));
	return Date.parse(iso);
};
const count = (table: string) => (db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("expiry and the failure emails", () => {
	it("expires an unanswered decision and emails the starter once", async () => {
		const decision = await start();
		const now = at("2026-11-04T19:30:00Z");

		expect(await runMaintenance(env, now)).toMatchObject({ expired: 1, notified: 1 });
		expect((await getDecision(env, anna, decision.name)).state).toBe("EXPIRED");
		expect(google.emails).toHaveLength(1);
		expect(google.emails[0].raw).toContain("To: anna@example.com");
		expect(google.emails[0].raw).toContain("Nobody answered your Neutra request");

		expect(await runMaintenance(env, now + 15 * 60_000)).toMatchObject({ expired: 0, notified: 0 });
		expect(google.emails).toHaveLength(1);
	});

	it("emails 'no common time' after the last try, naming the other person", async () => {
		const decision = await start();
		for (let i = 0; i < 3; i++) {
			await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benBusyThen });
		}
		await runMaintenance(env, Date.now());
		expect(google.emails).toHaveLength(1);
		expect(google.emails[0].raw).toContain("Ben Beispiel's assistant answered");
		expect(google.emails[0].raw).toContain("Neither of you saw the other's times");
	});

	it("sends no email when a meeting was found", async () => {
		const decision = await start();
		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });
		await runMaintenance(env, at("2026-11-05T08:00:00Z"));
		expect(google.emails).toHaveLength(0);
	});
});

describe("retention", () => {
	it("deletes a decision 7 days after its meeting ends, not before", async () => {
		const decision = await start();
		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });
		// The meeting ends 4 Nov 19:15 UTC.
		await runMaintenance(env, at("2026-11-11T19:00:00Z"));
		expect(count("decisions")).toBe(1);
		await runMaintenance(env, at("2026-11-11T19:30:00Z"));
		expect(count("decisions")).toBe(0);
		expect(count("answers")).toBe(0);
	});

	it("also removes the past meeting from Neutra's calendar, quietly", async () => {
		const decision = await start();
		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });
		expect(google.events.size).toBe(1);
		await runMaintenance(env, at("2026-11-12T08:00:00Z"));
		expect(google.events.size).toBe(0);
		const deletion = google.fetch.mock.calls.find(([, init]) => init?.method === "DELETE");
		expect(String(deletion?.[0])).toContain("sendUpdates=none");
	});

	it("puts an answer that crashed mid-way back to WAITING", async () => {
		const decision = await start();
		db.db.prepare("UPDATE decisions SET state = 'MATCHING', attempts = 1, update_time = ?").run("2026-11-03T08:00:00.000Z");
		await runMaintenance(env, at("2026-11-03T08:10:00Z"));
		expect((await getDecision(env, anna, decision.name)).state).toBe("WAITING");
		const { decision: after } = await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });
		expect(after.state).toBe("INVITE_SENT");
	});

	it("deletes an expired decision 7 days after it ended", async () => {
		await start();
		await runMaintenance(env, at("2026-11-04T19:30:00Z"));
		await runMaintenance(env, at("2026-11-11T19:00:00Z"));
		expect(count("decisions")).toBe(1);
		await runMaintenance(env, at("2026-11-11T19:45:00Z"));
		expect(count("decisions")).toBe(0);
	});

	it("keeps the anonymous events after deletion", async () => {
		const decision = await start();
		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });
		await runMaintenance(env, at("2026-11-12T08:00:00Z"));
		expect(count("decisions")).toBe(0);
		expect(count("events")).toBeGreaterThanOrEqual(2);
	});
});

describe("anonymous events", () => {
	it("count steps per assistant without names, emails or times", async () => {
		const decision = await start();
		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benBusyThen });
		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });

		const rows = db.db.prepare("SELECT type, client, person, detail_json, decision_ref FROM events ORDER BY id").all() as {
			type: string;
			client: string;
			person: string;
			detail_json: string;
			decision_ref: string;
		}[];
		expect(rows.map((r) => `${r.type}:${r.client}`)).toEqual([
			"decision_created:Claude",
			"answer_submitted:Muse",
			"answer_submitted:Muse",
		]);
		expect(JSON.parse(rows[2].detail_json)).toMatchObject({ attempt: 2, outcome: "match" });
		expect(new Set(rows.map((r) => r.decision_ref)).size).toBe(1);
		expect(rows[1].person).toBe(rows[2].person);
		expect(rows[0].person).not.toBe(rows[1].person);

		const everything = JSON.stringify(rows);
		for (const secret of ["anna@example.com", "ben@example.com", "Anna", "Ben", "2026-11-04", decision.code!, decision.name]) {
			expect(everything).not.toContain(secret);
		}
	});
});
