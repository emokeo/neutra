// Time zones: agents may send local times plus an IANA time zone, and get back what Neutra understood.

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone });
		return true;
	} catch {
		return false;
	}
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(instant));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Parses a timestamp: either RFC 3339 with an offset, or a local time ("2026-11-04T18:00")
 * read in the given IANA time zone. Returns milliseconds, or null if it can't be read.
 */
export function parseTimestamp(value: string, timeZone?: string): number | null {
	if (WITH_OFFSET.test(value)) {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? null : ms;
	}
	const m = LOCAL.exec(value);
	if (!m || !timeZone) return null;
	const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
	// Correct twice, so times right after a daylight-saving change land on the right side.
	let instant = wall - offsetAt(wall, timeZone);
	instant = wall - offsetAt(instant, timeZone);
	return instant;
}

/** "Wed 4 Nov, 18:00–21:00 (Europe/Zurich)", in the given zone (UTC if none). */
export function formatRange(start: number, end: number, timeZone = "UTC"): string {
	const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" });
	const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	const startDay = day.format(start).replace(",", "");
	const endDay = day.format(end).replace(",", "");
	const endText = startDay === endDay ? time.format(end) : `${endDay}, ${time.format(end)}`;
	return `${startDay}, ${time.format(start)}–${endText} (${timeZone})`;
}

/** "Thu 5 Nov", in the given zone (UTC if none). */
export function formatDay(instant: number, timeZone = "UTC"): string {
	return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" })
		.format(instant)
		.replace(",", "");
}
