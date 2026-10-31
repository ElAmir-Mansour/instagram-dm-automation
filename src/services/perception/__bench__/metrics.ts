/**
 * The numbers of the benchmark, and the bar they are held to (docs/specs/005-muse-sees SC-001, SC-002, SC-004). Pure: results in, numbers out, so the table, the
 * chart and the exit code are all read from one place and cannot disagree.
 *
 * What each number is, and is not:
 *
 *   understood        a case counts when what the arm reported of the media covers what the case says it must (`judgeUnderstood`): a mechanical check on words.
 *                     An arm that never opens an attachment understands none, and says so.
 *   expected action   the action the agent took is one the case accepts, and for a recommendation it is the right offer.
 *   invented facts    replies whose words state a number, a price, a discount or a link the account's information does not hold, or a fact the case forbids.
 *                     Counted twice: in the model's draft (before the guard) and in what the customer is sent (after it). The second is the one that must be 0.
 *   latency           from the message to the reply: reading the media and writing the answer. It leaves out the download from Instagram's CDN and the Send API, which
 *                     the live path adds. p50 and p90 are nearest-rank, as the DM evaluation counts them.
 *   cost per reply    what the responses said they used, priced with the table in `llm/cost.ts`, divided by the replies the customer was sent. The judge is not in it.
 */
import { percentile } from '../../dmSales/__evals__/report.js';
import type { ArmCaseResult, ArmId, ArmSummary, Failure, Rate, Suite } from './types.js';

export const ARM_SUITE: Readonly<Record<ArmId, Suite>> = Object.freeze({
    meta: 'media', today: 'media', voice: 'voice', today_voice: 'voice', memory_visual: 'memory', memory_transcript: 'memory',
});

/** How an arm is named in the table and the chart. */
export const ARM_LABELS: Readonly<Record<ArmId, string>> = Object.freeze({
    meta: 'Meta Muse (shipped path)',
    today: 'Today (before Muse)',
    voice: 'Meta voice (transcribe, then answer)',
    today_voice: 'Today, voice notes',
    memory_visual: 'Memory: visual library',
    memory_transcript: 'Memory: transcript-only library',
});

const rate = (n: number, of: number): Rate => ({ n, of, pct: of === 0 ? null : Math.round((n / of) * 1000) / 10 });

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/** Everything the report says of one arm, from the cases it ran. A case that was skipped is not in any number. */
export function summarizeArm(arm: ArmId, models: string, results: readonly ArmCaseResult[]): ArmSummary {
    const ran = results.filter((r) => r.arm === arm && r.status === 'ran');
    const replies = ran.filter((r) => r.reply.trim() !== '').length;
    const usd = Math.round(ran.reduce((n, r) => n + r.usd, 0) * 1e9) / 1e9;
    const judged = ran.flatMap((r) => (r.judge ? [r.judge.mean] : []));
    const failures: Failure[] = ran.flatMap((r) => r.failures);
    return {
        arm,
        suite: ARM_SUITE[arm],
        label: ARM_LABELS[arm],
        models,
        cases: ran.length,
        understood: rate(ran.filter((r) => r.understood === true).length, ran.length),
        expectedAction: rate(ran.filter((r) => r.actionOk).length, ran.length),
        inventedSent: ran.filter((r) => r.invented.sent.length > 0).length,
        inventedDraft: ran.filter((r) => r.invented.draft.length > 0).length,
        p50Ms: percentile(ran.map((r) => r.ms), 50),
        p90Ms: percentile(ran.map((r) => r.ms), 90),
        replies,
        usd,
        usdPerReply: replies === 0 ? null : usd / replies,
        judgeMean: mean(judged),
        failures,
    };
}

/**
 * A reason for a skip, as a PUBLIC FILE says it (the document and the chart). A path the document names has to be a tracked file (`npm run check:docs` fails on one that is not), and a module that has not landed
 * is not one, so every repository path in the reason is cut to its file name; and the plan's own labels (P3, P4b) mean nothing to a reader, so a bracket that opens with one is left
 * out. The terminal keeps the reason whole, where the person running it wants the path.
 */
export function forDoc(why: string): string {
    return why
        .replace(/(?<![\w/.@-])(?:src|dashboard|scripts|public|heroku-worker|docs)\/(?:[\w.@-]+\/)*([\w.@-]+)/g, '$1')
        .replace(/\s*\(P\d+[a-z]?\b[^)]*\)/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// ─── The bar ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The success criteria the spec sets for the shipped path. */
export const BAR = Object.freeze({
    /** SC-001: at least 90% of perception cases get the expected action. */
    expectedActionPct: 90,
    /** SC-001: and no answer states a fact that is not in the agent's information. */
    inventedFacts: 0,
    /** SC-002: a shared reel or photo is answered within 60 s at the 90th percentile, a voice note within 45 s. */
    p90Ms: 60_000,
    voiceP90Ms: 45_000,
    /** SC-004: the average cost of a perceived reply is under three cents. */
    usdPerReply: 0.03,
});

export interface Target {
    id: 'action' | 'invented' | 'p90' | 'cost';
    label: string;
    met: boolean;
    value: string;
    goal: string;
}

export const secs = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);
export const dollars = (n: number | null): string => (n === null ? '-' : `$${n.toFixed(n < 0.1 ? 4 : 2)}`);
export const percent = (r: Rate): string => (r.pct === null ? '-' : `${r.pct.toFixed(r.pct % 1 === 0 ? 0 : 1)}%`);

/** Whether an arm meets the bar. Only the arms that answer a customer (`meta`, `voice`) are held to it. */
export function targetsOf(s: ArmSummary): Target[] {
    const p90Goal = s.arm === 'voice' ? BAR.voiceP90Ms : BAR.p90Ms;
    return [
        {
            id: 'action', label: 'Expected action', met: s.expectedAction.pct !== null && s.expectedAction.pct >= BAR.expectedActionPct, value: percent(s.expectedAction), goal: `at least ${BAR.expectedActionPct}%`,
        },
        { id: 'invented', label: 'Invented facts sent', met: s.cases > 0 && s.inventedSent <= BAR.inventedFacts, value: String(s.inventedSent), goal: String(BAR.inventedFacts) },
        { id: 'p90', label: 'p90 latency', met: s.p90Ms !== null && s.p90Ms <= p90Goal, value: secs(s.p90Ms), goal: `at most ${p90Goal / 1000} s` },
        { id: 'cost', label: 'Cost per reply', met: s.usdPerReply !== null && s.usdPerReply <= BAR.usdPerReply, value: dollars(s.usdPerReply), goal: `at most ${dollars(BAR.usdPerReply)}` },
    ];
}

/** The run met the bar when every arm that answers a customer meets all of it. */
export function barMet(summaries: readonly ArmSummary[]): boolean {
    const held = summaries.filter((s) => (s.arm === 'meta' || s.arm === 'voice') && s.cases > 0);
    return held.length > 0 && held.every((s) => targetsOf(s).every((t) => t.met));
}

// ─── Reading a run ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A word error rate: the edit distance between the words of `reference` and of `heard`, over the length of `reference`. 0 is exact; it can pass 1. */
export function wordErrorRate(reference: readonly string[], heard: readonly string[]): number | null {
    if (reference.length === 0) return null;
    const prev = Array.from({ length: heard.length + 1 }, (_, i) => i);
    for (let i = 1; i <= reference.length; i++) {
        let diagonal = prev[0]!;
        prev[0] = i;
        for (let j = 1; j <= heard.length; j++) {
            const above = prev[j]!;
            prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diagonal + (reference[i - 1] === heard[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }
    return Math.round((prev[heard.length]! / reference.length) * 1000) / 1000;
}
