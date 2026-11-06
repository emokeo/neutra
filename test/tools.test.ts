import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ToolDefinition, toolList } from "../src/tools";

// The tools exactly as they were before price decisions (src/index.ts at the start of PR #41), copied here so
// that switching PRICE_DECISIONS off provably changes nothing for any assistant.
const Timestamp = z
	.string()
	.describe('Local time like "2026-11-04T18:00" (read in timeZone), or RFC 3339 with an offset like "2026-11-04T18:00:00+01:00"');
const Interval = z.object({ startTime: Timestamp, endTime: Timestamp });
const TimeZone = z
	.string()
	.optional()
	.describe('Your person\'s IANA time zone, e.g. "Europe/Zurich". Required for local times; also used to show times back to them.');
const AvailableWindows = z
	.array(Interval)
	.min(1)
	.max(50)
	.describe("Times this person can make it, together at least twice the meeting duration. Never shown to anyone else.");
const DecisionName = z.string().describe('The decision\'s name, e.g. "decisions/abc..."');

const BEFORE: [string, ToolDefinition][] = [
	[
		"create_decision",
		{
			title: "Start finding a meeting time",
			description:
				"Find a meeting time with someone whose calendar you can't see, without sharing your person's. Send their free times and the meeting length; returns a message for them to forward.",
			inputSchema: z.object({
				decision: z.object({
					meeting: z.object({ duration: z.string().describe('Seconds, e.g. "3600s"') }),
				}),
				starterAnswer: z.object({ meeting: z.object({ availableWindows: AvailableWindows, timeZone: TimeZone }) }),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
	],
	[
		"create_answer",
		{
			title: "Answer a meeting-time request",
			description:
				"Use when your person pastes a Neutra message or a \"neutra:\" code. Takes that code and your person's free times. Neutra compares them privately. If a time fits both, it sends one calendar invite; otherwise, nobody learns anything about the other's times.",
			inputSchema: z.object({
				parent: DecisionName.optional().describe("Not needed when code is the combined form"),
				code: z.string().describe('The code from the forwarded message, usually the combined form "neutra:<id>.<code>"'),
				answer: z.object({ meeting: z.object({ availableWindows: AvailableWindows, timeZone: TimeZone }) }),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
	],
	[
		"get_decision",
		{
			title: "Check a meeting-time decision",
			description: "Check a decision's status and meeting time.",
			inputSchema: z.object({ name: DecisionName }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
	],
	[
		"delete_decision",
		{
			title: "Delete a meeting-time decision",
			description: "Cancel a decision you started, including its invite.",
			inputSchema: z.object({ name: DecisionName }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
	],
	[
		"get_answer",
		{
			title: "Read your own answer",
			description: "Read your own answer.",
			inputSchema: z.object({ name: z.string().describe('e.g. "decisions/abc.../answers/xyz..."') }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
	],
	[
		"create_feature_request",
		{
			title: "Suggest a feature",
			description: "Tell Neutra's makers about something your person wanted that Neutra can't do yet.",
			inputSchema: z.object({
				featureRequest: z.object({
					summary: z
						.string()
						.describe(
							"The feature in general terms, under 500 characters. Don't include names, email addresses, dates, places or anything about your person.",
						),
				}),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
	],
	[
		"get_feature_request",
		{
			title: "Read your feature request",
			description: "Read a feature request you sent.",
			inputSchema: z.object({ name: z.string().describe('e.g. "featureRequests/abc..."') }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
	],
];

/** What an MCP client sees of a tool. */
function published(tools: [string, ToolDefinition][]) {
	return tools.map(([name, t]) => ({
		name,
		title: t.title,
		description: t.description,
		inputSchema: z.toJSONSchema(t.inputSchema),
		annotations: t.annotations,
	}));
}

describe("tools", () => {
	it("are exactly as before while price decisions are off", () => {
		expect(published(toolList({ answer: false, start: false }))).toEqual(published(BEFORE));
	});

	it("keep the same tool names in every mode: a price decision is a kind of decision, not a tool of its own", () => {
		for (const answer of [false, true]) {
			for (const start of [false, true]) {
				expect(toolList({ answer, start }).map(([name]) => name)).toEqual(BEFORE.map(([name]) => name));
			}
		}
	});

	it("add price answers and reading by code when on; create_decision stays as before for those who may not start one", () => {
		const on = published(toolList({ answer: true, start: false }));
		const answer = on.find((t) => t.name === "create_answer")!;
		expect(JSON.stringify(answer.inputSchema)).toContain("maximumToPay");
		expect(JSON.stringify(answer.inputSchema)).toContain("validateOnly");
		expect(JSON.stringify(on.find((t) => t.name === "get_decision")!.inputSchema)).toContain('"code"');
		// Testers mode, for someone not on the allowlist: today's create_decision.
		expect(on.find((t) => t.name === "create_decision")).toEqual(published(BEFORE).find((t) => t.name === "create_decision"));
	});

	it("let create_decision start either kind for those who may start a price decision", () => {
		const start = published(toolList({ answer: true, start: true })).find((t) => t.name === "create_decision")!;
		expect(start.title).toBe("Start a Neutra decision");
		expect(start.description).toBe(
			"Find a meeting time or agree on a price with someone, without either side seeing the other's calendar or limit. Send your person's free times or limit; returns a message for them to forward.",
		);
		const schema = start.inputSchema as {
			properties: {
				decision: { properties: Record<string, { description?: string }>; required?: string[] };
				starterAnswer: { properties: Record<string, unknown>; required?: string[] };
				validateOnly: unknown;
			};
		};
		const { decision, starterAnswer } = schema.properties;
		// Both kinds, both optional: exactly one is checked on the server, so there is no union in the schema.
		expect(Object.keys(decision.properties).sort()).toEqual(["meeting", "price"]);
		expect(decision.required ?? []).toEqual([]);
		expect(Object.keys(starterAnswer.properties).sort()).toEqual(["meeting", "price"]);
		expect(starterAnswer.required ?? []).toEqual([]);
		expect(decision.properties.meeting.description).toBe("To find a meeting time.");
		expect(decision.properties.price.description).toContain("To agree on a price (rent, a sale, a fee).");
		expect(JSON.stringify(starterAnswer)).toContain("minimumToAccept");
		expect(JSON.stringify(starterAnswer)).toContain("maximumToPay");
		expect(schema.properties.validateOnly).toBeTruthy();
		expect(JSON.stringify(start.inputSchema)).not.toContain("anyOf");
		expect(JSON.stringify(start.inputSchema)).not.toContain("oneOf");
	});

	it("use no anyOf, which strict clients handle badly", () => {
		for (const tool of published(toolList({ answer: true, start: true }))) {
			expect(JSON.stringify(tool.inputSchema)).not.toContain("anyOf");
		}
	});
});
