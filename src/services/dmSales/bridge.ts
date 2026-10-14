/**
 * The comment -> DM bridge (docs/DM_SALES_PLAN.md §10, S10): a person who commented a keyword, was sent the link in a private reply, and
 * then writes back is not a stranger to the DM bot. Two halves, one on each path:
 *
 *   comment path   `recordPrivateReplyRecipient`: after the private reply is SENT, the id it went to (`recipient_id` in Meta's response,
 *                  the platform-scoped id) is written on the interaction, with the campaign whose text was sent (migration v41).
 *   DM path        `commentSource`: when that person's DM reaches a SALES turn, the latest SENT interaction whose `recipient_id` is the
 *                  DM's sender, inside `BRIDGE_WINDOW_MS`, names the campaign the conversation began with. It is stored on
 *                  `conversations.source_campaign_id`, and the turn starts at `recommend` with "they commented «keyword» and were
 *                  sent the link to <offer>" among the conversation's facts, instead of qualifying from scratch.
 *
 * **Nothing here can change what happens to a comment or to a DM.** The comment half runs after the interaction is SENT and the caller
 * wraps it (it throws, and the call site in `comments.ts` catches: the status stays SENT and the public reply still goes out). The DM half
 * never throws: a database that is behind (v41 not applied), an error, a row it cannot read all answer "no source", and the turn is the
 * one it would have been without a bridge. It is only ever called from the sales turn, so `sales_mode = 'off'` (and a `test` sender who is
 * not listed) runs not one statement more than before.
 *
 * **The window is 7 days.** The plan states no figure; this is Meta's own private-reply horizon (§2: one private reply per comment, within
 * 7 days). A person who answers a private reply later than that is, far more likely than not, asking about something else, and the thread
 * is not presented to the model as an answer to it. The source already stored on the conversation outlives the window: it is still true
 * that this person came from that comment.
 *
 * **Assumption A1** (the plan's §13): the `recipient_id` of a private reply equals the `sender.id` of the same person's DMs, both the
 * Instagram-scoped id. Until the owner has seen it hold, every match logs the two ids side by side (`dm.bridge_matched`), and every
 * recording logs the id next to the commenter's own (`comment.bridge_recorded`). A DM that matches nothing is not logged (most do not):
 * the sign that A1 is false is a `comment.bridge_recorded` line whose `recipient_id` is the id of nobody who later writes.
 *
 * What it does not do (the plan's §10 also lists them; they are not built): create the conversation at comment time, or write the private
 * reply into it as an outbound `automation` message. The conversation is created by the person's first DM, as it always was.
 */
import { queryCount, queryOne } from '../../db/query.js';
import { normalizeArabic } from '../../utils/arabic.js';
import { describeError, log } from '../../utils/log.js';
import type { Offer } from '../profile/types.js';
import { linkKey } from './guard.js';
import type { SalesState } from './store.js';
import type { SalesFacts, Stage } from './types.js';

/** 7 days: Meta's private-reply horizon (see the top of the file). */
export const BRIDGE_WINDOW_DAYS = 7;
export const BRIDGE_WINDOW_MS = BRIDGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type BridgePlatform = 'instagram' | 'facebook';

// ─── Pure ────────────────────────────────────────────────────────────────────────────────────

/**
 * The id a private reply went to, from Meta's response to it; null when the response names none. Only a non-empty string counts: Meta
 * sends ids as strings, and a number would already have lost digits past 2^53. The `landed_before_retry` answer
 * (`sendPrivateReply`: Meta refused the second try because the first had gone through) carries no id at all.
 */
export function recipientIdOf(response: unknown): string | null {
    if (!response || typeof response !== 'object') return null;
    const id = (response as { recipient_id?: unknown }).recipient_id;
    if (typeof id !== 'string') return null;
    const trimmed = id.trim();
    return trimmed.length > 0 && trimmed.length <= 255 ? trimmed : null;
}

/**
 * Is a private reply sent at `at` recent enough to be what a DM sent at `now` answers? A reply sent exactly `BRIDGE_WINDOW_MS` ago still
 * is; one millisecond older is not. One stamped in the future (the database's clock a little ahead of this server's) is as recent as can be.
 */
export function inBridgeWindow(at: Date | string | number, now: Date): boolean {
    const sent = at instanceof Date ? at.getTime() : new Date(at).getTime();
    if (Number.isNaN(sent)) return false;
    return now.getTime() - sent <= BRIDGE_WINDOW_MS;
}

/** The campaign the conversation began with, as the sales turn needs it. */
export interface CommentSource {
    campaignId: string;
    /** The campaign's trigger keywords as saved (a comma-separated list). */
    triggerKeywords: string;
    /** The text of the private reply the campaign sends. */
    dmTemplate: string;
}

/** The first of a campaign's trigger keywords: what the model is told they commented. */
export function firstKeyword(triggerKeywords: string): string {
    return triggerKeywords.split(/[,،]/).map((k) => k.trim()).find(Boolean) ?? '';
}

/** The offer the campaign sells, and how it was found: the address in its text (the link was certainly sent), or a keyword the offer carries. */
export interface CampaignOffer {
    offerId: string;
    via: 'url' | 'keyword';
}

/** What of an offer the campaign is matched against. */
export type BridgeOffer = Pick<Offer, 'id' | 'url'> & { campaign?: Pick<NonNullable<Offer['campaign']>, 'keywords'> };

/** Every web address a text holds, as a link key (`guard.ts`: host in any case, path and query exactly), trailing punctuation off. */
function addressKeys(text: string): Set<string> {
    const found = text.match(/\bhttps?:\/\/[^\s<>«»"')\]]+/gi) ?? [];
    return new Set(found.map((u) => linkKey(u.replace(/[.,;:!?؟،؛…]+$/, ''))));
}

/**
 * Which offer a campaign sells (plan §10: "matching the campaign to `offers[].campaign.keywords` or the URL in `dm_template`").
 *
 * The address wins: an offer whose own `url` is in the campaign's text is the one whose link the person was sent. Failing that, the
 * offer that carries one of the campaign's trigger keywords (`Offer.campaign.keywords`, which is how the bulk import made the campaign).
 * Either way ONLY when exactly one offer fits: two offers in one text, or one keyword on two offers, is a guess, and a guess is `null`
 * (the model is told they were sent "a link" and no offer is named, which is true).
 */
export function offerForCampaign(campaign: Pick<CommentSource, 'triggerKeywords' | 'dmTemplate'>, offers: readonly BridgeOffer[]): CampaignOffer | null {
    const addresses = addressKeys(campaign.dmTemplate);
    if (addresses.size > 0) {
        const byUrl = offers.filter((o) => /^https?:\/\/\S+$/i.test(o.url.trim()) && addresses.has(linkKey(o.url.trim())));
        if (byUrl.length === 1) return { offerId: byUrl[0]!.id, via: 'url' };
        if (byUrl.length > 1) return null;
    }
    const triggers = new Set(campaign.triggerKeywords.split(/[,،]/).map((k) => normalizeArabic(k.trim())).filter(Boolean));
    if (triggers.size === 0) return null;
    const byKeyword = offers.filter((o) => (o.campaign?.keywords ?? []).some((k) => triggers.has(normalizeArabic(k.trim()))));
    return byKeyword.length === 1 ? { offerId: byKeyword[0]!.id, via: 'keyword' } : null;
}

/**
 * Where the turn starts. A conversation that has just begun (`new`, no qualifier asked, no link sent by the bot) and has a source starts at
 * `recommend`: the person already asked for the offer by commenting, and has been sent its link. Anywhere else the conversation's own stage
 * stands: a bridge never moves a conversation that is already going.
 */
export function openingStage(state: Pick<SalesState, 'stage' | 'qualifierTurns' | 'offersLinked'>, source: CommentSource | null): Stage {
    const fresh = state.stage === 'new' && state.qualifierTurns === 0 && state.offersLinked.length === 0;
    return source && fresh ? 'recommend' : state.stage;
}

/**
 * What the source adds to the conversation's facts (`salesFactsBlock`): the comment, and the link already sent for an offer found by its
 * address in the campaign's text. The model is thereby told not to send it again unless asked; `conversations.offers_linked` is NOT touched
 * (a private reply is not a link the bot sent, and the follow-up job reads that column: §10 "no nudge is ever sent on the private reply alone").
 */
export function bridgeFacts(source: CommentSource, offers: readonly BridgeOffer[]): { comment: NonNullable<SalesFacts['comment']>; linkSentFor: string[] } {
    const offer = offerForCampaign(source, offers);
    return {
        comment: { keyword: firstKeyword(source.triggerKeywords), offerId: offer?.offerId ?? null },
        linkSentFor: offer?.via === 'url' ? [offer.offerId] : [],
    };
}

// ─── Comment path ────────────────────────────────────────────────────────────────────────────

export interface PrivateReplyRecord {
    interactionId: string;
    creatorId: string;
    /** The campaign whose text was sent. The interaction already names the one it was claimed with; a resumed row is written with the one that actually went. */
    campaignId: string;
    /** The commenter's own id from the comment webhook, logged next to the recipient's (A1). */
    commenterId: string;
    platform: BridgePlatform;
}

/**
 * Write down who the private reply went to, on the interaction. Called AFTER the interaction is SENT, and by a caller that catches: this
 * throws on a database error and says nothing else about the comment. Returns whether an id was recorded; a response with none (the reply
 * landed on a retry) records nothing and says so in the log.
 *
 * One statement, by primary key and tenant: no Graph call, no read.
 */
export async function recordPrivateReplyRecipient(response: unknown, rec: PrivateReplyRecord): Promise<boolean> {
    const recipientId = recipientIdOf(response);
    const logBase = { interaction_id: rec.interactionId, campaign_id: rec.campaignId, platform: rec.platform };
    if (!recipientId) {
        const landed = Boolean(response && typeof response === 'object' && (response as { landed_before_retry?: unknown }).landed_before_retry);
        log(landed ? 'info' : 'warn', 'comment.bridge_no_recipient', {
            ...logBase, landed_before_retry: landed, effect: 'the reply is not joined to a later DM: nothing was recorded',
        });
        return false;
    }
    await queryCount(
        'UPDATE interactions SET recipient_id = $1, campaign_id = $2 WHERE id = $3 AND creator_id = $4',
        [recipientId, rec.campaignId, rec.interactionId, rec.creatorId]
    );
    // A1, the recording half: the id the reply went to, next to the id the comment webhook named as its author.
    log('info', 'comment.bridge_recorded', { ...logBase, recipient_id: recipientId, commenter_id: rec.commenterId, same_id: recipientId === rec.commenterId });
    return true;
}

// ─── DM path ─────────────────────────────────────────────────────────────────────────────────

export interface BridgeLookup {
    conversationId: string;
    creatorId: string;
    /** The DM's `sender.id`. */
    senderId: string;
    platform: BridgePlatform;
}

interface SourceRow {
    current_source: string | null;
    interaction_id: string | null;
    recent_campaign: string | null;
    recipient_id: string | null;
    replied_at: Date | string | null;
    recent_keywords: string | null;
    recent_template: string | null;
    current_keywords: string | null;
    current_template: string | null;
}

/**
 * The newest SENT interaction of this tenant whose private reply went to this sender (the partial index of v41), with its campaign, and the
 * campaign the conversation already has. ONE statement, and no time filter in it: the window is `inBridgeWindow`'s, applied to what it returns.
 */
const SOURCE_SQL = `SELECT c.source_campaign_id AS current_source,
        r.id AS interaction_id, r.campaign_id AS recent_campaign, r.recipient_id, r.timestamp AS replied_at,
        rc.trigger_keyword AS recent_keywords, rc.dm_template AS recent_template,
        cc.trigger_keyword AS current_keywords, cc.dm_template AS current_template
   FROM conversations c
   LEFT JOIN LATERAL (
         SELECT i.id, i.campaign_id, i.recipient_id, i.timestamp
           FROM interactions i
          WHERE i.creator_id = $2 AND i.recipient_id = $3 AND i.status = 'SENT' AND i.campaign_id IS NOT NULL
            AND i.platform = $4
          ORDER BY i.timestamp DESC, i.id DESC
          LIMIT 1) r ON TRUE
   LEFT JOIN campaigns rc ON rc.id = r.campaign_id
   LEFT JOIN campaigns cc ON cc.id = c.source_campaign_id
  WHERE c.id = $1 AND c.creator_id = $2`;

/**
 * The campaign this conversation began with, for the sales turn; null when there is none. Stores it on `conversations.source_campaign_id`
 * when the person's DM follows a private reply inside the window and the conversation does not already name that campaign (so a match is
 * written, and logged, ONCE). Never throws: see the top of the file.
 *
 * `now` is a parameter so the window's edge is a test and not a coincidence of the clock.
 */
export async function commentSource(input: BridgeLookup, now: Date = new Date()): Promise<CommentSource | null> {
    try {
        const row = await queryOne<SourceRow>(SOURCE_SQL, [input.conversationId, input.creatorId, input.senderId, input.platform]);
        if (!row) return null;

        const recent = row.recent_campaign !== null && row.recent_keywords !== null && row.replied_at !== null && inBridgeWindow(row.replied_at, now);
        if (recent) {
            const source: CommentSource = { campaignId: row.recent_campaign!, triggerKeywords: row.recent_keywords!, dmTemplate: row.recent_template ?? '' };
            if (row.current_source !== source.campaignId) await storeSource(input, row, source, now);
            return source;
        }
        // Not recent, or no private reply from this sender at all: whatever the conversation already names still holds.
        if (row.current_source !== null && row.current_keywords !== null) {
            return { campaignId: row.current_source, triggerKeywords: row.current_keywords, dmTemplate: row.current_template ?? '' };
        }
        return null;
    } catch (err) {
        log('warn', 'dm.bridge_failed', {
            creator_id: input.creatorId, conversation_id: input.conversationId, stage: 'lookup', ...describeError(err),
            effect: 'the turn runs without a source campaign, as it would have before the bridge',
        });
        return null;
    }
}

/** Store a match on the conversation and log it: the id the private reply went to beside the id the DM came from (A1). A failed write is logged, never thrown. */
async function storeSource(input: BridgeLookup, row: SourceRow, source: CommentSource, now: Date): Promise<void> {
    const repliedAt = row.replied_at instanceof Date ? row.replied_at : new Date(row.replied_at as string);
    log('info', 'dm.bridge_matched', {
        creator_id: input.creatorId, conversation_id: input.conversationId, campaign_id: source.campaignId, interaction_id: row.interaction_id,
        previous_campaign_id: row.current_source,
        sender_id: input.senderId, recipient_id: row.recipient_id, same_id: row.recipient_id === input.senderId,
        age_minutes: Math.max(0, Math.round((now.getTime() - repliedAt.getTime()) / 60_000)),
    });
    try {
        await queryCount(
            'UPDATE conversations SET source_campaign_id = $2 WHERE id = $1 AND creator_id = $3',
            [input.conversationId, source.campaignId, input.creatorId]
        );
    } catch (err) {
        log('warn', 'dm.bridge_failed', {
            creator_id: input.creatorId, conversation_id: input.conversationId, stage: 'store', ...describeError(err),
            effect: 'the source campaign is used for this turn only and is written on the next message',
        });
    }
}
