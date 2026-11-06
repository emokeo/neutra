// The web answer page for a price request: one amount, in the request's currency, shown once more before
// it is sent because there is only one answer.
import type { WebRequest } from "./decisions";
import { formatAmount, minorDigits, otherCurrencyIn, plainAmount, readPlainAmount } from "./money";
import { createPriceAnswer } from "./price";
import { answersText } from "./price-rules";
import { formatDay } from "./time";
import { type AnswerKind, limitError, who } from "./web-kind";
import { esc, messagePage } from "./web-pages";

type PriceAnswer = { minor: number };
type PriceValues = { amount: string };

/**
 * Reads an amount the way people type it: 1'700, 1 700, 1,700 or 1.700 (a comma or dot before exactly three
 * digits is a thousands separator), 1700.-, or with the request's currency, "CHF 1700". Anything else gets a
 * plain sentence on what to change.
 */
export function readTypedAmount(typed: string, currency: string): { minor: number } | { error: string } {
	let text = typed.trim();
	if (!text) return { error: "Enter an amount." };
	if (otherCurrencyIn(text, currency)) return { error: `This request is in ${currency}. Enter just the number.` };
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

/** What to give, how the rule works and how many answers there are: the person must know all three before answering. */
function introText(info: WebRequest): string {
	const t = terms(info);
	const answers = t.maxAnswers === 1 ? "You have one answer." : `You have ${t.maxAnswers} answers.`;
	return `Give ${pays(info) ? "the most you'd pay" : "the least you'd accept"} for ${esc(t.subject)}. ${esc(t.ruleText)} If not, neither of you learns the other's number. ${answers}`;
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
<p class="hint">${esc(answersText(t.maxAnswers, t.yourSide))} You can't change a number after sending it.</p>
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
		return { answer: { minor: result.minor }, values: { amount } };
	},

	confirm: (answer, info) => {
		const t = terms(info);
		return {
			text: `${label(info)}: ${formatAmount(answer.minor, t.currency, t.unit)}. You can't change it after sending.`,
			hidden: { amount: plainAmount(answer.minor, t.currency) },
		};
	},

	// Sent as plain digits in the request's currency, in the field for the person's side.
	send: (env, caller, code, answer, info) =>
		createPriceAnswer(env, caller, {
			code,
			price: { [pays(info) ? "maximumToPay" : "minimumToAccept"]: plainAmount(answer.minor, terms(info).currency) },
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
		if (info.state === "AGREED" && info.agreedPriceText) {
			return messagePage(
				"You have a deal",
				`<p><strong>Deal: ${esc(info.agreedPriceText)} for ${esc(terms(info).subject)}.</strong></p><p>${
					terms(info).rule === "MIDPOINT" ? "That's halfway between your two numbers." : `That's ${esc(terms(info).dealText)}.`
				} This isn't a contract: settle the details with ${who(info)} directly; you both got an email.</p>`,
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
