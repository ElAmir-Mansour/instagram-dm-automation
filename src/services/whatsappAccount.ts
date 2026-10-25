/**
 * What Meta says about the WhatsApp ACCOUNT, as opposed to one message (docs/specs/001-whatsapp-agent tasks T023, review H6, M13).
 *
 *   account_update              deleted, offboarded, reconnected, restricted, violation, ban (`DISABLED_UPDATE`), partner removed, and a
 *                               dozen events about partners and pricing that change nothing here
 *   account_alerts              Meta's own warnings (a limit that cannot grow, a policy notice)
 *   phone_number_quality_update the messaging limit tier, FLAGGED / UNFLAGGED, a throughput upgrade
 *   phone_number_name_update    the display-name review: APPROVED or DECLINED
 *   business_capability_update  the portfolio's daily limit and number cap
 *
 * Each becomes one or more `Change`s: a patch to `platform_connections.profile`, maybe a move of `status` (`invalid` when Meta stopped the
 * account from replying, back to `active` when it says that is over), and the alert the owner gets. The statuses are the three the CHECK at
 * migration_v18 allows: `revoked` is the owner's disconnect and nothing Meta says reaches it.
 *
 * ## "Once per distinct change" is decided by what is STORED, never by the clock
 *
 * `profile.alerts[key]` is the last value the owner was told for that key. A change whose value equals it is a duplicate (Meta redelivers, a
 * job is retried): applied to nothing, announced to no one. A change that differs is news, however soon it follows: GREEN -> YELLOW -> GREEN ->
 * YELLOW is four alerts, because each differs from the one before. For a state Meta also reports on the row (the quality, the limit) the
 * profile's own field stands in until the first alert is stored, so the first event does not announce a value the owner already sees.
 * Point events with no state to compare (a violation) carry their `entry.time` in the value, so a retry (same time) is one alert and a second
 * violation is another.
 *
 * ## The write is a compare-and-set on the whole profile
 *
 * A change is read, decided, and written `WHERE profile = <what was read>`. A webhook and the daily sweep can both be changing the same
 * connection; whichever loses re-reads and decides again, so no change is announced twice and none is announced over a newer one. Three
 * lost races in a row throw, and the job retry decides again.
 *
 * ## The alert goes out AFTER the claim, and a failure to send gives the claim back
 *
 * Claim-then-send means two racing runs cannot both send. If the send FAILS (Telegram said no, or did not answer) the claim is released and
 * the job fails, so the retry sends it; a run that dies between the claim and the send is the one loss left, and the next distinct change
 * still alerts. Alerts that are switched off are not a failure: the state is stored and the Settings card shows it.
 *
 * Nothing here sends a WhatsApp message or reaches an AI.
 */
import { queryCount, queryOne, queryRows } from '../db/query.js';
import type { ConnectionStatus } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import type { WaEventPayload } from '../jobs/types.js';
import { freeUsed, periodOf } from './channelUsage.js';
import { FREE_REPLIES_PER_MONTH, readSettings, type AccountBlock } from './whatsappConnections.js';
import { notifyWhatsAppOwner, type WhatsAppAlert, type WhatsAppAlertTarget } from './whatsappNotify.js';

type Raw = Record<string, unknown>;

const isObj = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const asRaw = (value: unknown): Raw => (isObj(value) ? value : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const isoOf = (seconds: number | null): string | null => (seconds === null ? null : new Date(seconds * 1000).toISOString());
const digits = (value: unknown): string => (typeof value === 'string' ? value.replace(/\D/g, '') : '');

// ─── What a change is ───────────────────────────────────────────────────────────────────

/** The one connection row, as the changes read and write it. The token columns are NOT here. */
export interface AccountRow {
    id: string;
    creator_id: string;
    external_account_id: string;
    display_name: string | null;
    status: ConnectionStatus;
    last_error: string | null;
    profile: unknown;
    settings?: unknown;
}

export const ROW_COLUMNS = 'id, creator_id, external_account_id, display_name, status, last_error, profile, settings';

export interface Change {
    /** Which "last told value" this is compared with and stored under (`profile.alerts[key]`). */
    key: string;
    /** The value, as text: what is compared and what is stored. */
    sig: string;
    /** What stands in for the stored value until there is one (the profile's own field for a state Meta also reports). */
    fallback?: (profile: Raw) => string | null;
    /** True: a change with nothing to compare it with is only recorded, not announced (the first reading of something). */
    silentWithoutPrevious?: boolean;
    /** Profile keys written (a shallow merge). `null` clears one. */
    patch?: Raw;
    /** A new `platform_connections.display_name` (Meta's verified name), when the event carries one. */
    displayName?: string | null;
    /** Meta stopped the account: `status` becomes `invalid` and `profile.account_block` says why (and until when). */
    invalidate?: { block: AccountBlock; until: string | null; reason: string };
    /** Meta says a block is over: the listed blocks are cleared and a connection they held `invalid` returns to `active`. */
    restore?: { clears: readonly AccountBlock[] };
    /** What the owner is told, given the value they were last told; null = recorded, not announced. */
    alert: ((previous: string | null) => WhatsAppAlert | null) | null;
}

export type CommitResult =
    /** Written. `alert` is what to send (null: nothing); `previous` is the value to hand back if the send fails. */
    | { result: 'applied'; alert: WhatsAppAlert | null; target: WhatsAppAlertTarget; previous: string | null; row: AccountRow }
    /** The stored value already equals this one: a repeat. Nothing was written. */
    | { result: 'duplicate' }
    /** The connection is gone or was disconnected between the lookup and the write. */
    | { result: 'gone' };

const MAX_ATTEMPTS = 3;

/**
 * Read the row, decide with `decide`, and write the decision only if the profile is still what was read. `decide` returns null to write
 * nothing (a duplicate). Pure in `decide`; the loop is the whole of the concurrency story (see the header).
 */
async function casUpdate<R>(
    connectionId: string,
    decide: (row: AccountRow) => { profile: Raw; status: ConnectionStatus; lastError: string | null; displayName: string | null; value: R } | null
): Promise<{ kind: 'written'; value: R; row: AccountRow; profile: Raw } | { kind: 'unchanged' } | { kind: 'gone' }> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const row = await queryOne<AccountRow>(
            `SELECT ${ROW_COLUMNS} FROM platform_connections WHERE id = $1 AND platform = 'whatsapp' AND status <> 'revoked'`,
            [connectionId]
        );
        if (!row) return { kind: 'gone' };
        const decision = decide(row);
        if (!decision) return { kind: 'unchanged' };
        const n = await queryCount(
            `UPDATE platform_connections
                SET profile = $2::jsonb, status = $3, last_error = $4, display_name = COALESCE($5, display_name), updated_at = NOW()
              WHERE id = $1 AND platform = 'whatsapp' AND status = $6 AND profile IS NOT DISTINCT FROM $7::jsonb`,
            [
                connectionId, JSON.stringify(decision.profile), decision.status, decision.lastError, decision.displayName, row.status,
                row.profile === null || row.profile === undefined ? null : JSON.stringify(row.profile),
            ]
        );
        if (n > 0) return { kind: 'written', value: decision.value, row, profile: decision.profile };
        log('debug', 'wa.account_cas_retry', { connection_id: connectionId, attempt: attempt + 1 });
    }
    throw new Error(`The WhatsApp connection ${connectionId} kept changing while an account event was applied; it will be retried.`);
}

const withAlert = (alerts: Raw, key: string, sig: string | null): Raw => {
    const next = { ...alerts };
    if (sig === null) delete next[key];
    else next[key] = sig;
    return next;
};

const targetOf = (row: AccountRow, profile: Raw, displayName: string | null): WhatsAppAlertTarget => ({
    number: str(profile.display_phone_number),
    name: displayName ?? row.display_name,
    phoneNumberId: row.external_account_id,
});

/**
 * Apply one change to one connection, once. See the header: a value equal to the stored one is a duplicate; otherwise the patch, the status
 * move and the stored value are written together, and the caller sends the alert.
 */
export async function commitChange(connectionId: string, change: Change): Promise<CommitResult> {
    const out = await casUpdate<{ alert: WhatsAppAlert | null; previous: string | null }>(connectionId, (row) => {
        const profile = asRaw(row.profile);
        const alerts = asRaw(profile.alerts);
        const stored = str(alerts[change.key]);
        const previous = stored ?? change.fallback?.(profile) ?? null;
        if (previous === change.sig) return null;

        const next: Raw = { ...profile, ...(change.patch ?? {}) };
        let status = row.status;
        let lastError = row.last_error;
        let nextAlerts = withAlert(alerts, change.key, change.sig);
        const block = str(profile.account_block);

        if (change.invalidate) {
            next.account_block = change.invalidate.block;
            if (change.invalidate.until) next.block_until = change.invalidate.until;
            else delete next.block_until;
            status = 'invalid';
            lastError = change.invalidate.reason.slice(0, 500);
            nextAlerts = withAlert(nextAlerts, 'connection', 'invalid');
        }
        if (change.restore && block && (change.restore.clears as readonly string[]).includes(block)) {
            delete next.account_block;
            delete next.block_until;
            if (status === 'invalid') {
                status = 'active';
                lastError = null;
                nextAlerts = withAlert(nextAlerts, 'connection', 'active');
            }
        }
        next.alerts = nextAlerts;

        const silent = change.silentWithoutPrevious === true && previous === null;
        return {
            profile: next,
            status,
            lastError,
            displayName: change.displayName ?? null,
            value: { alert: silent || !change.alert ? null : change.alert(previous), previous },
        };
    });
    if (out.kind === 'gone') return { result: 'gone' };
    if (out.kind === 'unchanged') return { result: 'duplicate' };
    return {
        result: 'applied',
        alert: out.value.alert,
        previous: out.value.previous,
        target: targetOf(out.row, out.profile, change.displayName ?? null),
        row: out.row,
    };
}

/** Give a claim back (the alert could not be sent): the value the owner was last told is put back, so the retry sees a change again. */
export async function releaseClaim(connectionId: string, change: Pick<Change, 'key' | 'sig'>, previous: string | null): Promise<void> {
    await casUpdate<null>(connectionId, (row) => {
        const profile = asRaw(row.profile);
        const alerts = asRaw(profile.alerts);
        if (alerts[change.key] !== change.sig) return null; // someone moved on from it already: nothing of ours to give back
        return { profile: { ...profile, alerts: withAlert(alerts, change.key, previous) }, status: row.status, lastError: row.last_error, displayName: null, value: null };
    });
}

/**
 * Commit a change and tell the owner. Returns what happened. A send that FAILS releases the claim and throws (`throwOnFailedAlert`, for a job
 * that will be retried) or just says so (`alertFailed`, for the daily sweep, which looks at the same values again tomorrow).
 */
export async function commitAndNotify(
    connectionId: string,
    change: Change,
    options: { throwOnFailedAlert?: boolean } = {}
): Promise<'applied' | 'duplicate' | 'gone' | 'alerted' | 'alertFailed'> {
    const committed = await commitChange(connectionId, change);
    if (committed.result !== 'applied') return committed.result;
    if (!committed.alert) return 'applied';
    const outcome = await notifyWhatsAppOwner(committed.alert, committed.target);
    if (outcome === 'sent' || outcome === 'off') return 'alerted';
    try {
        await releaseClaim(connectionId, change, committed.previous);
    } catch (err) {
        log('warn', 'wa.account_release_failed', { connection_id: connectionId, key: change.key, ...describeError(err) });
    }
    if (options.throwOnFailedAlert) throw new Error(`The owner alert for WhatsApp ${change.key} was not delivered (${outcome}); the event will be retried.`);
    return 'alertFailed';
}

// ─── Reading an event ───────────────────────────────────────────────────────────────────

/** `account_update` events that only say something about partners, pricing or linked ads: on record, and nothing changes. */
const INFORMATIONAL_EVENTS: ReadonlySet<string> = new Set([
    'AD_ACCOUNT_LINKED',
    'AUTH_INTL_PRICE_ELIGIBILITY_UPDATE',
    'BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE',
    'MM_LITE_TERMS_SIGNED',
    'PARTNER_ADDED',
    'PARTNER_APP_INSTALLED',
    'PARTNER_APP_UNINSTALLED',
    'PARTNER_CLIENT_CERTIFICATION_STATUS_UPDATE',
    'VOLUME_BASED_PRICING_TIER_UPDATE',
]);

export type AccountPlan =
    | { kind: 'changes'; changes: Change[]; /** Digits of the number the event is about, or null for an account-wide one. */ phoneDigits: string | null; /** Read the real numbers from Meta afterwards. */ readHealth: boolean }
    | { kind: 'informational'; event: string }
    | { kind: 'unhandled'; reason: string; event: string | null };

const BLOCKS_FROM_RECONNECT: readonly AccountBlock[] = ['deleted', 'offboarded', 'disconnected'];

/** What the quality, limit or status of a number says now, to put in `profile.alerts` next to the profile's own field. */
const field = (name: string) => (profile: Raw): string | null => str(profile[name]);

/**
 * One account-level event as the changes it implies. Pure: no database, no clock (`time` is the event's own, `entry.time`).
 *
 * Meta's field names and values are the ones in its published samples (src/webhook/__fixtures__/whatsapp/). Anything else, an event this
 * build has no sample for or a payload missing what the event needs, is `unhandled`: it completes, is logged by name, and is never
 * guessed into a state change.
 */
export function planAccountEvent(fieldName: string, value: unknown, time: number | null): AccountPlan {
    const v = asRaw(value);
    const at = isoOf(time) ?? new Date(0).toISOString();
    const stamp = time === null ? '' : String(time);

    switch (fieldName) {
        case 'account_update':
            return planAccountUpdate(v, time, at, stamp);

        case 'account_alerts': {
            const info = asRaw(v.alert_info);
            const type = str(info.alert_type);
            if (!type) return { kind: 'unhandled', reason: 'no_alert_type', event: null };
            const status = str(info.alert_status) ?? 'UNKNOWN';
            const severity = str(info.alert_severity) ?? 'UNKNOWN';
            const description = str(info.alert_description);
            return {
                kind: 'changes', phoneDigits: null, readHealth: false,
                changes: [{
                    key: `alert:${type.slice(0, 60)}`,
                    sig: `${status}:${severity}`,
                    // A resolved alert is recorded (so its return alerts again) and not announced.
                    alert: status === 'ACTIVE' ? () => ({ kind: 'account_alert', severity, type, description }) : null,
                }],
            };
        }

        case 'phone_number_name_update': {
            const decision = str(v.decision);
            if (!decision) return { kind: 'unhandled', reason: 'no_decision', event: null };
            const name = str(v.requested_verified_name);
            const reason = str(v.rejection_reason);
            const known = decision === 'APPROVED' || decision === 'DECLINED';
            return {
                kind: 'changes', phoneDigits: digits(v.display_phone_number) || null, readHealth: false,
                changes: [{
                    key: 'name',
                    sig: `${decision}:${name ?? ''}`,
                    patch: known ? { name_status: decision } : {},
                    displayName: decision === 'APPROVED' ? name : null,
                    alert: () => ({ kind: 'name', decision, name, reason }),
                }],
            };
        }

        case 'phone_number_quality_update': {
            const event = str(v.event);
            const limit = str(v.current_limit);
            const changes: Change[] = [];
            if (limit) {
                changes.push({
                    key: 'limit', sig: limit, fallback: field('messaging_limit'), patch: { messaging_limit: limit },
                    alert: (previous) => ({ kind: 'limit', from: previous, to: limit }),
                });
            }
            if (event === 'FLAGGED' || event === 'UNFLAGGED') {
                const to = event === 'FLAGGED' ? 'FLAGGED' : 'CONNECTED';
                changes.push({
                    key: 'number_status', sig: to, fallback: field('number_status'), patch: { number_status: to },
                    alert: (previous) => ({ kind: 'number_status', from: previous, to }),
                });
            }
            if (event === 'THROUGHPUT_UPGRADE') {
                // Good news with nothing to do: recorded on the profile, not announced.
                changes.push({ key: 'throughput', sig: 'HIGH', fallback: field('throughput'), patch: { throughput: 'HIGH' }, alert: null });
            }
            if (changes.length === 0) return { kind: 'unhandled', reason: 'unknown_quality_event', event };
            // The event carries no rating: read the real quality (and anything else that moved) from Meta once the event is applied.
            return { kind: 'changes', phoneDigits: digits(v.display_phone_number) || null, readHealth: true, changes };
        }

        case 'business_capability_update': {
            const max = num(v.max_daily_conversations_per_business);
            if (max === null) return { kind: 'unhandled', reason: 'no_daily_limit', event: null };
            const phones = num(v.max_phone_numbers_per_waba);
            return {
                kind: 'changes', phoneDigits: null, readHealth: false,
                changes: [{
                    key: 'capability', sig: String(max),
                    fallback: (profile) => {
                        const cap = asRaw(profile.business_capability);
                        return num(cap.max_daily_conversations) === null ? null : String(num(cap.max_daily_conversations));
                    },
                    patch: { business_capability: { max_daily_conversations: max, max_phone_numbers: phones, at } },
                    alert: (previous) => ({ kind: 'capability', from: previous === null ? null : Number(previous), to: max, phoneNumbers: phones }),
                }],
            };
        }

        default:
            return { kind: 'unhandled', reason: 'unknown_field', event: null };
    }
}

function planAccountUpdate(v: Raw, time: number | null, at: string, stamp: string): AccountPlan {
    const event = str(v.event);
    if (!event) return { kind: 'unhandled', reason: 'no_event', event: null };
    if (INFORMATIONAL_EVENTS.has(event)) return { kind: 'informational', event };

    const one = (change: Change): AccountPlan => ({ kind: 'changes', phoneDigits: null, readHealth: false, changes: [change] });

    switch (event) {
        case 'ACCOUNT_DELETED':
        case 'ACCOUNT_OFFBOARDED': {
            const deleted = event === 'ACCOUNT_DELETED';
            return one({
                key: 'disconnection', sig: event,
                patch: { disconnection: { event, reason: null, initiated_by: null, at } },
                invalidate: { block: deleted ? 'deleted' : 'offboarded', until: null, reason: deleted ? 'The WhatsApp account was deleted.' : 'The WhatsApp account was taken off this app.' },
                alert: () => ({ kind: 'disconnected', event, reason: null, initiatedBy: null }),
            });
        }

        case 'PARTNER_REMOVED': {
            const info = v.disconnection_info;
            // No `disconnection_info`: a partner was removed from the account, which does not stop this app. With it, the number was disconnected.
            if (!isObj(info)) return { kind: 'informational', event };
            const reason = str(info.reason);
            const initiatedBy = str(info.initiated_by);
            return one({
                key: 'disconnection', sig: `${event}:${reason ?? ''}`,
                patch: { disconnection: { event, reason, initiated_by: initiatedBy, at } },
                invalidate: { block: 'disconnected', until: null, reason: `The WhatsApp number was disconnected${reason ? ` (${reason})` : ''}.` },
                alert: () => ({ kind: 'disconnected', event, reason, initiatedBy }),
            });
        }

        case 'ACCOUNT_RECONNECTED':
            return one({
                key: 'disconnection', sig: event,
                patch: { disconnection: null },
                restore: { clears: BLOCKS_FROM_RECONNECT },
                alert: () => ({ kind: 'reconnected' }),
            });

        case 'ACCOUNT_RESTRICTION': {
            const items = (Array.isArray(v.restriction_info) ? v.restriction_info : [])
                .filter(isObj)
                .map((r) => ({ type: str(r.restriction_type), expiration: num(r.expiration) }))
                .filter((r): r is { type: string; expiration: number | null } => r.type !== null);
            if (items.length === 0) return { kind: 'unhandled', reason: 'no_restriction_info', event };
            items.sort((a, b) => a.type.localeCompare(b.type) || (a.expiration ?? 0) - (b.expiration ?? 0));
            // Replies are customer-initiated messages: only that restriction stops them (a restriction on business-initiated messages or on
            // adding numbers leaves them alone). One that had already ended when Meta announced it stops nothing.
            const stopping = items.filter((r) => r.type.includes('CUSTOMER_INITIATED') && (r.expiration === null || time === null || r.expiration > time));
            const stopsSending = stopping.length > 0;
            const open = stopping.some((r) => r.expiration === null);
            const lastEnd = stopping.reduce<number | null>((max, r) => (r.expiration !== null && (max === null || r.expiration > max) ? r.expiration : max), null);
            const until = open ? null : isoOf(lastEnd);
            const everyEnd = items.reduce<number | null>((max, r) => (r.expiration !== null && (max === null || r.expiration > max) ? r.expiration : max), null);
            const types = items.map((r) => r.type);
            return one({
                key: 'restriction', sig: items.map((r) => `${r.type}@${r.expiration ?? ''}`).join(','),
                patch: { restriction: { types, expires_at: isoOf(everyEnd), stops_sending: stopsSending, at } },
                ...(stopsSending ? { invalidate: { block: 'restricted' as const, until, reason: 'Meta restricted this WhatsApp number from replying.' } } : {}),
                alert: () => ({ kind: 'restriction', types, expiresAt: isoOf(everyEnd), stopsSending }),
            });
        }

        case 'ACCOUNT_VIOLATION': {
            const type = str(asRaw(v.violation_info).violation_type) ?? 'UNKNOWN';
            return one({
                // A point event with no state to compare: its own time makes a retry one alert and a second violation another.
                key: 'violation', sig: `${type}@${stamp}`,
                patch: { violation: { type, at } },
                alert: () => ({ kind: 'violation', type }),
            });
        }

        case 'DISABLED_UPDATE': {
            const info = asRaw(v.ban_info);
            const state = str(info.waba_ban_state);
            const date = str(info.waba_ban_date);
            if (state !== 'DISABLE' && state !== 'SCHEDULE_FOR_DISABLE' && state !== 'REINSTATE') {
                return { kind: 'unhandled', reason: 'unknown_ban_state', event };
            }
            return one({
                key: 'ban', sig: `${state}:${date ?? ''}`,
                patch: { ban: { state, date, at } },
                ...(state === 'DISABLE' ? { invalidate: { block: 'banned' as const, until: null, reason: 'Meta disabled this WhatsApp account.' } } : {}),
                ...(state === 'REINSTATE' ? { restore: { clears: ['banned'] as const } } : {}),
                alert: () => ({ kind: 'ban', state, date }),
            });
        }

        default:
            return { kind: 'unhandled', reason: 'unknown_event', event };
    }
}

// ─── The handler ────────────────────────────────────────────────────────────────────────

export type AccountEventOutcome =
    | { kind: 'unhandled' | 'informational' | 'no_connection' }
    | {
        kind: 'applied'; connections: number; applied: number; duplicates: number; alerted: number;
        /** The tenants whose numbers Meta should be asked about now (a quality event carries no rating): the caller reads them (`whatsappStatus.ts`). */
        readHealthFor: string[];
    };

type AccountPayload = Extract<WaEventPayload, { kind: 'account' }>;

/** The tenant's connections an account event is about: every live one on that account (`entry.id`), narrowed to one number when the event names it. */
async function connectionsFor(entryId: string, phoneDigits: string | null): Promise<Array<{ id: string; creator_id: string }>> {
    const rows = await queryRows<{ id: string; creator_id: string; profile: unknown }>(
        `SELECT id, creator_id, profile FROM platform_connections
          WHERE platform = 'whatsapp' AND status <> 'revoked' AND profile->>'waba_id' = $1`,
        [entryId]
    );
    return rows
        .filter((row) => {
            if (!phoneDigits) return true;
            const known = digits(asRaw(row.profile).display_phone_number);
            return known === '' || known === phoneDigits; // a number we never read cannot be told apart: it is the account's only one
        })
        .map((row) => ({ id: row.id, creator_id: row.creator_id }));
}

/**
 * The `wa.event` job of kind `account`. Throws only when the database does (or an owner alert could not be delivered), so the job is retried;
 * everything else, an event it does not know, a connection that is gone, a duplicate, completes. Never asks Meta anything itself.
 */
export async function handleAccountEvent(payload: AccountPayload): Promise<AccountEventOutcome> {
    const plan = planAccountEvent(payload.field, payload.value, payload.time);
    const base = { field: payload.field, entry_id: payload.entryId };

    if (plan.kind === 'unhandled') {
        log('warn', 'wa.account_event_unhandled', { ...base, reason: plan.reason, meta_event: plan.event });
        return { kind: 'unhandled' };
    }
    if (plan.kind === 'informational') {
        log('info', 'wa.account_event', { ...base, meta_event: plan.event, informational: true });
        return { kind: 'informational' };
    }

    const connections = payload.entryId ? await connectionsFor(payload.entryId, plan.phoneDigits) : [];
    if (connections.length === 0) {
        // Meta got its 200 and will not send it again: say so, once, where it can be found.
        log('info', 'wa.account_event', { ...base, connections: 0 });
        log('warn', 'wa.account_event_no_connection', base);
        return { kind: 'no_connection' };
    }

    const counts = { applied: 0, duplicates: 0, alerted: 0 };
    for (const connection of connections) {
        for (const change of plan.changes) {
            const result = await commitAndNotify(connection.id, change, { throwOnFailedAlert: true });
            if (result === 'duplicate') counts.duplicates++;
            else if (result === 'applied' || result === 'alerted') counts.applied++;
            if (result === 'alerted') counts.alerted++;
        }
    }
    log('info', 'wa.account_event', { ...base, connections: connections.length, ...counts });
    return { kind: 'applied', connections: connections.length, ...counts, readHealthFor: plan.readHealth ? connections.map((c) => c.creator_id) : [] };
}

// ─── The connection itself went invalid ─────────────────────────────────────────────────

/**
 * Meta refused the token or a permission (190, 200, 10) and the connection was marked `invalid`: tell the owner, once. Called by the daily
 * sweep, and by any send path that marks a connection invalid. Safe to call again for the same failure: the stored value is what stops a
 * second alert, and `commitAndNotify` gives it back only if the send failed.
 */
export async function reportConnectionInvalid(connectionId: string, failure: { code: number | null; reason: string | null }): Promise<string> {
    return commitAndNotify(connectionId, {
        key: 'connection', sig: 'invalid', fallback: () => 'active',
        alert: () => ({ kind: 'connection_invalid', code: failure.code, reason: failure.reason }),
    });
}

// ─── The free replies ───────────────────────────────────────────────────────────────────

export type FreeTierOutcome = 'no_connection' | 'already' | 'below' | 'alerted' | 'off' | 'alertFailed';

/**
 * A service message was just counted as delivered: has this number reached the owner's free-reply alert (`settings.free_tier_alert_at`,
 * default 900 of Meta's 1,000) in this period, and have they been told?
 *
 * Once per period: `profile.free_tier_alerted_period` holds the period the alert went out for, so the next delivery (the 901st, the 1,000th)
 * finds it and does nothing, and a new month alerts again. The period is stored BEFORE the send and given back if the send fails, so the next
 * delivery retries. Never throws into the status path: the delivery is already committed, so a failure here is logged and the next one decides.
 */
export async function checkFreeTierAlert(input: { creatorId: string; phoneNumberId: string; at?: Date }): Promise<FreeTierOutcome> {
    const period = periodOf(input.at ?? new Date());
    try {
        const row = await queryOne<AccountRow>(
            `SELECT ${ROW_COLUMNS} FROM platform_connections
              WHERE creator_id = $1 AND platform = 'whatsapp' AND external_account_id = $2 AND status <> 'revoked'`,
            [input.creatorId, input.phoneNumberId]
        );
        if (!row) return 'no_connection';
        if (asRaw(row.profile).free_tier_alerted_period === period) return 'already';

        const threshold = readSettings(row.settings).free_tier_alert_at;
        const used = await freeUsed(input.creatorId, input.phoneNumberId, period);
        if (used < threshold) return 'below';

        const claimed = await casUpdate<{ allowBillable: boolean; previous: string | null }>(row.id, (fresh) => {
            const profile = asRaw(fresh.profile);
            if (profile.free_tier_alerted_period === period) return null;
            return {
                profile: { ...profile, free_tier_alerted_period: period },
                status: fresh.status, lastError: fresh.last_error, displayName: null,
                value: { allowBillable: readSettings(fresh.settings).allow_billable, previous: str(profile.free_tier_alerted_period) },
            };
        });
        if (claimed.kind === 'gone') return 'no_connection';
        if (claimed.kind === 'unchanged') return 'already';

        const outcome = await notifyWhatsAppOwner(
            { kind: 'free_tier', used, limit: FREE_REPLIES_PER_MONTH, allowBillable: claimed.value.allowBillable },
            targetOf(claimed.row, claimed.profile, null)
        );
        if (outcome === 'sent' || outcome === 'off') return outcome === 'sent' ? 'alerted' : 'off';

        // The alert did not go: give the period back so the next delivery tries again.
        await casUpdate<null>(row.id, (fresh) => {
            const profile = asRaw(fresh.profile);
            if (profile.free_tier_alerted_period !== period) return null;
            const next = { ...profile };
            if (claimed.value.previous === null) delete next.free_tier_alerted_period;
            else next.free_tier_alerted_period = claimed.value.previous;
            return { profile: next, status: fresh.status, lastError: fresh.last_error, displayName: null, value: null };
        });
        return 'alertFailed';
    } catch (err) {
        log('warn', 'wa.free_tier_check_failed', { phone_number_id: input.phoneNumberId, period, ...describeError(err) });
        return 'alertFailed';
    }
}
