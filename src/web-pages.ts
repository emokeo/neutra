// The web answer page, for people without an AI assistant: sign in with Google, answer, send.
// Deliberately bare: one form, plain messages. What the form asks depends on the kind of request
// (web-meeting.ts, web-price.ts); the page around it is the same for all.

export function esc(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
body { font: 16px/1.5 system-ui, sans-serif; max-width: 480px; margin: 32px auto; padding: 0 16px; color: #1a1a1a; background: #fff; }
a { color: #0f5f5a; } h1 { font-size: 1.5rem; line-height: 1.2; } .muted { color: #5c5c5c; font-size: 0.9rem; }
.error { color: #b42318; font-weight: 600; } .hint { color: #5c5c5c; font-size: 0.9rem; }
.row { display: grid; grid-template-columns: 1fr 1fr 44px; gap: 6px; padding-bottom: 12px; margin-bottom: 12px; border-bottom: 1px solid #e4e4e0; }
.row .day { grid-column: 1 / 3; }
.row .rm { grid-column: 3; grid-row: 1; align-self: end; width: 44px; height: 44px; border: none; background: none; color: #5c5c5c; font-size: 22px; cursor: pointer; border-radius: 8px; }
.row .rm:focus-visible, #add:focus-visible { outline: 2px solid #0f5f5a; outline-offset: 2px; }
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
function shell(title: string, body: string, opts: { status?: number; nonce?: string; script?: string; style?: string } = {}): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}${opts.style ?? ""}</style>
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

/** The top of every page about a request: "Anna would like to meet you", and "1 hour · answer by Tue 17 Nov". */
export type Invitation = { title: string; detail: string; answerBy: string };

function heading(r: Invitation): string {
	return `<h1>${esc(r.title)}</h1>
<p class="muted">${esc(r.detail)} · answer by ${esc(r.answerBy)}</p>`;
}

/** Before sign-in: what this is, and one button. The texts are HTML, already escaped. */
export function introPage(r: Invitation, token: string, texts: { intro: string; expired?: string; signIn: string }): Response {
	return shell(
		r.title,
		`${heading(r)}
${texts.expired ? `<p class="error" role="alert">${texts.expired}</p>` : ""}
<p>${texts.intro}</p>
<a class="button" href="/a/${token}/signin">Continue with Google</a>
<p class="muted">${texts.signIn}</p>`,
	);
}

function nonce(): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** "Signed in as …": whose answer this is, and where the result goes. */
function signedInLine(token: string, email: string, addressNote: string): string {
	return `<p class="muted">Signed in as ${esc(email)}. ${addressNote} <a href="/a/${token}/signin">Use another Google account</a></p>`;
}

/** The answer form. The kind of request supplies the inputs (HTML) and anything they need. */
export function formPage(
	r: Invitation,
	p: {
		token: string;
		email: string;
		fields: string;
		attributes?: string;
		submit?: string;
		addressNote: string;
		script?: string;
		style?: string;
		notice?: string;
		error?: string;
		status?: number;
	},
): Response {
	return shell(
		r.title,
		`${heading(r)}
${p.notice ? `<p><strong>${esc(p.notice)}</strong></p>` : ""}
${p.error ? `<p class="error" role="alert">${esc(p.error)}</p>` : ""}
<form id="answer" method="post" action="/a/${p.token}"${p.attributes ?? ""}>
${p.fields}
<button type="submit" class="button">${p.submit ?? "Send"}</button>
${signedInLine(p.token, p.email, p.addressNote)}
</form>`,
		{ nonce: p.script ? nonce() : undefined, script: p.script, status: p.status, style: p.style },
	);
}

// The confirm step: the buttons stop working after the first click, so a double click can't send twice.
const CONFIRM_SCRIPT = `(() => {
  const form = document.getElementById("answer");
  form.addEventListener("submit", (event) => {
    const chosen = event.submitter;
    setTimeout(() => {
      form.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      if (chosen && chosen.value === "send") chosen.textContent = "Sending…";
    }, 0);
  });
})();`;

/**
 * Before an answer that can't be changed: what will be sent, Send or Change. The value travels in hidden
 * fields and is read again on Send, so what is sent is exactly what was shown.
 */
export function confirmPage(
	r: Invitation,
	p: { token: string; email: string; text: string; hidden: Record<string, string>; addressNote: string },
): Response {
	const hidden = Object.entries(p.hidden)
		.map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
		.join("\n");
	return shell(
		r.title,
		`${heading(r)}
<form id="answer" method="post" action="/a/${p.token}">
<p><strong>${esc(p.text)}</strong></p>
${hidden}
<button type="submit" class="button" name="step" value="send">Send</button>
<button type="submit" class="secondary" name="step" value="change">Change</button>
${signedInLine(p.token, p.email, p.addressNote)}
</form>`,
		{ nonce: nonce(), script: CONFIRM_SCRIPT, style: ".secondary { display: block; width: 100%; min-height: 44px; border: 1px solid #0f5f5a; border-radius: 12px; background: none; color: #0f5f5a; font: inherit; cursor: pointer; } @media (prefers-color-scheme: dark) { .secondary { color: #6cc4bb; border-color: #6cc4bb; } }" },
	);
}

/** Any page that only says something: the result, ended requests, wrong links, sign-in problems. */
export function messagePage(title: string, html: string, status = 200): Response {
	return shell(title, `<h1>${esc(title)}</h1>\n${html}`, { status });
}
