/**
 * What the daily sweep forgets about tracked links (S7): clicks older than 180 days, and nothing else.
 *
 * Tested against a stand-in holding `link_clicks`, `tracked_links` and a conversation, which answers the prune statement by reading its predicates
 * OUT OF the SQL it is given: take `clicked_at < $1` out and a click from yesterday goes; make `<` a `<=` and a click exactly 180 days old goes;
 * make the statement touch `tracked_links` and a link a person may still tap disappears. The boundary is decided in TypeScript (`linkClickCutoff`)
 * and handed over as a parameter, so a test can set a row on either side of it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from './monteur/testDb.js';
import {
    DEFAULT_RETENTION_DEPS, LINK_CLICK_PRUNE_BATCH, LINK_CLICK_RETENTION_DAYS, linkClickCutoff, MAX_SWEEP_PASSES, PRUNE_LINK_CLICKS_SQL,
    pruneLinkClicks, runRetentionSweep, type RetentionSweepDeps,
} from './retention.js';
import { setLogSink } from '../utils/log.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const ago = (days: number, plusMs = 0): Date => new Date(NOW - days * DAY + plusMs);

interface ClickRow { id: number; code: string; clicked_at: Date; is_prefetch: boolean; ua_class: string }

let db: FakeDb;
let clicks: ClickRow[];
let links: Array<{ code: string; conversation_id: string }>;
let logs: Array<{ level: string; event: string; fields: Record<string, unknown> }>;
let restoreSink: (() => void) | undefined;
let nextId: number;

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const matches = (sql: string): RegExp => new RegExp(`^${flat(sql).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const click = (days: number, plusMs = 0, code = 'aB3dE5gH7j'): void => {
    clicks.push({ id: nextId++, code, clicked_at: ago(days, plusMs), is_prefetch: false, ua_class: 'ios' });
};

beforeEach(() => {
    clicks = []; nextId = 1;
    links = [{ code: 'aB3dE5gH7j', conversation_id: 'c1' }];
    logs = [];
    const previous = setLogSink((level, line) => { try { const parsed = JSON.parse(line); logs.push({ level, event: parsed.event, fields: parsed }); } catch { /* not structured */ } });
    restoreSink = () => setLogSink(previous);
    db = installFakeDb();
    db.routes.push([matches(PRUNE_LINK_CLICKS_SQL), ([cutoff, limit], sql) => {
        const older = (r: ClickRow) => (sql.includes('clicked_at < $1') ? r.clicked_at.getTime() < (cutoff as Date).getTime() : true);
        const doomed = clicks.filter(older).sort((a, b) => a.clicked_at.getTime() - b.clicked_at.getTime()).slice(0, limit).map((r) => r.id);
        clicks = clicks.filter((r) => !doomed.includes(r.id));
        return { rows: [], rowCount: doomed.length };
    }]);
});
afterEach(() => { db.restore(); restoreSink?.(); });

describe('the window', () => {
    it('is the plan\'s 180 days, measured from the moment of the sweep', () => {
        assert.equal(LINK_CLICK_RETENTION_DAYS, 180);
        assert.equal(linkClickCutoff(NOW).getTime(), NOW - 180 * DAY);
    });
});

describe('pruneLinkClicks', () => {
    it('deletes a click once it is older than 180 days, and a click exactly 180 days old is kept', async () => {
        click(400); click(181); click(180, -1); click(180); click(180, 1); click(90); click(0);
        const { deleted } = await pruneLinkClicks(NOW);
        assert.equal(deleted, 3, 'a year, 181 days and a millisecond over 180');
        assert.deepEqual(clicks.map((c) => c.id).sort((a, b) => a - b), [4, 5, 6, 7], 'exactly 180 days, a millisecond under, 90 days and today');
    });

    it('hands the statement the cutoff and the batch as parameters, and reads clicks only', async () => {
        click(300);
        await pruneLinkClicks(NOW);
        const [statement] = db.ran(/^DELETE FROM link_clicks/);
        assert.deepEqual(statement!.params, [new Date(NOW - 180 * DAY), LINK_CLICK_PRUNE_BATCH]);
        assert.equal(db.statements.every((s) => /^DELETE FROM link_clicks/.test(s.sql)), true, 'one table, one kind of statement');
        assert.match(PRUNE_LINK_CLICKS_SQL, /^DELETE FROM link_clicks/);
        assert.doesNotMatch(PRUNE_LINK_CLICKS_SQL, /tracked_links/);
    });

    it('never touches the links: a link a person may still tap outlives its old clicks', async () => {
        click(500);
        await pruneLinkClicks(NOW);
        assert.deepEqual(links, [{ code: 'aB3dE5gH7j', conversation_id: 'c1' }]);
        assert.equal(clicks.length, 0);
    });

    it('prunes a prefetch the same as a click: both are only counts', async () => {
        clicks.push({ id: 1, code: 'aB3dE5gH7j', clicked_at: ago(200), is_prefetch: true, ua_class: 'preview' });
        assert.equal((await pruneLinkClicks(NOW)).deleted, 1);
    });

    it('goes on a batch at a time, oldest first, until a batch comes back short', async () => {
        for (let i = 0; i < LINK_CLICK_PRUNE_BATCH * 2 + 7; i++) click(300 + (i % 11));
        click(5);
        const { deleted } = await pruneLinkClicks(NOW);
        assert.equal(deleted, LINK_CLICK_PRUNE_BATCH * 2 + 7);
        assert.equal(clicks.length, 1, 'today\'s click is all that is left');
        assert.equal(db.ran(/^DELETE FROM link_clicks/).length, 3, 'two full batches and a short one');
    });

    it('stops after the pass limit and leaves the rest for tomorrow, so one sweep cannot hold the cron for ever', async () => {
        for (let i = 0; i < LINK_CLICK_PRUNE_BATCH * (MAX_SWEEP_PASSES + 2); i++) click(300);
        const { deleted } = await pruneLinkClicks(NOW);
        assert.equal(deleted, LINK_CLICK_PRUNE_BATCH * MAX_SWEEP_PASSES);
        assert.equal(clicks.length, LINK_CLICK_PRUNE_BATCH * 2);
        assert.equal(db.ran(/^DELETE FROM link_clicks/).length, MAX_SWEEP_PASSES);
    });

    it('does nothing, and asks once, when there is nothing old', async () => {
        click(1); click(100);
        assert.equal((await pruneLinkClicks(NOW)).deleted, 0);
        assert.equal(db.ran(/^DELETE FROM link_clicks/).length, 1);
        assert.deepEqual(logs, []);
    });

    it('logs what it deleted, once', async () => {
        click(200); click(201);
        await pruneLinkClicks(NOW);
        assert.deepEqual(logs.map((l) => [l.level, l.event, l.fields['deleted'], l.fields['retention_days']]), [['info', 'retention.link_clicks_pruned', 2, 180]]);
    });

    it('treats a database without migration v38 as nothing to prune: no error, no log', async () => {
        db.routes.unshift([matches(PRUNE_LINK_CLICKS_SQL), () => { throw Object.assign(new Error('relation "link_clicks" does not exist'), { code: '42P01' }); }]);
        assert.deepEqual(await pruneLinkClicks(NOW), { deleted: 0 });
        assert.deepEqual(logs, []);
    });

    it('logs any other failure and still does not throw: a retention failure must not stop the publishes after it', async () => {
        db.routes.unshift([matches(PRUNE_LINK_CLICKS_SQL), () => { throw new Error('canceling statement due to statement timeout'); }]);
        assert.deepEqual(await pruneLinkClicks(NOW), { deleted: 0 });
        assert.deepEqual(logs.map((l) => [l.level, l.event]), [['error', 'retention.link_clicks_prune_failed']]);
        // A missing table that is NOT link_clicks is a real failure, not "nothing to prune".
        logs = [];
        db.routes.unshift([matches(PRUNE_LINK_CLICKS_SQL), () => { throw Object.assign(new Error('relation "something_else" does not exist'), { code: '42P01' }); }]);
        await pruneLinkClicks(NOW);
        assert.deepEqual(logs.map((l) => l.event), ['retention.link_clicks_prune_failed']);
    });
});

describe('runRetentionSweep', () => {
    const quiet: RetentionSweepDeps = {
        pruneRaw: async () => ({ cleared: 0, skipped: false }),
        pruneJobs: async () => ({ deleted: 0 }),
        pruneMedia: async () => ({ deleted: 0, skipped: false as const }),
        removeObjects: async () => ({ removed: 0, failed: 0, skipped: false as const }),
    };

    it('runs the link-click prune once per sweep, however many passes the other prunes need, and reports it', async () => {
        let calls = 0;
        let raw = 0;
        const result = await runRetentionSweep({
            ...quiet,
            pruneRaw: async () => ({ cleared: raw++ < 2 ? 5_000 : 0, skipped: false }),
            pruneLinkClicks: async () => { calls++; return { deleted: 12 }; },
        });
        assert.equal(result.passes, 3);
        assert.equal(calls, 1);
        assert.equal(result.linkClicksDeleted, 12);
    });

    it('is part of the real sweep, in the default dependencies, and through them deletes old clicks', async () => {
        assert.equal(DEFAULT_RETENTION_DEPS.pruneLinkClicks, pruneLinkClicks);
        click(400); click(1);
        // The real sweep reads other tables through the same stand-in, which answers them with no rows.
        const result = await runRetentionSweep({ ...quiet, pruneLinkClicks: () => pruneLinkClicks(NOW) });
        assert.equal(result.linkClicksDeleted, 1);
        assert.deepEqual(clicks.map((c) => c.id), [2]);
    });

    it('reports zero, and does not call it, when a test passes dependencies without it', async () => {
        const result = await runRetentionSweep(quiet);
        assert.equal(result.linkClicksDeleted, 0);
        assert.equal(db.ran(/link_clicks/).length, 0);
    });
});

describe('/privacy', () => {
    const html = readFileSync('public/privacy.html', 'utf8');
    const article = (lang: 'ar' | 'en'): string => {
        const start = html.indexOf(`<article class="doc" data-doc-lang="${lang}"`);
        assert.ok(start >= 0, lang);
        return html.slice(start, html.indexOf('</article>', start));
    };
    const item = (lang: 'ar' | 'en'): string => {
        const doc = article(lang);
        const at = doc.indexOf(lang === 'ar' ? 'عدّ النقرات على الروابط' : 'Link-click counting');
        assert.ok(at >= 0, `${lang} has the line`);
        return doc.slice(doc.lastIndexOf('<li>', at), doc.indexOf('</li>', at)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    };

    it('says, in both languages and in one list item each, that clicks on short links are counted, and what is and is not kept', () => {
        const en = item('en');
        for (const part of ['short link on our own site', 'when', 'automatic link preview', 'coarse device type', 'do not record your IP address', 'full identification string']) {
            assert.ok(en.includes(part), `en: ${part}`);
        }
        const ar = item('ar');
        for (const part of ['رابطاً قصيراً على موقعنا', 'معاينة آلية', 'نوعاً عاماً للجهاز', 'لا نسجّل عنوان الاتصال', 'نصّ تعريف المتصفح الكامل']) {
            assert.ok(ar.includes(part), `ar: ${part}`);
        }
    });

    it('states the retention the sweep applies, so the page and the code cannot drift apart', () => {
        assert.match(item('en'), new RegExp(`deleted after ${LINK_CLICK_RETENTION_DAYS} days`));
        assert.ok(item('ar').includes(`بعد ${LINK_CLICK_RETENTION_DAYS} يوماً`));
    });

    it('says the link and its count go with the conversation, which is what the cascade in migration v38 does', () => {
        assert.ok(item('en').includes('deleted with your conversation'));
        assert.ok(item('ar').includes('مع محادثتك'));
    });

    it('sits in the section that lists what is stored when someone sends a direct message, after the replies line', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = article(lang);
            const dm = doc.indexOf(lang === 'ar' ? 'عندما ترسل رسالة خاصة' : 'When you send a direct message');
            const replies = doc.indexOf(lang === 'ar' ? 'الردود المُرسَلة إليك تُخزَّن' : 'Replies sent to you are stored');
            const line = doc.indexOf(lang === 'ar' ? 'عدّ النقرات على الروابط' : 'Link-click counting');
            const tiktok = doc.indexOf(lang === 'ar' ? 'عندما يربط صاحب الحساب تيك توك' : 'When the account owner connects TikTok');
            assert.ok(dm > 0 && dm < replies && replies < line && line < tiktok, lang);
        }
    });
});
