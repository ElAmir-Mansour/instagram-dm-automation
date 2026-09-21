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
