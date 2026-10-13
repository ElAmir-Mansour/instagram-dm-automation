/**
 * Which Arabic a creator writes (docs/onboarding/03 §3.2): code counts, the model decides, code checks.
 * Pure. `registerSignals` counts register markers in captions; `decideRegister` turns the counts into a
 * verdict and says how sure it is; `validateDraft` lets the model's own pick stand only where this agrees.
 *
 * Matching is by WHOLE WORD on `normalizeArabic`'d text (`utils/arabic.ts`), so `بس` is not found inside
 * `لبس` and `زي` not inside `زيت`: the text is split into tokens on anything that is not a letter or a
 * digit and a marker must be a token (or, for the two-word markers, two tokens in a row).
 *
 * Markers unique to one register count 1; markers shared by the dialects (`بس`, `عشان`, `يعني`...) count
 * 0.3 toward "this is not فصحى" and toward no dialect in particular. A marker counts once per caption, so
 * one shouted word does not make a register.
 *
 * Call-to-action lines (the ones that ask for a comment, or end in 📩 or 👇) are scored apart from the
 * bodies: a فصحى body with a Gulf ask is `mixed`, which is a finding and not noise.
 *
 * A result that is not confident defaults to فصحى (`msa`), and the tenant then picks by ear in the wizard.
 */
import { normalizeArabic } from '../../utils/arabic.js';
import type { ArabicRegister } from '../profile/types.js';

export type Dialect = Exclude<ArabicRegister, 'msa'>;
const DIALECTS: readonly Dialect[] = ['gulf', 'egyptian', 'levantine'];
const REGISTER_KEYS: readonly ArabicRegister[] = ['msa', 'gulf', 'egyptian', 'levantine'];

const norm = (words: readonly string[]): string[] => words.map((w) => normalizeArabic(w));

/** Single-word markers by register, weight 1. */
const MARKERS: Readonly<Record<ArabicRegister, readonly string[]>> = {
    gulf: norm(['وش', 'ايش', 'أبي', 'أبغى', 'تبي', 'تبغى', 'الحين', 'زين', 'واجد', 'وايد', 'يسوّي', 'لين', 'كذا', 'مرّة', 'ترى', 'دحين', 'ودك', 'يجيك']),
    egyptian: norm(['إزاي', 'ليه', 'فين', 'إيه', 'عايز', 'عاوز', 'دلوقتي', 'كده', 'بتاع', 'أوي', 'خالص', 'مش', 'ده', 'دي', 'دول']),
    levantine: norm(['شو', 'هلّق', 'هلأ', 'هيك', 'منيح', 'كتير', 'بدّي', 'بدك', 'لسّا', 'مشان', 'هون']),
    msa: norm(['سوف', 'لقد', 'ماذا', 'لماذا', 'هكذا', 'الذي', 'التي', 'ليس', 'أيضاً', 'فقط', 'يجب', 'حيث']),
};

/** Shared by the dialects, weight 0.3. */
const SHARED_MARKERS: readonly string[] = norm(['بس', 'عشان', 'علشان', 'ليش', 'زي', 'يعني', 'يلا', 'كمان']);
const SHARED_WEIGHT = 0.3;

/**
 * Two-word markers: a particle followed by a present-tense verb (a word that starts with a present-tense prefix
 * and has at least three letters). `عم` and `رح` are Levantine; `لم` and `لن` before a verb are فصحى.
 */
const BIGRAMS: ReadonlyArray<{ first: string; register: ArabicRegister; label: string }> = [
    { first: normalizeArabic('عم'), register: 'levantine', label: 'عم+فعل' },
    { first: normalizeArabic('رح'), register: 'levantine', label: 'رح+فعل' },
    { first: normalizeArabic('لم'), register: 'msa', label: 'لم+فعل' },
    { first: normalizeArabic('لن'), register: 'msa', label: 'لن+فعل' },
];
// Not a word that starts with the article (الشارع is a noun, not a verb in the first person).
const PRESENT_VERB = /^(?!\u0627\u0644)[يتناب]\p{L}{2,}$/u;

const wordsOf = (normalized: string): string[] => normalized.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

/** Marker lookup: token → the register it is unique to. */
const LOOKUP = new Map<string, ArabicRegister>();
for (const key of REGISTER_KEYS) for (const word of MARKERS[key]) LOOKUP.set(word, key);
const SHARED = new Set(SHARED_MARKERS);

/**
 * The marker a token is, if it is one: the token itself, or the token without a leading `و` ("and") when what
 * is left is at least three letters and is a marker. Writers attach it constantly (`وابغى`, `والحين`, `وسوف`),
 * and without it a marker is missed exactly where people use it most. It is still whole-word: `لبس` has no
 * marker in it, and a two-letter marker such as `بس` or `مش` is never found behind a `و`.
 */
function markerOf(token: string): string | null {
    if (LOOKUP.has(token) || SHARED.has(token)) return token;
    if (token.length >= 4 && token.startsWith('\u0648')) {
        const rest = token.slice(1);
        if (LOOKUP.has(rest) || SHARED.has(rest)) return rest;
    }
    return null;
}

export interface RegisterScores {
    msa: number;
    gulf: number;
    egyptian: number;
    levantine: number;
}

export interface RegisterSignals {
    /** Weighted marker score per register: unique markers 1 per caption, once per caption. */
    scores: RegisterScores;
    /** The distinct markers found, per register. */
    markers: Record<ArabicRegister, string[]>;
    /** In how many captions each register had at least one marker. */
    captionsWith: RegisterScores;
    /** How many captions carried a shared marker, and the weighted total of those (0.3 each, once per caption). */
    shared: { distinct: string[]; weight: number };
    /** All words, and the dialect markers (unique plus shared, every occurrence) per 100 words. */
    words: number;
    dialectPer100: number;
    /** The same counts for the call-to-action lines alone, which are left out of the body counts above. */
    cta: { scores: RegisterScores; captionsWith: RegisterScores; lines: number };
    captions: number;
}

const emptyScores = (): RegisterScores => ({ msa: 0, gulf: 0, egyptian: 0, levantine: 0 });

/**
 * A call-to-action line: one that asks for a comment (اكتب / علّق / comment) or ends in 📩 or 👇.
 * Checked on the raw line, because the emoji and the verb are what is looked for.
 */
export function isCtaLine(line: string): boolean {
    const text = line.trim();
    if (!text) return false;
    if (/(?:📩|👇)\s*(?:[\u{FE0F}\u{1F3FB}-\u{1F3FF}])*$/u.test(text)) return true;
    return /(?:اكتب|اكتبوا|اكتبي|علق|علّق|علقوا|علّقوا|\bcomment\b)/iu.test(normalizeArabic(text) + ' ' + text);
}

/** Splits a caption into its body and its call-to-action lines. */
export function splitCaption(caption: string): { body: string; cta: string[] } {
    const body: string[] = [];
    const cta: string[] = [];
    for (const line of caption.split(/\r?\n/)) (isCtaLine(line) ? cta : body).push(line);
    return { body: body.join('\n'), cta };
}

interface Count {
    unique: Map<string, ArabicRegister>;
    shared: Set<string>;
    /** Every occurrence, for the per-100-words rate. */
    occurrences: number;
}

/** The markers in one piece of text, each once. */
function markersIn(text: string): Count {
    const words = wordsOf(normalizeArabic(text));
    const unique = new Map<string, ArabicRegister>();
    const shared = new Set<string>();
    let occurrences = 0;
    for (let i = 0; i < words.length; i++) {
        const w = words[i]!;
        const marker = markerOf(w);
        const register = marker ? LOOKUP.get(marker) : undefined;
        if (marker && register) {
            unique.set(marker, register);
            // The rate is of DIALECT markers: a فصحى marker is the thing it is measured against.
            if (register !== 'msa') occurrences++;
        } else if (marker && SHARED.has(marker)) {
            shared.add(marker);
            occurrences += SHARED_WEIGHT;
        }
        const next = words[i + 1];
        if (next && PRESENT_VERB.test(next)) {
            const bigram = BIGRAMS.find((b) => b.first === w || `\u0648${b.first}` === w);
            if (bigram) {
                unique.set(bigram.label, bigram.register);
                if (bigram.register !== 'msa') occurrences++;
            }
        }
    }
    return { unique, shared, occurrences };
}

/** Counts register markers in captions (03 §3.2). Pure; each caption is one string with its line breaks. */
export function registerSignals(captions: readonly string[]): RegisterSignals {
    const scores = emptyScores();
    const captionsWith = emptyScores();
    const ctaScores = emptyScores();
    const ctaCaptionsWith = emptyScores();
    const markers: Record<ArabicRegister, Set<string>> = { msa: new Set(), gulf: new Set(), egyptian: new Set(), levantine: new Set() };
    const sharedSeen = new Set<string>();
    let sharedWeight = 0;
    let words = 0;
    let occurrences = 0;
    let ctaLines = 0;

    for (const caption of captions) {
        const { body, cta } = splitCaption(caption);
        words += wordsOf(normalizeArabic(body)).length;
        const bodyCount = markersIn(body);
        occurrences += bodyCount.occurrences;
        const seenHere = new Set<ArabicRegister>();
        for (const [marker, register] of bodyCount.unique) {
            scores[register] += 1;
            markers[register].add(marker);
            seenHere.add(register);
        }
        for (const register of seenHere) captionsWith[register] += 1;
        for (const marker of bodyCount.shared) {
            sharedWeight += SHARED_WEIGHT;
            sharedSeen.add(marker);
        }

        if (cta.length > 0) {
            ctaLines += cta.length;
            const ctaCount = markersIn(cta.join('\n'));
            const ctaSeen = new Set<ArabicRegister>();
            for (const [, register] of ctaCount.unique) {
                ctaScores[register] += 1;
                ctaSeen.add(register);
            }
            for (const register of ctaSeen) ctaCaptionsWith[register] += 1;
        }
    }
    return {
        scores,
        markers: { msa: [...markers.msa], gulf: [...markers.gulf], egyptian: [...markers.egyptian], levantine: [...markers.levantine] },
        captionsWith,
        shared: { distinct: [...sharedSeen], weight: sharedWeight },
        words,
        dialectPer100: words === 0 ? 0 : (occurrences / words) * 100,
        cta: { scores: ctaScores, captionsWith: ctaCaptionsWith, lines: ctaLines },
        captions: captions.length,
    };
}

export type LanguageGuess = 'ar' | 'en' | 'mixed' | null;

/** What the captions are written in, by script: mostly Arabic letters, mostly Latin, or both. Null for too little to say. */
export function languageOfCaptions(captions: readonly string[]): LanguageGuess {
    let arabic = 0;
    let latin = 0;
    for (const caption of captions) {
        for (const ch of caption) {
            if (/\p{Script=Arabic}/u.test(ch)) arabic++;
            else if (/\p{Script=Latin}/u.test(ch)) latin++;
        }
    }
    if (arabic + latin < 20) return null;
    const share = arabic / (arabic + latin);
    return share >= 0.6 ? 'ar' : share <= 0.15 ? 'en' : 'mixed';
}

export type RegisterVerdict = ArabicRegister | 'mixed';

export interface RegisterDecision {
    register: RegisterVerdict;
    confidence: 'high' | 'low';
    /** What decided it, in a word the wizard and the log can show. */
    reason: 'dialect' | 'msa' | 'mixed' | 'mixed_cta' | 'too_little_text';
    /** For `mixed_cta`: the dialect the asks are written in. */
    ctaRegister?: Dialect;
    /** What the profile should say: the verdict when it is sure, فصحى when it is not. */
    suggested: ArabicRegister;
}

/** Fewer words than this and nothing is a verdict. */
const MIN_WORDS = 60;
const MIN_DISTINCT = 3;
const MIN_CAPTIONS = 3;
const DOMINANCE = 2;
const MSA_DIALECT_PER_100 = 0.5;

/**
 * The verdict (03 §3.2):
 *   - A dialect wins if its score is at least twice the runner-up's (the best of the other dialects),
 *     it has at least 3 distinct markers, and they appear across at least 3 captions.
 *   - فصحى wins if dialect markers are fewer than 0.5 per 100 words. If the call-to-action lines are
 *     written in a dialect (a marker from the same dialect in at least two captions' asks), the answer is
 *     `mixed` with `reason: 'mixed_cta'`: a فصحى body with Gulf asks.
 *   - Otherwise `mixed`.
 * `suggested` is the verdict when it is a confident dialect or فصحى, and `msa` otherwise.
 */
export function decideRegister(signals: RegisterSignals): RegisterDecision {
    const msa = (reason: RegisterDecision['reason'], register: RegisterVerdict, confidence: 'high' | 'low', extra: Partial<RegisterDecision> = {}): RegisterDecision => ({
        register,
        confidence,
        reason,
        suggested: confidence === 'high' && register !== 'mixed' ? register : 'msa',
        ...extra,
    });
    if (signals.words < MIN_WORDS || signals.captions < 1) return msa('too_little_text', 'msa', 'low');

    const ranked = DIALECTS.map((d) => ({ d, score: signals.scores[d] })).sort((a, b) => b.score - a.score);
    const [best, second] = [ranked[0]!, ranked[1]!];
    if (
        best.score > 0 &&
        best.score >= DOMINANCE * second.score &&
        signals.markers[best.d].length >= MIN_DISTINCT &&
        signals.captionsWith[best.d] >= MIN_CAPTIONS
    ) {
        return msa('dialect', best.d, 'high');
    }

    if (signals.dialectPer100 < MSA_DIALECT_PER_100) {
        const ask = DIALECTS.map((d) => ({ d, captions: signals.cta.captionsWith[d] })).sort((a, b) => b.captions - a.captions)[0]!;
        if (ask.captions >= 2) return msa('mixed_cta', 'mixed', 'low', { ctaRegister: ask.d });
        return msa('msa', 'msa', 'high');
    }
    return msa('mixed', 'mixed', 'low');
}
