/**
 * The terms that bias a voice note's transcription (docs/specs/005-muse-sees T049, contracts/perception.md §2). The speech model is told, with the audio, the
 * names a customer is likely to say, so that «الكورس بتاع Agentic AI» is heard as that and not as something that sounds like it; Meta says only that keywords
 * "bias recognition but do not guarantee an exact spelling" (dev.meta.ai/docs/speech-to-text, read 2026-10-31), and gives no count or length limit.
 *
 *   voiceKeywords(profile)    at most 20 names: every offer's name (the course or product), the brand name, and the creator's display names, longest first.
 *
 * Pure: the profile's DM context (`ProfileContext<'dm'>`, which the DM turn already holds) goes in and a list comes out; nothing is read from a database.
 *
 * **What counts as a name.** The OFFER names (a course is an offer of kind `course`, so "offer and course names" are one list), the brand name, and both display names.
 * The display names are in because a tenant may have no brand name at all (a shop is its display name, «متجر نور», and `brand_name` is empty) and because a customer
 * says the creator's name to them. The comment keywords (the word a post asks people to comment) are NOT names, and are often an everyday word: they would bias
 * recognition toward a word that needs no help. A handle is not a spoken word either.
 *
 * **Which twenty.** A profile holds at most ten offers, so the cap is rarely met; when it is, the LONGEST names win: they are the most specific, the least likely to
 * be common words and the likeliest to be misheard when nothing says what they are. The list is in that order, ties in the order the profile gives them (the primary
 * offer first). A name that repeats one already kept, ignoring case, is dropped; one over `KEYWORD_MAX_CHARS` characters (a course TITLE is up to 200) is cut at a
 * word, because the start of a title is the part a person says and the whole of it is not.
 */
import { graphemes } from '../dmSales/text.js';
import { ASR_MAX_KEYWORDS } from '../llm/metaAsr.js';
import { oneLine } from './text.js';

/** The longest term sent (a brand name may be 80 characters; an offer's name is cut to it). */
export const KEYWORD_MAX_CHARS = 80;

/** What this reads of the profile's DM context: `ProfileContext<'dm'>` is one. */
export interface KeywordSource {
    names: { display_name: { ar: string; en: string }; brand_name: string };
    offers: readonly { name: string; primary?: boolean }[];
}

/** A name, as one clean line of at most `KEYWORD_MAX_CHARS` characters, cut at a word when it is longer: '' for anything that is not text or is blank. */
function term(value: unknown): string {
    const line = oneLine(value, 10_000);
    const parts = graphemes(line);
    if (parts.length <= KEYWORD_MAX_CHARS) return line;
    const head = parts.slice(0, KEYWORD_MAX_CHARS).join('');
    // Cut at the last space inside the limit when there is one past the first word; otherwise the word is longer than the limit and is cut where it stands.
    // What the cut leaves hanging at the end ("…memory,") is not part of a name.
    const space = head.lastIndexOf(' ');
    return (space > 0 ? head.slice(0, space) : head).replace(/[\s,;:\u060C\u061B\-\u2013\u2014]+$/u, '');
}

/** The names to bias a voice note's transcription with: see the file comment. Pure. */
export function voiceKeywords(profile: KeywordSource): string[] {
    // Array.prototype.sort is stable: the primary offer first, the others as the profile lists them.
    const offers = [...profile.offers].sort((a, b) => Number(b.primary === true) - Number(a.primary === true));
    const candidates = [...offers.map((o) => o.name), profile.names.brand_name, profile.names.display_name.ar, profile.names.display_name.en];

    const seen = new Set<string>();
    const terms: { text: string; length: number; order: number }[] = [];
    for (const candidate of candidates) {
        const text = term(candidate);
        if (!text) continue;
        const key = text.normalize('NFKC').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push({ text, length: graphemes(text).length, order: terms.length });
    }
    return terms.sort((a, b) => b.length - a.length || a.order - b.order).slice(0, ASR_MAX_KEYWORDS).map((t) => t.text);
}
