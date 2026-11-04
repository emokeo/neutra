// What Neutra tells the assistants: the connect-time briefing and a next step after every call.

export const SERVER_INSTRUCTIONS = `Neutra lets two people's AI assistants agree on a meeting time without either side seeing the other's availability. Neutra is plain code that compares time ranges: no AI model on Neutra's side sees any data.

Use Neutra when your person wants to meet someone and you need to agree on a time.

Flow:
1. Your person wants to meet someone. Ask when they're free, or read their calendar if you can and confirm the times with them before sending. Then call create_decision.
2. Show the returned handoffMessage to your person exactly as written. They forward it to the other person in whatever chat they use.
3. The other person's assistant calls create_answer with the code from that message ("neutra:<id>.<code>"; no decision name needed).
4. If there is a common time, both people get a calendar invite from neutra.invites@gmail.com. Accepting it confirms the meeting. Use get_decision to see the state.

Rules:
- Share your person's available times only through Neutra, never in chat with the other side.
- Don't paraphrase or shorten the handoffMessage.
- Send your person's local times with their time zone (e.g. "2026-11-04T18:00" and timeZone "Europe/Zurich"), or timestamps with an offset. Check receivedWindows in the reply: it shows what Neutra understood.
- If your person wants something Neutra can't do yet, you may tell us with create_feature_request, in general terms and without personal details.
- Every answer must cover at least twice the meeting length. If there is no common time, you may answer again with wider times; remainingAttempts says how many tries are left.`;

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
		return `${received}Tell your person in one short sentence that the request is ready and that the other person will never see their times. Then show the handoffMessage exactly as written, for them to forward on WhatsApp, by email or anywhere. Suggest they add a line of their own when forwarding, so the other person knows it really comes from them.`;
	}
	switch (decision.state) {
		case "WAITING":
			return decision.remainingAttempts !== undefined
				? `${received}No common time yet. Ask your person for wider or other times and call create_answer again: ${decision.remainingAttempts} ${decision.remainingAttempts === 1 ? "try" : "tries"} left.`
				: "Waiting for the other person's assistant to answer. Nothing to do until then.";
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
