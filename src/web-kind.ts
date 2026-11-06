// What the web answer page needs from each kind of request. The page itself (sign-in, errors, the confirm
// step, results) lives in web-answer.ts and is the same for every kind; a kind only says what to ask and how
// to read it. Meetings: web-meeting.ts. Prices: web-price.ts.
import type { ApiError, Caller, WebRequest } from "./decisions";
import { esc, type Invitation } from "./web-pages";
import type { WebSession } from "./web-session";

export type FormContext = {
	// The person's time zone once the page knows it; until then, a guess from their network (zone).
	timeZone?: string;
	zone: string;
	now: number;
};

export interface AnswerKind<Answer, Values> {
	/** The heading: who asks, what for, and the deadline in the person's time zone. */
	invitation(info: WebRequest, timeZone: string): Invitation;
	/** Before sign-in, all HTML: one line on what to do, the note under the button, and what an expired sign-in lost. */
	intro(info: WebRequest): string;
	signInNote: string;
	expiredNote: string;
	/** Under the form: where the result goes. */
	addressNote: string;
	/** The start of "…, ask Anna to send a new request", e.g. "If you still want to meet". */
	again: string;
	/** For the starter who opened their own link. HTML. */
	ownRequest: string;
	/** A line above the form, e.g. how many tries are left. */
	notice?(info: WebRequest): string | undefined;
	/** The inputs, inside the shared form. */
	form(
		info: WebRequest,
		values: Values | undefined,
		context: FormContext,
	): { fields: string; attributes?: string; submit?: string; script?: string; style?: string };
	/** The posted form, read for sending, or what to fix (said for a person) with what was entered. */
	read(form: FormData, info: WebRequest, zone: string): { answer: Answer; values: Values } | { error: string; values: Values };
	/** Kinds whose answer can't be changed show it once more before sending. */
	confirm?(answer: Answer, info: WebRequest): { text: string; hidden: Record<string, string> };
	send(env: Env, caller: Caller, code: string, answer: Answer, info: WebRequest): Promise<unknown>;
	/** An error from Neutra in the person's words, a page of its own, or null when the request page explains. */
	failed(error: ApiError, info: WebRequest, token: string): { error: string; status?: number } | Response | null;
	/** A page instead of the form: the outcome, or why it can't be answered. Null shows the form. */
	result(info: WebRequest, signedIn: WebSession | null): Response | null;
}

/** The limits are the same for every kind; the other errors are worded for assistants, so each page words its own. */
export function limitError(error: ApiError, info: WebRequest): { error: string; status: number } | null {
	if (error.reason === "SAME_STARTER_LIMIT") {
		return { error: `You've already answered 3 requests from ${info.starterFirstName} in the last 24 hours. Please try again tomorrow.`, status: 429 };
	}
	if (error.code === "RESOURCE_EXHAUSTED") return { error: "You've sent a lot of answers in the last hour. Please try again later.", status: 429 };
	return null;
}

/** "Anna", escaped for the page. */
export function who(info: WebRequest): string {
	return esc(info.starterFirstName);
}
