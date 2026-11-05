// The web answer page, for people without an AI assistant: sign in with Google, add the times you're free, send.
// Deliberately bare: one form, plain messages.
import { MAX_ROWS, type Row } from "./web-form";

export function esc(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
body { font: 16px/1.5 system-ui, sans-serif; max-width: 480px; margin: 32px auto; padding: 0 16px; color: #1a1a1a; background: #fff; }
a { color: #0f5f5a; } h1 { font-size: 1.5rem; line-height: 1.2; } .muted { color: #5c5c5c; font-size: 0.9rem; }
.error { color: #b42318; font-weight: 600; } .hint { color: #5c5c5c; font-size: 0.9rem; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding-bottom: 12px; margin-bottom: 12px; border-bottom: 1px solid #e4e4e0; }
.row .day { grid-column: 1 / -1; }
.row label { display: flex; flex-direction: column; font-size: 12px; color: #5c5c5c; }
input { min-height: 44px; font: inherit; font-size: 16px; padding: 0 6px; border: 1px solid #cfcfcb; border-radius: 8px; width: 100%; box-sizing: border-box; }
.button { display: block; width: 100%; min-height: 50px; border: none; border-radius: 12px; background: #0f5f5a; color: #fff; font: inherit;
  font-weight: 700; text-align: center; line-height: 50px; text-decoration: none; cursor: pointer; margin: 16px 0 8px; }
#add { background: none; border: 1px dashed #0f5f5a; color: #0f5f5a; border-radius: 8px; min-height: 40px; padding: 0 12px; font: inherit; cursor: pointer; }
@media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #141414; } a { color: #6cc4bb; } .muted, .row label { color: #a8a8a8; } .row { border-color: #333; }
  input { background: #1f1f1f; color: #e8e8e8; border-color: #555; } .error { color: #f97066; } #add { color: #6cc4bb; border-color: #6cc4bb; } }
`;

/**
 * No caching, no framing, scripts only with the nonce. The address holds the code, so it never goes to other
 * sites as a referrer ("same-origin": "no-referrer" would also make browsers send "Origin: null" with the form,
 * which the cross-site check then refuses).
 */
function shell(title: string, body: string, opts: { status?: number; nonce?: string; script?: string } = {}): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
<p class="muted"><a href="/">What is Neutra?</a> · <a href="/privacy">Privacy</a></p>
${opts.script && opts.nonce ? `<script nonce="${opts.nonce}">${opts.script}</script>` : ""}
</body>
</html>`;
	return new Response(html, {
		status: opts.status ?? 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Referrer-Policy": "same-origin",
			"X-Robots-Tag": "noindex",
			"Content-Security-Policy": `default-src 'none'; script-src ${opts.nonce ? `'nonce-${opts.nonce}'` : "'none'"}; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
		},
	});
}

export type Invitation = { starterFirstName: string; duration: string; answerBy: string };

function heading(r: Invitation): string {
	return `<h1>${esc(r.starterFirstName)} would like to meet you</h1>
<p class="muted">${esc(r.duration)} · answer by ${esc(r.answerBy)}</p>`;
}

/** Before sign-in: what this is, and one button. */
export function introPage(r: Invitation, token: string, expired = false): Response {
	return shell(
		`${r.starterFirstName} would like to meet you`,
		`${heading(r)}
${expired ? `<p class="error" role="alert">Your sign-in expired before you sent your times. Sign in again and add them once more.</p>` : ""}
<p>Add the times you're free. ${esc(r.starterFirstName)} won't see them: if a time fits, you both get one calendar invite.</p>
<a class="button" href="/a/${token}/signin">Continue with Google</a>
<p class="muted">Neutra gets only your name and email from Google, to send you the invite.</p>`,
	);
}

function rowHtml(row: Row, min: string, max: string): string {
	return `<div class="row">
<label class="day">Day<input type="date" name="day" value="${esc(row.day)}" min="${min}" max="${max}"></label>
<label>From<input type="time" name="from" value="${esc(row.from)}"></label>
<label>To<input type="time" name="to" value="${esc(row.to)}"></label>
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
  add.addEventListener("click", () => {
    if (rows.children.length >= ${MAX_ROWS}) return;
    const row = rows.lastElementChild.cloneNode(true);
    row.querySelectorAll("input").forEach((input) => { input.value = ""; });
    rows.append(row);
  });
  // The same rule as Neutra's: times shorter than the meeting don't count, and overlapping
  // or repeated times count once. Past times still count here, so the server stays the stricter check.
  const meeting = Number(form.dataset.meeting);
  const status = document.getElementById("enough");
  const text = (m) => { const h = Math.floor(m / 60), r = m % 60; return [h ? h + (h === 1 ? " hour" : " hours") : "", r ? r + " min" : ""].filter(Boolean).join(" ") || "0 min"; };
  const covered = () => {
    const spans = [];
    for (const row of rows.children) {
      const [day, from, to] = row.querySelectorAll("input");
      if (!day.value || !from.value || !to.value) continue;
      const start = Date.parse(day.value + "T" + from.value.slice(0, 5) + "Z");
      let end = Date.parse(day.value + "T" + to.value.slice(0, 5) + "Z");
      if (to.value.slice(0, 5) === "00:00") end += 24 * 60 * 60 * 1000;
      if (end - start >= meeting * 60 * 1000) spans.push([start, end]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let total = 0, reach = -Infinity;
    for (const [start, end] of spans) {
      if (end <= reach) continue;
      total += end - Math.max(start, reach);
      reach = end;
    }
    return total / 60000;
  };
  const update = () => {
    const total = covered();
    const ok = total >= 2 * meeting;
    status.textContent = ok
      ? "Added: " + text(total) + ". Enough to send."
      : "Added so far: " + text(total) + ". Add at least " + text(2 * meeting) + " in total, each time at least " + text(meeting) + " long. Times that overlap count once.";
    status.className = ok ? "muted" : "hint";
    return ok;
  };
  rows.addEventListener("input", update);
  add.addEventListener("click", update);
  update();
  form.addEventListener("submit", (event) => {
    if (!update()) { event.preventDefault(); status.className = "error"; status.focus(); return; }
    const send = form.querySelector("[type=submit]");
    setTimeout(() => { send.disabled = true; send.textContent = "Sending…"; }, 0);
  });
})();`;

/** The answer form: rows of day, from and to. */
export function formPage(
	r: Invitation,
	p: {
		token: string;
		email: string;
		rows: Row[];
		timeZone?: string;
		minDay: string;
		maxDay: string;
		minimum: string;
		meetingMinutes: number;
		notice?: string;
		error?: string;
		status?: number;
	},
): Response {
	const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
	const empty = { day: "", from: "", to: "" };
	const rows = p.rows.length ? p.rows : [empty, empty, empty];
	return shell(
		`${r.starterFirstName} would like to meet you`,
		`${heading(r)}
${p.notice ? `<p><strong>${esc(p.notice)}</strong></p>` : ""}
${p.error ? `<p class="error" role="alert">${esc(p.error)}</p>` : ""}
<form id="answer" method="post" action="/a/${p.token}" data-meeting="${Math.round(p.meetingMinutes)}">
<p>When are you free? Add each time that works, at least ${esc(p.minimum)} in total. ${esc(r.starterFirstName)} won't see your times.</p>
<div id="rows">
${rows.map((row) => rowHtml(row, p.minDay, p.maxDay)).join("\n")}
</div>
<button type="button" id="add" hidden>+ Add another time</button>
<input type="hidden" name="tz" value="${esc(p.timeZone ?? "")}">
<p id="enough" class="muted" tabindex="-1" aria-live="polite"></p>
<button type="submit" class="button">Send</button>
<p class="muted">Signed in as ${esc(p.email)}. The invite goes to this address. <a href="/a/${p.token}/signin">Use another Google account</a></p>
</form>`,
		{ nonce, script: SCRIPT, status: p.status },
	);
}

/** Any page that only says something: the result, ended requests, wrong links, sign-in problems. */
export function messagePage(title: string, html: string, status = 200): Response {
	return shell(title, `<h1>${esc(title)}</h1>\n${html}`, { status });
}
