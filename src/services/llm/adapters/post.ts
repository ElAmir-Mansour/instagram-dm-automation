/**
 * The one place a model request leaves this process, shared by every adapter: `postJson` for a
 * call, `getJson` for a model list or a key check.
 *
 * Raw `fetch` rather than axios or an SDK, on purpose: an axios error carries its request config,
 * and that config holds the API key (`geminiKey.ts` works around it by never logging one). A
 * `fetch` failure carries nothing of the request, so there is nothing to leak and nothing to
 * remember to strip. An SDK would add a retry loop (`maxRetries: 0` by construction here) and a
 * second error vocabulary to map. The key is only ever put in `headers`, by the adapter, never in
 * a URL: a URL lands in logs and error reports.
 *
 * Redirects are refused (`redirect: 'error'`). `fetch` follows them by default, and when a
 * redirect leaves the origin it drops `Authorization` but forwards every other header, so an
 * `x-api-key` or `x-goog-api-key` would go along to wherever a 307 pointed. A provider API has no
 * reason to redirect a POST or a GET; one that does is misconfigured or is not the provider.
 */
import { AiError, errorFromHttp, type AiErrorKind } from '../errors.js';
import { providerName } from '../registry.js';
import type { FetchLike } from '../types.js';

export interface PostArgs {
    provider: string;
    model: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
    /** For scrubbing error text; it is not sent from here. */
    key: string;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}

/** A GET: no body. `model` is what an error names, and a list or a key check has none, so callers pass ''. */
export type GetArgs = Omit<PostArgs, 'body'>;

/** The deadline firing (`TimeoutError` from `AbortSignal.timeout`) or a caller's abort. */
function isAbort(err: unknown, signal?: AbortSignal): boolean {
    const name = (err as { name?: string } | null)?.name;
    return signal?.aborted === true || name === 'AbortError' || name === 'TimeoutError';
}

/** Node's fetch reports a refused redirect as `TypeError: fetch failed`, `cause: Error: unexpected redirect`. */
function isRedirectRefusal(err: unknown): boolean {
    const e = err as { message?: unknown; cause?: { message?: unknown } } | null;
    return /redirect/i.test(String(e?.cause?.message ?? '')) || /redirect/i.test(String(e?.message ?? ''));
}

/** `ENOTFOUND`, `ECONNRESET`: what undici says in `cause`, and the one part of a network error worth keeping. */
function networkCode(err: unknown): string {
    const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
    const code = e?.cause?.code ?? e?.code;
    return typeof code === 'string' ? ` (${code})` : '';
}

/**
 * Sends one request and returns the parsed 2xx body. Every other outcome is an `AiError`: a
 * network failure or the deadline is `timeout`, a redirect is `bad_request`, an HTTP error is
 * `errorFromHttp`'s, a 2xx that is not JSON (a gateway's HTML page) is `bad_output`. Never retries.
 */
async function send(a: PostArgs | GetArgs, method: 'POST' | 'GET'): Promise<unknown> {
    const name = providerName(a.provider);
    const fail = (kind: AiErrorKind, message: string, status?: number) =>
        new AiError({ kind, provider: a.provider, model: a.model, status, message, key: a.key });
    const redirected = (status?: number) =>
        fail('bad_request', `${name} answered with a redirect, which is refused so that the API key is never sent to another address.`, status);
    const doFetch: FetchLike = a.fetchImpl ?? ((url, init) => fetch(url, init));

    let res: Response;
    try {
        res = await doFetch(a.url, {
            method,
            // A GET has no body, so it has no content type either.
            headers: method === 'POST' ? { 'content-type': 'application/json', ...a.headers } : { accept: 'application/json', ...a.headers },
            ...(method === 'POST' ? { body: JSON.stringify((a as PostArgs).body) } : {}),
            signal: a.signal,
            redirect: 'error',
        });
    } catch (err) {
        if (isRedirectRefusal(err)) throw redirected();
        throw isAbort(err, a.signal) ? fail('timeout', `${name} did not answer in time.`) : fail('timeout', `Could not reach ${name}${networkCode(err)}.`);
    }

    // `redirect: 'error'` makes a real fetch throw, but a stand-in for one need not.
    if (res.status >= 300 && res.status < 400) throw redirected(res.status);

    let text: string;
    try {
        text = await res.text();
    } catch (err) {
        throw isAbort(err, a.signal)
            ? fail('timeout', `${name} did not finish answering in time.`, res.status)
            : fail('timeout', `The connection to ${name} dropped mid-answer${networkCode(err)}.`, res.status);
    }

    if (!res.ok) throw errorFromHttp(a.provider, a.model, res.status, text, { key: a.key, retryAfter: res.headers.get('retry-after') });

    try {
        return JSON.parse(text);
    } catch {
        throw fail('bad_output', `${name} answered with something that is not JSON.`, res.status);
    }
}

/** POSTs JSON and returns the parsed 2xx body (see `send`). */
export const postJson = (a: PostArgs): Promise<unknown> => send(a, 'POST');

/**
 * GETs JSON, the same way and under the same rules: the model lists and key checks of every
 * provider. The key still goes in `headers` only, and `redirect: 'error'` still applies, which
 * matters most here: a Custom endpoint's address is typed by someone.
 */
export const getJson = (a: GetArgs): Promise<unknown> => send(a, 'GET');
