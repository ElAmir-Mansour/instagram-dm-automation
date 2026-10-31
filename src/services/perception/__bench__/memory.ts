/**
 * The memory arm (docs/specs/005-muse-sees US4, P4): the agent watched every reel the creator published once, and remembers what it SAW as well as what was said. The
 * question this arm asks is the honest one: does what was seen help? The same recall, on the same model, is asked the same questions of two libraries made from the same
 * reels: the visual one (each analysis as the indexer stored it) and a transcript-only one (each reel described by nothing but what it says aloud). Four of the ten questions are
 * about something that is only SHOWN on screen, which a transcript cannot hold. If the visual library does not find those reels, the memory is a transcript search and the
 * benchmark says so.
 *
 * Like the voice arm it runs the product's own module (`src/services/perception/recall`, P4b) and is skipped with a note while that module is not in this checkout. It needs the
 * library too (`--library <file.json>`: the `reel_analyses` rows with status `ok`, as `listOkForRecall` returns them, exported); the benchmark reads a file and never the database.
 *
 * A question is answered right when recall names a reel the library has and whose analysis says what the question's `expect.reel` groups say; a question with no such reel
 * (`none`) is answered right when recall says, in so many words, that there is none. A link that is not one of the library's is an INVENTED link, counted apart and expected to be
 * 0 in both libraries (the product builds a link from a row, never from what the model wrote, so a nonzero count would be a regression).
 */
import { percentile } from '../../dmSales/__evals__/report.js';
import type { FetchLike } from '../../llm/types.js';
import type { LibraryRow } from '../reelLibrary.js';
import type { MemoryQuestion } from './types.js';

export type { LibraryRow };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The creator the library's rows are made out to, and the sender who asks: stand-ins, since nothing here reads a tenant. */
export const BENCH_LIBRARY_CREATOR = 'benchmark-creator';

/**
 * The library file: a list of `reel_analyses` rows (or `{rows: [...]}`), each with at least an id (or `ig_media_id`) and the analysis in `result`. What a row does not say is
 * filled in the way the table would have it (`status: 'ok'`). A row without a result, or with no way to tell it from another, is a mistake in the file, named by its position.
 */
export function parseLibrary(raw: unknown): LibraryRow[] {
    const rows = isObj(raw) && Array.isArray(raw.rows) ? raw.rows : raw;
    if (!Array.isArray(rows)) throw new Error('the library file must be a list of reel_analyses rows (or {rows: [...]})');
    const seen = new Set<string>();
    return rows.map((row, i) => {
        if (!isObj(row) || !isObj(row.result)) throw new Error(`library row ${i + 1} has no "result" object`);
        const id = text(row.id) ?? text(row.ig_media_id);
        if (!id) throw new Error(`library row ${i + 1} has no id (or ig_media_id)`);
        if (seen.has(id)) throw new Error(`library row ${i + 1} repeats the id of an earlier row`);
        seen.add(id);
        const posted = text(row.posted_at);
        const when = posted ?? '1970-01-01T00:00:00.000Z';
        return {
            id, creator_id: text(row.creator_id) ?? BENCH_LIBRARY_CREATOR, ig_media_id: text(row.ig_media_id), permalink: text(row.permalink), youtube_url: text(row.youtube_url), posted_at: posted,
            status: 'ok', result: row.result, model: text(row.model), ms: typeof row.ms === 'number' ? row.ms : null, usd: typeof row.usd === 'number' ? row.usd : null,
            created_at: text(row.created_at) ?? when, updated_at: text(row.updated_at) ?? when,
        };
    });
}

/**
 * The same reels, each described by nothing but what it says aloud: the baseline the visual library is compared with. Recall cannot use a reel with no summary, so the narration
 * stands where the summary stands (cut to the length a library line holds, as the product cuts it), and what was SEEN is gone: no on-screen notes, no topics, no moments.
 */
export function transcriptOnly(library: readonly LibraryRow[]): LibraryRow[] {
    return library.map((row) => {
        const narration = text(row.result['narration']) ?? '';
        return { ...row, result: { summary: narration, topics: [], seen_on_screen: [], narration, key_moments: [] } };
    });
}

/** Every word an analysis holds, as one lower-case string, for matching a question's expectation. */
export function textOf(row: LibraryRow): string {
    const r = row.result;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const moments = (Array.isArray(r['key_moments']) ? r['key_moments'] : []).map((m) => (isObj(m) && typeof m['what'] === 'string' ? m['what'] : ''));
    return [text(r['summary']) ?? '', ...list(r['topics']), ...list(r['seen_on_screen']), text(r['narration']) ?? '', ...moments, text(r['hook_first_3s']) ?? '', text(r['caption_ar']) ?? ''].join(' ').toLowerCase();
}

/** The ids of the reels a question is about: those whose analysis has a word of every group. Null for a question with no reel (`none`). */
export function rightReels(q: MemoryQuestion, library: readonly LibraryRow[]): Set<string> | null {
    if ('none' in q.expect) return null;
    const groups = q.expect.reel;
    return new Set(library.filter((row) => {
        const body = textOf(row);
        return groups.every((g) => g.some((w) => body.includes(w.toLowerCase())));
    }).map((row) => row.id));
}

/**
 * What recall said to one question: a reel (with the second and the link it would send), "no video on this topic yet", nothing at all (it was not taken for a request for a video,
 * or the call failed: the turn is then answered as though recall did not exist), or a failure.
 */
export type RecallOutcome =
    | { kind: 'match'; id: string; second: number; link: string | null; ms: number; usd: number }
    | { kind: 'none'; ms: number; usd: number }
    | { kind: 'nothing'; ms: number; usd: number }
    | { kind: 'failed'; reason: string; ms: number; usd: number };

/** Recall, as the arm needs it: a question and a library in, what it said out. */
export type Recall = (question: string, library: readonly LibraryRow[]) => Promise<RecallOutcome>;

/**
 * What `recallForTurn` adds to a turn (P4b's `TurnRecall`): the facts block's line, the one link the reply may carry, and the reel that matched. `match: null` with a line is a
 * content request that no reel covers ("No video on this topic yet").
 */
export interface TurnRecall {
    line: string;
    link: string | null;
    match: { reelId: string; second: number } | null;
}

/** What `recallForTurn` returns, as the outcome the arm reads. Null is "nothing"; a result with no match is "none"; a match names its reel's row id. */
export function outcomeOf(turn: TurnRecall | null, ms: number, usd: number): RecallOutcome {
    if (turn === null) return { kind: 'nothing', ms, usd };
    if (turn.match === null) return { kind: 'none', ms, usd };
    return { kind: 'match', id: turn.match.reelId, second: turn.match.second, link: turn.link, ms, usd };
}

export interface MemoryResult {
    arm: 'memory_visual' | 'memory_transcript';
    questionId: string;
    ask: string;
    visualOnly: boolean;
    status: 'ran' | 'skipped';
    ok: boolean;
    /** The id it named, or null. */
    answeredWith: string | null;
    /** A link that is not one of the library's. */
    inventedLink: boolean;
    why: string | null;
    ms: number;
    usd: number;
}

export interface MemoryDeps {
    clock?: () => number;
}

/** One library, every question. A question the library has no reel for is skipped by name: the benchmark does not guess which reel was meant. */
export async function runMemoryArm(
    arm: MemoryResult['arm'], questions: readonly MemoryQuestion[], library: readonly LibraryRow[], truth: readonly LibraryRow[], recall: Recall, deps: MemoryDeps = {},
): Promise<MemoryResult[]> {
    const clock = deps.clock ?? (() => performance.now());
    const links = new Set(truth.flatMap((row) => [row.permalink, row.youtube_url].filter((l): l is string => Boolean(l))));
    const ids = new Set(truth.map((row) => row.id));
    /** A link recall builds may carry a start time on a YouTube address (`&t=13s`): the address before it is what the library holds. */
    const known = (link: string): boolean => links.has(link) || [...links].some((l) => link === l || link.startsWith(`${l}?t=`) || link.startsWith(`${l}&t=`));
    const out: MemoryResult[] = [];
    for (const q of questions) {
        const right = rightReels(q, truth);
        const base = { arm, questionId: q.id, ask: q.ask, visualOnly: q.visualOnly };
        if (right !== null && right.size === 0) {
            out.push({ ...base, status: 'skipped', ok: false, answeredWith: null, inventedLink: false, why: 'the library has no reel whose analysis says what this question is about', ms: 0, usd: 0 });
            continue;
        }
        const started = clock();
        let answer: RecallOutcome;
        try {
            answer = await recall(q.ask, library);
        } catch (err) {
            answer = { kind: 'failed', reason: err instanceof Error ? err.message.slice(0, 80) : 'error', ms: clock() - started, usd: 0 };
        }
        const ms = Math.max(answer.ms, clock() - started);
        if (answer.kind === 'failed') {
            out.push({ ...base, status: 'ran', ok: false, answeredWith: null, inventedLink: false, why: `recall failed: ${answer.reason}`, ms, usd: answer.usd });
            continue;
        }
        const named = answer.kind === 'match' ? answer.id : null;
        const inventedLink = answer.kind === 'match' && ((answer.link !== null && !known(answer.link)) || !ids.has(answer.id));
        let ok: boolean;
        let why: string | null = null;
        if (right === null) {
            ok = answer.kind === 'none';
            if (!ok) why = answer.kind === 'match' ? 'it named a reel for a topic the library does not cover' : 'it did not say there is no such video';
        } else {
            ok = answer.kind === 'match' && right.has(answer.id) && !inventedLink;
            if (!ok) why = answer.kind === 'match' ? (inventedLink ? 'it named a reel or a link the library does not have' : 'it named another reel') : answer.kind === 'none' ? 'it said there is no such video' : 'it found no video to recall';
        }
        out.push({ ...base, status: 'ran', ok, answeredWith: named, inventedLink, why, ms, usd: answer.usd });
    }
    return out;
}

export interface MemorySummary {
    arm: MemoryResult['arm'];
    label: string;
    questions: number;
    skipped: number;
    right: { n: number; of: number };
    rightVisual: { n: number; of: number };
    rightSpoken: { n: number; of: number };
    inventedLinks: number;
    p50Ms: number | null;
    p90Ms: number | null;
    usd: number;
    failures: { questionId: string; reason: string }[];
}

export const MEMORY_LABELS: Readonly<Record<MemoryResult['arm'], string>> = Object.freeze({
    memory_visual: 'Memory: visual library',
    memory_transcript: 'Memory: transcript-only library',
});

export function summarizeMemory(arm: MemoryResult['arm'], results: readonly MemoryResult[]): MemorySummary {
    const mine = results.filter((r) => r.arm === arm);
    const ran = mine.filter((r) => r.status === 'ran');
    const count = (list: readonly MemoryResult[]) => ({ n: list.filter((r) => r.ok).length, of: list.length });
    return {
        arm, label: MEMORY_LABELS[arm], questions: ran.length, skipped: mine.length - ran.length, right: count(ran), rightVisual: count(ran.filter((r) => r.visualOnly)),
        rightSpoken: count(ran.filter((r) => !r.visualOnly)), inventedLinks: ran.filter((r) => r.inventedLink).length, p50Ms: percentile(ran.map((r) => r.ms), 50),
        p90Ms: percentile(ran.map((r) => r.ms), 90), usd: Math.round(ran.reduce((n, r) => n + r.usd, 0) * 1e9) / 1e9,
        failures: ran.filter((r) => !r.ok).map((r) => ({ questionId: r.questionId, reason: r.why ?? 'wrong' })),
    };
}

// ─── Wiring the product's recall in ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The shape of `src/services/perception/recall.ts` as it is committed on the P4b branch (`hackathon/p4b-recall`): `recallForTurn(input, deps)` with the gate and the library
 * handed in. Only what the arm calls is named, so that another file of that module changing does not touch this.
 */
export interface RecallModule {
    recallForTurn(
        input: { creatorId: string; senderId: string; text: string },
        deps?: { now?: () => number; gate?: (args: unknown) => Promise<{ ok: true } | { ok: false; reason: string }>; library?: (creatorId: string) => Promise<LibraryRow[]> },
    ): Promise<TurnRecall | null>;
}

/**
 * The product's recall as the arm's `Recall`: the gate is open (the benchmark's own sender and tenant are allowed and the switch is on by definition), the library is the one
 * handed in, and the model call inside goes where `setAiCaller` sends it. `usd` and `ms` are read from the ledger by the caller of the arm; the call's own wall time is here.
 */
export function adaptRecall(mod: RecallModule, o: { ledgerUsd: () => number; clock?: () => number }): Recall {
    const clock = o.clock ?? (() => performance.now());
    return async (question, library) => {
        const started = clock();
        const before = o.ledgerUsd();
        const turn = await mod.recallForTurn(
            { creatorId: BENCH_LIBRARY_CREATOR, senderId: 'benchmark-sender', text: question },
            { gate: async () => ({ ok: true }), library: async () => [...library] },
        );
        return outcomeOf(turn, clock() - started, Math.round((o.ledgerUsd() - before) * 1e9) / 1e9);
    };
}

export type { FetchLike };
