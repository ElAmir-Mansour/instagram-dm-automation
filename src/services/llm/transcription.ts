/**
 * Speech to text over an OpenAI-compatible `/audio/transcriptions` endpoint (docs/specs/001-whatsapp-agent T034, research R6).
 *
 * A call apart from `generateJson` on purpose. The chat adapters speak JSON and filter speech models OUT of every model list
 * (`chatCompletions.ts`: `GROQ_NOT_CHAT` drops `whisper`), because a speech model cannot do a chat model's job; this file is the one
 * place that sends audio, and nothing here is reachable from a chat route.
 *
 * The request, as Groq documents it (https://console.groq.com/docs/speech-to-text, read 2026-10-19), which OpenAI's own endpoint
 * shares:
 *
 *   POST {base}/audio/transcriptions        base = https://api.groq.com/openai/v1
 *   Authorization: Bearer <key>             the key travels in this header only, never in a URL
 *   multipart/form-data:
 *     file             the audio; required unless `url` is used. Listed types: flac mp3 mp4 mpeg mpga m4a ogg wav webm
 *     model            required: `whisper-large-v3-turbo` (multilingual, transcription only, ~$0.04/hour) or `whisper-large-v3`
 *     language         optional ISO-639-1 code; improves accuracy and latency
 *     response_format  `json` (default: `{ "text": "..." }`), `verbose_json` or `text`
 *     temperature      0 to 1, default 0
 *   Limits: 25 MB a file on the free tier (100 MB on the dev tier), billed at a 10 s minimum. The page does not name the encoding
 *   (it is multipart, as OpenAI's is), documents no `x_groq` usage field, and gives `duration` only on `verbose_json`, so `durationMs`
 *   is read when an answer carries one and is otherwise absent.
 *
 * Same rules as `adapters/post.ts`: raw `fetch` (an axios error carries the request, and the request carries the key), redirects
 * refused (a 307 must never carry the key's header to another address), a deadline on every call, no retry inside it, and every
 * failure an `AiError` whose message is scrubbed of the key before it exists. A failure never carries the audio.
 */
import { AiError, errorFromHttp } from './errors.js';
import { providerById, providerName, type ProviderId } from './registry.js';
import type { FetchLike } from './types.js';

/** A voice note is seconds long and the turn it opens is waiting on it: past this the caller asks the customer to type. */
export const TRANSCRIPTION_TIMEOUT_MS = 20_000;

export interface TranscriptionArgs {
    /** Which provider, for errors. Its registry entry gives the base URL. */
    provider: ProviderId;
    apiKey: string;
    /** A speech model id, `whisper-large-v3-turbo`. Never a chat model. */
    model: string;
    audio: Uint8Array;
    /** The audio's own type without parameters (`audio/ogg`), as the `file` part is labelled. */
    mimeType: string;
    /** The file name Groq reads the format from: `voice.ogg`. */
    filename: string;
    /** ISO-639-1, `ar` for this audience. */
    language?: string;
    /** For a test: the deadline. */
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}

export interface TranscriptionResult {
    /** What was said. Empty for silence: the caller decides what that means. */
    text: string;
    /** From the answer's `duration` (seconds), when it carries one: `json` does not. */
    durationMs?: number;
    model: string;
}

/** The URL of the transcription endpoint of a provider that speaks the OpenAI shape. */
export function transcriptionUrl(provider: ProviderId): string {
    const base = providerById(provider)?.baseUrl;
    if (!base) throw new AiError({ kind: 'bad_request', provider, model: '', message: `${providerName(provider)} has no transcription endpoint.` });
    return `${base.replace(/\/+$/, '')}/audio/transcriptions`;
}

const isAbort = (err: unknown, signal?: AbortSignal): boolean => {
    const name = (err as { name?: string } | null)?.name;
    return signal?.aborted === true || name === 'AbortError' || name === 'TimeoutError';
};

/**
 * Sends the audio and returns the text. Every other outcome is an `AiError`: the deadline or a network failure is `timeout`, a
 * redirect is `bad_request`, an HTTP error is `errorFromHttp`'s (401/403 `auth`, 429 `rate`, 5xx `server`, ...), an answer that is
 * not JSON with a `text` is `bad_output`. Never retries.
 */
export async function transcribeWithProvider(args: TranscriptionArgs): Promise<TranscriptionResult> {
    const { provider, apiKey: key, model } = args;
    const name = providerName(provider);
    const fail = (kind: ConstructorParameters<typeof AiError>[0]['kind'], message: string, status?: number) =>
        new AiError({ kind, provider, model, status, message, key });

    const url = transcriptionUrl(provider);
    const form = new FormData();
    // Copied into a fresh ArrayBuffer: a Buffer from the media store may be a view into a pooled slab, and a Blob must hold exactly these bytes.
    form.append('file', new Blob([new Uint8Array(args.audio)], { type: args.mimeType }), args.filename);
    form.append('model', model);
    if (args.language) form.append('language', args.language);
    form.append('response_format', 'json');
    form.append('temperature', '0');

    const deadline = AbortSignal.timeout(args.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS);
    const signal = args.signal ? AbortSignal.any([args.signal, deadline]) : deadline;
    const doFetch: FetchLike = args.fetchImpl ?? ((input, init) => fetch(input, init));

    let res: Response;
    try {
        res = await doFetch(url, {
            method: 'POST',
            // No content-type: `fetch` sets multipart/form-data with its boundary from the body.
            headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
            body: form,
            signal,
            redirect: 'error',
        });
    } catch (err) {
        const redirected = /redirect/i.test(String((err as { cause?: { message?: unknown } })?.cause?.message ?? '')) || /redirect/i.test(String((err as Error)?.message ?? ''));
        if (redirected) throw fail('bad_request', `${name} answered with a redirect, which is refused so that the API key is never sent to another address.`);
        throw isAbort(err, signal) ? fail('timeout', `${name} did not transcribe in time.`) : fail('timeout', `Could not reach ${name}.`);
    }
    if (res.status >= 300 && res.status < 400) {
        throw fail('bad_request', `${name} answered with a redirect, which is refused so that the API key is never sent to another address.`, res.status);
    }

    let text: string;
    try {
        text = await res.text();
    } catch (err) {
        throw isAbort(err, signal)
            ? fail('timeout', `${name} did not finish answering in time.`, res.status)
            : fail('timeout', `The connection to ${name} dropped mid-answer.`, res.status);
    }
    if (!res.ok) throw errorFromHttp(provider, model, res.status, text, { key, retryAfter: res.headers.get('retry-after') });

    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        throw fail('bad_output', `${name} answered with something that is not JSON.`, res.status);
    }
    const said = (body as { text?: unknown } | null)?.text;
    if (typeof said !== 'string') throw fail('bad_output', `${name} answered without a transcript.`, res.status);

    const seconds = (body as { duration?: unknown }).duration;
    return {
        text: said.trim(),
        model,
        ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? { durationMs: Math.round(seconds * 1000) } : {}),
    };
}
