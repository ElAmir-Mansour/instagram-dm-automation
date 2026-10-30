/**
 * "An ad was rejected" and "An ad has issues" (`ad_rejected`, `ad_issues`): when the structure sync raises them. The rule is pure and
 * tested as a table; the raiser is tested through the swappable sink; the default sink is tested against a fake pool, which shows the
 * alert reaching `ads_alerts` with the ad's Meta id as its object and the ad account's own day.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import type { AdSighting } from './mirror.js';
import { adStatusAlertFor, raiseAdStatusAlerts, reasonText, setAdStatusAlertSink, type AdStatusAlert } from './adStatusAlerts.js';

const C = '11111111-1111-4111-8111-111111111111';

const sighting = (over: Partial<AdSighting> = {}): AdSighting => ({
    metaId: '333', name: 'Reel ad', existed: true, previousStatus: 'ACTIVE', effectiveStatus: 'DISAPPROVED', review: null, ...over,
});

const review = (issues: unknown = null, feedback: unknown = null): AdSighting['review'] => ({ issues_info: issues, ad_review_feedback: feedback, learning_stage_info: null });

describe('adStatusAlertFor: the rule', () => {
    it('a move INTO DISAPPROVED raises ad_rejected, from any state, including no state at all (an ad the app made, before its first sync)', () => {
        for (const previous of [null, 'ACTIVE', 'PAUSED', 'PENDING_REVIEW', 'IN_PROCESS', 'WITH_ISSUES', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED', 'ARCHIVED']) {
            assert.equal(adStatusAlertFor(sighting({ previousStatus: previous, effectiveStatus: 'DISAPPROVED' }))?.kind, 'ad_rejected', String(previous));
        }
    });

    it('a move INTO WITH_ISSUES raises ad_issues, from any state, including no state at all, and from DISAPPROVED', () => {
        for (const previous of [null, 'ACTIVE', 'PAUSED', 'PENDING_REVIEW', 'IN_PROCESS', 'DISAPPROVED', 'ADSET_PAUSED']) {
            assert.equal(adStatusAlertFor(sighting({ previousStatus: previous, effectiveStatus: 'WITH_ISSUES' }))?.kind, 'ad_issues', String(previous));
        }
    });

    it('a row the sync meets for the first time never alerts, whatever it says: the first import of an old account is silent', () => {
        for (const effectiveStatus of ['DISAPPROVED', 'WITH_ISSUES']) {
            assert.equal(adStatusAlertFor(sighting({ existed: false, previousStatus: null, effectiveStatus })), null, effectiveStatus);
        }
    });

    it('a state that did not change does not alert again: it was announced when the ad got there', () => {
        assert.equal(adStatusAlertFor(sighting({ previousStatus: 'DISAPPROVED', effectiveStatus: 'DISAPPROVED' })), null);
        assert.equal(adStatusAlertFor(sighting({ previousStatus: 'WITH_ISSUES', effectiveStatus: 'WITH_ISSUES' })), null);
    });

    it('leaving those states, and every other state, is not announced (a fixed ad is not news; neither is a pause)', () => {
        const quiet: Array<[string | null, string | null]> = [
            ['DISAPPROVED', 'ACTIVE'], ['WITH_ISSUES', 'ACTIVE'], ['DISAPPROVED', 'PENDING_REVIEW'], ['DISAPPROVED', null],
            ['ACTIVE', 'PAUSED'], ['ACTIVE', 'IN_PROCESS'], ['PAUSED', 'ACTIVE'], ['ACTIVE', 'ARCHIVED'], ['ACTIVE', 'DELETED'], ['ACTIVE', 'CAMPAIGN_PAUSED'],
            [null, 'ACTIVE'], [null, null], ['ACTIVE', 'ACTIVE'], ['ACTIVE', null],
        ];
        for (const [previousStatus, effectiveStatus] of quiet) {
            assert.equal(adStatusAlertFor(sighting({ previousStatus, effectiveStatus })), null, `${previousStatus} -> ${effectiveStatus}`);
        }
    });

    it('names the ad by its Meta id and its name, and carries Meta\'s reasons: exactly what notifyAds is given for these two kinds', () => {
        const r = review([{ error_summary: 'Ad disapproved', error_message: 'long text' }], { global: { 'Misleading claims': 'We removed it' } });
        assert.deepEqual(adStatusAlertFor(sighting({ metaId: '120200000000001', name: 'Spring reel', review: r })), {
            kind: 'ad_rejected', adId: '120200000000001', adName: 'Spring reel', reason: 'Ad disapproved; We removed it',
        });
        assert.deepEqual(adStatusAlertFor(sighting({ effectiveStatus: 'WITH_ISSUES', name: null, review: null })), {
            kind: 'ad_issues', adId: '333', adName: null, reason: null,
        });
    });
});

describe('reasonText', () => {
    it('joins Meta\'s own reasons with "; ": issues_info first (error_summary, else error_message), then the review feedback', () => {
        assert.equal(
            reasonText(review([{ error_summary: 'Ad disapproved', error_message: 'long text' }, { error_message: 'Fix the text' }], { global: { 'Misleading claims': 'We removed it' } })),
            'Ad disapproved; Fix the text; We removed it'
        );
    });

    it('uses a bare policy code when Meta gave no sentence, and is null when Meta gave nothing', () => {
        assert.equal(reasonText(review(null, { global: { CODE_7: '123' } })), 'CODE_7');
        assert.equal(reasonText(null), null);
        assert.equal(reasonText(review([], null)), null);
        assert.equal(reasonText(review(null, null)), null);
    });

    it('keeps at most six reasons (the stored copy\'s own limit)', () => {
        const many = Array.from({ length: 9 }, (_, i) => ({ error_summary: `r${i}` }));
        assert.equal(reasonText(review(many)), 'r0; r1; r2; r3; r4; r5');
    });
});

describe('raiseAdStatusAlerts', () => {
    let delivered: Array<{ creatorId: string; alert: AdStatusAlert; now: Date }>;
    let lines: Array<{ level: string; line: Record<string, any> }>;
    let restoreLog: () => void;

    beforeEach(() => {
        delivered = [];
        lines = [];
        setAdStatusAlertSink(async (creatorId, alert, now) => { delivered.push({ creatorId, alert, now }); });
        const previous = setLogSink((level, line) => lines.push({ level, line: JSON.parse(line) }));
        restoreLog = () => setLogSink(previous);
    });
    afterEach(() => {
        setAdStatusAlertSink(null);
        restoreLog();
    });

    const NOW = new Date('2026-10-22T10:00:00Z');

    it('hands the alert channel one alert for each ad that changed into one of the two states, in the order seen, and says how many', async () => {
        const raised = await raiseAdStatusAlerts(C, [
            sighting({ metaId: '1', effectiveStatus: 'DISAPPROVED' }),
            sighting({ metaId: '2', previousStatus: 'DISAPPROVED', effectiveStatus: 'DISAPPROVED' }),   // unchanged
            sighting({ metaId: '3', effectiveStatus: 'WITH_ISSUES' }),
            sighting({ metaId: '4', existed: false, previousStatus: null }),                              // a first sighting
            sighting({ metaId: '5', previousStatus: 'DISAPPROVED', effectiveStatus: 'ACTIVE' }),          // recovered
        ], NOW);
        assert.equal(raised, 2);
        assert.deepEqual(delivered.map((d) => [d.creatorId, d.alert.kind, d.alert.adId]), [[C, 'ad_rejected', '1'], [C, 'ad_issues', '3']]);
        assert.ok(delivered.every((d) => d.now === NOW), 'the sync\'s clock names the alert\'s day');
    });

    it('logs each alert it raised, with the states it saw: an event the owner can find, at info level', async () => {
        await raiseAdStatusAlerts(C, [sighting({ metaId: '1', previousStatus: null, effectiveStatus: 'WITH_ISSUES' })], NOW);
        const line = lines.find((l) => l.line['event'] === 'ads.ad_status_alert');
        assert.ok(line, 'ads.ad_status_alert');
        assert.equal(line!.level, 'info');
        assert.deepEqual([line!.line['creator_id'], line!.line['kind'], line!.line['ad_id'], line!.line['from'], line!.line['to']], [C, 'ad_issues', '1', null, 'WITH_ISSUES']);
    });

    it('says nothing, runs nothing and reads nothing when no ad qualifies: no statement, not even a setting', async () => {
        setAdStatusAlertSink(null);   // the real channel: any alert would read the tenant's settings
        const db = installFakeDb();
        try {
            const raised = await raiseAdStatusAlerts(C, [sighting({ existed: false }), sighting({ previousStatus: 'DISAPPROVED' }), sighting({ effectiveStatus: 'ACTIVE' })], NOW);
            assert.equal(raised, 0);
            assert.equal(db.statements.length, 0);
            assert.equal(await raiseAdStatusAlerts(C, [], NOW), 0);
        } finally {
            db.restore();
        }
    });

    it('a failing channel is logged at error level and does not stop the next alert or throw: the new state is stored either way', async () => {
        setAdStatusAlertSink(async (creatorId, alert, now) => {
            if (alert.adId === '1') throw new Error('settings unreadable');
            delivered.push({ creatorId, alert, now });
        });
        const raised = await raiseAdStatusAlerts(C, [sighting({ metaId: '1' }), sighting({ metaId: '2' })], NOW);
        assert.equal(raised, 1, 'only the one that was handed over');
        assert.deepEqual(delivered.map((d) => d.alert.adId), ['2']);
        const failed = lines.find((l) => l.line['event'] === 'ads.alert_failed');
        assert.ok(failed);
        assert.equal(failed!.level, 'error');
        assert.deepEqual([failed!.line['creator_id'], failed!.line['ad_id'], failed!.line['message']], [C, '1', 'settings unreadable']);
    });
});

describe('the alert channel (the default sink)', () => {
    let db: FakeDb;
    let alertRows: Array<{ params: any[] }>;
    let settings: Map<string, string>;
    let restoreLog: () => void;

    beforeEach(() => {
        const previousLog = setLogSink(() => undefined);
        restoreLog = () => setLogSink(previousLog);
        db = installFakeDb();
        alertRows = [];
        settings = new Map([
            [`ads.settings.${C}`, JSON.stringify({ adAccountId: 'act_1234567890', maxDailyBudget: 20, monthlyCap: 300 })],
            [`ads.health.${C}`, JSON.stringify({ account: { name: 'Spring Account', currency: 'USD', timezoneOffsetHours: 3 } })],
        ]);
        db.routes.push(
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: settings.has(p[0]) ? [{ value: settings.get(p[0]), is_secret: false }] : [] })],
            [/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/, () => ({ rows: [] })],
            [/^INSERT INTO ads_alerts/, (p) => { alertRows.push({ params: p }); return { rows: [{ id: `alert-${alertRows.length}` }] }; }],
            [/^UPDATE ads_alerts SET channels/, () => ({ rows: [] })],
        );
    });
    afterEach(() => {
        db.restore();
        restoreLog();
    });

    it('records one ads_alerts row per ad: the kind, the ad\'s Meta id as the object, the ad account\'s own day, and the alert itself', async () => {
        // 22:30 UTC is already the 23rd in the account's zone (UTC+3).
        const raised = await raiseAdStatusAlerts(C, [
            sighting({ metaId: '120200000000001', name: 'Spring reel', review: review([{ error_summary: 'Ad disapproved' }]) }),
            sighting({ metaId: '120200000000002', effectiveStatus: 'WITH_ISSUES' }),
        ], new Date('2026-10-22T22:30:00Z'));
        assert.equal(raised, 2);
        assert.equal(alertRows.length, 2);
        const [first, second] = alertRows.map((r) => r.params);
        assert.deepEqual(first!.slice(0, 4), [C, 'ad_rejected', '120200000000001', '2026-10-23']);
        assert.deepEqual(second!.slice(0, 4), [C, 'ad_issues', '120200000000002', '2026-10-23']);
        assert.deepEqual(JSON.parse(first![4]), { kind: 'ad_rejected', adId: '120200000000001', adName: 'Spring reel', reason: 'Ad disapproved' });
    });

    it('is the tenant\'s own: its settings and health are read by creator_id, and nothing is read for another', async () => {
        await raiseAdStatusAlerts(C, [sighting()], new Date('2026-10-22T10:00:00Z'));
        const keys = db.ran(/^SELECT value, is_secret FROM app_settings/).map((s) => s.params[0] as string);
        assert.ok(keys.includes(`ads.settings.${C}`) && keys.includes(`ads.health.${C}`), keys.join(', '));
        assert.ok(keys.filter((k) => k.startsWith('ads.')).every((k) => k.endsWith(`.${C}`) || k === 'ads.copy_admin'), keys.join(', '));
    });

    it('a second alert about the same ad the same day finds the ads_alerts row and is not sent again (the table\'s own dedupe)', async () => {
        const seen = new Set<string>();
        db.routes.unshift([/^INSERT INTO ads_alerts/, (p) => {
            const key = `${p[0]}|${p[1]}|${p[2]}|${p[3]}`;
            if (seen.has(key)) return { rows: [] };
            seen.add(key);
            return { rows: [{ id: `alert-${seen.size}` }] };
        }]);
        const now = new Date('2026-10-22T10:00:00Z');
        await raiseAdStatusAlerts(C, [sighting({ metaId: '9' })], now);
        await raiseAdStatusAlerts(C, [sighting({ metaId: '9' })], new Date('2026-10-22T18:00:00Z'));
        assert.equal(db.ran(/^UPDATE ads_alerts SET channels/).length, 1, 'the second was a duplicate: nothing was delivered for it');
        await raiseAdStatusAlerts(C, [sighting({ metaId: '9', effectiveStatus: 'WITH_ISSUES' })], now);
        assert.equal(db.ran(/^UPDATE ads_alerts SET channels/).length, 2, 'another kind for the same ad is an alert of its own');
    });
});
