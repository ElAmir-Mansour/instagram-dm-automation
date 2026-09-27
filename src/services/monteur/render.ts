/**
 * What the worker needs to render one reel (MONTEUR.md §3 `monteur_render`): the cut, its words on
 * the clip's own clock, the hook, the CTA card's two lines, and the brand.
 *
 * The same builder serves the first render and every re-render after an edit, so both cut the
 * words the same way. A clip keeps the accent it was first rendered in; a new clip takes the next
 * palette colour not used by the tenant's latest reels, so neighbouring tiles in the grid differ.
 */
import type { MonteurRenderPayload, StudioSettings, TranscriptWord } from '../../db/rows.js';
import type { Exec } from '../studio/common.js';
import { pickAccents } from '../studio/generate.js';

/** Seconds into the clip. The title is on screen from frame 0 anyway; this avoids a mid-blink frame. */
export const COVER_AT_S = 0.5;
/** How many recent reels a new accent avoids. */
const RECENT_ACCENTS = 3;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The CTA overlay (MONTEUR.md §3): line 1 is the slide's short ask with «keyword» — never the
 * caption's long one — and line 2 the slide's "and I'll DM you the link".
 */
export function ctaLines(settings: StudioSettings, keyword: string): { line1: string; line2: string } {
    const ask = settings.cta?.slide?.igAsk?.trim() ?? '';
    return { line1: ask ? `${ask} «${keyword}»` : `«${keyword}»`, line2: settings.cta?.slide?.igSub?.trim() ?? '' };
}

/**
 * TikTok's CTA for its own cut: TikTok can't auto-DM, so its video must not say "comment X". The
 * slide's pill ("link in bio") and its sub-line.
 */
export function tiktokCtaLines(settings: StudioSettings): { line1: string; line2: string } {
    return { line1: settings.cta?.slide?.ttPill?.trim() ?? '', line2: settings.cta?.slide?.ttSub?.trim() ?? '' };
}

/**
 * The words that start inside [start, end), on the clip's clock (0 = `start`), each ending by the
 * clip's end. A word that starts in the lead-in belongs to the clip; one that ended before it does
 * not, even if its tail is audible.
 */
export function clipWords(words: readonly TranscriptWord[], start: number, end: number): TranscriptWord[] {
    const length = round2(end - start);
    return words
        .filter(([t0]) => t0 >= start && t0 < end)
        .map(([t0, t1, text]) => [round2(t0 - start), Math.min(length, round2(t1 - start)), text] as TranscriptWord);
}

export function buildRenderPayload(input: {
    clipId: string;
    source: { id: string; path: string; words: readonly TranscriptWord[] | null };
    start: number;
    end: number;
    title: string;
    keyword: string;
    accent: string;
    settings: StudioSettings;
}): MonteurRenderPayload {
    const { settings } = input;
    return {
        clipId: input.clipId,
        sourceId: input.source.id,
        path: input.source.path,
        start: input.start,
        end: input.end,
        title: input.title,
        words: clipWords(input.source.words ?? [], input.start, input.end),
        cta: ctaLines(settings, input.keyword),
        // Only when TikTok is on: a second render nobody would post is minutes of the Mac's time.
        cta_tiktok: settings.monteur.platforms.includes('tiktok') ? tiktokCtaLines(settings) : null,
        brand: { accent: input.accent, font: settings.brand.fonts.display, direction: settings.brand.direction },
        cover_at: COVER_AT_S,
    };
}

/** The accents of the tenant's latest reels, newest first. */
export async function recentReelAccents(exec: Exec, creatorId: string): Promise<string[]> {
    const { rows } = await exec.query<{ accent: string | null }>(
        `SELECT payload->'brand'->>'accent' AS accent FROM studio_jobs
          WHERE creator_id = $1 AND kind = 'monteur_render'
          ORDER BY created_at DESC
          LIMIT 12`,
        [creatorId]
    );
    return [...new Set(rows.map((r) => r.accent).filter((a): a is string => Boolean(a)))].slice(0, RECENT_ACCENTS);
}

/** The accent a clip was last rendered in, so an edit keeps its look. */
export async function clipAccent(exec: Exec, creatorId: string, clipId: string): Promise<string | null> {
    const { rows } = await exec.query<{ accent: string | null }>(
        `SELECT payload->'brand'->>'accent' AS accent FROM studio_jobs
          WHERE creator_id = $1 AND kind = 'monteur_render' AND payload->>'clipId' = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [creatorId, clipId]
    );
    return rows[0]?.accent ?? null;
}

/** `k` accents for new clips, each avoiding the recent ones and the ones before it. */
export async function accentsFor(exec: Exec, creatorId: string, settings: StudioSettings, k: number): Promise<string[]> {
    return pickAccents(k, settings.brand.palette, await recentReelAccents(exec, creatorId));
}
