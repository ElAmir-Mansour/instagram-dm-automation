/**
 * What a run says, as numbers and as text (docs/DM_SALES_PLAN.md §11): the pass rate, how long the model took, what it cost, and every
 * failure with its reason, for each model, in the terminal and as a markdown report to attach to a PR. This is how the `dm` route is chosen.
 *
 * The bar a model must clear (§11): every hard check passes, the judge's mean is at least 4, and no judged score is under 3. A run that
 * did not score the soft checks (no judge) can only fail the bar, never meet it on hard checks alone: nothing unscored is a pass.
 *
 * Pure. Numbers are computed here and nowhere else, so the terminal and the markdown cannot disagree.
 */
import { isJudgeFailure, JUDGE_FLOOR, JUDGE_MEAN_TARGET } from './judge.js';
import { SOFT_CRITERIA, type CaseOutcome, type EvalRun, type SoftCriterion, type TurnOutcome } from './types.js';

/** The value at percentile `p` (0 to 100) by nearest rank, or null for no values. p50 of [1,2,3,4] is 2; p90 of ten values is the ninth. */
export function percentile(values: readonly number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
    return sorted[rank - 1]!;
}

export interface Failure {
    case: string;
    turn: number;
    /** The check, or `judge`, or `skipped`. */
    what: string;
    detail: string;
}

export interface RunSummary {
    model: string;
    provider: string;
    effort: string;
    judgeModel: string | null;
    cases: number;
    passed: number;
    passRate: number;
    turns: number;
    /** Turns the model was asked about. The rest were decided by the pre-filter or were silent. */
    modelCalls: number;
    hardChecks: number;
    hardFailures: number;
    judged: number;
    judgeFailures: number;
    judgeMean: number | null;
    judgeMin: number | null;
    criterionMeans: Partial<Record<SoftCriterion, number>>;
    p50Ms: number | null;
    p90Ms: number | null;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    usd: number;
    judgeUsd: number;
    /** Answers `coerceSalesReply` had to repair. */
    repairs: number;
    guardFallbacks: number;
    failures: Failure[];
    barMet: boolean;
    barReasons: string[];
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/** The scores the judge gave a turn, criterion by criterion; none when it was not judged or the judge failed. */
function judgedScores(t: TurnOutcome): [SoftCriterion, number][] {
    if (!t.judge || isJudgeFailure(t.judge)) return [];
    const given = t.judge.scores;
    return SOFT_CRITERIA.flatMap((k) => (given[k] === undefined ? [] : [[k, given[k]!] as [SoftCriterion, number]]));
}

/** Everything the report says about one run, computed once. */
export function summarize(run: EvalRun): RunSummary {
    const judged = run.judgeModel !== null;
    const failures: Failure[] = [];
    const latencies: number[] = [];
    const scores: number[] = [];
    const byCriterion = new Map<SoftCriterion, number[]>();
    let turns = 0;
    let modelCalls = 0;
    let hardChecks = 0;
    let hardFailures = 0;
    let judgedTurns = 0;
    let judgeFailures = 0;
    let repairs = 0;
    let guardFallbacks = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let usd = 0;
    let judgeUsd = 0;

    for (const c of run.cases) {
        for (const t of c.turns) {
            turns += 1;
            if (t.usage) {
                modelCalls += 1;
                tokensIn += t.usage.in;
                tokensOut += t.usage.out;
                cacheRead += t.usage.cacheRead ?? 0;
                cacheWrite += t.usage.cacheWrite ?? 0;
                usd += t.usd ?? 0;
                if (t.latencyMs !== undefined) latencies.push(t.latencyMs);
            } else if (t.error) {
                modelCalls += 1;
            }
            if (t.repaired.length > 0) repairs += 1;
            if (t.guardFallback) guardFallbacks += 1;
            for (const check of t.checks) {
                hardChecks += 1;
                if (!check.pass) {
                    hardFailures += 1;
                    failures.push({ case: c.id, turn: t.index, what: check.name, detail: check.detail });
                }
            }
            if (t.judge) {
                if (isJudgeFailure(t.judge)) {
                    judgeFailures += 1;
                    failures.push({ case: c.id, turn: t.index, what: 'judge', detail: `not scored: ${t.judge.error}` });
                } else {
                    judgedTurns += 1;
                    judgeUsd += t.judge.usd;
                    for (const [criterion, score] of judgedScores(t)) {
                        scores.push(score);
                        byCriterion.set(criterion, [...(byCriterion.get(criterion) ?? []), score]);
                        if (score < JUDGE_FLOOR) {
                            failures.push({ case: c.id, turn: t.index, what: 'judge', detail: `${criterion} scored ${score}: ${t.judge.notes || 'no notes'}` });
                        }
                    }
                }
            }
        }
        if (c.skipped > 0) failures.push({ case: c.id, turn: c.turns.length + 1, what: 'skipped', detail: `${c.skipped} later turn${c.skipped === 1 ? '' : 's'} not run: the model gave no answer to an earlier one` });
    }

    const passed = run.cases.filter((c) => c.pass).length;
    const judgeMean = mean(scores);
    const judgeMin = scores.length === 0 ? null : Math.min(...scores);
    const criterionMeans: Partial<Record<SoftCriterion, number>> = {};
    for (const [criterion, list] of byCriterion) criterionMeans[criterion] = mean(list)!;

    const barReasons: string[] = [];
    if (hardFailures > 0) barReasons.push(`${hardFailures} hard-check failure${hardFailures === 1 ? '' : 's'}`);
    if (run.cases.some((c) => c.skipped > 0)) barReasons.push('a conversation stopped early');
    if (!judged) barReasons.push('soft checks not scored (no judge)');
    else {
        if (judgeFailures > 0) barReasons.push(`${judgeFailures} reply${judgeFailures === 1 ? '' : 's'} not scored by the judge`);
        if (judgeMean !== null && judgeMean < JUDGE_MEAN_TARGET) barReasons.push(`judge mean ${judgeMean.toFixed(2)} is under ${JUDGE_MEAN_TARGET}`);
        if (judgeMin !== null && judgeMin < JUDGE_FLOOR) barReasons.push(`a judged score of ${judgeMin} is under ${JUDGE_FLOOR}`);
        if (judgedTurns === 0 && judgeFailures === 0) barReasons.push('the judge scored nothing');
    }

    return {
        model: run.model, provider: run.provider, effort: run.effort, judgeModel: run.judgeModel,
        cases: run.cases.length, passed, passRate: run.cases.length === 0 ? 0 : passed / run.cases.length,
        turns, modelCalls, hardChecks, hardFailures, judged: judgedTurns, judgeFailures, judgeMean, judgeMin, criterionMeans,
        p50Ms: percentile(latencies, 50), p90Ms: percentile(latencies, 90),
        tokensIn, tokensOut, cacheRead, cacheWrite, usd, judgeUsd, repairs, guardFallbacks, failures,
        barMet: barReasons.length === 0, barReasons,
    };
}

// ─── Formatting ──────────────────────────────────────────────────────────────────────────────

const int = (n: number): string => Math.round(n).toLocaleString('en-US');
const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;
const secs = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);
const dollars = (n: number): string => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const score = (n: number | null): string => (n === null ? '-' : n.toFixed(2));
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const html = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim();

/** How a turn was decided, in one short word. */
const routeWord = (t: TurnOutcome): string => (t.route === 'prefilter' ? `filter:${t.prefilter}` : t.route);

const caseJudge = (c: CaseOutcome): number | null => mean(c.turns.flatMap((t) => judgedScores(t).map(([, v]) => v)));

function caseLatency(c: CaseOutcome): number | null {
    const values = c.turns.map((t) => t.latencyMs).filter((v): v is number => v !== undefined);
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
}

/** The result of one case, as a word. */
const resultOf = (c: CaseOutcome): string => (c.pass ? 'PASS' : 'FAIL');

function pad(text: string, width: number, right = false): string {
    return right ? text.padStart(width) : text.padEnd(width);
}

/** A table of rows as aligned plain text, with a rule under the header. */
function table(header: readonly string[], rows: readonly (readonly string[])[], rightFrom = Infinity): string {
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
    const line = (r: readonly string[]): string => r.map((c, i) => pad(c, widths[i]!, i >= rightFrom)).join('  ').trimEnd();
    return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const title = (s: RunSummary): string => `${s.model} (${s.provider}, effort ${s.effort})${s.judgeModel ? `, judge ${s.judgeModel}` : ', no judge'}`;

function statLines(s: RunSummary): string[] {
    const lines = [
        `cases     ${s.cases}, passed ${s.passed} (${pct(s.passRate)}); hard checks ${s.hardChecks - s.hardFailures}/${s.hardChecks}; the model was asked on ${s.modelCalls} of ${s.turns} turns`,
        `bar       ${s.barMet ? 'MET' : `NOT MET: ${s.barReasons.join('; ')}`}`,
        `latency   p50 ${secs(s.p50Ms)}, p90 ${secs(s.p90Ms)} (over ${s.modelCalls} model calls; the target is p50 under 10 s, p90 under 20 s)`,
        `tokens    in ${int(s.tokensIn)}, out ${int(s.tokensOut)}${s.cacheRead || s.cacheWrite ? `, cache read ${int(s.cacheRead)}, cache write ${int(s.cacheWrite)}` : ''}`,
        `cost      ${dollars(s.usd)} for the model${s.judgeModel ? ` + ${dollars(s.judgeUsd)} for the judge = ${dollars(s.usd + s.judgeUsd)}` : ''}${s.modelCalls > 0 ? `; ${dollars(s.usd / s.modelCalls)} a model call` : ''}`,
    ];
    if (s.judgeModel) {
        const parts = SOFT_CRITERIA.map((k) => (s.criterionMeans[k] === undefined ? null : `${k} ${score(s.criterionMeans[k]!)}`)).filter(Boolean);
        lines.push(`judge     mean ${score(s.judgeMean)}, lowest ${s.judgeMin ?? '-'}${parts.length ? `; ${parts.join(', ')}` : ''}`);
    }
    if (s.repairs > 0 || s.guardFallbacks > 0) lines.push(`repairs   ${s.repairs} answer${s.repairs === 1 ? '' : 's'} needed coercion; the guard refused ${s.guardFallbacks}`);
    return lines;
}

/** One model, for the terminal. */
function runText(run: EvalRun): string {
    const s = summarize(run);
    const rows = run.cases.map((c) => [c.id, c.writes, c.fixture, String(c.turns.length + c.skipped), [...new Set(c.turns.map(routeWord))].join('>'), resultOf(c), score(caseJudge(c)), secs(caseLatency(c))]);
    const out = [
        `== ${title(s)} ==`,
        ...statLines(s),
        '',
        table(['case', 'writes', 'fixture', 'turns', 'decided by', 'result', 'judge', 'latency'], rows, 6),
    ];
    if (s.failures.length > 0) {
        out.push('', 'failures:');
        for (const f of s.failures) out.push(`  ${f.case} turn ${f.turn} - ${f.what}: ${f.detail}`);
    }
    return out.join('\n');
}

/** The side-by-side of every model in a run. */
function comparisonRows(summaries: readonly RunSummary[]): { header: string[]; rows: string[][] } {
    return {
        header: ['model', 'passed', 'hard fails', 'judge mean', 'p50', 'p90', 'tokens in/out', 'model $', 'judge $', 'bar'],
        rows: summaries.map((s) => [
            s.model, `${s.passed}/${s.cases} (${pct(s.passRate)})`, String(s.hardFailures), score(s.judgeMean), secs(s.p50Ms), secs(s.p90Ms),
            `${int(s.tokensIn)}/${int(s.tokensOut)}`, dollars(s.usd), s.judgeModel ? dollars(s.judgeUsd) : '-', s.barMet ? 'MET' : 'NOT MET',
        ]),
    };
}

/** The whole terminal report: a comparison when there is more than one model, then one block per model. */
export function renderTerminal(runs: readonly EvalRun[]): string {
    const blocks: string[] = [];
    if (runs.length > 1) {
        const { header, rows } = comparisonRows(runs.map(summarize));
        blocks.push(table(header, rows));
    }
    for (const run of runs) blocks.push(runText(run));
    return blocks.join('\n\n');
}

// ─── Markdown ────────────────────────────────────────────────────────────────────────────────

export interface ReportMeta {
    at: Date;
    /** The command that produced it, without any secret (there is none on the command line). */
    command: string;
    /** A dry run with canned answers: the report says so at the top, so nobody picks a model by it. */
    stub: boolean;
    cacheSystem: boolean;
}

function mdTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
    return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

function mdCase(c: CaseOutcome): string {
    const lines = [`<details><summary><code>${c.id}</code> ${html(c.title)}: ${resultOf(c)}</summary>`, ''];
    for (const t of c.turns) {
        lines.push(`**Turn ${t.index}** (${routeWord(t)}${t.model ? `, ${t.model.next_action}${t.model.offer_id !== 'none' ? ` ${t.model.offer_id}` : ''}${t.model.handoff_reason !== 'none' ? `, ${t.model.handoff_reason}` : ''}` : ''})`, '');
        lines.push(`> Customer: ${t.user.replace(/\n/g, ' ')}`, '>');
        lines.push(`> Bot (${t.sent.kind}${t.guardFallback ? ', after the guard refused the model' : ''}): ${t.sent.text ? t.sent.text.replace(/\n/g, ' ') : '(nothing sent)'}`);
        if (t.rawText !== undefined && t.sent.kind !== 'model' && t.rawText.trim()) lines.push('>', `> Model wrote (not sent): ${t.rawText.replace(/\n/g, ' ')}`);
        lines.push('');
        const bad = t.checks.filter((k) => !k.pass);
        if (bad.length > 0) for (const k of bad) lines.push(`- FAIL \`${k.name}\`: ${k.detail}`);
        if (t.error) lines.push(`- model call failed (${t.error.kind}): ${t.error.message}`);
        if (t.judge) {
            if (isJudgeFailure(t.judge)) lines.push(`- judge: not scored (${t.judge.error})`);
            else lines.push(`- judge: ${judgedScores(t).map(([k, v]) => `${k} ${v}`).join(', ')}${t.judge.notes ? `; ${t.judge.notes}` : ''}`);
        }
        if (bad.length > 0 || t.error || t.judge) lines.push('');
    }
    if (c.skipped > 0) lines.push(`${c.skipped} later turn${c.skipped === 1 ? '' : 's'} not run.`, '');
    lines.push('</details>');
    return lines.join('\n');
}

/** The report as markdown, for a file. */
export function renderMarkdown(runs: readonly EvalRun[], meta: ReportMeta): string {
    const summaries = runs.map(summarize);
    const first = runs[0];
    const out: string[] = ['# DM sales evaluation', ''];
    if (meta.stub) out.push('> **Dry run.** The answers are canned, nothing was sent to a model and nothing was billed. Do not choose a model by this report.', '');
    out.push(
        `- Run: ${meta.at.toISOString()}`,
        `- Command: \`${meta.command}\``,
        `- Cases: ${first ? first.cases.length : 0} (cases digest \`${first?.casesDigest ?? '-'}\`)`,
        `- Prompts: built from the committed fixtures (digest \`${first?.promptDigest ?? '-'}\`); a changed digest means the prompt, the kit lines or the fixtures changed since another report`,
        `- System prompt cache: ${meta.cacheSystem ? 'on, as the live path asks for it' : 'off'}`,
        `- The bar (docs/DM_SALES_PLAN.md §11): every hard check passes, the judge's mean is at least ${JUDGE_MEAN_TARGET}, and no judged score is under ${JUDGE_FLOOR}`,
        '',
    );
    if (runs.length > 1) {
        const { header, rows } = comparisonRows(summaries);
        out.push('## Comparison', '', mdTable(header, rows), '');
    }
    for (const [i, run] of runs.entries()) {
        const s = summaries[i]!;
        out.push(`## ${title(s)}`, '', ...statLines(s).map((l) => `- ${l.replace(/^(\w+)\s+/, '**$1** ')}`), '');
        out.push(mdTable(['case', 'writes', 'fixture', 'turns', 'decided by', 'result', 'judge', 'latency'],
            run.cases.map((c) => [`\`${c.id}\``, c.writes, c.fixture, String(c.turns.length + c.skipped), [...new Set(c.turns.map(routeWord))].join(' > '), resultOf(c), score(caseJudge(c)), secs(caseLatency(c))])), '');
        if (s.failures.length > 0) {
            out.push('### Failures', '', ...s.failures.map((f) => `- \`${f.case}\` turn ${f.turn}, **${f.what}**: ${f.detail}`), '');
        } else {
            out.push('No failures.', '');
        }
        out.push('### Conversations', '', ...run.cases.flatMap((c) => [mdCase(c), '']));
    }
    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

