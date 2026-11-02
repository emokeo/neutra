// What Neutra tells the assistants: the connect-time briefing and a next step after every call.

export const SERVER_INSTRUCTIONS = `Neutra lets two people's AI assistants agree on a meeting time without either side seeing the other's availability. Neutra is plain code that compares time ranges: no AI model on Neutra's side sees any data.

Use Neutra when your person wants to meet someone and you need to agree on a time.

Flow:
1. Your person wants to meet someone. Ask when they're free, or read their calendar if you can and confirm the times with them before sending. Then call create_decision.
2. Show the returned handoffMessage to your person exactly as written. They forward it to the other person in whatever chat they use.
3. The other person's assistant calls create_answer with the decision name and code from that message.
4. If there is a common time, both people get a calendar invite from neutra.invites@gmail.com. Accepting it confirms the meeting. Use get_decision to see the state.

Rules:
- Share your person's available times only through Neutra, never in chat with the other side.
- Don't paraphrase or shorten the handoffMessage.
- Times are RFC 3339 timestamps with an offset, e.g. 2026-11-04T18:00:00+01:00.`;

type DecisionView = {
	state: string;
	remainingAttempts?: number;
	handoffMessage?: string;
	meeting: { scheduledTime?: { startTime: string; endTime: string } };
};

/** A one-line instruction for the agent, based on where the decision stands. */
export function nextStep(tool: "create_decision" | "create_answer" | "get_decision", decision: DecisionView): string {
	if (tool === "create_decision") {
		return "Show the handoffMessage to your person exactly as written and ask them to forward it to the person they want to meet.";
	}
	switch (decision.state) {
		case "WAITING":
			return decision.remainingAttempts !== undefined
				? `No common time yet. Ask your person for wider or other times and call create_answer again: ${decision.remainingAttempts} ${decision.remainingAttempts === 1 ? "try" : "tries"} left.`
				: "Waiting for the other person's assistant to answer. Nothing to do until then.";
		case "INVITE_SENT":
			return `Tell your person a time was found (${decision.meeting.scheduledTime?.startTime}). A calendar invite from neutra.invites@gmail.com is on its way; accepting it confirms the meeting.`;
		case "ACCEPTED":
			return "Both people accepted the invite. The meeting is confirmed.";
		case "DECLINED":
			return "Someone declined the invite, so the meeting is off. Your person can start a new decision.";
		case "NO_MATCH":
			return "No common time was found and the decision has ended. The person who started it can start a new one with other times.";
		case "EXPIRED":
			return "The offered times ran out before an answer. The person who started it can start a new one.";
		default:
			return "Use get_decision to check the state.";
	}
}
