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
 * **One retry**, for a `server` (5xx) or `timeout` failure of step 3 only (`contracts/perception.md`: "one retry for reads"), and only while the step still has the time: the whole
 * step is held to 90 s, so a second 30 s attempt is made only if the first ended with 30 s to spare. A 429, an auth failure and a bad request are never retried inside the turn.
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
import { fetchMedia, type MediaResult } from './media.js';
import { oneLine, TRANSCRIPT_MAX_CHARS } from './text.js';
import { transcodeToWav, type TranscodeFailure, type TranscodeResult } from './transcode.js';
import type { FailReason, SkipReason } from './types.js';

/** A transcript with fewer words than this is not understood (`contracts/perception.md` §2). */
export const MIN_TRANSCRIPT_WORDS = 2;

/** The whole step's budget (`contracts/perception.md`, "Errors -> behaviour"): the download, the decode and the call, with a retry only if it fits. */
export const VOICE_STEP_BUDGET_MS = 90_000;

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
    | ({ ok: false; status: 'failed'; reason: FailReason; /** For the log, never the customer: which step and why. */ detail?: string } & VoiceBase);

/** The steps, replaceable one by one so a test can reach each outcome without a network, a binary or a database. */
export interface VoiceDeps {
    download?: (link: string | null | undefined) => Promise<MediaResult>;
    decode?: (bytes: Uint8Array) => Promise<TranscodeResult>;
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
function hearFailure(err: unknown): { status: 'skipped'; reason: 'budget' | 'no_key' } | { status: 'failed'; reason: FailReason; detail: string } {
    if (isAiError(err)) {
        if (err.kind === 'budget') return { status: 'skipped', reason: 'budget' };
        if (err.kind === 'no_provider') return { status: 'skipped', reason: 'no_key' };
        if (err.kind === 'timeout') return { status: 'failed', reason: 'timeout', detail: 'asr' };
        return { status: 'failed', reason: 'provider_error', detail: `${err.kind}${err.status !== undefined ? `_${err.status}` : ''}` };
    }
    return { status: 'failed', reason: 'provider_error', detail: 'unexpected' };
}

/** Whether a failed attempt to hear is worth one more: a 5xx or a timeout, which are the provider's passing trouble. */
const worthRetrying = (err: unknown): boolean => isAiError(err) && (err.kind === 'server' || err.kind === 'timeout');

/**
 * Hear one voice note. Never throws; see the file comment for the steps, the limits and what each failure is called.
 */
export async function transcribeVoice(input: VoiceInput, deps: VoiceDeps = {}): Promise<VoiceResult> {
    const now = deps.now ?? Date.now;
    const download = deps.download ?? ((link) => fetchMedia(link, { kind: 'audio' }));
    const decode = deps.decode ?? ((bytes) => transcodeToWav(bytes));
    const transcribe = deps.transcribe ?? transcribeWithMeta;
    const startedAt = now();
    const elapsed = (): number => now() - startedAt;

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
    const failed = (reason: FailReason, detail: string | undefined, model = ''): VoiceResult =>
        finish({ ok: false, status: 'failed', reason, ...(detail ? { detail } : {}), usd: 0, model, ms: elapsed() });

    try {
        // 1. The bytes.
        const downloadStart = now();
        const media = await download(input.link);
        facts['download_ms'] = now() - downloadStart;
        if (!media.ok) return media.status === 'skipped' ? skipped(media.reason) : failed(media.reason, media.detail);
        facts['host'] = media.media.host;
        facts['bytes_in'] = media.media.bytes.length;
        if (media.media.mediaKind !== 'audio') return failed('fetch_failed', 'not_audio');

        // 2. The WAV.
        const decodeStart = now();
        const decoded = await decode(media.media.bytes);
        facts['decode_ms'] = now() - decodeStart;
        if (!decoded.ok) {
            const f = decodeFailure(decoded.reason, decoded.detail);
            return failed(f.reason, f.detail);
        }
        facts['wav_bytes'] = decoded.wav.length;

        // 3. The words, once, and once more for a passing failure if the step has the time.
        const hearStart = now();
        let heard: TranscribeWithMetaResult | undefined;
        let refusal: unknown;
        for (let attempt = 1; ; attempt++) {
            try {
                heard = await transcribe({ creatorId: input.creatorId, wav: decoded.wav, ...(input.keywords ? { keywords: input.keywords } : {}) });
                break;
            } catch (err) {
                refusal = err;
                if (attempt >= 2 || !worthRetrying(err) || elapsed() + ASR_TIMEOUT_MS > VOICE_STEP_BUDGET_MS) break;
                log('info', 'perception.voice_retry', { creator_id: input.creatorId, kind: isAiError(err) ? err.kind : 'error', elapsed_ms: elapsed() });
            }
        }
        facts['asr_ms'] = now() - hearStart;
        if (!heard) {
            const f = hearFailure(refusal);
            return f.status === 'skipped' ? skipped(f.reason) : failed(f.reason, f.detail, ASR_MODEL);
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
