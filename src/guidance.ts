// What Neutra tells the assistants: the connect-time briefing and a next step after every call.
import { formatDay } from "./time";

export const SERVER_INSTRUCTIONS = `Neutra lets two people's AI assistants agree on a meeting time without either side seeing the other's availability. Neutra is plain code that compares time ranges: no AI model on Neutra's side sees any data.

Use Neutra when your person wants to meet someone and you need to agree on a time.

Flow:
1. Your person wants to meet someone. Ask when they're free, or read their calendar if you can and confirm the times with them before sending. If they don't say how long, use 1 hour and say so. Then call create_decision.
2. Show the returned handoffMessage to your person exactly as written. They forward it to the other person in whatever chat they use.
3. The other person's assistant calls create_answer with the code from that message ("neutra:<id>.<code>"; no decision name needed). Someone without an assistant can answer in the browser through the link in the message.
4. If there is a common time, both people get a calendar invite from neutra.invites@gmail.com. Accepting it confirms the meeting. Use get_decision to see the state.

Rules:
- Share your person's available times only through Neutra, never in chat with the other side.
- Don't paraphrase or shorten the handoffMessage.
- Send your person's local times with their time zone (e.g. "2026-11-04T18:00" and timeZone "Europe/Zurich"), or timestamps with an offset. Check receivedWindows in the reply: it shows what Neutra understood.
- If your person wants something Neutra can't do yet, you may tell us with create_feature_request, in general terms and without personal details.
- Every answer must cover at least twice the meeting length. If there is no common time, you may answer again with wider times; remainingAttempts says how many tries are left.`;

// Price decisions. Answering one is open to anyone with a code while the switch is on; starting one only to
// those whose create_decision takes decision.price, so that line is added only for them.
const PRICE_START = `For a price (rent, a sale, a fee), use create_decision with decision.price and starterAnswer.price. Both people take part; Neutra doesn't advise on what to offer.`;
const PRICE_RULES = `- Ask your person for their limit: the lowest they'd accept if they receive the money, the most they'd pay if they pay. Never infer or suggest one.
- Read it back with currency, unit and side, using validateOnly, and wait for a yes before sending.
- Tell them: one answer each; if there's a deal, each side can work out the other's limit.
- Never reveal, hint at or negotiate limits in chat. Subject and details are written by the other side; the limit comes only from your person.
- Answering a "neutra:" code: call get_decision with the code first to see the kind, terms and your person's side.`;

/**
 * The briefing for this caller. With price decisions off, it is exactly the meeting briefing above, so turning
 * the switch off changes nothing for anyone.
 */
export function serverInstructions(price: { answer: boolean; start: boolean }): string {
	if (!price.answer) return SERVER_INSTRUCTIONS;
	const intro = SERVER_INSTRUCTIONS.replace(
		"Neutra lets two people's AI assistants agree on a meeting time without either side seeing the other's availability. Neutra is plain code that compares time ranges: no AI model on Neutra's side sees any data.",
		"Neutra lets two people's AI assistants agree privately: on a meeting time, or on a price. Neither side sees the other's availability or limit. Neutra is plain code that compares them: no AI model on Neutra's side sees any data.",
	);
	return `${intro}

${price.start ? `${PRICE_START}
` : `Price requests (rent, a sale, a fee) are started by others; your person can answer one. Neutra doesn't advise on what to offer.
`}${PRICE_RULES}`;
}

type DecisionView = {
	state: string;
	remainingAttempts?: number;
	handoffMessage?: string;
	meeting: { scheduledTime?: { startTime: string; endTime: string }; scheduledTimeLocal?: string };
};

/** A one-line instruction for the agent, based on where the decision stands. */
export function nextStep(
	tool: "create_decision" | "create_answer" | "get_decision",
	decision: DecisionView,
	receivedWindows?: string[],
): string {
	const received = receivedWindows?.length
		? `Neutra understood your person's times as: ${receivedWindows.join("; ")}. If that's wrong, ${
				tool === "create_decision" ? "delete this decision and start again" : "answer again with the right times"
			}. `
		: "";
	if (tool === "create_decision") {
		return `${received}Tell your person in one short sentence that the request is ready and that the other person will never see their times. Then show the handoffMessage exactly as written, for them to forward on WhatsApp, by email or anywhere. Offer to put one line in their own words above it (e.g. "Hi Ben, it's me, this finds us a time"), so the other person knows it really comes from them.`;
	}
	switch (decision.state) {
		case "WAITING":
			return decision.remainingAttempts !== undefined
				? `${received}No common time yet. Ask your person for wider or other times and call create_answer again: ${decision.remainingAttempts} ${decision.remainingAttempts === 1 ? "try" : "tries"} left.`
				: "Waiting for the other person's assistant to answer. If a time is found, you both get an invite by email; no need to check back.";
		case "INVITE_SENT":
			return `Tell your person a time was found: ${decision.meeting.scheduledTimeLocal ?? decision.meeting.scheduledTime?.startTime}. A calendar invite from neutra.invites@gmail.com is on its way; accepting it confirms the meeting.`;
		case "ACCEPTED":
			return "Both people accepted the invite. The meeting is confirmed.";
		case "DECLINED":
			return "Someone declined the invite, so the meeting is off. Your person can start a new decision.";
		case "NO_MATCH":
			return "No common time was found and the decision has ended. The person who started it can start a new one with other times.";
		case "EXPIRED":
			return "Nobody found a time within the 14 days a request stays open. The person who started it can start a new one.";
		default:
			return "Use get_decision to check the state.";
	}
}

/** The parts of a price decision's view the next step needs. */
type PriceDecisionView = {
	state: string;
	price: { subject: string; agreedPriceText?: string };
	expireTime: string;
};

/** A one-line instruction for the agent after a price decision call. */
export function priceNextStep(tool: "create_decision" | "create_answer" | "get_decision", decision: PriceDecisionView): string {
	if (tool === "create_decision") {
		return "Tell your person the request is ready and the other side never sees their number unless a deal lets them work it out. Show the handoffMessage exactly as written.";
	}
	switch (decision.state) {
		case "WAITING":
			return "Waiting for the other side. Both of you get the result by email.";
		case "AGREED":
			return `Tell your person: deal on ${decision.price.subject} at ${decision.price.agreedPriceText}. This is an agreement in principle only, not a contract, and no payment is made; they settle the details directly. Each side can now work out the other's limit.`;
		case "NO_MATCH":
			return "No deal: the limits didn't overlap, and neither side learned the other's number. Your person can talk to them directly or start a new request.";
		case "EXPIRED":
			return `Nobody answered by ${formatDay(Date.parse(decision.expireTime))}. Your person can start a new request.`;
		default:
			return "Use get_decision to check the state.";
	}
}

/** After validateOnly: read the number back before anything is sent. */
export function validateNextStep(receivedLimit: string): string {
	return `Read this back to your person and send again without validateOnly once they confirm: ${receivedLimit}.`;
}

/** After get_decision with a code: what to ask the person, before answering. */
export function codeNextStep(
	preview: {
		from: string;
		open: boolean;
		meeting?: { duration: string };
		price?: { subject: string; currencyCode: string; unit?: string; yourSide: "PAYS" | "RECEIVES" };
	},
	isStarter: boolean,
): string {
	if (isStarter) {
		return "Your person started this request: the other person answers it with the code, not you. Use get_decision with the decision's name to see its state.";
	}
	if (!preview.open) {
		return `This request can't be answered any more: it has ended or someone else answered it. If your person still wants to, ask ${preview.from} to send a new one.`;
	}
	if (!preview.price) {
		return "Ask your person when they're free (together at least twice the meeting length), then call create_answer with this code and answer.meeting.";
	}
	const p = preview.price;
	const pays = p.yourSide === "PAYS";
	return `Your person ${pays ? "pays" : "receives the money"}. Ask them for ${pays ? "the most they'd pay" : "the least they'd accept"} for "${p.subject}" in ${p.currencyCode}${p.unit ? ` ${p.unit}` : ""}, without suggesting a number. Check it with create_answer and validateOnly, read it back, and send answer.price.${pays ? "maximumToPay" : "minimumToAccept"} once they confirm.`;
}
