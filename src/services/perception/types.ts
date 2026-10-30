/**
 * The vocabulary of Meta Muse perception (docs/specs/005-muse-sees, local): what the DM sales agent can SEE and HEAR, and the record it keeps
 * of having done so. Pure types and closed lists, shared by the modules of this folder so a value added here is in the gate, the stored
 * record and the text helpers from the same commit.
 *
 * A word-less DM (a shared reel, a story mention, a photo, a voice note: `webhook/attachments.ts`) used to get one fixed line. With the
 * switches on, `perceive.ts` turns its media into a description, `messages.perception` keeps it (migration v60), and the existing sales turn
 * answers it. Perception DESCRIBES; it never decides: the sales turn chooses among its own actions.
 *
 * Nothing in this file reads a database or a clock.
 */
import type { WordlessKind } from '../../webhook/attachments.js';

/**
 * The word-less kinds perception can read. The rest (`file`, `sticker`, `attachment`: a view-once or a message Instagram could not show)
 * keep today's behaviour. `satisfies` ties the list to `WORDLESS_KINDS`: a name that is not a kind does not compile.
 */
export const PERCEIVABLE_KINDS = [
    'reel', 'share', 'story_reply', 'story_share', 'story_mention', 'image', 'video', 'audio',
] as const satisfies readonly WordlessKind[];

export type PerceptionKind = (typeof PERCEIVABLE_KINDS)[number];

export const isPerceivableKind = (value: unknown): value is PerceptionKind =>
    typeof value === 'string' && (PERCEIVABLE_KINDS as readonly string[]).includes(value);

/** What is switched on for a tenant (`muse.switches.<tenant>`, `switches.ts`). A voice note is `voice`; every other perceivable kind is `dm_media`. */
export type MuseCapability = 'dm_media' | 'voice' | 'memory';

/** The capability a kind needs, or null for a kind perception does not read. */
export function capabilityOfKind(kind: unknown): 'dm_media' | 'voice' | null {
    if (!isPerceivableKind(kind)) return null;
    return kind === 'audio' ? 'voice' : 'dm_media';
}

/** How a perception ended. `ok` is the only one the sales turn answers; the other three leave today's line in place. */
export const PERCEPTION_STATUSES = ['ok', 'unreadable', 'skipped', 'failed'] as const;
export type PerceptionStatus = (typeof PERCEPTION_STATUSES)[number];

/**
 * Why perception did not run. The gate answers the first five (`gate.ts`); `sales_off` is the pipeline's (the tenant's sales mode does not answer this
 * sender), and `no_url` is the download's (the event carried no link to the media: a view-once, for one).
 */
export const SKIP_REASONS = ['switch_off', 'not_allowed_sender', 'sales_off', 'budget', 'unsupported_kind', 'no_key', 'no_url'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Why a step that ran came to nothing. `expired_url`: Meta's link was refused (403/404/410): a story's is gone within a day. */
export const FAIL_REASONS = ['too_large', 'fetch_failed', 'expired_url', 'provider_error', 'timeout'] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

/** Why Meta's answer was not good enough to act on: under the confidence floor, or a voice note with no words in it. */
export const UNREADABLE_REASONS = ['low_confidence', 'empty_transcript'] as const;
export type UnreadableReason = (typeof UNREADABLE_REASONS)[number];

export type PerceptionReason = SkipReason | FailReason | UnreadableReason;

/** Whose content the media is. `personal` (an ID, a card, a receipt with personal data) is handed to a person and never described. */
export const ABOUT_OWNER = ['own_content', 'other_content', 'personal', 'unclear'] as const;
export type AboutOwner = (typeof ABOUT_OWNER)[number];

/** The perception is answered only at or above this confidence (`contracts/perception.md` §1): below it the person is asked to resend. */
export const MIN_CONFIDENCE = 0.6;

/**
 * `messages.perception` (migration v60): what the agent understood from one inbound message. NULL on the row means perception never ran.
 * Written once (`UPDATE … WHERE id = $1 AND perception IS NULL`); a retry reads it back and reuses it. The media itself is never stored.
 */
export interface Perception {
    v: 1;
    kind: PerceptionKind;
    status: PerceptionStatus;
    reason?: PerceptionReason;
    /** 1 to 3 sentences, in English: what it shows and what the person likely wants. "a personal document" for personal media. */
    seen?: string;
    /** Voice: the speech-to-text transcript. Video: the speech heard in it, short. */
    transcript?: string;
    about_owner?: AboutOwner;
    /** 0 to 1. */
    confidence?: number;
    /** Story mentions only: what they shared, at most 8 words, in the conversation's language. */
    mention_summary?: string;
    /** Set when recall matched a reel of the owner's on this turn. */
    recall?: { reel_id: string; permalink: string; second: number };
    model: string;
    /** When the perception was stored: the supersession rule reads it (a reply sent after it means this message was answered). */
    stored_at: string;
    ms: number;
    usd: number;
}
