/**
 * Ads alerts (research R8, R9; tasks T022): once per (tenant, kind, object, day) through `ads_alerts`; in the tenant's language to the
 * tenant's own Telegram chat and email (the deployment's bot and Resend key, the tenant's recipients); a copy, in both languages, to the
 * platform admin's channels unless `ads.copy_admin` is 'false'; each channel's outcome recorded on the row; and it never throws.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { telegramHttp } from '../notify.js';
import { emailHttp } from '../notifyEmail.js';
import { buildAdsAlertText, localDay, notifyAds, sendAdsTest, type AdsAlert } from './notify.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BOT = '123456789:AAH_fake_token_for_tests_0123456789abcd';
const KEY = 're_AbCdEfGh_0123456789abcdefghijkl';
const target = { creatorId: TENANT, adAccountId: '509787248064459', accountName: 'Test Account', offsetHours: 3 };
const capPaused: AdsAlert = { kind: 'cap_paused', spent: 101.5, cap: 100, nextDay: 17.5, paused: 2, currency: 'USD' };

describe('buildAdsAlertText', () => {
    it('writes each kind in Arabic and in English, naming the ad account and the numbers, never a token', () => {
        for (const lang of ['ar', 'en'] as const) {
            const text = buildAdsAlertText(capPaused, target, lang);
            assert.match(text, /509787248064459|Test Account/);
            assert.match(text, /101\.5/);
            assert.match(text, /100/);
        }
        assert.match(buildAdsAlertText(capPaused, target, 'ar'), /[؀-ۿ]/);
        assert.doesNotMatch(buildAdsAlertText(capPaused, target, 'en'), /[؀-ۿ]/);
        const kinds: AdsAlert[] = [
            capPaused,
            { kind: 'payment', reason: 'no_payment_method', status: 1 },
            { kind: 'account_disabled', status: 2, label: 'disabled', disableReason: 'Ads integrity policy' },
            { kind: 'token_dead', code: 190 },
            { kind: 'token_expiring', expiresAt: '2026-11-01T00:00:00Z', daysLeft: 10 },
            { kind: 'guard_blind', since: '2026-10-22T08:00:00Z', reason: 'token' },
            { kind: 'version_mismatch', pinned: 'v26.0', served: 'v25.0' },
            { kind: 'ad_rejected', adId: '1', adName: 'Ad', reason: 'Policy' },
            { kind: 'ad_issues', adId: '1', adName: 'Ad', reason: null },
        ];
        for (const a of kinds) for (const lang of ['ar', 'en'] as const) assert.ok(buildAdsAlertText(a, target, lang).length > 20, `${a.kind} ${lang}`);
    });

    it('cleans what Meta wrote: links and bidi controls removed', () => {
        const text = buildAdsAlertText({ kind: 'ad_rejected', adId: '1', adName: 'x‮evil', reason: 'see https://evil.example now' }, target, 'en');
        assert.doesNotMatch(text, /https:\/\/evil/);
        assert.doesNotMatch(text, /‮/);
    });
});

describe('rule alerts (A9)', () => {
    it('says what the rule did, the numbers behind it, and that a raise waits for approval', () => {
        const acted: AdsAlert = {
            kind: 'rule_acted', ruleId: 'r1', ruleName: 'Too expensive', objectName: 'Spring ad', currency: 'SAR', proposalId: null,
            values: { 'cost_per_conversation:3d': 18.456, 'spend:today': 40 },
            steps: [{ kind: 'op', objectId: 'o1', action: 'lower_budget', from: 50, to: 40, adsetMetaId: 's1' }, { kind: 'notify', objectId: 'o1' }],
        };
        const en = buildAdsAlertText(acted, target, 'en');
        assert.match(en, /Too expensive/);
        assert.match(en, /Spring ad/);
        assert.match(en, /18\.46 SAR/);
        assert.match(en, /from 50 SAR to 40 SAR/);
        assert.match(buildAdsAlertText(acted, target, 'ar'), /خُفِّضت الميزانية/);
        const raise = buildAdsAlertText({ ...acted, steps: [{ kind: 'propose', objectId: 'o1', action: 'resume' }] }, target, 'en');
        assert.match(raise, /waits for your approval/);
    });

    it('a blind rule names the reason, in both languages', () => {
        const blind: AdsAlert = { kind: 'rule_blind', ruleId: 'r1', ruleName: 'Pace', reason: 'throttled', hours: 26 };
        assert.match(buildAdsAlertText(blind, target, 'en'), /26 hours[\s\S]*limiting requests/);
        assert.match(buildAdsAlertText(blind, target, 'ar'), /26 ساعة/);
    });
});

describe('localDay', () => {
    it('is the ad account\'s calendar day', () => {
        assert.equal(localDay(new Date('2026-10-31T22:00:00Z'), 3), '2026-11-01');
        assert.equal(localDay(new Date('2026-10-31T22:00:00Z'), 0), '2026-10-31');
    });
});

describe('notifyAds', () => {
    let db: FakeDb;
    let settings: Map<string, string>;
    let alertRows: Array<{ id: string; key: string; channels: unknown }>;
    let telegramSent: Array<{ url: string; body: any }>;
    let emailSent: Array<{ body: any }>;
    let originalTelegram: typeof telegramHttp.post;
    let originalEmail: typeof emailHttp.post;
    let telegramFails: boolean;

    beforeEach(() => {
        db = installFakeDb();
        settings = new Map();
        alertRows = [];
        telegramSent = [];
        emailSent = [];
        telegramFails = false;
        const value = (key: string) => (settings.has(key) ? [{ key, value: settings.get(key), is_secret: false }] : []);
        db.routes.push(
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: value(p[0]) })],
            [/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/, (p) => ({ rows: (p[0] as string[]).flatMap(value) })],
            [/^INSERT INTO ads_alerts/, (p) => {
                const key = `${p[0]}|${p[1]}|${p[2]}|${p[3]}`;
                if (alertRows.some((r) => r.key === key)) return { rows: [] };
                const row = { id: `alert-${alertRows.length + 1}`, key, channels: null };
                alertRows.push(row);
                return { rows: [{ id: row.id }] };
            }],
            [/^UPDATE ads_alerts SET channels/, (p) => {
                const row = alertRows.find((r) => r.id === p[0]);
                if (row) row.channels = JSON.parse(p[1]);
                return { rows: [] };
            }],
        );
        originalTelegram = telegramHttp.post;
        originalEmail = emailHttp.post;
        (telegramHttp as any).post = async (url: string, body: any) => {
            telegramSent.push({ url, body });
            if (telegramFails) throw Object.assign(new Error('x'), { response: { status: 400, data: { ok: false, description: 'chat not found' } } });
            return { data: { ok: true } };
        };
        (emailHttp as any).post = async (_url: string, body: any) => { emailSent.push({ body }); return { data: { id: 'e1' } }; };
        // The deployment's bot and Resend key; the admin's own chat and address.
        settings.set('notify.telegram_bot_token', BOT);
        settings.set('notify.telegram_chat_id', '999');
        settings.set('notify.telegram_enabled', 'true');
        settings.set('notify.email_api_key', KEY);
        settings.set('notify.email_to', 'admin@example.com');
        settings.set('notify.email_enabled', 'true');
    });
    afterEach(() => {
        db.restore();
        (telegramHttp as any).post = originalTelegram;
        (emailHttp as any).post = originalEmail;
    });

    it('sends to the tenant\'s own chat and email in its language, and a bilingual copy to the admin', async () => {
        settings.set(`ads.alerts.${TENANT}`, JSON.stringify({ telegramChatId: '4242', email: 'owner@example.com', lang: 'en' }));
        const r = await notifyAds(capPaused, target);
        assert.equal(r.outcome, 'sent');
        assert.deepEqual(r.channels, { telegram: 'sent', email: 'sent', admin_copy: 'sent' });
        const toTenant = telegramSent.find((m) => m.body.chat_id === '4242');
        const toAdmin = telegramSent.find((m) => m.body.chat_id === '999');
        assert.ok(toTenant && toAdmin);
        assert.ok(toTenant!.url.includes(BOT), 'the deployment bot sends it');
        assert.doesNotMatch(toTenant!.body.text, /[؀-ۿ]/, 'English for this tenant');
        assert.match(toAdmin!.body.text, /[؀-ۿ]/);
        assert.match(toAdmin!.body.text, /[A-Za-z]{4,}/, 'the admin copy has both languages');
        assert.ok(emailSent.some((e) => JSON.stringify(e.body).includes('owner@example.com')));
        assert.deepEqual(alertRows[0]!.channels, r.channels, 'the outcome is recorded on the row');
    });

    it('sends at most once per kind, object and day', async () => {
        const first = await notifyAds(capPaused, target, { now: new Date('2026-10-22T10:00:00Z') });
        const again = await notifyAds(capPaused, target, { now: new Date('2026-10-22T18:00:00Z') });
        const tomorrow = await notifyAds(capPaused, target, { now: new Date('2026-10-23T10:00:00Z') });
        assert.equal(first.outcome, 'sent');
        assert.equal(again.outcome, 'duplicate');
        assert.equal(tomorrow.outcome, 'sent');
        const other = await notifyAds(capPaused, target, { now: new Date('2026-10-22T18:00:00Z'), objectKey: 'campaign-2' });
        assert.equal(other.outcome, 'sent', 'another object the same day is another alert');
    });

    it('a kind the tenant switched off is not sent to the tenant; a required one always is', async () => {
        settings.set(`ads.alerts.${TENANT}`, JSON.stringify({ telegramChatId: '4242', kinds: { version_mismatch: false, cap_paused: false } }));
        settings.set('ads.copy_admin', 'false');
        const off = await notifyAds({ kind: 'version_mismatch', pinned: 'v26.0', served: 'v25.0' }, target);
        assert.equal(off.channels.telegram, 'off');
        const required = await notifyAds(capPaused, target);
        assert.equal(required.channels.telegram, 'sent', 'cap_paused cannot be switched off');
    });

    it('no admin copy when ads.copy_admin is false, or when the tenant\'s chat is the admin\'s', async () => {
        settings.set(`ads.alerts.${TENANT}`, JSON.stringify({ telegramChatId: '999' }));
        settings.delete('notify.email_enabled');
        const r = await notifyAds(capPaused, target);
        assert.equal(telegramSent.length, 1, 'one message to the shared chat, not two');
        assert.equal(r.channels.telegram, 'sent');
        settings.set('ads.copy_admin', 'false');
        settings.set(`ads.alerts.${TENANT}`, JSON.stringify({}));
        const r2 = await notifyAds({ kind: 'token_dead', code: 190 }, target);
        assert.equal(r2.channels.admin_copy, 'off');
        assert.equal(r2.channels.telegram, 'off');
    });

    it('records a failed channel, and never throws, even when the database does', async () => {
        settings.set(`ads.alerts.${TENANT}`, JSON.stringify({ telegramChatId: '4242' }));
        settings.set('ads.copy_admin', 'false');
        telegramFails = true;
        const r = await notifyAds(capPaused, target);
        assert.equal(r.channels.telegram, 'failed');
        db.routes.unshift([/^INSERT INTO ads_alerts/, () => { throw new Error('db down'); }]);
        const broken = await notifyAds({ kind: 'token_dead', code: 190 }, target);
        assert.equal(broken.outcome, 'error');
    });

    it('sendAdsTest sends to the tenant\'s recipients with no dedupe row', async () => {
        settings.set(`ads.alerts.${TENANT}`, JSON.stringify({ telegramChatId: '4242', email: 'owner@example.com' }));
        const r = await sendAdsTest(TENANT);
        assert.deepEqual(r, { telegram: 'sent', email: 'sent' });
        assert.equal(alertRows.length, 0);
    });
});
