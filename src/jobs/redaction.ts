/**
 * How a handler that fails can still say "redact my payload if this is the failure that ends the job".
 *
 * A thrown error carries no extra arguments, and the runner is what knows whether the attempt was the last one, so the handler tags the error it
 * throws and the runner reads the tag. The tag lives in a `WeakMap` beside the error, not on it: nothing about the error (its message, its
 * `code`, what `describeError` logs) changes, and the tag goes away with the error. See `JobResult` (./types.ts) for why a payload is redacted.
 *
 * The tag is only read when no retry follows. A job that will run again keeps the payload the next attempt needs.
 */
const redactions = new WeakMap<object, unknown>();

/**
 * Tag `error` so that, if it ends the job, the stored payload becomes `payload`. Returns the error to throw: the same object when it is an
 * `Error`, a new `Error` around a value that is not one (a thrown string has nowhere to carry a tag).
 */
export function redactOnFailure(error: unknown, payload: unknown): Error {
    const thrown = error instanceof Error ? error : new Error(String(error));
    redactions.set(thrown, payload);
    return thrown;
}

/** The redaction a handler asked for on this error, or null. */
export function failureRedaction(error: unknown): { payload: unknown } | null {
    if (typeof error !== 'object' || error === null || !redactions.has(error)) return null;
    return { payload: redactions.get(error) };
}
