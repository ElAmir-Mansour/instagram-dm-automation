/**
 * What the creator's own reels say, for the Monteur's pick (MONTEUR.md §6.1, "Evidence"): the reels
 * with the most views in the last 90 days and the ones with the fewest, each with what it was about.
 *
 * A reel is one post across platforms: its Instagram and Facebook rows share `scheduled_post_id`, and
 * their views add up. A repost of the same video is the same reel again, so posts are also merged
 * by their opening line, keeping the better one. A reel the Monteur cut carries its clip's `title`
 * and `topic` (joined through `clip_drafts.schedule.meta_row_id`); any other reel has only its
 * caption's first line, which is still what it was about.
 *
 * Reels younger than `SETTLE_DAYS` can be among the best but never among the worst: their views are
 * still coming in.
 */
import { pool } from '../../config/db.js';
import type { PostMetrics } from '../../db/rows.js';

export const EVIDENCE_DAYS = 90;
export const BEST_REELS = 3;
export const WORST_REELS = 2;
export const SETTLE_DAYS = 3;
/** Fewer reels than this and "the fewest views" says nothing yet: no worst list. */
export const MIN_FOR_WORST = 6;
const OPENING_MAX = 100;

export interface ReelEvidenceRow {
    group_key: string;
    platform: string;
    caption: string | null;
    published_at: string | Date | null;
    metrics: PostMetrics | null;
    title: string | null;
    topic: string | null;
}

export interface ReelEvidence {
    views: number;
    /** Instagram's share of views gone within 3 s, 0–100; null when only Facebook has the reel. */
    skipRate: number | null;
    title: string | null;
    topic: string | null;
    opening: string;
}

export interface ReelEvidenceSet { best: ReelEvidence[]; worst: ReelEvidence[] }

export const REEL_EVIDENCE_SQL = `
    SELECT COALESCE(p.scheduled_post_id::text, p.platform || ':' || p.media_id) AS group_key,
           p.platform, p.caption, p.published_at, p.metrics, c.title, c.topic
      FROM post_insights p
      LEFT JOIN clip_drafts c
        ON c.creator_id = p.creator_id AND c.schedule->>'meta_row_id' = p.scheduled_post_id::text
     WHERE p.creator_id = $1 AND p.media_type IN ('REELS', 'VIDEO') AND p.metrics ? 'views'
       AND p.published_at > NOW() - make_interval(days => $2)
     ORDER BY p.published_at DESC
     LIMIT 300`;

const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const firstLine = (caption: string | null) => oneLine((caption ?? '').split('\n').find((l) => l.trim()));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface Reel extends ReelEvidence { key: string; publishedAt: number }

/** Pure: rows → the best and the worst reels. `now` is for the settle rule. */
export function rankReels(rows: readonly ReelEvidenceRow[], now: number = Date.now()): ReelEvidenceSet {
    const posts = new Map<string, Reel>();
    for (const row of rows) {
        const views = num(row.metrics?.views) ?? 0;
        const skip = row.platform === 'instagram' ? num(row.metrics?.skip_rate) : null;
        const at = row.published_at ? new Date(row.published_at).getTime() : NaN;
        const post = posts.get(row.group_key);
        if (post) {
            post.views += views;
            post.skipRate ??= skip;
            post.title ??= oneLine(row.title) || null;
            post.topic ??= oneLine(row.topic) || null;
            if (!post.opening) post.opening = firstLine(row.caption).slice(0, OPENING_MAX);
            if (Number.isFinite(at)) post.publishedAt = Math.min(post.publishedAt, at);
        } else {
            posts.set(row.group_key, {
                key: row.group_key, views, skipRate: skip,
                title: oneLine(row.title) || null, topic: oneLine(row.topic) || null,
                opening: firstLine(row.caption).slice(0, OPENING_MAX),
                publishedAt: Number.isFinite(at) ? at : now,
            });
        }
    }
    // A repost is the same reel again: keep the one with more views.
    const reels = new Map<string, Reel>();
    for (const post of posts.values()) {
        const key = (post.title ?? post.opening).toLowerCase() || post.key;
        const kept = reels.get(key);
        if (!kept || post.views > kept.views) reels.set(key, post);
    }
    const all = [...reels.values()].filter((r) => r.title || r.opening);
    const best = [...all].sort((a, b) => b.views - a.views).slice(0, BEST_REELS);
    const settled = all.filter((r) => now - r.publishedAt >= SETTLE_DAYS * 86_400_000 && !best.includes(r));
    const worst = all.length < MIN_FOR_WORST ? [] : settled.sort((a, b) => a.views - b.views).slice(0, WORST_REELS);
    const strip = ({ views, skipRate, title, topic, opening }: Reel): ReelEvidence => ({ views, skipRate, title, topic, opening });
    return { best: best.map(strip), worst: worst.map(strip) };
}

/** One reel as a prompt line, with only what it has. */
export function evidenceLine(r: ReelEvidence): string {
    const numbers = [`${Math.round(r.views).toLocaleString('en-US')} views`];
    if (r.skipRate !== null) numbers.push(`skipped in 3s ${Number(r.skipRate.toFixed(1))}%`);
    const about = [
        ...(r.title ? [`title «${r.title}»`] : []),
        ...(r.topic ? [`topic «${r.topic}»`] : []),
        ...(r.opening ? [`opening «${r.opening}»`] : []),
    ];
    return `- ${numbers.join(', ')}: ${about.join('; ')}`;
}

/** Fail-soft: without the Growth hub's table the prompt just has no evidence. */
export async function loadReelEvidence(creatorId: string): Promise<ReelEvidenceSet> {
    try {
        const { rows } = await pool.query<ReelEvidenceRow>(REEL_EVIDENCE_SQL, [creatorId, EVIDENCE_DAYS]);
        return rankReels(rows);
    } catch {
        return { best: [], worst: [] };
    }
}
