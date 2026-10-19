/**
 * A WhatsApp message, stored. The `dm.process` job for `object: 'whatsapp'` (src/jobs/handlers.ts) ends here, and in this phase it ends
 * with NOTHING SENT: the agent has no WhatsApp brain yet, so every message is stored and marked "not answered, and here is why"
 * (`messages.no_reply_reason`). No function in this file, or imported by it, sends a message; `whatsappInbound.test.ts` fails if one is called.
 *
 * It is a file of its own, and not another branch of `answerDm` (messaging.ts), because the Instagram pipeline has to stay exactly what it is: this
 * writes the same tables with the same dedupe rules (the `meta_message_id` claim, the 300 s re-claim window) but a different contact
 * (a BSUID, with optional phone and username), different columns, and no model call.
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
import type { JobResult, WhatsAppDmPayload } from '../jobs/types.js';
import { getCreatorByWhatsAppNumber } from '../services/tenant.js';
import { withTransaction } from '../services/studio/common.js';
import { readWhatsAppSettings, type WhatsAppAgentSettings, type WhatsAppMode } from '../services/whatsappAgent.js';
import { redactOnFailure } from '../jobs/redaction.js';
import { describeError, log, withLogContext } from '../utils/log.js';
import { dmPromptText } from './messaging.js';
import { FINAL_ATTEMPT, type WebhookHandlerOptions } from './options.js';
import { redactedInboundPayload } from './whatsappRedact.js';
import { normalizeWhatsAppChange, type WaEntrySource, type WaIgnored, type WaInbound, type WaSystemEvent } from './whatsapp.js';

/**
 * How long one attempt may hold an inbound message before another may take it. The same 300 s as `REPLY_CLAIM_VISIBILITY_SECONDS` in
 * messaging.ts and `CLAIM_VISIBILITY_SECONDS` in src/jobs/runner.ts, for the same reason: taking a claim from a run that is still working is
 * how a person is answered twice.
 */
export const WA_CLAIM_VISIBILITY_SECONDS = 300;

/** `conversations.profile_name` is VARCHAR(255); `messages.message_type` is VARCHAR(50) and Meta's `type` is untrusted text: a type it adds one day must not fail the insert. */
const PROFILE_NAME_MAX = 255, MESSAGE_TYPE_MAX = 50;

/** Why an inbound message got no reply: `messages.no_reply_reason`. The column is free text; this is the vocabulary this file writes. */
export type NoReplyReason = 'agent_off' | 'not_test_sender' | 'unsupported_type' | 'system_event';

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
 * Why this message is not answered, in this phase. A message the agent cannot read is `unsupported_type` whatever the mode; `off` is
 * `agent_off`; `test` is `not_test_sender` for anyone not listed.
 */
export function noReplyReasonFor(input: { unsupported: boolean; mode: WhatsAppMode; isTestSender: boolean }): NoReplyReason {
    if (input.unsupported) return 'unsupported_type';
    if (input.mode === 'off') return 'agent_off';
    if (input.mode === 'test' && !input.isTestSender) return 'not_test_sender';
    // W5 replaces this: the agent answers test senders (and, once the go-live gate exists, everyone). Until then nothing is sent in any mode.
    return 'agent_off';
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
}

function incomingOf(message: WaInbound): Incoming {
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
}

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

/** Terminal: the message is concluded, unanswered, and says why. The one write that sets `no_reply_reason`. */
async function markNotAnswered(messageId: string, reason: NoReplyReason): Promise<void> {
    await queryCount(
        'UPDATE messages SET handled_at = NOW(), reply_claimed_at = NULL, no_reply_reason = $2 WHERE id = $1',
        [messageId, reason]
    );
}

/** Store one customer message (or a kept ignored one) and conclude it as not answered. */
async function storeInbound(ctx: Context, incoming: Incoming): Promise<void> {
    if (await alreadyHandled(incoming.wamid)) {
        log('info', 'wa.duplicate_ignored');
        return;
    }

    const test = isTestSender(ctx.settings.testSenders, [incoming.senderId], incoming.phone);
    if (test) ctx.progress.keepPayload = true;
    const entrySource = { ...(incoming.entrySource ?? { kind: 'organic' as const }), at: isoOf(incoming.timestamp) };

    // The thread. One statement, not SELECT-then-INSERT (two messages a second apart race on `unique_creator_user`). Who the person is
    // (phone, username, name, parent id) is written for a test sender only; a thread for anyone else is the BSUID and when they wrote.
    //   last_inbound_at   NOW() on every inbound (review H3), on insert and on update
    //   platform          set once and kept, as Instagram's is
    //   entry_source      only the first inbound sets it: a later message never rewrites how the thread began
    //   username, name   the latest value wins unless it is missing; phone and parent id fill once
    const conversation = await queryOne<{ id: string }>(
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
         RETURNING id`,
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

    const reason = noReplyReasonFor({ unsupported: incoming.unsupported, mode: ctx.settings.mode, isTestSender: test });
    await markNotAnswered(claim.id, reason);
    log('info', 'wa.inbound_stored', {
        message_type: incoming.messageType,
        stored: test ? 'full' : 'metadata_only',
        no_reply_reason: reason,
        connection_status: ctx.connectionStatus,
        conversation_id: conversation.id,
    });
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
    await markNotAnswered(claim.id, 'system_event');
    log('info', 'wa.system_event_stored', { system_type: event.systemType, stored: test ? 'full' : 'metadata_only', conversation_id: conversation.id });
}

// ─── The job ──────────────────────────────────────────────────────────────────────────────

/**
 * The `dm.process` job for one WhatsApp message. Every path out of here either stores the message and concludes it, or logs why it did not:
 * `wa.no_creator` (no connection for the number), `wa.ignored` (a message with nothing to store), `wa.duplicate_ignored`, `wa.job_empty`.
 *
 * Throws only for a failure a retry may cure (the database): the runner backs off and the claim is resumed. Nothing is sent, ever.
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
export async function handleWhatsAppInbound(payload: WhatsAppDmPayload, options: WebhookHandlerOptions = FINAL_ATTEMPT): Promise<JobResult | undefined> {
    const progress: Progress = { keepPayload: false };
    try {
        await ingest(payload, options, progress);
    } catch (err) {
        // Not knowing who the sender was (the failure came before the settings were read) is the stranger's case: redact.
        throw progress.keepPayload ? err : redactOnFailure(err, redactedInboundPayload(payload));
    }
    return progress.keepPayload ? undefined : { redactPayload: redactedInboundPayload(payload) };
}

async function ingest(payload: WhatsAppDmPayload, options: WebhookHandlerOptions, progress: Progress): Promise<void> {
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
