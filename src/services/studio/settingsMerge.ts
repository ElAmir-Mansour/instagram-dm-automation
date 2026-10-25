/**
 * The pure half of the Studio settings: the neutral defaults, the partial merge a PUT applies, and a stored
 * row read over the defaults. Moved out of `settings.ts` unchanged so that `profile/store.ts` can read the
 * stored rows without importing the module that will import the store (P4 makes `getStudioSettings` a view
 * over the profile). `settings.ts` re-exports all of it, so every existing import keeps working.
 */
import type { StudioSettings, StudioSettingsRow } from '../../db/rows.js';
import { type Exec, isPlainObject } from './common.js';
import { defaultStudioSettings as writerDefaults } from './settingsTypes.js';

export const STUDIO_SETTINGS_SECTIONS = ['brand', 'voice', 'product', 'cta', 'schedule', 'library', 'examples', 'monteur', 'infographic', 'explainer'] as const;
type Section = (typeof STUDIO_SETTINGS_SECTIONS)[number];

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

/**
 * The tenant's stored settings over the defaults (the neutral defaults for a tenant with no row). `lock` reads the
 * row `FOR UPDATE`, for a writer that is about to change it: inside a transaction that holds `lockTenantSettings`.
 */
export async function readStudioSettings(exec: Exec, creatorId: string, lock = false): Promise<StudioSettings> {
    const { rows } = await exec.query<Omit<StudioSettingsRow, 'creator_id' | 'updated_at'>>(
        `SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic, explainer FROM studio_settings WHERE creator_id = $1${lock ? ' FOR UPDATE' : ''}`,
        [creatorId]
    );
    return rows[0] ? overDefaults(rows[0]) : defaultStudioSettings();
}
