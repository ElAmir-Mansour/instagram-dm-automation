/**
 * Meta's `user_preferences` webhook as a consent row (src/services/consentPreferences.ts), against the published sample
 * (src/webhook/__fixtures__/whatsapp/user-preferences.json: a `resume`; Meta publishes no `stop` sample, so that one is the same payload with the value flipped).
 *
 * `pool.query` is stubbed and records the SQL. What is pinned: stop is `withdrawn`, resume is `granted`, both are `marketing` with source
 * `user_preferences`; the row is keyed by the BSUID and dated by Meta's timestamp, never in the future; the opt-out of the conversation is NOT
 * set; a preference the module does not know is counted and never written.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { handleUserPreference } from './consentPreferences.js';

const CREATOR = '22222222-2222-2222-2222-222222222222';
const NOW = Date.parse('2026-10-19T12:00:00Z');
const fixture = JSON.parse(readFileSync(new URL('../webhook/__fixtures__/whatsapp/user-preferences.json', import.meta.url), 'utf8'));
const FIXTURE_VALUE = fixture.entry[0].changes[0].value;
const FIXTURE_USER_ID = 'US.13491208655302741918';
const FIXTURE_TIME = new Date(1731705721 * 1000);

const original = { query: pool.query };
let asked: { sql: string; params: any[] }[];
let threads: any[];

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const inserts = () => asked.filter((a) => a.sql.startsWith('INSERT INTO contact_consents'));

beforeEach(() => {
    asked = []; threads = [];
    (pool as any).query = async (sqlIn: string, params: any[] = []) => {
        const sql = norm(sqlIn);
        asked.push({ sql, params });
        if (sql.startsWith('SELECT id, instagram_user_id FROM conversations')) return { rows: threads, rowCount: threads.length };
        if (sql.startsWith('INSERT INTO contact_consents')) {
            const [creator_id, conversation_id, platform, contact_ref, category, action, source, wording, created_at] = params;
            return { rows: [{ id: `row-${asked.length}`, creator_id, conversation_id, platform, contact_ref, category, action, source, wording, created_at }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    };
});
afterEach(() => {
    (pool as any).query = original.query;
    // Whatever a case did, a marketing preference never touches the conversation or an existing consent row.
    assert.deepEqual(asked.filter((a) => /^(UPDATE|DELETE)\b/.test(a.sql)), []);
});

const preference = (over: Record<string, unknown> = {}) => ({
    wa_id: '16505551234', user_id: FIXTURE_USER_ID, detail: 'User requested to stop marketing messages', category: 'marketing_messages', value: 'stop', timestamp: 1731705721, ...over,
});

describe('handleUserPreference', () => {
    it('turns the published resume sample into a granted marketing row from user_preferences, keyed by the BSUID and dated by Meta', async () => {
        const out = await handleUserPreference(CREATOR, FIXTURE_VALUE, NOW);
        assert.equal(out.ignored, 0);
        assert.equal(out.recorded.length, 1);
        assert.equal(inserts().length, 1);
        assert.deepEqual(inserts()[0]!.params, [
            CREATOR, null, 'whatsapp', FIXTURE_USER_ID, 'marketing', 'granted', 'user_preferences', 'User requested to resume marketing messages', FIXTURE_TIME,
        ]);
    });

    it('turns a stop into a withdrawn marketing row', async () => {
        const out = await handleUserPreference(CREATOR, { user_preferences: [preference()] }, NOW);
        assert.deepEqual(out.recorded.map((r) => [r.category, r.action, r.source, r.contact_ref, r.platform]), [['marketing', 'withdrawn', 'user_preferences', FIXTURE_USER_ID, 'whatsapp']]);
        assert.equal(out.recorded[0]!.wording, 'User requested to stop marketing messages');
    });

    it('takes the wa.event payload as well as the bare change, with the same result', async () => {
        const viaPayload = await handleUserPreference(CREATOR, { kind: 'preference', entryId: 'WABA', phoneNumberId: 'PN', change: { user_preferences: [preference()] } }, NOW);
        const bare = await handleUserPreference(CREATOR, { user_preferences: [preference()] }, NOW);
        assert.deepEqual(viaPayload.recorded.map((r) => [r.action, r.contact_ref]), bare.recorded.map((r) => [r.action, r.contact_ref]));
        assert.equal(inserts().length, 2);
    });

    it('never writes any category but marketing, and never an UPDATE: it does not opt the conversation out', async () => {
        await handleUserPreference(CREATOR, { user_preferences: [preference(), preference({ value: 'resume' })] }, NOW);
        assert.ok(inserts().every((i) => i.params[4] === 'marketing'));
        assert.equal(asked.filter((a) => a.sql.includes('opted_out_at')).length, 0);
    });

    it('records each preference of one event, in order', async () => {
        const out = await handleUserPreference(CREATOR, { user_preferences: [
            preference({ value: 'stop', timestamp: 1731705000 }), preference({ value: 'resume', timestamp: 1731705700 }),
        ] }, NOW);
        assert.deepEqual(out.recorded.map((r) => r.action), ['withdrawn', 'granted']);
        assert.deepEqual(inserts().map((i) => i.params[8]), [new Date(1731705000 * 1000), new Date(1731705700 * 1000)]);
    });

    it('links the row to the contact\'s thread when there is one', async () => {
        threads = [{ id: 'conv-9', instagram_user_id: FIXTURE_USER_ID }];
        await handleUserPreference(CREATOR, { user_preferences: [preference()] }, NOW);
        const lookup = asked.find((a) => a.sql.startsWith('SELECT id, instagram_user_id FROM conversations'))!;
        assert.match(lookup.sql, /WHERE creator_id = \$1 AND platform = 'whatsapp' AND \(instagram_user_id = ANY\(\$2::text\[\]\) OR wa_phone = ANY\(\$2::text\[\]\)\)/);
        assert.deepEqual(lookup.params, [CREATOR, [FIXTURE_USER_ID, '16505551234']]);
        assert.equal(inserts()[0]!.params[1], 'conv-9');
    });

    it('with no BSUID, keys the row by the thread found through the phone, else by the phone digits so a stop is never dropped', async () => {
        threads = [{ id: 'conv-3', instagram_user_id: 'EG.77' }];
        await handleUserPreference(CREATOR, { user_preferences: [preference({ user_id: undefined })] }, NOW);
        assert.deepEqual([inserts()[0]!.params[1], inserts()[0]!.params[3]], ['conv-3', 'EG.77']);

        threads = [];
        await handleUserPreference(CREATOR, { user_preferences: [preference({ user_id: undefined })] }, NOW);
        assert.deepEqual([inserts()[1]!.params[1], inserts()[1]!.params[3]], [null, '16505551234']);
    });

    it('keys by the BSUID when the thread is keyed by it, and by nobody else\'s id when two threads match', async () => {
        threads = [{ id: 'conv-phone', instagram_user_id: 'OTHER' }, { id: 'conv-bsuid', instagram_user_id: FIXTURE_USER_ID }];
        await handleUserPreference(CREATOR, { user_preferences: [preference()] }, NOW);
        assert.deepEqual([inserts()[0]!.params[1], inserts()[0]!.params[3]], ['conv-bsuid', FIXTURE_USER_ID]);
    });

    it('dates the row by Meta\'s timestamp, clamped to now, and by arrival when the timestamp is unusable', async () => {
        await handleUserPreference(CREATOR, { user_preferences: [
            preference({ timestamp: 1731705721 }), preference({ timestamp: Math.floor(NOW / 1000) + 86_400 }), preference({ timestamp: '1731705721' }),
            preference({ timestamp: 'soon' }), preference({ timestamp: undefined }), preference({ timestamp: -5 }),
        ] }, NOW);
        assert.deepEqual(inserts().map((i) => i.params[8]), [FIXTURE_TIME, new Date(NOW), FIXTURE_TIME, null, null, null]);
    });

    it('counts and skips what it cannot apply: another category, another value, no id for the person', async () => {
        const out = await handleUserPreference(CREATOR, { user_preferences: [
            preference({ category: 'utility_messages' }), preference({ value: 'interested' }), preference({ value: undefined }),
            preference({ user_id: undefined, wa_id: undefined }), preference({ user_id: '  ', wa_id: '' }), 'not an object', null,
            preference({ value: 'STOP ', timestamp: 1731705721 }),
        ] }, NOW);
        assert.equal(out.recorded.length, 1, 'only the last one is valid: the value is trimmed and case-folded');
        assert.equal(out.recorded[0]!.action, 'withdrawn');
        assert.equal(out.ignored, 5);
        assert.equal(inserts().length, 1);
    });

    it('uses Meta\'s own wording, or names the preference when there is none', async () => {
        await handleUserPreference(CREATOR, { user_preferences: [preference({ detail: undefined })] }, NOW);
        assert.equal(inserts()[0]!.params[7], 'marketing_messages: stop');
    });

    it('does nothing, and does not throw, for an event with no preferences or one that is not an object', async () => {
        for (const event of [undefined, null, 'x', 5, {}, { user_preferences: [] }, { user_preferences: 'stop' }, { kind: 'preference', change: null }]) {
            const out = await handleUserPreference(CREATOR, event, NOW);
            assert.deepEqual([out.recorded.length, out.ignored], [0, 0]);
        }
        assert.equal(asked.length, 0);
    });

    it('lets a database failure through, so the job is retried and the opt-out is not lost', async () => {
        (pool as any).query = async () => { throw new Error('connection terminated unexpectedly'); };
        await assert.rejects(handleUserPreference(CREATOR, { user_preferences: [preference()] }, NOW), /connection terminated/);
    });
});
