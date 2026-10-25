/**
 * A WhatsApp contact asking to be left alone (`optOutWhatsAppContact`, whatsappOptOut.ts: W7 wired in, T044, review C2).
 *
 * `withdrawAll` and `sendWhatsAppReply` are stand-ins that record their calls: what is pinned here is the decision and the order, and each of those is tested where it
 * lives (consent.test.ts for the transaction, send.test.ts for the sender). Nothing here reaches a database or Meta.
 *
 * What is pinned, because each is a way a person who said stop is mistreated:
 *   - the thread is closed the way Instagram's turn closes one (the stage `optOutDecision` names, `last_intent = opt_out`, the bot paused), in the withdrawal's own transaction
 *   - the confirmation goes ONCE: not on a repeat stop, not when the agent may not speak, and in the language of the phrase
 *   - a confirmation that fails never undoes the opt-out, and an opt-out that cannot be written sends nothing
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { WhatsAppSendResult } from '../services/channels/send.js';
import { confirmationText, type WithdrawAllInput, type WithdrawAllOutcome } from '../services/consent.js';
import { optOutDecision } from '../services/dmSales/flow.js';
import { setLogSink } from '../utils/log.js';
import { OPT_OUT_THREAD, optOutWhatsAppContact, type OptOutDeps, type WhatsAppStopInput } from './whatsappOptOut.js';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const BSUID = 'EG.13491208655302741918';

const input = (over: Partial<WhatsAppStopInput> = {}): WhatsAppStopInput => ({
    creatorId: CREATOR, conversationId: 'conv-1', senderId: BSUID, text: 'إيقاف', lang: 'ar', confirm: true, ...over,
});

let withdrawals: WithdrawAllInput[];
let sent: Array<Parameters<OptOutDeps['send']>[0]>;
let outcome: WithdrawAllOutcome;
let sendImpl: OptOutDeps['send'];
let withdrawFails: boolean;
let logs: Array<Record<string, any>>;
let restore: (() => void) | undefined;

const ok: WhatsAppSendResult = { ok: true, wamid: 'wamid.OUT', messageId: 'msg-out' };
const refusal = (reason: Extract<WhatsAppSendResult, { ok: false }>['reason'], over: Partial<Extract<WhatsAppSendResult, { ok: false }>> = {}): WhatsAppSendResult => ({
    ok: false, reason, attempted: false, permanent: true, mayHaveLanded: false, code: null, closesAt: null, detail: 'x', ...over,
});

const deps = (): OptOutDeps => ({
    withdraw: async (i) => { withdrawals.push(i); if (withdrawFails) throw new Error('connection terminated unexpectedly'); return outcome; },
    send: async (i) => { sent.push(i); return sendImpl(i); },
});

beforeEach(() => {
    withdrawals = []; sent = []; withdrawFails = false; logs = [];
    outcome = { consents: [], conversationsNewlyOptedOut: 1, followupsCancelled: 2 };
    sendImpl = async () => ok;
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restore = () => setLogSink(previous);
});
afterEach(() => restore?.());

const logged = (event: string) => logs.filter((l) => l.event === event);

describe('what the stop does to the thread: the same as on Instagram', () => {
    it('closes it with the stage Instagram\'s own opt-out decision names, last_intent opt_out, and the withdrawal\'s transaction carries it', async () => {
        await optOutWhatsAppContact(input(), deps());
        assert.equal(withdrawals.length, 1);
        const w = withdrawals[0]!;
        assert.deepEqual([w.creatorId, w.platform, w.contactRef, w.conversationId, w.wording], [CREATOR, 'whatsapp', BSUID, 'conv-1', 'إيقاف']);
        assert.deepEqual(w.closeThread, { stage: 'closed', lastIntent: 'opt_out' });
    });

    it('takes the stage from optOutDecision, the decision Instagram\'s turn makes for "stop", so the two cannot disagree without a test failing', () => {
        const ig = optOutDecision({ qualifierTurns: 2, abuseStrikes: 1 });
        assert.equal(ig.optOut, true, 'Instagram pauses the bot for exactly decision.optOut');
        assert.equal(OPT_OUT_THREAD.stage, ig.stage);
        assert.equal(OPT_OUT_THREAD.lastIntent, 'opt_out');
    });
});

describe('the confirmation', () => {
    it('is sent ONCE, after a first opt-out, through the sender as the agent\'s own reply, in the words of consent.ts', async () => {
        const out = await optOutWhatsAppContact(input(), deps());
        assert.equal(sent.length, 1);
        assert.deepEqual([sent[0]!.creatorId, sent[0]!.conversationId, sent[0]!.kind, sent[0]!.body], [CREATOR, 'conv-1', 'agent', { text: confirmationText('ar') }]);
        assert.notEqual(sent[0]!.record, false, 'the sender writes the outbound row: this is not a sales turn with a record of its own');
        assert.deepEqual(out, { newlyOptedOut: true, followupsCancelled: 2, confirmation: 'sent' });
    });

    it('is in the language of the phrase: English for «stop», Arabic for «إيقاف»', async () => {
        await optOutWhatsAppContact(input({ text: 'stop', lang: 'en' }), deps());
        await optOutWhatsAppContact(input({ text: 'ايقاف', lang: 'ar' }), deps());
        assert.deepEqual(sent.map((s) => s.body.text), [confirmationText('en'), confirmationText('ar')]);
    });

    it('is NOT sent for a repeat stop: the withdrawal is recorded again and nothing is said a second time', async () => {
        outcome = { consents: [], conversationsNewlyOptedOut: 0, followupsCancelled: 0 };
        const out = await optOutWhatsAppContact(input(), deps());
        assert.equal(withdrawals.length, 1, 'the request is recorded: the history is append-only');
        assert.equal(sent.length, 0);
        assert.deepEqual([out.newlyOptedOut, out.confirmation], [false, 'not_needed']);
    });

    it('is NOT sent when the agent may not speak (switched off, a refused connection, a person has the thread), and the opt-out is recorded all the same', async () => {
        const out = await optOutWhatsAppContact(input({ confirm: false }), deps());
        assert.equal(withdrawals.length, 1);
        assert.equal(sent.length, 0);
        assert.deepEqual([out.newlyOptedOut, out.confirmation], [true, 'not_allowed']);
        assert.equal(logged('wa.optout_confirmation_skipped')[0]?.reason, 'agent_cannot_speak');
    });

    it('that is refused by the sender (a closed window, a refused connection, a billable reply) leaves the opt-out standing and is said in the log', async () => {
        for (const reason of ['window_closed', 'connection_invalid', 'billable_blocked'] as const) {
            sendImpl = async () => refusal(reason);
            const out = await optOutWhatsAppContact(input(), deps());
            assert.equal(out.confirmation, 'failed', reason);
            assert.equal(out.newlyOptedOut, true, reason);
        }
        assert.equal(logged('wa.optout_confirmation_not_sent').length, 3);
        assert.ok(logged('wa.optout_confirmation_not_sent').every((l) => /the opt-out stands/.test(String(l.effect))));
    });

    it('that fails with an error is the same: nothing is thrown, nothing is retried, the opt-out stands', async () => {
        sendImpl = async () => { throw new Error('connection terminated unexpectedly'); };
        const out = await optOutWhatsAppContact(input(), deps());
        assert.deepEqual([out.newlyOptedOut, out.confirmation], [true, 'failed']);
        assert.equal(sent.length, 1, 'tried once');
        assert.equal(logged('wa.optout_confirmation_not_sent')[0]?.level, 'error');
    });
});

describe('an opt-out that cannot be written', () => {
    it('throws, so the job is retried and the stop is not lost, and sends NOTHING', async () => {
        withdrawFails = true;
        await assert.rejects(optOutWhatsAppContact(input(), deps()), /connection terminated/);
        assert.equal(sent.length, 0);
    });
});

describe('what is logged', () => {
    it('says the outcome without the contact\'s id or what they wrote', async () => {
        await optOutWhatsAppContact(input({ text: 'إيقاف من فضلك 0551234567' }), deps());
        const everything = logs.map((l) => JSON.stringify(l)).join('\n');
        for (const secret of [BSUID, '0551234567', 'من فضلك']) assert.ok(!everything.includes(secret), secret);
        assert.deepEqual([logged('wa.opted_out')[0]?.newly, logged('wa.opted_out')[0]?.confirmation], [true, 'sent']);
    });
});
