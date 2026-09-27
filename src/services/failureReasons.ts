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

/** The pipeline's own sentences, in the order they are tested. */
const OWN_WORDING: ReadonlyArray<readonly [RegExp, string]> = [
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
const META_CODE = /\bCode:?\s*(-?\d+)\b/i;

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
}

export interface FailureReason {
    reason_code: string;
    count: number;
    /** The most recent raw `error_log` behind this reason, for the tooltip and the unknown case. */
    sample: string | null;
    last_at: string | null;
}

export interface FailureSummary {
    total: number;
    reasons: FailureReason[];
}

const time = (iso: string | null): number => (iso ? Date.parse(iso) : 0) || 0;

/** Fold the text groups into reasons, most frequent first (then most recent), top `top`. */
export function summariseFailures(rows: readonly FailureTextGroup[], top = FAILURE_REASON_TOP): FailureSummary {
    const byReason = new Map<string, FailureReason>();
    let counted = 0;
    for (const row of rows) {
        const count = Number(row.count) || 0;
        if (count <= 0) continue;
        counted += count;
        const reason_code = failureReasonCode(row.error_log);
        const lastAt = toIso(row.last_at);
        const current = byReason.get(reason_code);
        if (!current) {
            byReason.set(reason_code, { reason_code, count, sample: row.error_log ?? null, last_at: lastAt });
            continue;
        }
        current.count += count;
        if (time(lastAt) > time(current.last_at)) {
            current.last_at = lastAt;
            current.sample = row.error_log ?? null;
        }
    }
    const declared = Number(rows[0]?.total);
    const reasons = [...byReason.values()]
        .sort((a, b) => (b.count - a.count) || (time(b.last_at) - time(a.last_at)))
        .slice(0, Math.max(0, top));
    return { total: Number.isFinite(declared) && declared >= counted ? declared : counted, reasons };
}
