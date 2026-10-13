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
import { providerName } from './registry.js';
import type { Usage } from './types.js';

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
}

export class AiError extends Error {
    readonly kind: AiErrorKind;
    readonly provider: string;
    readonly model: string;
    readonly status?: number;
    readonly retryable: boolean;
    /** Set when the provider answered and charged for an answer that could not be used; whoever records spend needs it. */
    readonly usage?: Usage;

    constructor(init: AiErrorInit) {
        // Scrubbed here, in the constructor, so no construction site can forget to.
        super(scrub(init.message, init.key));
        this.name = 'AiError';
        this.kind = init.kind;
        this.provider = init.provider;
        this.model = init.model;
        if (init.status !== undefined) this.status = init.status;
        if (init.usage) this.usage = init.usage;
        this.retryable = RETRYABLE[init.kind];
    }

    /** `message` is not enumerable on an Error, so without this `JSON.stringify(err)` — a log line — would drop the one field that explains it. */
    toJSON() {
        return {
            name: this.name, kind: this.kind, provider: this.provider, model: this.model,
            ...(this.status !== undefined ? { status: this.status } : {}), retryable: this.retryable,
            ...(this.usage ? { usage: this.usage } : {}), message: this.message,
        };
    }
}

export const isAiError = (err: unknown): err is AiError => err instanceof AiError;

/**
 * The provider's explanation out of an error body. Anthropic sends `{type:'error', error:{type,
 * message}}`, OpenAI and OpenRouter `{error:{message, code}}`, Gemini `{error:{code, message,
 * status}}` (sometimes inside an array), and a gateway may send a plain string or an HTML page.
 */
function explanation(bodyText: string): { message: string; tag: string } {
    const text = bodyText.trim();
    if (!text) return { message: '', tag: '' };
    try {
        const data: any = JSON.parse(text);
        const root = Array.isArray(data) ? data[0] : data;
        const error = root?.error;
        if (typeof error === 'string') return { message: error, tag: '' };
        const message = typeof error?.message === 'string' ? error.message : typeof root?.message === 'string' ? root.message : '';
        // `type` and `code` carry what the sentence may not say: OpenAI's `insufficient_quota`,
        // Anthropic's `billing_error`. They are matched on, not shown.
        const tag = [error?.type, error?.code, error?.status].filter((v) => typeof v === 'string').join(' ');
        if (message) return { message, tag };
    } catch {
        // Not JSON: fall through to the text itself.
    }
    // A markup page from a gateway is noise, not an explanation.
    return { message: text.startsWith('<') ? '' : text, tag: '' };
}

/** Billing and spend trouble, as the words providers use for it. */
const QUOTA_WORDS = /insufficient_quota|quota|billing|credit balance|spend(?:ing)? limit|usage limits?/i;
/** Gemini answers a bad key with 400, not 401: "API key not valid", "API key expired". */
const BAD_KEY_WORDS = /api[ _-]?key[^.]{0,40}(?:not valid|invalid|expired|not found|missing)|(?:invalid|expired|missing)[^.]{0,20}api[ _-]?key/i;

/**
 * An HTTP failure as an `AiError`. `bodyText` is the response body, already read, so this is
 * pure and every row of the table is testable without a fetch.
 *
 *   401, 403, Gemini's 400 "API key not valid"            → auth      (final)
 *   402, a 429 or 400 that speaks of quota or billing      → quota     (final)
 *   any other 429                                          → rate      (retryable)
 *   400, 404, 413, 422 and other 4xx                       → bad_request (final)
 *   408                                                    → timeout   (retryable)
 *   5xx, including Anthropic's 529                         → server    (retryable)
 *
 * Anthropic reports a spent workspace limit or an empty credit balance as a plain 400, which is
 * why a 400 is looked at for quota words too; every other 400 is the request's own fault.
 */
export function errorFromHttp(provider: string, model: string, status: number, bodyText: string, key?: string): AiError {
    const { message: said, tag } = explanation(bodyText);
    const message = said || `${providerName(provider)} returned ${status}.`;
    const heard = `${tag} ${said}`;

    let kind: AiErrorKind;
    if (status === 401 || status === 403) kind = 'auth';
    else if (status === 402) kind = 'quota';
    else if (status === 429) kind = QUOTA_WORDS.test(heard) ? 'quota' : 'rate';
    else if (status === 400 && BAD_KEY_WORDS.test(said)) kind = 'auth';
    else if (status === 400 && QUOTA_WORDS.test(heard)) kind = 'quota';
    else if (status === 408) kind = 'timeout';
    else if (status >= 500) kind = 'server';
    else kind = 'bad_request';

    return new AiError({ kind, provider, model, status, message, key });
}
