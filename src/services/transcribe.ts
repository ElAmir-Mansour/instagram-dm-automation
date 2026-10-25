/**
 * A voice note, as text (docs/specs/001-whatsapp-agent T035, research R6, FR-009 / FR-028 / FR-034).
 *
 * Arabic voice notes are the norm for this audience, so the WhatsApp agent turns one into the message text before the turn runs. This
 * file is that step and nothing else: audio (an upload the customer sent, or bytes) in, text or a typed reason out. Wiring it in front
 * of the turn, and storing the transcript as the inbound `text`, is the integration step's.
 *
 * ── The provider rule ──
 *
 * A customer's voice is personal data, and Meta's terms for the WhatsApp Business Platform (§4.7) forbid sending it to anyone who may
 * train on it. So only `groq` and `openai`, whose API terms do not train on inputs or outputs, may serve `transcribe`
 * (`TRANSCRIBE_PROVIDERS`), tried in that order with whichever has a usable key. Anything else (Gemini, OpenRouter, a custom endpoint, or no
 * key at all) answers `provider_unavailable`: never a silent fall-through to a provider that may train. Groq's free tier is the default.
 * OpenAI is paid, so it serves only when the caller says the owner allows paid AI (`allowPaid`, the `whatsapp.allow_paid_ai` setting's
 * value, default false: T033's free-only rule).
 *
 * `transcribe` is a usage label (`purposes.ts: TRANSCRIBE`), not one of the chat routes in `ai.routing`: its model is a speech model, and
 * the provider's CHAT default (`defaultModelOf`) is never used here. The key is the provider's ordinary one (`ai.providers.groq.api_key`).
 *
 * ── What it never does ──
 *
 * Never throws: a failure is a value, because the caller's answer to every one of them is the same: ask the customer to type (FR-009).
 * Never logs the transcript, the audio, a key or a URL: a log line carries the provider, the model, sizes, timings and the reason.
 * Reads a private upload only through the tenant-scoped read (`privateFor`), so a voice note of one tenant cannot be transcribed under
 * another's id.
 */
import { performance } from 'node:perf_hooks';
import { aiErrorLogFields, isAiError, type AiError } from './llm/errors.js';
import { TRANSCRIBE } from './aiProviders/purposes.js';
import { transcribeWithProvider, TRANSCRIPTION_TIMEOUT_MS } from './llm/transcription.js';
import type { FetchLike } from './llm/types.js';
import type { ProviderId } from './llm/registry.js';
import { loadAiSettings, providerProblem } from './aiProviders/settings.js';
import { getMediaStore } from './storage.js';
import { log } from '../utils/log.js';

/** The providers whose terms forbid training on what they are sent, in the order they are tried. Everything else is refused. */
export const TRANSCRIBE_PROVIDERS = ['groq', 'openai'] as const satisfies readonly ProviderId[];
export type TranscribeProvider = (typeof TRANSCRIBE_PROVIDERS)[number];

export const isTranscribeProvider = (value: unknown): value is TranscribeProvider =>
    typeof value === 'string' && (TRANSCRIBE_PROVIDERS as readonly string[]).includes(value);

/** Providers that bill per use. They serve only when the owner allowed paid AI. */
const PAID_TRANSCRIBE_PROVIDERS: ReadonlySet<TranscribeProvider> = new Set<TranscribeProvider>(['openai']);

/**
 * The model a provider transcribes with when the route names none. Groq's is the one this phase is built and tested on (multilingual,
 * ~$0.04/hour, https://console.groq.com/docs/speech-to-text). OpenAI's is the endpoint's long-standing speech model; the route can
 * name another, and it was not exercised against OpenAI this phase.
 */
export const TRANSCRIBE_DEFAULT_MODEL: Readonly<Record<TranscribeProvider, string>> = {
    groq: 'whisper-large-v3-turbo',
    openai: 'whisper-1',
};

/**
 * Larger than a voice note will ever be, smaller than Groq's 25 MB free-tier file limit. Matches the 16 MB this phase stores
 * (`MAX_INBOUND_MEDIA_BYTES` in whatsappMedia.ts), so a stored note is never refused for size here.
 */
export const MAX_TRANSCRIBE_BYTES = 16 * 1024 * 1024;

/**
 * What the audio may be: the formats Groq lists (flac, mp3, mp4/m4a, mpeg, ogg, wav, webm) by their MIME types, with the file name the
 * provider reads the format from. WhatsApp sends `audio/ogg` (a voice note: Opus), `audio/mpeg`, `audio/mp4`, `audio/aac` and
 * `audio/amr`; the last two are not on the list, so they are refused here, without a call, rather than failing at the provider.
 */
const AUDIO_FILES: Readonly<Record<string, string>> = {
    'audio/ogg': 'voice.ogg',
    'audio/opus': 'voice.ogg',
    'audio/mpeg': 'voice.mp3',
    'audio/mp3': 'voice.mp3',
    'audio/mp4': 'voice.m4a',
    'audio/m4a': 'voice.m4a',
    'audio/x-m4a': 'voice.m4a',
    'audio/wav': 'voice.wav',
    'audio/x-wav': 'voice.wav',
    'audio/webm': 'voice.webm',
    'audio/flac': 'voice.flac',
};

/** `audio/ogg; codecs=opus` becomes `audio/ogg`. */
export function baseMime(mime: string): string {
    return String(mime ?? '').split(';')[0]!.trim().toLowerCase();
}

export type TranscribeFailure =
    /** No allow-listed provider can answer: none has a key, the route names one that may train, or only a paid one is left and paid AI is off. */
    | 'provider_unavailable'
    /** The upload does not exist, is not private, or is another tenant's. */
    | 'upload_missing'
    | 'too_large'
    /** A type the providers do not take (`audio/aac`, `audio/amr`) or not audio at all. */
    | 'unsupported_media'
    /** The provider answered and heard nothing: silence, or noise. */
    | 'empty'
    | 'timeout'
    | 'rate_limited'
    | 'failed';

export type TranscribeResult =
    | { ok: true; text: string; durationMs?: number; provider: TranscribeProvider; model: string }
    | { ok: false; reason: TranscribeFailure };

export type TranscribeInput = {
    mime: string;
    languageHint?: string;
    /** The owner allows a paid provider to answer (`whatsapp.allow_paid_ai`). Default false. */
    allowPaid?: boolean;
    /** A speech model of the provider, for an operator who wants another; default `TRANSCRIBE_DEFAULT_MODEL`. */
    model?: string;
    /** For a test: a stand-in for `fetch`, and a shorter deadline. */
    fetchImpl?: FetchLike;
    timeoutMs?: number;
} & (
    /** A private upload of this tenant, read through the media store. */
    | { creatorId: string; uploadId: string; bytes?: undefined }
    /** Bytes the caller already holds. */
    | { bytes: Uint8Array; uploadId?: undefined; creatorId?: string }
);

interface Chosen { provider: TranscribeProvider; model: string; apiKey: string }

/**
 * The provider that serves `transcribe`, or null when none may: the first of `TRANSCRIBE_PROVIDERS` that is switched on, has a key, and is
 * free or allowed to be paid. Reads settings (the keys: saved first, then the environment); never the network.
 */
async function chooseTranscriber(allowPaid: boolean, model: string | undefined): Promise<Chosen | null> {
    const { config, keys } = await loadAiSettings();
    for (const id of TRANSCRIBE_PROVIDERS) {
        if (providerProblem(id, config, keys) !== null) continue;
        if (PAID_TRANSCRIBE_PROVIDERS.has(id) && !allowPaid) continue;
        const apiKey = keys.get(id);
        if (apiKey) return { provider: id, model: model || TRANSCRIBE_DEFAULT_MODEL[id], apiKey };
    }
    return null;
}

const FAILURE_BY_KIND: Partial<Record<AiError['kind'], TranscribeFailure>> = {
    timeout: 'timeout',
    rate: 'rate_limited',
    quota: 'rate_limited',
    auth: 'provider_unavailable',
};

/**
 * Transcribe one voice note. Never throws; see the header for what it will and will not do.
 */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscribeResult> {
    const mime = baseMime(input.mime);
    const filename = AUDIO_FILES[mime];
    if (!filename) return { ok: false, reason: 'unsupported_media' };

    // Provider first: a refusal here costs nothing, and a turn without one hands off whatever the audio is.
    let chosen: Chosen | null;
    try {
        chosen = await chooseTranscriber(input.allowPaid === true, input.model);
    } catch (err) {
        log('warn', 'transcribe.settings_unreadable', { message: (err as Error)?.message });
        return { ok: false, reason: 'provider_unavailable' };
    }
    if (!chosen) {
        log('warn', 'transcribe.provider_unavailable', { allow_paid: input.allowPaid === true });
        return { ok: false, reason: 'provider_unavailable' };
    }

    let audio: Uint8Array;
    if (input.bytes) {
        audio = input.bytes;
    } else {
        try {
            const stored = await (await getMediaStore()).get(input.uploadId, { privateFor: input.creatorId });
            if (!stored) return { ok: false, reason: 'upload_missing' };
            audio = stored.data;
        } catch (err) {
            log('error', 'transcribe.upload_unreadable', { upload_id: input.uploadId, message: (err as Error)?.message });
            return { ok: false, reason: 'upload_missing' };
        }
    }
    if (audio.byteLength === 0) return { ok: false, reason: 'empty' };
    if (audio.byteLength > MAX_TRANSCRIBE_BYTES) return { ok: false, reason: 'too_large' };

    const started = performance.now();
    try {
        const out = await transcribeWithProvider({
            provider: chosen.provider,
            apiKey: chosen.apiKey,
            model: chosen.model,
            audio,
            mimeType: mime,
            filename,
            language: input.languageHint ?? 'ar',
            timeoutMs: input.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS,
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        });
        const elapsed = Math.round(performance.now() - started);
        if (!out.text) {
            log('info', 'transcribe.empty', { provider: chosen.provider, model: chosen.model, bytes: audio.byteLength, elapsed_ms: elapsed });
            return { ok: false, reason: 'empty' };
        }
        // The transcript is the customer's words: its length is logged, never the text.
        log('info', 'transcribe.done', { provider: chosen.provider, model: chosen.model, bytes: audio.byteLength, text_chars: out.text.length, elapsed_ms: elapsed });
        return {
            ok: true, text: out.text, provider: chosen.provider, model: out.model,
            ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
        };
    } catch (err) {
        const elapsed = Math.round(performance.now() - started);
        if (isAiError(err)) {
            log('warn', 'transcribe.failed', { ...aiErrorLogFields(err), purpose: TRANSCRIBE, bytes: audio.byteLength, elapsed_ms: elapsed });
            return { ok: false, reason: FAILURE_BY_KIND[err.kind] ?? 'failed' };
        }
        log('error', 'transcribe.failed', { provider: chosen.provider, model: chosen.model, message: (err as Error)?.message, bytes: audio.byteLength, elapsed_ms: elapsed });
        return { ok: false, reason: 'failed' };
    }
}
