/**
 * A tester's file and voice note (`saveInboundFile`, `readInboundMedia`: whatsappMediaInput.ts; WhatsApp agent T035, T036, review M17).
 *
 * The download, the transcription, the sender, the profile and the owner's switch are stand-ins that record their calls, and the database is a recorder that answers by SQL
 * and throws for a statement nobody expected: what is pinned is the DECISION and the ORDER, and each stand-in's real self is tested where it lives (whatsappMedia.test.ts,
 * transcribe.test.ts, send.test.ts). Nothing here reaches Postgres, Meta or Groq.
 *
 * What is pinned, because each is a way a person is mistreated or a rationed free tier is burnt:
 *   - a file is saved PRIVATELY and linked to its row; a retried message does not download it again
 *   - a voice note is transcribed once, in Arabic, free tier only; the transcript is the row's text; a retry does not transcribe again
 *   - a voice note that cannot be read gets exactly ONE line asking for text, whatever the reason (a Groq 429 included), and nothing is retried
 *   - a file with no caption gets the kit's line once per burst, claimed first and sent after; a caption is just words
 *   - the owner's switch is honoured before anything is spent, and no transcript, caption or token is ever logged
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import type { WhatsAppSendResult } from '../services/channels/send.js';
import { kitFor } from '../services/profile/kits.js';
import type { ProfileContext } from '../services/profile/context.js';
import type { TranscribeResult } from '../services/transcribe.js';
import type { SaveInboundMediaResult } from '../services/whatsappMedia.js';
import { setLogSink } from '../utils/log.js';
import { ATTACHMENT_ACK_TYPE, WORDLESS_MESSAGE_TYPES } from './attachments.js';
import { CLAIM_ACK } from './attachmentAck.js';
import {
    acknowledgeInbound, reasonOfSend, readInboundMedia, saveInboundFile, WHATSAPP_WORDLESS_MESSAGE_TYPES, type AcknowledgeInput, type MediaDeps, type ReadMediaInput, type SaveFileInput,
} from './whatsappMediaInput.js';
import type { WaMedia } from './whatsapp.js';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const PHONE_ID = '106540352242922';
const TOKEN = 'EAAGwhatsapp-system-user-token-0123456789';
const TRANSCRIPT = 'كم سعر الخطة وهل يناسب المبتدئين';
const CAPTION = 'my secret receipt caption';

const VOICE: WaMedia = { kind: 'audio', id: 'MEDIA-VOICE-1', mime: 'audio/ogg; codecs=opus', voice: true };
const PHOTO: WaMedia = { kind: 'image', id: 'MEDIA-PHOTO-1', mime: 'image/jpeg' };
const GULF = { code: 'ar', register: 'gulf' } as const;
const LINE = kitFor(GULF).attachments.media;

let statements: Array<{ sql: string; params: any[] }>;
let logs: Array<Record<string, any>>;
let rows: { media_upload_id: string | null; text: string };
let claimRefused: boolean;
let order: string[];
let restore: (() => void) | undefined;
const originalQuery = pool.query;

let saved: Array<Parameters<MediaDeps['save']>[0]>;
let transcribed: Array<Parameters<MediaDeps['transcribe']>[0]>;
let sent: Array<Parameters<MediaDeps['send']>[0]>;
let tokenImpl: MediaDeps['token'];
let saveImpl: () => Promise<SaveInboundMediaResult>;
let transcribeImpl: () => Promise<TranscribeResult>;
let sendImpl: () => Promise<WhatsAppSendResult>;
let agentOn: boolean;

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const ok = (over: Partial<Extract<WhatsAppSendResult, { ok: true }>> = {}): WhatsAppSendResult => ({ ok: true, wamid: 'wamid.OUT1', messageId: null, ...over });
const refused = (reason: Extract<WhatsAppSendResult, { ok: false }>['reason'], over: Partial<Extract<WhatsAppSendResult, { ok: false }>> = {}): WhatsAppSendResult => ({
    ok: false, reason, attempted: false, permanent: true, mayHaveLanded: false, code: null, closesAt: null, detail: 'x', ...over,
});

const deps = (): MediaDeps => ({
    token: (id) => tokenImpl(id),
    save: async (i) => { saved.push(i); return saveImpl(); },
    transcribe: async (i) => { order.push('transcribe'); transcribed.push(i); return transcribeImpl(); },
    send: async (i) => { order.push('send'); sent.push(i); return sendImpl(); },
    profile: async () => ({ language: GULF }) as unknown as ProfileContext<'dm'>,
    agentSpeaks: async () => agentOn,
});

beforeEach(() => {
    statements = []; logs = []; saved = []; transcribed = []; sent = []; order = [];
    rows = { media_upload_id: null, text: '' };
    claimRefused = false; agentOn = true;
    tokenImpl = async () => TOKEN;
    saveImpl = async () => ({ ok: true, uploadId: 'upload-1', mimeType: 'audio/ogg', bytes: 1234 });
    transcribeImpl = async () => ({ ok: true, text: `  ${TRANSCRIPT}  `, provider: 'groq', model: 'whisper-large-v3-turbo' });
    sendImpl = async () => ok();
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restore = () => setLogSink(previous);
    (pool as any).query = async (sqlIn: string, params: any[] = []) => {
        const sql = norm(sqlIn);
        statements.push({ sql, params });
        const result = (r: any[], rowCount = r.length) => ({ rows: r, rowCount });
        if (sql === 'SELECT media_upload_id FROM messages WHERE id = $1') return result([{ media_upload_id: rows.media_upload_id }]);
        if (sql === 'SELECT text FROM messages WHERE id = $1') return result([{ text: rows.text }]);
        if (sql === 'UPDATE messages SET media_upload_id = $2 WHERE id = $1') { rows.media_upload_id = params[1]; return result([], 1); }
        if (sql === 'UPDATE messages SET text = $2 WHERE id = $1') { rows.text = params[1]; return result([], 1); }
        if (sql === norm(CLAIM_ACK)) { order.push('claim'); return claimRefused ? result([]) : result([{ id: 'ack-1' }]); }
        if (sql === 'DELETE FROM messages WHERE id = $1') { order.push('unclaim'); return result([], 1); }
        if (sql === 'UPDATE messages SET meta_message_id = $2 WHERE id = $1 AND meta_message_id IS NULL') return result([], 1);
        if (sql === 'UPDATE conversations SET ai_disclosed_at = NOW() WHERE id = $1') return result([], 1);
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
});
afterEach(() => {
    restore?.();
    (pool as any).query = originalQuery;
});

const logged = (event: string) => logs.filter((l) => l.event === event);
const everythingLogged = () => logs.map((l) => JSON.stringify(l)).join('\n');
const sql = (prefix: string) => statements.filter((s) => s.sql.startsWith(prefix));

const fileInput = (over: Partial<SaveFileInput> = {}): SaveFileInput => ({ creatorId: CREATOR, messageId: 'msg-1', phoneNumberId: PHONE_ID, media: VOICE, resumed: false, ...over });
const readInput = (over: Partial<ReadMediaInput> = {}): ReadMediaInput => ({
    creatorId: CREATOR, conversationId: 'conv-1', messageId: 'msg-1', kind: 'voice', media: VOICE, caption: '', saved: { uploadId: 'upload-1', mimeType: 'audio/ogg' },
    resumed: false, aiDisclosedAt: new Date(), ...over,
});

describe('saveInboundFile: the file, private, once', () => {
    it('downloads with the connection\'s token for the number the message came in on, and links the upload to its row', async () => {
        const out = await saveInboundFile(deps())(fileInput());
        assert.deepEqual(out, { uploadId: 'upload-1', mimeType: 'audio/ogg' });
        assert.deepEqual(saved, [{ creatorId: CREATOR, phoneNumberId: PHONE_ID, token: TOKEN, mediaId: 'MEDIA-VOICE-1', mime: 'audio/ogg; codecs=opus' }]);
        assert.deepEqual(sql('UPDATE messages SET media_upload_id')[0]!.params, ['msg-1', 'upload-1']);
        assert.equal(rows.media_upload_id, 'upload-1');
    });

    it('is no file at all, and says so, for a message with no media id, no number to ask Meta with, or a connection with no usable token', async () => {
        assert.equal(await saveInboundFile(deps())(fileInput({ media: null })), null);
        assert.equal(await saveInboundFile(deps())(fileInput({ phoneNumberId: null })), null);
        tokenImpl = async () => { throw new Error(`Meta refused ${TOKEN}`); };
        assert.equal(await saveInboundFile(deps())(fileInput()), null);
        assert.deepEqual(saved, [], 'nothing was downloaded');
        assert.deepEqual(logged('wa.media_not_saved').map((l) => l.reason), ['no_media_id', 'no_phone_number_id', 'no_token']);
        assert.ok(!everythingLogged().includes(TOKEN), 'the token is never logged, even inside an error\'s words');
    });

    it('is no file when the download fails (too large, expired, an unsupported type), and the row is not linked to anything', async () => {
        for (const reason of ['too_large', 'not_found', 'unsupported_type', 'download_failed'] as const) {
            saveImpl = async () => ({ ok: false, reason, retryable: reason === 'download_failed' });
            assert.equal(await saveInboundFile(deps())(fileInput()), null, reason);
        }
        assert.equal(sql('UPDATE messages SET media_upload_id').length, 0);
        assert.deepEqual(logged('wa.media_not_saved').map((l) => l.reason), ['too_large', 'not_found', 'unsupported_type', 'download_failed']);
    });

    it('does not download again for a retried message whose row already holds the file', async () => {
        rows.media_upload_id = 'upload-from-attempt-1';
        const out = await saveInboundFile(deps())(fileInput({ resumed: true }));
        assert.deepEqual(out, { uploadId: 'upload-from-attempt-1', mimeType: 'audio/ogg' });
        assert.deepEqual(saved, [], 'no second copy of a customer\'s file');
        assert.equal(sql('UPDATE messages SET media_upload_id').length, 0);
    });

    it('downloads for a retried message whose first attempt got no file, and a first delivery never asks the row', async () => {
        await saveInboundFile(deps())(fileInput({ resumed: true }));
        assert.equal(saved.length, 1);
        statements.length = 0;
        await saveInboundFile(deps())(fileInput());
        assert.equal(sql('SELECT media_upload_id').length, 0);
    });

    it('lets a failure to link the row throw: the retry downloads again and links that copy', async () => {
        const failing = (pool as any).query;
        (pool as any).query = async (s: string, p: any[]) => { if (norm(s).startsWith('UPDATE messages SET media_upload_id')) throw new Error('connection terminated unexpectedly'); return failing(s, p); };
        await assert.rejects(saveInboundFile(deps())(fileInput()), /connection terminated/);
    });
});

describe('readInboundMedia: a caption is words', () => {
    it('is the message, as typed: no check of the owner\'s switch, no line, no query', async () => {
        const out = await readInboundMedia(deps())(readInput({ kind: 'media', media: PHOTO, caption: CAPTION, saved: null }));
        assert.deepEqual(out, { kind: 'text', text: CAPTION });
        assert.deepEqual([sent.length, transcribed.length, statements.length], [0, 0, 0]);
    });
});

describe('readInboundMedia: a voice note', () => {
    it('is transcribed from the saved file in Arabic on the free tier, stored as the row\'s text, and is the words the agent answers', async () => {
        const out = await readInboundMedia(deps())(readInput());
        assert.deepEqual(out, { kind: 'text', text: TRANSCRIPT }, 'trimmed');
        assert.deepEqual(transcribed, [{ creatorId: CREATOR, uploadId: 'upload-1', mime: 'audio/ogg', languageHint: 'ar', allowPaid: false }]);
        assert.deepEqual(sql('UPDATE messages SET text')[0]!.params, ['msg-1', TRANSCRIPT]);
        assert.equal(rows.text, TRANSCRIPT);
        assert.equal(sent.length, 0, 'it was understood: nothing to apologise for');
    });

    it('never logs what was said', async () => {
        await readInboundMedia(deps())(readInput());
        assert.ok(!everythingLogged().includes(TRANSCRIPT));
        await readInboundMedia(deps())(readInput({ kind: 'media', media: PHOTO, caption: CAPTION }));
        assert.ok(!everythingLogged().includes(CAPTION));
    });

    it('does not transcribe a retried message again: the transcript is in the row', async () => {
        rows.text = TRANSCRIPT;
        const out = await readInboundMedia(deps())(readInput({ resumed: true }));
        assert.deepEqual(out, { kind: 'text', text: TRANSCRIPT });
        assert.equal(transcribed.length, 0, 'a rationed free tier is not spent twice on one voice note');
    });

    it('transcribes a retried message whose first attempt got nowhere (the placeholder is not a transcript)', async () => {
        rows.text = '[voice note]';
        await readInboundMedia(deps())(readInput({ resumed: true }));
        assert.equal(transcribed.length, 1);
    });

    for (const why of ['rate_limited', 'timeout', 'provider_unavailable', 'unsupported_media', 'empty', 'upload_missing', 'too_large', 'failed'] as const) {
        it(`that could not be read (${why}) gets exactly ONE line asking for text, once, and no retry: the agent is not asked`, async () => {
            transcribeImpl = async () => ({ ok: false, reason: why });
            const out = await readInboundMedia(deps())(readInput());
            assert.deepEqual(out, { kind: 'concluded', reason: null }, 'the line went out: the customer was answered');
            assert.equal(sent.length, 1, 'ONE line');
            assert.equal(transcribed.length, 1, 'one call to the provider: a 429 is a failure, not a retry storm');
            assert.equal(logged('wa.voice_unreadable')[0]?.reason, why);
            assert.equal(sql('UPDATE messages SET text').length, 0, 'no transcript was stored');
        });
    }

    it('with no file at all (the download failed, or Meta gave no id) is the same line, and the provider is never called', async () => {
        const out = await readInboundMedia(deps())(readInput({ saved: null }));
        assert.deepEqual(out, { kind: 'concluded', reason: null });
        assert.equal(sent.length, 1);
        assert.equal(transcribed.length, 0);
        assert.equal(logged('wa.voice_unreadable')[0]?.reason, 'no_file');
    });

    it('is said in the persona kit\'s own words, as the agent\'s reply: claimed first, sent after, with the wamid attached and no row written by the sender', async () => {
        await readInboundMedia(deps())(readInput({ saved: null, aiDisclosedAt: new Date() }));
        assert.deepEqual(order, ['claim', 'send']);
        const claim = sql('INSERT INTO messages')[0]!;
        assert.deepEqual(claim.params.slice(0, 4), ['conv-1', CREATOR, ATTACHMENT_ACK_TYPE, LINE]);
        assert.deepEqual(JSON.parse(claim.params[5]), { engine: 'rule', reply: ATTACHMENT_ACK_TYPE, kind: 'audio', channel: 'whatsapp' });
        assert.deepEqual([claim.params[6], claim.params[7]], ['msg-1', WHATSAPP_WORDLESS_MESSAGE_TYPES]);
        assert.deepEqual(sent, [{ creatorId: CREATOR, conversationId: 'conv-1', kind: 'agent', record: false, body: { text: LINE } }]);
        assert.deepEqual(sql('UPDATE messages SET meta_message_id')[0]!.params, ['ack-1', 'wamid.OUT1']);
    });
});

describe('readInboundMedia: a file with no caption', () => {
    it('gets the one line the kit says for a message with no words, claimed with Instagram\'s own statement, and the agent is not asked', async () => {
        const out = await readInboundMedia(deps())(readInput({ kind: 'media', media: PHOTO, saved: { uploadId: 'upload-p', mimeType: 'image/jpeg' } }));
        assert.deepEqual(out, { kind: 'concluded', reason: null });
        assert.equal(transcribed.length, 0);
        assert.equal(sent[0]!.body.text, LINE);
        assert.equal(sql('INSERT INTO messages')[0]!.sql, norm(CLAIM_ACK), 'the same text as Instagram\'s: once per burst, never over words, never twice in a day');
        assert.equal(JSON.parse(sql('INSERT INTO messages')[0]!.params[5]).kind, 'image');
    });

    it('is a document\'s kind "file", as Instagram names it', async () => {
        await readInboundMedia(deps())(readInput({ kind: 'media', media: { kind: 'document', id: 'D1', mime: 'application/pdf' } }));
        assert.equal(JSON.parse(sql('INSERT INTO messages')[0]!.params[5]).kind, 'file');
    });

    it('says nothing when the claim is refused (a later message is waiting, words are being answered, or it asked within a day): superseded, no send', async () => {
        claimRefused = true;
        const out = await readInboundMedia(deps())(readInput({ kind: 'media', media: PHOTO }));
        assert.deepEqual(out, { kind: 'concluded', reason: 'superseded' });
        assert.equal(sent.length, 0);
        assert.equal(logged('wa.media_ack_skipped').length, 1);
    });
});

describe('the one line that cannot be sent', () => {
    it('takes the claim back and says why on the row: a closed window, a billable reply nobody allowed, a refused connection, anything else', async () => {
        const cases: Array<[Extract<WhatsAppSendResult, { ok: false }>['reason'], string]> = [
            ['window_closed', 'window_closed'], ['billable_blocked', 'billable_blocked'], ['connection_invalid', 'connection_invalid'], ['rejected', 'failure'], ['send_failed', 'failure'],
        ];
        for (const [reason, expected] of cases) {
            order.length = 0;
            sendImpl = async () => refused(reason);
            const out = await readInboundMedia(deps())(readInput({ kind: 'media', media: PHOTO }));
            assert.deepEqual(out, { kind: 'concluded', reason: expected }, reason);
            assert.deepEqual(order, ['claim', 'send', 'unclaim'], 'nothing was said, so nothing may say that something was');
        }
    });

    it('keeps the claim when the send MAY HAVE LANDED, so a retry never says it twice', async () => {
        sendImpl = async () => refused('send_failed', { attempted: true, mayHaveLanded: true, permanent: false });
        const out = await readInboundMedia(deps())(readInput({ kind: 'media', media: PHOTO }));
        assert.deepEqual(out, { kind: 'concluded', reason: 'failure' });
        assert.deepEqual(order, ['claim', 'send']);
    });

    it('takes the claim back and throws when our own database fails before a request left, so the retry says it once', async () => {
        sendImpl = async () => { throw new Error('connection terminated unexpectedly'); };
        await assert.rejects(readInboundMedia(deps())(readInput({ kind: 'media', media: PHOTO })), /connection terminated/);
        assert.deepEqual(order, ['claim', 'send', 'unclaim']);
    });

    it('maps the sender\'s refusals to the reasons the inbound row uses', () => {
        assert.equal(reasonOfSend(refused('window_closed') as any), 'window_closed');
        assert.equal(reasonOfSend(refused('undeliverable') as any), 'failure');
    });
});

describe('the owner\'s switch and the automated-service line', () => {
    it('an agent the owner switched off says nothing and spends nothing: no transcription, no line', async () => {
        agentOn = false;
        for (const input of [readInput(), readInput({ kind: 'media', media: PHOTO })]) {
            assert.deepEqual(await readInboundMedia(deps())(input), { kind: 'concluded', reason: 'agent_off' });
        }
        assert.deepEqual([transcribed.length, sent.length, sql('INSERT INTO messages').length], [0, 0, 0]);
    });

    it('puts the disclosure in front of the line when it is the first thing said here, in the same message, and records that it was said', async () => {
        await readInboundMedia(deps())(readInput({ saved: null, aiDisclosedAt: null }));
        assert.equal(sent.length, 1);
        assert.match(sent[0]!.body.text, new RegExp(`^.+\\n${LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 's'));
        assert.ok(sent[0]!.body.text.length > LINE.length);
        assert.equal(JSON.parse(sql('INSERT INTO messages')[0]!.params[4]).text, LINE, 'the row stores what the bot said, not the disclosure that travelled with it');
        assert.equal(sql('UPDATE conversations SET ai_disclosed_at').length, 1);
    });

    it('says no disclosure when the thread already has one, and does not stamp it again', async () => {
        await readInboundMedia(deps())(readInput({ saved: null, aiDisclosedAt: new Date() }));
        assert.equal(sent[0]!.body.text, LINE);
        assert.equal(sql('UPDATE conversations SET ai_disclosed_at').length, 0);
    });
});

// ─── A sticker, a location, a contact card ───────────────────────────────────────────────────

const ackInput = (over: Partial<AcknowledgeInput> = {}): AcknowledgeInput => ({ creatorId: CREATOR, conversationId: 'conv-1', messageId: 'msg-1', what: 'sticker', aiDisclosedAt: new Date(), ...over });

describe('acknowledgeInbound: the one line for a sticker, a location or a contact card', () => {
    for (const what of ['sticker', 'location', 'contacts'] as const) {
        it(`${what}: the kit's own line, claimed first and sent after through the WhatsApp transport, with its wamid attached; NULL on the row because it went out`, async () => {
            const out = await acknowledgeInbound(deps())(ackInput({ what }));
            assert.equal(out, null, 'the line went out: the customer was answered');
            assert.deepEqual(order, ['claim', 'send']);
            const claim = sql('INSERT INTO messages')[0]!;
            assert.equal(claim.sql, norm(CLAIM_ACK), 'Instagram\'s own statement: once per burst, never over words, never twice in a day');
            assert.deepEqual(claim.params.slice(0, 4), ['conv-1', CREATOR, ATTACHMENT_ACK_TYPE, LINE]);
            assert.deepEqual(JSON.parse(claim.params[5]), { engine: 'rule', reply: ATTACHMENT_ACK_TYPE, kind: what, channel: 'whatsapp' });
            assert.deepEqual(sent, [{ creatorId: CREATOR, conversationId: 'conv-1', kind: 'agent', record: false, body: { text: LINE } }]);
            assert.deepEqual(sql('UPDATE messages SET meta_message_id')[0]!.params, ['ack-1', 'wamid.OUT1']);
            assert.deepEqual([saved.length, transcribed.length], [0, 0], 'nothing is downloaded and nothing is transcribed');
        });
    }

    it('counts a location and a contact card as word-less in the claim, so a sticker and a location in one burst are not "words being answered" and a second card the same day is not answered again', async () => {
        await acknowledgeInbound(deps())(ackInput({ what: 'location' }));
        const types = sql('INSERT INTO messages')[0]!.params[7] as string[];
        assert.deepEqual([...types], [...WORDLESS_MESSAGE_TYPES, 'location', 'contacts']);
        assert.ok(types.includes('sticker') && types.includes('location') && types.includes('contacts'));
        assert.ok(!types.includes('text'), 'typed words are still words');
    });

    it('says nothing when the claim is refused (a later message is waiting, words are being answered, or it asked within a day): superseded, no send', async () => {
        claimRefused = true;
        const out = await acknowledgeInbound(deps())(ackInput({ what: 'contacts' }));
        assert.equal(out, 'superseded');
        assert.equal(sent.length, 0);
        assert.equal(logged('wa.media_ack_skipped')[0]?.kind, 'contacts');
    });

    it('an agent the owner switched off says nothing and spends nothing: no claim, no line', async () => {
        agentOn = false;
        assert.equal(await acknowledgeInbound(deps())(ackInput()), 'agent_off');
        assert.deepEqual([sent.length, sql('INSERT INTO messages').length], [0, 0]);
    });

    it('takes the claim back and says why on the row when the line cannot be sent: a closed window, a billable reply nobody allowed, a refused connection, anything else', async () => {
        const cases: Array<[Extract<WhatsAppSendResult, { ok: false }>['reason'], string]> = [
            ['window_closed', 'window_closed'], ['billable_blocked', 'billable_blocked'], ['connection_invalid', 'connection_invalid'], ['rejected', 'failure'],
        ];
        for (const [reason, expected] of cases) {
            order.length = 0;
            sendImpl = async () => refused(reason);
            assert.equal(await acknowledgeInbound(deps())(ackInput()), expected, reason);
            assert.deepEqual(order, ['claim', 'send', 'unclaim']);
        }
    });

    it('keeps the claim when the send MAY HAVE LANDED, and takes it back and throws when our own database fails before a request left', async () => {
        sendImpl = async () => refused('send_failed', { attempted: true, mayHaveLanded: true, permanent: false });
        assert.equal(await acknowledgeInbound(deps())(ackInput()), 'failure');
        assert.deepEqual(order, ['claim', 'send']);

        order.length = 0;
        sendImpl = async () => { throw new Error('connection terminated unexpectedly'); };
        await assert.rejects(acknowledgeInbound(deps())(ackInput()), /connection terminated/);
        assert.deepEqual(order, ['claim', 'send', 'unclaim']);
    });

    it('puts the disclosure in front of the line when it is the first thing said here, and never logs what was sent', async () => {
        await acknowledgeInbound(deps())(ackInput({ aiDisclosedAt: null }));
        assert.ok(sent[0]!.body.text.length > LINE.length && sent[0]!.body.text.endsWith(LINE));
        assert.equal(sql('UPDATE conversations SET ai_disclosed_at').length, 1);
        assert.ok(!everythingLogged().includes(LINE));
    });
});
