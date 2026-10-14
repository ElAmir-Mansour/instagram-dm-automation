/**
 * Text helpers the sales modules share: digits, numbers, UTF-8 bytes. Pure.
 *
 * Two jobs, both about not trusting what a model typed:
 *
 *   - **Numbers.** Arabic is written with Arabic-Indic digits (٣٤٩) as often as with Latin ones, with its own decimal and thousands marks
 *     (٫ ٬). The guard compares a reply's numbers with the owner's data, so both go through `normalizeDigits` and `canonNumber` first:
 *     "٤٩٫٩٩", "49.99" and "49.990" are one number.
 *   - **Bytes.** Instagram counts a text in UTF-8 bytes. `capUtf8Bytes` cuts on a grapheme boundary, so it never splits a letter from its
 *     mark, an emoji from its skin tone or a joined emoji sequence, and never leaves half of a surrogate pair.
 */

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_INDIC_ZERO = 0x06f0;

/**
 * Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits as ASCII, and the Arabic decimal mark (٫) and thousands mark (٬) as "." and ",".
 * One character in, one character out, so a position in the result is a position in the original.
 */
export function normalizeDigits(text: string): string {
    return text.replace(/[٠-٩۰-۹٫٬]/g, (c) => {
        const code = c.charCodeAt(0);
        if (code === 0x066b) return '.';
        if (code === 0x066c) return ',';
        return String(code >= EXTENDED_INDIC_ZERO ? code - EXTENDED_INDIC_ZERO : code - ARABIC_INDIC_ZERO);
    });
}

/**
 * A number in one spelling: no thousands commas, no leading zeros, no trailing zeros after the point. "1,000" is "1000", "09" is "9",
 * "49.50" is "49.5", "49.0" is "49". The argument is what `NUMBER` matched, in ASCII digits.
 */
export function canonNumber(raw: string): string {
    const [whole = '', fraction = ''] = raw.replace(/,/g, '').split('.');
    const int = whole.replace(/^0+(?=\d)/, '') || '0';
    const frac = fraction.replace(/0+$/, '');
    return frac ? `${int}.${frac}` : int;
}

/** A number: digits grouped by commas ("1,299.50") or plain ("49", "49.99"). "1,5" is two numbers: a comma that is not a thousands mark is not read as a decimal one. */
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * Keycap emoji (1️⃣) and the "1." that opens a list line are not claims about the offer, so they are blanked (to spaces of the same
 * length, so positions hold) before numbers are looked for. Anything else with a digit in it is a number.
 */
function maskNoise(ascii: string): string {
    return ascii
        .replace(/\d️?⃣/g, (m) => ' '.repeat(m.length))
        .replace(/^([ \t]*)(\d{1,2})(?=[.):\-][ \t])/gm, (_m, lead: string, digits: string) => lead + ' '.repeat(digits.length));
}

export interface NumberSpan {
    /** `canonNumber` of it. */
    value: string;
    start: number;
    /** One past the last character, in the text the span was found in (digits normalised, which keeps every position). */
    end: number;
}

/** Every number in `text`, in ASCII after `normalizeDigits`, with where it sits. */
export function numberSpans(text: string): NumberSpan[] {
    const ascii = maskNoise(normalizeDigits(text));
    return [...ascii.matchAll(NUMBER)].map((m) => ({ value: canonNumber(m[0]), start: m.index!, end: m.index! + m[0].length }));
}

/** The set of numbers in `text`, canonical. */
export function extractNumbers(text: string): Set<string> {
    return new Set(numberSpans(text).map((s) => s.value));
}

// ─── Bytes ───────────────────────────────────────────────────────────────────────────────────

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A half of a surrogate pair standing alone is not text: it would be sent as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The user-perceived characters of `text`: a letter and its marks, an emoji and its modifiers, a joined sequence, each one piece. */
export function graphemes(text: string): string[] {
    return [...segmenter.segment(text)].map((s) => s.segment);
}

/** Ends a sentence, in Latin and Arabic punctuation (، is a comma: it does not). */
const SENTENCE_END = /[.!?؟…\n]/;

/**
 * `text` cut to at most `maxBytes` of UTF-8, whole graphemes only. When it has to be cut, it is cut at the last sentence end of its
 * second half if there is one; else at the last space of its second half and closed with "…"; else mid-word, closed with "…". The
 * "…" is counted, so the result never exceeds the cap. A text already inside the cap comes back as it is (less lone surrogates).
 */
export function capUtf8Bytes(text: string, maxBytes: number): string {
    const clean = text.replace(LONE_SURROGATE, '');
    if (utf8Bytes(clean) <= maxBytes) return clean;
    const ELLIPSIS = '…';
    const room = Math.max(0, maxBytes - utf8Bytes(ELLIPSIS));

    const parts = graphemes(clean);
    let kept = '';
    let bytes = 0;
    for (const g of parts) {
        const b = utf8Bytes(g);
        if (bytes + b > maxBytes) break;
        kept += g;
        bytes += b;
    }
    // No room for a mark at all: the whole graphemes that fit are the answer.
    if (maxBytes < utf8Bytes(ELLIPSIS)) return kept;
    // A cut at a sentence end needs no mark, and may use all of the cap.
    const half = Math.floor(kept.length / 2);
    for (let i = kept.length - 1; i >= half; i--) {
        if (SENTENCE_END.test(kept[i]!)) return kept.slice(0, i + 1).trimEnd();
    }
    // Otherwise the ellipsis has to fit too: cut again at `room`.
    let shorter = '';
    bytes = 0;
    for (const g of parts) {
        const b = utf8Bytes(g);
        if (bytes + b > room) break;
        shorter += g;
        bytes += b;
    }
    const space = shorter.lastIndexOf(' ');
    const cut = space >= Math.floor(shorter.length / 2) ? shorter.slice(0, space) : shorter;
    return `${cut.trimEnd()}${ELLIPSIS}`;
}
