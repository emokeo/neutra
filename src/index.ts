import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { ApiError, type Caller, deleteDecision, getAnswer } from "./decisions";
import { recordEvent } from "./events";
import { createFeatureRequest, getFeatureRequest } from "./feedback";
import { GoogleHandler } from "./google-handler";
import { isAllowed } from "./utils";
import { serverInstructions } from "./guidance";
import { answerRequest, readDecision, startDecision } from "./handlers";
import { runMaintenance } from "./maintenance";
import { canStartPrice, priceMode } from "./price";
import {
	CREATE_ANSWER_MEETING,
	CREATE_ANSWER_WITH_PRICE,
	CREATE_DECISION,
	CREATE_DECISION_WITH_PRICE,
	CREATE_FEATURE_REQUEST,
	DELETE_DECISION,
	GET_ANSWER,
	GET_DECISION_MEETING,
	GET_DECISION_WITH_PRICE,
	GET_FEATURE_REQUEST,
} from "./tools";

// Who the caller is, from Google sign-in. Encrypted inside the auth token.
export type Props = {
	name: string;
	email: string;
	// The assistant's registered name, e.g. "Claude", recorded at sign-in.
	client?: string;
};

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
	const server = new McpServer(
		{ name: "Neutra", version: "0.2.0" },
		{ instructions: serverInstructions({ answer: priceOn, start: priceStart }) },
	);

	// The same tools, in the same order, as toolList() in tools.ts (which the tests check). create_decision,
	// create_answer and get_decision take price inputs only while price decisions are on (create_decision only for
	// callers who may start one); otherwise they keep their meeting-only inputs. Both inputs fit one handler.
	if (priceStart) {
		server.registerTool("create_decision", CREATE_DECISION_WITH_PRICE, async (request) =>
			run("create_decision", caller, (c) => startDecision(env, c, request, true)),
		);
	} else {
		server.registerTool("create_decision", CREATE_DECISION, async (request) =>
			run("create_decision", caller, (c) => startDecision(env, c, request, false)),
		);
	}
	if (priceOn) {
		server.registerTool("create_answer", CREATE_ANSWER_WITH_PRICE, async (request) =>
			run("create_answer", caller, (c) => answerRequest(env, c, request)),
		);
		server.registerTool("get_decision", GET_DECISION_WITH_PRICE, async (request) => run("get_decision", caller, (c) => readDecision(env, c, request)));
	} else {
		server.registerTool("create_answer", CREATE_ANSWER_MEETING, async (request) =>
			run("create_answer", caller, (c) => answerRequest(env, c, request)),
		);
		server.registerTool("get_decision", GET_DECISION_MEETING, async (request) => run("get_decision", caller, (c) => readDecision(env, c, request)));
	}

	server.registerTool("delete_decision", DELETE_DECISION, async ({ name }) =>
		run("delete_decision", caller, async (c) => {
			await deleteDecision(env, c, name);
			return {};
		}),
	);

	server.registerTool("get_answer", GET_ANSWER, async ({ name }) => run("get_answer", caller, (c) => getAnswer(env, c, name)));

	server.registerTool("create_feature_request", CREATE_FEATURE_REQUEST, async ({ featureRequest }) =>
		run("create_feature_request", caller, (c) => createFeatureRequest(env, c, featureRequest.summary)),
	);

	server.registerTool("get_feature_request", GET_FEATURE_REQUEST, async ({ name }) =>
		run("get_feature_request", caller, (c) => getFeatureRequest(env, c, name)),
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
