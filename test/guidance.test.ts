import { describe, expect, it } from "vitest";
import { nextStep, SERVER_INSTRUCTIONS } from "../src/guidance";

const meeting = { scheduledTime: { startTime: "2026-11-04T18:15:00.000Z", endTime: "2026-11-04T19:15:00.000Z" } };

describe("nextStep", () => {
	it("tells the starter to pass the hand-off message on unchanged", () => {
		expect(nextStep("create_decision", { state: "WAITING", meeting: {} })).toMatch(/exactly as written/);
	});

	it("tells the responder how many tries are left", () => {
		expect(nextStep("create_answer", { state: "WAITING", remainingAttempts: 2, meeting: {} })).toMatch(/2 tries left/);
		expect(nextStep("create_answer", { state: "WAITING", remainingAttempts: 1, meeting: {} })).toMatch(/1 try left/);
	});

	it("names the meeting time once an invite is sent", () => {
		expect(nextStep("create_answer", { state: "INVITE_SENT", meeting })).toContain("2026-11-04T18:15:00.000Z");
	});

	it("has a step for every final state", () => {
		for (const state of ["ACCEPTED", "DECLINED", "NO_MATCH", "EXPIRED"]) {
			expect(nextStep("get_decision", { state, meeting })).not.toMatch(/check the state/);
		}
	});
});

describe("server instructions", () => {
	it("promise no AI on Neutra's side and forbid sharing times outside Neutra", () => {
		expect(SERVER_INSTRUCTIONS).toMatch(/no AI model on Neutra's side/);
		expect(SERVER_INSTRUCTIONS).toMatch(/only through Neutra/);
	});
});
