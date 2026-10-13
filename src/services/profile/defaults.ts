/**
 * The neutral profile a new tenant starts on, and the way a stored one is read.
 *
 * Nothing in `defaultProfile()` belongs to any one creator: no name, no offer, no presenter, no
 * dialect word. What it leaves empty is what activation asks for (`activationMissing`), so a new
 * tenant is never mistaken for a finished one. The owner's tenant is described by `legacy.ts`
 * instead; a new tenant never falls back to it.
 */
import { defaultInfographicConfig } from '../studio/settingsTypes.js';
import type { ContentRulePreset, CreatorProfile, Lang, Offer } from './types.js';
import { CONTENT_RULE_PRESETS, SOCIALS, SURFACES } from './types.js';

/** What a tenant with no Growth settings is aiming at (docs/agents/BRIEF.md). `DEFAULT_GOALS` in growth/settings.ts; a test holds them equal. */
const DEFAULT_GOALS = { followers: 10_000, views: 1_000_000 } as const;

/**
 * Neutral. Arabic gets the MSA register (D8: a new tenant's default is Arabic/فصحى unless the admin
 * picks otherwise) and Arabic-Indic digits; English gets neither. `rules` is
 * `onboarding.default_rules` for a tenant created by the admin (D9: the no-women rule is pre-ticked
 * and the wizard shows it).
 */
export function defaultProfile({ lang = 'ar', rules = ['no_women_imagery'] }: { lang?: Lang; rules?: readonly ContentRulePreset[] } = {}): CreatorProfile {
    const brand = defaultInfographicConfig();
    return {
        schema: 1,
        identity: {
            display_name: { ar: '', en: '' },
            brand_name: '',
            kind: null,
            role: '',
            niche: '',
            country: null,
            timezone: '',
        },
        language: {
            primary: lang,
            register: lang === 'ar' ? 'msa' : null,
            digits: lang === 'ar' ? 'arabic-indic' : 'latin',
            surfaces: {},
        },
        offers: [],
        audience: { description: '', level: null, pains: [], goals: [], countries: [], languages: [] },
        voice: { guide: '', tone: [], samples: [], use_words: [], avoid_words: [], emoji: 'light', address: '' },
        presenter: null,
        content: { domain: 'general', pillars: [], never_mention: [], rules: [...rules], custom_rules: [] },
        brand: {
            primary: brand.primary,
            accent: brand.accent,
            // The Studio's neutral font has no Arabic glyphs.
            font_display: lang === 'ar' ? 'Cairo' : 'Inter',
            logo_url: null,
            portrait_url: null,
            theme: brand.theme,
        },
        socials: { handle: '', site: '', platforms: [], links: {} },
        dm: { knowledge: '', faq: [], handoff: null, hours: null },
        goals: { ...DEFAULT_GOALS },
    };
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `patch` over `base`, the way `overDefaults` reads a stored Studio row (studio/settings.ts): plain
 * objects merge key by key, and a key `base` doesn't have is dropped, not reported, because nobody
 * is asking. A field added to the profile later therefore reads as its default for every stored
 * profile, with no backfill. Unlike `overDefaults`, a leaf of the wrong type also keeps the default
 * (a stored `pains: "x"` reads as `[]`), so a profile a bug once wrote cannot make a reader throw.
 */
function mergeOver(base: unknown, patch: unknown): unknown {
    if (patch === undefined) return base;
    if (isObj(base)) {
        if (!isObj(patch)) return base;
        const out: Loose = { ...base };
        for (const key of Object.keys(base)) out[key] = mergeOver(base[key], patch[key]);
        return out;
    }
    // Empty by default (a presenter, a country, a handoff): it may hold whatever it can.
    if (base === null) return patch;
    if (Array.isArray(base)) return Array.isArray(patch) ? patch : base;
    return typeof patch === typeof base ? patch : base;
}

/** A blank offer: what an offer saved before a field existed reads as. */
function blankOffer(): Offer {
    return { id: '', kind: 'other', name: '', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: false };
}

/**
 * A stored profile, merged over `defaultProfile()`, so it can be read whatever shape an older
 * release wrote. Not validation: `validateProfile` is what refuses a bad one, and it runs on
 * writes. Anything that is not an object reads as the default.
 *
 * What the default has no key for is copied rather than merged: the surfaces and the social links
 * (keyed by name), the offers (each over a blank offer, with its optional campaign) and
 * `audience.timezone`. The default is built for the stored language, so an English profile reads
 * as Inter, not Cairo, wherever its font is missing. `content.rules` is the one list that defaults
 * to something: a profile that never had it reads as the platform's default, and not as "no
 * rules", so the no-women rule cannot be dropped by a field that was never written (05 §0).
 */
export function upgradeProfile(raw: unknown): CreatorProfile {
    const stored: Loose = isObj(raw) ? structuredClone(raw) : {};
    const lang: Lang = isObj(stored.language) && stored.language.primary === 'en' ? 'en' : 'ar';
    const merged = mergeOver(defaultProfile({ lang }), stored) as CreatorProfile;
    // `schema` is the shape's own version: whatever was stored, this is what it has been read as.
    merged.schema = 1;

    const surfaces = isObj(stored.language) && isObj(stored.language.surfaces) ? stored.language.surfaces : {};
    merged.language.surfaces = Object.fromEntries(
        Object.keys(surfaces).flatMap((name) => {
            const one = surfaces[name];
            if (!(SURFACES as readonly string[]).includes(name) || !isObj(one)) return [];
            return [[name, Object.fromEntries((['language', 'register'] as const).filter((k) => one[k] !== undefined).map((k) => [k, one[k]]))]];
        })
    ) as CreatorProfile['language']['surfaces'];

    const links = isObj(stored.socials) && isObj(stored.socials.links) ? stored.socials.links : {};
    merged.socials.links = Object.fromEntries(
        Object.keys(links).filter((name) => (SOCIALS as readonly string[]).includes(name) && typeof links[name] === 'string').map((name) => [name, links[name]])
    ) as CreatorProfile['socials']['links'];

    merged.offers = Array.isArray(stored.offers)
        ? stored.offers.filter(isObj).map((o) => {
            const offer = mergeOver(blankOffer(), o) as Offer;
            // `campaign` is optional and has no default, so `mergeOver`, which follows the blank's keys, would lose it.
            return isObj(o.campaign) ? { ...offer, campaign: o.campaign as unknown as NonNullable<Offer['campaign']> } : offer;
        })
        : [];

    if (isObj(stored.audience) && typeof stored.audience.timezone === 'string') merged.audience.timezone = stored.audience.timezone;
    // A preset this release no longer knows is dropped: the validator would refuse it.
    merged.content.rules = merged.content.rules.filter((r) => (CONTENT_RULE_PRESETS as readonly string[]).includes(r));
    return merged;
}
