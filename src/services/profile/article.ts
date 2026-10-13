/**
 * "a" or "an": the indefinite article for a noun phrase a prompt builds a sentence around (docs/onboarding/05 §2).
 *
 * The profile's `identity.role` is an English noun phrase written by a person ("tech educator", "online shop",
 * "UX designer", "iOS developer"), and a prompt that says "for a online shop's Instagram" reads as machine-made.
 * The article follows how the first word is SAID, not how it is spelt, so the rules are about sound:
 *
 *   - a word that opens with a vowel letter takes "an" ("an educator"), except where the vowel is pronounced as a
 *     consonant ("a university", "a user", "a one-to-one coach");
 *   - a word that opens with a consonant letter takes "a", except where the h is silent ("an hour");
 *   - an acronym is read by the name of its first letter: "an SEO consultant", "an MBA mentor", "a UX designer". In capitals,
 *     any 2-3 letter word is one; in lower case ("ux designer", "seo consultant") only the common ones in `SPELLED_OUT`
 *     are, because "spa" and "mom" are words and "a spa", "a mom" are right;
 *   - an X is a letter before a consonant ("an x-ray", "an Xbox") and a Z before a vowel ("a xylophone", "a xenon");
 *   - a mixed-case brand starting with a vowel letter ("iOS", "eBay") is read by its letter: "an iOS developer".
 *
 * It is a heuristic, not a dictionary: a phrase it gets wrong is a role the owner can reword in the profile. What it
 * must never do is change for a phrase the owner's prompt already uses: "tech educator" stays "a tech educator".
 */

/** Letters whose NAME starts with a vowel sound: A (ay), E (ee), F (eff), H (aitch), I (eye), L (el), M (em), N (en), O (oh), R (ar), S (ess), X (ex). */
const VOWEL_SOUND_LETTERS = 'AEFHILMNORSX';

/**
 * Acronyms that people write in lower case too, said letter by letter. Only the ones the plain rules get wrong need to be
 * here: a vowel letter said "you" (ux, ui), and a consonant letter whose name starts with a vowel (seo, hr, mba, nlp...).
 */
const SPELLED_OUT = new Set([
    'ux', 'ui', 'seo', 'sem', 'smm', 'hr', 'mba', 'mma', 'mfa', 'msc', 'mri', 'fba', 'faq', 'fmcg', 'fx', 'nlp', 'ngo', 'lms', 'sql',
    'rn', 'rpa', 'erp', 'ml', 'mlm', 'hvac', 'lgbtq',
]);

/** Words that start with a vowel letter and a consonant sound ("yoo", "wun"). */
const CONSONANT_SOUND = /^(uni(?!n)|use|usu|uti|ura|uro|ubi|uk|eu|ewe|one|once|ouija)/i;
/** Words that start with a consonant letter and a vowel sound (a silent h). */
const SILENT_H = /^(hour|honest|honou?r|heir)/i;

/** The first word of `phrase`: its first run of letters and digits ("one-to-one coach" gives "one"; "12-week plan" gives "12"). */
function firstWord(phrase: string): string {
    return /^[^A-Za-z0-9]*([A-Za-z0-9]+)/.exec(phrase)?.[1] ?? '';
}

/** "a" or "an" for `phrase`, by how its first word is pronounced. An empty phrase gets "a". */
export function indefiniteArticle(phrase: string): 'a' | 'an' {
    const word = firstWord(phrase);
    if (!word) return 'a';
    // A number is read aloud: eight, eighty, eleven and eighteen take "an"; "a 12-week plan", "a 30-day coach".
    if (/^[0-9]/.test(word)) return word.startsWith('8') || word === '11' || word === '18' ? 'an' : 'a';
    // An acronym is spelt out letter by letter. A 2-3 letter all-capitals word is one ("UX", "SEO", "HR", "MBA"); a longer one
    // ("STEM", "YOGA") is usually read as a word, so it takes the ordinary rules below. In lower case, only the known ones.
    if (/^[A-Z]{2,3}$/.test(word) || SPELLED_OUT.has(word.toLowerCase())) return VOWEL_SOUND_LETTERS.includes(word[0]!.toUpperCase()) ? 'an' : 'a';
    if (CONSONANT_SOUND.test(word)) return 'a';
    if (SILENT_H.test(word)) return 'an';
    // X says "ex" before a consonant or on its own (x-ray, xray, Xbox, XML) and "z" before a vowel (xylophone, xenon, Xerox).
    if (/^x(?![aeiouy])/i.test(word)) return 'an';
    return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** `phrase` with its article: "an online shop", "a fitness coach". */
export function withArticle(phrase: string): string {
    const text = phrase.trim();
    return `${indefiniteArticle(text)} ${text}`;
}
