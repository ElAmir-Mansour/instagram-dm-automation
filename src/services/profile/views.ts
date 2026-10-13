/**
 * The Studio and Growth settings as views over the Creator Profile (docs/onboarding/01 §0 and §2).
 *
 * Every prompt builder is a pure function of `StudioSettings` (and the Growth coach of
 * `GrowthSettings`), so if the view is deep-equal to the row the builder reads today, every prompt is
 * byte-identical. That is the whole trick of phase 1: the readers keep returning the settings, and a
 * fact that moved into the profile is read from there.
 *
 *   studioView(stored, p)        the stored row with the profile-owned fields replaced from `p`
 *   growthView(stored, p)        the same for the Growth settings
 *   intoProfile(p, s, g?)        the inverse: `p` with the profile-owned fields taken from the settings
 *
 * The two are a lens, and `views.test.ts` holds them to its laws:
 *   studioView(stale, intoProfile(p, s)) ≡ s        `stale` is `s` with every owned field scrambled
 *   intoProfile(p, studioView(s, p)) ≡ p
 *
 * Two rules the goldens depend on, both about *shape*, not value: a view is built by spreading the
 * stored object and overriding in place, so keys keep the stored order (the prompts print some of
 * these objects as JSON); and an optional key the profile has nothing for is left out, not written
 * as `undefined` or an empty list.
 */
import { isDeepStrictEqual } from 'node:util';
import type { GrowthSettings } from '../../db/rows.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import type { ArabicRegister, CreatorProfile, Lang, Offer, Surface } from './types.js';
import { primaryOffer } from './validate.js';

/** The Studio settings the profile owns, so P4's PUT knows which paths to route into `saveProfile` (01 §2). */
export const STUDIO_PROFILE_PATHS = [
    'brand.name', 'brand.fonts.display',
    'voice.language', 'voice.digits', 'voice.guide', 'voice.avoid',
    'product.name', 'product.url', 'product.facts', 'product.dmBullets',
    'schedule.timezone',
    'infographic.name.ar', 'infographic.name.en', 'infographic.site', 'infographic.handle', 'infographic.socials',
    'infographic.primary', 'infographic.accent', 'infographic.photo_url', 'infographic.theme', 'infographic.language',
] as const;

/** The Growth settings the profile owns. */
export const GROWTH_PROFILE_PATHS = [
    'audience.countries', 'audience.languages', 'audience.timezone', 'goal_followers', 'goal_views',
] as const;

function valueAt(root: unknown, path: string): unknown {
    let at: unknown = root;
    for (const key of path.split('.')) {
        if (typeof at !== 'object' || at === null || Array.isArray(at)) return undefined;
        at = (at as Record<string, unknown>)[key];
    }
    return at;
}

/**
 * The paths of `paths` whose value differs between two settings objects: what an edit changed among the fields the
 * profile owns. P4's writers route a change here into `saveProfile`; a change to anything else (the Monteur, the CTA
 * words, the palette, the slots…) never touches the profile. A path an object does not hold reads as undefined.
 */
export function changedPaths(before: object, after: object, paths: readonly string[]): string[] {
    return paths.filter((path) => !isDeepStrictEqual(valueAt(before, path), valueAt(after, path)));
}

/** The language a surface speaks: its own override, else the profile's. */
export function surfaceLanguage(p: CreatorProfile, surface: Surface): Lang {
    return p.language.surfaces[surface]?.language ?? p.language.primary;
}

/** What `brand.name` reads when the profile holds no brand name of its own (01 §2). */
export function brandName(p: CreatorProfile): string {
    return p.identity.brand_name || p.identity.display_name.en || 'My Studio';
}

/** What `schedule.timezone` reads: an empty profile timezone is the Studio's default, UTC (01 §2). */
export function scheduleTimezone(p: CreatorProfile): string {
    return p.identity.timezone || 'UTC';
}

/**
 * `list` written into `target[key]` when there is anything to write, or when the key is already
 * there (a stale value must be replaced, even by nothing). An empty list never adds a key the stored
 * object did not have.
 */
function setList<T extends object, K extends keyof T>(target: T, key: K, list: readonly string[]): void {
    if (list.length > 0 || key in target) (target as Record<K, unknown>)[key] = [...list];
}

/**
 * The Studio settings `p` describes, over the stored row. Replaces exactly `STUDIO_PROFILE_PATHS`;
 * every other field (palette, CTA words, slots, the Monteur, the examples…) is the stored one.
 *
 * `product` is the primary offer. A profile with no offer has no product, and says so: the stored
 * product is not kept, or a tenant who removed their offer would still be selling it.
 * `brand.direction` is the stored one: it is a setting of its own (the carousel template's reading
 * direction, edited in Studio settings), and an Arabic row set left to right, or an English one set right
 * to left, is a choice the profile must not undo.
 */
export function studioView(stored: StudioSettings, p: CreatorProfile): StudioSettings {
    const offer = primaryOffer(p.offers);
    const voice = { ...stored.voice, language: p.language.primary, digits: p.language.digits, guide: p.voice.guide };
    setList(voice, 'avoid', p.content.never_mention);
    return {
        ...stored,
        brand: {
            ...stored.brand,
            name: brandName(p),
            fonts: { ...stored.brand.fonts, display: p.brand.font_display },
        },
        voice,
        product: {
            ...stored.product,
            name: offer?.name ?? '',
            url: offer?.url ?? '',
            facts: [...(offer?.facts ?? [])],
            dmBullets: [...(offer?.bullets ?? [])],
        },
        schedule: { ...stored.schedule, timezone: scheduleTimezone(p) },
        infographic: {
            ...stored.infographic,
            name: { ...stored.infographic.name, ar: p.identity.display_name.ar, en: p.identity.display_name.en },
            site: p.socials.site,
            handle: p.socials.handle,
            socials: [...p.socials.platforms],
            primary: p.brand.primary,
            accent: p.brand.accent,
            photo_url: p.brand.portrait_url,
            theme: p.brand.theme,
            language: surfaceLanguage(p, 'infographic'),
        },
    };
}

/**
 * The Growth settings `p` describes, over the stored row. `audience.timezone` is only the heatmap's
 * override, so a profile without one removes it. The keywords, hashtag sets and competitors are how
 * the Growth agent works and stay as stored.
 */
export function growthView(stored: GrowthSettings, p: CreatorProfile): GrowthSettings {
    const audience = { ...stored.audience };
    setList(audience, 'countries', p.audience.countries);
    setList(audience, 'languages', p.audience.languages);
    if (p.audience.timezone === undefined) delete audience.timezone;
    else audience.timezone = p.audience.timezone;
    return { ...stored, audience, goal_followers: p.goals.followers, goal_views: p.goals.views };
}

const hasProduct = (s: StudioSettings): boolean => Boolean(s.product.name || s.product.url || s.product.facts.length || s.product.dmBullets.length);

/**
 * `p` with the profile-owned fields taken from the settings: what the profile is, given what a
 * tenant's rows already say. `g` is optional; left out, the profile keeps its own audience and goals.
 * (The DM bot's knowledge base is not a profile field: it stays an agent setting.)
 *
 * Where the view of a field is lossy (`brand.name` falls back to the display name, an empty timezone
 * reads as UTC, the infographic language is only an override of the primary), `p` keeps its own
 * value whenever the view of it already equals what the settings say. That keeps the second lens
 * law true for every profile, an empty default included, and a profile is never rewritten into
 * something that merely reads the same. A tenant that has no profile yet must NOT be read that way:
 * `profileFromLegacy` copies both of those fields outright.
 */
export function intoProfile(p: CreatorProfile, s: StudioSettings, g?: GrowthSettings): CreatorProfile {
    const next = structuredClone(p);

    // Language. An Arabic profile needs a register to be valid, and the Studio's voice.language
    // cannot name one: a tenant switched to Arabic reads as MSA (D8), the default for low confidence.
    next.language.primary = s.voice.language;
    next.language.digits = s.voice.digits;
    if (next.language.primary === 'ar' && next.language.register === null) next.language.register = 'msa';
    next.voice.guide = s.voice.guide;
    next.content.never_mention = [...(s.voice.avoid ?? [])];
    // The infographic language is a surface override, written only when it differs from the primary.
    if (s.infographic.language !== surfaceLanguage(next, 'infographic')) {
        const { language: _was, ...rest } = next.language.surfaces.infographic ?? {};
        let surface: { language?: Lang; register?: ArabicRegister } = s.infographic.language === next.language.primary ? rest : { ...rest, language: s.infographic.language };
        // An Arabic surface needs a register, its own or the profile's (the validator says so); the Studio
        // cannot name one, so a surface this creates for Arabic reads as MSA, as the profile's own does.
        if (surface.language === 'ar' && !surface.register && next.language.register === null) surface = { ...surface, register: 'msa' };
        if (Object.keys(surface).length > 0) next.language.surfaces.infographic = surface;
        else delete next.language.surfaces.infographic;
    }

    // Identity and brand.
    next.identity.display_name = { ar: s.infographic.name.ar, en: s.infographic.name.en };
    if (s.brand.name !== brandName(next)) next.identity.brand_name = s.brand.name;
    if (s.schedule.timezone !== scheduleTimezone(next)) next.identity.timezone = s.schedule.timezone;
    next.brand.font_display = s.brand.fonts.display;
    next.brand.primary = s.infographic.primary;
    next.brand.accent = s.infographic.accent;
    next.brand.portrait_url = s.infographic.photo_url;
    next.brand.theme = s.infographic.theme;
    next.socials.site = s.infographic.site;
    next.socials.handle = s.infographic.handle;
    next.socials.platforms = [...s.infographic.socials];

    // The product is the primary offer. With no offer yet, a product that says anything makes one.
    const fields = { name: s.product.name, url: s.product.url, facts: [...s.product.facts], bullets: [...s.product.dmBullets] };
    const offer = primaryOffer(next.offers);
    if (offer) {
        const hadLink = offer.url !== '';
        Object.assign(offer, fields);
        // A link-less offer can only be ordered by message, and an offer that says otherwise is invalid;
        // one that was link-less and gets a link is ordered by it again. An offer that already had a
        // link and says "message me" is the tenant's choice, and stays.
        if (offer.order_via === 'url' && !offer.url) offer.order_via = 'dm';
        else if (offer.order_via === 'dm' && !hadLink && offer.url) offer.order_via = 'url';
    } else if (hasProduct(s)) {
        const created: Offer = { id: 'main', kind: 'other', ...fields, order_via: fields.url ? 'url' : 'dm', price: '', keyword: '', primary: true };
        next.offers.push(created);
    }

    if (g) applyGrowth(next, g);
    return next;
}

/** `next`'s audience and goals, taken from the Growth settings (`GROWTH_PROFILE_PATHS`). */
function applyGrowth(next: CreatorProfile, g: GrowthSettings): void {
    next.audience.countries = [...(g.audience.countries ?? [])];
    next.audience.languages = [...(g.audience.languages ?? [])];
    if (g.audience.timezone === undefined) delete next.audience.timezone;
    else next.audience.timezone = g.audience.timezone;
    next.goals = { followers: g.goal_followers, views: g.goal_views };
}

/**
 * `p` with only its audience and goals taken from the Growth settings: what a Growth settings write changes in the
 * profile. `intoProfile` needs Studio settings too; this is the half a Growth write has.
 */
export function growthIntoProfile(p: CreatorProfile, g: GrowthSettings): CreatorProfile {
    const next = structuredClone(p);
    applyGrowth(next, g);
    return next;
}
