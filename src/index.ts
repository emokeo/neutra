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
} from "./decisions";
import { recordEvent } from "./events";
import { createFeatureRequest, getFeatureRequest } from "./feedback";
import { GoogleHandler } from "./google-handler";
import { nextStep, SERVER_INSTRUCTIONS } from "./guidance";
import { runMaintenance } from "./maintenance";

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
	try {
		const result = await action(caller);
		console.log(JSON.stringify({ tool, outcome: "ok" }));
		return ok(result);
	} catch (error) {
		const code = error instanceof ApiError ? error.code : "INTERNAL";
		console.log(JSON.stringify({ tool, outcome: code }));
		await recordEvent(env, { type: "request_failed", client: caller.client, email: caller.email, detail: { tool, code } });
		return fail(error);
	}
}

function createServer() {
	const server = new McpServer({ name: "Neutra", version: "0.2.0" }, { instructions: SERVER_INSTRUCTIONS });
	const props = getMcpAuthContext()?.props as Props | undefined;
	const caller = props ? { email: props.email, name: props.name, client: props.client } : undefined;

	server.registerTool(
		"create_decision",
		{
			title: "Start finding a meeting time",
			description:
				"Start finding a meeting time with someone. Send your person's free times and the meeting length; returns a message to forward.",
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

	server.registerTool(
		"create_answer",
		{
			title: "Answer a meeting-time request",
			description:
				"Answer a Neutra request with your person's free times. Neutra compares them privately. If a time fits both, it sends one calendar invite; otherwise, nobody learns anything about the other's times.",
			inputSchema: z.object({
				parent: DecisionName,
				code: z.string().describe("The code from the message the other person forwarded"),
				answer: z.object({ meeting: z.object({ availableWindows: AvailableWindows, timeZone: TimeZone }) }),
			}),
			// Sends a calendar invite to both people when there is a match.
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (request) =>
			run("create_answer", caller, async (c) => {
				const result = await createAnswer(env, c, {
					parent: request.parent,
					code: request.code,
					windows: request.answer.meeting.availableWindows,
					timeZone: request.answer.meeting.timeZone,
				});
				return { ...result, nextStep: nextStep("create_answer", result.decision, result.receivedWindows) };
			}),
	);

	server.registerTool(
		"get_decision",
		{
			title: "Check a meeting-time decision",
			description:
				"Check a decision's status and meeting time.",
			inputSchema: z.object({ name: DecisionName }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ name }) =>
			run("get_decision", caller, async (c) => {
				const decision = await getDecision(env, c, name);
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
			description: "Answer a meeting-time request someone sent you through Neutra.",
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
						text: `Someone sent me this Neutra request:\n\n${message}\n\nAsk me when I'm free, or check my calendar if you can and confirm the times with me, then answer it with Neutra.`,
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
