/**
 * Voice examples: the samples a tenant said "sounds like me" to, as a prompt may use them (docs/onboarding/03 §5, plan P25). Pure.
 *
 * A proof sample (`voice_examples`, v34) is something the production builders wrote for a new tenant during onboarding, and the
 * tenant judged: approved as it is, edited into their own wording, or rejected. The ones they stood behind become few-shot
 * examples in that tenant's prompts, so a new tenant's writer starts from what they confirmed and not from a guess.
 *
 * Three rules live here, because they are the rules that keep this from hurting anyone:
 *
 *   - **Only the tenant's own confirmation counts.** A row is usable when its verdict is `approved` or `edited` AND
 *     `tenant_confirmed_at` is set. A sample the operator approved on the tenant's behalf is `verdict_by = 'admin'` with no
 *     confirmation: it stays unused until the tenant confirms it (02 §2, "Fill on behalf"). A rejected sample is never used.
 *   - **Edited first, then newest.** An edit is the strongest thing a person can say about their voice, so it leads; among equals
 *     the newest does. At most three (`VOICE_EXAMPLES_MAX`): examples steer a prompt, they do not fill it.
 *   - **Each is a pair.** `wrote` is what the model wrote; `changed_to` is what the tenant made of it, or null when they left it as
 *     it was. A prompt shows "you wrote → they changed it to".
 *
 * The owner has no `voice_examples` (nothing can write one for him: `onboarding/proof.ts` refuses a completed tenant), so nothing here
 * reaches his prompts, and a prompt with no examples is byte-identical to the one before this file existed.
 */
export const VOICE_EXAMPLE_KINDS = ['dm_reply', 'caption', 'comment_dm', 'comment_public'] as const;
export type VoiceExampleKind = (typeof VOICE_EXAMPLE_KINDS)[number];

export const isVoiceExampleKind = (value: unknown): value is VoiceExampleKind =>
    typeof value === 'string' && (VOICE_EXAMPLE_KINDS as readonly string[]).includes(value);

/** Examples steer a prompt; they do not fill it. */
export const VOICE_EXAMPLES_MAX = 3;
/** The longest an example is shown, in characters: an Instagram caption is at most 2,200, and a prompt does not need all of it. */
export const VOICE_EXAMPLE_CHARS = 1200;

/** One example, as a prompt shows it. */
export interface VoiceExample {
    /** What the model wrote. */
    wrote: string;
    /** What the tenant changed it to, or null when they approved it as it was. */
    changed_to: string | null;
}

/** The columns the choice reads. */
export interface VoiceExampleRow {
    model_output: string;
    final_text: string | null;
    verdict: string | null;
    tenant_confirmed_at: Date | string | null;
    created_at: Date | string;
}

const time = (value: Date | string): number => (value instanceof Date ? value.getTime() : Date.parse(value));

/**
 * Text as a prompt may carry it: control characters out, every angle bracket turned into a look-alike (an example is a person's own
 * words, and no word of theirs may close the block it sits in), and cut to `VOICE_EXAMPLE_CHARS`. Idempotent.
 */
export function cleanExampleText(raw: unknown, max: number = VOICE_EXAMPLE_CHARS): string {
    if (typeof raw !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g, '')
        .replace(/[<＜﹤〈〈❮]/g, '‹')
        .replace(/[>＞﹥〉〉❯]/g, '›')
        .replace(/\r\n?/g, '\n')
        .trim();
    return Array.from(text).slice(0, max).join('').trim();
}

/**
 * The examples a tenant's rows give, at most `limit`: only a verdict of `approved` or `edited` that the tenant themselves confirmed,
 * edited ones first, then the newest. A row with nothing to show (an empty output, or an edit that is empty) is left out.
 */
export function selectVoiceExamples(rows: readonly VoiceExampleRow[], limit: number = VOICE_EXAMPLES_MAX): VoiceExample[] {
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10) : VOICE_EXAMPLES_MAX;
    return rows
        .filter((r) => (r.verdict === 'approved' || r.verdict === 'edited') && r.tenant_confirmed_at !== null && r.tenant_confirmed_at !== undefined)
        .map((r) => {
            const wrote = cleanExampleText(r.model_output);
            const edit = r.verdict === 'edited' ? cleanExampleText(r.final_text) : '';
            return { row: r, wrote, edit };
        })
        .filter((x) => (x.row.verdict === 'edited' ? x.edit !== '' : x.wrote !== ''))
        .sort((a, b) => (a.row.verdict === 'edited' ? 0 : 1) - (b.row.verdict === 'edited' ? 0 : 1) || time(b.row.created_at) - time(a.row.created_at))
        .slice(0, cap)
        .map((x) => ({ wrote: x.wrote, changed_to: x.row.verdict === 'edited' ? x.edit : null }));
}
