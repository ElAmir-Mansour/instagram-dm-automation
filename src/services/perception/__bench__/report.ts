/**
 * What a run says, as text: `docs/hackathon/benchmark.md` for the repository and a short table for the terminal. Pure: a finished run in, text out, so the numbers on the screen, in
 * the document and in the chart (`svg.ts`) are read from the same `ArmSummary` and cannot disagree.
 *
 * The document is written to be read by someone who does not trust it, so it shows what a flattering one would leave out: every failure with its case id and a line of why, the
 * arms that did not run and what they were waiting for, the bar the shipped path is held to and whether it met it, today's behaviour beside it, what the numbers do not measure, and
 * the command that makes them again. Nothing in it is hand-edited: it is the output of the script, and the date, the models and the cases' digest say which run it is.
 */
import { SOFT_CRITERIA } from '../../dmSales/__evals__/types.js';
import { DEFAULT_PRICES } from '../../llm/cost.js';
import { ARM_LABELS, dollars, percent, secs, targetsOf, barMet } from './metrics.js';
import type { MemoryResult, MemorySummary } from './memory.js';
import type { AnalysisRun } from './openWeights.js';
import type { ActionClass, ArmCaseResult, ArmId, ArmSummary, Failure, MuseCase, SkippedArm } from './types.js';

export interface BenchmarkRun {
    at: Date;
    /** The command as it was typed, with home folders shortened. */
    command: string;
    /** A dry run with canned answers: the document says so, and is never a measurement. */
    stub: boolean;
    models: { perception: string; reply: string; judge: string | null; speech: string | null; open: string | null };
    casesDigest: string;
    promptDigest: string;
    mediaDir: string;
    cases: readonly MuseCase[];
    /** Cases left out for want of a file, by id. */
    skippedCases: readonly { caseId: string; why: string }[];
    results: readonly ArmCaseResult[];
    summaries: readonly ArmSummary[];
    skippedArms: readonly SkippedArm[];
    memory: { library: number; results: readonly MemoryResult[]; summaries: readonly MemorySummary[] } | null;
    openWeights: readonly AnalysisRun[] | null;
    judgeUsd: number | null;
    /** Calls charged at the table's ceiling because their model has no price. */
    unpriced: number;
}

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A cell of a table: no pipe, no line break. */
export const cell = (text: string): string => String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
/** Text inside an HTML element of the document: the three characters markup reads. */
export const html = (text: string): string => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const oneLine = (text: string, max = 200): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

const ACTION_SHORT: Readonly<Record<ActionClass, string>> = Object.freeze({
    answer: 'answer', recommend: 'recommend', resend: 'ask to resend', handoff: 'hand off', thank_named: 'thanks, by name', thank: 'generic thanks', generic_line: 'fixed line',
    silent: 'nothing sent', error: 'error',
});

const KIND_WORDS: Readonly<Record<MuseCase['kind'], string>> = Object.freeze({
    image: 'photo', video: 'video', story_mention: 'story mention', reel: 'reel', voice: 'voice note',
});

function kindOf(c: MuseCase): string {
    if (c.kind === 'reel') return c.owner === 'other' ? 'reel by another creator' : 'the account\'s own reel';
    return `${KIND_WORDS[c.kind]}${c.source.kind === 'synthetic' ? ' (drawn by the script)' : ''}`;
}

const expected = (c: MuseCase): string => c.expect.action.map((a) => ACTION_SHORT[a]).join(' or ');

/** An arm's row of the headline table. An arm that says nothing of its own has no draft to invent in. */
function armRow(s: ArmSummary): string[] {
    const own = s.arm === 'today' || s.arm === 'today_voice';
    return [
        s.label, String(s.cases), `${percent(s.understood)} (${s.understood.n}/${s.understood.of})`, `${percent(s.expectedAction)} (${s.expectedAction.n}/${s.expectedAction.of})`,
        own ? String(s.inventedSent) : `${s.inventedSent} sent · ${s.inventedDraft} in the draft`, secs(s.p50Ms), secs(s.p90Ms), dollars(s.usdPerReply),
    ];
}

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
    [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

const HEADLINE = ['Arm', 'Cases', 'Understood', 'Expected action', 'Invented facts', 'p50', 'p90', 'Cost per reply'];

function failureLine(f: Failure): string {
    return `- ${code(f.caseId)} **${f.what}**: ${cell(f.reason)}`;
}

// ─── The document ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function renderMarkdown(run: BenchmarkRun): string {
    const out: string[] = ['# Benchmark: what the agent does with what it is sent', ''];
    if (run.stub) out.push('> **Dry run.** The answers are canned, nothing was sent to Meta and nothing was billed. These numbers are not a measurement of anything.', '');
    out.push('![What the agent does with what it is sent](benchmark.svg)', '');

    const by = (arm: ArmId): ArmSummary | undefined => run.summaries.find((s) => s.arm === arm && s.cases > 0);
    const meta = by('meta');
    const mediaCases = run.cases.filter((c) => c.kind !== 'voice');
    const voiceCases = run.cases.filter((c) => c.kind === 'voice');

    // What this is, and which run.
    out.push(
        `A hand-run check of the sales agent on what followers send without a word: photos, videos, shared reels, story mentions and, when its module is in, voice notes. The shipped path (Meta Muse reads it, then the sales agent answers) is set beside what the agent did before Muse, case by case, with every failure listed.`,
        '',
        `- **Date:** ${run.at.toISOString().slice(0, 10)} (UTC)`,
        `- **Command:** ${code(run.command)}`,
        `- **Models:** perception and replies ${code(run.models.perception)} at low effort${run.models.speech ? `; speech ${code(run.models.speech)}` : ''}${run.models.open ? `; open weights ${code(run.models.open)}` : ''}${run.models.judge ? `; judge ${code(run.models.judge)}` : '; no judge (every number below is checked in code)'}`,
        `- **Cases:** ${run.cases.length} (${mediaCases.length} media, ${voiceCases.length} voice) from ${code('scripts/eval-muse/cases.json')}, digest ${code(run.casesDigest)}; prompts built from the committed fixtures, digest ${code(run.promptDigest)}`,
        `- **Media:** read from ${code(run.mediaDir)}; no media file is in this repository`,
        '',
    );

    // The result.
    out.push('## Result', '');
    const media = ['meta', 'today'].map((a) => by(a as ArmId)).filter((s): s is ArmSummary => s !== undefined);
    if (media.length > 0) {
        out.push('### Messages with no words', '', table(HEADLINE, media.map(armRow)), '');
    }
    const voice = ['voice', 'today_voice'].map((a) => by(a as ArmId)).filter((s): s is ArmSummary => s !== undefined);
    if (voice.length > 0) out.push('### Voice notes', '', table(HEADLINE, voice.map(armRow)), '');

    if (run.memory && run.memory.summaries.some((m) => m.questions > 0)) {
        out.push(
            '### Memory: does the right reel come back?', '',
            table(
                ['Library', 'Questions', 'Right reel', 'Of those only shown on screen', 'Of those said aloud', 'Invented links', 'p50', 'p90', 'Cost'],
                run.memory.summaries.map((m) => [
                    m.label, String(m.questions), `${m.right.n}/${m.right.of}`, `${m.rightVisual.n}/${m.rightVisual.of}`, `${m.rightSpoken.n}/${m.rightSpoken.of}`, String(m.inventedLinks), secs(m.p50Ms), secs(m.p90Ms), dollars(m.usd),
                ]),
            ),
            '',
            `The same recall, the same model and the same ${run.memory.library} reels; the second library keeps only what each reel says aloud.`,
            '',
        );
    }

    if (run.openWeights && run.openWeights.length > 0) out.push(...openWeightsSection(run.openWeights));

    // Against the bar.
    if (meta) {
        const targets = targetsOf(meta);
        out.push(
            '## Against the bar', '',
            `The success criteria the shipped path was built to (the first three are about replies, the fourth about cost). ${barMet(run.summaries) ? 'All are met on this run.' : 'Not all are met on this run.'}`, '',
            table(['Criterion', 'This run', 'Goal', 'Verdict'], targets.map((t) => [t.label, t.value, t.goal, t.met ? 'met' : 'missed'])), '',
        );
    }

    // Failures.
    out.push('## Every failure', '');
    const failuresOf = (arm: ArmId): Failure[] => run.results.filter((r) => r.arm === arm && r.status === 'ran').flatMap((r) => r.failures);
    for (const arm of ['meta', 'voice'] as const) {
        if (!by(arm)) continue;
        const list = failuresOf(arm);
        out.push(`### ${ARM_LABELS[arm]}: ${list.length === 0 ? 'none' : list.length}`, '');
        if (list.length > 0) out.push(...list.map(failureLine), '');
        else out.push('Every check passed on every case that ran.', '');
    }
    for (const arm of ['today', 'today_voice'] as const) {
        if (!by(arm)) continue;
        const list = failuresOf(arm);
        out.push(`<details><summary>${html(ARM_LABELS[arm])}: ${list.length} ${list.length === 1 ? 'case where' : 'cases where'} what it did was not what the case asks for</summary>`, '', 'It never opens an attachment, so it understands none of them; this lists where the line it sends is the wrong action.', '', ...list.map(failureLine), '', '</details>', '');
    }
    if (run.memory) {
        for (const m of run.memory.summaries.filter((x) => x.questions > 0 && x.failures.length > 0)) {
            out.push(`### ${m.label}: ${m.failures.length}`, '', ...m.failures.map((f) => `- ${code(f.questionId)}: ${cell(f.reason)}`), '');
        }
    }

    // Case by case.
    out.push('## Case by case', '');
    const rows = run.cases.filter((c) => !run.skippedCases.some((s) => s.caseId === c.id)).map((c) => {
        const find = (arm: ArmId): ArmCaseResult | undefined => run.results.find((r) => r.arm === arm && r.caseId === c.id && r.status === 'ran');
        const shown = (r: ArmCaseResult | undefined): string => (r ? `${ACTION_SHORT[r.action]} (${r.actionOk ? 'as expected' : 'miss'})` : 'not run');
        const meta = find(c.kind === 'voice' ? 'voice' : 'meta');
        const today = find(c.kind === 'voice' ? 'today_voice' : 'today');
        return [code(c.id), kindOf(c), c.typed ? `«${c.typed}»` : 'nothing typed', expected(c), shown(meta), shown(today)];
    });
    out.push(table(['Case', 'What was sent', 'Typed with it', 'Expected', 'Meta Muse', 'Today'], rows), '');

    out.push('### What each case got', '');
    for (const c of run.cases) {
        const r = run.results.find((x) => x.arm === (c.kind === 'voice' ? 'voice' : 'meta') && x.caseId === c.id && x.status === 'ran');
        const t = run.results.find((x) => x.arm === (c.kind === 'voice' ? 'today_voice' : 'today') && x.caseId === c.id && x.status === 'ran');
        if (!r) continue;
        out.push(`<details><summary>${code(c.id)}: ${html(c.title)}</summary>`, '');
        if (c.note) out.push(`*${html(oneLine(c.note, 400))}*`, '');
        out.push(`- **What it saw:** ${r.seen ? html(oneLine(r.seen, 400)) : 'nothing it could say'}`);
        if (r.trace) out.push(`- **What it did, in the words the inbox shows:** ${html(r.trace)}`);
        out.push(`- **What the customer got:** ${r.reply ? html(oneLine(r.reply, 500)) : '(nothing sent)'}`);
        if (r.failures.length > 0) out.push(`- **Failed:** ${r.failures.map((f) => `${f.what}: ${html(f.reason)}`).join('; ')}`);
        if (t) out.push(`- **Today:** ${t.reply ? html(oneLine(t.reply, 300)) : '(nothing sent)'}`);
        out.push('', '</details>', '');
    }

    // What did not run.
    const notRun = [...run.skippedArms.map((s) => `- **${s.label}:** ${s.why}`), ...run.skippedCases.map((s) => `- ${code(s.caseId)}: ${s.why}`)];
    if (notRun.length > 0) out.push('## Not run', '', ...notRun, '');

    out.push(...methodSection(run));
    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function openWeightsSection(rows: readonly AnalysisRun[]): string[] {
    const names = [...new Set(rows.flatMap((r) => r.checks.map((c) => c.name)))];
    const facts = [...new Set(rows.flatMap((r) => r.facts.map((f) => f.name)))];
    const header = ['', ...rows.map((r) => r.label)];
    const body: string[][] = [
        ['Model', ...rows.map((r) => code(r.model))],
        ['Answered', ...rows.map((r) => (r.status === 'ok' ? 'yes' : `no: ${r.error ?? 'failed'}`))],
        ['Time', ...rows.map((r) => secs(r.ms))],
        ['Tokens in / out', ...rows.map((r) => (r.tokensIn === null ? '-' : `${r.tokensIn.toLocaleString('en-US')} / ${(r.tokensOut ?? 0).toLocaleString('en-US')}`))],
        ['Cost at list price', ...rows.map((r) => dollars(r.usd))],
        ...names.map((n) => [n.replace(/_/g, ' '), ...rows.map((r) => (r.status !== 'ok' ? '-' : r.checks.find((c) => c.name === n)?.pass ? 'pass' : `fail: ${r.checks.find((c) => c.name === n)?.detail ?? ''}`))]),
        ['Facts found', ...rows.map((r) => (r.status === 'ok' ? `${r.facts.filter((f) => f.found).length}/${r.facts.length}` : '-'))],
    ];
    const missed = facts.filter((f) => rows.some((r) => r.status === 'ok' && r.facts.find((x) => x.name === f)?.found === false));
    return [
        '### Open weights against hosted, on one reel', '', table(header, body), '',
        missed.length > 0 ? `Facts a model missed: ${missed.map((f) => `${f} (${rows.filter((r) => r.status === 'ok' && r.facts.find((x) => x.name === f)?.found === false).map((r) => r.label).join(', ')})`).join('; ')}.` : 'Both found every fact the reel is known to hold.',
        '', 'Same reel, same prompt, same schema and same limits as the video memory\'s indexer sends. Only the account\'s own reel goes to the open model\'s host: followers\' messages stay with Meta\'s hosted models.', '',
    ];
}

function methodSection(run: BenchmarkRun): string[] {
    const crit = SOFT_CRITERIA.join(', ');
    return [
        '## How to read this', '',
        '- **Understood** is checked on words: what Muse reported it saw or heard has to contain what the case says the picture holds (a price, a topic, a name). A picture that cannot be read counts as understood when the agent says so instead of guessing. An arm that never opens an attachment understands none.',
        '- **Expected action** is one of the actions the case accepts (answer, recommend the right offer, ask to resend, hand off, thank by name), taken from the sales agent\'s own decision, and for a recommendation the offer must be the right one.',
        '- **Invented facts** counts replies that state a number, a price, a discount or a link that the account\'s information does not hold, or a fact the case forbids (a price the picture showed). The second number is the first draft, before the guard that strips a link and refuses a reply with such a number; the one that must be 0 is what the customer is sent.',
        '- **Latency** is the time Muse takes to read the media and write the answer. It leaves out downloading the file from Instagram and sending the reply, which the live path adds.',
        `- **Cost** is what the responses said they used, at the list price in ${code('src/services/llm/cost.ts')} (Muse Spark $${DEFAULT_PRICES['muse-spark-1.3']!.in} in and $${DEFAULT_PRICES['muse-spark-1.3']!.out} out per million tokens), divided by the replies sent.${run.judgeUsd !== null ? ` The judge cost ${dollars(run.judgeUsd)} more and is not in it.` : ''}${run.unpriced > 0 ? ` ${run.unpriced} call${run.unpriced === 1 ? ' was' : 's were'} charged at the table's ceiling because the model has no price.` : ''}`,
        '- **Today** is what the agent sent before Muse: for a message with no words, one fixed line, once a day; for a message with words, an answer from the words alone, with the attachment never opened (so those cases ask a model, the same one, with nothing about the media in front of it).',
        '- **Typed words.** When a case has words, they are the question and what was shared rides along as a fact, the way a reply to a story with words does in the product. Instagram delivers a shared reel and the words typed under it as two messages; this joins them.',
        '- **One draft.** The first answer is the one judged. The product asks the model once more when its guard refuses a reply, which this does not count.',
        `- **The judge**${run.models.judge ? ` (${crit}) scored the replies that were sent in the model's own words` : ' did not run, so tone and helpfulness are not scored here'}.`,
        `- **What this does not show.** ${run.cases.length} cases are few, so one case moves a rate by several points. The cases and what each expects were written by the builders of the agent, in one file anyone can read and change. One run is one run: the models are not deterministic, and a second run can differ. Two cases are pictures drawn by the script (a made-up identity card and a story), because no real document or follower should be used. Instagram\'s delivery, real followers and the live webhook are not part of it.`,
        '', `Run it again: ${code(run.command)}`, '',
    ];
}

// ─── The terminal ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A plain-text table for the terminal, with a rule under the header. */
function plain(header: readonly string[], rows: readonly (readonly string[])[]): string {
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
    const line = (r: readonly string[]): string => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
    return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

export function renderTerminal(run: BenchmarkRun): string {
    const out: string[] = [];
    if (run.stub) out.push('DRY RUN: canned answers, nothing sent to Meta, not a measurement.', '');
    out.push(plain(['arm', 'cases', 'understood', 'action', 'invented (sent/draft)', 'p50', 'p90', '$/reply'], run.summaries.filter((s) => s.cases > 0).map((s) => [
        s.arm, String(s.cases), percent(s.understood), percent(s.expectedAction), `${s.inventedSent}/${s.inventedDraft}`, secs(s.p50Ms), secs(s.p90Ms), dollars(s.usdPerReply),
    ])));
    for (const s of run.summaries.filter((x) => x.cases > 0 && (x.arm === 'meta' || x.arm === 'voice') && x.failures.length > 0)) {
        out.push('', `${s.arm}: ${s.failures.length} failure${s.failures.length === 1 ? '' : 's'}`, ...s.failures.map((f) => `  ${f.caseId} - ${f.what}: ${f.reason}`));
    }
    for (const s of run.skippedArms) out.push('', `not run: ${s.label}: ${s.why}`);
    for (const s of run.skippedCases) out.push(`not run: ${s.caseId}: ${s.why}`);
    return out.join('\n');
}

