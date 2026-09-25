/**
 * `POST /api/growth/coach` (GROWTH.md §3): Gemini reads the tenant's numbers, captions and
 * settings and answers `{ summary, wins, problems, actions, experiments }` in the tenant's voice
 * language (`studio_settings.voice.language`, else English).
 *
 * It runs on the Studio's writer chain (`callGemini`: `STUDIO_MODELS` in order, never the DM
 * bot's model), with a response schema, and the answer is checked here rather than trusted: every
 * list is capped, every enum normalised, and a `post_notes` entry must name a post we sent.
 *
 * Code computes what code can: medians per type, the follower / non-follower split, reposted
 * captions, the best slots. The model is told to reason from those — about retention when reach
 * already comes from non-followers — and to say a number is missing rather than guess it.
 */
import { callGemini, type CallModel, type GeminiSchema } from '../studio/generate.js';
import { getStudioSettings } from '../studio/settings.js';
import { describeError, log } from '../../utils/log.js';
import { isMissingSchema } from '../health.js';
import { clip, GrowthError } from './common.js';
import { getOverview, listPostInsights, slotOf, type Overview, type PostInsight } from './overview.js';
import { getGrowthSettings } from './settings.js';
import { readSyncState } from './sync.js';
import type { GrowthSettings } from '../../db/rows.js';

export type Level = 'low' | 'med' | 'high';
export interface CoachAction { title: string; why: string; how: string; effort: Level; impact: Level }
export interface CoachExperiment { hypothesis: string; how: string; measure: string }
export interface CoachAnswer {
    summary: string;
    wins: string[];
    problems: string[];
    actions: CoachAction[];
    experiments: CoachExperiment[];
    /** "Why it worked", for the Posts table's tooltip: one line per post, by `media_id`. */
    post_notes: { media_id: string; note: string }[];
}
export interface CoachResponse extends CoachAnswer {
    language: 'ar' | 'en';
    /** False when no post has views or reach: the coach worked from the post history alone. */
    metrics_available: boolean;
    /** Permissions the last sync found missing. */
    missing: string[];
    generated_at: string;
}

export const COACH_TIMEOUT_MS = 60_000;
const LIMITS = { wins: 5, problems: 5, actions: 7, experiments: 4, notes: 5, posts: 30 } as const;

// ─── Schema ──────────────────────────────────────────────────────────────────────────────

const str = (description: string): GeminiSchema => ({ type: 'STRING', description });
const obj = (properties: Record<string, GeminiSchema>, description?: string): GeminiSchema => ({
    type: 'OBJECT', properties, required: Object.keys(properties), propertyOrdering: Object.keys(properties),
    ...(description ? { description } : {}),
});
const list = (items: GeminiSchema, maxItems: number, description: string): GeminiSchema => ({ type: 'ARRAY', items, maxItems, description });
const level: GeminiSchema = { type: 'STRING', enum: ['low', 'med', 'high'] };

export const COACH_SCHEMA: GeminiSchema = obj({
    summary: str('3–5 sentences: where the account stands, and the one thing that matters most right now'),
    wins: list(str('one line naming the number behind it'), LIMITS.wins, 'what is working'),
    problems: list(str('one line naming the number behind it, or the data that is missing'), LIMITS.problems, 'what holds growth back'),
    actions: list(obj({
        title: str('an imperative, ≤ 80 characters'),
        why: str('the number that justifies it'),
        how: str('concrete steps for this week'),
        effort: level,
        impact: level,
    }), LIMITS.actions, 'prioritised: highest impact first'),
    experiments: list(obj({
        hypothesis: str('if … then …, one variable'),
        how: str('how to run it, over how many posts'),
        measure: str('which metric decides it'),
    }), LIMITS.experiments, 'small tests to run next'),
    post_notes: list(obj({
        media_id: str('a media id from the post list, exactly'),
        note: str('why this post did well, one line'),
    }), LIMITS.notes, 'for the best posts in the list'),
});

// ─── The facts code works out ────────────────────────────────────────────────────────────

export function median(values: readonly number[]): number | null {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** Posts that share a caption: the same reel posted again. `key` is the caption's start, normalised. */
export function repostGroups(posts: readonly PostInsight[]): { caption: string; posts: PostInsight[] }[] {
    const groups = new Map<string, PostInsight[]>();
    for (const p of posts) {
        const key = (p.caption ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
        if (key.length < 12) continue;
        groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    return [...groups.values()].filter((g) => g.length > 1).map((g) => ({ caption: g[0]!.caption ?? '', posts: g }));
}

const fmt = (n: number | null | undefined, digits = 0): string =>
    n === null || n === undefined ? 'n/a' : Number(n.toFixed(digits)).toLocaleString('en-US');
const seconds = (ms: number | null | undefined): string => (ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)}s`);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function postLine(p: PostInsight, timezone: string): string {
    const when = p.published_at ? (() => {
        const { weekday, hour } = slotOf(new Date(p.published_at), timezone);
        return `${p.published_at.slice(0, 10)} ${DAYS[weekday]} ${String(hour).padStart(2, '0')}:00`;
    })() : 'unknown time';
    const m = p.metrics;
    const numbers = [
        `views ${fmt(m.views)}`, `reach ${fmt(m.reach)}`, `likes ${fmt(m.likes)}`, `comments ${fmt(m.comments)}`,
        `saved ${fmt(m.saved)}`, `shares ${fmt(m.shares)}`,
        ...(m.avg_watch_time_ms !== null ? [`avg watch ${seconds(m.avg_watch_time_ms)}`] : []),
        ...(m.skip_rate !== null && m.skip_rate !== undefined ? [`skipped in 3s ${fmt(m.skip_rate)}%`] : []),
        ...(m.follows !== null ? [`follows ${fmt(m.follows)}`] : []),
    ].join(', ');
    return `- id ${p.media_id} [${p.platform} ${p.media_type ?? '?'} ${when}] ${numbers} | «${clip(p.caption, 140)}»`;
}

/** The user turn: every number the coach may use, and nothing it would have to guess. */
export function coachPrompt(input: {
    overview: Overview; posts: readonly PostInsight[]; settings: GrowthSettings; missing: readonly string[]; language: 'ar' | 'en';
}): string {
    const { overview: o, posts, settings, missing } = input;
    const k = o.kpis;
    const lines: string[] = [`Coach this account on the last ${o.days} days. Timezone: ${o.timezone}.`, ''];

    lines.push('## Account');
    for (const p of o.by_platform) {
        lines.push(`- ${p.platform}: followers ${fmt(p.followers)}, posts ${p.posts}, views ${fmt(p.views)}, reach ${fmt(p.reach)}, avg views per post ${fmt(p.avg_views)}`);
    }
    lines.push(`- totals: views ${fmt(k.views)}, reach ${fmt(k.reach)}, interactions ${fmt(k.interactions)}, engagement rate ${k.engagement_rate === null ? 'n/a' : `${(k.engagement_rate * 100).toFixed(1)}%`}, saves ${fmt(k.saves)}, shares ${fmt(k.shares)}, followers change ${fmt(k.followers_delta)}`);
    if (o.audience_split) {
        const r = o.audience_split.reach;
        const v = o.audience_split.views;
        lines.push(`- Instagram reach: followers ${fmt(r.followers)}, non-followers ${fmt(r.non_followers)} (non-follower share ${k.non_follower_reach_share === null ? 'n/a' : `${(k.non_follower_reach_share * 100).toFixed(0)}%`}); views: followers ${fmt(v.followers)}, non-followers ${fmt(v.non_followers)}`);
    }
    if (o.reach_by_surface) {
        lines.push(`- Instagram reach by surface: ${Object.entries(o.reach_by_surface).map(([s, n]) => `${s} ${fmt(n)}`).join(', ')}`);
    }

    lines.push('', '## By post type');
    const types = [...new Set(posts.map((p) => p.media_type ?? 'UNKNOWN'))];
    for (const type of types) {
        const group = posts.filter((p) => (p.media_type ?? 'UNKNOWN') === type);
        const pick = (f: (p: PostInsight) => number | null | undefined) =>
            median(group.map(f).filter((x): x is number => typeof x === 'number'));
        lines.push(`- ${type}: ${group.length} posts, median views ${fmt(pick((p) => p.metrics.views))}, median reach ${fmt(pick((p) => p.metrics.reach))}, median interactions ${fmt(pick((p) => p.interactions))}${type === 'REELS' || type === 'VIDEO' ? `, median avg watch ${seconds(pick((p) => p.metrics.avg_watch_time_ms))}` : ''}${type === 'REELS' ? `, median skipped in 3s ${fmt(pick((p) => p.metrics.skip_rate))}%` : ''}`);
    }

    const reposts = repostGroups(posts);
    if (reposts.length) {
        lines.push('', '## Posts that share a caption (reposts)');
        for (const g of reposts.slice(0, 5)) {
            lines.push(`- ${g.posts.length} posts «${clip(g.caption, 80)}»: views ${g.posts.map((p) => fmt(p.metrics.views)).join(', ')}`);
        }
    }

    const slots: { d: number; h: number; v: number; n: number }[] = [];
    o.best_times.forEach((row, d) => row.forEach((v, h) => { const n = o.best_times_meta.counts[d]![h]!; if (n) slots.push({ d, h, v, n }); }));
    if (slots.length) {
        slots.sort((a, b) => b.v - a.v);
        lines.push('', `## Best slots so far (average ${o.best_times_meta.metric} of own posts by publish time)`);
        lines.push(slots.slice(0, 5).map((s) => `${DAYS[s.d]} ${String(s.h).padStart(2, '0')}:00 → ${fmt(s.v)} (${s.n} post${s.n === 1 ? '' : 's'})`).join('; '));
    }

    lines.push('', `## Posts, newest first (${Math.min(posts.length, LIMITS.posts)} of ${posts.length})`);
    lines.push(...posts.slice(0, LIMITS.posts).map((p) => postLine(p, o.timezone)));
    if (!posts.length) lines.push('- (no posts synced yet)');

    lines.push('', '## Settings');
    lines.push(`- search keywords: ${settings.keywords.length ? settings.keywords.join(', ') : '(none set)'}`);
    lines.push(`- hashtag sets: ${settings.hashtag_sets.length ? settings.hashtag_sets.map((s) => `${s.name} (${s.tags.slice(0, 8).join(' ')})`).join('; ') : '(none set)'}`);
    const a = settings.audience;
    lines.push(`- audience: countries ${a.countries?.join(', ') || 'not set'}, languages ${a.languages?.join(', ') || 'not set'}`);

    const notes = Object.entries(o.notes).map(([key, why]) => `- ${key}: ${why}`);
    if (missing.length || notes.length) {
        lines.push('', '## Missing data');
        if (missing.length) lines.push(`- The access token lacks ${missing.join(', ')}, so views, reach, saves and watch time are missing where it applies. Say so; don't estimate them.`);
        lines.push(...notes);
    }
    return lines.join('\n');
}

export function coachSystemPrompt(language: 'ar' | 'en'): string {
    const name = language === 'ar' ? 'Arabic' : 'English';
    return `You are a growth coach for a creator's Instagram and Facebook accounts. You read their real numbers and tell them what to do next. Return strict JSON matching the response schema and nothing else.

## Language
Write every field in ${name}, plainly, as one practitioner to another. Metric names and numbers may stay as they are.

## Rules
- Ground every claim in the numbers given. Quote the number. Never invent a figure, a benchmark or a trend the data doesn't show.
- When a number is missing, say it's missing and why (a permission, fewer than 100 followers), and coach from what is there: the post history, types, captions and timing.
- Find the bottleneck the data shows before advising. When most reach already comes from non-followers, distribution is not the problem — retention and conversion are. For reels, an average watch time of a few seconds means the first 3 seconds don't hold: coach the hook, the opening frame, on-screen text and pacing, not hashtags or posting volume. "skipped in 3s" is Instagram's own count of the views that left within 3 seconds: the lower, the stronger the hook. Compare reels by it.
- A reel posted again under the same caption is a repost: judge reposting by the views each copy got, and say whether it is worth continuing.
- Actions are concrete and doable this week, highest impact first; each names the number behind it. Experiments change one variable, say how many posts to run, and name the metric that decides them.
- post_notes: only for posts in the list, by their exact id.
- Nothing against the platforms' rules: no bought followers, engagement pods, follow/unfollow or misleading captions.`;
}

// ─── Checking the answer ─────────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const texts = (v: unknown, max: number, each: number): string[] =>
    (Array.isArray(v) ? v : []).map((x) => clip(x, each)).filter(Boolean).slice(0, max);

export function toLevel(v: unknown): Level {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (s === 'low' || s === 'high') return s;
    return 'med';
}

const RANK: Record<Level, number> = { low: 0, med: 1, high: 2 };

/** The model's JSON, capped and normalised. Throws 502 when nothing usable came back. */
export function coerceCoach(raw: unknown, knownIds: ReadonlySet<string>): CoachAnswer {
    const r = isObj(raw) ? raw : {};
    const actions = (Array.isArray(r.actions) ? r.actions : [])
        .filter(isObj)
        .map((a) => ({ title: clip(a.title, 120), why: clip(a.why, 500), how: clip(a.how, 800), effort: toLevel(a.effort), impact: toLevel(a.impact) }))
        .filter((a) => a.title)
        .slice(0, LIMITS.actions)
        .sort((a, b) => RANK[b.impact] - RANK[a.impact] || RANK[a.effort] - RANK[b.effort]);
    const experiments = (Array.isArray(r.experiments) ? r.experiments : [])
        .filter(isObj)
        .map((e) => ({ hypothesis: clip(e.hypothesis, 400), how: clip(e.how, 500), measure: clip(e.measure, 300) }))
        .filter((e) => e.hypothesis)
        .slice(0, LIMITS.experiments);
    const seen = new Set<string>();
    const postNotes = (Array.isArray(r.post_notes) ? r.post_notes : [])
        .filter(isObj)
        .map((n) => ({ media_id: typeof n.media_id === 'string' ? n.media_id.trim() : '', note: clip(n.note, 300) }))
        .filter((n) => n.note && knownIds.has(n.media_id) && !seen.has(n.media_id) && seen.add(n.media_id))
        .slice(0, LIMITS.notes);
    const summary = clip(r.summary, 1500);
    if (!summary && !actions.length) throw new GrowthError(502, 'The coach returned nothing usable. Try again in a moment.');
    return {
        summary,
        wins: texts(r.wins, LIMITS.wins, 400),
        problems: texts(r.problems, LIMITS.problems, 400),
        actions,
        experiments,
        post_notes: postNotes,
    };
}

// ─── Running it ──────────────────────────────────────────────────────────────────────────

/** The tenant's voice language, from the Studio settings; English when there are none. */
export async function tenantLanguage(creatorId: string): Promise<'ar' | 'en'> {
    try {
        return (await getStudioSettings(creatorId)).voice?.language === 'ar' ? 'ar' : 'en';
    } catch (err) {
        if (!isMissingSchema(err)) log('warn', 'growth.language_unreadable', describeError(err));
        return 'en';
    }
}

export async function runCoach(creatorId: string, opts: { callModel?: CallModel; now?: Date } = {}): Promise<CoachResponse> {
    const call = opts.callModel ?? callGemini;
    const [overview, { posts }, settings, state, language] = await Promise.all([
        getOverview(creatorId, { days: 90, platform: 'all' }, opts.now),
        listPostInsights(creatorId, { days: 90 }),
        getGrowthSettings(creatorId),
        readSyncState(creatorId),
        tenantLanguage(creatorId),
    ]);
    const missing = state?.missing ?? [];

    let raw: unknown;
    try {
        raw = await call({
            purpose: 'growth-coach',
            system: coachSystemPrompt(language),
            turns: [{ role: 'user', text: coachPrompt({ overview, posts, settings, missing, language }) }],
            schema: COACH_SCHEMA,
            temperature: 0.5,
            thinkingBudget: 1024,
            timeoutMs: COACH_TIMEOUT_MS,
        });
    } catch (err) {
        log('warn', 'growth.coach_failed', { creator_id: creatorId, ...describeError(err) });
        throw new GrowthError(502, `The coach could not answer: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400));
    }

    const answer = coerceCoach(raw, new Set(posts.map((p) => p.media_id)));
    return {
        ...answer,
        language,
        metrics_available: posts.some((p) => p.metrics.views !== null || p.metrics.reach !== null),
        missing,
        generated_at: (opts.now ?? new Date()).toISOString(),
    };
}
