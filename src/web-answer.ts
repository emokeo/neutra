// Answering in the browser, for people without an AI assistant. The link in the hand-off message is
// /a/<decision id>.<code>: it carries the same code as the line for the assistant, so it's just as private.
// Sign-in uses Google (same client and /callback as the connector; states starting with "web." are ours).
import { Hono } from "hono";
import { ApiError, createAnswer, MAX_ANSWERS, webRequest, type WebRequest } from "./decisions";
import { recordEvent } from "./events";
import { formatDay, isValidTimeZone } from "./time";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, isAllowed } from "./utils";
import { durationText, isoDay, readRows, rowsToWindows, type Row } from "./web-form";
import { esc, formPage, type Invitation, introPage, messagePage } from "./web-pages";
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

function invitation(info: WebRequest, timeZone: string): Invitation {
	return {
		starterFirstName: info.starterFirstName,
		duration: durationText(info.durationSeconds),
		answerBy: formatDay(info.answerBy, timeZone),
	};
}

/** The page for a request that can't be answered (any more), or null if the form should show. */
function stateGuard(info: WebRequest, signedIn: WebSession | null): Response | null {
	const who = esc(info.starterFirstName);
	if (info.viewer === "starter") {
		return messagePage(
			"This is your own request",
			`<p>Send the link to the person you want to meet: they answer it, not you.</p>`,
		);
	}
	if (info.viewer === "someone_else") {
		return messagePage(
			"Someone else already answered",
			`<p>This request was answered with another Google account. If you still want to meet, ask ${who} to send a new request.</p>`,
		);
	}
	if (info.pending) {
		return messagePage(
			"Almost there",
			`<p>An answer to this request is being processed, and the invite may be on its way. Look for an email from neutra.invites@gmail.com, or open this link again in a few minutes.</p>`,
		);
	}
	if (info.state === "INVITE_SENT" || info.state === "ACCEPTED" || info.state === "DECLINED") {
		if (info.viewer === "responder" && signedIn && info.scheduledTimeLocal) {
			return messagePage(
				"A time fits",
				`<p><strong>${esc(info.scheduledTimeLocal)}</strong></p><p>You and ${who} both get a calendar invite from neutra.invites@gmail.com (yours goes to ${esc(signedIn.email)}). Accept it to confirm.</p>`,
			);
		}
		return messagePage(
			"This request already has a time",
			`<p>If you answered it, look for the calendar invite from neutra.invites@gmail.com.</p>`,
		);
	}
	if (info.state === "NO_MATCH" && info.viewer === "responder") {
		return messagePage(
			"No time fits",
			`<p>None of your times overlapped with ${who}'s, and there are no tries left. ${who} gets an email that no time was found and can send you a new request.</p>`,
		);
	}
	// Ended, or the starter's times are over so nothing can fit any more.
	if (info.state !== "WAITING" || info.timesPassed) {
		return messagePage("This request has ended", `<p>If you still want to meet, ask ${who} to send a new request.</p>`);
	}
	return null;
}

function renderForm(
	request: Request,
	info: WebRequest,
	signedIn: WebSession,
	token: string,
	extra: { rows?: Row[]; timeZone?: string; error?: string; notice?: string; status?: number } = {},
): Response {
	// Dates are shown in the person's zone once known; before that, where their network is.
	const zone = extra.timeZone ?? networkZone(request);
	const now = Date.now();
	return formPage(invitation(info, zone), {
		token,
		email: signedIn.email,
		rows: extra.rows ?? [],
		// Empty on the first visit: the page fills in the browser's own time zone.
		timeZone: extra.timeZone,
		minDay: isoDay(now, zone),
		// 29, not 30: Neutra refuses times starting more than 30 days from now, and the last day's evening would be past that.
		maxDay: isoDay(now + 29 * 24 * 60 * 60 * 1000, zone),
		minimum: durationText(2 * info.durationSeconds),
		notice: extra.notice,
		error: extra.error,
		status: extra.status,
	});
}

export const WebAnswer = new Hono<{ Bindings: Env }>();

WebAnswer.get("/a/:token", async (c) => {
	const token = c.req.param("token").toLowerCase();
	const parsed = parseToken(token);
	if (!parsed) return notFound();
	const signedIn = await session(c.env, c.req.raw);
	const info = await webRequest(c.env, parsed.id, parsed.code, signedIn?.email);
	if (!info) return notFound();
	const guard = stateGuard(info, signedIn);
	if (guard) return guard;
	if (!signedIn) {
		return introPage(invitation(info, networkZone(c.req.raw)), token, c.req.query("expired") === "1");
	}
	// After an answer that didn't fit: say so above the form. Neither side learns anything about the other's times.
	const tried = info.viewer === "responder" && info.remainingAttempts < MAX_ANSWERS;
	return renderForm(c.req.raw, info, signedIn, token, {
		notice: tried
			? `No time fits yet: none of your times overlap with ${info.starterFirstName}'s. Try again with more times (${info.remainingAttempts} ${info.remainingAttempts === 1 ? "try" : "tries"} left).`
			: undefined,
	});
});

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
	if (stateGuard(info, signedIn)) return c.redirect(back, 303);

	const form = await c.req.formData();
	const rows = readRows(form);
	const zone = form.get("tz");
	const timeZone = typeof zone === "string" && isValidTimeZone(zone) ? zone : networkZone(c.req.raw);
	const again = (error: string, status = 400) => renderForm(c.req.raw, info, signedIn, token, { rows, timeZone, error, status });
	const windows = rowsToWindows(rows);
	if ("error" in windows) return again(windows.error);

	try {
		await createAnswer(
			c.env,
			{ email: signedIn.email, name: signedIn.name, client: "web" },
			{ code: `neutra:${parsed.id}.${parsed.code}`, windows: windows.windows, timeZone },
		);
	} catch (error) {
		if (!(error instanceof ApiError)) {
			console.error("web answer failed", parsed.id, error);
			return messagePage(
				"Something went wrong",
				`<p>Something went wrong on Neutra's side. <a href="/a/${token}">Open the request again</a> in a few minutes to see where it stands.</p>`,
				500,
			);
		}
		await recordEvent(c.env, {
			type: "request_failed",
			client: "web",
			email: signedIn.email,
			detail: error.reason ? { tool: "create_answer", code: error.code, reason: error.reason } : { tool: "create_answer", code: error.code },
		});
		if (error.reason === "TOO_NARROW") {
			return again(
				`Add more times: together at least ${durationText(2 * info.durationSeconds)}, each at least ${durationText(info.durationSeconds)} long and starting an hour from now or later.`,
			);
		}
		if (error.reason === "OUT_OF_RANGE") {
			return again("One of your times has already passed or is more than 30 days ahead. Check the days and try again.");
		}
		if (error.reason === "UNCONFIRMED") {
			return messagePage(
				"Neutra couldn't confirm the invite",
				`<p>A time may have been found, but the invite didn't confirm. Look for an invite from neutra.invites@gmail.com in the next 20 minutes. If none comes, <a href="/a/${token}">open this request again</a>: it will be open for another try.</p>`,
				502,
			);
		}
		// The other errors are worded for assistants, so the page says it in its own words.
		if (error.reason === "SAME_STARTER_LIMIT") {
			return again(`You've already answered 3 requests from ${info.starterFirstName} in the last 24 hours. Please try again tomorrow.`, 429);
		}
		if (error.code === "RESOURCE_EXHAUSTED") return again("You've sent a lot of answers in the last hour. Please try again later.", 429);
		if (error.code === "INVALID_ARGUMENT") return again("Neutra couldn't read these times. Check each day and time and try again.");
		// The request ended, is being answered, or someone else answered: the request page explains.
		return c.redirect(back, 303);
	}
	// Post, then redirect: reloading the result page must never send the answer again.
	return c.redirect(back, 303);
});

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
