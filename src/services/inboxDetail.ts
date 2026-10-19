/**
 * What the inbox shows beyond the messages themselves: who the sender is, which model answered, and whether a reply is failing.
 *
 * Everything here is READ-SIDE. It adds fields to the answers of `GET /api/conversations` and `GET /api/conversations/:id/messages` and
 * touches no sending path: the DM pipeline, the AI's replies and the AI switch are what they were.
 *
 * Where each fact comes from, and how sure it is (the dashboard words it accordingly):
 *
 *   - `ai.model`, `ai.source = 'usage'`  the `ai_usage` row of the call that wrote the reply: the model that really answered. Only the
 *     providers engine writes one (`generateDmViaLayer`); the Gemini engine's `generateAiResponse` does not. Matched by tenant, purpose `dm`,
 *     outcome `ok` and time: the newest such row that started in the three minutes before the reply was stored. There is no message id on
 *     the row, so under heavy concurrent traffic for ONE tenant the pairing is a best guess, though the model is nearly always the same.
 *   - `ai.model`, `ai.source = 'agent'`  no usage row matched, so the model the tenant's agent is set to NOW (`ai_agents.model`). That is
 *     the Gemini engine's answer, and also a providers reply that fell back to Gemini; it can differ from what answered a reply written
 *     before the setting was changed. The dashboard does not claim more than "model".
 *   - `delivery`  the queue's record of the inbound message's job (`jobs.dedupe_key = 'dm:<mid>'`) while it is failing or has failed. A
 *     PERMANENT Meta refusal (a blocked recipient, a dead token) is settled by the pipeline as handled and leaves the job `done` with no
 *     error, so it is NOT here: nothing stores it but the logs. This only ever reports what is stored.
 *
 * Every lookup is optional. A failed query (a database behind a migration, a table that is not there) is logged and the answer goes out
 * without that block; the message list is never held hostage to a nicety.
 *
 * The sales funnel's share of the list (DM plan S11): the conversation's stage, last intent and handoff columns (v39) are pinned to a type,
 * and `link_clicks` says how many times a PERSON opened the links sent in the thread (`loadLinkClicks`, the same optional kind of lookup).
 * A visit that was a link-preview crawler, a HEAD request or a prefetch (`link_clicks.is_prefetch`) is never in that count.
 */
import { queryRows } from '../db/query.js';
import type { ConversationPlatform } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import { STAGES, type Stage } from './dmSales/types.js';
import { effectiveAiOf, windowEndsAtOf, type AssistantState } from './inboxAssistant.js';

/** How far before a reply's row a usage row may have started and still be taken for the call that wrote it. */
export const USAGE_MATCH_WINDOW_SECONDS = 180;

/** The queue's dedupe key for a DM (`src/webhook/router.ts`: `dm:<mid>`). */
export const dmJobKey = (metaMessageId: string): string => `dm:${metaMessageId}`;

// ─── The conversation list's row ──────────────────────────────────────────────────────────

const nullableBool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** A picture is a link and only ever an http(s) one: the dashboard puts it in an `<img src>`, and this is the first of its two gates. */
export function profilePicOf(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    return /^https?:\/\//i.test(url) ? url : null;
}

/** A count from the database: `pg` hands `INTEGER` back as a number and `COUNT(*)` as a string. Anything else is no count. */
export function countOf(value: unknown): number | null {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** The sender's profile columns (v40) pinned to a type: null for each on a database without the migration. */
export function profileView(row: Record<string, unknown>) {
    return {
        username: typeof row.username === 'string' && row.username.trim() ? row.username : null,
        profile_name: typeof row.profile_name === 'string' && row.profile_name.trim() ? row.profile_name : null,
        profile_pic_url: profilePicOf(row.profile_pic_url),
        follower_count: countOf(row.follower_count),
        is_user_follow_business: nullableBool(row.is_user_follow_business),
        is_business_follow_user: nullableBool(row.is_business_follow_user),
        is_verified_user: nullableBool(row.is_verified_user),
        profile_fetched_at: row.profile_fetched_at ?? null,
        profile_checked_at: row.profile_checked_at ?? null,
    };
}

const isoOrNull = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value as string);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const isStage = (value: unknown): value is Stage => typeof value === 'string' && (STAGES as readonly string[]).includes(value);

/**
 * What the sales flow keeps on the conversation (v39), pinned to a type: null for each on a database that is behind, and `stage` null for
 * a value that is not one of the flow's own (the chip is drawn from a closed list, so a stranger is no chip, not a guess).
 * Timestamps go out as ISO strings, as `pg` Dates would be serialised anyway.
 */
export function salesView(row: Record<string, unknown>) {
    return {
        stage: isStage(row.stage) ? row.stage : null,
        last_intent: typeof row.last_intent === 'string' && row.last_intent ? row.last_intent : null,
        handoff_reason: typeof row.handoff_reason === 'string' && row.handoff_reason ? row.handoff_reason : null,
        handoff_at: isoOrNull(row.handoff_at),
        last_link_at: isoOrNull(row.last_link_at),
        opted_out_at: isoOrNull(row.opted_out_at),
        followups_sent: countOf(row.followups_sent),
    };
}

/**
 * The tracked links sent in a thread (`/r/:code`, DM plan S7) and what people did with them: `links` created, `clicks` by a PERSON, `last_click_at`
 * the newest of those, and `prefetch` the visits that were not a person's (a preview crawler, a HEAD request: counted so the number can be
 * shown honestly, never added to `clicks`).
 */
export interface LinkClicks {
    links: number;
    clicks: number;
    prefetch: number;
    last_click_at: string | null;
}

interface LinkClickRow {
    conversation_id: string;
    links: number | string | null;
    clicks: number | string | null;
    prefetch: number | string | null;
    last_click_at: Date | string | null;
}

/** One row per conversation that has a tracked link, for the page of conversations on screen. `$1` the tenant, `$2` the conversation ids. */
export const LINK_CLICKS_SQL = `SELECT tl.conversation_id,
       COUNT(DISTINCT tl.code)::int AS links,
       COUNT(lc.id) FILTER (WHERE NOT lc.is_prefetch)::int AS clicks,
       COUNT(lc.id) FILTER (WHERE lc.is_prefetch)::int AS prefetch,
       MAX(lc.clicked_at) FILTER (WHERE NOT lc.is_prefetch) AS last_click_at
  FROM tracked_links tl
  LEFT JOIN link_clicks lc ON lc.code = tl.code
 WHERE tl.creator_id = $1 AND tl.conversation_id = ANY($2::uuid[])
 GROUP BY tl.conversation_id`;

/**
 * The link clicks of these conversations, by conversation id. Never throws: a database without the tracked-links tables (v38), or any other
 * failure, is logged as `inbox.detail_failed` and answers an empty map, so the list simply carries no click counts.
 */
export async function loadLinkClicks(tenantId: string, conversationIds: readonly string[]): Promise<Map<string, LinkClicks>> {
    const out = new Map<string, LinkClicks>();
    if (conversationIds.length === 0) return out;
    try {
        const rows = await queryRows<LinkClickRow>(LINK_CLICKS_SQL, [tenantId, [...conversationIds]]);
        for (const row of rows) {
            out.set(String(row.conversation_id), {
                links: countOf(row.links) ?? 0,
                clicks: countOf(row.clicks) ?? 0,
                prefetch: countOf(row.prefetch) ?? 0,
                last_click_at: isoOrNull(row.last_click_at),
            });
        }
    } catch (err) {
        log('warn', 'inbox.detail_failed', { what: 'link_clicks', tenant_id: tenantId, ...describeError(err) });
    }
    return out;
}

/**
 * One conversation as the inbox reads it. The row is passed through (`c.*` has always been the answer) and the fields this release added are
 * pinned to a type, so a database without v40 answers null for each and the dashboard reads one shape before and after the migration.
 *
 * `platform` is the caller's: `conversationPlatformOf` lives with the route.
 *
 * UX US1 adds three fields (contracts/api.md, "Conversations"):
 *   - `handled_at`      the owner's "Mark handled" stamp (v45), or null: also null on a database that is behind, and ISO, like every stamp here;
 *   - `window_ends_at`  when Meta's 24 h reply window closes (the customer's last message + 24 h), or null when they have not written;
 *   - `effective_ai`    who would answer this thread's next message (`effectiveAiOf`): the assistant's global switch, then the thread's own,
 *                       then the sales mode. `assistant` is what `loadAssistantState` read, or null when it could not be: then only the
 *                       thread's own switch can be said and the answer is never "off".
 */
export function conversationView<T extends Record<string, unknown>>(
    row: T,
    platform: ConversationPlatform | null,
    clicks?: LinkClicks | null,
    assistant: AssistantState | null = null
) {
    return {
        ...row,
        platform,
        ...profileView(row),
        ...salesView(row),
        handled_at: isoOrNull(row.handled_at),
        window_ends_at: windowEndsAtOf(row),
        effective_ai: effectiveAiOf(row, assistant),
        link_clicks: clicks ?? null,
        message_count: countOf(row.message_count),
        // What the list's preview needs of the newest message, beyond its text (see `GET /conversations`).
        last_message_type: typeof row.last_message_type === 'string' ? row.last_message_type : null,
        last_message_cards: countOf(row.last_message_cards),
        last_message_card_title: typeof row.last_message_card_title === 'string' && row.last_message_card_title ? row.last_message_card_title : null,
    };
}

// ─── The message log's extras ─────────────────────────────────────────────────────────────

export interface UsageMatch {
    message_id: string;
    model: string;
    provider: string | null;
}

export interface JobFacts {
    dedupe_key: string;
    status: string;
    attempts: number | null;
    max_attempts: number | null;
    last_error: string | null;
}

export interface MessageExtras {
    /** Reply row id → the usage row that wrote it. */
    usage: readonly UsageMatch[];
    /** `ai_agents.model` now, or null for a tenant with no agent. */
    agentModel: string | null;
    /** Jobs that are failing or failed, for the inbound messages on screen. */
    jobs: readonly JobFacts[];
}

export const NO_EXTRAS: MessageExtras = { usage: [], agentModel: null, jobs: [] };

/** The code in `metaFailure`'s wording, "… (Code: 10903)". `N/A` is no code. */
export function metaCodeOf(error: unknown): number | null {
    if (typeof error !== 'string') return null;
    const match = /\(Code:\s*(\d{1,6})\)/.exec(error);
    return match ? Number(match[1]) : null;
}

export interface DeliveryFacts {
    /** `failed`: the job is out of attempts. `retrying`: it has failed at least once and will be tried again. */
    state: 'failed' | 'retrying';
    /** Meta's error code when the last error carried one. */
    code: number | null;
    attempts: number | null;
    max_attempts: number | null;
}

/** What a queue row says about one inbound message's reply; null when it says nothing is wrong. Pure. */
export function deliveryOf(job: JobFacts | undefined): DeliveryFacts | null {
    if (!job) return null;
    const failed = job.status === 'failed';
    const retrying = (job.status === 'pending' || job.status === 'running') && Boolean(job.last_error);
    if (!failed && !retrying) return null;
    return {
        state: failed ? 'failed' : 'retrying',
        code: metaCodeOf(job.last_error),
        attempts: countOf(job.attempts),
        max_attempts: countOf(job.max_attempts),
    };
}

interface MessageLike {
    id?: unknown;
    direction?: unknown;
    sender?: unknown;
    meta_message_id?: unknown;
}

/** What `annotateMessages` adds. Both blocks are always present, null when there is nothing to say. */
export interface MessageAnnotation {
    ai: { model: string; provider: string | null; source: 'usage' | 'agent' } | null;
    delivery: DeliveryFacts | null;
}

/**
 * Add `ai` to the AI's replies and `delivery` to the customer's messages. Pure: the rows and the facts in, the rows out, in the same order.
 * Every other row gets both blocks as null, so the dashboard reads one shape.
 */
export function annotateMessages<T extends MessageLike>(rows: readonly T[], extras: MessageExtras): Array<T & MessageAnnotation> {
    const usage = new Map(extras.usage.map((u) => [String(u.message_id), u]));
    const jobs = new Map(extras.jobs.map((j) => [j.dedupe_key, j]));
    return rows.map((row) => {
        let ai: MessageAnnotation['ai'] = null;
        if (row.direction === 'outbound' && row.sender === 'ai') {
            const matched = usage.get(String(row.id));
            if (matched && matched.model) ai = { model: matched.model, provider: matched.provider ?? null, source: 'usage' };
            else if (extras.agentModel) ai = { model: extras.agentModel, provider: null, source: 'agent' };
        }
        let delivery: DeliveryFacts | null = null;
        if (row.direction === 'inbound' && typeof row.meta_message_id === 'string' && row.meta_message_id) {
            delivery = deliveryOf(jobs.get(dmJobKey(row.meta_message_id)));
        }
        return { ...row, ai, delivery };
    });
}

/**
 * The three optional lookups behind `annotateMessages`, in parallel. Never throws: each failure is logged as `inbox.detail_failed` and that
 * block is simply empty.
 */
export async function loadMessageExtras(tenantId: string, rows: readonly MessageLike[]): Promise<MessageExtras> {
    const aiIds = rows.filter((r) => r.direction === 'outbound' && r.sender === 'ai').map((r) => String(r.id));
    const jobKeys = rows
        .filter((r) => r.direction === 'inbound' && typeof r.meta_message_id === 'string' && r.meta_message_id)
        .map((r) => dmJobKey(String(r.meta_message_id)));

    const guarded = async <T>(what: string, run: () => Promise<T>, empty: T): Promise<T> => {
        try {
            return await run();
        } catch (err) {
            log('warn', 'inbox.detail_failed', { what, tenant_id: tenantId, ...describeError(err) });
            return empty;
        }
    };

    const [usage, agentModel, jobs] = await Promise.all([
        aiIds.length === 0 ? Promise.resolve([] as UsageMatch[]) : guarded('usage', () => queryRows<UsageMatch>(
            `SELECT DISTINCT ON (m.id) m.id AS message_id, u.model, u.provider
               FROM messages m
               JOIN ai_usage u
                 ON u.creator_id = $2 AND u.purpose = 'dm' AND u.outcome = 'ok'
                AND u.at <= m.created_at AND u.at >= m.created_at - make_interval(secs => $3::float8)
              WHERE m.id = ANY($1::uuid[])
              ORDER BY m.id, u.at DESC`,
            [aiIds, tenantId, USAGE_MATCH_WINDOW_SECONDS]
        ), [] as UsageMatch[]),
        aiIds.length === 0 ? Promise.resolve(null) : guarded('agent', async () => {
            const [row] = await queryRows<{ model: string | null }>('SELECT model FROM ai_agents WHERE creator_id = $1', [tenantId]);
            return typeof row?.model === 'string' && row.model ? row.model : null;
        }, null),
        jobKeys.length === 0 ? Promise.resolve([] as JobFacts[]) : guarded('jobs', () => queryRows<JobFacts>(
            `SELECT dedupe_key, status, attempts, max_attempts, last_error
               FROM jobs
              WHERE dedupe_key = ANY($1::text[]) AND status IN ('failed', 'pending', 'running')`,
            [jobKeys]
        ), [] as JobFacts[]),
    ]);
    return { usage, agentModel, jobs };
}
