import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { splitCombinedCode } from "./decisions";
import { recordEvent } from "./events";
import { ogImage } from "./og-image";
import { homePage, privacyPage, requestPage } from "./pages";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, isAllowed, type Props } from "./utils";
import { WebAnswer, webCallback } from "./web-answer";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/", (c) => homePage(c.env.MCP_RESOURCE));
app.get("/privacy", () => privacyPage());
app.get("/og.png", () => ogImage());
// Answering in the browser, for people without an AI assistant.
app.route("/", WebAnswer);

// The link in a hand-off message. Counts "message opened" (link previews and bots excluded).
app.get("/r/:id", async (c) => {
	const id = c.req.param("id");
	const row = /^[a-z][a-z2-7]{25}$/.test(id)
		? await c.env.DB.prepare("SELECT starter_name, stats_ref, kind FROM decisions WHERE id = ?")
				.bind(id)
				.first<{ starter_name: string; stats_ref: string | null; kind: "meeting" | "price" }>()
		: null;
	const agent = c.req.header("user-agent") ?? "";
	if (row && !/bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|telegram|twitter|discord|linkedin|skype/i.test(agent)) {
		c.executionCtx.waitUntil(recordEvent(c.env, { type: "handoff_opened", decisionRef: row.stats_ref }));
	}
	return requestPage(
		row?.starter_name ?? null,
		c.env.MCP_RESOURCE,
		/^[a-z][a-z2-7]{25}$/.test(id) ? id : "",
		c.req.query("bad") === "1",
		row?.kind === "price" ? "price" : "meeting",
	);
});

// The code box on the steps page: someone who opened the wrong link pastes the code and goes to the answer page.
app.get("/r/:id/answer", (c) => {
	const id = c.req.param("id");
	const pasted = (c.req.query("code") ?? "").trim();
	let target: string | null = null;
	try {
		const combined = splitCombinedCode(pasted.match(/neutra:\S+/i)?.[0] ?? pasted);
		if (combined) target = `${combined.id}.${combined.code}`;
	} catch {
		// An incomplete "neutra:" code: say so below.
	}
	// Just the 12 characters after the dot also work, with the request from the address.
	if (!target && /^[a-z][a-z2-7]{25}$/.test(id) && /^[a-z][a-z2-7]{11}$/i.test(pasted)) target = `${id}.${pasted.toLowerCase()}`;
	const headers = { "Cache-Control": "no-store", "Referrer-Policy": "same-origin" };
	return target
		? new Response(null, { status: 303, headers: { ...headers, Location: `/a/${target}` } })
		: new Response(null, { status: 303, headers: { ...headers, Location: `/r/${id}?bad=1#browser` } });
});

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// Check if client is already approved
	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		// Skip approval dialog but still create secure state and bind to session
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		return redirectToGoogle(c.req.raw, c.env, stateToken, {
			"Set-Cookie": sessionBindingCookie,
		});
	}

	// Generate CSRF protection for the approval form
	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "Neutra lets your assistant agree on a time with other people's assistants, without either side seeing the other's calendar.",
			name: "Neutra",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		// Read form data once
		const formData = await c.req.raw.formData();

		// Validate CSRF token
		validateCSRFToken(formData, c.req.raw);

		// Extract state from form data
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		// Add client to approved list
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		// Create OAuth state and bind it to this user's session
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		// Set both cookies: approved client list + session binding
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);

		return redirectToGoogle(c.req.raw, c.env, stateToken, Object.fromEntries(headers));
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error
		return c.text("Something went wrong while signing in. Please try again.", 500);
	}
});

async function redirectToGoogle(
	request: Request,
	env: Env,
	stateToken: string,
	headers: Record<string, string> = {},
) {
	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				clientId: env.GOOGLE_CLIENT_ID,
				hostedDomain: env.HOSTED_DOMAIN,
				redirectUri: new URL("/callback", request.url).href,
				scope: "email profile",
				state: stateToken,
				upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			}),
		},
		status: 302,
	});
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from Google after user authentication.
 * It exchanges the temporary code for an access token, then stores some
 * user metadata & the auth token as part of the 'props' on the token passed
 * down to the client. It ends by redirecting the client back to _its_ callback URL
 *
 * SECURITY: This endpoint validates that the state parameter from Google
 * matches both:
 * 1. A valid state token in KV (proves it was created by our server)
 * 2. The __Host-CONSENTED_STATE cookie (proves THIS browser consented to it)
 *
 * This prevents CSRF attacks where an attacker's state token is injected
 * into a victim's OAuth flow.
 */
app.get("/callback", async (c) => {
	// Sign-in for the web answer page shares this redirect address.
	if (c.req.query("state")?.startsWith("web.")) return webCallback(c.req.raw, c.env);

	// Validate OAuth state with session binding
	// This checks both KV storage AND the session cookie
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Unexpected non-OAuth error
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	// Exchange the code for an access token
	const code = c.req.query("code");
	if (!code) {
		return c.text("Missing code", 400);
	}

	const [accessToken, googleErrResponse] = await fetchUpstreamAuthToken({
		clientId: c.env.GOOGLE_CLIENT_ID,
		clientSecret: c.env.GOOGLE_CLIENT_SECRET,
		code,
		grantType: "authorization_code",
		redirectUri: new URL("/callback", c.req.url).href,
		upstreamUrl: "https://accounts.google.com/o/oauth2/token",
	});
	if (googleErrResponse) {
		return googleErrResponse;
	}

	// Fetch the user info from Google
	const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});
	if (!userResponse.ok) {
		console.error("userinfo failed", userResponse.status);
		return c.text("Couldn't read your Google profile. Please try signing in again.", 500);
	}

	const { id, name, email, verified_email } = (await userResponse.json()) as {
		id: string;
		name: string;
		email: string;
		verified_email?: boolean;
	};

	// v0 is restricted to the test users listed in ALLOWED_EMAILS.
	// ACCESS_MODE "allowlist" (default): only ALLOWED_EMAILS. "open": any verified Google account.
	const open = c.env.ACCESS_MODE === "open";
	if (!verified_email || (!open && !isAllowed(email, c.env.ALLOWED_EMAILS))) {
		return c.text("Neutra is in private testing. This Google account is not on the list yet.", 403);
	}

	// Return back to the MCP client a new token
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: name,
		},
		// The Google access token is deliberately not stored: v0 only needs who the person is.
		props: {
			email,
			name,
			// Which assistant this is, for anonymous usage counts.
			client: (await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId))?.clientName ?? "unknown",
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: id,
	});

	// Clear the session binding cookie (one-time use) by creating response with headers
	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}

	return new Response(null, {
		status: 302,
		headers,
	});
});

export { app as GoogleHandler };
