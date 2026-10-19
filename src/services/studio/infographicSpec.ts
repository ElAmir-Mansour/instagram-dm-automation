/**
 * Animated infographics (v31): what one is, what Claude is asked to write, and the checks on both.
 * Pure — no database — so every rule here is testable on its own. infographics.ts is the rows and
 * the routes' work; jobs.ts applies the worker's result through `parseInfographicResult`.
 *
 * An infographic compares two or three things ("RAG vs CAG vs KAG"): one column each, every column
 * a name, the kind of problem it suits, a one-line note and exactly three steps, each with a small
 * animated diagram. The worker's template (aicourse-captions src/infographic) draws it in the
 * tenant's personal brand (`studio_settings.infographic`), in a dark or a light theme, and renders
 * it as an MP4, a GIF and a cover.
 *
 * Claude writes the page and its caption in ONE answer, from the same content, so the caption is
 * about the GIF it goes with: it must name every column the GIF shows (`captionProblems`), and
 * nothing is scheduled while it does not.
 */
import type { RenderInfographicPayload } from '../../db/rows.js';
import { withArticle } from '../profile/article.js';
import type { ProfileContext } from '../profile/context.js';
import type { ArabicRegister, Domain } from '../profile/types.js';
import type { InfographicConfig, InfographicTheme } from './settingsTypes.js';
import { isPlainObject } from './common.js';

// ─── The spec: what the template draws ──────────────────────────────────────────────────

/** The diagrams the template can draw (minis.tsx), and what each one shows, for the prompt. */
export const DIAGRAMS = {
    docs: 'a stack of documents: a large collection. `label`: a short badge, e.g. "10K+ docs"',
    'chunk-db': 'a document cut into chunks that flow into a vector database',
    topk: 'a query finding its nearest points: similarity search',
    augment: 'retrieved context flowing into a model box that writes an answer. `label`: the box, default "LLM"',
    window: 'documents that all fit inside a context window',
    preload: 'documents loaded up front into a long context',
    kv: 'K and V cache cells filling up, then saved',
    instant: 'a cache plus a question giving an answer at once, with no lookup',
    graph: 'a knowledge graph around one central node',
    'graph-build': 'text turned into a graph of entities and links',
    hops: 'a query hopping through a graph, one step at a time',
    grounded: 'an answer with its source attached',
    chat: 'chat bubbles appearing one after another',
    loop: 'an agent loop: a dot circling a robot',
    icon: 'one line icon, named in `icon`',
} as const;
export type DiagramKind = keyof typeof DIAGRAMS;
export const DIAGRAM_KINDS = Object.keys(DIAGRAMS) as DiagramKind[];

/** The icons a diagram of kind `icon` may name: the template's set (Tabler), objects and symbols only. */
export const DIAGRAM_ICONS: readonly string[] = [
    'brain', 'bulb', 'rocket', 'robot', 'code', 'terminal-2', 'database', 'cloud', 'server', 'cpu', 'device-laptop',
    'device-mobile', 'world', 'map', 'compass', 'target', 'trophy', 'star', 'flame', 'bolt', 'search', 'question-mark',
    'check', 'x', 'circle-check', 'circle-x', 'arrow-right', 'trending-up', 'trending-down', 'chart-bar', 'chart-pie',
    'report-analytics', 'file-text', 'files', 'folder', 'book', 'books', 'notebook', 'pencil', 'writing',
    'message-circle', 'messages', 'mail', 'phone', 'lock', 'lock-open', 'key', 'shield-check', 'settings', 'tool',
    'tools', 'puzzle', 'school', 'certificate', 'shopping-cart', 'coin', 'cash', 'camera', 'video', 'microphone',
    'photo', 'palette', 'wand', 'sparkles', 'link', 'share', 'download', 'upload', 'refresh', 'repeat', 'player-play',
    'news', 'clock', 'hourglass', 'calendar', 'alarm', 'alert-triangle', 'eye', 'stairs-up', 'language', 'wifi',
];

/** A diagram as the template takes it (MiniSpec): `name` is the icon's, `badge` the docs', `label` the model box's. */
export type Mini = { kind: DiagramKind; name?: string; badge?: string; label?: string };

/** A technology's logo, found by the worker in simple-icons from the name Claude gives: its title, colour and 24×24 path. */
export type InfographicLogo = { title: string; hex: string; path: string };

/** A real product or tool that does what a column describes: its logo when simple-icons has one, else its name alone. */
export type InfographicExample = { title: string; hex: string | null; path: string | null };

export type InfographicColumn = {
    name: string;
    logo?: InfographicLogo;
    examples?: InfographicExample[];
    hero: Mini;
    kind: string;
    note: string;
    steps: { mini: Mini; title: string; desc: string }[];
};

/** The template's input (InfographicSpec in Infographic.tsx). `title` is the columns' names. */
export type InfographicSpec = {
    dir: 'rtl' | 'ltr';
    title: string[];
    subtitle: { text: string; accent?: string };
    columns: InfographicColumn[];
};

export const STEPS_PER_COLUMN = 3;

/**
 * Text budgets, in characters, by column count: what the 1080×1350 page fits at its font sizes
 * (two columns get one-line notes and descriptions at a larger size). Claude is asked for these;
 * the check allows a little over, since a line slightly long still fits.
 */
export const BUDGETS = {
    name: 14,
    subtitle: 60,
    accent: 30,
    kind: { 2: 30, 3: 26 },
    note: { 2: 40, 3: 46 },
    stepTitle: { 2: 24, 3: 20 },
    stepDesc: { 2: 40, 3: 48 },
    label: 12,
    caption: 2200,
} as const;
const SLACK = 6;
/** Real products shown under a column, as logos. */
export const MAX_EXAMPLES = 3;
/** Likely expert comments Claude prepares a reply for. */
export const MAX_OBJECTIONS = 3;
const MAX_REVIEW_TEXT = 700;

/** An SVG path's commands and numbers only: it is drawn as a `d` attribute, never as markup. */
const SVG_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/;
const isExample = (v: unknown): boolean =>
    isPlainObject(v) && typeof v.title === 'string' && v.title.trim().length > 0 && v.title.length <= 40
    && (v.hex === null || (typeof v.hex === 'string' && /^#[0-9a-f]{6}$/i.test(v.hex)))
    && (v.path === null || (typeof v.path === 'string' && v.path.length > 0 && v.path.length <= 20_000 && SVG_PATH.test(v.path)));
const isLogo = (v: unknown): boolean =>
    isPlainObject(v) && typeof v.title === 'string' && v.title.length <= 60 && typeof v.hex === 'string' && /^#[0-9a-f]{6}$/i.test(v.hex)
    && typeof v.path === 'string' && v.path.length > 0 && v.path.length <= 20_000 && SVG_PATH.test(v.path);

/** Everything wrong with a spec, as sentences an operator can act on. Empty means it renders and fits. */
export function specProblems(spec: unknown): string[] {
    const problems: string[] = [];
    if (!isPlainObject(spec)) return ['The infographic has no content yet.'];
    if (spec.dir !== 'rtl' && spec.dir !== 'ltr') problems.push('dir must be rtl or ltr');
    const columns = spec.columns;
    if (!Array.isArray(columns) || columns.length < 2 || columns.length > 3) {
        problems.push('An infographic compares 2 or 3 things: it needs 2 or 3 columns.');
        return problems;
    }
    const n = columns.length as 2 | 3;
    const text = (value: unknown, where: string, max: number, required = true): void => {
        if (typeof value !== 'string') {
            if (required || value !== undefined) problems.push(`${where} must be text`);
            return;
        }
        if (required && !value.trim()) problems.push(`${where} is empty`);
        else if (value.length > max + SLACK) problems.push(`${where} is ${value.length} characters; it fits ${max}`);
    };
    const mini = (value: unknown, where: string): void => {
        if (!isPlainObject(value) || !DIAGRAM_KINDS.includes(value.kind as DiagramKind)) {
            problems.push(`${where} must be one of the diagrams: ${DIAGRAM_KINDS.join(', ')}`);
            return;
        }
        if (value.kind === 'icon' && !DIAGRAM_ICONS.includes(value.name as string)) {
            problems.push(`${where} is an icon, so it needs one of the icon names (e.g. robot, database, target)`);
        }
        text(value.badge, `${where}'s badge`, BUDGETS.label, false);
        text(value.label, `${where}'s label`, BUDGETS.label, false);
    };

    const subtitle = isPlainObject(spec.subtitle) ? spec.subtitle : null;
    if (!subtitle) problems.push('The subtitle is missing');
    else {
        text(subtitle.text, 'The subtitle', BUDGETS.subtitle);
        text(subtitle.accent, 'The subtitle\'s highlighted words', BUDGETS.accent, false);
        if (typeof subtitle.accent === 'string' && subtitle.accent && typeof subtitle.text === 'string' && !subtitle.text.includes(subtitle.accent)) {
            problems.push('The subtitle\'s highlighted words must be part of the subtitle, exactly as written there');
        }
    }

    const names: string[] = [];
    columns.forEach((col: unknown, c: number) => {
        const where = `Column ${c + 1}`;
        if (!isPlainObject(col)) {
            problems.push(`${where} is not a column`);
            return;
        }
        text(col.name, `${where}'s name`, BUDGETS.name);
        if (col.logo !== undefined && !isLogo(col.logo)) problems.push(`${where}'s logo must be { title, hex, path } from the worker`);
        if (col.examples !== undefined) {
            if (!Array.isArray(col.examples) || col.examples.length > MAX_EXAMPLES || !col.examples.every(isExample)) {
                problems.push(`${where}'s examples must be up to ${MAX_EXAMPLES} of { title, hex, path } from the worker`);
            }
        }
        if (typeof col.name === 'string') names.push(col.name.trim().toLowerCase());
        mini(col.hero, `${where}'s main diagram`);
        text(col.kind, `${where}'s "kind of problem" line`, BUDGETS.kind[n]);
        text(col.note, `${where}'s note`, BUDGETS.note[n]);
        if (!Array.isArray(col.steps) || col.steps.length !== STEPS_PER_COLUMN) {
            problems.push(`${where} needs exactly ${STEPS_PER_COLUMN} steps`);
            return;
        }
        col.steps.forEach((step: unknown, i: number) => {
            const at = `${where}, step ${i + 1}`;
            if (!isPlainObject(step)) {
                problems.push(`${at} is not a step`);
                return;
            }
            mini(step.mini, `${at}'s diagram`);
            text(step.title, `${at}'s title`, BUDGETS.stepTitle[n]);
            text(step.desc, `${at}'s description`, BUDGETS.stepDesc[n]);
        });
    });
    if (new Set(names).size !== names.length) problems.push('Two columns have the same name');
    const title = spec.title;
    if (!Array.isArray(title) || title.length !== columns.length || title.some((t, i) => t !== (columns[i] as InfographicColumn)?.name)) {
        problems.push('title must be the columns\' names, in order');
    }
    return problems;
}

/**
 * The caption must be about this GIF: it names every column, as the page writes it (Arabic letters
 * normalised, Latin case ignored). An empty caption or one over Instagram's limit fails too.
 */
export function captionProblems(caption: unknown, spec: unknown): string[] {
    return captionIssues(caption, spec).map((issue) => issue.message);
}

/** One thing wrong with a caption: the sentence `captionProblems` has always returned, and the code and params the 409 carries. */
export interface CaptionIssue {
    code: 'CAPTION_EMPTY' | 'CAPTION_TOO_LONG' | 'CAPTION_MISSING_COLUMNS';
    params: Record<string, unknown>;
    message: string;
}

/**
 * `captionProblems`, with a code per problem (src/services/errorCodes.ts), in the order it has always listed them. Schedule's 409
 * sends the most useful one as its `code` (`primaryCaptionIssue`) and the full list as `problems`.
 */
export function captionIssues(caption: unknown, spec: unknown): CaptionIssue[] {
    if (typeof caption !== 'string' || !caption.trim()) return [{ code: 'CAPTION_EMPTY', params: {}, message: 'The caption is empty.' }];
    const issues: CaptionIssue[] = [];
    if (caption.length > BUDGETS.caption) {
        issues.push({
            code: 'CAPTION_TOO_LONG', params: { length: caption.length, max: BUDGETS.caption },
            message: `The caption is ${caption.length} characters; Instagram takes ${BUDGETS.caption}.`,
        });
    }
    const folded = fold(caption);
    const missing = columnNames(spec).filter((name) => !folded.includes(fold(name)));
    if (missing.length) {
        const list = missing.map((m) => `«${m}»`).join(', ');
        issues.push({
            code: 'CAPTION_MISSING_COLUMNS', params: { columns: missing, list },
            message: `The caption doesn't mention ${list}: it must talk about what the infographic shows.`,
        });
    }
    return issues;
}

/**
 * The issue a single code stands for when there are several: the owner's rule (name every column) first, then an empty caption,
 * then the length. The params of every issue travel together, so a sentence for one can still use a number from another.
 */
export function primaryCaptionIssue(issues: readonly CaptionIssue[]): { code: CaptionIssue['code']; params: Record<string, unknown> } | null {
    const order: CaptionIssue['code'][] = ['CAPTION_MISSING_COLUMNS', 'CAPTION_EMPTY', 'CAPTION_TOO_LONG'];
    const first = order.map((code) => issues.find((issue) => issue.code === code)).find((issue) => issue !== undefined);
    if (!first) return null;
    return { code: first.code, params: Object.assign({}, ...issues.map((issue) => issue.params)) as Record<string, unknown> };
}

const fold = (s: string): string =>
    s.toLowerCase().normalize('NFKC').replace(/[\u064B-\u0652\u0640]/g, '').replace(/[\u0623\u0625\u0622]/g, '\u0627')
        .replace(/\u0649/g, '\u064A').replace(/\u0629/g, '\u0647');

export function columnNames(spec: unknown): string[] {
    if (!isPlainObject(spec) || !Array.isArray(spec.columns)) return [];
    return spec.columns.flatMap((c: unknown) => (isPlainObject(c) && typeof c.name === 'string' && c.name.trim() ? [c.name.trim()] : []));
}

/** "RAG vs CAG vs KAG: how AI reaches outside knowledge", for a YouTube title and the dashboard. */
export function headline(spec: unknown): string {
    const names = columnNames(spec).join(' vs ');
    const sub = isPlainObject(spec) && isPlainObject(spec.subtitle) && typeof spec.subtitle.text === 'string' ? spec.subtitle.text.trim() : '';
    return sub ? `${names}: ${sub}` : names;
}

// ─── What Claude is asked ───────────────────────────────────────────────────────────────

const diagramSchema = {
    type: 'object',
    properties: {
        kind: { type: 'string', enum: DIAGRAM_KINDS },
        icon: { type: 'string', description: 'Only for kind "icon": one of the icon names.' },
        label: { type: 'string', description: 'Only for kind "docs" (a badge) or "augment" (the model box). At most 12 characters.' },
    },
    required: ['kind'],
} as const;

/**
 * Claude's answer. The worker turns it into the template's spec (`dir` from the language, `title`
 * from the names, each diagram's `icon`/`label` into `name`/`badge`/`label`) and returns that spec,
 * which is what the app stores and checks: the one that was rendered.
 */
export const WRITE_SCHEMA = {
    type: 'object',
    properties: {
        subtitle: { type: 'string', description: 'One line under the title: what the comparison is about.' },
        accent: { type: 'string', description: 'The subtitle\'s key words, copied exactly from it: drawn in the accent colour.' },
        columns: {
            type: 'array',
            minItems: 2,
            maxItems: 3,
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    examples: {
                        type: 'array',
                        maxItems: MAX_EXAMPLES,
                        items: { type: 'string' },
                        description: '1–3 real products, tools or services that do what this column describes, by brand name (e.g. PostgreSQL, Veeam, Cloudflare). Shown as their logos.',
                    },
                    logo: {
                        type: 'string',
                        description: 'Only when the column IS a product, language or tool with a logo (e.g. Go, Node.js, Python, PostgreSQL, Docker): its brand name. Omit for ideas and techniques (RAG, Chatbot, Serverless as a concept).',
                    },
                    kind: { type: 'string', description: 'The kind of problem it suits, as a short phrase.' },
                    note: { type: 'string' },
                    hero: diagramSchema,
                    steps: {
                        type: 'array',
                        minItems: STEPS_PER_COLUMN,
                        maxItems: STEPS_PER_COLUMN,
                        items: {
                            type: 'object',
                            properties: { title: { type: 'string' }, desc: { type: 'string' }, diagram: diagramSchema },
                            required: ['title', 'desc', 'diagram'],
                        },
                    },
                },
                required: ['name', 'kind', 'note', 'hero', 'steps', 'examples'],
            },
        },
        caption: { type: 'string', description: 'The post\'s caption, about this infographic.' },
        review: {
            type: 'object',
            description: 'The practitioner review: what experts will most likely comment, and the reply.',
            properties: {
                objections: {
                    type: 'array',
                    minItems: 2,
                    maxItems: MAX_OBJECTIONS,
                    items: {
                        type: 'object',
                        properties: {
                            comment: { type: 'string', description: 'The comment, as an expert would write it.' },
                            reply: { type: 'string', description: 'A short, friendly reply in the post\'s language.' },
                        },
                        required: ['comment', 'reply'],
                    },
                },
            },
            required: ['objections'],
        },
    },
    required: ['subtitle', 'accent', 'columns', 'caption', 'review'],
} as const;

/** The comments experts are likely to post under it, each with a reply ready (the owner's ask, 2026-10-13). */
export type InfographicReview = { objections: { comment: string; reply: string }[] };

export interface WriteRequest {
    topic: string;
    notes: string | null;
    language: 'ar' | 'en';
    /** Words the tenant's voice never uses (`voice.avoid`). */
    avoid: readonly string[];
}

/**
 * What the writer's system prompt reads of the tenant (docs/onboarding/05 §2, P12): who they are (`who.role`,
 * `who.domain`) and the register an Arabic page is policed against (`language.register`). A `ProfileContext<'infographic'>`
 * is one; the pick keeps the builder testable with no more of a profile than it reads.
 */
export type InfographicWriterContext = Pick<ProfileContext<'infographic'>, 'language' | 'who'>;

/** The role as a prompt names the creator: one line, and "creator" for a profile that has none yet. */
const roleOf = (ctx: InfographicWriterContext): string => ctx.who.role.replace(/\s+/g, ' ').trim() || 'creator';

// ─── The dialect-ban line (Arabic pages are فصحى whatever the tenant speaks) ───────────────────

type DialectWords = { ban: readonly string[]; use: readonly string[] };

/** The words every Arabic page avoids, each with the فصحى word that replaces it. For `msa` and `gulf` this is the whole line. */
const DIALECT_BASE: DialectWords = {
    ban: ['يوصل', 'لين', 'يسوّي', 'وش', 'كذا', 'زي', 'علشان', 'بس (in the sense of "only")'],
    use: ['يصل', 'حتى', 'يُنجز', 'ماذا', 'هكذا', 'مثل', 'لأن', 'فقط'],
};

/** What a register adds to the base: the words its speakers reach for, so the writer is told about those too (05 §2, P12). */
const DIALECT_EXTRA: { readonly [R in ArabicRegister]?: DialectWords } = {
    egyptian: { ban: ['عايز', 'إزاي', 'دلوقتي', 'كده'], use: ['أريد', 'كيف', 'الآن', 'هكذا'] },
    levantine: { ban: ['هيك', 'شو', 'بدّك', 'هلق'], use: ['هكذا', 'ماذا', 'تريد', 'الآن'] },
};

/**
 * "Never use dialect: not … Use …": the base for every register, plus the register's own words. A replacement the base
 * already names (هكذا for both كذا and كده) is said once. A null register (an English tenant asked for one Arabic page)
 * is the base alone.
 */
export function dialectLine(register: ArabicRegister | null): string {
    const extra = (register && DIALECT_EXTRA[register]) || { ban: [], use: [] };
    const ban = [...DIALECT_BASE.ban, ...extra.ban];
    const use = [...new Set([...DIALECT_BASE.use, ...extra.use])];
    return `Never use dialect: not ${ban.join('، ')}. Use ${use.join('، ')}.`;
}

// ─── The domain kits ───────────────────────────────────────────────────────────────────────────

/** The lines of the prompt that are about what the creator makes: a developer's stack, or any other field. */
interface DomainKit {
    /** When a column gets a logo. */
    logo: string;
    /** The real examples under a column. */
    examples: string;
    /** What makes a page concrete: the three bullets under "Make it concrete". */
    concrete: readonly [string, string, string];
    /** The practitioner review: its opening line, and the two bullets the domain words (the other two are shared). */
    reviewer: string;
    realWay: string;
    tradeOff: string;
    /** Arabic only: the terms kept in Latin letters. */
    terms: string;
    /** A line after the diagram list, for a field the diagrams do not picture. Null: the list says it all. */
    diagramNote: string | null;
}

const EXAMPLES_HEAD = `Real examples, always: give every column 1–${MAX_EXAMPLES} \`examples\`, the real products, tools or services that do what it describes, by brand name as their makers write it`;
const EXAMPLES_TAIL = 'They are drawn as logos under the column, so readers recognise them at a glance. Only ones a practitioner would agree are true examples of that column, well known, and the same kind of thing across columns. Leave the list empty only when no real product fits.';
const NO_ABSOLUTES = '- No absolutes: not "always", "never", "only", "X is dead". Give the condition each claim depends on.';

/** Today's text, word for word: the owner's field, software. Every byte of it is pinned by the owner's goldens. */
const TECH_KIT: DomainKit = {
    logo: 'When a column is a real product, language or tool (Go, Node.js, PostgreSQL), give its brand name in `logo`: its logo is drawn beside its name. Never for an idea or a technique.',
    examples: `${EXAMPLES_HEAD} (PostgreSQL, Veeam, Cloudflare, Kubernetes). ${EXAMPLES_TAIL}`,
    concrete: [
        '- Pick ONE real example and carry it through every column, e.g. "your API gets 10,000 photo uploads at once" or "a customer asks for a refund". Put it in the subtitle, and let each column\'s steps show what happens to that same example.',
        '- Name the specific feature that makes the difference (e.g. Go\'s goroutines and channels, Node.js\'s event loop), not general claims like "fast" or "scalable".',
        '- Numbers that belong to the example are good (10,000 requests, 8 cores); benchmark figures and percentages are not.',
    ],
    reviewer: 'Practitioner review, before you answer. Read your page and caption as a senior engineer who builds this in production today, and who will comment if anything is off:',
    realWay: '- The example must be how real systems do it now. Where teams do it differently (resize on upload, or on demand behind a cache; inline, or in a job queue), word it so it is true either way, or say which setup you assume ("on a cache miss", "in a background worker").',
    tradeOff: '- Each trade-off must be the one practitioners actually cite, with its standard fix (e.g. Node.js moves CPU work to worker threads).',
    terms: 'Keep the technical terms practitioners say in English in Latin letters (RAG, API, KV Cache, LLM), and use them as column names when that is the term.',
    diagramNote: null,
};

/**
 * Any other field: the same instructions with no stack in them, a reviewer who is "a senior expert in this topic" (a role
 * is a noun phrase and not always a person, so no sentence is built around it but the first), and a note that the
 * diagrams on offer picture AI systems, so that a page about candles or squats reaches for an icon first.
 */
const GENERAL_KIT: DomainKit = {
    logo: 'When a column is a real product, brand or tool, give its brand name in `logo`: its logo is drawn beside its name. Never for an idea or a technique.',
    examples: `${EXAMPLES_HEAD}. ${EXAMPLES_TAIL}`,
    concrete: [
        '- Pick ONE real example and carry it through every column, e.g. "a customer asks for a refund". Put it in the subtitle, and let each column\'s steps show what happens to that same example.',
        '- Name the specific feature that makes the difference, not general claims like "better" or "best".',
        '- Numbers that belong to the example are good; benchmark figures and percentages are not.',
    ],
    reviewer: 'Practitioner review, before you answer. Read your page and caption as a senior expert in this topic would: someone who works with it every day, and who will comment if anything is off:',
    realWay: '- The example must be how it is really done now. Where practitioners do it differently, word it so it is true either way, or say which setup you assume.',
    tradeOff: '- Each trade-off must be the one practitioners actually cite, with its standard fix.',
    terms: 'Keep in Latin letters only what practitioners never translate: brand and product names and standard abbreviations, and use them as column names when that is the term. Write every other term in Arabic.',
    diagramNote: 'The diagrams above picture AI systems (documents, vector stores, caches, graphs, agent loops). For this field, use `icon` unless a diagram truly matches what the step shows.',
};

/** Every domain has a kit: a domain added to the profile without one does not compile. */
const DOMAIN_KITS: { readonly [D in Domain]: DomainKit } = {
    tech: TECH_KIT,
    general: GENERAL_KIT,
};

/**
 * The system prompt: the format, the diagrams, the budgets and the language rule, for the creator the context describes.
 * For the owner's context (his role, the `tech` domain, a فصحى page) it is the text the goldens pin; for
 * any other it names their role, drops the stack examples unless the domain is `tech` (and says the diagrams on offer
 * picture AI systems), and polices the dialect their register speaks. `language` is the page's, which a request may choose differently from the surface's default.
 */
export function writeSystemPrompt(language: 'ar' | 'en', ctx: InfographicWriterContext): string {
    const role = roleOf(ctx);
    const kit = DOMAIN_KITS[ctx.who.domain];
    const diagrams = DIAGRAM_KINDS.map((k) => `- ${k}: ${DIAGRAMS[k]}`).join('\n');
    const lang = language === 'ar'
        ? [
            'Write in Modern Standard Arabic (العربية الفصحى): correct grammar, clear, short and simple, as a good textbook would say it.',
            dialectLine(ctx.language.register),
            kit.terms,
        ].join('\n')
        : 'Write in clear, plain English. Short words, no hype.';
    return [
        `You write one animated comparison infographic for ${withArticle(role)}'s Instagram, Facebook, YouTube and LinkedIn: two or three things compared side by side, and the caption that goes with it.`,
        '',
        'The page: a title made of the column names ("A vs B vs C"), one subtitle line under it, then one column per thing compared. Each column has:',
        '- name: the thing, as practitioners write it (often an acronym or 1–2 words)',
        '- kind: the kind of problem it suits, as a short phrase',
        '- note: one line that explains the kind',
        '- hero: the diagram that pictures it best',
        `- steps: exactly ${STEPS_PER_COLUMN}, how it works in order, each a short title, a one-line description and a diagram`,
        '',
        'Columns go from the simplest or oldest to the most capable: the last column is drawn in the accent colour.',
        kit.logo,
        kit.examples,
        '',
        'Make it concrete, so a reader sees it rather than reads it:',
        ...kit.concrete,
        'The steps of different columns sit side by side, so make them parallel where you can (step 1 of each is the setup, step 3 the result).',
        '',
        'Diagrams (pick the one that matches the step; use "icon" only when none does):',
        diagrams,
        `Icons for kind "icon": ${DIAGRAM_ICONS.join(', ')}.`,
        ...(kit.diagramNote ? [kit.diagramNote] : []),
        '',
        'Lengths, in characters, which the page fits exactly (2 columns / 3 columns):',
        `- name ≤ ${BUDGETS.name}; subtitle ≤ ${BUDGETS.subtitle}; accent ≤ ${BUDGETS.accent}, copied exactly from the subtitle`,
        `- kind ≤ ${BUDGETS.kind[2]} / ${BUDGETS.kind[3]}; note ≤ ${BUDGETS.note[2]} / ${BUDGETS.note[3]}`,
        `- step title ≤ ${BUDGETS.stepTitle[2]} / ${BUDGETS.stepTitle[3]}; step description ≤ ${BUDGETS.stepDesc[2]} / ${BUDGETS.stepDesc[3]}`,
        '',
        'The caption is about THIS infographic, in the same language. It is what someone reads under the GIF:',
        '1. A hook line that names the comparison.',
        '2. One short paragraph per column, in the page\'s order, starting with the column\'s name exactly as on the page: what it suits and how it works, following its three steps.',
        '3. One line on when to choose which.',
        '4. A question that invites a comment.',
        '5. 4–6 hashtags on the last line.',
        'Every column name must appear in the caption. 600–1,400 characters. No links, no "link in bio".',
        '',
        'Be accurate: say only what is true of each technique. If the topic is not something that can be compared, compare the two or three closest ideas it covers.',
        '',
        kit.reviewer,
        kit.realWay,
        NO_ABSOLUTES,
        kit.tradeOff,
        '- If a fair objection is fixable on the page, fix the page. Then fill `review.objections` with the 2–3 comments an expert is still most likely to post (a correction, an "it depends", another setup), each with a short, friendly reply that agrees where they are right and shows why the post still holds.',
        '',
        lang,
    ].join('\n');
}

export function writeUserPrompt(req: WriteRequest): string {
    return [
        `Topic: ${req.topic.trim()}`,
        req.notes?.trim() ? `\nNotes from the creator (follow them):\n${req.notes.trim()}` : '',
        req.avoid.length ? `\nNever use these words or topics: ${req.avoid.join(', ')}.` : '',
        `\nLanguage: ${req.language === 'ar' ? 'Arabic (Modern Standard Arabic, الفصحى)' : 'English'}.`,
    ].join('');
}

/** The brand the worker draws with: the tenant's infographic settings, as the template's InfoBrand. */
export function payloadBrand(cfg: InfographicConfig): RenderInfographicPayload['brand'] {
    return {
        name: { ar: cfg.name.ar, en: cfg.name.en },
        site: cfg.site,
        handle: cfg.handle,
        socials: [...cfg.socials],
        primary: cfg.primary,
        accent: cfg.accent,
        photo: cfg.photo_url,
    };
}

// ─── The worker's result ────────────────────────────────────────────────────────────────

export interface InfographicResult {
    mp4_url: string;
    gif_url: string;
    cover_url: string;
    gif_width: number | null;
    gif_fps: number | null;
    /** Present when the job wrote the infographic: the spec that was rendered, the caption, and the review. */
    written: { spec: unknown; caption: string; model: string | null; review: InfographicReview | null } | null;
}

/**
 * Claude's review as stored: up to MAX_OBJECTIONS comment/reply pairs, each cut to a sane length, or
 * null. Lenient on purpose: the review helps the owner answer comments, and a malformed one must
 * never cost the render it came with.
 */
export function parseReview(raw: unknown): InfographicReview | null {
    if (!isPlainObject(raw) || !Array.isArray(raw.objections)) return null;
    const objections = raw.objections
        .filter((o: unknown): o is Record<string, unknown> => isPlainObject(o) && typeof o.comment === 'string' && typeof o.reply === 'string')
        .map((o) => ({ comment: (o.comment as string).trim().slice(0, MAX_REVIEW_TEXT), reply: (o.reply as string).trim().slice(0, MAX_REVIEW_TEXT) }))
        .filter((o) => o.comment && o.reply)
        .slice(0, MAX_OBJECTIONS);
    return objections.length ? { objections } : null;
}

/** Our own upload URL: `…/api/uploads/<uuid>`, with an optional extension. */
const UPLOAD_URL = /^https?:\/\/[^\s/]+\/api\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{2,4})?$/i;

/** The worker's result, or the reasons it is not one (a 400: the job stays claimed and the worker reports it). */
export function parseInfographicResult(raw: unknown): { ok: true; result: InfographicResult } | { ok: false; problems: string[] } {
    const problems: string[] = [];
    if (!isPlainObject(raw)) return { ok: false, problems: ['The result must be an object.'] };
    const url = (key: 'mp4_url' | 'gif_url' | 'cover_url'): string => {
        const v = raw[key];
        if (typeof v !== 'string' || !UPLOAD_URL.test(v)) problems.push(`${key} must be one of the app's upload URLs`);
        return typeof v === 'string' ? v : '';
    };
    const num = (key: 'gif_width' | 'gif_fps'): number | null =>
        typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : null;
    const result: InfographicResult = {
        mp4_url: url('mp4_url'), gif_url: url('gif_url'), cover_url: url('cover_url'),
        gif_width: num('gif_width'), gif_fps: num('gif_fps'), written: null,
    };
    if (raw.written !== undefined && raw.written !== null) {
        const w = raw.written;
        if (!isPlainObject(w) || !isPlainObject(w.spec) || typeof w.caption !== 'string') {
            problems.push('written must be { spec, caption, model }');
        } else {
            result.written = {
                spec: w.spec, caption: w.caption, model: typeof w.model === 'string' ? w.model.slice(0, 100) : null, review: parseReview(w.review),
            };
        }
    }
    return problems.length ? { ok: false, problems } : { ok: true, result };
}

export const THEMES: readonly InfographicTheme[] = ['dark', 'light'];
export const dirFor = (language: 'ar' | 'en'): 'rtl' | 'ltr' => (language === 'ar' ? 'rtl' : 'ltr');
