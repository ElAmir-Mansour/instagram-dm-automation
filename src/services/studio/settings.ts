/**
 * Per-tenant Studio settings (STUDIO.md §10): brand kit, voice, product, CTAs, posting times,
 * library folder, few-shot examples, the Monteur (MONTEUR.md §1) and the infographics' brand (v31).
 *
 * The Studio is a feature for any tenant, so none of this is in code or prompts. A tenant with
 * no row gets `defaultStudioSettings()`, which is deliberately neutral: English, generic copy,
 * no product. A stored row is merged over those defaults on every read, section by section, so
 * a field added to a section later reads as its default for every tenant with no backfill.
 */
import { pool } from '../../config/db.js';
import type { MonteurConfig, MonteurPlatform, StudioDisplayFont, StudioSettings, StudioSettingsRow } from '../../db/rows.js';
import type { InfographicPlatform, InfographicSocial, InfographicTheme, MonteurBrain, MonteurMode, MonteurSource, MonteurStyle } from './settingsTypes.js';
import { type Exec, isPlainObject, lockTenantSettings, problemsError, StudioError, withTransaction } from './common.js';
import { defaultStudioSettings, mergeSettings, overDefaults, readStudioSettings, STUDIO_SETTINGS_SECTIONS } from './settingsMerge.js';

// Read and merged in ./settingsMerge.ts, which imports nothing from here: the profile store reads the stored rows with them.
export { defaultStudioSettings, mergeSettings, overDefaults, STUDIO_SETTINGS_SECTIONS };

export const DISPLAY_FONTS: readonly StudioDisplayFont[] = ['Cairo', 'Tajawal', 'IBM Plex Sans Arabic', 'Inter'];
/** Placeholders `cta.dmTemplate` may use; anything else is a typo that would reach a customer. */
export const DM_PLACEHOLDERS = ['username', 'question', 'pitch', 'url', 'bullets'] as const;
export const MONTEUR_PLATFORMS: readonly MonteurPlatform[] = ['instagram', 'facebook', 'tiktok', 'youtube'];
export const MONTEUR_SOURCES: readonly MonteurSource[] = ['folder', 'course'];
export const MONTEUR_MODES: readonly MonteurMode[] = ['review', 'auto'];
export const MONTEUR_BRAINS: readonly MonteurBrain[] = ['gemini', 'claude_mac'];
export const MONTEUR_STYLES: readonly MonteurStyle[] = ['classic', 'paper'];
export const INFOGRAPHIC_SOCIALS: readonly InfographicSocial[] = ['instagram', 'youtube', 'linkedin', 'x', 'tiktok', 'facebook', 'github'];
export const INFOGRAPHIC_THEMES: readonly InfographicTheme[] = ['dark', 'light'];
export const INFOGRAPHIC_PLATFORMS: readonly InfographicPlatform[] = ['instagram', 'facebook', 'youtube'];
/** The portrait is one of our own uploads: the worker fetches it while rendering. */
const UPLOAD_URL = /^https:\/\/[^\s/]+\/api\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jpg)?$/i;
/** An absolute folder: `/…` on macOS and Linux, `C:\…` or `\\server\share` on Windows. */
const ABSOLUTE_FOLDER = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
/** NUL, newlines and the other control characters: never part of a folder the worker can open. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const MAX_PROBLEMS = 20;
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    const between = (value: unknown, path: string, min: number, max: number, whole: boolean): void => {
        const ok = typeof value === 'number' && Number.isFinite(value) && (!whole || Number.isInteger(value));
        if (!ok || (value as number) < min || (value as number) > max) {
            problems.push(`${path} must be ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}`);
        }
    };
    const times = (value: unknown, path: string, min: number, max: number): void => {
        list(value, path, max, (v, p) => {
            if (typeof v !== 'string' || !LOCAL_TIME.test(v)) problems.push(`${p} must be a time like 13:00`);
        });
        if (Array.isArray(value)) {
            if (value.length < min) problems.push(`${path} needs at least ${min === 1 ? 'one time' : `${min} times`}`);
            if (new Set(value).size !== value.length) problems.push(`${path} lists a time twice`);
        }
    };

    const { brand, voice, product, cta, schedule, library, examples, monteur, infographic } = s;
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
    times(schedule?.slots, 'schedule.slots', 1, 8);

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

    // The Monteur (MONTEUR.md §1). Its times are in schedule.timezone, checked above.
    if (!isPlainObject(monteur)) {
        problems.push('monteur must be an object');
    } else {
        if (typeof monteur.enabled !== 'boolean') problems.push('monteur.enabled must be true or false');
        // The folder is needed only to take videos from it; the course library has its own paths.
        oneOf(monteur.source, 'monteur.source', MONTEUR_SOURCES);
        oneOf(monteur.mode, 'monteur.mode', MONTEUR_MODES);
        oneOf(monteur.brain, 'monteur.brain', MONTEUR_BRAINS);
        oneOf(monteur.style, 'monteur.style', MONTEUR_STYLES);
        if (typeof monteur.human !== 'boolean') problems.push('monteur.human must be true or false');
        if (monteur.folder !== null) {
            text(monteur.folder, 'monteur.folder', 1024, true);
            if (typeof monteur.folder === 'string' && monteur.folder.trim() && !ABSOLUTE_FOLDER.test(monteur.folder)) {
                problems.push('monteur.folder must be a full folder path, e.g. /Users/you/Movies/Monteur');
            }
            if (typeof monteur.folder === 'string' && CONTROL_CHARACTERS.test(monteur.folder)) {
                problems.push('monteur.folder must not contain control characters or a line break');
            }
        }
        if (typeof monteur.run_at !== 'string' || !LOCAL_TIME.test(monteur.run_at)) {
            problems.push('monteur.run_at must be a time like 07:00');
        }
        between(monteur.videos_per_run, 'monteur.videos_per_run', 1, 10, true);
        between(monteur.reels_per_video, 'monteur.reels_per_video', 1, 5, true);
        list(monteur.platforms, 'monteur.platforms', MONTEUR_PLATFORMS.length, (v, p) => oneOf(v, p, MONTEUR_PLATFORMS));
        if (Array.isArray(monteur.platforms)) {
            if (monteur.platforms.length === 0) problems.push('monteur.platforms needs at least one platform');
            if (new Set(monteur.platforms).size !== monteur.platforms.length) problems.push('monteur.platforms lists a platform twice');
        }
        times(monteur.post_at, 'monteur.post_at', 1, 4);
        between(monteur.min_seconds, 'monteur.min_seconds', 10, 60, false);
        between(monteur.max_seconds, 'monteur.max_seconds', 15, 180, false);
        if (typeof monteur.min_seconds === 'number' && typeof monteur.max_seconds === 'number'
            && monteur.max_seconds <= monteur.min_seconds) {
            problems.push('monteur.max_seconds must be more than monteur.min_seconds');
        }
    }

    // The infographic's brand (v31): printed on every page, so each field is short.
    if (!isPlainObject(infographic)) {
        problems.push('infographic must be an object');
    } else {
        text(infographic.name?.ar, 'infographic.name.ar', 40);
        text(infographic.name?.en, 'infographic.name.en', 40);
        text(infographic.site, 'infographic.site', 40);
        text(infographic.handle, 'infographic.handle', 32);
        list(infographic.socials, 'infographic.socials', INFOGRAPHIC_SOCIALS.length, (v, p) => oneOf(v, p, INFOGRAPHIC_SOCIALS));
        if (Array.isArray(infographic.socials) && new Set(infographic.socials).size !== infographic.socials.length) {
            problems.push('infographic.socials lists a platform twice');
        }
        colour(infographic.primary, 'infographic.primary');
        colour(infographic.accent, 'infographic.accent');
        if (infographic.photo_url !== null && (typeof infographic.photo_url !== 'string' || !UPLOAD_URL.test(infographic.photo_url))) {
            problems.push('infographic.photo_url must be one of your uploads (…/api/uploads/<id>), or null');
        }
        oneOf(infographic.theme, 'infographic.theme', INFOGRAPHIC_THEMES);
        oneOf(infographic.language, 'infographic.language', ['ar', 'en']);
        list(infographic.platforms, 'infographic.platforms', INFOGRAPHIC_PLATFORMS.length, (v, p) => oneOf(v, p, INFOGRAPHIC_PLATFORMS));
        if (Array.isArray(infographic.platforms)) {
            if (infographic.platforms.length === 0) problems.push('infographic.platforms needs at least one platform');
            if (new Set(infographic.platforms).size !== infographic.platforms.length) problems.push('infographic.platforms lists a platform twice');
        }
    }
    return problems;
}

/**
 * Only what the Monteur's daily run needs — its section and the timezone — over the defaults.
 * Every worker poll reads this, so it does not fetch the rest of the row (the few-shot examples
 * alone can be 100KB).
 */
export async function getMonteurSettings(creatorId: string, exec: Exec = pool): Promise<{ monteur: MonteurConfig; timezone: string }> {
    const { rows } = await exec.query<Pick<StudioSettingsRow, 'monteur' | 'schedule'>>(
        'SELECT monteur, schedule FROM studio_settings WHERE creator_id = $1', [creatorId]
    );
    const s = overDefaults(rows[0] ?? {});
    return { monteur: s.monteur, timezone: s.schedule.timezone };
}

/** The tenant's settings, over the defaults. `exec` is a transaction's client, when inside one. */
export async function getStudioSettings(creatorId: string, exec: Exec = pool): Promise<StudioSettings> {
    return readStudioSettings(exec, creatorId);
}

/**
 * Apply a partial update (`{ schedule: { timezone } }` changes only that). Validated whole,
 * after the merge, so a change that is fine alone but breaks what it lands on is refused too.
 *
 * Read, change, write whole row: so it runs in a transaction that holds the tenant's settings lock first
 * (`lockTenantSettings`), the way a profile save does, or a save that landed between its read and its write would
 * be overwritten by the stale row. Given a transaction's client it uses that; the caller's commit releases the lock.
 */
export async function updateStudioSettings(
    creatorId: string, patch: unknown, exec: Exec = pool
): Promise<{ settings: StudioSettings; changed: string[] }> {
    if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
        throw new StudioError(400, 'Send the settings to change, e.g. { "schedule": { "timezone": "Asia/Riyadh" } }.');
    }
    return (exec as unknown) === pool
        ? withTransaction((tx) => applyStudioPatch(creatorId, patch, tx))
        : applyStudioPatch(creatorId, patch, exec);
}

async function applyStudioPatch(
    creatorId: string, patch: Record<string, unknown>, exec: Exec
): Promise<{ settings: StudioSettings; changed: string[] }> {
    await lockTenantSettings(exec, creatorId);
    const current = await readStudioSettings(exec, creatorId, true);
    const problems: string[] = [];
    const next = mergeSettings(current, patch, problems);
    problems.push(...settingsProblems(next));
    if (problems.length) throw problemsError(problems.slice(0, MAX_PROBLEMS), 'these settings');

    await exec.query(
        `INSERT INTO studio_settings (creator_id, brand, voice, product, cta, schedule, library, examples, monteur, infographic, updated_at)
         VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, NOW())
         ON CONFLICT (creator_id) DO UPDATE
            SET brand = EXCLUDED.brand, voice = EXCLUDED.voice, product = EXCLUDED.product,
                cta = EXCLUDED.cta, schedule = EXCLUDED.schedule, library = EXCLUDED.library,
                examples = EXCLUDED.examples, monteur = EXCLUDED.monteur, infographic = EXCLUDED.infographic, updated_at = NOW()`,
        [
            creatorId,
            JSON.stringify(next.brand), JSON.stringify(next.voice), JSON.stringify(next.product),
            JSON.stringify(next.cta), JSON.stringify(next.schedule), JSON.stringify(next.library),
            // SQL NULL, not the JSON value `null`: "no examples" is the absence of a list.
            next.examples === null ? null : JSON.stringify(next.examples),
            JSON.stringify(next.monteur),
            JSON.stringify(next.infographic),
        ]
    );
    await supersedeStaleScans(exec, creatorId, current.monteur, next.monteur);
    return { settings: next, changed: Object.keys(patch) };
}

/**
 * A scan still waiting for the old source or folder would run instead of one for the new: the
 * daily run queues nothing while a scan is open. So a pending scan the new settings would not have
 * queued is failed — in course mode every folder scan (a course scan carries `files`), in folder
 * mode every course scan and any for another folder. One already claimed is left to finish.
 */
async function supersedeStaleScans(exec: Exec, creatorId: string, was: MonteurConfig, now: MonteurConfig): Promise<void> {
    const sourceChanged = now.source !== was.source;
    if (!sourceChanged && (now.folder === was.folder || now.source === 'course')) return;
    const error = sourceChanged ? 'Superseded: the Monteur\'s source changed.' : 'Superseded: the Monteur\'s folder changed.';
    const stale = `UPDATE studio_jobs SET status = 'failed', error = $2, updated_at = NOW()
          WHERE creator_id = $1 AND kind = 'monteur_scan' AND status = 'pending'`;
    await (now.source === 'course'
        ? exec.query(`${stale} AND payload->'files' IS NULL`, [creatorId, error])
        : exec.query(`${stale} AND (payload->'files' IS NOT NULL OR payload->>'folder' IS DISTINCT FROM $3)`, [creatorId, error, now.folder]));
}
