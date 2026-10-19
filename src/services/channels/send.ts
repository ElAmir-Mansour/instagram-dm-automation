/**
 * The WhatsApp sender (docs/specs/001-whatsapp-agent/contracts/outbound-send.md section 1): the one place a reply is turned into a message and handed to
 * Meta for a WhatsApp thread, for the agent and for the operator typing in the inbox alike. `sendWhatsAppReply` answers `{ ok: true, ... }` or a refusal
 * that says why, and it never throws for a refusal: whoever asked decides what a refusal means (a 409 for a person at the inbox, a note on the message
 * and a handoff for the agent).
 *
 * Instagram and Messenger are NOT here. Their sends stay `sendDirectMessage` at every call site they have, byte for byte; this file adds a path for a
 * channel that had none, and moves nothing off an existing one.
 *
 * In order, and each step that says no makes NO call to Meta:
 *
 *   1. the thread     the conversation, scoped to the tenant, and a WhatsApp one                    `conversation_not_found`, `not_whatsapp`
 *   2. the connection the tenant's number, `active` and holding a token                             `connection_invalid`
 *   3. the window     `isWindowOpen(last_inbound_at, free_window_expires_at)` (`channels/window.ts`)  `window_closed`
 *   4. the meter      a service message that would be billable, with `settings.allow_billable` off  `billable_blocked`
 *   5. the shape      `toWhatsAppMessage`: one message, never two (review M14)                       `invalid_message`
 *   6. the send       `whatsapp.sendMessage`, which is NEVER retried once it may have landed
 *   7. the row        the outbound `messages` row, with the `wamid` Meta returned, so a delivery status can find it
 *
 * **A failure is classified, not guessed** (`classifyWhatsAppError`). A dead token or a payment problem marks the connection `invalid` (every surface
 * then says "reconnect", and inbound messages are still stored); the window closing under us is `window_closed`; a throttle is `rate_limited`
 * (retryable); an unknown error is `send_failed`. `mayHaveLanded` says whether the failure could have come AFTER WhatsApp delivered (a timeout, a reset,
 * a 5xx): the caller must not send the same words again then. A 4xx from Meta is a refusal, and nothing was delivered.
 *
 * **The agent records its own row.** A sales turn writes its reply and the conversation's new state in one statement (`recordTurn`), so it asks for
 * `record: false` and attaches the `wamid` to its row afterwards (`attachWamid`). Everyone else leaves the default and gets the row here.
 *
 * Nothing here logs a message's words or a token: a line carries the conversation, the kind, the shape, and Meta's code.
 */
import { queryCount, queryOne } from '../../db/query.js';
import { toWhatsAppMessage, WhatsAppShapeError, type WhatsAppReplyBody } from '../../webhook/whatsappPayload.js';
import { describeError, log } from '../../utils/log.js';
import { freeUsed, periodOf, wouldBeBillable } from '../channelUsage.js';
import { metaErrorCode } from '../http.js';
import { sendMessage } from '../whatsapp.js';
import { classifyWhatsAppError } from '../whatsappErrors.js';
import { getAccessToken, markConnectionInvalid, WhatsAppNotConnectedError } from '../whatsappConnections.js';
import { isWindowOpen, windowClosesAt } from './window.js';

/** Who asked: the bot's reply, a person typing in the inbox, or the line that hands a conversation over. */
export type WhatsAppSendKind = 'agent' | 'operator' | 'handoff';

/** `messages.sender` for each kind: the inbox tags the bot's replies apart from a person's own. */
const SENDER_OF: Record<WhatsAppSendKind, 'ai' | 'operator'> = { agent: 'ai', handoff: 'ai', operator: 'operator' };

export interface SendWhatsAppReplyInput {
    creatorId: string;
    conversationId: string;
    kind: WhatsAppSendKind;
    body: WhatsAppReplyBody;
    /** Store the outbound row (the default). The sales turn stores its own with the conversation's new state and passes false. */
    record?: boolean;
    /** The clock. Tests only. */
    now?: Date;
}

export type SendFailureReason =
    | 'conversation_not_found'
    | 'not_whatsapp'
    | 'connection_invalid'
    | 'window_closed'
    | 'billable_blocked'
    | 'invalid_message'
    | 'undeliverable'
    | 'rate_limited'
    | 'rejected'
    | 'send_failed';

export type WhatsAppSendResult =
    | {
        ok: true;
        /** Null when Meta answered 200 with no id: the message may be on its way and nothing can track it. */
        wamid: string | null;
        /** The outbound row, when this call wrote one and the write held. */
        messageId: string | null;
    }
    | {
        ok: false;
        reason: SendFailureReason;
        /** A request went to Meta. False for every refusal that came before it. */
        attempted: boolean;
        /** Sending the same thing again will fail the same way. */
        permanent: boolean;
        /** The failure could have come after WhatsApp delivered: never send the same words again. */
        mayHaveLanded: boolean;
        /** Meta's error code, when it gave one. */
        code: number | null;
        /** When the window closes (or closed), for `window_closed`. */
        closesAt: Date | null;
        /** A sentence for the owner's log or a refusal body: no token, no message words. */
        detail: string;
    };

/** What a person is told when there is no usable connection, whatever the reason stored with it (Meta's own words are for the Settings card, not for a refusal). */
const RECONNECT = 'WhatsApp is not connected, or Meta refused the connection: reconnect it in Settings.';

/** The failure result for a step that said no before any request: nothing was attempted, nothing can have landed. */
function refused(reason: SendFailureReason, detail: string, extra: Partial<Extract<WhatsAppSendResult, { ok: false }>> = {}): WhatsAppSendResult {
    return { ok: false, reason, attempted: false, permanent: true, mayHaveLanded: false, code: null, closesAt: null, detail, ...extra };
}

/** Who a reply is addressed to: the contact's phone (`to`) when known, else their BSUID (`recipient`). See the send step below. */
export function recipientOf(thread: Pick<ThreadRow, 'instagram_user_id' | 'wa_phone'>): string {
    const phone = typeof thread.wa_phone === 'string' ? thread.wa_phone.trim().replace(/^\+/, '') : '';
    return /^\d{8,15}$/.test(phone) ? phone : thread.instagram_user_id;
}

interface ThreadRow {
    id: string;
    instagram_user_id: string;
    /** v50. The contact's phone in E.164 digits when Meta has sent `wa_id`; NULL for a username-only contact. */
    wa_phone: string | null;
    platform: string | null;
    last_inbound_at: Date | string | null;
    free_window_expires_at: Date | string | null;
}

/** An error that ended without an answer from Meta, or with a server error, may have been delivered all the same. */
function mayHaveLanded(err: unknown): boolean {
    const cause = (err as { cause?: { response?: { status?: unknown }; code?: unknown } } | null)?.cause;
    const status = cause?.response?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) return false;
    if (typeof cause?.code === 'string' && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(cause.code)) return false;
    return true;
}

const statusOf = (err: unknown): number | null => {
    const status = (err as { cause?: { response?: { status?: unknown } } } | null)?.cause?.response?.status;
    return typeof status === 'number' ? status : null;
};

export async function sendWhatsAppReply(input: SendWhatsAppReplyInput): Promise<WhatsAppSendResult> {
    const { creatorId, conversationId, kind } = input;
    const now = input.now ?? new Date();
    const logBase = { creator_id: creatorId, conversation_id: conversationId, kind };

    // 1. The thread, for this tenant only: unscoped, this would send from one tenant's number to another's customer.
    const thread = await queryOne<ThreadRow>(
        `SELECT id, instagram_user_id, wa_phone, platform, last_inbound_at, free_window_expires_at
           FROM conversations WHERE id = $1 AND creator_id = $2`,
        [conversationId, creatorId]
    );
    if (!thread) return refused('conversation_not_found', 'There is no such conversation.');
    if (thread.platform !== 'whatsapp') return refused('not_whatsapp', 'This conversation is not on WhatsApp.');

    // 2. The connection. `getAccessToken` throws for no row, a revoked one, one with no token and an `invalid` one: all "reconnect in Settings".
    let token: string;
    let connection: Awaited<ReturnType<typeof getAccessToken>>['connection'];
    try {
        ({ accessToken: token, connection } = await getAccessToken(creatorId));
    } catch (err) {
        if (err instanceof WhatsAppNotConnectedError) {
            log('warn', 'wa.send_refused', { ...logBase, reason: 'connection_invalid' });
            return refused('connection_invalid', RECONNECT);
        }
        throw err;
    }
    if (connection.status !== 'active') {
        log('warn', 'wa.send_refused', { ...logBase, reason: 'connection_invalid' });
        return refused('connection_invalid', RECONNECT);
    }

    // 3. The window. Meta would answer 131047 and a template would be needed; declining to send is recoverable, sending is not.
    const window = { lastInboundAt: thread.last_inbound_at, freeWindowExpiresAt: thread.free_window_expires_at };
    if (!isWindowOpen({ ...window, now })) {
        const closesAt = windowClosesAt(window);
        log('info', 'wa.send_refused', { ...logBase, reason: 'window_closed', closes_at: closesAt?.toISOString() ?? null });
        return refused('window_closed', 'The 24-hour window has closed: a reply is possible once the customer writes again.', { closesAt });
    }

    // 4. The meter. Past 1,000 delivered service messages a month Meta bills each one, and an account with no payment method has them not delivered at
    // all: the owner chooses (`allow_billable`) before the first one that would cost. A meter that cannot be read is a thrown error: not sent.
    if (!connection.settings.allow_billable) {
        const used = await freeUsed(creatorId, connection.phoneNumberId, periodOf(now));
        if (wouldBeBillable({ category: 'service', freeUsed: used })) {
            log('warn', 'wa.send_refused', { ...logBase, reason: 'billable_blocked', free_used: used });
            return refused('billable_blocked', 'The free replies for this month are used up, and replies that cost money are switched off in Settings.');
        }
    }

    // 5. The shape: one message.
    let message;
    try {
        // The phone when Meta gave us one, else the BSUID. A test number delivers only to the phone numbers on its allowed list and checks
        // that list by phone: addressed by BSUID, every reply failed with 131030 "Recipient phone number not in allowed list" (2026-10-19,
        // the owner's own number on the list). A username-only contact has no phone and is reached by BSUID, as Meta documents.
        message = toWhatsAppMessage(input.body, recipientOf(thread));
    } catch (err) {
        if (err instanceof WhatsAppShapeError) {
            log('warn', 'wa.send_refused', { ...logBase, reason: 'invalid_message' });
            return refused('invalid_message', err.message);
        }
        throw err;
    }

    // 6. The send. Never retried after it may have landed (`creates` in `sendMessage`).
    let sent;
    try {
        sent = await sendMessage(connection.phoneNumberId, token, message);
    } catch (err) {
        return failedSend(err, { connectionId: connection.id, logBase, shape: message.type });
    }
    log('info', 'wa.sent', { ...logBase, shape: message.type, has_wamid: sent.messageId !== null });
    if (sent.messageId === null) log('warn', 'wa.send_no_id', logBase);

    // 7. The row. The message has gone: a write that fails is logged loudly and does not turn a delivered message into a failed send.
    let messageId: string | null = null;
    if (input.record !== false) {
        try {
            const quick = (input.body.quickReplies ?? []).filter((q) => q.title && q.payload);
            const row = await queryOne<{ id: string }>(
                `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload, meta_message_id, sender)
                 VALUES ($1, $2, 'outbound', $3, $4, $5::jsonb, $6, $7)
                 RETURNING id`,
                [
                    conversationId, creatorId, quick.length > 0 ? 'quick_reply' : 'text', input.body.text.trim(),
                    // What the inbox and the model's history read, in the shape they already read (`{ text, quick_replies }`), not Meta's request.
                    JSON.stringify(quick.length > 0
                        ? { text: input.body.text.trim(), quick_replies: quick.map((q) => ({ content_type: 'text', title: q.title, payload: q.payload })) }
                        : { text: input.body.text.trim() }),
                    sent.messageId, SENDER_OF[kind],
                ]
            );
            messageId = row?.id ?? null;
        } catch (err) {
            log('error', 'wa.send_unrecorded', { ...logBase, ...describeError(err), effect: 'the message was sent; the thread does not show it' });
        }
    }
    return { ok: true, wamid: sent.messageId, messageId };
}

/** Meta's answer to a failed send, as a result: what it was, whether it can be tried again, and whether it could have been delivered anyway. */
async function failedSend(
    err: unknown, ctx: { connectionId: string; logBase: Record<string, unknown>; shape: string }
): Promise<WhatsAppSendResult> {
    const code = metaErrorCode(err) ?? null;
    const verdict = classifyWhatsAppError(code);
    const status = statusOf(err);
    const landed = mayHaveLanded(err);
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const base = { ok: false as const, attempted: true, mayHaveLanded: landed, code, closesAt: null, detail };

    let reason: SendFailureReason;
    let permanent = verdict.kind === 'permanent';
    switch (verdict.reason) {
        case 'window_closed': reason = 'window_closed'; break;
        case 'undeliverable': reason = 'undeliverable'; break;
        case 'pair_rate_limit':
        case 'throughput': reason = 'rate_limited'; break;
        case 'token_or_permission':
        case 'payment_issue': {
            reason = 'connection_invalid';
            // A dead token, a missing permission or a payment problem stops EVERY send, not this one: say so where the owner looks.
            try {
                await markConnectionInvalid(ctx.connectionId, detail);
            } catch (markErr) {
                log('error', 'wa.connection_mark_failed', { ...ctx.logBase, ...describeError(markErr) });
            }
            break;
        }
        case null:
            // A code nobody classified. A 4xx is Meta refusing this request (bad parameter, a BSUID it cannot use): the same request fails again.
            reason = 'send_failed';
            permanent = status !== null && status >= 400 && status < 500 && status !== 429;
            break;
        default: reason = 'rejected';
    }
    log(permanent ? 'error' : 'warn', 'wa.send_failed', {
        ...ctx.logBase, reason, code, status, shape: ctx.shape, permanent, may_have_landed: landed, ...describeError(err),
    });
    // What the connection stored and the log keep is Meta's own sentence; what a person is told is the next step.
    return { ...base, reason, permanent, detail: reason === 'connection_invalid' ? RECONNECT : detail };
}

/**
 * Put a `wamid` on a row the sender did not write (the sales turn's own reply), so the status webhook can find the message. Best effort and made to
 * be called after the send: it never throws, because the message has gone and a failure here only costs the delivery tick.
 */
export async function attachWamid(messageId: string | null, wamid: string | null): Promise<boolean> {
    if (!messageId || !wamid) return false;
    try {
        return (await queryCount('UPDATE messages SET meta_message_id = $2 WHERE id = $1 AND meta_message_id IS NULL', [messageId, wamid])) > 0;
    } catch (err) {
        log('warn', 'wa.wamid_not_attached', { message_id: messageId, ...describeError(err) });
        return false;
    }
}
