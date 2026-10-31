/**
 * The benchmark's chart, `docs/hackathon/benchmark.svg`: bars for what each arm understood and how often it did the right thing, and the three numbers that decide whether the
 * answers can be trusted. Hand-written SVG with no dependency, because GitHub renders it as it is and a chart should be something a person can read in a diff.
 *
 * It works in light and dark: the colours are variables on the root element, and a `prefers-color-scheme: dark` block swaps them. The chart is also a card with a ground of its
 * own, so it stays readable when a page is dark and the viewer's system is not (GitHub's theme and the browser's can differ). Every word in it is escaped, a bar is a `<rect>`,
 * and nothing in it is loaded from anywhere: no font, no image, no link.
 *
 * What a bar says: 100% is every case the arm ran. An arm that did not run is not a bar of zero: it is a line that says it did not run.
 */
import { BAR, dollars, forDoc, percent, secs } from './metrics.js';
import type { MemorySummary } from './memory.js';
import type { ArmId, ArmSummary, Rate, SkippedArm } from './types.js';

export interface ChartData {
    title: string;
    /** One line under the title: how many cases, which model, which day. */
    subtitle: string;
    arms: readonly ArmSummary[];
    memory: readonly MemorySummary[];
    skipped: readonly SkippedArm[];
    /** A dry run's chart says so, in a band across the top. */
    stub: boolean;
}

/** XML text: the five characters that cannot be written as they are. */
export function esc(text: string): string {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const WIDTH = 880;
const PAD = 28;
const LABEL_W = 236;
const BAR_X = PAD + LABEL_W + 8;
const BAR_W = 360;
const BAR_H = 16;
const ROW_H = 62;

/** What colour each arm's bars are: the shipped path is the accent, and everything it is compared with is quiet. */
const ARM_CLASS: Readonly<Record<ArmId, string>> = Object.freeze({
    meta: 'meta', today: 'today', voice: 'voice', today_voice: 'today', memory_visual: 'visual', memory_transcript: 'today',
});

interface Bar {
    label: string;
    rate: Rate;
    cls: string;
    /** A goal to mark on the track, as a percentage. */
    goal?: number;
}

/** A horizontal bar on a track, with its value after it. `n/m` is in the value, because a percentage of eight cases is a number a reader should be able to check. */
function bar(x: number, y: number, b: Bar): string {
    const pct = b.rate.pct;
    const trackW = BAR_W - 112;
    const fillW = pct === null || pct <= 0 ? 0 : Math.max(2, Math.round((trackW * pct) / 100));
    const value = pct === null ? '-' : `${percent(b.rate)} (${b.rate.n}/${b.rate.of})`;
    const tick = b.goal === undefined ? '' : `<rect class="goal" x="${x + 112 + Math.round((trackW * b.goal) / 100) - 1}" y="${y - 3}" width="2" height="${BAR_H + 6}"/>`;
    return [
        `<text class="small muted" x="${x}" y="${y + 12}">${esc(b.label)}</text>`,
        `<rect class="track" x="${x + 112}" y="${y}" width="${trackW}" height="${BAR_H}" rx="3"/>`,
        fillW === 0 ? '' : `<rect class="${b.cls}" x="${x + 112}" y="${y}" width="${fillW}" height="${BAR_H}" rx="3"/>`,
        tick,
        `<text class="small" x="${x + BAR_W + 8}" y="${y + 12}">${esc(value)}</text>`,
    ].filter(Boolean).join('\n');
}

const upper = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/** The chart as an SVG document. Deterministic: the same data is the same bytes. */
export function renderChart(d: ChartData): string {
    const media = d.arms.filter((a) => a.cases > 0 && (a.suite === 'media' || a.suite === 'voice'));
    const memory = d.memory.filter((m) => m.questions > 0);
    const numbers = d.arms.find((a) => a.arm === 'meta' && a.cases > 0);
    const skipped = d.skipped.filter((s) => s.arm !== 'today' && s.arm !== 'meta');

    const top = d.stub ? 120 : 92;
    let y = top;
    const out: string[] = [];

    if (media.length > 0) {
        out.push(`<text class="head" x="${PAD}" y="${y}">Messages with no words, and what the agent does with them (the tick is the ${BAR.expectedActionPct}% goal)</text>`);
        y += 14;
        for (const a of media) {
            const cls = ARM_CLASS[a.arm];
            out.push(
                `<text class="label" x="${PAD}" y="${y + 26}">${esc(a.label)}</text>`,
                `<text class="small muted" x="${PAD}" y="${y + 44}">${esc(`${a.cases} cases`)}</text>`,
                bar(BAR_X, y + 10, { label: 'Understood', rate: a.understood, cls }),
                bar(BAR_X, y + 34, { label: 'Expected action', rate: a.expectedAction, cls, ...(a.arm === 'meta' || a.arm === 'voice' ? { goal: BAR.expectedActionPct } : {}) }),
            );
            y += ROW_H;
        }
        y += 26;
    }

    if (memory.length > 0) {
        out.push(`<text class="head" x="${PAD}" y="${y}">Memory: does the right reel come back?</text>`);
        y += 14;
        for (const m of memory) {
            const cls = ARM_CLASS[m.arm];
            const of = (r: { n: number; of: number }): Rate => ({ n: r.n, of: r.of, pct: r.of === 0 ? null : Math.round((r.n / r.of) * 1000) / 10 });
            out.push(
                `<text class="label" x="${PAD}" y="${y + 26}">${esc(m.label)}</text>`,
                `<text class="small muted" x="${PAD}" y="${y + 44}">${esc(`${m.questions} questions`)}</text>`,
                bar(BAR_X, y + 10, { label: 'All questions', rate: of(m.right), cls }),
                bar(BAR_X, y + 34, { label: 'Only on screen', rate: of(m.rightVisual), cls }),
            );
            y += ROW_H;
        }
        y += 26;
    }

    if (numbers) {
        out.push(`<text class="head" x="${PAD}" y="${y}">The shipped path, against the bar</text>`);
        y += 22;
        const stats: [string, string, string][] = [
            ['Invented facts sent', String(numbers.inventedSent), `${numbers.inventedDraft} in the first draft, before the guard`],
            ['p90 latency', secs(numbers.p90Ms), `goal: at most ${BAR.p90Ms / 1000} s`],
            ['Cost per reply', dollars(numbers.usdPerReply), `goal: at most ${dollars(BAR.usdPerReply)}`],
        ];
        stats.forEach(([label, value, note], i) => {
            const x = PAD + i * 290;
            out.push(`<text class="big" x="${x}" y="${y + 24}">${esc(value)}</text>`, `<text class="small" x="${x}" y="${y + 44}">${esc(label)}</text>`, `<text class="small muted" x="${x}" y="${y + 60}">${esc(note)}</text>`);
        });
        y += 80;
    }

    for (const s of skipped) {
        out.push(`<text class="small muted" x="${PAD}" y="${y + 14}">${esc(`${s.label}: not run. ${upper(forDoc(s.why))}`.slice(0, 130))}</text>`);
        y += 20;
    }

    const height = Math.max(y + 22, 160);
    const summary = `${d.title}. ${d.subtitle}. ${[...media.map((a) => `${a.label}: understood ${percent(a.understood)}, expected action ${percent(a.expectedAction)}`), ...memory.map((m) => `${m.label}: ${m.right.n} of ${m.right.of} right`)].join('. ')}.`;

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-labelledby="chart-title chart-desc">`,
        `<title id="chart-title">${esc(d.title)}</title>`,
        `<desc id="chart-desc">${esc(summary)}</desc>`,
        '<style>',
        'svg { --bg: #ffffff; --card: #f6f8fa; --text: #1f2328; --muted: #59636e; --track: #e1e6eb; --border: #d1d9e0; --meta: #0969da; --today: #8c959f; --voice: #1a7f37; --visual: #8250df; --warn: #9a6700; }',
        '@media (prefers-color-scheme: dark) { svg { --bg: #0d1117; --card: #151b23; --text: #e6edf3; --muted: #9198a1; --track: #262c36; --border: #3d444d; --meta: #4493f8; --today: #6e7681; --voice: #3fb950; --visual: #ab7df8; --warn: #d29922; } }',
        'text { font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: var(--text); }',
        '.title { font-size: 20px; font-weight: 700; }',
        '.sub { font-size: 13px; fill: var(--muted); }',
        '.head { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; fill: var(--muted); }',
        '.label { font-size: 14px; font-weight: 600; }',
        '.small { font-size: 12px; }',
        '.big { font-size: 26px; font-weight: 700; }',
        '.muted { fill: var(--muted); }',
        '.band { fill: var(--warn); }',
        '.track { fill: var(--track); }',
        '.goal { fill: var(--text); opacity: 0.55; }',
        '.meta { fill: var(--meta); }',
        '.today { fill: var(--today); }',
        '.voice { fill: var(--voice); }',
        '.visual { fill: var(--visual); }',
        '</style>',
        `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="var(--bg)" stroke="var(--border)"/>`,
        `<text class="title" x="${PAD}" y="${PAD + 14}">${esc(d.title)}</text>`,
        `<text class="sub" x="${PAD}" y="${PAD + 36}">${esc(d.subtitle)}</text>`,
        d.stub ? `<text class="small band" x="${PAD}" y="${PAD + 62}">${esc('Dry run: canned answers, nothing was sent to Meta. These bars are not a measurement.')}</text>` : '',
        ...out,
        '</svg>',
        '',
    ].filter((line) => line !== '').join('\n');
}
