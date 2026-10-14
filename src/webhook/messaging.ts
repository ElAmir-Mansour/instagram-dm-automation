/**
 * The DM pipeline: `entry.messaging` → Gemini → Meta Send API.
 *
 * Previously ~180 lines inline in the webhook handler, sharing one try/catch with the comment
 * pipeline — so a duplicate-key error here aborted the comment events queued behind it.
 */
import { queryCount, queryOne } from '../db/query.js';
import type { ConversationPlatform, ConversationRow, MessageRow } from '../db/rows.js';
import { generateDmReply } from '../services/dmEngine.js';
import { answersWithSales, readSalesSettings } from '../services/dmSales/mode.js';
import { runSalesTurn } from '../services/dmSales/turn.js';
import { profileContextOrLegacy } from '../services/profile/context.js';
import { sendDirectMessage } from '../services/instagram.js';
import { isPermanentMetaError } from '../services/http.js';
import { PROFILE_WAIT_MS, refreshSenderProfile, settleWithin } from '../services/senderProfile.js';
import { noteMetaFailure } from '../services/tokenHealth.js';
import { getCreatorByPageId, type Creator } from '../services/tenant.js';
import { checkFairSendQuota } from '../utils/rateLimiter.js';
import { acknowledgeWordless } from './attachmentAck.js';
import { describeWordless, WORDLESS_PLACEHOLDERS, type Wordless } from './attachments.js';
import { toMetaMessage, applyDisclosure, disclosureLine, type MetaMessagePayload } from './meta-payload.js';
import { FINAL_ATTEMPT, type WebhookHandlerOptions } from './options.js';
import { describeError, log, withLogContext } from '../utils/log.js';

/**
 * Meta asks for a fresh disclosure "after a significant lapse of time". The policy never
 * quantifies it; a week is long enough that the thread reads as a new conversation to the
 * person on the other end.
 */
const DISCLOSURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long one attempt may hold an inbound message before another may take it.
 *
 * Only reached when an invocation dies mid-flight: a transient failure releases its own claim
 * explicitly. Generous on purpose — taking a claim from a run that is still working is how the
 * same person gets answered twice, which is worse than being answered a few minutes late.
 * Matches `CLAIM_VISIBILITY_SECONDS` in src/jobs/runner.ts for the same reason.
 */
const REPLY_CLAIM_VISIBILITY_SECONDS = 300;

export interface NormalizedDm {
    senderId: string;
    text: string;
    payload: string;
    isStoryMention: boolean;
    /**
     * What the message is when it has no words: no text and no quick-reply payload, but a photo, a voice note, a shared reel, a story mention,
     * a reply to a story or a message Instagram could not show (src/webhook/attachments.ts). Null for anything with words. A message with
     * words is answered by a model; one without is stored as its kind and acknowledged with a fixed line, never answered by a model.
     */
    wordless: Wordless | null;
    /** Meta's message id — the dedupe key. Null for events that carry none. */
    metaMessageId: string | null;
}

/** What a story mention says, in the absence of any text the person actually typed: the placeholder it has always been stored as. */
export const STORY_MENTION_TEXT = WORDLESS_PLACEHOLDERS.story_mention;

/**
 * The one string that stands for "what this person said", for BOTH the stored row and the
 * Gemini call.
 *
 * The two used to be computed separately and could disagree, and for a pure story mention
 * they always did: the row stored `'[Story Mention]'` while `generateAiResponse` was handed
 * `dm.text || dm.payload`, which is `''`. That matters because of how `src/services/ai.ts`
 * decides whether the current message is already in the history it just read — it compares
 * the last stored row's text against the string it was passed, and appends a turn when they
 * differ. With the two disagreeing it always differed, so every story mention sent Gemini a
 * trailing `{ role: 'user', parts: [{ text: '' }] }`: an empty turn after a `user` turn that
 * already existed, which is at best a wasted part and at worst a 400 from the API.
 *
 * A quick reply with no accompanying text had the same shape from the other side — the row
 * stored `''` while the payload went to Gemini — so the payload is folded in here too and the
 * inbox stops showing an empty bubble for a button somebody pressed.
 *
 * The last resort is the word-less placeholder (`[photo]`, `[Story Mention]`): it is what is STORED for a message with no words, and so
 * what a later model turn sees in the history, as the customer's earlier message. The model is never asked to answer it: a word-less
 * message is acknowledged with a fixed line (`attachmentAck.ts`) before any model is reached, in every `sales_mode`.
 *
 * Exported so the test can assert the two call sites cannot drift apart again.
 */
export function dmPromptText(dm: NormalizedDm): string {
    return dm.text || dm.payload || dm.wordless?.placeholder || '';
}

/**
 * Flatten the shapes a messaging event arrives in (plain message, quick reply, postback, and a message with no words: an attachment, a
 * reply to a story, an unsupported message) into one. Returns null for events with nothing to reply to or to store.
 *
 * Exported for src/webhook/messaging.test.ts. It is pure, and the alternative is a test that
 * reaches it only through the whole database-and-Gemini pipeline.
 */
export function normalizeDm(event: any): NormalizedDm | null {
    const senderId = event?.sender?.id;

    // An unsend (`message.is_deleted`) is not a new message, even one that still lists attachments: nothing to store and nobody to answer.
    if (event?.message?.is_deleted) return skippedEmpty(event);

    let text: string = event?.message?.text || '';
    let payload = '';

    if (event?.message?.quick_reply) {
        payload = event.message.quick_reply.payload || '';
        log('debug', 'dm.quick_reply', { payload });
    }

    if (event?.postback) {
        text = event.postback.title || '';
        payload = event.postback.payload || '';
        log('debug', 'dm.postback', { payload });
    }

    let isStoryMention = false;
    if (Array.isArray(event?.message?.attachments)) {
        const storyMention = event.message.attachments.find((att: any) => att?.type === 'story_mention');
        if (storyMention) {
            isStoryMention = true;
            log('debug', 'dm.story_mention', { sender_id: senderId });
        }
    }

    // A message with no words, and only then: a caption, a typed line or a tapped button is words, and is answered as it always was.
    const wordless = !text && !payload ? describeWordless(event?.message) : null;

    if (!senderId || (!text && !payload && !wordless)) return skippedEmpty(event);

    return {
        senderId,
        text,
        payload,
        isStoryMention,
        wordless,
        metaMessageId: event?.message?.mid ?? event?.postback?.mid ?? null,
    };
}

/**
 * `normalizeDm`'s "nothing to reply to or to store": read watermarks, delivery receipts, reactions, referrals and an unsend. A message with
 * only an attachment is NOT here any more (it is a word-less message, `describeWordless`), so what lands here is not a person waiting;
 * the log says what the event held all the same.
 */
function skippedEmpty(event: any): null {
    log('debug', 'dm.skipped_empty', {
        has_message: Boolean(event?.message),
        is_deleted: Boolean(event?.message?.is_deleted),
        attachment_types: Array.isArray(event?.message?.attachments)
            ? event.message.attachments.map((att: any) => att?.type ?? 'unknown')
            : [],
        event_keys: event && typeof event === 'object' ? Object.keys(event) : [],
    });
    return null;
}

/**
 * Which endpoint the Send API call has to use.
 *
 * Meta requires `/{page-id}/messages` for Page access tokens; `/me/messages` only resolves
 * correctly for Instagram-Login tokens. The comment path has always threaded the Facebook
 * Page id through — the DM path never did, so every Facebook Messenger reply went to `/me`.
 * There is no `field === 'feed'` marker on a messaging event, so the signal is the page id
 * the event is addressed to.
 *
 * Exported for src/webhook/messaging.test.ts.
 */
export function resolveDmPageId(creator: Creator, addressedTo: (string | undefined)[]): string | undefined {
    if (!creator.facebook_page_id) return undefined;
    return addressedTo.some((id) => id && id === creator.facebook_page_id)
        ? creator.facebook_page_id
        : undefined;
}

/**
 * Which network a DM arrived on, for `conversations.platform` (v26).
 *
 * The exact answer is the webhook body's `object`: Meta sends `'instagram'` for Instagram
 * messaging and `'page'` for Messenger, and it is the only field that says so outright. It lives on
 * the body rather than the event, so it reaches here through the job payload; a job queued before
 * v26 has none. For those, the fallback is which of the tenant's page ids the event was addressed
 * to — `recipient.id` first, which on a message event is the account that received it, then
 * `entry.id`, which `processDm` notes may be either id depending on the subscription. Not
 * `resolveDmPageId`: that answers "which endpoint", a different question. No match either way is
 * `null`, which the dashboard shows as no platform at all rather than a guess.
 *
 * Exported for src/webhook/messaging.test.ts.
 */
export function dmPlatform(
    object: unknown,
    creator: Pick<Creator, 'instagram_page_id' | 'facebook_page_id'>,
    addressedTo: (string | undefined)[]
): ConversationPlatform | null {
    if (object === 'instagram') return 'instagram';
    if (object === 'page') return 'facebook';
    for (const id of addressedTo) {
        if (!id) continue;
        if (creator.instagram_page_id && id === creator.instagram_page_id) return 'instagram';
        if (creator.facebook_page_id && id === creator.facebook_page_id) return 'facebook';
    }
    return null;
}

/** Exported for src/webhook/messaging.test.ts. */
export function needsDisclosure(disclosedAt: string | Date | null | undefined): boolean {
    if (!disclosedAt) return true;
    const at = disclosedAt instanceof Date ? disclosedAt.getTime() : Date.parse(disclosedAt);
    if (Number.isNaN(at)) return true;
    return Date.now() - at > DISCLOSURE_MAX_AGE_MS;
}

export async function handleMessagingEvent(
    event: any,
    entryId: string,
    options: WebhookHandlerOptions = FINAL_ATTEMPT
): Promise<void> {
    const recipientId = event?.recipient?.id;

    // Ignore echo messages (sent by the page itself)
    if (event?.message?.is_echo) {
        log('debug', 'dm.skipped_echo');
        return;
    }

    const dm = normalizeDm(event);
    if (!dm) return;

    // The Meta message id is the dedupe key, so it is the field to correlate on: every line
    // below belongs to this one inbound message, retries included.
    return withLogContext({ mid: dm.metaMessageId, sender_id: dm.senderId }, () =>
        processDm(dm, event, recipientId, entryId, options)
    );
}

/** The inbound row, plus whether this attempt inherited it from a previous one. */
interface InboundClaim {
    id: string;
    resumed: boolean;
    attempts: number;
}

/**
 * Write down the inbound message and claim the right to answer it.
 *
 * `messages.meta_message_id UNIQUE` was carrying two meanings at once. It correctly stopped a
 * Meta redelivery from re-running a paid Gemini call and re-sending a DM to a real person — and
 * it also, unintentionally, stopped every *retry* from doing anything, because the row is
 * written before the AI call. So a transient Gemini 503 or a Meta blip meant: inbound row
 * saved, no reply sent, job marked done, and every subsequent attempt logging
 * `dm.duplicate_ignored` and returning successfully. The customer was never answered and
 * nothing anywhere said so. Four months of untested DM traffic would have surfaced this the
 * first time Gemini rate-limited a request.
 *
 * v14 splits the two meanings: the UNIQUE index still dedupes, and `handled_at` records
 * whether the pipeline ever reached a conclusion. `reply_claimed_at` is a visibility timeout
 * so that resuming cannot become two runs answering the same person at once.
 */
async function claimInbound(
    conversationId: string,
    creatorId: string,
    dm: NormalizedDm,
    event: any
): Promise<InboundClaim | null> {
    const inserted = await queryOne<Pick<MessageRow, 'id'>>(
        `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, payload,
                               raw_payload, meta_message_id, reply_claimed_at, reply_attempts, sender)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, NOW(), 1, 'customer')
         ON CONFLICT (meta_message_id) WHERE meta_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
            conversationId,
            creatorId,
            // `message_type` is one of the word-less kinds exactly when the message has no words (`WORDLESS_MESSAGE_TYPES`): the sales
            // turn's `supersession` and the acknowledgement's claim tell the two apart in SQL by it.
            dm.wordless ? dm.wordless.kind : 'text',
            dmPromptText(dm),
            dm.payload || null,
            JSON.stringify(event),
            dm.metaMessageId,
        ]
    );
    if (inserted) return { id: inserted.id, resumed: false, attempts: 1 };

    // An event with no `mid` can never conflict (the unique index is partial), so reaching
    // here means there is a row with this mid already.
    const resumed = await queryOne<Pick<MessageRow, 'id' | 'reply_attempts'>>(
        `UPDATE messages
            SET reply_claimed_at = NOW(),
                reply_attempts = reply_attempts + 1
          WHERE meta_message_id = $1
            AND handled_at IS NULL
            AND (reply_claimed_at IS NULL OR reply_claimed_at < NOW() - make_interval(secs => $2))
      RETURNING id, reply_attempts`,
        [dm.metaMessageId, REPLY_CLAIM_VISIBILITY_SECONDS]
    );

    // No row means either the message was already handled — the redelivery case this index
    // exists for — or another attempt is holding a live claim on it right now. Both mean
    // "not ours to answer".
    if (!resumed) return null;

    return { id: resumed.id, resumed: true, attempts: resumed.reply_attempts };
}

/** Terminal: the pipeline reached a conclusion for this inbound message, good or bad. */
async function markHandled(messageId: string): Promise<void> {
    await queryCount(
        'UPDATE messages SET handled_at = NOW(), reply_claimed_at = NULL WHERE id = $1',
        [messageId]
    );
}

/**
 * Non-terminal: hand the message back so the next attempt can claim it immediately.
 *
 * Without this, a released message would wait out the whole visibility window before a retry
 * could touch it — and the job runner's first backoff is ~30 seconds, far shorter than that.
 * Releasing explicitly is what makes the retry actually reach the work.
 */
async function releaseInbound(messageId: string): Promise<void> {
    await queryCount(
        'UPDATE messages SET reply_claimed_at = NULL WHERE id = $1 AND handled_at IS NULL',
        [messageId]
    );
}

/**
 * Work that rides along with one DM and must be finished before its job is, but never decides how the DM turns out.
 * Today that is the sender's profile lookup (`refreshSenderProfile`), which resolves whatever happened and never throws.
 */
interface DmSideTasks {
    profile: Promise<unknown>;
}

async function processDm(
    dm: NormalizedDm,
    event: any,
    recipientId: string | undefined,
    entryId: string,
    options: WebhookHandlerOptions
): Promise<void> {
    const side: DmSideTasks = { profile: Promise.resolve() };
    try {
        await answerDm(dm, event, recipientId, entryId, options, side);
    } finally {
        // Awaited whichever way the DM ended, and AFTER it: the lookup started alongside the reply, so it only ever costs the job time it
        // did not need to spend, and a serverless instance that is frozen after the response does not freeze it half way. For at most
        // `PROFILE_WAIT_MS`: the reply is sent and the message handled by now, and a slow Meta must not hold the job for it. `settleWithin`
        // never rejects: `refreshSenderProfile` does not either, and a profile must not be able to turn an answered DM into a failed job.
        await settleWithin(side.profile, PROFILE_WAIT_MS);
    }
}

async function answerDm(
    dm: NormalizedDm,
    event: any,
    recipientId: string | undefined,
    entryId: string,
    options: WebhookHandlerOptions,
    side: DmSideTasks
): Promise<void> {
    log('info', 'dm.received', { is_story_mention: dm.isStoryMention, has_payload: Boolean(dm.payload), wordless_kind: dm.wordless?.kind ?? null });

    // Whether this attempt may leave work for another one.
    //
    // The `mid` is load-bearing and not decoration: it is the only thing that lets a second
    // attempt recognise the row the first one wrote. Without it the partial unique index never
    // fires, so a retry would insert a *second* inbound row for the same event and answer the
    // same person twice. An event with no `mid` therefore gets exactly one attempt, whatever
    // the job budget says.
    const mayRetry = Boolean(dm.metaMessageId) && !options.lastAttempt;

    // recipientId from message events = Instagram Business Account ID (most reliable)
    // entryId = could be IG ID (app-level sub) or FB Page ID (page-level sub)
    const creator = await getCreatorByPageId(recipientId, entryId);
    if (!creator) {
        log('warn', 'dm.no_creator', { recipient_id: recipientId, entry_id: entryId });
        return;
    }

    // 1. Fetch or create the conversation thread.
    //    One statement, not SELECT-then-INSERT: two DMs a second apart raced on the
    //    unique_creator_user constraint and the loser's duplicate-key error killed the batch.
    //    The DO UPDATE also replaces the separate last_message_at write.
    //    `platform` (v26) is set once and kept: COALESCE fills a thread written before v26 on
    //    its next DM, and never flips one that already has an answer.
    const platform = dmPlatform(options.object, creator, [recipientId, entryId]);
    const conversation = await queryOne<Pick<ConversationRow, 'id' | 'is_bot_active' | 'ai_disclosed_at'>>(
        `INSERT INTO conversations (creator_id, instagram_user_id, status, platform)
         VALUES ($1, $2, 'active', $3)
         ON CONFLICT (creator_id, instagram_user_id)
         DO UPDATE SET last_message_at = NOW(),
                       platform = COALESCE(conversations.platform, EXCLUDED.platform)
         RETURNING id, is_bot_active, ai_disclosed_at`,
        [creator.id, dm.senderId, platform]
    );

    if (!conversation) {
        // An upsert with DO UPDATE always returns its row, so no row means the statement did
        // not do what this code assumes. Previously this read `convRes.rows[0].id` and threw
        // a TypeError three lines later, from a place that said nothing about the cause.
        log('error', 'dm.conversation_upsert_empty', { creator_id: creator.id });
        return;
    }
    const conversationId: string = conversation.id;

    // 2. Log the inbound message — and claim the right to answer it. See `claimInbound`.
    const claim = await claimInbound(conversationId, creator.id, dm, event);
    if (!claim) {
        log('info', 'dm.duplicate_ignored');
        return;
    }
    if (claim.resumed) {
        log('info', 'dm.resumed', { message_id: claim.id, reply_attempts: claim.attempts });
    }

    // Who the sender is, for the inbox (v40): Instagram only, on first contact and at most once a day after that, started now so it
    // runs while the reply is being written and awaited in `processDm` once the DM is done. Best effort by construction: it never throws,
    // so nothing below can change because of it. See src/services/senderProfile.ts.
    if (platform === 'instagram') {
        side.profile = refreshSenderProfile({ conversationId, igsid: dm.senderId, token: creator.page_access_token });
    }

    // 3. Call AI Agent to reply if Bot is active
    if (!conversation.is_bot_active) {
        log('info', 'dm.bot_paused', { conversation_id: conversationId });
        // Terminal, not a failure: the operator took this thread over deliberately, and a
        // retry must not decide later that the bot should have answered after all.
        await markHandled(claim.id);
        return;
    }

    try {
        // A message with no words never reaches a brain, in any `sales_mode`: not Gemini, not the providers engine, not the sales turn. It is
        // already stored (as its kind); what is left is one fixed line from the kit, or nothing for a sticker (src/webhook/attachmentAck.ts).
        // First in the `try` so the catch below keeps its meaning for it: a transient send failure is retried, a permanent Meta error is final.
        // Always terminal otherwise: a refused quota or a claim that found an answer already on its way is not retried for an acknowledgement.
        if (dm.wordless) {
            const dmCtx = await profileContextOrLegacy(creator.id, 'dm');
            const ack = await acknowledgeWordless({
                creator: { id: creator.id, page_access_token: creator.page_access_token },
                pageId: resolveDmPageId(creator, [recipientId, entryId]),
                conversation: { id: conversationId },
                inbound: { id: claim.id, senderId: dm.senderId },
                wordless: dm.wordless,
                ctx: dmCtx,
                disclosure: { needed: needsDisclosure(conversation.ai_disclosed_at), line: disclosureLine(dmCtx.language.code) },
            });
            log('info', 'dm.wordless_handled', { wordless_kind: dm.wordless.kind, ack });
            await markHandled(claim.id);
            return;
        }

        // Which brain answers (`ai_agents.sales_mode`, DM plan S6): `off`, the default, is everything below exactly as it was; `test`
        // sends the sales turn only the listed test senders and everyone else down the old path; `on` sends it everyone. The read fails
        // toward `off` (a database that is behind, an error): a DM is never answered by an experiment because the lookup broke.
        const salesSettings = await readSalesSettings(creator.id);
        const useSales = answersWithSales(salesSettings, dm.senderId);

        // Who the creator is, once for this DM: the model's rules and schema and the disclosure line below are written
        // from it. A profile that cannot be read is the owner's wording (`profileContextOrLegacy`), never a failed reply.
        const dmCtx = await profileContextOrLegacy(creator.id, 'dm');

        if (useSales) {
            // The sales turn owns the reply, its quota check, the disclosure and the record of both (src/services/dmSales/turn.ts); this
            // function keeps the claim: handled once the turn has concluded, released for a retry when the quota stopped it, and the
            // catch below still decides what a thrown error means.
            const turn = await runSalesTurn({
                creator: { id: creator.id, page_access_token: creator.page_access_token },
                pageId: resolveDmPageId(creator, [recipientId, entryId]),
                conversation: { id: conversationId },
                inbound: { id: claim.id, senderId: dm.senderId, text: dmPromptText(dm), payload: dm.payload || undefined },
                ctx: dmCtx,
                disclosure: { needed: needsDisclosure(conversation.ai_disclosed_at), line: disclosureLine(dmCtx.language.code) },
            });
            if (turn.kind === 'quota') {
                if (mayRetry) {
                    await releaseInbound(claim.id);
                    throw new Error(`Send quota exhausted (${turn.blockedBy}: ${turn.count}/${turn.limit}).`);
                }
                await markHandled(claim.id);
                return;
            }
            await markHandled(claim.id);
            return;
        }

        // Ask the engine the tenant chose (`ai_agents.engine`): Gemini, today's call, unless they flipped it. Timed, because
        // this is both the dominant marginal cost of the product and the reason the webhook cannot finish inside Meta's timeout.
        const startedAt = Date.now();
        // `dmPromptText(dm)`, not `dm.text || dm.payload` — the same string `claimInbound`
        // stored, so ai.ts's "is this message already in the history" check can succeed.
        const dmReply = await generateDmReply(conversationId, dmPromptText(dm), creator.id, undefined, dmCtx);

        // The AI providers engine failed and so did what stands in for it (or the fallback is off): nothing is sent, no canned
        // apology and no second try. `dm.engine_failed` has said why. Terminal on purpose, like the paused bot above: S8's handoff
        // is what will pick this message up, and a retry here would only spend the same budget again.
        if (dmReply.kind === 'handoff') {
            await markHandled(claim.id);
            return;
        }
        const aiRes = dmReply.kind === 'reply' ? dmReply.response : null;
        log('info', 'ai.replied', {
            creator_id: creator.id,
            duration_ms: Date.now() - startedAt,
            message_type: aiRes?.message_type ?? null,
        });

        // null means the creator's AI agent is switched off — a deliberate "say nothing",
        // not a failure. Every real failure throws, so there is nothing to paper over here.
        if (!aiRes) {
            log('info', 'ai.agent_disabled', { creator_id: creator.id });
            await markHandled(claim.id);
            return;
        }

        // Format Meta payload
        let metaMessagePayload: MetaMessagePayload = toMetaMessage(aiRes);

        // One quota check per reply, not per network call: a disclosure that has to travel as
        // its own message is still one logical reply to one person.
        const quota = await checkFairSendQuota(creator.id, 'dm');
        if (!quota.allowed) {
            // Meta throttles automated sends at roughly 200/hr, and the app-wide pool above
            // that is shared with every other tenant. Real customers are going unanswered
            // either way, so this is alert-worthy.
            log('error', 'dm.quota_exhausted', {
                creator_id: creator.id,
                count: quota.count,
                limit: quota.limit,
                blocked_by: quota.blockedBy,
                app_count: quota.app.count,
                app_limit: quota.app.limit,
                source: 'dm',
            });
            // Retried rather than dropped. The counters are hourly, so the runner's backoff
            // (~30s, ~2m, ~8m) may well spend every attempt inside the same window — but it
            // may not, and the alternative is a real customer silently never answered, which
            // is what happened before. Nothing else will come back for this message: the
            // queue's `dedupe_key` is `dm:<mid>`, so a later Meta redelivery of the same
            // message is refused at enqueue and never becomes a second job.
            if (mayRetry) {
                await releaseInbound(claim.id);
                throw new Error(
                    `Send quota exhausted (${quota.blockedBy}: ${quota.count}/${quota.limit}).`
                );
            }
            await markHandled(claim.id);
            return;
        }

        const pageId = resolveDmPageId(creator, [recipientId, entryId]);

        // Meta policy: disclose the automated service at the start of a thread, and again
        // after a long gap.
        const discloseNow = needsDisclosure(conversation.ai_disclosed_at);
        if (discloseNow) {
            const disclosure = applyDisclosure(metaMessagePayload, disclosureLine(dmCtx.language.code));
            metaMessagePayload = disclosure.payload;
            if (disclosure.standalone) {
                log('info', 'dm.disclosure_standalone');
                await sendDirectMessage(
                    dm.senderId,
                    { text: disclosure.standalone },
                    creator.page_access_token,
                    pageId
                );
            }
        }

        // Send DM using Meta Send API
        await sendDirectMessage(dm.senderId, metaMessagePayload, creator.page_access_token, pageId);
        log('info', 'dm.sent', {
            creator_id: creator.id, message_type: aiRes.message_type, disclosed: discloseNow,
        });

        // Recorded only after a successful send, so a failed first reply still discloses next time.
        if (discloseNow) {
            await queryCount('UPDATE conversations SET ai_disclosed_at = NOW() WHERE id = $1', [conversationId]);
        }

        // Log outbound message
        // `sender = 'ai'` (v26): the inbox tags Gemini's replies apart from the operator's own.
        await queryCount(
            `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload, sender)
             VALUES ($1, $2, 'outbound', $3, $4, $5, 'ai')`,
            [
                conversationId,
                creator.id,
                aiRes.message_type,
                metaMessagePayload.text || '[Structured Template]',
                JSON.stringify(metaMessagePayload),
            ]
        );

        // Last, so that a crash anywhere above leaves the message claimable again. Writing it
        // earlier would turn a failed send into a message nobody ever retries.
        await markHandled(claim.id);
    } catch (aiError: any) {
        log('error', 'dm.pipeline_failed', { creator_id: creator.id, ...describeError(aiError) });

        await noteMetaFailure(creator.id, aiError);

        // A Gemini rate limit, a Meta 500 and a socket reset are all transient — and all of
        // them used to end here, logged and swallowed, with the job marked done and the
        // inbound row permanently unanswerable. Re-raising lets the runner back off and try
        // again; releasing the claim is what lets that attempt reach the work.
        //
        // A permanent Meta error (dead token, recipient blocked DMs) is recorded as final
        // instead: retrying it is how an app attracts Meta's enforcement attention.
        const permanent = isPermanentMetaError(aiError);
        if (!permanent && mayRetry) {
            await releaseInbound(claim.id);
            throw aiError;
        }

        await markHandled(claim.id);
    }
}
