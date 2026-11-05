// The two public pages Google's sign-in setup asks for: a home page and a privacy policy.

const CONTACT = "neutra.invites@gmail.com";

function page(title: string, body: string): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  a { color: #1a56db; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #141414; } a { color: #7aa7ff; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
	return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function homePage(connectorUrl: string): Response {
	return page(
		"Neutra",
		`<h1>Neutra</h1>
<p><strong>Find a time to meet, without sharing your calendar.</strong> Your AI assistant tells Neutra when you're free, the other person's assistant does the same, and Neutra sends one calendar invite to both. Neither of you ever sees the other's times.</p>
<p>No AI on Neutra's side: Neutra is plain code that compares times. It can't see your calendar, contacts or mail: Google sign-in gives it only your name and email. Neutra is new and free, made by Emoke Olti in Switzerland. <a href="https://github.com/emokeo/neutra">Source code</a>.</p>

<h2>Got a Neutra message?</h2>
<p>Add Neutra to your assistant once (below), then paste the line from the message and add when you're free.</p>

<h2>Add Neutra to your assistant</h2>
<p>Connector address: <code>${connectorUrl}</code>. Neutra isn't in connector directories yet, so you add it as a custom connector.</p>
<ul>
<li><strong>Claude:</strong> Customize → Connectors → Add custom connector → paste the address → Add → sign in with Google. In a chat, Neutra can be switched on under <em>+</em> → Connectors. If your phone app can't add connectors, add it once on claude.ai; it then works in the app too.</li>
<li><strong>ChatGPT:</strong> custom connectors need Developer mode (Settings → Apps), which not every plan has. Then add the address as a new app and sign in.</li>
<li><strong>Muse:</strong> tell Muse in chat: <em>"Add a custom connector: Neutra, remote streamable HTTP, ${connectorUrl}, OAuth."</em> Then sign in. (Muse is available in the US, Canada, Japan and Singapore.)</li>
<li><strong>Other assistants:</strong> any assistant that supports remote MCP connectors with sign-in.</li>
</ul>

<h2>Start one yourself</h2>
<p>Ask your assistant, for example:</p>
<ul>
<li><em>"Use Neutra to find an hour with Ben next week. I'm free Tuesday and Thursday, 18:00–21:00."</em></li>
<li><em>"Find 30 minutes with my landlord before Friday with Neutra, without showing him my calendar."</em></li>
<li><em>"Answer this Neutra request: neutra:… I'm free tomorrow afternoon and Monday morning."</em></li>
</ul>
<p>Starting one gives you a message to forward. If a time fits both of you, you both get a calendar invite; ask your assistant for the status any time.</p>

<p><a href="/privacy">Privacy</a> · Contact: <a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
	);
}

/** The page behind the link in a hand-off message: what this is and how to answer. */
export function requestPage(starterName: string | null, connectorUrl: string): Response {
	const who = starterName ? starterName.split(/\s+/)[0] : "Someone";
	return page(
		"Neutra · Answer a request",
		`<h1>${who.replace(/[<>&"']/g, "")} would like to meet you</h1>
<p>Neutra finds a time that works for both of you, <strong>without either of you sharing your calendar</strong>. When it finds one, you both get a calendar invite. No AI on Neutra's side sees your times.</p>

<h2>1. Add Neutra to your assistant (once, about 2 minutes)</h2>
<p>Connector address: <code>${connectorUrl}</code>. Neutra isn't in connector directories yet, so you add it as a custom connector.</p>
<ul>
<li><strong>Claude:</strong> Customize → Connectors → Add custom connector → paste the address → Add → sign in with Google. In a chat, Neutra can be switched on under <em>+</em> → Connectors. If your phone app can't add connectors, add it once on claude.ai; it then works in the app too.</li>
<li><strong>ChatGPT:</strong> custom connectors need Developer mode (Settings → Apps), which not every plan has. Then add the address as a new app and sign in.</li>
<li><strong>Muse:</strong> tell Muse in chat: <em>"Add a custom connector: Neutra, remote streamable HTTP, ${connectorUrl}, OAuth."</em> Then sign in. (Muse is available in the US, Canada, Japan and Singapore.)</li>
<li><strong>Other assistants:</strong> any assistant that supports remote MCP connectors with sign-in.</li>
</ul>
<p>Neutra only uses your name and email from Google sign-in, to send you the invite.</p>

<h2>2. Paste the line from the message</h2>
<p>Paste the line in quotes from the message into your assistant, and add when you're free. That's it.</p>

<p><a href="/">What is Neutra?</a> · <a href="/privacy">Privacy</a></p>`,
	);
}

export function privacyPage(): Response {
	return page(
		"Neutra · Privacy",
		`<h1>Privacy</h1>
<p>Neutra is an early, free project. This page says plainly what it stores and why. Last updated: 5 November 2026.</p>

<h2>Who is responsible</h2>
<p>Neutra is run by Emoke Olti, Switzerland. Contact: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>

<h2>When you sign in</h2>
<p>We receive your name and email address from Google. Nothing else: we don't access your calendar, contacts or mail.</p>

<h2>Your available times</h2>
<p>Your assistant sends the times you're free for one decision. They are never shown to anyone else. The times of the person answering are never stored at all. The starter's times are deleted as soon as the decision is matched or ends, at most 14 days after it started.</p>

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
<p>A matched meeting is sent as a Google Calendar invite from ${CONTACT} to both people. Like any invite, it shows both email addresses.</p>

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
