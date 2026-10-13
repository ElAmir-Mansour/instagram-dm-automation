/**
 * How an example carousel is printed in the writer's prompt (STUDIO.md §7, §10.3).
 *
 * The examples are the tenant's own: `studio_settings.examples`, at most three, and a tenant with none is shown none (P14 removed the
 * built-in fallback; the owner's three carousels are in his own row, and `exampleFixtures.ts` holds them for the tests). So this file
 * holds no carousel: only the one fixed key order a prompt prints one in.
 */
import type { ExampleCarousel } from './carouselTypes.js';

// ─── Printing an example ────────────────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The keys of each shape, in the order `carouselTypes.ts` declares them and the owner's reference carousels (`exampleFixtures.ts`) write them. An example is
 * stored as JSONB, which hands an object's keys back sorted by length and then by bytes (`id`, `accent`, `slides`, `keyword`…), so a
 * prompt that printed what came back would not be the prompt that printed what was stored: the model reads the order. These
 * lists are the one order, whatever order a row holds.
 */
const CAROUSEL_KEYS = ['id', 'accent', 'keyword', 'slides', 'captions'] as const;
const CAPTION_KEYS = ['instagram', 'tiktokTitle', 'tiktok'] as const;
const SHOT_KEYS = ['name', 'zoom', 'focusX', 'focusY'] as const;
const SIDE_KEYS = ['label', 'items'] as const;
const ITEM_KEYS = ['icon', 'text', 'sub'] as const;
const STEP_KEYS = ['title', 'body'] as const;
/** Every slide kind starts with `kind` and ends with `altText` (what `SlideMeta` adds to each). */
const SLIDE_KEYS: Readonly<Record<string, readonly string[]>> = {
    cover: ['kind', 'kicker', 'title', 'highlight', 'subtitle', 'shot', 'altText'],
    point: ['kind', 'n', 'title', 'body', 'shot', 'tip', 'altText'],
    list: ['kind', 'title', 'items', 'altText'],
    compare: ['kind', 'title', 'left', 'right', 'altText'],
    steps: ['kind', 'title', 'steps', 'altText'],
    prompt: ['kind', 'title', 'label', 'prompt', 'note', 'altText'],
    stat: ['kind', 'value', 'label', 'body', 'altText'],
    shot: ['kind', 'title', 'shot', 'caption', 'altText'],
    cta: ['kind', 'promise', 'altText'],
};

/**
 * `value` rebuilt with its keys in `order`, each value passed through `child` by key. A key `order` does not know follows,
 * sorted (so the same object prints the same whatever order it arrived in), and `drop` is left out. A value that is not an
 * object (a stray string where a shape was expected) is returned as it is: an example is only loosely checked on the way in.
 */
function inOrder(value: unknown, order: readonly string[], child: (key: string, v: unknown) => unknown = (_key, v) => v, drop: readonly string[] = []): unknown {
    if (!isObject(value)) return value;
    const keys = [...order.filter((k) => k in value), ...Object.keys(value).filter((k) => !order.includes(k)).sort()];
    const out: Loose = {};
    for (const key of keys) {
        if (drop.includes(key) || value[key] === undefined) continue;
        out[key] = child(key, value[key]);
    }
    return out;
}

const each = (v: unknown, f: (item: unknown) => unknown): unknown => (Array.isArray(v) ? v.map(f) : v);

function slideOf(slide: unknown): unknown {
    const kind = isObject(slide) && typeof slide.kind === 'string' ? slide.kind : '';
    return inOrder(slide, SLIDE_KEYS[kind] ?? ['kind', 'altText'], (key, v) => {
        switch (key) {
            case 'shot': return inOrder(v, SHOT_KEYS);
            case 'items': return each(v, (item) => inOrder(item, ITEM_KEYS));
            case 'steps': return each(v, (step) => inOrder(step, STEP_KEYS));
            case 'left': case 'right': return inOrder(v, SIDE_KEYS);
            default: return v;
        }
    });
}

/**
 * An example as the writer's prompt prints it: `JSON.stringify(carousel, null, 2)` with its keys in the one fixed order
 * (`CAROUSEL_KEYS`, `SLIDE_KEYS`…) and without `reference`, which is for the code and not the model. For the owner's
 * references it is the very text the prompt has always held, however many times it has been through a database in between.
 */
export function exampleJson(example: ExampleCarousel): string {
    const ordered = inOrder(example, CAROUSEL_KEYS, (key, v) => {
        if (key === 'slides') return each(v, slideOf);
        if (key === 'captions') return inOrder(v, CAPTION_KEYS);
        return v;
    }, ['reference']);
    return JSON.stringify(ordered, null, 2);
}
