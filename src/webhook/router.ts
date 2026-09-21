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

/** Flatten one webhook body into the jobs it implies, without touching the database. */
export function planJobs(body: any): EnqueueInput[] {
    const planned: EnqueueInput[] = [];
    const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];

    for (const entry of entries) {
        const entryId = entry?.id;

        if (Array.isArray(entry?.messaging)) {
            for (const event of entry.messaging) {
                // Echoes are the page's own outbound messages coming back. Filtered here
                // rather than in the handler so they never become rows at all — on an active
                // account they are a large share of all messaging events.
                if (event?.message?.is_echo) continue;
                planned.push({
                    kind: 'dm.process',
                    payload: { event, entryId },
                    dedupeKey: dmDedupeKey(event),
                });
            }
        }

        if (Array.isArray(entry?.changes)) {
            for (const change of entry.changes) {
                planned.push({
                    kind: 'comment.process',
                    payload: { change, entryId },
                    dedupeKey: commentDedupeKey(change),
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
                    await handleMessagingEvent(event, entryId);
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
                    await handleCommentChange(change, entryId);
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
