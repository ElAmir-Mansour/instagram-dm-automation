/**
 * Telling the owner once a day that Meta will not read what customers send (`alert.ts`): a refused key or an account with no credit left leaves every word-less message
 * on the usual line, and nobody would otherwise know. Never a customer's name or message in it; never more than one a day; never a throw.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { buildProviderNotice, claimProviderNotice, tellOwnerProviderTrouble } from './alert.js';

const NOW = new Date('2026-10-30T22:15:00.000Z');
const TENANT = 'c0ffee00-0000-4000-8000-000000000001';

let logged: { level: string; event: string; [k: string]: unknown }[];
let undo: (() => void)[];
beforeEach(() => {
    logged = [];
    const sink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    const original = pool.query;
    undo = [() => setLogSink(sink), () => { (pool as any).query = original; }];
});
afterEach(() => { for (const f of undo) f(); });

describe('buildProviderNotice', () => {
    it('is both languages, Arabic first, and says what happened and what to do', () => {
        const auth = buildProviderNotice('auth');
        assert.equal(auth.subject, 'AutoReply · Meta vision stopped: the model service refused the Meta key');
        const [ar, en] = auth.text.split('\n\n');
        assert.match(ar!, /^AutoReply · توقفت رؤية ميتا: رفض مزوّد النماذج مفتاح ميتا\n/);
        assert.match(en!, /^AutoReply · Meta vision stopped: the model service refused the Meta key\nMessages with no words get the fixed line until this is fixed\. Nothing is lost\.\nWhat to do: Check the Meta key in Settings → AI providers\.$/);
        assert.match(ar!, /المطلوب:/);
    });

    it('an account with no credit says so', () => {
        const quota = buildProviderNotice('quota');
        assert.match(quota.subject, /the Meta model account has no credit left/);
        assert.match(quota.text, /Add credit, or a higher limit, in the Meta model account\./);
        assert.match(quota.text, /انتهى رصيد حساب ميتا للنماذج/);
    });

    it('holds nothing of any customer: no tenant, no id, no name, no message', () => {
        for (const kind of ['auth', 'quota'] as const) assert.ok(!/@|user|customer|[0-9]{4}/i.test(buildProviderNotice(kind).text), kind);
    });
});

describe('claimProviderNotice: one statement, one winner a day', () => {
    it('writes the UTC day over the stored one, and is true only for the call that changed it', async () => {
        const seen: { sql: string; params: any[] }[] = [];
        (pool as any).query = async (sql: string, params: any[]) => { seen.push({ sql, params }); return { rows: seen.length === 1 ? [{ key: 'k' }] : [], rowCount: seen.length === 1 ? 1 : 0 }; };

        assert.equal(await claimProviderNotice(TENANT, NOW), true);
        assert.equal(await claimProviderNotice(TENANT, NOW), false, 'the same day again: the row already says so');
        assert.deepEqual(seen[0]!.params, [`muse.provider_notice.${TENANT}`, '2026-10-30']);
        assert.match(seen[0]!.sql.replace(/\s+/g, ' '), /ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, updated_at = NOW\(\) WHERE app_settings\.value IS DISTINCT FROM EXCLUDED\.value RETURNING key/);
    });

    it('is its own setting: not the budget notice\'s, so one cannot hide the other', () => {
        assert.notEqual(`muse.provider_notice.${TENANT}`, `muse.budget_notice.${TENANT}`);
    });
});

describe('tellOwnerProviderTrouble', () => {
    it('sends the notice once: the first refusal of the day tells him, the rest tell nobody', async () => {
        const sent: { subject: string; text: string }[] = [];
        let claims = 0;
        const deps = { now: () => NOW, claim: async () => claims++ === 0, send: async (n: { subject: string; text: string }) => { sent.push(n); return { telegram: 'off' as const, email: 'sent' as const }; } };

        await tellOwnerProviderTrouble(TENANT, 'auth', deps);
        await tellOwnerProviderTrouble(TENANT, 'auth', deps);
        await tellOwnerProviderTrouble(TENANT, 'quota', deps);

        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0], buildProviderNotice('auth'));
        assert.equal(logged.find((l) => l.event === 'perception.provider_notice')?.level, 'info');
    });

    it('says so, as a warning, when no channel took it', async () => {
        await tellOwnerProviderTrouble(TENANT, 'auth', { claim: async () => true, send: async () => ({ telegram: 'off', email: 'failed' }) });
        const line = logged.find((l) => l.event === 'perception.provider_notice')!;
        assert.equal(line.level, 'warn');
        assert.equal(line.email, 'failed');
    });

    it('never throws: a claim that cannot be made, or a send that blows up, is logged and let go', async () => {
        await tellOwnerProviderTrouble(TENANT, 'auth', { claim: async () => { throw new Error('connection terminated'); } });
        await tellOwnerProviderTrouble(TENANT, 'quota', { claim: async () => true, send: async () => { throw new Error('boom'); } });
        assert.equal(logged.filter((l) => l.event === 'perception.provider_notice_failed').length, 2);
    });
});
