/**
 * What the profile tests share: the scrambler the lens laws need, a path walker, the way Postgres
 * stores a JSON object, the shipped campaigns screen, and a fully filled profile whose every value is
 * different from every other, so a field that lands in the wrong place cannot hide behind an equal
 * neighbour. Imported by tests only; production code never reads it.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { CreatorProfile } from './types.js';

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

export function getAt(root: unknown, path: string): unknown {
    let at: unknown = root;
    for (const key of path.split('.')) {
        if (!isObj(at) || !(key in at)) return undefined;
        at = at[key];
    }
    return at;
}

export function hasAt(root: unknown, path: string): boolean {
    let at: unknown = root;
    for (const key of path.split('.')) {
        if (!isObj(at) || !(key in at)) return false;
        at = at[key];
    }
    return true;
}

export function setAt(root: unknown, path: string, value: unknown): void {
    const keys = path.split('.');
    let at = root as Loose;
    for (const key of keys.slice(0, -1)) at = at[key] as Loose;
    at[keys.at(-1)!] = value;
}

/** Junk of the same kind as `value`, so the scrambled object is still the shape a reader expects. */
function junkFor(value: unknown, path: string): unknown {
    if (typeof value === 'number') return 7;
    if (Array.isArray(value)) return [`JUNK:${path}`];
    return `JUNK:${path}`;
}

/**
 * `settings` with each of `paths` that it holds overwritten by junk: the row a profile edit has left
 * behind. A path the object does not have is left out, not added: a stale row is the same row with
 * stale values, not a row of a different shape.
 */
export function scramble<T extends object>(settings: T, paths: readonly string[]): T {
    const out = structuredClone(settings);
    for (const path of paths) if (hasAt(out, path)) setAt(out, path, junkFor(getAt(out, path), path));
    return out;
}

/** Every leaf path of an object: lists, `null` and scalars are leaves, plain objects are walked. */
export function leafPaths(value: unknown, prefix = ''): string[] {
    if (!isObj(value)) return prefix ? [prefix] : [];
    return Object.entries(value).flatMap(([key, v]) => leafPaths(v, prefix ? `${prefix}.${key}` : key));
}

/**
 * `value` as Postgres hands a jsonb column back: object keys sorted by length, then by their bytes (arrays
 * keep their order). A profile read from `creator_profiles` has been through this, so a reader that only
 * works on the key order it was written in is wrong in production and right in every test that skips it.
 */
export function jsonbReorder<T>(value: T): T {
    if (Array.isArray(value)) return value.map(jsonbReorder) as T;
    if (!isObj(value)) return value;
    const bytes = (k: string): Buffer => Buffer.from(k, 'utf8');
    const keys = Object.keys(value).sort((a, b) => bytes(a).length - bytes(b).length || Buffer.compare(bytes(a), bytes(b)));
    return Object.fromEntries(keys.map((k) => [k, jsonbReorder(value[k])])) as T;
}

/** `value` as the database stores and returns it: serialised, and its keys reordered the way jsonb does. */
export const throughJsonb = <T>(value: T): T => jsonbReorder(JSON.parse(JSON.stringify(value)) as T);

/**
 * The REAL shipped campaigns screen, run in a bare context (the way golden.test.ts runs it): it only declares
 * CampaignsPage and registers its actions. `inside` reads a value out of it as plain JSON.
 */
export function loadCampaignsPage(): vm.Context {
    const file = new URL('../../../dashboard/js/pages/campaigns.js', import.meta.url);
    const ctx = vm.createContext({
        UI: { registerActions: () => {}, showModal: () => {}, formatNumber: (n: unknown) => String(n), button: () => '' },
        html: Object.assign(() => '', { raw: (s: unknown) => s }),
        t: (key: string) => key,
    });
    vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: 'dashboard/js/pages/campaigns.js' });
    return ctx;
}

export const inside = (ctx: vm.Context, expression: string): any => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, ctx));

/** Freezes `value` all the way down, so a function that mutates its input throws instead of passing. */
export function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
}

export const UPLOAD_A = 'https://app.example.com/api/uploads/11111111-1111-4111-8111-111111111111';
export const UPLOAD_B = 'https://app.example.com/api/uploads/22222222-2222-4222-8222-222222222222.jpg';

/**
 * A second tenant, filled in everywhere: Arabic in the Egyptian register with an English carousel, a
 * non-primary offer listed first, a presenter, a campaign, hours, a handoff. No two fields hold the
 * same value, and none is the default.
 */
export function richProfile(): CreatorProfile {
    return {
        schema: 1,
        identity: {
            display_name: { ar: 'سامي للياقة', en: 'Sami Fitness' },
            brand_name: 'Sami Fit Studio',
            kind: 'coach',
            role: 'fitness coach',
            niche: 'Home workouts for busy parents',
            country: 'EG',
            timezone: 'Africa/Cairo',
        },
        language: {
            primary: 'ar',
            register: 'egyptian',
            digits: 'latin',
            surfaces: { carousel: { language: 'en' }, infographic: { language: 'ar', register: 'msa' }, dm: { register: 'levantine' } },
        },
        offers: [
            { id: 'side', kind: 'coaching', name: 'One-to-one call', order_via: 'dm', url: '', price: '$20', facts: ['30 minutes'], bullets: ['✅ A plan for you'], keyword: 'call', primary: false },
            {
                id: 'main', kind: 'program', name: 'Twelve-week program', order_via: 'url', url: 'https://samifit.example/program?ref=ig', price: '$99',
                facts: ['12 weeks', 'Video lessons', 'Weekly check-in'], bullets: ['✅ A plan every week', '✅ Replies within a day'], keyword: 'plan', primary: true,
                campaign: { name_match: 'twelve-week', match: 'word', keywords: ['plan', 'program'], dm_template: 'Hi {username}, the program is here: {url}', public_replies: ['Sent to your DMs!', 'Check your messages'] },
            },
        ],
        audience: {
            description: 'Parents with under an hour a day', level: 'beginner', pains: ['No time', 'No gym'], goals: ['Lose weight', 'Sleep better'],
            countries: ['EG', 'SA'], languages: ['ar', 'en'], timezone: 'Asia/Dubai',
        },
        voice: {
            guide: 'Warm, direct, never preachy.', tone: ['warm', 'direct'], samples: ['Ten minutes is enough. Start now.'], use_words: ['simple'],
            avoid_words: ['hack'], emoji: 'rich', address: 'plural',
        },
        presenter: { name: 'Sami', pronouns: 'she', on_camera: 'mixed' },
        content: {
            domain: 'general', pillars: ['Workouts', 'Food'], never_mention: ['steroids', 'crash diets'], rules: ['no_women_imagery'],
            custom_rules: ['No before-and-after body photos'],
        },
        brand: { primary: '#112233', accent: '#AABBCC', font_display: 'Tajawal', logo_url: UPLOAD_A, portrait_url: UPLOAD_B, theme: 'light' },
        socials: { handle: '@sami.fit', site: 'samifit.example', platforms: ['instagram', 'youtube'], links: { instagram: 'https://instagram.com/sami.fit' } },
        dm: {
            faq: [{ q: 'How much is it?', a: '$99, once.' }],
            handoff: { when: 'The person asks for a refund', message: 'A person will reply to you soon.' },
            hours: { days: [0, 1, 2, 3, 4], from: '09:00', to: '17:00' },
        },
        goals: { followers: 5000, views: 250_000 },
    };
}
