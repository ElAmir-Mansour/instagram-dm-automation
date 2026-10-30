/**
 * `transcribeWithMeta`: one voice note heard by Meta's speech model, with its key found, its cost reserved and recorded, and the platform's budgets in force
 * (docs/specs/005-muse-sees T048; the label is `perception_voice`, `purposes.ts`). It is to speech what `generate` is to a chat answer, and it sits beside it for
 * the same reason `aiProviders/` sits beside `llm/`: the client (`llm/metaAsr.ts`) is held clear of the database, and the key, the budget and the row are this
 * layer's.
 *
 *   1. **The WAV is checked** before anything is read or written: a file the endpoint will not take is the caller's fault and never different next time (`bad_request`).
 *   2. **The key.** `loadAiSettings`: the one saved in Settings → AI providers first, the `META_MODEL_API_KEY` environment variable as the fallback, exactly as every
 *      chat call finds it. No key, or Meta switched off, is `no_provider`, recorded as a refusal. **Never another provider**: a voice note is sent to Meta's speech
 *      model or to nobody (the privacy page says so).
 *   3. **Reserve.** The call's cost is known before it is made (the WAV's own length at $0.18 an hour), so that is what `reserveCall` holds against the platform's and the
 *      tenant's budgets under its lock; a budget already reached refuses the call (`BudgetRefused`, kind `budget`) and Meta is not asked.
 *   4. **Call**, once, with the 30 s deadline (`llm/metaAsr.ts`). No retry here: the caller owns the step's deadline.
 *   5. **Settle.** The reservation becomes the real row: provider `meta`, model `muse-voice-transcribe-1.0`, no tokens (speech is billed by the hour), `usd` =
 *      `audioDurationMs` / 3,600,000 x $0.18, the outcome, the latency. A call that failed settles at 0 (Meta does not bill a request that fails before it produces a
 *      transcript), except an answer that came back unusable (`bad_output`), which Meta did process and is charged at the estimate.
 *
 * It never logs a key, a transcript or the audio: a line carries the purpose, the model, the outcome, the audio's length, the dollars and the latency. A failure
 * never carries the audio. The same log events as `generate` (`ai.call`, `ai.call_failed`, `ai.call_refused`), so one search finds every model call.
 */
import { log } from '../../utils/log.js';
import { UUID_PATTERN } from '../studio/common.js';
import { AiError, isAiError } from '../llm/errors.js';
import { asrUsd, ASR_MODEL, ASR_PROVIDER, callMetaAsr, type AsrResult } from '../llm/metaAsr.js';
import type { FetchLike } from '../llm/types.js';
import { isAsrWav, parseWav } from '../llm/wav.js';
import { providerFetchImpl } from './generate.js';
import { PERCEPTION_VOICE } from './purposes.js';
import { loadAiSettings, providerProblem } from './settings.js';
import { recordCall, reserveCall, settleCall } from './usage.js';

export interface TranscribeWithMetaArgs {
    /** The tenant the call is charged to. */
    creatorId: string;
    /** RIFF/WAVE, mono, 16-bit PCM, 16 or 24 kHz. */
    wav: Uint8Array;
    /** Offer, course and brand names to bias recognition toward (`perception/keywords.ts`). */
    keywords?: readonly string[];
    /** One deadline for the call; `ASR_TIMEOUT_MS` when absent. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** For tests. Defaults to `setProviderFetch`'s, then the global `fetch`. */
    fetchImpl?: FetchLike;
    /** For tests: the instant the budgets are read at. */
    now?: Date;
}

export interface TranscribeWithMetaResult extends AsrResult {
    /** What the call cost: `audioDurationMs` / 3,600,000 x $0.18. */
    usd: number;
    /** The `ai_usage` row, so a caller can keep it with what it made. */
    usageId: string;
    /** From the request to the answer: not the settings read or the reservation. */
    elapsedMs: number;
}

const badRequest = (message: string): AiError => new AiError({ kind: 'bad_request', provider: ASR_PROVIDER, model: ASR_MODEL, message });

/** Transcribe one WAV with Meta. Throws an `AiError` for every way it can fail (see `callMetaAsr`, plus `no_provider` and `budget`); the file comment says what is recorded. */
export async function transcribeWithMeta(args: TranscribeWithMetaArgs): Promise<TranscribeWithMetaResult> {
    // What is wrong with the call itself, before a settings read or a row.
    if (typeof args.creatorId !== 'string' || !UUID_PATTERN.test(args.creatorId)) throw badRequest('creatorId must be a tenant id.');
    const wav = parseWav(args.wav);
    if (!wav.ok || !isAsrWav(wav.info)) throw badRequest('Meta\'s speech model takes a WAV file of mono 16-bit PCM audio at 16 or 24 kHz, and this is not one.');
    const audioMs = wav.info.durationMs;
    const logBase = { purpose: PERCEPTION_VOICE, creator_id: args.creatorId };

    const { config, keys } = await loadAiSettings();
    const problem = providerProblem(ASR_PROVIDER, config, keys);
    const apiKey = keys.get(ASR_PROVIDER);
    if (problem || !apiKey) {
        await recordCall({ creatorId: args.creatorId, purpose: PERCEPTION_VOICE, provider: 'none', model: '', outcome: 'no_provider', tokensIn: 0, tokensOut: 0, usd: 0, priced: true, elapsedMs: 0 });
        log('warn', 'ai.call_refused', { ...logBase, outcome: 'no_provider' });
        throw new AiError({
            kind: 'no_provider', provider: ASR_PROVIDER, model: ASR_MODEL,
            message: `Meta (Muse) ${problem ?? 'has no API key saved'}, so a voice note cannot be transcribed: save its key in Operations → AI providers.`,
        });
    }

    const estimate = asrUsd(audioMs);
    let reservation;
    try {
        reservation = await reserveCall({
            creatorId: args.creatorId, purpose: PERCEPTION_VOICE, provider: ASR_PROVIDER, model: ASR_MODEL, estimateUsd: estimate, priced: true, budgets: config.budgets,
            ...(args.now ? { now: args.now } : {}),
        });
    } catch (err) {
        if (isAiError(err)) log('warn', 'ai.call_refused', { ...logBase, provider: ASR_PROVIDER, model: ASR_MODEL, outcome: err.kind });
        throw err;
    }

    const started = Date.now();
    try {
        const out = await callMetaAsr({
            apiKey, wav: args.wav, keywords: args.keywords, timeoutMs: args.timeoutMs, signal: args.signal, fetchImpl: args.fetchImpl ?? providerFetchImpl(),
        });
        const usd = asrUsd(out.durationMs);
        const elapsedMs = Date.now() - started;
        await settleCall(reservation, { outcome: 'ok', provider: ASR_PROVIDER, model: out.model, tokensIn: 0, tokensOut: 0, usd, priced: true, elapsedMs });
        log('info', 'ai.call', { ...logBase, provider: ASR_PROVIDER, model: out.model, outcome: 'ok', elapsed_ms: elapsedMs, audio_ms: out.durationMs, usd, priced: true, session_id: out.sessionId });
        return { ...out, usd, usageId: reservation.id, elapsedMs };
    } catch (err) {
        const outcome = isAiError(err) ? err.kind : 'bad_request';
        // A request that failed before a transcript was made is not billed; an answer that came back unusable was processed.
        const usd = outcome === 'bad_output' ? estimate : 0;
        const elapsedMs = Date.now() - started;
        await settleCall(reservation, { outcome, provider: ASR_PROVIDER, model: ASR_MODEL, tokensIn: 0, tokensOut: 0, usd, priced: true, elapsedMs });
        log('warn', 'ai.call_failed', { ...logBase, provider: ASR_PROVIDER, model: ASR_MODEL, outcome, elapsed_ms: elapsedMs, audio_ms: audioMs, usd });
        throw err;
    }
}
