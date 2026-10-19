/**
 * Data-subject erasure.
 *
 * `/data-deletion` promises that a person's data will be removed on request. Until now that
 * promise was kept — when it was kept — by hand in the Supabase SQL editor, which is exactly
 * where it goes wrong: the obvious statement clears `messages.text` and leaves `raw_payload`
 * holding the same text as a verbatim JSONB copy of the Meta event, so the row still contains
 * everything the person wrote plus their Meta user id. `src/services/retention.ts` describes
 * that as the mechanism by which the promise is currently untrue. This module is the mechanism
 * by which it becomes true.
 *
 * ── Why there is a mandatory preview ──
 *
 * This is the only hard DELETE in the product. Everything else in this codebase is additive or
 * reversible; a wrong erasure destroys a customer's conversation history with no backup that
 * an operator can reach. So there is deliberately no way to spell "delete this handle" in one
 * request:
 *
 *   1. `previewErasure` resolves the handle, counts what would go, writes nothing, and returns
 *      a short-lived signed token bound to **that handle and those counts**.
 *   2. `executeErasure` accepts only a token. It re-resolves the target from the handle inside
 *      the token, re-counts inside the deleting transaction, and refuses if anything moved.
 *
 * The drift check is not only a safety rail against a stale preview — it is also what makes a
 * replayed token harmless. Once the rows are gone the counts are zero, so the same token
 * cannot delete a second person's data that happened to arrive under the same handle.
 *
 * ── What the preview does NOT return ──
 *
 * Message bodies. The operator needs to confirm they have the right person, and usernames,
 * IGSIDs, tenant names and timestamps do that; the text of what a private individual wrote
 * does not need to be rendered into an admin page and a browser cache on the way to being
 * deleted. The sample carries metadata only.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { queryRows } from '../db/query.js';
import { signWithSessionSecret } from '../middleware/auth.js';
import { log } from '../utils/log.js';

/** Long enough to read the preview and decide; short enough that a leaked token is stale. */
export const ERASURE_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Namespace folded into the HMAC so no other signed value in this app can verify here. */
const TOKEN_SCOPE = 'erasure:v1';

/** Rows sampled per table. Enough to recognise a person, few enough to read. */
const SAMPLE_LIMIT = 5;

export interface ErasureCounts {
    messages: number;
    conversations: number;
    interactions: number;
    dmSendLog: number;
}

const ZERO_COUNTS: ErasureCounts = { messages: 0, conversations: 0, interactions: 0, dmSendLog: 0 };

/**
 * Everything the handle resolved to.
 *
 * A person is identified three different ways in this schema and no single column holds all
 * of them: DMs key on `conversations.instagram_user_id` (the IGSID), comments key on
 * `interactions.sender_username`, and the per-recipient DM cap keys on
 * `dm_send_log.recipient_id` (an IGSID again). `conversations` is the only table carrying both
 * an IGSID and a username, so it is the bridge — resolving through it is what lets one handle
 * reach a person's comments as well as their DMs.
 */
export interface ErasureTarget {
    handle: string;
    conversationIds: string[];
    usernames: string[];
    instagramUserIds: string[];
}

/** Just enough of `pg`'s surface to run the same queries on the pool or inside a transaction. */
interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * Resolve a handle into every identifier that names the same person.
 *
 * Case-insensitive on usernames (Instagram handles are case-insensitive and the webhook stores
 * whatever Meta sent) and exact on IGSIDs, which are opaque numeric strings.
 */
export async function resolveErasureTarget(handle: string, exec: Queryable = pool): Promise<ErasureTarget> {
    const needle = handle.trim();

    const { rows } = await exec.query(
        `SELECT id, instagram_user_id, username
           FROM conversations
          WHERE instagram_user_id = $1 OR lower(username) = lower($1)`,
        [needle]
    );

    const usernames = new Set<string>([needle.toLowerCase()]);
    const instagramUserIds = new Set<string>([needle]);
    const conversationIds: string[] = [];

    for (const row of rows) {
        conversationIds.push(row.id);
        if (row.instagram_user_id) instagramUserIds.add(row.instagram_user_id);
        if (row.username) usernames.add(String(row.username).toLowerCase());
    }

    return {
        handle: needle,
        conversationIds,
        usernames: [...usernames],
        instagramUserIds: [...instagramUserIds],
    };
}

/** What would be deleted, counted. Writes nothing. */
export async function countErasure(target: ErasureTarget, exec: Queryable = pool): Promise<ErasureCounts> {
    const row = await exec.query(
        `SELECT
             (SELECT COUNT(*) FROM messages      WHERE conversation_id = ANY($1::uuid[]))::int AS messages,
             (SELECT COUNT(*) FROM conversations WHERE id = ANY($1::uuid[]))::int              AS conversations,
             (SELECT COUNT(*) FROM interactions  WHERE lower(sender_username) = ANY($2::text[]))::int AS interactions,
             (SELECT COUNT(*) FROM dm_send_log   WHERE recipient_id = ANY($3::text[]))::int    AS dm_send_log`,
        [target.conversationIds, target.usernames, target.instagramUserIds]
    );

    const r = row.rows[0];
    if (!r) return { ...ZERO_COUNTS };
    return {
        messages: r.messages ?? 0,
        conversations: r.conversations ?? 0,
        interactions: r.interactions ?? 0,
        dmSendLog: r.dm_send_log ?? 0,
    };
}

export function countsTotal(counts: ErasureCounts): number {
    return counts.messages + counts.conversations + counts.interactions + counts.dmSendLog;
}

/** Pure, so the "something changed since the preview" rule is testable. */
export function countsDrifted(expected: ErasureCounts, actual: ErasureCounts): boolean {
    return expected.messages !== actual.messages
        || expected.conversations !== actual.conversations
        || expected.interactions !== actual.interactions
        || expected.dmSendLog !== actual.dmSendLog;
}

// ─── The preview token ──────────────────────────────────────────────────────────────────

interface TokenClaims {
    /** The handle as it was previewed, verbatim. The target is re-derived from it, not trusted. */
    h: string;
    c: ErasureCounts;
    /** Unix ms. */
    exp: number;
}

/**
 * Mint a token bound to one handle and one set of counts.
 *
 * Format `<payload-b64url>.<hmac>`, signed with the session secret via
 * `signWithSessionSecret` so the key lives in exactly one module. The expiry is inside the
 * signed payload rather than beside it, so it cannot be edited.
 */
export function mintErasureToken(handle: string, counts: ErasureCounts, now = Date.now()): string {
    const claims: TokenClaims = { h: handle, c: counts, exp: now + ERASURE_TOKEN_TTL_MS };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${signWithSessionSecret(`${TOKEN_SCOPE}:${body}`)}`;
}

export type TokenFailure = 'malformed' | 'bad_signature' | 'expired';

export type VerifiedToken =
    | { ok: true; handle: string; counts: ErasureCounts; expiresAt: number }
    | { ok: false; reason: TokenFailure };

/** Verify and decode. Never throws, whatever is handed to it. */
export function verifyErasureToken(raw: unknown, now = Date.now()): VerifiedToken {
    if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };

    const parts = raw.split('.');
    if (parts.length !== 2) return { ok: false, reason: 'malformed' };

    const body = parts[0]!;
    const signature = parts[1]!;

    let expected: string;
    try {
        expected = signWithSessionSecret(`${TOKEN_SCOPE}:${body}`);
    } catch {
        // The signing secret is unavailable. Treat as invalid, never as valid — the failure
        // mode on the other side of this branch is an unauthenticated hard delete.
        return { ok: false, reason: 'bad_signature' };
    }

    try {
        if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
            return { ok: false, reason: 'bad_signature' };
        }
    } catch {
        // Malformed hex: `Buffer.from` truncates silently, so the length check has to come
        // from timingSafeEqual throwing.
        return { ok: false, reason: 'bad_signature' };
    }

    let claims: TokenClaims;
    try {
        claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed' };
    }

    if (typeof claims?.h !== 'string' || !claims.h || typeof claims?.exp !== 'number') {
        return { ok: false, reason: 'malformed' };
    }
    const c = claims.c;
    if (!c || typeof c.messages !== 'number' || typeof c.conversations !== 'number'
        || typeof c.interactions !== 'number' || typeof c.dmSendLog !== 'number') {
        return { ok: false, reason: 'malformed' };
    }
    if (now > claims.exp) return { ok: false, reason: 'expired' };

    return { ok: true, handle: claims.h, counts: c, expiresAt: claims.exp };
}

// ─── Preview ────────────────────────────────────────────────────────────────────────────

export interface ErasureSample {
    conversations: Array<{
        id: string;
        creatorId: string | null;
        creatorName: string | null;
        instagramUserId: string;
        username: string | null;
        lastMessageAt: string | null;
    }>;
    /** Metadata only — deliberately no message text. See the note at the top of this file. */
    messages: Array<{
        id: string;
        direction: string;
        messageType: string | null;
        textLength: number;
        hasRawPayload: boolean;
        createdAt: string | null;
    }>;
    interactions: Array<{
        id: string;
        commentId: string;
        postId: string;
        status: string;
        platform: string | null;
        timestamp: string | null;
    }>;
}

/**
 * One workspace (tenant) that holds rows for the handle, and how many.
 *
 * Matching is cross-tenant on purpose (`resolveErasureTarget` has no `creator_id` filter): one erasure removes the person from every
 * workspace, so the screen has to say which ones (UX audit ER-02). `rows` is every row the deletion would remove in that workspace, in
 * the same four tables `ErasureCounts` counts, so the rows of `byTenant` add up to `countsTotal(counts)`. A row that belongs to no
 * workspace at all (a legacy row from before migration v12) is grouped under `tenantId` and `name` null, not dropped.
 */
export interface ErasureTenantRows {
    tenantId: string | null;
    name: string | null;
    rows: number;
}

/** The oldest and newest timestamp among the rows of one table; null when there are none. */
export interface ErasureDateRange {
    first: string | null;
    last: string | null;
}

/**
 * First and last date per data type, over ALL the matched rows. The sample is the newest five, so its dates cannot say when the
 * oldest row is; these are MIN and MAX, which can. Dates only: nothing here is content.
 */
export type ErasureRanges = Record<keyof ErasureCounts, ErasureDateRange>;

export interface ErasurePreview {
    handle: string;
    found: boolean;
    matched: {
        conversationIds: string[];
        usernames: string[];
        instagramUserIds: string[];
    };
    counts: ErasureCounts;
    /** Rows per workspace, most first. See `ErasureTenantRows`. */
    byTenant: ErasureTenantRows[];
    ranges: ErasureRanges;
    sample: ErasureSample;
    /** Null when nothing matched — there is then nothing to authorise. */
    token: string | null;
    expiresAt: string | null;
}

const iso = (value: unknown): string | null =>
    value instanceof Date ? value.toISOString() : value == null ? null : String(value);

export async function previewErasure(handle: string): Promise<ErasurePreview> {
    const target = await resolveErasureTarget(handle);
    const counts = await countErasure(target);
    const found = countsTotal(counts) > 0;

    const [conversations, messages, interactions, tenantRows, rangeRows] = await Promise.all([
        queryRows<any>(
            `SELECT cv.id, cv.creator_id, c.name AS creator_name, cv.instagram_user_id,
                    cv.username, cv.last_message_at
               FROM conversations cv
               LEFT JOIN creators c ON c.id = cv.creator_id
              WHERE cv.id = ANY($1::uuid[])
              ORDER BY cv.last_message_at DESC NULLS LAST
              LIMIT $2`,
            [target.conversationIds, SAMPLE_LIMIT]
        ),
        queryRows<any>(
            // `char_length(text)` rather than `text`: enough for the operator to see there is
            // real content without putting it on screen.
            `SELECT id, direction, message_type,
                    char_length(COALESCE(text, ''))::int AS text_length,
                    (raw_payload IS NOT NULL) AS has_raw_payload,
                    created_at
               FROM messages
              WHERE conversation_id = ANY($1::uuid[])
              ORDER BY created_at DESC
              LIMIT $2`,
            [target.conversationIds, SAMPLE_LIMIT]
        ),
        queryRows<any>(
            `SELECT id, comment_id, post_id, status, platform, timestamp
               FROM interactions
              WHERE lower(sender_username) = ANY($1::text[])
              ORDER BY timestamp DESC
              LIMIT $2`,
            [target.usernames, SAMPLE_LIMIT]
        ),
        // Rows per workspace. The same four predicates as `countErasure` and as the deletes in `executeErasure`, grouped by the owning
        // workspace; messages take theirs from the conversation, as the delete does (`conversation_id = ANY(...)`).
        queryRows<any>(
            `SELECT t.creator_id, c.name, SUM(t.n)::int AS row_count
               FROM (
                    SELECT creator_id, COUNT(*) AS n FROM conversations
                     WHERE id = ANY($1::uuid[]) GROUP BY creator_id
                    UNION ALL
                    SELECT cv.creator_id, COUNT(*) FROM messages m
                      JOIN conversations cv ON cv.id = m.conversation_id
                     WHERE m.conversation_id = ANY($1::uuid[]) GROUP BY cv.creator_id
                    UNION ALL
                    SELECT creator_id, COUNT(*) FROM interactions
                     WHERE lower(sender_username) = ANY($2::text[]) GROUP BY creator_id
                    UNION ALL
                    SELECT creator_id, COUNT(*) FROM dm_send_log
                     WHERE recipient_id = ANY($3::text[]) GROUP BY creator_id
               ) t
               LEFT JOIN creators c ON c.id = t.creator_id
              GROUP BY t.creator_id, c.name
              ORDER BY row_count DESC, c.name NULLS LAST`,
            [target.conversationIds, target.usernames, target.instagramUserIds]
        ),
        // The oldest and newest row of each table, over everything that matched.
        queryRows<any>(
            `SELECT
                 (SELECT MIN(created_at)       FROM conversations WHERE id = ANY($1::uuid[]))                      AS conversations_first,
                 (SELECT MAX(last_message_at)  FROM conversations WHERE id = ANY($1::uuid[]))                      AS conversations_last,
                 (SELECT MIN(created_at)       FROM messages      WHERE conversation_id = ANY($1::uuid[]))         AS messages_first,
                 (SELECT MAX(created_at)       FROM messages      WHERE conversation_id = ANY($1::uuid[]))         AS messages_last,
                 (SELECT MIN(timestamp)        FROM interactions  WHERE lower(sender_username) = ANY($2::text[]))  AS interactions_first,
                 (SELECT MAX(timestamp)        FROM interactions  WHERE lower(sender_username) = ANY($2::text[]))  AS interactions_last,
                 (SELECT MIN(sent_at)          FROM dm_send_log   WHERE recipient_id = ANY($3::text[]))            AS dm_send_log_first,
                 (SELECT MAX(sent_at)          FROM dm_send_log   WHERE recipient_id = ANY($3::text[]))            AS dm_send_log_last`,
            [target.conversationIds, target.usernames, target.instagramUserIds]
        ),
    ]);
    const range = rangeRows[0] ?? {};

    const token = found ? mintErasureToken(target.handle, counts) : null;
    const verified = token ? verifyErasureToken(token) : null;

    // Not an audit row — the preview writes nothing, by contract. But an erasure request
    // arriving at all is worth a log line, because the execute that follows is irreversible.
    log('info', 'erasure.previewed', {
        handle_digest: crypto.createHash('sha256').update(target.handle).digest('hex').slice(0, 12),
        ...counts,
    });

    return {
        handle: target.handle,
        found,
        matched: {
            conversationIds: target.conversationIds,
            usernames: target.usernames,
            instagramUserIds: target.instagramUserIds,
        },
        counts,
        byTenant: tenantRows.map((r) => ({
            tenantId: r.creator_id ?? null,
            name: r.name ?? null,
            rows: Number(r.row_count) || 0,
        })),
        ranges: {
            conversations: { first: iso(range.conversations_first), last: iso(range.conversations_last) },
            messages: { first: iso(range.messages_first), last: iso(range.messages_last) },
            interactions: { first: iso(range.interactions_first), last: iso(range.interactions_last) },
            dmSendLog: { first: iso(range.dm_send_log_first), last: iso(range.dm_send_log_last) },
        },
        sample: {
            conversations: conversations.map((r) => ({
                id: r.id,
                creatorId: r.creator_id ?? null,
                creatorName: r.creator_name ?? null,
                instagramUserId: r.instagram_user_id,
                username: r.username ?? null,
                lastMessageAt: iso(r.last_message_at),
            })),
            messages: messages.map((r) => ({
                id: r.id,
                direction: r.direction,
                messageType: r.message_type ?? null,
                textLength: r.text_length ?? 0,
                hasRawPayload: Boolean(r.has_raw_payload),
                createdAt: iso(r.created_at),
            })),
            interactions: interactions.map((r) => ({
                id: r.id,
                commentId: r.comment_id,
                postId: r.post_id,
                status: r.status,
                platform: r.platform ?? null,
                timestamp: iso(r.timestamp),
            })),
        },
        token,
        expiresAt: verified?.ok ? new Date(verified.expiresAt).toISOString() : null,
    };
}

// ─── Execute ────────────────────────────────────────────────────────────────────────────

export type ErasureOutcome =
    | { ok: true; handle: string; deleted: ErasureCounts; target: ErasureTarget; client: PoolClient }
    | { ok: false; status: 400 | 409; code: 'ERASURE_TOKEN_INVALID' | 'ERASURE_PREVIEW_EXPIRED' | 'ERASURE_COUNTS_DRIFTED'; error: string;
        expected?: ErasureCounts; actual?: ErasureCounts };

/** The codes (src/services/errorCodes.ts): an expired token is the one a person can fix by pressing Preview again, so it has its own. */
const TOKEN_FAILURE_CODE: Record<TokenFailure, 'ERASURE_TOKEN_INVALID' | 'ERASURE_PREVIEW_EXPIRED'> = {
    malformed: 'ERASURE_TOKEN_INVALID',
    bad_signature: 'ERASURE_TOKEN_INVALID',
    expired: 'ERASURE_PREVIEW_EXPIRED',
};

const TOKEN_FAILURE_MESSAGE: Record<TokenFailure, string> = {
    malformed: 'That is not a valid erasure token. Run the preview again.',
    bad_signature: 'That erasure token does not verify. Run the preview again.',
    expired: 'That erasure token has expired. Run the preview again and confirm within 10 minutes.',
};

/**
 * Perform the deletion, inside one transaction, and hand the open client back to the caller.
 *
 * The client is returned still in its transaction so the caller can write the audit row on the
 * same connection before committing — an erasure whose audit row failed to land would be rows
 * gone with nothing recording who removed them, which is the one outcome worse than not
 * deleting. `commitErasure` / `rollbackErasure` close it.
 *
 * Deletion order matters only for `messages` and `conversations`: `messages.conversation_id`
 * is `ON DELETE CASCADE`, so dropping the conversation would take the messages with it — but
 * then `rowCount` would report 0 messages deleted and the returned numbers would be a lie.
 * Explicit first, so what is reported is what happened.
 */
export async function executeErasure(rawToken: unknown, now = Date.now()): Promise<ErasureOutcome> {
    const verified = verifyErasureToken(rawToken, now);
    if (!verified.ok) {
        return {
            ok: false, status: 400, code: TOKEN_FAILURE_CODE[verified.reason],
            error: TOKEN_FAILURE_MESSAGE[verified.reason],
        };
    }

    const client = await pool.connect();
    let handedOff = false;
    try {
        await client.query('BEGIN');

        // Re-derived, never taken from the token. The token authorises an erasure of a handle;
        // it does not get to declare which rows that means.
        const target = await resolveErasureTarget(verified.handle, client);
        const actual = await countErasure(target, client);

        if (countsDrifted(verified.counts, actual)) {
            await client.query('ROLLBACK');
            return {
                ok: false, status: 409, code: 'ERASURE_COUNTS_DRIFTED',
                error:
                    'What this handle matches has changed since the preview — a new message or ' +
                    'comment arrived, or part of it has already been erased. Nothing was deleted. ' +
                    'Run the preview again and review the new numbers.',
                expected: verified.counts,
                actual,
            };
        }

        const deletedMessages = await client.query(
            'DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])',
            [target.conversationIds]
        );
        // Deleting a conversation also deletes the tracked links sent in it and every click on them (migration v38: `tracked_links.conversation_id`
        // and `link_clicks.code` are ON DELETE CASCADE), in this same transaction. That is done by the schema and not by a statement here, so it
        // holds for whatever deletes a conversation, and an erasure on a database that has not had v38 applied yet still runs. The counts above
        // and the audit row name conversations, messages, interactions and the send log: a link is metadata of the conversation, not a fifth subject.
        const deletedConversations = await client.query(
            'DELETE FROM conversations WHERE id = ANY($1::uuid[])',
            [target.conversationIds]
        );
        // Worth naming: `interactions.comment_id` is UNIQUE and that constraint is the comment
        // pipeline's idempotency claim. Erasing the row gives up the claim, so if Meta
        // redelivers that same comment later — and the matching `jobs.dedupe_key` row has
        // since been pruned — the comment would be processed again and the person would get
        // another DM. There is no way to both erase someone's data and remember that we
        // already contacted them; erasure is the obligation that wins.
        const deletedInteractions = await client.query(
            'DELETE FROM interactions WHERE lower(sender_username) = ANY($1::text[])',
            [target.usernames]
        );
        const deletedSendLog = await client.query(
            'DELETE FROM dm_send_log WHERE recipient_id = ANY($1::text[])',
            [target.instagramUserIds]
        );

        handedOff = true;
        return {
            ok: true,
            handle: target.handle,
            target,
            deleted: {
                messages: deletedMessages.rowCount ?? 0,
                conversations: deletedConversations.rowCount ?? 0,
                interactions: deletedInteractions.rowCount ?? 0,
                dmSendLog: deletedSendLog.rowCount ?? 0,
            },
            client,
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        // Only release when the client is not being handed on; otherwise the caller owns it.
        if (!handedOff) client.release();
    }
}

export async function commitErasure(client: PoolClient): Promise<void> {
    try {
        await client.query('COMMIT');
    } finally {
        client.release();
    }
}

export async function rollbackErasure(client: PoolClient): Promise<void> {
    try {
        await client.query('ROLLBACK').catch(() => {});
    } finally {
        client.release();
    }
}
