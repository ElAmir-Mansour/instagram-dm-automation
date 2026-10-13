/**
 * Gathering a creator's website (docs/onboarding/03 §1, "Website"): the one place `safeFetch`, the extractor
 * and the brand reader are put together. It fetches `/robots.txt` and the home page, up to four pages the
 * navigation points at (or, on a link-in-bio hub, up to two of its outbound links), the manifest, up to two
 * stylesheets and any SVG logos for their colours, and returns what was read, what could not be and why.
 *
 * Every request goes through `safeFetch` (so every SSRF rule applies to every hop), under one phase deadline
 * (25 s), and robots.txt is honoured: pages on the site's own origin are checked against its rules, and the
 * hub's outbound pages against their own host's (one extra request per host). Sub-resources on another
 * origin (a CDN's stylesheet) are not checked: they have no robots.txt of their own that means anything.
 *
 * Nothing here writes anything or reads the database, and it never throws for a site that misbehaves: a site
 * that refuses (a 403 from a firewall) is a `needsPaste`, which the wizard turns into "paste your About
 * text" (03 §1.8), and the rest is in `notes`.
 */
import { brandColours, inkAndPaper, logoCandidates, parseManifest, type BrandColours, type Logos, type Manifest } from './brand.js';
import { validateFetchUrl } from './netGuard.js';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type Robots } from './robots.js';
import { isSafeFetchError, phaseSignal, safeFetch, siteUrlCandidates, type SafeFetchOptions, type SafeFetchResponse } from './safeFetch.js';
import { capSiteTexts, extractSite, hubCandidates, navCandidates, pickStylesheets, type FaqItem, type JsonLdOffer, type SiteExtract } from './siteExtract.js';
import type { InfographicSocial } from '../profile/types.js';

/** At most this many pages beyond the home page (03 §1), and, on a hub, this many outbound links. */
export const MAX_NAV_PAGES = 4;
export const MAX_HUB_PAGES = 2;
export const MAX_STYLESHEETS = 2;

export interface FetchNote {
    url: string;
    kind: 'robots' | 'page' | 'manifest' | 'css' | 'svg';
    ok: boolean;
    /** The `SafeFetchError.kind` when it failed, or `robots` when robots.txt said no. */
    error?: string;
    status?: number;
}

export type WebsiteStatus = 'ok' | 'blocked' | 'robots' | 'unreachable';

export interface GatheredPage {
    url: string;
    role: 'home' | 'nav' | 'hub';
    extract: SiteExtract;
}

export interface Website {
    status: WebsiteStatus;
    /** The site refused to be read (401 or 403): ask for the About text instead. */
    needsPaste: boolean;
    pages: GatheredPage[];
    /** Each page's visible text, within 3000 characters a page and 12000 in all. */
    texts: Array<{ url: string; text: string }>;
    manifest: Manifest | null;
    brand: BrandColours & { ink: string; paper: string };
    logos: Logos;
    /** Everything the pages together say (first page wins). */
    merged: MergedSite;
    notes: FetchNote[];
}

export interface MergedSite {
    title: string;
    description: string;
    lang: string | null;
    dir: 'rtl' | 'ltr' | null;
    organization: SiteExtract['jsonLd']['organization'];
    person: SiteExtract['jsonLd']['person'];
    offers: JsonLdOffer[];
    faq: FaqItem[];
    socials: Partial<Record<InfographicSocial, string>>;
    handles: Partial<Record<InfographicSocial, string>>;
    emails: string[];
    phones: string[];
    whatsapp: string | null;
}

export interface GatherOptions {
    signal?: AbortSignal;
    userAgent?: string;
    theme?: 'dark' | 'light';
    /** The DNS lookup and the socket, for tests. */
    resolve?: SafeFetchOptions['resolve'];
    transport?: SafeFetchOptions['transport'];
}

/** What the pages say together: the first page to say something wins, and lists are joined without repeats. */
export function mergeSites(extracts: readonly SiteExtract[]): MergedSite {
    const merged: MergedSite = {
        title: '', description: '', lang: null, dir: null, organization: null, person: null, offers: [], faq: [], socials: {}, handles: {}, emails: [], phones: [], whatsapp: null,
    };
    const offers = new Set<string>();
    const questions = new Set<string>();
    for (const e of extracts) {
        merged.title ||= e.title;
        merged.description ||= e.description;
        merged.lang ??= e.lang;
        merged.dir ??= e.dir;
        merged.organization ??= e.jsonLd.organization;
        merged.person ??= e.jsonLd.person;
        for (const o of e.jsonLd.offers) {
            if (offers.has(o.name.toLowerCase()) || merged.offers.length >= 10) continue;
            offers.add(o.name.toLowerCase());
            merged.offers.push(o);
        }
        for (const f of e.jsonLd.faq) {
            if (questions.has(f.question.toLowerCase()) || merged.faq.length >= 20) continue;
            questions.add(f.question.toLowerCase());
            merged.faq.push(f);
        }
        for (const [platform, url] of Object.entries(e.socials.links) as Array<[InfographicSocial, string]>) {
            if (!(platform in merged.socials)) {
                merged.socials[platform] = url;
                merged.handles[platform] = e.socials.handles[platform];
            }
        }
        for (const email of e.contact.emails) if (!merged.emails.includes(email) && merged.emails.length < 3) merged.emails.push(email);
        for (const phone of e.contact.phones) if (!merged.phones.includes(phone) && merged.phones.length < 3) merged.phones.push(phone);
        merged.whatsapp ??= e.contact.whatsapp;
    }
    return merged;
}

/**
 * Reads a typed site. `input` is what the tenant typed: a bare domain, or an address. https is tried first.
 */
export async function gatherWebsite(input: string, opts: GatherOptions = {}): Promise<Website> {
    const signal = opts.signal ?? phaseSignal();
    const base: Omit<SafeFetchOptions, 'kind'> = { signal, userAgent: opts.userAgent, resolve: opts.resolve, transport: opts.transport };
    const notes: FetchNote[] = [];
    let blockedPage = false;
    const note = (url: string, kind: FetchNote['kind'], ok: boolean, error?: string, status?: number) => notes.push({ url, kind, ok, ...(error ? { error } : {}), ...(status ? { status } : {}) });

    const get = async (url: string, kind: SafeFetchOptions['kind'], noteKind: FetchNote['kind']): Promise<SafeFetchResponse | null> => {
        try {
            const response = await safeFetch(url, { ...base, kind });
            note(response.url, noteKind, true, undefined, response.status);
            return response;
        } catch (err) {
            note(url, noteKind, false, isSafeFetchError(err) ? err.kind : 'network', isSafeFetchError(err) ? err.status : undefined);
            if (isSafeFetchError(err) && err.kind === 'forbidden' && noteKind === 'page') blockedPage = true;
            return null;
        }
    };

    const result = (status: WebsiteStatus, pages: GatheredPage[], manifest: Manifest | null, css: string[], svg: string[], logos: Logos): Website => {
        const extracts = pages.map((p) => p.extract);
        const home = extracts[0];
        const brand = brandColours({
            themeColor: home?.themeColor,
            manifestThemeColor: manifest?.themeColor,
            css: [...extracts.flatMap((e) => e.inlineStyles), ...css],
            svg: [...extracts.flatMap((e) => e.svgFills.map((f) => `fill="${f}"`)), ...svg],
        });
        return {
            status,
            needsPaste: blockedPage,
            pages,
            texts: capSiteTexts(pages.map((p) => ({ url: p.url, text: p.extract.text }))),
            manifest,
            brand: { ...brand, ...inkAndPaper(brand.primary, opts.theme ?? 'light') },
            logos,
            merged: mergeSites(extracts),
            notes,
        };
    };
    const empty: Logos = { candidates: [], svg: [] };

    // 1. Which scheme answers, and what its robots.txt says. https first; http only if https is not there at all.
    const robotsByOrigin = new Map<string, { robots: Robots; reached: boolean }>();
    const robotsOf = async (origin: string): Promise<{ robots: Robots; reached: boolean }> => {
        const known = robotsByOrigin.get(origin);
        if (known) return known;
        let outcome: { robots: Robots; reached: boolean };
        try {
            const response = await safeFetch(`${origin}/robots.txt`, { ...base, kind: 'text' });
            note(response.url, 'robots', true, undefined, response.status);
            outcome = { robots: parseRobots(response.text), reached: true };
        } catch (err) {
            const kind = isSafeFetchError(err) ? err.kind : 'network';
            const status = isSafeFetchError(err) ? err.status : undefined;
            note(`${origin}/robots.txt`, 'robots', false, kind, status);
            // The server answered (a 404, a refusal, an HTML page where the file should be): no rules. It did not answer
            // properly (an error, or nothing at all): RFC 9309 says to assume everything is closed.
            const answered = status !== undefined && status < 500;
            outcome = { robots: answered ? ALLOW_ALL : DISALLOW_ALL, reached: status !== undefined };
        }
        robotsByOrigin.set(origin, outcome);
        return outcome;
    };

    let homeUrl: URL | null = null;
    let homeRobots: Robots = ALLOW_ALL;
    for (const candidate of siteUrlCandidates(input)) {
        // What was typed is judged as typed: `new URL(...).origin` would quietly drop a password or a port.
        const verdict = validateFetchUrl(candidate);
        if (!verdict.ok) {
            note(candidate, 'page', false, verdict.reason === 'invalid' || verdict.reason === 'too_long' ? 'invalid_url' : 'blocked_url');
            continue;
        }
        const u = verdict.url;
        const { robots, reached } = await robotsOf(u.origin);
        if (!reached) continue;
        homeUrl = u;
        homeRobots = robots;
        break;
    }
    if (!homeUrl) return result('unreachable', [], null, [], [], empty);
    if (!homeRobots.allows(`${homeUrl.pathname}${homeUrl.search}`)) {
        note(homeUrl.href, 'page', false, 'robots');
        return result('robots', [], null, [], [], empty);
    }

    // 2. The home page.
    const homeResponse = await get(homeUrl.href, 'html', 'page');
    if (!homeResponse) return result(blockedPage ? 'blocked' : 'unreachable', [], null, [], [], empty);
    const home = extractSite(homeResponse.text, homeResponse.url);
    const pages: GatheredPage[] = [{ url: homeResponse.url, role: 'home', extract: home }];

    // 3. The pages that say the most: the navigation's, or a hub's outbound links.
    const finalOrigin = new URL(homeResponse.url).origin;
    const targets = (home.hub ? hubCandidates(home, MAX_HUB_PAGES) : navCandidates(home, MAX_NAV_PAGES)).map((l) => l.href);
    const followed = await Promise.all(
        targets.map(async (href): Promise<GatheredPage | null> => {
            let u: URL;
            try {
                u = new URL(href);
            } catch {
                return null;
            }
            const { robots, reached } = await robotsOf(u.origin);
            if (!reached || !robots.allows(`${u.pathname}${u.search}`)) {
                note(href, 'page', false, reached ? 'robots' : 'unreachable');
                return null;
            }
            const response = await get(href, 'html', 'page');
            return response ? { url: response.url, role: home.hub ? 'hub' : 'nav', extract: extractSite(response.text, response.url) } : null;
        }),
    );
    for (const page of followed) if (page) pages.push(page);

    // 4. The manifest, the stylesheets and the SVG logos: for colours and for the logo's address.
    const sameOriginAllowed = async (url: string): Promise<boolean> => {
        try {
            const u = new URL(url);
            if (u.origin !== finalOrigin) return true;
            return (await robotsOf(u.origin)).robots.allows(`${u.pathname}${u.search}`);
        } catch {
            return false;
        }
    };
    let manifest: Manifest | null = null;
    if (home.manifestUrl && (await sameOriginAllowed(home.manifestUrl))) {
        const response = await get(home.manifestUrl, 'json', 'manifest');
        if (response) manifest = parseManifest(response.text, response.url);
    }
    const sheets = pickStylesheets(home, MAX_STYLESHEETS);
    const cssTexts = (
        await Promise.all(sheets.map(async (href) => ((await sameOriginAllowed(href)) ? (await get(href, 'css', 'css'))?.text ?? '' : '')))
    ).filter(Boolean);
    const logos = logoCandidates(home, manifest);
    const svgTexts = (
        await Promise.all(logos.svg.slice(0, 2).map(async (logo) => ((await sameOriginAllowed(logo.url)) ? (await get(logo.url, 'image', 'svg'))?.text ?? '' : '')))
    ).filter(Boolean);

    return result('ok', pages, manifest, cssTexts, svgTexts, logos);
}
