/**
 * The DM sales funnel (docs/DM_SALES_PLAN.md §1 and §9, S12): how far the people who wrote to a tenant got, over the last 7, 30 or 90 days,
 * for the card on the inbox page. `GET /api/dm/funnel?days=`.
 *
 * Counts and rates only: no conversation id, name, handle or message leaves this module.
 *
 * ─── What is counted ──────────────────────────────────────────────────────────────────────────────────────
 *
 * **The cohort** is the conversations whose FIRST message from the customer falls inside the window. A person counts in the window they
 * started in, however long they then took, so a rate never mixes people who began at different times. A conversation row that has no
 * message from the customer (a private reply the comment path may one day write before they answer) is not a conversation here.
 *
 * **A step is "reached at least"**, so the five counts only ever fall from one step to the next. The conversation row keeps only where it is
 * NOW (`stage`), and a conversation that went recommend, objection, handoff is "handoff" at the end; so what was reached is read from
 * everything that remembers it, and any one of them is enough:
 *
 *   - the current `stage`;
 *   - the stage after every bot reply (`messages.ai_meta.stage`, written with each reply: the stages a conversation has been through);
 *   - the columns that only a step sets: `qualifier_turns` (a qualifying question was asked), `offers_linked` / `last_link_at` (a link
 *     went out: they are written in the same statement as the reply that carried it, so a send that failed leaves them alone),
 *     `followups_sent`, `handoff_at`, `opted_out_at`.
 *
 * The steps, each implying the one before it:
 *
 *   conversations   every conversation in the cohort
 *   qualified       reached `qualify`, or asked a qualifying question, or any step below
 *   recommended     reached `recommend` (an `objection` is a reaction to an offer, so it counts) or any step below
 *   link_sent       a link went out, or the stage is `link` / `follow_up` (both are only ever set after one)
 *   clicked         a link was sent AND a PERSON opened it: a click whose `is_prefetch` is FALSE. A HEAD request, a link-preview crawler or
 *                   a speculative load is not a click. The rule is HERE and not in SQL: the statement hands back the clicks grouped by
 *                   `is_prefetch`, so what counts is one readable line (`humanClicks`) with a test that fails when a prefetch is counted.
 *
 * **Outcomes** are counted beside the steps, not in them, because they can happen at any step and a handoff is not "further" than a click:
 * `follow_up` (the one nudge was sent), `handoff` (a person was asked to take over), `closed` (reached `closed`, or opted out), `opted_out`
 * (asked to be left alone) and `complaints` (a handoff for a complaint).
 *
 * **The rates** are the plan's §1, each with its numerator and denominator so a small sample reads as the small sample it is:
 *   link      link_sent / recommended         (target ≥ 60%)
 *   click     clicked / link_sent             (a baseline for 30 days, then a target)
 *   handoff   handoff / conversations         (target < 15%)
 *   opt_out   opted_out / conversations       (watched: rising means the tone is wrong)
 *
 * **Reply time** is NOT per conversation: it is every customer message in the window (in any of the tenant's conversations) and the bot's
 * next reply to it, p50 and p90 (§1: p50 < 10 s, p90 < 20 s). The "next reply" is the next outbound message of any kind; it counts only when
 * the bot wrote it, so a message the owner answered by hand is the owner's time and not the bot's, and the follow-up nudge (hours later,
 * on purpose) is not a reply. The first message of a burst waits for the one answer that covers them all, which is what it really waited.
 *
 * **The A/B comparison** (S14, `dmVariantFunnel.ts`) is a section beside these numbers, present only when the tenant has an experiment or a conversation
 * that was given an arm: each arm's conversations, how many were recommended, sent the link and clicked it, and the link and click rates, with no
 * percentage below a minimum sample. It reads the arm from `conversations.sales_variant` (v42) in a statement of its own, so a database that is behind
 * costs the funnel this section and nothing else.
 *
 * The aggregation (`buildDmFunnel`) is pure and tested from fixture rows by hand; `loadDmFunnel` is the three statements that feed it.
 * Every statement binds the TENANT as `$1`.
 */
import { queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { buildVariantBreakdown, type DmVariantBreakdown, type VariantFact } from './dmVariantFunnel.js';
import { readVariantConfig } from './dmSales/variantStore.js';
import type { VariantConfig } from './dmSales/variants.js';

export const DM_FUNNEL_WINDOWS = [7, 30, 90] as const;
export type DmFunnelWindow = (typeof DM_FUNNEL_WINDOWS)[number];
export const DEFAULT_DM_FUNNEL_WINDOW: DmFunnelWindow = 30;

/** `?days=` as a window, the default for none, null for anything else (including a list or an object, which a query string can hold). */
export function parseDmFunnelWindow(raw: unknown): DmFunnelWindow | null {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_DM_FUNNEL_WINDOW;
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const n = Number(raw);
    return (DM_FUNNEL_WINDOWS as readonly number[]).includes(n) ? (n as DmFunnelWindow) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── The three statements ($1 the tenant, $2 the start of the window) ────────────────────────────────────

/** When the customer first wrote in a conversation: the moment it enters the funnel. */
const FIRST_INBOUND_SQL = `(SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound')`;

/** One row per conversation in the cohort, with the facts `reachedOf` reads. */
export const DM_FUNNEL_CONVERSATIONS_SQL = `SELECT c.id, c.stage, c.qualifier_turns,
       COALESCE(cardinality(c.offers_linked), 0)::int AS links_sent,
       c.last_link_at, c.followups_sent, c.handoff_at, c.handoff_reason, c.opted_out_at,
       ARRAY(SELECT DISTINCT m.ai_meta ->> 'stage' FROM messages m
              WHERE m.conversation_id = c.id AND m.ai_meta ->> 'stage' IS NOT NULL) AS stages_seen
  FROM conversations c
 WHERE c.creator_id = $1
   AND ${FIRST_INBOUND_SQL} >= $2`;

/**
 * The clicks on the cohort's tracked links, grouped by conversation and by whether it was a person: a few rows however many times a link
 * was opened. Whether a prefetch counts is decided in `buildDmFunnel`, not here.
 */
export const DM_FUNNEL_CLICKS_SQL = `SELECT tl.conversation_id, lc.is_prefetch, COUNT(*)::int AS n
  FROM tracked_links tl
  JOIN link_clicks lc ON lc.code = tl.code
 WHERE tl.creator_id = $1
   AND tl.conversation_id IN (SELECT c.id FROM conversations c WHERE c.creator_id = $1 AND ${FIRST_INBOUND_SQL} >= $2)
 GROUP BY tl.conversation_id, lc.is_prefetch`;

/** How long the bot took to answer each customer message in the window: how many were answered, and the p50 and p90 in milliseconds. */
export const DM_FUNNEL_REPLY_SQL = `SELECT COUNT(*)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ms) AS p50_ms,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY r.ms) AS p90_ms
  FROM (
        SELECT EXTRACT(EPOCH FROM (nx.created_at - i.created_at)) * 1000 AS ms
          FROM messages i
          JOIN conversations c ON c.id = i.conversation_id AND c.creator_id = $1
          JOIN LATERAL (
                SELECT o.created_at, o.sender
                  FROM messages o
                 WHERE o.conversation_id = i.conversation_id AND o.direction = 'outbound' AND o.created_at > i.created_at
                   AND COALESCE(o.ai_meta ->> 'kind', '') <> 'followup'
                 ORDER BY o.created_at ASC
                 LIMIT 1
          ) nx ON nx.sender = 'ai'
         WHERE i.direction = 'inbound' AND i.created_at >= $2
       ) r`;

/** The cohort's conversations that were given an A/B arm (v42), with it: a separate statement, so the funnel does not depend on the column. */
export const DM_FUNNEL_VARIANTS_SQL = `SELECT c.id, c.sales_variant
  FROM conversations c
 WHERE c.creator_id = $1
   AND c.sales_variant IS NOT NULL
   AND ${FIRST_INBOUND_SQL} >= $2`;

export interface ConversationFact {
    id: string;
    stage: string | null;
    qualifier_turns: number | string | null;
    /** `cardinality(offers_linked)`: how many offers have had their link sent in this conversation. */
    links_sent: number | string | null;
    last_link_at: Date | string | null;
    followups_sent: number | string | null;
    handoff_at: Date | string | null;
    handoff_reason: string | null;
    opted_out_at: Date | string | null;
    /** Every stage a bot reply recorded (`messages.ai_meta.stage`), once each. */
    stages_seen: readonly string[] | null;
}

export interface ClickFact {
    conversation_id: string;
    is_prefetch: boolean;
    n: number | string;
}

export interface ReplyFact {
    n: number | string | null;
    p50_ms: number | string | null;
    p90_ms: number | string | null;
}

// ─── What a conversation reached ────────────────────────────────────────────────────────────────────────

const SEEN_RECOMMEND: ReadonlySet<string> = new Set(['recommend', 'objection', 'link', 'follow_up']);
const SEEN_QUALIFY: ReadonlySet<string> = new Set(['qualify', ...SEEN_RECOMMEND]);
/** Stages that exist only after a link went out (`flow.ts`: `link` is entered by a sent link; `follow_up` is the nudge that follows one). */
const SEEN_LINK: ReadonlySet<string> = new Set(['link', 'follow_up']);

/** A count from the database: `pg` hands `INTEGER` back as a number and `COUNT(*)` as a string. Anything else is no count. */
const countOf = (value: unknown): number => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const present = (value: unknown): boolean => value !== null && value !== undefined && value !== '';

export interface Reached {
    qualified: boolean;
    recommended: boolean;
    linked: boolean;
    clicked: boolean;
    followedUp: boolean;
    handedOff: boolean;
    closed: boolean;
    optedOut: boolean;
    complaint: boolean;
}

/**
 * What one conversation reached. `humanClicks` is the number of clicks on its links that were a person's: the caller has already left
 * the prefetches out, and `clicked` still needs a link that was sent, so a step never exceeds the one before it.
 */
export function reachedOf(fact: ConversationFact, humanClicks: number): Reached {
    const seen = new Set<string>((fact.stages_seen ?? []).filter((s): s is string => typeof s === 'string'));
    if (typeof fact.stage === 'string') seen.add(fact.stage);
    const hasAny = (stages: ReadonlySet<string>): boolean => [...seen].some((s) => stages.has(s));

    const followUps = countOf(fact.followups_sent);
    const linked = countOf(fact.links_sent) > 0 || present(fact.last_link_at) || hasAny(SEEN_LINK) || followUps > 0;
    const recommended = linked || hasAny(SEEN_RECOMMEND);
    const qualified = recommended || hasAny(SEEN_QUALIFY) || countOf(fact.qualifier_turns) > 0;
    const optedOut = present(fact.opted_out_at);
    return {
        qualified,
        recommended,
        linked,
        clicked: linked && humanClicks > 0,
        followedUp: followUps > 0 || seen.has('follow_up'),
        handedOff: present(fact.handoff_at) || seen.has('handoff'),
        closed: seen.has('closed') || optedOut,
        optedOut,
        complaint: fact.handoff_reason === 'complaint',
    };
}

// ─── The aggregation ────────────────────────────────────────────────────────────────────────────────────

export const DM_FUNNEL_STEP_IDS = ['conversations', 'qualified', 'recommended', 'link_sent', 'clicked'] as const;
export type DmFunnelStepId = (typeof DM_FUNNEL_STEP_IDS)[number];

export interface DmFunnelStep {
    id: DmFunnelStepId;
    /** Conversations that reached this step or went past it. */
    count: number;
    /** `count` as a share of the cohort, 0 to 100. */
    pct: number;
}

/** A rate with the numbers it is made of; `pct` is null when there is nothing to divide by. */
export interface DmFunnelRate {
    count: number;
    of: number;
    pct: number | null;
}

export interface DmFunnel {
    days: DmFunnelWindow;
    since: string;
    /** The cohort: conversations whose first customer message is in the window. */
    conversations: number;
    steps: DmFunnelStep[];
    outcomes: { follow_up: number; handoff: number; closed: number; opted_out: number; complaints: number };
    rates: { link: DmFunnelRate; click: DmFunnelRate; handoff: DmFunnelRate; opt_out: DmFunnelRate };
    /** What the clicks were: `people` is the conversations with a person's click; `human` and `preview` count the visits themselves. */
    clicks: { people: number; human: number; preview: number };
    /** How long the bot took to answer, over `sample` customer messages. null when none was answered. */
    reply: { sample: number; median_ms: number | null; p90_ms: number | null };
    /** The A/B comparison of the owner's wording arms (S14). Absent when there is no experiment and no conversation was given an arm. */
    variants?: DmVariantBreakdown;
}

const rate = (count: number, of: number): DmFunnelRate => ({ count, of, pct: of > 0 ? Math.round((100 * count) / of) : null });

const msOf = (value: unknown): number | null => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/** Pure: the fixture rows (or the statements' answers) in, the funnel out. */
export function buildDmFunnel(
    conversations: readonly ConversationFact[],
    clicks: readonly ClickFact[],
    reply: ReplyFact | null,
    options: { days: DmFunnelWindow; now?: number; variants?: { config: VariantConfig | null; assignments: readonly VariantFact[] } }
): DmFunnel {
    const now = options.now ?? Date.now();

    // A person's clicks per conversation. A visit that was a prefetch is counted on the side and never as a click.
    const human = new Map<string, number>();
    let humanVisits = 0;
    let previewVisits = 0;
    for (const row of clicks) {
        const n = countOf(row.n);
        if (row.is_prefetch === true) { previewVisits += n; continue; }
        humanVisits += n;
        human.set(row.conversation_id, (human.get(row.conversation_id) ?? 0) + n);
    }

    const flags = conversations.map((c) => reachedOf(c, human.get(c.id) ?? 0));
    const total = conversations.length;
    const count = (pick: (r: Reached) => boolean): number => flags.filter(pick).length;
    const counts: Record<DmFunnelStepId, number> = {
        conversations: total,
        qualified: count((r) => r.qualified),
        recommended: count((r) => r.recommended),
        link_sent: count((r) => r.linked),
        clicked: count((r) => r.clicked),
    };
    const outcomes = {
        follow_up: count((r) => r.followedUp),
        handoff: count((r) => r.handedOff),
        closed: count((r) => r.closed),
        opted_out: count((r) => r.optedOut),
        complaints: count((r) => r.complaint),
    };
    const sample = countOf(reply?.n);
    const variants = options.variants ? buildVariantBreakdown(conversations, flags, options.variants.assignments, options.variants.config) : null;
    return {
        days: options.days,
        since: new Date(now - options.days * DAY_MS).toISOString(),
        conversations: total,
        steps: DM_FUNNEL_STEP_IDS.map((id) => ({ id, count: counts[id], pct: total === 0 ? 0 : Math.round((100 * counts[id]) / total) })),
        outcomes,
        rates: {
            link: rate(counts.link_sent, counts.recommended),
            click: rate(counts.clicked, counts.link_sent),
            handoff: rate(outcomes.handoff, total),
            opt_out: rate(outcomes.opted_out, total),
        },
        clicks: { people: counts.clicked, human: humanVisits, preview: previewVisits },
        reply: { sample, median_ms: sample > 0 ? msOf(reply?.p50_ms) : null, p90_ms: sample > 0 ? msOf(reply?.p90_ms) : null },
        ...(variants ? { variants } : {}),
    };
}

/** The funnel for one tenant's last `days` days, from the database. Read-only. */
export async function loadDmFunnel(tenantId: string, days: DmFunnelWindow, now: number = Date.now()): Promise<DmFunnel> {
    const since = new Date(now - days * DAY_MS);
    const [conversations, clicks, reply, config] = await Promise.all([
        queryRows<ConversationFact>(DM_FUNNEL_CONVERSATIONS_SQL, [tenantId, since]),
        queryRows<ClickFact>(DM_FUNNEL_CLICKS_SQL, [tenantId, since]),
        queryRows<ReplyFact>(DM_FUNNEL_REPLY_SQL, [tenantId, since]),
        readVariantConfig(tenantId),
    ]);
    // The A/B section: only for a tenant that has saved an experiment (no row, no arm was ever assigned), and never at the funnel's expense. The arm is
    // v42's column: a database that is behind answers an error here, which is a funnel without the comparison.
    let variants: { config: VariantConfig | null; assignments: VariantFact[] } | undefined;
    if (config !== null) {
        try {
            variants = { config, assignments: await queryRows<VariantFact>(DM_FUNNEL_VARIANTS_SQL, [tenantId, since]) };
        } catch (err) {
            log('warn', 'dm.funnel_variants_unavailable', { creator_id: tenantId, ...describeError(err) });
        }
    }
    return buildDmFunnel(conversations, clicks, reply[0] ?? null, { days, now, ...(variants ? { variants } : {}) });
}
