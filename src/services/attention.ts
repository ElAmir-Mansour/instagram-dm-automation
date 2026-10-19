/**
 * "What needs me?": the server half of the dashboard's attention model (UX overhaul, research R-02, data-model "AttentionItem").
 *
 * The rules a thread, a post or a connection must meet to need the owner are written once, here and in `dashboard/js/attention.js`
 * (a later change), instead of three diverging copies on Overview, the nav badge and the Inbox count line (audit OV-02, IN-03). This
 * module answers for the whole tenant from a handful of aggregate queries, so every page can show a count without loading the page's
 * own data. `GET /api/attention` is its only caller.
 *
 * What this never does:
 *   - **Call Meta, TikTok or Google.** Every number is read from a column. `GET /settings/token/status` is the deliberate, live check;
 *     a connection is "broken" here because the token status STORED the last time something looked says so (audit OV-08).
 *   - **Count what is not the owner's to do.** An archived post (`scheduled_posts.archived_at`), a handled conversation
 *     (`conversations.handled_at`), a designed skip (`src/services/outcomes.ts`) and a tenant with nothing connected yet (which gets the
 *     Get-started panel instead) produce no item and no count.
 *   - **Say "all clear" when it could not look.** A query that fails fails the whole summary: a half-answer reads as "nothing needs you".
 *
 * Implemented here: the heartbeat; `handoff`, `post_failed`, `post_overdue` and `connection_broken` items; the Inbox's "waiting" count.
 * The other item types of `AttentionType` (`webhook_silent`, `hot_lead`, `window_closing`, `tiktok_draft`, `reel_review`,
 * `worker_offline`, `connection_expiring`, `timezone_unset`, `platform`) belong to later changes, and `counts.studio` stays 0 until
 * `reel_review` exists to fill it.
 *
 * The thread rules mirror `Inbox.isWaiting` / `Inbox.isNeedsYou` (dashboard/js/pages/inbox.js) clause for clause, and a thread that is
 * both counts once, as a handoff: the Inbox's `needsHuman` is the union of the two, and the nav badge is its size.
 */
import { queryRows } from '../db/query.js';
import { getQueueHealth, getSchemaState, getTenantHealth, toIso } from './health.js';
import { workerSummary } from './studio/worker.js';

/** What the route says when a statement fails because migration v45 is not applied yet (`archived_at`, `handled_at`). */
export const ATTENTION_MIGRATION_HINT =
    'The database is missing migration v45 (src/config/migration_v45_ux_archive_handled.sql). '
    + 'Apply it with `npm run migrate`, then reload.';

// ─── Types ───────────────────────────────────────────────────────────────────────────────────

export type AttentionType =
    | 'webhook_silent' | 'handoff' | 'hot_lead' | 'window_closing' | 'post_failed' | 'tiktok_draft'
    | 'post_overdue' | 'reel_review' | 'worker_offline' | 'connection_expiring' | 'connection_broken'
    | 'timezone_unset' | 'platform';

export type AttentionSeverity = 'danger' | 'warning' | 'info';

/** An i18n key and the values to put in it. The server never sends text, so a sentence is translated and bidi-isolated by the client. */
export interface AttentionSentence {
    key: string;
    params: Record<string, string | number>;
}

export interface AttentionItem {
    type: AttentionType;
    severity: AttentionSeverity;
    /** ≥ 1. Threads for `handoff`, posts for `post_*` (a post on several platforms is one), 1 for a connection. */
    count: number;
    sentence: AttentionSentence;
    /** Exactly one: a verb (an i18n key) and where it goes. */
    action: { verb: string; href: string };
    /** When the oldest thing behind this item started waiting: "oldest waited ...", and the sort key within a severity. */
    oldestAt?: string;
}

export interface Heartbeat {
    /** The newest comment that matched a campaign. A comment that matches nothing writes no row, so this is NOT "the last comment Meta sent". */
    lastCommentAt: string | null;
    /** The newest inbound DM. */
    lastDmAt: string | null;
    /**
     * The newest inbound signal of any kind, including a delivery that matched no campaign (a `jobs` row). The honest "is Meta still
     * calling us" answer (`health.ts`): silence in `lastCommentAt` with a recent value here means keywords, not delivery. Additive to the contract.
     */
    lastWebhookAt: string | null;
    queue: { pending: number; oldestPendingAt: string | null; failed: number };
    /** `lastSeenAt: null` is a tenant that never registered a worker. */
    worker: { online: boolean; lastSeenAt: string | null };
}

export interface AttentionCounts {
    inbox: number;
    /** 0 until `reel_review` and failed renders are counted (a later change). */
    studio: number;
    scheduler: number;
    /** Present for platform admins only. */
    platform?: number;
}

export interface AttentionSummary {
    checkedAt: string;
    heartbeat: Heartbeat;
    items: AttentionItem[];
    counts: AttentionCounts;
}

// ─── Rules ───────────────────────────────────────────────────────────────────────────────────

/** A post still `PENDING` this long after its time is overdue: the sweeps run every few minutes, so less than this is just waiting for the next one. */
export const OVERDUE_GRACE_MINUTES = 15;

/** Where each item sends the owner. The deep-link targets are specs/001-dashboard-ux tasks T071. */
const HREF = {
    inboxTodo: '#/inbox?filter=todo',
    postsNeedsYou: '#/posts?filter=needs-you',
    settings: (section: string) => `#/settings?s=${section}`,
} as const;

const SEVERITY_RANK: Record<AttentionSeverity, number> = { danger: 0, warning: 1, info: 2 };

// ─── Facts: what the queries return ──────────────────────────────────────────────────────────

export interface WaitingFact {
    count: number;
    /** When the oldest of them started waiting (ISO). */
    oldestAt: string | null;
}

export interface HandoffFact extends WaitingFact {
    /** How many of the handed-over threads carry each reason, `none` and blank left out. */
    reasons: Array<{ reason: string; count: number }>;
}

export type ConnectionIntegration = 'meta' | 'tiktok' | 'youtube';

export interface ConnectionFact {
    integration: ConnectionIntegration;
    /** Stored status says it no longer works. Never the result of a live call. */
    broken: boolean;
    /** When that status was last written (ISO), or null. */
    at: string | null;
}

/** Everything `buildAttention` needs, already counted. */
export interface AttentionFacts {
    handoff: HandoffFact;
    waiting: WaitingFact;
    postsFailed: WaitingFact;
    postsOverdue: WaitingFact;
    /** One row per connected integration, broken or not. Empty: nothing is connected yet. */
    connections: ConnectionFact[];
}

/** The reason most of the handed-over threads carry, ties broken by name so the answer is the same every time. null when none names one. */
export function dominantReason(reasons: ReadonlyArray<{ reason: string; count: number }>): string | null {
    let best: { reason: string; count: number } | null = null;
    for (const r of reasons) {
        if (!r.reason || r.reason === 'none' || r.count <= 0) continue;
        if (!best || r.count > best.count || (r.count === best.count && r.reason < best.reason)) best = r;
    }
    return best ? best.reason : null;
}

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Severity first, then the one that has waited longest; an item with no date after the dated ones; then by type, so the order is total. */
export function compareItems(a: AttentionItem, b: AttentionItem): number {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const ta = time(a.oldestAt);
    const tb = time(b.oldestAt);
    const aDated = Number.isFinite(ta);
    const bDated = Number.isFinite(tb);
    if (aDated && bDated && ta !== tb) return ta - tb;
    if (aDated !== bDated) return aDated ? -1 : 1;
    return a.type.localeCompare(b.type) || JSON.stringify(a.sentence.params).localeCompare(JSON.stringify(b.sentence.params));
}

function dated<T extends object>(item: T, oldestAt: string | null): T & { oldestAt?: string } {
    return oldestAt ? { ...item, oldestAt } : item;
}

/**
 * Items and nav counts from the facts. Pure.
 *
 * A tenant with no connection yet gets nothing at all: it has the Get-started panel, and a count beside a screen it cannot use yet
 * would be noise. (Whatever it holds could only be left over from before.)
 */
export function buildAttention(facts: AttentionFacts): { items: AttentionItem[]; counts: Omit<AttentionCounts, 'platform'> } {
    if (facts.connections.length === 0) return { items: [], counts: { inbox: 0, studio: 0, scheduler: 0 } };

    const items: AttentionItem[] = [];

    if (facts.handoff.count > 0) {
        const reason = dominantReason(facts.handoff.reasons);
        const params: Record<string, string | number> = { n: facts.handoff.count };
        if (reason) params.reason = reason;
        items.push(dated({
            type: 'handoff', severity: 'warning', count: facts.handoff.count,
            sentence: { key: 'attention.handoff', params },
            action: { verb: 'attention.verb.reply', href: HREF.inboxTodo },
        }, facts.handoff.oldestAt));
    }

    if (facts.postsFailed.count > 0) {
        items.push(dated({
            type: 'post_failed', severity: 'danger', count: facts.postsFailed.count,
            sentence: { key: 'attention.post_failed', params: { n: facts.postsFailed.count } },
            action: { verb: 'attention.verb.review', href: HREF.postsNeedsYou },
        }, facts.postsFailed.oldestAt));
    }

    if (facts.postsOverdue.count > 0) {
        items.push(dated({
            type: 'post_overdue', severity: 'warning', count: facts.postsOverdue.count,
            sentence: { key: 'attention.post_overdue', params: { n: facts.postsOverdue.count, minutes: OVERDUE_GRACE_MINUTES } },
            action: { verb: 'attention.verb.review', href: HREF.postsNeedsYou },
        }, facts.postsOverdue.oldestAt));
    }

    // One item per integration, not one for all of them: each is fixed in its own place, and "TikTok needs reconnecting" is an action.
    for (const connection of facts.connections) {
        if (!connection.broken) continue;
        items.push(dated({
            type: 'connection_broken', severity: 'danger', count: 1,
            sentence: { key: 'attention.connection_broken', params: { platform: connection.integration } },
            action: { verb: 'attention.verb.reconnect', href: HREF.settings(connection.integration) },
        }, connection.at));
    }

    items.sort(compareItems);

    return {
        items,
        counts: {
            // Threads that need a person, each once: handed over, or waiting for a reply.
            inbox: facts.handoff.count + facts.waiting.count,
            studio: 0,
            scheduler: facts.postsFailed.count + facts.postsOverdue.count,
        },
    };
}

// ─── Queries ─────────────────────────────────────────────────────────────────────────────────

/**
 * Threads that need a person, by kind and (for a handoff) reason. `$1` is the tenant.
 *
 * Aggregated in SQL, one row per (kind, reason), so what crosses the wire is a handful of rows however many threads there are.
 *
 *   - `handled_at IS NULL`: "Mark handled" is the way out of To do, and a new inbound message clears it again.
 *   - `handoff`: stage 'handoff', and no operator reply at or after `handoff_at` (a reply from here or from the Instagram app ends it;
 *     a null `handoff_at` is never "answered"): `Inbox.isNeedsYou`.
 *   - `waiting`: the bot is off for the thread and the newest message is the customer's: `Inbox.isWaiting`. Only reached when the thread
 *     is not already a handoff, so it counts once.
 *   - The WHERE clause is a superset of both (a handoff stage, or a bot that is off), so the two laterals run over the few threads that
 *     could qualify and not every thread the tenant has ever had.
 *   - `since` is when the wait started: the handoff, or the customer's last message.
 */
export const THREADS_ATTENTION_SQL = `
    SELECT t.kind, t.reason, COUNT(*)::int AS n, MIN(t.since) AS oldest_at
      FROM (
          SELECT
              CASE
                  WHEN c.stage = 'handoff'
                   AND NOT (c.handoff_at IS NOT NULL AND fx.last_operator_at IS NOT NULL AND fx.last_operator_at >= c.handoff_at)
                      THEN 'handoff'
                  WHEN c.is_bot_active = false AND lm.direction = 'inbound'
                      THEN 'waiting'
              END AS kind,
              CASE WHEN c.stage = 'handoff' THEN c.handoff_reason END AS reason,
              CASE WHEN c.stage = 'handoff' THEN COALESCE(c.handoff_at, lm.created_at) ELSE lm.created_at END AS since
            FROM conversations c
            LEFT JOIN LATERAL (
                SELECT m.direction, m.created_at
                  FROM messages m
                 WHERE m.conversation_id = c.id
                 ORDER BY m.created_at DESC
                 LIMIT 1
            ) lm ON TRUE
            LEFT JOIN LATERAL (
                SELECT MAX(m3.created_at) AS last_operator_at
                  FROM messages m3
                 WHERE m3.conversation_id = c.id AND m3.direction = 'outbound' AND m3.sender = 'operator'
            ) fx ON TRUE
           WHERE c.creator_id = $1
             AND c.handled_at IS NULL
             AND (c.stage = 'handoff' OR c.is_bot_active = false)
      ) t
     WHERE t.kind IS NOT NULL
     GROUP BY t.kind, t.reason
`;

/**
 * Failed and overdue posts, counted as the owner sees them: a post that went to several platforms is one (`group_id`, else the row).
 * `$1` is the tenant, `$2` the grace in minutes.
 *
 * `archived_at IS NULL` is the way out of this count (Archive). Every FAILED post is a real failure and so actionable: the designed
 * holds (a TikTok inbox that is full, an Instagram reel still processing) are written back as PENDING, not FAILED. Those are overdue
 * only once they are late, which is what the grace is for.
 */
export const POSTS_ATTENTION_SQL = `
    SELECT
        COUNT(DISTINCT COALESCE(s.group_id, s.id)) FILTER (WHERE s.status = 'FAILED')::int AS failed,
        MIN(s.scheduled_time) FILTER (WHERE s.status = 'FAILED') AS failed_oldest_at,
        COUNT(DISTINCT COALESCE(s.group_id, s.id))
            FILTER (WHERE s.status = 'PENDING' AND s.scheduled_time < NOW() - make_interval(mins => $2))::int AS overdue,
        MIN(s.scheduled_time)
            FILTER (WHERE s.status = 'PENDING' AND s.scheduled_time < NOW() - make_interval(mins => $2)) AS overdue_oldest_at
      FROM scheduled_posts s
     WHERE s.creator_id = $1
       AND s.archived_at IS NULL
       AND s.status IN ('FAILED', 'PENDING')
`;

/**
 * One row per integration this tenant has connected, and whether its STORED status says it is broken. `$1` is the tenant.
 * Meta counts as connected only with a token (a tenant created by name has none, v34); a TikTok or YouTube connection is a row.
 * Reads columns only: `creators.token_status` is written by whatever last checked the token, `platform_connections.status` by the
 * refresh and the revoke paths.
 */
export const CONNECTIONS_ATTENTION_SQL = `
    SELECT 'meta' AS integration, (c.token_status = 'invalid') AS broken, c.token_last_checked_at AS at
      FROM creators c
     WHERE c.id = $1 AND c.page_access_token IS NOT NULL
    UNION ALL
    SELECT pc.platform AS integration, (pc.status IN ('invalid', 'revoked')) AS broken, pc.updated_at AS at
      FROM platform_connections pc
     WHERE pc.creator_id = $1
`;

interface ThreadRow { kind: 'handoff' | 'waiting'; reason: string | null; n: number; oldest_at: Date | null }

function threadFacts(rows: readonly ThreadRow[]): { handoff: HandoffFact; waiting: WaitingFact } {
    const handoff: HandoffFact = { count: 0, oldestAt: null, reasons: [] };
    const waiting: WaitingFact = { count: 0, oldestAt: null };
    const older = (current: string | null, next: Date | null): string | null => {
        const iso = toIso(next);
        return iso && (!current || Date.parse(iso) < Date.parse(current)) ? iso : current;
    };
    for (const row of rows) {
        const n = Number(row.n) || 0;
        if (n <= 0) continue;
        if (row.kind === 'handoff') {
            handoff.count += n;
            handoff.oldestAt = older(handoff.oldestAt, row.oldest_at);
            if (row.reason) handoff.reasons.push({ reason: row.reason, count: n });
        } else if (row.kind === 'waiting') {
            waiting.count += n;
            waiting.oldestAt = older(waiting.oldestAt, row.oldest_at);
        }
    }
    return { handoff, waiting };
}

async function loadThreads(creatorId: string) {
    return threadFacts(await queryRows<ThreadRow>(THREADS_ATTENTION_SQL, [creatorId]));
}

async function loadPosts(creatorId: string): Promise<{ postsFailed: WaitingFact; postsOverdue: WaitingFact }> {
    const [row] = await queryRows<{ failed: number; failed_oldest_at: Date | null; overdue: number; overdue_oldest_at: Date | null }>(
        POSTS_ATTENTION_SQL, [creatorId, OVERDUE_GRACE_MINUTES]
    );
    return {
        postsFailed: { count: Number(row?.failed) || 0, oldestAt: toIso(row?.failed_oldest_at) },
        postsOverdue: { count: Number(row?.overdue) || 0, oldestAt: toIso(row?.overdue_oldest_at) },
    };
}

const INTEGRATIONS: ReadonlySet<string> = new Set<ConnectionIntegration>(['meta', 'tiktok', 'youtube']);

async function loadConnections(creatorId: string): Promise<ConnectionFact[]> {
    const rows = await queryRows<{ integration: string; broken: boolean | null; at: Date | null }>(CONNECTIONS_ATTENTION_SQL, [creatorId]);
    return rows
        .filter((row) => INTEGRATIONS.has(row.integration))
        .map((row) => ({ integration: row.integration as ConnectionIntegration, broken: row.broken === true, at: toIso(row.at) }));
}

async function loadHeartbeat(creatorId: string, now: number): Promise<Heartbeat> {
    const [health, worker] = await Promise.all([getTenantHealth(creatorId), workerSummary(creatorId, now)]);
    return {
        lastCommentAt: health?.lastCommentAt ?? null,
        lastDmAt: health?.lastInboundDmAt ?? null,
        lastWebhookAt: health?.lastWebhookAt ?? null,
        queue: {
            pending: health?.queue.pending ?? 0,
            oldestPendingAt: health?.queue.oldestPendingAt ?? null,
            failed: health?.queue.failed ?? 0,
        },
        worker: { online: worker.online, lastSeenAt: worker.lastSeen },
    };
}

/**
 * How many platform-wide problems there are, for the Platform nav entry (platform admins only). Two signals that exist today and are
 * unambiguous: an invocation died holding a job claim (`queue.stale`), and the database is behind this build (`schema.pending`, the same
 * ledger `GET /admin/ops` shows). Each counts once however large. The verdict that names more of them (R-17) extends this.
 */
export async function countPlatformProblems(): Promise<number> {
    const [queue, schema] = await Promise.all([getQueueHealth(), getSchemaState()]);
    return (queue.stale > 0 ? 1 : 0) + (schema.pending.length > 0 ? 1 : 0);
}

export interface AttentionOptions {
    /** Adds `counts.platform`. The caller decides this from the session; nothing here knows who is asking. */
    platformAdmin?: boolean;
    /** The clock, in ms: `checkedAt` and whether the worker counts as online. Defaults to now; a test passes one. */
    now?: number;
}

/**
 * The attention summary for one tenant. Every query is an aggregate over a column, none leaves the database, and they run together.
 * Any failure rejects: see the header for why a partial answer is worse than none.
 */
export async function getAttention(creatorId: string, options: AttentionOptions = {}): Promise<AttentionSummary> {
    const now = options.now ?? Date.now();
    const [heartbeat, threads, posts, connections, platform] = await Promise.all([
        loadHeartbeat(creatorId, now),
        loadThreads(creatorId),
        loadPosts(creatorId),
        loadConnections(creatorId),
        options.platformAdmin ? countPlatformProblems() : Promise.resolve(undefined),
    ]);

    const { items, counts } = buildAttention({ ...threads, ...posts, connections });

    return {
        checkedAt: new Date(now).toISOString(),
        heartbeat,
        items,
        counts: platform === undefined ? counts : { ...counts, platform },
    };
}
