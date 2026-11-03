import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnswer, createDecision } from "../src/decisions";
import { LIMITS } from "../src/limits";
import { FakeD1 } from "./fake-d1";
import { fakeGoogle } from "./fake-calendar";

const anna = { email: "anna@example.com", name: "Anna" };
const ben = { email: "ben@example.com", name: "Ben" };
const window = (start: string, end: string) => ({ startTime: start, endTime: end });
const annaFree = [window("2026-11-04T17:00:00Z", "2026-11-04T20:00:00Z")];
const benBusyThen = [window("2026-11-06T09:00:00Z", "2026-11-06T12:00:00Z")];

let env: Env;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-03T08:00:00Z"));
	vi.stubGlobal("fetch", fakeGoogle().fetch);
	env = {
		DB: new FakeD1(),
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

const start = (who = anna) => createDecision(env, who, { durationSeconds: "3600s", starterWindows: annaFree });

describe("rate limits", () => {
	it(`allows ${LIMITS.decisionsPerDay} new decisions per person per day, then refuses`, async () => {
		for (let i = 0; i < LIMITS.decisionsPerDay; i++) await start();
		await expect(start()).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
		await expect(start(ben)).resolves.toBeTruthy();
		vi.setSystemTime(new Date("2026-11-04T08:30:00Z"));
		await expect(
			createDecision(env, anna, { durationSeconds: "3600s", starterWindows: [window("2026-11-05T17:00:00Z", "2026-11-05T20:00:00Z")] }),
		).resolves.toBeTruthy();
	});

	it(`lets one person answer at most ${LIMITS.answeredFromSameStarterPerDay} decisions from the same starter per day`, async () => {
		for (let i = 0; i < LIMITS.answeredFromSameStarterPerDay; i++) {
			const d = await start();
			await createAnswer(env, ben, { parent: d.name, code: d.code!, windows: benBusyThen });
		}
		const extra = await start();
		await expect(createAnswer(env, ben, { parent: extra.name, code: extra.code!, windows: benBusyThen })).rejects.toMatchObject({
			code: "RESOURCE_EXHAUSTED",
		});
	});

	it("still allows retries on the same decision", async () => {
		const d = await start();
		for (let i = 0; i < 3; i++) {
			await createAnswer(env, ben, { parent: d.name, code: d.code!, windows: benBusyThen });
		}
	});
});
