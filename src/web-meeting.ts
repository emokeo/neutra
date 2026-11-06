// The web answer page for a meeting request: rows of day, from and to, checked as they're typed.
import { createAnswer, type Interval, MAX_ANSWERS } from "./decisions";
import { formatDay, isValidTimeZone } from "./time";
import { type AnswerKind, limitError, who } from "./web-kind";
import { durationText, isoDay, MAX_ROWS, readRows, type Row, rowsToWindows } from "./web-form";
import { esc, messagePage } from "./web-pages";

type MeetingAnswer = { windows: Interval[]; timeZone: string };
type MeetingValues = { rows: Row[]; timeZone?: string };

function rowHtml(row: Row, min: string, max: string): string {
	return `<div class="row">
<label class="day">Day<input type="date" name="day" value="${esc(row.day)}" min="${min}" max="${max}"></label>
<label>From<input type="time" name="from" value="${esc(row.from)}"></label>
<label>To<input type="time" name="to" value="${esc(row.to)}"></label>
<button type="button" class="rm" aria-label="Remove this time" hidden>×</button>
</div>`;
}

// Fills in the browser's time zone, adds rows, shows whether the times are enough before sending,
// and stops a double click from sending two tries.
const SCRIPT = `(() => {
  const form = document.getElementById("answer");
  const zone = form.elements.namedItem("tz");
  try { if (!zone.value) zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
  const add = document.getElementById("add");
  const rows = document.getElementById("rows");
  add.hidden = false;
  rows.querySelectorAll(".rm").forEach((button) => { button.hidden = false; });
  add.addEventListener("click", () => {
    if (rows.children.length >= ${MAX_ROWS}) return;
    const row = rows.lastElementChild.cloneNode(true);
    row.querySelectorAll("input").forEach((input) => { input.value = ""; });
    rows.append(row);
    row.querySelector("input").focus();
    update();
  });
  // Remove a row; the last one is cleared instead, so there's always one to fill in.
  rows.addEventListener("click", (event) => {
    const button = event.target.closest(".rm");
    if (!button) return;
    const row = button.closest(".row");
    if (rows.children.length > 1) row.remove();
    else row.querySelectorAll("input").forEach((input) => { input.value = ""; });
    update();
  });
  // The same rule as Neutra's: only time from an hour from now to 30 days ahead counts, in pieces at
  // least as long as the meeting, and overlapping or repeated times count once. Times are read in this
  // browser's time zone, the one the answer is sent with.
  const meeting = Number(form.dataset.meeting);
  const status = document.getElementById("enough");
  const text = (m) => { const h = Math.floor(m / 60), r = Math.round(m % 60); return [h ? h + (h === 1 ? " hour" : " hours") : "", r ? r + " min" : ""].filter(Boolean).join(" ") || "0 min"; };
  const check = () => {
    const from0 = Date.now() + 60 * 60 * 1000, to0 = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const spans = [];
    let n = 0, problem = "";
    for (const row of rows.children) {
      n++;
      const [day, from, to] = row.querySelectorAll("input");
      if (!day.value || !from.value || !to.value) continue;
      const f = from.value.slice(0, 5), t = to.value.slice(0, 5);
      if (t <= f && t !== "00:00") { problem = problem || "Time " + n + " ends before it starts."; continue; }
      let start = new Date(day.value + "T" + f).getTime();
      let end = new Date(day.value + "T" + t).getTime();
      if (t === "00:00") end += 24 * 60 * 60 * 1000;
      start = Math.max(start, from0); end = Math.min(end, to0);
      if (end - start >= meeting * 60 * 1000) spans.push([start, end]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let total = 0, reach = -Infinity;
    for (const [start, end] of spans) {
      if (end <= reach) continue;
      total += end - Math.max(start, reach);
      reach = end;
    }
    return { total: total / 60000, problem };
  };
  const update = () => {
    const { total, problem } = check();
    const ok = !problem && total >= 2 * meeting;
    status.textContent = problem
      ? problem + " For a time past midnight, add the next day as its own time."
      : ok
        ? "Added: " + text(total) + ". Enough to send."
        : "Added so far: " + text(total) + ". Add at least " + text(2 * meeting) + " in total, each time at least " + text(meeting) + " long and starting an hour from now or later. Times that overlap count once.";
    status.className = ok ? "muted" : "hint";
    return ok;
  };
  rows.addEventListener("input", update);
  update();
  form.addEventListener("submit", (event) => {
    if (!update()) { event.preventDefault(); status.className = "error"; status.focus(); return; }
    const send = form.querySelector("[type=submit]");
    setTimeout(() => { send.disabled = true; send.textContent = "Sending…"; }, 0);
  });
})();`;


export const meetingKind: AnswerKind<MeetingAnswer, MeetingValues> = {
	invitation: (info, timeZone) => ({
		title: `${info.starterFirstName} would like to meet you`,
		detail: durationText(info.durationSeconds),
		answerBy: formatDay(info.answerBy, timeZone),
	}),
	intro: (info) => `Add the times you're free. ${who(info)} won't see them: if a time fits, you both get one calendar invite.`,
	signInNote: "Neutra gets only your name and email from Google, to send you the invite.",
	expiredNote: "Your sign-in expired before you sent your times. Sign in again and add them once more.",
	addressNote: "The invite goes to this address.",
	again: "If you still want to meet",
	ownRequest: "Send the link to the person you want to meet: they answer it, not you.",

	// After an answer that didn't fit: say so above the form. Neither side learns anything about the other's times.
	notice: (info) =>
		info.viewer === "responder" && info.remainingAttempts < MAX_ANSWERS
			? `No time fits yet: none of your times overlap with ${info.starterFirstName}'s. Try again with more times (${info.remainingAttempts} ${info.remainingAttempts === 1 ? "try" : "tries"} left).`
			: undefined,

	form(info, values, { timeZone, zone, now }) {
		const empty = { day: "", from: "", to: "" };
		const rows = values?.rows.length ? values.rows : [empty, empty, empty];
		const minDay = isoDay(now, zone);
		// 29, not 30: Neutra refuses times starting more than 30 days from now, and the last day's evening would be past that.
		const maxDay = isoDay(now + 29 * 24 * 60 * 60 * 1000, zone);
		return {
			attributes: ` data-meeting="${Math.round(info.durationSeconds / 60)}"`,
			// Empty on the first visit: the page fills in the browser's own time zone.
			fields: `<p>When are you free? Add each time that works, at least ${esc(durationText(2 * info.durationSeconds))} in total. ${who(info)} won't see your times.</p>
<div id="rows">
${rows.map((row) => rowHtml(row, minDay, maxDay)).join("\n")}
</div>
<p class="hint">Past midnight? Add the next day as its own time.</p>
<button type="button" id="add" hidden>+ Add another time</button>
<input type="hidden" name="tz" value="${esc(timeZone ?? "")}">
<p id="enough" class="muted" tabindex="-1" aria-live="polite"></p>`,
			script: SCRIPT,
		};
	},

	read(form, _info, zone) {
		const rows = readRows(form);
		const tz = form.get("tz");
		const timeZone = typeof tz === "string" && isValidTimeZone(tz) ? tz : zone;
		const windows = rowsToWindows(rows);
		if ("error" in windows) return { error: windows.error, values: { rows, timeZone } };
		return { answer: { windows: windows.windows, timeZone }, values: { rows, timeZone } };
	},

	send: (env, caller, code, answer) => createAnswer(env, caller, { code, windows: answer.windows, timeZone: answer.timeZone }),

	failed(error, info, token) {
		if (error.reason === "TOO_NARROW") {
			return {
				error: `Add more times: together at least ${durationText(2 * info.durationSeconds)}, each at least ${durationText(info.durationSeconds)} long and starting an hour from now or later.`,
			};
		}
		if (error.reason === "OUT_OF_RANGE") {
			return { error: "One of your times has already passed or is more than 30 days ahead. Check the days and try again." };
		}
		if (error.reason === "UNCONFIRMED") {
			return messagePage(
				"Neutra couldn't confirm the invite",
				`<p>A time may have been found, but the invite didn't confirm. Look for an invite from neutra.invites@gmail.com in the next 20 minutes. If none comes, <a href="/a/${token}">open this request again</a>: it will be open for another try.</p>`,
				502,
			);
		}
		const limited = limitError(error, info);
		if (limited) return limited;
		if (error.code === "INVALID_ARGUMENT") return { error: "Neutra couldn't read these times. Check each day and time and try again." };
		return null;
	},

	result(info, signedIn) {
		if (info.pending) {
			return messagePage(
				"Almost there",
				`<p>An answer to this request is being processed, and the invite may be on its way. Look for an email from neutra.invites@gmail.com, or open this link again in a few minutes.</p>`,
			);
		}
		if (info.state === "INVITE_SENT" || info.state === "ACCEPTED" || info.state === "DECLINED") {
			if (info.viewer === "responder" && signedIn && info.scheduledTimeLocal) {
				return messagePage(
					"A time fits",
					`<p><strong>${esc(info.scheduledTimeLocal)}</strong></p><p>You and ${who(info)} both get a calendar invite from neutra.invites@gmail.com (yours goes to ${esc(signedIn.email)}). Accept it to confirm.</p>`,
				);
			}
			return messagePage(
				"This request already has a time",
				`<p>If you answered it, look for the calendar invite from neutra.invites@gmail.com.</p>`,
			);
		}
		if (info.state === "NO_MATCH" && info.viewer === "responder") {
			return messagePage(
				"No time fits",
				`<p>None of your times overlapped with ${who(info)}'s, and there are no tries left. ${who(info)} gets an email that no time was found and can send you a new request.</p>`,
			);
		}
		return null;
	},
};

