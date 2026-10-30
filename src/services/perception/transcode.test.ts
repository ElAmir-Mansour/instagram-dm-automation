/**
 * The voice-note decoder (`transcode.ts`): the arguments it runs ffmpeg with, the 10 s kill, the directory it always removes, how long a note may be, and a REAL decode of a
 * small AAC-in-MP4 fixture made at test time with the bundled binary (skipped, cleanly, where that binary is not installed). The shape of every outcome is a result, never a
 * throw. Nothing here reaches the network.
 *
 * Three kinds of double, from fast to real: a `run` stand-in that records the call and writes whatever output the test wants; small shell scripts standing in for the binary,
 * which exercise the real `execFile` (a real kill, a real exit code, a real stderr); and the real ffmpeg.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { setLogSink } from '../../utils/log.js';
import { wavBytes } from '../llm/testAudio.js';
import { isAsrWav, parseWav } from '../llm/wav.js';
import { MEDIA_LIMITS } from './media.js';
import {
    AUDIO_GRACE_MS, ffmpegArgs, ffmpegBinary, MAX_AUDIO_MS, MAX_INPUT_BYTES, MAX_WAV_BYTES, TRANSCODE_TIMEOUT_MS, transcodeToWav, WAV_SAMPLE_RATE, type RunFile, type RunOptions,
    type TranscodeResult,
} from './transcode.js';

const run = promisify(execFile);

/**
 * The bundled binary, or why a test that needs it is skipped. Found here, before any test is defined: a `skip` option is read when the test is declared, which is before
 * a `before` hook has run.
 */
const binary: string | null = await ffmpegBinary();
const missing: string | false = binary !== null && existsSync(binary) && statSync(binary).isFile() ? false : 'the ffmpeg-static binary is not installed here';
const NOTE = Buffer.from('pretend this is a voice note: AAC inside an MP4');

let work: string;
let bin: string;
let restoreSink: (() => void) | undefined;
let logged: { level: string; line: string }[];

before(async () => {
    bin = await mkdtemp(path.join(tmpdir(), 'transcode-test-bin-'));
});
after(async () => {
    await rm(bin, { recursive: true, force: true });
});
beforeEach(async () => {
    // Where the decoder makes its own directory: empty before and, if it cleans up, after.
    work = await mkdtemp(path.join(tmpdir(), 'transcode-test-work-'));
    logged = [];
    const previous = setLogSink((level, line) => { logged.push({ level, line }); });
    restoreSink = () => setLogSink(previous);
});
afterEach(async () => {
    restoreSink?.();
    await rm(work, { recursive: true, force: true });
});

const leftBehind = (): Promise<string[]> => readdir(work);

interface Call { file: string; args: readonly string[]; options: RunOptions; input: Buffer; dir: string }

/** A `run` that records what it was called with (and the input file as it was at that moment) and then does what the test says: write an output, or fail. */
function standIn(behave: (call: Call) => Promise<void> | void = () => undefined): { run: RunFile; calls: Call[] } {
    const calls: Call[] = [];
    const fake: RunFile = async (file, args, options) => {
        const input = args[args.indexOf('-i') + 1]!;
        const call: Call = { file, args: [...args], options, input: await readFile(input), dir: path.dirname(input) };
        calls.push(call);
        await behave(call);
        return { stdout: '', stderr: '' };
    };
    return { run: fake, calls };
}

const outputOf = (call: Call): string => call.args[call.args.length - 1]!;
const writes = (wav: Buffer) => async (call: Call) => { await writeFile(outputOf(call), wav); };
const failsWith = (error: Record<string, unknown>) => () => { throw Object.assign(new Error('Command failed'), error); };

const decode = (input: Uint8Array, over: Parameters<typeof transcodeToWav>[1] = {}): Promise<TranscodeResult> =>
    transcodeToWav(input, { ffmpegPath: '/fake/ffmpeg', tmpRoot: work, ...over });

function assertFailure(result: TranscodeResult, reason: string, detail?: string | RegExp): void {
    assert.equal(result.ok, false, JSON.stringify(result));
    if (result.ok) return;
    assert.equal(result.reason, reason, JSON.stringify(result));
    if (typeof detail === 'string') assert.equal(result.detail, detail);
    else if (detail) assert.match(result.detail ?? '', detail);
}

describe('the decoder\'s arguments', () => {
    it('are exactly the proven ones, as a list: quiet, the input, mono, 24 kHz, 16-bit PCM, no metadata, overwrite, the output', () => {
        assert.deepEqual(ffmpegArgs('/t/in.bin', '/t/out.wav'), [
            '-hide_banner', '-loglevel', 'error', '-i', '/t/in.bin', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-y', '/t/out.wav',
        ]);
        assert.equal(WAV_SAMPLE_RATE, 24_000);
    });

    it('are what ffmpeg is run with, by execFile\'s list form with no shell, on a file that holds the bytes it was given', async () => {
        const { run, calls } = standIn(writes(wavBytes({ seconds: 2 })));
        const result = await decode(NOTE, { run });
        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        const call = calls[0]!;
        assert.equal(call.file, '/fake/ffmpeg');
        const input = path.join(call.dir, 'in.bin');
        const output = path.join(call.dir, 'out.wav');
        assert.deepEqual(call.args, ffmpegArgs(input, output));
        assert.ok(call.input.equals(NOTE), 'the input file held exactly the downloaded bytes when the decoder started');
        assert.ok(!('shell' in call.options), 'no shell: an argument is never parsed as a command line');
    });

    it('make the decoder\'s directory under the root it is given, named voice-…, and put both files in it', async () => {
        const { run, calls } = standIn(writes(wavBytes()));
        await decode(NOTE, { run });
        assert.equal(path.dirname(calls[0]!.dir), work);
        assert.match(path.basename(calls[0]!.dir), /^voice-[A-Za-z0-9]{6}$/);
    });

    it('make a fresh directory for each note, so two at once never share a file', async () => {
        const { run, calls } = standIn(writes(wavBytes()));
        await Promise.all([decode(NOTE, { run }), decode(NOTE, { run })]);
        assert.notEqual(calls[0]!.dir, calls[1]!.dir);
    });
});

describe('the 10 s limit', () => {
    it('is 10 seconds, and the process is killed with SIGKILL when it passes it, with a bounded stderr', async () => {
        assert.equal(TRANSCODE_TIMEOUT_MS, 10_000);
        const { run, calls } = standIn(writes(wavBytes()));
        await decode(NOTE, { run });
        assert.equal(calls[0]!.options.timeout, 10_000);
        assert.equal(calls[0]!.options.killSignal, 'SIGKILL');
        assert.ok(calls[0]!.options.maxBuffer > 0 && calls[0]!.options.maxBuffer <= 1024 * 1024);
    });

    it('is `timeout` when the decoder was killed for it', async () => {
        const { run } = standIn(failsWith({ killed: true, signal: 'SIGKILL', code: null }));
        assertFailure(await decode(NOTE, { run }), 'timeout', 'decode');
        assert.deepEqual(await leftBehind(), []);
    });

    it('really kills a decoder that will not finish: a script that sleeps is gone within the deadline and the directory with it', async () => {
        const script = path.join(bin, 'sleeper.sh');
        const pidFile = path.join(bin, 'sleeper.pid');
        const flag = path.join(bin, 'sleeper.flag');
        // `exec` makes the shell become the sleep, so killing the process kills the sleep and leaves nothing behind. While the flag exists the script exits at once: the first run
        // of a new file can take hundreds of milliseconds on a Mac (the system looks it over), and the deadline below must start after that, so it is run once beforehand.
        await writeFile(script, `#!/bin/sh\nif [ -e '${flag}' ]; then exit 0; fi\necho $$ > '${pidFile}'\nexec sleep 30\n`);
        await chmod(script, 0o755);
        await writeFile(flag, '');
        await run(script);
        await rm(flag);

        const started = Date.now();
        const result = await decode(NOTE, { ffmpegPath: script, timeoutMs: 1500 });
        assertFailure(result, 'timeout', 'decode');
        assert.ok(Date.now() - started < 10_000, 'the call came back at the deadline, not when the sleep ended');
        const pid = Number((await readFile(pidFile, 'utf8')).trim());
        assert.ok(pid > 1);
        assert.throws(() => process.kill(pid, 0), (err: NodeJS.ErrnoException) => err.code === 'ESRCH', 'the process is gone');
        assert.deepEqual(await leftBehind(), []);
    });
});

describe('the directory is removed on every path', () => {
    it('after a decode that worked', async () => {
        const { run } = standIn(writes(wavBytes({ seconds: 1 })));
        assert.equal((await decode(NOTE, { run })).ok, true);
        assert.deepEqual(await leftBehind(), []);
    });

    it('after a decoder that failed, was killed, or could not start', async () => {
        for (const error of [{ code: 1, stderr: 'x' }, { killed: true, signal: 'SIGKILL' }, { code: 'ENOENT' }, { code: 'EACCES' }, { signal: 'SIGSEGV' }]) {
            const { run } = standIn(failsWith(error));
            assert.equal((await decode(NOTE, { run })).ok, false);
            assert.deepEqual(await leftBehind(), [], JSON.stringify(error));
        }
    });

    it('after an output that is no good: not a WAV, too long, no sound, no file at all', async () => {
        for (const behave of [writes(Buffer.from('junk')), writes(wavBytes({ seconds: 200 })), writes(wavBytes({ seconds: 0 })), () => undefined]) {
            const { run } = standIn(behave);
            assert.equal((await decode(NOTE, { run })).ok, false);
            assert.deepEqual(await leftBehind(), []);
        }
    });

    it('after the decoder throws something that is not an exec error at all', async () => {
        const { run } = standIn(() => { throw new TypeError('boom'); });
        assertFailure(await decode(NOTE, { run }), 'decode_failed', 'exit');
        assert.deepEqual(await leftBehind(), []);
    });

    it('and a directory that cannot be removed is said, not thrown: the note\'s file is still on the disk, and nobody else would know', async () => {
        const root = path.join(work, 'locked');
        await mkdir(root);
        const { run } = standIn(async (call) => {
            await writeFile(outputOf(call), wavBytes());
            // Take the permission to remove the entries away from the directory's parent after the fact: rm now fails with EACCES on a real filesystem.
            await chmod(root, 0o555);
        });
        try {
            const result = await decode(NOTE, { run, tmpRoot: root });
            assert.equal(result.ok, true, 'the transcript does not depend on cleanup');
            assert.equal(logged.filter((l) => JSON.parse(l.line).event === 'perception.transcode_cleanup_failed').length, process.getuid?.() === 0 ? 0 : 1);
        } finally {
            await chmod(root, 0o755);
        }
    });
});

describe('what comes in', () => {
    it('refuses no bytes at all, without making a directory or running anything', async () => {
        const { run, calls } = standIn();
        assertFailure(await decode(new Uint8Array(0), { run }), 'empty');
        assert.equal(calls.length, 0);
        assert.deepEqual(await leftBehind(), []);
    });

    it('refuses more than 10 MB, which is the cap the download already enforces', async () => {
        assert.equal(MAX_INPUT_BYTES, 10 * 1024 * 1024);
        assert.equal(MAX_INPUT_BYTES, MEDIA_LIMITS.audio);
        const { run, calls } = standIn(writes(wavBytes()));
        assertFailure(await decode(Buffer.alloc(MAX_INPUT_BYTES + 1), { run }), 'too_large');
        assert.equal(calls.length, 0);
        assert.equal((await decode(Buffer.alloc(MAX_INPUT_BYTES), { run })).ok, true, 'exactly 10 MB is allowed');
    });

    it('is `decoder_unavailable` with no binary at all (the package missing, or no build for the platform), and runs nothing', async () => {
        const { run, calls } = standIn();
        assertFailure(await decode(NOTE, { run, ffmpegPath: null }), 'decoder_unavailable', 'no_binary');
        assert.equal(calls.length, 0);
    });
});

describe('what a failure is called', () => {
    it('a binary that is not there or not allowed to run is decoder_unavailable, with the code', async () => {
        for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC']) {
            assertFailure(await decode(NOTE, { run: standIn(failsWith({ code })).run }), 'decoder_unavailable', code);
        }
    });

    it('an exit code is decode_failed with the decoder\'s own last line, the directory taken out of it', async () => {
        const { run } = standIn((call) => {
            throw Object.assign(new Error('Command failed'), {
                code: 183, killed: false, signal: null, stderr: `[mov @ 0x1] stuff\n${call.args[call.args.indexOf('-i') + 1]}: Invalid data found when processing input\n`,
            });
        });
        const result = await decode(NOTE, { run });
        assertFailure(result, 'decode_failed', /^exit_183: <tmp>\/in\.bin: Invalid data found when processing input$/);
        assert.ok(!(result.ok ? '' : result.detail ?? '').includes(work), 'the path of the directory is not in what is logged');
    });

    it('a flood of output (the process is killed by node for it, so it also says `killed`) is decode_failed and not a timeout', async () => {
        assertFailure(await decode(NOTE, { run: standIn(failsWith({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true })).run }), 'decode_failed', 'stderr_flood');
    });

    it('a crash by signal is decode_failed with the signal', async () => {
        assertFailure(await decode(NOTE, { run: standIn(failsWith({ code: null, killed: false, signal: 'SIGSEGV' })).run }), 'decode_failed', 'signal_SIGSEGV');
    });

    it('keeps the detail to one short clean line, however much the decoder said', async () => {
        const noisy = `${'x'.repeat(500)}\u0007\u202e control and direction characters`;
        const result = await decode(NOTE, { run: standIn(failsWith({ code: 1, stderr: `first\n${noisy}\n` })).run });
        assert.equal(result.ok, false);
        const detail = result.ok ? '' : result.detail ?? '';
        assert.ok(detail.length <= 180, detail.length.toString());
        assert.doesNotMatch(detail, /[\u0000-\u001f\u202e]/);
    });
});

describe('what comes out', () => {
    it('is the WAV, how long it plays (from its size, with no ffprobe), and how long the whole thing took', async () => {
        const wav = wavBytes({ seconds: 3.5, info: true });
        const result = await decode(NOTE, { run: standIn(writes(wav)).run });
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.ok(result.wav.equals(wav));
        assert.equal(result.durationMs, 3500);
        assert.ok(result.ms >= 0);
    });

    it('allows exactly three minutes, and the encoder\'s padding after them (one second of grace); more is `too_long`', async () => {
        assert.equal(MAX_AUDIO_MS, 180_000);
        assert.equal(AUDIO_GRACE_MS, 1000);
        const ok = async (seconds: number) => decode(NOTE, { run: standIn(writes(wavBytes({ seconds }))).run });
        const at180 = await ok(180);
        assert.ok(at180.ok && at180.durationMs === 180_000, JSON.stringify(at180));
        const padded = await ok(180.05);
        assert.ok(padded.ok, 'an AAC note of exactly 3:00 decodes to a few tens of milliseconds more');
        assert.ok((await ok(181)).ok, 'the grace is a whole second');
        assertFailure(await ok(181.05), 'too_long');
        assertFailure(await ok(200), 'too_long');
    });

    it('refuses a WAV past the size limit from its stat, WITHOUT reading it: junk that size is `too_long`, and was never parsed', async () => {
        const { run } = standIn(async (call) => { await writeFile(outputOf(call), Buffer.alloc(MAX_WAV_BYTES + 1)); });
        assertFailure(await decode(NOTE, { run }), 'too_long');
        // A size that is exactly the limit IS read: it is junk, so it is a WAV that is not one.
        const atLimit = standIn(async (call) => { await writeFile(outputOf(call), Buffer.alloc(MAX_WAV_BYTES)); });
        assertFailure(await decode(NOTE, { run: atLimit.run }), 'decode_failed', 'bad_wav_not_wav');
        assert.equal(MAX_WAV_BYTES, Math.ceil(181 * 48_000) + 4096);
    });

    it('is decode_failed when the decoder exited 0 and made nothing usable: no file, not a WAV, the wrong format, no samples', async () => {
        assertFailure(await decode(NOTE, { run: standIn().run }), 'decode_failed', 'no_output');
        assertFailure(await decode(NOTE, { run: standIn(writes(Buffer.from('RIFF....not really'))).run }), 'decode_failed', /^bad_wav_/);
        assertFailure(await decode(NOTE, { run: standIn(writes(wavBytes({ rate: 44_100, channels: 2 }))).run }), 'decode_failed', 'bad_wav_format');
        assertFailure(await decode(NOTE, { run: standIn(writes(wavBytes({ seconds: 0 }))).run }), 'decode_failed', 'no_audio');
    });

    it('is decode_failed (io_…) when the function\'s own disk fails, and says the code and nothing of the path', async () => {
        const result = await decode(NOTE, { run: standIn().run, tmpRoot: path.join(work, 'does', 'not', 'exist') });
        assertFailure(result, 'decode_failed', 'io_ENOENT');
        assert.ok(!(result.ok ? '' : result.detail ?? '').includes(work));
    });
});

describe('the real execFile, against scripts that stand in for the binary', () => {
    async function script(name: string, body: string): Promise<string> {
        const file = path.join(bin, name);
        await writeFile(file, `#!/bin/sh\n${body}\n`);
        await chmod(file, 0o755);
        return file;
    }

    it('passes the arguments as a list (a file name with spaces and quotes is one argument, never a command), reads the exit code and stderr, and returns what the decoder wrote', async () => {
        const fixture = path.join(bin, 'fixture.wav');
        await writeFile(fixture, wavBytes({ seconds: 2, info: true }));
        // The script writes the argument count and the output path, then copies a WAV to its last argument.
        const argsFile = path.join(bin, 'args.txt');
        const ffmpeg = await script('writer.sh', `printf '%s\\n' "$#" "$@" > '${argsFile}'\nfor last; do :; done\ncp '${fixture}' "$last"`);
        const root = path.join(work, 'a dir with $(spaces) and \'quotes\'');
        await mkdir(root);
        const result = await decode(NOTE, { ffmpegPath: ffmpeg, tmpRoot: root });
        assert.equal(result.ok, true, JSON.stringify(result));
        if (!result.ok) return;
        assert.equal(result.durationMs, 2000);
        const seen = (await readFile(argsFile, 'utf8')).split('\n');
        assert.equal(seen[0], '15', 'fifteen arguments, however the path was spelt');
        assert.deepEqual(seen.slice(1, 5), ['-hide_banner', '-loglevel', 'error', '-i']);
        assert.deepEqual(await readdir(root), []);
    });

    it('is decode_failed with the exit code and the last line it said', async () => {
        const ffmpeg = await script('failer.sh', `echo 'first line' >&2\necho "cannot open $5" >&2\nexit 3`);
        const result = await decode(NOTE, { ffmpegPath: ffmpeg });
        assertFailure(result, 'decode_failed', /^exit_3: cannot open <tmp>\/in\.bin$/);
    });

    it('is decoder_unavailable for a path that does not exist and for a file that may not be run', async () => {
        assertFailure(await decode(NOTE, { ffmpegPath: path.join(bin, 'nothing-here') }), 'decoder_unavailable', 'ENOENT');
        const plain = path.join(bin, 'plain.txt');
        await writeFile(plain, '#!/bin/sh\nexit 0\n');
        await chmod(plain, 0o644);
        assertFailure(await decode(NOTE, { ffmpegPath: plain }), 'decoder_unavailable', 'EACCES');
        assert.deepEqual(await leftBehind(), []);
    });
});

/** A note as Instagram sends one, made with the bundled binary: AAC in MP4. The index (`moov`) is at the END, as it is for any MP4 written to a file. */
async function aacNote(seconds: number, extra: string[] = [], source = 'sine=frequency=440'): Promise<Buffer> {
    const file = path.join(bin, `note-${Math.random().toString(36).slice(2)}.mp4`);
    await run(binary!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `${source}:duration=${seconds}`, '-c:a', 'aac', '-b:a', '48k', ...extra, '-f', 'mp4', '-y', file]);
    return readFile(file);
}

describe('a real decode with the bundled ffmpeg', () => {
    const real = (name: string, fn: () => Promise<void>) => it(name, { skip: missing === false ? false : String(missing) }, fn);

    real('turns a 1-second AAC-in-MP4 note into mono 16-bit 24 kHz WAV that Meta\'s endpoint takes, and removes the directory', async () => {
        const note = await aacNote(1);
        assert.ok(note.indexOf('moov') > note.indexOf('mdat'), 'the fixture has its index at the end of the file, like a real voice note may');
        const result = await transcodeToWav(note, { tmpRoot: work });
        assert.equal(result.ok, true, JSON.stringify(result));
        if (!result.ok) return;
        const parsed = parseWav(result.wav);
        assert.ok(parsed.ok);
        assert.ok(isAsrWav(parsed.info));
        assert.deepEqual([parsed.info.format, parsed.info.channels, parsed.info.sampleRate, parsed.info.bitsPerSample], [1, 1, 24_000, 16]);
        // A second of tone, plus the encoder's priming and padding: the probe on Vercel got 1,022 ms.
        assert.ok(result.durationMs >= 1000 && result.durationMs <= 1100, String(result.durationMs));
        assert.equal(result.wav.subarray(0, 4).toString('ascii'), 'RIFF');
        assert.deepEqual(await leftBehind(), []);
    });

    real('strips the input\'s metadata: a title and a location in the note are not in the WAV (and would be without -map_metadata -1)', async () => {
        const note = await aacNote(1, ['-metadata', 'title=SECRET-TITLE-9f3a', '-metadata', 'comment=LOCATION+30.0444+031.2357']);
        assert.ok(note.includes('SECRET-TITLE-9f3a'), 'the fixture carries the tags');
        const result = await transcodeToWav(note, { tmpRoot: work });
        assert.ok(result.ok);
        if (!result.ok) return;
        assert.ok(!result.wav.includes('SECRET-TITLE-9f3a') && !result.wav.includes('LOCATION'), 'no tag of the input survived');

        // The same decode WITHOUT the flag copies them: this is what the assertion above would not catch if the flag were ever dropped.
        const dir = await mkdtemp(path.join(work, 'sensitivity-'));
        await writeFile(path.join(dir, 'in.bin'), note);
        await run(binary!, ['-hide_banner', '-loglevel', 'error', '-i', path.join(dir, 'in.bin'), '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-y', path.join(dir, 'out.wav')]);
        const without = await readFile(path.join(dir, 'out.wav'));
        assert.ok(without.includes('SECRET-TITLE-9f3a'), 'without -map_metadata -1 the title is in the WAV');
    });

    real('decodes exactly three minutes, and refuses more than three minutes with `too_long`', async () => {
        const silence = 'anullsrc=r=24000:cl=mono';
        const three = await transcodeToWav(await aacNote(180, [], silence), { tmpRoot: work });
        assert.ok(three.ok, JSON.stringify(three));
        if (three.ok) assert.ok(three.durationMs >= 180_000 && three.durationMs <= 181_000, String(three.durationMs));
        const long = await transcodeToWav(await aacNote(200, [], silence), { tmpRoot: work });
        assertFailure(long, 'too_long');
        assert.deepEqual(await leftBehind(), []);
    });

    real('says decode_failed, with the decoder\'s own words and not the directory, for a file that is not audio', async () => {
        const result = await transcodeToWav(Buffer.from('this is definitely not audio '.repeat(40)), { tmpRoot: work });
        assertFailure(result, 'decode_failed', /^exit_\d+: <tmp>\/in\.bin:/);
        assert.deepEqual(await leftBehind(), []);
    });

    real('says decode_failed for an MP4 with no sound in it', async () => {
        const file = path.join(bin, 'silent-video.mp4');
        await run(binary!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=5', '-c:v', 'mpeg4', '-an', '-y', file]);
        assertFailure(await transcodeToWav(await readFile(file), { tmpRoot: work }), 'decode_failed', /^exit_\d+/);
    });
});

describe('what the deployment ships', () => {
    it('puts the binary in the function: vercel.json\'s src/index.ts build includes node_modules/ffmpeg-static/ffmpeg (without it the path resolves and the file is not there)', () => {
        const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { builds: Array<{ src: string; use: string; config?: { includeFiles?: string[] } }> };
        const build = vercel.builds.find((b) => b.src === 'src/index.ts');
        assert.ok(build, 'the function build');
        assert.equal(build.use, '@vercel/node');
        assert.deepEqual(build.config?.includeFiles, ['node_modules/ffmpeg-static/ffmpeg']);
    });

    it('pins ffmpeg-static to the version that passed the probe: exactly 5.3.0, in package.json and the lockfile', () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
        assert.equal(pkg.dependencies['ffmpeg-static'], '5.3.0');
        const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string }> };
        assert.equal(lock.packages['node_modules/ffmpeg-static']?.version, '5.3.0');
    });

    it('has the binary where the package says, on this machine (the tests that decode for real are skipped where it is not)', { skip: missing === false ? false : String(missing) }, async () => {
        assert.ok(binary && path.isAbsolute(binary));
        assert.ok((await stat(binary)).isFile());
    });
});

describe('transcode.ts: what it never does', () => {
    const source = readFileSync(new URL('./transcode.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    it('runs the decoder with execFile and an argument list: no exec, no spawn, no shell option', () => {
        assert.match(code, /import \{ execFile \} from 'node:child_process'/);
        assert.doesNotMatch(code, /\bexec\(|\bexecSync\b|\bspawn\b|\bexecFileSync\b|shell\s*:/);
    });

    it('imports the binary\'s package only when it is asked for: a deployment without it loses voice notes, not the app', () => {
        assert.doesNotMatch(code, /^\s*import\b[^\n]*['"]ffmpeg-static['"]/m);
        assert.match(code, /await import\('ffmpeg-static'\)/);
    });

    it('touches no database, no setting and no network, and stores nothing but in its own directory', () => {
        assert.doesNotMatch(code, /\bpool\b|db\/query|appSettings|getSetting|\bfetch\(|axios|media_uploads/);
    });
});
