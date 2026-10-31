/**
 * Meta Muse reads an Instagram DM (docs/specs/005-muse-sees T032): everything between "this message may be readable" and "here is what it said", in the order
 * that keeps the product exactly as it was whenever any condition is not met. `src/webhook/messaging.ts` decides what to DO with the answer (send a line, or
 * let the sales turn answer); this decides whether to look and what was seen.
 *
 *   primaryRef(message)     which thing in a messaging event is the one to read, or null. Pure.
 *   perceiveDm(input)       gate → typing → what to show → Muse → store. The perception as stored, or why not.
 *
 * **The order is the safety.** Nothing here runs for a message the pipeline did not already decide is Instagram's, has no words, and is of a kind Muse reads
 * (a sticker, a file and anything Meta added later are not: `primaryRef` is null, and they are acknowledged as they always were). Then, in this
 * order and each only if the one before passed:
 *
 *   1. **A retry reuses what an earlier attempt stored** (`messages.perception`): no gate, no download, no model call, no typing. The work was done and paid for.
 *   2. **The gate** (`gatePerception`): the tenant's switch for the kind (`dm_media`, or `voice` for a voice note), the sender's allow-list, a Meta route with a key,
 *      the day's cap. Refused for the switch or the sender: NOTHING is written and the product is as it was (the gate logged `perception.skipped:<reason>`). Refused for
 *      the day's cap or a missing key, which the owner switched this on in spite of: the reason is stored on the row, so the inbox can say why a reel was not read.
 *   3. **`typing_on`**, best effort, right after the gate passes and before the slow part: the person sees that someone is working on it.
 *   4. **What to show** (`resolveSource`) and **Muse** (`perceive`), within one 90 s budget for the whole step. A **voice note** is not shown to Muse: `transcribeVoice`
 *      (`voice.ts`) downloads it, decodes it and has Meta's speech model write down what was said, within the same budget (`deadlineAt`).
 *   5. **Stored once** with the readable text in the same statement (for a voice note, the bare transcript); a second attempt that finds it stored uses that one.
 *
 * **What leaves the building:** the media (a voice note's audio, as a WAV), the account's own handle and, for a reel or post, what Meta's event sent with it (its caption),
 * and for a voice note the names of the account's offers and brand, as hints. Never the customer's name, username, id or words. **What stays:** a description or a
 * transcript with the message. The media itself is never written anywhere.
 */
import { describeError, log } from '../../utils/log.js';
import { sendSenderAction } from '../instagram.js';
import type { LlmMedia } from '../llm/types.js';
import { tellOwnerProviderTrouble } from './alert.js';
import { gatePerception, type GateReason, type GateResult } from './gate.js';
import { mediaRefsOf, type MediaRef } from './media.js';
import { cleanHandle, perceive, STEP_BUDGET_MS, type PerceiveLanguage, type PerceiveResult, type SeenKind } from './perceive.js';
import { liveDownload, ownerAbout, resolveSource, withHow, type Draft, type Source, type SourceContext } from './source.js';
import { readStoredPerception, storePerception } from './store.js';
import { perceivedText } from './text.js';
import { capabilityOfKind, type Perception, type PerceptionKind } from './types.js';
import { transcribeVoice, voiceDraft, type VoiceInput, type VoiceResult } from './voice.js';

/**
 * The one thing in a messaging event's `message` that Muse reads, or null. What the customer SENT comes before the story a reply answers (a photo sent in reply to
 * a story is the photo, and so is a voice note), and the first thing sent is the one. A voice note is one: it is HEARD, behind its own switch (`voice`) and by Meta's speech
 * model, but through the same steps as a picture. Pure.
 */
export function primaryRef(message: unknown): MediaRef | null {
    const refs = mediaRefsOf(message);
    return refs.find((ref) => ref.kind !== 'story_reply') ?? refs[0] ?? null;
}

/** The story a message is a reply to, as a thing to read, or null: for a reply that HAS words, whose story is context for the answer. Pure. */
export function storyReplyRef(message: unknown): MediaRef | null {
    return mediaRefsOf(message).find((ref) => ref.kind === 'story_reply') ?? null;
}

// ─── The step ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PerceiveDmInput {
    creator: { id: string; page_access_token: string; instagram_page_id: string | null };
    /** The Facebook Page id for a Messenger DM; undefined for Instagram (the endpoint `me`). Perception is Instagram's, so this is undefined in practice. */
    pageId: string | undefined;
    senderId: string;
    /** The inbound `messages` row. */
    messageId: string;
    ref: MediaRef;
    /** They typed words with it (a reply to a story that has some): the row's `text` stays what they typed, and the media is only context for the answer. */
    typed: boolean;
    /** This attempt inherited the row from an earlier one, which may have stored a perception already. */
    resumed: boolean;
    /** The account's DM language, for the summary of a story mention. */
    language: PerceiveLanguage;
    /** The account's own handle, as the profile has it. */
    handle: string | null;
    /** A voice note only: the names of the account's offers and brand (`voiceKeywords`), which the speech model is given as hints so that it spells them as they are written. */
    keywords?: readonly string[];
}

export type DmReading =
    /** Nothing was read and nothing was written: the product is as it was. `reason` is the gate's, which has logged it. */
    | { kind: 'declined'; reason: GateReason }
    /** A perception is stored, or was reused: act on its status. */
    | { kind: 'read'; perception: Perception; reused: boolean };

export interface PerceiveDmDeps {
    now?: () => number;
    gate?: (args: Parameters<typeof gatePerception>[0]) => Promise<GateResult>;
    readStored?: typeof readStoredPerception;
    store?: typeof storePerception;
    typing?: (input: PerceiveDmInput) => Promise<void>;
    resolve?: (ref: MediaRef, ctx: SourceContext) => Promise<Source>;
    perceive?: (input: Parameters<typeof perceive>[0]) => Promise<PerceiveResult>;
    /** A voice note: what was said in it (download, decode, Meta's speech model). Replaces `transcribeVoice` as a whole; a test that wants the real one passes its own steps to it. */
    hear?: (input: VoiceInput) => Promise<VoiceResult>;
    /** Called when the provider refused the key or has no credit left: the owner is told, once a day. Best effort. */
    onProviderTrouble?: (creatorId: string, kind: 'auth' | 'quota') => Promise<void>;
}

let overrides: PerceiveDmDeps = {};

/**
 * Tests only: replaces parts of the step for every `perceiveDm` made through the pipeline (`src/webhook/messaging.ts` passes none of its own), the way `setAiCaller`
 * and `setMediaFetch` replace the model and the CDN. A test of the pipeline uses it to say a Meta route exists and today's spend is nothing, without arranging the
 * providers layer's whole settings read; every other part (the switches, the allow-list, the record, the download, the model call) is still the real one.
 * Returns the previous overrides, so a test can put them back.
 */
export function setPerceiveDmDeps(next: PerceiveDmDeps): PerceiveDmDeps {
    const previous = overrides;
    overrides = next;
    return previous;
}

/** `typing_on`, best effort: a failure is logged and costs nothing. */
async function sendTyping(input: PerceiveDmInput): Promise<void> {
    try {
        await sendSenderAction(input.senderId, 'typing_on', input.creator.page_access_token, input.pageId);
    } catch (err) {
        log('warn', 'dm.sender_action_failed', { action: 'typing_on', ...describeError(err) });
    }
}

/** A voice note heard for real: the download goes through the same seam as a picture's (`setMediaFetch`), the decoder and the speech model are the real ones. */
const hearLive = (input: VoiceInput): Promise<VoiceResult> => transcribeVoice(input, { download: (link, options) => liveDownload(link, { kind: 'audio', ...options }) });

/** A downloaded picture or video, as what the providers layer takes: the bare base64 and its type. */
function llmMediaOf(source: Extract<Source, { source: 'media' }>): LlmMedia {
    return { kind: source.media.mediaKind === 'video' ? 'video' : 'image', mime: source.media.mime, base64: source.media.bytes.toString('base64') };
}

/** A perception that did not come to be, as a record: the reason is all it says. */
const emptyDraft = (kind: PerceptionKind, status: 'skipped' | 'failed', reason: NonNullable<Perception['reason']>): Draft => ({ v: 1, kind, status, reason, model: '', ms: 0, usd: 0 });

export async function perceiveDm(input: PerceiveDmInput, given: PerceiveDmDeps = {}): Promise<DmReading> {
    const deps: PerceiveDmDeps = { ...overrides, ...given };
    const now = deps.now ?? Date.now;
    const { creator, ref } = input;
    const logBase = { creator_id: creator.id, message_id: input.messageId, kind: ref.kind };
    const readStored = deps.readStored ?? readStoredPerception;
    const store = deps.store ?? storePerception;

    // 1. A retry reuses what an earlier attempt stored.
    if (input.resumed) {
        const stored = await readStored(input.messageId, creator.id);
        if (stored) {
            log('info', 'perception.reused', { ...logBase, status: stored.status, reason: stored.reason });
            return { kind: 'read', perception: stored, reused: true };
        }
    }

    /** Write the record once, with the readable text in the same statement, and give back the one that is stored (ours, or the one that got there first). */
    const keep = async (draft: Draft): Promise<Perception> => {
        const text = draft.status === 'ok' && !input.typed ? perceivedText(draft.kind, draft) : null;
        const stored = (await store({ messageId: input.messageId, creatorId: creator.id, perception: draft, text }))
            ?? (await readStored(input.messageId, creator.id));
        // A row that took neither (it was deleted in between, or the column is not there to read back): the record this attempt made is still what it understood.
        return stored ?? { ...draft, stored_at: new Date(now()).toISOString() };
    };

    // 2. The gate: `voice` for a voice note and `dm_media` for everything else (the gate checks that the pair agrees).
    const gated = await (deps.gate ?? gatePerception)({ creatorId: creator.id, senderId: input.senderId, kind: ref.kind, capability: capabilityOfKind(ref.kind) ?? 'dm_media' });
    if (!gated.ok) {
        if (gated.reason !== 'budget' && gated.reason !== 'no_key') return { kind: 'declined', reason: gated.reason };
        return { kind: 'read', perception: await keep(emptyDraft(ref.kind, 'skipped', gated.reason)), reused: false };
    }

    // 3. The person sees someone is working on it.
    await (deps.typing ?? sendTyping)(input);

    // 4. What to show, and Muse (or, for a voice note, what is said in it). One budget for the whole of it.
    const startedAt = now();
    const deadlineAt = startedAt + STEP_BUDGET_MS;

    /** The key was refused or the account has no credit: the owner is told, once a day. Best effort, and it never holds the customer's line back. */
    const tellOwner = async (kind: 'auth' | 'quota'): Promise<void> => {
        try {
            await (deps.onProviderTrouble ?? tellOwnerProviderTrouble)(creator.id, kind);
        } catch (err) {
            log('warn', 'perception.provider_notice_failed', { creator_id: creator.id, ...describeError(err) });
        }
    };

    let draft: Draft;
    let via: string;
    if (ref.kind === 'audio') {
        // A voice note is heard, not shown: the speech model writes down what was said, and the record is that transcript. The same clock, the same record.
        const heard = await (deps.hear ?? hearLive)({ creatorId: creator.id, link: ref.url, ...(input.keywords ? { keywords: input.keywords } : {}), deadlineAt });
        draft = voiceDraft(heard);
        via = 'voice';
        if (heard.status === 'failed' && heard.errorKind) await tellOwner(heard.errorKind);
    } else {
        const source = await (deps.resolve ?? resolveSource)(ref, {
            creatorId: creator.id, igAccountId: creator.instagram_page_id, pageToken: creator.page_access_token, deadlineAt,
        });
        via = source.source === 'nothing' ? 'none' : source.how;

        if (source.source === 'ready') {
            draft = source.perception;
        } else if (source.source === 'nothing') {
            draft = emptyDraft(ref.kind, source.status, source.reason);
        } else {
            const read = await (deps.perceive ?? perceive)({
                creatorId: creator.id, kind: ref.kind as SeenKind, media: llmMediaOf(source), typed: input.typed, coverOnly: source.how === 'cover',
                caption: source.caption, handle: cleanHandle(input.handle), language: input.language, deadlineAt,
            });
            draft = read.perception;
            if (draft.status === 'ok' && draft.about_owner !== 'personal') {
                // How it was looked at is said in the description, and whose it is is what the code knows, not what the model guessed.
                const owner = ownerAbout(source.owner);
                draft = { ...draft, seen: withHow(source.how, draft.seen ?? '', source.caption !== null), ...(owner ? { about_owner: owner } : {}) };
            }
            if (read.errorKind === 'auth' || read.errorKind === 'quota') await tellOwner(read.errorKind);
        }
    }

    // 5. Stored once.
    const perception = await keep(draft);
    log('info', 'perception.stored', { ...logBase, status: perception.status, reason: perception.reason, via, ms: now() - startedAt });
    return { kind: 'read', perception, reused: false };
}
