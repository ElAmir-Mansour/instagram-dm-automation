/**
 * The brand a payload carries: a tenant's logo, and its colours when the "use my brand colours" switch is on (Brand Kit, contract §3).
 *
 * Pure, and it imports only the colour helpers and types: no database, so `promptSurface` and the golden tests can use it.
 *
 * The two outputs are independent and both default to nothing (I1): no logo means no `logo` key in any payload, and the switch off
 * (`use_brand_colours !== true`, which includes absent) means no colour in any payload moves. The platform owner has neither, so his
 * payloads are byte-identical to what they were before the Brand Kit existed. The switch sets the DEFAULT of a new item and never
 * rewrites a stored choice (I8): a carousel's `accent` and a clip's accent stay what they were made with.
 */
import { contrastRatio, hexToRgb, toHex } from '../onboarding/colour.js';
import type { CreatorProfile, LogoTone } from '../profile/types.js';

/** What a payload carries for the logo: `LogoAsset` without `added_at`. The worker's `RenderLogo` is this, key for key. */
export interface RenderLogo { url: string; width: number; height: number; alpha: boolean; tone: LogoTone; colour: string }

/** The switch, worked out. Only when `profile.brand.use_brand_colours === true`. */
export interface BrandColours {
    /** The carousel page (`brand.colors.ink` of a carousel payload): `mix(primary, '#000000', 0.82)`, the infographic's dark page. */
    carouselInk: string;
    /** A NEW carousel's accent (`GenContext.palette = [it]`): `readableOn(accent, carouselInk)`. */
    carouselAccent: string;
    /** A NEW reel's accent: `readableOn(accent, '#08080A')`, the reel's ink and its call-to-action card. */
    reelAccent: string;
    /** The explainer's `title_color`: `readableOn(accent, '#000000')`, its canvas. */
    explainerTitle: string;
}

export interface RenderBrand { logo: RenderLogo | null; colours: BrandColours | null }
export const NO_BRAND: RenderBrand = Object.freeze({ logo: null, colours: null });

/** The worker's `lookFor` fallbacks: what a colour that is no colour reads as. */
const FALLBACK_PRIMARY = '#0E3B5C';
const FALLBACK_ACCENT = '#F2A33A';

/** Per channel `round(a + (b - a) * k)`, `#RRGGBB` upper case: the worker's `mix`, and the dashboard's. A colour that is no colour is returned as it is. */
export function mix(a: string, b: string, k: number): string {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    if (!x || !y) return a;
    return toHex({ r: x.r + (y.r - x.r) * k, g: x.g + (y.g - x.g) * k, b: x.b + (y.b - x.b) * k });
}

/**
 * `colour`, lightened toward white in steps of 2.5% until it reads on `background` at `min` or better (WCAG contrast); white when no step
 * does. The dark branch of the dashboard's `fixContrast` (`welcome.js`), which mirrors it.
 */
export function readableOn(colour: string, background: string, min = 4.5): string {
    for (let i = 0; i <= 40; i++) {
        const candidate = mix(colour, '#FFFFFF', i * 0.025);
        if (contrastRatio(candidate, background) >= min) return candidate;
    }
    return '#FFFFFF';
}

const hexOr = (value: unknown, fallback: string): string => (typeof value === 'string' && hexToRgb(value) ? value.toUpperCase() : fallback);

/** The colours the switch gives, from the brand's primary and accent. An invalid colour reads as the worker's fallback for it. */
export function brandColours(primary: string, accent: string): BrandColours {
    const p = hexOr(primary, FALLBACK_PRIMARY);
    const a = hexOr(accent, FALLBACK_ACCENT);
    const carouselInk = mix(p, '#000000', 0.82);
    return {
        carouselInk,
        carouselAccent: readableOn(a, carouselInk),
        reelAccent: readableOn(a, '#08080A'),
        explainerTitle: readableOn(a, '#000000'),
    };
}

/**
 * What a profile's brand section hands the payload builders. `logo` is `logos.main` without `added_at`, its keys in the order the
 * worker's `RenderLogo` has them; `colours` is `brandColours` when the switch is exactly `true`. Reads `logos.main` only, never `logo_url`.
 */
export function renderBrandOf(profile: Pick<CreatorProfile, 'brand'>): RenderBrand {
    const { brand } = profile;
    const main = brand.logos?.main;
    const logo: RenderLogo | null = main
        ? { url: main.url, width: main.width, height: main.height, alpha: main.alpha, tone: main.tone, colour: main.colour }
        : null;
    const colours = brand.use_brand_colours === true ? brandColours(brand.primary, brand.accent) : null;
    return logo === null && colours === null ? NO_BRAND : { logo, colours };
}
