import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApiError,
	createAnswer,
	createDecision,
	deleteDecision,
	findMatch,
	getAnswer,
	getDecision,
} from "../src/decisions";
import { FakeD1 } from "./fake-d1";
import { fakeGoogle } from "./fake-calendar";

const anna = { email: "anna@example.com", name: "Anna" };
const ben = { email: "ben@example.com", name: "Ben" };
const eve = { email: "eve@example.com", name: "Eve" };

const NOW = "2026-11-03T08:00:00Z";
const window = (start: string, end: string) => ({ startTime: start, endTime: end });
// Anna: Wednesday 17:00–20:00 UTC; Ben: Wednesday 18:10–21:00 UTC.
const annaFree = [window("2026-11-04T17:00:00Z", "2026-11-04T20:00:00Z")];
const benFree = [window("2026-11-04T18:10:00Z", "2026-11-04T21:00:00Z")];
const benBusyThen = [window("2026-11-06T09:00:00Z", "2026-11-06T12:00:00Z")];

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
	} as unknown as Env;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function rejects(promise: Promise<unknown>, code: ApiError["code"]) {
	await expect(promise).rejects.toMatchObject({ code });
}

async function start() {
	return createDecision(env, anna, { durationSeconds: "3600s", starterWindows: annaFree });
}

describe("findMatch", () => {
	const at = (iso: string) => Date.parse(iso);
	const now = at(NOW);

	it("picks the earliest common slot, starting on a quarter hour", () => {
		const match = findMatch(
			[{ start: at("2026-11-04T17:00:00Z"), end: at("2026-11-04T20:00:00Z") }],
			[{ start: at("2026-11-04T18:10:00Z"), end: at("2026-11-04T21:00:00Z") }],
			3600_000,
			now,
		);
		expect(match).toEqual({ start: at("2026-11-04T18:15:00Z"), end: at("2026-11-04T19:15:00Z") });
	});

	it("returns null when the overlap is shorter than the meeting", () => {
		const match = findMatch(
			[{ start: at("2026-11-04T17:00:00Z"), end: at("2026-11-04T18:30:00Z") }],
			[{ start: at("2026-11-04T18:00:00Z"), end: at("2026-11-04T21:00:00Z") }],
			3600_000,
			now,
		);
		expect(match).toBeNull();
	});

	it("never starts less than an hour from now", () => {
		const match = findMatch(
			[{ start: now, end: now + 4 * 3600_000 }],
			[{ start: now, end: now + 4 * 3600_000 }],
			1800_000,
			now,
		);
		expect(match?.start).toBe(now + 3600_000);
	});
});

describe("create_decision", () => {
	it("returns a waiting decision with a code and a hand-off message", async () => {
		const decision = await start();
		expect(decision.name).toMatch(/^decisions\/[a-z][a-z2-7]{25}$/);
		expect(decision.state).toBe("WAITING");
		expect(decision.code).toMatch(/^[a-z][a-z2-7]{11}$/);
		expect(decision.handoffMessage).toContain(decision.code);
		expect(decision.handoffMessage).toContain(decision.name);
	});

	it("rejects windows in the past or too far ahead, and bad durations", async () => {
		await rejects(
			createDecision(env, anna, { durationSeconds: "3600s", starterWindows: [window("2026-11-01T10:00:00Z", "2026-11-01T12:00:00Z")] }),
			"INVALID_ARGUMENT",
		);
		await rejects(
			createDecision(env, anna, { durationSeconds: "3600s", starterWindows: [window("2026-12-20T10:00:00Z", "2026-12-20T12:00:00Z")] }),
			"INVALID_ARGUMENT",
		);
		await rejects(createDecision(env, anna, { durationSeconds: "0s", starterWindows: annaFree }), "INVALID_ARGUMENT");
		await rejects(
			createDecision(env, anna, { durationSeconds: "3600s", starterWindows: [window("2026-11-04T18:00:00Z", "2026-11-04T19:00:00Z")] }),
			"INVALID_ARGUMENT",
		);
	});
});

describe("create_answer", () => {
	it("matches, sends one invite to both, and keeps nobody's times", async () => {
		const decision = await start();
		const { decision: after, answer } = await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });

		expect(after.state).toBe("INVITE_SENT");
		expect(after.meeting.scheduledTime).toEqual({ startTime: "2026-11-04T18:15:00.000Z", endTime: "2026-11-04T19:15:00.000Z" });
		expect(after).not.toHaveProperty("code");

		const [event] = [...google.events.values()];
		expect(google.events.size).toBe(1);
		expect(event.summary).toBe("Anna & Ben");
		expect(event.attendees.map((a) => a.email)).toEqual([anna.email, ben.email]);

		const own = await getAnswer(env, ben, answer.name);
		expect(own.meeting.availableWindows).toEqual([]);
	});

	it("after no match, the same person may retry twice; then it ends as NO_MATCH", async () => {
		const decision = await start();
		const answer = () => createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benBusyThen });

		const first = await answer();
		expect(first.decision.state).toBe("WAITING");
		expect(first.decision.remainingAttempts).toBe(2);
		expect((await answer()).decision.remainingAttempts).toBe(1);
		expect((await answer()).decision.state).toBe("NO_MATCH");
		await rejects(answer(), "FAILED_PRECONDITION");
		expect(google.events.size).toBe(0);
	});

	it("a retry can still match", async () => {
		const decision = await start();
		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benBusyThen });
		const { decision: after } = await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });
		expect(after.state).toBe("INVITE_SENT");
		expect(google.events.size).toBe(1);
	});

	it("binds the code to the first person who answers", async () => {
		const decision = await start();
		await rejects(createAnswer(env, ben, { parent: decision.name, code: "wrongcode234", windows: benFree }), "PERMISSION_DENIED");
		await rejects(createAnswer(env, anna, { parent: decision.name, code: decision.code!, windows: benFree }), "PERMISSION_DENIED");

		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benBusyThen });
		await rejects(createAnswer(env, eve, { parent: decision.name, code: decision.code!, windows: benFree }), "PERMISSION_DENIED");
	});

	it("refuses answers narrower than twice the meeting, without using a try", async () => {
		const decision = await start();
		const narrow = [window("2026-11-04T18:15:00Z", "2026-11-04T19:15:00Z")];
		await rejects(createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: narrow }), "INVALID_ARGUMENT");
		const first = await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benBusyThen });
		expect(first.decision.remainingAttempts).toBe(2);
	});

	it("keeps no times of the responder, even while retries remain", async () => {
		const decision = await start();
		const { answer } = await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benBusyThen });
		expect((await getAnswer(env, ben, answer.name)).meeting.availableWindows).toEqual([]);
	});

	it("does not use up the code when the answer is invalid", async () => {
		const decision = await start();
		await rejects(
			createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: [window("2026-11-04T20:00:00Z", "2026-11-04T19:00:00Z")] }),
			"INVALID_ARGUMENT",
		);
		const { decision: after } = await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });
		expect(after.state).toBe("INVITE_SENT");
	});
});

describe("get_decision", () => {
	it("is readable by participants only", async () => {
		const decision = await start();
		await rejects(getDecision(env, eve, decision.name), "PERMISSION_DENIED");
		await rejects(getDecision(env, anna, "decisions/aaaaaaaaaaaaaaaaaaaaaaaaaa"), "NOT_FOUND");
		expect((await getDecision(env, anna, decision.name)).state).toBe("WAITING");
	});

	it("follows the invite replies: both yes is ACCEPTED, any no is DECLINED", async () => {
		const decision = await start();
		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });
		const [eventId] = [...google.events.keys()];

		google.reply(eventId, anna.email, "accepted");
		expect((await getDecision(env, anna, decision.name)).state).toBe("INVITE_SENT");
		google.reply(eventId, ben.email, "accepted");
		expect((await getDecision(env, ben, decision.name)).state).toBe("ACCEPTED");
		google.reply(eventId, ben.email, "declined");
		expect((await getDecision(env, anna, decision.name)).state).toBe("DECLINED");
	});

	it("shows EXPIRED once the offered times have run out", async () => {
		const decision = await start();
		vi.setSystemTime(new Date("2026-11-04T19:30:00Z"));
		expect((await getDecision(env, anna, decision.name)).state).toBe("EXPIRED");
		await rejects(createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree }), "FAILED_PRECONDITION");
	});

	it("never shows anyone's times or the code after creation", async () => {
		const decision = await start();
		const read = await getDecision(env, anna, decision.name);
		expect(JSON.stringify(read)).not.toContain("availableWindows");
		expect(read).not.toHaveProperty("code");
	});
});

describe("delete_decision", () => {
	it("lets only the starter delete, and cancels the invite", async () => {
		const decision = await start();
		await createAnswer(env, ben, { parent: decision.name, code: decision.code!, windows: benFree });
		await rejects(deleteDecision(env, ben, decision.name), "PERMISSION_DENIED");

		await deleteDecision(env, anna, decision.name);
		expect(google.events.size).toBe(0);
		await rejects(getDecision(env, anna, decision.name), "NOT_FOUND");
	});
});
