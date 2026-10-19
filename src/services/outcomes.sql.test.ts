/**
 * `outcomeSql` / `expectedFailureSql`: the SQL form of `classifyOutcome`, held to the JavaScript one.
 *
 * The stats routes classify in the database, so there are two implementations of one judgement, and the way two screens come to
 * disagree about what "failed" means is two implementations. They share ONE set of patterns (`failureReasons.ts` exports them and
 * `outcomes.ts` renders them), and this file is what keeps the rendering honest:
 *
 *   1. every pattern the JavaScript side judges with has an arm in the SQL, rendered faithfully (`\b` is `\y`, `^` allows leading
 *      white space), and a pattern with no faithful form is refused instead of dropped;
 *   2. the SQL's arms, walked in JavaScript in the order the CASE tests them, agree with `isExpectedFailure` on a text built from
 *      EVERY pattern and on the strings the comment path really writes, so a pattern added to `failureReasons.ts` that the SQL
 *      mishandles fails here;
 *   3. against a REAL PostgreSQL, the generated CASE agrees with `classifyOutcome` on every (status, error_log) pair. That one needs
 *      a database, which CI does not have: it runs when `OUTCOMES_SQL_PG_URL` names a throwaway one, and is skipped otherwise.
 *      (`postgres://user@127.0.0.1:5432/postgres` against a scratch `initdb` cluster is enough; it creates no tables.)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { classifyDmError } from '../webhook/errors.js';
import { EXPECTED_REASONS, isExpectedFailure, META_CODE, OWN_WORDING, PUBLIC_FALLBACK_SENT } from './failureReasons.js';
import { metaFailure } from './instagram.js';
import {
    classifyOutcome, expectedFailureArms, expectedFailureSql, expectedMetaCodes, metaCodePattern, outcomeCountsSql, outcomeLateral,
    outcomeSql, OUTCOMES, pgPattern,
} from './outcomes.js';

function metaError(code: number, message: string, prefix = 'Private Reply Failed') {
    return metaFailure(prefix, { response: { status: 400, data: { error: { code, message } } } });
}
const classified = (code: number, message: string) => classifyDmError(metaError(code, message));

const RECIPIENT_CAP = 'Skipped: recipient already received an automated DM within 24 hours.';
const QUOTA_HOURLY = 'Skipped: hourly DM quota reached (181/180). Meta throttles automated sends at ~200/hr.';
const QUOTA_APP = 'Skipped: the app-wide Meta send budget is exhausted (1001/1000 this hour). That budget is shared by every account on this app.';
const PUBLIC_REPLY = ' Replied publicly with the link instead.';
const refused = classified(100, '(#100) Invalid parameter').error;

/** Every kind of text the judgement has to get right: the writers' own output, each pattern's shape, and the awkward neighbours. */
const CORPUS: Array<string | null> = [
    null, '', '   ', '\n',
    RECIPIENT_CAP, QUOTA_HOURLY, QUOTA_APP, `  \n${RECIPIENT_CAP}`, `x ${RECIPIENT_CAP}`,
    classified(-1, 'This comment already has a reply').error, classified(10900, 'Activity already replied to').error,
    'Private Reply Failed: Activity already replied to (Code: 10900)', 'Private Reply Failed: x (code 10900)', 'CODE: 10900',
    'Private Reply Failed: An unknown error occurred (Code: -1)',
    classified(190, 'Error validating access token').error, classified(200, 'Permissions error').error,
    classified(613, 'rate limit').error, classified(4, 'limit').error,
    refused, `${refused}${PUBLIC_REPLY}`, `${refused} Replied publicly with the link instead (in the neutral wording).`,
    `${refused} The public fallback reply failed too: Public Reply Failed: Permissions error (Code: 200)`,
    `Private Reply Failed: x (Code: 190) ${PUBLIC_REPLY} (Code: 10900)`, 'Code: 10900 then Code: 190', 'Code: 190 then Code: 10900',
    'Mcode: 10900', 'Code:10900', 'Code 10900', 'Code: 109001', 'Code: -10900',
    'REPLIED PUBLICLY WITH THE LINK INSTEAD', 'This comment ALREADY HAS A REPLY',
    "WON'T ACCEPT A PRIVATE REPLY (Code: 10900)", "already had its private reply and also won't accept a private reply",
    'Skipped: hourly DM quota reached (999/180)', 'something else entirely', 'تم إرسال', 'خطأ (Code: 10900)',
];
const STATUSES: unknown[] = ['SENT', 'PENDING', 'FAILED', 'SKIPPED', 'USER_BLOCKED_DMS', 'sent', 'DONE', '', null, undefined, 7];

/** The PostgreSQL pattern read back as the JavaScript one it came from: `\y` is `\b`, and the leading `(?i)` is the `i` flag. */
function backToJs(pattern: string): RegExp {
    const inline = pattern.startsWith('(?i)');
    return new RegExp((inline ? pattern.slice(4) : pattern).replace(/\\y/g, '\\b').replace(/\\Y/g, '\\B'), 'i');
}

/** The SQL's CASE, walked in JavaScript: the same arms, in the same order, then the same Meta-code fallback. */
function expectedBySqlArms(log: string | null): boolean {
    const text = log ?? '';
    for (const arm of expectedFailureArms()) if (backToJs(arm.pattern).test(text)) return arm.result;
    const code = backToJs(metaCodePattern()).exec(text);
    return code ? expectedMetaCodes().includes(code[1]!) : false;
}

describe('pgPattern: a JavaScript pattern as a PostgreSQL one', () => {
    it('turns the word boundary into PostgreSQL’s (\\b is a backspace there)', () => {
        assert.equal(pgPattern(/\bCode:?\s*(-?\d+)\b/i), '\\yCode:?\\s*(-?\\d+)\\y');
        assert.equal(pgPattern(/a\Bb/i), 'a\\Yb');
    });

    it('lets a leading ^ follow leading white space, because the JavaScript side judges trimmed text', () => {
        assert.equal(pgPattern(/^Skipped: hourly DM quota/i), '^\\s*Skipped: hourly DM quota');
        assert.equal(pgPattern(/won't accept a private reply/i), "won't accept a private reply", 'no anchor: unchanged');
    });

    it('refuses what it cannot translate faithfully, instead of silently dropping it', () => {
        assert.throws(() => pgPattern(/x/m), /flags "m"/);
        assert.throws(() => pgPattern(/x/gi), /flags "gi"/);
        assert.throws(() => pgPattern(/x/s), /flags "s"/);
        assert.throws(() => pgPattern(/(?<=a)b/i), /lookbehind/);
        assert.throws(() => pgPattern(/(?<n>a)b/i), /named groups/);
        assert.throws(() => pgPattern(/a|^b/i), /anchor in the middle/);
        assert.throws(() => pgPattern(new RegExp('a$re$b', 'i')), /quote tag/);
        // A ^ inside a character class or escaped is not an anchor.
        assert.doesNotThrow(() => pgPattern(/[^a]\^b/i));
    });

    it('translates every pattern failureReasons.ts judges with', () => {
        for (const [re] of OWN_WORDING) assert.doesNotThrow(() => pgPattern(re), re.source);
        assert.doesNotThrow(() => pgPattern(PUBLIC_FALLBACK_SENT));
        assert.doesNotThrow(() => pgPattern(META_CODE));
    });
});

describe('expectedFailureSql: one arm per pattern, in the order the JavaScript side tries them', () => {
    it('has an arm for the public fallback first, then one for each of the pipeline’s own sentences', () => {
        const arms = expectedFailureArms();
        assert.equal(arms.length, 1 + OWN_WORDING.length);
        assert.equal(arms[0]!.pattern, pgPattern(PUBLIC_FALLBACK_SENT));
        assert.equal(arms[0]!.result, true);
        OWN_WORDING.forEach(([re, code], i) => {
            assert.equal(arms[i + 1]!.pattern, pgPattern(re), re.source);
            assert.equal(arms[i + 1]!.result, EXPECTED_REASONS.has(code), `${code} is expected only if the JavaScript side says so`);
        });
    });

    it('puts every pattern in the SQL text, dollar-quoted so no quote or backslash needs escaping', () => {
        const sql = expectedFailureSql('i.error_log');
        for (const arm of expectedFailureArms()) assert.ok(sql.includes(`$re$${arm.pattern}$re$`), arm.pattern);
        assert.ok(sql.includes(`$re$${metaCodePattern()}$re$`));
        for (const code of expectedMetaCodes()) assert.ok(sql.includes(`'${code}'`), code);
        assert.match(sql, /^CASE WHEN i\.error_log ~\* \$re\$/);
        assert.match(sql, / END$/);
    });

    it('the wording that decides the by-design cases is the wording the comment path writes', () => {
        // The patterns read the source of truth, so if comments.ts is reworded and failureReasons.ts follows, the SQL follows too.
        const sql = expectedFailureSql('i.error_log');
        for (const text of [RECIPIENT_CAP, QUOTA_HOURLY, QUOTA_APP]) assert.equal(expectedBySqlArms(text), true, text);
        assert.ok(sql.includes('Skipped: recipient already received an automated DM'));
        assert.ok(sql.includes('Skipped: the app-wide Meta send budget'));
    });

    it('is a FALSE for text it has no reason to trust: NULL, empty and white space', () => {
        for (const text of [null, '', '   ', '\n\t']) assert.equal(expectedBySqlArms(text), false, JSON.stringify(text));
    });

    it('agrees with isExpectedFailure on the corpus: the writers’ own strings and every awkward neighbour', () => {
        for (const text of CORPUS) assert.equal(expectedBySqlArms(text), isExpectedFailure(text), JSON.stringify(text));
    });

    it('agrees on a text built from EVERY pattern, alone and wrapped in a failure that would otherwise be actionable', () => {
        // One sample per pattern, taken from the pattern itself: a new entry in OWN_WORDING is covered with no edit here.
        const samples = [
            'Replied publicly with the link instead',
            "won't accept a private reply",
            'already had its private reply',
            'already has a reply',
            'Skipped: recipient already received an automated DM',
            'Skipped: the app-wide Meta send budget',
            'Skipped: hourly DM quota',
            ...[...EXPECTED_REASONS].filter((c) => /^-?\d+$/.test(c)).map((c) => `(Code: ${c})`),
            '(Code: 190)', '(Code: -1)',
        ];
        for (const sample of samples) {
            for (const text of [sample, `Private Reply Failed: ${sample}`, `${sample} (Code: 190)`, `(Code: 190) ${sample}`, `${sample}${PUBLIC_REPLY}`]) {
                assert.equal(expectedBySqlArms(text), isExpectedFailure(text), JSON.stringify(text));
            }
        }
    });

    it('a pattern the JavaScript side treats as expected is an expected arm in the SQL, and one it does not is not', () => {
        const byPattern = new Map(expectedFailureArms().map((a) => [a.pattern, a.result]));
        for (const [re, code] of OWN_WORDING) assert.equal(byPattern.get(pgPattern(re)), EXPECTED_REASONS.has(code), `${code}: ${re.source}`);
    });
});

describe('outcomeSql', () => {
    const sql = outcomeSql();

    it('names every status the classifier knows, and the outcome each gets', () => {
        for (const status of ['SENT', 'PENDING', 'USER_BLOCKED_DMS', 'SKIPPED', 'FAILED']) assert.ok(sql.includes(`WHEN '${status}'`), status);
        for (const [status, outcome] of [['SENT', 'delivered'], ['PENDING', 'pending'], ['USER_BLOCKED_DMS', 'blocked'], ['SKIPPED', 'by_design']]) {
            assert.ok(sql.includes(`WHEN '${status}' THEN '${outcome}'`), `${status} → ${outcome}`);
        }
        // Anything else, and NULL, is surfaced, never quietly counted as fine.
        assert.match(sql, / ELSE 'actionable' END$/);
        assert.equal(classifyOutcome('DONE', null), 'actionable');
    });

    it('a FAILED row is by design only when the expected-failure CASE says so', () => {
        assert.ok(sql.includes(`WHEN 'FAILED' THEN (CASE WHEN ${expectedFailureSql('i.error_log')} THEN 'by_design' ELSE 'actionable' END)`));
    });

    it('takes other column names, written in source, and refuses anything that is not a column reference', () => {
        assert.ok(outcomeSql('s.status', 's.error_log').startsWith('CASE s.status WHEN'));
        for (const bad of ["i.status; DROP TABLE interactions", "i.status' OR '1'='1", 'i.status --', '', 'a.b.c', '1x', '$1']) {
            assert.throws(() => outcomeSql(bad), /not a column reference/, bad);
            assert.throws(() => expectedFailureSql(bad), /not a column reference/, bad);
        }
        assert.throws(() => outcomeCountsSql('i.id', 'o.outcome', "x; DROP"), /not a column prefix/);
    });

    it('counts every outcome by `COUNT(id) FILTER`, so a LEFT-JOINed row that matched nothing is in none of them', () => {
        const counts = outcomeCountsSql();
        for (const o of OUTCOMES) assert.ok(counts.includes(`COUNT(i.id) FILTER (WHERE o.outcome = '${o}')::int AS ${o}`), o);
        assert.ok(outcomeCountsSql('i.id', 'o.outcome', 'outcome_').includes("::int AS outcome_by_design"));
        assert.match(outcomeLateral(), /^LATERAL \(SELECT CASE i\.status .* AS outcome\) o$/);
    });
});

// ─── Against a real PostgreSQL, when one is given ─────────────────────────────────────────────────────────────────────────────
const PG_URL = process.env.OUTCOMES_SQL_PG_URL;

describe('outcomeSql on a real PostgreSQL', { skip: PG_URL ? false : 'set OUTCOMES_SQL_PG_URL to a throwaway PostgreSQL to run' }, () => {
    it('agrees with classifyOutcome on every (status, error_log) pair', async () => {
        const client = new pg.Client({ connectionString: PG_URL });
        await client.connect();
        try {
            const bad: string[] = [];
            for (const status of STATUSES) {
                for (const log of CORPUS) {
                    const { rows } = await client.query(
                        `SELECT ${outcomeSql('s.status', 's.error_log')} AS outcome, ${expectedFailureSql('s.error_log')} AS expected
                           FROM (SELECT $1::text AS status, $2::text AS error_log) s`,
                        [status === undefined || typeof status === 'number' ? null : status, log],
                    );
                    const want = classifyOutcome(typeof status === 'number' ? 7 : status, log);
                    // A status that is not text reaches the database as NULL, which the CASE sends to the same bucket.
                    if (rows[0].outcome !== want) bad.push(JSON.stringify({ status, log, got: rows[0].outcome, want }));
                    if (status === 'FAILED' && rows[0].expected !== isExpectedFailure(log)) bad.push(JSON.stringify({ log, expected: rows[0].expected }));
                }
            }
            assert.deepEqual(bad, [], 'every pair agrees');
        } finally {
            await client.end();
        }
    });
});
