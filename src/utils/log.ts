/**
 * Structured logging.
 *
 * What this replaces: ~150 `console.log` calls, most of them prefixed with an emoji and
 * interpolating their values into a prose sentence. Two consequences, both of which have
 * already cost debugging hours on this project:
 *
 *   1. Nothing is searchable. "which comment ids failed to match a campaign last Tuesday" is
 *      a question about a field, and there are no fields — only sentences. Vercel's log search
 *      is substring-only, so `❌ Private DM Error:` finds the line but tells you nothing about
 *      which tenant, which comment, or which of the fifteen callers produced it.
 *   2. Nothing is correlated. One Meta delivery fans out into a dozen log lines across the
 *      router, the pipeline, the Meta client and the retry helper. Interleaved with a
 *      concurrent delivery — which is normal — there is no way to tell which lines belong to
 *      which event. The project's own documentation describes a webhook signature failure as
 *      "invisible" for exactly this reason.
 *
 * The shape is one JSON object per line, because that is what every log backend (Vercel's own
 * drains, Axiom, Datadog, Better Stack) ingests without configuration. No dependency: this is
 * `JSON.stringify` and an `AsyncLocalStorage`, both stdlib.
 *
 * Usage:
 *
 *     log('info', 'comment.matched', { comment_id: id, campaign_id: c.id });
 *
 * `event` is a dotted, lowercase, machine-stable name — the thing you filter and alert on.
 * It is deliberately not a sentence: sentences get reworded, and the alert that depended on
 * the old wording stops firing silently.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL: LogLevel = 'info';

export type LogFields = Record<string, unknown>;

/**
 * Fields inherited by every log line emitted inside `withLogContext`.
 *
 * AsyncLocalStorage rather than an explicit parameter threaded through every function: the
 * call graph from webhook to Meta client is six frames deep through code that has no business
 * knowing about logging. Passing a context object through all of it is the kind of churn that
 * gets reverted, and a partial thread-through is worse than none — the lines that matter are
 * the ones deepest in the stack.
 */
const contextStorage = new AsyncLocalStorage<LogFields>();

/** Keys whose values never belong in a log line, matched case-insensitively on the key name. */
const REDACT_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|signature|cookie)/i;
const REDACTED = '[redacted]';

/**
 * Where lines go. Swappable so tests can assert on structured output instead of scraping
 * stdout, and so a log drain could be attached later without touching call sites.
 */
export type LogSink = (level: LogLevel, line: string) => void;

function defaultSink(level: LogLevel, line: string): void {
    // warn/error to stderr: Vercel tags the streams separately, and "show me only the errors"
    // should not depend on parsing the payload.
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
}

let sink: LogSink = defaultSink;

/** Replace the sink. Returns the previous one so a test can restore it. */
export function setLogSink(next: LogSink): LogSink {
    const previous = sink;
    sink = next;
    return previous;
}

/**
 * Resolved per call rather than cached, so `LOG_LEVEL` can be changed in a test without
 * reaching into module state. The cost is one `process.env` read against a `JSON.stringify`.
 */
function minimumLevel(): number {
    const configured = process.env.LOG_LEVEL?.toLowerCase();
    if (configured && configured in LEVEL_ORDER) {
        return LEVEL_ORDER[configured as LogLevel];
    }
    return LEVEL_ORDER[DEFAULT_LEVEL];
}

export function isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= minimumLevel();
}

/**
 * Make one value safe to serialise.
 *
 * Three hazards, all of which have taken down a logging call somewhere: circular references
 * (an axios error holds its own request, which holds the response, which holds the error),
 * BigInt (throws in JSON.stringify), and Error (serialises to `{}` because its fields are
 * non-enumerable).
 */
function sanitise(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
    if (value === null || value === undefined) return value;

    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return String(value);
    if (type === 'function' || type === 'symbol') return undefined;

    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return describeError(value);

    // Deeply nested structures in a log line are almost always a mistake — a whole webhook
    // body, or an axios config. Cut them off rather than emitting a 40KB line.
    if (depth >= 4) return '[truncated]';

    if (typeof value === 'object') {
        if (seen.has(value)) return '[circular]';
        seen.add(value);

        if (Array.isArray(value)) {
            return value.slice(0, 50).map((v) => sanitise(v, seen, depth + 1));
        }

        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = REDACT_KEY.test(k) ? REDACTED : sanitise(v, seen, depth + 1);
        }
        return out;
    }

    return String(value);
}

/**
 * Flatten an error into loggable fields.
 *
 * Exported because callers want it in the `err` position of their own fields, and because an
 * axios error's useful content is buried in `response.data.error` — the place every existing
 * `catch` block in this codebase reaches into by hand, each slightly differently.
 */
export function describeError(err: unknown): LogFields {
    if (!(err instanceof Error)) {
        return { message: String(err) };
    }

    const out: LogFields = { message: err.message, name: err.name };

    // Node system errors and axios both use `code`; for Meta failures it is the single most
    // useful field there is (190 = dead token, 200 = missing permission, 10903 = blocked).
    const anyErr = err as unknown as Record<string, unknown>;
    if (anyErr['code'] !== undefined) out['code'] = anyErr['code'];

    const response = anyErr['response'] as Record<string, unknown> | undefined;
    if (response) {
        out['http_status'] = response['status'];
        const data = response['data'] as Record<string, unknown> | undefined;
        const metaError = data?.['error'] as Record<string, unknown> | undefined;
        if (metaError) {
            out['meta_code'] = metaError['code'];
            out['meta_subcode'] = metaError['error_subcode'];
            out['meta_message'] = metaError['message'];
            out['meta_type'] = metaError['type'];
        }
    }

    // Deliberately not the stack by default: on Vercel it triples the line length and the
    // useful frames are all in this repo anyway. `LOG_STACKS=1` turns it back on.
    if (process.env.LOG_STACKS === '1' && err.stack) out['stack'] = err.stack;

    return out;
}

/**
 * Emit one structured line.
 *
 * Never throws. A logging call that can fail is a logging call that takes down the request it
 * was supposed to explain — and this one runs inside `catch` blocks, where an exception has
 * nowhere left to go.
 */
export function log(level: LogLevel, event: string, fields?: LogFields): void {
    if (!isLevelEnabled(level)) return;

    try {
        const seen = new WeakSet<object>();
        const record: Record<string, unknown> = {
            ts: new Date().toISOString(),
            level,
            event,
        };

        // Context first, explicit fields second: a call site that names `creator_id` itself
        // means that one, not the ambient one.
        const context = contextStorage.getStore();
        if (context) {
            for (const [k, v] of Object.entries(context)) {
                record[k] = REDACT_KEY.test(k) ? REDACTED : sanitise(v, seen);
            }
        }
        if (fields) {
            for (const [k, v] of Object.entries(fields)) {
                if (v === undefined) continue;
                record[k] = REDACT_KEY.test(k) ? REDACTED : sanitise(v, seen);
            }
        }

        sink(level, JSON.stringify(record));
    } catch (err) {
        // Last resort, and deliberately not structured — if JSON.stringify is the thing that
        // broke, emitting more JSON is not going to help.
        try {
            console.error(`[log] failed to emit event=${event}: ${(err as Error)?.message}`);
        } catch {
            /* nothing left to try */
        }
    }
}

/** A correlation id. 16 hex chars: long enough not to collide, short enough to paste. */
export function newRequestId(): string {
    return randomBytes(8).toString('hex');
}

/**
 * Run `fn` with extra fields attached to every log line it produces, transitively.
 *
 * The context is merged with whatever is already in scope, so a job handler can add
 * `job_id` without losing the `request_id` the webhook established.
 */
export function withLogContext<T>(fields: LogFields, fn: () => T): T {
    const parent = contextStorage.getStore();
    return contextStorage.run({ ...parent, ...fields }, fn);
}

/** The fields currently in scope. Mainly for handing a correlation id to a durable job. */
export function currentLogContext(): LogFields {
    return { ...contextStorage.getStore() };
}

/** The correlation id in scope, if any. */
export function currentRequestId(): string | undefined {
    const id = contextStorage.getStore()?.['request_id'];
    return typeof id === 'string' ? id : undefined;
}
