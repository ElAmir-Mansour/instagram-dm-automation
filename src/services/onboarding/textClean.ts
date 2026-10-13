/**
 * Cleaning text that came from somewhere the platform does not control (a bio, a caption, a web page,
 * a model's answer). Pure.
 *
 * `stripInvisible` removes what a reader cannot see but a model can read: bidirectional controls (which
 * also reorder text so that a line reads one way and means another), zero-width and joiner characters
 * (they split a word such as `</sou\u200Brce>` so that a filter misses it), the Unicode "tag" block and the
 * variation selectors supplement (a way to hide a whole sentence in what looks like an empty string),
 * and the C0 and C1 controls. Plain line breaks and tabs stay.
 */

// Written as escapes: an invisible character in a source file is exactly the thing this guards against.
const INVISIBLE = new RegExp(
    [
        '[\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF\\uFFF9-\\uFFFC]', // soft hyphen, ALM, mongolian vowel separator, zero-width and bidi marks, invisible operators, BOM, annotation anchors
        '[\\u{E0000}-\\u{E007F}]', // tag characters
        '[\\u{E0100}-\\u{E01EF}]', // variation selectors supplement
        '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', // controls other than \\t \\n \\r
    ].join('|'),
    'gu',
);

/** `s` without the characters a reader cannot see, and with the Unicode line and paragraph separators as plain line breaks. */
export function stripInvisible(s: string): string {
    return s.replace(/[\u2028\u2029]/g, '\n').replace(/\r\n?/g, '\n').replace(INVISIBLE, '');
}

/** The first `max` characters of `s`, counted in code points so that no surrogate pair (an emoji) is cut in half. */
export function truncateChars(s: string, max: number): string {
    if (s.length <= max) return s;
    const chars = Array.from(s);
    return chars.length <= max ? s : chars.slice(0, max).join('');
}

/** Whitespace of every kind folded to single spaces. */
export const oneLine = (s: string): string => s.replace(/[\s\u00A0]+/g, ' ').trim();

/** How many code points `s` has. */
export const charLength = (s: string): number => Array.from(s).length;
