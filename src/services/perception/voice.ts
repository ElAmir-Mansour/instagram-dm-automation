/**
 * A voice note, heard (docs/specs/005-muse-sees T047 to T050, contracts/perception.md §2): the link Meta's event holds in, the words in it out.
 *
 *   transcribeVoice({ creatorId, link, keywords })    download -> decode -> Meta's speech model, as ONE result: `{ transcript, durationMs, usd, model, ... }` or why not.
 *
 * It is the MEDIA half of the voice branch of `answerDm`. The branch itself decides whether to try at all (the gate: `voice` switch, allow-list, daily cap, a Meta key),
 * sends "typing…", stores `messages.perception` and `messages.text` (the BARE transcript, so history, the inbox and the sales turn all read the customer's own words), and
 * answers; none of that is here. Nothing here reads or writes a message, sends anything to the customer, or checks a switch.
 *
 * ─── The steps, each one's limit, and what a failure is called ───
 *   1. **Download** (`media.ts` `fetchMedia`, kind `audio`): Meta's hosts only, HTTPS, no token, at most 10 MB, 15 s to connect and 30 s in all, never written anywhere. A voice note
 *      arrives as `video/mp4` (AAC inside an MP4) and stays audio.   No link: `skipped / no_url`.   The rest as `fetchMedia` names them: `too_large`, `fetch_failed`, `expired_url`, `timeout`.
 *   2. **Decode** (`transcode.ts`): `ffmpeg-static` inside the function, to mono 16-bit 24 kHz WAV with the tags removed, 10 s. More than 3 minutes is `failed / too_large` (detail
 *      `too_long`); a file that will not decode is `failed / decode_failed` (detail `decode_failed: …`); the binary missing is `failed / decode_failed` too (detail
 *      `decoder_unavailable: …`) and is logged as an ERROR, because it means the deployment is wrong and every voice note will say so.
 *   3. **Hear** (`aiProviders/asr.ts`): Meta's `muse-voice-transcribe-1.0`, with Arabic and English as the language bias and the creator's names as keywords, 30 s, one row in
 *      `ai_usage` (purpose `perception_voice`, $0.18 an hour). **Never another provider.** No Meta key, or Meta switched off: `skipped / no_key`; a platform or tenant budget reached:
 *      `skipped / budget`; the deadline: `failed / timeout`; any other refusal or answer that is no good: `failed / provider_error` (detail: the kind and the HTTP status).
 *   4. **Words.** Fewer than two: `unreadable / empty_transcript` (silence, noise, a single word: the kit's resend line is the answer, as for media it could not read).
 *
 * **The clock is one, and the caller's** (`deadlineAt`, as `perceive` and `resolveSource` take it): the whole step is over at 90 s from the gate's pass, and every part's own deadline is
 * cut to what is left (the download's 15 s and 30 s, the decoder's 10 s, the model's 30 s). **One retry**, for a `server` (5xx), `timeout` or `bad_output` failure of step 3 only
 * (`contracts/perception.md`: "one retry for reads", the same kinds `perceive` retries), and only while at least `MIN_CALL_MS` is left, with that much of a deadline at most. A
 * 429, an auth failure, a bad request, a budget and a missing key are never retried inside the turn. Nothing is started that could not finish: with less than `MIN_CALL_MS` left
 * before the first call, the step is `failed / timeout` and the model is not asked.
 *
 * ─── What it never does ───
 * Never throws: every outcome is a result, because the caller's answer to each failure is the same fixed line and must not depend on a catch. Never logs the transcript, the audio,
 * the link or a key: the one line per call carries the stage timings, sizes, the audio's length, the number of words, the dollars and the model. Never stores a file: the bytes
 * live in this call.
 */
import { log } from '../../utils/log.js';
import { transcribeWithMeta, type TranscribeWithMetaArgs, type TranscribeWithMetaResult } from '../aiProviders/asr.js';
import { isAiError } from '../llm/errors.js';
import { ASR_MODEL, ASR_TIMEOUT_MS } from '../llm/metaAsr.js';
import { CONNECT_TIMEOUT_MS, fetchMedia, TOTAL_TIMEOUT_MS, type MediaResult } from './media.js';
import { MIN_CALL_MS, STEP_BUDGET_MS } from './perceive.js';
import { oneLine, TRANSCRIPT_MAX_CHARS } from './text.js';
import { TRANSCODE_TIMEOUT_MS, transcodeToWav, type TranscodeFailure, type TranscodeResult } from './transcode.js';
import type { FailReason, Perception, SkipReason } from './types.js';

/** A transcript with fewer words than this is not understood (`contracts/perception.md` §2). */
export const MIN_TRANSCRIPT_WORDS = 2;

/** How many words a transcript has: whitespace-separated pieces with a letter or a digit in them, in any script. Punctuation on its own is not a word. */
export function wordCount(text: string): number {
    return text.split(/\s+/).filter((piece) => /[\p{L}\p{N}]/u.test(piece)).length;
}

export interface VoiceInput {
    /** The tenant the call is charged to. */
    creatorId: string;
    /** The voice note's link as Meta sent it (`MediaRef.url`). Null or empty: `skipped / no_url`. */
    link: string | null | undefined;
    /** The names to bias recognition toward (`keywords.ts` `voiceKeywords`). */
    keywords?: readonly string[];
    /** When the whole step must be over, in epoch milliseconds (`perceiveDm` starts the clock when the gate passes). Absent: `STEP_BUDGET_MS` from now. */
    deadlineAt?: number;
}

/** What every result carries, for the record the caller stores: the cost, the model that heard it ('' when none did) and the time the whole step took. */
interface VoiceBase {
    usd: number;
    model: string;
    ms: number;
}

/** The reasons a voice note is skipped: nothing to download, and the two ways the model call is refused before it is made. */
export type VoiceSkip = Extract<SkipReason, 'no_url' | 'no_key' | 'budget'>;

export type VoiceResult =
    | ({ ok: true; status: 'ok'; transcript: string; words: number; /** What Meta says it processed. */ durationMs: number; sessionId?: string } & VoiceBase)
    | ({ ok: false; status: 'unreadable'; reason: 'empty_transcript'; /** What there was: nothing, or a single word. */ transcript: string; words: number; durationMs: number } & VoiceBase)
    | ({ ok: false; status: 'skipped'; reason: VoiceSkip } & VoiceBase)
    | ({
        ok: false; status: 'failed'; reason: FailReason; /** For the log, never the customer: which step and why. */ detail?: string;
        /** Meta refused the key (`auth`) or the account has no credit left (`quota`): the caller tells the owner, once a day, as for a picture. */
        errorKind?: 'auth' | 'quota';
    } & VoiceBase);

/** The steps, replaceable one by one so a test can reach each outcome without a network, a binary or a database. */
export interface VoiceDeps {
    download?: (link: string | null | undefined, options: { connectMs: number; totalMs: number }) => Promise<MediaResult>;
    decode?: (bytes: Uint8Array, options: { timeoutMs: number }) => Promise<TranscodeResult>;
    transcribe?: (args: TranscribeWithMetaArgs) => Promise<TranscribeWithMetaResult>;
    now?: () => number;
}

/**
 * A refusal from the decoder as the reason the record keeps. Too big or too long is `too_large`, the kill after 10 s is `timeout`, and everything else the decoder can
 * say (not audio, no sound, no bytes, no binary) is one thing to the record, `decode_failed`: the audio did not become a WAV. The log's `detail` says which.
 */
function decodeFailure(reason: TranscodeFailure, detail: string | undefined): { reason: FailReason; detail: string } {
    switch (reason) {
        case 'too_long': return { reason: 'too_large', detail: 'too_long' };
        case 'too_large': return { reason: 'too_large', detail: 'audio' };
        case 'timeout': return { reason: 'timeout', detail: 'decode' };
        default: return { reason: 'decode_failed', detail: `${reason}${detail ? `: ${detail}` : ''}` };
    }
}

/** Meta's refusal as the result it is: a budget and a missing key are skips (the call was never made), the deadline is a timeout, the rest is the provider's. */
function hearFailure(err: unknown): { status: 'skipped'; reason: 'budget' | 'no_key' } | { status: 'failed'; reason: FailReason; detail: string; errorKind?: 'auth' | 'quota' } {
    if (isAiError(err)) {
        if (err.kind === 'budget') return { status: 'skipped', reason: 'budget' };
        if (err.kind === 'no_provider') return { status: 'skipped', reason: 'no_key' };
        if (err.kind === 'timeout') return { status: 'failed', reason: 'timeout', detail: 'asr' };
        return {
            status: 'failed', reason: 'provider_error', detail: `${err.kind}${err.status !== undefined ? `_${err.status}` : ''}`,
            ...(err.kind === 'auth' || err.kind === 'quota' ? { errorKind: err.kind } : {}),
        };
    }
    return { status: 'failed', reason: 'provider_error', detail: 'unexpected' };
}

/** Whether a failed attempt to hear is worth one more: what `perceive` retries, the provider's passing trouble (a 5xx, a timeout, an answer that is no use). */
const worthRetrying = (err: unknown): boolean => isAiError(err) && (err.kind === 'server' || err.kind === 'timeout' || err.kind === 'bad_output');

/** The record a result is stored as: `messages.perception` without the `stored_at` the database writes. */
export type VoiceDraft = Omit<Perception, 'stored_at'>;

/**
 * What `perceiveDm` keeps of a result, once. A voice note's `ok` record is its transcript and what it cost: no description, no owner and no confidence (the speech model
 * gives none, and a voice note is the customer's own voice, not content that is anyone's). Written with the bare transcript as the row's `text` in the same statement
 * (`perceivedText`); an `unreadable` one keeps the little it heard (nothing, or one word) and leaves the row's text as the placeholder. A failure keeps its reason: the `detail` is
 * for the log. Pure.
 */
export function voiceDraft(r: VoiceResult): VoiceDraft {
    const base = { v: 1 as const, kind: 'audio' as const, model: r.model, ms: r.ms, usd: r.usd };
    switch (r.status) {
        case 'ok': return { ...base, status: 'ok', transcript: r.transcript };
        case 'unreadable': return { ...base, status: 'unreadable', reason: r.reason, ...(r.transcript ? { transcript: r.transcript } : {}) };
        case 'skipped': return { ...base, status: 'skipped', reason: r.reason };
        case 'failed': return { ...base, status: 'failed', reason: r.reason };
    }
}

/**
 * Hear one voice note. Never throws; see the file comment for the steps, the limits and what each failure is called.
 */
export async function transcribeVoice(input: VoiceInput, deps: VoiceDeps = {}): Promise<VoiceResult> {
    const now = deps.now ?? Date.now;
    const download = deps.download ?? ((link, options) => fetchMedia(link, { kind: 'audio', ...options }));
    const decode = deps.decode ?? ((bytes, options) => transcodeToWav(bytes, options));
    const transcribe = deps.transcribe ?? transcribeWithMeta;
    const startedAt = now();
    const elapsed = (): number => now() - startedAt;
    // The one clock: what is left of the step, which every part's own deadline is cut to.
    const deadlineAt = input.deadlineAt ?? startedAt + STEP_BUDGET_MS;
    const left = (): number => deadlineAt - now();

    // What the one log line says, filled in as the steps finish.
    const facts: Record<string, string | number | undefined> = {};
    const finish = (result: VoiceResult): VoiceResult => {
        const level = result.status === 'failed' ? (result.detail?.startsWith('decoder_unavailable') ? 'error' : 'warn') : 'info';
        log(level, `perception.voice_${result.ok ? 'heard' : result.status}`, {
            creator_id: input.creatorId,
            ...(result.ok ? {} : { reason: result.reason }),
            ...(result.status === 'failed' && result.detail ? { detail: result.detail } : {}),
            ...(result.status === 'ok' || result.status === 'unreadable' ? { words: result.words, audio_ms: result.durationMs } : {}),
            ms: result.ms, usd: result.usd, model: result.model, ...facts,
        });
        return result;
    };
    const skipped = (reason: VoiceSkip): VoiceResult => finish({ ok: false, status: 'skipped', reason, usd: 0, model: '', ms: elapsed() });
    const failed = (reason: FailReason, detail: string | undefined, model = '', errorKind?: 'auth' | 'quota'): VoiceResult =>
        finish({ ok: false, status: 'failed', reason, ...(detail ? { detail } : {}), ...(errorKind ? { errorKind } : {}), usd: 0, model, ms: elapsed() });

    try {
        // 1. The bytes, within what is left of the step (a step that is already over starts nothing).
        const downloadStart = now();
        const room = left();
        const media: MediaResult = room <= 0
            ? { ok: false, status: 'failed', reason: 'timeout' }
            : await download(input.link, { connectMs: Math.min(CONNECT_TIMEOUT_MS, room), totalMs: Math.min(TOTAL_TIMEOUT_MS, room) });
        facts['download_ms'] = now() - downloadStart;
        if (!media.ok) return media.status === 'skipped' ? skipped(media.reason) : failed(media.reason, media.detail);
        facts['host'] = media.media.host;
        facts['bytes_in'] = media.media.bytes.length;
        if (media.media.mediaKind !== 'audio') return failed('fetch_failed', 'not_audio');

        // 2. The WAV, killed at 10 s or at what is left of the step, whichever is sooner.
        const decodeStart = now();
        const decodeRoom = left();
        if (decodeRoom <= 0) return failed('timeout', 'decode');
        const decoded = await decode(media.media.bytes, { timeoutMs: Math.max(1, Math.floor(Math.min(TRANSCODE_TIMEOUT_MS, decodeRoom))) });
        facts['decode_ms'] = now() - decodeStart;
        if (!decoded.ok) {
            const f = decodeFailure(decoded.reason, decoded.detail);
            return failed(f.reason, f.detail);
        }
        facts['wav_bytes'] = decoded.wav.length;

        // 3. The words, once, and once more for a passing failure while at least `MIN_CALL_MS` is left. Each call's deadline is cut to what is left.
        const hearStart = now();
        let heard: TranscribeWithMetaResult | undefined;
        let refusal: unknown;
        let outOfTime = false;
        for (let attempt = 1; ; attempt++) {
            const room = left();
            if (room < MIN_CALL_MS) {
                // Nothing is left to try with. The first attempt gets here only when the download and the decode ate the step; a second, only when the first used it up
                // (and then the first one's refusal is what it was, not a timeout).
                log('warn', 'perception.out_of_time', { creator_id: input.creatorId, kind: 'audio', attempt });
                outOfTime = attempt === 1;
                break;
            }
            try {
                heard = await transcribe({
                    creatorId: input.creatorId, wav: decoded.wav, ...(input.keywords ? { keywords: input.keywords } : {}),
                    timeoutMs: Math.max(1, Math.floor(Math.min(ASR_TIMEOUT_MS, room))),
                });
                break;
            } catch (err) {
                refusal = err;
                if (attempt >= 2 || !worthRetrying(err)) break;
                log('info', 'perception.voice_retry', { creator_id: input.creatorId, kind: isAiError(err) ? err.kind : 'error', elapsed_ms: elapsed() });
            }
        }
        facts['asr_ms'] = now() - hearStart;
        if (!heard) {
            if (outOfTime) return failed('timeout', 'out_of_time');
            const f = hearFailure(refusal);
            return f.status === 'skipped' ? skipped(f.reason) : failed(f.reason, f.detail, ASR_MODEL, f.errorKind);
        }
        if (heard.sessionId) facts['session_id'] = heard.sessionId;

        // 4. Whether it is words. The text is cleaned the way the stored line is (`perceivedText`): one line, no control or direction-changing characters, cut to what a 3-minute note holds.
        const transcript = oneLine(heard.transcript, TRANSCRIPT_MAX_CHARS);
        const words = wordCount(transcript);
        const base = { usd: heard.usd, model: heard.model, ms: elapsed() };
        if (words < MIN_TRANSCRIPT_WORDS) {
            return finish({ ok: false, status: 'unreadable', reason: 'empty_transcript', transcript, words, durationMs: heard.durationMs, ...base });
        }
        return finish({ ok: true, status: 'ok', transcript, words, durationMs: heard.durationMs, ...(heard.sessionId ? { sessionId: heard.sessionId } : {}), ...base });
    } catch (err) {
        // A step that threw instead of answering with a result: the contract of this function is that nothing does.
        return failed('provider_error', `unexpected_${isAiError(err) ? err.kind : String((err as { name?: unknown } | null)?.name ?? 'error').slice(0, 40)}`);
    }
}
