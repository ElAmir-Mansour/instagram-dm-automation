/**
 * What became of one comment's DM: delivered, not delivered on purpose, not delivered by accident, still in flight, or blocked by the
 * person. Dashboard UX overhaul, research R-03, data-model "Outcome".
 *
 * Today every one of those that is not `SENT` is written as `FAILED`, so "5 DMs failed today" mixes a dead token (the owner must
 * act) with a person who was already messaged (nothing to do, and the product did it on purpose). A red number that is mostly the
 * second kind teaches the owner to ignore red (audit OV-03). This classifies at READ time instead of changing what the comment path
 * writes: the live webhook is untouched (constitution VII), and rows already in the table are classified correctly with no backfill.
 *
 * The judgement about which failures were chosen lives in `failureReasons.ts` (`isExpectedFailure`), next to the sentences it reads.
 *
 * | status             | outcome                                                                               |
 * |--------------------|---------------------------------------------------------------------------------------|
 * | `SENT`             | delivered                                                                             |
 * | `PENDING`          | pending: shown, never counted as a success or a failure                               |
 * | `USER_BLOCKED_DMS` | blocked: neutral, the person's own privacy setting                                    |
 * | `SKIPPED`          | by_design                                                                             |
 * | `FAILED`, expected | by_design: send caps, "already has a reply" (codes -1 / 10900), public reply instead  |
 * | any other `FAILED` | actionable                                                                            |
 *
 * Pure, so every row of that table is pinned by `outcomes.test.ts` against the strings the comment path really writes.
 */
import {
    EXPECTED_REASONS, isExpectedFailure, META_CODE, OWN_WORDING, PUBLIC_FALLBACK_SENT,
} from './failureReasons.js';

export const OUTCOMES = ['delivered', 'by_design', 'actionable', 'pending', 'blocked'] as const;
export type Outcome = typeof OUTCOMES[number];

/**
 * The outcome of one `interactions` row.
 *
 * A status this function does not know is `actionable`, not a quiet bucket: the column is a free VARCHAR with no CHECK, and a value
 * nobody planned for is exactly the kind of thing that should be looked at rather than counted as fine.
 */
export function classifyOutcome(status: unknown, errorLog?: unknown): Outcome {
    switch (status) {
        case 'SENT': return 'delivered';
        case 'PENDING': return 'pending';
        case 'USER_BLOCKED_DMS': return 'blocked';
        case 'SKIPPED': return 'by_design';
        case 'FAILED': return isExpectedFailure(errorLog) ? 'by_design' : 'actionable';
        default: return 'actionable';
    }
}

/** Counts per outcome, every key present. */
export type OutcomeCounts = Record<Outcome, number>;

/**
 * Delivered ÷ (delivered + actionable): the one success-rate definition (audit OV-20). Pending rows are not attempts yet, by-design
 * skips are not failures, and a blocked recipient is not the product's doing, so none of them move it. `null` when nothing has been
 * attempted: no rate is not a rate of 0% or of 100%.
 */
export function successRate(counts: Pick<OutcomeCounts, 'delivered' | 'actionable'>): number | null {
    const attempted = counts.delivered + counts.actionable;
    return attempted > 0 ? counts.delivered / attempted : null;
}

/** `successRate` as a whole percent, the form the dashboard shows, or null when nothing was attempted. */
export function successPercent(counts: Pick<OutcomeCounts, 'delivered' | 'actionable'>): number | null {
    const rate = successRate(counts);
    return rate === null ? null : Math.round(rate * 100);
}

// ─── The same judgement, in SQL ───────────────────────────────────────────────────────────────────────────────────────────────
//
// The stats routes count thousands of rows per request, so they classify in the database (a `COUNT(*) FILTER` per outcome) and not
// by pulling every row into JavaScript. That makes a second implementation of `classifyOutcome`, which is exactly how two screens
// come to disagree about what "failed" means (audit OV-20: Overview, Analytics and the campaign cards each counted their own way).
//
// So there is still ONE set of patterns: the regexes `failureReasons.ts` judges a row with are rendered here into the SQL, and
// `outcomes.sql.test.ts` runs the generated expression's own arms against `isExpectedFailure` / `classifyOutcome` on every pattern
// and every status. A pattern that has no faithful SQL form (a flag other than `i`, a lookbehind, an anchor in the middle) is
// refused when the SQL is built, which is at load for every route that uses it: it cannot ship half-translated.

/** What a JS pattern becomes in a PostgreSQL ARE: `\b` is a backspace there and `\y` is the word boundary. */
export function pgPattern(re: RegExp): string {
    if (re.flags.replace('i', '') !== '') throw new Error(`pgPattern: flags "${re.flags}" have no PostgreSQL form (${re.source})`);
    if (re.source.includes('(?<')) throw new Error(`pgPattern: lookbehind and named groups have no PostgreSQL form (${re.source})`);
    if (re.source.includes('$re$')) throw new Error('pgPattern: the pattern contains the literal quote tag');
    // A `^` that is not the very first character and not inside a class would anchor differently; refuse rather than guess.
    const anchors = [...re.source.matchAll(/(?<![[\\])\^/g)].map((m) => m.index);
    if (anchors.some((at) => at !== 0)) throw new Error(`pgPattern: an anchor in the middle of ${re.source}`);
    const body = re.source.replace(/\\b/g, '\\y').replace(/\\B/g, '\\Y');
    // The JavaScript side judges the TRIMMED text, so `^Skipped` meant "after any leading whitespace".
    return body.startsWith('^') ? `^\\s*${body.slice(1)}` : body;
}

/** A pattern as a dollar-quoted SQL literal, which needs no escaping of a quote or a backslash. */
const literal = (pattern: string): string => `$re$${pattern}$re$`;

/** A column reference written in source (`i.error_log`), never a request value: it is interpolated into SQL. */
function column(name: string): string {
    if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(name)) throw new Error(`not a column reference: ${name}`);
    return name;
}

/** One arm of the expected-failure CASE: a PostgreSQL pattern, and whether a row that matches it is expected. */
export interface ExpectedArm { pattern: string; result: boolean }

/**
 * The arms of `expectedFailureSql`, first match wins, in the order `isExpectedFailure` decides. Exported so the test walks exactly
 * what the SQL walks.
 */
export function expectedFailureArms(): ExpectedArm[] {
    return [
        // The public fallback went out: by design whatever the DM's own reason was (`isExpectedFailure` checks it first).
        { pattern: pgPattern(PUBLIC_FALLBACK_SENT), result: true },
        // Then the pipeline's own wording, in the order `failureReasonCode` tries it; the first that matches names the reason.
        ...OWN_WORDING.map(([re, code]) => ({ pattern: pgPattern(re), result: EXPECTED_REASONS.has(code) })),
    ];
}

/** The numeric Meta codes that are expected ('10900'): what `failureReasonCode` reads from `META_CODE` when no wording matched. */
export function expectedMetaCodes(): string[] {
    return [...EXPECTED_REASONS].filter((code) => /^-?\d+$/.test(code));
}

/** The pattern that pulls the first Meta code out of an `error_log`, with the case-insensitivity PostgreSQL wants inline. */
export function metaCodePattern(): string {
    return `(?i)${pgPattern(META_CODE)}`;
}

/**
 * A SQL boolean: is the FAILED row whose `error_log` is `col` a failure the pipeline expected? `isExpectedFailure` as a CASE.
 * NULL, empty and whitespace-only text are false, as they are there: an unexplained failure is never assumed to be fine.
 */
export function expectedFailureSql(col: string): string {
    const c = column(col);
    const arms = expectedFailureArms().map((a) => `WHEN ${c} ~* ${literal(a.pattern)} THEN ${a.result ? 'TRUE' : 'FALSE'}`);
    const codes = expectedMetaCodes();
    const byCode = codes.length
        ? `COALESCE(substring(${c} from ${literal(metaCodePattern())}) IN (${codes.map((code) => `'${code}'`).join(', ')}), FALSE)`
        : 'FALSE';
    return `CASE ${arms.join(' ')} ELSE ${byCode} END`;
}

/**
 * A SQL text expression: `classifyOutcome(status, error_log)` as a CASE. A status the table does not know, and NULL, is
 * 'actionable', as it is there.
 */
export function outcomeSql(statusCol = 'i.status', errorLogCol = 'i.error_log'): string {
    return `CASE ${column(statusCol)}`
        + ` WHEN 'SENT' THEN 'delivered'`
        + ` WHEN 'PENDING' THEN 'pending'`
        + ` WHEN 'USER_BLOCKED_DMS' THEN 'blocked'`
        + ` WHEN 'SKIPPED' THEN 'by_design'`
        + ` WHEN 'FAILED' THEN (CASE WHEN ${expectedFailureSql(errorLogCol)} THEN 'by_design' ELSE 'actionable' END)`
        + ` ELSE 'actionable' END`;
}

/**
 * The outcome of each interaction as a column, computed once per row: `CROSS JOIN ${outcomeLateral()}` (or `LEFT JOIN ${...} ON TRUE`
 * after a LEFT JOIN of interactions) exposes it as `o.outcome`.
 */
export function outcomeLateral(statusCol = 'i.status', errorLogCol = 'i.error_log'): string {
    return `LATERAL (SELECT ${outcomeSql(statusCol, errorLogCol)} AS outcome) o`;
}

/**
 * The select list that counts each outcome of the interactions in a group: `delivered`, `by_design`, `actionable`, `pending` and
 * `blocked`, as `int`, each named `<prefix><outcome>`. It counts `idCol`, so a LEFT-JOINed row that matched nothing (id NULL) is in none of them, however its
 * outcome column reads.
 */
export function outcomeCountsSql(idCol = 'i.id', outcomeCol = 'o.outcome', prefix = ''): string {
    const id = column(idCol);
    const outcome = column(outcomeCol);
    if (!/^[a-z_]*$/.test(prefix)) throw new Error(`not a column prefix: ${prefix}`);
    return OUTCOMES.map((o) => `COUNT(${id}) FILTER (WHERE ${outcome} = '${o}')::int AS ${prefix}${o}`).join(', ');
}

export const isOutcome = (value: unknown): value is Outcome => typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);

/** What the SQL counts came back as: numbers, every key present, 0 where the database said nothing. */
export function readOutcomeCounts(row: Record<string, unknown> | undefined | null): OutcomeCounts {
    const out = {} as OutcomeCounts;
    for (const o of OUTCOMES) out[o] = Number(row?.[o]) || 0;
    return out;
}
