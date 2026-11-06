// The web answer page for a price request: one amount, in the request's currency, shown once more before
// it is sent because there is only one answer.
import type { WebRequest } from "./decisions";
import { formatAmount, formatNumber, minorDigits, otherCurrencyIn, plainAmount, readPlainAmount, splitRange } from "./money";
import { createPriceAnswer } from "./price";
import { answersText } from "./price-rules";
import { formatDay } from "./time";
import { type AnswerKind, limitError, who } from "./web-kind";
import { esc, messagePage } from "./web-pages";

// One number, or a range of which both ends count: a deal can only land inside it.
type PriceAnswer = { minor: number } | { range: { low: number; high: number } };
type PriceValues = { amount: string };

/**
 * Reads an amount the way people type it: 1'700, 1 700, 1,700 or 1.700 (a comma or dot before exactly three
 * digits is a thousands separator), 1700.-, or with the request's currency, "CHF 1700". Anything else gets a
 * plain sentence on what to change.
 */
export function readTypedAmount(typed: string, currency: string): PriceAnswer | { error: string } {
	const text = typed.trim();
	if (!text) return { error: "Enter an amount." };
	if (otherCurrencyIn(text, currency)) return { error: `This request is in ${currency}. Enter just the number.` };
	// A range, e.g. "10'000–20'000": each end read the same way.
	const ends = splitRange(text);
	if (!ends) return readOneAmount(text, currency);
	const [low, high] = ends.map((end) => readOneAmount(end, currency));
	if ("error" in low) return low;
	if ("error" in high) return high;
	if (low.minor >= high.minor) return { error: "Enter the lower number first, e.g. 1700–1900, or just one number." };
	return { range: { low: low.minor, high: high.minor } };
}

function readOneAmount(typed: string, currency: string): { minor: number } | { error: string } {
	let text = typed.trim();
	text = text
		.replace(new RegExp(`^${currency}\\s*|\\s*${currency}$`, "i"), "")
		// The Swiss "1700.-" means a whole amount.
		.replace(/\.[-–—]$/, "");
	const digits = minorDigits(currency);
	if (/^\d{1,3}(['’\s]\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/['’\s]/g, "");
	else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, "");
	// "1.700" or "1.700.000": dots between groups of three are thousands, as many people write them. Only where
	// the currency has fewer than three decimals; in KWD "1.700" is a real amount. The confirm step shows the
	// result ("CHF 1,700") before anything is sent.
	else if (digits < 3 && /^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
	else if (/^\d+,\d+$/.test(text)) return { error: "Use a dot for decimals, e.g. 1700.50, and enter the amount again." };
	const result = readPlainAmount(text, digits);
	if ("minor" in result) return result;
	switch (result.problem) {
		case "DECIMALS":
			return { error: digits === 0 ? `${currency} amounts have no decimals. Enter a whole number.` : `Enter at most ${digits} decimals.` };
		case "ZERO":
			return { error: "Enter an amount above 0." };
		case "TOO_LARGE":
			return { error: "That amount is too large. Check it and enter it again." };
		default:
			return { error: "Enter the amount in digits, e.g. 1700 or 1700.50." };
	}
}

/** "1900.00" or "1700.00-1900.00": what is sent, in the API's plain form. */
function plainLimit(answer: PriceAnswer, currency: string): string {
	return "range" in answer
		? `${plainAmount(answer.range.low, currency)}-${plainAmount(answer.range.high, currency)}`
		: plainAmount(answer.minor, currency);
}

function terms(info: WebRequest) {
	// Price requests always carry their terms; see webRequest.
	return info.price as NonNullable<WebRequest["price"]>;
}

function pays(info: WebRequest): boolean {
	return terms(info).yourSide === "PAYS";
}

/** "The most you'd pay" / "The least you'd accept". */
function label(info: WebRequest): string {
	return pays(info) ? "The most you'd pay" : "The least you'd accept";
}

function subject(info: WebRequest): string {
	const t = terms(info);
	return `${t.subject}${t.details ? ` (${t.details})` : ""}`;
}

/** Answers this person still has: all of them before a try, fewer after a no-deal. */
function answersLeft(info: WebRequest): number {
	return info.viewer === "responder" ? info.remainingAttempts : terms(info).maxAnswers;
}

/** "You have 2 answers." or, after a try, "You have 1 answer left." */
function answersLine(info: WebRequest): string {
	const left = answersLeft(info);
	if (left < terms(info).maxAnswers) return `You have ${left} ${left === 1 ? "answer" : "answers"} left.`;
	return left === 1 ? "You have one answer." : `You have ${left} answers.`;
}

/**
 * What to give, how the rule works and how many answers there are: the person must know all three before answering.
 * The subject isn't repeated in the sentence: it is in the line under the heading.
 */
/** The subject on its own line, under a result: never pasted into a sentence, where its capital letter reads oddly. */
function subjectLine(info: WebRequest): string {
	const t = terms(info);
	return `<p class="muted">${esc(t.subject)}${t.details ? ` (${esc(t.details)})` : ""}</p>`;
}

function introText(info: WebRequest): string {
	const t = terms(info);
	const noDeal = t.rule === "OVERLAP_ONLY" ? "" : " If not, neither of you learns the other's number.";
	return `Give ${pays(info) ? "the most you'd pay" : "the least you'd accept"}. ${esc(t.ruleText)}${noDeal} ${answersLine(info)}`;
}

const STYLE = `
.amount { display: flex; align-items: center; gap: 8px; margin: 4px 0 12px; } .amount input { flex: 1; font-size: 20px; }
.amount span { color: #5c5c5c; white-space: nowrap; } label.big { font-weight: 600; }
@media (prefers-color-scheme: dark) { .amount span { color: #a8a8a8; } }
`;

export const priceKind: AnswerKind<PriceAnswer, PriceValues> = {
	invitation: (info, timeZone) => ({
		title: `${info.starterFirstName} would like to agree on a price with you`,
		detail: subject(info),
		answerBy: formatDay(info.answerBy, timeZone),
	}),
	intro: introText,
	signInNote: "Neutra gets only your name and email from Google, to email you the result.",
	expiredNote: "Your sign-in expired before you sent your number. Sign in again and enter it once more.",
	addressNote: "The result goes to this address.",
	again: "If you still want to agree on a price",
	ownRequest: "Send the link to the other person: they answer it, not you.",
	privateOutcome: true,

	// After a try without a deal, while answers are left. Nothing about how far apart the numbers were.
	notice: (info) =>
		info.viewer === "responder" && info.remainingAttempts < terms(info).maxAnswers
			? `No deal yet: your number didn't reach theirs. ${info.remainingAttempts} ${info.remainingAttempts === 1 ? "answer" : "answers"} left.`
			: undefined,

	form(info, values) {
		const t = terms(info);
		return {
			fields: `<p>${introText(info)}</p>
<label class="big" for="amount">${label(info)}</label>
<div class="amount"><span>${esc(t.currency)}</span><input id="amount" name="amount" inputmode="decimal" autocomplete="off" required value="${esc(values?.amount ?? "")}">${t.unit ? `<span>${esc(t.unit)}</span>` : ""}</div>
<p class="hint">A range like 1700–1900 works too.</p>
<p class="hint">${esc(
				answersLeft(info) < t.maxAnswers
					? answersLeft(info) === 1
						? "This is your last answer."
						: `${answersLine(info)} After a "no deal" you can send another number.`
					: answersText(t.maxAnswers, t.yourSide),
			)} You can't change a number after sending it.</p>
<input type="hidden" name="step" value="confirm">`,
			submit: "Continue",
			style: STYLE,
		};
	},

	read(form, info) {
		const typed = form.get("amount");
		const amount = typeof typed === "string" ? typed.trim() : "";
		const result = readTypedAmount(amount, terms(info).currency);
		if ("error" in result) return { error: result.error, values: { amount } };
		return { answer: result, values: { amount } };
	},

	confirm: (answer, info) => {
		const t = terms(info);
		const unit = t.unit ? ` ${t.unit}` : "";
		return {
			text:
				"range" in answer
					? `Your range: ${t.currency} ${formatNumber(answer.range.low, t.currency)}–${formatNumber(answer.range.high, t.currency)}${unit} (${
							pays(info) ? "you pay" : "you receive"
						}). A deal can only land inside it. You can't change it after sending.`
					: `${label(info)}: ${formatAmount(answer.minor, t.currency, t.unit)}. You can't change it after sending.`,
			hidden: { amount: plainLimit(answer, t.currency) },
		};
	},

	// Sent as plain digits in the request's currency, in the field for the person's side.
	send: (env, caller, code, answer, info) =>
		createPriceAnswer(env, caller, {
			code,
			price: { [pays(info) ? "maximumToPay" : "minimumToAccept"]: plainLimit(answer, terms(info).currency) },
		}),

	failed(error, info) {
		if (error.reason === "PRICE_ANSWER_LIMIT") {
			return { error: "You've already answered 3 price requests in the last 24 hours. Please try again tomorrow.", status: 429 };
		}
		if (error.reason === "PRICE_OFF") {
			return messagePage("Price requests aren't available right now", `<p>Ask ${who(info)} to agree on the price with you directly.</p>`, 503);
		}
		const limited = limitError(error, info);
		if (limited) return limited;
		if (error.code === "INVALID_ARGUMENT") return { error: "Neutra couldn't read this amount. Enter digits only, e.g. 1700 or 1700.50." };
		return null;
	},

	// Only the person who answered sees the outcome here; for everyone else the shared page says the request ended.
	result(info, signedIn) {
		if (info.viewer !== "responder" || !signedIn) return null;
		// OVERLAP_ONLY: no price, only whether the numbers overlap.
		if (info.state === "AGREED" && terms(info).rule === "OVERLAP_ONLY") {
			return messagePage(
				"Your numbers overlap",
				`<p><strong>Your numbers overlap: worth talking.</strong></p>${subjectLine(info)}<p>Neutra set no price; agree on it together with ${who(info)}. Neither of you learns the other's number. You both got an email.</p>`,
			);
		}
		if (info.state === "NO_MATCH" && terms(info).rule === "OVERLAP_ONLY") {
			return messagePage(
				"Your numbers don't overlap",
				`<p><strong>Your numbers don't overlap.</strong></p>${subjectLine(info)}<p>Neither of you learns the other's number.</p>`,
			);
		}
		if (info.state === "AGREED" && info.agreedPriceText) {
			return messagePage(
				"You have a deal",
				`<p><strong>Deal: ${esc(info.agreedPriceText)}</strong></p>${subjectLine(info)}<p>That's ${esc(terms(info).dealText)}. This isn't a contract: settle the details with ${who(info)} directly; you both got an email.</p>`,
			);
		}
		if (info.state === "NO_MATCH") {
			return messagePage(
				"No deal",
				`<p>No deal: your numbers didn't overlap. Neither of you learns the other's number.</p><p>If you still want to agree, talk to ${who(info)} directly or ask for a new request.</p>`,
			);
		}
		return null;
	},
};
