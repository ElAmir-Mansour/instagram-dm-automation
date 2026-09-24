/**
 * The carousel rules: a port of aicourse-captions/scripts/check-carousels.mts (STUDIO.md §6).
 *
 * `validateCarousel` returns one message per problem and `[]` for a valid carousel. It is pure:
 * no I/O, no clock, no mutation of its input.
 *
 * Every check of the original is here. There is one intended difference: a shot name is checked
 * against the draft's own `shotNames` (the keys of its `shots` map), not the static library.
 *
 * The original reads typed `posts/*.ts` files, so it never meets a missing array or a number where
 * a string belongs. This one validates JSON from the model and from the dashboard, where a
 * TypeError would turn a 400 into a 500. So it also reports shape problems (a missing required
 * field, a wrong type, an unknown slide kind) instead of throwing. Its file-level checks (one
 * export per file, the id matching the file name, duplicate ids) have no file to check here; what
 * they protected, an id that is safe in paths, is checked instead.
 *
 * The budget table is exported so the generator's last-resort trimmer cuts to exactly the limits
 * this validator enforces.
 */
import type { Carousel, Slide } from './carouselTypes.js';

type Loose = Record<string, unknown>;

/** A budgeted text field, located so a caller can read it and (on a copy) rewrite it. */
export type TextField = {
    /** e.g. `slide 3 (list).items[1].sub`. */
    label: string;
    /** The object holding the field: the slide, a list item, a step, or a compare side's items. */
    holder: Loose;
    key: string;
    max: number;
    /**
     * Whether the Latin-digit test applies. The checker runs it on every budgeted field except
     * `prompt.prompt` and `stat.value`, which it only measures.
     */
    digits: boolean;
};

export const SLIDE_KINDS = ['cover', 'point', 'list', 'compare', 'steps', 'prompt', 'stat', 'shot', 'cta'] as const;
export type SlideKind = (typeof SLIDE_KINDS)[number];

/** The budgets from carouselTypes.ts's doc comments, in UTF-16 units (`String.length`). */
export const BUDGETS = {
    cover: { kicker: 24, title: 34, subtitle: 70 },
    point: { title: 40, body: 150, tip: 70 },
    list: { title: 36, itemText: 36, itemSub: 60 },
    compare: { title: 36, label: 16, item: 30 },
    steps: { title: 36, stepTitle: 28, stepBody: 70 },
    prompt: { title: 36, label: 20, prompt: 320, note: 70 },
    stat: { value: 8, label: 40, body: 120 },
    shot: { title: 40, caption: 90 },
    cta: { promise: 40 },
} as const;

/** Inclusive [min, max] item counts. */
export const COUNTS = {
    slides: [6, 10],
    listItems: [3, 5],
    compareItems: [2, 4],
    steps: [3, 4],
} as const;

export const CAPTION_LIMITS = { tiktokTitle: 90, tiktok: 4000, instagram: 2200, hashtags: 30 } as const;

/** The line every TikTok caption must carry: TikTok can't auto-DM, so the link is in the bio. */
export const LINK_IN_BIO = 'البايو';

/** Arabic text uses Arabic-Indic digits; Latin digits are fine inside Latin runs ("Gemini 2.5"). */
const LATIN_DIGIT_BESIDE_ARABIC = /[؀-ۿ]\s*[0-9]|[0-9]\s*[؀-ۿ]/;

/** Safe in output paths and composition ids (Remotion allows letters, digits and `-`). */
const SAFE_ID = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function slideLabel(index: number, s: unknown): string {
    const kind = isObj(s) && typeof s.kind === 'string' ? s.kind : '?';
    return `slide ${index + 1} (${kind})`;
}

/**
 * Every budgeted text field of one slide. Fields whose holder is missing are skipped; the shape
 * check reports those.
 */
export function slideTextFields(s: Slide | unknown, prefix: string): TextField[] {
    const out: TextField[] = [];
    const add = (holder: unknown, key: string, max: number, label: string, digits = true): void => {
        if (holder !== null && typeof holder === 'object') {
            out.push({ label: `${prefix}.${label}`, holder: holder as Loose, key, max, digits });
        }
    };
    if (!isObj(s)) return out;
    switch (s.kind) {
        case 'cover': {
            const b = BUDGETS.cover;
            add(s, 'kicker', b.kicker, 'kicker'); add(s, 'title', b.title, 'title'); add(s, 'subtitle', b.subtitle, 'subtitle');
            break;
        }
        case 'point': {
            const b = BUDGETS.point;
            add(s, 'title', b.title, 'title'); add(s, 'body', b.body, 'body'); add(s, 'tip', b.tip, 'tip');
            break;
        }
        case 'list': {
            const b = BUDGETS.list;
            add(s, 'title', b.title, 'title');
            arr(s.items).forEach((it, i) => {
                add(it, 'text', b.itemText, `items[${i}].text`);
                add(it, 'sub', b.itemSub, `items[${i}].sub`);
            });
            break;
        }
        case 'compare': {
            const b = BUDGETS.compare;
            add(s, 'title', b.title, 'title');
            for (const side of ['left', 'right'] as const) {
                const v = s[side];
                if (!isObj(v)) continue;
                add(v, 'label', b.label, `${side}.label`);
                const items = v.items;
                if (Array.isArray(items)) items.forEach((_, i) => add(items, String(i), b.item, `${side}.items[${i}]`));
            }
            break;
        }
        case 'steps': {
            const b = BUDGETS.steps;
            add(s, 'title', b.title, 'title');
            arr(s.steps).forEach((st, i) => {
                add(st, 'title', b.stepTitle, `steps[${i}].title`);
                add(st, 'body', b.stepBody, `steps[${i}].body`);
            });
            break;
        }
        case 'prompt': {
            const b = BUDGETS.prompt;
            add(s, 'title', b.title, 'title'); add(s, 'label', b.label, 'label');
            add(s, 'prompt', b.prompt, 'prompt', false); add(s, 'note', b.note, 'note');
            break;
        }
        case 'stat': {
            const b = BUDGETS.stat;
            add(s, 'value', b.value, 'value', false); add(s, 'label', b.label, 'label'); add(s, 'body', b.body, 'body');
            break;
        }
        case 'shot': {
            const b = BUDGETS.shot;
            add(s, 'title', b.title, 'title'); add(s, 'caption', b.caption, 'caption');
            break;
        }
        case 'cta':
            add(s, 'promise', BUDGETS.cta.promise, 'promise');
            break;
    }
    return out;
}

/** The required top-level text fields per kind, checked for presence and non-blankness. */
const REQUIRED: Record<SlideKind, string[]> = {
    cover: ['title'],
    point: ['title'],
    list: ['title'],
    compare: [],
    steps: ['title'],
    prompt: ['title', 'prompt'],
    stat: ['value', 'label'],
    shot: ['title'],
    cta: [],
};

function count(problems: string[], label: string, n: number, [min, max]: readonly [number, number]): void {
    if (n < min || n > max) problems.push(`${label}: ${n} items, expected ${min}–${max}`);
}

function checkShotRef(problems: string[], p: string, ref: unknown, shotNames: ReadonlySet<string>): void {
    if (!isObj(ref) || typeof ref.name !== 'string') {
        problems.push(`${p}.shot: must be { name }`);
        return;
    }
    if (!shotNames.has(ref.name)) problems.push(`${p}.shot: unknown shot "${ref.name}"`);
    for (const k of ['zoom', 'focusX', 'focusY'] as const) {
        const v = ref[k];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${p}.shot.${k}: must be a number`);
        else if (k === 'zoom' ? v <= 0 : v < 0 || v > 1) problems.push(`${p}.shot.${k}: ${v} is out of range`);
    }
}

function checkSlide(problems: string[], p: string, s: unknown, shotNames: ReadonlySet<string>): void {
    if (!isObj(s) || !(SLIDE_KINDS as readonly unknown[]).includes(s.kind)) {
        problems.push(`${p}: unknown slide kind`);
        return;
    }
    const kind = s.kind as SlideKind;

    for (const key of REQUIRED[kind]) {
        const v = s[key];
        if (typeof v !== 'string' || !v.trim()) problems.push(`${p}.${key}: required`);
    }

    // Budgets and the Latin-digit test, over every text field the slide has.
    for (const f of slideTextFields(s, p)) {
        const v = f.holder[f.key];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string') {
            problems.push(`${f.label}: must be text`);
            continue;
        }
        if (v.length > f.max) problems.push(`${f.label}: ${v.length} > ${f.max} «${v}»`);
        if (f.digits && LATIN_DIGIT_BESIDE_ARABIC.test(v)) problems.push(`${f.label}: Latin digit next to Arabic text «${v}»`);
    }

    // Shots: cover and point may carry one, a shot slide must.
    if (kind === 'shot' || ((kind === 'cover' || kind === 'point') && s.shot !== undefined && s.shot !== null)) {
        checkShotRef(problems, p, s.shot, shotNames);
    }

    switch (kind) {
        case 'cover':
            if (typeof s.highlight === 'string' && s.highlight && typeof s.title === 'string' && !s.title.includes(s.highlight)) {
                problems.push(`${p}.highlight not in title`);
            }
            break;
        case 'point':
            if (s.n !== undefined && s.n !== null && (typeof s.n !== 'number' || !Number.isInteger(s.n))) {
                problems.push(`${p}.n: must be a whole number`);
            }
            break;
        case 'list':
            if (!Array.isArray(s.items)) { problems.push(`${p}.items: required`); break; }
            count(problems, `${p}.items`, s.items.length, COUNTS.listItems);
            s.items.forEach((it, i) => {
                if (!isObj(it) || typeof it.text !== 'string' || !it.text.trim()) problems.push(`${p}.items[${i}].text: required`);
                else if (typeof it.icon === 'string' && (it.icon.length > 8 || /\p{L}/u.test(it.icon))) {
                    problems.push(`${p}.items[${i}].icon: must be one emoji «${it.icon}»`);
                }
            });
            break;
        case 'compare': {
            const sides = [s.left, s.right];
            if (!sides.every((v) => isObj(v) && typeof v.label === 'string' && Array.isArray(v.items))) {
                problems.push(`${p}: compare needs left and right, each { label, items }`);
                break;
            }
            const [left, right] = sides as [Loose & { items: unknown[] }, Loose & { items: unknown[] }];
            count(problems, `${p}.left.items`, left.items.length, COUNTS.compareItems);
            if (left.items.length !== right.items.length) problems.push(`${p}: compare sides differ in length`);
            break;
        }
        case 'steps':
            if (!Array.isArray(s.steps)) { problems.push(`${p}.steps: required`); break; }
            count(problems, `${p}.steps`, s.steps.length, COUNTS.steps);
            s.steps.forEach((st, i) => {
                if (!isObj(st) || typeof st.title !== 'string' || !st.title.trim()) problems.push(`${p}.steps[${i}].title: required`);
            });
            break;
    }
}

/**
 * All the problems with a carousel, or `[]`. `shotNames` is the set of names its slides may use:
 * the keys of the draft's `shots` map.
 */
export function validateCarousel(c: Carousel, shotNames: ReadonlySet<string>): string[] {
    const problems: string[] = [];
    const raw = c as unknown;
    if (!isObj(raw)) return ['carousel: must be an object'];

    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!SAFE_ID.test(id)) problems.push(`id "${id}" must be ASCII letters, digits or "-", starting with a letter`);

    const accent = typeof raw.accent === 'string' ? raw.accent : '';
    if (!/^#[0-9A-F]{6}$/i.test(accent)) problems.push(`accent "${accent}" is not #RRGGBB`);

    const keyword = typeof raw.keyword === 'string' ? raw.keyword : '';
    if (!keyword || /\s/.test(keyword)) problems.push('keyword must be one word');

    if (!Array.isArray(raw.slides)) {
        problems.push('slides: required');
    } else {
        const slides = raw.slides as unknown[];
        count(problems, 'slides', slides.length, COUNTS.slides);
        if (!isObj(slides[0]) || slides[0].kind !== 'cover') problems.push('first slide must be cover');
        const last = slides.at(-1);
        if (!isObj(last) || last.kind !== 'cta') problems.push('last slide must be cta');
        slides.forEach((s, i) => checkSlide(problems, slideLabel(i, s), s, shotNames));
    }

    const captions = isObj(raw.captions) ? raw.captions : {};
    const text = (k: string): string | null => {
        const v = captions[k];
        if (typeof v === 'string') return v;
        problems.push(`captions.${k}: required`);
        return null;
    };
    const instagram = text('instagram');
    const tiktokTitle = text('tiktokTitle');
    const tiktok = text('tiktok');
    const L = CAPTION_LIMITS;
    if (tiktokTitle !== null && tiktokTitle.length > L.tiktokTitle) {
        problems.push(`tiktokTitle ${tiktokTitle.length} > ${L.tiktokTitle} UTF-16`);
    }
    if (tiktok !== null && tiktok.length > L.tiktok) problems.push('tiktok caption too long');
    if (instagram !== null) {
        if (instagram.length > L.instagram) problems.push(`instagram caption ${instagram.length} > ${L.instagram}`);
        if (!instagram.includes(keyword)) problems.push("instagram caption doesn't mention the keyword");
        const tags = (instagram.match(/#/g) ?? []).length;
        if (tags > L.hashtags) problems.push(`${tags} hashtags > ${L.hashtags}`);
    }
    if (tiktok !== null && !tiktok.includes(LINK_IN_BIO)) problems.push('tiktok caption is missing the link-in-bio line');

    return problems;
}

/** The shot names a carousel's slides use, in slide order (duplicates kept). */
export function usedShotNames(c: Carousel): string[] {
    const names: string[] = [];
    for (const s of Array.isArray(c?.slides) ? c.slides : []) {
        const ref = (s as Loose).shot;
        if (isObj(ref) && typeof ref.name === 'string') names.push(ref.name);
    }
    return names;
}
