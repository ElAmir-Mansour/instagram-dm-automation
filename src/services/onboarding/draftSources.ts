/**
 * The fetch phase of a draft (docs/onboarding/03 §1, "Sources and exact calls"): the four things a tenant can give, read in
 * parallel under one 25-second deadline, and what code finds out from them. Not pure: it talks to Meta, Google, the tenant's
 * website and the database. The pieces it puts together are each pure or each have their own file (`igDiscovery`, `ytSource`,
 * `website`, `igMap`, `ytMap`); what is here is the plan, the failure policy and the shape of what is kept.
 *
 *   Instagram   Business Discovery by handle, as the platform's own account (the tenant need not be connected), or the tenant's own
 *               token once it is. A failure that says the road is closed (`no_access`, `not_configured`) falls back to the other.
 *   Website     `gatherWebsite`: robots.txt, the home page, up to four pages its navigation names, the manifest, stylesheets.
 *   YouTube     the typed channel, by the platform's API key; or the tenant's own connection, which costs no extra quota.
 *   Typed       text the tenant pasted ("paste your About text" when the site refuses).
 *
 * A source that fails is one line of `sources_status` and the others still land: an Instagram `not_found` beside a readable
 * website still drafts. The draft only fails here when NOTHING could be read (`decideAfterFetch`).
 *
 * What is kept is the FACTS the model will be shown (the prepared sources and the signals) and the facts code found and the model
 * must never write: colours, the logo candidates, the social links, the follower counts. Not an image, ever: a logo candidate is an
 * address, and the profile picture is never asked for.
 */
import { describeError, log } from '../../utils/log.js';
import { queryRows } from '../../db/query.js';
import { getTenant } from '../tenant.js';
import { getAccessToken, getConnection as getYouTubeConnection, YouTubeNotConnectedError } from '../youtubeConnections.js';
import { getMyChannel } from '../youtube.js';
import { resolveDiscoveryAccount, type DiscoveryAccount } from './discoveryAccount.js';
import { computeSignals, type SampleCandidate } from './draftSignals.js';
import { FETCH_PHASE_MS } from './draftStep.js';
import type { DraftInputs } from './draftInputs.js';
import type { DraftFacts, FetchedBundle, SourceReport, SourceState, SourcesStatus } from './draftTypes.js';
import { prepareSources, type DraftSource } from './fence.js';
import { fetchBusinessDiscovery, fetchOwnInstagram, type GraphCredentials } from './igDiscovery.js';
import { instagramSources, type IgProfile } from './igMap.js';
import { scrubSecrets, sourceOk, type SourceError, type SourceResult } from './sourceError.js';
import { gatherWebsite, type GatheredPage, type Website } from './website.js';
import { fetchYouTubeChannel } from './ytSource.js';
import { classifyYouTubeFailure, fromMyChannel, youtubeFailureOf, youtubeSources, type YouTubeChannelData } from './ytMap.js';

// ─── What is kept ───────────────────────────────────────────────────────────────────────────
// The shapes are in `draftTypes.ts` (SourceReport, SourcesStatus, DraftFacts, FetchedBundle).

export interface FetchOutcome {
    bundle: FetchedBundle;
    status: SourcesStatus;
    /** Sources that gave text the model will read. */
    usable: number;
    /** Some source failed in a way a later try could fix. */
    anyRetryable: boolean;
}

// ─── What it reads with ─────────────────────────────────────────────────────────────────────

export interface SourceDeps {
    discoveryAccount: () => Promise<SourceResult<DiscoveryAccount>>;
    businessDiscovery: (creds: GraphCredentials, handle: string) => Promise<SourceResult<IgProfile>>;
    ownCredentials: (creatorId: string) => Promise<GraphCredentials | null>;
    ownInstagram: (creds: GraphCredentials, handle: string | null) => Promise<SourceResult<IgProfile>>;
    youtube: (ref: string, signal: AbortSignal) => Promise<SourceResult<YouTubeChannelData>>;
    /** The tenant's own connection; null when there is none. */
    connectedYouTube: (creatorId: string) => Promise<SourceResult<YouTubeChannelData> | null>;
    website: (input: string, signal: AbortSignal) => Promise<Website>;
    keywordsInUse: (creatorId: string) => Promise<string[]>;
    now: () => number;
}

async function ownCredentials(creatorId: string): Promise<GraphCredentials | null> {
    const creator = await getTenant(creatorId, ['id', 'instagram_page_id', 'page_access_token']);
    const igUserId = creator?.instagram_page_id;
    const token = creator?.page_access_token;
    return igUserId && token ? { token, igUserId: String(igUserId) } : null;
}

async function connectedYouTube(creatorId: string): Promise<SourceResult<YouTubeChannelData> | null> {
    if (!(await getYouTubeConnection(creatorId))) return null;
    try {
        const { accessToken } = await getAccessToken(creatorId);
        return sourceOk(fromMyChannel(await getMyChannel(accessToken)));
    } catch (err) {
        if (err instanceof YouTubeNotConnectedError) return null;
        return { ok: false, error: classifyYouTubeFailure(youtubeFailureOf(err)) };
    }
}

/** The trigger words of the tenant's own campaigns: one cell may hold several, separated by a comma. */
async function keywordsInUse(creatorId: string): Promise<string[]> {
    const rows = await queryRows<{ trigger_keyword: string | null }>('SELECT trigger_keyword FROM campaigns WHERE creator_id = $1 LIMIT 200', [creatorId]);
    const words = rows.flatMap((r) => (r.trigger_keyword ?? '').split(/[,،|]/)).map((w) => w.trim()).filter(Boolean);
    return [...new Set(words)].slice(0, 100);
}

export const DEFAULT_SOURCE_DEPS: SourceDeps = {
    discoveryAccount: resolveDiscoveryAccount,
    businessDiscovery: fetchBusinessDiscovery,
    ownCredentials,
    ownInstagram: fetchOwnInstagram,
    youtube: (ref, signal) => fetchYouTubeChannel(ref, { signal }),
    connectedYouTube,
    website: (input, signal) => gatherWebsite(input, { signal }),
    keywordsInUse,
    now: Date.now,
};

// ─── Small helpers ──────────────────────────────────────────────────────────────────────────

const report = (state: SourceState, via: string | null, ms: number, extra: Partial<SourceReport> = {}): SourceReport => ({
    state, via, kind: null, retryable: false, message: null, ms, counts: {}, ...extra,
});
const skipped = (kind: string, message: string, via: string | null = null): SourceReport => report('skipped', via, 0, { kind, message });

/** A source error as the report of a source that failed (or, for `not_configured`, was skipped: nothing was tried). */
function failureReport(error: SourceError, via: string | null, ms: number): SourceReport {
    return report(error.kind === 'not_configured' ? 'skipped' : 'failed', via, ms, { kind: error.kind, retryable: error.retryable, message: error.message });
}

/** What an unexpected exception says, scrubbed of anything key-shaped and cut short: it is stored and shown. */
const errorMessage = (err: unknown): string => scrubSecrets(err instanceof Error ? err.message : String(err)) || 'The read failed.';

/**
 * `work` under a deadline. A source that does not answer in time is a retryable `timeout`, and whatever it later does is
 * ignored (its promise is still handled, so a late rejection is not an unhandled one). Never throws.
 */
async function within<T>(ms: number, work: () => Promise<T>, onFailure: (kind: 'timeout' | 'internal', message: string) => T): Promise<T> {
    return new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(onFailure('timeout', `No answer within ${Math.round(ms / 1000)} s.`)), ms);
        let running: Promise<T>;
        try {
            running = work();
        } catch (err) {
            clearTimeout(timer);
            resolve(onFailure('internal', errorMessage(err)));
            return;
        }
        running.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err: unknown) => { clearTimeout(timer); resolve(onFailure('internal', errorMessage(err))); },
        );
    });
}

const unique = (values: ReadonlyArray<string | null | undefined>, max = 60): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))].slice(0, max);

// ─── Website → sources ──────────────────────────────────────────────────────────────────────

/**
 * The sources a gathered site gives: one per page, `site1`, `site2`…, `site_page` (a link-in-bio hub's own page is `link_hub`).
 * A page's text starts with its address, title and description and its structured data (offers and FAQ from JSON-LD), then its
 * visible text, so the cap of 3 000 characters cuts the body and not the facts. A hub lists its outbound links with their
 * addresses, so an offer's address is one a source holds. Pure.
 */
export function websiteSources(site: Pick<Website, 'pages' | 'texts'>): DraftSource[] {
    const textOf = new Map(site.texts.map((t) => [t.url, t.text]));
    return site.pages.map((page, i): DraftSource => {
        const e = page.extract;
        const lines: string[] = [page.url];
        if (e.title) lines.push(e.title);
        if (e.description && e.description !== e.title) lines.push(e.description);
        for (const offer of e.jsonLd.offers.slice(0, 8)) {
            const price = offer.price ? ` — ${offer.price}${offer.currency ? ` ${offer.currency}` : ''}` : '';
            lines.push(`${offer.name}${price}${offer.url ? ` — ${offer.url}` : ''}`);
        }
        for (const item of e.jsonLd.faq.slice(0, 10)) lines.push(`${item.question}\n${item.answer}`);
        const isHub = page.role === 'home' && e.hub;
        if (isHub) for (const link of e.links.slice(0, 30)) lines.push(`${link.label}: ${link.href}`);
        const body = textOf.get(page.url) ?? e.text;
        if (body) lines.push(body);
        return { id: `site${i + 1}`, kind: isHub ? 'link_hub' : 'site_page', text: lines.join('\n') };
    });
}

/** The hosts, links, emails and numbers a gathered site gives, for `validateDraft` to let a model repeat. */
function siteKnowledge(site: Website): { urls: string[]; emails: string[]; phones: string[] } {
    const { merged, pages } = site;
    const urls = [
        ...pages.map((p) => p.url),
        ...Object.values(merged.socials),
        ...merged.offers.map((o) => o.url),
        merged.organization?.url, ...(merged.organization?.sameAs ?? []),
        merged.whatsapp && /^https?:\/\//i.test(merged.whatsapp) ? merged.whatsapp : null,
    ];
    const phones = [...merged.phones, merged.whatsapp && !/^https?:\/\//i.test(merged.whatsapp) ? merged.whatsapp : null, merged.organization?.telephone];
    return { urls: unique(urls), emails: unique([...merged.emails, merged.organization?.email]), phones: unique(phones) };
}

/** Whether an unreachable site may be reachable later: a timeout, a dropped connection, a 5xx, a 429. */
export function websiteRetryable(site: Pick<Website, 'status' | 'notes'>): boolean {
    if (site.status !== 'unreachable') return false;
    return site.notes.some((n) => !n.ok && n.kind === 'page' && (n.error === 'timeout' || n.error === 'network' || n.error === 'rate_limited' || (n.error === 'status' && (n.status ?? 0) >= 500)));
}

const hostOf = (url: string): string | null => {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return null;
    }
};

// ─── The phase ──────────────────────────────────────────────────────────────────────────────

/** The order the model reads them in, and the order that survives the total budget: what is most about the business first. */
function rank(source: DraftSource): number {
    switch (source.kind) {
        case 'typed': return 0;
        case 'ig_bio': return 1;
        case 'site_page':
        case 'link_hub': return 2;
        case 'yt_description': return source.id === 'yt_about' ? 3 : 5;
        case 'ig_caption': return 4;
        default: return 5;
    }
}

/**
 * Reads everything a tenant gave, in parallel, inside `FETCH_PHASE_MS`. Never throws: a source that breaks is a line in
 * the status. `creatorId` is only for the tenant's own connections and campaigns.
 */
export async function fetchDraftSources(
    creatorId: string,
    inputs: DraftInputs,
    options: { deps?: Partial<SourceDeps>; phaseMs?: number } = {},
): Promise<FetchOutcome> {
    const deps: SourceDeps = { ...DEFAULT_SOURCE_DEPS, ...options.deps };
    const phaseMs = options.phaseMs ?? FETCH_PHASE_MS;
    const signal = AbortSignal.timeout(phaseMs);
    const started = deps.now();
    const since = (): number => deps.now() - started;

    // ── Instagram ──
    const readInstagram = async (): Promise<{ report: SourceReport; profile: IgProfile | null }> => {
        const t0 = deps.now();
        const fail = (kind: 'timeout' | 'internal', message: string) => ({ report: report('failed', null, deps.now() - t0, { kind, retryable: true, message }), profile: null });
        return within(phaseMs, async () => {
            let lastError: SourceError | null = null;
            let via: string | null = null;

            if (inputs.via === 'own_token') {
                const creds = await deps.ownCredentials(creatorId);
                if (creds) {
                    via = 'own_token';
                    const own = await deps.ownInstagram(creds, inputs.instagram);
                    if (own.ok) return { report: igReport(own.value, 'own_token', deps.now() - t0), profile: own.value };
                    lastError = own.error;
                    // A road that is shut (a dead token, a missing permission) is no reason not to try the other.
                    if (!(own.error.kind === 'no_access' || own.error.kind === 'not_configured') || !inputs.instagram) {
                        return { report: failureReport(own.error, via, deps.now() - t0), profile: null };
                    }
                }
            }

            if (!inputs.instagram) return { report: lastError ? failureReport(lastError, via, deps.now() - t0) : skipped('no_input', 'No Instagram handle was given.'), profile: null };

            const account = await deps.discoveryAccount();
            if (!account.ok) return { report: failureReport(account.error, 'business_discovery', deps.now() - t0), profile: null };
            const found = await deps.businessDiscovery(account.value, inputs.instagram);
            if (found.ok) return { report: igReport(found.value, 'business_discovery', deps.now() - t0), profile: found.value };
            return { report: failureReport(found.error, 'business_discovery', deps.now() - t0), profile: null };
        }, fail);
    };

    // ── Website ──
    const readWebsite = async (): Promise<{ report: SourceReport; site: Website | null }> => {
        if (!inputs.website) return { report: skipped('no_input', 'No website was given.'), site: null };
        const t0 = deps.now();
        const fail = (kind: 'timeout' | 'internal', message: string) => ({ report: report('failed', 'safe_fetch', deps.now() - t0, { kind, retryable: true, message }), site: null });
        return within(phaseMs, async () => {
            const site = await deps.website(inputs.website!, signal);
            const ms = deps.now() - t0;
            if (site.status === 'ok') {
                return { report: report('ok', 'safe_fetch', ms, { counts: { pages: site.pages.length, ...(site.merged.offers.length ? { offers: site.merged.offers.length } : {}), ...(site.merged.faq.length ? { faq: site.merged.faq.length } : {}) } }), site };
            }
            const message = site.status === 'blocked' ? 'The site refused to be read (a firewall or a login).'
                : site.status === 'robots' ? 'The site\'s robots.txt does not allow it to be read.'
                    : 'The site could not be reached.';
            return { report: report('failed', 'safe_fetch', ms, { kind: site.status, retryable: websiteRetryable(site), message, needsPaste: site.needsPaste || site.status === 'blocked' || site.status === 'robots' }), site: null };
        }, fail);
    };

    // ── YouTube ──
    const readYouTube = async (): Promise<{ report: SourceReport; channel: YouTubeChannelData | null }> => {
        const t0 = deps.now();
        const fail = (kind: 'timeout' | 'internal', message: string) => ({ report: report('failed', null, deps.now() - t0, { kind, retryable: true, message }), channel: null });
        return within(phaseMs, async () => {
            let result: SourceResult<YouTubeChannelData> | null;
            let via: string;
            if (inputs.youtube) {
                via = 'api_key';
                result = await deps.youtube(inputs.youtube, signal);
            } else {
                via = 'connected';
                result = await deps.connectedYouTube(creatorId);
                if (!result) return { report: skipped('no_input', 'No YouTube channel was given or connected.'), channel: null };
            }
            const ms = deps.now() - t0;
            if (!result.ok) return { report: failureReport(result.error, via, ms), channel: null };
            const channel = result.value;
            return {
                report: report('ok', via, ms, {
                    counts: { videos: channel.videos.length },
                    ...(channel.videosError ? { message: `The recent videos could not be read: ${channel.videosError.kind}.` } : {}),
                }),
                channel,
            };
        }, fail);
    };

    const [ig, web, yt, keywords] = await Promise.all([
        readInstagram(),
        readWebsite(),
        readYouTube(),
        deps.keywordsInUse(creatorId).catch((err: unknown) => {
            // The campaigns could not be read: the draft is made without the collision check, which a person still does on the way in.
            log('warn', 'onboarding.draft_keywords_unreadable', { creator_id: creatorId, ...describeError(err) });
            return [] as string[];
        }),
    ]);

    // ── Put it together ──
    const typed: SourceReport = inputs.about ? report('ok', 'typed', 0, { counts: { chars: Array.from(inputs.about).length } }) : skipped('no_input', 'No text was pasted.');
    const status: SourcesStatus = { instagram: ig.report, website: web.report, youtube: yt.report, typed };

    const raw: DraftSource[] = [];
    let candidates: SampleCandidate[] = [];
    let followers: number | null = null;
    let mediaCount: number | null = null;
    if (inputs.about) raw.push({ id: 'typed', kind: 'typed', text: inputs.about });
    if (ig.profile) {
        const made = instagramSources(ig.profile);
        raw.push(...made.sources);
        candidates = made.candidates;
        followers = made.followers;
        mediaCount = made.mediaCount;
    }
    if (web.site) raw.push(...websiteSources(web.site));
    if (yt.channel) raw.push(...youtubeSources(yt.channel));
    const sources = prepareSources(raw.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s));
    const kept = new Set(sources.map((s) => s.id));
    candidates = candidates.filter((c) => kept.has(c.id));

    const home = web.site?.pages[0]?.url ?? null;
    const siteHost = (home ? hostOf(home) : null) ?? (inputs.website ? hostOf(inputs.website) : null);
    const known = web.site ? siteKnowledge(web.site) : { urls: [], emails: [], phones: [] };
    const handle = ig.profile?.username ?? inputs.instagram;
    const facts: DraftFacts = {
        handle,
        handleMismatch: ig.profile?.handleMismatch ?? false,
        igName: ig.profile?.name ?? null,
        followers,
        mediaCount,
        siteHost,
        site: web.site ? { status: web.site.status, needsPaste: web.site.needsPaste, pages: web.site.pages.map((p: GatheredPage) => ({ url: p.url, role: p.role })) } : null,
        brand: web.site ? { primary: web.site.brand.primary, accent: web.site.brand.accent, ink: web.site.brand.ink, paper: web.site.brand.paper, source: web.site.brand.primarySource } : null,
        logos: web.site ? web.site.logos.candidates.slice(0, 5) : [],
        socialLinks: web.site ? { ...web.site.merged.socials } : {},
        youtube: yt.channel ? { id: yt.channel.id, title: yt.channel.title, handle: yt.channel.handle, country: yt.channel.country, subscribers: yt.channel.subscribers, via: yt.channel.via } : null,
        knownUrls: unique([...known.urls, ig.profile?.website]),
        knownEmails: known.emails,
        knownPhones: known.phones,
        keywordsInUse: keywords,
    };
    const signals = computeSignals({ sources, candidates, keywordsInUse: keywords, handle, siteHost, followers, mediaCount });

    const reports = Object.values(status);
    const outcome: FetchOutcome = {
        bundle: { version: 1, sources, candidates, signals, facts },
        status,
        usable: sources.length,
        anyRetryable: reports.some((r) => r.state === 'failed' && r.retryable),
    };
    log('info', 'onboarding.draft_fetched', {
        creator_id: creatorId, elapsed_ms: since(), sources: sources.length,
        instagram: ig.report.state, instagram_kind: ig.report.kind, website: web.report.state, website_kind: web.report.kind,
        youtube: yt.report.state, youtube_kind: yt.report.kind, typed: typed.state,
    });
    return outcome;
}

function igReport(profile: IgProfile, via: string, ms: number): SourceReport {
    return report('ok', via, ms, {
        counts: { posts: profile.posts.length, ...(profile.followers !== null ? { followers: profile.followers } : {}) },
        ...(profile.postsError ? { message: `The posts could not be read: ${profile.postsError.kind}.` } : {}),
    });
}
