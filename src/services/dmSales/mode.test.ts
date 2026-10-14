/**
 * Who the sales turn answers (`mode.ts`): off by default, a test list that matches exact ids only, and a read that fails toward the old path.
 *
 * The case that carries the weight is `test` with a sender who is NOT on the list: a looser check ("any id that looks like one", a prefix, a
 * number compared as a number) would put a real customer on the experiment. The mutation that makes `test` answer everyone is in
 * messaging.test.ts, where it is caught through the whole pipeline.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import {
    answersWithSales, DEFAULT_SALES_MODE, isSalesMode, MAX_TEST_SENDERS, parseTestSenders, readSalesSettings, SALES_MODES, salesSettingsOf,
} from './mode.js';

describe('the sales mode', () => {
    it('is off, test or on, and nothing else', () => {
        assert.deepEqual([...SALES_MODES], ['off', 'test', 'on']);
        for (const ok of SALES_MODES) assert.equal(isSalesMode(ok), true);
        for (const bad of ['OFF', 'On', 'yes', '', null, undefined, 1, true, {}]) assert.equal(isSalesMode(bad), false, String(bad));
    });

    it('defaults to off: a row that says nothing is the old path', () => {
        assert.equal(DEFAULT_SALES_MODE, 'off');
        assert.deepEqual(salesSettingsOf(null), { mode: 'off', testSenders: [] });
        assert.deepEqual(salesSettingsOf(undefined), { mode: 'off', testSenders: [] });
        assert.deepEqual(salesSettingsOf({}), { mode: 'off', testSenders: [] });
        assert.deepEqual(salesSettingsOf({ sales_mode: 'sales' as any }), { mode: 'off', testSenders: [] }, 'an unknown mode is off, not on');
    });

    it('reads the list as it is stored: trimmed, text only', () => {
        assert.deepEqual(salesSettingsOf({ sales_mode: 'test', sales_test_senders: [' 123456 ', '', 7 as any, '654321'] }), { mode: 'test', testSenders: ['123456', '654321'] });
        assert.deepEqual(salesSettingsOf({ sales_mode: 'test', sales_test_senders: 'nope' as any }).testSenders, []);
    });
});

describe('answersWithSales: who gets the sales turn', () => {
    const list = ['17841400000000001', '17841400000000002'];

    it('off answers nobody, not even a listed sender', () => {
        assert.equal(answersWithSales({ mode: 'off', testSenders: list }, list[0]!), false);
        assert.equal(answersWithSales({ mode: 'off', testSenders: [] }, 'anyone'), false);
    });

    it('on answers everyone', () => {
        assert.equal(answersWithSales({ mode: 'on', testSenders: [] }, 'anyone'), true);
        assert.equal(answersWithSales({ mode: 'on', testSenders: list }, 'someone-else'), true);
    });

    it('test answers ONLY a listed sender, by exact id', () => {
        const settings = { mode: 'test' as const, testSenders: list };
        assert.equal(answersWithSales(settings, list[0]!), true);
        assert.equal(answersWithSales(settings, list[1]!), true);
        assert.equal(answersWithSales(settings, '17841400000000003'), false, 'another id');
        assert.equal(answersWithSales(settings, '1784140000000000'), false, 'a prefix of one');
        assert.equal(answersWithSales(settings, '178414000000000011'), false, 'one that starts with one');
        assert.equal(answersWithSales(settings, ''), false);
    });

    it('test with an empty list answers nobody', () => {
        assert.equal(answersWithSales({ mode: 'test', testSenders: [] }, '17841400000000001'), false);
    });
});

describe('parseTestSenders: what an operator typed', () => {
    it('takes lines, commas and spaces, trims, and keeps each id once, in order', () => {
        assert.deepEqual(parseTestSenders('12345\n67890, 12345  24680;13579'), { senders: ['12345', '67890', '24680', '13579'] });
        assert.deepEqual(parseTestSenders(['12345', ' 67890 ', '12345']), { senders: ['12345', '67890'] });
    });

    it('takes nothing as an empty list', () => {
        for (const none of [undefined, null, '', '  \n ', []]) assert.deepEqual(parseTestSenders(none), { senders: [] }, String(none));
    });

    it('names an entry that is not an id instead of dropping it: a typo must not quietly leave the test account off the list', () => {
        for (const bad of ['abc', '1234', '12345x', '@someone', 'https://instagram.com/x', '1'.repeat(33), '12.345', '-12345']) {
            const out = parseTestSenders(`12345\n${bad}`);
            assert.ok('error' in out, bad);
            assert.ok(out.error.includes(bad.slice(0, 40)), `names ${bad}: ${out.error}`);
        }
    });

    it('refuses what is neither a string nor a list of strings', () => {
        for (const bad of [5, true, {}, [1, 2], [['12345']]]) assert.ok('error' in parseTestSenders(bad as any), JSON.stringify(bad));
    });

    it('allows at most the handful a test needs', () => {
        const ok = Array.from({ length: MAX_TEST_SENDERS }, (_, i) => String(10000 + i));
        assert.equal((parseTestSenders(ok) as { senders: string[] }).senders.length, MAX_TEST_SENDERS);
        assert.ok('error' in parseTestSenders([...ok, '99999']));
    });
});

describe('readSalesSettings: the read fails toward the old path', () => {
    let original: typeof pool.query;
    let logged: { level: string; event: string }[];
    let restoreSink: () => void;
    beforeEach(() => {
        original = pool.query;
        logged = [];
        const previous = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
        restoreSink = () => { setLogSink(previous); };
    });
    afterEach(() => {
        (pool as any).query = original;
        restoreSink();
    });

    it('reads the mode and the senders of the tenant', async () => {
        const asked: { sql: string; params: any[] }[] = [];
        (pool as any).query = async (sql: string, params: any[]) => {
            asked.push({ sql, params });
            return { rows: [{ sales_mode: 'test', sales_test_senders: ['12345'] }], rowCount: 1 };
        };
        assert.deepEqual(await readSalesSettings('creator-1'), { mode: 'test', testSenders: ['12345'] });
        assert.deepEqual(asked.map((a) => a.params), [['creator-1']]);
        assert.match(asked[0]!.sql, /FROM ai_agents WHERE creator_id = \$1/);
    });

    it('a tenant with no agent row is off', async () => {
        (pool as any).query = async () => ({ rows: [], rowCount: 0 });
        assert.deepEqual(await readSalesSettings('creator-1'), { mode: 'off', testSenders: [] });
    });

    it('a database that has not had v39 yet (the column is missing) is off, and says so in the log', async () => {
        (pool as any).query = async () => { throw Object.assign(new Error('column "sales_mode" does not exist'), { code: '42703' }); };
        assert.deepEqual(await readSalesSettings('creator-1'), { mode: 'off', testSenders: [] });
        assert.deepEqual(logged.map((l) => [l.level, l.event]), [['warn', 'dm.sales_mode_read_failed']]);
    });
});
