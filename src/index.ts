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
import { GoogleHandler } from "./google-handler";
import { nextStep, SERVER_INSTRUCTIONS } from "./guidance";

// Who the caller is, from Google sign-in. Encrypted inside the auth token.
export type Props = {
	name: string;
	email: string;
};

// google.type.Interval, as JSON.
const Interval = z.object({
	startTime: z.string().datetime({ offset: true }).describe("RFC 3339 timestamp with offset"),
	endTime: z.string().datetime({ offset: true }).describe("RFC 3339 timestamp with offset"),
});

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
		console.log(JSON.stringify({ tool, outcome: error instanceof ApiError ? error.code : "INTERNAL" }));
		return fail(error);
	}
}

function createServer() {
	const server = new McpServer({ name: "Neutra", version: "0.2.0" }, { instructions: SERVER_INSTRUCTIONS });
	const props = getMcpAuthContext()?.props as Props | undefined;
	const caller = props ? { email: props.email, name: props.name } : undefined;

	server.registerTool(
		"create_decision",
		{
			title: "Start finding a meeting time",
			description:
				"Use this when your person wants to meet someone and you need to agree on a time. Send your person's available windows (together at least twice the meeting duration) and the duration. Returns a code and a handoffMessage for your person to forward; the other person's assistant answers with create_answer. Nobody ever sees the other person's times.",
			inputSchema: z.object({
				decision: z.object({
					meeting: z.object({ duration: z.string().describe('Seconds, e.g. "3600s"') }),
				}),
				starterAnswer: z.object({ meeting: z.object({ availableWindows: AvailableWindows }) }),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (request) =>
			run("create_decision", caller, async (c) => {
				const decision = await createDecision(env, c, {
					durationSeconds: request.decision.meeting.duration,
					starterWindows: request.starterAnswer.meeting.availableWindows,
				});
				return { ...decision, nextStep: nextStep("create_decision", decision) };
			}),
	);

	server.registerTool(
		"create_answer",
		{
			title: "Answer a meeting-time request",
			description:
				"Use this when your person received a Neutra message with a decision name and code. Send your person's available windows; together they must cover at least twice the meeting duration. If both people share a time, a calendar invite goes to both right away. If not, the decision stays WAITING and remainingAttempts says how many more answers you may send, so ask your person for wider times. After the last one it ends as NO_MATCH.",
			inputSchema: z.object({
				parent: DecisionName,
				code: z.string().describe("The code from the message the other person forwarded"),
				answer: z.object({ meeting: z.object({ availableWindows: AvailableWindows }) }),
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
				});
				return { ...result, nextStep: nextStep("create_answer", result.decision) };
			}),
	);

	server.registerTool(
		"get_decision",
		{
			title: "Check a meeting-time decision",
			description:
				"Use this to see where a decision stands: WAITING, NO_MATCH, INVITE_SENT, ACCEPTED, DECLINED or EXPIRED, plus the meeting time and each person's reply to the invite. Participants only.",
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
				"Use this when your person no longer wants a meeting they started. Deletes the decision: the code stops working, and if an invite was sent, it is cancelled for both people.",
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
			description: "Read your own answer to a decision. Times are kept only until the decision is settled.",
			inputSchema: z.object({ name: z.string().describe('e.g. "decisions/abc.../answers/xyz..."') }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ name }) => run("get_answer", caller, (c) => getAnswer(env, c, name)),
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

export default new OAuthProvider<Env>({
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
