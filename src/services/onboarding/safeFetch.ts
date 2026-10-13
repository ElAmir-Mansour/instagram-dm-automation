/**
 * `safeFetch`: the one way the draft engine reads a page it was only given the address of
 * (docs/onboarding/03 §1). A tenant types a website; the server fetches it. Everything that makes
 * that safe is here:
 *
 *   - The address is judged before anything is sent (`validateFetchUrl`): http or https, ports 80
 *     and 443, no credentials, no IP literal, no private-looking name.
 *   - The name is resolved HERE, every answer is vetted (`guardedLookup`: one private record blocks
 *     the host), and the socket is opened to a vetted IP address, with the name kept only for the
 *     `Host` header and the TLS server name. The name is never resolved a second time, so an
 *     answer that changes between the check and the connect (DNS rebinding) changes nothing.
 *   - Redirects are followed by hand, at most three, and each hop goes through all of the above again.
 *     A redirect from https to http is refused.
 *   - The body is read through a byte counter that runs AFTER decompression and aborts the stream
 *     the moment the cap is passed, so a gzip bomb is never inflated: HTML 1.5 MB, CSS 512 KB,
 *     images 512 KB (manifest and robots: 256 KB).
 *   - Each request has 8 seconds (the whole call may be bounded further by the caller's `signal`,
 *     which is how the 25-second phase is kept).
 *   - The content type is checked against a list per kind, and an image must match its magic bytes.
 *   - No cookie, no authorization, no credentials: the request carries a fixed set of headers, and
 *     anything the server sets is ignored.
 *
 * The DNS lookup and the socket are both injectable (`resolve`, `transport`), so a test never
 * touches the network. The default transport is `node:http(s)` opened to the vetted address.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable, pipeline, type Transform } from 'node:stream';
import zlib from 'node:zlib';
import { BlockedHostError, guardedLookup, validateFetchUrl, type ResolvedAddress, type Resolver, type UrlRejection } from './netGuard.js';
import { IMAGE_CONTENT_TYPES, sniffImage } from './imageSniff.js';

/** The product token robots.txt is read for (03 §1.7). A caller may add a contact URL after it. */
export const BOT_TOKEN = 'AutoReplyProBot';
export const USER_AGENT = `${BOT_TOKEN}/1.0`;
/** One request, connection to last byte (03 §1.5). */
export const REQUEST_TIMEOUT_MS = 8_000;
/** The whole gathering phase, which a caller enforces by passing `phaseSignal()` as `signal`. */
export const PHASE_TIMEOUT_MS = 25_000;
export const MAX_REDIRECTS = 3;
/** How many of a host's vetted addresses a connection tries before giving up. */
const MAX_ADDRESSES_TRIED = 4;

export type FetchKind = 'html' | 'css' | 'image' | 'json' | 'text';

interface KindPolicy {
    maxBytes: number;
    types: readonly string[];
    accept: string;
}

/** What each kind of fetch may receive. The caps are the spec's (03 §1.4); `json` and `text` (manifest, robots.txt) are small by nature. */
export const FETCH_KINDS: Readonly<Record<FetchKind, KindPolicy>> = {
    html: { maxBytes: 1_500_000, types: ['text/html', 'application/xhtml+xml'], accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    css: { maxBytes: 512 * 1024, types: ['text/css'], accept: 'text/css,*/*;q=0.1' },
    image: { maxBytes: 512 * 1024, types: Object.keys(IMAGE_CONTENT_TYPES), accept: 'image/png,image/jpeg,image/webp,image/svg+xml,image/*;q=0.8' },
    // Manifests are often served as text/plain by a server that has never heard of them.
    json: { maxBytes: 256 * 1024, types: ['application/json', 'application/manifest+json', 'text/json', 'text/plain'], accept: 'application/manifest+json,application/json;q=0.9,*/*;q=0.1' },
    text: { maxBytes: 256 * 1024, types: ['text/plain'], accept: 'text/plain,*/*;q=0.1' },
};

export type SafeFetchErrorKind =
    | 'invalid_url' // not a URL, or one that is too long
    | 'blocked_url' // a scheme, port, credential, IP literal or private name that may not be fetched
    | 'blocked_address' // the name resolves to an address that is not on the public internet
    | 'dns'
    | 'too_many_redirects'
    | 'insecure_redirect' // https to http
    | 'bad_redirect'
    | 'forbidden' // 401 or 403: a firewall or a login, which is "paste your About text" to the wizard
    | 'rate_limited'
    | 'not_found'
    | 'status'
    | 'content_type'
    | 'content_encoding'
    | 'bad_content' // an image whose bytes are not the image it claims to be, or a corrupt compressed body
    | 'too_large'
    | 'timeout'
    | 'network';

const RETRYABLE: ReadonlySet<SafeFetchErrorKind> = new Set(['timeout', 'network', 'rate_limited']);

export class SafeFetchError extends Error {
    readonly retryable: boolean;
    constructor(
        readonly kind: SafeFetchErrorKind,
        message: string,
        readonly details: { url?: string; status?: number; scope?: 'request' | 'phase'; blocked?: { address: string; reason: string }; urlReason?: UrlRejection; code?: string } = {},
    ) {
        super(message);
        this.name = 'SafeFetchError';
        this.retryable = RETRYABLE.has(kind) || (kind === 'status' && (details.status ?? 0) >= 500) || (kind === 'dns' && message.includes('did not answer'));
    }
    get status(): number | undefined {
        return this.details.status;
    }
}

export const isSafeFetchError = (err: unknown): err is SafeFetchError => err instanceof SafeFetchError;

// ─── The socket ──────────────────────────────────────────────────────────────────────────────

/** One request to one vetted address. `url`'s hostname is for `Host` and the TLS server name only: nothing may resolve it. */
export interface TransportRequest {
    url: URL;
    address: string;
    family: 4 | 6;
    port: number;
    headers: Record<string, string>;
    signal: AbortSignal;
}

export interface TransportResponse {
    status: number;
    /** Header names in lower case. */
    headers: Record<string, string | string[] | undefined>;
    /** The body as the server sent it, still compressed if it was. */
    body: AsyncIterable<Uint8Array>;
    /** Tears the connection down. Safe to call twice. */
    close(): void;
}

/** What opens a connection: tests hand in a script, production uses `nodeTransport`. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** DNS is never consulted when the host is an address, and it is one here; this makes "never" true if that ever stops being so. */
const refuseLookup = ((_hostname: string, _options: unknown, callback: (err: Error | null) => void) => {
    callback(new Error('DNS is not consulted when a connection is made'));
}) as unknown as http.RequestOptions['lookup'];

/**
 * The real socket: connects to the vetted IP address and keeps the name for the `Host` header and, for
 * https, the TLS server name (SNI), so the certificate is checked against the name that was asked for
 * and not against the number. No agent, no keep-alive: one connection per request.
 */
export const nodeTransport: Transport = (request) =>
    new Promise<TransportResponse>((resolve, reject) => {
        const secure = request.url.protocol === 'https:';
        const options: https.RequestOptions = {
            host: request.address,
            family: request.family,
            port: request.port,
            method: 'GET',
            path: `${request.url.pathname}${request.url.search}`,
            headers: request.headers,
            agent: false,
            signal: request.signal,
            lookup: refuseLookup,
            maxHeaderSize: 32 * 1024,
            ...(secure ? { servername: request.url.hostname.replace(/\.$/, '') } : {}),
        };
        const outgoing = (secure ? https : http).request(options, (res) => {
            resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: res,
                close: () => {
                    res.destroy();
                    outgoing.destroy();
                },
            });
        });
        outgoing.once('error', reject);
        outgoing.end();
    });

/** The system resolver: every address a name has, in the order the operating system gives them. */
export const systemResolver: Resolver = async (host) => {
    const answers = await dnsLookup(host, { all: true, verbatim: true });
    return answers.map((a): ResolvedAddress => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

// ─── Options and result ──────────────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
    kind: FetchKind;
    /** Lowers the kind's cap, never raises it. */
    maxBytes?: number;
    /** Per request (each redirect hop has its own). Default 8 s. */
    timeoutMs?: number;
    /** At most 3, the default. */
    maxRedirects?: number;
    /** The phase's deadline (`phaseSignal()`), or the caller's cancel. */
    signal?: AbortSignal;
    userAgent?: string;
    resolve?: Resolver;
    transport?: Transport;
}

export interface SafeFetchResponse {
    /** The address that answered, after any redirects. */
    url: string;
    status: number;
    /** `type/subtype`, lower case, without parameters. */
    contentType: string;
    bytes: Uint8Array;
    /** Decoded text for html, css, json, text and svg; empty for a raster image. */
    text: string;
    /** Each address a redirect led to, in order. */
    redirects: string[];
    /** The vetted IP address the last connection was made to. */
    address: string;
}

/** An `AbortSignal` that fires when the 25-second gathering phase is over. Pass it as `signal` to every fetch of a phase. */
export const phaseSignal = (ms = PHASE_TIMEOUT_MS): AbortSignal => AbortSignal.timeout(ms);

// ─── Reading a body ──────────────────────────────────────────────────────────────────────────

/** Rejects when `signal` aborts, whatever `promise` is doing; the promise itself is left to its own cleanup. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (err) => {
                signal.removeEventListener('abort', onAbort);
                reject(err);
            },
        );
    });
}

function decoderFor(encoding: string): Transform | null | 'unsupported' {
    switch (encoding) {
        case '':
        case 'identity':
            return null;
        case 'gzip':
        case 'x-gzip':
            return zlib.createGunzip();
        case 'deflate':
            return zlib.createInflate();
        case 'br':
            return zlib.createBrotliDecompress();
        default:
            return 'unsupported';
    }
}

/**
 * The body as bytes, or `too_large` the moment more than `cap` bytes have come out of the decoder.
 * The counter sits AFTER decompression: a 10 MB gzip of zeros is a few kilobytes on the wire and
 * would be gigabytes of memory, so the stream is destroyed as soon as the cap is passed and the rest
 * is never inflated (the compressed side is capped too, a little above `cap`, since a valid stream
 * is never much smaller than what it holds).
 */
async function readBody(response: TransportResponse, encoding: string, cap: number, signal: AbortSignal, url: string): Promise<Uint8Array> {
    const tooLarge = () => new SafeFetchError('too_large', `The page is larger than ${Math.round(cap / 1024)} KB.`, { url });
    const decoder = decoderFor(encoding);
    if (decoder === 'unsupported') throw new SafeFetchError('content_encoding', 'The page uses a compression this reader does not support.', { url });

    let source: AsyncIterable<Uint8Array> = response.body;
    if (decoder) {
        const compressedLimit = cap + 4096;
        const raw = response.body;
        const counted = (async function* (): AsyncGenerator<Uint8Array> {
            let compressed = 0;
            for await (const chunk of raw) {
                compressed += chunk.byteLength;
                if (compressed > compressedLimit) throw tooLarge();
                yield chunk;
            }
        })();
        pipeline(Readable.from(counted, { objectMode: false }), decoder, () => {});
        source = decoder;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const iterator = source[Symbol.asyncIterator]();
    try {
        for (;;) {
            const next = await abortable(iterator.next(), signal);
            if (next.done) break;
            total += next.value.byteLength;
            if (total > cap) throw tooLarge();
            chunks.push(next.value);
        }
    } catch (err) {
        if (isSafeFetchError(err)) throw err;
        const code = (err as { code?: string } | null)?.code ?? '';
        if (code.startsWith('Z_') || code.startsWith('ERR_BROTLI') || code === 'ERR_PADDING_ERR') {
            throw new SafeFetchError('bad_content', 'The page could not be decompressed.', { url });
        }
        throw err;
    } finally {
        // Stop reading whatever the reason: the rest of an oversized body must never be pulled.
        decoder?.destroy();
        if (!decoder) Promise.resolve(iterator.return?.()).catch(() => {});
        response.close();
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
}

/** `text/html; charset=utf-8` as its parts. */
export function parseContentType(header: string | string[] | undefined): { type: string; charset: string | null } {
    const value = (Array.isArray(header) ? header[0] : header) ?? '';
    const [type = '', ...params] = value.split(';');
    let charset: string | null = null;
    for (const param of params) {
        const m = param.trim().match(/^charset\s*=\s*"?([\w.:-]+)"?$/i);
        if (m) charset = m[1]!.toLowerCase();
    }
    return { type: type.trim().toLowerCase(), charset };
}

/**
 * Bytes as text: a byte-order mark first, then the header's charset, then (for HTML) a `<meta charset>` in
 * the first 4 KB, then UTF-8. Arabic sites still serve windows-1256 now and then, and reading that as UTF-8
 * is a page of question marks.
 */
export function decodeBody(bytes: Uint8Array, contentTypeHeader: string | null, kind: FetchKind): string {
    let label: string | null = null;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = 'utf-8';
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
    if (!label && contentTypeHeader) label = parseContentType(contentTypeHeader).charset;
    if (!label && kind === 'html') {
        const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
        label = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]?.toLowerCase() ?? null;
    }
    try {
        return new TextDecoder(label ?? 'utf-8').decode(bytes);
    } catch {
        return new TextDecoder('utf-8').decode(bytes);
    }
}

// ─── One request ─────────────────────────────────────────────────────────────────────────────

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

interface Context {
    policy: KindPolicy;
    cap: number;
    kind: FetchKind;
    timeoutMs: number;
    signal: AbortSignal | undefined;
    userAgent: string;
    resolve: Resolver;
    transport: Transport;
}

type Hop = { redirect: string } | { response: Omit<SafeFetchResponse, 'redirects'> };

async function fetchHop(url: URL, host: string, ctx: Context): Promise<Hop> {
    const hop = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        hop.abort();
    }, ctx.timeoutMs);
    const onOuterAbort = () => hop.abort();
    ctx.signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (ctx.signal?.aborted) hop.abort();
    const where = url.origin + url.pathname;
    try {
        // 1. Resolve, vet every answer, and keep the answers: these are the ONLY addresses this hop connects to.
        const addresses = await abortable(guardedLookup(host, ctx.resolve), hop.signal);

        // 2. Connect to a vetted address. The name is not looked up again; a second answer from DNS is never heard.
        const headers: Record<string, string> = {
            Host: url.host,
            'User-Agent': ctx.userAgent,
            Accept: ctx.policy.accept,
            'Accept-Encoding': 'gzip, deflate, br',
            Connection: 'close',
        };
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        let response: TransportResponse | undefined;
        let used = addresses[0]!;
        let lastError: unknown;
        for (const candidate of addresses.slice(0, MAX_ADDRESSES_TRIED)) {
            try {
                const pending = ctx.transport({ url, address: candidate.address, family: candidate.family, port, headers, signal: hop.signal });
                // A connection that opens after the deadline has passed must not be left open.
                pending.then(
                    (late) => {
                        if (hop.signal.aborted) late.close();
                    },
                    () => {},
                );
                response = await abortable(pending, hop.signal);
                used = candidate;
                break;
            } catch (err) {
                if (hop.signal.aborted) throw err;
                lastError = err;
            }
        }
        if (!response) throw lastError ?? new SafeFetchError('network', 'Could not connect.', { url: where });

        // 3. What came back.
        const status = response.status;
        const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
        if (REDIRECT_STATUSES.has(status)) {
            response.close();
            const location = first(responseHeaders.location);
            if (!location) throw new SafeFetchError('bad_redirect', 'The page redirected without saying where.', { url: where, status });
            return { redirect: location };
        }
        if (status < 200 || status >= 300) {
            response.close();
            const details = { url: where, status };
            if (status === 401 || status === 403) throw new SafeFetchError('forbidden', 'The site does not let this reader in.', details);
            if (status === 404 || status === 410) throw new SafeFetchError('not_found', 'The page does not exist.', details);
            if (status === 429) throw new SafeFetchError('rate_limited', 'The site asked this reader to slow down.', details);
            throw new SafeFetchError('status', `The site answered ${status}.`, details);
        }

        const { type } = parseContentType(responseHeaders['content-type']);
        if (!ctx.policy.types.includes(type)) {
            response.close();
            throw new SafeFetchError('content_type', `The page is ${type ? `"${type}"` : 'of no declared type'}, not ${ctx.kind === 'html' ? 'a web page' : `a ${ctx.kind} file`}.`, { url: where, status });
        }
        const encoding = (first(responseHeaders['content-encoding']) ?? '').trim().toLowerCase();
        const declared = Number(first(responseHeaders['content-length']));
        if (Number.isFinite(declared) && declared > ctx.cap + (encoding && encoding !== 'identity' ? 4096 : 0)) {
            response.close();
            throw new SafeFetchError('too_large', `The page is larger than ${Math.round(ctx.cap / 1024)} KB.`, { url: where, status });
        }

        const bytes = await readBody(response, encoding, ctx.cap, hop.signal, where);

        // 4. Images are what their bytes say, not what the server says.
        let isText = ctx.kind !== 'image';
        if (ctx.kind === 'image') {
            const claimed = IMAGE_CONTENT_TYPES[type];
            const actual = sniffImage(bytes);
            if (!actual || actual !== claimed) throw new SafeFetchError('bad_content', 'The file is not the image it says it is.', { url: where, status });
            isText = actual === 'svg';
        }
        const contentTypeHeader = first(responseHeaders['content-type']) ?? null;
        return { response: { url: url.href, status, contentType: type, bytes, text: isText ? decodeBody(bytes, contentTypeHeader, ctx.kind) : '', address: used.address } };
    } catch (err) {
        throw asSafeFetchError(err, { timedOut, outer: ctx.signal, url: where });
    } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onOuterAbort);
    }
}

function asSafeFetchError(err: unknown, how: { timedOut: boolean; outer: AbortSignal | undefined; url: string }): SafeFetchError {
    if (isSafeFetchError(err)) return err;
    if (err instanceof BlockedHostError) return new SafeFetchError(err.kind, err.message, { url: how.url, blocked: err.blocked });
    if (how.timedOut) return new SafeFetchError('timeout', 'The site did not answer in time.', { url: how.url, scope: 'request' });
    if (how.outer?.aborted) return new SafeFetchError('timeout', 'The time allowed for reading the site ran out.', { url: how.url, scope: 'phase' });
    const code = (err as { code?: string } | null)?.code;
    return new SafeFetchError('network', code ? `Could not reach the site (${code}).` : 'Could not reach the site.', { url: how.url, code });
}

// ─── The call ────────────────────────────────────────────────────────────────────────────────

const REFUSALS: Readonly<Record<UrlRejection, string>> = {
    invalid: 'That is not a web address.',
    too_long: 'That web address is too long.',
    scheme: 'Only http and https addresses can be read.',
    userinfo: 'A web address with a username or password cannot be read.',
    port: 'Only the standard web ports can be read.',
    bad_host: 'That is not a valid site name.',
    ip_literal: 'Give the site name, not a number.',
    single_label: 'That is not a public site name.',
    private_name: 'That is not a public site name.',
};

function checkUrl(raw: string): { url: URL; host: string } {
    const verdict = validateFetchUrl(raw);
    if (verdict.ok) return { url: verdict.url, host: verdict.host };
    throw new SafeFetchError(verdict.reason === 'invalid' || verdict.reason === 'too_long' ? 'invalid_url' : 'blocked_url', REFUSALS[verdict.reason], { urlReason: verdict.reason });
}

/**
 * Fetches one address through every rule above. Resolves with the final response, or throws a
 * `SafeFetchError` whose `kind` says which rule it was (and `retryable` whether trying again could help).
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResponse> {
    const policy = FETCH_KINDS[opts.kind];
    if (!policy) throw new SafeFetchError('invalid_url', 'Unknown kind of fetch.');
    const ctx: Context = {
        policy,
        kind: opts.kind,
        cap: Math.max(1, Math.min(policy.maxBytes, opts.maxBytes ?? policy.maxBytes)),
        timeoutMs: Math.max(1, opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
        signal: opts.signal,
        userAgent: opts.userAgent ?? USER_AGENT,
        resolve: opts.resolve ?? systemResolver,
        transport: opts.transport ?? nodeTransport,
    };
    const maxRedirects = Math.max(0, Math.min(MAX_REDIRECTS, opts.maxRedirects ?? MAX_REDIRECTS));

    let current = checkUrl(rawUrl);
    const redirects: string[] = [];
    for (let hop = 0; ; hop++) {
        const result = await fetchHop(current.url, current.host, ctx);
        if ('response' in result) return { ...result.response, redirects };
        if (hop >= maxRedirects) throw new SafeFetchError('too_many_redirects', 'The site redirects too many times.', { url: current.url.origin });
        let next: { url: URL; host: string };
        try {
            next = checkUrl(new URL(result.redirect, current.url).href);
        } catch (err) {
            if (isSafeFetchError(err) && err.kind === 'blocked_url') throw new SafeFetchError('blocked_url', 'The site redirects somewhere that cannot be read.', { urlReason: err.details.urlReason });
            throw new SafeFetchError('bad_redirect', 'The site redirects to an address that is not valid.', { url: current.url.origin });
        }
        if (current.url.protocol === 'https:' && next.url.protocol === 'http:') {
            throw new SafeFetchError('insecure_redirect', 'The site redirects from a secure address to an insecure one.', { url: current.url.origin });
        }
        redirects.push(next.url.href);
        current = next;
    }
}

// ─── A typed site ────────────────────────────────────────────────────────────────────────────

/** Why a connection can fail before anything is said: nobody listening, nobody answering, no route. A certificate that does not verify is not one of them. */
const CONNECT_FAILURES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']);

/** What a person typed as their site, as the addresses to try, https first (03 §1.1). */
export function siteUrlCandidates(input: string): string[] {
    const typed = input.trim();
    if (!typed) return [];
    if (/^https:\/\//i.test(typed)) return [typed];
    const bare = typed.replace(/^http:\/\//i, '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bare)) return [typed];
    return [`https://${bare}`, `http://${bare}`];
}

/**
 * `safeFetch` for a site the tenant typed: https first, and http only when https could not be reached
 * at all (nobody listening or answering). An address that was refused, a certificate that did not
 * verify or a site that answered is final: falling back to http would only be a way around the first answer.
 */
export async function safeFetchSite(input: string, opts: SafeFetchOptions): Promise<SafeFetchResponse> {
    const candidates = siteUrlCandidates(input);
    if (candidates.length === 0) throw new SafeFetchError('invalid_url', REFUSALS.invalid);
    let last: unknown;
    for (const candidate of candidates) {
        try {
            return await safeFetch(candidate, opts);
        } catch (err) {
            last = err;
            const unreachable = isSafeFetchError(err) && ((err.kind === 'network' && CONNECT_FAILURES.has(err.details.code ?? '')) || (err.kind === 'timeout' && err.details.scope === 'request'));
            if (!unreachable) break;
        }
    }
    throw last;
}
