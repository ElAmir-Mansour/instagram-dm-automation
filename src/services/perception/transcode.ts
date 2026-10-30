/**
 * A voice note's audio, made into the one thing Meta's speech endpoint takes (docs/specs/005-muse-sees T047, research R7, Plan A): a RIFF/WAVE file of mono
 * 16-bit PCM at 24 kHz, with the input's metadata left out. An Instagram voice note is AAC inside an MP4 (`video/mp4`, research R18), which the endpoint refuses
 * (WAV only), so something has to decode it, and that something is `ffmpeg-static`'s binary running INSIDE the Vercel function.
 *
 * **Proven first** (T046, a Vercel preview, 2026-10-30): `ffmpeg-static@5.3.0`, with `"includeFiles": ["node_modules/ffmpeg-static/ffmpeg"]` on the `src/index.ts`
 * build in `vercel.json` (the legacy `builds` config: no `functions` block), ran from `/var/task/node_modules/ffmpeg-static/ffmpeg` (ffmpeg 7.0.2, Linux x64) and turned a
 * 1-second AAC into 49,118 bytes of WAV in 11 to 19 ms; the whole probe took 56 ms warm and 296 ms cold. So: no Heroku worker, no Groq. Without `includeFiles` the
 * package's JavaScript is traced into the function and its binary is not, so the path resolves and the file is not there: `decoder_unavailable`, and `transcode.test.ts`
 * pins the entry in `vercel.json` for that reason.
 *
 *   transcodeToWav(bytes, opts)    the WAV, or why there is none. A RESULT, never a throw; nothing is logged but a cleanup that failed (the caller logs the result).
 *
 * ─── What it does, in order ───
 *   1. Refuses empty input and more than 10 MB (`MEDIA_LIMITS.audio`: the same cap the download enforces).
 *   2. Writes the bytes into a fresh `mkdtemp` directory under `os.tmpdir()` (a voice note's MP4 may keep its index at the END of the file, so it is read from a file and not
 *      a pipe), and runs the binary on it with `execFile` and an argument LIST, never a shell: the file's name is ours and nothing of the sender's is ever a command line.
 *      The arguments are exactly `-hide_banner -loglevel error -i <in> -ac 1 -ar 24000 -c:a pcm_s16le -map_metadata -1 -y <out.wav>` (`ffmpegArgs`).
 *      `-map_metadata -1` drops the input's tags: a phone's voice note can carry a title, a device and a location, and none of it is Meta's business or ours.
 *   3. **10 s, then SIGKILL.** A file that makes the decoder spin frees the job instead of holding it (`timeout`).
 *   4. Measures the result WITHOUT `ffprobe`: the WAV's own size says how long it plays (`llm/wav.ts`, 48,000 bytes a second at 24 kHz mono). More than 3 minutes (plus one second
 *      of grace: an AAC encoder pads a note's ends by a few tens of milliseconds) is `too_long`, and a file over that size is refused from its `stat` before it is read, so a 10 MB
 *      note of 20 minutes never sits in memory as 57 MB of samples.
 *   5. **Removes the directory in `finally`**, on every path: a success, a decoder that failed, a timeout and a throw. A warm Vercel instance keeps `/tmp` between calls, and a
 *      customer's voice is not left on a disk.
 *
 * ─── What the input is trusted for ───
 * It comes from Meta's CDN (`media.ts` allows only Meta's hosts) and is at most 10 MB. A hostile file is the decoder's input like any other: what is bounded here is its size,
 * its time and where it sits on the disk afterwards, and this is not a sandbox. The arguments are the proven ones (T046) and nothing is added to them.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeError, log } from '../../utils/log.js';
import { isAsrWav, parseWav } from '../llm/wav.js';
import { MEDIA_LIMITS } from './media.js';
import { oneLine } from './text.js';

/** How long the decoder may run before it is killed. */
export const TRANSCODE_TIMEOUT_MS = 10_000;

/** The most input: a voice note is a few hundred kilobytes, and this is the cap the download already enforces. */
export const MAX_INPUT_BYTES = MEDIA_LIMITS.audio;

/** The longest voice note answered (3 minutes), and the grace an encoder's padding is given before a note is called longer. */
export const MAX_AUDIO_MS = 3 * 60 * 1000;
export const AUDIO_GRACE_MS = 1000;

/** What the endpoint is sent: 24 kHz is its engine-native rate, mono, 16-bit. */
export const WAV_SAMPLE_RATE = 24_000;
const WAV_BYTES_PER_SECOND = WAV_SAMPLE_RATE * 2;

/** A WAV this long or longer is more than `MAX_AUDIO_MS` plus the grace whatever its header says (the header has room for tags): refused without being read. */
export const MAX_WAV_BYTES = Math.ceil(((MAX_AUDIO_MS + AUDIO_GRACE_MS) / 1000) * WAV_BYTES_PER_SECOND) + 4096;

/** ffmpeg at `-loglevel error` says one line about a file it cannot read; a decoder that floods past this is killed and read as failed. */
const STDERR_MAX_BYTES = 256 * 1024;

/**
 * The decoder's arguments, in order. The input and the output are the only variables, and both are paths this module made. Pure.
 *
 *   -hide_banner -loglevel error   quiet: the one line it says on failure is what the result's `detail` keeps
 *   -i <in>                        the voice note, as downloaded
 *   -ac 1 -ar 24000                mono, 24 kHz
 *   -c:a pcm_s16le                 16-bit PCM, in a WAV container (the output's extension says so)
 *   -map_metadata -1               none of the input's tags
 *   -y <out.wav>                   the file is ours, in a directory that was empty
 */
export const ffmpegArgs = (input: string, output: string): string[] => [
    '-hide_banner', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', String(WAV_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-y', output,
];

/**
 * Where the bundled binary is, or null when there is none: the package is missing, or it has no build for this platform. Imported when it is asked for, never at load:
 * a deployment without the package must lose voice notes, not the app. (The package's own types declare a default export, which Node's ESM loader gives as the
 * path itself, so the value is checked and not trusted.)
 */
export async function ffmpegBinary(): Promise<string | null> {
    try {
        const loaded = (await import('ffmpeg-static')) as unknown as { default?: unknown };
        return typeof loaded.default === 'string' && loaded.default.length > 0 ? loaded.default : null;
    } catch {
        return null;
    }
}

export interface RunOptions {
    timeout: number;
    killSignal: NodeJS.Signals;
    maxBuffer: number;
}

/** `execFile`, as far as this module needs it: a test hands in a stand-in that records the call. Rejects as `execFile` does, with `stdout` and `stderr` on the error. */
export type RunFile = (file: string, args: readonly string[], options: RunOptions) => Promise<{ stdout: string; stderr: string }>;

const runFile: RunFile = (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
    });
});

export type TranscodeFailure =
    /** No bytes. */
    | 'empty'
    /** More than `MAX_INPUT_BYTES`. */
    | 'too_large'
    /** More than three minutes of audio (the decoded WAV says so). */
    | 'too_long'
    /** The binary is not there or cannot run (the package missing, the platform without a build, `includeFiles` not applied, no execute permission). A deployment fault. */
    | 'decoder_unavailable'
    /** The decoder ran and did not make a WAV: not audio it can read, a file with no sound in it, or something that failed on the function's own disk. */
    | 'decode_failed'
    /** Killed after `TRANSCODE_TIMEOUT_MS`. */
    | 'timeout';

export type TranscodeResult =
    | { ok: true; wav: Buffer; /** How long it plays, from its size. */ durationMs: number; ms: number }
    | { ok: false; reason: TranscodeFailure; /** A short code or the decoder's own one line, for a log: never the audio, never the directory. */ detail?: string; ms: number };

export interface TranscodeOptions {
    /** For a test: another binary (null: none), another executor, another place for the temp directory, another deadline. */
    ffmpegPath?: string | null;
    run?: RunFile;
    tmpRoot?: string;
    timeoutMs?: number;
}

/** A transport or filesystem error's short code (`ENOENT`, `EACCES`…), never its message, which carries a path. */
function errorCode(err: unknown): string {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code.slice(0, 40) : 'error';
}

/** The last line the decoder said, with the temp directory taken out of it, as one clean short line. */
function lastLine(stderr: unknown, dir: string): string {
    if (typeof stderr !== 'string') return '';
    const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return oneLine((lines[lines.length - 1] ?? '').split(dir).join('<tmp>'), 160);
}

/** What a failed run was, from the error `execFile` rejects with. */
function classify(err: unknown, dir: string): { reason: TranscodeFailure; detail: string } {
    const e = err as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown } | null;
    if (typeof e?.code === 'string') {
        // The binary could not be started: not there, not allowed, not an executable for this system.
        if (['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(e.code)) return { reason: 'decoder_unavailable', detail: e.code };
        // A flood of output: node has already killed the child, so this comes before `killed`.
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { reason: 'decode_failed', detail: 'stderr_flood' };
        return { reason: 'decode_failed', detail: e.code.slice(0, 40) };
    }
    if (e?.killed === true) return { reason: 'timeout', detail: 'decode' };
    const said = lastLine(e?.stderr, dir);
    if (typeof e?.code === 'number') return { reason: 'decode_failed', detail: `exit_${e.code}${said ? `: ${said}` : ''}` };
    return { reason: 'decode_failed', detail: `${typeof e?.signal === 'string' ? `signal_${e.signal}` : 'exit'}${said ? `: ${said}` : ''}` };
}

/**
 * Decode a voice note to a WAV the speech endpoint takes. Never throws; see the file comment for what is done and in what order.
 *
 *   no bytes                       `empty`
 *   over 10 MB                     `too_large`
 *   no binary, or it cannot run    `decoder_unavailable` (detail `no_binary`, `ENOENT`, `EACCES`…)
 *   10 s without finishing         `timeout`
 *   the decoder failed             `decode_failed` (detail `exit_<n>: <what it said>`)
 *   it made no usable WAV          `decode_failed` (detail `no_output`, `bad_wav_*`, `no_audio`)
 *   more than 3 minutes of audio   `too_long`
 */
export async function transcodeToWav(input: Uint8Array, opts: TranscodeOptions = {}): Promise<TranscodeResult> {
    const startedAt = Date.now();
    const fail = (reason: TranscodeFailure, detail?: string): TranscodeResult => ({ ok: false, reason, ...(detail ? { detail } : {}), ms: Date.now() - startedAt });

    if (input.byteLength === 0) return fail('empty');
    if (input.byteLength > MAX_INPUT_BYTES) return fail('too_large');
    const binary = opts.ffmpegPath !== undefined ? opts.ffmpegPath : await ffmpegBinary();
    if (!binary) return fail('decoder_unavailable', 'no_binary');

    let dir: string | undefined;
    try {
        dir = await mkdtemp(path.join(opts.tmpRoot ?? tmpdir(), 'voice-'));
        const inFile = path.join(dir, 'in.bin');
        const outFile = path.join(dir, 'out.wav');
        await writeFile(inFile, input);

        try {
            await (opts.run ?? runFile)(binary, ffmpegArgs(inFile, outFile), { timeout: opts.timeoutMs ?? TRANSCODE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: STDERR_MAX_BYTES });
        } catch (err) {
            const { reason, detail } = classify(err, dir);
            return fail(reason, detail);
        }

        // The size first: a WAV past the limit is refused without being read into memory.
        let size: number;
        try {
            size = (await stat(outFile)).size;
        } catch {
            return fail('decode_failed', 'no_output');
        }
        if (size > MAX_WAV_BYTES) return fail('too_long');

        const wav = await readFile(outFile);
        const parsed = parseWav(wav);
        if (!parsed.ok) return fail('decode_failed', `bad_wav_${parsed.problem}`);
        if (!isAsrWav(parsed.info)) return fail('decode_failed', 'bad_wav_format');
        if (parsed.info.dataBytes === 0) return fail('decode_failed', 'no_audio');
        if (parsed.info.durationMs > MAX_AUDIO_MS + AUDIO_GRACE_MS) return fail('too_long');
        return { ok: true, wav, durationMs: parsed.info.durationMs, ms: Date.now() - startedAt };
    } catch (err) {
        // The function's own disk (no space, no permission): not the audio's fault, and not something to retry with the same file.
        return fail('decode_failed', `io_${errorCode(err)}`);
    } finally {
        if (dir) {
            try {
                await rm(dir, { recursive: true, force: true });
            } catch (err) {
                // Nobody else can see this: the voice note's file is still on the disk, so it is said.
                log('warn', 'perception.transcode_cleanup_failed', describeError(err));
            }
        }
    }
}
