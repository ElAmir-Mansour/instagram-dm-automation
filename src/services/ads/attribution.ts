/**
 * Ads → DM bot attribution (Meta Ads Manager phase A3): which ad a conversation came from, what the bot may be told about it, how long it may
 * be written to, and the two send refusals that belong to ad traffic.
 *
 * ## Where the ad shows up (Meta, `contracts/webhook-inbound.md`)
 * - Instagram (click-to-Direct): `message.referral` on the person's first message.
 * - Messenger, new thread: `postback.referral` on the greeting's or an ice breaker's postback.
 * - Messenger, existing thread: a standalone `referral` event (subscribed as `messaging_referrals`, `metaLogin.ts`).
 * All three carry `{ ref?, ad_id, source: 'ADS', type: 'OPEN_THREAD', ads_context_data: { ad_title, photo_url?, video_url?, post_id? } }`.
 * WhatsApp's click-to-WhatsApp referral is its own shape and is recorded by `webhook/whatsapp.ts` as `kind:'ctwa'` (v50).
 *
 * ## What is recorded (v54)
 * - The FIRST touch of a conversation (no earlier inbound message, no entry source yet) becomes `conversations.entry_source`
 *   `{kind:'ctm', platform, ad_id, ref, ads_context_data, at}`. It is never rewritten.
 * - Every later ad referral is put in front of `conversations.ad_touches` (newest 10). A redelivered referral is not added twice.
 *
 * ## Joining a conversation to the ad
 * By our own `ref` first (`ar_<12 hex of ads_objects.id>`, set on every message ad the app creates, so it joins before the mirror has the ad id),
 * then by `ad_id` against the stored copy (`ads_objects.meta_id`, level `ad`). An ad made in Meta's own Ads Manager before the next sync joins by
 * nothing yet: the conversation keeps the raw `ad_id`, and the join happens at read time. `ads_objects` arrives with the ads core (v53); until
 * it exists every join answers null, never an error.
 */
import { queryOne, queryRows } from '../../db/query.js';
import type { AdTouch, AdsContextData, ConversationEntrySource } from '../../db/rows.js';
import { metaErrorCode, metaErrorSubcode } from '../http.js';
import { describeError, log } from '../../utils/log.js';
import { readExtendedWindow, writeAdsSwitches, type AdPlatform, type AdsSwitches } from './switches.js';

/** What `normalizeDm` reads off a messaging event that came from a click-to-message ad. */
export interface AdSource {
    platform: AdPlatform;
    adId: string | null;
    ref: string | null;
    context: AdsContextData | null;
    /** When the click arrived (the event's `timestamp`), ISO 8601. */
    at: string;
}

/** At most this many later touches are kept on a conversation. */
export const MAX_AD_TOUCHES = 10;

/** The default reply window the bot keeps to: Meta's 24 hours from the person's last message, less an hour of margin (`followup.ts`). */
export const DEFAULT_WINDOW_MS = 23 * 60 * 60 * 1000;
/** Meta's window for a conversation started from a click-to-message ad (since 2026-09-28): 7 days from the click, less an hour of margin. */
export const AD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** `ads_context_data` as Meta sent it, keeping only the fields the privacy page names: the ad's title and its media links. Pure. */
export function adsContextOf(raw: unknown): AdsContextData | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const out: AdsContextData = {};
    const title = str(r.ad_title, 300);
    const photo = str(r.photo_url, 2000);
    const video = str(r.video_url, 2000);
    const post = str(r.post_id, 100);
    if (title) out.ad_title = title;
    if (photo) out.photo_url = photo;
    if (video) out.video_url = video;
    if (post) out.post_id = post;
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * The ad a messaging event came from, or null. Reads `message.referral`, then `postback.referral`, then the standalone `referral`, and keeps
 * only a referral whose `source` is `ADS` (an `ig.me` or `m.me` link's referral is not an ad). `object` is the webhook body's (`'instagram'` or
 * `'page'`); without it, a referral on a message is taken as Instagram and any other as Messenger, which is where Meta sends each. Pure.
 */
export function adSourceOf(event: any, object?: unknown): AdSource | null {
    const referral = event?.message?.referral ?? event?.postback?.referral ?? event?.referral;
    if (!referral || typeof referral !== 'object') return null;
    if (String(referral.source ?? '').toUpperCase() !== 'ADS') return null;
    const adId = str(referral.ad_id, 64);
    const ref = str(referral.ref, 250);
    if (!adId && !ref) return null;
    const platform: AdPlatform = object === 'instagram' ? 'instagram'
        : object === 'page' ? 'messenger'
        : event?.message?.referral ? 'instagram' : 'messenger';
    const ts = Number(event?.timestamp);
    const at = Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : new Date().toISOString();
    return { platform, adId, ref, context: adsContextOf(referral.ads_context_data), at };
}

/** The `entry_source` a first ad touch writes. Pure. */
export function entrySourceFor(source: AdSource): ConversationEntrySource {
    return {
        kind: 'ctm',
        platform: source.platform,
        ...(source.adId ? { ad_id: source.adId } : {}),
        ...(source.ref ? { ref: source.ref } : {}),
        ...(source.context ? { ads_context_data: source.context } : {}),
        at: source.at,
    };
}

/** The `ad_touches` element a later touch adds. Pure. */
export function touchFor(source: AdSource): AdTouch {
    return { ad_id: source.adId, ref: source.ref, platform: source.platform, at: source.at };
}

export type AdTouchRecorded = 'entry' | 'touch' | 'duplicate' | 'missing';

/**
 * Record an ad touch on a conversation, in one statement. It becomes the entry source when the conversation has none and no inbound message
 * before this one (`inboundId`, the row this event's own message wrote, is not "before"); otherwise it goes in front of `ad_touches`, unless it
 * is the same touch again (a redelivery: the entry source's own, or one already in the list). Never throws: attribution must not cost a reply.
 */
export async function recordAdTouch(input: {
    conversationId: string;
    creatorId: string;
    source: AdSource;
    inboundId?: string | null;
}): Promise<AdTouchRecorded> {
    const entry = JSON.stringify(entrySourceFor(input.source));
    const touch = JSON.stringify(touchFor(input.source));
    try {
        const row = await queryOne<{ recorded: AdTouchRecorded }>(
            `WITH cur AS (
                SELECT c.id,
                       (c.entry_source IS NULL AND NOT EXISTS (
                            SELECT 1 FROM messages m
                             WHERE m.conversation_id = c.id AND m.direction = 'inbound' AND m.id IS DISTINCT FROM $5::uuid)) AS first,
                       (c.entry_source IS NOT NULL
                            AND (c.entry_source->>'at') = ($4::jsonb->>'at')
                            AND (c.entry_source->>'ad_id') IS NOT DISTINCT FROM ($4::jsonb->>'ad_id'))
                         OR c.ad_touches @> jsonb_build_array($4::jsonb) AS seen
                  FROM conversations c
                 WHERE c.id = $1 AND c.creator_id = $2
                 FOR UPDATE
            )
            UPDATE conversations c
               SET entry_source = CASE WHEN cur.first THEN $3::jsonb ELSE c.entry_source END,
                   ad_touches = CASE WHEN cur.first OR cur.seen THEN c.ad_touches
                                     ELSE (SELECT COALESCE(jsonb_agg(t.e ORDER BY t.i), '[]'::jsonb)
                                             FROM jsonb_array_elements(jsonb_build_array($4::jsonb) || c.ad_touches) WITH ORDINALITY AS t(e, i)
                                            WHERE t.i <= $6)
                                END
              FROM cur
             WHERE c.id = cur.id
         RETURNING CASE WHEN cur.first THEN 'entry' WHEN cur.seen THEN 'duplicate' ELSE 'touch' END AS recorded`,
            [input.conversationId, input.creatorId, entry, touch, input.inboundId ?? null, MAX_AD_TOUCHES]
        );
        const recorded = row?.recorded ?? 'missing';
        log('info', 'ads.touch_recorded', {
            conversation_id: input.conversationId, recorded, platform: input.source.platform, ad_id: input.source.adId, has_ref: Boolean(input.source.ref),
        });
        return recorded;
    } catch (err) {
        log('error', 'ads.touch_failed', { conversation_id: input.conversationId, ...describeError(err) });
        return 'missing';
    }
}

// ─── Joins ────────────────────────────────────────────────────────────────────────────────────────

/** Our own `ref` for an ad the app creates: `ar_` and the first 12 hex digits of its `ads_objects.id`. Phase A4 sets it on every message ad. Pure. */
export function refFor(objectId: string): string {
    return `ar_${objectId.replace(/-/g, '').slice(0, 12).toLowerCase()}`;
}

/** The id prefix inside one of our refs, or null for any other ref (a ref set in Meta's Ads Manager by hand). Pure. */
export function refPrefix(ref: string | null | undefined): string | null {
    const m = /^ar_([0-9a-f]{12})$/i.exec(ref ?? '');
    return m ? m[1]!.toLowerCase() : null;
}

/** An ad in the stored copy, as much of it as attribution needs. */
export interface JoinedAd {
    objectId: string;
    metaId: string | null;
    name: string | null;
    /** `app_meta.offer_id`: the offer the app stored with the ad (A4). Null for an ad made outside the app. */
    offerId: string | null;
    /** The ad's primary text, when the stored copy has it. */
    primaryText: string | null;
}

/** Postgres' "relation does not exist": `ads_objects` before the ads core (v53) is applied. */
const UNDEFINED_TABLE = '42P01';

/**
 * The stored ad a touch belongs to: by our `ref` first, then by `ad_id`. Null when neither matches yet, or the stored copy does not exist yet.
 * Never throws.
 */
export async function joinAd(creatorId: string, key: { ref?: string | null; adId?: string | null }): Promise<JoinedAd | null> {
    const prefix = refPrefix(key.ref);
    const adId = key.adId ?? null;
    if (!prefix && !adId) return null;
    try {
        const row = await queryOne<{ id: string; meta_id: string | null; name: string | null; offer_id: string | null; primary_text: string | null }>(
            `SELECT id, meta_id, name, app_meta->>'offer_id' AS offer_id,
                    COALESCE(app_meta->>'primary_text', raw#>>'{creative,body}') AS primary_text
               FROM ads_objects
              WHERE creator_id = $1 AND level = 'ad'
                AND (($2::text IS NOT NULL AND replace(id::text, '-', '') LIKE $2::text || '%') OR ($3::text IS NOT NULL AND meta_id = $3::text))
              ORDER BY ($2::text IS NOT NULL AND replace(id::text, '-', '') LIKE $2::text || '%') DESC
              LIMIT 1`,
            [creatorId, prefix, adId]
        );
        return row ? { objectId: row.id, metaId: row.meta_id, name: row.name, offerId: row.offer_id, primaryText: row.primary_text } : null;
    } catch (err: any) {
        if (err?.code !== UNDEFINED_TABLE) log('warn', 'ads.join_failed', { creator_id: creatorId, ...describeError(err) });
        return null;
    }
}

/**
 * The stored copy's name for each of these Meta ad ids, for the Inbox's "from ad" chip. Ads not in the stored copy yet (or no stored copy at
 * all, before v53) are simply missing from the map: the chip then shows the title Meta sent with the click. Never throws.
 */
export async function adNamesFor(creatorId: string, adIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(adIds.filter((id) => typeof id === 'string' && id))];
    if (ids.length === 0) return out;
    try {
        const rows = await queryRows<{ meta_id: string; name: string | null }>(
            `SELECT meta_id, name FROM ads_objects WHERE creator_id = $1 AND level = 'ad' AND meta_id = ANY($2::text[])`,
            [creatorId, ids]
        );
        for (const r of rows) if (r.name) out.set(r.meta_id, r.name);
    } catch (err: any) {
        if (err?.code !== UNDEFINED_TABLE) log('warn', 'ads.names_unreadable', { creator_id: creatorId, ...describeError(err) });
    }
    return out;
}

/** Per ad id: the conversations that began from it (Instagram, Messenger and WhatsApp alike), the tracked-link clicks and the handoffs in them. */
export interface AdConversationResults {
    adId: string;
    conversations: number;
    trackedClicks: number;
    handoffs: number;
}

/**
 * The app-side results per ad: what Meta cannot see, because the sale happens on another site. For the Ads screen's results (`ads/mirror.ts`
 * `ObjectView.results`), one statement over the v54 index. Never throws; an error is no results.
 */
export async function resultsByAd(creatorId: string, adIds: readonly string[]): Promise<Map<string, AdConversationResults>> {
    const out = new Map<string, AdConversationResults>();
    if (adIds.length === 0) return out;
    try {
        const rows = await queryRows<{ ad_id: string; conversations: string; tracked_clicks: string; handoffs: string }>(
            `SELECT c.entry_source->>'ad_id' AS ad_id,
                    COUNT(DISTINCT c.id) AS conversations,
                    COUNT(lc.id) FILTER (WHERE NOT lc.is_prefetch) AS tracked_clicks,
                    COUNT(DISTINCT c.id) FILTER (WHERE c.handoff_at IS NOT NULL) AS handoffs
               FROM conversations c
               LEFT JOIN tracked_links tl ON tl.conversation_id = c.id AND tl.creator_id = c.creator_id
               LEFT JOIN link_clicks lc ON lc.code = tl.code
              WHERE c.creator_id = $1 AND c.entry_source ? 'ad_id' AND (c.entry_source->>'ad_id') = ANY($2::text[])
              GROUP BY 1`,
            [creatorId, [...adIds]]
        );
        for (const r of rows) {
            out.set(r.ad_id, { adId: r.ad_id, conversations: Number(r.conversations), trackedClicks: Number(r.tracked_clicks), handoffs: Number(r.handoffs) });
        }
    } catch (err) {
        log('warn', 'ads.results_unreadable', { creator_id: creatorId, ...describeError(err) });
    }
    return out;
}

// ─── The bot's ad context (ads.bot_context) ──────────────────────────────────────────────────────────

/** What the sales turn's facts block says about the ad (`SalesFacts.ad`). */
export interface AdFacts {
    /** The ad's name in the stored copy, else the title Meta sent with the click. */
    name: string;
    /** The title of the offer the app stored with the ad, or null (an ad made outside the app). */
    offerTitle: string | null;
    /** The ad's primary text, at most 200 characters, or null. */
    primaryText: string | null;
    /** The ice breaker they tapped (the postback's title), or null. */
    tapped: string | null;
}

/**
 * The ad facts for one sales turn, or null. Only for a conversation that began from a click-to-message ad (`entry_source.kind = 'ctm'`, or this
 * message carrying the first referral). The caller has already checked `ads.bot_context`. Pure apart from the join it is handed.
 */
export function adFactsFor(input: {
    entry: Pick<ConversationEntrySource, 'kind' | 'ads_context_data'> | null | undefined;
    joined: JoinedAd | null;
    offers: readonly { id: string; name: string }[];
    tapped: string | null;
}): AdFacts | null {
    if (input.entry?.kind !== 'ctm') return null;
    const name = str(input.joined?.name, 200) ?? str(input.entry.ads_context_data?.ad_title, 200);
    if (!name) return null;
    const offerId = input.joined?.offerId ?? null;
    const offerTitle = offerId ? input.offers.find((o) => o.id === offerId)?.name ?? null : null;
    const text = str(input.joined?.primaryText, 2000);
    return {
        name,
        offerTitle,
        primaryText: text ? (text.length > 200 ? `${text.slice(0, 199)}…` : text) : null,
        tapped: str(input.tapped, 200),
    };
}

// ─── The reply window (ads.extended_window) ──────────────────────────────────────────────────────────

type WindowConversation = { entry_source?: Pick<ConversationEntrySource, 'kind' | 'platform'> | null };

/**
 * How long after the person's last message the bot may still write: 23 hours, or 7 days less an hour for a conversation that began from a
 * click-to-message ad on a platform whose `ads.extended_window` switch is on. Pure.
 */
export function windowFor(conversation: WindowConversation, switches: Pick<AdsSwitches, 'extendedWindow'>): number {
    const e = conversation.entry_source;
    if (e?.kind === 'ctm' && e.platform && switches.extendedWindow[e.platform]) return AD_WINDOW_MS;
    return DEFAULT_WINDOW_MS;
}

/**
 * When the window closes. Meta's 7-day ad window starts at the click, not at the person's last message, so an ad conversation with the switch
 * on may be written to until the LATER of (their last message + 23 h) and (the ad click + 7 d − 1 h); any other until their last message + 23 h.
 * Pure.
 */
export function windowEndsAt(
    conversation: { entry_source?: Pick<ConversationEntrySource, 'kind' | 'platform' | 'at'> | null },
    lastInboundAt: Date,
    switches: Pick<AdsSwitches, 'extendedWindow'>
): Date {
    const base = lastInboundAt.getTime() + DEFAULT_WINDOW_MS;
    if (windowFor(conversation, switches) !== AD_WINDOW_MS) return new Date(base);
    const clickedAt = Date.parse(conversation.entry_source?.at ?? '');
    if (!Number.isFinite(clickedAt)) return new Date(base);
    return new Date(Math.max(base, clickedAt + AD_WINDOW_MS));
}

// ─── Send refusals that belong to ad traffic ─────────────────────────────────────────────────────────

/** Meta Business AI holds this Instagram thread: untagged sends fail with 100 / 2534037 until the owner takes control back. Pure. */
export function isBusinessAiBlock(err: unknown): boolean {
    return metaErrorCode(err) === 100 && metaErrorSubcode(err) === 2534037;
}

/** A send refused for being outside the messaging window: 10 / 2018278, or 551 ("this person isn't available right now"). Pure. */
export function isWindowRefusal(err: unknown): boolean {
    const code = metaErrorCode(err);
    return (code === 10 && metaErrorSubcode(err) === 2018278) || code === 551;
}

/**
 * The ads alerts A3 raises: `business_ai` and `window_error`. Delivered through the ads alert channel (`ads/notify.ts`, once per kind per object
 * per day) when it exists; logged at error level either way, so the log alert sees it.
 */
export type AttributionAlertKind = 'business_ai' | 'window_error';

export type AttributionAlertSink = (alert: { creatorId: string; kind: AttributionAlertKind; objectKey: string; detail: Record<string, unknown> }) => Promise<void>;

let alertSink: AttributionAlertSink | null = null;

/** Wire the ads alert channel in (and tests a recorder). Null goes back to the log only. */
export function setAttributionAlertSink(sink: AttributionAlertSink | null): void {
    alertSink = sink;
}

async function raiseAlert(creatorId: string, kind: AttributionAlertKind, objectKey: string, detail: Record<string, unknown>): Promise<void> {
    log('error', `ads.alert_${kind}`, { creator_id: creatorId, object_key: objectKey, ...detail });
    if (!alertSink) return;
    try {
        await alertSink({ creatorId, kind, objectKey, detail });
    } catch (err) {
        log('error', 'ads.alert_failed', { creator_id: creatorId, kind, ...describeError(err) });
    }
}

/**
 * A send failed because Meta Business AI owns the thread: the conversation records why the bot is silent, and the owner is told, once (the
 * conversation's reason is set only when it was not already; the alert channel dedupes per day on top). Nothing is retried. Never throws.
 */
export async function noteBusinessAiBlock(creatorId: string, conversationId: string): Promise<void> {
    try {
        const changed = await queryOne<{ id: string }>(
            `UPDATE conversations SET no_reply_reason = 'business_ai_owns_thread'
              WHERE id = $1 AND creator_id = $2 AND no_reply_reason IS DISTINCT FROM 'business_ai_owns_thread'
          RETURNING id`,
            [conversationId, creatorId]
        );
        if (changed) await raiseAlert(creatorId, 'business_ai', creatorId, { conversation_id: conversationId });
        else log('info', 'ads.business_ai_still_owns', { conversation_id: conversationId });
    } catch (err) {
        log('error', 'ads.business_ai_note_failed', { conversation_id: conversationId, ...describeError(err) });
    }
}

/** A send went out after all: the Business AI block is over. One statement that touches no row in the usual case. Never throws. */
export async function clearNoReplyReason(conversationId: string): Promise<void> {
    try {
        await queryOne('UPDATE conversations SET no_reply_reason = NULL WHERE id = $1 AND no_reply_reason IS NOT NULL RETURNING id', [conversationId]);
    } catch (err) {
        log('warn', 'ads.no_reply_reason_clear_failed', { conversation_id: conversationId, ...describeError(err) });
    }
}

/**
 * A send to an ad-started conversation was refused for being outside the window: Meta did not give this platform the longer window we
 * assumed, so `ads.extended_window` goes off for it, by itself, and the owner is told. Only when the switch was on: with it off, a window
 * refusal is the ordinary 24-hour rule and says nothing about ads. Never throws.
 */
export async function noteWindowRefusal(creatorId: string, platform: AdPlatform, conversationId: string): Promise<boolean> {
    try {
        const current = await readExtendedWindow(creatorId);
        if (!current[platform]) return false;
        await writeAdsSwitches(creatorId, { extendedWindow: { [platform]: false } }, null);
        await raiseAlert(creatorId, 'window_error', `${creatorId}:${platform}`, { platform, conversation_id: conversationId });
        return true;
    } catch (err) {
        log('error', 'ads.window_note_failed', { creator_id: creatorId, platform, ...describeError(err) });
        return false;
    }
}

/** `conversations.platform` ('instagram' | 'facebook') as the ad platform, or null for any other. Pure. */
export function adPlatformOf(platform: string | null | undefined): AdPlatform | null {
    return platform === 'instagram' ? 'instagram' : platform === 'facebook' ? 'messenger' : null;
}
