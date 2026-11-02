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
	.describe("Times this person can make it. Never shown to anyone else.");

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
	const server = new McpServer({ name: "Neutra", version: "0.1.0" });
	const props = getMcpAuthContext()?.props as Props | undefined;
	const caller = props ? { email: props.email, name: props.name } : undefined;

	server.registerTool(
		"create_decision",
		{
			description:
				"Start finding a meeting time with one other person. Send your person's available windows and the meeting duration. Returns the decision, a code and a message to forward to the other person; their assistant answers with create_answer. Nobody ever sees the other person's times.",
			inputSchema: z.object({
				decision: z.object({
					meeting: z.object({ duration: z.string().describe('Seconds, e.g. "3600s"') }),
				}),
				starterAnswer: z.object({ meeting: z.object({ availableWindows: AvailableWindows }) }),
			}),
		},
		async (request) =>
			run("create_decision", caller, (c) =>
				createDecision(env, c, {
					durationSeconds: request.decision.meeting.duration,
					starterWindows: request.starterAnswer.meeting.availableWindows,
				}),
			),
	);

	server.registerTool(
		"create_answer",
		{
			description:
				"Answer a decision someone started, using the decision name and code they sent. Send your person's available windows; together they must cover at least twice the meeting duration. If both people share a time, a calendar invite goes to both right away. If not, the decision stays WAITING and remainingAttempts says how many more answers you may send, so ask your person for wider times. After the last one it ends as NO_MATCH.",
			inputSchema: z.object({
				parent: DecisionName,
				code: z.string().describe("The code from the message the other person forwarded"),
				answer: z.object({ meeting: z.object({ availableWindows: AvailableWindows }) }),
			}),
		},
		async (request) =>
			run("create_answer", caller, (c) =>
				createAnswer(env, c, {
					parent: request.parent,
					code: request.code,
					windows: request.answer.meeting.availableWindows,
				}),
			),
	);

	server.registerTool(
		"get_decision",
		{
			description:
				"Read a decision's state: WAITING, NO_MATCH, INVITE_SENT, ACCEPTED, DECLINED or EXPIRED, plus the meeting time and each person's reply to the invite. Participants only.",
			inputSchema: z.object({ name: DecisionName }),
		},
		async ({ name }) => run("get_decision", caller, (c) => getDecision(env, c, name)),
	);

	server.registerTool(
		"delete_decision",
		{
			description:
				"Delete a decision you started. The code stops working, and if an invite was sent, it is cancelled for both people.",
			inputSchema: z.object({ name: DecisionName }),
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
			description: "Read your own answer to a decision. Times are kept only until the decision is settled.",
			inputSchema: z.object({ name: z.string().describe('e.g. "decisions/abc.../answers/xyz..."') }),
		},
		async ({ name }) => run("get_answer", caller, (c) => getAnswer(env, c, name)),
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
