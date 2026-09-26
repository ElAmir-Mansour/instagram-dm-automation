/**
 * What the worker may send back for the Monteur's four job kinds (MONTEUR.md §3), checked before
 * anything is written. Pure: `completeJob` (src/services/studio/jobs.ts) applies what these return.
 *
 * The rule is the Studio's: a result that is the wrong shape is a 400 and changes nothing, so the
 * worker sees its own bug; one odd entry in an otherwise good scan is skipped and named, so one
 * strange file cannot keep every other new video out.
 */
import type { TranscriptWord } from '../../db/rows.js';
import { uploadIdFromUrl } from '../storage.js';
import { clipText, isFiniteNumber, isPlainObject, problemsError, StudioError } from '../studio/common.js';

/** A scan never returns more than `videos_per_run` (≤ 10); this bounds a worker that ignores it. */
export const MAX_SCAN_FILES = 100;
/** MONTEUR.md §3: at most 40 000 words, about four hours of speech. */
export const MAX_WORDS = 40_000;
const MAX_WORD_TEXT = 200;
const MAX_PROBLEMS = 20;
/** How many of the worker's skipped files a scan's stored result keeps. */
export const MAX_SKIPPED_KEPT = 20;

/** The worker's content key: the sha1 hex of the size, the first MiB and the last MiB. */
export const CONTENT_KEY = /^[0-9a-f]{40}$/;
/** An absolute path on macOS or Linux, or on Windows (`C:\…`, `\\server\share`). */
export const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ─── pick_folder ────────────────────────────────────────────────────────────────────────

export type PickFolderResult = { folder: string } | { cancelled: true };

/** `{ folder }` or `{ cancelled: true }`. The folder is checked by the settings rules on apply. */
export function parsePickFolderResult(result: unknown): PickFolderResult {
    if (isPlainObject(result) && result.cancelled === true) return { cancelled: true };
    if (isPlainObject(result) && typeof result.folder === 'string' && result.folder.trim()) {
        // osascript ends its answer with a newline; a path never does.
        return { folder: result.folder.replace(/[\r\n]+$/, '').trim() };
    }
    throw new StudioError(400, 'A folder pick result is { folder: "/absolute/path" } or { cancelled: true }.');
}

// ─── monteur_scan ───────────────────────────────────────────────────────────────────────

export interface ScannedFile {
    key: string;
    path: string;
    name: string;
    size: number | null;
    duration: number | null;
}

export interface SkippedFile { name: string; reason: string }

function scannedFileProblem(raw: unknown): string | null {
    if (!isPlainObject(raw)) return 'not an object';
    if (typeof raw.path !== 'string' || !ABSOLUTE_PATH.test(raw.path) || raw.path.length > 4096) return 'path must be an absolute path';
    if (typeof raw.key !== 'string' || !CONTENT_KEY.test(raw.key.toLowerCase())) return 'key must be a sha1 in hex';
    if (raw.name != null && typeof raw.name !== 'string') return 'name must be text';
    if (raw.size != null && !(isFiniteNumber(raw.size) && raw.size >= 0)) return 'size must be a number of bytes';
    if (raw.duration != null && !(isFiniteNumber(raw.duration) && raw.duration >= 0)) return 'duration must be a number of seconds';
    return null;
}

function baseName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The new files, oldest first as the worker sent them, at most `limit` of them and each content
 * key once; what was skipped, the worker's reasons plus any entry this could not read; and whether
 * the folder was missing.
 */
export function parseMonteurScanResult(
    result: unknown, limit: number
): { files: ScannedFile[]; skipped: SkippedFile[]; missing: boolean } {
    if (!isPlainObject(result) || !Array.isArray(result.files)) {
        throw new StudioError(400, 'A scan result is { files: [...], skipped: [...], missing }.');
    }
    if (result.files.length > MAX_SCAN_FILES) {
        throw new StudioError(400, `A scan result holds at most ${MAX_SCAN_FILES} files.`);
    }
    const skipped: SkippedFile[] = [];
    if (Array.isArray(result.skipped)) {
        for (const s of result.skipped.slice(0, 200)) {
            if (!isPlainObject(s)) continue;
            skipped.push({ name: clipText(s.name, 300) ?? '(unnamed)', reason: clipText(s.reason, 300) ?? 'skipped' });
        }
    }
    const seen = new Set<string>();
    const files: ScannedFile[] = [];
    result.files.forEach((raw: unknown, i: number) => {
        const problem = scannedFileProblem(raw);
        const r = raw as Record<string, unknown>;
        if (problem) {
            skipped.push({ name: clipText(isPlainObject(raw) ? r.name ?? r.path : null, 300) ?? `files[${i}]`, reason: `unreadable: ${problem}` });
            return;
        }
        const key = (r.key as string).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const path = r.path as string;
        files.push({
            key,
            path,
            name: clipText(r.name, 1024) ?? baseName(path),
            size: (r.size as number | null | undefined) ?? null,
            duration: r.duration == null ? null : round2(r.duration as number),
        });
    });
    const cap = Number.isInteger(limit) && limit > 0 ? limit : files.length;
    return { files: files.slice(0, cap), skipped, missing: result.missing === true };
}

// ─── monteur_transcribe ─────────────────────────────────────────────────────────────────

/**
 * The words, in time order, times rounded to 2 decimals. An empty token is dropped and an end
 * before its start is moved to the start (DTW timing can cross by a hundredth). A word that is not
 * `[t0, t1, text]` refuses the whole result: half a transcript would be cut as if it were all.
 */
export function parseTranscribeResult(result: unknown): { duration: number | null; words: TranscriptWord[] } {
    if (!isPlainObject(result) || !Array.isArray(result.words)) {
        throw new StudioError(400, 'A transcript result is { duration, words: [[t0, t1, "text"], ...] }.');
    }
    if (result.words.length > MAX_WORDS) {
        throw new StudioError(400, `A transcript holds at most ${MAX_WORDS} words, not ${result.words.length}.`);
    }
    const problems: string[] = [];
    const words: TranscriptWord[] = [];
    result.words.forEach((raw: unknown, i: number) => {
        if (!Array.isArray(raw) || raw.length < 3) {
            problems.push(`words[${i}] must be [t0, t1, "text"]`);
            return;
        }
        const [t0, t1, text] = raw as unknown[];
        if (!(isFiniteNumber(t0) && t0 >= 0) || !(isFiniteNumber(t1) && t1 >= 0)) {
            problems.push(`words[${i}]: t0 and t1 must be seconds`);
            return;
        }
        if (typeof text !== 'string') {
            problems.push(`words[${i}]: the text must be a string`);
            return;
        }
        const word = text.trim().slice(0, MAX_WORD_TEXT);
        if (!word) return;
        words.push([round2(t0), round2(Math.max(t0, t1)), word]);
    });
    if (problems.length) throw problemsError(problems.slice(0, MAX_PROBLEMS), 'the transcript');
    if (result.duration != null && !(isFiniteNumber(result.duration) && result.duration >= 0)) {
        throw new StudioError(400, 'duration must be a number of seconds.');
    }
    // Stable, so words at the same instant keep the order they were spoken in.
    words.sort((a, b) => a[0] - b[0]);
    return { duration: result.duration == null ? null : round2(result.duration as number), words };
}

// ─── monteur_render ─────────────────────────────────────────────────────────────────────

export interface ParsedRender {
    video_url: string;
    cover_url: string;
    duration: number;
    videoId: string;
    coverId: string;
}

/** Two of this app's upload URLs and a duration. Whose uploads they are is checked on apply. */
export function parseMonteurRenderResult(result: unknown): ParsedRender {
    if (!isPlainObject(result)) throw new StudioError(400, 'A render result is { video_url, cover_url, duration, width, height }.');
    const problems: string[] = [];
    const url = (key: 'video_url' | 'cover_url'): { url: string; id: string } | null => {
        const value = result[key];
        const id = typeof value === 'string' && /^https?:\/\//i.test(value) ? uploadIdFromUrl(value) : null;
        if (!id) {
            problems.push(`${key} is not one of this app's upload URLs`);
            return null;
        }
        return { url: value as string, id };
    };
    const video = url('video_url');
    const cover = url('cover_url');
    if (!(isFiniteNumber(result.duration) && result.duration > 0)) problems.push('duration must be the video\'s length in seconds');
    if (problems.length) throw problemsError(problems, 'the render result');
    return {
        video_url: video!.url, cover_url: cover!.url, duration: round2(result.duration as number),
        videoId: video!.id, coverId: cover!.id,
    };
}
