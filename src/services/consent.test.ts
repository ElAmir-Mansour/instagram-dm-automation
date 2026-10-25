/**
 * Consent rows and the stop-phrase matcher (src/services/consent.ts; review C2 of docs/specs/001-whatsapp-agent).
 *
 * `pool.query` and `pool.connect` are stubbed and record the SQL. What is pinned: the table is only ever INSERTed into (append-only), every
 * statement is scoped to the tenant, `withdrawAll` is ONE transaction on ONE client that writes all three categories, stamps
 * `conversations.opted_out_at` and cancels the pending follow-ups, and the matcher fires on the WHOLE message and nothing else.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import {
    CONSENT_CATEGORIES, confirmationText, currentConsent, isStopMessage, matchStopMessage, normaliseStopText, recordConsent, withdrawAll,
} from './consent.js';

const CREATOR = '11111111-1111-1111-1111-111111111111';
const BSUID = 'EG.13491208655302741918';

type Asked = { via: 'pool' | 'client'; sql: string; params: any[] };

const original = { query: pool.query, connect: pool.connect };
let asked: Asked[];
let released: number;
/** Throws for any statement whose text starts with this, to prove the rollback. */
let failOn: string | null;
let optedOutRowCount: number;
let cancelledRowCount: number;
let latest: any[];

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function answer(via: 'pool' | 'client', sqlIn: string, params: any[] = []) {
    const sql = norm(sqlIn);
    asked.push({ via, sql, params });
    if (failOn && sql.startsWith(failOn)) throw new Error('connection terminated unexpectedly');
    if (sql.startsWith('INSERT INTO contact_consents')) {
        const [creator_id, conversation_id, platform, contact_ref, category, action, source, wording, at] = params;
        return { rows: [{ id: `row-${asked.length}`, creator_id, conversation_id, platform, contact_ref, category, action, source, wording, created_at: at ?? new Date('2026-10-19T12:00:00Z') }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE conversations')) return { rows: [], rowCount: optedOutRowCount };
    if (sql.startsWith('UPDATE jobs')) return { rows: [], rowCount: cancelledRowCount };
    if (sql.startsWith('SELECT action, source, wording, created_at FROM contact_consents')) return { rows: latest, rowCount: latest.length };
    return { rows: [], rowCount: 0 };
}

beforeEach(() => {
    asked = []; released = 0; failOn = null; optedOutRowCount = 1; cancelledRowCount = 0; latest = [];
    (pool as any).query = async (sql: string, params?: any[]) => answer('pool', sql, params);
    (pool as any).connect = async () => ({ query: async (sql: string, params?: any[]) => answer('client', sql, params), release: () => { released++; } });
});
afterEach(() => {
    (pool as any).query = original.query;
    (pool as any).connect = original.connect;
    // Append-only, whatever a test did: nothing in this file's run may have changed or removed a consent row.
    assert.deepEqual(asked.filter((a) => /^(UPDATE|DELETE)\b.*\bcontact_consents\b/.test(a.sql)), []);
});

describe('recordConsent', () => {
    it('appends ONE row with an INSERT and nothing else, and returns it', async () => {
        const row = await recordConsent({
            creatorId: CREATOR, conversationId: 'conv-1', platform: 'whatsapp', contactRef: BSUID, category: 'updates', action: 'granted', source: 'agent_offer',
            wording: '  Want order updates here? Reply yes.  ',
        });
        assert.equal(asked.length, 1);
        assert.match(asked[0]!.sql, /^INSERT INTO contact_consents \(creator_id, conversation_id, platform, contact_ref, category, action, source, wording, created_at\)/);
        assert.deepEqual(asked[0]!.params, [CREATOR, 'conv-1', 'whatsapp', BSUID, 'updates', 'granted', 'agent_offer', 'Want order updates here? Reply yes.', null]);
        assert.equal(row.action, 'granted');
        assert.equal(row.contact_ref, BSUID);
    });

    it('dates the row with clock_timestamp() so two rows of one transaction keep their order, or with the source\'s own time', async () => {
        await recordConsent({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID, category: 'marketing', action: 'withdrawn', source: 'owner' });
        assert.match(asked[0]!.sql, /COALESCE\(\$9::timestamptz, clock_timestamp\(\)\)/);
        const at = new Date('2026-10-01T09:00:00Z');
        await recordConsent({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID, category: 'marketing', action: 'granted', source: 'user_preferences', at });
        assert.equal(asked[1]!.params[8], at);
    });

    it('keeps no conversation and no wording as NULL, and bounds a long wording', async () => {
        await recordConsent({ creatorId: CREATOR, platform: 'instagram', contactRef: '17841', category: 'service', action: 'granted', source: 'owner', wording: '   ' });
        assert.deepEqual([asked[0]!.params[1], asked[0]!.params[7]], [null, null]);
        await recordConsent({ creatorId: CREATOR, platform: 'instagram', contactRef: '17841', category: 'service', action: 'granted', source: 'owner', wording: 'x'.repeat(5000) });
        assert.equal(asked[1]!.params[7].length, 2000);
    });

    it('refuses a value the CHECK constraints would refuse, before the database does', async () => {
        const base = { creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID, category: 'marketing', action: 'granted', source: 'owner' } as const;
        await assert.rejects(recordConsent({ ...base, category: 'promotions' as any }), /unknown category/);
        await assert.rejects(recordConsent({ ...base, action: 'revoked' as any }), /unknown action/);
        await assert.rejects(recordConsent({ ...base, source: 'guess' as any }), /unknown source/);
        await assert.rejects(recordConsent({ ...base, contactRef: ' ' }), /contactRef is required/);
        await assert.rejects(recordConsent({ ...base, creatorId: '' }), /creatorId is required/);
        assert.equal(asked.length, 0);
    });

    it('writes inside the caller\'s transaction when given its client', async () => {
        const seen: string[] = [];
        const client = { query: async (sql: string) => { seen.push(norm(sql)); return { rows: [{ id: 'r' }], rowCount: 1 } as any; } };
        await recordConsent({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID, category: 'service', action: 'granted', source: 'owner' }, client);
        assert.equal(seen.length, 1);
        assert.equal(asked.length, 0, 'it must not have gone through the pool');
    });
});

describe('currentConsent', () => {
    it('reads the newest row for (creator, contact, category): one statement, newest first, scoped to the tenant', async () => {
        latest = [{ action: 'withdrawn', source: 'stop_phrase', wording: 'إيقاف', created_at: new Date('2026-10-19T10:00:00Z') }];
        const state = await currentConsent(CREATOR, BSUID, 'marketing');
        assert.equal(asked.length, 1);
        assert.match(asked[0]!.sql, /WHERE creator_id = \$1 AND contact_ref = \$2 AND category = \$3 ORDER BY created_at DESC LIMIT 1$/);
        assert.deepEqual(asked[0]!.params, [CREATOR, BSUID, 'marketing']);
        assert.deepEqual(state, { action: 'withdrawn', source: 'stop_phrase', wording: 'إيقاف', at: new Date('2026-10-19T10:00:00Z') });
    });

    it('is null, not "withdrawn", when nothing was ever recorded', async () => {
        assert.equal(await currentConsent(CREATOR, BSUID, 'updates'), null);
    });
});

describe('withdrawAll', () => {
    it('is ONE transaction on ONE client: three withdrawn rows, opted_out_at, the follow-ups, then COMMIT', async () => {
        cancelledRowCount = 2;
        const out = await withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID, conversationId: 'conv-1', wording: 'إيقاف' });

        assert.ok(asked.every((a) => a.via === 'client'), 'every statement goes through the transaction\'s client, never the pool');
        assert.deepEqual(asked.map((a) => a.sql.split(' ').slice(0, 3).join(' ')), [
            'BEGIN', 'INSERT INTO contact_consents', 'INSERT INTO contact_consents', 'INSERT INTO contact_consents', 'UPDATE conversations SET', 'UPDATE jobs SET', 'COMMIT',
        ]);
        const inserts = asked.filter((a) => a.sql.startsWith('INSERT'));
        assert.deepEqual(inserts.map((a) => a.params[4]), [...CONSENT_CATEGORIES]);
        assert.deepEqual(CONSENT_CATEGORIES, ['service', 'updates', 'marketing']);
        for (const insert of inserts) {
            assert.deepEqual([insert.params[0], insert.params[1], insert.params[2], insert.params[3], insert.params[5], insert.params[6], insert.params[7]],
                [CREATOR, 'conv-1', 'whatsapp', BSUID, 'withdrawn', 'stop_phrase', 'إيقاف']);
        }
        assert.equal(released, 1);
        assert.equal(out.consents.length, 3);
        assert.equal(out.conversationsNewlyOptedOut, 1);
        assert.equal(out.followupsCancelled, 2);
    });

    it('stamps opted_out_at on this tenant\'s thread with this contact on this platform, and only once', async () => {
        await withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID });
        const update = asked.find((a) => a.sql.startsWith('UPDATE conversations'))!;
        assert.match(update.sql, /SET opted_out_at = NOW\(\)/);
        assert.match(update.sql, /WHERE creator_id = \$1 AND instagram_user_id = \$2 AND \(platform = \$3 OR \(platform IS NULL AND \$3 = 'instagram'\)\) AND opted_out_at IS NULL$/);
        assert.deepEqual(update.params, [CREATOR, BSUID, 'whatsapp']);
    });

    it('cancels only this tenant\'s PENDING dm.followup jobs addressed to this contact', async () => {
        await withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID });
        const jobs = asked.find((a) => a.sql.startsWith('UPDATE jobs'))!;
        assert.match(jobs.sql, /SET status = 'cancelled'/);
        assert.match(jobs.sql, /WHERE kind = 'dm\.followup' AND status = 'pending' AND creator_id = \$1 AND payload->>'senderId' = \$2$/);
        assert.deepEqual(jobs.params, [CREATOR, BSUID]);
    });

    it('a repeat stop reports no newly opted-out thread, so no second confirmation goes out, and still records the request', async () => {
        optedOutRowCount = 0;
        const out = await withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID });
        assert.equal(out.conversationsNewlyOptedOut, 0);
        assert.equal(out.consents.length, 3);
    });

    it('rolls EVERYTHING back when the stamp fails: no COMMIT, the client is released, the error reaches the caller', async () => {
        failOn = 'UPDATE conversations';
        await assert.rejects(withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID }), /connection terminated/);
        const verbs = asked.map((a) => a.sql.split(' ')[0]);
        assert.ok(verbs.includes('ROLLBACK'));
        assert.ok(!verbs.includes('COMMIT'));
        assert.equal(released, 1);
    });

    it('rolls back when a consent insert fails, before anything is stamped', async () => {
        failOn = 'INSERT INTO contact_consents';
        await assert.rejects(withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID }), /connection terminated/);
        assert.ok(!asked.some((a) => a.sql.startsWith('UPDATE')));
        assert.ok(!asked.some((a) => a.sql === 'COMMIT'));
    });

    it('closes the thread in the SAME transaction when asked (closeThread): the bot paused, the stage and the intent, for this tenant\'s thread on this platform', async () => {
        await withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID, closeThread: { stage: 'closed', lastIntent: 'opt_out' } });
        assert.ok(asked.every((a) => a.via === 'client'));
        assert.deepEqual(asked.map((a) => a.sql.split(' ').slice(0, 3).join(' ')), [
            'BEGIN', 'INSERT INTO contact_consents', 'INSERT INTO contact_consents', 'INSERT INTO contact_consents', 'UPDATE conversations SET', 'UPDATE conversations SET', 'UPDATE jobs SET', 'COMMIT',
        ]);
        const close = asked.filter((a) => a.sql.startsWith('UPDATE conversations'))[1]!;
        assert.match(close.sql, /SET is_bot_active = FALSE, stage = \$4, last_intent = \$5 WHERE creator_id = \$1 AND instagram_user_id = \$2 AND \(platform = \$3 OR \(platform IS NULL AND \$3 = 'instagram'\)\)$/);
        assert.deepEqual(close.params, [CREATOR, BSUID, 'whatsapp', 'closed', 'opt_out']);
        assert.doesNotMatch(close.sql, /opted_out_at/, 'the stamp is the first statement\'s, and only for a thread not yet opted out');
    });

    it('pauses the thread even when it was opted out before (a second stop after the owner switched the bot back on), where the stamp is left alone', async () => {
        optedOutRowCount = 0;
        await withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID, closeThread: { stage: 'closed', lastIntent: 'opt_out' } });
        assert.ok(asked.some((a) => /SET is_bot_active = FALSE/.test(a.sql)), 'the pause does not depend on the stamp being new');
    });

    it('writes nothing about the thread\'s state without closeThread: the statement list is what it was', async () => {
        await withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID });
        assert.ok(!asked.some((a) => /is_bot_active|last_intent/.test(a.sql)));
    });

    it('rolls EVERYTHING back when the close fails: a withdrawal never stands without the pause', async () => {
        failOn = 'UPDATE conversations SET is_bot_active';
        await assert.rejects(withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID, closeThread: { stage: 'closed', lastIntent: 'opt_out' } }), /connection terminated/);
        const verbs = asked.map((a) => a.sql.split(' ')[0]);
        assert.ok(verbs.includes('ROLLBACK'));
        assert.ok(!verbs.includes('COMMIT'));
        assert.equal(released, 1);
    });

    it('takes the source from the caller and refuses an unknown one or an empty contact', async () => {
        await withdrawAll({ creatorId: CREATOR, platform: 'instagram', contactRef: '17841', source: 'owner' });
        assert.ok(asked.filter((a) => a.sql.startsWith('INSERT')).every((a) => a.params[6] === 'owner'));
        asked = [];
        await assert.rejects(withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: '' }), /contactRef is required/);
        await assert.rejects(withdrawAll({ creatorId: CREATOR, platform: 'whatsapp', contactRef: BSUID, source: 'guess' as any }), /unknown source/);
        assert.equal(asked.length, 0, 'nothing is opened for a call that cannot succeed');
    });
});

describe('isStopMessage: the whole message is a stop phrase', () => {
    const stops: [string, string][] = [
        // Arabic, as listed
        ['إيقاف', 'ar'], ['ايقاف', 'ar'], ['وقف', 'ar'], ['ستوب', 'ar'], ['إلغاء الاشتراك', 'ar'], ['الغاء الاشتراك', 'ar'], ['لا ترسل', 'ar'], ['لا ترسلوا', 'ar'], ['توقف', 'ar'],
        // English, as listed
        ['stop', 'en'], ['unsubscribe', 'en'], ['stop messages', 'en'], ['opt out', 'en'], ['cancel subscription', 'en'],
    ];
    for (const [text, lang] of stops) {
        it(`fires on "${text}" and says ${lang}`, () => {
            assert.equal(isStopMessage(text), true);
            assert.deepEqual(matchStopMessage(text)?.lang, lang);
        });
    }

    it('survives how people really type it: case, spacing, punctuation, emoji, tatweel, diacritics, direction marks', () => {
        for (const text of [
            'STOP', 'Stop.', '  stop  ', 'stop!!!', 'Stop 🛑', '🛑 STOP', '"stop"', 'Unsubscribe', 'opt-out', 'Opt Out', 'STOP   MESSAGES', 'stop\nmessages', 'Cancel Subscription.',
            'إيـــقـــاف', 'إيقاف!!', 'إيقاف.', 'وَقْف', 'وقف 🙏', '«وقف»', 'توقّف', 'لا ترسل.', 'لا  ترسلوا', 'الغاء الاشتراك؟', 'ستوب!',
            '‏إيقاف‏', '‫وقف‬', 'stop​',
        ]) {
            assert.equal(isStopMessage(text), true, JSON.stringify(text));
        }
    });

    it('does NOT fire when the phrase is only part of the message (review C2: never a substring)', () => {
        for (const text of [
            'عايز إلغاء الطلب', 'موقف', 'ممكن توقف شوي وتشرح', 'وقفت السيارة', 'اتوقف الاشتراك عندي', 'ابغى ايقاف الخصم من البطاقة', 'لا ترسل لي العرض الثاني',
            "don't stop", 'stop by tomorrow?', 'nonstop', 'stop messaging me about the discount please', 'I want to unsubscribe from the newsletter',
            'how do I opt out of the newsletter', 'cancel my subscription', 'stop stop stop', 'stopwatch', 'unsubscribed', 'تم ايقاف الخدمه',
        ]) {
            assert.equal(isStopMessage(text), false, JSON.stringify(text));
        }
    });

    it('does not fire on a word that merely contains one, in either script', () => {
        for (const text of ['موقف', 'موقفي', 'توقفت', 'وقفنا', 'استوب', 'ستوبات', 'bus stop', 'stopped', 'stops', 'ايقافه']) {
            assert.equal(isStopMessage(text), false, JSON.stringify(text));
        }
    });

    it('does not fire on a bare «إلغاء» or "cancel": they cancel an order as often as a subscription', () => {
        assert.equal(isStopMessage('إلغاء'), false);
        assert.equal(isStopMessage('cancel'), false);
    });

    it('does not fire on anything that is not a sentence of words', () => {
        for (const text of ['', ' ', '🛑', '!!!', '...', '👍', '123']) assert.equal(isStopMessage(text), false, JSON.stringify(text));
        for (const notText of [null, undefined, 0, 7, {}, [], ['stop'], true]) assert.equal(isStopMessage(notText as any), false);
    });

    it('does not fire on a long message that starts or ends with the phrase', () => {
        assert.equal(isStopMessage('stop ' + 'word '.repeat(60)), false);
        assert.equal(isStopMessage('إيقاف ' + 'كلمة '.repeat(60)), false);
        assert.equal(isStopMessage('x'.repeat(10_000)), false);
    });

    it('can be limited to one language', () => {
        assert.equal(isStopMessage('stop', 'en'), true);
        assert.equal(isStopMessage('stop', 'ar'), false);
        assert.equal(isStopMessage('وقف', 'ar'), true);
        assert.equal(isStopMessage('وقف', 'en'), false);
    });

    it('compares the normalised forms: the same entry however it is spelled', () => {
        assert.equal(normaliseStopText('إيــقــاف'), normaliseStopText('ايقاف'));
        assert.equal(normaliseStopText(' Stop!! '), 'stop');
        assert.equal(normaliseStopText('‏لا ترسل‏'), 'لا ترسل');
    });
});

describe('confirmationText', () => {
    it('is one plain line in each language that says no more messages and that they can write again', () => {
        const ar = confirmationText('ar');
        const en = confirmationText('en');
        for (const line of [ar, en]) {
            assert.ok(!line.includes('\n'));
            assert.ok(line.length > 20 && line.length < 200);
            assert.ok(!/\p{Extended_Pictographic}/u.test(line), 'no emoji');
        }
        assert.match(ar, /[؀-ۿ]/);
        assert.match(ar, /أوقفنا/);
        assert.match(ar, /ما راح توصلك/);
        assert.match(ar, /اكتب لنا في أي وقت/);
        assert.match(en, /won't get any more messages/);
        assert.match(en, /write to us again anytime/);
    });

    it('is not itself a stop message (a confirmation that echoed "stop" would loop)', () => {
        assert.equal(isStopMessage(confirmationText('ar')), false);
        assert.equal(isStopMessage(confirmationText('en')), false);
    });
});
