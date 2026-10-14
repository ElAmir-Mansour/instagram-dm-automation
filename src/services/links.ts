/**
 * Tracked links: the short `/r/:code` addresses a sales DM carries instead of the product's own (docs/DM_SALES_PLAN.md §9, S7).
 *
 * Meta reports neither "a link was sent" nor "a link was opened", so the funnel needs a hop of its own: the DM names
 * `https://<our domain>/r/<code>`, and `GET /r/:code` (src/routes/links.ts) answers 302 to the address stored here and counts the visit.
 *
 *   createTrackedLink   mint (or reuse) the code for one (conversation, offer). Nothing calls it yet: S6 does, when a sales turn sends a link.
 *   resolve             code -> the link, or null.
 *   recordClick         one row in `link_clicks`: when, person-or-preview, a coarse device class.
 *
 * ── The three promises, and where each is kept ──
 *
 *   BYTE FOR BYTE. The target is stored as given and served as stored, so a referral code in a product address reaches the shop untouched. The one thing this
 *   module does to an address is percent-encode characters that cannot appear in an HTTP header at all (anything outside printable ASCII), and an
 *   address that is already wire-safe, which is every one a browser has ever shown, is stored exactly as typed. Nothing is appended, nothing is
 *   re-ordered, the scheme and host are not lower-cased.
 *
 *   UNGUESSABLE. A code is 10 characters of base62 drawn from `crypto.randomBytes` with rejection sampling (no modulo bias): about 59 bits. The
 *   table is the only way to find a link, and the route never takes a target from the request, so it is not an open redirect.
 *
 *   PII-LIGHT. A click stores the time, whether a person made it, and one of a closed list of device classes. Never an IP address, never the
 *   user-agent string: `ua_class` is a CHECK-constrained enum in the database (migration v38) and `LINK_CLICK_UA_CLASSES` below is the same list,
 *   with a test that fails when they differ.
 */
import { randomBytes } from 'node:crypto';
import { queryCount, queryOne } from '../db/query.js';

// ─── Codes ───────────────────────────────────────────────────────────────────────────────────

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 62 characters, so a byte is usable only below 248 (4 x 62): the rest would make the first 8 characters likelier than the others. */
const UNBIASED_BELOW = 248;

/** Plan §9: a 10-character random base62 code. The database CHECK allows 10 to 32. */
export const LINK_CODE_LENGTH = 10;
export const MIN_LINK_CODE_LENGTH = 10;

/** What a code looks like. The route 404s anything else without asking the database. */
export const LINK_CODE_PATTERN = /^[0-9A-Za-z]{10,32}$/;

export function isLinkCode(value: unknown): value is string {
    return typeof value === 'string' && LINK_CODE_PATTERN.test(value);
}

/** Where the entropy comes from. Injected only so a test can prove biased bytes are discarded. */
export type RandomSource = (size: number) => Uint8Array;

/** A random base62 code from a CSPRNG. Uniform: bytes that would bias a character are discarded, not wrapped. */
export function generateLinkCode(length: number = LINK_CODE_LENGTH, random: RandomSource = randomBytes): string {
    if (!Number.isInteger(length) || length < MIN_LINK_CODE_LENGTH) {
        throw new RangeError(`A link code is at least ${MIN_LINK_CODE_LENGTH} characters, asked for ${length}`);
    }
    let code = '';
    while (code.length < length) {
        for (const byte of random(length * 2)) {
            if (byte >= UNBIASED_BELOW) continue;
            code += ALPHABET[byte % 62];
            if (code.length === length) break;
        }
    }
    return code;
}

// ─── Targets ─────────────────────────────────────────────────────────────────────────────────

export class InvalidTargetUrlError extends Error {
    constructor(reason: string) {
        super(`Not a link target: ${reason}`);
        this.name = 'InvalidTargetUrlError';
    }
}

/** An offer's address is `^https?://\S+$` in the profile (`OFFER_URL`); a link may be no looser. */
const HTTP_ADDRESS = /^https?:\/\/\S+$/i;
export const MAX_TARGET_URL_LENGTH = 2048;

/**
 * The address as it will travel in the Location header: the stored value, with only the characters a header cannot carry (control
 * characters and everything past printable ASCII) percent-encoded as UTF-8. An address that is already ASCII comes back identical, so the
 * product link is the product link. Throws `InvalidTargetUrlError` for anything that is not an http(s) address with a host.
 */
export function toWireUrl(target: unknown): string {
    if (typeof target !== 'string' || target === '') throw new InvalidTargetUrlError('empty');
    if (target.length > MAX_TARGET_URL_LENGTH) throw new InvalidTargetUrlError(`longer than ${MAX_TARGET_URL_LENGTH} characters`);
    if (!HTTP_ADDRESS.test(target)) throw new InvalidTargetUrlError('it must start with http:// or https:// and hold no whitespace');
    let wire: string;
    try {
        wire = target.replace(/[^\x21-\x7e]/gu, (ch) => encodeURIComponent(ch));
        // Parsed only to be judged, never to be re-serialised: `new URL(x).href` would normalise the very bytes this must keep.
        if (new URL(wire).hostname === '') throw new Error('no host');
    } catch {
        throw new InvalidTargetUrlError('it does not parse as a web address with a host');
    }
    return wire;
}

// ─── Creating and resolving ──────────────────────────────────────────────────────────────────

export interface TrackedLink {
    code: string;
    creatorId: string;
    conversationId: string | null;
    offerId: string;
    targetUrl: string;
}

/**
 * One statement for both cases. With a conversation, the partial unique index on (conversation_id, offer_id) is the arbiter: a second link for
 * the same pair keeps its first code and takes the newer address (the offer's URL may have been edited since), and RETURNING hands back whichever
 * code the row has. Without a conversation there is no pair to collide on and the insert is always new. A collision on the code itself is a
 * unique violation that no ON CONFLICT here catches, which `createTrackedLink` retries with a fresh code.
 */
export const CREATE_LINK_SQL = `INSERT INTO tracked_links (code, creator_id, offer_id, target_url, conversation_id)
 VALUES ($1, $2, $3, $4, $5)
 ON CONFLICT (conversation_id, offer_id) WHERE conversation_id IS NOT NULL
 DO UPDATE SET target_url = EXCLUDED.target_url
 RETURNING code`;

export const RESOLVE_LINK_SQL = `SELECT code, creator_id, conversation_id, offer_id, target_url FROM tracked_links WHERE code = $1`;

const MAX_CODE_ATTEMPTS = 5;

/**
 * Make the link for one offer, sent to one person, and return its code. Call it again for the same (conversation, offer) and the same code
 * comes back. `conversationId` is omitted for a link made outside a conversation (a test link): that one is always new.
 *
 * Throws `InvalidTargetUrlError` for an address that is not http(s), and whatever the database throws. The caller is the sales turn, which
 * sends the DM without a link rather than with a broken one.
 */
export async function createTrackedLink(
    creatorId: string,
    offerId: string,
    targetUrl: string,
    conversationId?: string | null,
): Promise<string> {
    if (typeof creatorId !== 'string' || creatorId === '') throw new TypeError('createTrackedLink needs a creatorId');
    if (typeof offerId !== 'string' || offerId === '' || offerId.length > 100) throw new TypeError('createTrackedLink needs an offerId of 1 to 100 characters');
    const wire = toWireUrl(targetUrl);

    for (let attempt = 1; ; attempt++) {
        try {
            const row = await queryOne<{ code: string }>(CREATE_LINK_SQL, [generateLinkCode(), creatorId, offerId, wire, conversationId ?? null]);
            if (!row) throw new Error('createTrackedLink: the insert returned no row');
            return row.code;
        } catch (err) {
            const code = (err as { code?: unknown } | null)?.code;
            if (code === '23505' && attempt < MAX_CODE_ATTEMPTS) continue;
            throw err;
        }
    }
}

/** The link a code names, or null. A malformed code is null without a query. */
export async function resolve(code: string): Promise<TrackedLink | null> {
    if (!isLinkCode(code)) return null;
    const row = await queryOne<{ code: string; creator_id: string; conversation_id: string | null; offer_id: string; target_url: string }>(RESOLVE_LINK_SQL, [code]);
    if (!row) return null;
    return { code: row.code, creatorId: row.creator_id, conversationId: row.conversation_id, offerId: row.offer_id, targetUrl: row.target_url };
}

// ─── Clicks ──────────────────────────────────────────────────────────────────────────────────

/**
 * The only trace of a visitor's browser that is ever stored. The same list as the CHECK in migration v38 (a test compares them).
 *
 *   instagram, facebook   the app's own in-app browser: a person who tapped the link in the app
 *   ios, android, desktop any other browser
 *   preview               a link-preview fetcher we know by name (Meta's, WhatsApp's, Slack's ...): never a person
 *   bot                   a crawler, a script, or a request that names nothing
 *   other                 a browser we could not place
 */
export const LINK_CLICK_UA_CLASSES = ['instagram', 'facebook', 'ios', 'android', 'desktop', 'preview', 'bot', 'other'] as const;
export type LinkClickUaClass = (typeof LINK_CLICK_UA_CLASSES)[number];

/** Link-preview fetchers: Meta's (Instagram and Facebook DMs, Messenger), WhatsApp's, and the chat apps that unfurl a pasted link. */
const PREVIEW_AGENT = /facebookexternalhit|facebookcatalog|facebot|meta-external(?:agent|fetcher)|meta-webindexer|^whatsapp\/|twitterbot|slackbot|slack-imgproxy|telegrambot|discordbot|linkedinbot|skypeuripreview|bingpreview/i;

/** Everything else that is not a browser: crawlers by name, and the HTTP libraries a script uses. */
const BOT_AGENT = /\b[a-z0-9]*(?:bot|spider|crawler|crawl|slurp)\b|curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|go-http-client|libwww|scrapy|node-fetch|undici|axios\/|java\/|okhttp\/[\d.]+$|headlesschrome|lighthouse|pingdom|uptimerobot/i;

/** A speculative load: the headers a browser adds when it fetches a link before, or instead of, the person opening it. */
const PREFETCH_PURPOSE = /prefetch|prerender|preview/i;

/** A user-agent longer than this is cut before it is matched; nothing here needs more, and none of it is stored. */
const MAX_UA_CHARS = 512;

export interface ClickInput {
    method: string;
    userAgent?: string | undefined;
    /** `Sec-Purpose`, `Purpose`, `X-Moz`, `X-Purpose` joined: whatever the client said about why it is fetching. */
    purpose?: string | undefined;
}

export interface ClickClass {
    uaClass: LinkClickUaClass;
    isPrefetch: boolean;
}

/**
 * Who made this request, as coarsely as the funnel needs. Pure.
 *
 * `isPrefetch` is "not a person's click": a HEAD request (a browser never navigates with one), a speculative-load header, a preview fetcher
 * we know by name, a crawler or script, or a request that names no client at all. Only a person's click counts as "clicked".
 *
 * The Instagram and Facebook IN-APP BROWSERS are people: a person tapping the link in a DM opens it inside the app, and the page's user-agent
 * carries the app's name beside a normal browser engine ("Mozilla/5.0 ... Instagram 345.0"). A request that names Instagram and no browser
 * engine at all is the app's own fetcher, not a browser, and is a preview.
 */
export function classifyClick(input: ClickInput): ClickClass {
    const ua = (input.userAgent ?? '').slice(0, MAX_UA_CHARS).trim();
    const uaClass = classifyUserAgent(ua);
    const isPrefetch = input.method.toUpperCase() === 'HEAD'
        || PREFETCH_PURPOSE.test(input.purpose ?? '')
        || uaClass === 'preview'
        || uaClass === 'bot';
    return { uaClass, isPrefetch };
}

function classifyUserAgent(ua: string): LinkClickUaClass {
    if (ua === '') return 'bot';
    if (PREVIEW_AGENT.test(ua)) return 'preview';
    const browser = /\bMozilla\//i.test(ua);
    if (/\bInstagram\b/i.test(ua)) return browser ? 'instagram' : 'preview';
    if (BOT_AGENT.test(ua)) return 'bot';
    if (/\bFB_IAB\b|\bFBAN\b|\bFBAV\b|\bFBIOS\b/.test(ua)) return 'facebook';
    if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) return 'ios';
    if (/\bAndroid\b/.test(ua)) return 'android';
    if (/\b(?:Windows|Macintosh|X11|CrOS|Linux)\b/.test(ua)) return 'desktop';
    return 'other';
}

export const RECORD_CLICK_SQL = `INSERT INTO link_clicks (code, ua_class, is_prefetch) VALUES ($1, $2, $3)`;

/**
 * Count one visit. The time is the database's (`clicked_at` defaults to NOW()). Throws when the insert fails: the route logs it and
 * redirects anyway, because losing a count must never cost a person their link.
 */
export async function recordClick(code: string, click: ClickClass): Promise<void> {
    await queryCount(RECORD_CLICK_SQL, [code, click.uaClass, click.isPrefetch]);
}
