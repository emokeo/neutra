import { describe, expect, it } from "vitest";
import { formatAmount, midpoint, minorDigits, overlapOf, parseAmount, parseLimit, plainAmount, splitRange } from "../src/money";
import { sealLimit, unsealLimit } from "../src/seal";

describe("currencies", () => {
	it("knows how many decimals each currency has, in any case", () => {
		expect(minorDigits("CHF")).toBe(2);
		expect(minorDigits("chf")).toBe(2);
		expect(minorDigits("JPY")).toBe(0);
		expect(minorDigits("KWD")).toBe(3);
	});

	it("refuses what isn't an ISO 4217 code, saying what to send", () => {
		expect(() => minorDigits("Fr.")).toThrow('"Fr." isn\'t an ISO 4217 currency code. Use e.g. "CHF", "EUR", "USD".');
		expect(() => minorDigits("XYZ")).toThrow("isn't an ISO 4217 currency code");
	});
});

describe("parseAmount", () => {
	it("reads plain amounts into smallest units without floating point", () => {
		expect(parseAmount("1850", "CHF")).toBe(185000);
		expect(parseAmount(" 1850.50 ", "CHF")).toBe(185050);
		expect(parseAmount("1850.5", "CHF")).toBe(185050);
		expect(parseAmount(1850, "CHF")).toBe(185000);
		expect(parseAmount(1850.5, "CHF")).toBe(185050);
		expect(parseAmount("1500", "JPY")).toBe(1500);
		expect(parseAmount("1.234", "KWD")).toBe(1234);
	});

	it("refuses separators, symbols, exponents, signs and zero", () => {
		for (const value of ["1'850", "1,850", "1 850", "CHF 1850", "1e3", "-5", ".5", "1850."]) {
			expect(() => parseAmount(value, "CHF")).toThrow("isn't a plain amount. Send digits with an optional dot");
		}
		expect(() => parseAmount(1e21, "CHF")).toThrow("isn't a plain amount");
		expect(() => parseAmount(-5, "CHF")).toThrow("isn't a plain amount");
		expect(() => parseAmount("0", "CHF")).toThrow("more than 0");
		expect(() => parseAmount(0, "CHF")).toThrow("more than 0");
	});

	it("refuses more decimals than the currency has", () => {
		expect(() => parseAmount("1500.50", "JPY")).toThrow('JPY takes no decimals; got "1500.50".');
		expect(() => parseAmount("1850.505", "CHF")).toThrow("CHF takes at most 2 decimals");
		expect(() => parseAmount(0.1 + 0.2, "CHF")).toThrow("CHF takes at most 2 decimals");
		// Not even trailing zeros: "1.700" in francs most likely means one thousand seven hundred.
		expect(() => parseAmount("1850.500", "CHF")).toThrow("CHF takes at most 2 decimals");
		expect(() => parseAmount("1.700", "CHF")).toThrow('CHF takes at most 2 decimals; got "1.700". If you meant 1700, send "1700".');
		expect(() => parseAmount("1.500", "JPY")).toThrow('JPY takes no decimals; got "1.500". If you meant 1500, send "1500".');
		expect(parseAmount("1.700", "KWD")).toBe(1700);
	});

	it("caps amounts at 10^13 smallest units", () => {
		expect(parseAmount("100000000000", "CHF")).toBe(10 ** 13);
		expect(() => parseAmount("100000000000.01", "CHF")).toThrow("more than Neutra can handle");
	});
});

describe("ranges", () => {
	it("are split on a dash, an en or em dash, or 'to'", () => {
		for (const text of ["10000-20000", "10000 - 20000", "10000 to 20000", "10000–20000", "10000 — 20000"]) {
			expect(splitRange(text)).toEqual(["10000", "20000"]);
		}
		expect(splitRange("1700")).toBeNull();
		expect(splitRange("1700.-")).toBeNull();
		expect(splitRange("-5")).toBeNull();
	});

	it("keep both ends; a single number leaves the far end open", () => {
		expect(parseLimit("10000-20000", "CHF", "PAYS")).toEqual({ low: 1000000, high: 2000000, isRange: true });
		expect(parseLimit("10000 to 20000", "CHF", "RECEIVES")).toEqual({ low: 1000000, high: 2000000, isRange: true });
		expect(parseLimit("1850", "CHF", "PAYS")).toEqual({ low: 0, high: 185000, isRange: false });
		expect(parseLimit("1850", "CHF", "RECEIVES")).toEqual({ low: 185000, high: Infinity, isRange: false });
	});

	it("meet where both sides accept, or not at all", () => {
		const payer = (low: number, high: number) => ({ low, high });
		// Single numbers: from the receiver's minimum to the payer's maximum, as before.
		expect(overlapOf(payer(0, 1850), payer(1700, Infinity))).toEqual({ minimum: 1700, maximum: 1850 });
		expect(overlapOf(payer(0, 1600), payer(1700, Infinity))).toBeNull();
		// Nested: the payer's band lies inside the receiver's.
		expect(overlapOf(payer(1750, 1800), payer(1700, 1900))).toEqual({ minimum: 1750, maximum: 1800 });
		// Touching ends: a deal at exactly that price.
		expect(overlapOf(payer(1500, 1700), payer(1700, 1900))).toEqual({ minimum: 1700, maximum: 1700 });
		// The payer's floor above the receiver's minimum raises the low end.
		expect(overlapOf(payer(1800, 2000), payer(1700, Infinity))).toEqual({ minimum: 1800, maximum: 2000 });
		// The receiver's ceiling below the payer's maximum lowers the high end.
		expect(overlapOf(payer(0, 2000), payer(1700, 1900))).toEqual({ minimum: 1700, maximum: 1900 });
		// Disjoint.
		expect(overlapOf(payer(2000, 2100), payer(1700, 1900))).toBeNull();
	});

	it("are refused when reversed or equal, or when an end isn't a plain amount", () => {
		expect(() => parseLimit("20000-10000", "CHF", "PAYS")).toThrow('The range "20000-10000" goes from high to low. Send the lower number first');
		expect(() => parseLimit("10000-10000", "CHF", "PAYS")).toThrow("has the same number at both ends");
		expect(() => parseLimit("10'000-20000", "CHF", "PAYS")).toThrow("isn't a plain amount");
	});
});

describe("formatAmount", () => {
	it("shows amounts the way people write them", () => {
		expect(formatAmount(177500, "CHF", "per month")).toBe("CHF 1,775 per month");
		expect(formatAmount(177550, "CHF")).toBe("CHF 1,775.50");
		expect(formatAmount(177500, "CHF", undefined, false)).toBe("CHF 1,775.00");
		expect(formatAmount(150000, "JPY")).toBe("JPY 150,000");
		expect(formatAmount(1234, "KWD")).toBe("KWD 1.234");
		expect(plainAmount(177550, "CHF")).toBe("1775.50");
		expect(plainAmount(1500, "JPY")).toBe("1500");
	});
});

describe("midpoint", () => {
	it("is a deal at the halfway price when the payer's maximum reaches the receiver's minimum", () => {
		expect(midpoint(170000, 185000, "CHF")).toEqual({ deal: true, price: 177500 });
		expect(midpoint(180000, 180000, "CHF")).toEqual({ deal: true, price: 180000 });
		expect(midpoint(185000, 170000, "CHF")).toEqual({ deal: false });
	});

	it("rounds half a cent up, and keeps whole amounts whole", () => {
		expect(midpoint(170001, 170002, "CHF")).toEqual({ deal: true, price: 170002 });
		// 1700 and 1851 francs: halfway is 1775.50, but both said whole francs, so 1776.
		expect(midpoint(170000, 185100, "CHF")).toEqual({ deal: true, price: 177600 });
		expect(midpoint(170050, 185100, "CHF")).toEqual({ deal: true, price: 177575 });
		expect(midpoint(1700, 1701, "JPY")).toEqual({ deal: true, price: 1701 });
	});
});

describe("sealed limits", () => {
	it("open only with the same code and request", async () => {
		const sealed = await sealLimit(185000, "abcdefghijkl", "decision1");
		expect(sealed).not.toContain("185000");
		expect(await unsealLimit(sealed, "abcdefghijkl", "decision1")).toBe(185000);
		await expect(unsealLimit(sealed, "bbcdefghijkl", "decision1")).rejects.toBeTruthy();
		await expect(unsealLimit(sealed, "abcdefghijkl", "decision2")).rejects.toBeTruthy();
	});

	it("differ every time, so equal limits don't look equal", async () => {
		expect(await sealLimit(185000, "abcdefghijkl", "decision1")).not.toBe(await sealLimit(185000, "abcdefghijkl", "decision1"));
	});
});
