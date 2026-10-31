/**
 * A voice note, heard (`voice.ts`): download -> decode -> Meta's speech model as one result, and what each way it can end is called. The steps are handed in, one by one, so
 * that every outcome is reached without a network, a binary or a database; the last describe runs the real download, the real decoder (the bundled ffmpeg, skipped where it is
 * not installed) and the real `ai_usage` bookkeeping against a stand-in for Meta, to see the whole chain put together.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { setLogSink } from '../../utils/log.js';
import { transcribeWithMeta, type TranscribeWithMetaArgs, type TranscribeWithMetaResult } from '../aiProviders/asr.js';
import { installAiDb, type AiDb } from '../aiProviders/testDb.js';
import { assertNoKey, FAKE_KEYS } from '../aiProviders/testKeys.js';
import { AiError, type AiErrorKind } from '../llm/errors.js';
import { asrUsd, ASR_MODEL, ASR_TIMEOUT_MS } from '../llm/metaAsr.js';
import { parseMultipart, wavBytes } from '../llm/testAudio.js';
import { jsonResponse } from '../llm/testFetch.js';
import { isAsrWav, parseWav } from '../llm/wav.js';
import { CONNECT_TIMEOUT_MS, fetchMedia, TOTAL_TIMEOUT_MS, type MediaResult } from './media.js';
import { MIN_CALL_MS, STEP_BUDGET_MS } from './perceive.js';
import { TRANSCRIPT_MAX_CHARS } from './text.js';
import { ffmpegBinary, TRANSCODE_TIMEOUT_MS, type TranscodeFailure, type TranscodeResult } from './transcode.js';
import { MIN_TRANSCRIPT_WORDS, transcribeVoice, voiceDraft, wordCount, type VoiceDeps, type VoiceInput, type VoiceResult } from './voice.js';

const CREATOR = '44444444-4444-4444-8444-444444444444';
const OWNER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-01T09:30:00.000Z');
const LINK = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=SECRETSIG123';
const KEY = FAKE_KEYS.meta;
const TRANSCRIPT = 'عايز أعرف بكام الاشتراك وفيه شهادة';

let logs: { level: string; line: string; fields: Record<string, unknown> }[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    logs = [];
    const previous = setLogSink((level, line) => { logs.push({ level, line, fields: JSON.parse(line) }); });
    restoreSink = () => setLogSink(previous);
});
afterEach(() => {
    restoreSink?.();
});

const voiceLines = () => logs.filter((l) => String(l.fields.event).startsWith('perception.voice_'));

// ─── The steps ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const downloaded = (over: Record<string, unknown> = {}): MediaResult =>
    ({ ok: true, media: { mediaKind: 'audio', mime: 'video/mp4', bytes: Buffer.from('the mp4 bytes'), host: 'lookaside.fbsbx.com', ms: 12, ...over } as never });
const decoded = (over: Record<string, unknown> = {}): TranscodeResult => ({ ok: true, wav: wavBytes({ seconds: 3 }), durationMs: 3000, ms: 5, ...over } as never);
const heard = (over: Partial<TranscribeWithMetaResult> = {}): TranscribeWithMetaResult =>
    ({ transcript: TRANSCRIPT, durationMs: 3000, model: ASR_MODEL, usd: 0.00015, usageId: '9', elapsedMs: 800, sessionId: 'sess-1', ...over });
const aiError = (kind: AiErrorKind, status?: number): AiError => new AiError({ kind, provider: 'meta', model: ASR_MODEL, message: `${kind} happened`, ...(status ? { status } : {}) });

interface Script {
    download?: (link: string | null | undefined, options: { connectMs: number; totalMs: number }) => MediaResult | Promise<MediaResult>;
    decode?: (bytes: Uint8Array, options: { timeoutMs: number }) => TranscodeResult | Promise<TranscodeResult>;
    /** Throws to fail; `attempt` counts from 1. */
    transcribe?: (args: TranscribeWithMetaArgs, attempt: number) => TranscribeWithMetaResult | Promise<TranscribeWithMetaResult>;
    now?: () => number;
}

function rig(script: Script = {}) {
    const calls = {
        download: [] as (string | null | undefined)[], downloadOptions: [] as { connectMs: number; totalMs: number }[],
        decode: [] as Uint8Array[], decodeOptions: [] as { timeoutMs: number }[], transcribe: [] as TranscribeWithMetaArgs[],
    };
    const deps: VoiceDeps = {
        download: async (link, options) => { calls.download.push(link); calls.downloadOptions.push(options); return script.download ? script.download(link, options) : downloaded(); },
        decode: async (bytes, options) => { calls.decode.push(bytes); calls.decodeOptions.push(options); return script.decode ? script.decode(bytes, options) : decoded(); },
        transcribe: async (args) => { calls.transcribe.push(args); return script.transcribe ? script.transcribe(args, calls.transcribe.length) : heard(); },
        ...(script.now ? { now: script.now } : {}),
    };
    return { deps, calls };
}

const hear = (script: Script = {}, input: Partial<VoiceInput> = {}) => {
    const r = rig(script);
    return transcribeVoice({ creatorId: CREATOR, link: LINK, ...input }, r.deps).then((result) => ({ result, calls: r.calls }));
};

/** Narrow a result to the one status the test is about. */
function only<S extends VoiceResult['status']>(result: VoiceResult, status: S): Extract<VoiceResult, { status: S }> {
    assert.equal(result.status, status, JSON.stringify(result));
    return result as Extract<VoiceResult, { status: S }>;
}

describe('wordCount', () => {
    it('counts the pieces of a transcript that have a letter or a digit in them, in any script', () => {
        assert.equal(wordCount('بكام الاشتراك'), 2);
        assert.equal(wordCount('how much is the plan'), 5);
        assert.equal(wordCount('الاشتراك plan 300'), 3);
        assert.equal(wordCount('٣٠٠ جنيه'), 2);
        assert.equal(wordCount('  spaced \n\t out  '), 2);
    });

    it('does not count what is not a word: nothing, silence, punctuation on its own', () => {
        for (const text of ['', '   ', '...', '؟ ؟', '- - -', '!!! ???', '\n']) assert.equal(wordCount(text), 0, JSON.stringify(text));
        assert.equal(wordCount('تمام ...'), 1);
        assert.equal(wordCount('تمام؟'), 1);
    });

    it('needs two to understand a note', () => {
        assert.equal(MIN_TRANSCRIPT_WORDS, 2);
    });
});

describe('transcribeVoice: a note that is heard', () => {
    it('is the transcript, how long Meta says the audio was, what it cost, the model, how many words, the session, and how long the whole step took', async () => {
        const { result } = await hear();
        assert.deepEqual({ ...result, ms: 0 }, {
            ok: true, status: 'ok', transcript: TRANSCRIPT, words: 6, durationMs: 3000, usd: 0.00015, model: 'muse-voice-transcribe-1.0', sessionId: 'sess-1', ms: 0,
        });
        assert.ok(result.ms >= 0);
    });

    it('hands each step what the one before made: the link to the download, the downloaded bytes to the decoder, the WAV and the keywords and the tenant to Meta', async () => {
        const wav = wavBytes({ seconds: 2 });
        const { calls } = await hear({
            download: () => downloaded({ bytes: Buffer.from('MP4-BYTES') }),
            decode: () => decoded({ wav, durationMs: 2000 }),
        }, { keywords: ['Data Academy', 'AutoReply'] });
        assert.deepEqual(calls.download, [LINK]);
        assert.equal(Buffer.from(calls.decode[0]!).toString(), 'MP4-BYTES');
        assert.equal(calls.transcribe.length, 1);
        assert.equal(calls.transcribe[0]!.creatorId, CREATOR);
        assert.ok(Buffer.from(calls.transcribe[0]!.wav).equals(wav));
        assert.deepEqual(calls.transcribe[0]!.keywords, ['Data Academy', 'AutoReply']);
    });

    it('sends no keywords key when the caller has none', async () => {
        const { calls } = await hear();
        assert.ok(!('keywords' in calls.transcribe[0]!));
    });

    it('cleans the transcript the way the stored line is cleaned: one line, no control or direction-changing character; and cuts it to what a 3-minute note holds', async () => {
        const messy = await hear({ transcribe: () => heard({ transcript: 'بكام\u202e الاشتراك\n\n ده\t؟\u0007' }) });
        assert.equal(only(messy.result, 'ok').transcript, 'بكام الاشتراك ده ؟');

        const long = await hear({ transcribe: () => heard({ transcript: 'كلمة '.repeat(2000) }) });
        const ok = only(long.result, 'ok');
        assert.ok([...ok.transcript].length <= TRANSCRIPT_MAX_CHARS);
        assert.match(ok.transcript, /…$/);
    });

    it('leaves out the session id when Meta did not give one', async () => {
        const { result } = await hear({ transcribe: () => heard({ sessionId: undefined }) });
        assert.ok(!('sessionId' in result));
    });
});

describe('transcribeVoice: no link, and the download', () => {
    it('is skipped (no_url) when the event had no link, and nothing else is asked: no decode, no model', async () => {
        for (const link of [null, undefined, '']) {
            const r = rig({ download: () => ({ ok: false, status: 'skipped', reason: 'no_url' }) });
            const result = await transcribeVoice({ creatorId: CREATOR, link }, r.deps);
            assert.deepEqual({ ...result, ms: 0 }, { ok: false, status: 'skipped', reason: 'no_url', usd: 0, model: '', ms: 0 });
            assert.equal(r.calls.decode.length + r.calls.transcribe.length, 0);
        }
    });

    it('by default makes no request at all for a missing link (the real fetchMedia answers no_url first), and none to a database', async () => {
        const result = await transcribeVoice({ creatorId: CREATOR, link: null });
        assert.equal(result.status, 'skipped');
        assert.equal(result.ok === false && result.reason, 'no_url');
    });

    it('is failed with the download\'s own reason and detail, and the decoder and the model are never reached', async () => {
        const cases: [Extract<MediaResult, { status: 'failed' }>['reason'], string | undefined][] = [
            ['too_large', 'audio'], ['fetch_failed', 'http_500'], ['fetch_failed', 'blocked_url'], ['expired_url', 'http_404'], ['timeout', undefined],
        ];
        for (const [reason, detail] of cases) {
            const { result, calls } = await hear({ download: () => ({ ok: false, status: 'failed', reason, ...(detail ? { detail } : {}) }) });
            const failed = only(result, 'failed');
            assert.equal(failed.reason, reason);
            assert.equal(failed.detail, detail);
            assert.equal(failed.model, '');
            assert.equal(failed.usd, 0);
            assert.equal(calls.decode.length + calls.transcribe.length, 0);
        }
    });

    it('is failed (fetch_failed / not_audio) when the link served something that is not audio: a picture, say', async () => {
        const { result, calls } = await hear({ download: () => downloaded({ mediaKind: 'image', mime: 'image/jpeg' }) });
        const failed = only(result, 'failed');
        assert.deepEqual([failed.reason, failed.detail], ['fetch_failed', 'not_audio']);
        assert.equal(calls.decode.length, 0);
    });
});

describe('transcribeVoice: the decode', () => {
    const decodeFails = (reason: TranscodeFailure, detail?: string) => (): TranscodeResult => ({ ok: false, reason, ...(detail ? { detail } : {}), ms: 3 });

    it('says what the decoder\'s refusal is in the reasons a record keeps, and never reaches the model: more than 3 minutes is too_large (detail too_long)', async () => {
        const table: [TranscodeFailure, string | undefined, string, string][] = [
            ['too_long', undefined, 'too_large', 'too_long'],
            ['too_large', undefined, 'too_large', 'audio'],
            ['timeout', 'decode', 'timeout', 'decode'],
            ['empty', undefined, 'decode_failed', 'empty'],
            ['decode_failed', 'exit_1: <tmp>/in.bin: Invalid data found when processing input', 'decode_failed', 'decode_failed: exit_1: <tmp>/in.bin: Invalid data found when processing input'],
            ['decode_failed', 'no_audio', 'decode_failed', 'decode_failed: no_audio'],
            ['decoder_unavailable', 'ENOENT', 'decode_failed', 'decoder_unavailable: ENOENT'],
            ['decoder_unavailable', 'no_binary', 'decode_failed', 'decoder_unavailable: no_binary'],
        ];
        for (const [reason, detail, expectedReason, expectedDetail] of table) {
            const { result, calls } = await hear({ decode: decodeFails(reason, detail) });
            const failed = only(result, 'failed');
            assert.deepEqual([failed.reason, failed.detail], [expectedReason, expectedDetail], `${reason} ${detail ?? ''}`);
            assert.equal(failed.model, '');
            assert.equal(calls.transcribe.length, 0, 'Meta is not asked about a note that could not be decoded');
        }
    });

    it('a decoder that is not there is the loudest line (an error): it means the deployment is wrong and every voice note will say so', async () => {
        await hear({ decode: decodeFails('decoder_unavailable', 'ENOENT') });
        const [line] = voiceLines();
        assert.equal(line!.level, 'error');
        assert.equal(line!.fields.event, 'perception.voice_failed');
        assert.match(String(line!.fields.detail), /^decoder_unavailable/);
        await hear({ decode: decodeFails('decode_failed', 'exit_1') });
        assert.equal(voiceLines().at(-1)!.level, 'warn', 'one bad file is only a warning');
    });
});

describe('transcribeVoice: Meta', () => {
    const refuses = (kind: AiErrorKind, status?: number) => (): never => { throw aiError(kind, status); };

    it('a budget reached and a missing or switched-off key are skipped, not failed: the call was never made', async () => {
        const budget = await hear({ transcribe: refuses('budget') });
        assert.deepEqual([budget.result.status, budget.result.ok === false && budget.result.reason], ['skipped', 'budget']);
        const noKey = await hear({ transcribe: refuses('no_provider') });
        assert.deepEqual([noKey.result.status, noKey.result.ok === false && noKey.result.reason], ['skipped', 'no_key']);
        assert.equal(noKey.result.usd, 0);
    });

    it('the deadline is a timeout (detail asr); a refusal or an answer that is no good is provider_error, with the kind and the HTTP status', async () => {
        assert.deepEqual(await outcome('timeout'), ['failed', 'timeout', 'asr']);
        assert.deepEqual(await outcome('auth', 401), ['failed', 'provider_error', 'auth_401']);
        assert.deepEqual(await outcome('auth', 403), ['failed', 'provider_error', 'auth_403']);
        assert.deepEqual(await outcome('rate', 429), ['failed', 'provider_error', 'rate_429']);
        assert.deepEqual(await outcome('quota', 402), ['failed', 'provider_error', 'quota_402']);
        assert.deepEqual(await outcome('bad_request', 400), ['failed', 'provider_error', 'bad_request_400']);
        assert.deepEqual(await outcome('bad_output', 200), ['failed', 'provider_error', 'bad_output_200']);
        assert.deepEqual(await outcome('server', 503), ['failed', 'provider_error', 'server_503']);

        async function outcome(kind: AiErrorKind, status?: number): Promise<[string, string | false, string | undefined]> {
            const { result } = await hear({ transcribe: refuses(kind, status) });
            return [result.status, result.ok === false && result.reason, result.status === 'failed' ? result.detail : undefined];
        }
    });

    it('says when Meta refused the key or the account has no credit left, so the caller can tell the owner; no other refusal says it', async () => {
        for (const [kind, status, expected] of [['auth', 401, 'auth'], ['auth', 403, 'auth'], ['quota', 402, 'quota']] as const) {
            const { result } = await hear({ transcribe: refuses(kind, status) });
            assert.equal(only(result, 'failed').errorKind, expected, `${kind} ${status}`);
        }
        for (const kind of ['rate', 'server', 'timeout', 'bad_request', 'bad_output'] as const) {
            const { result } = await hear({ transcribe: refuses(kind, 500) });
            assert.equal('errorKind' in only(result, 'failed'), false, kind);
        }
    });

    it('an error that is not an AiError (a database that fell over) is provider_error / unexpected, and is not thrown', async () => {
        const { result } = await hear({ transcribe: () => { throw new Error('connection terminated unexpectedly'); } });
        const failed = only(result, 'failed');
        assert.deepEqual([failed.reason, failed.detail], ['provider_error', 'unexpected']);
        assert.equal(failed.model, ASR_MODEL);
    });
});

describe('transcribeVoice: one retry for a passing failure, and only while the step has the time', () => {
    const throwing = (kind: AiErrorKind, status?: number) => (): never => { throw aiError(kind, status); };

    it('a 5xx is tried once more, and the second answer is the result', async () => {
        const { result, calls } = await hear({ transcribe: (_args, attempt) => { if (attempt === 1) throw aiError('server', 503); return heard(); } });
        assert.equal(result.status, 'ok');
        assert.equal(calls.transcribe.length, 2);
        assert.equal(logs.filter((l) => l.fields.event === 'perception.voice_retry').length, 1);
    });

    it('a timeout, and an answer that was no use, are tried once more as well: the kinds perceive retries', async () => {
        for (const kind of ['timeout', 'bad_output'] as const) {
            const { result, calls } = await hear({ transcribe: (_args, attempt) => { if (attempt === 1) throw aiError(kind); return heard(); } });
            assert.equal(result.status, 'ok', kind);
            assert.equal(calls.transcribe.length, 2, kind);
        }
    });

    it('the retry is the same call: the same WAV, the same keywords, the same tenant', async () => {
        const { calls } = await hear({ transcribe: (_args, attempt) => { if (attempt === 1) throw aiError('server', 500); return heard(); } }, { keywords: ['x'] });
        assert.deepEqual({ ...calls.transcribe[1], timeoutMs: 0 }, { ...calls.transcribe[0], timeoutMs: 0 });
    });

    it('is ONE retry: a second failure is the result, and a third call is never made', async () => {
        const { result, calls } = await hear({ transcribe: throwing('server', 503) });
        assert.equal(calls.transcribe.length, 2);
        assert.deepEqual([result.status, result.ok === false && result.reason, result.status === 'failed' && result.detail], ['failed', 'provider_error', 'server_503']);
    });

    it('a 429, a refused key, a bad request, no credit, a budget and a missing key are NEVER retried inside the turn', async () => {
        for (const [kind, status] of [['rate', 429], ['auth', 401], ['auth', 403], ['bad_request', 400], ['quota', 402], ['budget', undefined], ['no_provider', undefined]] as const) {
            const { calls } = await hear({ transcribe: throwing(kind, status) });
            assert.equal(calls.transcribe.length, 1, kind);
        }
    });

    it('the step is held to 90 s from the caller\'s deadline: it is the clock perceive and the download use, and the default is that long from now', async () => {
        assert.equal(STEP_BUDGET_MS, 90_000);
        assert.equal(MIN_CALL_MS, 8_000);
        const { calls } = await hear({ now: () => 5_000_000 });
        // No deadline given: 90 s from the start, so the first call's own deadline is its usual 30 s, and the download's and the decoder's are theirs.
        assert.deepEqual(calls.downloadOptions[0], { connectMs: CONNECT_TIMEOUT_MS, totalMs: TOTAL_TIMEOUT_MS });
        assert.deepEqual(calls.decodeOptions[0], { timeoutMs: TRANSCODE_TIMEOUT_MS });
        assert.equal(calls.transcribe[0]!.timeoutMs, ASR_TIMEOUT_MS);
    });

    it('cuts every part\'s deadline to what is left of the caller\'s: the download, the decoder and the model never outlast the step', async () => {
        let t = 1_000;
        const { calls } = await hear({
            now: () => t,
            download: () => { t += 40_000; return downloaded(); },
            decode: () => { t += 6_000; return decoded(); },
        }, { deadlineAt: 1_000 + 60_000 });
        // 60 s in all: the download may use 15 s to connect and 30 in all (both under the 60 left); the decoder then has 20 s left and gets 10; the model has 14 s left.
        assert.deepEqual(calls.downloadOptions[0], { connectMs: 15_000, totalMs: 30_000 });
        assert.deepEqual(calls.decodeOptions[0], { timeoutMs: 10_000 });
        assert.equal(calls.transcribe[0]!.timeoutMs, 14_000);

        t = 1_000;
        const tight = await hear({ now: () => t, download: () => { t += 1_000; return downloaded(); } }, { deadlineAt: 1_000 + 12_000 });
        assert.deepEqual(tight.calls.downloadOptions[0], { connectMs: 12_000, totalMs: 12_000 }, 'what is left is less than the usual, so it is what is left');
        assert.equal(tight.calls.decodeOptions[0]!.timeoutMs, 10_000);
        assert.equal(tight.calls.transcribe[0]!.timeoutMs, 11_000, 'and the model has what is left of that');
    });

    it('a retry is made while at least MIN_CALL_MS (8 s) is left, and its deadline is what is left: a first attempt that ended with 8 s to spare is retried, one with less is not', async () => {
        for (const [spentMs, retried] of [[10_000, true], [40_000, true], [82_000, true], [82_001, false], [89_000, false]] as const) {
            let t = 1_000_000;
            const { calls } = await hear({ now: () => t, transcribe: () => { t += spentMs; throw aiError('timeout'); } });
            assert.equal(calls.transcribe.length, retried ? 2 : 1, `${spentMs} ms spent`);
            if (retried) assert.equal(calls.transcribe[1]!.timeoutMs, Math.min(ASR_TIMEOUT_MS, STEP_BUDGET_MS - spentMs), `${spentMs} ms spent: the second call is cut to what is left`);
        }
    });

    it('keeps the first attempt\'s refusal when there is no time for a second: the provider\'s 5xx, not a timeout', async () => {
        let t = 1_000_000;
        const { result } = await hear({ now: () => t, transcribe: () => { t += 85_000; throw aiError('server', 503); } });
        const failed = only(result, 'failed');
        assert.deepEqual([failed.reason, failed.detail], ['provider_error', 'server_503']);
    });

    it('counts the download and the decode against the same clock: they ate the step, so the model is not asked and the step is a timeout', async () => {
        let t = 0;
        const slow = await hear({
            now: () => t,
            download: () => { t += 70_000; return downloaded(); },
            decode: () => { t += 15_000; return decoded(); },
        });
        const failed = only(slow.result, 'failed');
        assert.deepEqual([failed.reason, failed.detail], ['timeout', 'out_of_time']);
        assert.equal(slow.calls.transcribe.length, 0, '5 s are left: less than a call needs, so none is started that could not finish');
        assert.equal(logs.filter((l) => l.fields.event === 'perception.out_of_time').length, 1);

        t = 0;
        const quick = await hear({
            now: () => t,
            download: () => { t += 2_000; return downloaded(); },
            decode: () => { t += 500; return decoded(); },
            transcribe: (_a, attempt) => { t += 3_000; if (attempt === 1) throw aiError('server', 503); return heard(); },
        });
        assert.equal(quick.calls.transcribe.length, 2);
        assert.equal(quick.result.status, 'ok');
        assert.equal(quick.result.ms, 2_000 + 500 + 3_000 + 3_000, 'the step\'s time is all of it, the retry included');
    });

    it('a step that is already over starts nothing: no download, no decode, no model', async () => {
        const { result, calls } = await hear({ now: () => 10_000 }, { deadlineAt: 9_000 });
        assert.equal(only(result, 'failed').reason, 'timeout');
        assert.deepEqual([calls.download.length, calls.decode.length, calls.transcribe.length], [0, 0, 0]);
    });

    it('the decoder is not started when the step ran out in the download', async () => {
        let t = 0;
        const { result, calls } = await hear({ now: () => t, download: () => { t += 95_000; return downloaded(); } });
        const failed = only(result, 'failed');
        assert.deepEqual([failed.reason, failed.detail], ['timeout', 'decode']);
        assert.equal(calls.decode.length + calls.transcribe.length, 0);
    });
});

describe('transcribeVoice: whether it is words', () => {
    it('fewer than two words is unreadable (empty_transcript), and still carries what it cost and what it heard, for the record', async () => {
        for (const transcript of ['', '   ', '...', '؟', 'تمام', 'تمام؟ ...', 'ok']) {
            const { result } = await hear({ transcribe: () => heard({ transcript }) });
            const unreadable = only(result, 'unreadable');
            assert.equal(unreadable.ok, false);
            assert.equal(unreadable.reason, 'empty_transcript');
            assert.equal(unreadable.usd, 0.00015, 'Meta was paid for it');
            assert.equal(unreadable.model, ASR_MODEL);
            assert.equal(unreadable.durationMs, 3000);
            assert.ok(unreadable.words < 2);
            assert.equal(unreadable.transcript, transcript.trim());
        }
    });

    it('two words is enough', async () => {
        for (const transcript of ['بكام الاشتراك', 'price please', 'عايز ٣٠٠']) {
            const { result } = await hear({ transcribe: () => heard({ transcript }) });
            assert.equal(result.status, 'ok', transcript);
            assert.equal(only(result, 'ok').words, 2);
        }
    });
});

describe('voiceDraft: what is stored of a result', () => {
    const base = { usd: 0.00015, model: ASR_MODEL, ms: 4_100 };

    it('an ok note is its transcript and what it cost: no description, no owner, no confidence, and the database writes the time', () => {
        const draft = voiceDraft({ ok: true, status: 'ok', transcript: TRANSCRIPT, words: 6, durationMs: 3000, sessionId: 'sess-1', ...base });
        assert.deepEqual(draft, { v: 1, kind: 'audio', status: 'ok', transcript: TRANSCRIPT, model: ASR_MODEL, ms: 4_100, usd: 0.00015 });
        assert.ok(!('stored_at' in draft) && !('seen' in draft) && !('about_owner' in draft) && !('confidence' in draft), 'none of the fields a picture has');
    });

    it('an unreadable note keeps what little it heard, or nothing, and the reason; it is still paid for', () => {
        assert.deepEqual(voiceDraft({ ok: false, status: 'unreadable', reason: 'empty_transcript', transcript: 'تمام', words: 1, durationMs: 2000, ...base }),
            { v: 1, kind: 'audio', status: 'unreadable', reason: 'empty_transcript', transcript: 'تمام', model: ASR_MODEL, ms: 4_100, usd: 0.00015 });
        const silent = voiceDraft({ ok: false, status: 'unreadable', reason: 'empty_transcript', transcript: '', words: 0, durationMs: 2000, ...base });
        assert.ok(!('transcript' in silent));
    });

    it('a skip and a failure keep their reason and nothing of the log\'s detail', () => {
        assert.deepEqual(voiceDraft({ ok: false, status: 'skipped', reason: 'budget', usd: 0, model: '', ms: 12 }), { v: 1, kind: 'audio', status: 'skipped', reason: 'budget', model: '', ms: 12, usd: 0 });
        const failed = voiceDraft({ ok: false, status: 'failed', reason: 'decode_failed', detail: 'decoder_unavailable: ENOENT', errorKind: 'auth', usd: 0, model: '', ms: 30 });
        assert.deepEqual(failed, { v: 1, kind: 'audio', status: 'failed', reason: 'decode_failed', model: '', ms: 30, usd: 0 });
    });

    it('is JSON the store can write and read back unchanged', () => {
        const draft = voiceDraft({ ok: true, status: 'ok', transcript: TRANSCRIPT, words: 6, durationMs: 3000, ...base });
        assert.deepEqual(JSON.parse(JSON.stringify(draft)), draft);
    });
});

describe('transcribeVoice: it never throws', () => {
    it('a step that throws instead of answering with a result is a failed result, with the kind of the error and nothing of its message', async () => {
        const cases: Script[] = [
            { download: () => { throw new Error(`boom with ${LINK} and ${KEY}`); } },
            { decode: () => { throw new TypeError('decoder fell over'); } },
        ];
        for (const script of cases) {
            const { result } = await hear(script);
            const failed = only(result, 'failed');
            assert.equal(failed.reason, 'provider_error');
            assert.match(failed.detail ?? '', /^unexpected_(Error|TypeError)$/);
        }
        const all = logs.map((l) => l.line).join('\n');
        assert.ok(!all.includes(KEY) && !all.includes('SECRETSIG123'), 'what the error said is not logged');
    });
});

describe('transcribeVoice: what it logs', () => {
    it('is one line per call: the stage timings, sizes, the audio\'s length, the words, the dollars and the model; never the words, the link or a key', async () => {
        await hear({}, { keywords: ['Data Academy'] });
        const lines = voiceLines();
        assert.equal(lines.length, 1);
        const line = lines[0]!;
        assert.equal(line.level, 'info');
        assert.equal(line.fields.event, 'perception.voice_heard');
        assert.equal(line.fields.creator_id, CREATOR);
        assert.equal(line.fields.words, 6);
        assert.equal(line.fields.audio_ms, 3000);
        assert.equal(line.fields.usd, 0.00015);
        assert.equal(line.fields.model, ASR_MODEL);
        assert.equal(line.fields.session_id, 'sess-1');
        assert.equal(line.fields.host, 'lookaside.fbsbx.com');
        assert.equal(line.fields.bytes_in, 13);
        assert.equal(line.fields.wav_bytes, wavBytes({ seconds: 3 }).length);
        for (const field of ['ms', 'download_ms', 'decode_ms', 'asr_ms']) assert.ok(typeof line.fields[field] === 'number', field);

        const all = logs.map((l) => l.line).join('\n');
        assert.ok(!all.includes('الاشتراك'), 'the transcript is not logged');
        assert.ok(!all.includes(LINK) && !all.includes('SECRETSIG123') && !all.includes('asset_id'), 'the link is a signed URL and is never logged');
        assert.ok(!all.includes('Data Academy'), 'the keywords are names of the creator\'s, not for a log');
        assert.ok(!all.includes('[redacted]'), 'no field is named so the logger blanks it');
    });

    it('has one event for each way it ends: heard, unreadable, skipped, failed', async () => {
        await hear();
        await hear({ transcribe: () => heard({ transcript: '' }) });
        await hear({ download: () => ({ ok: false, status: 'skipped', reason: 'no_url' }) });
        await hear({ decode: () => ({ ok: false, reason: 'too_long', ms: 1 }) });
        assert.deepEqual(voiceLines().map((l) => [l.fields.event, l.level]), [
            ['perception.voice_heard', 'info'], ['perception.voice_unreadable', 'info'], ['perception.voice_skipped', 'info'], ['perception.voice_failed', 'warn'],
        ]);
        assert.equal(voiceLines()[1]!.fields.reason, 'empty_transcript');
        assert.equal(voiceLines()[2]!.fields.reason, 'no_url');
        assert.equal(voiceLines()[3]!.fields.reason, 'too_large');
        assert.equal(voiceLines()[3]!.fields.detail, 'too_long');
    });

    it('never says what was said, even when the note was unreadable', async () => {
        await hear({ transcribe: () => heard({ transcript: 'سر شخصي' }) });
        assert.ok(!logs.map((l) => l.line).join('\n').includes('سر شخصي'));
    });
});

describe('voice.ts: what it never does', () => {
    const source = readFileSync(new URL('./voice.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    it('writes nothing: no database, no table, no file', () => {
        assert.doesNotMatch(code, /\bpool\b|db\/query|\bINSERT\b|\bUPDATE\b|media_uploads|messages|writeFile|createWriteStream/i);
    });

    it('goes to Meta and to nobody else: no other speech provider is imported or named', () => {
        assert.doesNotMatch(code, /groq|whisper|openai|transcribeAudio|services\/transcribe/i);
        assert.match(code, /aiProviders\/asr\.js/);
    });

    it('prints nothing but through the logger', () => {
        assert.doesNotMatch(code, /console\./);
    });
});

// ─── The whole chain ─────────────────────────────────────────────────────────────────────────────────────────────────────

const run = promisify(execFile);
const binary: string | null = await ffmpegBinary();
const missing: string | false = binary !== null && existsSync(binary) && statSync(binary).isFile() ? false : 'the ffmpeg-static binary is not installed here';

describe('the whole chain: the real download, the real decoder, the real bookkeeping, against a stand-in for Meta', () => {
    let db: AiDb;
    let bin: string;
    let savedEnv: Record<string, string | undefined>;

    before(async () => {
        bin = await mkdtemp(path.join(tmpdir(), 'voice-test-'));
        savedEnv = { TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY, META_MODEL_API_KEY: process.env.META_MODEL_API_KEY };
        process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    });
    after(async () => {
        await rm(bin, { recursive: true, force: true });
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    beforeEach(() => {
        delete process.env.META_MODEL_API_KEY;
        db = installAiDb({ owner: OWNER });
        db.now = new Date(NOW);
        db.setSetting('ai.providers.meta.api_key', KEY, true);
    });
    afterEach(() => {
        db.restore();
    });

    /** An Instagram voice note as the bundled binary makes one: a second of tone, AAC in an MP4. */
    async function aacNote(): Promise<Buffer> {
        const file = path.join(bin, `note-${Math.random().toString(36).slice(2)}.mp4`);
        await run(binary!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-b:a', '48k', '-f', 'mp4', '-y', file]);
        return readFile(file);
    }

    interface Wire { downloads: { url: string; headers: Record<string, string> }[]; asr: { url: string; headers: Record<string, string>; body: Buffer }[] }

    /** Meta's CDN serving `note` (as video/mp4, which is what a voice note arrives as), and Meta's speech endpoint answering from `answers`. */
    function wire(note: Buffer, ...answers: Response[]): { deps: VoiceDeps; seen: Wire } {
        const seen: Wire = { downloads: [], asr: [] };
        const queue = [...answers];
        const deps: VoiceDeps = {
            download: (link) => fetchMedia(link, {
                kind: 'audio',
                fetchImpl: async (url, init) => {
                    seen.downloads.push({ url, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) });
                    return new Response(note, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(note.length) } });
                },
            }),
            transcribe: (args) => transcribeWithMeta({
                ...args, now: NOW,
                fetchImpl: async (url, init) => {
                    const body = init.body as Uint8Array;
                    seen.asr.push({
                        url, body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
                        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
                    });
                    const next = queue.shift();
                    if (!next) throw new Error('unexpected extra request to Meta');
                    return next;
                },
            }),
        };
        return { deps, seen };
    }

    const asrAnswer = (over: Record<string, unknown> = {}): Response => jsonResponse(200, { sessionId: 'sess-77', transcript: TRANSCRIPT, audioDurationMs: 1022, turns: [], ...over });

    it('hears a real AAC-in-MP4 note: downloaded with no credentials, decoded to a 24 kHz mono WAV, sent to Meta with the names, billed by the hour of audio', {
        skip: missing === false ? false : String(missing),
    }, async () => {
        const { deps, seen } = wire(await aacNote(), asrAnswer());
        const result = await transcribeVoice({ creatorId: CREATOR, link: LINK, keywords: ['Data Academy', 'AutoReply'] }, deps);

        const ok = only(result, 'ok');
        assert.equal(ok.transcript, TRANSCRIPT);
        assert.equal(ok.durationMs, 1022);
        assert.equal(ok.usd, asrUsd(1022));
        assert.equal(ok.model, 'muse-voice-transcribe-1.0');
        assert.equal(ok.sessionId, 'sess-77');

        // The download: Meta's CDN, and no credential of ours goes with it.
        assert.equal(seen.downloads.length, 1);
        assert.equal(seen.downloads[0]!.url, LINK);
        assert.ok(!('authorization' in seen.downloads[0]!.headers) && !('cookie' in seen.downloads[0]!.headers));

        // The request to Meta: the key as a Bearer header, the names, and a WAV of the note that the endpoint takes.
        assert.equal(seen.asr.length, 1);
        const sent = seen.asr[0]!;
        assert.equal(sent.url, 'https://api.meta.ai/v1/asr/transcribe');
        assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
        const [request, audio] = parseMultipart(sent.body, sent.headers['content-type']!);
        assert.deepEqual(JSON.parse(request!.data.toString('utf8')), {
            model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', languageBias: ['Arabic', 'English'], keywords: ['Data Academy', 'AutoReply'],
        });
        const wav = parseWav(audio!.data);
        assert.ok(wav.ok && isAsrWav(wav.info));
        assert.ok(wav.ok && wav.info.sampleRate === 24_000 && wav.info.durationMs >= 1000 && wav.info.durationMs <= 1100, JSON.stringify(wav));

        // The row, and nothing left reserved.
        assert.equal(db.usage.length, 1);
        assert.deepEqual(
            [db.usage[0]!.purpose, db.usage[0]!.provider, db.usage[0]!.model, db.usage[0]!.outcome, db.usage[0]!.usd, db.usage[0]!.creator_id],
            ['perception_voice', 'meta', 'muse-voice-transcribe-1.0', 'ok', asrUsd(1022), CREATOR],
        );

        // The log: one line, with the stage timings, and never the words, the link or the key.
        assert.equal(voiceLines().length, 1);
        const all = logs.map((l) => l.line).join('\n');
        assertNoKey(all, 'the log');
        assert.ok(!all.includes('الاشتراك') && !all.includes('SECRETSIG123'));
    });

    it('a 503 from Meta twice ends as provider_error: two attempts, each a row settled at nothing', async () => {
        const failing = jsonResponse(503, { error: { message: 'Transcription failed' } });
        const { deps } = wire(Buffer.from('mp4'), failing, jsonResponse(503, { error: { message: 'Transcription failed' } }));
        const result = await transcribeVoice({ creatorId: CREATOR, link: LINK }, { ...deps, decode: async () => decoded() });
        const failed = only(result, 'failed');
        assert.deepEqual([failed.reason, failed.detail], ['provider_error', 'server_503']);
        assert.deepEqual(db.usage.map((r) => [r.outcome, r.usd]), [['server', 0], ['server', 0]]);
    });

    it('a 503 and then an answer is heard: the first attempt is a row of its own, the second the one that is paid for', async () => {
        const { deps } = wire(Buffer.from('mp4'), jsonResponse(503, { error: { message: 'x' } }), asrAnswer());
        const result = await transcribeVoice({ creatorId: CREATOR, link: LINK }, { ...deps, decode: async () => decoded() });
        assert.equal(result.status, 'ok');
        assert.deepEqual(db.usage.map((r) => [r.outcome, r.usd]), [['server', 0], ['ok', asrUsd(1022)]]);
    });

    it('a platform budget already reached is skipped (budget): Meta is not asked and the refusal is a row', async () => {
        db.setSetting('ai.budget.daily_usd', '0');
        const { deps, seen } = wire(Buffer.from('mp4'), asrAnswer());
        const result = await transcribeVoice({ creatorId: CREATOR, link: LINK }, { ...deps, decode: async () => decoded() });
        assert.deepEqual([result.status, result.ok === false && result.reason], ['skipped', 'budget']);
        assert.equal(seen.asr.length, 0);
        assert.equal(db.usage.at(-1)!.outcome, 'budget');
    });

    it('no key for Meta is skipped (no_key): nothing is sent, and no other provider\'s key is looked for', async () => {
        db.settings.delete('ai.providers.meta.api_key');
        db.setSetting('ai.providers.groq.api_key', FAKE_KEYS.groq, true);
        const { deps, seen } = wire(Buffer.from('mp4'), asrAnswer());
        const result = await transcribeVoice({ creatorId: CREATOR, link: LINK }, { ...deps, decode: async () => decoded() });
        assert.deepEqual([result.status, result.ok === false && result.reason], ['skipped', 'no_key']);
        assert.equal(seen.asr.length, 0);
        assert.deepEqual([db.usage[0]!.provider, db.usage[0]!.outcome], ['none', 'no_provider']);
    });

    it('a note that is only a word is unreadable but paid for: the row says what Meta billed', async () => {
        const { deps } = wire(Buffer.from('mp4'), asrAnswer({ transcript: 'تمام', audioDurationMs: 2000 }));
        const result = await transcribeVoice({ creatorId: CREATOR, link: LINK }, { ...deps, decode: async () => decoded() });
        const unreadable = only(result, 'unreadable');
        assert.equal(unreadable.usd, asrUsd(2000));
        assert.equal(db.usage[0]!.usd, asrUsd(2000));
    });

    it('a link that is not Meta\'s is never fetched: failed (fetch_failed / blocked_url) before any request, and the decoder and the model are not reached', async () => {
        const { deps, seen } = wire(Buffer.from('mp4'), asrAnswer());
        const result = await transcribeVoice({ creatorId: CREATOR, link: 'https://evil.example/voice.m4a' }, { ...deps, decode: async () => { throw new Error('not reached'); } });
        const failed = only(result, 'failed');
        assert.deepEqual([failed.reason, failed.detail], ['fetch_failed', 'blocked_url']);
        assert.equal(seen.downloads.length + seen.asr.length, 0);
        assert.equal(db.statements.length, 0, 'no database either');
    });
});
