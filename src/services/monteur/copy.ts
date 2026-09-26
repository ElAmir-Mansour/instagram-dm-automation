/**
 * The Marketer (MONTEUR.md §6.2): ONE Gemini call writes the copy for every clip of a video, and
 * code turns each answer into a `ClipCopy` with the Studio writer's own helpers, so a reel's
 * caption, keyword and DM follow exactly the rules a carousel's do:
 *
 *   keyword    `chooseKeyword` against the live campaigns' keywords, and the keywords this batch
 *              already took, so two reels of one video don't ask for overlapping words
 *   caption    `normalizeInstagramCaption`: the tenant's exact keyword ask and save line
 *   tiktok     `normalizeTiktokCaption`: no ask (TikTok can't auto-reply), the tenant's link line
 *   dm         `buildDm` over the tenant's template, `{username}` left for the webhook
 *   digits     `toArabicDigits` when the tenant writes Arabic-Indic digits
 *
 * A clip the answer leaves without a usable keyword is dropped rather than saved half-written.
 */
import type { ClipCopy, StudioLesson, StudioSettings } from '../../db/rows.js';
import { normalizeArabic } from '../../utils/arabic.js';
import {
    chooseKeyword, cleanVariants, normalizeInstagramCaption, normalizeTiktokCaption, toArabicDigits, trimText,
    type GeminiSchema, type GenContext,
} from '../studio/generate.js';
import { buildDm, languageKit, oneLine } from '../studio/prompts.js';
import { ask, emptyCost, type CallCost } from './model.js';
import { formatLines, type PickedClip, type TranscriptLine } from './transcript.js';

export const COPY_CALL_MS = 90_000;
const COPY_THINKING = 512;
/** Thinking, plus about 700 tokens of Arabic copy per clip. */
const copyMaxOutput = (clips: number): number => COPY_THINKING + 700 * Math.max(1, clips);
export const MAX_HASHTAGS = 5;
const ALT_TEXT_MAX = 300;
const VOICE_GUIDE_MAX = 2000;

const str = (description: string): GeminiSchema => ({ type: 'STRING', description });
const strs = (description: string): GeminiSchema => ({ type: 'ARRAY', items: { type: 'STRING' }, description });
const COPY_FIELDS = [
    'clip', 'first_line', 'body', 'tiktok_body', 'hashtags', 'keyword_candidates', 'variants', 'question', 'pitch', 'alt_text',
] as const;

export const COPY_SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: {
        clips: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    clip: { type: 'INTEGER', description: 'the clip\'s number, [n]' },
                    first_line: str('the caption\'s hook line, one emoji'),
                    body: str('1–3 short lines, each opening with an emoji'),
                    tiktok_body: str('the same for TikTok, ending with a question 👇'),
                    hashtags: strs('3–5, without #'),
                    keyword_candidates: strs('3 single words, best first'),
                    variants: strs('0–3 other spellings of the first candidate'),
                    question: str('one line opening the DM'),
                    pitch: str('one sentence'),
                    alt_text: str('one plain sentence'),
                },
                required: [...COPY_FIELDS],
                propertyOrdering: [...COPY_FIELDS],
            },
        },
    },
    required: ['clips'],
    propertyOrdering: ['clips'],
};

const strings = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
const line = (v: unknown): string => (typeof v === 'string' ? oneLine(v) : '');
/** Several lines kept as lines, each tidied, blank ones dropped. */
const block = (v: unknown): string =>
    (typeof v === 'string' ? v : '').replace(/\r\n?/g, '\n').split('\n').map(oneLine).filter(Boolean).join('\n');
const joinParas = (parts: readonly string[]): string => parts.filter((p) => p.trim()).join('\n\n');

function whoFor(settings: StudioSettings): string {
    const brand = settings.brand?.name?.trim();
    const product = settings.product?.name?.trim();
    const who = brand ? `«${brand}»` : 'a creator';
    return product ? `${who}, whose product is «${product}»` : who;
}

export function copySystemPrompt(settings: StudioSettings): string {
    const lang = languageKit(settings);
    const digits = settings.voice?.digits === 'arabic-indic'
        ? ' Use Arabic-Indic digits (٠-٩) in Arabic text.'
        : ' Use Latin digits.';
    const guide = (settings.voice?.guide ?? '').trim().slice(0, VOICE_GUIDE_MAX);
    return `You write the post copy for short vertical reels by ${whoFor(settings)}. Answer with JSON only, everything in ${lang.name}.${digits}
For each clip:
- first_line: the hook as the caption's first line, with one emoji. Instagram search reads it: name the topic in the words people search for.
- body: 1-3 short lines of value from the clip, each opening with an emoji.
- tiktok_body: the same for TikTok, ending with a question to the viewer 👇. No time words (${lang.timeWords.slice(0, 4).join(', ')}).
- hashtags: 3-5 topical hashtags, without #.
- keyword_candidates: 3 single easy ${lang.name} words tied to the clip's topic, best first, like ${lang.keywordExamples}: viewers comment one to get the link by DM.
- variants: 0-3 other spellings of the first candidate, one word each.
- question: one line that opens the DM, about the clip's topic.
- pitch: one sentence tying the topic to the product.
- alt_text: one plain sentence on what the video shows, for screen readers. No hashtags, no emoji.
Use only what the clip says and the product facts. Invent nothing.
The creator's voice guide wins where it differs:
<voice>
${guide || '(none: write plainly and warmly)'}
</voice>`;
}

export function copyUserPrompt(args: {
    clips: readonly PickedClip[];
    lines: readonly TranscriptLine[];
    settings: StudioSettings;
    lessons: readonly StudioLesson[];
    activeKeywords: readonly string[];
    seo?: GenContext['seo'];
}): string {
    const { clips, lines, settings, lessons, activeKeywords, seo } = args;
    const facts = strings(settings.product?.facts);
    const avoid = strings(settings.voice?.avoid);
    const searchTerms = strings(seo?.keywords).slice(0, 8);
    const tags = strings(seo?.hashtags).slice(0, 15);
    const out: string[] = [
        facts.length
            ? `Product: «${settings.product.name || 'the product'}». Facts: ${facts.join(' · ')}`
            : 'There are no product facts: state no numbers about the product.',
        activeKeywords.length
            ? `Active keywords: ${activeKeywords.slice(0, 60).join(', ')}. A new keyword must neither contain nor sit inside one of these; one that fits the topic may be reused exactly.`
            : 'There are no active keywords yet.',
    ];
    if (searchTerms.length) out.push(`Search terms this audience types: ${searchTerms.map((k) => `«${k}»`).join(', ')}. Put one in first_line where it fits.`);
    if (tags.length) out.push(`Prefer hashtags from: ${tags.join(' ')}`);
    if (lessons.length) out.push('Lessons from past reels:', ...lessons.map((l) => `- ${l.rule}`));
    if (avoid.length) out.push(`Never mention: ${avoid.join(', ')}.`);
    out.push('Clips:');
    clips.forEach((clip, i) => {
        out.push(`[${i + 1}] «${clip.title}»`, formatLines(lines.slice(clip.startLine - 1, clip.endLine)));
    });
    return out.join('\n');
}

/** 3–5 hashtags without '#': one token each, de-duplicated regardless of case. */
export function cleanHashtags(raw: unknown): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tag of strings(raw)) {
        const t = tag.replace(/^#+/, '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '');
        if (!t || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        out.push(t);
        if (out.length === MAX_HASHTAGS) break;
    }
    return out;
}

export type CopyOutcome = { copy: ClipCopy } | { error: string };

/**
 * One answer as a `ClipCopy`. `taken` is the keywords earlier clips of this batch chose; a new one
 * chosen here is added to it. A keyword equal to a sibling's is shared (the campaign is created
 * once, by whichever reel is approved first) and still marked for creation, so neither reel
 * depends on the other being approved.
 */
export function toClipCopy(
    item: unknown, clip: Pick<PickedClip, 'title'>, settings: StudioSettings, active: readonly string[], taken: string[]
): CopyOutcome {
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const digits = settings.voice?.digits === 'arabic-indic' ? toArabicDigits : (s: string) => s;
    const lang = languageKit(settings);

    const candidates = strings(r.keyword_candidates);
    const { choice, rejected } = chooseKeyword(candidates, [...active, ...taken]);
    if (!choice) {
        return { error: `No usable comment keyword (${rejected.join('; ') || 'none given'}).` };
    }
    const n = normalizeArabic(choice.keyword);
    const shared = taken.some((t) => normalizeArabic(t) === n);
    const create = choice.create || shared;
    const variants = choice.create ? cleanVariants(r.variants, choice.keyword, [...active, ...taken]) : [];
    if (choice.create) taken.push(choice.keyword);

    const hashtags = cleanHashtags(r.hashtags);
    const tagLine = hashtags.map((t) => `#${t}`).join(' ');
    const first = digits(line(r.first_line)) || clip.title;
    const caption = normalizeInstagramCaption(
        joinParas([first, digits(block(r.body)), tagLine]), choice.keyword, candidates, settings,
    );
    const tiktok = normalizeTiktokCaption(
        joinParas([first, digits(block(r.tiktok_body)), tagLine]), [...candidates, choice.keyword], settings,
    );
    const dm = buildDm(settings.cta?.dmTemplate ?? '', {
        question: digits(line(r.question)) || lang.fallbackQuestion,
        pitch: digits(line(r.pitch)) || lang.fallbackPitch,
        url: settings.product?.url ?? '',
        bullets: settings.product?.dmBullets ?? [],
    });
    return {
        copy: {
            caption,
            tiktok_caption: tiktok,
            hashtags,
            keyword: choice.keyword,
            variants,
            keyword_create: create,
            dm,
            alt_text: trimText(digits(line(r.alt_text)), ALT_TEXT_MAX) || clip.title,
        },
    };
}

export interface CopyResult {
    /** One per clip, in the clips' order. */
    outcomes: CopyOutcome[];
    cost: CallCost;
}

/** The copy for every clip of one video, in one call. */
export async function writeCopy(
    clips: readonly PickedClip[],
    lines: readonly TranscriptLine[],
    settings: StudioSettings,
    ctx: Pick<GenContext, 'activeKeywords' | 'seo'>,
    lessons: readonly StudioLesson[],
    deadline: number,
): Promise<CopyResult> {
    const cost = emptyCost();
    const raw = await ask({
        purpose: 'monteur.copy',
        system: copySystemPrompt(settings),
        turns: [{ role: 'user', text: copyUserPrompt({ clips, lines, settings, lessons, activeKeywords: ctx.activeKeywords, seo: ctx.seo }) }],
        schema: COPY_SCHEMA,
        temperature: 0.7,
        thinkingBudget: COPY_THINKING,
        maxOutputTokens: copyMaxOutput(clips.length),
        capMs: COPY_CALL_MS,
    }, deadline, cost);
    const items = raw && typeof raw === 'object' && Array.isArray((raw as { clips?: unknown }).clips)
        ? (raw as { clips: unknown[] }).clips
        : [];
    const numbered = (n: number) => items.find((it) => it && typeof it === 'object' && (it as { clip?: unknown }).clip === n);
    const taken: string[] = [];
    const outcomes = clips.map((clip, i): CopyOutcome => {
        const item = numbered(i + 1) ?? items[i];
        if (!item) return { error: 'The Marketer wrote nothing for this clip.' };
        return toClipCopy(item, clip, settings, ctx.activeKeywords, taken);
    });
    return { outcomes, cost };
}
