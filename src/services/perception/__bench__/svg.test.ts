/**
 * The chart (`svg.ts`): that it is well-formed XML (a chart GitHub cannot draw is a chart that is not there), that it works in light and dark, that every word in it is escaped, that it
 * loads nothing from anywhere, that a bar is as long as its rate and an arm that did not run is a line and not a bar of zero, and that the same data is the same bytes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MemorySummary } from './memory.js';
import { summarizeArm } from './metrics.js';
import { esc, renderChart, type ChartData } from './svg.js';
import { xmlProblems } from './testSupport.js';
import type { ArmCaseResult, ArmId } from './types.js';

function row(arm: ArmId, over: Partial<ArmCaseResult> = {}): ArmCaseResult {
    return {
        arm, caseId: 'c', status: 'ran', note: null, understood: true, understoodWhy: null, action: 'answer', actionOk: true, actionWhy: null, seen: null, reply: 'hi', trace: null,
        invented: { draft: [], sent: [] }, failures: [], ms: 4000, usd: 0.01, tokensIn: 1, tokensOut: 1, calls: 2, judge: null, ...over,
    };
}

const memory = (arm: MemorySummary['arm'], label: string, right: [number, number], visual: [number, number]): MemorySummary => ({
    arm, label, questions: right[1], skipped: 0, right: { n: right[0], of: right[1] }, rightVisual: { n: visual[0], of: visual[1] }, rightSpoken: { n: 0, of: 0 }, inventedLinks: 0, p50Ms: 1, p90Ms: 2, usd: 0, failures: [],
});

function data(over: Partial<ChartData> = {}): ChartData {
    return {
        title: 'What the agent does with what it is sent', subtitle: '15 cases · muse-spark-1.3 · 2026-10-31',
        arms: [
            summarizeArm('meta', 'm', [row('meta'), row('meta', { actionOk: false }), row('meta'), row('meta')]),
            summarizeArm('today', 'm', [row('today', { understood: false, actionOk: false }), row('today', { understood: false }), row('today', { understood: false, actionOk: false }), row('today', { understood: false, actionOk: false })]),
        ],
        memory: [], skipped: [], stub: false, ...over,
    };
}

describe('esc', () => {
    it('escapes the five characters XML cannot hold as they are', () => {
        assert.equal(esc('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
        assert.equal(esc('plain'), 'plain');
    });
});

describe('the chart', () => {
    it('is well-formed XML with one root, an SVG namespace, a viewBox and a title for a screen reader', () => {
        const svg = renderChart(data());
        assert.deepEqual(xmlProblems(svg), []);
        assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 880 \d+"/);
        assert.match(svg, /role="img" aria-labelledby="chart-title chart-desc"/);
        assert.match(svg, /<title id="chart-title">What the agent does with what it is sent<\/title>/);
        assert.match(svg, /<desc id="chart-desc">[^<]*Meta Muse \(shipped path\): understood 100%, expected action 75%/);
    });

    it('works in light and dark: the colours are variables, a dark block swaps them, and the card has a ground of its own', () => {
        const svg = renderChart(data());
        assert.match(svg, /svg \{ --bg: #ffffff;/);
        assert.match(svg, /@media \(prefers-color-scheme: dark\) \{ svg \{ --bg: #0d1117;/);
        assert.match(svg, /<rect x="0\.5" y="0\.5" width="879"[^>]*fill="var\(--bg\)"/);
        for (const v of ['--text', '--muted', '--track', '--meta', '--today', '--border']) {
            const light = new RegExp(`svg \\{[^}]*${v}: #[0-9a-f]{6}`).test(svg);
            const dark = new RegExp(`prefers-color-scheme: dark\\) \\{ svg \\{[^}]*${v}: #[0-9a-f]{6}`).test(svg);
            assert.ok(light && dark, `${v} is set in both`);
        }
    });

    it('loads nothing from anywhere: no image, no link, no external font, no script, no url()', () => {
        const svg = renderChart(data({ memory: [memory('memory_visual', 'Memory: visual library', [8, 10], [4, 4])] }));
        for (const bad of [/<image/i, /href=/i, /@import/i, /<script/i, /url\(/i, /<foreignObject/i, /xlink/i, /https?:\/\/(?!www\.w3\.org)/i]) assert.doesNotMatch(svg, bad, String(bad));
        assert.match(svg, /font-family: system-ui/);
    });

    it('makes a bar as long as its rate: 100% fills the track, 50% half of it, 0% none, and every bar has a track', () => {
        const svg = renderChart(data());
        const widths = [...svg.matchAll(/<rect class="(meta|today)" x="\d+" y="\d+" width="(\d+)"/g)].map((m) => [m[1], Number(m[2])] as const);
        const track = Number(/class="track" x="\d+" y="\d+" width="(\d+)"/.exec(svg)![1]);
        const meta = widths.filter(([c]) => c === 'meta').map(([, w]) => w);
        assert.deepEqual(meta, [track, Math.round(track * 0.75)], 'understood 100%, expected action 75%');
        const today = widths.filter(([c]) => c === 'today').map(([, w]) => w);
        assert.deepEqual(today, [Math.round(track * 0.25)], 'understood 0% draws no bar; expected action 25% is a quarter');
        assert.equal((svg.match(/class="track"/g) ?? []).length, 4);
    });

    it('writes each value with its count, so a rate of four cases can be checked: "75% (3/4)"', () => {
        const svg = renderChart(data());
        assert.match(svg, />100% \(4\/4\)</);
        assert.match(svg, />75% \(3\/4\)</);
        assert.match(svg, />0% \(0\/4\)</);
        assert.match(svg, />25% \(1\/4\)</);
    });

    it('marks the 90% goal on the arms that are held to it, and not on today\'s', () => {
        const svg = renderChart(data());
        assert.equal((svg.match(/class="goal"/g) ?? []).length, 1);
        assert.match(svg, /the tick is the 90% goal/);
    });

    it('shows the shipped path\'s three numbers against their goals', () => {
        const svg = renderChart(data());
        assert.match(svg, />Invented facts sent</);
        assert.match(svg, />p90 latency</);
        assert.match(svg, />Cost per reply</);
        assert.match(svg, /goal: at most 60 s/);
        assert.match(svg, /goal: at most \$0\.0300/);
        assert.match(svg, /0 in the first draft, before the guard/);
    });

    it('draws the memory panel with the visual-only bar when there is a memory run', () => {
        const svg = renderChart(data({ memory: [memory('memory_visual', 'Memory: visual library', [8, 10], [4, 4]), memory('memory_transcript', 'Memory: transcript-only library', [4, 10], [0, 4])] }));
        assert.deepEqual(xmlProblems(svg), []);
        assert.match(svg, /Memory: does the right reel come back\?/);
        assert.match(svg, />Only on screen</);
        assert.match(svg, />100% \(4\/4\)</);
        assert.match(svg, />0% \(0\/4\)</);
        assert.match(svg, /class="visual"/);
    });

    it('says an arm did not run, in a line, and draws no bar of zero for it', () => {
        const svg = renderChart(data({ skipped: [{ arm: 'voice', label: 'Meta voice', why: 'the voice module is not in yet' }] }));
        assert.match(svg, /Meta voice: not run\. The voice module is not in yet/);
        assert.doesNotMatch(svg, />Meta voice</, 'no row for an arm that did not run');
    });

    it('says in a band that a dry run is not a measurement', () => {
        assert.match(renderChart(data({ stub: true })), /Dry run: canned answers, nothing was sent to Meta\. These bars are not a measurement\./);
        assert.doesNotMatch(renderChart(data({ stub: false })), /Dry run/);
    });

    it('escapes every word it is given, so a title or a label with markup in it cannot break the chart or add to it', () => {
        const svg = renderChart(data({ title: 'A <script>alert(1)</script> & "B"', subtitle: 'x < y', arms: [{ ...data().arms[0]!, label: 'Arm <b>&</b>' }] }));
        assert.deepEqual(xmlProblems(svg), []);
        assert.doesNotMatch(svg, /<script/i);
        assert.match(svg, /A &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;B&quot;/);
        assert.match(svg, /Arm &lt;b&gt;&amp;&lt;\/b&gt;/);
    });

    it('survives nothing to draw: no arms, a dry run of zero cases, an arm with no rate', () => {
        assert.deepEqual(xmlProblems(renderChart(data({ arms: [], memory: [], skipped: [] }))), []);
        const empty = summarizeArm('meta', 'm', []);
        assert.deepEqual(xmlProblems(renderChart(data({ arms: [empty] }))), []);
    });

    it('is the same bytes for the same data, and tall enough for what it holds', () => {
        assert.equal(renderChart(data()), renderChart(data()));
        const height = (svg: string): number => Number(/viewBox="0 0 880 (\d+)"/.exec(svg)![1]);
        const small = renderChart(data({ memory: [] }));
        const big = renderChart(data({ memory: [memory('memory_visual', 'V', [1, 1], [1, 1]), memory('memory_transcript', 'T', [1, 1], [1, 1])], skipped: [{ arm: 'voice', label: 'v', why: 'w' }] }));
        assert.ok(height(big) > height(small));
        const ys = [...big.matchAll(/ y="(\d+)"/g)].map((m) => Number(m[1]));
        assert.ok(Math.max(...ys) < height(big), 'nothing is drawn below the card');
    });
});

describe('the XML reader the chart is held to', () => {
    it('finds what is wrong with XML that is not well-formed (so a pass above means something)', () => {
        assert.deepEqual(xmlProblems('<a><b x="1"/></a>'), []);
        assert.ok(xmlProblems('<a><b></a>').length > 0, 'a tag closed out of order');
        assert.ok(xmlProblems('<a x=1/>').length > 0, 'an unquoted attribute');
        assert.ok(xmlProblems('<a>1 < 2</a>').length > 0, 'a raw <');
        assert.ok(xmlProblems('<a>fish & chips</a>').length > 0, 'a raw &');
        assert.ok(xmlProblems('<a/><b/>').length > 0, 'two roots');
        assert.ok(xmlProblems('<a>').length > 0, 'an unclosed tag');
        assert.ok(xmlProblems('text<a/>').length > 0, 'text outside the root');
        assert.deepEqual(xmlProblems('<a>fish &amp; chips &#8212; &#x2014;</a>'), []);
    });
});
