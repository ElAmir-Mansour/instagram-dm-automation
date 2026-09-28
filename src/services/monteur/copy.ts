/**
 * The Marketer (MONTEUR.md §6 and §6.1): ONE Gemini call writes the copy for every clip of a
 * video, and code assembles each `ClipCopy`:
 *
 *   keyword    one word of 4+ letters, chosen with the Studio's `chooseKeyword` against the live
 *              campaigns' keywords and every keyword a reel in flight already asks for
 *   caption    first_line, body, the ask (the model's `ask_line` with «keyword»), hashtags. One
 *              ask per post: no save line, and any other ask the model wrote is stripped. An ask
 *              without {keyword}, or too like the tenant's last 5, falls back to a built-in pool
 *              of question-style asks — never to `cta.instagramAsk`
 *   tiktok     first_line, tiktok_body, the tenant's TikTok line, hashtags, through the Studio's
 *              `normalizeTiktokCaption`: TikTok can't auto-reply, so no ask
 *   hashtags   3–5, none of the reach-bait tags, at least one Arabic tag for an Arabic tenant
 *   dm         `buildDm` over the tenant's template, `{username}` left for the webhook
 *   digits     `toArabicDigits` when the tenant writes Arabic-Indic digits
 *
 * A clip the answer leaves without a usable keyword is dropped rather than saved half-written.
 */
import type { ClipCopy, StudioLesson, StudioSettings } from '../../db/rows.js';
import { normalizeArabic } from '../../utils/arabic.js';
import {
    chooseKeyword, cleanVariants, normalizeTiktokCaption, toArabicDigits, trimText, type GeminiSchema, type GenContext,
} from '../studio/generate.js';
import { buildDm, languageKit, oneLine } from '../studio/prompts.js';
import { ask, emptyCost, type CallCost } from './model.js';
import { thinkRoute, type ThinkOn } from './think.js';
import { formatLines, textOverlap, tokens, type PickedClip, type TranscriptLine } from './transcript.js';

export const COPY_CALL_MS = 90_000;
const COPY_THINKING = 512;
/** Thinking counts toward the cap and may run past its budget: see PICK_MAX_OUTPUT. */
export const COPY_MAX_OUTPUT = 8192;
export const MAX_HASHTAGS = 5;
const MAX_HASHTAG_LENGTH = 30;
export const MAX_FIRST_LINE = 60;
/** §6.1: a keyword shorter than this fires on too much. */
export const MIN_KEYWORD_LETTERS = 4;
/** §6.1: an ask this like one of the tenant's last 5 is a repeat. */
export const ASK_OVERLAP = 0.6;
const ALT_TEXT_MAX = 300;
const VOICE_GUIDE_MAX = 2000;
/** §6.1: tags that ask for reach rather than name the topic. Compared without the #, case-folded. */
export const HASHTAG_BLOCKLIST: readonly string[] = ['اكسبلور', 'explore', 'fyp', 'foryou'];
/**
 * Tags too broad to name a clip's topic. The first live reel (2026-09-27) got exactly these four
 * (#تقنية #تطوير #برمجة #تعلم) for a clip about Gemini's custom instructions: they are dropped
 * whenever the clip has enough real topic tags, and the tools named in its title are added.
 */
export const GENERIC_HASHTAGS: readonly string[] = ['تقنية', 'تكنولوجيا', 'تطوير', 'برمجة', 'تعلم', 'تعليم', 'tech', 'technology', 'learning', 'education'];
const MIN_TOPIC_TAGS = 2;
/** A tool or product named in Latin script, e.g. Gemini, ChatGPT, n8n: a tag people search. */
const LATIN_TERM = /\b[A-Za-z][A-Za-z0-9.+-]{2,24}\b/g;
/** Words that are Latin but name no topic. */
const LATIN_STOP = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'how', 'why', 'what', 'from', 'this', 'that', 'agent', 'agents', 'prompt', 'prompts']);

/** The tools named in `text` (the clip's title and first line), as tags, first mention first. */
export function termTags(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(LATIN_TERM)) {
        const term = m[0].replace(/[.+-]+$/, '');
        // A tool's name has a capital or a digit (Gemini, ChatGPT, n8n); plain English words don't.
        if (term.length < 3 || LATIN_STOP.has(term.toLowerCase()) || !/[A-Z0-9]/.test(term)) continue;
        if (!out.some((t) => t.toLowerCase() === term.toLowerCase())) out.push(term);
    }
    return out;
}

/** Question-style asks for when the model's own can't be used, per language. `{keyword}` is filled. */
export const ASK_POOL: Record<'ar' | 'en', readonly string[]> = {
    ar: [
        'تبي الرابط؟ اكتب «{keyword}» ويوصلك بالخاص 📩',
        'حاب تطبقها بنفسك؟ علّق «{keyword}» وأرسل لك التفاصيل 📩',
        'تحتاج الشرح كامل؟ اكتب «{keyword}» ويجيك بالخاص 👇',
        'ودك بالخطوات؟ علّق «{keyword}» وتوصلك رسالة مني 📩',
        'تبي تجربها؟ اكتب «{keyword}» بالتعليقات 👇',
    ],
    en: [
        'Want the link? Comment «{keyword}» and I\'ll DM it to you 📩',
        'Want to try it yourself? Comment «{keyword}» 👇',
        'Need the full walkthrough? Comment «{keyword}» and check your DMs 📩',
        'Want the steps? Comment «{keyword}» and I\'ll send them 👇',
        'Should I send you the details? Comment «{keyword}» 📩',
    ],
};

const str = (description: string): GeminiSchema => ({ type: 'STRING', description });
const strs = (description: string): GeminiSchema => ({ type: 'ARRAY', items: { type: 'STRING' }, description });
const COPY_FIELDS = [
    'clip', 'first_line', 'body', 'ask_line', 'tiktok_body', 'hashtags', 'keyword_candidates', 'variants', 'question', 'pitch', 'alt_text',
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
                    first_line: str(`at most ${MAX_FIRST_LINE} characters`),
                    body: str('1–3 short lines'),
                    ask_line: str('a question, then «{keyword}»'),
                    tiktok_body: str('one descriptive sentence'),
                    hashtags: strs('3–5, without #'),
                    keyword_candidates: strs('3 single words of 4+ letters, best first'),
                    variants: strs('0–3 other spellings of the first candidate'),
                    question: str('one line opening the DM'),
                    pitch: str('one sentence'),
                    alt_text: str('at most 2 sentences'),
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
const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;
const isArabic = (s: string): boolean => /[؀-ۿ]/.test(s);

function whoFor(settings: StudioSettings): string {
    const brand = settings.brand?.name?.trim();
    const product = settings.product?.name?.trim();
    const who = brand ? `«${brand}»` : 'a creator';
    return product ? `${who}, whose product is «${product}»` : who;
}

export function copySystemPrompt(settings: StudioSettings): string {
    const lang = languageKit(settings);
    const ar = settings.voice?.language === 'ar';
    const digits = settings.voice?.digits === 'arabic-indic' ? ' Use Arabic-Indic digits (٠-٩) in Arabic text.' : ' Use Latin digits.';
    const guide = (settings.voice?.guide ?? '').trim().slice(0, VOICE_GUIDE_MAX);
    return `You write the post copy for short vertical reels by ${whoFor(settings)}. Answer with JSON only, in ${lang.name}.${digits}
For each clip:
- first_line: at most ${MAX_FIRST_LINE} characters: the result or problem, naming the topic once the way people search it. One language. Not the title. No hype, no ask.
- body: 1-3 short lines: the takeaway worth forwarding. Never "share this".
- ask_line: a question, then «{keyword}», written so it fits any of the candidates. Not one of the recent asks listed.
- keyword_candidates: 3 single ${lang.name} words of 4 or more letters, best first, tied to what the DM sends, like ${lang.keywordExamples}.
- variants: 0-3 other spellings of the first candidate, one word each.
- hashtags: 3-5 tags without # naming this clip's topic: the tool it shows (Gemini, ChatGPT) and the subject${ar ? ' (الذكاء_الاصطناعي), mostly Arabic' : ''}. Never generic tags (${ar ? '#تقنية #تعلم #برمجة' : '#tech #learning'}) nor #اكسبلور #explore #fyp #foryou.
- tiktok_body: one descriptive sentence with the topic words. No ask and no link: the link line is added for you.
- question: one line that opens the DM, about the clip's topic. pitch: one sentence tying the topic to the product.
- alt_text: ${ar ? 'neutral MSA, ' : ''}at most 2 sentences: ${ar ? '«متحدث يشرح …»' : '"A speaker explains …"'} plus what the clip says. No hashtags, no ask.
Invent nothing: only the numbers, tools and results the clip says, and the product facts.
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
    recentAsks?: readonly string[];
    seo?: GenContext['seo'];
}): string {
    const { clips, lines, settings, lessons, activeKeywords, seo } = args;
    const facts = strings(settings.product?.facts);
    const avoid = strings(settings.voice?.avoid);
    const searchTerms = strings(seo?.keywords).slice(0, 8);
    const tags = strings(seo?.hashtags).slice(0, 15);
    const recent = strings(args.recentAsks).slice(0, 5);
    const out: string[] = [
        facts.length
            ? `Product: «${settings.product.name || 'the product'}». Facts: ${facts.join(' · ')}`
            : 'There are no product facts: state no numbers about the product.',
        activeKeywords.length
            ? `Keywords in use: ${activeKeywords.slice(0, 60).join(', ')}. A new keyword must neither contain nor sit inside one of these; one that fits the topic may be reused exactly.`
            : 'No keywords are in use yet.',
    ];
    if (recent.length) out.push('Recent asks (don\'t reuse):', ...recent.map((a) => `- ${a}`));
    if (searchTerms.length) out.push(`Search terms this audience types: ${searchTerms.map((k) => `«${k}»`).join(', ')}.`);
    if (tags.length) out.push(`Prefer hashtags from: ${tags.join(' ')}`);
    if (lessons.length) out.push('Lessons from past reels:', ...lessons.map((l) => `- ${l.rule}`));
    if (avoid.length) out.push(`Never mention: ${avoid.join(', ')}.`);
    out.push('Clips:');
    clips.forEach((clip, i) => {
        out.push(`[${i + 1}] «${clip.title}»`, formatLines(lines.slice(clip.startLine - 1, clip.endLine)));
    });
    return out.join('\n');
}

/**
 * 3–5 hashtags without '#': one token each, none on the blocklist, de-duplicated regardless of
 * case. An Arabic tenant gets at least one Arabic tag, from its own sets when the model gave none.
 */
export function cleanHashtags(
    raw: unknown, settings?: StudioSettings, fallback: readonly string[] = [], topics: readonly string[] = [],
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (tag: string, front = false): void => {
        const t = tag.replace(/^#+/, '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '');
        const key = normalizeArabic(t);
        if (!t || t.length > MAX_HASHTAG_LENGTH || seen.has(key) || HASHTAG_BLOCKLIST.includes(key)) return;
        seen.add(key);
        if (front) out.unshift(t);
        else out.push(t);
    };
    for (const tag of strings(raw)) add(tag);
    const generic = new Set(GENERIC_HASHTAGS.map((g) => normalizeArabic(g).toLowerCase()));
    const isGeneric = (t: string) => generic.has(normalizeArabic(t).toLowerCase());
    for (const term of topics) add(term, true);
    if (out.filter((t) => !isGeneric(t)).length >= MIN_TOPIC_TAGS) {
        for (let i = out.length - 1; i >= 0; i--) if (isGeneric(out[i]!)) out.splice(i, 1);
    }
    if (settings?.voice?.language === 'ar' && !out.some(isArabic)) {
        const arabic = strings(fallback).find(isArabic);
        if (arabic) add(arabic, true);
    }
    return out.slice(0, MAX_HASHTAGS);
}

/**
 * The TikTok body without its own "link in bio": the tenant's TikTok line adds that, and the first
 * live reel said it twice («…، ورابطه في البايو.» and then «رابطه في البايو 🔗»).
 */
export function withoutBioLink(text: string): string {
    return text
        .replace(/[،,]?\s*و?(?:ال)?رابط(?:ه|ها)?\s+(?:في|ف|ب)\s*(?:ال)?بايو/g, '')
        .replace(/[,;]?\s*(?:and\s+)?(?:the\s+)?link(?:'s| is)?\s+in\s+(?:my\s+|the\s+)?bio/gi, '')
        .replace(/\s+([.!؟?])/g, '$1')
        .trim();
}

/** The ask as a template: its «keyword» (in any quote, or bare {keyword}) as «{keyword}». */
export function askTemplate(askLine: string, keyword?: string): string {
    let t = askLine.replace(/[«"“]?\s*\{keyword\}\s*[»"”]?/g, '«{keyword}»');
    if (keyword) t = t.split(`«${keyword}»`).join('«{keyword}»');
    return oneLine(t);
}

const askWords = (t: string): string => t.replace(/«\{keyword\}»|\{keyword\}/g, ' ');

/**
 * The ask this clip posts with, as a template: the model's when it has {keyword} and isn't one of
 * the last asks said again; else the first pool ask neither recent nor already used in this batch.
 */
export function chooseAsk(
    modelAsk: string, recentAsks: readonly string[], used: readonly string[], language: 'ar' | 'en', turn: number
): string {
    const recent = [...recentAsks, ...used];
    const own = askTemplate(modelAsk);
    const tooLike = (t: string) => recent.some((r) => textOverlap(askWords(t), askWords(r)) >= ASK_OVERLAP);
    if (own.includes('«{keyword}»') && !tooLike(own)) return own;
    const pool = ASK_POOL[language];
    for (let k = 0; k < pool.length; k++) {
        const candidate = pool[(turn + k) % pool.length]!;
        if (!recent.includes(candidate)) return candidate;
    }
    return pool[turn % pool.length]!;
}

export type CopyOutcome = { copy: ClipCopy; ask: string } | { error: string };

export interface CopyContext {
    /** Keywords live campaigns answer. */
    activeKeywords: readonly string[];
    /** Variants of reels in flight: no keyword may be one of them, nor overlap one. */
    inFlightVariants?: readonly string[];
    seo?: GenContext['seo'];
    /** The tenant's last asks, as templates, newest first. */
    recentAsks?: readonly string[];
}

/**
 * One answer as a `ClipCopy`. `taken` holds the keywords reels in flight already ask for, and this
 * batch's; a new one chosen here is added to it. A keyword equal to one in flight is shared (the
 * campaign is created once, by whichever reel is approved first); one overlapping it is refused.
 */
export function toClipCopy(
    item: unknown, clip: Pick<PickedClip, 'title'>, settings: StudioSettings, ctx: CopyContext, taken: string[], usedAsks: string[], turn = 0,
): CopyOutcome {
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const digits = settings.voice?.digits === 'arabic-indic' ? toArabicDigits : (s: string) => s;
    const lang = languageKit(settings);
    const language = settings.voice?.language === 'ar' ? 'ar' : 'en';

    // Equal to another reel's variant would make two campaigns answer one word: never shared.
    const theirVariants = new Set((ctx.inFlightVariants ?? []).map((v) => normalizeArabic(v)));
    const candidates = strings(r.keyword_candidates)
        .filter((k) => letters(k) >= MIN_KEYWORD_LETTERS && !theirVariants.has(normalizeArabic(k)));
    const { choice, rejected } = chooseKeyword(candidates, [...ctx.activeKeywords, ...taken, ...(ctx.inFlightVariants ?? [])]);
    if (!choice) {
        const short = strings(r.keyword_candidates).filter((k) => letters(k) < MIN_KEYWORD_LETTERS);
        const reasons = [...rejected, ...short.map((k) => `«${k}» is under ${MIN_KEYWORD_LETTERS} letters`)];
        return { error: `No usable comment keyword (${reasons.join('; ') || 'none given'}).` };
    }
    const keyword = choice.keyword;
    const n = normalizeArabic(keyword);
    const shared = taken.some((t) => normalizeArabic(t) === n);
    const variants = choice.create ? cleanVariants(r.variants, keyword, [...ctx.activeKeywords, ...taken, ...(ctx.inFlightVariants ?? [])]) : [];
    if (choice.create) taken.push(keyword);

    const template = chooseAsk(line(r.ask_line), ctx.recentAsks ?? [], usedAsks, language, turn);
    usedAsks.push(template);
    const ask = digits(template.split('{keyword}').join(keyword));
    // One ask per post: a line naming a quoted keyword anywhere else is another ask.
    const quoted = new Set([keyword, ...candidates].map((k) => normalizeArabic(k)));
    const notAnAsk = (l: string): boolean => {
        if (l.includes('{keyword}')) return false;
        const inQuotes = [...l.matchAll(/[«"“]\s*([^»"”]+?)\s*[»"”]/g)].map((m) => normalizeArabic(m[1]!));
        return !inQuotes.some((q) => quoted.has(q));
    };
    const keepLines = (text: string): string => text.split('\n').filter(notAnAsk).join('\n');

    const hashtags = cleanHashtags(r.hashtags, settings, ctx.seo?.hashtags ?? [], termTags(`${clip.title} ${line(r.first_line)}`));
    const tagLine = hashtags.map((t) => `#${t}`).join(' ');
    const first = keepLines(trimText(digits(line(r.first_line)), MAX_FIRST_LINE)) || clip.title;
    const caption = joinParas([first, keepLines(digits(block(r.body))), ask, tagLine]);
    const tiktok = normalizeTiktokCaption(
        joinParas([first, withoutBioLink(keepLines(digits(block(r.tiktok_body)))), tagLine]), [...candidates, keyword], settings,
    );
    const dm = buildDm(settings.cta?.dmTemplate ?? '', {
        question: digits(line(r.question)) || lang.fallbackQuestion,
        pitch: digits(line(r.pitch)) || lang.fallbackPitch,
        url: settings.product?.url ?? '',
        bullets: settings.product?.dmBullets ?? [],
    });
    return {
        ask: template,
        copy: {
            caption,
            tiktok_caption: tiktok,
            hashtags,
            keyword,
            variants,
            keyword_create: choice.create || shared,
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

/**
 * The copy for every clip of one video, in one call. When the model numbers its answers, an
 * answer is matched by its number only: falling back to position would give a clip the model
 * skipped its neighbour's copy. `think` sends the call to Claude on the Mac.
 */
export async function writeCopy(
    clips: readonly PickedClip[],
    lines: readonly TranscriptLine[],
    settings: StudioSettings,
    ctx: CopyContext & { inFlightKeywords?: readonly string[] },
    lessons: readonly StudioLesson[],
    deadline: number,
    think?: ThinkOn,
): Promise<CopyResult> {
    const cost = emptyCost();
    const raw = await ask({
        purpose: 'monteur.copy',
        system: copySystemPrompt(settings),
        turns: [{
            role: 'user',
            text: copyUserPrompt({
                clips, lines, settings, lessons,
                activeKeywords: [...ctx.activeKeywords, ...(ctx.inFlightKeywords ?? []), ...(ctx.inFlightVariants ?? [])],
                recentAsks: ctx.recentAsks, seo: ctx.seo,
            }),
        }],
        schema: COPY_SCHEMA,
        temperature: 0.7,
        thinkingBudget: COPY_THINKING,
        maxOutputTokens: COPY_MAX_OUTPUT,
        capMs: COPY_CALL_MS,
        think: thinkRoute(think, 'monteur.copy', 'copy'),
    }, deadline, cost);
    const items = raw && typeof raw === 'object' && Array.isArray((raw as { clips?: unknown }).clips)
        ? (raw as { clips: unknown[] }).clips
        : [];
    const numbered = items.some((it) => it && typeof it === 'object' && Number.isInteger((it as { clip?: unknown }).clip));
    const byNumber = (n: number) => items.find((it) => it && typeof it === 'object' && (it as { clip?: unknown }).clip === n);
    const taken: string[] = [...(ctx.inFlightKeywords ?? [])];
    const usedAsks: string[] = [];
    const outcomes = clips.map((clip, i): CopyOutcome => {
        const item = numbered ? byNumber(i + 1) : items[i];
        if (!item) return { error: 'The Marketer wrote nothing for this clip.' };
        return toClipCopy(item, clip, settings, ctx, taken, usedAsks, (ctx.recentAsks?.length ?? 0) + i);
    });
    return { outcomes, cost };
}

/** The ask in a caption, as a template: the line holding «keyword». Null when there is none. */
export function askOf(caption: string, keyword: string): string | null {
    const l = caption.split('\n').find((x) => x.includes(`«${keyword}»`));
    return l ? askTemplate(l, keyword) : null;
}

/** Whether a word counts as a keyword at all: one word of 4+ letters. */
export function keywordLongEnough(keyword: string): boolean {
    return letters(keyword) >= MIN_KEYWORD_LETTERS && tokens(keyword).length === 1;
}
