/**
 * Webhook dispatch — two routes through the same work.
 *
 * `enqueueWebhookBody` is the one to use: it writes each event to the `jobs` table and
 * returns, so the work survives the invocation being frozen after the response. See
 * migration v13 for why that matters.
 *
 * `processWebhookBody` is the original inline path, kept as the fallback for when the queue
 * is unavailable — a database that is up enough to serve reads but not the `jobs` insert, or
 * a deployment that has shipped this code before migration v13 has been applied by hand.
 * Both routes call the same `handleCommentChange` / `handleMessagingEvent`, so they cannot
 * drift apart.
 *
 * The failure mode the per-event isolation exists to kill: the whole batch used to run inside
 * one try/catch, so the first un-wrapped database error aborted the loop over `body.entry` —
 * and because the handler answered 200 unconditionally in its `finally`, Meta was told every
 * event in that delivery succeeded. The remaining events were gone for good, with one console
 * line as the only evidence. Each entry, and each event inside it, now fails alone.
 */
import { describeError, log, withLogContext } from '../utils/log.js';
import { getJobQueue } from '../jobs/queue.js';
import type { EnqueueInput } from '../jobs/types.js';
import { handleMessagingEvent } from './messaging.js';
import { handleCommentChange } from './comments.js';
import { FINAL_ATTEMPT } from './options.js';

/**
 * The id Meta gives this comment, for queue-level deduplication.
 *
 * Instagram puts it at `value.id`, Facebook at `value.comment_id`. Best effort by design:
 * an event whose id cannot be found is still enqueued, just without dedupe protection, and
 * the row-level `interactions.comment_id UNIQUE` claim still catches the redelivery one layer
 * down. Losing the event would be far worse than processing it twice.
 */
function commentDedupeKey(change: any): string | undefined {
    const id = change?.value?.id ?? change?.value?.comment_id;
    return typeof id === 'string' && id ? `comment:${id}` : undefined;
}

/** Same idea for DMs; `messages.meta_message_id UNIQUE` is the layer below. */
function dmDedupeKey(event: any): string | undefined {
    const mid = event?.message?.mid ?? event?.postback?.mid;
    return typeof mid === 'string' && mid ? `dm:${mid}` : undefined;
}

/**
 * Whether a messaging event is something the DM pipeline could act on.
 *
 * `entry.messaging` carries far more than inbound messages: on an active account most of it is
 * `read` watermarks and `delivery` receipts, plus reactions, referrals and handover-protocol
 * events. None of those reach a reply — `normalizeDm` rejects every one of them for having no
 * text and no payload — but they were each becoming a `jobs` row first, and because they carry
 * no `mid` they get no dedupe key either, so a redelivered batch of read receipts wrote a
 * fresh row per receipt per delivery. Rows that are claimed, run, logged `dm.skipped_empty`
 * and marked done, forever.
 *
 * Filtering here rather than in the handler keeps the queue a record of work, which is what
 * makes "how much is pending" a number worth reading.
 *
 * Erring towards enqueueing: an event with a `message` or a `postback` goes through even if
 * this function cannot see anything answerable in it, because the handler is the thing that
 * knows, and dropping a real customer message would be far worse than one wasted job.
 */
function isActionableMessagingEvent(event: any): boolean {
    // Echoes are the page's own outbound messages coming back. On an active account they are
    // a large share of all messaging events.
    if (event?.message?.is_echo) return false;
    if (event?.message) return true;
    if (event?.postback) return true;
    return false;
}

/** Flatten one webhook body into the jobs it implies, without touching the database. */
export function planJobs(body: any): EnqueueInput[] {
    const planned: EnqueueInput[] = [];
    const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];

    for (const entry of entries) {
        const entryId = entry?.id;

        // The fair-queueing partition. `entry.id` is the Meta page id the delivery is
        // addressed to, which is available here without a database read — unlike the tenant's
        // own uuid, which is why `jobs.creator_id` is NULL on every row the webhook writes.
        const tenantKey = typeof entryId === 'string' && entryId ? entryId : undefined;

        if (Array.isArray(entry?.messaging)) {
            for (const event of entry.messaging) {
                if (!isActionableMessagingEvent(event)) continue;
                planned.push({
                    kind: 'dm.process',
                    payload: { event, entryId },
                    dedupeKey: dmDedupeKey(event),
                    tenantKey,
                });
            }
        }

        if (Array.isArray(entry?.changes)) {
            for (const change of entry.changes) {
                planned.push({
                    kind: 'comment.process',
                    payload: { change, entryId },
                    dedupeKey: commentDedupeKey(change),
                    tenantKey,
                });
            }
        }
    }

    return planned;
}

export interface EnqueueResult {
    planned: number;
    enqueued: number;
    deduped: number;
}

/**
 * Durably record every event in this body, then return.
 *
 * Throws if the queue is unreachable. The caller is expected to fall back to the inline path
 * rather than drop the delivery — losing events is the one outcome worse than processing
 * them on the Meta clock.
 */
export async function enqueueWebhookBody(body: any, requestId?: string): Promise<EnqueueResult> {
    const planned = planJobs(body);
    const result: EnqueueResult = { planned: planned.length, enqueued: 0, deduped: 0 };

    if (planned.length === 0) {
        log('info', 'webhook.no_events', { object: body?.object });
        return result;
    }

    const queue = getJobQueue();
    for (const input of planned) {
        const id = await queue.enqueue({ ...input, requestId });
        if (id) result.enqueued++;
        else result.deduped++;
    }

    log('info', 'webhook.enqueued', { ...result, object: body?.object });
    return result;
}

// ─── Legacy inline path ─────────────────────────────────────────────────────────────────

function describe(err: any): string {
    return err?.message ?? String(err);
}

async function processEntry(entry: any, objectType: string): Promise<void> {
    const entryId = entry?.id;

    await withLogContext({ entry_id: entryId, object: objectType }, async () => {
        // ─── A. Instagram Direct Messages & Postbacks ─────────────────────────────
        if (Array.isArray(entry?.messaging)) {
            log('info', 'webhook.messaging_batch', { count: entry.messaging.length });
            for (const event of entry.messaging) {
                try {
                    // FINAL_ATTEMPT (the default) is correct here and not a shortcut: this is
                    // the fallback path taken when the queue could not be written, so there is
                    // no retry to leave work for. Every outcome has to be recorded now.
                    await handleMessagingEvent(event, entryId, FINAL_ATTEMPT);
                } catch (err: any) {
                    log('error', 'webhook.messaging_failed', {
                        mid: event?.message?.mid ?? null,
                        ...describeError(err),
                    });
                }
            }
        }

        // ─── B. Comment webhooks (Instagram & Facebook) ───────────────────────────
        if (Array.isArray(entry?.changes)) {
            for (const change of entry.changes) {
                try {
                    await handleCommentChange(change, entryId, FINAL_ATTEMPT);
                } catch (err: any) {
                    log('error', 'webhook.comment_failed', {
                        field: change?.field,
                        ...describeError(err),
                    });
                }
            }
        }
    });
}

/** Process one verified webhook body inline. Never throws: every event is isolated. */
export async function processWebhookBody(body: any): Promise<void> {
    const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];

    if (entries.length === 0) {
        log('info', 'webhook.no_entries', { object: body?.object });
        return;
    }

    for (const entry of entries) {
        try {
            await processEntry(entry, body?.object);
        } catch (err: any) {
            log('error', 'webhook.entry_failed', { entry_id: entry?.id, message: describe(err) });
        }
    }
}
