import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import {
	ApiError,
	type Caller,
	createAnswer,
	createDecision,
	deleteDecision,
	getAnswer,
	getDecision,
	requestTerms,
} from "./decisions";
import { recordEvent } from "./events";
import { createFeatureRequest, getFeatureRequest } from "./feedback";
import { GoogleHandler } from "./google-handler";
import { isAllowed } from "./utils";
import { codeNextStep, nextStep, priceNextStep, serverInstructions, validateNextStep } from "./guidance";
import { runMaintenance } from "./maintenance";
import { canStartPrice, createPriceAnswer, createPriceDecision, priceMode } from "./price";

// Who the caller is, from Google sign-in. Encrypted inside the auth token.
export type Props = {
	name: string;
	email: string;
	// The assistant's registered name, e.g. "Claude", recorded at sign-in.
	client?: string;
};

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

// A price limit: a string or a number. A union of two plain types is fine for strict clients (unions of objects are not).
const Amount = z.union([z.string(), z.number()]);
const MinimumToAccept = Amount.optional().describe(
	'The lowest your person would accept, if they receive the money. Digits with an optional dot, e.g. "1850" or "1850.50".',
);
const MaximumToPay = Amount.optional().describe(
	'The most your person would pay, if they pay. Digits with an optional dot, e.g. "1850" or "1850.50".',
);
const ValidateOnly = z
	.boolean()
	.optional()
	.describe("Check the amount and get it back to read to your person, without sending or storing anything.");

// Shared tools say more once price decisions are on; while the switch is off they read exactly as before.
const MEETING_ONLY = {
	answerTitle: "Answer a meeting-time request",
	answerDescription:
		"Use when your person pastes a Neutra message or a \"neutra:\" code. Takes that code and your person's free times. Neutra compares them privately. If a time fits both, it sends one calendar invite; otherwise, nobody learns anything about the other's times.",
	getTitle: "Check a meeting-time decision",
	getDescription: "Check a decision's status and meeting time.",
};
const WITH_PRICE = {
	answerTitle: "Answer a Neutra request",
	answerDescription:
		"Answer a request from a forwarded Neutra message or \"neutra:\" code, with your person's free times or price limit. Neutra compares the two answers privately and reports only the result.",
	getTitle: "Check a Neutra request",
	getDescription: 'Read a request\'s terms and status, by its name or by a "neutra:" code. Never shows the other side\'s times or limit.',
};

function exactlyOne(values: unknown[], message: string): void {
	if (values.filter((v) => v !== undefined).length !== 1) throw new ApiError("INVALID_ARGUMENT", message);
}

function ok(result: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function fail(error: unknown) {
	const body =
		error instanceof ApiError
			? { error: { status: error.code, message: error.message } }
			: { error: { status: "INTERNAL", message: "Something went wrong on Neutra's side." } };
	if (!(error instanceof ApiError)) console.error(error);
	return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

async function run(tool: string, caller: Caller | undefined, action: (caller: Caller) => Promise<unknown>) {
	if (!caller) return fail(new ApiError("PERMISSION_DENIED", "Sign in to use Neutra."));
	// Checked on every call, so removing someone from the allowlist takes effect at once.
	if (env.ACCESS_MODE !== "open" && !isAllowed(caller.email, env.ALLOWED_EMAILS)) {
		return fail(new ApiError("PERMISSION_DENIED", "Neutra is in private testing, and this account isn't on the list yet."));
	}
	try {
		const result = await action(caller);
		console.log(JSON.stringify({ tool, outcome: "ok" }));
		return ok(result);
	} catch (error) {
		const code = error instanceof ApiError ? error.code : "INTERNAL";
		console.log(JSON.stringify({ tool, outcome: code }));
		// The reason (e.g. TOO_NARROW) shows how often people hit a rule, without any of their data.
		const detail: Record<string, string> = { tool, code };
		if (error instanceof ApiError && error.reason) detail.reason = error.reason;
		await recordEvent(env, { type: "request_failed", client: caller.client, email: caller.email, detail });
		return fail(error);
	}
}

function createServer() {
	const props = getMcpAuthContext()?.props as Props | undefined;
	const caller = props ? { email: props.email, name: props.name, client: props.client } : undefined;
	// Anyone may answer a price request while the switch is on; starting one depends on who is asking.
	const priceOn = priceMode(env) !== "off";
	const priceStart = canStartPrice(env, caller?.email);
	const texts = priceOn ? WITH_PRICE : MEETING_ONLY;
	const server = new McpServer(
		{ name: "Neutra", version: "0.2.0" },
		{ instructions: serverInstructions({ answer: priceOn, start: priceStart }) },
	);

	server.registerTool(
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
		async (request) =>
			run("create_decision", caller, async (c) => {
				const decision = await createDecision(env, c, {
					durationSeconds: request.decision.meeting.duration,
					starterWindows: request.starterAnswer.meeting.availableWindows,
					timeZone: request.starterAnswer.meeting.timeZone,
				});
				return { ...decision, nextStep: nextStep("create_decision", decision, decision.receivedWindows) };
			}),
	);

	if (priceStart) {
		server.registerTool(
			"create_price_decision",
			{
				title: "Start agreeing on a price",
				description:
					"Agree a price with another person who also takes part, without either side seeing the other's limit. Send your person's limit and the terms; returns a message for them to forward.",
				// One object with optional fields instead of a union: strict-schema clients handle unions badly.
				inputSchema: z.object({
					decision: z.object({
						price: z.object({
							subject: z.string().describe('What the price is for, 3 to 120 characters, shown to both sides, e.g. "Rent for the flat at Seestrasse 12"'),
							details: z.string().optional().describe('Up to 200 characters, shown to both sides, e.g. "utilities included"'),
							currency: z.string().describe('ISO 4217 code, e.g. "CHF"'),
							unit: z.string().optional().describe('Up to 30 characters, e.g. "per month"'),
							answerBy: z
								.string()
								.optional()
								.describe('Last day to answer, "YYYY-MM-DD", 1 to 14 days ahead. Leave out for 14 days.'),
						}),
					}),
					starterAnswer: z
						.object({ price: z.object({ minimumToAccept: MinimumToAccept, maximumToPay: MaximumToPay }) })
						.describe("Exactly one of minimumToAccept or maximumToPay. Never shown to anyone."),
					validateOnly: ValidateOnly,
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
			},
			async (request) =>
				run("create_price_decision", caller, async (c) => {
					const result = await createPriceDecision(env, c, {
						price: request.decision.price,
						starterAnswer: request.starterAnswer.price,
						validateOnly: request.validateOnly,
					});
					if (result.validateOnly) {
						return { receivedLimit: result.receivedLimit, terms: result.terms, nextStep: validateNextStep(result.receivedLimit) };
					}
					return { ...result, nextStep: priceNextStep("create_price_decision", result.decision) };
				}),
		);
	}

	server.registerTool(
		"create_answer",
		{
			title: texts.answerTitle,
			description: texts.answerDescription,
			inputSchema: z.object({
				parent: DecisionName.optional().describe("Not needed when code is the combined form"),
				code: z.string().describe('The code from the forwarded message, usually the combined form "neutra:<id>.<code>"'),
				answer: z
					.object({
						meeting: z.object({ availableWindows: AvailableWindows, timeZone: TimeZone }).optional(),
						price: z
							.object({ maximumToPay: MaximumToPay, minimumToAccept: MinimumToAccept })
							.optional()
							.describe("For a price request: exactly one, in the request's currency. get_decision with the code says which."),
					})
					.describe("Exactly one of meeting or price, matching the request."),
				validateOnly: ValidateOnly.describe("Price answers only: check the amount and get it back to read to your person, without sending."),
			}),
			// Sends a calendar invite to both people when there is a match.
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (request) =>
			run("create_answer", caller, async (c) => {
				const { meeting, price } = request.answer;
				exactlyOne(
					[meeting, price],
					"Send exactly one of answer.meeting (free times) or answer.price (a price limit). get_decision with the code says which this request needs.",
				);
				if (price) {
					const result = await createPriceAnswer(env, c, {
						parent: request.parent,
						code: request.code,
						price,
						validateOnly: request.validateOnly,
					});
					if (result.validateOnly) {
						return { receivedLimit: result.receivedLimit, terms: result.terms, nextStep: validateNextStep(result.receivedLimit) };
					}
					return { ...result, nextStep: priceNextStep("create_answer", result.decision) };
				}
				if (request.validateOnly) {
					throw new ApiError(
						"INVALID_ARGUMENT",
						"validateOnly is only for price answers. For a meeting, send the times without it: receivedWindows in the reply shows what Neutra understood.",
					);
				}
				if (!meeting) throw new ApiError("INVALID_ARGUMENT", "Send answer.meeting with your person's free times.");
				const result = await createAnswer(env, c, {
					parent: request.parent,
					code: request.code,
					windows: meeting.availableWindows,
					timeZone: meeting.timeZone,
				});
				return { ...result, nextStep: nextStep("create_answer", result.decision, result.receivedWindows) };
			}),
	);

	server.registerTool(
		"get_decision",
		{
			title: texts.getTitle,
			description: texts.getDescription,
			inputSchema: z.object({
				name: DecisionName.optional().describe('The decision\'s name, e.g. "decisions/abc...". Or send code instead.'),
				code: z
					.string()
					.optional()
					.describe('A "neutra:<id>.<code>" code from a forwarded message: shows what the request asks for, without answering it.'),
			}),
			// Only reads, by name or by code: a code is never bound or counted here.
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ name, code }) =>
			run("get_decision", caller, async (c) => {
				exactlyOne([name, code], "Send either name or code, not both.");
				if (code !== undefined) {
					const terms = await requestTerms(env, c, code);
					return { ...terms, nextStep: codeNextStep(terms) };
				}
				const decision = await getDecision(env, c, name as string);
				if ("kind" in decision) return { ...decision, nextStep: priceNextStep("get_decision", decision) };
				return { ...decision, nextStep: nextStep("get_decision", decision) };
			}),
	);

	server.registerTool(
		"delete_decision",
		{
			title: "Delete a meeting-time decision",
			description:
				"Cancel a decision you started, including its invite.",
			inputSchema: z.object({ name: DecisionName }),
			// Cancels the invite for both people if one was sent.
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async ({ name }) =>
			run("delete_decision", caller, async (c) => {
				await deleteDecision(env, c, name);
				return {};
			}),
	);

	server.registerTool(
		"get_answer",
		{
			title: "Read your own answer",
			description: "Read your own answer.",
			inputSchema: z.object({ name: z.string().describe('e.g. "decisions/abc.../answers/xyz..."') }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ name }) => run("get_answer", caller, (c) => getAnswer(env, c, name)),
	);

	server.registerTool(
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
		async ({ featureRequest }) => run("create_feature_request", caller, (c) => createFeatureRequest(env, c, featureRequest.summary)),
	);

	server.registerTool(
		"get_feature_request",
		{
			title: "Read your feature request",
			description: "Read a feature request you sent.",
			inputSchema: z.object({ name: z.string().describe('e.g. "featureRequests/abc..."') }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ name }) => run("get_feature_request", caller, (c) => getFeatureRequest(env, c, name)),
	);

	// One-click shortcuts that clients like Claude show to the person.
	server.registerPrompt(
		"find_a_time",
		{
			title: "Find a time with someone",
			description: "Start agreeing on a meeting time with another person through Neutra.",
			argsSchema: z.object({
				with: z.string().describe("Who you want to meet"),
				when: z.string().optional().describe("When you're free, in your own words (optional)"),
			}),
		},
		({ with: person, when }) => ({
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: `I'd like to meet ${person}. Use Neutra to find a time. ${
							when
								? `I'm free: ${when}.`
								: "Ask me when I'm free, or check my calendar if you can and confirm the times with me."
						} Then show me the message to forward, exactly as Neutra returns it.`,
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"answer_request",
		{
			title: "Answer a Neutra request",
			description: priceOn
				? "Answer a request someone sent you through Neutra: a meeting time or a price."
				: "Answer a meeting-time request someone sent you through Neutra.",
			argsSchema: z.object({
				message: z.string().describe("The Neutra message you received"),
			}),
		},
		({ message }) => ({
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: priceOn
							? `Someone sent me this Neutra request:\n\n${message}\n\nCheck with Neutra what it asks for. For a meeting, ask me when I'm free, or check my calendar if you can and confirm the times with me. For a price, ask me for my number and read it back to me before sending. Then answer it with Neutra.`
							: `Someone sent me this Neutra request:\n\n${message}\n\nAsk me when I'm free, or check my calendar if you can and confirm the times with me, then answer it with Neutra.`,
					},
				},
			],
		}),
	);

	return server;
}

const mcpHandler = createMcpHandler(createServer);

const provider = new OAuthProvider<Env>({
	apiHandler: {
		fetch(request: Request, env: Env, ctx: ExecutionContext) {
			return mcpHandler(request, env, ctx);
		},
	},
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GoogleHandler as any,
	tokenEndpoint: "/token",
	// The URL MCP clients connect to. Every token is bound to it.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),
	// Every 15 minutes (see wrangler.jsonc): expiry, the failure emails, and deleting old data.
	scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
		ctx.waitUntil(runMaintenance(env));
	},
};
