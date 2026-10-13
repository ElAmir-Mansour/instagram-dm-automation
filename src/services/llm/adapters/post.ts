/**
 * The one place a model request leaves this process, shared by every adapter.
 *
 * Raw `fetch` rather than axios or an SDK, on purpose: an axios error carries its request config,
 * and that config holds the API key (`geminiKey.ts` works around it by never logging one). A
 * `fetch` failure carries nothing of the request, so there is nothing to leak and nothing to
 * remember to strip. An SDK would add a retry loop (`maxRetries: 0` by construction here) and a
 * second error vocabulary to map. The key is only ever put in `headers`, by the adapter, never in
 * a URL: a URL lands in logs and error reports.
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

/** The deadline firing (`TimeoutError` from `AbortSignal.timeout`) or a caller's abort. */
function isAbort(err: unknown, signal?: AbortSignal): boolean {
    const name = (err as { name?: string } | null)?.name;
    return signal?.aborted === true || name === 'AbortError' || name === 'TimeoutError';
}

/** `ENOTFOUND`, `ECONNRESET`: what undici says in `cause`, and the one part of a network error worth keeping. */
function networkCode(err: unknown): string {
    const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
    const code = e?.cause?.code ?? e?.code;
    return typeof code === 'string' ? ` (${code})` : '';
}

/**
 * POSTs JSON and returns the parsed 2xx body. Every other outcome is an `AiError`: a network
 * failure or the deadline is `timeout`, an HTTP error is `errorFromHttp`'s, a 2xx that is not JSON
 * (a gateway's HTML page) is `bad_output`. Never retries.
 */
export async function postJson(a: PostArgs): Promise<unknown> {
    const name = providerName(a.provider);
    const fail = (kind: AiErrorKind, message: string, status?: number) =>
        new AiError({ kind, provider: a.provider, model: a.model, status, message, key: a.key });
    const doFetch: FetchLike = a.fetchImpl ?? ((url, init) => fetch(url, init));

    let res: Response;
    try {
        res = await doFetch(a.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...a.headers },
            body: JSON.stringify(a.body),
            signal: a.signal,
        });
    } catch (err) {
        throw isAbort(err, a.signal) ? fail('timeout', `${name} did not answer in time.`) : fail('timeout', `Could not reach ${name}${networkCode(err)}.`);
    }

    let text: string;
    try {
        text = await res.text();
    } catch (err) {
        throw isAbort(err, a.signal)
            ? fail('timeout', `${name} did not finish answering in time.`, res.status)
            : fail('timeout', `The connection to ${name} dropped mid-answer${networkCode(err)}.`, res.status);
    }

    if (!res.ok) throw errorFromHttp(a.provider, a.model, res.status, text, a.key);

    try {
        return JSON.parse(text);
    } catch {
        throw fail('bad_output', `${name} answered with something that is not JSON.`, res.status);
    }
}
