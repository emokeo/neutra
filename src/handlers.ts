// The tools that come in two shapes (meeting only, or with price), routed to the right kind of decision.
// Apart from index.ts so tests can call them without the Workers runtime. Each takes the wider input; the
// meeting-only inputs (price switched off) fit it too.
import { ApiError, type Caller, createAnswer, createDecision, getDecision, type Interval, requestPreview } from "./decisions";
import { codeNextStep, nextStep, priceNextStep, validateNextStep } from "./guidance";
import { createPriceAnswer, createPriceDecision, type LimitInput, type PriceInput } from "./price";

type Windows = { availableWindows: Interval[]; timeZone?: string };

function exactlyOne(values: unknown[], message: string): void {
	if (values.filter((v) => v !== undefined).length !== 1) throw new ApiError("INVALID_ARGUMENT", message);
}

/** create_decision: a meeting, or (for callers who may start one) a price. The kind follows from decision. */
export async function startDecision(
	env: Env,
	caller: Caller,
	request: {
		decision: { meeting?: { duration: string }; price?: PriceInput };
		starterAnswer: { meeting?: Windows; price?: LimitInput };
		validateOnly?: boolean;
	},
	canStartPrice: boolean,
) {
	const { decision, starterAnswer } = request;
	exactlyOne(
		[decision.meeting, decision.price],
		"Send exactly one of decision.meeting (to find a meeting time) or decision.price (to agree on a price).",
	);
	if (decision.price) {
		if (!canStartPrice) throw new ApiError("FAILED_PRECONDITION", "Price requests aren't available yet.", "PRICE_OFF");
		if (!starterAnswer.price || starterAnswer.meeting) {
			throw new ApiError(
				"INVALID_ARGUMENT",
				"A price decision takes starterAnswer.price: minimumToAccept if your person receives the money, or maximumToPay if they pay. Leave out starterAnswer.meeting.",
			);
		}
		const result = await createPriceDecision(env, caller, {
			price: decision.price,
			starterAnswer: starterAnswer.price,
			validateOnly: request.validateOnly,
		});
		// neutra.v1.CreateDecisionResponse: with validateOnly there is no decision yet.
		if (result.validateOnly) return { receivedLimit: result.receivedLimit, nextStep: validateNextStep(result.receivedLimit) };
		return { decision: result.decision, receivedLimit: result.receivedLimit, nextStep: priceNextStep("create_decision", result.decision) };
	}
	if (!starterAnswer.meeting || starterAnswer.price) {
		throw new ApiError(
			"INVALID_ARGUMENT",
			"A meeting decision takes starterAnswer.meeting with your person's free times. Leave out starterAnswer.price.",
		);
	}
	if (request.validateOnly) {
		throw new ApiError(
			"INVALID_ARGUMENT",
			"validateOnly is only for price decisions. For a meeting, send the times without it: receivedWindows in the reply shows what Neutra understood.",
		);
	}
	// The meeting path, exactly as before price decisions.
	const meeting = decision.meeting as { duration: string };
	const created = await createDecision(env, caller, {
		durationSeconds: meeting.duration,
		starterWindows: starterAnswer.meeting.availableWindows,
		timeZone: starterAnswer.meeting.timeZone,
	});
	return { ...created, nextStep: nextStep("create_decision", created, created.receivedWindows) };
}

/** create_answer: free times for a meeting request, or a limit for a price request. */
export async function answerRequest(
	env: Env,
	caller: Caller,
	request: { parent?: string; code: string; answer: { meeting?: Windows; price?: LimitInput }; validateOnly?: boolean },
) {
	const { meeting, price } = request.answer;
	exactlyOne(
		[meeting, price],
		"Send exactly one of answer.meeting (free times) or answer.price (a price limit). get_decision with the code says which this request needs.",
	);
	if (price) {
		const result = await createPriceAnswer(env, caller, { parent: request.parent, code: request.code, price, validateOnly: request.validateOnly });
		// neutra.v1.CreateAnswerResponse. The limit comes back only with validateOnly, before anything is sent.
		if (result.validateOnly) return { receivedLimit: result.receivedLimit, nextStep: validateNextStep(result.receivedLimit) };
		return { decision: result.decision, nextStep: priceNextStep("create_answer", result.decision) };
	}
	if (request.validateOnly) {
		throw new ApiError(
			"INVALID_ARGUMENT",
			"validateOnly is only for price answers. For a meeting, send the times without it: receivedWindows in the reply shows what Neutra understood.",
		);
	}
	const windows = meeting as Windows;
	const result = await createAnswer(env, caller, {
		parent: request.parent,
		code: request.code,
		windows: windows.availableWindows,
		timeZone: windows.timeZone,
	});
	return { ...result, nextStep: nextStep("create_answer", result.decision, result.receivedWindows) };
}

/** get_decision, by name (participants) or, with the switch on, by code (anyone holding it). */
export async function readDecision(env: Env, caller: Caller, request: { name?: string; code?: string }) {
	if (request.name === undefined && request.code === undefined) throw new ApiError("INVALID_ARGUMENT", "Send name or code.");
	exactlyOne([request.name, request.code], "Send either name or code, not both.");
	// neutra.v1.GetDecisionResponse: a preview by code, the decision by name. Meetings keep their older shape
	// (the view's fields at the top level), so nothing changes for them.
	if (request.code !== undefined) {
		const { preview, isStarter } = await requestPreview(env, caller, request.code);
		return { preview, nextStep: codeNextStep(preview, isStarter) };
	}
	const decision = await getDecision(env, caller, request.name as string);
	if ("price" in decision) return { decision, nextStep: priceNextStep("get_decision", decision) };
	return { ...decision, nextStep: nextStep("get_decision", decision) };
}
