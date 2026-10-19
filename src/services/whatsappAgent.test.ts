/**
 * Who the WhatsApp agent answers: the mode, and the test-sender validator that is the WhatsApp channel's own.
 *
 * The validator is separate from `dmSales/mode.ts`' `SENDER_ID` on purpose (review L8): that one is Instagram's settings route's, and widening
 * it would change what that route accepts. The last test here pins that it did not move.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { SENDER_ID, parseTestSenders } from './dmSales/mode.js';
import {
    BSUID, DEFAULT_WHATSAPP_MODE, E164_DIGITS, isWhatsAppMode, isWhatsAppSender, MAX_WHATSAPP_TEST_SENDERS, parseWhatsAppTestSenders,
    readWhatsAppSettings, whatsAppSettingsOf, writeWhatsAppSettings,
} from './whatsappAgent.js';

describe('isWhatsAppSender', () => {
    it('accepts a BSUID: two capitals, a dot, up to 125 letters, digits and dots (a parent id too)', () => {
        for (const id of ['EG.13491208655302741918', 'US.ENT.11815799212886844830', 'SA.abc123', 'EG.1', `EG.${'a'.repeat(125)}`]) {
            assert.ok(BSUID.test(id), id);
            assert.ok(isWhatsAppSender(id), id);
        }
    });

    it('accepts a phone number in E.164 digits, 8 to 15 of them', () => {
        for (const phone of ['20100123456', '966501234567', '12345678', '123456789012345']) assert.ok(E164_DIGITS.test(phone), phone);
    });

    it('refuses everything else, including what Instagram’s validator would take', () => {
        for (const bad of [
            '12345', '1234567', '1234567890123456', '+20100123456', '20 100 123 456', 'eg.12345', 'E.123', 'EGY.123', 'EG.', 'EG.12-34',
            `EG.${'a'.repeat(126)}`, 'EG 123', '', 'abc',
        ]) {
            assert.equal(isWhatsAppSender(bad), false, JSON.stringify(bad));
        }
    });
});

describe('parseWhatsAppTestSenders', () => {
    it('takes a list, trims it and drops duplicates, keeping the order given', () => {
        assert.deepEqual(
            parseWhatsAppTestSenders([' EG.123 ', '20100123456', 'EG.123', '', '  ']),
            { senders: ['EG.123', '20100123456'] }
        );
    });

    it('takes one string separated by commas, spaces, semicolons or lines', () => {
        assert.deepEqual(
            parseWhatsAppTestSenders('EG.123, 20100123456;SA.77\n US.ENT.5 '),
            { senders: ['EG.123', '20100123456', 'SA.77', 'US.ENT.5'] }
        );
    });

    it('reads nothing as an empty list', () => {
        for (const empty of [undefined, null, '', [], '  ']) assert.deepEqual(parseWhatsAppTestSenders(empty), { senders: [] });
    });

    it('names the entry that is not a sender instead of dropping it: a typo must not leave the one test account off the list', () => {
        const r = parseWhatsAppTestSenders(['EG.123', 'oops-not-an-id']);
        assert.ok('error' in r);
        assert.match(r.error, /"oops-not-an-id" is not a WhatsApp sender/);
    });

    it('refuses what is not a list of strings', () => {
        for (const bad of [42, {}, [1, 2], [null], true]) {
            const r = parseWhatsAppTestSenders(bad);
            assert.ok('error' in r, JSON.stringify(bad));
        }
    });

    it('allows 20 and refuses 21', () => {
        const make = (n: number) => Array.from({ length: n }, (_, i) => `EG.${1000 + i}`);
        assert.equal((parseWhatsAppTestSenders(make(MAX_WHATSAPP_TEST_SENDERS)) as { senders: string[] }).senders.length, 20);
        const r = parseWhatsAppTestSenders(make(21));
        assert.ok('error' in r);
        assert.match(r.error, /At most 20/);
    });

    it('counts after deduplication, so a repeated id does not eat the cap', () => {
        assert.equal('error' in parseWhatsAppTestSenders(Array.from({ length: 30 }, () => 'EG.1')), false);
    });
});

describe('the settings a row holds', () => {
    it('reads anything unreadable as off with no senders', () => {
        assert.deepEqual(whatsAppSettingsOf(null), { mode: 'off', testSenders: [] });
        assert.deepEqual(whatsAppSettingsOf({}), { mode: 'off', testSenders: [] });
        assert.deepEqual(whatsAppSettingsOf({ whatsapp_mode: 'sometimes' as never, whatsapp_test_senders: 'EG.1' as never }), { mode: 'off', testSenders: [] });
        assert.equal(DEFAULT_WHATSAPP_MODE, 'off');
    });

    it('reads a saved row', () => {
        assert.deepEqual(
            whatsAppSettingsOf({ whatsapp_mode: 'test', whatsapp_test_senders: [' EG.1 ', 'EG.2', ''] }),
            { mode: 'test', testSenders: ['EG.1', 'EG.2'] }
        );
    });

    it('knows the three modes', () => {
        for (const m of ['off', 'test', 'everyone']) assert.ok(isWhatsAppMode(m));
        for (const m of ['on', 'Test', '', null, undefined, 1]) assert.equal(isWhatsAppMode(m), false);
    });
});

describe('reading and writing the agent row', () => {
    let statements: Array<{ sql: string; params: unknown[] }>;
    let respond: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number };
    const originalQuery = pool.query;

    beforeEach(() => {
        statements = [];
        respond = () => ({ rows: [] });
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            const r = respond(sql, params);
            return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        };
    });
    afterEach(() => { (pool as unknown as { query: unknown }).query = originalQuery; });

    it('answers off for a tenant with no agent row', async () => {
        assert.deepEqual(await readWhatsAppSettings('t-1'), { mode: 'off', testSenders: [] });
        assert.match(statements[0]!.sql, /FROM ai_agents WHERE creator_id = \$1/);
    });

    it('writes with an UPDATE, never an INSERT: picking a WhatsApp mode must not create a half-configured bot', async () => {
        respond = () => ({ rows: [{ whatsapp_mode: 'test', whatsapp_test_senders: ['EG.1'] }] });

        const saved = await writeWhatsAppSettings('t-1', { mode: 'test', testSenders: ['EG.1'] });

        assert.deepEqual(saved, { mode: 'test', testSenders: ['EG.1'] });
        assert.equal(statements.length, 1);
        assert.match(statements[0]!.sql, /^UPDATE ai_agents SET/);
        assert.doesNotMatch(statements[0]!.sql, /INSERT/);
        assert.deepEqual(statements[0]!.params, ['t-1', 'test', ['EG.1']]);
    });

    it('leaves what it is not given alone (null parameters, COALESCEd to the stored value)', async () => {
        respond = () => ({ rows: [{ whatsapp_mode: 'off', whatsapp_test_senders: ['EG.1'] }] });

        await writeWhatsAppSettings('t-1', { mode: 'off' });
        assert.deepEqual(statements[0]!.params, ['t-1', 'off', null]);
        await writeWhatsAppSettings('t-1', { testSenders: [] });
        assert.deepEqual(statements[1]!.params, ['t-1', null, []], 'an explicit empty list clears the senders');
        assert.match(statements[0]!.sql, /COALESCE\(\$2, whatsapp_mode\)/);
    });

    it('answers null when the tenant has no agent row', async () => {
        assert.equal(await writeWhatsAppSettings('t-1', { mode: 'test' }), null);
    });
});

describe('Instagram’s sender validator did not move', () => {
    it('SENDER_ID is still digits only, 5 to 32, and parseTestSenders still refuses a BSUID', () => {
        assert.equal(SENDER_ID.source, '^\\d{5,32}$');
        assert.equal(SENDER_ID.test('EG.13491208655302741918'), false);
        assert.ok('error' in parseTestSenders(['EG.13491208655302741918']));
        assert.deepEqual(parseTestSenders(['17841400000000000']), { senders: ['17841400000000000'] });
    });
});
