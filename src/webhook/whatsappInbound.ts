/**
 * A WhatsApp message, stored and, for the owner's own testers, answered. The `dm.process` job for `object: 'whatsapp'` (src/jobs/handlers.ts) ends here.
 * Every message is stored and concluded: either ANSWERED by the sales agent (`whatsappAnswer.ts`, phase W5), or marked "not answered, and here is why"
 * (`messages.no_reply_reason`). The agent answers only when ALL of these hold (`noReplyReasonFor`):
 *
 *   - `ai_agents.whatsapp_mode` is `test` (`everyone` is refused by the API until the go-live gate exists, and is treated as `test` here: a listed sender only)
 *   - the sender is on `whatsapp_test_senders`: the owner's own testers, by BSUID or phone
 *   - the connection is `active` (an `invalid` one still STORES: Meta never redelivers, so a message is stored now or lost)
 *   - the message is words the agent can read: text, a tapped button or list row, a photo's or video's or document's caption, or a voice note it could transcribe
 *     (a photo with no caption, a sticker, a location: not words, see "What a listed tester sends that is not typed words")
 *   - nobody has taken the thread over (`conversations.is_bot_active`)
 *
 * The send of an ANSWER is `whatsappAnswer.ts`' (through `channels/send.ts`), and `handleWhatsAppInbound` takes it as a dependency, so what is tested here is the
 * decision and the bookkeeping, and what is tested there is the answer. The three other things this file may cause to be sent (the opt-out confirmation, and the one line
 * for a voice note or file that could not be read) are `whatsappOptOut.ts`' and `whatsappMediaInput.ts`', taken as dependencies the same way (`InboundSteps`).
 *
 * It is a file of its own, and not another branch of `answerDm` (messaging.ts), because the Instagram pipeline has to stay exactly what it is: this
 * writes the same tables with the same dedupe rules (the `meta_message_id` claim, the 300 s re-claim window) but a different contact
 * (a BSUID, with optional phone and username) and different columns.
 *
 * ## What is stored, and for whom (review C3, constitution VI)
 *
 * The public pages do not name WhatsApp yet, and there is no go-live gate, so customer data is processed only for the people the owner listed in
 * `ai_agents.whatsapp_test_senders` (their own testers, by BSUID or phone):
 *
 *   a listed test sender   everything: the words, the phone, the username, the profile name (into `conversations.profile_name`, review M24),
 *                          the raw event (which holds the media id, mime type and caption), the interactive reply id
 *   anyone else            a METADATA-ONLY thread and row: the conversation keyed by the BSUID with no phone, username or name; the message with
 *                          `text = ''`, no payload, no raw event, and its `message_type`. So the owner can see that someone wrote and when, and
 *                          nothing about what they said
 *
 * The queue is the other place the words would live: the `jobs` row holds the event verbatim (that is what makes a replay possible), and a `done`
 * row is kept 7 days. So the job's payload is redacted too, in the statement that ends the job (see `handleWhatsAppInbound`). What cannot be closed is
 * the time before the handler runs: from the webhook's enqueue until the job concludes, the full event is in `jobs`.
 *
 * ## What a listed tester says, in the order it is looked at (W6, W7, W8 wired in)
 *
 *   1. a STOP     the words (text, a tap, a caption) are WHOLLY a stop phrase (`matchStopMessage`, consent.ts): `whatsappOptOut.ts` decides, in every mode and whatever
 *                 the gates below say, the turn is never run, the row says `opted_out`. See that file for what it shares with Instagram and for what happens when they write again
 *   2. the FILE   a photo, video, document or voice note is downloaded and saved PRIVATELY, in every mode, so it outlives Meta's 7 days (`whatsappMediaInput.ts`). A stranger's is
 *                 never downloaded: everything in this list is behind `isTestSender`
 *   3. the GATES  `noReplyReasonFor`, as before
 *   4. the WORDS  only when the agent will answer: a voice note is transcribed (and a transcript that is a stop phrase is a stop), a caption is the message, a file with nothing
 *                 written on it gets the one line Instagram sends for it, and a voice note that could not be read gets ONE line asking for text
 *   5. the AGENT  on the words, with the entry link's tracking code taken out of them (stored text is as received)
 *
 * ## Where a thread came from (W8, T049, review M20)
 *
 * The first inbound sets `entry_source` and no later one rewrites it. A click-to-WhatsApp `referral` is `ctwa` (ingest). Otherwise a ` #ref` in the words that is one of THIS
 * tenant's entry links (`platform_connections.settings.entry_links`) is `link` with the owner's label (a QR code and a short link both: they share the ref); an unknown ref is
 * not trusted (a person can type `#K7M3QA`), and no ref is `organic`. It is metadata, not a customer's words, so it is recorded for strangers too. `free_window_expires_at` is
 * NOT set here, from a referral or from anything else: only a delivery status of ours that says `free_entry_point` sets it (`whatsappStatus.ts`).
 *
 * ## The thread
 *
 * `conversations.instagram_user_id` holds the BSUID (the column kept its name; a BSUID cannot collide with a numeric IGSID or PSID). Every
 * inbound message stamps `last_inbound_at = NOW()` (review H3): the 24 h customer-service window is what decides whether a manual reply may go
 * out, and nothing else stamps it for a thread no sales turn has answered. A system message is not the customer writing and does not.
 *
 * `conversations.handled_at` (v45, "Mark handled") is NOT cleared here, because the Instagram upsert does not clear it yet either. When that
 * change lands (a new inbound re-opens a handled thread), the upsert below gets the same line.
 *
 * ## A BSUID that changes (review M9)
 *
 * A `system` message `user_changed_number` / `user_changed_user_id` names the old and the new id. In one transaction: the thread is re-keyed
 * old -> new, the contact's consent rows are re-keyed (an opt-out must follow the person), and the id in `whatsapp_test_senders` is replaced.
 * If a thread already exists for the new id, the threads are NOT merged or deleted: both stay, `wa.contact_rekey_conflict` says so, and the
 * system message goes on the new one. Consents and the test-sender id are re-keyed all the same.
 */
import { queryOne, queryCount } from '../db/query.js';
import type { ConversationEntrySource } from '../db/rows.js';
import type { JobResult, WhatsAppDmPayload } from '../jobs/types.js';
import { matchStopMessage } from '../services/consent.js';
import { getCreatorByWhatsAppNumber } from '../services/tenant.js';
import { withTransaction } from '../services/studio/common.js';
import { readWhatsAppSettings, type WhatsAppAgentSettings, type WhatsAppMode } from '../services/whatsappAgent.js';
import { getEntryLinkLabels, refFromText, type EntryLinkLabels } from '../services/whatsappEntryLinks.js';
import { redactOnFailure } from '../jobs/redaction.js';
import { describeError, log, withLogContext } from '../utils/log.js';
import { dmPromptText } from './messaging.js';
import { FINAL_ATTEMPT, type WebhookHandlerOptions } from './options.js';
import { answerWhatsApp, withoutEntryRef, type NoReplyReason, type WhatsAppAnswerFn } from './whatsappAnswer.js';
import { readInboundMedia, saveInboundFile, type ReadMediaFn, type SaveFileFn, type SavedFile } from './whatsappMediaInput.js';
import { optOutWhatsAppContact, type WhatsAppStopFn } from './whatsappOptOut.js';
import { redactedInboundPayload } from './whatsappRedact.js';
import { normalizeWhatsAppChange, type WaEntrySource, type WaIgnored, type WaInbound, type WaMedia, type WaSystemEvent } from './whatsapp.js';

/**
 * How long one attempt may hold an inbound message before another may take it. The same 300 s as `REPLY_CLAIM_VISIBILITY_SECONDS` in
 * messaging.ts and `CLAIM_VISIBILITY_SECONDS` in src/jobs/runner.ts, for the same reason: taking a claim from a run that is still working is
 * how a person is answered twice.
 */
export const WA_CLAIM_VISIBILITY_SECONDS = 300;

/** `conversations.profile_name` is VARCHAR(255); `messages.message_type` is VARCHAR(50) and Meta's `type` is untrusted text: a type it adds one day must not fail the insert. */
const PROFILE_NAME_MAX = 255, MESSAGE_TYPE_MAX = 50;

export type { NoReplyReason };

/**
 * Whether the person is one of the owner's testers: by any of their ids (the BSUID, or on a re-key both the old and the new), or by phone
 * number. The list holds BSUIDs and E.164 digits (`whatsapp_test_senders`); Meta sends the phone in digits and a leading plus is tolerated.
 */
export function isTestSender(testSenders: readonly string[], ids: readonly (string | null | undefined)[], phone: string | null | undefined): boolean {
    const wanted = new Set<string>();
    for (const id of ids) if (id) wanted.add(id.trim());
    if (phone) wanted.add(phone.trim().replace(/^\+/, ''));
    return testSenders.some((entry) => wanted.has(entry.trim().replace(/^\+/, '')));
}

/**
 * Why this message is not answered, or null when the agent answers it. In this order, so the most basic reason wins:
 *
 *   unsupported_type   a reaction or a message the agent cannot read, whatever the mode
 *   agent_off          mode `off`
 *   not_test_sender    mode `test` (or `everyone`, which is test-only until the go-live gate) and a sender who is not listed
 *   unsupported_type   a sticker, a location, a contact card: stored, never read (a photo, a video, a document and a voice note ARE read: see `Incoming.file`)
 *   connection_invalid the connection is not `active`: stored, nothing is sent
 *   bot_paused         a person has the thread
 *
 * The three optional facts default to "fine", so a caller that knows only the mode and the sender asks the first three questions.
 */
export function noReplyReasonFor(input: {
    unsupported: boolean; mode: WhatsAppMode; isTestSender: boolean; answerable?: boolean; connectionActive?: boolean; botActive?: boolean;
}): NoReplyReason | null {
    if (input.unsupported) return 'unsupported_type';
    if (input.mode === 'off') return 'agent_off';
    if (!input.isTestSender) return 'not_test_sender';
    if (input.answerable === false) return 'unsupported_type';
    if (input.connectionActive === false) return 'connection_invalid';
    if (input.botActive === false) return 'bot_paused';
    return null;
}

/** What a stored message is, whatever shape it came in: a customer's message, or an ignored one that is kept as a row with a reason. */
interface Incoming {
    senderId: string;
    wamid: string;
    /** `messages.message_type`: Meta's `type` (`text`, `image`, `interactive.button_reply`, `reaction`, ...). */
    messageType: string;
    /** What a listed test sender's row says. Never read for anyone else. */
    text: string;
    payload: string | null;
    phone: string | null;
    username: string | null;
    profileName: string | null;
    parentUserId: string | null;
    entrySource: WaEntrySource | null;
    timestamp: number | null;
    /** A message the agent cannot read: a reaction, an unsupported type. */
    unsupported: boolean;
    /**
     * Something the agent can work with: typed words (text, a tapped button or list row), or a FILE it knows what to do with (`file`). Not a sticker, a location or a contact card.
     */
    answerable: boolean;
    /** `voice`: audio, to be transcribed. `media`: a photo, video or document. Null for everything else (a sticker is `message.media` too, and is not read). */
    file: 'voice' | 'media' | null;
    /** The file's media id and type, when Meta gave an id. */
    media: WaMedia | null;
    /** What the customer wrote on a photo, video or document; '' for nothing. (A voice note has none.) */
    caption: string;
}

/** The files a tester's message can carry that the agent reads: a voice note or any audio, a photo, a video or a document. A sticker is a like, not a question. */
function fileOf(message: WaInbound): Incoming['file'] {
    if (message.messageType === 'audio') return 'voice';
    const kind = message.media?.kind;
    return kind === 'image' || kind === 'video' || kind === 'document' ? 'media' : null;
}

function incomingOf(message: WaInbound): Incoming {
    const file = fileOf(message);
    return {
        senderId: message.senderId,
        wamid: message.metaMessageId,
        messageType: message.messageType.slice(0, MESSAGE_TYPE_MAX),
        text: dmPromptText(message),
        payload: message.payload || null,
        phone: message.phone,
        username: message.username,
        profileName: message.profileName,
        parentUserId: message.parentUserId,
        entrySource: message.entrySource,
        timestamp: message.timestamp,
        unsupported: false,
        answerable: file !== null || (!message.media && !message.needsTranscript && !message.wordless && dmPromptText(message).trim() !== ''),
        file,
        media: message.media,
        caption: file === 'media' ? message.media?.caption?.trim() ?? '' : '',
    };
}

/** An ignored message that the contract keeps a row for. The caller has checked `store`, a sender and an id. */
function incomingOfIgnored(message: WaIgnored & { senderId: string; metaMessageId: string }): Incoming {
    return {
        senderId: message.senderId,
        wamid: message.metaMessageId,
        messageType: (message.messageType ?? 'unsupported').slice(0, MESSAGE_TYPE_MAX),
        text: '',
        payload: null,
        phone: message.phone,
        username: message.username,
        profileName: message.profileName,
        parentUserId: null,
        entrySource: null,
        timestamp: message.timestamp,
        unsupported: true,
        answerable: false,
        file: null,
        media: null,
        caption: '',
    };
}

interface Context {
    creatorId: string;
    phoneNumberId: string | null;
    connectionStatus: string;
    settings: WhatsAppAgentSettings;
    /** The change as the job stored it, kept as the raw event of a test sender's rows. */
    rawChange: unknown;
    progress: Progress;
    /** The agent's answer to a message this handler has decided to answer. */
    answer: WhatsAppAnswerFn;
    /** The steps that are not the agent's answer: an opt-out, a file, an entry link. */
    steps: InboundSteps;
    /** No retry follows this attempt. */
    lastAttempt: boolean;
}

/**
 * What the handler asks of the code around it, as dependencies (like `answer`): so `whatsappInbound.test.ts` tests the decision and the bookkeeping with stand-ins that FAIL THE
 * TEST when asked for a message they should not have been asked for, and each step is tested on its own where it lives.
 */
export interface InboundSteps {
    /** A tester's stop phrase: record it, close the thread, confirm once (`whatsappOptOut.ts`). */
    stop: WhatsAppStopFn;
    /** A tester's file, saved privately (`whatsappMediaInput.ts`). */
    saveFile: SaveFileFn;
    /** A tester's voice note or file, as words or as the one line (`whatsappMediaInput.ts`). */
    readMedia: ReadMediaFn;
    /** The tenant's entry-link labels (`platform_connections.settings.entry_links`). */
    labels: (creatorId: string) => Promise<EntryLinkLabels>;
}

const LIVE_STEPS: InboundSteps = {
    stop: (input) => optOutWhatsAppContact(input),
    saveFile: saveInboundFile(),
    readMedia: readInboundMedia(),
    labels: getEntryLinkLabels,
};

/** What the job has learned about its payload as it ran. */
interface Progress {
    /** True once a message in this job is known to be a listed test sender's: its payload is kept whole, on success and on a failure that ends the job. */
    keepPayload: boolean;
}

const isoOf = (seconds: number | null): string => {
    const at = seconds !== null ? new Date(seconds * 1000) : new Date();
    return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
};

/**
 * Has this message already reached a conclusion? Asked BEFORE the thread is touched: a redelivery must not stamp `last_inbound_at` and
 * re-open a 24 h window the customer closed days ago. A row that exists but is unfinished (a crash after the claim) is not a duplicate: the
 * claim below resumes it.
 */
async function alreadyHandled(wamid: string): Promise<boolean> {
    const row = await queryOne<{ id: string }>('SELECT id FROM messages WHERE meta_message_id = $1 AND handled_at IS NOT NULL', [wamid]);
    return row !== null;
}

interface InboundClaim {
    id: string;
    resumed: boolean;
    attempts: number;
}

/**
 * Write the inbound row and claim the right to conclude it: `claimInbound` (messaging.ts) with this channel's columns. The partial unique index
 * on `meta_message_id` dedupes a redelivery; `handled_at` records whether a conclusion was reached; `reply_claimed_at` is the visibility timeout
 * that stops a resume from becoming two runs at once.
 */
async function claimWhatsAppInbound(
    conversationId: string,
    creatorId: string,
    row: { messageType: string; text: string; payload: string | null; rawPayload: string | null; wamid: string }
): Promise<InboundClaim | null> {
    const inserted = await queryOne<{ id: string }>(
        `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, payload,
                               raw_payload, meta_message_id, reply_claimed_at, reply_attempts, sender)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, NOW(), 1, 'customer')
         ON CONFLICT (meta_message_id) WHERE meta_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [conversationId, creatorId, row.messageType, row.text, row.payload, row.rawPayload, row.wamid]
    );
    if (inserted) return { id: inserted.id, resumed: false, attempts: 1 };

    const resumed = await queryOne<{ id: string; reply_attempts: number }>(
        `UPDATE messages
            SET reply_claimed_at = NOW(),
                reply_attempts = reply_attempts + 1
          WHERE meta_message_id = $1
            AND handled_at IS NULL
            AND (reply_claimed_at IS NULL OR reply_claimed_at < NOW() - make_interval(secs => $2))
      RETURNING id, reply_attempts`,
        [row.wamid, WA_CLAIM_VISIBILITY_SECONDS]
    );
    return resumed ? { id: resumed.id, resumed: true, attempts: resumed.reply_attempts } : null;
}

/** Terminal: the message is concluded. The one write that sets `no_reply_reason`: a reason when it was not answered, NULL when it was. */
async function markConcluded(messageId: string, reason: NoReplyReason | null): Promise<void> {
    await queryCount(
        'UPDATE messages SET handled_at = NOW(), reply_claimed_at = NULL, no_reply_reason = $2 WHERE id = $1',
        [messageId, reason]
    );
}

/** Give the claim back so the next attempt can take it at once, instead of waiting out the 300 s visibility window. The statement `whatsappAnswer.ts` uses. */
async function releaseClaim(messageId: string): Promise<void> {
    await queryCount('UPDATE messages SET reply_claimed_at = NULL WHERE id = $1 AND handled_at IS NULL', [messageId]);
}

/**
 * The entry link this message came in through, when its words carry the tracking code of one of THIS tenant's links: `{ ref, label }`. The pure check comes first, so a message
 * with no ` #ref` in it (nearly all of them) costs no query. A ref that is not the tenant's own is not trusted (anyone can type one), and labels that cannot be read are "no
 * link": a message is stored whatever its attribution, so this never throws.
 */
async function entryLinkOf(ctx: Context, text: string): Promise<{ ref: string; label: string } | null> {
    const candidate = refFromText(text);
    if (!candidate) return null;
    try {
        const hit = Object.values(await ctx.steps.labels(ctx.creatorId)).find((entry) => entry.ref === candidate);
        return hit ? { ref: hit.ref, label: hit.label } : null;
    } catch (err) {
        log('warn', 'wa.entry_link_unreadable', { creator_id: ctx.creatorId, ...describeError(err), effect: 'stored without a link source' });
        return null;
    }
}

/** The typed words of a tester's message, for the stop check: text, a tapped button or list row, a photo's caption. Null for a voice note (read later), a bare file and everything unreadable. */
function typedWords(incoming: Incoming, said: string): string | null {
    if (incoming.file === 'voice') return null;
    if (incoming.file === 'media') return incoming.caption !== '' ? said : null;
    return incoming.answerable ? said : null;
}

/** Store one customer message (or a kept ignored one) and conclude it: answered, or not answered and why. */
async function storeInbound(ctx: Context, incoming: Incoming): Promise<void> {
    if (await alreadyHandled(incoming.wamid)) {
        log('info', 'wa.duplicate_ignored');
        return;
    }

    const test = isTestSender(ctx.settings.testSenders, [incoming.senderId], incoming.phone);
    if (test) ctx.progress.keepPayload = true;

    // How the thread began (only the first inbound's counts: the upsert keeps what is there). A click-to-WhatsApp referral is `ctwa`; else a tracking code that is one of the
    // tenant's own links is `link`, with the owner's label of it; else `organic`. A QR code and a short link share a ref, so they are one kind.
    const link = await entryLinkOf(ctx, incoming.text);
    const began: Omit<ConversationEntrySource, 'at'> = incoming.entrySource ?? (link ? { kind: 'link', ref: link.ref, label: link.label } : { kind: 'organic' });
    const entrySource = { ...began, at: isoOf(incoming.timestamp) };

    // The thread. One statement, not SELECT-then-INSERT (two messages a second apart race on `unique_creator_user`). Who the person is
    // (phone, username, name, parent id) is written for a test sender only; a thread for anyone else is the BSUID and when they wrote.
    //   last_inbound_at   NOW() on every inbound (review H3), on insert and on update
    //   platform          set once and kept, as Instagram's is
    //   entry_source      only the first inbound sets it: a later message never rewrites how the thread began
    //   username, name   the latest value wins unless it is missing; phone and parent id fill once
    const conversation = await queryOne<{ id: string; is_bot_active?: boolean | null; ai_disclosed_at?: Date | string | null; entry_source?: ConversationEntrySource | null }>(
        `INSERT INTO conversations (creator_id, instagram_user_id, status, platform, last_inbound_at,
                                    wa_phone, wa_username, wa_parent_user_id, profile_name, entry_source)
         VALUES ($1, $2, 'active', 'whatsapp', NOW(), $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (creator_id, instagram_user_id)
         DO UPDATE SET last_message_at = NOW(),
                       last_inbound_at = NOW(),
                       platform = COALESCE(conversations.platform, EXCLUDED.platform),
                       wa_phone = COALESCE(conversations.wa_phone, EXCLUDED.wa_phone),
                       wa_username = COALESCE(EXCLUDED.wa_username, conversations.wa_username),
                       wa_parent_user_id = COALESCE(conversations.wa_parent_user_id, EXCLUDED.wa_parent_user_id),
                       profile_name = COALESCE(EXCLUDED.profile_name, conversations.profile_name),
                       entry_source = COALESCE(conversations.entry_source, EXCLUDED.entry_source)
         RETURNING id, is_bot_active, ai_disclosed_at, entry_source`,
        [
            ctx.creatorId,
            incoming.senderId,
            test ? incoming.phone : null,
            test ? incoming.username : null,
            test ? incoming.parentUserId : null,
            test ? incoming.profileName?.slice(0, PROFILE_NAME_MAX) ?? null : null,
            JSON.stringify(entrySource),
        ]
    );
    if (!conversation) {
        // An upsert with DO UPDATE always returns its row; no row means it did not do what this assumes.
        log('error', 'wa.conversation_upsert_empty', { creator_id: ctx.creatorId });
        return;
    }

    const claim = await claimWhatsAppInbound(conversation.id, ctx.creatorId, {
        messageType: incoming.messageType,
        text: test ? incoming.text : '',
        payload: test ? incoming.payload : null,
        rawPayload: test ? JSON.stringify(ctx.rawChange) : null,
        wamid: incoming.wamid,
    });
    if (!claim) {
        log('info', 'wa.duplicate_ignored');
        return;
    }
    if (claim.resumed) log('info', 'wa.resumed', { message_id: claim.id, reply_attempts: claim.attempts });

    /** Conclude, and say so. Every path below ends here. */
    const conclude = async (why: NoReplyReason | null): Promise<void> => {
        await markConcluded(claim.id, why);
        log('info', 'wa.inbound_stored', {
            message_type: incoming.messageType,
            stored: test ? 'full' : 'metadata_only',
            no_reply_reason: why,
            answered: why === null,
            connection_status: ctx.connectionStatus,
            conversation_id: conversation.id,
        });
    };

    // The tracking code is the owner's, not the customer's: the agent reads the words without it, and the row keeps them as they arrived. The thread's own ref covers the
    // later messages of a thread that began on a link (and the first, when the ref was just read from the words).
    const entryRef = conversation.entry_source?.ref ?? link?.ref ?? null;
    const said = withoutEntryRef(incoming.text, entryRef);

    // Would the agent answer this? Everything but the words themselves: who they are, the mode, the connection, whether a person has the thread.
    let reason = noReplyReasonFor({
        unsupported: incoming.unsupported, mode: ctx.settings.mode, isTestSender: test, answerable: incoming.answerable,
        connectionActive: ctx.connectionStatus === 'active', botActive: conversation.is_bot_active !== false,
    });
    const mayAnswer = reason === null;

    /**
     * A stop, decided by `whatsappOptOut.ts` and nobody else: the turn is not run for it. An opt-out that could not be written is retried while an attempt is left (the claim
     * is given back first, so the retry takes it at once) and, on the last, is said loudly and concluded as a failure: nothing is sent to someone who said stop, whatever happens.
     */
    const optOut = async (words: string, lang: 'ar' | 'en'): Promise<void> => {
        try {
            await ctx.steps.stop({ creatorId: ctx.creatorId, conversationId: conversation.id, senderId: incoming.senderId, text: words, lang, confirm: mayAnswer });
        } catch (err) {
            if (!ctx.lastAttempt) {
                log('warn', 'wa.optout_retrying', { creator_id: ctx.creatorId, conversation_id: conversation.id, ...describeError(err) });
                await releaseClaim(claim.id);
                throw err;
            }
            log('error', 'wa.optout_not_recorded', { creator_id: ctx.creatorId, conversation_id: conversation.id, ...describeError(err), effect: 'the stop is NOT recorded; nothing was sent to the contact' });
            await conclude('failure');
            return;
        }
        await conclude('opted_out');
    };

    // 1. A stop, in the words of a listed tester: honoured in every mode, `off` included, and whether or not a person has the thread (consent.ts, wiring note).
    const words = test ? typedWords(incoming, said) : null;
    const stop = words !== null ? matchStopMessage(words) : null;
    if (words !== null && stop) return optOut(words, stop.lang);

    // 2. The file, saved privately and linked to the row, for a tester and nobody else: a stranger's file is never downloaded. In every mode, because Meta keeps it 7 days; and
    // only on a connection that can download (an `invalid` one has no token to try with).
    let saved: SavedFile | null = null;
    if (test && incoming.file !== null && ctx.connectionStatus === 'active') {
        saved = await ctx.steps.saveFile({ creatorId: ctx.creatorId, messageId: claim.id, phoneNumberId: ctx.phoneNumberId, media: incoming.media, resumed: claim.resumed });
    }

    // 3 and 4. What the agent reads: the words, a voice note's transcript, a caption, or a line that says it could not read it.
    let text = said;
    if (reason === null && incoming.file !== null) {
        const read = await ctx.steps.readMedia({
            creatorId: ctx.creatorId, conversationId: conversation.id, messageId: claim.id, kind: incoming.file, media: incoming.media, caption: incoming.caption,
            saved, resumed: claim.resumed, aiDisclosedAt: conversation.ai_disclosed_at ?? null,
        });
        if (read.kind === 'concluded') return conclude(read.reason);
        text = withoutEntryRef(read.text, entryRef);
        // A voice note that SAYS «وقف» is a stop like a typed one (a caption was checked above, with the words).
        const spoken = incoming.file === 'voice' ? matchStopMessage(text) : null;
        if (spoken) return optOut(text, spoken.lang);
    }

    // 5. The agent. It throws only to ask for a retry (the claim is released first); anything else is concluded here, whatever happened.
    if (reason === null) {
        reason = (await ctx.answer({
            creatorId: ctx.creatorId, conversationId: conversation.id, messageId: claim.id, wamid: incoming.wamid, phoneNumberId: ctx.phoneNumberId,
            senderId: incoming.senderId, text, payload: incoming.payload, aiDisclosedAt: conversation.ai_disclosed_at ?? null, entryRef, lastAttempt: ctx.lastAttempt,
        })).reason;
    }
    await conclude(reason);
}

// ─── A BSUID that changed ─────────────────────────────────────────────────────────────────

type RekeyOutcome = 'rekeyed' | 'no_thread' | 'conflict';

const UNIQUE_VIOLATION = '23505';

/**
 * Re-key one contact, old -> new, for this tenant. One transaction: the thread (unless the new id already has one), the consents, the test-sender
 * list. A race that makes the thread UPDATE hit the unique index (a message from the new id creating its thread between the check and the write)
 * rolls the transaction back and runs it again without the thread step: the same outcome as finding the conflict first.
 */
async function rekeyContact(creatorId: string, from: string, to: string): Promise<{ outcome: RekeyOutcome; consents: number; testSenders: number }> {
    const run = (skipThread: boolean) =>
        withTransaction(async (tx) => {
            let outcome: RekeyOutcome = 'conflict';
            if (!skipThread) {
                // The NOT EXISTS is the check; the unique index is the guarantee.
                const moved = await tx.query<{ id: string }>(
                    `UPDATE conversations SET instagram_user_id = $3
                      WHERE creator_id = $1 AND platform = 'whatsapp' AND instagram_user_id = $2
                        AND NOT EXISTS (SELECT 1 FROM conversations n WHERE n.creator_id = $1 AND n.instagram_user_id = $3)
                  RETURNING id`,
                    [creatorId, from, to]
                );
                if (moved.rows.length > 0) {
                    outcome = 'rekeyed';
                } else {
                    const present = await tx.query<{ instagram_user_id: string }>(
                        'SELECT instagram_user_id FROM conversations WHERE creator_id = $1 AND instagram_user_id = ANY($2::text[])',
                        [creatorId, [from, to]]
                    );
                    const ids = new Set(present.rows.map((r) => r.instagram_user_id));
                    outcome = ids.has(from) && ids.has(to) ? 'conflict' : 'no_thread';
                }
            }

            // The person's consent history follows them: an opt-out under the old id must still hold under the new one.
            const consents = await tx.query(
                `UPDATE contact_consents SET contact_ref = $3
                  WHERE creator_id = $1 AND platform = 'whatsapp' AND contact_ref = $2`,
                [creatorId, from, to]
            );
            // The test-sender list: replace the old id, unless the new one is already there (then just drop the old: no duplicate).
            const senders = await tx.query(
                `UPDATE ai_agents
                    SET whatsapp_test_senders = CASE WHEN $3::text = ANY(whatsapp_test_senders)
                                                     THEN array_remove(whatsapp_test_senders, $2::text)
                                                     ELSE array_replace(whatsapp_test_senders, $2::text, $3::text) END
                  WHERE creator_id = $1 AND $2::text = ANY(whatsapp_test_senders)`,
                [creatorId, from, to]
            );
            return { outcome, consents: consents.rowCount ?? 0, testSenders: senders.rowCount ?? 0 };
        });

    try {
        return await run(false);
    } catch (err) {
        if ((err as { code?: unknown })?.code !== UNIQUE_VIOLATION) throw err;
        return run(true);
    }
}

async function storeSystemEvent(ctx: Context, event: WaSystemEvent): Promise<void> {
    if (await alreadyHandled(event.metaMessageId)) {
        log('info', 'wa.duplicate_ignored');
        return;
    }

    const test = isTestSender(ctx.settings.testSenders, [event.userId, event.rekey?.from, event.rekey?.to], event.phone);
    if (test) ctx.progress.keepPayload = true;

    if (event.rekey) {
        const { from, to } = event.rekey;
        const result = await rekeyContact(ctx.creatorId, from, to);
        if (result.outcome === 'conflict') {
            // Two threads for one person. Merging them would rewrite history; deleting one would lose it. Both stay, and this says so.
            log('warn', 'wa.contact_rekey_conflict', { creator_id: ctx.creatorId, from, to, consents_rekeyed: result.consents, test_senders_rekeyed: result.testSenders });
        } else {
            log('info', 'wa.contact_rekeyed', { creator_id: ctx.creatorId, outcome: result.outcome, consents_rekeyed: result.consents, test_senders_rekeyed: result.testSenders });
        }
    } else {
        log('info', 'wa.system_event_no_rekey', { system_type: event.systemType });
    }

    // The system message lives on the thread of the NEW id (the old one's, re-keyed, or the one that was already there, or a new one). It is not
    // the customer writing: no `last_inbound_at`, no `last_message_at`. The NEW phone (`system.wa_id`) is the contact's current one, so it wins.
    const conversation = await queryOne<{ id: string }>(
        `INSERT INTO conversations (creator_id, instagram_user_id, status, platform, wa_phone, wa_parent_user_id)
         VALUES ($1, $2, 'active', 'whatsapp', $3, $4)
         ON CONFLICT (creator_id, instagram_user_id)
         DO UPDATE SET platform = COALESCE(conversations.platform, EXCLUDED.platform),
                       wa_phone = COALESCE(EXCLUDED.wa_phone, conversations.wa_phone),
                       wa_parent_user_id = COALESCE(conversations.wa_parent_user_id, EXCLUDED.wa_parent_user_id)
         RETURNING id`,
        [ctx.creatorId, event.userId, test ? event.phone : null, test ? event.parentUserId : null]
    );
    if (!conversation) {
        log('error', 'wa.conversation_upsert_empty', { creator_id: ctx.creatorId });
        return;
    }

    const claim = await claimWhatsAppInbound(conversation.id, ctx.creatorId, {
        messageType: 'system',
        text: test ? event.body ?? '' : '',
        payload: null,
        rawPayload: test ? JSON.stringify(ctx.rawChange) : null,
        wamid: event.metaMessageId,
    });
    if (!claim) {
        log('info', 'wa.duplicate_ignored');
        return;
    }
    await markConcluded(claim.id, 'system_event');
    log('info', 'wa.system_event_stored', { system_type: event.systemType, stored: test ? 'full' : 'metadata_only', conversation_id: conversation.id });
}

// ─── The job ──────────────────────────────────────────────────────────────────────────────

/**
 * The `dm.process` job for one WhatsApp message. Every path out of here either stores the message and concludes it, or logs why it did not:
 * `wa.no_creator` (no connection for the number), `wa.ignored` (a message with nothing to store), `wa.duplicate_ignored`, `wa.job_empty`.
 *
 * Throws only for a failure a retry may cure (the database, a throttle): the runner backs off and the claim is resumed.
 *
 * ## What the job keeps (review C3)
 *
 * The job's payload is the event verbatim, and the queue keeps a `done` row 7 days and a `failed` one for good. Whatever happened, a payload whose
 * customer was not stored in full is redacted (`redactedInboundPayload`) in the statement that ends the job: a stranger's message, a message for
 * a number nobody connected, a duplicate, an edit. Only a listed test sender's message, whose words are kept in `messages` anyway, leaves the payload
 * alone. The redaction is returned as `{ redactPayload }` for the queue to apply on completion; an error thrown from here is tagged (`redactOnFailure`)
 * so the runner applies the same redaction if it is the failure that ENDS the job, and not while a retry is coming. The one window this cannot close
 * is before any of it runs: from the webhook's enqueue until the handler concludes the job, the full event is in `jobs`.
 */
export async function handleWhatsAppInbound(
    payload: WhatsAppDmPayload, options: WebhookHandlerOptions = FINAL_ATTEMPT, answer: WhatsAppAnswerFn = answerWhatsApp, steps: Partial<InboundSteps> = {}
): Promise<JobResult | undefined> {
    const progress: Progress = { keepPayload: false };
    try {
        await ingest(payload, options, progress, answer, { ...LIVE_STEPS, ...steps });
    } catch (err) {
        // Not knowing who the sender was (the failure came before the settings were read) is the stranger's case: redact.
        throw progress.keepPayload ? err : redactOnFailure(err, redactedInboundPayload(payload));
    }
    return progress.keepPayload ? undefined : { redactPayload: redactedInboundPayload(payload) };
}

async function ingest(payload: WhatsAppDmPayload, options: WebhookHandlerOptions, progress: Progress, answer: WhatsAppAnswerFn, steps: InboundSteps): Promise<void> {
    const change = normalizeWhatsAppChange(payload.change);
    if (change.messages.length === 0) {
        log('warn', 'wa.job_empty', { phone_number_id: payload.phoneNumberId });
        return;
    }

    const phoneNumberId = payload.phoneNumberId ?? change.messages.find((m) => m.phoneNumberId)?.phoneNumberId ?? null;
    const tenant = await getCreatorByWhatsAppNumber(phoneNumberId);
    if (!tenant) {
        // No connection for this number (never connected, disconnected, or a number that belongs to someone else's app). Meta has its 200 and will
        // not redeliver, so this is logged and the job completes: a retry would find the same nothing.
        log('warn', 'wa.no_creator', { phone_number_id: phoneNumberId });
        return;
    }

    let settings: WhatsAppAgentSettings;
    try {
        settings = await readWhatsAppSettings(tenant.creator.id);
    } catch (err) {
        // A database that cannot answer is retried while a retry is left. On the last attempt the message is stored as it would be for a stranger
        // (metadata only, nobody answered): the safe side of not knowing who the owner's testers are.
        if (!options.lastAttempt) throw err;
        log('error', 'wa.settings_unreadable', { ...describeError(err), effect: 'stored as metadata only' });
        settings = { mode: 'off', testSenders: [] };
    }

    const ctx: Context = {
        creatorId: tenant.creator.id,
        phoneNumberId,
        connectionStatus: tenant.connectionStatus,
        settings,
        rawChange: payload.change,
        progress,
        answer,
        steps,
        lastAttempt: options.lastAttempt,
    };

    for (const message of change.messages) {
        await withLogContext({ mid: message.metaMessageId, phone_number_id: phoneNumberId, creator_id: ctx.creatorId }, async () => {
            if (message.kind === 'system') return storeSystemEvent(ctx, message);
            if (message.kind === 'message') return storeInbound(ctx, incomingOf(message));

            // Ignored. A reaction or a message the agent cannot read is kept as a row that says so; anything else (a message with no id, an
            // edit, `request_welcome`) has nothing to keep, and the log is the record.
            if (message.store && message.senderId && message.metaMessageId) {
                return storeInbound(ctx, incomingOfIgnored({ ...message, senderId: message.senderId, metaMessageId: message.metaMessageId }));
            }
            log('info', 'wa.ignored', { reason: message.reason, phone_number_id: phoneNumberId });
        });
    }
}
