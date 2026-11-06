import { CLAUDE_DIRECTORY_URL } from "./links";
// The two public pages Google's sign-in setup asks for: a home page and a privacy policy.

const CONTACT = "neutra.invites@gmail.com";

const DESCRIPTION = "Your AI assistant and theirs find a time to meet. You both get one calendar invite; neither of you sees the other's calendar.";

/** Link previews in chat apps and social sites (title, text and the 1200×630 card at /og.png). */
function preview(title: string, home: string): string {
	return `<meta name="description" content="${DESCRIPTION}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Neutra">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:url" content="${home}/">
<meta property="og:image" content="${home}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Neutra: find a time to meet, without sharing your calendar.">
<meta name="twitter:card" content="summary_large_image">`;
}

/** The address of the connector with a Copy button (the script below makes it work). */
function address(url: string): string {
	return `<span class="addr"><code>${url}</code> <button type="button" class="copy" data-copy="${url}">Copy</button></span>`;
}

const COPY_SCRIPT = `<script>
document.querySelectorAll(".copy").forEach((button) => button.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = "Copied"; }
  catch (e) {
    const range = document.createRange(); range.selectNodeContents(button.previousElementSibling);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    button.textContent = "Selected, now copy";
  }
  setTimeout(() => { button.textContent = "Copy"; }, 2500);
}));
</script>`;

function page(title: string, body: string, home?: string): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${home ? preview(title, home) : ""}
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  a { color: #1a56db; }
  .box { border: 1px solid #d8d8d8; border-radius: 10px; padding: 10px 14px; margin: 8px 0 4px; background: #f7f7f5; font-size: 0.92rem; }
  ol.steps > li { margin-bottom: 1rem; }
  details { margin: 6px 0; } summary { cursor: pointer; font-weight: 600; }
  .addr code { white-space: nowrap; }
  .copy { font: inherit; font-size: 0.8rem; padding: 2px 10px; min-height: 30px; border: 1px solid #0f5f5a; border-radius: 6px; background: none; color: #0f5f5a; cursor: pointer; }
  .flow { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; gap: 8px; align-items: center; margin: 20px 0 8px; text-align: center; }
  .node { border: 1px solid #d8d8d8; border-radius: 10px; padding: 10px 8px; font-weight: 600; font-size: 0.95rem; }
  .node small { display: block; font-weight: 400; color: #5c5c5c; font-size: 0.8rem; }
  .node.neutra { border-color: #0f5f5a; background: #e3f0ee; color: #0f5f5a; }
  .node.invite { grid-column: 3; }
  .arrow { color: #0f5f5a; font-size: 1.3rem; }
  .down { grid-column: 3; }
  .codebox { display: flex; flex-wrap: wrap; gap: 8px; } .codebox input { flex: 1 1 220px; min-height: 40px; font: inherit; padding: 0 8px; border: 1px solid #bbb; border-radius: 8px; }
  .codebox button { min-height: 40px; padding: 0 14px; border: none; border-radius: 8px; background: #0f5f5a; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: #b42318; font-weight: 600; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  @media (max-width: 560px) { .flow { grid-template-columns: 1fr; } .node.invite, .down { grid-column: 1; } .arrow { transform: rotate(90deg); } .arrow.down { transform: none; } }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #141414; } a { color: #7aa7ff; } .box { background: #1f1f1f; border-color: #3a3a3a; }
    .node { border-color: #3a3a3a; } .node small { color: #a8a8a8; } .node.neutra { background: #1b3431; color: #6cc4bb; border-color: #6cc4bb; } .arrow { color: #6cc4bb; }
    .copy { color: #6cc4bb; border-color: #6cc4bb; } .codebox input { background: #1f1f1f; color: #e8e8e8; border-color: #555; } .error { color: #f97066; } }
</style>
</head>
<body>
${body}
${body.includes('class="copy"') ? COPY_SCRIPT : ""}
</body>
</html>`;
	return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function homePage(connectorUrl: string): Response {
	const home = connectorUrl.replace(/\/mcp$/, "");
	return page(
		"Neutra · Find a time without sharing your calendar",
		`<h1>Neutra</h1>
<p><strong>Find a time to meet, without sharing your calendar.</strong> Your AI assistant and theirs work it out, and you both get one calendar invite. Neither of you sees the other's free times.</p>

<div class="flow" role="img" aria-label="Anna's assistant sends her free times to Neutra, Ben answers with his assistant or in the browser, and Neutra sends one invite to both.">
<div class="node">Anna's assistant<small>sends her free times</small></div>
<span class="arrow" aria-hidden="true">→</span>
<div class="node neutra">Neutra<small>compares them privately</small></div>
<span class="arrow" aria-hidden="true">←</span>
<div class="node">Ben<small>his assistant or the browser</small></div>
<span class="arrow down" aria-hidden="true">↓</span>
<div class="node invite">One invite to both<small>with a Google Meet link</small></div>
</div>

<h2>How it works</h2>
<ol class="steps">
<li><strong>You ask your assistant.</strong> <em>"Find an hour with Ben next week. I'm free Tuesday and Thursday evening."</em> It gives you a short message to send Ben, by WhatsApp or anywhere:
<div class="box">Anna wants to find a time to meet you with Neutra. Neither of you shares your calendar … Tell your assistant: "Answer Neutra request neutra:… I'm free: …"</div></li>
<li><strong>Ben's assistant answers</strong> with when he's free. Neutra compares the two privately. No assistant? The message also has a link where Ben signs in with Google and adds his times in the browser.</li>
<li><strong>You both get one invite:</strong>
<div class="box"><strong>Anna &amp; Ben</strong> · Thu 12 Nov, 19:00–20:00<br>Set up by Neutra, with a Google Meet link.</div></li>
</ol>

<h2>What if no time fits?</h2>
<p>Nobody learns anything about the other's times. Ben can try again with more times, up to three tries, and each answer must cover at least twice the meeting length, so tries can't be used to map your calendar slot by slot. If nothing fits, you get an email.</p>

<h2>Is it private?</h2>
<p>Neutra is plain code that compares times: no AI on Neutra's side sees them. Free times are deleted as soon as a time is found, at the latest after 14 days. Google sign-in gives Neutra only your name and email; it can't see your calendar, contacts or mail. Free, made by Emoke Olti in Switzerland. <a href="https://github.com/emokeo/neutra">Source code</a> · <a href="/privacy">Privacy</a>.</p>

<h2>Try it</h2>
<p>Ask your assistant, for example:</p>
<ul>
<li><em>"Use Neutra to find an hour with Ben next week. I'm free Tuesday and Thursday, 18:00–21:00."</em></li>
<li><em>"Find 30 minutes with my landlord before Friday with Neutra, without showing him my calendar."</em></li>
<li><em>"Answer this Neutra request: neutra:… I'm free tomorrow afternoon and Monday morning."</em></li>
</ul>

<h2 id="add">Add Neutra to your assistant (once, about 2 minutes)</h2>
<p>Assistants use add-ons called connectors. Neutra's address is ${address(connectorUrl)}.</p>
<details open><summary>Claude</summary><p>Neutra is in Claude's connector directory: <a href="${CLAUDE_DIRECTORY_URL}">open Neutra there</a> → Connect → sign in with Google. If your phone app can't add it, add it once on claude.ai; it then works in the app too.</p></details>
<details><summary>ChatGPT</summary><p>Needs Developer mode (Settings → Apps), which not every plan has. Then add the address as a new app and sign in.</p></details>
<details><summary>Muse</summary><p>Tell Muse in chat: <em>"Add a custom connector: Neutra, remote streamable HTTP, ${connectorUrl}, OAuth."</em> Then sign in. Muse is available in the US, Canada, Japan and Singapore.</p></details>
<details><summary>Other assistants</summary><p>Any assistant that supports remote MCP connectors with sign-in.</p></details>

<p>Contact: <a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
		home,
	);
}

// The parts of the steps page that depend on what the request is about.
const REQUEST_TEXTS = {
	meeting: {
		heading: "would like to meet you",
		intro: `Neutra finds a time that works for both of you, <strong>without either of you sharing your calendar</strong>. When it finds one, you both get a calendar invite. No AI on Neutra's side sees your times.`,
		signIn: "Neutra only uses your name and email from Google sign-in, to send you the invite.",
		paste: "Paste the line in quotes from the message into your assistant, and add when you're free. That's it. If no time fits, nobody learns anything about the other's times, and you can try again with more times.",
		browser: "sign in with Google and add the times you're free",
	},
	price: {
		heading: "would like to agree on a price with you",
		intro: `Neutra checks whether your two numbers overlap, <strong>without either of you seeing the other's number</strong>. If they do, you both get the price halfway between them by email. No AI on Neutra's side sees your number.`,
		signIn: "Neutra only uses your name and email from Google sign-in, to email you the result.",
		paste: "Paste the line in quotes from the message into your assistant, with your number. You have one answer, so your assistant reads it back to you before sending. If there's no deal, neither of you learns the other's number.",
		browser: "sign in with Google and enter your number",
	},
};

/** The page behind the link in a hand-off message: what this is and how to answer. */
export function requestPage(
	starterName: string | null,
	connectorUrl: string,
	decisionId: string,
	badCode = false,
	kind: "meeting" | "price" = "meeting",
): Response {
	const who = starterName ? starterName.split(/\s+/)[0] : "Someone";
	const texts = REQUEST_TEXTS[kind];
	return page(
		"Neutra · Answer a request",
		`<h1>${who.replace(/[<>&"']/g, "")} ${texts.heading}</h1>
<p>${texts.intro}</p>

<h2>1. Add Neutra to your assistant (once, about 2 minutes)</h2>
<p>Assistants use add-ons called connectors. Neutra's address is ${address(connectorUrl)}.</p>
<details open><summary>Claude</summary><p>Neutra is in Claude's connector directory: <a href="${CLAUDE_DIRECTORY_URL}">open Neutra there</a> → Connect → sign in with Google. If your phone app can't add it, add it once on claude.ai; it then works in the app too.</p></details>
<details><summary>ChatGPT</summary><p>Needs Developer mode (Settings → Apps), which not every plan has. Then add the address as a new app and sign in.</p></details>
<details><summary>Muse</summary><p>Tell Muse in chat: <em>"Add a custom connector: Neutra, remote streamable HTTP, ${connectorUrl}, OAuth."</em> Then sign in. Muse is available in the US, Canada, Japan and Singapore.</p></details>
<details><summary>Other assistants</summary><p>Any assistant that supports remote MCP connectors with sign-in.</p></details>
<p>${texts.signIn}</p>

<h2>2. Paste the line from the message</h2>
<p>${texts.paste}</p>
<h2 id="browser">No AI assistant?</h2>
<p>Open the browser link at the end of the message: ${texts.browser}. Or paste the code from the message here:</p>
${badCode ? `<p class="error" role="alert">That code doesn't look complete. Copy the part that starts with "neutra:" from the message.</p>` : ""}
<form class="codebox" method="get" action="/r/${decisionId}/answer">
<label for="code" class="sr">Code from the message</label>
<input id="code" name="code" placeholder="neutra:…" autocomplete="off" autocapitalize="off" spellcheck="false" required>
<button type="submit">Answer in the browser</button>
</form>

<p><a href="/">What is Neutra?</a> · <a href="/privacy">Privacy</a></p>`,
		connectorUrl.replace(/\/mcp$/, ""),
	);
}

export function privacyPage(): Response {
	return page(
		"Neutra · Privacy",
		`<h1>Privacy</h1>
<p>Neutra is an early, free project. This page says plainly what it stores and why. Last updated: 6 November 2026.</p>

<h2>Who is responsible</h2>
<p>Neutra is run by Emoke Olti, Switzerland. Contact: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>

<h2>When you sign in</h2>
<p>We receive your name and email address from Google. Nothing else: we don't access your calendar, contacts or mail. If you answer a request in your browser instead of through an assistant, a cookie keeps you signed in for up to an hour.</p>

<h2>Your available times</h2>
<p>Your assistant, or the answer page in your browser, sends the times you're free for one decision. They are never shown to anyone else. The times of the person answering are never stored at all. The starter's times are deleted as soon as the decision is matched or ends, at most 14 days after it started.</p>

<h2>Price limits</h2>
<p>When two people agree on a price through Neutra, each gives one number: the most they'd pay or the least they'd accept. The answering person's number is never stored. The starting person's number is stored encrypted, with a key only the request code can open, until the request settles or ends, at most 14 days. Neither number is ever shown to the other person; only the agreed price is, or "no deal". The result email goes to both people and shows both names and email addresses, so they can settle the details.</p>

<h2>Decisions</h2>
<p>For each decision we keep the participants' names and email addresses, its state and, if one was found, the meeting time. <strong>Everything about a decision is deleted 7 days after its meeting ends</strong>, or 7 days after it ended without a meeting. The person who started a decision can delete it earlier at any time, which also cancels the invite.</p>
<p>Two kinds of copies outlive this: database backups, which Cloudflare keeps for up to 30 days, and the invite itself, which stays in your own calendar and inbox like any invite you receive. The invites and notice emails Neutra sent also remain in Neutra's sending account.</p>

<h2>Emails</h2>
<p>If nobody answers in time, or no common time is found, the person who started the decision gets one short email from neutra.invites@gmail.com saying so.</p>

<h2>Feature requests</h2>
<p>An assistant can send us a short suggestion for a feature. We keep its text, with email addresses, links and phone numbers removed, and a pseudonymous ID per person.</p>

<h2>Usage statistics</h2>
<p>To learn whether Neutra is useful, we count what happens: for example "a decision was started from Claude" or "an answer matched on the second try". These records contain no names, email addresses or times, only a random reference per decision and a pseudonymous ID per person, so we can count distinct people. They are kept after the decision itself is deleted.</p>

<h2>Calendar invites</h2>
<p>A matched meeting is sent as a Google Calendar invite from ${CONTACT} to both people. Like any invite, it shows both email addresses. It includes a Google Meet video link; if you use it, the call runs on Google Meet.</p>

<h2>Why we may use this data</h2>
<p>To provide what you ask for: finding a time and sending the invite (Art. 6(1)(b) GDPR). For the usage statistics and limits against abuse, our legitimate interest in running Neutra safely and learning whether it is useful (Art. 6(1)(f) GDPR). The same applies under the Swiss Federal Act on Data Protection.</p>

<h2>Who processes it for us</h2>
<p><strong>Cloudflare</strong> runs Neutra: decisions are stored in its EU jurisdiction; sign-in sessions and requests may pass through its servers worldwide. <strong>Google</strong> handles sign-in and sends the invites and notice emails (Google Calendar and Gmail). Both are US companies, so data can be transferred to the United States. Both take part in the EU-U.S. and Swiss-U.S. Data Privacy Framework.</p>

<h2>What we don't do</h2>
<p>No ads, no selling or sharing of data, no use of your data for anything other than the decisions you take part in.</p>

<h2>Your rights</h2>
<p>You can ask to see, correct or delete everything we hold about you, or object to its use: write to <a href="mailto:${CONTACT}">${CONTACT}</a>. You can also complain to the Swiss Federal Data Protection and Information Commissioner (FDPIC) or to the data protection authority where you live.</p>
<p><a href="/">Back to Neutra</a></p>`,
	);
}
