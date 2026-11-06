// Answering in the browser, for people without an AI assistant. The link in the hand-off message is
// /a/<decision id>.<code>: it carries the same code as the line for the assistant, so it's just as private.
// Sign-in uses Google (same client and /callback as the connector; states starting with "web." are ours).
import { Hono } from "hono";
import { ApiError, webRequest, type WebRequest } from "./decisions";
import { recordEvent } from "./events";
import { isValidTimeZone } from "./time";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, isAllowed } from "./utils";
import type { AnswerKind } from "./web-kind";
import { meetingKind } from "./web-meeting";
import { priceMode } from "./price";
import { confirmPage, esc, formPage, introPage, messagePage } from "./web-pages";
import { priceKind } from "./web-price";
import {
	cookie,
	LOGIN_COOKIE,
	LOGIN_SECONDS,
	readCookie,
	SESSION_COOKIE,
	SESSION_SECONDS,
	sign,
	verify,
	type WebSession,
} from "./web-session";

const TOKEN = /^([a-z][a-z2-7]{25})\.([a-z][a-z2-7]{11})$/;

type Login = { s: string; t: string };
type Session = { e: string; n: string };

export function parseToken(token: string): { id: string; code: string } | null {
	const m = TOKEN.exec(token.toLowerCase());
	return m ? { id: m[1], code: m[2] } : null;
}

async function session(env: Env, request: Request): Promise<WebSession | null> {
	const s = await verify<Session>(env.COOKIE_ENCRYPTION_KEY, "web-session", readCookie(request.headers.get("cookie"), SESSION_COOKIE));
	return s ? { email: s.e, name: s.n } : null;
}

function notFound(): Response {
	return messagePage(
		"This link doesn't work",
		`<p>Check that you copied the whole link from the message. If it still doesn't work, the request may have been deleted: ask the person who sent it.</p>`,
		404,
	);
}

/** The guess for the person's time zone before the browser says: where their network is. */
function networkZone(request: Request): string {
	const zone = (request as Request & { cf?: { timezone?: string } }).cf?.timezone;
	return zone && isValidTimeZone(zone) ? zone : "UTC";
}

/** While price requests are switched off, their links say so before anything else. */
function priceOff(info: WebRequest): Response {
	return messagePage(
		"Price requests aren't available right now",
		`<p>Ask ${esc(info.starterFirstName)} to agree on the price with you directly.</p>`,
		503,
	);
}

/** The page for a request that can't be answered (any more), or null if the form should show. */
function stateGuard<A, V>(kind: AnswerKind<A, V>, info: WebRequest, signedIn: WebSession | null): Response | null {
	const who = esc(info.starterFirstName);
	if (info.viewer === "starter") {
		return messagePage("This is your own request", `<p>${kind.ownRequest}</p>`);
	}
	if (info.viewer === "someone_else" && !kind.privateOutcome) {
		return messagePage(
			"Someone else already answered",
			`<p>This request was answered with another Google account. ${kind.again}, ask ${who} to send a new request.</p>`,
		);
	}
	const outcome = kind.result(info, signedIn);
	if (outcome) return outcome;
	// Ended, or the starter's times are over so nothing can fit any more.
	if (info.state !== "WAITING" || info.timesPassed) {
		return messagePage("This request has ended", `<p>${kind.again}, ask ${who} to send a new request.</p>`);
	}
	return null;
}

function renderForm<A, V>(
	kind: AnswerKind<A, V>,
	request: Request,
	info: WebRequest,
	signedIn: WebSession,
	token: string,
	extra: { values?: V; timeZone?: string; error?: string; notice?: string; status?: number } = {},
): Response {
	// Dates are shown in the person's zone once known; before that, where their network is.
	const zone = extra.timeZone ?? networkZone(request);
	return formPage(kind.invitation(info, zone), {
		token,
		email: signedIn.email,
		addressNote: kind.addressNote,
		...kind.form(info, extra.values, { timeZone: extra.timeZone, zone, now: Date.now() }),
		notice: extra.notice,
		error: extra.error,
		status: extra.status,
	});
}

export const WebAnswer = new Hono<{ Bindings: Env }>();

/** The page for one request, of whichever kind. */
async function showRequest<A, V>(kind: AnswerKind<A, V>, request: Request, info: WebRequest, signedIn: WebSession | null, token: string, expired: boolean) {
	const guard = stateGuard(kind, info, signedIn);
	if (guard) return guard;
	if (!signedIn) {
		return introPage(kind.invitation(info, networkZone(request)), token, {
			intro: kind.intro(info),
			expired: expired ? kind.expiredNote : undefined,
			signIn: kind.signInNote,
		});
	}
	return renderForm(kind, request, info, signedIn, token, { notice: kind.notice?.(info) });
}

WebAnswer.get("/a/:token", async (c) => {
	const token = c.req.param("token").toLowerCase();
	const parsed = parseToken(token);
	if (!parsed) return notFound();
	const signedIn = await session(c.env, c.req.raw);
	const info = await webRequest(c.env, parsed.id, parsed.code, signedIn?.email);
	if (!info) return notFound();
	const expired = c.req.query("expired") === "1";
	if (info.kind === "price" && priceMode(c.env) === "off") return priceOff(info);
	return info.kind === "price"
		? showRequest(priceKind, c.req.raw, info, signedIn, token, expired)
		: showRequest(meetingKind, c.req.raw, info, signedIn, token, expired);
});

/**
 * An answer from the form. Kinds with a confirm step go form → confirm → send; only "send" reaches Neutra.
 * Post, then redirect: reloading the result page must never send the answer again.
 */
async function postAnswer<A, V>(
	kind: AnswerKind<A, V>,
	env: Env,
	request: Request,
	info: WebRequest,
	signedIn: WebSession,
	parsed: { id: string; code: string },
	token: string,
	back: string,
): Promise<Response> {
	const form = await request.formData();
	const zone = networkZone(request);
	const read = kind.read(form, info, zone);
	const again = (values: V, error?: string, status = 400) => {
		const tz = form.get("tz");
		const timeZone = typeof tz === "string" && isValidTimeZone(tz) ? tz : zone;
		return renderForm(kind, request, info, signedIn, token, { values, timeZone, error, status: error ? status : 200 });
	};
	if ("error" in read) return again(read.values, read.error);
	const step = form.get("step");
	if (kind.confirm && step === "change") return again(read.values);
	if (kind.confirm && step !== "send") {
		const shown = kind.confirm(read.answer, info);
		return confirmPage(kind.invitation(info, zone), { token, email: signedIn.email, addressNote: kind.addressNote, ...shown });
	}

	try {
		await kind.send(env, { email: signedIn.email, name: signedIn.name, client: "web" }, `neutra:${parsed.id}.${parsed.code}`, read.answer, info);
	} catch (error) {
		if (!(error instanceof ApiError)) {
			console.error("web answer failed", parsed.id, error);
			return messagePage(
				"Something went wrong",
				`<p>Something went wrong on Neutra's side. <a href="/a/${token}">Open the request again</a> in a few minutes to see where it stands.</p>`,
				500,
			);
		}
		await recordEvent(env, {
			type: "request_failed",
			client: "web",
			email: signedIn.email,
			detail: error.reason ? { tool: "create_answer", code: error.code, reason: error.reason } : { tool: "create_answer", code: error.code },
		});
		// The errors are worded for assistants, so the page says it in its own words.
		const handled = kind.failed(error, info, token);
		if (handled instanceof Response) return handled;
		if (handled) return again(read.values, handled.error, handled.status);
		// The request ended, is being answered, or someone else answered: the request page explains.
		return Response.redirect(back, 303);
	}
	return Response.redirect(back, 303);
}

WebAnswer.post("/a/:token", async (c) => {
	const token = c.req.param("token").toLowerCase();
	const parsed = parseToken(token);
	if (!parsed) return notFound();
	const self = new URL(c.req.url);
	const back = new URL(`/a/${token}`, self).href;
	// Only this page may send answers (the session cookie is SameSite=Lax as well).
	const origin = c.req.header("origin");
	if (origin && origin !== self.origin) return c.text("Forbidden", 403);
	const signedIn = await session(c.env, c.req.raw);
	// Signed out in the meantime (the sign-in lasts an hour): say so on the sign-in page.
	if (!signedIn) return c.redirect(`${back}?expired=1`, 303);
	const info = await webRequest(c.env, parsed.id, parsed.code, signedIn.email);
	if (!info) return notFound();
	if (info.kind === "price" && priceMode(c.env) === "off") return priceOff(info);
	return info.kind === "price"
		? answerOrBack(priceKind, c.env, c.req.raw, info, signedIn, parsed, token, back)
		: answerOrBack(meetingKind, c.env, c.req.raw, info, signedIn, parsed, token, back);
});

function answerOrBack<A, V>(
	kind: AnswerKind<A, V>,
	env: Env,
	request: Request,
	info: WebRequest,
	signedIn: WebSession,
	parsed: { id: string; code: string },
	token: string,
	back: string,
): Promise<Response> | Response {
	if (stateGuard(kind, info, signedIn)) return Response.redirect(back, 303);
	return postAnswer(kind, env, request, info, signedIn, parsed, token, back);
}

WebAnswer.get("/a/:token/signin", async (c) => {
	const token = c.req.param("token").toLowerCase();
	if (!parseToken(token)) return notFound();
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	const state = `web.${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
	const login = await sign(c.env.COOKIE_ENCRYPTION_KEY, "web-login", { s: state, t: token }, LOGIN_SECONDS);
	const google = new URL(
		getUpstreamAuthorizeUrl({
			clientId: c.env.GOOGLE_CLIENT_ID,
			hostedDomain: c.env.HOSTED_DOMAIN,
			redirectUri: new URL("/callback", c.req.url).href,
			scope: "email profile",
			state,
			upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		}),
	);
	// The invite goes to this account, so let people pick it.
	google.searchParams.set("prompt", "select_account");
	return new Response(null, {
		status: 302,
		headers: { Location: google.href, "Set-Cookie": cookie(LOGIN_COOKIE, login, LOGIN_SECONDS), "Cache-Control": "no-store" },
	});
});

/** Google's redirect back for a web sign-in (the state starts with "web."). */
export async function webCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const login = await verify<Login>(env.COOKIE_ENCRYPTION_KEY, "web-login", readCookie(request.headers.get("cookie"), LOGIN_COOKIE));
	if (!login || login.s !== url.searchParams.get("state") || !parseToken(login.t)) {
		return messagePage(
			"Sign-in didn't work",
			`<p>Sign-in took too long or was opened in another browser. Open the link from the message again.</p>`,
			400,
		);
	}
	const back = new URL(`/a/${login.t}`, url).href;
	const clearLogin = cookie(LOGIN_COOKIE, "", 0);
	// Cancelled at Google: back to the request.
	if (url.searchParams.get("error")) {
		return new Response(null, { status: 303, headers: { Location: back, "Set-Cookie": clearLogin } });
	}
	const [accessToken, failed] = await fetchUpstreamAuthToken({
		clientId: env.GOOGLE_CLIENT_ID,
		clientSecret: env.GOOGLE_CLIENT_SECRET,
		code: url.searchParams.get("code") ?? undefined,
		grantType: "authorization_code",
		redirectUri: new URL("/callback", url).href,
		upstreamUrl: "https://accounts.google.com/o/oauth2/token",
	});
	const retry = `<p><a href="/a/${login.t}/signin">Try signing in again</a>.</p>`;
	if (failed) return messagePage("Sign-in didn't work", retry, 502);
	const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!response.ok) {
		console.error("userinfo failed", response.status);
		return messagePage("Sign-in didn't work", retry, 502);
	}
	const { name, email, verified_email } = (await response.json()) as { name?: string; email: string; verified_email?: boolean };
	const open = env.ACCESS_MODE === "open";
	if (!verified_email) {
		return messagePage("This account can't be used", `<p>Neutra needs a Google account with a verified email address.</p>${retry}`, 403);
	}
	if (!open && !isAllowed(email, env.ALLOWED_EMAILS)) {
		return messagePage("Neutra is in private testing", `<p>This Google account is not on the list yet.</p>`, 403);
	}
	const value = await sign(env.COOKIE_ENCRYPTION_KEY, "web-session", { e: email, n: name?.trim() || email.split("@")[0] }, SESSION_SECONDS);
	const headers = new Headers({ Location: back, "Cache-Control": "no-store" });
	headers.append("Set-Cookie", cookie(SESSION_COOKIE, value, SESSION_SECONDS));
	headers.append("Set-Cookie", clearLogin);
	return new Response(null, { status: 303, headers });
}
