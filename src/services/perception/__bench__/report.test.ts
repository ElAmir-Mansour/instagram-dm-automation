/**
 * The document the script writes (`report.ts`): that it says which run it is (the date, the command, the models, the cases' digest), shows every failure with its case id and a line
 * of why, says what did not run, holds the shipped path to the bar in words, and escapes what it quotes. And that it is the kind of copy the repository accepts: none of the words
 * the product never says (`npm run check:voice`'s own rules, applied to it), no mention of RAG or a million-token context, and no path in it that is not a tracked file (`npm run
 * check:docs`'s own check, applied to it).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
// @ts-ignore: plain ESM, no declaration file
import { checkDoc, trackedFiles } from '../../../../scripts/check-doc-refs.mjs';
// @ts-ignore: plain ESM, no declaration file
import { violations } from '../../../../scripts/check-voice.mjs';
import { cell, forDoc, html, renderMarkdown, renderTerminal, type BenchmarkRun } from './report.js';
import { printable } from './cli.js';
import type { MemoryResult } from './memory.js';
import { summarizeMemory } from './memory.js';
import { summarizeArm } from './metrics.js';
import type { AnalysisRun } from './openWeights.js';
import { caseOf, committed, REPO } from './testSupport.js';
import type { ArmCaseResult, ArmId, Failure } from './types.js';

function result(arm: ArmId, caseId: string, over: Partial<ArmCaseResult> = {}): ArmCaseResult {
    return {
        arm, caseId, status: 'ran', note: null, understood: true, understoodWhy: null, action: 'recommend', actionOk: true, actionWhy: null, seen: 'A screenshot of a price.', reply: 'هلا فيك! هذا الرابط.',
        trace: 'Read a photo; sent the offer\'s link, because they asked about the price.', invented: { draft: [], sent: [] }, failures: [], ms: 6000, usd: 0.012, tokensIn: 5000, tokensOut: 600, calls: 2, judge: null, ...over,
    };
}

const FAILURE: Failure = { caseId: 'image-garbled', arm: 'meta', what: 'action', reason: 'answered; expected a request to send it again | with a pipe' };

function run(over: Partial<BenchmarkRun> = {}): BenchmarkRun {
    const cases = committed().cases.filter((c) => ['image-price', 'image-garbled', 'reel-other', 'voice-payment'].includes(c.id));
    const results: ArmCaseResult[] = [
        result('meta', 'image-price'), result('meta', 'image-garbled', { action: 'answer', actionOk: false, actionWhy: FAILURE.reason, failures: [FAILURE], understood: false, understoodWhy: 'it described what could not be read' }),
        result('meta', 'reel-other', { seen: 'Read the caption. It says: «<b>x</b> & y»', reply: 'a <script>alert(1)</script> reply' }),
        result('today', 'image-price', { action: 'generic_line', actionOk: false, understood: false, reply: 'وصلني مرفقك', failures: [{ caseId: 'image-price', arm: 'today', what: 'action', reason: 'sent the fixed line; expected a recommendation' }], usd: 0, ms: 0, calls: 0 }),
        result('today', 'image-garbled', { action: 'generic_line', actionOk: false, understood: false, usd: 0, ms: 0, calls: 0 }),
        result('today', 'reel-other', { action: 'generic_line', actionOk: false, understood: false, usd: 0, ms: 0, calls: 0 }),
    ];
    const summaries = (['meta', 'today'] as const).map((a) => summarizeArm(a, a === 'meta' ? 'muse-spark-1.3' : 'none', results));
    return {
        at: new Date('2026-11-01T09:30:00Z'), command: 'npm run eval:muse -- --env ../.env', stub: false,
        models: { perception: 'muse-spark-1.3', reply: 'muse-spark-1.3', judge: null, speech: null, open: null }, casesDigest: 'abc123def456', promptDigest: '0123456789ab', mediaDir: '~/Desktop/media',
        cases, skippedCases: [{ caseId: 'voice-payment', why: 'voice-3.m4a is not in the media folder (~/Desktop/media)' }], results, summaries,
        skippedArms: [{ arm: 'voice', label: 'Meta voice (transcribe, then answer)', why: 'src/services/perception/voice.ts is not in this checkout yet (P3, the voice notes)' }],
        memory: null, openWeights: null, judgeUsd: null, unpriced: 0, ...over,
    };
}

const OPEN: AnalysisRun[] = [
    { label: 'Muse Spark, hosted by Meta', model: 'muse-spark-1.3', status: 'ok', error: null, ms: 29_000, tokensIn: 5863, tokensOut: 3371, usd: 0.0217, checks: [{ name: 'usable', pass: true, detail: '' }, { name: 'moments', pass: false, detail: '3 moments (at least 4)' }], facts: [{ name: 'paid one riyal', found: true }, { name: 'the fix', found: false }] },
    { label: 'Muse Spark Open, served by Baseten', model: 'meta-models/muse-spark-open-1026', status: 'failed', error: 'timeout', ms: null, tokensIn: null, tokensOut: null, usd: null, checks: [], facts: [] },
];

describe('the document', () => {
    const md = renderMarkdown(run());

    it('says which run it is: the date, the exact command, the models, the cases and their digest, where the media was read from', () => {
        assert.match(md, /^# Benchmark: what the agent does with what it is sent/);
        assert.match(md, /- \*\*Date:\*\* 2026-11-01 \(UTC\)/);
        assert.match(md, /- \*\*Command:\*\* `npm run eval:muse -- --env \.\.\/\.env`/);
        assert.match(md, /- \*\*Models:\*\* perception and replies `muse-spark-1\.3` at low effort; no judge/);
        assert.match(md, /- \*\*Cases:\*\* 4 \(3 media, 1 voice\) from `scripts\/eval-muse\/cases\.json`, digest `abc123def456`/);
        assert.match(md, /- \*\*Media:\*\* read from `~\/Desktop\/media`; no media file is in this repository/);
        assert.match(md, /!\[What the agent does with what it is sent\]\(benchmark\.svg\)/);
        assert.doesNotMatch(md, /Dry run/);
    });

    it('has the headline table: each arm with its cases, understood, expected action, invented facts, p50, p90 and cost per reply', () => {
        assert.match(md, /\| Arm \| Cases \| Understood \| Expected action \| Invented facts \| p50 \| p90 \| Cost per reply \|/);
        assert.match(md, /\| Meta Muse \(shipped path\) \| 3 \| 66\.7% \(2\/3\) \| 66\.7% \(2\/3\) \| 0 sent · 0 in the draft \| 6\.0 s \| 6\.0 s \| \$0\.0120 \|/);
        assert.match(md, /\| Today \(before Muse\) \| 3 \| 0% \(0\/3\) \| 0% \(0\/3\) \| 0 \| 0\.0 s \| 0\.0 s \| \$0\.0000 \|/);
    });

    it('holds the shipped path to the bar in words, with what it did against each line, and says it did not meet it', () => {
        assert.match(md, /## Against the bar/);
        assert.match(md, /Not all are met on this run\./);
        assert.match(md, /\| Expected action \| 66\.7% \| at least 90% \| missed \|/);
        assert.match(md, /\| Invented facts sent \| 0 \| 0 \| met \|/);
        assert.match(md, /\| p90 latency \| 6\.0 s \| at most 60 s \| met \|/);
    });

    it('lists every failure of the shipped path with its case id and a line of why, a pipe in the reason kept out of the table\'s way', () => {
        assert.match(md, /### Meta Muse \(shipped path\): 1\n\n- `image-garbled` \*\*action\*\*: answered; expected a request to send it again \\\| with a pipe/);
    });

    it('puts today\'s failures behind a fold with the one sentence that explains them, and its failures there too', () => {
        assert.match(md, /<details><summary>Today \(before Muse\): 1 case where what it did was not what the case asks for<\/summary>/);
        assert.match(md, /It never opens an attachment, so it understands none of them/);
        assert.match(md, /- `image-price` \*\*action\*\*: sent the fixed line; expected a recommendation/);
    });

    it('has a row for every case that ran: what was sent, what was typed, what was expected, and what each arm did with a mark of whether it was as expected', () => {
        assert.match(md, /\| `image-price` \| photo \| nothing typed \| recommend or answer \| recommend \(as expected\) \| fixed line \(miss\) \|/);
        assert.match(md, /\| `image-garbled` \| photo \| nothing typed \| ask to resend \| answer \(miss\) \| fixed line \(miss\) \|/);
        assert.match(md, /\| `reel-other` \| reel by another creator \| nothing typed \| answer \| recommend \(as expected\)|\| `reel-other` \| reel by another creator \| nothing typed \| answer \|/);
        assert.doesNotMatch(md, /\| `voice-payment` \|/, 'a case that did not run is not in the table of what ran');
    });

    it('says what did not run, each with what it was waiting for', () => {
        assert.match(md, /## Not run/);
        assert.match(md, /- \*\*Meta voice \(transcribe, then answer\):\*\* voice\.ts is not in this checkout yet\n/);
        assert.doesNotMatch(md, /src\/services\/perception\/voice|\bP3\b/, 'a document names no file that is not in the repository yet, and none of the plan\'s own labels');
        assert.match(md, /- `voice-payment`: voice-3\.m4a is not in the media folder/);
    });

    it('shows what each case saw, what it did in the inbox\'s words and what the customer got, with markup in what it quotes turned into text', () => {
        assert.match(md, /<details><summary>`image-price`: A screenshot of the price, sent with no words<\/summary>/);
        assert.match(md, /- \*\*What it saw:\*\* A screenshot of a price\./);
        assert.match(md, /- \*\*What it did, in the words the inbox shows:\*\* Read a photo; sent the offer's link/);
        assert.match(md, /- \*\*What the customer got:\*\* هلا فيك! هذا الرابط\./);
        assert.doesNotMatch(md, /<script>/);
        assert.match(md, /a &lt;script&gt;alert\(1\)&lt;\/script&gt; reply/);
        assert.match(md, /«&lt;b&gt;x&lt;\/b&gt; &amp; y»/);
    });

    it('says how to read the numbers, and what they do not show: few cases, one run, cases written by the builders, two drawn pictures, no live followers', () => {
        assert.match(md, /## How to read this/);
        assert.match(md, /4 cases are few, so one case moves a rate by several points/);
        assert.match(md, /written by the builders of the agent/);
        assert.match(md, /One run is one run/);
        assert.match(md, /Two cases are pictures drawn by the script/);
        assert.match(md, /at the list price in `src\/services\/llm\/cost\.ts` \(Muse Spark \$1\.25 in and \$4\.25 out per million tokens\)/);
        assert.match(md, /Run it again: `npm run eval:muse -- --env \.\.\/\.env`/);
    });

    it('is the same text for the same run', () => {
        assert.equal(renderMarkdown(run()), renderMarkdown(run()));
        assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'));
        assert.doesNotMatch(md, /\n{3,}/);
    });
});

describe('the document, in the other cases', () => {
    it('says in a banner that a dry run is not a measurement', () => {
        assert.match(renderMarkdown(run({ stub: true })), /^# Benchmark[^\n]*\n\n> \*\*Dry run\.\*\* The answers are canned, nothing was sent to Meta and nothing was billed\. These numbers are not a measurement of anything\./);
    });

    it('says when the bar was met', () => {
        const only = run({ results: run().results.filter((r) => r.caseId !== 'image-garbled') });
        const met = renderMarkdown({ ...only, summaries: (['meta', 'today'] as const).map((a) => summarizeArm(a, 'm', only.results)), skippedCases: [] });
        assert.match(met, /All are met on this run\./);
        assert.match(met, /### Meta Muse \(shipped path\): none\n\nEvery check passed on every case that ran\./);
    });

    it('names the judge and its cost when it ran, and says tone is not scored when it did not', () => {
        const judged = renderMarkdown(run({ models: { ...run().models, judge: 'claude-opus-5-5' }, judgeUsd: 0.42 }));
        assert.match(judged, /judge `claude-opus-5-5`/);
        assert.match(judged, /The judge cost \$0\.42 more and is not in it\./);
        assert.match(judged, /\*\*The judge\*\* \(tone, helpfulness, no_pressure, right_recommendation\) scored the replies that were sent in the model's own words/);
        assert.match(renderMarkdown(run()), /\*\*The judge\*\* did not run, so tone and helpfulness are not scored here/);
    });

    it('says how many calls were charged at the ceiling because their model has no price', () => {
        assert.match(renderMarkdown(run({ unpriced: 2 })), /2 calls were charged at the table's ceiling because the model has no price/);
        assert.match(renderMarkdown(run({ unpriced: 1 })), /1 call was charged at the table's ceiling/);
    });

    it('shows the memory section: the right reel for each library, and the questions each got wrong', () => {
        const results: MemoryResult[] = [
            { arm: 'memory_visual', questionId: 'visual-green-sweater', ask: 'q', visualOnly: true, status: 'ran', ok: true, answeredWith: 'r1', inventedLink: false, why: null, ms: 2000, usd: 0.004 },
            { arm: 'memory_transcript', questionId: 'visual-green-sweater', ask: 'q', visualOnly: true, status: 'ran', ok: false, answeredWith: null, inventedLink: false, why: 'it said there is no such video', ms: 1500, usd: 0.003 },
        ];
        const md = renderMarkdown(run({ memory: { library: 70, results, summaries: [summarizeMemory('memory_visual', results), summarizeMemory('memory_transcript', results)] } }));
        assert.match(md, /### Memory: does the right reel come back\?/);
        assert.match(md, /\| Memory: visual library \| 1 \| 1\/1 \| 1\/1 \| 0\/0 \| 0 \|/);
        assert.match(md, /\| Memory: transcript-only library \| 1 \| 0\/1 \| 0\/1 \| 0\/0 \| 0 \|/);
        assert.match(md, /the same 70 reels; the second library keeps only what each reel says aloud/);
        assert.match(md, /### Memory: transcript-only library: 1\n\n- `visual-green-sweater`: it said there is no such video/);
    });

    it('shows the open-weights table: both models, the checks each passed and failed, the facts found, and a failure as a failure', () => {
        const md = renderMarkdown(run({ openWeights: OPEN, models: { ...run().models, open: 'meta-models/muse-spark-open-1026' } }));
        assert.match(md, /### Open weights against hosted, on one reel/);
        assert.match(md, /\|\s+\| Muse Spark, hosted by Meta \| Muse Spark Open, served by Baseten \|/);
        assert.match(md, /\| Answered \| yes \| no: timeout \|/);
        assert.match(md, /\| Tokens in \/ out \| 5,863 \/ 3,371 \| - \|/);
        assert.match(md, /\| moments \| fail: 3 moments \(at least 4\) \| - \|/);
        assert.match(md, /\| Facts found \| 1\/2 \| - \|/);
        assert.match(md, /Facts a model missed: the fix \(Muse Spark, hosted by Meta\)/);
        assert.match(md, /open weights `meta-models\/muse-spark-open-1026`/);
    });

    it('survives a run with no arm that ran, and one with a skipped arm and nothing else', () => {
        const empty = renderMarkdown(run({ results: [], summaries: [], cases: [], skippedCases: [] }));
        assert.match(empty, /^# Benchmark/);
        assert.match(empty, /## Not run/);
        assert.doesNotMatch(empty, /## Against the bar/);
    });
});

describe('the terminal', () => {
    it('is a plain table of the arms, each failure with its case id, and what did not run', () => {
        const text = renderTerminal(run());
        assert.match(text, /^arm\s+cases\s+understood\s+action\s+invented \(sent\/draft\)\s+p50\s+p90\s+\$\/reply/);
        assert.match(text, /meta\s+3\s+66\.7%\s+66\.7%\s+0\/0/);
        assert.match(text, /meta: 1 failure\n {2}image-garbled - action: answered/);
        assert.match(text, /not run: Meta voice \(transcribe, then answer\): src\/services\/perception\/voice\.ts is not in this checkout yet/);
        assert.match(text, /not run: voice-payment: voice-3\.m4a is not in the media folder/);
        assert.match(renderTerminal(run({ stub: true })), /^DRY RUN: canned answers/);
    });
});

describe('the helpers', () => {
    it('says a skip in the document with no repository path and no plan label, which the terminal keeps whole', () => {
        assert.equal(forDoc('src/services/perception/voice.ts is not in this checkout yet (P3, the voice notes)'), 'voice.ts is not in this checkout yet');
        assert.equal(forDoc('src/services/perception/recall.ts is in, but it does not export recallForTurn() as the benchmark expects: adapt loadRecall in scripts/eval-muse.mts'), 'recall.ts is in, but it does not export recallForTurn() as the benchmark expects: adapt loadRecall in eval-muse.mts');
        assert.equal(forDoc('voice-3.m4a is not in the media folder (~/Desktop/media)'), 'voice-3.m4a is not in the media folder (~/Desktop/media)');
        assert.match(renderTerminal(run()), /src\/services\/perception\/voice\.ts is not in this checkout yet \(P3, the voice notes\)/);
    });

    it('keep a table cell on one line without a bare pipe, and turn markup in a quote into text', () => {
        assert.equal(cell('a | b\nc'), 'a \\| b c');
        assert.equal(html('<b> & </b>'), '&lt;b&gt; &amp; &lt;/b&gt;');
    });

    it('prints a command with the home folder shortened wherever it is, so a public document has no user name in it', () => {
        const home = process.env.HOME ?? '';
        assert.equal(printable(['--stub', '--out', 'scratch/x']), 'npm run eval:muse -- --stub --out scratch/x');
        if (home.length > 1) {
            assert.equal(printable(['--media-dir', `${home}/Desktop/media`]), 'npm run eval:muse -- --media-dir ~/Desktop/media');
            assert.equal(printable([`--media-dir=${home}/m`]), 'npm run eval:muse -- --media-dir=~/m');
        }
    });
});

// ─── The repository's own rules, applied to the document ──────────────────────────────────────────────────────────────────

describe('the document passes the repository\'s rules for what it publishes', () => {
    const all = [
        renderMarkdown(run()), renderMarkdown(run({ stub: true })), renderMarkdown(run({ openWeights: OPEN })),
        renderMarkdown(run({ memory: { library: 3, results: [], summaries: [summarizeMemory('memory_visual', []), summarizeMemory('memory_transcript', [])] } })),
    ];

    it('says none of the words the product never says (the rules of npm run check:voice, applied to every line of it)', () => {
        for (const md of all) {
            for (const line of md.split('\n')) {
                // A line that quotes a model's reply or a customer's words is a quotation, not copy: the cases' own words are not ours to change.
                if (/What the customer got|What it saw|«/.test(line)) continue;
                assert.deepEqual(violations(line).map((v: { word: string }) => v.word), [], line.slice(0, 120));
            }
        }
    });

    it('never says RAG, or a million-token context', () => {
        for (const md of all) {
            assert.doesNotMatch(md, /\bRAG\b/);
            assert.doesNotMatch(md, /\b1\s*M\b[^.\n]{0,24}\bcontext|million[- ]token context|context window of/i);
        }
    });

    it('names no file that is not tracked, and no line number (npm run check:docs, applied to it, with the two outputs counted as tracked)', () => {
        const tracked = [...trackedFiles(), 'docs/hackathon/benchmark.md', 'docs/hackathon/benchmark.svg'];
        const lines = (p: string): string[] => { try { return readFileSync(path.join(REPO, p), 'utf8').split('\n'); } catch { return []; } };
        for (const md of all) {
            assert.deepEqual(checkDoc('docs/hackathon/benchmark.md', md, tracked, lines), []);
            assert.doesNotMatch(md, /\.(?:ts|mts|mjs|json):\d+/);
        }
    });

    it('would fail the same check if it named a file that is not there (the check is not an empty promise)', () => {
        const problems = checkDoc('docs/hackathon/benchmark.md', 'see `scripts/not-a-real-file.mts`', trackedFiles(), () => []);
        assert.equal(problems.length, 1);
    });

    it('quotes the case ids of the committed cases only as code, so a case that is renamed is a change a reader can see', () => {
        assert.ok(caseOf('image-price'));
    });
});
