/**
 * The memory arm (docs/specs/005-muse-sees US4, P4): the agent watched every reel the creator published once, and remembers what it SAW as well as what was said. The
 * question this arm asks is the honest one: does what was seen help? The same recall, on the same model, is asked the same questions of two libraries made from the same
 * reels: the visual one (the analysis as the indexer stores it) and a transcript-only one (nothing but what each reel says aloud). Four of the ten questions are about
 * something that is only SHOWN on screen, which a transcript cannot hold. If the visual library does not find those reels, the memory is a transcript search and the benchmark
 * says so.
 *
 * Like the voice arm it runs the product's own module (`src/services/perception/recall`, P4) and is skipped with a note while that module is not in this checkout. It needs the
 * library too (`--library <file.json>`, rows as the `reel_analyses` table holds them); the benchmark reads a file and never the database.
 *
 * A question is answered right when recall names a reel the library has and whose analysis says what the question's `expect.reel` groups say; a question with no such reel
 * (`none`) is answered right when recall says there is none. A link that is not in the library is an INVENTED link, counted apart and expected to be 0 in both libraries.
 */
import { percentile } from '../../dmSales/__evals__/report.js';
import type { MemoryQuestion } from './types.js';

export interface ReelFindings {
    summary?: string;
    topics?: string[];
    seen_on_screen?: string[];
    narration?: string;
    key_moments?: { second: number; what: string }[];
    hook_first_3s?: string;
    hook_score?: number;
    caption_ar?: string;
    cover_second?: number;
    cover_reason?: string;
}

/** One reel of the library, as `reel_analyses` holds it. */
export interface LibraryEntry {
    id: string;
    permalink: string | null;
    youtube_url?: string | null;
    posted_at: string | null;
    result: ReelFindings;
}

export type RecallAnswer =
    | { status: 'ok'; /** The id of the reel it names, or null for "no video on that yet". */ match: string | null; second: number | null; link: string | null; ms: number; usd: number }
    | { status: 'failed'; reason: string; ms: number; usd: number };

/** Recall, as the arm needs it: a question and a library in, a reel (or none) out. `loadRecall` in `scripts/eval-muse.mts` maps the product's own function onto this. */
export type Recall = (question: string, library: readonly LibraryEntry[]) => Promise<RecallAnswer>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The library file: a list of rows, each with an id and the analysis in `result`. A row without either is a mistake in the file, named by its position. */
export function parseLibrary(raw: unknown): LibraryEntry[] {
    const rows = isObj(raw) && Array.isArray(raw.rows) ? raw.rows : raw;
    if (!Array.isArray(rows)) throw new Error('the library file must be a list of reel_analyses rows (or {rows: [...]})');
    return rows.map((row, i) => {
        if (!isObj(row) || !isObj(row.result)) throw new Error(`library row ${i + 1} has no "result" object`);
        const id = typeof row.id === 'string' && row.id ? row.id : typeof row.ig_media_id === 'string' && row.ig_media_id ? row.ig_media_id : '';
        if (!id) throw new Error(`library row ${i + 1} has no id (or ig_media_id)`);
        const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
        return { id, permalink: text(row.permalink), youtube_url: text(row.youtube_url), posted_at: text(row.posted_at), result: row.result as ReelFindings };
    });
}

/** The same reels with only what each says aloud: the narration, and nothing that was seen. The baseline the visual library is compared with. */
export function transcriptOnly(library: readonly LibraryEntry[]): LibraryEntry[] {
    return library.map((e) => ({ ...e, result: { ...(typeof e.result.narration === 'string' ? { narration: e.result.narration } : {}) } }));
}

/** Every word an entry's analysis holds, as one lower-case string, for matching a question's expectation. */
export function textOf(entry: LibraryEntry): string {
    const r = entry.result;
    const parts: string[] = [r.summary ?? '', ...(r.topics ?? []), ...(r.seen_on_screen ?? []), r.narration ?? '', ...(r.key_moments ?? []).map((m) => m.what), r.hook_first_3s ?? '', r.caption_ar ?? ''];
    return parts.join(' ').toLowerCase();
}

/** The ids of the reels a question is about: those whose analysis has a word of every group. Null for a question with no reel (`none`). */
export function rightReels(q: MemoryQuestion, library: readonly LibraryEntry[]): Set<string> | null {
    if ('none' in q.expect) return null;
    const groups = q.expect.reel;
    return new Set(library.filter((e) => {
        const text = textOf(e);
        return groups.every((g) => g.some((w) => text.includes(w.toLowerCase())));
    }).map((e) => e.id));
}

export interface MemoryResult {
    arm: 'memory_visual' | 'memory_transcript';
    questionId: string;
    ask: string;
    visualOnly: boolean;
    status: 'ran' | 'skipped';
    ok: boolean;
    /** The id it named, or null for none. */
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
    arm: MemoryResult['arm'], questions: readonly MemoryQuestion[], library: readonly LibraryEntry[], truth: readonly LibraryEntry[], recall: Recall, deps: MemoryDeps = {},
): Promise<MemoryResult[]> {
    const clock = deps.clock ?? (() => performance.now());
    const links = new Set(truth.flatMap((e) => [e.permalink, e.youtube_url].filter((l): l is string => Boolean(l))));
    const ids = new Set(truth.map((e) => e.id));
    const out: MemoryResult[] = [];
    for (const q of questions) {
        const right = rightReels(q, truth);
        const base = { arm, questionId: q.id, ask: q.ask, visualOnly: q.visualOnly };
        if (right !== null && right.size === 0) {
            out.push({ ...base, status: 'skipped', ok: false, answeredWith: null, inventedLink: false, why: 'the library has no reel whose analysis says what this question is about', ms: 0, usd: 0 });
            continue;
        }
        const started = clock();
        let answer: RecallAnswer;
        try {
            answer = await recall(q.ask, library);
        } catch (err) {
            answer = { status: 'failed', reason: err instanceof Error ? err.message.slice(0, 80) : 'error', ms: clock() - started, usd: 0 };
        }
        const ms = answer.status === 'ok' ? Math.max(answer.ms, clock() - started) : answer.ms;
        if (answer.status === 'failed') {
            out.push({ ...base, status: 'ran', ok: false, answeredWith: null, inventedLink: false, why: `recall failed: ${answer.reason}`, ms, usd: answer.usd });
            continue;
        }
        const inventedLink = (answer.link !== null && !links.has(answer.link)) || (answer.match !== null && !ids.has(answer.match));
        let ok: boolean;
        let why: string | null = null;
        if (right === null) {
            ok = answer.match === null && !inventedLink;
            if (!ok) why = answer.match === null ? 'it invented a link' : 'it named a reel for a topic the library does not cover';
        } else {
            ok = answer.match !== null && right.has(answer.match) && !inventedLink;
            if (!ok) why = answer.match === null ? 'it said there is no such video' : inventedLink ? 'it named a reel or a link the library does not have' : 'it named another reel';
        }
        out.push({ ...base, status: 'ran', ok, answeredWith: answer.match, inventedLink, why, ms, usd: answer.usd });
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
