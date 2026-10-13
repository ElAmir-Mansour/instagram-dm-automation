/**
 * What can go wrong with a model call, in one vocabulary for every provider
 * (docs/onboarding/06-ai-providers.md, "Error taxonomy").
 *
 * The caller's state machine decides what to do about each kind, so what matters here is that the
 * kind is right and that `retryable` says whether trying again can help. Retries are never made
 * inside a call: a retry belongs to whoever owns the budget and the deadline.
 *
 * An error's message is the provider's own explanation ("API key not valid") because that is the
 * useful part, but it is scrubbed of the key and anything shaped like one and capped at 240
 * characters before an `AiError` exists at all. A provider can echo the key back in its error
 * text, and that text ends up in logs, in `ai_usage` rows and in the Operations screen.
 */
import type { LogFields } from '../../utils/log.js';
import { providerName } from './registry.js';
import type { Billed, Usage } from './types.js';

export const AI_ERROR_KINDS = [
    'auth', 'quota', 'rate', 'bad_request', 'server', 'timeout', 'refusal', 'max_tokens', 'bad_output', 'budget', 'no_provider',
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

/**
 * Whether trying the same call again can succeed. `bad_output` is retryable *once*: the model
 * answered, just badly, and a second sample usually fixes it; a third rarely does. That limit is
 * the caller's to enforce, as every other retry decision is.
 */
export const RETRYABLE: Readonly<Record<AiErrorKind, boolean>> = {
    auth: false,
    quota: false,
    rate: true,
    bad_request: false,
    server: true,
    timeout: true,
    refusal: false,
    max_tokens: false,
    bad_output: true,
    budget: false,
    no_provider: false,
};

export const MAX_MESSAGE_CHARS = 240;

/**
 * Things that look like a credential even when we were not told the key: `sk-…` (OpenAI,
 * Anthropic `sk-ant-`, OpenRouter `sk-or-`), Google's `AIza…`, a bearer token, a key in a query
 * string or an echoed header, and any other long unbroken run of token characters (xAI, Groq and
 * the next provider's prefix). Providers that mask a key print stars in the middle
 * ("sk-proj-****abcd"), so stars count as part of one.
 */
const KEY_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
    [/([?&](?:key|api_key|apikey|access_token)=)[^&\s"'<>]+/gi, '$1[redacted]'],
    [/\b(x-api-key|x-goog-api-key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]'],
    [/\bsk-[A-Za-z0-9_*.-]{6,}/g, '[redacted]'],
    [/\bAIza[0-9A-Za-z_*-]{16,}/g, '[redacted]'],
    [/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]'],
];

/**
 * A message that is safe to store and show: the key removed (as given, and URL-encoded), anything
 * key-shaped removed, whitespace collapsed, at most 240 characters. The order matters: removing
 * comes before cutting, so a key straddling the cut cannot survive as a prefix.
 */
export function scrub(message: string, key?: string): string {
    let out = String(message);
    // Under four characters it is not a credential, and removing it would garble every word.
    if (key && key.length >= 4) {
        out = out.split(key).join('[key]');
        const encoded = encodeURIComponent(key);
        if (encoded !== key) out = out.split(encoded).join('[key]');
    }
    for (const [pattern, replacement] of KEY_SHAPES) out = out.replace(pattern, replacement);
    out = out.replace(/\s+/g, ' ').trim();
    return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS - 1)}…` : out;
}

export interface AiErrorInit {
    kind: AiErrorKind;
    provider: string;
    model: string;
    status?: number;
    message: string;
    /** The API key of the call, so its message can be scrubbed of it. */
    key?: string;
    /** Tokens the provider billed for a call that answered but was unusable (refused, cut off, malformed). */
    usage?: Usage;
    /** The same per model, for pricing; see `Billed`. */
    billed?: Billed[];
    /** How long the provider asked to be left alone, from `retry-after`. */
    retryAfterMs?: number;
}

export class AiError extends Error {
    readonly kind: AiErrorKind;
    /**
     * The same as `kind`, under the name `describeError` (utils/log.ts) looks for: it keeps `code`
     * and drops every other field of an Error, so without this a logged AiError would say what it
     * said but not what it was.
     */
    readonly code: AiErrorKind;
    readonly provider: string;
    readonly model: string;
    readonly status?: number;
    readonly retryable: boolean;
    /** Set when the provider answered and charged for an answer that could not be used; whoever records spend needs it. */
    readonly usage?: Usage;
    readonly billed?: Billed[];
    readonly retryAfterMs?: number;

    constructor(init: AiErrorInit) {
        // Scrubbed here, in the constructor, so no construction site can forget.
        super(scrub(init.message, init.key));
        this.name = 'AiError';
        this.kind = init.kind;
        this.code = init.kind;
        this.provider = init.provider;
        this.model = init.model;
        if (init.status !== undefined) this.status = init.status;
        this.retryable = RETRYABLE[init.kind];
        if (init.usage) this.usage = init.usage;
        if (init.billed) this.billed = init.billed;
        if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    }

    /** `message` is not enumerable on an Error, so without this `JSON.stringify(err)` — a log line — would drop the one field that explains it. */
    toJSON() {
        return {
            name: this.name, kind: this.kind, provider: this.provider, model: this.model,
            ...(this.status !== undefined ? { status: this.status } : {}), retryable: this.retryable,
            ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
            ...(this.usage ? { usage: this.usage } : {}), ...(this.billed ? { billed: this.billed } : {}), message: this.message,
        };
    }
}

export const isAiError = (err: unknown): err is AiError => err instanceof AiError;

/**
 * The fields to log for a failed call: `log('warn', 'llm.call_failed', aiErrorLogFields(err))`.
 * `describeError` keeps an Error's message, name and `code` and nothing else, so kind, status and
 * the rest travel as fields of their own; and none of these names contains "token", "key",
 * "secret" or any other word the logger redacts by name. Tokens are `in` and `out` for that reason.
 */
export function aiErrorLogFields(err: AiError): LogFields {
    return {
        err,
        kind: err.kind,
        provider: err.provider,
        model: err.model,
        status: err.status,
        retryable: err.retryable,
        retry_after_ms: err.retryAfterMs,
        in: err.usage?.in,
        out: err.usage?.out,
    };
}

// ─── Reading a provider's error ──────────────────────────────────────────────────────────────

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * A `retry-after` header as milliseconds: seconds ("30"), or an HTTP date. Anthropic and OpenAI
 * send seconds. Never more than a day, never negative, and nothing for a value that is neither.
 */
export function parseRetryAfter(raw: string | null | undefined, now: number = Date.now()): number | undefined {
    const text = raw?.trim();
    if (!text) return undefined;
    // Every HTTP-date spells out a weekday and a month. Without that check `Date.parse` takes "-5"
    // or "2026" for a date, and a nonsense header would read as "retry at once".
    const ms = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : /[a-z]{3}/i.test(text) ? Date.parse(text) - now : Number.NaN;
    return Number.isFinite(ms) ? Math.min(Math.max(Math.round(ms), 0), MAX_RETRY_AFTER_MS) : undefined;
}

/** Google's `RetryInfo.retryDelay`: "33s" or "0.5s". */
function retryDelayMs(details: unknown): number | undefined {
    if (!Array.isArray(details)) return undefined;
    for (const d of details) {
        const delay = typeof d?.['@type'] === 'string' && d['@type'].endsWith('RetryInfo') ? d.retryDelay : undefined;
        const m = typeof delay === 'string' ? delay.match(/^(\d+(?:\.\d+)?)s$/) : null;
        if (m) return Math.min(Math.round(Number(m[1]) * 1000), MAX_RETRY_AFTER_MS);
    }
    return undefined;
}

/**
 * The provider's explanation out of an error body, and the parsed body itself. Anthropic sends
 * `{type:'error', error:{type, message, details?}}`, OpenAI and OpenRouter `{error:{message,
 * code, type}}`, Gemini `{error:{code, message, status, details:[…]}}` (sometimes inside an
 * array), and a gateway may send a plain string or an HTML page.
 */
function explanation(bodyText: string): { message: string; tag: string; error: any } {
    const text = bodyText.trim();
    if (!text) return { message: '', tag: '', error: undefined };
    try {
        const data: any = JSON.parse(text);
        const root = Array.isArray(data) ? data[0] : data;
        const error = root?.error;
        if (typeof error === 'string') return { message: error, tag: '', error: undefined };
        const message = typeof error?.message === 'string' ? error.message : typeof root?.message === 'string' ? root.message : '';
        // `type`, `code` and `status` carry what the sentence may not say: OpenAI's
        // `insufficient_quota`, Anthropic's `billing_error`. They are matched on, not shown.
        const tag = [error?.type, error?.code, error?.status].filter((v) => typeof v === 'string').join(' ');
        if (message) return { message, tag, error };
    } catch {
        // Not JSON: fall through to the text itself.
    }
    // A markup page from a gateway is noise, not an explanation.
    return { message: text.startsWith('<') ? '' : text, tag: '', error: undefined };
}

/** Billing and spend trouble, as the words providers use for it. */
const QUOTA_WORDS = /insufficient_quota|quota|billing|credit balance|spend(?:ing)? limit|usage limits?/i;
/** Gemini answers a bad key with 400, not 401: "API key not valid", "API key expired". */
const BAD_KEY_WORDS = /api[ _-]?key[^.]{0,40}(?:not valid|invalid|expired|not found|missing)|(?:invalid|expired|missing)[^.]{0,20}api[ _-]?key/i;
/** A quota that comes back with the day or the month, not in a minute. */
const SLOW_QUOTA_ID = /Per(?:Day|Month)/i;
/** Providers whose 429 has no structure of its own to read, so its words are all there is. */
const WORDS_ONLY = new Set(['openai', 'openrouter', 'custom']);

/**
 * Whether a 429 is a limit that lifts by itself (`rate`) or one that does not (`quota`). A 429
 * means both, and the sentence cannot tell them apart: Gemini's per-minute limit and its daily
 * one both say "You exceeded your current quota", and Anthropic's spend cap is a
 * `rate_limit_error`. So the structure is read first and the words only where there is none:
 *
 *   - Gemini: `error.details[]` holds a `google.rpc.QuotaFailure` whose `violations[].quotaId`
 *     names the quota, for example `GenerateRequestsPerDayPerProjectPerModel-FreeTier`. Any
 *     per-day (or per-month) quota is `quota`; a per-minute one is `rate`.
 *   - Anthropic: `rate_limit_error` is `rate`, except `error.details.error_code ===
 *     'enforced_spend_limit_reached'` (the monthly cap, which sends no `retry-after`), which is
 *     `quota`.
 *   - OpenAI: `code`/`type` `insufficient_quota` is `quota`, `rate_limit_exceeded` is `rate`.
 *   - Anything else is `rate`, the retryable guess; only OpenAI-compatible endpoints, whose words
 *     are unambiguous, are also read by them.
 */
function classify429(provider: string, error: any, heard: string): 'quota' | 'rate' {
    const details = error?.details;
    if (Array.isArray(details)) {
        const ids = details
            .filter((d: any) => typeof d?.['@type'] === 'string' && d['@type'].endsWith('QuotaFailure'))
            .flatMap((d: any) => (Array.isArray(d.violations) ? d.violations : []))
            .map((v: any) => v?.quotaId)
            .filter((id: unknown): id is string => typeof id === 'string');
        if (ids.length) return ids.some((id) => SLOW_QUOTA_ID.test(id)) ? 'quota' : 'rate';
    } else if (details && typeof details === 'object' && details.error_code === 'enforced_spend_limit_reached') {
        return 'quota';
    }
    const codes = [error?.type, error?.code];
    if (codes.includes('insufficient_quota')) return 'quota';
    if (codes.includes('rate_limit_error') || codes.includes('rate_limit_exceeded')) return 'rate';
    return WORDS_ONLY.has(provider) && QUOTA_WORDS.test(heard) ? 'quota' : 'rate';
}

export interface HttpErrorOptions {
    /** The API key of the call, so the message can be scrubbed of it. */
    key?: string;
    /** The `retry-after` response header, as it came. */
    retryAfter?: string | null;
}

/**
 * An HTTP failure as an `AiError`. `bodyText` is the response body, already read, so this is
 * pure and every row of the table is testable without a fetch.
 *
 *   401, 403, Gemini's 400 "API key not valid"            → auth      (final)
 *   402, a 429 that does not lift by itself, a 400 that
 *   speaks of credit or a spend limit                      → quota     (final)
 *   any other 429 (see `classify429`)                      → rate      (retryable)
 *   400, 404, 413, 422 and other 4xx, and a redirect       → bad_request (final)
 *   408                                                    → timeout   (retryable)
 *   5xx, including Anthropic's 529                         → server    (retryable)
 *
 * Anthropic reports an empty credit balance or a spend limit the operator set as a plain 400,
 * which is why a 400 is looked at for those words too; every other 400 is the request's own fault.
 */
export function errorFromHttp(provider: string, model: string, status: number, bodyText: string, opts: HttpErrorOptions = {}): AiError {
    const { message: said, tag, error } = explanation(bodyText);
    const message = said || `${providerName(provider)} returned ${status}.`;
    const heard = `${tag} ${said}`;

    let kind: AiErrorKind;
    if (status === 401 || status === 403) kind = 'auth';
    else if (status === 402) kind = 'quota';
    else if (status === 429) kind = classify429(provider, error, heard);
    else if (status === 400 && BAD_KEY_WORDS.test(said)) kind = 'auth';
    else if (status === 400 && QUOTA_WORDS.test(heard)) kind = 'quota';
    else if (status === 408) kind = 'timeout';
    else if (status >= 500) kind = 'server';
    else kind = 'bad_request';

    // Waiting only helps a limit that lifts: Anthropic's spend cap sends no header, and a daily
    // quota's RetryInfo is a few seconds that mean nothing.
    const waits = kind === 'rate' || kind === 'server' || kind === 'timeout';
    const retryAfterMs = waits ? (parseRetryAfter(opts.retryAfter) ?? (kind === 'rate' ? retryDelayMs(error?.details) : undefined)) : undefined;

    return new AiError({ kind, provider, model, status, message, key: opts.key, retryAfterMs });
}
