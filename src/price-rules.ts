// The rules a price decision can follow, and how each one is said to people. Pure, so it is easy to test.
// Every rule makes a deal under the same condition: the payer's maximum reaches the receiver's minimum. Rules differ
// only in where in that overlap the deal lands, and so in what a deal reveals. They depend on the two sides, never on
// who started. A new rule is one more entry here and in the tool's list (src/tools.ts).
import { formatAmount, midpoint, minorDigits } from "./money";

/** Who pays: the starter picks their side, the other person gets the opposite. */
export type Side = "PAYS" | "RECEIVES";

export const RULES = ["MIDPOINT", "LOWEST", "HIGHEST", "MIDPOINT_ROUNDED", "RANDOM", "OVERLAP_ONLY"] as const;
export type Rule = (typeof RULES)[number];

/** What a rule needs to know about the request: the rule, the currency, and the step for MIDPOINT_ROUNDED. */
export type RuleTerms = { rule: Rule; currency: string; roundTo?: number };

/** A uniform whole number from 0 to n - 1. Replaceable in tests; never Math.random. */
export type RandomBelow = (n: number) => number;

/** Uniform in 0..n-1 from crypto.getRandomValues: 53 random bits, redrawn above the last whole multiple of n so no value is likelier. */
export const cryptoRandomBelow: RandomBelow = (n) => {
	if (n <= 1) return 0;
	const limit = Math.floor(2 ** 53 / n) * n;
	for (;;) {
		const [a, b] = crypto.getRandomValues(new Uint32Array(2));
		const x = a * 2 ** 21 + (b >>> 11);
		if (x < limit) return x % n;
	}
};

/**
 * The default step for MIDPOINT_ROUNDED: about 1% of the starter's number, rounded down to 1, 2 or 5 times a power
 * of ten, and at least one whole unit of the currency (CHF 1850 → CHF 10; CHF 1,850,000 → CHF 10,000).
 */
export function defaultStep(starterMinor: number, currency: string): number {
	const whole = 10 ** minorDigits(currency);
	const target = starterMinor / 100;
	if (target <= whole) return whole;
	const power = 10 ** Math.floor(Math.log10(target));
	const step = [5, 2, 1].map((m) => m * power).find((v) => v <= target) ?? power;
	return Math.max(whole, step);
}

/** How many numbers the person answering may try, at most. The starter chooses 1 (the default) to 3. */
export const MAX_PRICE_ANSWERS = 3;

/**
 * The deal price in smallest units, or null for no deal.
 * MIDPOINT: halfway between the two numbers, so a deal lets each side work out the other's.
 * LOWEST: the receiver's minimum, the lowest price in the overlap. The payer learns it; the payer's number stays private.
 * HIGHEST: the payer's maximum, the highest price in the overlap. The receiver learns it; the receiver's stays private.
 * OVERLAP_ONLY: no price at all, also when the numbers overlap (null). Whether they overlap is the whole result,
 * so neither number ever shows: see overlaps().
 */
export function dealPrice(
	t: RuleTerms,
	p: { minimum: number; maximum: number },
	randomBelow: RandomBelow = cryptoRandomBelow,
): number | null {
	const { minimum, maximum } = p;
	if (maximum < minimum || t.rule === "OVERLAP_ONLY") return null;
	if (t.rule === "LOWEST") return minimum;
	if (t.rule === "HIGHEST") return maximum;
	if (t.rule === "RANDOM") {
		// Uniform over the overlap, so on average it equals the midpoint. Whole units when both numbers are whole.
		const whole = 10 ** minorDigits(t.currency);
		const unit = minimum % whole === 0 && maximum % whole === 0 ? whole : 1;
		const low = Math.ceil(minimum / unit);
		const high = Math.floor(maximum / unit);
		return (low + randomBelow(high - low + 1)) * unit;
	}
	const half = (midpoint(minimum, maximum, t.currency) as { price: number }).price;
	if (t.rule === "MIDPOINT_ROUNDED") {
		// Halfway, to the nearest step (halves up), then back inside the overlap: a step wider than the overlap
		// must never push the price past either number.
		const step = t.roundTo ?? 1;
		const rounded = Math.floor(half / step + 0.5) * step;
		return Math.min(maximum, Math.max(minimum, rounded));
	}
	return half;
}

/** Whether there is a deal (for OVERLAP_ONLY: whether the numbers overlap). The same condition for every rule. */
export function overlaps(p: { minimum: number; maximum: number }): boolean {
	return p.maximum >= p.minimum;
}

/** Whether a deal under this rule has a price. */
export function setsPrice(rule: Rule): boolean {
	return rule !== "OVERLAP_ONLY";
}

/**
 * How the rule works, said to one side (side is the reader's; other is the other side's name, e.g. "Anna" or
 * "the other side"). Says what a deal costs or brings the reader, and whose number a deal reveals.
 */
export function ruleText(t: RuleTerms, side: Side, other: string): string {
	const rule = t.rule;
	const pays = side === "PAYS";
	if (rule === "MIDPOINT_ROUNDED") {
		return `If your number reaches theirs, the price is halfway between them, rounded to ${stepText(t)}. You can each work out the other's number only roughly.`;
	}
	if (rule === "OVERLAP_ONLY") {
		return "Neutra only tells you both whether your numbers overlap. No price is set, and neither of you learns the other's number.";
	}
	if (rule === "RANDOM") {
		return "If your number reaches theirs, the price is a random point between the two numbers. Each of you learns only that the other's number is beyond the price.";
	}
	// Whether the reader's own number becomes the price: LOWEST for the receiver, HIGHEST for the payer.
	const ownNumberIsPrice = (rule === "LOWEST" && !pays) || (rule === "HIGHEST" && pays);
	if (rule === "MIDPOINT") {
		return "If your number reaches theirs, the price is halfway between them. You can then each work out the other's number.";
	}
	if (ownNumberIsPrice) {
		return pays
			? `If your number reaches ${other}'s, you pay exactly the number you give. Give your real maximum only if you're happy to pay it. ${other}'s number stays private.`
			: `If your number reaches ${other}'s, you get exactly the number you give. Give your real minimum only if you're happy to get just that. ${other}'s number stays private.`;
	}
	return pays
		? `If your number reaches ${other}'s, you pay ${other}'s minimum, never more. ${other} never learns your number.`
		: `If your number reaches ${other}'s, you get ${other}'s maximum, never less. ${other} never learns your number.`;
}

/** How many answers the person answering has, said to them. */
export function answersText(maxAnswers: number, side: Side): string {
	return maxAnswers === 1
		? `You have one answer, so give your real ${side === "PAYS" ? "maximum" : "minimum"}, not an opening offer.`
		: `You have ${maxAnswers} answers: after a "no deal" you can send another number.`;
}

/** How a deal's price is described in results: "halfway between your numbers". */
export function dealText(t: RuleTerms): string {
	if (t.rule === "LOWEST") return "the lowest price you both accept";
	if (t.rule === "HIGHEST") return "the highest price you both accept";
	if (t.rule === "MIDPOINT_ROUNDED") return `halfway, rounded to ${stepText(t)}`;
	if (t.rule === "RANDOM") return "a random point between your numbers";
	if (t.rule === "OVERLAP_ONLY") return "no price set: your numbers overlap";
	return "halfway between your numbers";
}

/** "CHF 50": the MIDPOINT_ROUNDED step. */
function stepText(t: RuleTerms): string {
	return formatAmount(t.roundTo ?? 1, t.currency);
}

/**
 * A caution for the starter: with several answers, the other side can move their number between tries wherever
 * their own number can set the price (always under MIDPOINT; under LOWEST if they receive, HIGHEST if they pay).
 */
export function starterCaution(rule: Rule, maxAnswers: number, starterSide: Side): string | undefined {
	if (maxAnswers === 1) return undefined;
	if (rule === "OVERLAP_ONLY") {
		// No price to move, but every "don't overlap" still tells the other side which side of your number theirs fell.
		return "With more than one answer, each \"don't overlap\" tells the other side that your number is beyond the one they sent, so they can narrow it down.";
	}
	const responderPays = starterSide === "RECEIVES";
	// Under the halfway and random rules both numbers move the price; under LOWEST or HIGHEST only one side's does.
	const theirNumberCounts =
		rule === "MIDPOINT" ||
		rule === "MIDPOINT_ROUNDED" ||
		rule === "RANDOM" ||
		(rule === "LOWEST" && !responderPays) ||
		(rule === "HIGHEST" && responderPays);
	if (!theirNumberCounts) return undefined;
	return responderPays
		? "With more than one answer, the other side can start low and raise their number."
		: "With more than one answer, the other side can start high and lower their number.";
}
