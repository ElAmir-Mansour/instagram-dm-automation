/**
 * "Why DMs fail" (docs/UX_AUDIT_2026-09-27.md A5): the FAILED rows of `interactions`, grouped by
 * the reason written into `error_log`.
 *
 * The SQL (`GET /api/stats/failures`) groups by the exact `error_log` text, which is exact but
 * too fine — the quota line carries its own counts, and Meta's message varies around the same
 * code. This folds those text groups into reasons:
 *
 *   1. The pipeline's own wording, where it has one (src/webhook/comments.ts, errors.ts): code
 *      100's "won't accept a private reply", the one-private-reply-per-comment refusal (which
 *      Facebook reports as 10900 and Instagram as -1, so its code alone would split it in two),
 *      and the three "Skipped:" lines the send caps write.
 *   2. Otherwise the first Meta code in the text — `(Code: 190)` from src/services/instagram.ts,
 *      `(Code 10903)` from errors.ts. The first, because a fallback that failed too appends its
 *      own code after the DM's, and the DM's is the reason the row is FAILED.
 *   3. Otherwise the first line, digits and spacing normalised, so one sentence is one reason.
 *
 * Each reason also says whether it is **expected**: a failure the pipeline chose, which worked as designed (a send cap, a
 * comment that already had its private reply, a public reply sent in place of an undeliverable DM). Those are written as
 * `FAILED` rows today, and counting them as failures makes the dashboard red for things that went right (audit OV-03). The
 * judgement lives here, once, and `src/services/outcomes.ts` builds the delivered / by-design / actionable split on it.
 *
 * Pure, so every rule is pinned by src/services/failureReasons.test.ts against the strings the
 * writers actually produce.
 */
import { toIso } from './health.js';

/** How many reasons the panel shows. */
export const FAILURE_REASON_TOP = 6;

/**
 * How many distinct `error_log` texts the query hands over. The grand total is exact whatever
 * this is (a window SUM over every group); only a reason spread across more distinct texts than
 * this could be undercounted, and one tenant's month of failures is nowhere near it.
 */
export const FAILURE_TEXT_GROUPS = 500;

/** A reason with no code and no pipeline wording: the text itself, normalised. */
export const TEXT_REASON_PREFIX = 'text:';

/**
 * The pipeline's own sentences, in the order they are tested.
 *
 * `OWN_WORDING`, `META_CODE`, `EXPECTED_REASONS` and `PUBLIC_FALLBACK_SENT` are exported for one reader besides this file:
 * `expectedFailureSql` (src/services/outcomes.ts) renders them as SQL, so the stats routes can count outcomes in the database with
 * the SAME patterns this file judges one row with. A pattern changed here therefore changes both, and a pattern that cannot be
 * rendered as SQL is refused by that function at load, not silently dropped.
 */
export const OWN_WORDING: ReadonlyArray<readonly [RegExp, string]> = [
    // classifyDmError's code-100 sentence (src/webhook/errors.ts).
    [/won't accept a private reply/i, '100'],
    // classifyDmError's already-replied sentence, and Meta's own words for it.
    [/already had its private reply|already has a reply/i, 'already_replied'],
    // The send caps (src/webhook/comments.ts) — no Meta call was made, so no code.
    [/^Skipped: recipient already received an automated DM/i, 'recipient_cap'],
    [/^Skipped: the app-wide Meta send budget/i, 'quota_app'],
    [/^Skipped: hourly DM quota/i, 'quota_hourly'],
];

/** `(Code: 190)`, `(Code 10903)`, `(Code: -1)`. Not `(Code: N/A)`. */
export const META_CODE = /\bCode:?\s*(-?\d+)\b/i;

/**
 * The reasons that are the pipeline doing what it was built to do, by `failureReasonCode`:
 *   - `recipient_cap`  this app's own rule of one automated DM per person per 24 h, so nobody is messaged twice in a day;
 *   - `quota_hourly`, `quota_app`  the send budgets, which skip a send rather than let Meta throttle the account;
 *   - `already_replied`  Meta allows one private reply per comment and it was already used, usually by hand: a DM exists;
 *   - `10900`  Meta's own code for that same refusal, on a row written before the pipeline wrote its own sentence for it.
 *
 * Deliberately NOT here: `-1`. Instagram sends the refusal as -1 *with* "already has a reply", which `OWN_WORDING` turns into
 * `already_replied` before any code is read. A bare `-1` is Graph's generic "unknown error", which is a real failure.
 */
export const EXPECTED_REASONS: ReadonlySet<string> = new Set(['recipient_cap', 'quota_hourly', 'quota_app', 'already_replied', '10900']);

/**
 * What `comments.ts` appends to a DM failure's `error_log` once the public reply that stands in for it has gone out. The DM
 * could not be delivered, but the person who asked still got the link: the row stays `FAILED` and the outcome is by design.
 * Checked on the TEXT, not the reason code, because the same code-100 refusal with this sentence worked as designed and
 * without it (the fallback failed too: `... The public fallback reply failed too: ...`) did not.
 */
export const PUBLIC_FALLBACK_SENT = /Replied publicly with the link instead/i;

/**
 * True when this `error_log` is a failure the pipeline expected (see `EXPECTED_REASONS`, `PUBLIC_FALLBACK_SENT`): not something
 * the owner has to fix. False for everything else, including no text at all: an unexplained failure is never assumed to be fine.
 */
export function isExpectedFailure(errorLog: unknown): boolean {
    const text = typeof errorLog === 'string' ? errorLog : '';
    if (PUBLIC_FALLBACK_SENT.test(text)) return true;
    return EXPECTED_REASONS.has(failureReasonCode(text));
}

/** The first line, with numbers and spacing made uniform, clipped. '' when there is nothing. */
export function normaliseFailureLine(text: string): string {
    const first = text.split(/\r?\n/, 1)[0] ?? '';
    return first.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * The reason one `error_log` stands for: a Meta code as digits (`'190'`), one of the pipeline's
 * named reasons (`'recipient_cap'`), `text:<normalised first line>`, or `'unknown'` for no text.
 */
export function failureReasonCode(errorLog: unknown): string {
    const text = typeof errorLog === 'string' ? errorLog.trim() : '';
    if (!text) return 'unknown';
    for (const [pattern, code] of OWN_WORDING) if (pattern.test(text)) return code;
    const code = META_CODE.exec(text);
    if (code) return code[1]!;
    const line = normaliseFailureLine(text);
    return line ? `${TEXT_REASON_PREFIX}${line}` : 'unknown';
}

/** One row of the grouped query. */
export interface FailureTextGroup {
    error_log: string | null;
    count: number | string;
    last_at: unknown;
    /** Every FAILED row in the window, the same on every row (a window SUM). */
    total?: number | string;
    /** Of those, the ones the SQL judged expected (`expectedFailureSql`), the same on every row. Absent: counted from the groups. */
    expected_total?: number | string;
}

export interface FailureReason {
    reason_code: string;
    count: number;
    /**
     * True when every failure behind this reason was one the pipeline expected (`isExpectedFailure`): a designed skip, not a
     * fault. A reason can be mixed (code 100 is by design when the public reply went out and a fault when it did not), and then
     * this is false and `expected_count` says how many of its `count` were by design.
     */
    expected: boolean;
    /** How many of `count` were expected. 0 for a fault, `count` for a designed skip. */
    expected_count: number;
    /** The most recent raw `error_log` behind this reason, for the tooltip and the unknown case. */
    sample: string | null;
    last_at: string | null;
}

export interface FailureSummary {
    total: number;
    /**
     * How many of `total` were failures the pipeline expected (`isExpectedFailure`), and how many the owner has to look at: the
     * two halves of "Why DMs fail" (audit OV-20). Counted over every text group, not only the top reasons, and taken from the
     * query's own sum when it sent one, like `total`. `actionable_total` is `total - expected_total`.
     */
    expected_total: number;
    actionable_total: number;
    reasons: FailureReason[];
}

const time = (iso: string | null): number => (iso ? Date.parse(iso) : 0) || 0;

/** Fold the text groups into reasons, most frequent first (then most recent), top `top`. */
export function summariseFailures(rows: readonly FailureTextGroup[], top = FAILURE_REASON_TOP): FailureSummary {
    const byReason = new Map<string, FailureReason>();
    let counted = 0;
    let countedExpected = 0;
    for (const row of rows) {
        const count = Number(row.count) || 0;
        if (count <= 0) continue;
        counted += count;
        const reason_code = failureReasonCode(row.error_log);
        const lastAt = toIso(row.last_at);
        const expectedHere = isExpectedFailure(row.error_log) ? count : 0;
        countedExpected += expectedHere;
        const current = byReason.get(reason_code);
        if (!current) {
            byReason.set(reason_code, {
                reason_code, count, expected: expectedHere === count, expected_count: expectedHere,
                sample: row.error_log ?? null, last_at: lastAt,
            });
            continue;
        }
        current.count += count;
        current.expected_count += expectedHere;
        current.expected = current.expected_count === current.count;
        if (time(lastAt) > time(current.last_at)) {
            current.last_at = lastAt;
            current.sample = row.error_log ?? null;
        }
    }
    const declared = Number(rows[0]?.total);
    const reasons = [...byReason.values()]
        .sort((a, b) => (b.count - a.count) || (time(b.last_at) - time(a.last_at)))
        .slice(0, Math.max(0, top));
    const total = Number.isFinite(declared) && declared >= counted ? declared : counted;
    // The SQL's own count wins when it came and is sane (the same rule as `total`), so a month with more distinct texts than the
    // query hands over still splits exactly. It can never exceed `total`.
    const declaredExpected = Number(rows[0]?.expected_total);
    const expected_total = Number.isFinite(declaredExpected) && declaredExpected >= countedExpected && declaredExpected <= total
        ? declaredExpected : Math.min(countedExpected, total);
    return { total, expected_total, actionable_total: total - expected_total, reasons };
}
