/**
 * The WhatsApp agent answering one message (docs/specs/001-whatsapp-agent, phase W5): the part of `handleWhatsAppInbound` that runs AFTER the message is
 * stored and claimed, and only for a message the inbound handler has decided to answer (a listed test sender, an active connection, words the agent can
 * read: `noReplyReasonFor`). It is the sales turn (`runSalesTurn`, the same code that answers Instagram and Messenger) given a WhatsApp transport:
 *
 *   1. `markReadWithTyping` while the model thinks (best effort: a refusal of the receipt never costs the reply)
 *   2. `runSalesTurn` with `transport`: purpose `dm_whatsapp` (providers that do not train on what they are sent), never Gemini, one message per turn
 *   3. the outcome as the inbound row's `no_reply_reason`: NULL when the customer was answered, else why not
 *
 * **It answers regardless of the tenant's Instagram `sales_mode`** (review M22): on WhatsApp the sales flow is the agent, and `whatsapp_test_senders` is
 * the one list that decides who is answered.
 *
 * ## What each ending means for the inbound row (`messages.no_reply_reason`, a vocabulary in code)
 *
 *   NULL                   answered: a reply, the stop line, the calm line, or the hand-off line a flow asked for (a refund, a person wanted)
 *   provider_unavailable   the model could not answer (no allowed provider, a provider outage or 429, a budget): the conversation was handed to a person,
 *                          who was told, and the customer got the hand-off line. Never Gemini (review C1)
 *   window_closed          the reply could not be sent: the 24 h window closed before it was ready (the person wrote, the model was slow)
 *   billable_blocked       the reply could not be sent: the free replies are used up and the owner has not allowed paid ones
 *   connection_invalid     the reply could not be sent: Meta refused the connection (a dead token, a payment problem)
 *   failure                anything else that stopped a reply: a send Meta did not take, a database that failed through every attempt
 *   bot_paused             a person has the thread (the inbox's manual reply, a hand-off) or the flow ended it (a loop, a second insult)
 *   superseded             a later message took its place, or somebody replied after it
 *   agent_off              the owner's agent is switched off
 *
 * A reply that could not be sent leaves the customer unanswered, so the conversation is STAMPED as handed over (the inbox's "Needs you") and the owner is
 * told what happened. `conversations.handoff_reason` allows only a closed list (`migration_v39`, VARCHAR(16)), so the stamp says `unsure` and the cause is
 * here and in the alert (review M7).
 *
 * ## Retries
 *
 * A failure that a retry may cure (the database, a throttle) releases the claim and is rethrown while an attempt is left, so the runner backs off and the
 * message is answered then. Two things are never retried, because a duplicate message to a customer is worse than a missing one: a send that MAY have
 * landed (a timeout, a 5xx), and any error after a message went out (the customer has been answered; only the bookkeeping failed).
 */
import { queryCount } from '../db/query.js';
import type { SalesTurnResult } from '../services/dmSales/turn.js';
import { runSalesTurn } from '../services/dmSales/turn.js';
import { notifyOwner, type NoticePlan, type WhatsAppSendBlock } from '../services/dmSales/handoff.js';
import { FAILURE_HANDOFF_REASON } from '../services/dmSales/failureHandoff.js';
import { SalesSendRefused, type SalesTransport } from '../services/dmSales/transport.js';
import { attachWamid, sendWhatsAppReply } from '../services/channels/send.js';
import { profileContextOrLegacy } from '../services/profile/context.js';
import { markReadWithTyping } from '../services/whatsapp.js';
import { getAccessToken } from '../services/whatsappConnections.js';
import { describeError, log } from '../utils/log.js';
import { disclosureLine } from './meta-payload.js';
import { needsDisclosure } from './messaging.js';

/**
 * Why an inbound message got no reply: `messages.no_reply_reason`. The column is free text; this is the vocabulary this module and the inbound handler write
 * (the schema's own list, v50: agent_off, not_test_sender, handed_off, window_closed, opted_out, billable_blocked, provider_unavailable, unsupported_type, failure).
 */
export type NoReplyReason =
    | 'agent_off' | 'not_test_sender' | 'unsupported_type' | 'system_event'
    | 'provider_unavailable' | 'window_closed' | 'billable_blocked' | 'connection_invalid' | 'failure' | 'bot_paused' | 'superseded';

export interface WhatsAppAnswerInput {
    creatorId: string;
    conversationId: string;
    /** The inbound `messages` row being answered. */
    messageId: string;
    /** The inbound message's wamid: the read receipt names it. */
    wamid: string;
    phoneNumberId: string | null;
    /** The contact's BSUID: the conversation's key. */
    senderId: string;
    /** What they wrote (a button's title for a tap). */
    text: string;
    /** The id of the button or list row they tapped, when it was a tap. */
    payload: string | null;
    /** `conversations.ai_disclosed_at`: when the automated-service line was last said on this thread. */
    aiDisclosedAt: Date | string | null;
    /** No retry follows this attempt: every outcome is written down as final. */
    lastAttempt: boolean;
}

/** What the inbound row should say. `reason: null` is "answered". */
export interface WhatsAppAnswerResult {
    reason: NoReplyReason | null;
}

/** The agent's answer to one message. Injected into `handleWhatsAppInbound` so its tests do not need a model, a profile and a sender. */
export type WhatsAppAnswerFn = (input: WhatsAppAnswerInput) => Promise<WhatsAppAnswerResult>;

/** Give the claim back so the next attempt can take it at once, instead of waiting out the 300 s visibility window. The statement `messaging.ts` uses. */
async function releaseClaim(messageId: string): Promise<void> {
    await queryCount('UPDATE messages SET reply_claimed_at = NULL WHERE id = $1 AND handled_at IS NULL', [messageId]);
}

/** The inbound row's reason for how a turn ended. */
export function reasonOfTurn(turn: SalesTurnResult): NoReplyReason | null {
    // The quota is Instagram's and a turn with a transport never checks it; if one ever did, it is a failure, not an answer.
    if (turn.kind === 'quota') return 'failure';
    switch (turn.outcome) {
        case 'agent_off': return 'agent_off';
        case 'superseded': return 'superseded';
        case 'paused': return 'bot_paused';
        case 'handoff': return turn.modelFailed ? 'provider_unavailable' : null;
        default: return null;
    }
}

/** The WhatsApp transport for one message: the sender for the words, the read receipt for "typing", the wamid for the row. */
export function whatsappTransport(input: Pick<WhatsAppAnswerInput, 'creatorId' | 'conversationId' | 'wamid' | 'phoneNumberId'>): SalesTransport & { readonly sent: boolean } {
    let sent = false;
    return {
        channel: 'whatsapp',
        get sent() { return sent; },
        async send(payload) {
            // At most one message per turn (review M14, T037): the turn is written to send one, and a change that made it send two (a disclosure of its
            // own, a link after the words) is refused HERE, before a second request leaves, and fails a test instead of spamming a customer.
            if (sent) throw new Error('A WhatsApp turn sends one message: a second send was refused.');
            const quick = (payload.quick_replies ?? []).map((q) => ({ title: q.title, payload: q.payload }));
            const result = await sendWhatsAppReply({
                creatorId: input.creatorId, conversationId: input.conversationId, kind: 'agent', record: false,
                body: { text: payload.text ?? '', ...(quick.length > 0 ? { quickReplies: quick } : {}) },
            });
            if (!result.ok) {
                throw new SalesSendRefused(result.reason, {
                    permanent: result.permanent, mayHaveLanded: result.mayHaveLanded, attempted: result.attempted, code: result.code, closesAt: result.closesAt,
                }, result.detail);
            }
            sent = true;
            return { wamid: result.wamid };
        },
        async seen() {
            try {
                if (!input.phoneNumberId) return;
                const { accessToken } = await getAccessToken(input.creatorId);
                await markReadWithTyping(input.phoneNumberId, accessToken, input.wamid);
            } catch (err) {
                // The receipt and the indicator are decoration: the reply is the point.
                log('warn', 'wa.sender_action_failed', { creator_id: input.creatorId, conversation_id: input.conversationId, ...describeError(err) });
            }
        },
        async recorded(replyId, message) {
            await attachWamid(replyId, message.wamid);
        },
    };
}

/** What a refused or failed send means for the inbound row, and whether another attempt could change it. */
interface Failure {
    reason: NoReplyReason;
    /** The alert's reason: why the customer could not be answered. */
    block: WhatsAppSendBlock | 'engine_failed';
    /** Trying again may work: not a refusal that will be the same, and nothing was delivered. */
    retryable: boolean;
}

function failureOf(err: unknown, delivered: boolean): Failure {
    if (delivered) return { reason: 'failure', block: 'engine_failed', retryable: false };
    if (err instanceof SalesSendRefused) {
        switch (err.reason) {
            case 'window_closed': return { reason: 'window_closed', block: 'window_closed', retryable: false };
            case 'billable_blocked': return { reason: 'billable_blocked', block: 'billable_blocked', retryable: false };
            case 'connection_invalid': return { reason: 'connection_invalid', block: 'connection_invalid', retryable: false };
            // A throttle, or a connection that never went out: nothing was delivered and waiting may cure it. A failure that MAY have landed never is.
            default: return { reason: 'failure', block: 'engine_failed', retryable: !err.info.permanent && !err.info.mayHaveLanded };
        }
    }
    // The database, a profile, anything on our side before a send: a retry may cure it, and nothing has gone to the customer.
    return { reason: 'failure', block: 'engine_failed', retryable: true };
}

/**
 * The reply could not be sent, so the customer is unanswered and a person has to know: the conversation is stamped (the inbox's "Needs you", the bot left on
 * as `failureHandoff.ts` leaves it) and the owner is told. Never throws.
 */
async function handOver(input: WhatsAppAnswerInput, block: Extract<NoticePlan, { kind: 'handoff' }>['reason'], language: string): Promise<void> {
    const logBase = { creator_id: input.creatorId, conversation_id: input.conversationId };
    try {
        await queryCount(
            `UPDATE conversations SET stage = 'handoff', handoff_at = NOW(), handoff_reason = $3 WHERE id = $1 AND creator_id = $2`,
            [input.conversationId, input.creatorId, FAILURE_HANDOFF_REASON]
        );
    } catch (err) {
        log('warn', 'wa.handoff_stamp_failed', { ...logBase, ...describeError(err) });
    }
    await notifyOwner({ creatorId: input.creatorId, conversationId: input.conversationId, plan: { kind: 'handoff', reason: block }, language });
}

/**
 * Answer one WhatsApp message. Returns what the inbound row should say; throws only to ask for a retry, after releasing the claim (see the top of the file).
 */
export async function answerWhatsApp(input: WhatsAppAnswerInput): Promise<WhatsAppAnswerResult> {
    const logBase = { creator_id: input.creatorId, conversation_id: input.conversationId };
    const transport = whatsappTransport(input);
    /** The language of the alert if the turn never got as far as reading the profile: the owner's own. */
    let language = 'ar';
    try {
        // Who the creator is, once for this message: the model's rules and schema, the disclosure line and every line of a hand-off are written from it. A
        // profile that cannot be read is the owner's wording (`profileContextOrLegacy`), never a failed reply. Inside the `try` all the same: whatever
        // goes wrong on the way to the model must end in a conclusion for this message, and not in a claim nobody releases.
        const ctx = await profileContextOrLegacy(input.creatorId, 'dm');
        language = ctx.language.code;
        const turn = await runSalesTurn({
            // Not read with a transport: the token is the connection's (`getAccessToken`), and there is no Facebook Page.
            creator: { id: input.creatorId, page_access_token: '' },
            pageId: undefined,
            conversation: { id: input.conversationId },
            inbound: { id: input.messageId, senderId: input.senderId, text: input.text, payload: input.payload || undefined },
            ctx,
            disclosure: { needed: needsDisclosure(input.aiDisclosedAt), line: disclosureLine(ctx.language.code) },
            transport,
        });
        const reason = reasonOfTurn(turn);
        log('info', 'wa.answered', { ...logBase, outcome: turn.kind === 'done' ? turn.outcome : 'quota', no_reply_reason: reason });
        return { reason };
    } catch (err) {
        const failure = failureOf(err, transport.sent);
        const refused = err instanceof SalesSendRefused ? err.reason : null;
        if (failure.retryable && !input.lastAttempt) {
            // Nothing reached the customer and another attempt may cure it: hand the message back, and let the runner back off.
            log('warn', 'wa.answer_retrying', { ...logBase, refused, ...describeError(err) });
            await releaseClaim(input.messageId);
            throw err;
        }
        if (transport.sent) {
            // The reply went out and only what came after it failed (the record of the turn): the customer HAS been answered, and answering again is the
            // one thing worse than a row that is missing. Concluded as answered; the log is what says the thread does not show it.
            log('error', 'wa.answered_unrecorded', { ...logBase, ...describeError(err), effect: 'the reply was sent; the thread may not show it' });
            return { reason: null };
        }
        log('error', 'wa.answer_failed', { ...logBase, no_reply_reason: failure.reason, refused, ...describeError(err) });
        await handOver(input, failure.block, language);
        return { reason: failure.reason };
    }
}
