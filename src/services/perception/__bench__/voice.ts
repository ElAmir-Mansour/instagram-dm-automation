/**
 * The voice arm (docs/specs/005-muse-sees US3, P3): a voice note is downloaded, decoded, heard by Meta's speech model, and its transcript is answered by the sales turn as
 * though the customer had typed it. The benchmark measures the PRODUCT's own path, so the arm runs `transcribeVoice` of `src/services/perception/voice.ts` and nothing of its own
 * (the module as committed on the P3 branch): its download is the one thing replaced, by the file in `--media-dir`, and the call to Meta's speech model by the same client
 * (`llm/metaAsr.ts`) without the settings read and the `ai_usage` row that the providers layer adds. Its decoder is its own, the one that runs in production. While that module is
 * not in this checkout (P3 has not landed) the arm is skipped with a note, behind `--voice`.
 *
 * What the arm needs of it, in one function (`TranscribeVoice`): the audio and what to listen for in, a status and a transcript out, with the time and the dollars the call took.
 * `adaptVoice` maps the module onto it; when P3 lands with another signature, that function is the one place to change.
 *
 * What happens next is the pipeline's rule for a voice note (contracts/perception.md §2): a transcript of fewer than two words is not understood and the customer is asked to
 * send it again or type it; anything else is answered by the sales turn as the customer's own words, which go through the pre-filter as any typed message does.
 */
import { words } from '../../dmSales/prefilter.js';
import { resolveFixture } from '../../dmSales/__evals__/fixtures.js';
import { kitFor } from '../../profile/kits.js';
import { isAiError } from '../../llm/errors.js';
import {
    accepts, ACTION_WORDS, draftTurn, emptyInvented, expectedWords, finishDrafted, judgeUnderstood, oneLine, spent, type ArmDeps,
} from './arms.js';
import type { Perception } from '../types.js';
import { scrubKey } from './caller.js';
import type { FetchLike } from '../../llm/types.js';
import type { LoadedMedia } from './cases.js';
import { wordErrorRate } from './metrics.js';
import type { ArmCaseResult, Failure, MuseCase } from './types.js';

export interface VoiceInput {
    caseId: string;
    bytes: Buffer;
    mime: string;
    /** What to listen for: the account's offer and brand names, longest first, at most twenty. */
    keywords: string[];
    /** The profile the names come from, for a module that makes its own list (`voiceKeywords`). */
    source: KeywordSource;
    language: 'Arabic' | 'English';
}

/** What a list of names is made from: the DM context's names and offers (`ProfileContext<'dm'>` is one). */
export interface KeywordSource {
    names: { display_name: { ar: string; en: string }; brand_name: string };
    offers: readonly { name: string; primary?: boolean }[];
}

export interface VoiceHeard {
    status: 'ok' | 'unreadable' | 'failed';
    transcript: string;
    /** Milliseconds the module took: decoding and hearing. */
    ms: number;
    /** Dollars the speech call cost. */
    usd: number;
    reason?: string;
}

export type TranscribeVoice = (input: VoiceInput) => Promise<VoiceHeard>;

/** The most names the speech model is told to listen for (contracts/perception.md §2). */
export const MAX_KEYWORDS = 20;

/** The account's offer and brand names, once each, longest first, at most `MAX_KEYWORDS`: the words a dialect voice note is most likely to get wrong. */
export function keywordsFor(c: Pick<MuseCase, 'fixture'>): string[] {
    const fx = resolveFixture(c.fixture);
    const names = [...fx.ctx.offers.map((o) => o.name), fx.ctx.names.display_name.ar, fx.ctx.names.display_name.en, fx.ctx.names.brand_name].map((n) => n.trim()).filter(Boolean);
    return [...new Set(names)].sort((a, b) => b.length - a.length).slice(0, MAX_KEYWORDS);
}

/** A transcript shorter than this is not words to answer: the customer is asked to type, or send it again (contracts/perception.md §2). */
export const MIN_TRANSCRIPT_WORDS = 2;

export async function runVoiceCase(c: MuseCase, media: LoadedMedia, transcribe: TranscribeVoice, deps: ArmDeps): Promise<ArmCaseResult> {
    const fx = resolveFixture(c.fixture);
    const kit = kitFor(fx.ctx.language);
    const clock = deps.clock ?? (() => performance.now());
    deps.ledger.current = c.id;
    try {
        const started = clock();
        let heard: VoiceHeard;
        try {
            heard = await transcribe({ caseId: c.id, bytes: media.bytes, mime: media.mime, keywords: keywordsFor(c), source: fx.ctx, language: kit.dm.schemaLanguage });
        } catch (err) {
            heard = { status: 'failed', transcript: '', ms: clock() - started, usd: 0, reason: isAiError(err) ? err.kind : scrubKey(err instanceof Error ? err.message : String(err)).slice(0, 80) };
        }
        const readMs = Math.max(clock() - started, heard.ms);
        const spoken = words(heard.transcript);
        const wer = c.reference ? wordErrorRate(words(c.reference), spoken) : null;
        const understood = judgeUnderstood(c.understood, { status: heard.status, reason: heard.reason as Perception['reason'], transcript: heard.transcript });
        const base = {
            arm: 'voice' as const, caseId: c.id, status: 'ran' as const, note: null, understood: understood.ok, understoodWhy: understood.why,
            seen: heard.status === 'ok' ? heard.transcript : null, judge: null as ArmCaseResult['judge'],
        };
        const failures: Failure[] = understood.ok ? [] : [{ caseId: c.id, arm: 'voice', what: 'understood', reason: oneLine(understood.why ?? '') }];
        const trace = heard.status === 'ok' ? `Heard the voice note${wer === null ? '' : `, word error rate ${wer.toFixed(2)} against what was said`}.` : `Could not hear it (${heard.status}${heard.reason ? `: ${heard.reason}` : ''}).`;

        if (heard.status !== 'ok' || spoken.length < MIN_TRANSCRIPT_WORDS) {
            const actionOk = accepts(c, 'resend');
            const why = `${ACTION_WORDS.resend}, because it could not be heard; ${expectedWords(c)}`;
            if (!actionOk) failures.push({ caseId: c.id, arm: 'voice', what: 'action', reason: oneLine(why) });
            return {
                ...base, action: 'resend', actionOk, actionWhy: actionOk ? null : why, reply: kit.attachments.resend, trace, invented: emptyInvented(), failures, ms: readMs,
                ...spent(deps, c.id), usd: Math.round((spent(deps, c.id).usd + heard.usd) * 1e9) / 1e9,
            };
        }
        const outcome = await draftTurn(c, heard.transcript, undefined, deps);
        return finishDrafted(c, 'voice', base, failures, outcome, fx, readMs, deps, null, { trace, usd: heard.usd });
    } finally {
        deps.ledger.current = null;
    }
}

// ─── Wiring the product's voice module in ────────────────────────────────────────────────────────────────────────────────

/** What `transcribeVoice` returns (`VoiceResult` in the P3 module): only the fields the arm reads. */
export type VoiceModuleResult =
    | { ok: true; status: 'ok'; transcript: string; usd: number; ms: number }
    | { ok: false; status: 'unreadable' | 'skipped' | 'failed'; reason: string; detail?: string; transcript?: string; usd: number; ms: number };

/** The shape of `src/services/perception/voice.ts` as committed on the P3 branch (`hackathon/p3-voice`): the steps are replaceable one by one, which is how the arm reaches it. */
export interface VoiceModule {
    transcribeVoice(
        input: { creatorId: string; link: string | null | undefined; keywords?: readonly string[] },
        deps?: {
            download?: (link: string | null | undefined) => Promise<{ ok: true; media: { mediaKind: 'audio'; mime: string; bytes: Buffer; host: string; ms: number } }>;
            transcribe?: (args: { creatorId: string; wav: Uint8Array; keywords?: readonly string[] }) => Promise<{ transcript: string; durationMs: number; model: string; sessionId?: string; usd: number; usageId: string; elapsedMs: number }>;
        },
    ): Promise<VoiceModuleResult>;
}

/** The speech client, `src/services/llm/metaAsr.ts`: no database and no settings, the key an argument. */
export interface AsrModule {
    callMetaAsr(args: { apiKey: string; wav: Uint8Array; keywords?: readonly string[]; fetchImpl?: FetchLike }): Promise<{ transcript: string; durationMs: number; model: string; sessionId?: string }>;
    asrUsd(ms: number): number;
}

/** The product's list of names (`src/services/perception/keywords.ts`), when that module is there too. */
export interface KeywordsModule {
    voiceKeywords(profile: KeywordSource): string[];
}

/**
 * The product's `transcribeVoice` as the arm's `TranscribeVoice`. The link it is given is a stand-in that is never fetched: its `download` returns the case's own audio. Its
 * `transcribe` is `callMetaAsr` with the benchmark's key, priced as `transcribeWithMeta` prices it (`asrUsd` of the audio Meta says it processed), and no row is written anywhere.
 * The module's own decoder, its two-word rule and its one retry are what run.
 */
export function adaptVoice(mod: VoiceModule, asr: AsrModule, o: { apiKey: string; fetchImpl?: FetchLike; keywords?: KeywordsModule }): TranscribeVoice {
    return async (input) => {
        const result = await mod.transcribeVoice(
            { creatorId: 'benchmark-creator', link: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=benchmark', keywords: o.keywords ? o.keywords.voiceKeywords(input.source) : input.keywords },
            {
                download: async () => ({ ok: true, media: { mediaKind: 'audio', mime: input.mime, bytes: input.bytes, host: 'benchmark.local', ms: 0 } }),
                transcribe: async (args) => {
                    const started = performance.now();
                    const out = await asr.callMetaAsr({ apiKey: o.apiKey, wav: args.wav, ...(args.keywords ? { keywords: args.keywords } : {}), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
                    return { ...out, usd: asr.asrUsd(out.durationMs), usageId: 'benchmark', elapsedMs: performance.now() - started };
                },
            },
        );
        if (result.ok) return { status: 'ok', transcript: result.transcript, ms: result.ms, usd: result.usd };
        const reason = `${result.reason}${result.detail ? `: ${result.detail}` : ''}`;
        return { status: result.status === 'unreadable' ? 'unreadable' : 'failed', transcript: result.transcript ?? '', ms: result.ms, usd: result.usd, reason };
    };
}
