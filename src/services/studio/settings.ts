/**
 * Per-tenant Studio settings (STUDIO.md §10): brand kit, voice, product, CTAs, posting times,
 * library folder and few-shot examples.
 *
 * The Studio is a feature for any tenant, so none of this is in code or prompts. A tenant with
 * no row gets `defaultStudioSettings()`, which is deliberately neutral: English, generic copy,
 * no product. A stored row is merged over those defaults on every read, section by section, so
 * a field added to a section later reads as its default for every tenant with no backfill.
 */
import { queryCount, queryOne } from '../../db/query.js';
import type { StudioDisplayFont, StudioSettings, StudioSettingsRow } from '../../db/rows.js';
import { isPlainObject, problemsError, StudioError } from './common.js';
import { defaultStudioSettings as writerDefaults } from './settingsTypes.js';

export const STUDIO_SETTINGS_SECTIONS = ['brand', 'voice', 'product', 'cta', 'schedule', 'library', 'examples'] as const;
type Section = (typeof STUDIO_SETTINGS_SECTIONS)[number];

export const DISPLAY_FONTS: readonly StudioDisplayFont[] = ['Cairo', 'Tajawal', 'IBM Plex Sans Arabic', 'Inter'];
/** Placeholders `cta.dmTemplate` may use; anything else is a typo that would reach a customer. */
export const DM_PLACEHOLDERS = ['username', 'question', 'pitch', 'url', 'bullets'] as const;

const MAX_PROBLEMS = 20;
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Neutral. Every tenant starts here; nothing in it belongs to any one creator.
 *
 * One definition, owned by the writer's `settingsTypes.ts`: its built-in English example and its
 * rules are written against these exact CTA lines, so a second copy here drifted from them and a
 * default tenant's first generated carousel failed its own checks.
 */
export function defaultStudioSettings(): StudioSettings {
    return writerDefaults() as StudioSettings;
}

/**
 * `patch` merged into `base`: plain objects recursively, everything else (arrays, text, null)
 * replaced. A key `base` does not have is reported rather than kept, so a typo such as
 * `brand.pallete` is a 400 instead of a setting that silently does nothing.
 */
function mergeInto(base: unknown, patch: unknown, path: string, problems: string[]): unknown {
    if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (!Object.prototype.hasOwnProperty.call(base, key)) {
            problems.push(`${path}.${key} is not a setting`);
            continue;
        }
        out[key] = mergeInto(base[key], value, `${path}.${key}`, problems);
    }
    return out;
}

/** A partial update applied to the current settings. Problems are unknown keys only. */
export function mergeSettings(current: StudioSettings, patch: Record<string, unknown>, problems: string[]): StudioSettings {
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (!(STUDIO_SETTINGS_SECTIONS as readonly string[]).includes(key)) {
            problems.push(`"${key}" is not a Studio setting (use ${STUDIO_SETTINGS_SECTIONS.join(', ')})`);
            continue;
        }
        // Examples are a list: replaced whole, never merged slide by slide.
        next[key] = key === 'examples' ? value : mergeInto(current[key as Section], value, key, problems);
    }
    return next as unknown as StudioSettings;
}

/** A stored row over the defaults. Unknown stored keys are dropped, not reported: nobody is asking. */
export function overDefaults(stored: Partial<Record<Section, unknown>>): StudioSettings {
    const patch: Record<string, unknown> = {};
    for (const section of STUDIO_SETTINGS_SECTIONS) {
        if (stored[section] !== undefined && (stored[section] !== null || section === 'examples')) patch[section] = stored[section];
    }
    return mergeSettings(defaultStudioSettings(), patch, []);
}

function isTimeZone(value: unknown): boolean {
    if (typeof value !== 'string' || !value) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

function placeholders(template: string): string[] {
    return [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
}

/** Every rule a stored setting must hold. Also run over `defaultStudioSettings()` by the tests. */
export function settingsProblems(s: StudioSettings): string[] {
    const problems: string[] = [];
    const text = (value: unknown, path: string, max: number, required = false): void => {
        if (typeof value !== 'string') problems.push(`${path} must be text`);
        else if (required && !value.trim()) problems.push(`${path} is required`);
        else if (value.length > max) problems.push(`${path} is ${value.length} characters; the limit is ${max}`);
    };
    const list = (value: unknown, path: string, max: number, each: (v: unknown, p: string) => void): void => {
        if (!Array.isArray(value)) {
            problems.push(`${path} must be a list`);
            return;
        }
        if (value.length > max) problems.push(`${path} holds at most ${max}`);
        value.slice(0, max).forEach((v, i) => each(v, `${path}[${i}]`));
    };
    const colour = (value: unknown, path: string): void => {
        if (typeof value !== 'string' || !HEX_COLOUR.test(value)) problems.push(`${path} must be a colour like #FFD60A`);
    };
    const oneOf = (value: unknown, path: string, options: readonly string[]): void => {
        if (!options.includes(value as string)) problems.push(`${path} must be one of ${options.join(', ')}`);
    };

    const { brand, voice, product, cta, schedule, library, examples } = s;
    text(brand?.name, 'brand.name', 80, true);
    text(brand?.signature?.latin, 'brand.signature.latin', 40);
    text(brand?.signature?.local, 'brand.signature.local', 40);
    list(brand?.palette, 'brand.palette', 24, colour);
    if (Array.isArray(brand?.palette) && brand.palette.length === 0) problems.push('brand.palette needs at least one colour');
    colour(brand?.colors?.ink, 'brand.colors.ink');
    colour(brand?.colors?.paper, 'brand.colors.paper');
    colour(brand?.colors?.muted, 'brand.colors.muted');
    oneOf(brand?.fonts?.display, 'brand.fonts.display', DISPLAY_FONTS);
    oneOf(brand?.fonts?.mono, 'brand.fonts.mono', ['JetBrains Mono']);
    oneOf(brand?.direction, 'brand.direction', ['rtl', 'ltr']);
    oneOf(brand?.theme, 'brand.theme', ['dark-grid']);

    oneOf(voice?.language, 'voice.language', ['ar', 'en']);
    oneOf(voice?.digits, 'voice.digits', ['arabic-indic', 'latin']);
    text(voice?.guide, 'voice.guide', 4000);
    if (voice?.avoid !== undefined) list(voice.avoid, 'voice.avoid', 30, (v, p) => text(v, p, 80, true));

    text(product?.name, 'product.name', 200);
    text(product?.url, 'product.url', 1000);
    if (typeof product?.url === 'string' && product.url && !/^https?:\/\/\S+$/i.test(product.url)) {
        problems.push('product.url must be a web address starting with https://');
    }
    list(product?.facts, 'product.facts', 20, (v, p) => text(v, p, 60, true));
    list(product?.dmBullets, 'product.dmBullets', 10, (v, p) => text(v, p, 200, true));

    text(cta?.instagramAsk, 'cta.instagramAsk', 300, true);
    if (typeof cta?.instagramAsk === 'string') {
        const found = placeholders(cta.instagramAsk);
        if (!found.includes('keyword')) problems.push('cta.instagramAsk must contain {keyword}: it is what the comment automation answers');
        for (const p of found.filter((p) => p !== 'keyword')) problems.push(`cta.instagramAsk uses {${p}}; only {keyword} is filled in`);
    }
    text(cta?.tiktokLine, 'cta.tiktokLine', 200);
    text(cta?.dmTemplate, 'cta.dmTemplate', 4000, true);
    if (typeof cta?.dmTemplate === 'string') {
        for (const p of placeholders(cta.dmTemplate)) {
            if (!(DM_PLACEHOLDERS as readonly string[]).includes(p)) {
                problems.push(`cta.dmTemplate uses {${p}}; the placeholders are ${DM_PLACEHOLDERS.map((x) => `{${x}}`).join(' ')}`);
            }
        }
    }
    if (!isPlainObject(cta?.slide)) problems.push('cta.slide must be an object');
    else for (const [key, value] of Object.entries(cta.slide)) text(value, `cta.slide.${key}`, 60);

    if (!isTimeZone(schedule?.timezone)) problems.push('schedule.timezone must be a timezone like Asia/Riyadh or Europe/London');
    list(schedule?.slots, 'schedule.slots', 8, (v, p) => {
        if (typeof v !== 'string' || !LOCAL_TIME.test(v)) problems.push(`${p} must be a time like 13:00`);
    });
    if (Array.isArray(schedule?.slots)) {
        if (schedule.slots.length === 0) problems.push('schedule.slots needs at least one time');
        if (new Set(schedule.slots).size !== schedule.slots.length) problems.push('schedule.slots lists a time twice');
    }

    if (!isPlainObject(library)) problems.push('library must be an object');
    else if (library.root !== null) {
        text(library.root, 'library.root', 1000, true);
        if (typeof library.root === 'string' && !/^(\/|[A-Za-z]:[\\/])/.test(library.root)) {
            problems.push('library.root must be a full folder path, e.g. /Users/you/Videos/Course');
        }
    }

    if (examples !== null) {
        list(examples, 'examples', 5, (v, p) => {
            if (!isPlainObject(v) || !Array.isArray(v.slides) || !isPlainObject(v.captions)) {
                problems.push(`${p} must be a carousel, with slides and captions`);
            }
        });
        if (Array.isArray(examples) && JSON.stringify(examples).length > 100_000) {
            problems.push('examples are larger than 100KB: keep the few-shot set to a handful of carousels');
        }
    }
    return problems;
}

/** The tenant's settings, over the defaults. */
export async function getStudioSettings(creatorId: string): Promise<StudioSettings> {
    const row = await queryOne<Omit<StudioSettingsRow, 'creator_id' | 'updated_at'>>(
        'SELECT brand, voice, product, cta, schedule, library, examples FROM studio_settings WHERE creator_id = $1',
        [creatorId]
    );
    return row ? overDefaults(row) : defaultStudioSettings();
}

/**
 * Apply a partial update (`{ schedule: { timezone } }` changes only that). Validated whole,
 * after the merge, so a change that is fine alone but breaks what it lands on is refused too.
 */
export async function updateStudioSettings(
    creatorId: string, patch: unknown
): Promise<{ settings: StudioSettings; changed: string[] }> {
    if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
        throw new StudioError(400, 'Send the settings to change, e.g. { "schedule": { "timezone": "Asia/Riyadh" } }.');
    }
    const current = await getStudioSettings(creatorId);
    const problems: string[] = [];
    const next = mergeSettings(current, patch, problems);
    problems.push(...settingsProblems(next));
    if (problems.length) throw problemsError(problems.slice(0, MAX_PROBLEMS), 'these settings');

    await queryCount(
        `INSERT INTO studio_settings (creator_id, brand, voice, product, cta, schedule, library, examples, updated_at)
         VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, NOW())
         ON CONFLICT (creator_id) DO UPDATE
            SET brand = EXCLUDED.brand, voice = EXCLUDED.voice, product = EXCLUDED.product,
                cta = EXCLUDED.cta, schedule = EXCLUDED.schedule, library = EXCLUDED.library,
                examples = EXCLUDED.examples, updated_at = NOW()`,
        [
            creatorId,
            JSON.stringify(next.brand), JSON.stringify(next.voice), JSON.stringify(next.product),
            JSON.stringify(next.cta), JSON.stringify(next.schedule), JSON.stringify(next.library),
            // SQL NULL, not the JSON value `null`: "no examples" is the absence of a list.
            next.examples === null ? null : JSON.stringify(next.examples),
        ]
    );
    return { settings: next, changed: Object.keys(patch) };
}
