/**
 * The Studio's writer (STUDIO.md §7, as amended by §10): lesson notes and screenshot moments in, a
 * branded carousel out, as strict JSON that passes `validateCarousel`.
 *
 * The flow for one draft:
 *   1. Gemini (`gemini-2.5-pro`, `responseSchema`) writes the carousel in a *flat* slide format.
 *      The typed `Slide` union is hard to express in Gemini's schema subset, so every slide is one
 *      object with a `kind` enum and optional fields, plus the `sources` it rests on and, for a
 *      screenshot, a `momentId`.
 *   2. `assemble` converts it to the typed union. Code, not the model, owns what code can decide:
 *      the accent (from the palette, avoiding recent ones), the keyword (first candidate that
 *      doesn't collide with a live campaign), the CTA lines in both captions (from settings), the
 *      DM (the tenant's template), and the shots (clean moments only, as `m-<momentId>`).
 *   3. The problems (`validateCarousel` plus the writer's own rules) go back to the model, for up
 *      to 2 repair rounds, while the 120s budget allows.
 *   4. The best candidate gets the safe fixes (UTF-16 trimming that never splits a surrogate pair
 *      or a [placeholder], digits, item counts, unsourced slides dropped). If a problem survives
 *      that, generation throws `StudioGenerationError` with the list.
 *
 * The Gemini call is injectable (`opts.callModel`, or `setModelCaller`), so tests never touch the
 * network.
 */
import axios from 'axios';
import type { Carousel, ShotRef, Slide } from './carouselTypes.js';
import {
    buildCatalog,
    buildDm,
    buildPlanCatalog,
    buildPlanSystemPrompt,
    buildSystemPrompt,
    draftUserPrompt,
    languageKit,
    oneLine,
    planUserPrompt,
    repairPrompt,
    rewriteUserPrompt,
    saveLine,
    tiktokLine,
    type Catalog,
    type PlanCatalog,
} from './prompts.js';
import {
    BUDGETS,
    CAPTION_LIMITS,
    COUNTS,
    SLIDE_KINDS,
    fillKeyword,
    slideLabel,
    slideTextFields,
    usedShotNames,
    validateCarousel,
    type SlideKind,
} from './rules.js';
import { DEFAULT_PALETTE, defaultStudioSettings, type StudioSettings } from './settingsTypes.js';
import { normalizeArabic } from '../../utils/arabic.js';
import { log } from '../../utils/log.js';

// ─── Shared types (STUDIO.md §3, §7, §10.3) ─────────────────────────────────────────────────

export type LessonNotes = {
    /** 2–4 sentences. */
    summary: string;
    /** What it teaches, 3–10. */
    points: { title: string; detail: string; t?: number }[];
    /** Prompts shown on screen, verbatim. */
    prompts: { text: string; t?: number }[];
    /** Products used, e.g. "NotebookLM". */
    tools: string[];
    demos: { title: string; result: string; t?: number }[];
};

export type MomentKind = 'slide' | 'ui' | 'result' | 'code' | 'prompt' | 'other';

export type Moment = {
    id: string;
    lesson_id: string;
    /** Seconds into the video. Postgres `numeric` may arrive as a string; it's coerced. */
    t: number;
    description: string;
    kind: MomentKind;
    /** No annotation arrows or scribbles, nothing loading or blank. Only clean moments become shots. */
    clean: boolean;
    thumb_url: string | null;
};

export type ShotSpec = { lessonId: string; t: number; zoom: number; focusX: number; focusY: number; desc?: string };

export type Angle = 'auto' | 'tips' | 'steps' | 'mistakes' | 'compare' | 'prompt' | 'overview';

export type DraftInput = {
    /** 0–3 lessons to ground the post in. */
    lessonIds: string[];
    /** Free-text topic; required when lessonIds is empty. */
    idea?: string;
    angle?: Angle;
    /** 6–10, default 8. */
    slides?: number;
    /** Else suggested. */
    keyword?: string;
    /** `#RRGGBB`, else picked from the palette. */
    accent?: string;
};

/** The `course_lessons` columns the writer reads. A full row satisfies it. */
export type LessonRow = {
    id: string;
    lesson_no: string;
    title: string;
    section_no?: number | null;
    section_title?: string | null;
    status?: string;
    notes?: LessonNotes | null;
};

/** One lesson a draft is grounded in, with its moments. */
export type GenSource = { lesson: LessonRow; moments: Moment[] };

export type GenContext = {
    recentTopics: string[];
    /** Newest first. */
    recentAccents: string[];
    /** Keywords live campaigns fire on. A comma-separated `trigger_keyword` is split. */
    activeKeywords: string[];
    /** Superseded by `settings.brand.palette` (v1.1); used only when that is empty. */
    palette?: string[];
    settings: StudioSettings;
};

export type Campaign = { keyword: string; variants: string[]; dm: string; create: boolean };

export type DraftResult = { carousel: Carousel; shots: Record<string, ShotSpec>; campaign: Campaign };

export type Proposal = DraftInput & { title: string; rationale: string };

/** A draft that can't be made valid; `problems` lists what's still wrong. */
export class StudioGenerationError extends Error {
    readonly problems: string[];
    constructor(message: string, problems: string[] = []) {
        super(problems.length ? `${message}: ${problems.join('; ')}` : message);
        this.name = 'StudioGenerationError';
        this.problems = problems;
    }
}

// ─── Constants ──────────────────────────────────────────────────────────────────────────────

export const STUDIO_MODEL = 'gemini-2.5-pro';
/** The whole generation's budget, repairs included: POST /drafts runs it synchronously. */
export const GENERATION_TIMEOUT_MS = 120_000;
export const MAX_REPAIR_ROUNDS = 2;
export const MAX_SHOTS = 3;
export const SHOT_DEFAULTS = { zoom: 1.3, focusX: 0.5, focusY: 0.5 } as const;

/** A whole-carousel repair takes ~30–45s on 2.5 Pro; with less left, trimming is the better bet. */
const MIN_REPAIR_MS = 40_000;
/** A retry of a failed first call needs time for a full answer. */
const MIN_RETRY_MS = 50_000;
const MIN_CALL_MS = 8_000;
const MAX_OUTPUT_TOKENS = 24_576;
/** 2.5 Pro can't switch thinking off (minimum 128); these keep it inside the budget. */
const THINKING = { draft: 2048, repair: 1024, rewrite: 1024, plan: 2048 } as const;
const MAX_PLAN = 14;

// ─── The model call ─────────────────────────────────────────────────────────────────────────

/** Gemini's `responseSchema` subset (OpenAPI 3.0-ish, upper-case types). */
export type GeminiSchema = {
    type: 'OBJECT' | 'ARRAY' | 'STRING' | 'INTEGER' | 'NUMBER' | 'BOOLEAN';
    description?: string;
    enum?: string[];
    properties?: Record<string, GeminiSchema>;
    required?: string[];
    propertyOrdering?: string[];
    items?: GeminiSchema;
    minItems?: number;
    maxItems?: number;
};

export type ModelTurn = { role: 'user' | 'model'; text: string };

export type ModelRequest = {
    /** For logs: 'draft', 'repair', 'rewrite', 'rewrite-repair', 'plan', 'plan-repair'. */
    purpose: string;
    system: string;
    turns: ModelTurn[];
    schema: GeminiSchema;
    temperature: number;
    thinkingBudget: number;
    timeoutMs: number;
};

/** Resolves to the JSON the model returned, parsed. Throws with `retryable` on transient failures. */
export type CallModel = (req: ModelRequest) => Promise<unknown>;

export type GenOptions = {
    /** Replaces the Gemini call for this invocation. */
    callModel?: CallModel;
    /** The whole call's budget. Default `GENERATION_TIMEOUT_MS`. */
    timeoutMs?: number;
};

class ModelError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable: boolean) {
        super(message);
        this.name = 'ModelError';
        this.retryable = retryable;
    }
}

/**
 * The real Gemini call, over REST like src/services/ai.ts: the key in a header (never the query
 * string, which lands in logs), narrow error logging (never the request config, which holds the
 * key), and the same failure modes surfaced as errors that say what happened.
 */
export async function callGemini(req: ModelRequest): Promise<unknown> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new ModelError('Missing GEMINI_API_KEY environment variable.', false);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${STUDIO_MODEL}:generateContent`;
    const payload = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: req.schema,
            temperature: req.temperature,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinkingConfig: { thinkingBudget: req.thinkingBudget },
        },
    };

    let data: any;
    try {
        const res = await axios.post(url, payload, { headers: { 'x-goog-api-key': apiKey }, timeout: req.timeoutMs });
        data = res.data;
    } catch (err: any) {
        const apiError = err?.response?.data?.error;
        const status: number | undefined = err?.response?.status;
        const timedOut = err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT';
        log('error', 'studio.ai_request_failed', {
            purpose: req.purpose, model: STUDIO_MODEL, http_status: status, gemini_status: apiError?.status,
            timed_out: timedOut, message: apiError?.message ?? err?.message,
        });
        const why = status ? ` [HTTP ${status}]` : timedOut ? ' (timed out)' : '';
        throw new ModelError(
            `Gemini request failed${why}: ${apiError?.message || err?.message}`,
            !timedOut && (status === undefined || status === 429 || status >= 500),
        );
    }

    const usage = data?.usageMetadata;
    if (usage) {
        log('info', 'studio.ai_usage', {
            purpose: req.purpose, model: STUDIO_MODEL, prompt_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount, thinking_tokens: usage.thoughtsTokenCount ?? 0,
            cached_tokens: usage.cachedContentTokenCount ?? 0,
        });
    }

    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts;
    const text = Array.isArray(parts)
        ? parts.filter((p: any) => p && !p.thought && typeof p.text === 'string').map((p: any) => p.text).join('')
        : '';
    if (!text) {
        // Usually a safety block: no candidates, or one with a finishReason and no parts.
        const blockReason = data?.promptFeedback?.blockReason;
        throw new ModelError(
            `Gemini returned no content (finishReason: ${candidate?.finishReason || 'none'}, blockReason: ${blockReason || 'none'}).`,
            !blockReason,
        );
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        // A reply cut off by MAX_TOKENS is valid text and invalid JSON.
        throw new ModelError(
            `Gemini returned text that is not valid JSON (${(e as Error).message}; finishReason: ${candidate?.finishReason || 'none'}). First 200 characters: ${text.slice(0, 200)}`,
            true,
        );
    }
}

let modelCaller: CallModel = callGemini;

/** Swaps the module's model call (tests, or a different provider). Returns the previous one. */
export function setModelCaller(next: CallModel): CallModel {
    const previous = modelCaller;
    modelCaller = next;
    return previous;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function callWithin(call: CallModel, req: Omit<ModelRequest, 'timeoutMs'>, deadline: number, retries: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
        const left = deadline - Date.now();
        if (left < MIN_CALL_MS) throw new StudioGenerationError(`Out of time before the ${req.purpose} call`);
        try {
            return await call({ ...req, timeoutMs: left });
        } catch (err) {
            const retryable = (err as { retryable?: unknown } | null)?.retryable === true;
            if (attempt >= retries || !retryable || deadline - Date.now() < MIN_RETRY_MS) throw err;
            log('warn', 'studio.ai_retry', { purpose: req.purpose, attempt: attempt + 1, message: errorMessage(err) });
        }
    }
}

// ─── Response schemas ───────────────────────────────────────────────────────────────────────

const str = (description?: string): GeminiSchema => (description ? { type: 'STRING', description } : { type: 'STRING' });
const strs = (maxItems: number, description?: string): GeminiSchema =>
    ({ type: 'ARRAY', items: str(), maxItems, ...(description ? { description } : {}) });
function obj(properties: Record<string, GeminiSchema>, required: string[], description?: string): GeminiSchema {
    return { type: 'OBJECT', properties, required, propertyOrdering: Object.keys(properties), ...(description ? { description } : {}) };
}

const B = BUDGETS;

/** One slide, flat: `kind` plus the union of every kind's fields. `sources` comes first, so the model cites before it writes. */
export const SLIDE_SCHEMA: GeminiSchema = obj({
    kind: { type: 'STRING', enum: [...SLIDE_KINDS] },
    sources: strs(8, 'The source ids this slide rests on, e.g. L1.point2 or M4. Empty only on cover and cta.'),
    kicker: str(`cover: ≤ ${B.cover.kicker}`),
    title: str(`cover ≤ ${B.cover.title}, point ≤ ${B.point.title}, list/compare/steps/prompt ≤ ${B.list.title}, shot ≤ ${B.shot.title}`),
    highlight: str('cover: words copied verbatim from the title'),
    subtitle: str(`cover: ≤ ${B.cover.subtitle}`),
    n: { type: 'INTEGER', description: 'point: the numeral badge in a numbered run' },
    body: str(`point ≤ ${B.point.body}, stat ≤ ${B.stat.body}`),
    tip: str(`point: ≤ ${B.point.tip}`),
    momentId: str('cover, point or shot: a clean moment id such as M3. Required on shot.'),
    items: {
        type: 'ARRAY', maxItems: COUNTS.listItems[1], description: `list: ${COUNTS.listItems.join('–')} items`,
        items: obj({ icon: str('one emoji'), text: str(`≤ ${B.list.itemText}`), sub: str(`≤ ${B.list.itemSub}`) }, ['text']),
    },
    leftLabel: str(`compare: the weak side, ≤ ${B.compare.label}`),
    leftItems: strs(COUNTS.compareItems[1], `compare: ${COUNTS.compareItems.join('–')}, each ≤ ${B.compare.item}`),
    rightLabel: str(`compare: the strong side, ≤ ${B.compare.label}`),
    rightItems: strs(COUNTS.compareItems[1], 'compare: as many as leftItems'),
    steps: {
        type: 'ARRAY', maxItems: COUNTS.steps[1], description: `steps: ${COUNTS.steps.join('–')} steps`,
        items: obj({ title: str(`≤ ${B.steps.stepTitle}`), body: str(`≤ ${B.steps.stepBody}`) }, ['title']),
    },
    label: str(`prompt ≤ ${B.prompt.label}, stat ≤ ${B.stat.label}`),
    prompt: str(`prompt: ≤ ${B.prompt.prompt}, [placeholders] in square brackets`),
    note: str(`prompt: ≤ ${B.prompt.note}`),
    value: str(`stat: ≤ ${B.stat.value}`),
    caption: str(`shot: ≤ ${B.shot.caption}`),
    promise: str(`cta: ≤ ${B.cta.promise}`),
}, ['kind', 'sources']);

export const DRAFT_SCHEMA: GeminiSchema = obj({
    id: str('a short PascalCase English name, e.g. LocalAI'),
    keyword: str('one word'),
    keywordAlternatives: strs(3, 'more keyword candidates, best first'),
    variants: strs(3, 'other spellings of the keyword'),
    slides: { type: 'ARRAY', items: SLIDE_SCHEMA, minItems: COUNTS.slides[0], maxItems: COUNTS.slides[1] },
    captions: obj({
        instagram: str(),
        tiktokTitle: str(`≤ ${CAPTION_LIMITS.tiktokTitle} UTF-16 units`),
        tiktok: str(),
    }, ['instagram', 'tiktokTitle', 'tiktok']),
    dmQuestion: str('one line'),
    dmPitch: str('one sentence naming the part of the course'),
}, ['id', 'keyword', 'keywordAlternatives', 'variants', 'slides', 'captions', 'dmQuestion', 'dmPitch']);

const PLAN_ANGLES = ['tips', 'steps', 'mistakes', 'compare', 'prompt', 'overview'] as const;

export const PLAN_SCHEMA: GeminiSchema = obj({
    proposals: {
        type: 'ARRAY',
        items: obj({
            lessons: strs(3, 'lesson ids from the list, e.g. L2'),
            angle: { type: 'STRING', enum: [...PLAN_ANGLES] },
            title: str('the working hook, ≤ 60 characters'),
            idea: str('one line: what the post teaches'),
            rationale: str('one or two English sentences'),
            slides: { type: 'INTEGER', description: `${COUNTS.slides.join('–')}` },
        }, ['lessons', 'angle', 'title', 'idea', 'rationale', 'slides']),
    },
}, ['proposals']);

// ─── Small helpers ──────────────────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] =>
    arr(v).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A single-line field, or undefined when absent or blank. */
const line = (v: unknown): string | undefined => (typeof v === 'string' && oneLine(v) ? oneLine(v) : undefined);

/** A multi-line field (the prompt): line breaks kept, each line tidied. */
function block(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return s || undefined;
}

/** Drops the undefined keys, so stored JSON and deep-equality agree. */
function compact<T extends object>(o: T): T {
    for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
    return o;
}

const posInt = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 100 ? v : undefined;

/** The requested slide count, clamped to 6–10; 8 when unset. */
export function slideTarget(v: unknown): number {
    const n = typeof v === 'number' ? Math.round(v) : Number.NaN;
    return Number.isFinite(n) ? Math.min(COUNTS.slides[1], Math.max(COUNTS.slides[0], n)) : 8;
}

/** A PascalCase id from whatever the model called it, safe in file paths. */
export function safeId(raw: unknown): string {
    const words = (typeof raw === 'string' ? raw : '').match(/[A-Za-z0-9]+/g) ?? [];
    let id = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    if (!/^[A-Za-z]/.test(id)) id = `Studio${id}`;
    return id.slice(0, 48);
}

// ─── Trimming (the last resort) ─────────────────────────────────────────────────────────────

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** The largest grapheme boundary ≤ i: never inside a surrogate pair, a ZWJ emoji or a combining mark. */
function graphemeFloor(s: string, i: number): number {
    if (i >= s.length) return s.length;
    if (i <= 0) return 0;
    if (graphemes) {
        let last = 0;
        for (const { index } of graphemes.segment(s)) {
            if (index > i) break;
            last = index;
        }
        return last;
    }
    const c = s.charCodeAt(i - 1);
    return c >= 0xd800 && c <= 0xdbff ? i - 1 : i;
}

/** Where the [placeholder] a cut at `i` would split starts, or null when `i` is outside one. */
function placeholderStart(s: string, i: number): number | null {
    const open = s.lastIndexOf('[', i - 1);
    if (open < 0) return null;
    const close = s.indexOf(']', open);
    return close === -1 || close >= i ? open : null;
}

/** A safe cut at or before `i`: on a grapheme boundary and outside every [placeholder]. */
function safeCut(s: string, i: number): number {
    let j = graphemeFloor(s, i);
    for (let p = placeholderStart(s, j); p !== null; p = placeholderStart(s, j)) j = graphemeFloor(s, p);
    return j;
}

/**
 * `s` cut to at most `max` UTF-16 units. Never splits a surrogate pair (or any grapheme) and never
 * cuts inside a `[placeholder]`: it backs up to before the bracket instead. Prefers a word boundary
 * when one sits in the last 40%, and tidies a dangling comma or dash off the end.
 */
export function trimText(s: string, max: number): string {
    if (s.length <= max) return s;
    if (max <= 0) return '';
    let cut = safeCut(s, max);
    const floor = Math.floor(max * 0.6);
    for (let k = cut; k > floor; k--) {
        if (/\s/.test(s.charAt(k))) {
            const w = safeCut(s, k);
            if (w > floor) cut = w;
            break;
        }
    }
    return s.slice(0, cut).replace(/[\s،,:;\-–—…(«"'“]+$/u, '');
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/** Latin digits touching Arabic text become Arabic-Indic; digits inside Latin runs stay. */
export function toArabicDigits(s: string): string {
    let out = s;
    for (let pass = 0; pass < 5; pass++) {
        const next = out.replace(/[0-9]+(?:[.,][0-9]+)*/g, (run, offset: number, whole: string) => {
            const before = whole.slice(0, offset);
            const after = whole.slice(offset + run.length);
            const touches = /[؀-ۿ]\s*$/.test(before) || /^\s*[؀-ۿ]/.test(after);
            return touches
                ? run.replace(/[0-9]/g, (d) => ARABIC_INDIC.charAt(Number(d))).replace(/\./g, '٫').replace(/,/g, '٬')
                : run;
        });
        if (next === out) break;
        out = next;
    }
    return out;
}

// ─── Accent ─────────────────────────────────────────────────────────────────────────────────

const HEX = /^#[0-9A-F]{6}$/i;

/**
 * The accent: the requested one when valid, else the first palette colour not used recently, else
 * (every colour recent) the one used longest ago. `recent` is newest first.
 */
export function pickAccent(requested: string | undefined, palette: readonly string[], recent: readonly string[]): string {
    if (typeof requested === 'string' && HEX.test(requested.trim())) return requested.trim().toUpperCase();
    const pool = [...new Set(strings(palette).filter((c) => HEX.test(c)).map((c) => c.toUpperCase()))];
    const colors = pool.length ? pool : [...DEFAULT_PALETTE];
    const used = strings(recent).map((c) => c.toUpperCase());
    const fresh = colors.find((c) => !used.includes(c));
    if (fresh) return fresh;
    return colors.reduce((best, c) => (used.indexOf(c) > used.indexOf(best) ? c : best), colors[0]!);
}

/** `k` accents in a row, each avoiding the recent ones and the ones before it. */
export function pickAccents(k: number, palette: readonly string[], recent: readonly string[]): string[] {
    const out: string[] = [];
    let history = strings(recent);
    for (let i = 0; i < k; i++) {
        const a = pickAccent(undefined, palette, history);
        out.push(a);
        history = [a, ...history];
    }
    return out;
}

const paletteOf = (ctx: GenContext): string[] => {
    const brand = strings(ctx.settings?.brand?.palette);
    return brand.length ? brand : strings(ctx.palette);
};

// ─── Keyword ────────────────────────────────────────────────────────────────────────────────

type ActiveKeyword = { raw: string; norm: string };

/** Live campaigns' keywords, one per entry, with comma-separated `trigger_keyword` lists split. */
function activeKeywordList(active: readonly string[]): ActiveKeyword[] {
    return strings(active)
        .flatMap((a) => a.split(/[,،]/))
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => ({ raw, norm: normalizeArabic(raw) }))
        .filter((k) => k.norm);
}

/** One word, unquoted, or null. */
function cleanKeyword(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const k = v.trim().replace(/^[#"'«»“”]+|[#"'«»“”.،,!؟?]+$/gu, '').trim();
    if (!k || /\s/.test(k) || k.length > 30 || !/\p{L}/u.test(k)) return null;
    return k;
}

export type KeywordChoice = { keyword: string; create: boolean };

/**
 * The first candidate that works: one that equals a live keyword (under the matcher's Arabic
 * normalisation) is reused with `create: false`; a new one must neither contain nor sit inside any
 * live keyword, since the matcher tests substrings and the wrong campaign would answer.
 */
export function chooseKeyword(candidates: readonly unknown[], active: readonly string[]): { choice: KeywordChoice | null; rejected: string[] } {
    const list = activeKeywordList(active);
    const rejected: string[] = [];
    for (const cand of candidates) {
        const k = cleanKeyword(cand);
        if (!k) {
            if (typeof cand === 'string' && cand.trim()) rejected.push(`«${cand.trim()}» isn't one word`);
            continue;
        }
        const n = normalizeArabic(k);
        const same = list.find((a) => a.norm === n);
        if (same) return { choice: { keyword: same.raw, create: false }, rejected };
        const clash = list.find((a) => a.norm.includes(n) || n.includes(a.norm));
        if (clash) {
            rejected.push(`«${k}» overlaps the active keyword «${clash.raw}»`);
            continue;
        }
        return { choice: { keyword: k, create: true }, rejected };
    }
    return { choice: null, rejected };
}

/** Spellings that should also fire the new campaign: one word, not redundant, not colliding. */
function cleanVariants(raw: unknown, keyword: string, active: readonly string[]): string[] {
    const kn = normalizeArabic(keyword);
    const list = activeKeywordList(active);
    const seen = new Set([kn]);
    const out: string[] = [];
    for (const v of arr(raw)) {
        const k = cleanKeyword(v);
        if (!k) continue;
        const n = normalizeArabic(k);
        // Under substring matching a variant containing the keyword is redundant, and one inside it
        // is broader than the keyword itself.
        if (n.length < 3 || seen.has(n) || n.includes(kn) || kn.includes(n)) continue;
        if (list.some((a) => a.norm.includes(n) || n.includes(a.norm))) continue;
        seen.add(n);
        out.push(k);
        if (out.length === 3) break;
    }
    return out;
}

// ─── Moments and shots ──────────────────────────────────────────────────────────────────────

export const shotName = (momentId: string): string => `m-${momentId}`;

export function shotSpecFor(m: Moment): ShotSpec {
    return compact({ lessonId: m.lesson_id, t: Number(m.t), ...SHOT_DEFAULTS, desc: m.description || undefined });
}

/** A moment by alias (`M3`), by id, or by shot name (`m-<id>`). */
function findMoment(catalog: Catalog, raw: unknown): Moment | null {
    if (typeof raw !== 'string') return null;
    const key = raw.trim();
    if (!key) return null;
    const byAlias = catalog.moments.get(key.toUpperCase());
    if (byAlias) return byAlias;
    const id = key.startsWith('m-') ? key.slice(2) : key;
    for (const m of catalog.moments.values()) if (String(m.id) === id) return m;
    return null;
}

/** Cited ids that exist in the catalog; `[L1.point2]` and `l1.point2` are accepted. */
function citedSources(raw: unknown, catalog: Catalog): string[] {
    const f = isObj(raw) ? raw : {};
    const out = new Set<string>();
    for (const s of strings(f.sources)) {
        const id = s.replace(/^\[|\]$/g, '').trim().replace(/^([lm])(\d)/, (_, a: string, d: string) => a.toUpperCase() + d);
        if (catalog.sourceIds.has(id)) out.add(id);
    }
    return [...out];
}

/**
 * A flat slide from the model as a typed `Slide`. `pick` resolves a momentId to a shot name, or
 * null, which drops the shot: a `shot` slide without one becomes a `point`.
 */
function toSlide(raw: unknown, pick: (momentId: unknown) => string | null): Slide {
    const f = isObj(raw) ? raw : {};
    const kind: SlideKind = (SLIDE_KINDS as readonly unknown[]).includes(f.kind) ? (f.kind as SlideKind) : 'point';
    const title = line(f.title) ?? '';
    const shot = (): ShotRef | undefined => {
        const name = pick(f.momentId);
        return name ? { name } : undefined;
    };
    switch (kind) {
        case 'cover':
            return compact({ kind, kicker: line(f.kicker), title, highlight: line(f.highlight), subtitle: line(f.subtitle), shot: shot() });
        case 'point':
            return compact({ kind, n: posInt(f.n), title, body: line(f.body), shot: shot(), tip: line(f.tip) });
        case 'list':
            return {
                kind, title,
                items: arr(f.items).map((it) => {
                    const o = isObj(it) ? it : {};
                    return compact({ icon: line(o.icon), text: line(o.text) ?? '', sub: line(o.sub) });
                }),
            };
        case 'compare':
            return compact({
                kind, title: line(f.title),
                left: { label: line(f.leftLabel) ?? '', items: strings(f.leftItems).map(oneLine) },
                right: { label: line(f.rightLabel) ?? '', items: strings(f.rightItems).map(oneLine) },
            });
        case 'steps':
            return {
                kind, title,
                steps: arr(f.steps).map((st) => {
                    const o = isObj(st) ? st : {};
                    return compact({ title: line(o.title) ?? '', body: line(o.body) });
                }),
            };
        case 'prompt':
            return compact({ kind, title, label: line(f.label), prompt: block(f.prompt) ?? '', note: line(f.note) });
        case 'stat':
            return compact({ kind, value: line(f.value) ?? '', label: line(f.label) ?? '', body: line(f.body) });
        case 'shot': {
            const ref = shot();
            return ref
                ? compact({ kind, title, shot: ref, caption: line(f.caption) })
                : compact({ kind: 'point' as const, title, body: line(f.caption) });
        }
        case 'cta':
            return compact({ kind, promise: line(f.promise) });
    }
}

// ─── Captions ───────────────────────────────────────────────────────────────────────────────

function paragraphs(raw: unknown): string[][] {
    const text = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : '';
    return text.split(/\n[ \t]*\n/)
        .map((p) => p.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()))
        .filter((p) => p.length);
}
const joinParas = (ps: string[][]): string => ps.filter((p) => p.length).map((p) => p.join('\n')).join('\n\n').trim();
const isHashtagLine = (l: string): boolean => {
    const t = l.trim();
    return t.startsWith('#') && t.split(/\s+/).every((w) => w.startsWith('#'));
};
const tagsIndex = (ps: string[][]): number => {
    const last = ps.at(-1);
    return last && last.every(isHashtagLine) ? ps.length - 1 : ps.length;
};

/** A line's words for comparison: normalised, letters and digits only. */
function words(s: string): string[] {
    return normalizeArabic(s).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w.length > 1);
}

/** How much of `target`'s wording `l` carries, 0..1. */
function overlap(l: string, target: string): number {
    const t = new Set(words(target));
    if (!t.size) return 0;
    const have = new Set(words(l));
    let n = 0;
    for (const w of t) if (have.has(w)) n++;
    return n / t.size;
}

/** Matches a line that quotes one of the keywords: "k", «k», “k”. */
function quotedKeywords(keywords: readonly string[]): RegExp | null {
    const ks = [...new Set(keywords.filter(Boolean))].map(escapeRegExp);
    return ks.length ? new RegExp(`["«“']\\s*(?:${ks.join('|')})\\s*["»”']`, 'u') : null;
}

/** Whether `l` is a version of the keyword ask: the same wording, or a quoted keyword and part of it. */
function looksLikeAsk(l: string, askTemplate: string, quoted: RegExp | null): boolean {
    const wording = fillKeyword(askTemplate, '');
    const o = overlap(l, wording);
    return o >= 0.6 || (o >= 0.3 && (quoted?.test(l) ?? false));
}

/**
 * The Instagram caption with this tenant's exact keyword ask (replacing the model's version of it,
 * or added before the hashtags) and its save line (added before the ask when missing).
 */
export function normalizeInstagramCaption(raw: unknown, keyword: string | null, candidates: readonly string[], settings: StudioSettings): string {
    const ps = paragraphs(raw);
    const template = settings?.cta?.instagramAsk?.trim() ?? '';
    const ask = keyword && template ? fillKeyword(template, keyword) : '';
    if (ask) {
        const quoted = quotedKeywords([keyword!, ...candidates]);
        let placed = false;
        for (const p of ps) {
            for (let i = 0; i < p.length; i++) {
                const l = p[i]!;
                if (!l.includes(ask) && !looksLikeAsk(l, template, quoted)) continue;
                if (placed) p.splice(i--, 1);
                else { p[i] = l.includes(ask) ? l : ask; placed = true; }
            }
        }
        if (!placed) ps.splice(tagsIndex(ps), 0, [ask]);
    }
    const save = saveLine(settings);
    const saveWord = settings?.cta?.slide?.save?.trim() ?? '';
    if (save && !ps.some((p) => p.some((l) => l.includes(saveWord)))) {
        const at = ask ? ps.findIndex((p) => p.some((l) => l.includes(ask))) : -1;
        ps.splice(at < 0 ? tagsIndex(ps) : at, 0, [save]);
    }
    return joinParas(ps);
}

/**
 * The TikTok caption with no keyword ask (TikTok can't auto-reply), this tenant's exact link line,
 * and the language's learning hashtags.
 */
export function normalizeTiktokCaption(raw: unknown, candidates: readonly string[], settings: StudioSettings): string {
    const ps = paragraphs(raw);
    const template = settings?.cta?.instagramAsk?.trim() ?? '';
    if (template) {
        const quoted = quotedKeywords(candidates);
        for (const p of ps) for (let i = 0; i < p.length; i++) if (looksLikeAsk(p[i]!, template, quoted)) p.splice(i--, 1);
    }
    const link = tiktokLine(settings);
    if (link) {
        let placed = false;
        for (const p of ps) {
            for (let i = 0; i < p.length; i++) {
                const l = p[i]!;
                if (!l.includes(link) && overlap(l, link) < 0.6) continue;
                if (placed) p.splice(i--, 1);
                else { p[i] = l.includes(link) ? l : link; placed = true; }
            }
        }
        if (!placed) ps.splice(tagsIndex(ps.filter((p) => p.length)), 0, [link]);
    }
    const kept = ps.filter((p) => p.length);
    const present = new Set((joinParas(kept).match(/#[^\s#]+/g) ?? []).map((t) => t.toLowerCase()));
    const missing = languageKit(settings).learnTags.filter((t) => !present.has(t.toLowerCase()));
    if (missing.length) {
        const last = kept.at(-1);
        if (last && last.every(isHashtagLine)) last[last.length - 1] = `${last[last.length - 1]} ${missing.join(' ')}`;
        else kept.push([missing.join(' ')]);
    }
    return joinParas(kept);
}

// ─── The writer's own rules ─────────────────────────────────────────────────────────────────

type Problems = { hard: string[]; soft: string[] };

type Candidate = {
    carousel: Carousel;
    /** Per slide: the cited ids that exist in the catalog. */
    sources: string[][];
    shots: Record<string, ShotSpec>;
    keyword: KeywordChoice | null;
    keywordNotes: string[];
    variants: string[];
    dmQuestion: string;
    dmPitch: string;
};

type DraftEnv = {
    settings: StudioSettings;
    catalog: Catalog;
    accent: string;
    fixed: KeywordChoice | null;
    active: readonly string[];
    target: number;
};

const hashtagCount = (s: string): number => (s.match(/#[^\s#]+/g) ?? []).length;

function avoidPattern(settings: StudioSettings): RegExp | null {
    const terms = strings(settings?.voice?.avoid).map(escapeRegExp);
    return terms.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
}

/** Every piece of generated copy, labelled, for the avoid-list check. */
function copyOf(slides: readonly Slide[], offset: number, extra: Record<string, string>): [string, string][] {
    const out: [string, string][] = [];
    slides.forEach((s, i) => {
        for (const f of slideTextFields(s, slideLabel(i + offset, s))) {
            const v = f.holder[f.key];
            if (typeof v === 'string') out.push([f.label, v]);
        }
    });
    for (const [k, v] of Object.entries(extra)) out.push([k, v]);
    return out;
}

function avoidProblems(copy: [string, string][], settings: StudioSettings): string[] {
    const re = avoidPattern(settings);
    if (!re) return [];
    return copy.flatMap(([label, v]) => {
        const m = re.exec(v);
        return m ? [`${label}: mentions «${m[0]}», which this creator never mentions`] : [];
    });
}

function timeWordIn(s: string, settings: StudioSettings): string | null {
    const ws = languageKit(settings).timeWords.map(escapeRegExp);
    if (!ws.length) return null;
    const m = new RegExp(`(?<![\\p{L}\\p{N}])[وفبل]?(?:${ws.join('|')})(?![\\p{L}\\p{N}])`, 'iu').exec(s);
    return m ? m[0] : null;
}

function draftProblems(cand: Candidate, env: DraftEnv): Problems {
    const c = cand.carousel;
    const hard = validateCarousel(c, new Set(Object.keys(cand.shots)), env.settings);
    const soft: string[] = [];
    const last = c.slides.length - 1;

    c.slides.forEach((s, i) => {
        if (i === 0 || i === last || s.kind === 'cover' || s.kind === 'cta') return;
        if (!cand.sources[i]?.length) {
            hard.push(`${slideLabel(i, s)}: no sources. Cite the ids it rests on, or replace it with a slide the sources support`);
        }
    });

    const names = usedShotNames(c);
    if (names.length > MAX_SHOTS) hard.push(`${names.length} screenshots: use at most ${MAX_SHOTS}`);
    if (new Set(names).size < names.length) hard.push('a moment is used on two slides: use each screen once');
    if (!names.length && env.catalog.hasCleanMoment) soft.push('no screenshot: use 1–3 clean moments (momentId on a cover, point or shot slide)');

    if (!cand.keyword) {
        const why = cand.keywordNotes.length ? cand.keywordNotes.join('; ') : 'none given';
        hard.push(`keyword: no usable candidate (${why}). Pick one word that doesn't overlap an active keyword, or reuse an active one that fits the topic`);
    }
    if (!cand.dmQuestion) hard.push('dmQuestion: required');
    if (!cand.dmPitch) hard.push('dmPitch: required');
    hard.push(...avoidProblems(copyOf(c.slides, 0, {
        'captions.instagram': c.captions.instagram, 'captions.tiktokTitle': c.captions.tiktokTitle,
        'captions.tiktok': c.captions.tiktok, dmQuestion: cand.dmQuestion, dmPitch: cand.dmPitch,
    }), env.settings));

    if (c.slides.length !== env.target) soft.push(`asked for ${env.target} slides, got ${c.slides.length}`);
    const middle = c.slides.slice(1, -1).map((s) => s.kind);
    const need = Math.min(4, middle.length);
    const distinct = new Set(middle).size;
    if (distinct < need) soft.push(`only ${distinct} different slide kinds between cover and cta: use at least ${need}`);
    for (let i = 2; i < middle.length; i++) {
        if (middle[i] === middle[i - 1] && middle[i] === middle[i - 2]) {
            soft.push(`slides ${i}–${i + 2} are all ${middle[i]}: don't use one kind 3 times in a row`);
        }
    }
    if (env.catalog.hasPrompts && !middle.includes('prompt')) {
        soft.push('no prompt slide, though the notes quote an on-screen prompt: add one, it\'s the slide people save');
    }
    const igTags = hashtagCount(c.captions.instagram);
    if (igTags < 4 || igTags > 6) soft.push(`captions.instagram has ${igTags} hashtags: use 4–6`);
    const ttTags = hashtagCount(c.captions.tiktok);
    if (ttTags < 4 || ttTags > 6) soft.push(`captions.tiktok has ${ttTags} hashtags: use 4–6`);
    for (const [k, v] of [['tiktokTitle', c.captions.tiktokTitle], ['tiktok', c.captions.tiktok]] as const) {
        const w = timeWordIn(v, env.settings);
        if (w) soft.push(`captions.${k} uses the time word «${w}»: TikTok posts go out later, so drop it`);
    }
    return { hard, soft };
}

function assemble(raw: unknown, env: DraftEnv): Candidate {
    const r = isObj(raw) ? raw : {};
    const shots: Record<string, ShotSpec> = {};
    const pick = (id: unknown): string | null => {
        const m = findMoment(env.catalog, id);
        if (!m || m.clean !== true) return null;
        const name = shotName(String(m.id));
        shots[name] = shotSpecFor(m);
        return name;
    };
    const flat = arr(r.slides);
    const slides = flat.map((f) => toSlide(f, pick));

    const candidates = strings([r.keyword, ...arr(r.keywordAlternatives)]);
    let keyword = env.fixed;
    let keywordNotes: string[] = [];
    if (!keyword) {
        const res = chooseKeyword(candidates, env.active);
        keyword = res.choice;
        keywordNotes = res.rejected;
    }
    const caps = isObj(r.captions) ? r.captions : {};
    const carousel: Carousel = {
        id: safeId(r.id),
        accent: env.accent,
        keyword: keyword?.keyword ?? '',
        slides,
        captions: {
            instagram: normalizeInstagramCaption(caps.instagram, keyword?.keyword ?? null, candidates, env.settings),
            tiktokTitle: line(caps.tiktokTitle) ?? '',
            tiktok: normalizeTiktokCaption(caps.tiktok, [...candidates, ...(keyword ? [keyword.keyword] : [])], env.settings),
        },
    };
    return {
        carousel,
        sources: flat.map((f) => citedSources(f, env.catalog)),
        shots,
        keyword,
        keywordNotes,
        variants: keyword?.create ? cleanVariants(r.variants, keyword.keyword, env.active) : [],
        dmQuestion: line(r.dmQuestion) ?? '',
        dmPitch: line(r.dmPitch) ?? '',
    };
}

// ─── Safe fixes ─────────────────────────────────────────────────────────────────────────────

function withoutShot(s: Slide): Slide {
    if (s.kind === 'shot') return compact({ kind: 'point' as const, title: s.title, body: s.caption });
    const copy = { ...s } as Slide & { shot?: ShotRef };
    delete copy.shot;
    return copy;
}

/** Keeps the first `MAX_SHOTS` distinct shots and drops the rest. */
function capShots(slides: Slide[]): Slide[] {
    const kept = new Set<string>();
    return slides.map((s) => {
        const ref = (s as { shot?: ShotRef }).shot;
        if (!ref) return s;
        if (!kept.has(ref.name) && kept.size < MAX_SHOTS) {
            kept.add(ref.name);
            return s;
        }
        return withoutShot(s);
    });
}

/** Over-long item lists shrink to their maximum; compare sides shrink to the same length. */
function shrinkCounts(s: Slide): void {
    if (s.kind === 'list' && s.items.length > COUNTS.listItems[1]) s.items = s.items.slice(0, COUNTS.listItems[1]);
    if (s.kind === 'steps' && s.steps.length > COUNTS.steps[1]) s.steps = s.steps.slice(0, COUNTS.steps[1]);
    if (s.kind === 'compare') {
        const n = Math.min(s.left.items.length, s.right.items.length, COUNTS.compareItems[1]);
        if (n >= COUNTS.compareItems[0]) {
            s.left.items = s.left.items.slice(0, n);
            s.right.items = s.right.items.slice(0, n);
        }
    }
}

/** Digits, then budgets, then a highlight the trim cut out of its title. Mutates `slides`. */
function fixSlideText(slides: Slide[], settings: StudioSettings, offset = 0): void {
    const digits = settings?.voice?.digits === 'arabic-indic';
    slides.forEach((s, i) => {
        for (const f of slideTextFields(s, slideLabel(i + offset, s))) {
            const v = f.holder[f.key];
            if (typeof v !== 'string') continue;
            let next = digits && f.digits ? toArabicDigits(v) : v;
            if (next.length > f.max) next = trimText(next, f.max);
            if (next === v) continue;
            if (next || Array.isArray(f.holder)) f.holder[f.key] = next;
            else delete f.holder[f.key];
        }
        if (s.kind === 'cover' && s.highlight && !s.title.includes(s.highlight)) delete s.highlight;
    });
}

function finalize(cand: Candidate, env: DraftEnv): Candidate {
    const c = structuredClone(cand.carousel);
    const sources = cand.sources.map((s) => [...s]);
    const drop = (i: number): void => { c.slides.splice(i, 1); sources.splice(i, 1); };
    // Unsourced slides go, while the carousel keeps its minimum.
    for (let i = c.slides.length - 2; i >= 1; i--) {
        if (!sources[i]?.length && c.slides.length > COUNTS.slides[0]) drop(i);
    }
    while (c.slides.length > COUNTS.slides[1]) drop(c.slides.length - 2);
    c.slides = capShots(c.slides);
    c.slides.forEach(shrinkCounts);
    fixSlideText(c.slides, env.settings);
    c.captions.tiktokTitle = trimText(c.captions.tiktokTitle, CAPTION_LIMITS.tiktokTitle);

    const used = new Set(usedShotNames(c));
    const shots = Object.fromEntries(Object.entries(cand.shots).filter(([name]) => used.has(name)));
    const lang = languageKit(env.settings);
    return {
        ...cand, carousel: c, sources, shots,
        dmQuestion: cand.dmQuestion || lang.fallbackQuestion,
        dmPitch: cand.dmPitch || lang.fallbackPitch,
    };
}

/** Lower is better: problems left after the safe fixes, then hard problems, then soft ones. */
function rank(cand: Candidate, env: DraftEnv): [number, number, number] {
    const p = draftProblems(cand, env);
    return [draftProblems(finalize(cand, env), env).hard.length, p.hard.length, p.soft.length];
}
const noWorse = (a: readonly number[], b: readonly number[]): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
    return true;
};

// ─── generateDraft ──────────────────────────────────────────────────────────────────────────

export async function generateDraft(input: DraftInput, sources: GenSource[], ctx: GenContext, opts: GenOptions = {}): Promise<DraftResult> {
    const started = Date.now();
    const deadline = started + (opts.timeoutMs ?? GENERATION_TIMEOUT_MS);
    const call = opts.callModel ?? modelCaller;
    const settings = ctx?.settings ?? defaultStudioSettings();
    const list = Array.isArray(sources) ? sources : [];

    if (list.length > 3) throw new StudioGenerationError(`A draft uses at most 3 lessons, not ${list.length}`);
    if (!list.length && !input?.idea?.trim()) throw new StudioGenerationError('A draft needs a lesson or an idea');
    let fixed: KeywordChoice | null = null;
    if (input.keyword?.trim()) {
        const k = cleanKeyword(input.keyword);
        if (!k) throw new StudioGenerationError(`The keyword "${input.keyword}" must be one word`);
        const n = normalizeArabic(k);
        fixed = { keyword: k, create: !activeKeywordList(ctx.activeKeywords ?? []).some((a) => a.norm === n) };
    }

    const env: DraftEnv = {
        settings,
        catalog: buildCatalog(list, settings, input.idea),
        accent: pickAccent(input.accent, paletteOf(ctx), ctx.recentAccents ?? []),
        fixed,
        active: ctx.activeKeywords ?? [],
        target: slideTarget(input.slides),
    };
    const system = buildSystemPrompt(settings);
    const turns: ModelTurn[] = [{
        role: 'user',
        text: draftUserPrompt({
            input, catalog: env.catalog, slides: env.target, keyword: fixed?.keyword ?? null,
            activeKeywords: activeKeywordList(env.active).map((k) => k.raw), recentTopics: ctx.recentTopics ?? [],
        }),
    }];

    let raw = await callWithin(call, { purpose: 'draft', system, turns, schema: DRAFT_SCHEMA, temperature: 0.8, thinkingBudget: THINKING.draft }, deadline, 1);
    let cand = assemble(raw, env);
    let probs = draftProblems(cand, env);
    let best = { cand, rank: rank(cand, env) };
    let rounds = 0;

    while (rounds < MAX_REPAIR_ROUNDS && (probs.hard.length || probs.soft.length)) {
        if (deadline - Date.now() < MIN_REPAIR_MS) {
            log('warn', 'studio.repair_skipped', { round: rounds + 1, left_ms: deadline - Date.now() });
            break;
        }
        rounds++;
        turns.push({ role: 'model', text: JSON.stringify(raw) }, { role: 'user', text: repairPrompt([...probs.hard, ...probs.soft]) });
        try {
            raw = await callWithin(call, { purpose: 'repair', system, turns, schema: DRAFT_SCHEMA, temperature: 0.4, thinkingBudget: THINKING.repair }, deadline, 0);
        } catch (err) {
            log('warn', 'studio.repair_failed', { round: rounds, message: errorMessage(err) });
            break;
        }
        cand = assemble(raw, env);
        probs = draftProblems(cand, env);
        const r = rank(cand, env);
        if (noWorse(r, best.rank)) best = { cand, rank: r };
    }

    const final = finalize(best.cand, env);
    const left = draftProblems(final, env).hard;
    log(left.length ? 'warn' : 'info', 'studio.draft_generated', {
        rounds, problems_left: left.length, ms: Date.now() - started, slides: final.carousel.slides.length,
    });
    if (left.length || !final.keyword) {
        throw new StudioGenerationError(`The draft still breaks ${left.length} rule(s) after ${rounds} repair round(s)`, left);
    }
    return {
        carousel: final.carousel,
        shots: final.shots,
        campaign: {
            keyword: final.keyword.keyword,
            variants: final.variants,
            dm: buildDm(settings.cta?.dmTemplate ?? '', {
                question: final.dmQuestion, pitch: final.dmPitch,
                url: settings.product?.url ?? '', bullets: settings.product?.dmBullets ?? [],
            }),
            create: final.keyword.create,
        },
    };
}

// ─── rewriteSlide ───────────────────────────────────────────────────────────────────────────

/**
 * One slide rewritten within its budgets. Slide 1 stays a cover and the last stays a cta. A
 * screenshot may only be one the carousel already shows: the draft's `shots` map holds nothing
 * else, and this returns only the slide.
 */
export async function rewriteSlide(
    carousel: Carousel, index: number, instruction: string | undefined, sources: GenSource[], ctx: GenContext, opts: GenOptions = {},
): Promise<Slide> {
    const slides = Array.isArray(carousel?.slides) ? carousel.slides : [];
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) {
        throw new StudioGenerationError(`There's no slide ${index + 1}: the carousel has ${slides.length}`);
    }
    const deadline = Date.now() + (opts.timeoutMs ?? GENERATION_TIMEOUT_MS);
    const call = opts.callModel ?? modelCaller;
    const settings = ctx?.settings ?? defaultStudioSettings();
    const list = Array.isArray(sources) ? sources : [];
    const last = slides.length - 1;
    const middle = index !== 0 && index !== last;
    const allowedKinds: SlideKind[] = index === 0 ? ['cover'] : index === last ? ['cta'] : SLIDE_KINDS.filter((k) => k !== 'cover' && k !== 'cta');
    const catalog = buildCatalog(list, settings);

    const existing = new Set(usedShotNames(carousel));
    const aliasOf = new Map<string, string>();
    for (const [alias, m] of catalog.moments) if (existing.has(shotName(String(m.id)))) aliasOf.set(shotName(String(m.id)), alias);
    const allowedMoments = [...existing].map((n) => aliasOf.get(n) ?? n);
    const pick = (raw: unknown): string | null => {
        if (typeof raw !== 'string' || !raw.trim()) return null;
        if (existing.has(raw.trim())) return raw.trim();
        const m = findMoment(catalog, raw);
        const name = m ? shotName(String(m.id)) : null;
        return name && existing.has(name) ? name : null;
    };
    const needsSources = middle && list.length > 0;
    const assess = (slide: Slide, cited: readonly string[]): string[] => {
        const next: Carousel = { ...carousel, slides: slides.map((s, i) => (i === index ? slide : s)) };
        const own = `slide ${index + 1} (`;
        const problems = validateCarousel(next, existing, settings).filter((p) => p.startsWith(own));
        if (!allowedKinds.includes(slide.kind)) problems.push(`slide ${index + 1} must be ${allowedKinds.join(' or ')}, not ${slide.kind}`);
        if (needsSources && !cited.length) problems.push(`${slideLabel(index, slide)}: no sources. Cite the ids it rests on`);
        problems.push(...avoidProblems(copyOf([slide], index, {}), settings));
        return problems;
    };

    const system = buildSystemPrompt(settings);
    const turns: ModelTurn[] = [{
        role: 'user',
        text: rewriteUserPrompt({ carousel, index, instruction, allowedKinds, allowedMoments, catalog }),
    }];
    let raw = await callWithin(call, { purpose: 'rewrite', system, turns, schema: SLIDE_SCHEMA, temperature: 0.7, thinkingBudget: THINKING.rewrite }, deadline, 1);
    let slide = toSlide(raw, pick);
    let cited = citedSources(raw, catalog);
    let problems = assess(slide, cited);
    let best = { slide, cited, problems };

    for (let round = 1; round <= MAX_REPAIR_ROUNDS && problems.length; round++) {
        if (deadline - Date.now() < MIN_CALL_MS * 2) break;
        turns.push({ role: 'model', text: JSON.stringify(raw) }, { role: 'user', text: repairPrompt(problems) });
        try {
            raw = await callWithin(call, { purpose: 'rewrite-repair', system, turns, schema: SLIDE_SCHEMA, temperature: 0.4, thinkingBudget: THINKING.repair }, deadline, 0);
        } catch (err) {
            log('warn', 'studio.rewrite_repair_failed', { round, message: errorMessage(err) });
            break;
        }
        slide = toSlide(raw, pick);
        cited = citedSources(raw, catalog);
        problems = assess(slide, cited);
        if (problems.length <= best.problems.length) best = { slide, cited, problems };
    }

    const fixedSlide = structuredClone(best.slide);
    shrinkCounts(fixedSlide);
    fixSlideText([fixedSlide], settings, index);
    const left = assess(fixedSlide, best.cited);
    if (left.length) throw new StudioGenerationError(`Slide ${index + 1} still breaks ${left.length} rule(s)`, left);
    return fixedSlide;
}

// ─── planWeek ───────────────────────────────────────────────────────────────────────────────

function toProposals(raw: unknown, catalog: PlanCatalog, settings: StudioSettings): Proposal[] {
    const avoid = avoidPattern(settings);
    const seen = new Set<string>();
    const out: Proposal[] = [];
    for (const item of arr(isObj(raw) ? raw.proposals : raw)) {
        const p = isObj(item) ? item : {};
        const lessonIds = [...new Set(strings(p.lessons)
            .map((a) => catalog.lessons.get(a.replace(/^\[|\]$/g, '').toUpperCase())?.id)
            .filter((id): id is string => typeof id === 'string'))].slice(0, 3);
        const title = line(p.title);
        if (!lessonIds.length || !title) continue;
        const idea = line(p.idea);
        if (avoid && (avoid.test(title) || (idea && avoid.test(idea)))) continue;
        const angle: Angle = (PLAN_ANGLES as readonly unknown[]).includes(p.angle) ? (p.angle as Angle) : 'auto';
        const key = `${[...lessonIds].sort().join('+')}|${angle}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(compact({ lessonIds, idea, angle, slides: slideTarget(p.slides), title, rationale: line(p.rationale) ?? '' }));
    }
    return out;
}

/**
 * `count` proposals for the coming posts, varied across lessons and angles and away from recent
 * topics. Each gets its own accent, so drafts generated side by side don't all pick the same one.
 * Slots are the caller's business.
 */
export async function planWeek(count: number, lessons: LessonRow[], ctx: GenContext, opts: GenOptions = {}): Promise<Proposal[]> {
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n < 1) throw new StudioGenerationError('count must be at least 1');
    const want = Math.min(n, MAX_PLAN);
    const settings = ctx?.settings ?? defaultStudioSettings();
    const all = (Array.isArray(lessons) ? lessons : []).filter((l) => l && typeof l.id === 'string');
    const indexed = all.filter((l) => l.notes);
    const pool = indexed.length ? indexed : all;
    if (!pool.length) throw new StudioGenerationError('There are no lessons to plan from: scan the library first');

    const deadline = Date.now() + (opts.timeoutMs ?? GENERATION_TIMEOUT_MS);
    const call = opts.callModel ?? modelCaller;
    const catalog = buildPlanCatalog(pool);
    const system = buildPlanSystemPrompt(settings);
    const turns: ModelTurn[] = [{ role: 'user', text: planUserPrompt(want, catalog, ctx.recentTopics ?? []) }];
    const raw = await callWithin(call, { purpose: 'plan', system, turns, schema: PLAN_SCHEMA, temperature: 0.9, thinkingBudget: THINKING.plan }, deadline, 1);
    let proposals = toProposals(raw, catalog, settings);

    if (proposals.length < want && deadline - Date.now() >= MIN_REPAIR_MS) {
        turns.push({ role: 'model', text: JSON.stringify(raw) }, {
            role: 'user',
            text: `Only ${proposals.length} of those are usable: each needs 1–3 lesson ids from the list and a title, and no two may share the same lessons and angle. Return all ${want} again.`,
        });
        try {
            const again = toProposals(
                await callWithin(call, { purpose: 'plan-repair', system, turns, schema: PLAN_SCHEMA, temperature: 0.7, thinkingBudget: THINKING.repair }, deadline, 0),
                catalog, settings,
            );
            if (again.length > proposals.length) proposals = again;
        } catch (err) {
            log('warn', 'studio.plan_repair_failed', { message: errorMessage(err) });
        }
    }
    if (!proposals.length) throw new StudioGenerationError('The planner returned no usable proposals');

    const kept = proposals.slice(0, want);
    const accents = pickAccents(kept.length, paletteOf(ctx), ctx.recentAccents ?? []);
    return kept.map((p, i) => ({ ...p, accent: accents[i]! }));
}
