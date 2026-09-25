/**
 * The Instagram reach levers a scheduled post can carry (GROWTH.md §4): alt text, collaborators
 * and trial reels. Only what the Content Publishing API documents, per
 * src/services/growth/README.md §1 "Content Publishing levers":
 *
 *   alt_text       single image, or each image child of a carousel; ≤ 1000 characters
 *   collaborators  up to 3 usernames; feed image, reel, carousel parent; never a story
 *   trial_params   reels only; { graduation_strategy: MANUAL | SS_PERFORMANCE }
 *
 * Stored in `scheduled_posts.meta_options` (v22), not `platform_options`, which is TikTok's.
 *
 * Two layers, on purpose:
 *   - `validateMetaOptions` runs at create and edit. It refuses malformed values with the
 *     sentence the dashboard shows, and drops a lever the post's type cannot use — the same
 *     way a stray `media_urls` on a non-carousel is ignored rather than refused.
 *   - `reachOptionsFor` runs at publish time and applies only what fits the row as it is then,
 *     so an edit that changed the type without resending the options stays harmless.
 */
import type { MetaPostOptions, TrialReelGraduation } from '../db/rows.js';
import type { InstagramReachOptions } from './instagram.js';

/** Instagram's documented limit ("up to 1000 character"). The Studio writes to a 200 budget. */
export const ALT_TEXT_MAX = 1000;
export const MAX_COLLABORATORS = 3;
/** Instagram's own carousel maximum, so `alt_texts` can never be longer than a carousel can be. */
const MAX_SLIDES = 10;
export const TRIAL_GRADUATIONS: readonly TrialReelGraduation[] = ['MANUAL', 'SS_PERFORMANCE'];

/** Instagram usernames: letters, digits, periods and underscores, at most 30. */
const USERNAME = /^[a-z0-9._]{1,30}$/;

/** The body fields that carry reach levers. */
export const META_OPTION_FIELDS = ['alt_text', 'alt_texts', 'collaborators', 'trial_reel'] as const;

export type MetaOptionsCheck =
    | { ok: true; options: MetaPostOptions | null }
    | { ok: false; error: string };

type Loose = Record<string, unknown>;

/** True when the body sends any lever, even as null (null clears it). */
export function sendsMetaOptions(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    return META_OPTION_FIELDS.some((k) => (body as Loose)[k] !== undefined);
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Which levers the post's effective platform and type can use. */
function applicable(platform: unknown, postType: unknown) {
    const instagram = platform === 'instagram' || platform === 'both';
    return {
        altText: instagram && postType === 'image',
        altTexts: instagram && postType === 'carousel',
        collaborators: instagram && ['image', 'video', 'reel', 'carousel'].includes(String(postType)),
        trialReel: instagram && (postType === 'video' || postType === 'reel'),
    };
}

function altTextProblem(value: string, label: string): string | null {
    return value.length > ALT_TEXT_MAX
        ? `${label} is ${value.length} characters; Instagram takes at most ${ALT_TEXT_MAX}.`
        : null;
}

/**
 * The levers in a create or edit body, over `current` (the stored options, on an edit). A field
 * the body leaves out keeps its current value, and null or blank clears it. `slideCount` is the
 * carousel's image count, when known, so `alt_texts` cannot outnumber the slides.
 */
export function validateMetaOptions(
    body: unknown,
    ctx: { platform: unknown; postType: unknown; slideCount?: number | null; current?: MetaPostOptions | null }
): MetaOptionsCheck {
    const b: Loose = body && typeof body === 'object' ? (body as Loose) : {};
    const next: MetaPostOptions = { ...(ctx.current ?? {}) };

    // alt_text — one image.
    if (b.alt_text !== undefined) {
        if (b.alt_text === null || (typeof b.alt_text === 'string' && !b.alt_text.trim())) {
            delete next.alt_text;
        } else if (typeof b.alt_text !== 'string') {
            return { ok: false, error: 'alt_text must be text.' };
        } else {
            const text = oneLine(b.alt_text);
            const problem = altTextProblem(text, 'The alt text');
            if (problem) return { ok: false, error: problem };
            next.alt_text = text;
        }
    }

    // alt_texts — one per carousel slide, in slide order.
    if (b.alt_texts !== undefined) {
        if (b.alt_texts === null) {
            delete next.alt_texts;
        } else if (!Array.isArray(b.alt_texts)) {
            return { ok: false, error: 'alt_texts must be a list, one entry per slide.' };
        } else {
            const limit = ctx.slideCount ?? MAX_SLIDES;
            if (b.alt_texts.length > limit) {
                return {
                    ok: false,
                    error: `alt_texts has ${b.alt_texts.length} entries, but the carousel has ${limit} slide${limit === 1 ? '' : 's'}.`,
                };
            }
            const texts: (string | null)[] = [];
            for (const [i, raw] of b.alt_texts.entries()) {
                if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
                    texts.push(null);
                    continue;
                }
                if (typeof raw !== 'string') return { ok: false, error: `The alt text for slide ${i + 1} must be text.` };
                const text = oneLine(raw);
                const problem = altTextProblem(text, `The alt text for slide ${i + 1}`);
                if (problem) return { ok: false, error: problem };
                texts.push(text);
            }
            while (texts.length && texts[texts.length - 1] === null) texts.pop();
            if (texts.length) next.alt_texts = texts;
            else delete next.alt_texts;
        }
    }

    // collaborators — up to 3 usernames.
    if (b.collaborators !== undefined) {
        if (b.collaborators === null) {
            delete next.collaborators;
        } else if (!Array.isArray(b.collaborators)) {
            return { ok: false, error: 'collaborators must be a list of Instagram usernames.' };
        } else {
            const names: string[] = [];
            for (const raw of b.collaborators) {
                if (typeof raw !== 'string') return { ok: false, error: 'collaborators must be a list of Instagram usernames.' };
                const name = raw.trim().replace(/^@+/, '').toLowerCase();
                if (!name) continue;
                if (!USERNAME.test(name)) {
                    return {
                        ok: false,
                        error: `«${raw.trim().slice(0, 40)}» is not an Instagram username: letters, numbers, periods and underscores, at most 30.`,
                    };
                }
                if (!names.includes(name)) names.push(name);
            }
            if (names.length > MAX_COLLABORATORS) {
                return { ok: false, error: `Instagram takes at most ${MAX_COLLABORATORS} collaborators — this post has ${names.length}.` };
            }
            if (names.length) next.collaborators = names;
            else delete next.collaborators;
        }
    }

    // trial_reel — { graduation } or null.
    if (b.trial_reel !== undefined) {
        if (b.trial_reel === null || b.trial_reel === false) {
            delete next.trial_reel;
        } else {
            const graduation = b.trial_reel && typeof b.trial_reel === 'object'
                ? (b.trial_reel as Loose).graduation
                : undefined;
            const upper = typeof graduation === 'string' ? graduation.trim().toUpperCase() : '';
            if (!(TRIAL_GRADUATIONS as readonly string[]).includes(upper)) {
                return { ok: false, error: `trial_reel.graduation must be ${TRIAL_GRADUATIONS.join(' or ')}.` };
            }
            next.trial_reel = { graduation: upper as TrialReelGraduation };
        }
    }

    // Levers this post cannot use are dropped, not refused (see the file comment).
    const fits = applicable(ctx.platform, ctx.postType);
    if (!fits.altText) delete next.alt_text;
    if (!fits.altTexts) delete next.alt_texts;
    if (!fits.collaborators) delete next.collaborators;
    if (!fits.trialReel) delete next.trial_reel;
    if (next.alt_texts && ctx.slideCount != null && next.alt_texts.length > ctx.slideCount) {
        next.alt_texts = next.alt_texts.slice(0, ctx.slideCount);
    }

    return { ok: true, options: Object.keys(next).length ? next : null };
}

const LEVER_NAMES: Record<string, string> = {
    alt_text: 'alt text',
    collaborators: 'collaborators',
    trial_params: 'the trial reel',
};

/**
 * The sentence a PUBLISHED row keeps in `error_log` when Instagram refused a lever and the post
 * went out without it, or null when nothing was refused. The row is not a failure, so the words
 * say what happened rather than what broke.
 */
export function droppedLeversNote(dropped: readonly { field: string; reason: string }[] | null | undefined): string | null {
    if (!dropped?.length) return null;
    const names = [...new Set(dropped.map((d) => LEVER_NAMES[d.field] ?? d.field))];
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]!;
    return `Published without ${list}: Instagram refused ${names.length > 1 ? 'them' : 'it'} for this account — ${dropped[0]!.reason}`;
}

/**
 * What the Instagram publisher should send for this row, as it is at publish time. A lever the
 * row's type cannot use is left out, whatever is stored.
 */
export function reachOptionsFor(platform: unknown, postType: unknown, stored: MetaPostOptions | null | undefined): InstagramReachOptions {
    if (!stored || typeof stored !== 'object') return {};
    const fits = applicable(platform, postType);
    const out: InstagramReachOptions = {};
    if (fits.altText && typeof stored.alt_text === 'string' && stored.alt_text) out.altText = stored.alt_text;
    if (fits.altTexts && Array.isArray(stored.alt_texts) && stored.alt_texts.some(Boolean)) out.altTexts = stored.alt_texts;
    if (fits.collaborators && Array.isArray(stored.collaborators) && stored.collaborators.length) {
        out.collaborators = stored.collaborators.slice(0, MAX_COLLABORATORS);
    }
    const graduation = stored.trial_reel?.graduation;
    if (fits.trialReel && graduation && (TRIAL_GRADUATIONS as readonly string[]).includes(graduation)) {
        out.trialReel = { graduation };
    }
    return out;
}
