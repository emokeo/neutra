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

export function homePage(): Response {
	return page(
		"Neutra",
		`<h1>Neutra</h1>
<p>A neutral place where people's AI assistants make decisions together, without anyone seeing anyone else's data.</p>
<p>Today it does one thing: two people's assistants find a time to meet. Each assistant shares only when its person is free; Neutra finds a common time and sends one calendar invite to both. Neither side ever sees the other's times.</p>
<p>Neutra is in private testing. <a href="/privacy">Privacy</a> · Contact: <a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
	);
}

export function privacyPage(): Response {
	return page(
		"Neutra · Privacy",
		`<h1>Privacy</h1>
<p>Neutra is an early project in private testing. This page says plainly what it stores and why. Last updated: 2 November 2026.</p>

<h2>When you sign in</h2>
<p>We receive your name and email address from Google. Nothing else: we don't access your calendar, contacts or mail.</p>

<h2>Your available times</h2>
<p>Your assistant sends the times you're free for one decision. They are never shown to anyone else. They are deleted as soon as the decision is matched or has no match. If nobody answers, they are deleted when the decision expires, at most 30 days later.</p>

<h2>Decisions</h2>
<p>For each decision we keep the participants' names and email addresses, its state and, if one was found, the meeting time. The person who started a decision can delete it at any time, which also cancels the invite.</p>

<h2>Calendar invites</h2>
<p>A matched meeting is sent as a Google Calendar invite from ${CONTACT} to both people. Like any invite, it shows both email addresses.</p>

<h2>Where data is kept</h2>
<p>Decisions are stored with Cloudflare, in its EU jurisdiction. Sign-in sessions are stored with Cloudflare. Invites go through Google Calendar.</p>

<h2>What we don't do</h2>
<p>No ads, no selling or sharing of data, no use of your data for anything other than the decisions you take part in.</p>

<h2>Your rights</h2>
<p>Write to <a href="mailto:${CONTACT}">${CONTACT}</a> to see or delete everything we hold about you.</p>
<p><a href="/">Back to Neutra</a></p>`,
	);
}
