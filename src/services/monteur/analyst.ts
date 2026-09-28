/**
 * The Analyst (MONTEUR.md §8): one Gemini call a week reads the tenant's latest reels and their
 * numbers from the Growth hub, and writes at most 10 short rules the Monteur and the Marketer
 * follow from then on. Memory is those rules, not history: the latest `done` row is all either
 * prompt ever sees.
 *
 * Read from `post_insights` (migration v22) by its real columns: `media_type` REELS (Instagram) or
 * VIDEO (Facebook), `published_at`, `caption`, and the `metrics` JSONB, whose keys are
 * `PostMetrics`'s: views, reach, skip_rate, likes, comments, shares, saved. A metric the platform
 * did not return is absent, never 0, and is left out of the prompt rather than sent as zero.
 *
 * The follower split is not per post: Instagram only breaks reach down by follow_type for the
 * account, by day (`account_insights_daily.metrics.reach_followers` / `reach_non_followers`). The
 * share is summed over the days the reels span and sent once, as the account's.
 *
 * When it runs (the sweep): no `done` row in the last 7 days, no row at all in the last 6 hours —
 * so a failing run can't hammer Gemini — and at least 5 reels or videos with insights. Or now, on
 * POST /lessons/refresh.
 *
 * With `monteur.brain: 'claude_mac'` the call is Claude's, on the Mac (think.ts, MONTEUR.md §6.3):
 * the run's row stays `running` while the call waits there, the sweep resumes it on every drain
 * until the answer is in, and a call whose every try failed fails the run with "Claude on the Mac
 * didn't answer: …". Gemini is never asked.
 */
import { pool } from '../../config/db.js';
import type { LessonBasis, StudioLesson, StudioLessonRow, StudioSettings } from '../../db/rows.js';
import { describeError, log } from '../../utils/log.js';
import { type Exec, StudioError } from '../studio/common.js';
import { trimText, type GeminiSchema } from '../studio/generate.js';
import { languageKit, oneLine } from '../studio/prompts.js';
import { getStudioSettings } from '../studio/settings.js';
import { ask, emptyCost, usageFields } from './model.js';
import { lessonsThinkKey, ThinkWaiting, thinkRoute } from './think.js';

export const ANALYST_FRESH_DAYS = 7;
export const ANALYST_RETRY_HOURS = 6;
export const ANALYST_MIN_POSTS = 5;
/** The reels it reads: the latest this many. */
export const ANALYST_POSTS = 20;
export const MAX_LESSONS = 10;
export const RULE_MAX = 140;
export const EVIDENCE_MAX = 100;
export const SUMMARY_MAX = 280;
/** A `running` row older than this belongs to an invocation that was cut off. */
export const STALE_RUN_MS = 10 * 60 * 1000;
export const ANALYST_CALL_MS = 90_000;
const ANALYST_THINKING = 1024;
/** Thinking counts toward the cap and may run past its budget: see PICK_MAX_OUTPUT. */
export const ANALYST_MAX_OUTPUT = 8192;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const ANALYST_PURPOSE = 'monteur.analyst';

/**
 * True for a run (`studio_lessons l`) whose call went to Claude on the Mac: it has a think try under
 * the request `thinkRoute` gives it. Such a run waits as long as its tries do, so it is neither
 * "cut off" after 10 minutes nor run again beside itself.
 */
export const THINKING_RUN = `EXISTS (SELECT 1 FROM studio_jobs j
    WHERE j.creator_id = l.creator_id AND j.kind = 'monteur_think'
      AND j.payload->>'request' = 'lessons/' || l.id::text || '/${ANALYST_PURPOSE}')`;

/** Runs waiting for Claude on the Mac, oldest first: the sweep resumes these before starting any. */
export const WAITING_RUNS_SQL = `
    SELECT l.* FROM studio_lessons l
      JOIN creators c ON c.id = l.creator_id AND c.is_active = TRUE
     WHERE l.status = 'running' AND ${THINKING_RUN}
     ORDER BY l.created_at
     LIMIT 20`;

/** Reels (Instagram) and videos (Facebook), with numbers from the insights edge, not just the node. */
const REEL_WITH_INSIGHTS = `media_type IN ('REELS', 'VIDEO') AND (metrics ? 'views' OR metrics ? 'reach')`;

export const LESSONS_SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: {
        lessons: {
            type: 'ARRAY',
            maxItems: MAX_LESSONS,
            description: `at most ${MAX_LESSONS}`,
            items: {
                type: 'OBJECT',
                properties: {
                    rule: { type: 'STRING', description: `an imperative, at most ${RULE_MAX} characters` },
                    evidence: { type: 'STRING', description: `the numbers behind it, at most ${EVIDENCE_MAX} characters` },
                },
                required: ['rule', 'evidence'],
                propertyOrdering: ['rule', 'evidence'],
            },
        },
        summary: { type: 'STRING', description: `at most ${SUMMARY_MAX} characters` },
    },
    required: ['lessons', 'summary'],
    propertyOrdering: ['lessons', 'summary'],
};

// ─── What the prompts read ──────────────────────────────────────────────────────────────

/** The latest `done` row's lessons: what both of §6's prompts follow. None before the first run. */
export async function currentLessons(exec: Exec, creatorId: string): Promise<StudioLesson[]> {
    const { rows } = await exec.query<Pick<StudioLessonRow, 'lessons'>>(
        `SELECT lessons FROM studio_lessons
          WHERE creator_id = $1 AND status = 'done'
          ORDER BY created_at DESC
          LIMIT 1`,
        [creatorId]
    );
    return (rows[0]?.lessons ?? []).filter((l) => l && typeof l.rule === 'string' && l.rule.trim());
}

// ─── When it runs ───────────────────────────────────────────────────────────────────────

export interface AnalystStats {
    lastDoneAt: Date | null;
    lastRunAt: Date | null;
    /** Reels and videos with insights. */
    posts: number;
}

/** The sweep's three conditions. Pure, so each can be tested on its own. */
export function analystDue(stats: AnalystStats, now: number): boolean {
    if (stats.lastDoneAt && now - new Date(stats.lastDoneAt).getTime() < ANALYST_FRESH_DAYS * DAY_MS) return false;
    if (stats.lastRunAt && now - new Date(stats.lastRunAt).getTime() < ANALYST_RETRY_HOURS * HOUR_MS) return false;
    return stats.posts >= ANALYST_MIN_POSTS;
}

export async function analystStats(exec: Exec, creatorId: string): Promise<AnalystStats> {
    const { rows } = await exec.query<{ last_done_at: Date | null; last_run_at: Date | null; posts: number }>(
        `SELECT (SELECT MAX(created_at) FROM studio_lessons WHERE creator_id = $1 AND status = 'done') AS last_done_at,
                (SELECT MAX(created_at) FROM studio_lessons WHERE creator_id = $1) AS last_run_at,
                (SELECT COUNT(*)::int FROM post_insights WHERE creator_id = $1 AND ${REEL_WITH_INSIGHTS}) AS posts`,
        [creatorId]
    );
    const r = rows[0];
    return { lastDoneAt: r?.last_done_at ?? null, lastRunAt: r?.last_run_at ?? null, posts: r?.posts ?? 0 };
}

// ─── The inputs ─────────────────────────────────────────────────────────────────────────

export interface ReelInsight {
    id: string;
    platform: string;
    media_type: string | null;
    caption: string | null;
    published_at: Date | null;
    metrics: Record<string, unknown>;
}

export async function recentReels(exec: Exec, creatorId: string): Promise<ReelInsight[]> {
    const { rows } = await exec.query<ReelInsight>(
        `SELECT id, platform, media_type, caption, published_at, metrics
           FROM post_insights
          WHERE creator_id = $1 AND ${REEL_WITH_INSIGHTS}
          ORDER BY published_at DESC NULLS LAST, fetched_at DESC
          LIMIT $2`,
        [creatorId, ANALYST_POSTS]
    );
    return rows;
}

/** The account's Instagram reach from non-followers over these days, 0–1, or null when unknown. */
export async function nonFollowerShare(exec: Exec, creatorId: string, from: string, to: string): Promise<number | null> {
    const { rows } = await exec.query<{ followers: string | null; non_followers: string | null }>(
        `SELECT SUM((metrics->>'reach_followers')::numeric) AS followers,
                SUM((metrics->>'reach_non_followers')::numeric) AS non_followers
           FROM account_insights_daily
          WHERE creator_id = $1 AND platform = 'instagram' AND day BETWEEN $2::date AND $3::date
            AND metrics ? 'reach_non_followers'`,
        [creatorId, from, to]
    );
    const followers = Number(rows[0]?.followers ?? 0) || 0;
    const non = Number(rows[0]?.non_followers ?? 0) || 0;
    return followers + non > 0 ? non / (followers + non) : null;
}

const fmt = (n: unknown): string | null =>
    typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(1)).toLocaleString('en-US') : null;

function firstLine(caption: string | null): string {
    return oneLine(caption?.split('\n').find((l) => l.trim()) ?? '').slice(0, 120);
}

/** One reel, with only the numbers it has: an absent metric is left out, never sent as 0. */
export function reelLine(reel: ReelInsight, i: number): string {
    const m = reel.metrics ?? {};
    const numbers = ([
        ['views', m.views], ['reach', m.reach], ['skip', m.skip_rate], ['likes', m.likes], ['comments', m.comments],
        ['shares', m.shares], ['saves', m.saved],
    ] as const).flatMap(([label, value]) => {
        const v = fmt(value);
        return v === null ? [] : [label === 'skip' ? `skipped in 3s ${v}%` : `${label} ${v}`];
    });
    const when = reel.published_at ? new Date(reel.published_at).toISOString().slice(0, 10) : 'unknown date';
    const kind = reel.platform === 'instagram' ? 'IG reel' : `${reel.platform} video`;
    return `${i + 1}. ${when} ${kind} | ${numbers.join(' · ') || 'no numbers'} | «${firstLine(reel.caption)}»`;
}

export function analystSystemPrompt(settings: StudioSettings): string {
    const lang = languageKit(settings).name;
    return `You are a growth analyst for short vertical video. From a creator's latest reels and their numbers, write the lessons their next reels should follow. Answer with JSON only, in ${lang}.
- lessons: at most ${MAX_LESSONS} imperative rules, each at most ${RULE_MAX} characters, about hooks, length, topics, titles or captions; each with evidence of at most ${EVIDENCE_MAX} characters naming the numbers behind it.
- summary: at most ${SUMMARY_MAX} characters on what works and what doesn't.
"skipped in 3s" is the share of views gone within 3 seconds: the lower, the stronger the hook. Compare reels by it and by views.
Keep a current lesson the numbers still support, drop one they contradict. Never invent a number: a missing one is unknown.`;
}

export function analystUserPrompt(args: {
    reels: readonly ReelInsight[]; current: readonly StudioLesson[]; share: number | null;
}): string {
    const { reels, current, share } = args;
    return [
        current.length ? 'Current lessons:' : 'There are no lessons yet.',
        ...current.map((l) => `- ${l.rule} (${l.evidence})`),
        share === null
            ? 'The share of Instagram reach from non-followers is unknown.'
            : `Over these reels' days, ${(share * 100).toFixed(0)}% of the account's Instagram reach came from non-followers.`,
        'Reels, newest first:',
        ...reels.map(reelLine),
    ].join('\n');
}

/** The answer, cut to its limits. Rules with no words are dropped. */
export function parseLessons(raw: unknown): { lessons: StudioLesson[]; summary: string | null } {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const lessons = (Array.isArray(r.lessons) ? r.lessons : []).flatMap((item): StudioLesson[] => {
        const l = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        const rule = typeof l.rule === 'string' ? trimText(oneLine(l.rule), RULE_MAX) : '';
        if (!rule) return [];
        return [{ rule, evidence: typeof l.evidence === 'string' ? trimText(oneLine(l.evidence), EVIDENCE_MAX) : '' }];
    }).slice(0, MAX_LESSONS);
    const summary = typeof r.summary === 'string' && oneLine(r.summary) ? trimText(oneLine(r.summary), SUMMARY_MAX) : null;
    return { lessons, summary };
}

// ─── The run ────────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/**
 * One run: a `running` row first, then `done` or `failed`. A failure is recorded on the row and
 * returned, not thrown: the row is the answer either way. Only a database error throws. `resume`
 * is a run waiting for Claude on the Mac, taken up again; while it still waits it is returned
 * `running`, as it was.
 */
export async function runAnalyst(creatorId: string, deadline: number, resume: StudioLessonRow | null = null): Promise<StudioLessonRow> {
    const settings = await getStudioSettings(creatorId);
    const run = resume ?? (await pool.query<StudioLessonRow>(
        `INSERT INTO studio_lessons (creator_id, status) VALUES ($1, 'running') RETURNING *`, [creatorId]
    )).rows[0]!;
    const think = settings.monteur.brain === 'claude_mac' ? { creatorId, key: lessonsThinkKey(run.id) } : undefined;
    const cost = emptyCost();
    const began = Date.now();
    try {
        const reels = await recentReels(pool, creatorId);
        if (!reels.length) throw new Error('There are no reels or videos with insights yet: sync the Growth hub first.');
        const dates = reels.map((r) => iso(r.published_at)).filter((d): d is string => Boolean(d)).sort();
        const from = dates[0] ?? null;
        const to = dates.at(-1) ?? null;
        const [share, current] = await Promise.all([
            from && to ? nonFollowerShare(pool, creatorId, from.slice(0, 10), to.slice(0, 10)) : Promise.resolve(null),
            currentLessons(pool, creatorId),
        ]);
        const raw = await ask({
            purpose: ANALYST_PURPOSE,
            system: analystSystemPrompt(settings),
            turns: [{ role: 'user', text: analystUserPrompt({ reels, current, share }) }],
            schema: LESSONS_SCHEMA,
            temperature: 0.3,
            thinkingBudget: ANALYST_THINKING,
            maxOutputTokens: ANALYST_MAX_OUTPUT,
            capMs: ANALYST_CALL_MS,
            think: thinkRoute(think, ANALYST_PURPOSE, 'analyst'),
        }, deadline, cost);
        const { lessons, summary } = parseLessons(raw);
        log('info', 'monteur.analyst', {
            creator_id: creatorId, ...usageFields(cost), posts: reels.length, lessons: lessons.length, ms: Date.now() - began,
        });
        if (!lessons.length) throw new Error('The Analyst answered with no lessons; the current ones stay.');
        const basis: LessonBasis = { posts: reels.length, from, to, post_ids: reels.map((r) => r.id) };
        const { rows } = await pool.query<StudioLessonRow>(
            `UPDATE studio_lessons SET status = 'done', lessons = $2::jsonb, summary = $3, basis = $4::jsonb, model = $5, error = NULL
              WHERE id = $1
          RETURNING *`,
            [run.id, JSON.stringify(lessons), summary, JSON.stringify(basis), cost.model]
        );
        return rows[0] ?? run;
    } catch (err) {
        if (err instanceof ThinkWaiting) {
            log('info', 'monteur.analyst_waiting', { creator_id: creatorId, run_id: run.id, why: err.message });
            return run;
        }
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        log('warn', 'monteur.analyst_failed', { creator_id: creatorId, ...describeError(err) });
        const { rows } = await pool.query<StudioLessonRow>(
            `UPDATE studio_lessons SET status = 'failed', error = $2, model = $3 WHERE id = $1 RETURNING *`,
            [run.id, message, cost.model]
        );
        return rows[0] ?? { ...run, status: 'failed', error: message };
    }
}

/**
 * POST /lessons/refresh: run now, whatever the week's guards say — the operator asked. Refused
 * while a run is in progress (one waiting for Claude on the Mac is, however old), and when there is
 * nothing to learn from.
 */
export async function refreshLessons(creatorId: string, deadline: number = Date.now() + ANALYST_CALL_MS + 20_000): Promise<StudioLessonRow> {
    const { rows } = await pool.query<{ running: number; posts: number }>(
        `SELECT (SELECT COUNT(*)::int FROM studio_lessons l
                  WHERE l.creator_id = $1 AND l.status = 'running'
                    AND (l.created_at > NOW() - make_interval(secs => $2) OR ${THINKING_RUN})) AS running,
                (SELECT COUNT(*)::int FROM post_insights WHERE creator_id = $1 AND ${REEL_WITH_INSIGHTS}) AS posts`,
        [creatorId, STALE_RUN_MS / 1000]
    );
    if ((rows[0]?.running ?? 0) > 0) throw new StudioError(409, 'The Analyst is already running. Wait for it to finish.');
    if ((rows[0]?.posts ?? 0) === 0) {
        throw new StudioError(409, 'There are no reels or videos with insights yet: sync the Growth hub first.');
    }
    return runAnalyst(creatorId, deadline);
}

/**
 * From the sweep: the first tenant using the Monteur whose lessons are due, if any, run to the
 * deadline. "Using" is switched on, or with videos already: Run now picks with the lessons even
 * while the daily run is off. A tenant that never touched the Monteur spends no tokens here.
 *
 * Runs waiting for Claude on the Mac come first: each is a few queries until its answer is in, and
 * the first that finishes is this sweep's run. A tenant with one waiting never starts another.
 */
export async function runDueAnalyst(deadline: number, now: number = Date.now()): Promise<{ creator_id: string; status: StudioLessonRow['status'] } | null> {
    const { rows: waiting } = await pool.query<StudioLessonRow>(WAITING_RUNS_SQL);
    for (const row of waiting) {
        const resumed = await runAnalyst(row.creator_id, deadline, row);
        if (resumed.status !== 'running') return { creator_id: row.creator_id, status: resumed.status };
    }
    const busy = new Set(waiting.map((r) => r.creator_id));
    const { rows: tenants } = await pool.query<{ creator_id: string }>(
        `SELECT c.id AS creator_id
           FROM creators c
          WHERE c.is_active = TRUE
            AND (EXISTS (SELECT 1 FROM studio_settings s WHERE s.creator_id = c.id AND s.monteur->>'enabled' = 'true')
                 OR EXISTS (SELECT 1 FROM monteur_sources m WHERE m.creator_id = c.id))
          ORDER BY c.id
          LIMIT 50`
    );
    for (const { creator_id: creatorId } of tenants) {
        if (busy.has(creatorId) || !analystDue(await analystStats(pool, creatorId), now)) continue;
        const row = await runAnalyst(creatorId, deadline);
        return { creator_id: creatorId, status: row.status };
    }
    return null;
}
