/**
 * Normalizes Arabic text to strip variations in spelling of common characters
 * (Hamzas, Teh Marbuta, Yeh, diacritics/tashkeel) for robust keyword matching.
 */
export function normalizeArabic(text: string): string {
    if (!text) return '';
    return text
        .toLowerCase()
        // Tatweel (kashida) is pure decoration — "تـــم" and "تم" are the same word, and
        // stretched text is everywhere in social-media captions and comments.
        .replace(/ـ/g, '')
        // Replace various forms of Alef with a bare Alef
        .replace(/[أإآ]/g, 'ا')
        // Replace Teh Marbuta with Heh
        .replace(/ة/g, 'ه')
        // Replace Yeh/Alef Maksura with bare Yeh
        .replace(/[ىي]/g, 'ي')
        // Remove diacritics (Fatha, Damma, Kasra, Shadda, Sukun, Tanween) plus the combining
        // hamza/maddah marks at U+0653-U+0655, which are what an alef decomposed by NFD turns
        // into, and U+0670 (superscript alef) — all invisible to a user typing a keyword.
        .replace(/[ً-ٰٕ]/g, '')
        // Clean multiple whitespaces and trim
        .replace(/\s+/g, ' ')
        .trim();
}

/** The characters {@link normalizeArabic} deletes outright: tatweel, then the tashkeel block U+064B-U+0655 and U+0670. */
const REMOVED_BY_NORMALIZE = /[\u0640\u064B-\u0655\u0670]/;
const WHITESPACE = /\s/;

/**
 * {@link normalizeArabic} that also says where every output character came from.
 *
 * Returns `text` (exactly what `normalizeArabic(input)` returns) and `map`, where `map[i]` is the
 * UTF-16 index in the ORIGINAL string of the character that became `text[i]`, plus one final
 * sentinel entry equal to `input.length` — so `map.length === text.length + 1` and an exclusive
 * end offset can be mapped like any other. A run of whitespace collapses to one space that maps to
 * the run's first character. It exists so a checker can match on the normalised text and still
 * highlight the words the person actually typed (the ads policy check does).
 *
 * `text` is identical to `normalizeArabic(input)` — a test fuzzes that. Lower-casing is done one
 * character at a time so every output character has an owner; the one context-sensitive case (the
 * Greek final sigma) is resolved from the whole-string result.
 */
export function normalizeArabicWithMap(text: string): { text: string; map: number[] } {
    if (!text) return { text: '', map: [0] };

    // Lower-case code point by code point so every output character has an owner. The whole-string
    // result is the reference (it resolves context-sensitive cases such as the final sigma); the
    // per-character pieces are re-cut from it when the lengths agree.
    const pieces: Array<{ at: number; lower: string }> = [];
    for (let i = 0; i < text.length;) {
        const cp = text.codePointAt(i) as number;
        const ch = String.fromCodePoint(cp);
        pieces.push({ at: i, lower: ch.toLowerCase() });
        i += ch.length;
    }
    const whole = text.toLowerCase();
    if (pieces.map(p => p.lower).join('') !== whole && pieces.reduce((n, p) => n + p.lower.length, 0) === whole.length) {
        let off = 0;
        for (const p of pieces) { p.lower = whole.slice(off, off + p.lower.length); off += p.lower.length; }
    }

    let out = '';
    const map: number[] = [];
    for (const { at, lower } of pieces) {
        for (const c of lower) {
            if (REMOVED_BY_NORMALIZE.test(c)) continue;
            if (WHITESPACE.test(c)) {
                // A run of whitespace is one space, and leading whitespace is dropped (the trim).
                if (out === '' || out.endsWith(' ')) continue;
                out += ' ';
                map.push(at);
                continue;
            }
            let n = c;
            if (c === 'أ' || c === 'إ' || c === 'آ') n = 'ا';
            else if (c === 'ة') n = 'ه';
            else if (c === 'ى' || c === 'ي') n = 'ي';
            out += n;
            for (let k = 0; k < n.length; k++) map.push(at);
        }
    }
    if (out.endsWith(' ')) { out = out.slice(0, -1); map.pop(); } // the trailing trim
    map.push(text.length);
    return { text: out, map };
}

/** Escapes a string so it can be embedded in a RegExp as a literal. */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The two ways a keyword can be tested. Mirrors `campaigns.match_mode` (migration v14). */
export type KeywordMatchMode = 'substring' | 'word';

export const KEYWORD_MATCH_MODES: readonly KeywordMatchMode[] = ['substring', 'word'];

/**
 * Coerce anything — a request body field, a column a query forgot to select, a row written
 * before v14 — into a mode the matcher understands.
 *
 * Falls back to `'substring'` rather than throwing, and that direction is deliberate: this is
 * called on the webhook's critical path, where the alternative to "match the way you always
 * did" is "answer nobody". An unrecognised value is worth a look, not an outage — so callers
 * that are validating user input should use {@link isKeywordMatchMode} and reject, while
 * callers reading a row should use this.
 */
export function normalizeMatchMode(value: unknown): KeywordMatchMode {
    return value === 'word' ? 'word' : 'substring';
}

/** True only for a value that is exactly one of the supported modes. For input validation. */
export function isKeywordMatchMode(value: unknown): value is KeywordMatchMode {
    return typeof value === 'string' && (KEYWORD_MATCH_MODES as readonly string[]).includes(value);
}

/**
 * Tests a normalized keyword against normalized comment text.
 *
 * Both arguments must already have been through {@link normalizeArabic}.
 *
 * `'substring'` is the historical behaviour and stays the default so existing campaigns keep
 * matching exactly as they do today. It is also dangerous for short keywords: `تم` is a
 * substring of اهتمام, تمام and يتم, so a campaign triggered on it fires on unrelated comments.
 *
 * `'word'` requires the keyword to sit on a token boundary. JavaScript's `\b` is defined in
 * terms of `[A-Za-z0-9_]`, so every Arabic letter reads as a non-word character and `\b` fires
 * in all the wrong places — hence the explicit Unicode lookarounds instead. A multi-word
 * keyword works too: only the outer edges are anchored.
 */
export function keywordMatches(
    normalizedText: string,
    normalizedKeyword: string,
    mode: KeywordMatchMode = 'substring'
): boolean {
    // An empty keyword is a substring of everything, so a trailing comma in a campaign's
    // keyword list would otherwise fire on every comment that arrives.
    if (!normalizedText || !normalizedKeyword) return false;

    if (mode === 'substring') return normalizedText.includes(normalizedKeyword);

    const boundary = '[^\\p{L}\\p{N}_]';
    const pattern = new RegExp(
        `(?<=^|${boundary})${escapeRegExp(normalizedKeyword)}(?=$|${boundary})`,
        'u'
    );
    return pattern.test(normalizedText);
}
