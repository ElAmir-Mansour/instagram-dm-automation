/**
 * Meta's speech-to-text, the client (docs/specs/005-muse-sees T048, contracts/perception.md §2): one WAV in, a transcript out.
 *
 * `POST https://api.meta.ai/v1/asr/transcribe`, `multipart/form-data` (dev.meta.ai/docs/api-reference/voice/transcribe and /speech-to-text, read 2026-10-31):
 *
 *   request   `application/json`, no filename: `{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","languageBias":["Arabic","English"],"keywords":[…]}`.
 *             `model` and `audioEncoding` are required (`WAV` is the only encoding); `languageBias` is a list of language NAMES that steers recognition without
 *             forcing a language, and `keywords` a list of terms (product names, people, acronyms) to bias it toward, "not a guarantee of spelling". Both are
 *             optional; the docs give no count or length limit for either, so at most `ASR_MAX_KEYWORDS` (20) go out, and `keywords` is left out when there are none.
 *   audio     `audio/wav`: RIFF/WAVE, mono, 16-bit integer PCM at 16 or 24 kHz (`wav.ts`), at most 10 minutes and 32 MB. Anything else is a 400.
 *   answer    `{ sessionId, transcript, audioDurationMs, turns }`: `transcript` is the whole clip (`turns` is empty in the default PUSH_TO_TALK mode, which is the
 *             one used), `audioDurationMs` what Meta processed, `sessionId` "the only correlation handle for a support request", so it is returned for the log.
 *   price     $0.18 an hour of audio, metered in whole seconds rounded down (dev.meta.ai/docs/pricing-rate-limits); a request that fails before it produces a
 *             transcript is not billed. There is no Contributor mode for this model, so what is sent here is never offered for training.
 *   limits    No requests-per-minute limit; 256 concurrent streams and 16,000 an hour (a 429 beyond them: "retry with exponential backoff").
 *
 * The body is built BY HAND (`buildMultipart`) and not with `FormData`: `FormData.append(name, blob)` labels a part `filename="blob"` and a string part carries no
 * `Content-Type`, and the one shape tried live (2026-10-28, `scripts/meta-probe.mjs`) is a JSON part with its type and NO filename beside a file part. This sends
 * those bytes, and `metaAsr.test.ts` holds them equal to the probe's own builder.
 *
 * Same rules as `adapters/post.ts` and `transcription.ts`, which this sits beside: raw `fetch` (an axios error carries the request, and the request carries the
 * key), the key in the `Authorization` header and nowhere else, redirects refused (a 307 must never carry the header to another address), a deadline on the
 * call, no retry inside it (the caller owns the step's budget), and every failure an `AiError` whose message is scrubbed of the key before it exists. A failure
 * never carries the audio. A WAV that is not what the endpoint takes is `bad_request` BEFORE any request: the caller's fault, and never different next time.
 *
 * This file keeps to `llm/`'s rule (`schema.test.ts`): no database, no settings. The key is an argument; where it comes from, and the `ai_usage` row, are
 * `aiProviders/asr.ts`'s.
 */
import { randomBytes } from 'node:crypto';
import { AiError, errorFromHttp, type AiErrorKind } from './errors.js';
import { providerById, providerName } from './registry.js';
import type { FetchLike } from './types.js';
import { isAsrWav, parseWav } from './wav.js';

export const ASR_PROVIDER = 'meta' as const;
export const ASR_MODEL = 'muse-voice-transcribe-1.0';

/** A voice note is seconds long and the turn it opens is waiting on it (measured 2026-10-28: about 3 s for a short one). */
export const ASR_TIMEOUT_MS = 30_000;

/** What an hour of audio costs (Standard mode; the model has no other). */
export const ASR_USD_PER_HOUR = 0.18;

/** The languages this audience speaks, by the names the endpoint reads. A hint: it does not force one, and it finds a note that mixes both. */
export const ASR_LANGUAGE_BIAS: readonly string[] = Object.freeze(['Arabic', 'English']);

/** The most terms sent to bias recognition. */
export const ASR_MAX_KEYWORDS = 20;

/**
 * What `ms` of audio costs, in dollars: `ms / 3,600,000 × $0.18`, to the billionth (the precision of `cost.ts`, so that the tiny sums `ai_usage` adds up carry no
 * floating-point noise). Meta meters whole seconds rounded DOWN, so this is at most one second's cost (about $0.00005) above the invoice: over-counting is the
 * safe side of a budget. Not a number, or negative, is free.
 */
export function asrUsd(ms: number): number {
    const audioMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    return Math.round((audioMs / 3_600_000) * ASR_USD_PER_HOUR * 1e9) / 1e9;
}

/** Where the call goes: the registry's address for Meta, always (nothing here takes a base URL: a typed one is a place to send the key). */
export function asrUrl(): string {
    const base = providerById(ASR_PROVIDER)?.baseUrl;
    if (!base) throw new AiError({ kind: 'bad_request', provider: ASR_PROVIDER, model: ASR_MODEL, message: 'Meta has no address in the provider registry.' });
    return `${base.replace(/\/+$/, '')}/asr/transcribe`;
}

export interface AsrRequest {
    model: string;
    audioEncoding: 'WAV';
    languageBias: string[];
    keywords?: string[];
}

/** The `request` part, in the key order of the contract and of the live probe. Terms are trimmed, empty ones dropped, and no more than `ASR_MAX_KEYWORDS` kept. Pure. */
export function buildAsrRequest(keywords: readonly string[] = []): AsrRequest {
    const terms = keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean).slice(0, ASR_MAX_KEYWORDS);
    return { model: ASR_MODEL, audioEncoding: 'WAV', languageBias: [...ASR_LANGUAGE_BIAS], ...(terms.length ? { keywords: terms } : {}) };
}

export interface MultipartPart {
    name: string;
    /** Only a file part has one. */
    filename?: string;
    type: string;
    data: Uint8Array | string;
}

/**
 * A `multipart/form-data` body, byte for byte what `scripts/meta-probe.mjs` `multipart()` writes: each part is `--boundary`, a `Content-Disposition` (with a
 * `filename` only when the part has one), a `Content-Type`, a blank line, the data, and a line break; then `--boundary--`. The boundary is random per request.
 */
export function buildMultipart(parts: readonly MultipartPart[], boundary: string = `autoreply${randomBytes(12).toString('hex')}`): { boundary: string; contentType: string; body: Buffer } {
    const chunks: Buffer[] = [];
    for (const { name, filename, type, data } of parts) {
        const disposition = `form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}`;
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${type}\r\n\r\n`));
        // A view of the bytes, not a copy: `Buffer.concat` below is the one copy.
        chunks.push(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { boundary, contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

export interface AsrArgs {
    /** Meta's key. It goes in the `Authorization` header and nowhere else. */
    apiKey: string;
    /** RIFF/WAVE, mono, 16-bit PCM, 16 or 24 kHz (`perception/transcode.ts` makes it). */
    wav: Uint8Array;
    /** Offer, course and brand names, to bias recognition toward (`perception/keywords.ts`). */
    keywords?: readonly string[];
    /** For a test: the deadline, and a boundary that does not change. */
    timeoutMs?: number;
    boundary?: string;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}

export interface AsrResult {
    /** Trimmed. Empty for silence, or for noise the model could not make words of: the caller decides what that means. */
    transcript: string;
    /** What Meta says it processed, in milliseconds; the length of the WAV we sent when the answer does not say. */
    durationMs: number;
    model: string;
    /** Meta's correlation id for the request, for a support ticket: logged, never shown. */
    sessionId?: string;
}

const isAbort = (err: unknown, signal?: AbortSignal): boolean => {
    const name = (err as { name?: string } | null)?.name;
    return signal?.aborted === true || name === 'AbortError' || name === 'TimeoutError';
};

/** What a session id may look like for it to be worth logging: Meta's own, as an opaque short token. */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * Sends the WAV and returns what was said. Every other outcome is an `AiError`:
 *
 *   no key                           `no_provider`
 *   a WAV the endpoint will not take `bad_request`, before any request
 *   the deadline, or no connection   `timeout`
 *   a redirect                       `bad_request` (refused: the key is never sent to another address)
 *   an HTTP error                    `errorFromHttp`'s: 401/403 `auth`, 429 `rate`, other 4xx (a 400, a 413) `bad_request`, 5xx `server`
 *   a 200 that is not JSON, or has no `transcript`   `bad_output`
 *
 * Never retries.
 */
export async function callMetaAsr(args: AsrArgs): Promise<AsrResult> {
    const key = (args.apiKey ?? '').trim();
    const name = providerName(ASR_PROVIDER);
    const fail = (kind: AiErrorKind, message: string, status?: number): AiError => new AiError({ kind, provider: ASR_PROVIDER, model: ASR_MODEL, status, message, key });

    if (!key) throw fail('no_provider', `No API key is saved for ${name}.`);
    const wav = parseWav(args.wav);
    if (!wav.ok || !isAsrWav(wav.info)) {
        throw fail('bad_request', `${name}'s speech model takes a WAV file of mono 16-bit PCM audio at 16 or 24 kHz, and this is not one.`);
    }

    const { contentType, body } = buildMultipart([
        { name: 'request', type: 'application/json', data: JSON.stringify(buildAsrRequest(args.keywords)) },
        { name: 'audio', filename: 'voice.wav', type: 'audio/wav', data: args.wav },
    ], args.boundary);

    const deadline = AbortSignal.timeout(args.timeoutMs ?? ASR_TIMEOUT_MS);
    const signal = args.signal ? AbortSignal.any([args.signal, deadline]) : deadline;
    const doFetch: FetchLike = args.fetchImpl ?? ((input, init) => fetch(input, init));
    const redirected = (status?: number): AiError => fail('bad_request', `${name} answered with a redirect, which is refused so that the API key is never sent to another address.`, status);

    let res: Response;
    try {
        res = await doFetch(asrUrl(), {
            method: 'POST',
            // The content type is the multipart one WITH its boundary: `fetch` would set it from a `FormData`, and a raw body has to say it.
            headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': contentType },
            body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
            signal,
            redirect: 'error',
        });
    } catch (err) {
        const redirect = /redirect/i.test(String((err as { cause?: { message?: unknown } })?.cause?.message ?? '')) || /redirect/i.test(String((err as Error)?.message ?? ''));
        if (redirect) throw redirected();
        throw isAbort(err, signal) ? fail('timeout', `${name} did not transcribe in time.`) : fail('timeout', `Could not reach ${name}.`);
    }
    // `redirect: 'error'` makes a real fetch throw, but a stand-in for one need not.
    if (res.status >= 300 && res.status < 400) throw redirected(res.status);

    let text: string;
    try {
        text = await res.text();
    } catch (err) {
        throw isAbort(err, signal)
            ? fail('timeout', `${name} did not finish answering in time.`, res.status)
            : fail('timeout', `The connection to ${name} dropped mid-answer.`, res.status);
    }
    if (!res.ok) throw errorFromHttp(ASR_PROVIDER, ASR_MODEL, res.status, text, { key, retryAfter: res.headers.get('retry-after') });

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw fail('bad_output', `${name} answered with something that is not JSON.`, res.status);
    }
    const answer = (parsed && typeof parsed === 'object' ? parsed : {}) as { transcript?: unknown; audioDurationMs?: unknown; sessionId?: unknown };
    if (typeof answer.transcript !== 'string') throw fail('bad_output', `${name} answered without a transcript.`, res.status);

    const reported = answer.audioDurationMs;
    return {
        transcript: answer.transcript.trim(),
        durationMs: typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 ? Math.round(reported) : wav.info.durationMs,
        model: ASR_MODEL,
        ...(typeof answer.sessionId === 'string' && SESSION_ID.test(answer.sessionId) ? { sessionId: answer.sessionId } : {}),
    };
}
