/**
 * Ads → DM bot attribution (A3): the pure rules (what an ad referral is, the entry source and the touch it writes, our `ref`, the reply window, the
 * two send refusals, the ad facts) and the statements' contracts (one statement per touch, never a throw, an alert only on a change).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import {
    AD_WINDOW_MS, adFactsFor, adPlatformOf, adSourceOf, adsContextOf, DEFAULT_WINDOW_MS, entrySourceFor, isBusinessAiBlock, isWindowRefusal, joinAd,
    MAX_AD_TOUCHES, noteBusinessAiBlock, noteWindowRefusal, recordAdTouch, refFor, refPrefix, setAttributionAlertSink, touchFor, windowEndsAt, windowFor,
    type AdSource, type AttributionAlertKind,
} from './attribution.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const referral = (over: Record<string, unknown> = {}) => ({ ref: 'ar_0123456789ab', ad_id: '120', source: 'ADS', type: 'OPEN_THREAD', ads_context_data: { ad_title: 'Autumn', photo_url: 'https://p/1.jpg' }, ...over });
const SOURCE: AdSource = { platform: 'instagram', adId: '120', ref: 'ar_0123456789ab', context: { ad_title: 'Autumn' }, at: '2026-10-22T10:00:00.000Z' };

let logs: Array<Record<string, unknown>> = [];
let restoreLog: (() => void) | undefined;
beforeEach(() => {
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restoreLog = () => setLogSink(previous);
});
afterEach(() => restoreLog?.());

/** Run with `pool.query` answering by the first pattern that matches; anything unarranged throws. */
async function withDb<T>(routes: Array<[RegExp, (params: any[]) => { rows?: any[] } | Error]>, run: () => Promise<T>): Promise<{ out: T; sql: Array<{ text: string; params: any[] }> }> {
    const sql: Array<{ text: string; params: any[] }> = [];
    const original = pool.query;
    (pool as any).query = async (text: string, params: any[] = []) => {
        sql.push({ text, params });
        const route = routes.find(([re]) => re.test(text));
        if (!route) throw new Error(`no result arranged for SQL:\n${text}`);
        const r = route[1](params);
        if (r instanceof Error) throw r;
        return { rows: r.rows ?? [], rowCount: (r.rows ?? []).length };
    };
    try {
        return { out: await run(), sql };
    } finally {
        (pool as any).query = original;
    }
}

describe('adSourceOf', () => {
    it('reads message.referral, then postback.referral, then the standalone referral', () => {
        const all = { message: { referral: referral({ ad_id: 'A' }) }, postback: { referral: referral({ ad_id: 'B' }) }, referral: referral({ ad_id: 'C' }) };
        assert.equal(adSourceOf(all)?.adId, 'A');
        assert.equal(adSourceOf({ ...all, message: {} })?.adId, 'B');
        assert.equal(adSourceOf({ referral: referral({ ad_id: 'C' }) })?.adId, 'C');
    });

    it('keeps only an ad referral (source ADS, any case) that names an ad or a ref', () => {
        assert.equal(adSourceOf({ referral: referral({ source: 'SHORTLINK' }) }), null);
        assert.equal(adSourceOf({ referral: referral({ source: 'ads' }) })?.adId, '120');
        assert.equal(adSourceOf({ referral: referral({ ad_id: undefined, ref: undefined }) }), null);
        assert.equal(adSourceOf({ referral: 'nope' }), null);
        assert.equal(adSourceOf({}), null);
    });

    it('takes the platform from the body object, else from where the referral rode', () => {
        assert.equal(adSourceOf({ referral: referral() }, 'instagram')?.platform, 'instagram');
        assert.equal(adSourceOf({ message: { referral: referral() } }, 'page')?.platform, 'messenger');
        assert.equal(adSourceOf({ message: { referral: referral() } })?.platform, 'instagram');
        assert.equal(adSourceOf({ postback: { referral: referral() } })?.platform, 'messenger');
    });

    it('stamps the click with the event timestamp', () => {
        assert.equal(adSourceOf({ timestamp: 1761134400000, referral: referral() })?.at, new Date(1761134400000).toISOString());
    });

    it('keeps only the context fields the privacy page names', () => {
        assert.deepEqual(adsContextOf({ ad_title: ' T ', photo_url: 'p', video_url: 'v', post_id: '1_2', product_id: 'x', flow_id: 'y' }), { ad_title: 'T', photo_url: 'p', video_url: 'v', post_id: '1_2' });
        assert.equal(adsContextOf({ product_id: 'x' }), null);
        assert.equal(adsContextOf(null), null);
    });
});

describe('entrySourceFor and touchFor', () => {
    it('the first touch is a ctm entry source; a later one is a touch', () => {
        assert.deepEqual(entrySourceFor(SOURCE), { kind: 'ctm', platform: 'instagram', ad_id: '120', ref: 'ar_0123456789ab', ads_context_data: { ad_title: 'Autumn' }, at: SOURCE.at });
        assert.deepEqual(entrySourceFor({ ...SOURCE, adId: null, ref: null, context: null }), { kind: 'ctm', platform: 'instagram', at: SOURCE.at });
        assert.deepEqual(touchFor(SOURCE), { ad_id: '120', ref: 'ar_0123456789ab', platform: 'instagram', at: SOURCE.at });
    });
});

describe('refFor and refPrefix', () => {
    it('our ref is ar_ and 12 hex digits of the object id, and reads back', () => {
        const ref = refFor('01234567-89AB-cdef-0123-456789abcdef');
        assert.equal(ref, 'ar_0123456789ab');
        assert.match(ref, /^[A-Za-z0-9_=-]+$/, 'Meta allows only these characters in a ref');
        assert.equal(refPrefix(ref), '0123456789ab');
        assert.equal(refPrefix('summer_sale'), null);
        assert.equal(refPrefix(null), null);
    });
});

describe('windowFor and windowEndsAt', () => {
    const off = { extendedWindow: { instagram: false, messenger: false } };
    const ig = { extendedWindow: { instagram: true, messenger: false } };
    const ctm = { entry_source: { kind: 'ctm' as const, platform: 'instagram' as const, at: '2026-10-20T00:00:00.000Z' } };

    it('is 23 hours by default, and 7 days less an hour only for a ctm conversation whose platform is on', () => {
        assert.equal(DEFAULT_WINDOW_MS, 23 * HOUR);
        assert.equal(AD_WINDOW_MS, 7 * DAY - HOUR);
        assert.equal(windowFor({}, ig), DEFAULT_WINDOW_MS);
        assert.equal(windowFor(ctm, off), DEFAULT_WINDOW_MS);
        assert.equal(windowFor(ctm, ig), AD_WINDOW_MS);
        assert.equal(windowFor({ entry_source: { kind: 'ctm', platform: 'messenger' } }, ig), DEFAULT_WINDOW_MS);
        assert.equal(windowFor({ entry_source: { kind: 'ctwa' } }, ig), DEFAULT_WINDOW_MS);
    });

    it('counts the ad window from the click, never past it, and never shorter than the 23 hour rule', () => {
        const click = Date.parse(ctm.entry_source.at);
        assert.equal(windowEndsAt(ctm, new Date(click + DAY), ig).getTime(), click + AD_WINDOW_MS);
        assert.equal(windowEndsAt(ctm, new Date(click + 7 * DAY), ig).getTime(), click + 7 * DAY + DEFAULT_WINDOW_MS, 'a late message keeps its own 23 hours');
        assert.equal(windowEndsAt(ctm, new Date(click + DAY), off).getTime(), click + DAY + DEFAULT_WINDOW_MS);
        assert.equal(windowEndsAt({ entry_source: { ...ctm.entry_source, at: 'garbage' } }, new Date(click), ig).getTime(), click + DEFAULT_WINDOW_MS);
    });
});

describe('the send refusals', () => {
    const metaErr = (code: number, sub?: number) => Object.assign(new Error('x'), { response: { data: { error: { code, error_subcode: sub } } } });
    it('Business AI is 100 / 2534037, read from the response or the rewrapped error', () => {
        assert.equal(isBusinessAiBlock(metaErr(100, 2534037)), true);
        assert.equal(isBusinessAiBlock(Object.assign(new Error('x'), { metaCode: 100, metaSubcode: 2534037 })), true);
        assert.equal(isBusinessAiBlock(metaErr(100, 33)), false);
        assert.equal(isBusinessAiBlock(metaErr(10, 2534037)), false);
    });
    it('outside the window is 10 / 2018278 or 551', () => {
        assert.equal(isWindowRefusal(metaErr(10, 2018278)), true);
        assert.equal(isWindowRefusal(metaErr(551)), true);
        assert.equal(isWindowRefusal(metaErr(10, 1)), false);
        assert.equal(isWindowRefusal(metaErr(100, 2534037)), false);
    });
    it('maps conversations.platform to the ad platform', () => {
        assert.equal(adPlatformOf('instagram'), 'instagram');
        assert.equal(adPlatformOf('facebook'), 'messenger');
        assert.equal(adPlatformOf('whatsapp'), null);
        assert.equal(adPlatformOf(null), null);
    });
});

describe('adFactsFor', () => {
    const offers = [{ id: 'go', name: 'Go Bootcamp' }];
    const joined = { objectId: 'o', metaId: '120', name: 'Go — reel 3', offerId: 'go', primaryText: 'Learn Go' };
    it('only for a ctm conversation with a name to say', () => {
        assert.equal(adFactsFor({ entry: { kind: 'ctwa' }, joined, offers, tapped: null }), null);
        assert.equal(adFactsFor({ entry: null, joined, offers, tapped: null }), null);
        assert.equal(adFactsFor({ entry: { kind: 'ctm' }, joined: null, offers, tapped: null }), null);
    });
    it('the stored name and offer first, else the title Meta sent', () => {
        assert.deepEqual(adFactsFor({ entry: { kind: 'ctm', ads_context_data: { ad_title: 'Autumn' } }, joined, offers, tapped: 'Price?' }),
            { name: 'Go — reel 3', offerTitle: 'Go Bootcamp', primaryText: 'Learn Go', tapped: 'Price?' });
        assert.deepEqual(adFactsFor({ entry: { kind: 'ctm', ads_context_data: { ad_title: 'Autumn' } }, joined: null, offers, tapped: null }),
            { name: 'Autumn', offerTitle: null, primaryText: null, tapped: null });
        assert.equal(adFactsFor({ entry: { kind: 'ctm' }, joined: { ...joined, offerId: 'gone' }, offers, tapped: null })?.offerTitle, null);
    });
    it('cuts the ad text at 200 characters', () => {
        const long = 'x'.repeat(500);
        const facts = adFactsFor({ entry: { kind: 'ctm' }, joined: { ...joined, primaryText: long }, offers, tapped: null })!;
        assert.equal(facts.primaryText!.length, 200);
        assert.ok(facts.primaryText!.endsWith('…'));
    });
});

describe('recordAdTouch', () => {
    it('one statement, with the entry, the touch, its own inbound row and the cap, and answers what the database decided', async () => {
        const { out, sql } = await withDb([[/WITH cur AS/, () => ({ rows: [{ recorded: 'touch' }] })]], () =>
            recordAdTouch({ conversationId: 'c1', creatorId: 't1', source: SOURCE, inboundId: 'm1' }));
        assert.equal(out, 'touch');
        assert.equal(sql.length, 1);
        const p = sql[0]!.params;
        assert.deepEqual([p[0], p[1], p[4], p[5]], ['c1', 't1', 'm1', MAX_AD_TOUCHES]);
        assert.equal(JSON.parse(p[2]).kind, 'ctm');
        assert.deepEqual(JSON.parse(p[3]), touchFor(SOURCE));
        assert.match(sql[0]!.text, /FOR UPDATE/);
    });

    it('never throws: a database error is "missing", logged', async () => {
        const { out } = await withDb([[/WITH cur AS/, () => new Error('down')]], () => recordAdTouch({ conversationId: 'c1', creatorId: 't1', source: SOURCE }));
        assert.equal(out, 'missing');
        assert.ok(logs.some((l) => l['event'] === 'ads.touch_failed' || JSON.stringify(l).includes('ads.touch_failed')));
    });
});

describe('joinAd', () => {
    it('joins by our ref first, then by the ad id, at level ad', async () => {
        const { out, sql } = await withDb([[/FROM ads_objects/, () => ({ rows: [{ id: 'o1', meta_id: '120', name: 'Ad', offer_id: 'go', primary_text: 'T' }] })]], () =>
            joinAd('t1', { ref: 'ar_0123456789AB', adId: '120' }));
        assert.deepEqual(out, { objectId: 'o1', metaId: '120', name: 'Ad', offerId: 'go', primaryText: 'T' });
        assert.deepEqual(sql[0]!.params, ['t1', '0123456789ab', '120']);
        assert.match(sql[0]!.text, /level = 'ad'/);
    });

    it('asks nothing without a key, and answers null before the stored copy exists (42P01) without a warning', async () => {
        const none = await withDb([], () => joinAd('t1', { ref: 'summer', adId: null }));
        assert.equal(none.out, null);
        assert.equal(none.sql.length, 0);
        const missing = await withDb([[/FROM ads_objects/, () => Object.assign(new Error('relation does not exist'), { code: '42P01' })]], () => joinAd('t1', { adId: '1' }));
        assert.equal(missing.out, null);
        assert.ok(!logs.some((l) => JSON.stringify(l).includes('ads.join_failed')));
    });
});

describe('noteBusinessAiBlock and noteWindowRefusal', () => {
    let alerts: Array<{ kind: AttributionAlertKind; objectKey: string }> = [];
    beforeEach(() => {
        alerts = [];
        setAttributionAlertSink(async (a) => { alerts.push({ kind: a.kind, objectKey: a.objectKey }); });
    });
    afterEach(() => setAttributionAlertSink(null));

    it('Business AI: marks the conversation and alerts only when the mark is new', async () => {
        await withDb([[/SET no_reply_reason = 'business_ai_owns_thread'/, () => ({ rows: [{ id: 'c1' }] })]], () => noteBusinessAiBlock('t1', 'c1'));
        assert.deepEqual(alerts, [{ kind: 'business_ai', objectKey: 't1' }]);
        await withDb([[/SET no_reply_reason = 'business_ai_owns_thread'/, () => ({ rows: [] })]], () => noteBusinessAiBlock('t1', 'c1'));
        assert.equal(alerts.length, 1);
        await withDb([[/no_reply_reason/, () => new Error('down')]], () => noteBusinessAiBlock('t1', 'c1'));   // never throws
    });

    it('window refusal: switches the platform off and alerts, only when it was on', async () => {
        const writes: any[][] = [];
        let stored: string | null = JSON.stringify({ instagram: true, messenger: true });
        const routes: Array<[RegExp, (p: any[]) => { rows?: any[] }]> = [
            [/SELECT value, is_secret FROM app_settings WHERE key = \$1/, () => ({ rows: stored ? [{ value: stored, is_secret: false }] : [] })],
            [/INSERT INTO app_settings/, (p) => { writes.push(p); stored = p[1]; return { rows: [] }; }],
            [/DELETE FROM app_settings/, () => { stored = null; return { rows: [] }; }],
        ];
        const on = await withDb(routes, () => noteWindowRefusal('t1', 'instagram', 'c1'));
        assert.equal(on.out, true);
        assert.deepEqual(JSON.parse(stored!), { instagram: false, messenger: true });
        assert.equal(writes[0]![0], 'ads.extended_window.t1');
        assert.deepEqual(alerts, [{ kind: 'window_error', objectKey: 't1:instagram' }]);

        const off = await withDb(routes, () => noteWindowRefusal('t1', 'instagram', 'c1'));
        assert.equal(off.out, false, 'already off: the ordinary 24 hour rule says nothing about ads');
        assert.equal(alerts.length, 1);
    });
});
