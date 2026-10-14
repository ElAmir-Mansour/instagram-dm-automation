/**
 * The proof samples' rules (docs/onboarding/03 §5, plan P25): what a sample is, how many a tenant may ask for, and what an answer
 * must be before it is shown. Pure: no database, no settings, no model.
 *
 * W5 ("Does this sound like you?") shows two cards. Each is written by the production builders, on the `onboarding_proof` route, from the
 * confirmed profile alone, and judged by the tenant:
 *
 *   caption   an Instagram caption in the Studio writer's format (`kind 'caption'`)
 *   comment   the replies of the first comment campaign: the private message and the public reply (`kind 'comment_dm'`, the card's row;
 *             the public replies, the keyword and the match mode travel in `input`)
 *
 * A comment-reply card is the first campaign's own wording, so what the tenant approves is what `complete` creates (inactive).
 *
 * The limits are here as constants, like the draft engine's `DRAFTS_PER_DAY`, so a test can hold them and a mutation can break them:
 * three rounds a day, and three regenerations of a card.
 */
import { normalizeArabic } from '../../utils/arabic.js';
import { sanitizeSourceText } from './fence.js';
import type { MatchMode } from '../profile/types.js';

// ─── What a sample is ────────────────────────────────────────────────────────────────────────

/** The `voice_examples.kind` of each card's row. A DM-reply card is added when the DM bot goes live (03 §5), and is not here until then. */
export const PROOF_KINDS = ['caption', 'comment_dm'] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];
/** The card, as the page names it. */
export type ProofCardId = 'caption' | 'comment';

export const isProofKind = (value: unknown): value is ProofKind => typeof value === 'string' && (PROOF_KINDS as readonly string[]).includes(value);
export const cardOf = (kind: ProofKind): ProofCardId => (kind === 'caption' ? 'caption' : 'comment');

// ─── Limits ──────────────────────────────────────────────────────────────────────────────────

/** Rounds of samples a tenant may start in a UTC day (a round is one POST that asks a model for the cards that are missing). */
export const PROOFS_PER_DAY = 3;
/** "Not quite" regenerates a card with a hint, three tries at most (02 §3). Attempt 1 is the first sample, so a card is at most attempt 4. */
export const REGENERATIONS_PER_CARD = 3;
export const MAX_ATTEMPTS = REGENERATIONS_PER_CARD + 1;

/** What a call is asked for (`generate` raises `maxTokens` to what the route's model needs to think, never lowers it). */
export const PROOF_MAX_TOKENS = 4_000;
/** A round asks for both cards in parallel and answers inside 120 s (03 §5): the deadline for everything one card needs, a repair call included. */
export const PROOF_DEADLINE_MS = 120_000;
/** The most one call may take: a card that needs a repair call gets what is left of the deadline for it. */
export const PROOF_TIMEOUT_MS = 100_000;
/** A repair call is not started with less than this left: it could not answer, and the tenant would wait for nothing. */
export const PROOF_MIN_REPAIR_MS = 15_000;

/** Meta's limit on a direct message (1,000 UTF-8 bytes, about 450 Arabic characters). */
export const DM_MAX_BYTES = 1000;
export const PUBLIC_REPLY_MAX_CHARS = 140;
export const PUBLIC_REPLIES = 2;
export const KEYWORD_MIN_CHARS = 2;
export const KEYWORD_MAX_CHARS = 24;
/** What a person's own edit may be: an Instagram caption is at most 2,200, a DM 1,000 bytes. */
export const EDIT_MAX_CHARS = 2200;
export const HINT_MAX_CHARS = 200;

// ─── The tenant's words about a sample ───────────────────────────────────────────────────────

export const VERDICTS = ['approved', 'edited', 'rejected'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const isVerdict = (value: unknown): value is Verdict => typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);

/** The three chips that regenerate a card, and the fourth, which opens the editor. */
export const HINT_CODES = ['too_formal', 'too_long', 'wrong_info'] as const;
export type HintCode = (typeof HINT_CODES)[number];
export const REASON_CODES = [...HINT_CODES, 'edit_myself'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const isReasonCode = (value: unknown): value is ReasonCode => typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);

/** What each chip tells the model. The chips are code words so the wizard's words can change without changing the prompt. */
export const HINT_TEXT: Readonly<Record<HintCode, string>> = {
    too_formal: 'The creator said it is too formal. Write it the way they would say it to a friend: shorter sentences, everyday words, warmer.',
    too_long: 'The creator said it is too long. Cut it to about half and keep only what matters most.',
    wrong_info: 'The creator said it states something that is not true of them. Say only what the profile and the post support, and leave out every claim you cannot ground.',
};

export interface Hint {
    /** The chip, when the hint is one of the three. */
    code: HintCode | null;
    /** The creator's own words, cleaned (never markup), or ''. */
    note: string;
}

const isHintCode = (value: unknown): value is HintCode => typeof value === 'string' && (HINT_CODES as readonly string[]).includes(value);

/**
 * The hint of a regenerate: one of the chips' codes, or the creator's own words (up to 200 characters). Null for nothing at all.
 * Free text is cleaned like every other thing a model is shown (`sanitizeSourceText`: invisible characters and every angle bracket out).
 */
export function readHint(raw: unknown): Hint | null {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (text === '') return null;
    if (isHintCode(text)) return { code: text, note: '' };
    const note = sanitizeSourceText(text, HINT_MAX_CHARS).trim();
    return note === '' ? null : { code: null, note };
}

/** The reasons a request carries: the known codes only, each once, in the order given. Anything else is dropped. */
export function readReasons(raw: unknown): ReasonCode[] {
    if (!Array.isArray(raw)) return [];
    const out: ReasonCode[] = [];
    for (const item of raw) if (isReasonCode(item) && !out.includes(item)) out.push(item);
    return out;
}

// ─── What an answer must be ──────────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A link in any form a reader would click or copy: with a scheme, with `www.`, or a bare domain on a common ending. */
const LINKISH = /(?:https?:\/\/|www\.)\S|\b[\p{L}\p{N}-]+\.(?:com|net|org|io|co|me|app|dev|shop|store|link|ly|sa|ae|eg|kw|qa|bh|om|jo|tk|info|site|online)\b/iu;
export const hasLink = (text: string): boolean => LINKISH.test(text);

/** Every `{token}` in `text` that is not one of `allowed`: a placeholder nothing fills in would reach a follower as it is. */
const strayTokens = (text: string, allowed: readonly string[]): string[] =>
    [...text.matchAll(/\{([^{}\s]{0,20})\}|[{}]/g)].map((m) => m[0]).filter((t) => !allowed.includes(t));

const tidy = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const chars = (s: string): number => Array.from(s).length;
export const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

export type Checked<T> = { ok: true; value: T } | { ok: false; problem: string };

/** The caption answer: `{ caption }`, non-empty. Its length is the normaliser's business, after the ask and the save line are placed. */
export function readCaptionAnswer(raw: unknown): Checked<string> {
    if (!isObj(raw) || typeof raw.caption !== 'string') return { ok: false, problem: 'The answer has no caption.' };
    const caption = tidy(raw.caption);
    if (caption === '') return { ok: false, problem: 'The caption is empty.' };
    return { ok: true, value: caption };
}

/** The finished caption: Instagram takes at most 2,200 characters. */
export function checkCaption(caption: string, limit: number): string | null {
    if (caption.trim() === '') return 'The caption is empty.';
    if (chars(caption) > limit) return `The caption is ${chars(caption)} characters; Instagram takes ${limit}.`;
    return null;
}

export interface CommentAnswer {
    keyword: string;
    /** The private message, with the offer's link in it (or none) and `{username}` still to be filled when it is sent. */
    dm: string;
    publicReplies: string[];
}

export interface CommentFacts {
    /** The offer's link: the model writes `{url}` and code puts this in. '' when the offer is ordered in a DM and has no link. */
    url: string;
    /** A keyword the profile already fixes, or '' when the model proposes one. */
    keyword: string;
}

/**
 * The comment card's answer, checked and put together. The model writes `{url}` where the link goes and code replaces it, so a link is
 * never a thing a model could get wrong. What is refused, because each reaches a real follower:
 *
 *   - a link the model wrote itself (the DM may carry the offer's link once, through `{url}`, and the public reply no link at all:
 *     Instagram does not link comments, and a link in a public reply is what its spam filters look for);
 *   - a `{placeholder}` that nothing fills in (only `{username}`, and `{url}` in the DM, are real);
 *   - a DM over Meta's 1,000 bytes, a public reply over 140 characters, a keyword that is not one word.
 */
export function readCommentAnswer(raw: unknown, facts: CommentFacts): Checked<CommentAnswer> {
    if (!isObj(raw)) return { ok: false, problem: 'The answer is not an object.' };

    let keyword = facts.keyword.trim();
    if (keyword === '') {
        const proposed = typeof raw.keyword === 'string' ? oneLine(raw.keyword) : '';
        const length = chars(proposed);
        if (length < KEYWORD_MIN_CHARS || length > KEYWORD_MAX_CHARS || /[\s,|{}<>/\\:@#]/.test(proposed) || hasLink(proposed)) {
            return { ok: false, problem: 'The keyword is not one short word.' };
        }
        keyword = proposed;
    }

    if (typeof raw.dm !== 'string' || raw.dm.trim() === '') return { ok: false, problem: 'The message is empty.' };
    const dmText = tidy(raw.dm);
    const dmStray = strayTokens(dmText, ['{username}', '{url}']);
    if (dmStray.length) return { ok: false, problem: `The message holds a placeholder nothing fills in: ${dmStray[0]}.` };
    const urls = (dmText.match(/\{url\}/g) ?? []).length;
    const withoutToken = dmText.replace(/\{url\}/g, ' ');
    if (hasLink(withoutToken)) return { ok: false, problem: 'The message holds a link of its own.' };
    if (facts.url !== '' && urls !== 1) return { ok: false, problem: 'The message must carry the offer\'s link once, as {url}.' };
    if (facts.url === '' && urls !== 0) return { ok: false, problem: 'The offer has no link, so the message must not ask for one.' };
    const dm = tidy(dmText.replace(/\{url\}/g, facts.url));
    if (utf8Bytes(dm) > DM_MAX_BYTES) return { ok: false, problem: `The message is ${utf8Bytes(dm)} bytes; Meta takes ${DM_MAX_BYTES}.` };

    if (!Array.isArray(raw.public_replies)) return { ok: false, problem: 'The answer has no public replies.' };
    const publicReplies: string[] = [];
    for (const item of raw.public_replies) {
        if (typeof item !== 'string') continue;
        const reply = oneLine(item);
        if (reply === '') continue;
        if (hasLink(reply)) return { ok: false, problem: 'A public reply holds a link.' };
        if (reply.includes('|')) return { ok: false, problem: 'A public reply holds the separator "|".' };
        if (strayTokens(reply, ['{username}']).length) return { ok: false, problem: 'A public reply holds a placeholder nothing fills in.' };
        if (chars(reply) > PUBLIC_REPLY_MAX_CHARS) return { ok: false, problem: `A public reply is ${chars(reply)} characters; the limit is ${PUBLIC_REPLY_MAX_CHARS}.` };
        if (!publicReplies.includes(reply)) publicReplies.push(reply);
    }
    if (publicReplies.length === 0) return { ok: false, problem: 'There is no public reply.' };
    return { ok: true, value: { keyword, dm, publicReplies: publicReplies.slice(0, PUBLIC_REPLIES) } };
}

// ─── The campaign's match mode ───────────────────────────────────────────────────────────────

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Does the keyword sit INSIDE a longer word in any of these texts? Both sides are normalised the way the matcher normalises them. */
export function appearsInsideLongerWord(texts: readonly string[], keyword: string): boolean {
    const needle = normalizeArabic(keyword);
    if (needle === '') return false;
    for (const text of texts) {
        const hay = normalizeArabic(text);
        for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
            const before = at === 0 ? '' : Array.from(hay.slice(0, at)).pop() ?? '';
            const after = Array.from(hay.slice(at + needle.length))[0] ?? '';
            if ((before !== '' && WORD_CHAR.test(before)) || (after !== '' && WORD_CHAR.test(after))) return true;
        }
    }
    return false;
}

/**
 * `word` when the keyword appears inside a longer word in the tenant's own captions (so `تم` would fire on اهتمام), else `substring`, the
 * campaign default and what Arabic's attached prefixes (the definite article, a leading ب) need. 03 §5.
 */
export function matchModeFor(keyword: string, samples: readonly string[]): MatchMode {
    return appearsInsideLongerWord(samples, keyword) ? 'word' : 'substring';
}
