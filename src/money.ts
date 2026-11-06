// Amounts for price decisions: reading, showing and splitting them. Pure, so it is easy to test.
// Amounts are kept as whole numbers of the currency's smallest unit (cents, rappen, yen), never as
// floating-point money: 0.1 + 0.2 must not decide a price.
import { ApiError } from "./decisions";

/** The largest amount Neutra takes: 10^13 smallest units (e.g. 100 billion francs), well inside exact integers. */
export const MAX_MINOR = 10 ** 13;

/** Upper-case ISO 4217 code, or the error that says what to send instead. */
export function currencyCode(value: string): string {
	const code = value.trim().toUpperCase();
	// Intl accepts any three letters as a currency, so check against the list it knows when it can.
	const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : null;
	if (!/^[A-Z]{3}$/.test(code) || (known && !known.includes(code))) {
		throw new ApiError("INVALID_ARGUMENT", `"${value}" isn't an ISO 4217 currency code. Use e.g. "CHF", "EUR", "USD".`);
	}
	return code;
}

/** How many decimals the currency has: 2 for CHF, 0 for JPY, 3 for KWD. */
export function minorDigits(currency: string): number {
	const code = currencyCode(currency);
	return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Why a typed amount can't be used, so the API and the web page can each say it in their own words. */
export type AmountProblem = "FORMAT" | "DECIMALS" | "ZERO" | "TOO_LARGE";

/**
 * Reads a plain amount ("1850" or "1850.50") into smallest units. Integer and decimal parts are read
 * separately as whole numbers, so nothing is ever rounded on the way in.
 */
export function readPlainAmount(text: string, digits: number): { minor: number } | { problem: AmountProblem } {
	const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
	if (!m) return { problem: "FORMAT" };
	const fraction = m[2] ?? "";
	// "1850.50" in a currency with 2 decimals is fine; "1850.505" is not. Trailing zeros past the limit are fine too.
	if (fraction.replace(/0+$/, "").length > digits) return { problem: "DECIMALS" };
	const whole = m[1].replace(/^0+(?=\d)/, "");
	// More than 14 integer digits can't be under the limit; checking first keeps the numbers exact.
	if (whole.length > 14) return { problem: "TOO_LARGE" };
	const minor = Number(whole) * 10 ** digits + Number((fraction + "0".repeat(digits)).slice(0, digits) || "0");
	if (minor <= 0) return { problem: "ZERO" };
	if (minor > MAX_MINOR) return { problem: "TOO_LARGE" };
	return { minor };
}

/** An amount an assistant sent, as a string or a number, in smallest units. */
export function parseAmount(value: string | number, currency: string): number {
	const code = currencyCode(currency);
	const digits = minorDigits(code);
	let text: string;
	if (typeof value === "number") {
		// Numbers go through their shortest written form; 1e21 or NaN are refused like any other odd text.
		text = Number.isFinite(value) ? String(value) : "";
	} else {
		text = value.trim();
	}
	const result = readPlainAmount(text, digits);
	if ("minor" in result) return result.minor;
	const shown = typeof value === "number" ? String(value) : value;
	switch (result.problem) {
		case "DECIMALS":
			throw new ApiError(
				"INVALID_ARGUMENT",
				digits === 0
					? `${code} takes no decimals; got "${shown}". Send a whole amount, e.g. "1500".`
					: `${code} takes at most ${digits} decimals; got "${shown}".`,
			);
		case "ZERO":
			throw new ApiError("INVALID_ARGUMENT", `The amount must be more than 0; got "${shown}".`);
		case "TOO_LARGE":
			throw new ApiError("INVALID_ARGUMENT", `"${shown}" is more than Neutra can handle. Check the amount with your person.`);
		default:
			throw new ApiError(
				"INVALID_ARGUMENT",
				`"${shown}" isn't a plain amount. Send digits with an optional dot, e.g. "1850" or "1850.50".`,
			);
	}
}

/** "1850.50": the amount as plain digits with all of the currency's decimals, for the API. */
export function plainAmount(minor: number, currency: string): string {
	const digits = minorDigits(currency);
	const factor = 10 ** digits;
	const whole = Math.floor(minor / factor);
	return digits ? `${whole}.${String(minor % factor).padStart(digits, "0")}` : String(whole);
}

/**
 * "CHF 1,775 per month": for people. With wholeOnly (the default), whole amounts drop the ".00";
 * an amount with cents always shows them.
 */
export function formatAmount(minor: number, currency: string, unit?: string, wholeOnly = true): string {
	const code = currencyCode(currency);
	const digits = minorDigits(code);
	const factor = 10 ** digits;
	const whole = new Intl.NumberFormat("en").format(Math.floor(minor / factor));
	const cents = minor % factor;
	const decimals = digits && (cents !== 0 || !wholeOnly) ? `.${String(cents).padStart(digits, "0")}` : "";
	return `${code} ${whole}${decimals}${unit ? ` ${unit}` : ""}`;
}

/**
 * The MIDPOINT rule: a deal when the most the payer would pay is at least the least the receiver
 * would accept, at the price halfway between. A half smallest unit rounds up. When both people gave
 * whole amounts (e.g. 1700 and 1851 francs), the price is whole too, rounded up (1776, not 1775.50):
 * people who think in whole francs shouldn't get cents back.
 */
export function midpoint(minimum: number, maximum: number, currency: string): { deal: true; price: number } | { deal: false } {
	if (maximum < minimum) return { deal: false };
	let price = Math.floor((minimum + maximum + 1) / 2);
	const factor = 10 ** minorDigits(currency);
	if (minimum % factor === 0 && maximum % factor === 0 && price % factor !== 0) {
		price = Math.ceil(price / factor) * factor;
	}
	return { deal: true, price };
}
