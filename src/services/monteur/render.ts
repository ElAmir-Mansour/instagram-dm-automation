/**
 * What the worker needs to render one reel (MONTEUR.md §3 `monteur_render`): the cut, its words on
 * the clip's own clock, the hook, the CTA card's two lines, the brand (with the edits' style), the Editor's edits,
 * and — while `monteur.human` is on — its human touches.
 *
 * The same builder serves the first render and every re-render after an edit, so both cut the
 * words the same way and carry the same edits (the ones stored on the clip). A clip keeps the accent it was first rendered in; a new clip takes the next
 * palette colour not used by the tenant's latest reels, so neighbouring tiles in the grid differ.
 */
import type { ClipDirection, ClipEdit, MonteurRenderPayload, StudioSettings, TranscriptWord } from '../../db/rows.js';
import type { Exec } from '../studio/common.js';
import { pickAccents } from '../studio/generate.js';
import { humanTouchesOn } from './editor.js';

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
/** The platforms that cannot answer a comment with a DM, and so post the "link in bio" cut. */
export function needsLinkInBioCut(platforms: readonly string[]): boolean {
    return platforms.includes('tiktok') || platforms.includes('youtube');
}

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

/**
 * A clip's stored plan as the worker takes it (MONTEUR.md §3): `direction` holds the cuts, doodles,
 * freezes and transitions; the highlighter's word starts and the words behind the speaker ride
 * beside it, as `emphasis` and `behind`. A list missing from the stored plan is sent empty.
 */
export function touchFields(plan: ClipDirection): Required<Pick<MonteurRenderPayload, 'direction' | 'emphasis' | 'behind'>> {
    const list = <T>(v: readonly T[] | undefined): T[] => (Array.isArray(v) ? [...v] : []);
    return {
        direction: { cuts: list(plan.cuts), doodles: list(plan.doodles), freezes: list(plan.freezes), transitions: list(plan.transitions) },
        emphasis: list(plan.emphasis),
        behind: list(plan.behind),
    };
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
    /** The clip's stored edits (MONTEUR.md §6.2), already on its clock. */
    edits: readonly ClipEdit[];
    /** The clip's stored human touches (§6.2), on its clock; null or absent for none. */
    direction?: ClipDirection | null;
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
        // Only when TikTok or YouTube is on: a second render nobody would post is minutes of the
        // Mac's time. YouTube takes this cut too — it has no comment-to-DM, so "link in bio" is its CTA.
        cta_tiktok: needsLinkInBioCut(settings.monteur.platforms) ? tiktokCtaLines(settings) : null,
        // The edits' look, read at every render: a re-render after a change of style takes the new one.
        brand: { accent: input.accent, font: settings.brand.fonts.display, direction: settings.brand.direction, style: settings.monteur.style },
        cover_at: COVER_AT_S,
        edits: [...input.edits],
        // Read at every render, like the style: switched off, a re-render leaves them out. No plan
        // (a failed Editor call, a clip cut before v29 or while off) sends nothing new.
        ...(input.direction && humanTouchesOn(settings) ? touchFields(input.direction) : {}),
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
