/**
 * What can go wrong with a draft source that is read from a platform (Instagram, YouTube), in one vocabulary
 * (docs/onboarding/03 §1). The draft's state machine decides what to do about each kind, so what matters here
 * is that the kind is right and that `retryable` says whether trying the same read again can help; a retry is
 * never made inside a source, it belongs to whoever owns the budget and the deadline.
 *
 * A source returns a `SourceResult`, it does not throw for a platform that says no: one failed source is one
 * line of `sources_status`, and the others still land. The message is for an operator and the log ("what did
 * Meta say"); the wizard shows its own words for each kind. Every message is scrubbed of the credentials the
 * call used and of anything shaped like one before an error exists, because a platform can echo a token back
 * in its error text and that text ends up in logs, in the draft's `sources_status` and on the Operations screen.
 *
 * Pure.
 */
import { scrub } from '../llm/errors.js';

export const SOURCE_ERROR_KINDS = [
    /** The handle typed cannot be a username on the platform: nothing was asked of it. */
    'invalid_handle',
    /** The platform has no such account or channel. */
    'not_found',
    /** Instagram would not show this account: it does not exist, is private, or is a personal account (Meta answers all three with code 110). */
    'not_readable',
    /** The account answered but Business Discovery returned no profile for it (age-restricted accounts do this). */
    'age_gated',
    /** The platform is throttling us: Meta's rate-limit codes, a 429, or a usage header near the ceiling. */
    'rate_limited',
    /** A daily quota is spent (YouTube's 10,000 units): trying again in a minute is pointless. */
    'quota',
    /** The credential used cannot read this: a dead or under-privileged token, a rejected or restricted API key. */
    'no_access',
    /** There is nothing to read with: no discovery account connected, no API key saved. The source is skipped. */
    'not_configured',
    /** Our request was refused as malformed (an unknown field, a changed API): a bug to fix, not to retry. */
    'bad_request',
    /** The platform failed: a 5xx, a timeout, a connection that never completed. */
    'upstream',
    /** The platform answered 200 with something that is not what its documentation says. */
    'bad_response',
] as const;
export type SourceErrorKind = (typeof SOURCE_ERROR_KINDS)[number];

/** Whether the same read can succeed later (03 §4: network errors, 429, 5xx and timeouts are retried; the rest are final). */
export const SOURCE_RETRYABLE: Readonly<Record<SourceErrorKind, boolean>> = {
    invalid_handle: false,
    not_found: false,
    not_readable: false,
    age_gated: false,
    rate_limited: true,
    quota: false,
    no_access: false,
    not_configured: false,
    bad_request: false,
    upstream: true,
    bad_response: false,
};

export type SourceName = 'instagram_discovery' | 'instagram_own' | 'youtube';

export interface SourceError {
    source: SourceName;
    kind: SourceErrorKind;
    retryable: boolean;
    /** What the platform (or we) said, scrubbed of credentials and at most 240 characters. */
    message: string;
    /** The platform's own error code (Meta's `code`), when it sent one. */
    code: number | null;
    /** The HTTP status, when there was a response. */
    http_status: number | null;
}

export type SourceResult<T> = { ok: true; value: T } | { ok: false; error: SourceError };

export const sourceOk = <T>(value: T): SourceResult<T> => ({ ok: true, value });

/**
 * `text` with each secret removed (as given, and URL-encoded) and anything key-shaped, then cut to 240 characters.
 * The removal runs once per secret and the cut once at the end of each pass, so a secret that straddles the cut
 * in an earlier pass is already gone.
 */
export function scrubSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
    let out = String(text);
    for (const secret of secrets) if (secret) out = scrub(out, secret);
    return scrub(out);
}

export interface SourceErrorInit {
    code?: number | null;
    http_status?: number | null;
    /** The credentials the call used: removed from the message. */
    secrets?: readonly (string | null | undefined)[];
}

/** A source error, with its message scrubbed and its retryability from the kind. */
export function sourceError(source: SourceName, kind: SourceErrorKind, message: string, init: SourceErrorInit = {}): SourceError {
    return {
        source,
        kind,
        retryable: SOURCE_RETRYABLE[kind],
        message: scrubSecrets(message, init.secrets),
        code: init.code ?? null,
        http_status: init.http_status ?? null,
    };
}

export const sourceFail = <T = never>(
    source: SourceName,
    kind: SourceErrorKind,
    message: string,
    init: SourceErrorInit = {},
): SourceResult<T> => ({ ok: false, error: sourceError(source, kind, message, init) });
