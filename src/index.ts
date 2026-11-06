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
import { canStartPrice, createPriceAnswer, createPriceDecision, type LimitInput, priceMode } from "./price";
import {
	CREATE_ANSWER_MEETING,
	CREATE_ANSWER_WITH_PRICE,
	CREATE_DECISION,
	CREATE_FEATURE_REQUEST,
	CREATE_PRICE_DECISION,
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

type Windows = { availableWindows: { startTime: string; endTime: string }[]; timeZone?: string };

/** create_answer, for both inputs: the meeting-only one (switch off) and the one with price (switch on). */
async function answer(
	c: Caller,
	request: { parent?: string; code: string; answer: { meeting?: Windows; price?: LimitInput }; validateOnly?: boolean },
) {
	const { meeting, price } = request.answer;
	exactlyOne(
		[meeting, price],
		"Send exactly one of answer.meeting (free times) or answer.price (a price limit). get_decision with the code says which this request needs.",
	);
	if (price) {
		const result = await createPriceAnswer(env, c, { parent: request.parent, code: request.code, price, validateOnly: request.validateOnly });
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
	const windows = meeting as Windows;
	const result = await createAnswer(env, c, {
		parent: request.parent,
		code: request.code,
		windows: windows.availableWindows,
		timeZone: windows.timeZone,
	});
	return { ...result, nextStep: nextStep("create_answer", result.decision, result.receivedWindows) };
}

/** get_decision, by name (participants) or, with the switch on, by code (anyone holding it). */
async function read(c: Caller, request: { name?: string; code?: string }) {
	if (request.name === undefined && request.code === undefined) throw new ApiError("INVALID_ARGUMENT", "Send name or code.");
	exactlyOne([request.name, request.code], "Send either name or code, not both.");
	if (request.code !== undefined) {
		const terms = await requestTerms(env, c, request.code);
		return { ...terms, nextStep: codeNextStep(terms) };
	}
	const decision = await getDecision(env, c, request.name as string);
	if ("kind" in decision) return { ...decision, nextStep: priceNextStep("get_decision", decision) };
	return { ...decision, nextStep: nextStep("get_decision", decision) };
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

	// The same tools, in the same order, as toolList() in tools.ts (which the tests check).
	server.registerTool("create_decision", CREATE_DECISION, async (request) =>
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
		server.registerTool("create_price_decision", CREATE_PRICE_DECISION, async (request) =>
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

	// With the switch off, create_answer and get_decision keep their meeting-only inputs; both inputs fit one handler.
	if (priceOn) {
		server.registerTool("create_answer", CREATE_ANSWER_WITH_PRICE, async (request) => run("create_answer", caller, (c) => answer(c, request)));
		server.registerTool("get_decision", GET_DECISION_WITH_PRICE, async (request) => run("get_decision", caller, (c) => read(c, request)));
	} else {
		server.registerTool("create_answer", CREATE_ANSWER_MEETING, async (request) => run("create_answer", caller, (c) => answer(c, request)));
		server.registerTool("get_decision", GET_DECISION_MEETING, async (request) => run("get_decision", caller, (c) => read(c, request)));
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
