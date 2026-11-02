import { describe, expect, it } from "vitest";
import { formatRange, isValidTimeZone, parseTimestamp } from "../src/time";

describe("parseTimestamp", () => {
	it("reads timestamps with an offset as they are", () => {
		expect(parseTimestamp("2026-11-04T18:00:00+01:00")).toBe(Date.parse("2026-11-04T17:00:00Z"));
		expect(parseTimestamp("2026-11-04T17:00:00Z")).toBe(Date.parse("2026-11-04T17:00:00Z"));
	});

	it("reads local times in the given zone, in winter and in summer", () => {
		expect(parseTimestamp("2026-11-04T18:00", "Europe/Zurich")).toBe(Date.parse("2026-11-04T17:00:00Z"));
		expect(parseTimestamp("2026-07-01T18:00", "Europe/Zurich")).toBe(Date.parse("2026-07-01T16:00:00Z"));
		expect(parseTimestamp("2026-11-04T18:00", "America/New_York")).toBe(Date.parse("2026-11-04T23:00:00Z"));
	});

	it("handles the day daylight saving time ends", () => {
		// Zurich switches from +02:00 to +01:00 at 03:00 on 25 Oct 2026.
		expect(parseTimestamp("2026-10-25T12:00", "Europe/Zurich")).toBe(Date.parse("2026-10-25T11:00:00Z"));
		expect(parseTimestamp("2026-10-24T12:00", "Europe/Zurich")).toBe(Date.parse("2026-10-24T10:00:00Z"));
	});

	it("refuses a local time without a zone", () => {
		expect(parseTimestamp("2026-11-04T18:00")).toBeNull();
		expect(parseTimestamp("next Tuesday", "Europe/Zurich")).toBeNull();
	});
});

describe("time zones and formatting", () => {
	it("knows real zones", () => {
		expect(isValidTimeZone("Europe/Zurich")).toBe(true);
		expect(isValidTimeZone("Zurich")).toBe(false);
	});

	it("shows a range the way the person reads it", () => {
		const start = Date.parse("2026-11-04T17:00:00Z");
		const end = Date.parse("2026-11-04T20:00:00Z");
		expect(formatRange(start, end, "Europe/Zurich")).toBe("Wed 4 Nov, 18:00–21:00 (Europe/Zurich)");
		expect(formatRange(start, end)).toBe("Wed 4 Nov, 17:00–20:00 (UTC)");
	});
});
