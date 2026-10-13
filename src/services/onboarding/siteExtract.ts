/**
 * The site extractor (docs/onboarding/03 §1, "Website"): what a creator's own page says about them, read
 * from an HTML string. Pure: it never fetches anything, runs nothing and renders nothing, so a fixture
 * is all a test needs.
 *
 * What it takes: the title, the meta description and the `og:*` tags, `theme-color`, the icons, the
 * manifest and the stylesheets (as addresses, for the caller to fetch through `safeFetch`), the JSON-LD
 * (an Organization or Person, Product / Course / Service offers, an FAQPage), the social links, the
 * language and direction, the contact details, the headings and list items, and the visible text, sampled
 * for the creator's voice.
 *
 * What it does not take: text a visitor cannot see. A script, a style, a template, an SVG, a `noscript`,
 * an element that is `hidden`, `aria-hidden` or styled out of sight (display:none, zero size, pushed
 * off-screen, transparent) contributes nothing to the text, which is where a page hides instructions for
 * a model (`hiddenBlocks` counts them). The text is still data, never instructions: fencing (`fence.ts`)
 * is what makes it safe to show a model; this is the first line, not the only one.
 */
import { keywordMatches, normalizeArabic } from '../../utils/arabic.js';
import { collapse, tokenize, VOID_ELEMENTS, type Token } from './html.js';
import { classifySocialUrl, isLinkHubHost, whatsappFrom } from './socials.js';
import { stripInvisible, truncateChars } from './textClean.js';
import type { InfographicSocial } from '../profile/types.js';

/** Per page and in total (03 §1: "3k characters per page, 12k in total"). */
export const PAGE_TEXT_CHARS = 3_000;
export const TOTAL_TEXT_CHARS = 12_000;

export interface IconLink {
    href: string;
    rel: 'icon' | 'apple-touch-icon';
    /** The largest edge the link declares, in pixels; 0 when it declares none (or says `any`). */
    size: number;
    type: string;
}

export interface PageLink {
    href: string;
    label: string;
    /** Inside a `nav`, `header` or `footer`. */
    inNav: boolean;
}

export interface FaqItem {
    question: string;
    answer: string;
}

export interface JsonLdOrganization {
    name: string;
    url: string;
    description: string;
    /** Every logo the node names, as written (resolved against the page, https only). */
    logos: string[];
    sameAs: string[];
    email: string;
    telephone: string;
}

export interface JsonLdOffer {
    kind: 'product' | 'course' | 'service';
    name: string;
    description: string;
    url: string;
    price: string;
    currency: string;
}

export interface SiteExtract {
    url: string;
    title: string;
    description: string;
    canonical: string | null;
    /** `html[lang]`'s primary subtag, lower case. */
    lang: string | null;
    dir: 'rtl' | 'ltr' | null;
    /** What the visible text is written in, by its script. */
    textLang: 'ar' | 'en' | 'mixed' | null;
    /** Every `og:*` and `twitter:*` meta tag, by its property. NOT used for logos or colours: it is usually a photograph of a person. */
    og: Record<string, string>;
    /** The first `theme-color` that is not for a dark-scheme media query, else the first. */
    themeColor: string | null;
    icons: IconLink[];
    manifestUrl: string | null;
    stylesheets: string[];
    /** The contents of `<style>` elements, for the colour reader. */
    inlineStyles: string[];
    /** Colours written on SVG elements inline in the page (`fill`, `stop-color`). */
    svgFills: string[];
    jsonLd: { organization: JsonLdOrganization | null; person: { name: string; url: string; description: string; sameAs: string[] } | null; offers: JsonLdOffer[]; faq: FaqItem[]; invalid: number };
    socials: { links: Partial<Record<InfographicSocial, string>>; handles: Partial<Record<InfographicSocial, string>> };
    contact: { emails: string[]; phones: string[]; whatsapp: string | null };
    headings: string[];
    listItems: string[];
    /** The visible text, one line per block, at most `maxChars` characters. */
    text: string;
    links: PageLink[];
    /** Elements dropped from the text because a visitor cannot see them. */
    hiddenBlocks: number;
    hub: boolean;
}

// ─── Reading the markup ──────────────────────────────────────────────────────────────────────

const HIDDEN_CLASSES = new Set(['hidden', 'd-none', 'invisible', 'sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'hide', 'is-hidden', 'u-hidden']);

/** An element a visitor cannot see (or is not meant to): by attribute, by class or by inline style. */
export function isHiddenElement(tag: string, attrs: Record<string, string>): boolean {
    if (attrs.hidden !== undefined || attrs['aria-hidden']?.toLowerCase() === 'true') return true;
    if (tag === 'input' && attrs.type?.toLowerCase() === 'hidden') return true;
    const classes = attrs.class;
    if (classes && classes.length < 2000 && classes.toLowerCase().split(/\s+/).some((c) => HIDDEN_CLASSES.has(c))) return true;
    const raw = attrs.style;
    if (!raw || raw.length > 4000) return false;
    const style = raw.toLowerCase().replace(/\s+/g, '');
    return (
        style.includes('display:none') ||
        style.includes('visibility:hidden') ||
        style.includes('color:transparent') ||
        style.includes('clip:rect(0') ||
        style.includes('clip-path:inset(50%') ||
        /(?:^|;)opacity:0(?:\.0*)?(?:;|!|$)/.test(style) ||
        /(?:^|;)font-size:0(?![.\d])/.test(style) ||
        /(?:^|;)(?:left|right|top|bottom|text-indent|margin-left|margin-right|margin-top):-\d{3,}/.test(style) ||
        (style.includes('overflow:hidden') && /(?:^|;)(?:width|height|max-height|max-width):0(?:px)?(?:;|!|$)/.test(style))
    );
}

/** Elements whose content is never part of what a visitor reads. */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'svg', 'iframe', 'object', 'embed', 'canvas', 'select', 'datalist', 'textarea', 'audio', 'video']);
/** Boilerplate for the purpose of the voice sample (the contact scan still reads them). */
const NO_VOICE_TAGS = new Set(['nav', 'footer', 'aside', 'form']);
const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
    'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul',
]);

interface Frame {
    tag: string;
    hidden: boolean;
    skip: boolean;
    noVoice: boolean;
    nav: boolean;
    svg: boolean;
}

const MAX_STACK = 512;
const MAX_ITEMS = 40;

const stripInvisibleLine = (s: string): string => collapse(stripInvisible(s));

/** The largest `NxN` a `sizes` attribute names. */
function largestSize(sizes: string | undefined): number {
    if (!sizes) return 0;
    let best = 0;
    for (const m of sizes.toLowerCase().matchAll(/(\d{1,4})x(\d{1,4})/g)) best = Math.max(best, Math.max(Number(m[1]), Number(m[2])));
    return best;
}

/** `href` against `base`, as an http(s) address, or null (a `javascript:` link, a `data:` URI, nonsense). */
export function resolveHref(href: string | undefined, base: URL): string | null {
    if (!href) return null;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    try {
        const u = new URL(trimmed, base);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        u.hash = '';
        return u.href;
    } catch {
        return null;
    }
}

const scriptShare = (text: string): number | null => {
    let arabic = 0;
    let latin = 0;
    for (const ch of text) {
        if (/\p{Script=Arabic}/u.test(ch)) arabic++;
        else if (/\p{Script=Latin}/u.test(ch)) latin++;
    }
    return arabic + latin < 20 ? null : arabic / (arabic + latin);
};

/** What a text is written in, by its letters: mostly Arabic, mostly Latin, or both. Null for too little to say. */
export function languageOfText(text: string): 'ar' | 'en' | 'mixed' | null {
    const share = scriptShare(text);
    if (share === null) return null;
    return share >= 0.6 ? 'ar' : share <= 0.15 ? 'en' : 'mixed';
}

// ─── JSON-LD ─────────────────────────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** Plain text from a JSON-LD string, which may carry markup and entities (WordPress answers do). */
function ldText(v: unknown, max: number): string {
    if (typeof v === 'number') return String(v);
    if (typeof v !== 'string') return '';
    // Inline tags join the words around them; any other tag is a break.
    const INLINE = new Set(['a', 'b', 'i', 'em', 'strong', 'span', 'code', 'u', 'small', 'mark', 'sub', 'sup']);
    const withoutMarkup = v.includes('<') || v.includes('&') ? tokenize(v).flatMap((t) => (t.t === 'text' ? [t.text] : [INLINE.has(t.tag) ? '' : ' '])).join('') : v;
    return truncateChars(stripInvisibleLine(withoutMarkup), max);
}

function ldUrl(v: unknown, base: URL): string {
    if (isObj(v)) return ldUrl(v.url ?? v.contentUrl ?? v['@id'], base);
    return typeof v === 'string' ? (resolveHref(v, base) ?? '') : '';
}

const typeNames = (node: Loose): string[] =>
    asArray(node['@type']).flatMap((t) => (typeof t === 'string' ? [t.replace(/^.*[/:#]/, '')] : []));

const ORG_TYPE = /^(?:Organization|Corporation|NGO|OnlineBusiness|OnlineStore|Store|LocalBusiness|EducationalOrganization|ProfessionalService|[A-Za-z]*Business|[A-Za-z]*Store|[A-Za-z]*School|[A-Za-z]*Organization)$/;

function parseJsonLdBlock(text: string): unknown {
    const clean = text.replace(/^\uFEFF/, '').replace(/^\s*(?:<!--|<!\[CDATA\[)/, '').replace(/(?:-->|\]\]>)\s*$/, '').trim();
    try {
        return JSON.parse(clean);
    } catch {
        // WordPress plugins print a literal line break inside a string now and then; one retry with those as spaces.
        try {
            return JSON.parse(clean.replace(/[\u0000-\u001F]+/g, ' '));
        } catch {
            return undefined;
        }
    }
}

/** Every node in the JSON-LD that has an `@type`, in document order, however deeply a `@graph` or a property nests them. */
function ldNodes(root: unknown): Loose[] {
    const found: Loose[] = [];
    const visit = (v: unknown, depth: number): void => {
        if (found.length >= 500 || depth > 6) return;
        if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
        if (!isObj(v)) return;
        if (v['@type'] !== undefined) found.push(v);
        for (const value of Object.values(v)) if (typeof value === 'object' && value !== null) visit(value, depth + 1);
    };
    visit(root, 0);
    return found;
}

function readJsonLd(texts: string[], base: URL): SiteExtract['jsonLd'] {
    const out: SiteExtract['jsonLd'] = { organization: null, person: null, offers: [], faq: [], invalid: 0 };
    const orgs: JsonLdOrganization[] = [];
    const people: NonNullable<SiteExtract['jsonLd']['person']>[] = [];
    const seenOffers = new Set<string>();
    for (const text of texts) {
        const parsed = parseJsonLdBlock(text);
        if (parsed === undefined) {
            out.invalid++;
            continue;
        }
        for (const node of ldNodes(parsed)) {
            const types = typeNames(node);
            const sameAs = asArray(node.sameAs).flatMap((s) => (typeof s === 'string' ? [resolveHref(s, base)] : [])).filter((s): s is string => s !== null).slice(0, 20);
            if (types.some((t) => ORG_TYPE.test(t))) {
                const contact = isObj(node.contactPoint) ? node.contactPoint : asArray(node.contactPoint).find(isObj);
                orgs.push({
                    name: ldText(node.name, 120),
                    url: ldUrl(node.url, base),
                    description: ldText(node.description, 600),
                    logos: asArray(node.logo).map((l) => ldUrl(l, base)).filter(Boolean).slice(0, 5),
                    sameAs,
                    email: ldText(node.email ?? (isObj(contact) ? contact.email : ''), 120),
                    telephone: ldText(node.telephone ?? (isObj(contact) ? contact.telephone : ''), 40),
                });
            }
            if (types.includes('Person')) {
                people.push({ name: ldText(node.name, 120), url: ldUrl(node.url, base), description: ldText(node.description ?? node.jobTitle, 600), sameAs });
            }
            const kind = types.includes('Course') ? 'course' : types.includes('Product') || types.includes('ProductGroup') ? 'product' : types.includes('Service') ? 'service' : null;
            if (kind && out.offers.length < 10) {
                const name = ldText(node.name, 200);
                const offer = asArray(node.offers).find(isObj) ?? (types.includes('Offer') ? node : undefined);
                const price = isObj(offer) ? ldText(offer.price ?? offer.lowPrice, 40) : '';
                const key = name.toLowerCase();
                if (name && !seenOffers.has(key)) {
                    seenOffers.add(key);
                    out.offers.push({
                        kind,
                        name,
                        description: ldText(node.description, 400),
                        url: ldUrl(node.url ?? (isObj(offer) ? offer.url : undefined), base),
                        price,
                        currency: isObj(offer) ? ldText(offer.priceCurrency, 8) : '',
                    });
                }
            }
            if (types.includes('Question') && out.faq.length < 20) {
                const answer = isObj(node.acceptedAnswer) ? ldText(node.acceptedAnswer.text, 1000) : '';
                const question = ldText(node.name, 300);
                if (question && answer) out.faq.push({ question, answer });
            }
        }
    }
    // The first organisation that names itself, with what the later ones add to it.
    const named = orgs.filter((o) => o.name);
    if (named.length > 0) {
        const merged = { ...named[0]! };
        for (const o of named.slice(1)) {
            (['url', 'description', 'email', 'telephone'] as const).forEach((k) => {
                if (!merged[k]) merged[k] = o[k];
            });
            merged.logos = [...new Set([...merged.logos, ...o.logos])].slice(0, 5);
            merged.sameAs = [...new Set([...merged.sameAs, ...o.sameAs])].slice(0, 20);
        }
        out.organization = merged;
    }
    out.person = people.find((p) => p.name) ?? null;
    return out;
}

// ─── Contact ─────────────────────────────────────────────────────────────────────────────────

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/g;
const NOT_AN_EMAIL_TLD = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'ico', 'woff', 'woff2']);
const PLACEHOLDER_EMAIL = /@(?:example\.(?:com|org|net)|domain\.com|email\.com|yourdomain\.com|sentry\.io|wixpress\.com)$/i;
// A number that STARTS here: `00` in the middle of 1000 2000 is not an international prefix.
const PHONE = /(?<!\d)(?:\+|00)\d[\d\s().-]{7,17}\d(?!\d)/g;

function emailsIn(text: string): string[] {
    const found: string[] = [];
    for (const m of text.matchAll(EMAIL)) {
        const email = m[0].replace(/[.]+$/, '');
        const tld = email.slice(email.lastIndexOf('.') + 1).toLowerCase();
        if (NOT_AN_EMAIL_TLD.has(tld) || PLACEHOLDER_EMAIL.test(email)) continue;
        found.push(email);
    }
    return found;
}

const digitsOnly = (s: string): string => s.replace(/\D/g, '');

// ─── The pass ────────────────────────────────────────────────────────────────────────────────

export interface ExtractOptions {
    /** The visible text is cut to this many characters. Default 3000. */
    maxChars?: number;
}

/** Reads a page. `pageUrl` is where it came from: the base for every relative address in it. */
export function extractSite(html: string, pageUrl: string, opts: ExtractOptions = {}): SiteExtract {
    let base: URL;
    try {
        base = new URL(pageUrl);
    } catch {
        base = new URL('https://invalid.invalid/');
    }
    const tokens: Token[] = tokenize(html);
    const maxChars = opts.maxChars ?? PAGE_TEXT_CHARS;

    const meta: Record<string, string> = {};
    const og: Record<string, string> = {};
    const themeColors: Array<{ content: string; media: string }> = [];
    const icons: IconLink[] = [];
    const stylesheets: string[] = [];
    const inlineStyles: string[] = [];
    const svgFills: string[] = [];
    const jsonLdTexts: string[] = [];
    const headings: string[] = [];
    const listItems: string[] = [];
    const links: PageLink[] = [];
    const lines: string[] = [];
    const allText: string[] = [];
    const hrefs: string[] = [];
    let title = '';
    let canonical: string | null = null;
    let manifestUrl: string | null = null;
    let lang: string | null = null;
    let dir: 'rtl' | 'ltr' | null = null;
    let hiddenBlocks = 0;
    let line = '';

    const stack: Frame[] = [];
    const top = (): Frame | undefined => stack[stack.length - 1];
    let pending: 'title' | 'jsonld' | 'style' | null = null;
    let heading: { tag: string; text: string } | null = null;
    let item: { text: string } | null = null;
    let anchor: { href: string; text: string; inNav: boolean } | null = null;
    let baseHref: URL = base;

    const flushLine = () => {
        const text = stripInvisibleLine(line);
        line = '';
        if (text.length >= 2) lines.push(text);
    };
    const finishAnchor = () => {
        if (!anchor) return;
        const label = truncateChars(stripInvisibleLine(anchor.text), 120);
        if (links.length < 300) links.push({ href: anchor.href, label, inNav: anchor.inNav });
        anchor = null;
    };

    for (const token of tokens) {
        if (token.t === 'text') {
            if (pending === 'title') {
                if (!title) title = truncateChars(stripInvisibleLine(token.text), 200);
            } else if (pending === 'jsonld') {
                if (jsonLdTexts.length < 10) jsonLdTexts.push(token.text.slice(0, 200_000));
            } else if (pending === 'style') {
                if (inlineStyles.length < 5) inlineStyles.push(token.text.slice(0, 200_000));
            }
            pending = null;
            const frame = top();
            if (frame && (frame.hidden || frame.skip)) continue;
            const text = token.text;
            if (!text.trim()) {
                if (!frame?.noVoice) line += ' ';
                continue;
            }
            allText.push(text);
            if (heading) heading.text += text;
            if (item) item.text += text;
            if (anchor) anchor.text += text;
            if (!frame?.noVoice) line += text;
            continue;
        }

        if (token.t === 'close') {
            const tag = token.tag;
            let at = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i]!.tag === tag) {
                    at = i;
                    break;
                }
            }
            if (at >= 0) stack.length = at;
            if (tag === 'a') finishAnchor();
            if (heading && heading.tag === tag) {
                const text = truncateChars(stripInvisibleLine(heading.text), 200);
                if (text && headings.length < MAX_ITEMS) headings.push(text);
                heading = null;
            }
            if (tag === 'li' && item) {
                const text = truncateChars(stripInvisibleLine(item.text), 200);
                if (text.length >= 3 && listItems.length < MAX_ITEMS) listItems.push(text);
                item = null;
            }
            if (BLOCK_TAGS.has(tag)) flushLine();
            pending = null;
            continue;
        }

        // An open tag.
        const { tag, attrs } = token;
        // `</head>` may be left out; the body starting is what ends the head.
        if (tag === 'body') {
            const head = stack.findIndex((f) => f.tag === 'head');
            if (head >= 0) stack.length = head;
        }
        const parent = top();
        const hiddenHere = isHiddenElement(tag, attrs);
        if (hiddenHere && !parent?.hidden) hiddenBlocks++;
        const inSvg = parent?.svg === true || tag === 'svg';
        if (inSvg) {
            // The colours written on inline SVG are a source for the brand colour (03 §3.4).
            for (const key of ['fill', 'stop-color'] as const) {
                const value = attrs[key];
                if (value && svgFills.length < 200 && /^(?:#|rgb|hsl)/i.test(value.trim())) svgFills.push(value.trim());
            }
        }
        if (tag === 'html') {
            const l = attrs.lang?.trim().toLowerCase().split(/[-_]/)[0];
            if (l && /^[a-z]{2,3}$/.test(l)) lang = l;
            const d = attrs.dir?.trim().toLowerCase();
            if (d === 'rtl' || d === 'ltr') dir = d;
        } else if (tag === 'body' && dir === null) {
            const d = attrs.dir?.trim().toLowerCase();
            if (d === 'rtl' || d === 'ltr') dir = d;
        } else if (tag === 'base') {
            const resolved = resolveHref(attrs.href, base);
            if (resolved) baseHref = new URL(resolved);
        } else if (tag === 'meta') {
            const key = (attrs.property ?? attrs.name ?? attrs['http-equiv'] ?? '').trim().toLowerCase();
            const content = attrs.content;
            if (key && content !== undefined) {
                const value = truncateChars(stripInvisibleLine(content), 600);
                if (key === 'theme-color') {
                    if (themeColors.length < 4) themeColors.push({ content: value, media: (attrs.media ?? '').toLowerCase() });
                } else if (key.startsWith('og:') || key.startsWith('twitter:')) {
                    if (!(key in og)) og[key] = value;
                } else if (!(key in meta)) meta[key] = value;
            }
        } else if (tag === 'link') {
            const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean);
            const href = resolveHref(attrs.href, baseHref);
            if (href) {
                if (rel.includes('canonical') && !canonical) canonical = href;
                else if (rel.includes('manifest') && !manifestUrl) manifestUrl = href;
                else if (rel.includes('stylesheet') && !/\bprint\b/i.test(attrs.media ?? '')) {
                    if (stylesheets.length < 20) stylesheets.push(href);
                } else if (rel.some((r) => r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed')) {
                    icons.push({ href, rel: 'apple-touch-icon', size: largestSize(attrs.sizes) || 180, type: (attrs.type ?? '').toLowerCase() });
                } else if (rel.includes('icon')) {
                    icons.push({ href, rel: 'icon', size: largestSize(attrs.sizes), type: (attrs.type ?? '').toLowerCase() });
                }
            }
        } else if (tag === 'title' && !parent?.svg) {
            pending = 'title';
        } else if (tag === 'script' && /ld\+json/i.test(attrs.type ?? '')) {
            pending = 'jsonld';
        } else if (tag === 'style') {
            pending = 'style';
        }

        if (tag === 'a') {
            finishAnchor();
            const href = resolveHref(attrs.href, baseHref);
            const raw = attrs.href?.trim() ?? '';
            // mailto:, tel: and whatsapp: are not web addresses, but they are contact details.
            if (/^(?:mailto:|tel:|whatsapp:)/i.test(raw) && hrefs.length < 100) hrefs.push(raw);
            if (href) {
                if (hrefs.length < 300) hrefs.push(href);
                if (!parent?.hidden && !hiddenHere) anchor = { href, text: '', inNav: false };
            }
        }

        if (VOID_ELEMENTS.has(tag) || token.selfClosing) {
            if (BLOCK_TAGS.has(tag)) flushLine();
            continue;
        }

        const frame: Frame = {
            tag,
            hidden: (parent?.hidden ?? false) || hiddenHere,
            skip: (parent?.skip ?? false) || SKIP_TAGS.has(tag),
            noVoice: (parent?.noVoice ?? false) || NO_VOICE_TAGS.has(tag),
            nav: (parent?.nav ?? false) || tag === 'nav' || tag === 'header' || tag === 'footer' || attrs.role?.toLowerCase() === 'navigation',
            svg: inSvg,
        };
        if (stack.length < MAX_STACK) stack.push(frame);
        if (anchor && tag === 'a') anchor.inNav = frame.nav;

        if (/^h[1-3]$/.test(tag) && !frame.hidden && !frame.skip) heading = { tag, text: '' };
        if (tag === 'li' && !frame.hidden && !frame.skip) item = { text: '' };
        if (BLOCK_TAGS.has(tag)) flushLine();
    }
    flushLine();
    finishAnchor();

    // Text: one line per block, repeated lines (menus that repeat in a footer) once, cut at a line boundary.
    const seen = new Set<string>();
    const kept: string[] = [];
    let used = 0;
    for (const l of lines) {
        if (seen.has(l)) continue;
        seen.add(l);
        const remaining = maxChars - used;
        if (remaining <= 0) break;
        const piece = truncateChars(l, remaining);
        kept.push(piece);
        used += Array.from(piece).length + 1;
    }
    const text = kept.join('\n');

    const jsonLd = readJsonLd(jsonLdTexts, base);

    // Social links: what the page's own JSON-LD says first, then the page's links.
    const socials: SiteExtract['socials'] = { links: {}, handles: {} };
    let whatsapp: string | null = null;
    const candidates = [...(jsonLd.organization?.sameAs ?? []), ...(jsonLd.person?.sameAs ?? []), ...hrefs];
    for (const href of candidates) {
        const social = classifySocialUrl(href);
        if (social && !(social.platform in socials.links)) {
            socials.links[social.platform] = social.url;
            socials.handles[social.platform] = social.handle;
        }
        if (!whatsapp) whatsapp = whatsappFrom(href);
    }

    // Contact: the page's own mailto: and tel: links first, then the visible text.
    const emails: string[] = [];
    const phones: string[] = [];
    const addEmail = (e: string) => {
        if (emails.length < 3 && !emails.some((x) => x.toLowerCase() === e.toLowerCase())) emails.push(e);
    };
    const addPhone = (p: string) => {
        const stripped = p.replace(/[^\d+]/g, '');
        // 00966... and +966... are the same number.
        const cleaned = stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;
        const d = digitsOnly(cleaned);
        if (d.length >= 8 && d.length <= 15 && phones.length < 3 && !phones.some((x) => digitsOnly(x) === d)) phones.push(cleaned);
    };
    for (const raw of hrefs) {
        if (/^mailto:/i.test(raw)) emailsIn(decodeURIComponentSafe(raw.slice(7).split('?')[0]!)).forEach(addEmail);
        else if (/^tel:/i.test(raw)) addPhone(decodeURIComponentSafe(raw.slice(4)));
    }
    const joined = allText.join(' ').slice(0, 300_000);
    emailsIn(joined).forEach(addEmail);
    for (const m of joined.matchAll(PHONE)) addPhone(m[0]);
    if (jsonLd.organization?.email) emailsIn(jsonLd.organization.email).forEach(addEmail);
    if (jsonLd.organization?.telephone) addPhone(jsonLd.organization.telephone);

    const themeColor = (themeColors.find((c) => !c.media.includes('dark')) ?? themeColors[0])?.content ?? null;

    return {
        url: base.href,
        title,
        description: meta.description ?? og['og:description'] ?? '',
        canonical,
        lang,
        dir,
        textLang: languageOfText(text),
        og,
        themeColor: themeColor || null,
        icons,
        manifestUrl,
        stylesheets,
        inlineStyles,
        svgFills,
        jsonLd,
        socials,
        contact: { emails, phones, whatsapp },
        headings,
        listItems,
        text,
        links,
        hiddenBlocks,
        hub: isLinkHubHost(base.hostname),
    };
}

function decodeURIComponentSafe(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

// ─── What to fetch next ──────────────────────────────────────────────────────────────────────

const sameSite = (a: URL, b: URL): boolean => a.hostname.toLowerCase().replace(/^www\./, '') === b.hostname.toLowerCase().replace(/^www\./, '');

/**
 * Pages worth reading, in the order they are worth it (03 §1: about, contact, faq, pricing, courses, services,
 * shop, in English and Arabic). Arabic goes through `normalizeArabic`, as the keyword matcher does, so أ and ا,
 * ة and ه are the same letter; every keyword is matched as a whole word, so `/workshops` is not `shop`.
 */
const PAGE_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = (
    [
        ['about', ['about', 'about us', 'من نحن', 'عن', 'نبذة', 'قصتنا', 'قصتي', 'عني']],
        ['faq', ['faq', 'faqs', 'questions', 'الأسئلة', 'أسئلة', 'الاستفسارات']],
        ['pricing', ['pricing', 'prices', 'plans', 'الأسعار', 'الباقات', 'الاشتراك']],
        ['courses', ['courses', 'course', 'programs', 'classes', 'academy', 'الدورات', 'الكورسات', 'البرامج', 'الأكاديمية']],
        ['services', ['services', 'solutions', 'الخدمات', 'خدماتنا']],
        ['shop', ['shop', 'store', 'products', 'المتجر', 'المنتجات', 'تسوق']],
        ['contact', ['contact', 'contact us', 'تواصل', 'تواصلوا', 'اتصل', 'اتصلوا']],
    ] as const
).map(([name, words]) => [name, words.map((w) => normalizeArabic(w))] as const);
const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|pptx?)(?:$|\?)/i;

/**
 * Up to `max` same-site pages that are likely to say who the creator is and what they sell, from the
 * page's links (those in the navigation first). The path or the label has to match one of the page names.
 */
export function navCandidates(site: SiteExtract, max = 4): PageLink[] {
    let origin: URL;
    try {
        origin = new URL(site.url);
    } catch {
        return [];
    }
    const scored: Array<{ link: PageLink; rank: number; order: number }> = [];
    const seen = new Set<string>([origin.pathname.replace(/\/+$/, '') || '/']);
    site.links.forEach((link, order) => {
        let u: URL;
        try {
            u = new URL(link.href);
        } catch {
            return;
        }
        if (!sameSite(u, origin) || NOT_A_PAGE.test(u.pathname)) return;
        const path = u.pathname.replace(/\/+$/, '') || '/';
        if (seen.has(path)) return;
        const haystack = normalizeArabic(`${decodeURIComponentSafe(path)} ${link.label}`);
        const rank = PAGE_KEYWORDS.findIndex(([, words]) => words.some((w) => keywordMatches(haystack, w, 'word')));
        if (rank < 0) return;
        seen.add(path);
        scored.push({ link, rank, order });
    });
    return scored
        .sort((a, b) => Number(b.link.inNav) - Number(a.link.inNav) || a.rank - b.rank || a.order - b.order)
        .slice(0, max)
        .map((s) => s.link);
}

/**
 * On a link-in-bio hub the page is a list of where the person sends people: every outbound link that is not
 * a social profile, a mailto or a WhatsApp number is an offer candidate. At most `max` are returned; the
 * caller follows at most two (03 §1).
 */
export function hubCandidates(site: SiteExtract, max = 12): PageLink[] {
    let origin: URL;
    try {
        origin = new URL(site.url);
    } catch {
        return [];
    }
    const out: PageLink[] = [];
    const seen = new Set<string>();
    for (const link of site.links) {
        let u: URL;
        try {
            u = new URL(link.href);
        } catch {
            continue;
        }
        if (sameSite(u, origin) || classifySocialUrl(link.href) || whatsappFrom(link.href) || isLinkHubHost(u.hostname)) continue;
        const key = `${u.hostname}${u.pathname}`.replace(/\/+$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(link);
        if (out.length >= max) break;
    }
    return out;
}

/** Stylesheets that say something about THIS site: its own, before a framework's from a CDN (a stock Bootstrap blue is not a brand). */
const FRAMEWORK_CSS = /(?:bootstrap|font-?awesome|fonts\.googleapis|fonts\.bunny|animate|normalize|reset|cookie|jquery|swiper|slick|aos|owl|select2|datatables|flatpickr|toastr|sweetalert|leaflet|fancybox|lightbox|magnific)/i;

export function pickStylesheets(site: SiteExtract, max = 2): string[] {
    let origin: URL;
    try {
        origin = new URL(site.url);
    } catch {
        return [];
    }
    const rank = (href: string): number => {
        try {
            const u = new URL(href);
            if (FRAMEWORK_CSS.test(u.href)) return 2;
            return sameSite(u, origin) ? 0 : 1;
        } catch {
            return 3;
        }
    };
    return site.stylesheets
        .map((href, order) => ({ href, order, rank: rank(href) }))
        .filter((s) => s.rank < 2)
        .sort((a, b) => a.rank - b.rank || a.order - b.order)
        .slice(0, max)
        .map((s) => s.href);
}

/** Per-page text (each already at most 3000 characters) cut again to the total budget, page by page, in order. */
export function capSiteTexts(pages: ReadonlyArray<{ url: string; text: string }>, caps: { perPage?: number; total?: number } = {}): Array<{ url: string; text: string }> {
    const perPage = caps.perPage ?? PAGE_TEXT_CHARS;
    const total = caps.total ?? TOTAL_TEXT_CHARS;
    const out: Array<{ url: string; text: string }> = [];
    let used = 0;
    for (const page of pages) {
        const remaining = total - used;
        if (remaining <= 0) break;
        const text = truncateChars(page.text, Math.min(perPage, remaining));
        if (!text.trim()) continue;
        out.push({ url: page.url, text });
        used += Array.from(text).length;
    }
    return out;
}
