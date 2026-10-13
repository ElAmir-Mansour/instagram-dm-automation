/**
 * Colours and logo for the draft (docs/onboarding/03 §3.4): found by code, never written by the model.
 * Pure: it reads text it is handed (a page's `SiteExtract`, a manifest, stylesheets, SVG sources); the
 * caller fetched them through `safeFetch`.
 *
 * The primary colour, in order of trust:
 *   1. the `theme-color` meta;  2. the manifest's `theme_color`;  3. CSS custom properties
 *   (`--primary`, `--brand`, `--accent`, `--bs-primary`);  4. CSS frequency, counted three times inside
 *   `button`, `a` and `header` rules;  5. SVG fills.
 * Greys (saturation under 15%) and near-white or near-black (lightness outside 8 to 92%) are dropped from
 * every source, near-duplicates are merged, and the accent is the next colour at least 30 degrees of hue
 * away from the primary. `ink` and `paper` are the text and background colours of a theme, chosen so that
 * they contrast at 4.5 or better.
 *
 * The logo, in order: JSON-LD `Organization.logo`, `apple-touch-icon`, the largest PNG icon. NEVER `og:image`
 * and never a profile picture: those are usually photographs of a person, and the owner's rule is that no
 * image of one is used. An SVG logo contributes colours only. The model is given no images at all.
 */
import { colourDistance, contrastRatio, hexToRgb, hslToRgb, hueDistance, isBrandable, parseColour, rgbToHsl, toHex } from './colour.js';
import { resolveHref, type SiteExtract } from './siteExtract.js';

// ─── CSS ─────────────────────────────────────────────────────────────────────────────────────

interface Declaration {
    selector: string;
    prop: string;
    value: string;
}

const MAX_CSS_CHARS = 600_000;
const MAX_DECLARATIONS = 50_000;

/** Declarations and custom properties of a stylesheet. A small scanner: braces, quotes and parentheses, comments dropped, `@font-face` ignored. */
function readCss(css: string): { decls: Declaration[]; vars: Map<string, string> } {
    const decls: Declaration[] = [];
    const vars = new Map<string, string>();
    const rootDefined = new Set<string>();
    // Comments out, without a pattern that could backtrack across a long file.
    let src = '';
    for (let i = 0, n = Math.min(css.length, MAX_CSS_CHARS); i < n; ) {
        const open = css.indexOf('/*', i);
        if (open < 0 || open >= n) {
            src += css.slice(i, n);
            break;
        }
        src += css.slice(i, open);
        const close = css.indexOf('*/', open + 2);
        i = close < 0 ? n : close + 2;
    }

    const stack: string[] = [];
    let buf = '';
    let quote = '';
    let paren = 0;
    const selectorNow = (): string => {
        for (let i = stack.length - 1; i >= 0; i--) if (!stack[i]!.startsWith('@')) return stack[i]!;
        return '';
    };
    const inFontFace = (): boolean => stack.some((s) => /^@font-face/i.test(s));
    const declare = () => {
        const text = buf.trim();
        buf = '';
        const colon = text.indexOf(':');
        if (colon <= 0 || stack.length === 0 || decls.length >= MAX_DECLARATIONS || inFontFace()) return;
        const prop = text.slice(0, colon).trim().toLowerCase();
        const value = text.slice(colon + 1).trim();
        const selector = selectorNow();
        if (prop.startsWith('--')) {
            const root = /(?:^|[\s,])(?::root|html|body|\*|:host)(?![\w-])/i.test(selector);
            if (!vars.has(prop) || (root && !rootDefined.has(prop))) vars.set(prop, value);
            if (root) rootDefined.add(prop);
            return;
        }
        decls.push({ selector, prop, value });
    };
    for (const ch of src) {
        if (quote) {
            buf += ch;
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            buf += ch;
        } else if (ch === '(') {
            paren++;
            buf += ch;
        } else if (ch === ')') {
            paren = Math.max(0, paren - 1);
            buf += ch;
        } else if (paren > 0) {
            buf += ch;
        } else if (ch === '{') {
            stack.push(buf.trim());
            buf = '';
        } else if (ch === '}') {
            declare();
            stack.pop();
        } else if (ch === ';') {
            declare();
        } else {
            buf += ch;
        }
    }
    return { decls, vars };
}

const COLOUR_PROPS = /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-\w+)?)?(?:-color)?|outline(?:-color)?|fill|stroke|stop-color|text-decoration(?:-color)?|accent-color|caret-color)$/;
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{3,60}\)|hsla?\([^)]{3,60}\)|var\(\s*--[\w-]+\s*(?:,[^)]{0,60})?\)/g;
const HEAVY_SELECTOR = /(?:^|[\s,>+~(])(?:button|a|header)(?![\w-])|\.btn(?![a-z])|\.button(?![a-z])/i;

/** The custom properties that name a brand colour, most trusted first. */
const VAR_ROLE = /^--(?:color-|theme-|clr-)?(primary|brand|accent|bs-primary)(?:-(?:color|colour|main|base|default|500))?$/;
const VAR_ROLE_ORDER = ['primary', 'brand', 'accent', 'bs-primary'];

/** A custom property's colour, following `var(--other)` references a few hops. */
function resolveVar(name: string, vars: Map<string, string>, depth = 0): string | null {
    const value = vars.get(name);
    if (value === undefined || depth > 4) return null;
    const ref = value.match(/^var\(\s*(--[\w-]+)/);
    if (ref) return resolveVar(ref[1]!, vars, depth + 1);
    const literal = value.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{3,60}\)|hsla?\([^)]{3,60}\)/);
    return literal ? parseColour(literal[0]) : null;
}

interface CssColours {
    vars: string[];
    frequency: string[];
}

function coloursOfCss(sheets: readonly string[]): CssColours {
    const vars: Array<{ hex: string; rank: number; order: number }> = [];
    const counts = new Map<string, number>();
    let order = 0;
    for (const sheet of sheets) {
        const { decls, vars: defined } = readCss(sheet);
        for (const [name] of defined) {
            const role = name.match(VAR_ROLE)?.[1];
            if (!role) continue;
            const hex = resolveVar(name, defined);
            if (hex) vars.push({ hex, rank: VAR_ROLE_ORDER.indexOf(role), order: order++ });
        }
        for (const d of decls) {
            if (!COLOUR_PROPS.test(d.prop)) continue;
            const weight = HEAVY_SELECTOR.test(d.selector) ? 3 : 1;
            for (const m of d.value.matchAll(COLOUR_LITERAL)) {
                const hex = m[0].startsWith('var(') ? resolveVar(m[0].match(/--[\w-]+/)![0], defined) : parseColour(m[0]);
                if (hex) counts.set(hex, (counts.get(hex) ?? 0) + weight);
            }
        }
    }
    return {
        vars: vars.sort((a, b) => a.rank - b.rank || a.order - b.order).map((v) => v.hex),
        frequency: [...counts].sort((a, b) => b[1] - a[1]).map(([hex]) => hex),
    };
}

/** The fills of SVG sources (`fill`, `stop-color`), most used first. */
function coloursOfSvg(sources: readonly string[]): string[] {
    const counts = new Map<string, number>();
    const add = (value: string) => {
        const hex = parseColour(value);
        if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    };
    for (const svg of sources) {
        for (const m of svg.slice(0, MAX_CSS_CHARS).matchAll(/(?:fill|stop-color)\s*[:=]\s*["']?\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{3,60}\)|hsla?\([^)]{3,60}\))/gi)) add(m[1]!);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
}

// ─── The palette ─────────────────────────────────────────────────────────────────────────────

export type PrimarySource = 'theme-color' | 'manifest' | 'css-var' | 'css-frequency' | 'svg';

export interface BrandInputs {
    /** The page's `theme-color` meta (`SiteExtract.themeColor`). */
    themeColor?: string | null;
    /** The manifest's `theme_color`. */
    manifestThemeColor?: string | null;
    /** Stylesheet texts: the page's own `<style>` blocks and up to two fetched sheets. */
    css?: readonly string[];
    /** SVG sources: a fetched SVG logo, and the page's inline fills (`SiteExtract.svgFills`) as `fill="#..."` text. */
    svg?: readonly string[];
}

export interface BrandColours {
    primary: string | null;
    accent: string | null;
    primarySource: PrimarySource | null;
    /** Every colour that survived, most trusted first. */
    palette: string[];
}

/** Two colours closer than this (RGB distance) are the same colour for a brand. */
const NEAR_DUPLICATE = 40;
const MIN_ACCENT_HUE = 30;

export function brandColours(input: BrandInputs): BrandColours {
    const css = coloursOfCss(input.css ?? []);
    const tiers: Array<{ source: PrimarySource; colours: string[] }> = [
        { source: 'theme-color', colours: [input.themeColor].flatMap((c) => (c ? [parseColour(c)] : [])).filter((c): c is string => c !== null) },
        { source: 'manifest', colours: [input.manifestThemeColor].flatMap((c) => (c ? [parseColour(c)] : [])).filter((c): c is string => c !== null) },
        { source: 'css-var', colours: css.vars },
        { source: 'css-frequency', colours: css.frequency },
        { source: 'svg', colours: coloursOfSvg(input.svg ?? []) },
    ];
    const ranked: Array<{ hex: string; source: PrimarySource }> = [];
    for (const tier of tiers) {
        for (const hex of tier.colours) {
            if (!isBrandable(hex)) continue;
            if (ranked.some((kept) => colourDistance(kept.hex, hex) < NEAR_DUPLICATE)) continue;
            ranked.push({ hex, source: tier.source });
        }
    }
    const primary = ranked[0] ?? null;
    let accent: string | null = null;
    if (primary) {
        const hue = rgbToHsl(hexToRgb(primary.hex)!).h;
        accent = ranked.slice(1).find((c) => hueDistance(rgbToHsl(hexToRgb(c.hex)!).h, hue) >= MIN_ACCENT_HUE)?.hex ?? null;
    }
    return { primary: primary?.hex ?? null, accent, primarySource: primary?.source ?? null, palette: ranked.map((c) => c.hex) };
}

/** The minimum contrast between ink and paper (WCAG AA for body text). */
export const MIN_CONTRAST = 4.5;

/**
 * The text colour and the background of a theme, tinted toward the brand's hue and chosen so that they
 * contrast at 4.5 or better. A tint that cannot reach it falls back to black or white, which always can.
 */
export function inkAndPaper(primary: string | null, theme: 'dark' | 'light'): { ink: string; paper: string } {
    const rgb = primary ? hexToRgb(primary) : null;
    const hue = rgb ? rgbToHsl(rgb).h : 0;
    const tint = (s: number, l: number): string => toHex(hslToRgb({ h: hue, s: rgb ? s : 0, l }));
    const paper = theme === 'dark' ? tint(0.25, 0.07) : tint(0.2, 0.97);
    const candidates = theme === 'dark' ? [tint(0.15, 0.95), '#FFFFFF'] : [tint(0.3, 0.12), '#000000'];
    const ink = candidates.find((c) => contrastRatio(c, paper) >= MIN_CONTRAST) ?? (theme === 'dark' ? '#FFFFFF' : '#000000');
    return { ink, paper };
}

// ─── The manifest ────────────────────────────────────────────────────────────────────────────

export interface ManifestIcon {
    src: string;
    size: number;
    type: string;
}

export interface Manifest {
    name: string;
    shortName: string;
    themeColor: string | null;
    backgroundColor: string | null;
    icons: ManifestIcon[];
}

const largestEdge = (sizes: unknown): number => {
    let best = 0;
    if (typeof sizes === 'string') for (const m of sizes.toLowerCase().matchAll(/(\d{1,4})x(\d{1,4})/g)) best = Math.max(best, Number(m[1]), Number(m[2]));
    return best;
};

/** A web app manifest, read leniently; null when it is not JSON or not an object. */
export function parseManifest(text: string, manifestUrl: string): Manifest | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const m = raw as Record<string, unknown>;
    let base: URL;
    try {
        base = new URL(manifestUrl);
    } catch {
        return null;
    }
    const str = (v: unknown, max = 120): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const colour = (v: unknown): string | null => (typeof v === 'string' ? parseColour(v) : null);
    const icons: ManifestIcon[] = [];
    if (Array.isArray(m.icons)) {
        for (const icon of m.icons.slice(0, 20)) {
            if (typeof icon !== 'object' || icon === null) continue;
            const i = icon as Record<string, unknown>;
            const src = resolveHref(typeof i.src === 'string' ? i.src : undefined, base);
            if (src) icons.push({ src, size: largestEdge(i.sizes), type: str(i.type, 60).toLowerCase() });
        }
    }
    return { name: str(m.name), shortName: str(m.short_name), themeColor: colour(m.theme_color), backgroundColor: colour(m.background_color), icons };
}

// ─── The logo ────────────────────────────────────────────────────────────────────────────────

export interface LogoCandidate {
    url: string;
    source: 'jsonld' | 'apple-touch-icon' | 'icon' | 'manifest';
    /** From the address or the declared type; `unknown` is checked against the file's bytes when it is fetched. */
    format: 'png' | 'jpeg' | 'webp' | 'svg' | 'unknown';
    /** The largest edge it declares, in pixels; 0 when unknown. */
    size: number;
}

export interface Logos {
    /** Raster logos, most trusted first. Saved as an upload only after the tenant confirms one. */
    candidates: LogoCandidate[];
    /** SVG logos: read for colours only. */
    svg: LogoCandidate[];
}

function formatOf(url: string, type = ''): LogoCandidate['format'] | 'ico' | 'gif' {
    const t = type.toLowerCase();
    if (t.includes('svg')) return 'svg';
    if (t.includes('png')) return 'png';
    if (t.includes('jpeg') || t.includes('jpg')) return 'jpeg';
    if (t.includes('webp')) return 'webp';
    if (t.includes('icon') || t.includes('ico')) return 'ico';
    if (t.includes('gif')) return 'gif';
    let path = url;
    try {
        path = new URL(url).pathname;
    } catch {
        // keep the string
    }
    const ext = path.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
    if (ext === 'png') return 'png';
    if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
    if (ext === 'webp') return 'webp';
    if (ext === 'svg') return 'svg';
    if (ext === 'ico') return 'ico';
    if (ext === 'gif') return 'gif';
    return 'unknown';
}

const MAX_LOGOS = 5;

/**
 * Where the logo might be, in the order of trust, from the page and its manifest. `og:image` is not among
 * them, whatever the page says: it is not read here at all.
 */
export function logoCandidates(site: Pick<SiteExtract, 'icons' | 'jsonLd'>, manifest?: Pick<Manifest, 'icons'> | null): Logos {
    const raster: LogoCandidate[] = [];
    const svg: LogoCandidate[] = [];
    const seen = new Set<string>();
    const add = (url: string, source: LogoCandidate['source'], size: number, type = '') => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        const format = formatOf(url, type);
        // An .ico or a GIF is not a logo a profile can use.
        if (format === 'ico' || format === 'gif') return;
        const candidate: LogoCandidate = { url, source, format, size };
        if (format === 'svg') svg.push(candidate);
        else if (raster.length < MAX_LOGOS) raster.push(candidate);
    };

    for (const logo of site.jsonLd.organization?.logos ?? []) add(logo, 'jsonld', 0);

    const bySize = <T extends { size: number }>(list: T[]): T[] => [...list].sort((a, b) => b.size - a.size);
    for (const icon of bySize(site.icons.filter((i) => i.rel === 'apple-touch-icon'))) add(icon.href, 'apple-touch-icon', icon.size, icon.type);

    // The largest PNG icon, from the page's icon links and the manifest together.
    const pngs = [
        ...site.icons.filter((i) => i.rel === 'icon').map((i) => ({ url: i.href, size: i.size, type: i.type, source: 'icon' as const })),
        ...(manifest?.icons ?? []).map((i) => ({ url: i.src, size: i.size, type: i.type, source: 'manifest' as const })),
    ].filter((i) => formatOf(i.url, i.type) === 'png');
    for (const icon of bySize(pngs)) add(icon.url, icon.source, icon.size, icon.type);

    // An SVG icon (the page's own, or the manifest's) contributes colours, and only colours; collect it the same way.
    for (const icon of site.icons.filter((i) => i.rel === 'icon' && formatOf(i.href, i.type) === 'svg')) add(icon.href, 'icon', icon.size, icon.type);
    for (const icon of (manifest?.icons ?? []).filter((i) => formatOf(i.src, i.type) === 'svg')) add(icon.src, 'manifest', icon.size, icon.type);
    return { candidates: raster, svg };
}
