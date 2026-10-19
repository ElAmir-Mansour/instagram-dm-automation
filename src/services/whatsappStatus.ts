/**
 * `wa.event` jobs (src/jobs/handlers.ts): what WhatsApp says about our messages and about the account, as opposed to what a customer writes.
 *
 *   status       a message of OURS moved on: `sent` -> `delivered` -> `read` -> `played`, or `failed`. Applied to its `messages` row, and the
 *                first time a message counts as delivered it is counted in the usage ledger (channelUsage.ts)
 *   account      quality, limits, bans, restrictions, name review, Meta's alerts: written to the connection's profile and status and told to the
 *                owner once per distinct change (whatsappAccount.ts). A quality event carries no rating, so the real numbers are read from
 *                Meta afterwards (whatsappHealth.ts), best effort
 *   preference   a customer's marketing opt-in or opt-out: LOG ONLY in this phase (a later phase acts on it)
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
 */
import type { MessageDeliveryStatus } from '../db/rows.js';
import type { WaEventPayload } from '../jobs/types.js';
import { normalizeWhatsAppChange, type WaStatus } from '../webhook/whatsapp.js';
import { describeError, log } from '../utils/log.js';
import { recordDelivery } from './channelUsage.js';
import { withTransaction } from './studio/common.js';
import { checkFreeTierAlert, handleAccountEvent } from './whatsappAccount.js';
import { checkConnectionHealth } from './whatsappHealth.js';

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
        case 'preference':
            // A later phase turns it into a consent row. The detail names a person's phone number: not logged.
            log('info', 'wa.preference_event', { field: 'user_preferences', entry_id: payload.entryId, phone_number_id: payload.phoneNumberId });
            return;
        default: {
            const never: never = payload;
            log('warn', 'wa.event_unknown_kind', { kind: (never as { kind?: unknown })?.kind ?? null });
        }
    }
}
