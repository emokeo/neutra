// What each MCP tool tells assistants: title, description, input schema and hints. Kept apart from the handlers
// (index.ts) so tests can check them without the Workers runtime. With price decisions off, every tool here
// reads exactly as it did before price decisions existed.
import { z } from "zod";

// google.type.Interval, as JSON.
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

// Amounts are strings only: a union with numbers would put anyOf in the schema, which strict clients handle badly.
const MinimumToAccept = z
	.string()
	.optional()
	.describe('The lowest your person would accept, if they receive the money. Digits with an optional dot, as a string, e.g. "1850".');
const MaximumToPay = z
	.string()
	.optional()
	.describe('The most your person would pay, if they pay. Digits with an optional dot, as a string, e.g. "1850".');
const ValidateOnly = z.boolean().optional();

const MeetingAnswer = z.object({ availableWindows: AvailableWindows, timeZone: TimeZone });

export const CREATE_DECISION = {
	title: "Start finding a meeting time",
	description:
		"Find a meeting time with someone whose calendar you can't see, without sharing your person's. Send their free times and the meeting length; returns a message for them to forward.",
	inputSchema: z.object({
		decision: z.object({
			meeting: z.object({ duration: z.string().describe('Seconds, e.g. "3600s"') }),
		}),
		starterAnswer: z.object({ meeting: MeetingAnswer }),
	}),
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

export const CREATE_DECISION_WITH_PRICE = {
	title: "Start a Neutra decision",
	description:
		"Find a meeting time or agree on a price with someone, without either side seeing the other's calendar or limit. Send your person's free times or limit; returns a message for them to forward.",
	// One object with optional fields instead of a union: strict-schema clients handle unions badly.
	inputSchema: z.object({
		decision: z
			.object({
				meeting: z
					.object({ duration: z.string().describe('Seconds, e.g. "3600s"') })
					.optional()
					.describe("To find a meeting time."),
				price: z
					.object({
						subject: z.string().describe('What the price is for, 3 to 120 characters, shown to both sides, e.g. "Rent for the flat at Seestrasse 12"'),
						details: z.string().optional().describe('Up to 200 characters, shown to both sides, e.g. "utilities included"'),
						currencyCode: z.string().describe('ISO 4217 code, e.g. "CHF". Both answers are in this currency.'),
						unit: z.string().optional().describe('Up to 30 characters, e.g. "per month"'),
						answerBy: z.string().optional().describe('Last day to answer, "YYYY-MM-DD", 1 to 14 days ahead. Leave out for 14 days.'),
						rule: z
							.enum(["MIDPOINT", "LOWEST", "HIGHEST", "MIDPOINT_ROUNDED", "RANDOM", "OVERLAP_ONLY"])
							.optional()
							.describe(
								"Where in the overlap a deal lands. MIDPOINT (default): halfway, so each side can then work out the other's number. LOWEST: at the receiver's minimum (favors the payer, whose number stays private). HIGHEST: at the payer's maximum (favors the receiver, whose number stays private). MIDPOINT_ROUNDED: halfway, rounded to roundTo, so each side learns the other's number only roughly. RANDOM: a random point in the overlap, so each side learns only that the other's number is beyond the price. OVERLAP_ONLY: no price, only whether the numbers overlap (e.g. salaries, early screening); neither number shows.",
							),
						roundTo: z
							.string()
							.optional()
							.describe('MIDPOINT_ROUNDED only: the step, digits as a string in the currency, e.g. "50". Leave out for about 1% of your person\'s number.'),
						maxAnswers: z
							.number()
							.int()
							.min(1)
							.max(3)
							.optional()
							.describe("How many numbers the other side may send, 1 (default) to 3. Where their own number can set the price, more answers let them move it between tries."),
					})
					.optional()
					.describe(
						"To agree on a price (rent, a sale, a fee). Your person's side follows from starterAnswer.price: minimumToAccept if they receive the money, maximumToPay if they pay.",
					),
			})
			.describe("Exactly one of meeting or price."),
		starterAnswer: z
			.object({
				meeting: MeetingAnswer.optional().describe("With decision.meeting: your person's free times."),
				price: z
					.object({ minimumToAccept: MinimumToAccept, maximumToPay: MaximumToPay })
					.optional()
					.describe("With decision.price: exactly one of minimumToAccept or maximumToPay, your person's true limit. Never shown to anyone, except as the price under LOWEST or HIGHEST."),
			})
			.describe("Matching the decision: meeting with decision.meeting, price with decision.price."),
		validateOnly: ValidateOnly.describe(
			"Price decisions only: check the limit and get it back to read to your person, without sending or storing anything.",
		),
	}),
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

// Sends a calendar invite to both people when there is a match.
const ANSWER_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const Parent = DecisionName.optional().describe("Not needed when code is the combined form");
const Code = z.string().describe('The code from the forwarded message, usually the combined form "neutra:<id>.<code>"');

export const CREATE_ANSWER_MEETING = {
	title: "Answer a meeting-time request",
	description:
		"Use when your person pastes a Neutra message or a \"neutra:\" code. Takes that code and your person's free times. Neutra compares them privately. If a time fits both, it sends one calendar invite; otherwise, nobody learns anything about the other's times.",
	inputSchema: z.object({ parent: Parent, code: Code, answer: z.object({ meeting: MeetingAnswer }) }),
	annotations: ANSWER_HINTS,
};

export const CREATE_ANSWER_WITH_PRICE = {
	title: "Answer a Neutra request",
	description:
		"Answer a request from a forwarded Neutra message or \"neutra:\" code, with your person's free times or price limit. Neutra compares the two answers privately and reports only the result.",
	inputSchema: z.object({
		parent: Parent,
		code: Code,
		answer: z
			.object({
				meeting: MeetingAnswer.optional(),
				price: z
					.object({ maximumToPay: MaximumToPay, minimumToAccept: MinimumToAccept })
					.optional()
					.describe("For a price request: exactly one, in the request's currency. get_decision with the code says which."),
			})
			.describe("Exactly one of meeting or price, matching the request."),
		validateOnly: ValidateOnly.describe("Price answers only: check the amount and get it back to read to your person, without sending."),
	}),
	annotations: ANSWER_HINTS,
};

const READ_HINTS = { readOnlyHint: true, openWorldHint: false };

export const GET_DECISION_MEETING = {
	title: "Check a meeting-time decision",
	description: "Check a decision's status and meeting time.",
	inputSchema: z.object({ name: DecisionName }),
	annotations: READ_HINTS,
};

export const GET_DECISION_WITH_PRICE = {
	title: "Check a Neutra request",
	description: 'Read a request\'s terms and status, by its name or by a "neutra:" code. Never shows the other side\'s times or limit.',
	inputSchema: z.object({
		name: DecisionName.optional().describe('The decision\'s name, e.g. "decisions/abc...". Or send code instead.'),
		code: z
			.string()
			.optional()
			.describe(
				'A "neutra:<id>.<code>" code from a forwarded message: returns a preview of what the request asks for, without answering it. For a price, preview.price.yourSide is your person\'s side. PAYS: send maximumToPay; RECEIVES: send minimumToAccept.',
			),
	}),
	// Only reads, by name or by code: a code is never bound or counted here.
	annotations: READ_HINTS,
};

export const DELETE_DECISION = {
	title: "Delete a meeting-time decision",
	description: "Cancel a decision you started, including its invite.",
	inputSchema: z.object({ name: DecisionName }),
	// Cancels the invite for both people if one was sent.
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
};

export const GET_ANSWER = {
	title: "Read your own answer",
	description: "Read your own answer.",
	inputSchema: z.object({ name: z.string().describe('e.g. "decisions/abc.../answers/xyz..."') }),
	annotations: READ_HINTS,
};

export const CREATE_FEATURE_REQUEST = {
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
};

export const GET_FEATURE_REQUEST = {
	title: "Read your feature request",
	description: "Read a feature request you sent.",
	inputSchema: z.object({ name: z.string().describe('e.g. "featureRequests/abc..."') }),
	annotations: READ_HINTS,
};

export type ToolDefinition = { title: string; description: string; inputSchema: z.ZodTypeAny; annotations: object };

/**
 * The tools a caller gets, in the order they are registered. index.ts registers exactly these:
 * price.answer is "the switch is on", price.start is "this caller may start a price decision"
 * (open, or testers for those on the allowlist).
 */
export function toolList(price: { answer: boolean; start: boolean }): [string, ToolDefinition][] {
	return [
		["create_decision", price.start ? CREATE_DECISION_WITH_PRICE : CREATE_DECISION],
		["create_answer", price.answer ? CREATE_ANSWER_WITH_PRICE : CREATE_ANSWER_MEETING],
		["get_decision", price.answer ? GET_DECISION_WITH_PRICE : GET_DECISION_MEETING],
		["delete_decision", DELETE_DECISION],
		["get_answer", GET_ANSWER],
		["create_feature_request", CREATE_FEATURE_REQUEST],
		["get_feature_request", GET_FEATURE_REQUEST],
	];
}
