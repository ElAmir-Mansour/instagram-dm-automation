/**
 * Which language and which Arabic a reply is written in, decided in code (the "language and dialect match" check of
 * docs/DM_SALES_PLAN.md §11). Pure.
 *
 * Two questions, answered separately because they fail separately:
 *
 *   - **Language** is the script. A reply to an Arabic message is mostly Arabic letters (technical terms stay in English, as the audience
 *     writes them, so "mostly" is half or more), and a reply to an English one is mostly Latin letters.
 *   - **Dialect** is a short list of words that belong to one variety and are never written in another: «وش» and «الحين» are Gulf, «ازاي»
 *     and «دلوقتي» are Egyptian, «شو» and «كتير» are Levantine. A reply to a person writing MSA must contain none of them, and a reply to
 *     one writing a dialect must contain none of ANOTHER dialect's (a Gulf bot answering «ازاي» with «وش رايك» is the failure the register
 *     rule exists to prevent). With `lean`, the reply must also use at least one word of the person's own: "Egyptian-leaning", as the plan says.
 *
 * What it does not do: judge whether the Arabic is natural (the judge reads tone), or recognise a dialect by anything but these words.
 * The lists hold only words that are strongly one variety's: a word two dialects share is tagged with both, and a word that is also
 * ordinary MSA («شي», «مرة», «كذا», «طيب») is not on any list, because a false alarm here is a reply blamed for being polite.
 */
import { words } from '../prefilter.js';
import type { Variety } from './types.js';

type Dialect = 'gulf' | 'egyptian' | 'levantine';

/** Each marker, folded the way `words` folds a message (letters unified, marks out), with the dialects that use it. */
const MARKERS: ReadonlyMap<string, readonly Dialect[]> = (() => {
    const map = new Map<string, readonly Dialect[]>();
    const add = (dialects: readonly Dialect[], list: string): void => {
        for (const raw of list.split(/\s+/).filter(Boolean)) for (const w of words(raw)) map.set(w, dialects);
    };
    add(['gulf'], 'ابي ابغى ابغي وش شلون شخبارك الحين وايد ودي ودك تبي تبغى تبون يبي ابشر حياك حياكم مب ماني زين يبيله هالحين');
    add(['gulf', 'levantine'], 'ليش مو راح العافية العافيه');
    add(['egyptian'], [
        'ازاي ايه ليه دلوقتي دلوقت كده كدا ده دي دا دول عايز عايزه عاوز عاوزه لسه اوي بتاع بتاعت بتاعه مش برضو برضه فين',
        'هتقدر هتلاقي هنعمل هبعتلك هنبدا هتبدا هتحتاج هتتعلم هتشوف هتفهم هنساعدك هساعدك هتعرف هتتعلمها',
        'بيشرح بيغطي بيبدا بيعلمك بتشرح بتتعلم بتحتاج بتقدر بتعمل بتحب',
    ].join(' '));
    add(['levantine'], 'شو هلق هيك كتير بدي بدك منيح هاد هاي هادا عنجد هسا');
    return map;
})();

/** «هالموضوع», «هالمعلومة»: the Gulf and Levantine contraction of "this" glued to a noun. */
const THIS_PREFIX = /^هال\p{L}{2,}$/u;

/** The dialect words in `text`, by dialect, each word once, in the order they appear. */
export function dialectWords(text: string): Record<Dialect, string[]> {
    const found: Record<Dialect, string[]> = { gulf: [], egyptian: [], levantine: [] };
    const seen = new Set<string>();
    for (const w of words(text)) {
        if (seen.has(w)) continue;
        const dialects = MARKERS.get(w) ?? (THIS_PREFIX.test(w) ? (['gulf', 'levantine'] as const) : undefined);
        if (!dialects) continue;
        seen.add(w);
        for (const d of dialects) found[d].push(w);
    }
    return found;
}

export interface ScriptShares {
    arabic: number;
    latin: number;
    /** All letters, of any script. */
    letters: number;
}

/** How many letters of `text` are Arabic script, how many Latin, and how many in all. Digits, emoji and punctuation are not letters. */
export function scriptShares(text: string): ScriptShares {
    let arabic = 0;
    let latin = 0;
    let letters = 0;
    for (const ch of text) {
        if (!/\p{L}/u.test(ch)) continue;
        letters += 1;
        if (/\p{Script=Arabic}/u.test(ch)) arabic += 1;
        else if (/\p{Script=Latin}/u.test(ch)) latin += 1;
    }
    return { arabic, latin, letters };
}

/**
 * A reply is "in" a language when at least this much of its letters are that script. English terms in an Arabic reply, and an Arabic offer
 * name in an English one, are a few words either way and stay well under the other half; a reply in the wrong language is nowhere near it.
 */
export const LANGUAGE_SHARE = 0.5;

export interface VarietyVerdict {
    pass: boolean;
    detail: string;
}

/** Does `text` read as written in `variety`? See the top of the file for what that means. */
export function checkVariety(text: string, variety: Variety, lean = false): VarietyVerdict {
    const shares = scriptShares(text);
    if (shares.letters < 3) return { pass: false, detail: 'the reply has no words in it' };

    if (variety === 'english') {
        const share = shares.latin / shares.letters;
        return share >= LANGUAGE_SHARE
            ? { pass: true, detail: '' }
            : { pass: false, detail: `expected English, but only ${Math.round(share * 100)}% of its letters are Latin` };
    }

    const arabicShare = shares.arabic / shares.letters;
    if (arabicShare < LANGUAGE_SHARE) {
        return { pass: false, detail: `expected Arabic, but only ${Math.round(arabicShare * 100)}% of its letters are Arabic` };
    }

    const found = dialectWords(text);
    if (variety === 'msa') {
        const all = [...new Set([...found.gulf, ...found.egyptian, ...found.levantine])];
        return all.length === 0
            ? { pass: true, detail: '' }
            : { pass: false, detail: `expected MSA, but it uses dialect words: ${all.map((w) => `«${w}»`).join(' ')}` };
    }

    const others = (['gulf', 'egyptian', 'levantine'] as const).filter((d) => d !== variety);
    const foreign = [...new Set(others.flatMap((d) => found[d]).filter((w) => !found[variety].includes(w)))];
    if (foreign.length > 0) {
        const named = variety === 'gulf' ? 'Gulf' : 'Egyptian';
        return { pass: false, detail: `expected ${named}, but it uses another dialect's words: ${foreign.map((w) => `«${w}»`).join(' ')}` };
    }
    if (lean && found[variety].length === 0) {
        return { pass: false, detail: `expected a reply that leans ${variety === 'gulf' ? 'Gulf' : 'Egyptian'}, but it uses no ${variety === 'gulf' ? 'Gulf' : 'Egyptian'} word` };
    }
    return { pass: true, detail: '' };
}
