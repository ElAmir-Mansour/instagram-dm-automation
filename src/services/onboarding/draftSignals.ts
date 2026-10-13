/**
 * The facts code finds before a model is asked anything (docs/onboarding/03 §0: "code finds the facts;
 * Claude judges them"): which script the captions are in, the Arabic register markers and the verdict,
 * which digits and how many emoji the creator uses, and the sample-post pool. The model is shown them in a
 * `<signals>` block and `validateDraft` checks its own answer against them. Pure.
 */
import { registerSignals, decideRegister, languageOfCaptions, type LanguageGuess, type RegisterDecision, type RegisterScores, type RegisterSignals } from './register.js';
import type { DraftSource } from './fence.js';

/** A post that could be shown as an example of how the creator writes (03 §3.3). The text is in its source, under the same id. */
export interface SampleCandidate {
    /** The id of the `ig_caption` source that holds the text. */
    id: string;
    media_type: string;
    /** 0 to 100 among the creator's own posts, or null when likes are hidden. */
    engagement_percentile: number | null;
    chars: number;
}

export interface DraftSignals {
    language: LanguageGuess;
    register: {
        verdict: RegisterDecision['register'];
        confidence: RegisterDecision['confidence'];
        reason: RegisterDecision['reason'];
        suggested: RegisterDecision['suggested'];
        cta_register: string | null;
        scores: RegisterScores;
        distinct_markers: RegisterScores;
        captions_with: RegisterScores;
        dialect_per_100_words: number;
    };
    digits: { arabic_indic: number; latin: number };
    emoji: { per_caption: number; level: 'none' | 'light' | 'rich' };
    counts: { captions: number; words: number; sources: number };
    candidates: SampleCandidate[];
    keywords_in_use: string[];
    handle: string | null;
    site_host: string | null;
    followers: number | null;
    media_count: number | null;
}

export interface SignalInputs {
    sources: readonly DraftSource[];
    candidates?: readonly SampleCandidate[];
    keywordsInUse?: readonly string[];
    handle?: string | null;
    siteHost?: string | null;
    followers?: number | null;
    mediaCount?: number | null;
}

const ARABIC_INDIC = /[٠-٩۰-۹]/g;
const LATIN_DIGIT = /[0-9]/g;
const PICTOGRAPH = /\p{Extended_Pictographic}/gu;

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;
const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;

/** Everything code can say about the creator's captions before a model reads them. */
export function computeSignals(inputs: SignalInputs): DraftSignals {
    const captions = inputs.sources.filter((s) => s.kind === 'ig_caption').map((s) => s.text);
    const signals: RegisterSignals = registerSignals(captions);
    const decision = decideRegister(signals);
    const all = captions.join('\n');
    const emojiPerCaption = captions.length === 0 ? 0 : count(all, PICTOGRAPH) / captions.length;
    const distinct = (key: keyof RegisterScores): number => signals.markers[key].length;
    return {
        language: languageOfCaptions(captions),
        register: {
            verdict: decision.register,
            confidence: decision.confidence,
            reason: decision.reason,
            suggested: decision.suggested,
            cta_register: decision.ctaRegister ?? null,
            scores: signals.scores,
            distinct_markers: { msa: distinct('msa'), gulf: distinct('gulf'), egyptian: distinct('egyptian'), levantine: distinct('levantine') },
            captions_with: signals.captionsWith,
            dialect_per_100_words: round(signals.dialectPer100),
        },
        digits: { arabic_indic: count(all, ARABIC_INDIC), latin: count(all, LATIN_DIGIT) },
        emoji: { per_caption: round(emojiPerCaption), level: emojiPerCaption < 0.3 ? 'none' : emojiPerCaption <= 3 ? 'light' : 'rich' },
        counts: { captions: captions.length, words: signals.words, sources: inputs.sources.length },
        candidates: [...(inputs.candidates ?? [])],
        keywords_in_use: [...(inputs.keywordsInUse ?? [])],
        handle: inputs.handle ?? null,
        site_host: inputs.siteHost ?? null,
        followers: inputs.followers ?? null,
        media_count: inputs.mediaCount ?? null,
    };
}
