/**
 * What a listed tester sends that is not typed words: a voice note, a photo, a video, a PDF (WhatsApp agent: docs/specs/001-whatsapp-agent T035 and T036, review M17;
 * the services it calls are `whatsappMedia.ts` for the file and `transcribe.ts` for the voice).
 *
 * `whatsappInbound.ts` decides WHO and WHETHER (a test sender, and, for the second step, an agent that may answer at all); this file does the two steps of "what did they send":
 *
 *   1. `saveInboundFile`   the file, saved PRIVATELY (`media_uploads.is_private`) as soon as the job has it, because Meta keeps it 7 days and the URL it hands out lives 5
 *                          minutes. It is saved in every mode for a tester (their messages are stored in full), and for NOBODY ELSE: a stranger's file is never downloaded, which is
 *                          the handler's gate and not this file's. `messages.media_upload_id` points at it, so the erasure flow finds it with the contact
 *   2. `readInboundMedia`  what the agent reads, only when it may answer:
 *        a voice note      transcribed (Groq: a provider that does not train on what it is sent; language `ar`), the transcript stored as the row's `text`, and the turn runs on it.
 *                          If the file or the transcription fails, for ANY reason (no file, a download that failed, a format the provider refuses, a Groq 429, silence), the customer
 *                          gets ONE short line asking them to write it (FR-009: never ignored). Nothing is retried: a 429 is a failure, and a rationed free tier is not a loop
 *        a photo, video or document WITH a caption     the caption is the message (review M17): the turn runs on it, as typed text. The model does not see the image
 *        the same WITHOUT one     the one line Instagram sends for a message with no words (`kit.attachments.media`: "I can't open that here, write your question"), claimed with
 *                          Instagram's own statement (`CLAIM_ACK`, `attachmentAck.ts`): once per burst, never over words they are still being answered for, never twice in a day.
 *                          Never silent, and never a model asked to answer "[photo]"
 *
 * What is not a file and not words either (`acknowledgeInbound`, WhatsApp follow-up 2): a sticker, a location, a contact card. The agent cannot read them and has no media to save
 * (nothing is downloaded), but the chat must not go silent on a tester, so they get the SAME kit line a photo gets, through the same claim and the same transport. Instagram says
 * nothing for a sticker (a thumbs-up is not a question); on WhatsApp a sticker is often the whole message, so there it is answered once, like the rest. A stranger's never gets here:
 * `whatsappInbound.ts` decides `not_test_sender` first.
 *
 * The line for a voice note that could not be read is the SAME kit line as for a photo: it already says "photos, voice notes and clips" and "write your question", in the owner's
 * register, so there is one wording per persona and no second set of copy to keep in step with it.
 *
 * ## Retried jobs do not transcribe twice
 *
 * A job that runs again (a database error later in the turn) finds the row it already wrote: `media_upload_id` set means the file is saved (not downloaded again), a stored transcript
 * means the voice note is read (not sent to Groq again). Only a retry of a message whose first attempt got no transcript asks again.
 *
 * Nothing here logs a transcript, a caption, a file name, a URL or a token: a log line carries ids, sizes, a reason.
 */
import { queryCount, queryOne } from '../db/query.js';
import { decideAgent } from '../services/ai.js';
import { attachWamid, sendWhatsAppReply, type WhatsAppSendResult } from '../services/channels/send.js';
import { loadAgent } from '../services/dmSales/store.js';
import { profileContextOrLegacy, type ProfileContext } from '../services/profile/context.js';
import { kitFor } from '../services/profile/kits.js';
import { transcribeAudio } from '../services/transcribe.js';
import { baseMime, saveInboundMedia } from '../services/whatsappMedia.js';
import { getAccessToken } from '../services/whatsappConnections.js';
import { describeError, log } from '../utils/log.js';
import { ATTACHMENT_ACK_TYPE, WORDLESS_MESSAGE_TYPES, WORDLESS_PLACEHOLDERS } from './attachments.js';
import { CLAIM_ACK } from './attachmentAck.js';
import { applyDisclosure, disclosureLine } from './meta-payload.js';
import { needsDisclosure } from './messaging.js';
import type { WaMedia } from './whatsapp.js';
import type { NoReplyReason } from './whatsappAnswer.js';

/** A file of the customer's, saved: the private upload's id and the type Meta said it is. */
export interface SavedFile {
    uploadId: string;
    mimeType: string;
}

/**
 * The language of a voice note's transcript is a HINT, not a rule: Whisper still reads English, and the owner's customers speak Arabic. A wrong hint costs accuracy, not a failure.
 * Paid transcription (OpenAI) is off until the owner has a setting for it (`whatsapp.allow_paid_ai`, T033's free-only rule), so the free Groq tier is the only one used.
 */
const TRANSCRIBE_LANGUAGE = 'ar';
const ALLOW_PAID_TRANSCRIPTION = false;

/** What WhatsApp sends that is neither typed words nor a file the agent reads, and is answered with the one line: a sticker, a location, a contact card (`messages.message_type`). */
export type WordlessInbound = 'sticker' | 'location' | 'contacts';

/**
 * The `message_type`s the claim statement (`CLAIM_ACK`) treats as "no words": Instagram's list plus the two WhatsApp types that are never words. Without them a location row would
 * read as "words still being answered" (so a sticker and a location in one burst would each skip the line, and the chat would go silent) and as "they wrote something since the
 * last line" (so a second location would be answered again the same day).
 */
export const WHATSAPP_WORDLESS_MESSAGE_TYPES: readonly string[] = [...WORDLESS_MESSAGE_TYPES, 'location', 'contacts'];

export interface MediaDeps {
    /** The connection's token, or a throw when there is none or Meta refused it. */
    token(creatorId: string): Promise<string>;
    save: typeof saveInboundMedia;
    transcribe: typeof transcribeAudio;
    send: typeof sendWhatsAppReply;
    profile(creatorId: string): Promise<ProfileContext<'dm'>>;
    /** The owner's own switch (`ai_agents.is_active`): off or unconfigured, the agent says nothing. */
    agentSpeaks(creatorId: string): Promise<boolean>;
}

const LIVE: MediaDeps = {
    token: async (creatorId) => (await getAccessToken(creatorId)).accessToken,
    save: saveInboundMedia,
    transcribe: transcribeAudio,
    send: sendWhatsAppReply,
    profile: (creatorId) => profileContextOrLegacy(creatorId, 'dm'),
    agentSpeaks: async (creatorId) => decideAgent(await loadAgent(creatorId), false).speak,
};

// ─── 1. The file ────────────────────────────────────────────────────────────────────────

export interface SaveFileInput {
    creatorId: string;
    /** The inbound `messages` row the file belongs to. */
    messageId: string;
    /** The number the message arrived on: Meta answers only for a file that belongs to it. */
    phoneNumberId: string | null;
    /** Null for a voice note with no media id: there is nothing to save. */
    media: WaMedia | null;
    /** This is a retry of a message an earlier attempt claimed: the row may already hold its file. */
    resumed: boolean;
}

/** Save the customer's file privately, and link it to its row. A tester's file only: the caller's gate. Null when there is no file to be had. A database failure throws, so the job is retried. */
export type SaveFileFn = (input: SaveFileInput) => Promise<SavedFile | null>;

export const saveInboundFile = (deps: MediaDeps = LIVE): SaveFileFn => async (input) => {
    const logBase = { creator_id: input.creatorId, message_id: input.messageId };
    const { media } = input;
    if (!media) {
        log('info', 'wa.media_not_saved', { ...logBase, reason: 'no_media_id' });
        return null;
    }

    if (input.resumed) {
        const row = await queryOne<{ media_upload_id: string | null }>('SELECT media_upload_id FROM messages WHERE id = $1', [input.messageId]);
        if (row?.media_upload_id) return { uploadId: row.media_upload_id, mimeType: baseMime(media.mime) };
    }
    if (!input.phoneNumberId) {
        log('warn', 'wa.media_not_saved', { ...logBase, reason: 'no_phone_number_id' });
        return null;
    }

    let token: string;
    try {
        token = await deps.token(input.creatorId);
    } catch (err) {
        // A connection Meta refused: the file cannot be fetched (and the message is stored all the same, with its media id in the raw event). The error's own words are
        // not logged: the token is the one secret in reach of this line.
        log('warn', 'wa.media_not_saved', { ...logBase, reason: 'no_token', error: err instanceof Error ? err.name : 'unknown' });
        return null;
    }

    const saved = await deps.save({ creatorId: input.creatorId, phoneNumberId: input.phoneNumberId, token, mediaId: media.id, mime: media.mime });
    if (!saved.ok) {
        // `saveInboundMedia` already said why, without the token or the URL.
        log('warn', 'wa.media_not_saved', { ...logBase, reason: saved.reason, retryable: saved.retryable });
        return null;
    }
    // The link is what lets the erasure flow find the file with the contact. A failure here throws: the retry downloads again and links the new copy.
    await queryCount('UPDATE messages SET media_upload_id = $2 WHERE id = $1', [input.messageId, saved.uploadId]);
    return { uploadId: saved.uploadId, mimeType: saved.mimeType };
};

// ─── 2. What the agent reads ────────────────────────────────────────────────────────────

export interface ReadMediaInput {
    creatorId: string;
    conversationId: string;
    /** The inbound row. */
    messageId: string;
    /** `voice`: a voice note (or any audio) to transcribe. `media`: a photo, a video or a document. */
    kind: 'voice' | 'media';
    media: WaMedia | null;
    /** What the customer wrote on a photo, video or document; '' for nothing. */
    caption: string;
    /** `saveInboundFile`'s answer for this message. */
    saved: SavedFile | null;
    resumed: boolean;
    /** `conversations.ai_disclosed_at`, for the one line this may send. */
    aiDisclosedAt: Date | string | null;
}

export type MediaReading =
    /** Words the turn runs on: the transcript, or the caption. */
    | { kind: 'text'; text: string }
    /** Handled here, and the turn does not run: `reason` is what the row says (NULL when the one line went out). */
    | { kind: 'concluded'; reason: NoReplyReason | null };

export type ReadMediaFn = (input: ReadMediaInput) => Promise<MediaReading>;

/** What the one line needs to know: the thread, the inbound row it answers, and whether the thread has been told it is an automated service yet. */
type AckTarget = Pick<ReadMediaInput, 'creatorId' | 'conversationId' | 'messageId' | 'aiDisclosedAt'>;

export interface AcknowledgeInput extends AckTarget {
    /** Which of the three it is: the log's and the row's `kind`. */
    what: WordlessInbound;
}

/** The reason the row says: NULL when the one line went out. */
export type AcknowledgeFn = (input: AcknowledgeInput) => Promise<NoReplyReason | null>;

/** The row's reason for a line that could not be sent: the same words the agent's own sends use. */
export function reasonOfSend(sent: Extract<WhatsAppSendResult, { ok: false }>): NoReplyReason {
    switch (sent.reason) {
        case 'window_closed': return 'window_closed';
        case 'billable_blocked': return 'billable_blocked';
        case 'connection_invalid': return 'connection_invalid';
        default: return 'failure';
    }
}

export const readInboundMedia = (deps: MediaDeps = LIVE): ReadMediaFn => async (input) => {
    const logBase = { creator_id: input.creatorId, conversation_id: input.conversationId };

    // A caption is words, and is answered as typed words (review M17). Nothing to fetch, nothing to say.
    if (input.kind === 'media' && input.caption.trim() !== '') return { kind: 'text', text: input.caption };

    // The owner's own switch, before anything is spent: a transcription is a call to Groq, and a line is a message in his name.
    if (!(await deps.agentSpeaks(input.creatorId))) {
        log('debug', 'wa.media_agent_off', logBase);
        return { kind: 'concluded', reason: 'agent_off' };
    }

    if (input.kind === 'voice') {
        const heard = await transcribeVoice(input, deps);
        if (heard.ok) return { kind: 'text', text: heard.text };
        log('info', 'wa.voice_unreadable', { ...logBase, reason: heard.why });
        return acknowledge(input, deps, 'audio');
    }
    return acknowledge(input, deps, input.media?.kind === 'document' ? 'file' : input.media?.kind ?? 'attachment');
};

/**
 * The one line for a sticker, a location or a contact card from a tester whom the agent may answer (`whatsappInbound.ts` has already asked who, the mode, the connection and
 * whether a person has the thread). The owner's own switch first, as for every other line; then the kit's line through the claim and the transport of `acknowledge`: once per burst,
 * never over words, never twice in a day, `no_reply_reason` NULL when it went out.
 */
export const acknowledgeInbound = (deps: MediaDeps = LIVE): AcknowledgeFn => async (input) => {
    const logBase = { creator_id: input.creatorId, conversation_id: input.conversationId };
    if (!(await deps.agentSpeaks(input.creatorId))) {
        log('debug', 'wa.media_agent_off', logBase);
        return 'agent_off';
    }
    return (await acknowledge(input, deps, input.what)).reason;
};

/** The words of a voice note, or why there are none. Never throws for a provider or a file: only the database can. */
async function transcribeVoice(input: ReadMediaInput, deps: MediaDeps): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
    if (input.resumed) {
        // The first attempt may have got as far as the transcript: it is the row's text, and Groq is not asked again for it.
        const row = await queryOne<{ text: string | null }>('SELECT text FROM messages WHERE id = $1', [input.messageId]);
        const stored = row?.text?.trim() ?? '';
        if (stored !== '' && stored !== WORDLESS_PLACEHOLDERS.audio) return { ok: true, text: stored };
    }
    if (!input.saved) return { ok: false, why: 'no_file' };

    const out = await deps.transcribe({
        creatorId: input.creatorId, uploadId: input.saved.uploadId, mime: input.saved.mimeType, languageHint: TRANSCRIBE_LANGUAGE, allowPaid: ALLOW_PAID_TRANSCRIPTION,
    });
    if (!out.ok) return { ok: false, why: out.reason };

    const text = out.text.trim();
    if (text === '') return { ok: false, why: 'empty' };
    // The transcript IS the message from here on: the history the model reads, and a retry, find it in the row.
    await queryCount('UPDATE messages SET text = $2 WHERE id = $1', [input.messageId, text]);
    return { ok: true, text };
}

/**
 * The one line for a message the agent cannot read, claimed first and sent after, exactly as Instagram's acknowledgement is (`attachmentAck.ts`): the claim is the outbound
 * row, inserted only when no later message is waiting, no words are being answered and it has not asked already; a send that fails for good takes the claim back, and a send
 * that MAY have landed keeps it, so no retry says it twice.
 */
async function acknowledge(input: AckTarget, deps: MediaDeps, kind: string): Promise<Extract<MediaReading, { kind: 'concluded' }>> {
    const logBase = { creator_id: input.creatorId, conversation_id: input.conversationId };
    const ctx = await deps.profile(input.creatorId);
    const line = kitFor(ctx.language).attachments.media;

    const claimed = await queryOne<{ id: string }>(CLAIM_ACK, [
        input.conversationId, input.creatorId, ATTACHMENT_ACK_TYPE, line, JSON.stringify({ text: line }),
        JSON.stringify({ engine: 'rule', reply: ATTACHMENT_ACK_TYPE, kind, channel: 'whatsapp' }),
        input.messageId, WHATSAPP_WORDLESS_MESSAGE_TYPES,
    ]);
    if (!claimed) {
        // A later message of theirs is waiting, or words are being answered, or the line was said already and they have typed nothing since.
        log('info', 'wa.media_ack_skipped', { ...logBase, kind });
        return { kind: 'concluded', reason: 'superseded' };
    }

    const unclaim = async (): Promise<void> => {
        try {
            await queryCount('DELETE FROM messages WHERE id = $1', [claimed.id]);
        } catch (err) {
            log('error', 'wa.media_unclaim_failed', { ...logBase, message_id: claimed.id, ...describeError(err) });
        }
    };

    // The automated-service line goes in front of the words when this is the first thing said here, never as a bubble of its own.
    const disclose = needsDisclosure(input.aiDisclosedAt);
    const text = disclose ? applyDisclosure({ text: line }, disclosureLine(ctx.language.code)).payload.text ?? line : line;

    let sent: WhatsAppSendResult;
    try {
        sent = await deps.send({ creatorId: input.creatorId, conversationId: input.conversationId, kind: 'agent', record: false, body: { text } });
    } catch (err) {
        // Our own failure before a request left (the database): nothing was said, so the claim must not stay behind to make the retry "already asked".
        await unclaim();
        throw err;
    }
    if (!sent.ok) {
        if (!sent.mayHaveLanded) await unclaim();
        log('warn', 'wa.media_ack_not_sent', { ...logBase, kind, reason: sent.reason, may_have_landed: sent.mayHaveLanded });
        return { kind: 'concluded', reason: reasonOfSend(sent) };
    }

    await attachWamid(claimed.id, sent.wamid);
    log('info', 'wa.media_ack_sent', { ...logBase, kind, disclosed: disclose });
    if (disclose) {
        try {
            await queryCount('UPDATE conversations SET ai_disclosed_at = NOW() WHERE id = $1', [input.conversationId]);
        } catch (err) {
            // The line is out: a failed stamp only means the next reply says the disclosure again.
            log('warn', 'wa.disclosure_not_recorded', { ...logBase, ...describeError(err) });
        }
    }
    return { kind: 'concluded', reason: null };
}
