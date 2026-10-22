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
 * drift apart. A WhatsApp body (`whatsapp_business_account`) is planned by its own planner
 * (`whatsappPlan.ts`) and, on the inline path, run through the same two handlers the jobs
 * call (`handleWhatsAppInbound`, `handleWhatsAppEvent`); the Instagram and Facebook code below
 * it is untouched by that branch.
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
import { echoFromOwnApp, echoTakeoverEnabled } from './echo.js';
import { handleCommentChange } from './comments.js';
import { FINAL_ATTEMPT } from './options.js';
import { planWhatsAppEntry, WHATSAPP_OBJECT } from './whatsappPlan.js';
import { handleWhatsAppInbound } from './whatsappInbound.js';
import { handleWhatsAppEvent } from '../services/whatsappStatus.js';
import { isWhatsAppDmPayload } from '../jobs/types.js';

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
    if (typeof mid === 'string' && mid) return `dm:${mid}`;
    // A standalone ad referral (a returning person tapped a click-to-Messenger ad, A3) has no `mid`. Who, which ad and when is what makes it one
    // event, so a redelivery of it is refused at enqueue like a message's.
    if (isAdReferral(event?.referral)) {
        const sender = event?.sender?.id;
        const ts = event?.timestamp;
        if (sender && ts) return `dmref:${sender}:${event.referral.ad_id ?? event.referral.ref ?? ''}:${ts}`;
    }
    return undefined;
}

/** A referral from a click-to-message ad (`source: 'ADS'`), as opposed to an `m.me`/`ig.me` link's or any other. */
function isAdReferral(referral: any): boolean {
    return Boolean(referral) && typeof referral === 'object' && String(referral.source ?? '').toUpperCase() === 'ADS';
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
 * Erring towards enqueueing: an event with a `message` or a `postback` (or an ad's standalone `referral`, A3) goes through even if
 * this function cannot see anything answerable in it, because the handler is the thing that
 * knows, and dropping a real customer message would be far worse than one wasted job.
 */
function isActionableMessagingEvent(event: any, options: PlanOptions = {}): boolean {
    // Echoes are the page's own outbound messages coming back. On an active account they are
    // a large share of all messaging events, so they are dropped here unless echo takeover is on
    // (`dm.echo_takeover`, off by default), and then still dropped when `app_id` says they are this
    // deployment's own sends: a person's reply is the only echo worth a job.
    if (event?.message?.is_echo) return Boolean(options.echoes) && !echoFromOwnApp(event);
    if (event?.message) return true;
    if (event?.postback) return true;
    // A standalone ad referral: a person who already has a thread tapped a click-to-Messenger ad (A3). It carries no words, but it says which ad
    // brought them, which is the whole of ads → DM attribution; `handleMessagingEvent` records it and sends nothing. Other referrals (m.me links)
    // stay dropped, as before.
    if (isAdReferral(event?.referral)) return true;
    return false;
}

/**
 * Whether the webhook gate (`POST /webhook`) takes a body with this `object`: Instagram, a Facebook Page, or a WhatsApp Business Account.
 * Anything else is acknowledged with a 200 and logged `webhook.unrecognised_object` (src/index.ts): making Meta retry it forever is not an answer.
 * The signature check in front of it is the same for all three (one app secret).
 */
export function isAcceptedWebhookObject(object: unknown): boolean {
    return object === 'instagram' || object === 'page' || object === WHATSAPP_OBJECT;
}

export interface PlanOptions {
    /** Echo takeover is on: echoes become jobs. Absent or false is how the queue always behaved. */
    echoes?: boolean;
}

/** Does this body hold an echo? Decides whether the queue has to ask if takeover is on. */
function hasEcho(body: any): boolean {
    const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];
    return entries.some((entry) => Array.isArray(entry?.messaging) && entry.messaging.some((event: any) => event?.message?.is_echo));
}

/** Flatten one webhook body into the jobs it implies, without touching the database. */
export function planJobs(body: any, options: PlanOptions = {}): EnqueueInput[] {
    const planned: EnqueueInput[] = [];
    const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];
    // Which network the DMs in this body came from. It is on the body, not the event, so it
    // travels in the job or the pipeline cannot know it (v26 `conversations.platform`).
    const object = typeof body?.object === 'string' && body.object ? body.object : undefined;

    for (const entry of entries) {
        // A WhatsApp entry has `changes` and nothing else in common with the two Instagram/Facebook shapes below: its own planner (whatsappPlan.ts)
        // reads it, and everything after this `if` is exactly what it was before WhatsApp existed.
        if (object === WHATSAPP_OBJECT) {
            planned.push(...planWhatsAppEntry(entry));
            continue;
        }

        const entryId = entry?.id;

        // The fair-queueing partition. `entry.id` is the Meta page id the delivery is
        // addressed to, which is available here without a database read — unlike the tenant's
        // own uuid, which is why `jobs.creator_id` is NULL on every row the webhook writes.
        const tenantKey = typeof entryId === 'string' && entryId ? entryId : undefined;

        if (Array.isArray(entry?.messaging)) {
            for (const event of entry.messaging) {
                if (!isActionableMessagingEvent(event, options)) continue;
                planned.push({
                    kind: 'dm.process',
                    payload: object ? { event, entryId, object } : { event, entryId },
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
    // Asked only when a delivery holds an echo (one indexed row), and read as OFF when it cannot be read: the queue then behaves as it always did.
    let echoes = false;
    if (hasEcho(body)) {
        try {
            echoes = await echoTakeoverEnabled();
        } catch (err) {
            log('warn', 'webhook.echo_setting_unreadable', describeError(err));
        }
    }
    const planned = planJobs(body, { echoes });
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

/**
 * One WhatsApp entry on the inline path: the same planner as the queue, and the same two handlers the jobs call, so the routes cannot drift.
 * Each job is isolated: one that throws is logged and the rest still run. There is no retry on this path (`FINAL_ATTEMPT`).
 */
async function processWhatsAppEntry(entry: any): Promise<void> {
    for (const job of planWhatsAppEntry(entry)) {
        try {
            if (job.kind === 'dm.process' && isWhatsAppDmPayload(job.payload as any)) {
                await handleWhatsAppInbound(job.payload as any, FINAL_ATTEMPT);
            } else if (job.kind === 'wa.event') {
                await handleWhatsAppEvent(job.payload as any);
            }
        } catch (err: any) {
            log('error', 'webhook.whatsapp_failed', { job_kind: job.kind, ...describeError(err) });
        }
    }
}

async function processEntry(entry: any, objectType: string): Promise<void> {
    const entryId = entry?.id;

    if (objectType === WHATSAPP_OBJECT) {
        await withLogContext({ entry_id: entryId, object: objectType }, () => processWhatsAppEntry(entry));
        return;
    }

    await withLogContext({ entry_id: entryId, object: objectType }, async () => {
        // ─── A. Instagram Direct Messages & Postbacks ─────────────────────────────
        if (Array.isArray(entry?.messaging)) {
            log('info', 'webhook.messaging_batch', { count: entry.messaging.length });
            for (const event of entry.messaging) {
                try {
                    // FINAL_ATTEMPT (the default) is correct here and not a shortcut: this is
                    // the fallback path taken when the queue could not be written, so there is
                    // no retry to leave work for. Every outcome has to be recorded now.
                    await handleMessagingEvent(event, entryId, { ...FINAL_ATTEMPT, object: objectType });
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
