/**
 * `wa.event` jobs (src/jobs/handlers.ts): what WhatsApp says about our messages and about the account, as opposed to what a customer writes.
 *
 *   status       a message of OURS moved on: `sent` -> `delivered` -> `read` -> `played`, or `failed`. Applied to its `messages` row, and the
 *                first time a message counts as delivered it is counted in the usage ledger (channelUsage.ts)
 *   account      quality, limits, bans, restrictions, name review, Meta's alerts: written to the connection's profile and status and told to the
 *                owner once per distinct change (whatsappAccount.ts). A quality event carries no rating, so the real numbers are read from
 *                Meta afterwards (whatsappHealth.ts), best effort
 *   preference   a customer's "stop / resume marketing messages" button: a `marketing` consent row (`consentPreferences.ts`), for the tenant that owns the number
 *
 * None of these ever reaches an AI, and none sends a WhatsApp message. The first delivery of a `service` message also checks the owner's
 * free-reply alert (`checkFreeTierAlert`, once per period) after the transaction below has committed.
 *
 * ## A status is applied in one transaction, under a row lock
 *
 * Meta sends statuses out of order, twice, and in parallel for one message: a `read` can arrive before its `delivered`, and a redelivery can
 * run beside the original. So the row is read `FOR UPDATE`, the new status is compared with the one it holds, and the update and the ledger
 * count commit together. That is what makes "count a delivery exactly once" true: only the status that takes a message from not-delivered to
 * delivered (`delivered`, or a `read` or `played` that arrived first) counts, and a second status for the same message finds the row already
 * there. If the count fails, the status does not move either, so the retry counts it; the other order would lose it for good.
 *
 * ## Monotonic
 *
 *     sent (1) < failed (2) < delivered (3) < read (4) < played (5)
 *
 * A status that ranks below the one the row holds changes nothing about the status. `failed` after `delivered` is recorded as an error and
 * leaves `delivered` in place (a multi-device customer can produce both, data-model.md), while `delivered` after `failed` wins: the message did
 * arrive. The error columns keep the failure either way. Pricing is filled in from whichever status carries it (`sent` and `delivered` do; a
 * `read` may not), never overwritten with nothing.
 *
 * A status for a message that has no row (`wa.status_unknown_message`) completes without a retry: it is one of ours sent before this phase
 * wrote rows, or one the agent has not stored yet. The next status for the message carries the same pricing.
 *
 * ## The free-entry window (W8, T049, review M20)
 *
 * A click-to-WhatsApp ad makes the conversation's service messages free for up to 7 days, but only for a real click on a phone, so a `referral` alone proves nothing and
 * `free_window_expires_at` is NEVER set from one. The proof is a status of OUR message whose `pricing.type` is `free_entry_point`: Meta puts the window's own end in that
 * status's `conversation.expiration_timestamp`, and that is what is stored (`applyFreeEntryWindow`), clamped to 7 days from the status and never moved earlier. A status
 * with any other pricing type, or no expiry, changes nothing. The window then lets `isWindowOpen` (channels/window.ts) say yes after the 24 h are over.
 */
import type { MessageDeliveryStatus } from '../db/rows.js';
import type { WaEventPayload } from '../jobs/types.js';
import { normalizeWhatsAppChange, type WaStatus } from '../webhook/whatsapp.js';
import { describeError, log } from '../utils/log.js';
import { recordDelivery } from './channelUsage.js';
import { withTransaction } from './studio/common.js';
import { handleUserPreference } from './consentPreferences.js';
import { checkFreeTierAlert, handleAccountEvent } from './whatsappAccount.js';
import { checkConnectionHealth } from './whatsappHealth.js';
import { getCreatorByWhatsAppNumber } from './tenant.js';

/** The order a message's status only ever moves up. See the header for where `failed` sits and why. */
export const STATUS_RANK: Readonly<Record<MessageDeliveryStatus, number>> = Object.freeze({ sent: 1, failed: 2, delivered: 3, read: 4, played: 5 });

const rank = (status: string | null | undefined): number => (status && Object.hasOwn(STATUS_RANK, status) ? STATUS_RANK[status as MessageDeliveryStatus] : 0);

/** The statuses that mean the recipient's phone has the message: the ones that count as a delivery. */
const isDelivered = (status: string | null | undefined): boolean => status === 'delivered' || status === 'read' || status === 'played';

interface OutboundRow {
    id: string;
    creator_id: string | null;
    delivery_status: string | null;
    pricing_category: string | null;
    pricing_type: string | null;
    billable: boolean | null;
}

export type StatusOutcome =
    /** No outbound row has this wamid. */
    | { kind: 'unknown_message' }
    /** The row was updated. `moved`: its `delivery_status` changed. `counted`: this status made the delivery count in the ledger. */
    | { kind: 'applied'; moved: boolean; counted: boolean };

/** Meta's title and details as one line for `messages.delivery_error`, bounded: it is shown to the owner. */
function errorText(error: { title: string | null; details: string | null } | undefined): string | null {
    if (!error) return null;
    const text = [error.title, error.details].filter((part): part is string => Boolean(part)).join(': ');
    return text ? text.slice(0, 500) : null;
}

/** The most a free-entry window can last: Meta's own limit, and the clamp on whatever a status says (a window cannot be longer than the offer). */
export const FREE_ENTRY_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Store the free-entry window a status proves (see the header): only for `pricing.type = 'free_entry_point'`, only from the status's own `conversation.expiration_timestamp`, only
 * for the thread of the message the status is about, never earlier than what is stored, never more than 7 days past the status, and not at all when it is already over. One
 * statement keyed on the message, so the status's read lock on that row is what orders two statuses for one message.
 */
async function applyFreeEntryWindow(
    tx: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    row: OutboundRow,
    status: WaStatus,
): Promise<void> {
    if (status.pricing?.type?.toLowerCase() !== 'free_entry_point') return;
    const expiresAt = status.conversation?.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || !row.creator_id) return;

    const at = status.timestamp !== null ? status.timestamp * 1000 : Date.now();
    const end = Math.min(expiresAt * 1000, at + FREE_ENTRY_WINDOW_MAX_MS);
    if (end <= Date.now()) return;
    await tx.query(
        `UPDATE conversations
            SET free_window_expires_at = $3
          WHERE id = (SELECT conversation_id FROM messages WHERE id = $1) AND creator_id = $2 AND platform = 'whatsapp'
            AND (free_window_expires_at IS NULL OR free_window_expires_at < $3)`,
        [row.id, row.creator_id, new Date(end)]
    );
}

/**
 * Apply one status to our message. Exported for the tests; the job handler is `handleWhatsAppEvent`.
 *
 * `phoneNumberId` is the number the status came in on: the ledger's `external_account_id`. A status with no id for it still updates the row
 * and is simply not counted (`wa.usage_not_counted`).
 */
export async function applyStatus(status: WaStatus & { status: MessageDeliveryStatus }, phoneNumberId: string | null): Promise<StatusOutcome> {
    // What the free-reply alert needs, set inside the transaction and used only after it has committed.
    let countedService = null as { creatorId: string; phoneNumberId: string; at?: Date } | null;
    const outcome = await withTransaction<StatusOutcome>(async (tx) => {
        const found = await tx.query<OutboundRow>(
            `SELECT id, creator_id, delivery_status, pricing_category, pricing_type, billable
               FROM messages
              WHERE meta_message_id = $1 AND direction = 'outbound'
                FOR UPDATE`,
            [status.wamid]
        );
        const row = found.rows[0];
        if (!row) return { kind: 'unknown_message' };

        const moved = rank(status.status) > rank(row.delivery_status);
        const next = moved ? status.status : row.delivery_status;
        const first = status.errors?.[0];

        await tx.query(
            `UPDATE messages
                SET delivery_status = $2,
                    delivery_error_code = COALESCE($3, delivery_error_code),
                    delivery_error = COALESCE($4, delivery_error),
                    pricing_category = COALESCE($5, pricing_category),
                    pricing_type = COALESCE($6, pricing_type),
                    billable = COALESCE($7, billable)
              WHERE id = $1`,
            [
                row.id,
                next,
                status.status === 'failed' ? first?.code ?? null : null,
                status.status === 'failed' ? errorText(first) : null,
                status.pricing?.category ?? null,
                status.pricing?.type ?? null,
                status.pricing?.billable ?? null,
            ]
        );

        await applyFreeEntryWindow(tx, row, status);

        const counted = isDelivered(status.status) && !isDelivered(row.delivery_status);
        if (counted) {
            if (!row.creator_id || !phoneNumberId) {
                log('warn', 'wa.usage_not_counted', { reason: row.creator_id ? 'no_phone_number_id' : 'no_creator', phone_number_id: phoneNumberId });
            } else {
                await recordDelivery(
                    {
                        creatorId: row.creator_id,
                        phoneNumberId,
                        category: status.pricing?.category ?? row.pricing_category,
                        pricingType: status.pricing?.type ?? row.pricing_type,
                        billable: status.pricing?.billable ?? row.billable,
                        recipient: status.recipientUserId ?? status.recipientPhone ?? null,
                        ...(status.timestamp !== null ? { at: new Date(status.timestamp * 1000) } : {}),
                    },
                    tx
                );
                if ((status.pricing?.category ?? row.pricing_category)?.toLowerCase() === 'service') {
                    countedService = {
                        creatorId: row.creator_id, phoneNumberId,
                        ...(status.timestamp !== null ? { at: new Date(status.timestamp * 1000) } : {}),
                    };
                }
            }
        }
        return { kind: 'applied', moved, counted };
    });

    if (outcome.kind === 'unknown_message') {
        log('info', 'wa.status_unknown_message', { phone_number_id: phoneNumberId, status: status.status });
    } else if (!outcome.moved && status.status !== 'failed') {
        // A repeat or an out-of-order status: harmless, and said so.
        log('debug', 'wa.status_stale', { phone_number_id: phoneNumberId, status: status.status });
    }
    if (countedService) {
        // The delivery is committed; a failure to check or send the alert must not fail the status (it never throws, and says so in the log).
        await checkFreeTierAlert(countedService);
    }
    if (status.status === 'failed') {
        // The code is Meta's own (131047: outside the window, 131049: not delivered to protect the ecosystem, ...); never the message.
        log('warn', 'wa.message_failed', { phone_number_id: phoneNumberId, code: status.errors?.[0]?.code ?? null });
    }
    return outcome;
}

/** The `wa.event` job. Never sends anything. */
export async function handleWhatsAppEvent(payload: WaEventPayload): Promise<void> {
    switch (payload.kind) {
        case 'status': {
            const statuses = normalizeWhatsAppChange(payload.change).statuses;
            if (statuses.length === 0) {
                log('warn', 'wa.status_empty', { phone_number_id: payload.phoneNumberId });
                return;
            }
            for (const status of statuses) {
                if (status.status === 'unknown') {
                    log('warn', 'wa.status_unrecognised', { phone_number_id: payload.phoneNumberId, raw_status: status.rawStatus.slice(0, 40) });
                    continue;
                }
                await applyStatus({ ...status, status: status.status }, payload.phoneNumberId ?? status.phoneNumberId);
            }
            return;
        }
        case 'account': {
            const outcome = await handleAccountEvent(payload);
            if (outcome.kind !== 'applied') return;
            for (const creatorId of outcome.readHealthFor) {
                try {
                    await checkConnectionHealth(creatorId);
                } catch (err) {
                    // The event itself is applied and told. The daily sweep reads the same numbers tomorrow, so this is not worth a retry.
                    log('warn', 'wa.account_health_read_failed', { field: payload.field, entry_id: payload.entryId, creator_id: creatorId, ...describeError(err) });
                }
            }
            return;
        }
        case 'preference': {
            // Meta's own "stop / resume marketing messages" button, as a `marketing` consent row for the tenant that owns the number (`handleUserPreference`). It names a person:
            // neither the phone nor the BSUID is logged here or there. A database failure throws, so the job is retried and the stop is not lost; a number nobody connected is
            // `wa.no_creator` and completes (a retry would find the same nothing).
            log('info', 'wa.preference_event', { field: 'user_preferences', entry_id: payload.entryId, phone_number_id: payload.phoneNumberId });
            const tenant = await getCreatorByWhatsAppNumber(payload.phoneNumberId);
            if (!tenant) {
                log('warn', 'wa.no_creator', { phone_number_id: payload.phoneNumberId, source: 'user_preferences' });
                return;
            }
            await handleUserPreference(tenant.creator.id, payload);
            return;
        }
        default: {
            const never: never = payload;
            log('warn', 'wa.event_unknown_kind', { kind: (never as { kind?: unknown })?.kind ?? null });
        }
    }
}
