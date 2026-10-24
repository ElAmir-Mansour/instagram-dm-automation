/**
 * The rules of an explainer draft, as pure functions (data-model.md §1; spec FR-003 to FR-008, FR-013): how many scenes a length tier has, how
 * long a script takes to say, what a draft must hold, and the two guards on what it may say or show. No database, no clock, no network: the same
 * draft always gets the same answer, so the writer's answer, an owner's edit and a picture prompt are all held to one list.
 *
 * `checkDraft` sorts what it finds into two lists:
 *
 *   problems   the draft breaks a rule the rest of the pipeline relies on or a content rule: a field past the limit the voice, the label tag or
 *              the picture prompt were built for, a closing line that is not a question, engagement bait, a woman in a picture brief. Whoever
 *              applies the writer's answer asks again or refuses it; an owner's save that carries one is refused.
 *   warnings   the owner may still approve over these: a script that runs short or long, a scene count outside its tier, too few sources. They
 *              are stored with the draft and shown beside it (the edge case "the script is too long or too short" is a warning, not a refusal).
 *
 * Each finding has a stable `code` (what the dashboard translates), an English `message`, and where it applies the 0-based `scene` and the
 * `field`. A rule that was missed gets a new case and a test here, never a special case in a route.
 */
import type { ExplainerLanguage, ExplainerLengthTier } from '../../db/rows.js';
import { normalizeArabic, normalizeArabicWithMap } from '../../utils/arabic.js';
import { DEFAULT_EXPLAINER_PACE } from '../studio/settingsTypes.js';

export type Range = { readonly min: number; readonly max: number };

export const LENGTH_TIERS: readonly ExplainerLengthTier[] = ['short', 'medium', 'long'];

/** Scenes per length tier (data-model §1): one sentence each, so a tier's bounds follow from its length. */
export const SCENE_BOUNDS = {
    short: { min: 10, max: 30 },
    medium: { min: 30, max: 90 },
    long: { min: 120, max: 300 },
} as const satisfies Record<ExplainerLengthTier, Range>;

/** The most scenes any explainer holds: the writer schema's `maxItems`, and the top of the long tier. */
export const MAX_SCENES = 300;

/**
 * The seconds a script's estimate is held to. A little wider than the tier it is named for (60-90 s, 3-5 min, 10-15 min): the estimate is
 * words ÷ pace, not a measurement, and the voiced audio is the truth.
 */
export const DURATION_RANGE_S = {
    short: { min: 55, max: 95 },
    medium: { min: 170, max: 310 },
    long: { min: 570, max: 930 },
} as const satisfies Record<ExplainerLengthTier, Range>;

/** How a tier is named in a sentence the owner reads. */
const TIER_TARGET: Readonly<Record<ExplainerLengthTier, string>> = { short: '60-90 second', medium: '3-5 minute', long: '10-15 minute' };

/** Words a second the narrator speaks, per language. The Studio settings can override it (`explainer.pace`). */
export const DEFAULT_PACE = DEFAULT_EXPLAINER_PACE;

/** The limits of a draft's fields: the voice, the label tag and the picture prompt are built for them, and the schema repeats them. */
export const LIMITS = {
    title: 70,
    narration: 300,
    spoken: 400,
    brief: 500,
    labelWords: 4,
    labelChars: 40,
    characters: 4,
} as const;

/** A short explainer cites at least this many sources (data-model §1). The other tiers have no number yet. */
const MIN_SOURCES_SHORT = 3;

// ─── Text ──────────────────────────────────────────────────────────────────────────────────────

/** A character of a word: a letter or a digit, in any script. A token with none (a dash, a lone «؟») is not a word. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** Spoken words: what is between white space and has a letter or a digit in it. */
export function countWords(text: string): number {
    let count = 0;
    for (const token of text.split(/\s+/)) if (WORD_CHARACTER.test(token)) count++;
    return count;
}

/** Characters as Postgres's `char_length` and a JSON schema's `maxLength` count them: an emoji is one, not two UTF-16 units. */
function characters(text: string): number {
    let count = 0;
    for (const _ of text) count++;
    return count;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * How long the narration takes to say: the spoken words of every scene ÷ the narrator's pace, to a tenth of a second. A pace that cannot be one
 * (zero, negative, not a number) is the language's default: a settings value gone wrong must not make every estimate infinite.
 */
export function estimateSeconds(scenes: readonly { spoken: string }[], language: ExplainerLanguage, pace?: number): number {
    const perSecond = typeof pace === 'number' && Number.isFinite(pace) && pace > 0 ? pace : DEFAULT_PACE[language];
    let spoken = 0;
    for (const scene of scenes) spoken += countWords(str(scene?.spoken));
    return Math.round((spoken / perSecond) * 10) / 10;
}

/** Whether a line ends in a question mark, Latin or Arabic, with closing quotes and brackets after it allowed. */
export function endsWithQuestion(text: string): boolean {
    const trimmed = text.replace(/[\s"'’”»)\]}›]+$/u, '');
    return trimmed.endsWith('?') || trimmed.endsWith('؟');
}

// ─── Patterns ──────────────────────────────────────────────────────────────────────────────────

/** A letter or digit of any script, or `_`: what a word is made of. JavaScript's `\b` knows only A-Z, so it cannot tell where an Arabic word ends. */
const L = '[\\p{L}\\p{N}_]';
/** The start and the end of a word, as Unicode lookarounds. */
const S = `(?<!${L})`;
const E = `(?!${L})`;

/**
 * Folds an Arabic pattern the way `normalizeArabic` folds the text (tatweel and tashkeel gone, alef forms to alef, ta marbuta to ha, alef maksura
 * to ya), without lower-casing: that would turn `\P{L}` into `\p{L}`. A pattern typed in natural spelling then still matches the folded text.
 */
function foldPattern(source: string): string {
    return source
        .replace(/[\u0640\u064B-\u0655\u0670]/g, '')
        .replace(/[\u0623\u0625\u0622]/g, '\u0627')
        .replace(/\u0629/g, '\u0647')
        .replace(/\u0649/g, '\u064A');
}

/** Arabic-Indic (U+0660-0669) and Persian (U+06F0-06F9) digits to ASCII, one for one, so the offsets of the fold stay valid. */
function foldDigits(text: string): string {
    return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (digit) => {
        const code = digit.charCodeAt(0);
        return String.fromCharCode(0x30 + (code >= 0x06f0 ? code - 0x06f0 : code - 0x0660));
    });
}

// ─── Engagement bait ───────────────────────────────────────────────────────────────────────────

/** A keyword or answer in quotes: comment "GUIDE", اكتب «نعم». */
const QUOTED = `["“«'‘][^"”»'’\\n]{1,30}["”»'’]`;

/**
 * What asks a viewer to comment a keyword, type an answer, react, share or tag, in the closing words of a video or in a caption (FR-004, R10: Meta
 * demotes it). Genuine invitations stay out: "tell me in the comments what you think" asks for an opinion, not for a word. English is matched on
 * lower-cased text, Arabic on folded text, so every pattern is written in its natural spelling and the Arabic ones are folded when compiled.
 */
const BAIT_ENGLISH: readonly string[] = [
    // comment YES · comment 1 · comment the word GUIDE · comment "GUIDE"
    `${S}comment\\s+(?:(?:yes|me|yep|nope|done|\\d+)${E}|(?:the\\s+|a\\s+)?(?:key)?word${E}|(?:the|a)\\s+(?:number|letter|emoji)${E}|${QUOTED})`,
    // type 1 · type yes · reply 1 · reply "GUIDE"
    `${S}(?:type|reply)\\s+(?:(?:yes|\\d+)${E}|${QUOTED})`,
    // drop a 🔥 · drop a heart · leave an emoji
    `${S}(?:drop|leave|send)\\s+(?:me\\s+)?(?:an?\\s+|your\\s+)?(?:emoji|heart|fire|thumbs?\\s*up|\\p{Extended_Pictographic})`,
    // react with ❤️ · like if you agree · share if you learned something
    `${S}react\\s+with${E}`,
    `${S}(?:like|love|share|follow|subscribe|save)\\s+(?:this\\s+)?(?:(?:video|post|reel)\\s+)?if${E}`,
    `${S}like\\s+and\\s+(?:subscribe|share|follow)${E}`,
    // tag a friend · double tap · smash that like button
    `${S}tag\\s+(?:a|your|someone|somebody|two|three|2|3)${E}`,
    `${S}double[\\s-]?tap${E}`,
    `${S}(?:smash|hit|press|click)\\s+(?:that\\s+|the\\s+)?(?:like|subscribe)${E}`,
];

const BAIT_ARABIC: readonly string[] = [
    // اكتب نعم · اكتب 1 · اكتب رقم · اكتب كلمة · اكتب «…»
    `${S}(?:اكتب|اكتبوا|اكتبي)\\s+(?:لي\\s+)?(?:في\\s+التعليقات\\s+)?(?:(?:نعم|لا|\\d+)${E}|(?:ال)?(?:كلمة|رقم)${E}|${QUOTED})`,
    // علّق بكلمة · علّق بنعم · علّق برقم · علّق «…»
    `${S}(?:علق|علقوا|علقي)\\s+(?:ب(?:ال)?(?:كلمة|رقم)${E}|ب(?:نعم|لا|ايموجي|قلب)${E}|ب\\s*\\d+${E}|ب?\\s*${QUOTED})`,
    // رد بنعم · رد برقم
    `${S}(?:رد|ردوا|ردي)\\s+ب(?:نعم|لا|رقم|كلمة)${E}`,
    // اضغط لايك · ضع إعجاب · اترك قلب
    `${S}(?:ضع|ضعوا|اضغط|اضغطوا|اترك|اتركوا|سجل|سجلوا)\\s+(?:لنا\\s+)?(?:لايك|اعجاب|قلب|ايموجي|نار)${E}`,
    // لايك لو أعجبك · شارك الفيديو إذا استفدت
    `${S}(?:لايك|اعجاب|قلب)\\s+(?:اذا|لو|ان)${E}`,
    `${S}(?:شارك|شاركوا|شاركه|شير)\\s+(?:هذا\\s+)?(?:(?:الفيديو|المنشور|المقطع|الريل)\\s+)?(?:اذا|لو|ان)${E}`,
    // منشن صديقك · لا تنس الاشتراك
    `${S}(?:منشن|تاغ|تاج)\\s+(?:ل)?(?:صديق|اصدقاء|شخص)\\p{L}*`,
    `${S}لا\\s+تنس(?:وا)?\\s+(?:ال)?(?:اشتراك|لايك|اعجاب|متابعة)${E}`,
];

const BAIT_PATTERNS: readonly RegExp[] = [
    ...BAIT_ENGLISH.map((source) => new RegExp(source, 'iu')),
    ...BAIT_ARABIC.map((source) => new RegExp(foldPattern(source), 'iu')),
];

/**
 * The words that ask for a comment, a reaction or a share, as the person typed them, or null. Case, diacritics, tatweel and the spellings of the
 * hamza do not hide it («اكتـــب نَعَم»), and Arabic-Indic digits are digits («اكتب ١»).
 */
export function engagementBait(text: string): string | null {
    const { text: folded, map } = normalizeArabicWithMap(text);
    const subject = foldDigits(folded);
    let best: { start: number; end: number } | null = null;
    for (const pattern of BAIT_PATTERNS) {
        const found = pattern.exec(subject);
        if (found && (best === null || found.index < best.start)) best = { start: found.index, end: found.index + found[0].length };
    }
    return best === null ? null : text.slice(map[best.start]!, map[best.end]!).trim();
}

// ─── The no-women guard ────────────────────────────────────────────────────────────────────────

const ENGLISH_FEMALE_TERMS = [
    'woman', 'women', 'girl', 'girls', 'lady', 'ladies', 'female', 'females', 'mother', 'mothers', 'mom', 'moms', 'mum', 'mums', 'mommy', 'mama',
    'wife', 'wives', 'sister', 'sisters', 'daughter', 'daughters', 'she', 'her', 'hers', 'herself', 'grandmother', 'grandmothers', 'grandma',
    'grandmas', 'granny', 'aunt', 'aunts', 'niece', 'nieces', 'bride', 'brides', 'actress', 'actresses', 'waitress', 'waitresses', 'schoolgirl',
    'schoolgirls', 'girlfriend', 'girlfriends', 'businesswoman', 'businesswomen', 'princess', 'princesses',
] as const;

/** «أم» is matched with the article and the conjunctions only: «كام» («how many», Egyptian) is not «كأم». */
const ARABIC_ARTICLE_ONLY_TERMS = ['أم'] as const;

const ARABIC_FEMALE_TERMS = [
    'امرأة', 'مرأة', 'امراه', 'نساء', 'نسوة', 'فتاة', 'فتاه', 'فتيات', 'بنت', 'بنات', 'سيدة', 'سيدات', 'أمهات', 'زوجة', 'زوجه', 'زوجات', 'أخت', 'أخوات',
    'ابنة', 'أنثى', 'إناث', 'عروس', 'ممرضة', 'معلمة', 'طبيبة', 'طالبة', 'خالة', 'عمة',
] as const;

/**
 * The words that name a woman or a girl (research.md R5), which no picture brief and no character description may contain: Explainers never draw
 * them (FR-013). A heuristic by design: the writer is told the rule and the owner approves every picture, so this is the check that costs the
 * image allowance nothing, not the last one. `ar` is the words that stand alone, in their natural spelling; the article, the one-letter
 * prefixes and the possessive endings are added when they are matched («المرأة», «للأم», «زوجته»).
 */
export const FEMALE_TERMS = {
    en: ENGLISH_FEMALE_TERMS,
    ar: [...ARABIC_ARTICLE_ONLY_TERMS, ...ARABIC_FEMALE_TERMS],
} as const;

/**
 * A word folded for the guard: case, diacritics, tatweel, alef forms and ya forms are folded away, but the ta marbuta is KEPT. `normalizeArabic`
 * turns it into a ha, and then «ابنه» (his son) would be «ابنة» (a daughter) and «عمه» (his uncle) «عمة» (an aunt). So the informal «امراه» and
 * «فتاه» are terms of their own, and a word that is a daughter or an aunt only with its ta marbuta is matched only with it.
 */
const SHIELD = '\uE000';
function foldGuardWord(word: string): string {
    return normalizeArabic(word.replace(/\u0629/g, SHIELD)).replace(new RegExp(SHIELD, 'g'), '\u0629');
}

// Prefixes, from the outside in: a conjunction (و ف), then a preposition that carries the article (بال كال لل), the article (ال), or a preposition alone.
const AR_ARTICLE_PREFIX = '(?:[وف])?(?:[بك]ال|لل|ال)?';
const AR_ANY_PREFIX = '(?:[وف])?(?:[بك]ال|لل|ال|[بكل])?';
// Before a possessive ending there is no article: «أمه» is his mother, «الأمة» is the nation.
const AR_POSSESSIVE_PREFIX = '(?:[وف])?[بل]?';
const AR_ENDING = '(?:ي|ك|ه|ها|نا|كم|كن|هم|هن|كما|هما)';
/** The kinship words that take a possessive ending, as they are spelled before it: the ta marbuta of «زوجة» is a ta, «زوجتي». */
const AR_STEMS = ['أم', 'أخت', 'بنت', 'ابنت', 'زوجت', 'امرأت', 'خالت', 'عمت'];

const ENGLISH_TERMS: ReadonlySet<string> = new Set<string>(ENGLISH_FEMALE_TERMS);
const alternatives = (words: readonly string[]): string => words.map(foldGuardWord).join('|');
const ARABIC_MATCHERS: readonly RegExp[] = [
    new RegExp(`^${AR_ANY_PREFIX}(?:${alternatives(ARABIC_FEMALE_TERMS)})$`, 'u'),
    new RegExp(`^${AR_ARTICLE_PREFIX}(?:${alternatives(ARABIC_ARTICLE_ONLY_TERMS)})$`, 'u'),
    new RegExp(`^${AR_POSSESSIVE_PREFIX}(?:${alternatives(AR_STEMS)})${AR_ENDING}$`, 'u'),
];

/** Zero-width and bidirectional marks: invisible, and a way to split a word the guard would otherwise see whole. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD\u2060]/g;

/**
 * The first word of `text` that names a woman or a girl, as it was typed, or null. Whole words only: «human» is not «man», and «أمثلة» (examples)
 * is not «أم». A word is a run of letters, marks and digits, so an apostrophe ends one: «she's» is «she».
 */
export function findFemaleSubject(text: string): string | null {
    for (const found of text.replace(INVISIBLE, '').matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
        const word = found[0];
        const folded = foldGuardWord(word);
        if (ENGLISH_TERMS.has(folded) || ARABIC_MATCHERS.some((matcher) => matcher.test(folded))) return word;
    }
    return null;
}

// ─── A draft ───────────────────────────────────────────────────────────────────────────────────

export interface DraftScene {
    narration: string;
    spoken: string;
    label: string;
    brief: string;
    characters: readonly string[];
    continues?: boolean;
    /** Indexes into the draft's sources, for the claims this sentence makes. The writer sends them; an owner's edit does not. */
    source_ids?: readonly number[];
}

export interface DraftInput {
    title?: string | null;
    scenes: readonly DraftScene[];
    /** Only how many there are matters here. */
    sources?: readonly unknown[];
    captions?: { meta?: string; youtube?: { title?: string; description?: string }; tiktok?: string } | null;
    first_comment?: string | null;
}

export type DraftProblemCode =
    | 'no_scenes' | 'too_many_scenes' | 'field_empty' | 'field_too_long' | 'label_too_long' | 'too_many_characters' | 'bad_source_id'
    | 'closing_question' | 'engagement_bait' | 'female_subject';
export type DraftWarningCode = 'scene_count' | 'duration_short' | 'duration_long' | 'needs_sources' | 'few_sources';

export interface DraftFinding {
    code: DraftProblemCode | DraftWarningCode;
    /** English, for the owner and the logs. The dashboard translates by `code`. */
    message: string;
    /** 0-based position of the scene the finding is about. */
    scene?: number;
    /** `title`, `narration`, `spoken`, `brief`, `label`, `characters`, `captions.meta`, … */
    field?: string;
}

export interface DraftContext {
    tier: ExplainerLengthTier;
    language: ExplainerLanguage;
    /** Words a second, from the settings. Anything but a positive number is the language's default. */
    pace?: number;
}

export interface DraftCheck {
    /** Spoken words ÷ pace, to a tenth of a second (`estimateSeconds`). */
    est_seconds: number;
    problems: DraftFinding[];
    warnings: DraftFinding[];
}

/** Where the closing question's company is looked at for bait besides the last scene: every caption and the first comment. */
const BAIT_FIELDS: readonly [field: string, read: (draft: DraftInput) => unknown][] = [
    ['captions.meta', (d) => d.captions?.meta],
    ['captions.youtube.title', (d) => d.captions?.youtube?.title],
    ['captions.youtube.description', (d) => d.captions?.youtube?.description],
    ['captions.tiktok', (d) => d.captions?.tiktok],
    ['first_comment', (d) => d.first_comment],
];

/**
 * Holds a draft to every rule above and says what it found (see the top of the file for problems and warnings). It never changes the draft,
 * never throws on a field that is not what the schema says (a missing narration is an empty one, and a problem), and lists everything it finds:
 * the owner fixes a draft in one pass, not one refusal at a time.
 *
 * Engagement bait is looked for where it does harm: the last scene, and the captions and the first comment. In the middle of a script "type 1"
 * can be an instruction in a lesson, and a refusal there would loop the writer on a sentence that is right.
 */
export function checkDraft(draft: DraftInput, ctx: DraftContext): DraftCheck {
    const problems: DraftFinding[] = [];
    const warnings: DraftFinding[] = [];
    const scenes: readonly DraftScene[] = Array.isArray(draft.scenes) ? draft.scenes : [];
    const sourceCount = Array.isArray(draft.sources) ? draft.sources.length : 0;
    const est = estimateSeconds(scenes, ctx.language, ctx.pace);
    const target = TIER_TARGET[ctx.tier];

    const title = str(draft.title);
    if (characters(title) > LIMITS.title) {
        problems.push({ code: 'field_too_long', field: 'title', message: `The title is ${characters(title)} characters; the limit is ${LIMITS.title}.` });
    }

    scenes.forEach((raw, i) => {
        const scene = (raw ?? {}) as Partial<DraftScene>;
        const at = `Scene ${i + 1}`;

        for (const field of ['narration', 'spoken', 'brief'] as const) {
            const text = str(scene[field]);
            if (!text.trim()) {
                problems.push({ code: 'field_empty', scene: i, field, message: `${at}: the ${field} is empty.` });
            } else if (characters(text) > LIMITS[field]) {
                problems.push({
                    code: 'field_too_long', scene: i, field,
                    message: `${at}: the ${field} is ${characters(text)} characters; the limit is ${LIMITS[field]}.`,
                });
            }
        }

        const label = str(scene.label).trim();
        if (label && (countWords(label) > LIMITS.labelWords || characters(label) > LIMITS.labelChars)) {
            problems.push({
                code: 'label_too_long', scene: i, field: 'label',
                message: `${at}: the label «${label}» is more than ${LIMITS.labelWords} words or ${LIMITS.labelChars} characters; it has to fit on a tag.`,
            });
        }

        const named = Array.isArray(scene.characters) ? scene.characters.length : 0;
        if (named > LIMITS.characters) {
            problems.push({
                code: 'too_many_characters', scene: i, field: 'characters',
                message: `${at} names ${named} characters; at most ${LIMITS.characters} can be drawn together.`,
            });
        }

        const cited = Array.isArray(scene.source_ids) ? scene.source_ids : [];
        const missing = cited.filter((id) => !(Number.isInteger(id) && id >= 0 && id < sourceCount));
        if (missing.length) {
            problems.push({
                code: 'bad_source_id', scene: i, field: 'source_ids',
                message: `${at} cites source ${missing.join(', ')}, which is not in the list of ${sourceCount} sources.`,
            });
        }

        const woman = findFemaleSubject(str(scene.brief));
        if (woman) {
            problems.push({
                code: 'female_subject', scene: i, field: 'brief',
                message: `${at}: the picture brief mentions «${woman}»; Explainers never draw women or girls.`,
            });
        }
    });

    if (scenes.length === 0) {
        problems.push({ code: 'no_scenes', message: 'The script has no scenes.' });
    } else {
        const lastIndex = scenes.length - 1;
        const last = (scenes[lastIndex] ?? {}) as Partial<DraftScene>;
        if (!endsWithQuestion(str(last.narration))) {
            problems.push({
                code: 'closing_question', scene: lastIndex, field: 'narration',
                message: 'The last scene must ask the viewer a genuine question, ending in ? or ؟.',
            });
        }
        for (const field of ['narration', 'spoken'] as const) {
            const bait = engagementBait(str(last[field]));
            if (bait) {
                problems.push({
                    code: 'engagement_bait', scene: lastIndex, field,
                    message: `Scene ${lastIndex + 1}: asking viewers to «${bait}» is engagement bait; ask a genuine question instead.`,
                });
                break;
            }
        }
    }
    for (const [field, read] of BAIT_FIELDS) {
        const bait = engagementBait(str(read(draft)));
        if (bait) {
            problems.push({ code: 'engagement_bait', field, message: `The ${field} asks viewers to «${bait}»; that is engagement bait.` });
        }
    }
    if (scenes.length > MAX_SCENES) {
        problems.push({ code: 'too_many_scenes', message: `The script has ${scenes.length} scenes; the most an explainer can have is ${MAX_SCENES}.` });
    }

    if (scenes.length > 0) {
        const bounds = SCENE_BOUNDS[ctx.tier];
        if (scenes.length < bounds.min || scenes.length > bounds.max) {
            warnings.push({
                code: 'scene_count',
                message: `This script has ${scenes.length} scenes; a ${target} explainer usually has ${bounds.min}-${bounds.max}.`,
            });
        }
        const range = DURATION_RANGE_S[ctx.tier];
        if (est < range.min) {
            warnings.push({ code: 'duration_short', message: `The script runs about ${est} s, shorter than the ${range.min}-${range.max} s of a ${target} explainer.` });
        } else if (est > range.max) {
            warnings.push({ code: 'duration_long', message: `The script runs about ${est} s, longer than the ${range.min}-${range.max} s of a ${target} explainer.` });
        }
    }
    if (sourceCount === 0) {
        warnings.push({ code: 'needs_sources', message: 'No sources are listed. Add the papers or pages the script relies on, and ask for a rewrite.' });
    } else if (ctx.tier === 'short' && sourceCount < MIN_SOURCES_SHORT) {
        warnings.push({ code: 'few_sources', message: `Only ${sourceCount} source${sourceCount === 1 ? ' is' : 's are'} listed; a ${TIER_TARGET.short} explainer should cite at least ${MIN_SOURCES_SHORT}.` });
    }

    return { est_seconds: est, problems, warnings };
}
