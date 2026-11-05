// The web answer form: rows of day, from and to, turned into the windows create_answer takes.
import type { Interval } from "./decisions";

export type Row = { day: string; from: string; to: string };

export const MAX_ROWS = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?$/;

function text(value: FormDataEntryValue | undefined): string {
	return typeof value === "string" ? value.trim() : "";
}

/** The rows as submitted. Each row has all three inputs, so the lists line up. */
export function readRows(form: FormData): Row[] {
	const days = form.getAll("day");
	const froms = form.getAll("from");
	const tos = form.getAll("to");
	const count = Math.min(Math.max(days.length, froms.length, tos.length), MAX_ROWS);
	return Array.from({ length: count }, (_, i) => ({ day: text(days[i]), from: text(froms[i]), to: text(tos[i]) }));
}

function nextDay(day: string): string {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Local windows ("2026-11-10T18:00") for the filled rows, or what to fix, said for a person. */
export function rowsToWindows(rows: Row[]): { windows: Interval[] } | { error: string } {
	const windows: Interval[] = [];
	let n = 0;
	for (const row of rows) {
		n++;
		if (!row.day && !row.from && !row.to) continue;
		if (!row.day || !row.from || !row.to) return { error: `Fill in the day, from and to for time ${n}.` };
		if (!DAY.test(row.day) || !TIME.test(row.from) || !TIME.test(row.to)) {
			return { error: `Time ${n} has a day or time Neutra can't read. Pick it again.` };
		}
		const from = row.from.slice(0, 5);
		const to = row.to.slice(0, 5);
		let endDay = row.day;
		if (to <= from) {
			// "to 00:00" means until midnight.
			if (to !== "00:00") return { error: `Time ${n} ends before it starts. For a time past midnight, add the next day as its own time.` };
			endDay = nextDay(row.day);
		}
		windows.push({ startTime: `${row.day}T${from}`, endTime: `${endDay}T${to}` });
	}
	if (windows.length === 0) return { error: "Add at least one time when you're free." };
	return { windows };
}

/** "1 hour", "30 minutes", "1 hour 30 minutes". */
export function durationText(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	return [hours ? `${hours} ${hours === 1 ? "hour" : "hours"}` : "", minutes ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : ""]
		.filter(Boolean)
		.join(" ");
}

/** "2026-11-05" for an instant, in the given time zone. */
export function isoDay(instant: number, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
