/**
 * The owner's alert on TWO channels (`handoff.ts` `notifyOwner`, `notifyEmail.ts`): Telegram and email, each when the owner switched it on,
 * independent of each other. Every alert from every caller (a sales turn, a failed reply, a WhatsApp reply that could not be sent) goes
 * through `notifyOwner`, so this is the one place the fan-out has to be right.
 *
 * Nothing here touches Postgres, Telegram, Resend or Meta: `pool.query` answers on the SQL it is handed (any statement a test did not
 * arrange throws), `telegramHttp.post` and `emailHttp.post` are stubs. That matters in this repository: `.env` holds live credentials, and a
 * test that reached either network could message the owner.
 *
 * What is pinned, because each is a way the owner is not told, is told twice, or is hurt:
 *
 *   - with email off (every deployment before it existed, or a key saved but the switch off) the alert is EXACTLY the Telegram one it was:
 *     the same statements in the same order, the same call, the same log lines, and no email call and no lookup of the contact address;
 *   - with both on, each gets the alert, and one refusing, timing out or throwing changes nothing about the other;
 *   - the per-conversation allowance is spent once per alert, not once per channel;
 *   - a hot lead is its own switch on each channel (email's is off unless turned on);
 *   - the Resend key is in no log line and no statement parameter, and an address Resend echoes is taken out of the log.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { DEFAULT_CONTACT_EMAIL } from '../appSettings.js';
import { buildNoticeText, telegramHttp } from '../notify.js';
import { DEFAULT_EMAIL_FROM, emailHttp } from '../notifyEmail.js';
import { invalidateTenantCache } from '../tenant.js';
import { setLogSink } from '../../utils/log.js';
import { HANDOFF_ALERTS_PER_HOUR, notifyOwner, type NoticePlan } from './handoff.js';

type Row = Record<string, unknown>;
interface Sent { url: string; body: any; config?: any }

const TOKEN = '123456789:AAH_fake_token_for_tests_0123456789abcd';
const CHAT = '4242424242';
const KEY = 're_AbCdEfGh_0123456789abcdefghijkl';
const OWNER_ADDRESS = 'owner@example.com';
const BASE = 'https://msg.example';
const NOW = Date.parse('2026-10-19T12:00:00Z');

const TELEGRAM: Record<string, string> = {
    'notify.telegram_bot_token': TOKEN, 'notify.telegram_chat_id': CHAT, 'notify.telegram_enabled': 'true', 'app.public_base_url': BASE,
};
const EMAIL: Record<string, string> = { 'notify.email_api_key': KEY, 'notify.email_enabled': 'true', 'notify.email_to': OWNER_ADDRESS };
const BOTH = { ...TELEGRAM, ...EMAIL };
/** Telegram off, email on: the owner who only set up email. */
const EMAIL_ONLY = { 'app.public_base_url': BASE, ...EMAIL };

const FACTS: Row = {
    username: 'sara_dev', instagram_user_id: '17841400000000001', platform: 'instagram', profile_name: null, wa_username: null,
    last_inbound_text: 'I want a refund, give me my money back', last_inbound_at: new Date(NOW - 3 * 3600_000),
};
const HANDOFF = { kind: 'handoff', reason: 'refund' } as NoticePlan;
const HOT = { kind: 'hot_lead' } as NoticePlan;

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

interface World {
    settings?: Record<string, string>;
    owner?: string;
    plan?: NoticePlan;
    language?: string;
    facts?: Row;
    telegram?: (url: string, body: any) => Promise<any>;
    email?: (url: string, body: any, config: any) => Promise<any>;
    /** The statement that reads the site contact email throws. */
    contactDown?: boolean;
    /** How many times `notifyOwner` is called for the one conversation. */
    times?: number;
    counters?: Record<string, number>;
}

interface Run {
    outcomes: string[];
    telegram: Sent[];
    emails: Sent[];
    /** What each statement was, in order: `settings:many`, `settings:one(<key>)`, `owner`, `limiter`, `facts`. */
    kinds: string[];
    params: any[][];
    logged: Array<{ level: string; event: string; [k: string]: unknown }>;
    lines: string[];
}

async function call(world: World = {}): Promise<Run> {
    const settings = world.settings ?? TELEGRAM;
    const owner = world.owner ?? 'creator-1';
    const kinds: string[] = [];
    const params: any[][] = [];
    const telegram: Sent[] = [];
    const emails: Sent[] = [];
    const logged: Run['logged'] = [];
    const lines: string[] = [];
    const counters = new Map(Object.entries(world.counters ?? {}));
    const outcomes: string[] = [];

    const originalQuery = pool.query;
    const originalTelegram = telegramHttp.post;
    const originalEmail = emailHttp.post;
    const originalBase = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    const previousSink = setLogSink((level, line) => { lines.push(line); logged.push({ level, ...JSON.parse(line) }); });
    (pool as any).query = async (sql: string, p: any[] = []) => {
        params.push(p);
        if (/FROM app_settings WHERE key = ANY/.test(sql)) {
            kinds.push('settings:many');
            return { rows: (p[0] as string[]).filter((k) => k in settings).map((key) => ({ key, value: settings[key], is_secret: false })) };
        }
        if (/FROM app_settings WHERE key = \$1/.test(sql)) {
            kinds.push(`settings:one(${p[0]})`);
            if (world.contactDown && p[0] === 'site.contact_email') throw new Error('connection terminated');
            return { rows: p[0] in settings ? [{ key: p[0], value: settings[p[0]], is_secret: false }] : [] };
        }
        if (/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/.test(sql)) { kinds.push('owner'); return { rows: [{ id: owner }] }; }
        if (/INSERT INTO rate_limit_counters/.test(sql)) {
            kinds.push('limiter');
            const next = (counters.get(String(p[1])) ?? 0) + 1;
            counters.set(String(p[1]), next);
            return { rows: [{ count: next }] };
        }
        if (/SELECT c\.username/.test(sql)) { kinds.push('facts'); return { rows: [{ ...FACTS, ...world.facts }] }; }
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    (telegramHttp as any).post = async (url: string, body: any) => {
        telegram.push({ url, body });
        return (world.telegram ?? (async () => ({ data: { ok: true } })))(url, body);
    };
    (emailHttp as any).post = async (url: string, body: any, config: any) => {
        emails.push({ url, body, config });
        return (world.email ?? (async () => ({ status: 200, data: { id: 'email-1' } })))(url, body, config);
    };
    invalidateTenantCache();
    try {
        for (let i = 0; i < (world.times ?? 1); i++) {
            outcomes.push(await notifyOwner({
                creatorId: 'creator-1', conversationId: 'conv-1', plan: world.plan ?? HANDOFF, language: world.language ?? 'en', now: new Date(NOW),
            }));
        }
    } finally {
        (pool as any).query = originalQuery;
        (telegramHttp as any).post = originalTelegram;
        (emailHttp as any).post = originalEmail;
        if (originalBase === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = originalBase;
        setLogSink(previousSink);
        invalidateTenantCache();
    }
    return { outcomes, telegram, emails, kinds, params, logged, lines };
}

const events = (r: Run): string[] => r.logged.map((l) => l.event);
const notifyEvents = (r: Run): Run['logged'] => r.logged.filter((l) => /^dm\.handoff_notif/.test(l.event));

const refused = (status: number, data: unknown) => async () => { throw Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } }); };

// ─── Telegram alone is exactly what it was ──────────────────────────────────────────────────

describe('with email off, an alert is exactly the Telegram alert it always was', () => {
    const PLAIN_WORLD_KINDS = ['settings:many', 'owner', 'limiter', 'facts', 'settings:one(app.public_base_url)'];

    it('reads, limits, looks up and calls in that order, with one Telegram call of the same shape, and logs one line', async () => {
        const r = await call();

        assert.deepEqual(r.outcomes, ['sent']);
        assert.deepEqual(r.kinds, PLAIN_WORLD_KINDS, 'the same statements in the same order: ONE settings read, no contact-email lookup, nothing for email');
        assert.equal(r.telegram.length, 1);
        assert.equal(r.telegram[0]!.url, `/bot${TOKEN}/sendMessage`);
        assert.deepEqual(Object.keys(r.telegram[0]!.body).sort(), ['chat_id', 'disable_web_page_preview', 'text']);
        assert.equal(r.telegram[0]!.body.chat_id, CHAT);
        assert.equal(r.telegram[0]!.body.text, buildNoticeText({
            kind: 'handoff', reason: 'refund', lang: 'en', username: 'sara_dev', platform: 'instagram', senderId: '17841400000000001',
            lastMessage: 'I want a refund, give me my money back', windowMs: 21 * 3600_000, link: `${BASE}/dashboard#/inbox?c=conv-1`,
        }));
        assert.deepEqual(r.telegram[0]!.body.text.split('\n'), [
            'Needs you: refund request',
            'Customer: @sara_dev',
            'Last message: «I want a refund, give me my money back»',
            'Reply window: closes in 21 h',
            `Open: ${BASE}/dashboard#/inbox?c=conv-1`,
        ]);
        assert.equal(r.emails.length, 0, 'no email call');
        const log = notifyEvents(r);
        assert.deepEqual(log.map((l) => l.event), ['dm.handoff_notified']);
        const { ts: _ts, ...line } = log[0]!;
        assert.deepEqual(line, { level: 'info', event: 'dm.handoff_notified', conversation_id: 'conv-1', kind: 'handoff', reason: 'refund' });
    });

    it('reads the nine keys of both channels in the ONE statement the four Telegram keys used to be', async () => {
        const r = await call();
        const read = r.params[r.kinds.indexOf('settings:many')]![0] as string[];
        assert.equal(read.length, 9);
        assert.ok(['notify.telegram_bot_token', 'notify.telegram_chat_id', 'notify.telegram_enabled', 'notify.telegram_hot_leads'].every((k) => read.includes(k)));
        assert.ok(['notify.email_api_key', 'notify.email_to', 'notify.email_from', 'notify.email_enabled', 'notify.email_hot_leads'].every((k) => read.includes(k)));
    });

    it('is the same with a key and an address SAVED but the switch off, or the switch on and no key: nothing for email, byte for byte', async () => {
        const baseline = await call();
        for (const settings of [
            { ...TELEGRAM, 'notify.email_api_key': KEY, 'notify.email_to': OWNER_ADDRESS, 'notify.email_enabled': 'false' },
            { ...TELEGRAM, 'notify.email_api_key': KEY, 'notify.email_to': OWNER_ADDRESS },
            { ...TELEGRAM, 'notify.email_enabled': 'true', 'notify.email_to': OWNER_ADDRESS },
            { ...TELEGRAM, 'notify.email_enabled': 'true' },
        ]) {
            const r = await call({ settings });
            assert.equal(r.emails.length, 0, JSON.stringify(settings));
            assert.deepEqual(r.telegram, baseline.telegram);
            assert.deepEqual(r.kinds, baseline.kinds);
            assert.deepEqual(notifyEvents(r).map(({ ts: _t, ...l }) => l), notifyEvents(baseline).map(({ ts: _t, ...l }) => l));
            assert.deepEqual(r.outcomes, ['sent']);
        }
    });

    it('a Telegram refusal is the same two things it was: a warn line with the status and the words, and a "failed" outcome', async () => {
        const r = await call({ telegram: refused(401, { ok: false, description: 'Unauthorized' }) });
        assert.deepEqual(r.outcomes, ['failed']);
        const failure = r.logged.find((l) => l.event === 'dm.handoff_notify_failed')!;
        assert.deepEqual([failure.level, failure.outcome, failure.status, failure.description], ['warn', 'rejected', 401, 'Unauthorized']);
        assert.deepEqual(events(r).filter((e) => /handoff_notif/.test(e)), ['dm.handoff_notify_failed']);
        assert.equal(r.emails.length, 0);
    });

    it('alerts off or half configured on BOTH channels say nothing and spend nothing', async () => {
        const cases: Array<Record<string, string>> = [{}, { ...BOTH, 'notify.telegram_enabled': 'false', 'notify.email_enabled': 'false' }, { 'notify.email_enabled': 'true' }];
        for (const settings of cases) {
            const r = await call({ settings });
            assert.deepEqual(r.outcomes, ['off'], JSON.stringify(settings));
            assert.equal(r.telegram.length + r.emails.length, 0);
            assert.ok(!r.kinds.includes('limiter') && !r.kinds.includes('facts') && !r.kinds.includes('owner'), `nothing spent: ${r.kinds}`);
        }
    });
});

// ─── Both channels ──────────────────────────────────────────────────────────────────────────

describe('with both on, each channel gets the alert', () => {
    it('sends one Telegram message and one email, from ONE settings read, ONE allowance and ONE facts lookup', async () => {
        const r = await call({ settings: BOTH });

        assert.deepEqual(r.outcomes, ['sent']);
        assert.equal(r.telegram.length, 1);
        assert.equal(r.emails.length, 1);
        assert.deepEqual(r.kinds, ['settings:many', 'owner', 'limiter', 'facts', 'settings:one(app.public_base_url)'], 'one of each, whatever the number of channels');
        const email = r.emails[0]!;
        assert.equal(email.url, '/emails');
        assert.deepEqual(email.config, { headers: { Authorization: `Bearer ${KEY}` } });
        assert.deepEqual(Object.keys(email.body).sort(), ['from', 'subject', 'text', 'to']);
        assert.deepEqual([email.body.from, email.body.to], [DEFAULT_EMAIL_FROM, [OWNER_ADDRESS]]);
        assert.equal(email.body.subject, 'A conversation needs you on Instagram — @sara_dev');
        const telegramLines = r.telegram[0]!.body.text.split('\n');
        assert.deepEqual(email.body.text.split('\n'), [telegramLines[0], 'Channel: Instagram', ...telegramLines.slice(1)], 'the same alert plus the channel');
        assert.deepEqual(events(r).filter((e) => /handoff_notif/.test(e)).sort(), ['dm.handoff_notified', 'dm.handoff_notified_email']);
    });

    it('spends the conversation\'s hourly allowance once per ALERT: 3 alerts go to both channels and the fourth to neither', async () => {
        const r = await call({ settings: BOTH, times: 5 });
        assert.equal(HANDOFF_ALERTS_PER_HOUR, 3);
        assert.deepEqual(r.outcomes, ['sent', 'sent', 'sent', 'rate_limited', 'rate_limited']);
        assert.equal(r.telegram.length, 3);
        assert.equal(r.emails.length, 3);
    });

    it('Telegram refusing does not stop the email, and the alert still counts as sent', async () => {
        const r = await call({ settings: BOTH, telegram: refused(401, { ok: false, description: 'Unauthorized' }) });

        assert.deepEqual(r.outcomes, ['sent']);
        assert.equal(r.emails.length, 1, 'the email went although Telegram said no');
        assert.deepEqual(events(r).filter((e) => /handoff_notif/.test(e)).sort(), ['dm.handoff_notified_email', 'dm.handoff_notify_failed']);
    });

    it('the email refusing does not stop Telegram, and says why in the log with the owner\'s address and the key taken out', async () => {
        const r = await call({
            settings: BOTH,
            email: refused(403, { statusCode: 403, name: 'validation_error', message: `You can only send testing emails to your own email address (${OWNER_ADDRESS}). Sent with ${KEY}` }),
        });

        assert.deepEqual(r.outcomes, ['sent']);
        assert.equal(r.telegram.length, 1, 'Telegram went although Resend said no');
        const failure = r.logged.find((l) => l.event === 'dm.handoff_notify_email_failed')!;
        assert.deepEqual([failure.level, failure.outcome, failure.status], ['warn', 'rejected', 403]);
        assert.equal(failure.description, 'You can only send testing emails to your own email address ([address]). Sent with [key]');
        assert.ok(events(r).includes('dm.handoff_notified'));
        assert.ok(!events(r).includes('dm.handoff_notified_email'));
    });

    it('both refusing is a failed alert that costs nothing: two failure lines, no throw', async () => {
        const r = await call({ settings: BOTH, telegram: refused(401, { ok: false, description: 'Unauthorized' }), email: refused(401, { message: 'API key is invalid' }) });
        assert.deepEqual(r.outcomes, ['failed']);
        assert.deepEqual(events(r).filter((e) => /handoff_notif/.test(e)).sort(), ['dm.handoff_notify_email_failed', 'dm.handoff_notify_failed']);
        assert.equal(r.logged.find((l) => l.event === 'dm.handoff_notify_email_failed')!.description, 'API key is invalid');
    });

    it('neither channel hanging up on us (no answer at all) is the same: the other is still sent', async () => {
        const timeout = async () => { throw Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }); };
        const emailDown = await call({ settings: BOTH, email: timeout });
        assert.deepEqual([emailDown.outcomes, emailDown.telegram.length], [['sent'], 1]);
        assert.deepEqual([emailDown.logged.find((l) => l.event === 'dm.handoff_notify_email_failed')!.outcome, emailDown.logged.find((l) => l.event === 'dm.handoff_notify_email_failed')!.status], ['unreachable', null]);
        const telegramDown = await call({ settings: BOTH, telegram: timeout });
        assert.deepEqual([telegramDown.outcomes, telegramDown.emails.length], [['sent'], 1]);
    });

    it('a channel that THROWS is a failed channel, not a lost alert: the other still goes and the turn is not an error', async () => {
        // An error object that cannot be read: `sendTelegramMessage` does not guard against it, so this is the channel itself throwing.
        const hostile = async () => { throw new Proxy({}, { get() { throw new Error('boom'); } }); };
        const r = await call({ settings: BOTH, telegram: hostile });

        assert.deepEqual(r.outcomes, ['sent'], 'the email counts');
        assert.equal(r.emails.length, 1);
        assert.ok(events(r).includes('dm.handoff_notified_email'));
        const channelError = r.logged.find((l) => l.event === 'dm.handoff_notify_channel_error')!;
        assert.equal(channelError.channel, 'telegram');
        assert.ok(!events(r).includes('dm.handoff_notify_error'), 'it did not reach the outer catch');
    });

    it('the email alone, when Telegram is not set up: one email, no Telegram call', async () => {
        const r = await call({ settings: EMAIL_ONLY });
        assert.deepEqual(r.outcomes, ['sent']);
        assert.equal(r.telegram.length, 0);
        assert.equal(r.emails.length, 1);
        assert.deepEqual(events(r).filter((e) => /handoff_notif/.test(e)), ['dm.handoff_notified_email']);
    });

    it('is the Arabic alert for an Arabic profile, and names WhatsApp for a WhatsApp conversation, in the subject and the body', async () => {
        const r = await call({
            settings: BOTH, language: 'ar',
            facts: { platform: 'whatsapp', username: null, profile_name: 'Zainab Al-Fassi', instagram_user_id: 'EG.13491208655302741918', last_inbound_at: new Date(NOW - 26 * 3600_000) },
        });
        assert.equal(r.emails[0]!.body.subject, 'محادثة بانتظارك على واتساب — Zainab Al-Fassi');
        assert.deepEqual(r.emails[0]!.body.text.split('\n').slice(0, 3), ['يحتاج ردك: طلب استرجاع', 'القناة: واتساب', 'العميل: Zainab Al-Fassi']);
        assert.match(r.telegram[0]!.body.text, /واتساب|Zainab/);
        const en = await call({ settings: BOTH, facts: { platform: 'whatsapp', username: null, profile_name: 'Zainab Al-Fassi', instagram_user_id: 'EG.13491208655302741918' } });
        assert.equal(en.emails[0]!.body.subject, 'A conversation needs you on WhatsApp — Zainab Al-Fassi');
    });

    it('a WhatsApp reply that could not be sent is told on both channels with the reason', async () => {
        const r = await call({
            settings: BOTH, plan: { kind: 'handoff', reason: 'window_closed' } as NoticePlan,
            facts: { platform: 'whatsapp', username: null, profile_name: 'Zainab', instagram_user_id: 'EG.1349120865' },
        });
        assert.equal(r.telegram.length, 1);
        assert.equal(r.emails.length, 1);
        assert.match(r.emails[0]!.body.text, /^Needs you: the 24-hour window had closed, so no reply could be sent\nChannel: WhatsApp\n/);
    });
});

// ─── The address ────────────────────────────────────────────────────────────────────────────

describe('where the email goes', () => {
    const NO_ADDRESS = { ...TELEGRAM, 'notify.email_api_key': KEY, 'notify.email_enabled': 'true' };

    it('to the site contact email when the owner typed no address, and to the deployment\'s default contact when Settings has none either', async () => {
        const configured = await call({ settings: { ...NO_ADDRESS, 'site.contact_email': 'contact@example.com' } });
        assert.deepEqual(configured.emails[0]!.body.to, ['contact@example.com']);
        assert.ok(configured.kinds.includes('settings:one(site.contact_email)'));
        const fallback = await call({ settings: NO_ADDRESS });
        assert.deepEqual(fallback.emails[0]!.body.to, [DEFAULT_CONTACT_EMAIL]);
    });

    it('a typed address wins, and is the only thing used: the contact email is not even looked up', async () => {
        const r = await call({ settings: { ...NO_ADDRESS, 'notify.email_to': OWNER_ADDRESS, 'site.contact_email': 'contact@example.com' } });
        assert.deepEqual(r.emails[0]!.body.to, [OWNER_ADDRESS]);
        assert.ok(!r.kinds.includes('settings:one(site.contact_email)'));
    });

    it('a contact email that cannot be read costs the email, never the Telegram alert', async () => {
        const r = await call({ settings: NO_ADDRESS, contactDown: true });
        assert.deepEqual(r.outcomes, ['sent']);
        assert.equal(r.telegram.length, 1);
        assert.equal(r.emails.length, 0);
    });

    it('uses the sender the owner saved (an address on a domain he verified), else Resend\'s shared one', async () => {
        const own = await call({ settings: { ...BOTH, 'notify.email_from': 'AutoReply Pro <alerts@your-domain.com>' } });
        assert.equal(own.emails[0]!.body.from, 'AutoReply Pro <alerts@your-domain.com>');
        assert.equal((await call({ settings: BOTH })).emails[0]!.body.from, 'AutoReply Pro <onboarding@resend.dev>');
    });
});

// ─── Hot leads ──────────────────────────────────────────────────────────────────────────────

describe('a hot lead has its own switch on each channel', () => {
    it('Telegram\'s is on unless turned off, and email\'s is OFF unless turned on: a hot lead reaches Telegram alone by default', async () => {
        const r = await call({ settings: BOTH, plan: HOT });
        assert.deepEqual(r.outcomes, ['sent']);
        assert.equal(r.telegram.length, 1);
        assert.equal(r.emails.length, 0, 'the email owner has not asked for hot leads');
        assert.match(r.telegram[0]!.body.text, /^Hot lead: the link was sent\n/);
    });

    it('both when email\'s is turned on, and the email says what it is', async () => {
        const r = await call({ settings: { ...BOTH, 'notify.email_hot_leads': 'true' }, plan: HOT, facts: { platform: 'whatsapp', username: null, profile_name: 'Zainab', instagram_user_id: 'EG.1349120865' } });
        assert.equal(r.telegram.length, 1);
        assert.equal(r.emails.length, 1);
        assert.equal(r.emails[0]!.body.subject, 'Hot lead on WhatsApp — Zainab');
        assert.match(r.emails[0]!.body.text, /^Hot lead: the link was sent\nChannel: WhatsApp\n/);
    });

    it('each channel keeps its own: Telegram\'s off with email\'s on is the email alone', async () => {
        const r = await call({ settings: { ...BOTH, 'notify.telegram_hot_leads': 'false', 'notify.email_hot_leads': 'true' }, plan: HOT });
        assert.deepEqual([r.telegram.length, r.emails.length], [0, 1]);
    });

    it('with every on channel\'s hot-lead switch off, a hot lead is told to nobody and spends nothing; a handoff is still told to both', async () => {
        const off = await call({ settings: { ...BOTH, 'notify.telegram_hot_leads': 'false' }, plan: HOT });
        assert.deepEqual(off.outcomes, ['hot_leads_off']);
        assert.equal(off.telegram.length + off.emails.length, 0);
        assert.ok(!off.kinds.includes('limiter'));
        const handoff = await call({ settings: { ...BOTH, 'notify.telegram_hot_leads': 'false' } });
        assert.deepEqual([handoff.telegram.length, handoff.emails.length], [1, 1]);
    });

    it('a channel that is not on does not make the other\'s hot-lead switch matter: email alone, hot leads off, is "hot_leads_off"', async () => {
        const r = await call({ settings: EMAIL_ONLY, plan: HOT });
        assert.deepEqual(r.outcomes, ['hot_leads_off']);
        assert.equal(r.emails.length, 0);
    });
});

// ─── Whose alerts, and the secret ───────────────────────────────────────────────────────────

describe('alerts are the platform owner\'s, on every channel', () => {
    it('another tenant\'s customer is never sent to the owner\'s Telegram NOR his inbox', async () => {
        const r = await call({ settings: BOTH, owner: 'someone-else' });
        assert.deepEqual(r.outcomes, ['not_owner']);
        assert.equal(r.telegram.length + r.emails.length, 0);
        assert.ok(!r.kinds.includes('facts'), 'nothing about the conversation was even read');
    });
});

describe('the Resend API key', () => {
    it('is in no log line, whatever the email did, and in no statement parameter; it is in the Authorization header of the one call and there only', async () => {
        const failures = [
            refused(401, { message: `Invalid key ${KEY}` }),
            async () => { throw Object.assign(new Error(`connect ECONNREFUSED ${KEY}`), { code: 'ECONNREFUSED', config: { headers: { Authorization: `Bearer ${KEY}` } } }); },
            async () => ({ status: 200, data: { id: 'x' } }),
        ];
        for (const email of failures) {
            const r = await call({ settings: BOTH, email });
            assert.ok(r.lines.length > 0);
            for (const line of r.lines) {
                assert.ok(!line.includes(KEY), line);
                assert.ok(!/re_[A-Za-z0-9_-]{16,}/.test(line), line);
                assert.ok(!line.includes(OWNER_ADDRESS), `the owner's address is not in the log: ${line}`);
                assert.ok(!line.includes(TOKEN), line);
            }
            assert.deepEqual(r.params.filter((p) => JSON.stringify(p).includes(KEY)), [], 'settings are read by key; their values come back in rows and never go out in a statement');
            assert.ok(JSON.stringify(r.emails[0]!.config).includes(KEY));
            assert.ok(!r.emails[0]!.url.includes(KEY) && !JSON.stringify(r.emails[0]!.body).includes(KEY));
        }
    });
});
