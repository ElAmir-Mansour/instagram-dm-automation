/**
 * The neutral profile a new tenant starts on, and the way a stored one is read.
 *
 * Nothing in `defaultProfile()` belongs to any one creator: no name, no offer, no presenter, no
 * dialect word. What it leaves empty is what activation asks for (`activationMissing`), so a new
 * tenant is never mistaken for a finished one. The owner's tenant is described by `legacy.ts`
 * instead; a new tenant never falls back to it.
 */
import { defaultInfographicConfig } from '../studio/settingsTypes.js';
import type { ContentRulePreset, CreatorProfile, Lang, Offer, OfferCampaign, OfferSales } from './types.js';
import {
    ADDRESS, CONTENT_RULE_PRESETS, DIGITS, DOMAINS, EMOJI_LEVELS, FONTS, KINDS, LANGS, LEVELS, MATCH_MODES, OFFER_KINDS, ON_CAMERA, ORDER_VIA,
    PRONOUNS, PROOF_KINDS, REGISTERS, SALES_LEVELS, SOCIALS, SURFACES, THEMES,
} from './types.js';

/** What a tenant with no Growth settings is aiming at (docs/agents/BRIEF.md). `DEFAULT_GOALS` in growth/settings.ts; a test holds them equal. */
const DEFAULT_GOALS = { followers: 10_000, views: 1_000_000 } as const;

/**
 * Neutral. Arabic gets the MSA register (D8: a new tenant's default is Arabic/فصحى unless the admin
 * picks otherwise), Arabic-Indic digits and the masculine address its pools are written in; English
 * gets none of those, and addresses no one in particular. `rules` is `onboarding.default_rules` for a
 * tenant created by the admin (D9: the no-women rule is pre-ticked and the wizard shows it).
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
        voice: { guide: '', tone: [], samples: [], use_words: [], avoid_words: [], emoji: 'light', address: lang === 'ar' ? 'masc' : 'neutral' },
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
        dm: { faq: [], handoff: null, hours: null },
        goals: { ...DEFAULT_GOALS },
    };
}

/** A blank offer: what an offer saved before a field existed reads as. */
function blankOffer(): Omit<Offer, 'campaign'> {
    return { id: '', kind: 'other', name: '', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: false };
}

/** A blank campaign: what one saved before `name_match` existed reads as. */
function blankCampaign(): OfferCampaign {
    return { name_match: '', match: 'substring', keywords: [], dm_template: '', public_replies: [] };
}

/**
 * A blank sales block: what one saved before a field of it existed reads as, and what an editor starts a new block from. Level 'any'
 * and no date, so a blank block states no price and pitches at no one in particular.
 */
export function blankSales(): OfferSales {
    return {
        for_whom: '', level: 'any', outcomes: [], faqs: [], objections: [], proof: [],
        price_note: '', price_valid_until: '', currency: '', image_url: '',
    };
}

// ─── Reading a stored profile ───────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const member = (list: readonly string[]) => (v: unknown): boolean => typeof v === 'string' && list.includes(v);

/** Paths with an index in them are looked up with the index left out: `offers[2].kind` is `offers[].kind`. */
const generic = (path: string): string => path.replace(/\[\d+\]/g, '[]');

/** A string-valued field that is one of a closed list. */
const ENUMS: Record<string, readonly string[]> = {
    'language.primary': LANGS, 'language.register': REGISTERS, 'language.digits': DIGITS, 'voice.emoji': EMOJI_LEVELS, 'voice.address': ADDRESS,
    'content.domain': DOMAINS, 'brand.font_display': FONTS, 'brand.theme': THEMES,
    'offers[].kind': OFFER_KINDS, 'offers[].order_via': ORDER_VIA, 'offers[].campaign.match': MATCH_MODES,
    'offers[].sales.level': SALES_LEVELS,
};

const isPresenter = (v: unknown): boolean => isObj(v) && isString(v.name) && member(PRONOUNS)(v.pronouns) && member(ON_CAMERA)(v.on_camera);
const isHandoff = (v: unknown): boolean => isObj(v) && isString(v.when) && isString(v.message);
const isHours = (v: unknown): boolean =>
    isObj(v) && Array.isArray(v.days) && v.days.every((d) => typeof d === 'number') && isString(v.from) && isString(v.to);

/** A field that is empty (null) by default may hold a value, but only a value of its own kind. */
const NULLABLE: Record<string, (v: unknown) => boolean> = {
    'identity.kind': member(KINDS), 'identity.country': isString, 'language.register': member(REGISTERS), 'audience.level': member(LEVELS),
    'presenter': isPresenter, 'brand.logo_url': isString, 'brand.portrait_url': isString, 'dm.handoff': isHandoff, 'dm.hours': isHours,
};

/** A list, and what each entry of it must be. An entry that is not is dropped. */
const ITEMS: Record<string, (v: unknown) => boolean> = {
    'audience.pains': isString, 'audience.goals': isString, 'audience.countries': isString, 'audience.languages': isString,
    'voice.tone': isString, 'voice.samples': isString, 'voice.use_words': isString, 'voice.avoid_words': isString,
    'content.pillars': isString, 'content.never_mention': isString, 'content.custom_rules': isString,
    'content.rules': member(CONTENT_RULE_PRESETS), 'socials.platforms': member(SOCIALS),
    'dm.faq': (v) => isObj(v) && isString(v.q) && isString(v.a),
    'offers[].facts': isString, 'offers[].bullets': isString, 'offers[].campaign.keywords': isString, 'offers[].campaign.public_replies': isString,
    'offers[].sales.outcomes': isString,
    'offers[].sales.faqs': (v) => isObj(v) && isString(v.q) && isString(v.a),
    'offers[].sales.objections': (v) => isObj(v) && isString(v.objection) && isString(v.answer),
    'offers[].sales.proof': (v) => isObj(v) && member(PROOF_KINDS)(v.kind) && isString(v.text) && isString(v.source),
};

/** Keys of the default that are keyed by something other than a field name: read by hand, below. */
const BY_HAND = new Set(['language.surfaces', 'socials.links']);

/** Keys the default has none for because they are optional, with what each must be. */
const OPTIONAL: Record<string, Record<string, (v: unknown) => boolean>> = { audience: { timezone: isString } };

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

class Reader {
    readonly repaired: string[] = [];
    constructor(readonly keepUnknown: boolean) {}

    note(path: string): void {
        this.repaired.push(path);
    }

    /**
     * `patch` over `base`, the way `overDefaults` reads a stored Studio row (studio/settings.ts): plain
     * objects merge key by key, so a field a later release adds reads as its default for every stored
     * profile with no backfill, and that is not a repair. A value that is *stored* but cannot be kept as
     * stored is: the wrong type, a value outside its list, an entry that is not what its list holds, a
     * key this release has no field for. It reads as the default (or is dropped) and its path is noted.
     */
    merge(base: unknown, patch: unknown, path: string): unknown {
        if (patch === undefined) return base;
        const where = generic(path);
        if (BY_HAND.has(where)) return base;
        if (isObj(base)) {
            if (!isObj(patch)) {
                this.note(path);
                return base;
            }
            const out: Loose = { ...base };
            for (const key of Object.keys(base)) out[key] = this.merge(base[key], patch[key], join(path, key));
            for (const key of Object.keys(patch)) {
                if (key in base || patch[key] === undefined) continue;
                const optional = OPTIONAL[where]?.[key];
                if (optional) {
                    if (optional(patch[key])) out[key] = patch[key];
                    else this.note(join(path, key));
                } else if (this.keepUnknown) out[key] = patch[key];
                else this.note(join(path, key));
            }
            return out;
        }
        if (base === null) {
            const fits = NULLABLE[where];
            if (patch === null) return null;
            if (fits && !fits(patch)) {
                this.note(path);
                return null;
            }
            return patch;
        }
        if (Array.isArray(base)) {
            if (!Array.isArray(patch)) {
                this.note(path);
                return base;
            }
            const item = ITEMS[where];
            if (!item) return patch;
            const kept = patch.filter(item);
            if (kept.length !== patch.length) this.note(path);
            return kept;
        }
        if (typeof patch !== typeof base || (ENUMS[where] && !ENUMS[where]!.includes(patch as string))) {
            this.note(path);
            return base;
        }
        return patch;
    }

    /** The surfaces keyed by name, each with a language and a register, either of them optional. */
    surfaces(value: unknown, path: string): CreatorProfile['language']['surfaces'] {
        const out: Loose = {};
        if (value === undefined) return out;
        if (!isObj(value)) {
            this.note(path);
            return out;
        }
        for (const [name, one] of Object.entries(value)) {
            const at = join(path, name);
            if (!(SURFACES as readonly string[]).includes(name)) {
                if (this.keepUnknown) out[name] = one;
                else this.note(at);
            } else if (!isObj(one)) {
                this.note(at);
            } else {
                const surface: Loose = {};
                for (const [key, v] of Object.entries(one)) {
                    if (v === undefined) continue;
                    if (key === 'language' || key === 'register') {
                        if (member(key === 'language' ? LANGS : REGISTERS)(v)) surface[key] = v;
                        else this.note(join(at, key));
                    } else if (this.keepUnknown) surface[key] = v;
                    else this.note(join(at, key));
                }
                out[name] = surface;
            }
        }
        return out as CreatorProfile['language']['surfaces'];
    }

    /** The social links keyed by platform, each a string. */
    links(value: unknown, path: string): CreatorProfile['socials']['links'] {
        const out: Loose = {};
        if (value === undefined) return out;
        if (!isObj(value)) {
            this.note(path);
            return out;
        }
        for (const [name, link] of Object.entries(value)) {
            if (link === undefined) continue;
            const known = (SOCIALS as readonly string[]).includes(name);
            if (known && isString(link)) out[name] = link;
            else if (!known && this.keepUnknown) out[name] = link;
            else this.note(join(path, name));
        }
        return out as CreatorProfile['socials']['links'];
    }

    /** Each offer over a blank one, and its optional campaign and sales block over blank ones. An entry that is no object is dropped. */
    offers(value: unknown): Offer[] {
        if (value === undefined) return [];
        if (!Array.isArray(value)) {
            this.note('offers');
            return [];
        }
        const out: Offer[] = [];
        value.forEach((stored, i) => {
            const at = `offers[${i}]`;
            if (!isObj(stored)) {
                this.note(at);
                return;
            }
            const { campaign, sales, ...rest } = stored;
            const offer = this.merge(blankOffer(), rest, at) as Offer;
            if (campaign !== undefined) {
                if (isObj(campaign)) offer.campaign = this.merge(blankCampaign(), campaign, `${at}.campaign`) as OfferCampaign;
                else this.note(`${at}.campaign`);
            }
            if (sales !== undefined) {
                if (isObj(sales)) offer.sales = this.merge(blankSales(), sales, `${at}.sales`) as OfferSales;
                else this.note(`${at}.sales`);
            }
            out.push(offer);
        });
        return out;
    }
}

/** What reading a stored profile found. */
export interface UpgradedProfile {
    profile: CreatorProfile;
    /** Every stored path whose value was not kept as stored: reset to the default, or dropped. Empty for a profile this release wrote. */
    repaired: string[];
    /**
     * The stored `schema` is newer than this release knows. Its unknown keys are then kept on `profile`
     * as they were stored, and P4's save must refuse to write a profile read like this: writing it would
     * delete what a newer release stored. (`schema` itself stays as stored, so `validateProfile` refuses it too.)
     */
    newerSchema: boolean;
}

/**
 * A stored profile, merged over `defaultProfile()`, so it can be read whatever shape an older release
 * wrote. Not validation: `validateProfile` refuses a bad profile, and it runs on writes.
 *
 * What a reader gets is a profile whose fields each have the type the profile says: a stored value of
 * the wrong type, or outside its list, or an entry of a list that is not what the list holds, is read as
 * the default (or dropped) and named in `repaired`, so a repair is never silent. It does not say a
 * value is *valid*: a colour may not be a colour and a text may be too long.
 *
 * - Anything that is not an object reads as the default (and is repaired, unless it is null/undefined).
 * - The default is built for the stored language, so an English profile reads as Inter, not Cairo.
 * - `content.rules` is the one list that defaults to something: a profile that never had it reads as the
 *   platform's default, not as "no rules", so the no-women rule is not dropped by a field never written.
 * - A stored `schema` above 1 is `newerSchema`: nothing unknown is dropped.
 */
export function upgradeProfile(raw: unknown): UpgradedProfile {
    const stored: Loose = isObj(raw) ? structuredClone(raw) : {};
    const newerSchema = Number.isInteger(stored.schema) && (stored.schema as number) > 1;
    const reader = new Reader(newerSchema);
    if (raw !== undefined && raw !== null && !isObj(raw)) reader.note('profile');

    const lang: Lang = isObj(stored.language) && member(LANGS)(stored.language.primary) ? (stored.language.primary as Lang) : 'ar';
    const base = defaultProfile({ lang });
    // The sections whose keys are not the default's own are read by hand; the rest merge over the default.
    const { offers, ...rest } = stored;
    const merged = reader.merge({ ...base, offers: [] }, rest, '') as CreatorProfile & Loose;

    const language = isObj(stored.language) ? stored.language : {};
    merged.language.surfaces = reader.surfaces(language.surfaces, 'language.surfaces');
    const socials = isObj(stored.socials) ? stored.socials : {};
    merged.socials.links = reader.links(socials.links, 'socials.links');
    merged.offers = reader.offers(offers);

    // The shape's own version. A newer one stays as stored; a missing one is this release's; a garbled one is repaired.
    if (!newerSchema) {
        // A schema of another type was repaired by the merge; a number other than 1 (a 0, a 1.5) is repaired here.
        if (typeof stored.schema === 'number' && stored.schema !== 1) reader.note('schema');
        merged.schema = 1;
    }
    return { profile: merged, repaired: reader.repaired, newerSchema };
}
