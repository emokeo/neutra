import { afterEach, describe, expect, it } from "vitest";
import { overlapOf } from "../src/money";
import { answersText, cryptoRandomBelow, dealPrice, dealText, defaultStep, ruleText, starterCaution } from "../src/price-rules";

const chf = (rule: "MIDPOINT" | "LOWEST" | "HIGHEST" | "MIDPOINT_ROUNDED" | "RANDOM", roundTo?: number) => ({ rule, currency: "CHF", roundTo });
// Amounts in rappen: 170000 is CHF 1,700.
const deal = { minimum: 170000, maximum: 185100 };

describe("deal prices", () => {
	it("are halfway, the lowest or the highest point of the overlap", () => {
		expect(dealPrice(chf("MIDPOINT"), deal)).toBe(177600);
		expect(dealPrice(chf("LOWEST"), deal)).toBe(170000);
		expect(dealPrice(chf("HIGHEST"), deal)).toBe(185100);
		// OVERLAP_ONLY sets no price, even when the numbers overlap.
		expect(dealPrice({ rule: "OVERLAP_ONLY", currency: "CHF" }, deal)).toBeNull();
		for (const rule of ["MIDPOINT", "LOWEST", "HIGHEST", "MIDPOINT_ROUNDED", "RANDOM"] as const) {
			expect(dealPrice(chf(rule, 5000), { minimum: 185100, maximum: 170000 })).toBeNull();
		}
	});

	it("round halfway to the step, and never leave the overlap", () => {
		// Halfway is 1775.50; to the nearest 50 that is 1800.
		expect(dealPrice(chf("MIDPOINT_ROUNDED", 5000), deal)).toBe(180000);
		// A tiny overlap, 1701 to 1702: rounding to 50 would give 1700, below the receiver's minimum.
		expect(dealPrice(chf("MIDPOINT_ROUNDED", 5000), { minimum: 170100, maximum: 170200 })).toBe(170100);
		// A step far wider than the overlap: clamped to the payer's maximum.
		expect(dealPrice(chf("MIDPOINT_ROUNDED", 100000), { minimum: 155000, maximum: 160000 })).toBe(160000);
		// Equal numbers stay exactly that.
		expect(dealPrice(chf("MIDPOINT_ROUNDED", 5000), { minimum: 177700, maximum: 177700 })).toBe(177700);
	});

	it("pick a random point inside the overlap, in whole francs when both numbers are whole", () => {
		const seen = new Set<number>();
		for (let i = 0; i < 500; i++) {
			const price = dealPrice(chf("RANDOM"), { minimum: 170000, maximum: 170500 }) as number;
			expect(price).toBeGreaterThanOrEqual(170000);
			expect(price).toBeLessThanOrEqual(170500);
			expect(price % 100).toBe(0);
			seen.add(price);
		}
		// 1700 to 1705 is six whole francs; 500 draws reach all of them.
		expect(seen.size).toBe(6);
		// With cents in a number, any cent in the overlap.
		for (let i = 0; i < 200; i++) {
			const price = dealPrice(chf("RANDOM"), { minimum: 170050, maximum: 170060 }) as number;
			expect(price).toBeGreaterThanOrEqual(170050);
			expect(price).toBeLessThanOrEqual(170060);
		}
	});

	it("are deterministic with a stubbed random source, and never use Math.random", () => {
		const real = Math.random;
		Math.random = () => {
			throw new Error("Math.random must not be used");
		};
		try {
			expect(dealPrice(chf("RANDOM"), deal, () => 0)).toBe(170000);
			expect(dealPrice(chf("RANDOM"), deal, (n) => n - 1)).toBe(185100);
			expect(dealPrice(chf("RANDOM"), deal, () => 42)).toBe(170000 + 42 * 100);
			expect(cryptoRandomBelow(1)).toBe(0);
			expect(cryptoRandomBelow(10)).toBeLessThan(10);
		} finally {
			Math.random = real;
		}
	});
});

describe("deal prices with ranges", () => {
	it("land inside where the two ranges meet, for every rule", () => {
		// Payer band CHF 1,750–1,800 inside the receiver's range CHF 1,700–1,900: they meet from 1,750 to 1,800.
		const overlap = overlapOf({ low: 175000, high: 180000 }, { low: 170000, high: 190000 })!;
		expect(dealPrice(chf("LOWEST"), overlap)).toBe(175000);
		expect(dealPrice(chf("HIGHEST"), overlap)).toBe(180000);
		expect(dealPrice(chf("MIDPOINT"), overlap)).toBe(177500);
		expect(dealPrice(chf("MIDPOINT_ROUNDED", 10000), overlap)).toBe(180000);
		expect(dealPrice(chf("MIDPOINT_ROUNDED", 100000), overlap)).toBe(180000);
		for (let i = 0; i < 100; i++) {
			const price = dealPrice(chf("RANDOM"), overlap) as number;
			expect(price >= 175000 && price <= 180000).toBe(true);
		}
		expect(dealPrice({ rule: "OVERLAP_ONLY", currency: "CHF" }, overlap)).toBeNull();
		// Touching ends: every price rule lands on that one price.
		const touch = overlapOf({ low: 150000, high: 170000 }, { low: 170000, high: 190000 })!;
		for (const rule of ["MIDPOINT", "LOWEST", "HIGHEST", "RANDOM"] as const) expect(dealPrice(chf(rule), touch)).toBe(170000);
		expect(dealPrice(chf("MIDPOINT_ROUNDED", 5000), touch)).toBe(170000);
	});
});

describe("the default step", () => {
	it("is about 1% of the starter's number, as 1, 2 or 5 times a power of ten, at least one whole unit", () => {
		expect(defaultStep(185000, "CHF")).toBe(1000); // CHF 1,850 → CHF 10
		expect(defaultStep(185000000, "CHF")).toBe(1000000); // CHF 1,850,000 → CHF 10,000
		expect(defaultStep(300000, "CHF")).toBe(2000); // CHF 3,000 → CHF 20
		expect(defaultStep(700000, "CHF")).toBe(5000); // CHF 7,000 → CHF 50
		expect(defaultStep(5000, "CHF")).toBe(100); // CHF 50 → CHF 1
		expect(defaultStep(150000, "JPY")).toBe(1000); // JPY 150,000 → JPY 1,000
		expect(defaultStep(40, "JPY")).toBe(1);
	});
});

describe("the rules in plain words", () => {
	afterEach(() => {});
	it("say what a deal costs or brings the reader, and whose number it reveals", () => {
		expect(ruleText(chf("MIDPOINT"), "PAYS", "Anna")).toBe(
			"If your number reaches theirs, the price is halfway between them. You can then each work out the other's number.",
		);
		expect(ruleText(chf("LOWEST"), "PAYS", "Anna")).toBe(
			"If your number reaches Anna's, you pay the lowest price you both accept, never more than your number. Anna never learns how high you'd go.",
		);
		expect(ruleText(chf("LOWEST"), "RECEIVES", "Anna")).toBe(
			"If your number reaches Anna's, you get the lowest price you both accept, which can be exactly your number. Give your real minimum only if you're happy to get just that. Anna's highest price stays private.",
		);
		expect(ruleText(chf("HIGHEST"), "PAYS", "Anna")).toBe(
			"If your number reaches Anna's, you pay the highest price you both accept, which can be exactly your number. Give your real maximum only if you're happy to pay it. Anna's lowest price stays private.",
		);
		expect(ruleText(chf("HIGHEST"), "RECEIVES", "Anna")).toBe(
			"If your number reaches Anna's, you get the highest price you both accept, never less than your number. Anna never learns how low you'd go.",
		);
		expect(ruleText(chf("MIDPOINT_ROUNDED", 5000), "PAYS", "Anna")).toBe(
			"If your number reaches theirs, the price is halfway between them, rounded to CHF 50. You can each work out the other's number only roughly.",
		);
		expect(ruleText(chf("RANDOM"), "RECEIVES", "Anna")).toBe(
			"If your number reaches theirs, the price is a random point between the two numbers. Each of you learns only that the other's number is beyond the price.",
		);
	});

	it("name the rule in results", () => {
		expect(dealText(chf("MIDPOINT"))).toBe("halfway between your numbers");
		expect(dealText(chf("LOWEST"))).toBe("the lowest price you both accept");
		expect(dealText(chf("HIGHEST"))).toBe("the highest price you both accept");
		expect(dealText(chf("MIDPOINT_ROUNDED", 5000))).toBe("halfway, rounded to CHF 50");
		expect(dealText(chf("RANDOM"))).toBe("a random point between your numbers");
	});

	it("say how many answers there are", () => {
		expect(answersText(1, "PAYS")).toBe("You have one answer, so give your real maximum, not an opening offer.");
		expect(answersText(3, "RECEIVES")).toBe('You have 3 answers: after a "no deal" you can send another number.');
	});

	it("warn the starter where several answers let the other side move a number that sets the price", () => {
		expect(starterCaution("MIDPOINT", 1, "RECEIVES")).toBeUndefined();
		expect(starterCaution("MIDPOINT", 2, "RECEIVES")).toBe("With more than one answer, the other side can start low and raise their number.");
		expect(starterCaution("RANDOM", 3, "PAYS")).toBe("With more than one answer, the other side can start high and lower their number.");
		// The other side pays; under LOWEST the price is the starter's minimum, so their number never sets it.
		expect(starterCaution("LOWEST", 3, "RECEIVES")).toBeUndefined();
		expect(starterCaution("HIGHEST", 3, "RECEIVES")).toBe("With more than one answer, the other side can start low and raise their number.");
		expect(starterCaution("LOWEST", 2, "PAYS")).toBe("With more than one answer, the other side can start high and lower their number.");
		expect(starterCaution("OVERLAP_ONLY", 1, "PAYS")).toBeUndefined();
		expect(starterCaution("OVERLAP_ONLY", 3, "PAYS")).toBe(
			'With more than one answer, each "don\'t overlap" tells the other side that your number is beyond the one they sent, so they can narrow it down.',
		);
	});
});
