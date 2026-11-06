// Runs every 15 minutes: finishes stopped answers, expires decisions, tells starters when nothing worked out, and deletes old data.
import { eventExists, sendEmail } from "./calendar";
import { ANSWER_DAYS, MAX_ANSWERS } from "./decisions";
import { recordEvent } from "./events";
import { priceNotice } from "./price";
import { formatDay } from "./time";

export const RETENTION_DAYS = 7;

type Row = {
	id: string;
	stats_ref: string | null;
	starter_email: string;
	starter_name: string;
	responder_email: string | null;
	offered_until: string | null;
};

// For the result emails of price decisions, which need the terms and the outcome.
type NoticeRow = Row & {
	kind: "meeting" | "price";
	state: "NO_MATCH" | "EXPIRED" | "AGREED";
	terms_json: string | null;
	agreed_minor: number | null;
	expire_time: string;
};

function firstName(name: string): string {
	return name.trim().split(/\s+/)[0] || name;
}

export function noAnswerEmail(starterName: string) {
	return {
		subject: "Your Neutra request expired",
		body: `Hi ${firstName(starterName)},

Nobody answered your Neutra request within ${ANSWER_DAYS} days.

If you still want to meet, ask your assistant to start a new request and send the message again.

Neutra`,
	};
}

export function timesPassedEmail(starterName: string, lastDay: string) {
	return {
		subject: "Your Neutra request: your times have passed",
		body: `Hi ${firstName(starterName)},

The times you offered in your Neutra request have passed (the last was on ${lastDay}), and nobody answered before then.

If you still want to meet, ask your assistant to start a new request with new times.

Neutra`,
	};
}

export function noMatchEmail(starterName: string, responderName: string) {
	return {
		subject: `No common time with ${firstName(responderName)}`,
		body: `Hi ${firstName(starterName)},

${responderName}'s assistant answered your Neutra request, but none of the times fit yours. Neither of you saw the other's times.

If you still want to meet, ask your assistant to start a new request with other times.

Neutra`,
	};
}

/** "No common time" if the other person answered, otherwise "your times have passed". */
async function starterEmail(env: Env, d: Row) {
	if (d.responder_email) {
		const responder = await env.DB.prepare("SELECT author_name FROM answers WHERE decision_id = ? AND role = 'RESPONDER'")
			.bind(d.id)
			.first<{ author_name: string }>();
		return noMatchEmail(d.starter_name, responder?.author_name ?? "The other person");
	}
	const starter = await env.DB.prepare("SELECT time_zone FROM answers WHERE decision_id = ? AND role = 'STARTER'")
		.bind(d.id)
		.first<{ time_zone: string | null }>();
	return timesPassedEmail(d.starter_name, formatDay(Date.parse(d.offered_until ?? ""), starter?.time_zone ?? undefined));
}

export async function runMaintenance(env: Env, now = Date.now()) {
	const nowIso = new Date(now).toISOString();
	const result = { recovered: 0, expired: 0, timesPassed: 0, notified: 0, deleted: 0 };

	// 0. Answers that stopped mid-way (MATCHING for over 5 minutes). If the invite went out, finish the
	// answer; if not, the request opens again. The try stays counted (see createAnswer); after the last
	// one the decision ends as NO_MATCH. If Google can't say, wait for the next run.
	const { results: stuck } = await env.DB.prepare(
		"SELECT id, claim_id, pending_event_id FROM decisions WHERE state = 'MATCHING' AND update_time < ?",
	)
		.bind(new Date(now - 5 * 60_000).toISOString())
		.all<{ id: string; claim_id: string | null; pending_event_id: string | null }>();
	const stillStuck = "EXISTS (SELECT 1 FROM decisions WHERE id = ? AND state = 'MATCHING' AND claim_id IS ?)";
	for (const d of stuck) {
		let sent = false;
		try {
			sent = !!d.pending_event_id && (await eventExists(env, d.pending_event_id));
		} catch (error) {
			console.error("recovery check failed", d.id, error);
			continue;
		}
		const results = sent
			? await env.DB.batch([
					env.DB.prepare(`UPDATE answers SET windows_json = '[]' WHERE decision_id = ? AND ${stillStuck}`).bind(d.id, d.id, d.claim_id),
					env.DB.prepare(
						"UPDATE decisions SET state = 'INVITE_SENT', code_used = 1, calendar_event_id = pending_event_id, pending_event_id = NULL, claim_id = NULL, update_time = ? WHERE id = ? AND state = 'MATCHING' AND claim_id IS ?",
					).bind(nowIso, d.id, d.claim_id),
				])
			: await env.DB.batch([
					env.DB.prepare(
						`UPDATE answers SET windows_json = '[]' WHERE decision_id = ? AND ${stillStuck} AND (SELECT attempts FROM decisions WHERE id = ?) >= ?`,
					).bind(d.id, d.id, d.claim_id, d.id, MAX_ANSWERS),
					env.DB.prepare(
						`UPDATE decisions SET state = CASE WHEN attempts >= ? THEN 'NO_MATCH' ELSE 'WAITING' END, code_used = CASE WHEN attempts >= ? THEN 1 ELSE 0 END,
						 claim_id = NULL, pending_event_id = NULL, scheduled_start = NULL, scheduled_end = NULL, update_time = ?
						 WHERE id = ? AND state = 'MATCHING' AND claim_id IS ?`,
					).bind(MAX_ANSWERS, MAX_ANSWERS, nowIso, d.id, d.claim_id),
				]);
		if (results[1].meta.changes === 1) result.recovered++;
	}

	// 1. Decisions nobody settled in time.
	const { results: overdue } = await env.DB.prepare(
		"SELECT id, stats_ref, responder_email FROM decisions WHERE state = 'WAITING' AND expire_time < ?",
	)
		.bind(nowIso)
		.all<{ id: string; stats_ref: string | null; responder_email: string | null }>();
	for (const d of overdue) {
		await env.DB.batch([
			// A price request's sealed limit goes with it.
			env.DB.prepare("UPDATE decisions SET state = 'EXPIRED', limit_sealed = NULL, update_time = ? WHERE id = ? AND state = 'WAITING'").bind(
				nowIso,
				d.id,
			),
			env.DB.prepare("UPDATE answers SET windows_json = '[]' WHERE decision_id = ?").bind(d.id),
		]);
		await recordEvent(env, { type: "decision_expired", decisionRef: d.stats_ref, detail: { answered: !!d.responder_email } });
		result.expired++;
	}

	// 1b. The starter's times have passed but the request is still open. It stays open until its fixed deadline
	// (ending it now would tell the other person when the starter's times end), but the starter hears now,
	// and their times are deleted.
	const { results: passed } = await env.DB.prepare(
		"SELECT id, stats_ref, starter_email, starter_name, responder_email, offered_until FROM decisions WHERE kind = 'meeting' AND state = 'WAITING' AND notified = 0 AND offered_until < ?",
	)
		.bind(nowIso)
		.all<Row>();
	for (const d of passed) {
		try {
			await sendEmail(env, { to: d.starter_email, ...(await starterEmail(env, d)) });
			await env.DB.batch([
				env.DB.prepare("UPDATE decisions SET notified = 1 WHERE id = ?").bind(d.id),
				env.DB.prepare("UPDATE answers SET windows_json = '[]' WHERE decision_id = ? AND role = 'STARTER'").bind(d.id),
			]);
			result.timesPassed++;
		} catch (error) {
			console.error("notify failed", d.id, error);
		}
	}

	// 2. Delete everything about decisions that ended more than RETENTION_DAYS ago, including price deals.
	// The calendar event stays: deleting it would also remove it from both people's calendars.
	const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const { results: old } = await env.DB.prepare(
		`SELECT id FROM decisions
		 WHERE (state IN ('INVITE_SENT', 'ACCEPTED', 'DECLINED') AND scheduled_end < ?)
		    OR (state IN ('NO_MATCH', 'EXPIRED', 'AGREED') AND update_time < ?)`,
	)
		.bind(cutoff, cutoff)
		.all<{ id: string }>();
	for (const d of old) {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM answers WHERE decision_id = ?").bind(d.id),
			env.DB.prepare("DELETE FROM decisions WHERE id = ?").bind(d.id),
		]);
		result.deleted++;
	}

	// 3. One email to the starter when nothing worked out. For price decisions, the result email to both people,
	// which the answer sends itself: only ones that failed are retried here, after a few minutes so a slow
	// answer isn't emailed twice.
	const { results: unnotified } = await env.DB.prepare(
		`SELECT id, stats_ref, starter_email, starter_name, responder_email, offered_until, kind, state, terms_json, agreed_minor, expire_time
		 FROM decisions WHERE notified = 0
		  AND (state IN ('NO_MATCH', 'EXPIRED') OR (kind = 'price' AND state = 'AGREED'))
		  AND (kind = 'meeting' OR state = 'EXPIRED' OR update_time < ?)`,
	)
		.bind(new Date(now - 5 * 60_000).toISOString())
		.all<NoticeRow>();
	for (const d of unnotified) {
		try {
			await sendEmail(
				env,
				d.kind === "price"
					? await priceNotice(env, d)
					: { to: d.starter_email, ...(d.responder_email ? await starterEmail(env, d) : noAnswerEmail(d.starter_name)) },
			);
			await env.DB.prepare("UPDATE decisions SET notified = 1 WHERE id = ?").bind(d.id).run();
			result.notified++;
		} catch (error) {
			// Left unmarked, so the next run tries again.
			console.error("notify failed", d.id, error);
		}
	}

	console.log(JSON.stringify({ job: "maintenance", ...result }));
	return result;
}
