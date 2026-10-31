import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";

// Who the caller is, from Google sign-in. Encrypted inside the auth token.
export type Props = {
	name: string;
	email: string;
};

// google.type.Interval, as JSON.
const Interval = z.object({
	startTime: z.string().datetime({ offset: true }),
	endTime: z.string().datetime({ offset: true }),
});

// Duration as protobuf JSON, e.g. "3600s".
const Duration = z.string().regex(/^\d+s$/, 'Use seconds, e.g. "3600s"');

const CreateDecisionRequest = z.object({
	decision: z.object({
		meeting: z.object({ duration: Duration }),
	}),
	starterAnswer: z.object({
		meeting: z.object({ availableWindows: z.array(Interval).min(1) }),
	}),
	requestId: z.string().uuid().optional(),
});

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function randomId(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	// First character is a letter, as AIP-122 asks for resource IDs.
	return Array.from(bytes, (b, i) => (i === 0 ? ALPHABET[b % 26] : ALPHABET[b % 32])).join("");
}

function createServer() {
	const server = new McpServer({
		name: "Neutra",
		version: "0.0.1",
	});

	// v0 skeleton: validates the request and returns a decision, but stores nothing yet.
	server.registerTool(
		"create_decision",
		{
			description:
				"Start a decision to find a meeting time with one other person. Send your person's available windows and the meeting duration. Returns a code and a message to forward to the other person; their assistant answers with the code. Nobody ever sees the other person's times.",
			inputSchema: CreateDecisionRequest,
		},
		async (request) => {
			const name = `decisions/${randomId(26)}`;
			const code = randomId(12);
			const now = new Date();
			const decision = {
				name,
				meeting: { duration: request.decision.meeting.duration },
				state: "WAITING",
				code,
				handoffMessage: `I'd like to find a time to meet. Give this to your assistant: Neutra decision ${name}, code ${code}. If your assistant doesn't have the Neutra connector yet, add it first.`,
				createTime: now.toISOString(),
				updateTime: now.toISOString(),
			};
			return { content: [{ type: "text", text: JSON.stringify(decision, null, 2) }] };
		},
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
