/**
 * Per-tenant SEO settings (GROWTH.md §1, §3): the search keywords the audience types, hashtag
 * sets, competitors for Business Discovery, and the audience itself. A tenant with no row gets
 * the empty defaults; nothing about any one creator is in code.
 *
 * `PUT /api/growth/settings` is a partial update: a key it sends replaces that setting (the
 * audience merges field by field), a key it leaves out is kept. Everything is normalised before it
 * is stored — `@Name` becomes `name`, `ذكاء` becomes `#ذكاء` — and a value that can't be made valid
 * is refused with the sentence the dashboard shows.
 */
import type { GrowthAudience, GrowthSettings, HashtagSet } from '../../db/rows.js';
import { queryCount, queryOne } from '../../db/query.js';
import { normalizeArabic } from '../../utils/arabic.js';
import { describeError, log } from '../../utils/log.js';
import { isMissingSchema } from '../health.js';
import { GrowthError } from './common.js';

export const GROWTH_SETTING_KEYS = ['keywords', 'hashtag_sets', 'competitors', 'audience'] as const;
const AUDIENCE_KEYS = ['countries', 'languages', 'timezone'] as const;

export const GROWTH_LIMITS = {
    keywords: 30,
    keywordLength: 60,
    hashtagSets: 12,
    setName: 40,
    /** Instagram's own maximum per post. */
    tagsPerSet: 30,
    tagLength: 100,
    competitors: 10,
    countries: 30,
    languages: 10,
} as const;

/** Instagram usernames: letters, digits, periods, underscores; at most 30. */
export const USERNAME = /^[a-z0-9._]{1,30}$/;
const COUNTRY = /^[A-Z]{2}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
/** A hashtag: `#` then letters (any script), digits or underscores — no spaces or punctuation. */
const HASHTAG = /^#[\p{L}\p{M}\p{N}_]+$/u;
const MAX_PROBLEMS = 20;

export function defaultGrowthSettings(): GrowthSettings {
    return { keywords: [], hashtag_sets: [], competitors: [], audience: {} };
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function isTimeZone(value: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

/** `@Name`, `name`, or an instagram.com profile link → `name`, or null when it isn't one. */
export function normalizeUsername(raw: string): string | null {
    let name = raw.trim();
    const link = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#\s]+)/i.exec(name);
    if (link) name = link[1]!;
    name = name.replace(/^@+/, '').toLowerCase();
    return USERNAME.test(name) ? name : null;
}

/** `ذكاء` or `#ذكاء` → `#ذكاء`, or null when it can't be a hashtag. */
export function normalizeHashtag(raw: string): string | null {
    const tag = raw.trim();
    if (!tag) return null;
    const withHash = tag.startsWith('#') ? tag : `#${tag}`;
    return HASHTAG.test(withHash) && withHash.length <= GROWTH_LIMITS.tagLength ? withHash : null;
}

function keywordList(value: unknown, problems: string[]): string[] {
    if (!Array.isArray(value)) {
        problems.push('keywords must be a list of search terms');
        return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of value) {
        if (typeof raw !== 'string') { problems.push('keywords must be a list of search terms'); continue; }
        const term = oneLine(raw);
        if (!term) continue;
        if (term.length > GROWTH_LIMITS.keywordLength) {
            problems.push(`The keyword «${term.slice(0, 30)}…» is ${term.length} characters; the limit is ${GROWTH_LIMITS.keywordLength}`);
            continue;
        }
        const key = normalizeArabic(term.toLowerCase());
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(term);
    }
    if (out.length > GROWTH_LIMITS.keywords) problems.push(`keywords holds at most ${GROWTH_LIMITS.keywords}; this list has ${out.length}`);
    return out;
}

function hashtagSets(value: unknown, problems: string[]): HashtagSet[] {
    if (!Array.isArray(value)) {
        problems.push('hashtag_sets must be a list of { name, tags }');
        return [];
    }
    if (value.length > GROWTH_LIMITS.hashtagSets) problems.push(`hashtag_sets holds at most ${GROWTH_LIMITS.hashtagSets}`);
    const names = new Set<string>();
    const out: HashtagSet[] = [];
    value.slice(0, GROWTH_LIMITS.hashtagSets).forEach((raw, i) => {
        const at = `hashtag_sets[${i}]`;
        if (!isObj(raw)) { problems.push(`${at} must be { name, tags }`); return; }
        for (const key of Object.keys(raw)) if (key !== 'name' && key !== 'tags') problems.push(`${at}.${key} is not a setting`);
        const name = typeof raw.name === 'string' ? oneLine(raw.name) : '';
        if (!name) problems.push(`${at}.name is required`);
        else if (name.length > GROWTH_LIMITS.setName) problems.push(`${at}.name is ${name.length} characters; the limit is ${GROWTH_LIMITS.setName}`);
        else if (names.has(name.toLowerCase())) problems.push(`Two hashtag sets are called «${name}»`);
        names.add(name.toLowerCase());
        if (!Array.isArray(raw.tags)) { problems.push(`${at}.tags must be a list of hashtags`); return; }
        const tags: string[] = [];
        const seen = new Set<string>();
        for (const t of raw.tags) {
            if (typeof t !== 'string') { problems.push(`${at}.tags must be a list of hashtags`); continue; }
            if (!t.trim()) continue;
            const tag = normalizeHashtag(t);
            if (!tag) { problems.push(`«${t.trim().slice(0, 40)}» is not a hashtag: letters, numbers and underscores, no spaces`); continue; }
            if (seen.has(tag.toLowerCase())) continue;
            seen.add(tag.toLowerCase());
            tags.push(tag);
        }
        if (tags.length > GROWTH_LIMITS.tagsPerSet) problems.push(`${at} has ${tags.length} hashtags; Instagram allows ${GROWTH_LIMITS.tagsPerSet} per post`);
        out.push({ name, tags });
    });
    return out;
}

function competitorList(value: unknown, problems: string[]): string[] {
    if (!Array.isArray(value)) {
        problems.push('competitors must be a list of Instagram usernames');
        return [];
    }
    const out: string[] = [];
    for (const raw of value) {
        if (typeof raw !== 'string') { problems.push('competitors must be a list of Instagram usernames'); continue; }
        if (!raw.trim()) continue;
        const name = normalizeUsername(raw);
        if (!name) { problems.push(`«${raw.trim().slice(0, 40)}» is not an Instagram username: letters, numbers, periods and underscores, at most 30`); continue; }
        if (!out.includes(name)) out.push(name);
    }
    if (out.length > GROWTH_LIMITS.competitors) problems.push(`competitors holds at most ${GROWTH_LIMITS.competitors}; this list has ${out.length}`);
    return out;
}

function codeList(value: unknown, path: string, pattern: RegExp, max: number, upper: boolean, example: string, problems: string[]): string[] {
    if (!Array.isArray(value)) {
        problems.push(`${path} must be a list, e.g. ${example}`);
        return [];
    }
    const out: string[] = [];
    for (const raw of value) {
        const code = typeof raw === 'string' ? (upper ? raw.trim().toUpperCase() : raw.trim().toLowerCase()) : '';
        if (!pattern.test(code)) { problems.push(`${path}: «${String(raw).slice(0, 20)}» is not a code like ${example}`); continue; }
        if (!out.includes(code)) out.push(code);
    }
    if (out.length > max) problems.push(`${path} holds at most ${max}`);
    return out;
}

function audienceOver(current: GrowthAudience, patch: unknown, problems: string[]): GrowthAudience {
    if (!isObj(patch)) {
        problems.push('audience must be { countries, languages, timezone }');
        return current;
    }
    const next: GrowthAudience = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (!(AUDIENCE_KEYS as readonly string[]).includes(key)) {
            problems.push(`audience.${key} is not a setting (use ${AUDIENCE_KEYS.join(', ')})`);
            continue;
        }
        if (value === null) { delete next[key as keyof GrowthAudience]; continue; }
        if (key === 'countries') next.countries = codeList(value, 'audience.countries', COUNTRY, GROWTH_LIMITS.countries, true, "['SA', 'AE']", problems);
        if (key === 'languages') next.languages = codeList(value, 'audience.languages', LANGUAGE, GROWTH_LIMITS.languages, false, "['ar', 'en']", problems);
        if (key === 'timezone') {
            if (typeof value !== 'string' || !value.trim()) delete next.timezone;
            else if (!isTimeZone(value.trim())) problems.push('audience.timezone must be a timezone like Asia/Riyadh or Europe/London');
            else next.timezone = value.trim();
        }
    }
    return next;
}

/** A partial update over the current settings, normalised, with every problem found. */
export function applyGrowthPatch(current: GrowthSettings, patch: unknown): { settings: GrowthSettings; problems: string[] } {
    const problems: string[] = [];
    if (!isObj(patch) || Object.keys(patch).length === 0) {
        return { settings: current, problems: ['Send the settings to change, e.g. { "keywords": ["ذكاء اصطناعي"] }.'] };
    }
    const next: GrowthSettings = { ...current, audience: { ...current.audience } };
    for (const [key, value] of Object.entries(patch)) {
        switch (key) {
            case 'keywords': next.keywords = keywordList(value, problems); break;
            case 'hashtag_sets': next.hashtag_sets = hashtagSets(value, problems); break;
            case 'competitors': next.competitors = competitorList(value, problems); break;
            case 'audience': next.audience = audienceOver(current.audience, value, problems); break;
            default: problems.push(`"${key}" is not a Growth setting (use ${GROWTH_SETTING_KEYS.join(', ')})`);
        }
    }
    return { settings: next, problems };
}

/** A stored row, read defensively: the columns have defaults, but JSONB can hold anything. */
function fromRow(row: Partial<GrowthSettings> | null): GrowthSettings {
    if (!row) return defaultGrowthSettings();
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
        keywords: strings(row.keywords),
        hashtag_sets: (Array.isArray(row.hashtag_sets) ? row.hashtag_sets : [])
            .filter(isObj)
            .map((s) => ({ name: typeof s.name === 'string' ? s.name : '', tags: strings(s.tags) })),
        competitors: strings(row.competitors),
        audience: isObj(row.audience) ? (row.audience as GrowthAudience) : {},
    };
}

export async function getGrowthSettings(creatorId: string): Promise<GrowthSettings> {
    const row = await queryOne<GrowthSettings>(
        'SELECT keywords, hashtag_sets, competitors, audience FROM growth_settings WHERE creator_id = $1', [creatorId]
    );
    return fromRow(row);
}

export async function updateGrowthSettings(creatorId: string, patch: unknown): Promise<GrowthSettings> {
    const { settings, problems } = applyGrowthPatch(await getGrowthSettings(creatorId), patch);
    if (problems.length) {
        const list = problems.slice(0, MAX_PROBLEMS);
        throw new GrowthError(400, list.length === 1 ? list[0]! : `${list.length} problems with these settings.`, { problems: list });
    }
    await queryCount(
        `INSERT INTO growth_settings (creator_id, keywords, hashtag_sets, competitors, audience, updated_at)
         VALUES ($1, $2::text[], $3::jsonb, $4::text[], $5::jsonb, NOW())
         ON CONFLICT (creator_id) DO UPDATE
            SET keywords = EXCLUDED.keywords, hashtag_sets = EXCLUDED.hashtag_sets,
                competitors = EXCLUDED.competitors, audience = EXCLUDED.audience, updated_at = NOW()`,
        [creatorId, settings.keywords, JSON.stringify(settings.hashtag_sets), settings.competitors, JSON.stringify(settings.audience)]
    );
    return settings;
}

/**
 * What the Studio's writer uses: the keywords and every hashtag of every set, in order. Fail-soft
 * — a missing v22 table or a read error means no SEO hints, never a failed draft.
 */
export async function seoForWriter(creatorId: string): Promise<{ keywords: string[]; hashtags: string[] }> {
    try {
        const s = await getGrowthSettings(creatorId);
        const hashtags = [...new Set(s.hashtag_sets.flatMap((set) => set.tags))];
        return { keywords: s.keywords, hashtags };
    } catch (err) {
        if (!isMissingSchema(err)) log('warn', 'growth.writer_settings_unreadable', describeError(err));
        return { keywords: [], hashtags: [] };
    }
}
