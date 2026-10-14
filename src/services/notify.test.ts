/**
 * The owner's alerts (`notify.ts`): what is saved, what a Telegram call looks like, what an alert says, and what never leaves the process.
 *
 * Nothing here reaches Telegram, Postgres or Meta: `telegramHttp.post` is a stub and `pool.query` answers on the SQL it is handed, and any
 * statement a test did not arrange throws. What is pinned, because each is a way the owner is hurt rather than helped:
 *
 *   - the message is PLAIN TEXT: no `parse_mode` is ever sent, so what a customer typed (`<b>`, `*`, a link) is shown as typed and cannot
 *     make the alert say something else;
 *   - the bot token is in the URL of every call and therefore in every axios error: it is in no log line, no result, no response;
 *   - the Settings card is told `{ set, last4 }` and never the token, and the token is stored encrypted;
 *   - a customer's link is not made tappable in the owner's chat, and text that reorders or hides is taken out.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import {
    buildNoticeText, describeTelegramSettings, excerpt, formatRemaining, inboxLink, mergeTelegram, parseTelegramInput, readTelegramSettings, saveTelegramInput,
    scrub, sendTelegramMessage, sendTestMessage, telegramHttp, telegramReady, telegramSettingsOf, windowRemainingMs, WINDOW_MS,
    type TelegramSettings,
} from './notify.js';
import { APP_SETTING_KEYS, type AppSettingKey } from './appSettings.js';

/** A made-up token of the right shape. It belongs to no bot. */
const TOKEN = '123456789:AAH_fake_token_for_tests_0123456789abcd';
const CHAT = '4242424242';

let lines: string[];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((_level, line) => { lines.push(line); });
    restoreSink = () => setLogSink(previous);
});
afterEach(() => { lines = []; });
beforeEach(() => { lines = []; });

// ─── The words ──────────────────────────────────────────────────────────────────────────────

describe('excerpt: what a customer typed, made safe to show the owner', () => {
    it('leaves markup as it was typed: the message has no parse_mode, so <b> is just characters', () => {
        assert.equal(excerpt('<b>pay</b> *now* _please_ `x` & <script>alert(1)</script>'), '<b>pay</b> *now* _please_ `x` & <script>alert(1)</script>');
    });

    it('replaces anything that Telegram would make tappable with [link]: a scheme, www, or a bare domain', () => {
        assert.equal(excerpt('go to https://evil.example/pay?x=1 now'), 'go to [link] now');
        assert.equal(excerpt('see www.evil.example or evil.example/buy or t.me/scamchannel'), 'see [link] or [link] or [link]');
        assert.equal(excerpt('كم السعر؟ زر evil.com'), 'كم السعر؟ زر [link]');
        assert.equal(excerpt('e.g. a price, i.e. cost'), 'e.g. a price, i.e. cost', 'abbreviations are not domains');
    });

    it('takes out bidirectional controls and control characters, and keeps the joiners Arabic and Persian need', () => {
        assert.equal(excerpt('abc‮def⁦ghi‏jkl\u0007'), 'abcdefghijkl');
        assert.equal(excerpt('می‌خواهم'), 'می‌خواهم', 'a zero-width non-joiner is a letter of the language');
    });

    it('collapses whitespace, and cuts to the limit on whole characters with an ellipsis', () => {
        assert.equal(excerpt('a\n\n  b\tc'), 'a b c');
        const long = excerpt('ب'.repeat(300), 200);
        assert.equal(Array.from(long).length, 201);
        assert.ok(long.endsWith('…'));
        assert.equal(excerpt('😀'.repeat(250), 200).replace('…', '').length, 400, 'cut between emoji, never inside one');
        assert.equal(excerpt(null), '');
        assert.equal(excerpt(undefined), '');
    });
});

describe('the window', () => {
    const at = (iso: string) => new Date(iso);

    it('is 24 hours from the person\'s last message, 0 when it has closed, null when there is none', () => {
        const now = at('2026-10-14T12:00:00Z');
        assert.equal(windowRemainingMs('2026-10-14T11:00:00Z', now), 23 * 3600 * 1000);
        assert.equal(windowRemainingMs(at('2026-10-13T12:00:00Z'), now), 0, 'exactly 24 h: closed');
        assert.equal(windowRemainingMs('2026-10-10T12:00:00Z', now), 0);
        assert.equal(windowRemainingMs('2026-10-14T13:00:00Z', now), WINDOW_MS, 'a clock a little ahead never promises more than 24 h');
        assert.equal(windowRemainingMs(null, now), null);
        assert.equal(windowRemainingMs('not a date', now), null);
    });

    it('is said in hours and minutes, in Latin digits, in both languages', () => {
        assert.equal(formatRemaining(5 * 3600_000 + 20 * 60_000, 'en'), '5 h 20 min');
        assert.equal(formatRemaining(3 * 3600_000, 'en'), '3 h');
        assert.equal(formatRemaining(40 * 60_000, 'en'), '40 min');
        assert.equal(formatRemaining(20_000, 'en'), 'less than a minute');
        assert.equal(formatRemaining(5 * 3600_000 + 20 * 60_000, 'ar'), '5 ساعة و20 دقيقة');
        assert.equal(formatRemaining(2 * 3600_000, 'ar'), '2 ساعة');
        assert.equal(formatRemaining(40 * 60_000, 'ar'), '40 دقيقة');
    });
});

describe('inboxLink', () => {
    it('is the open conversation on the public origin, or nothing when there is no origin', () => {
        assert.equal(inboxLink('https://msg.example', 'abc-123'), 'https://msg.example/dashboard#/inbox?c=abc-123');
        assert.equal(inboxLink('https://msg.example/', 'abc-123'), 'https://msg.example/dashboard#/inbox?c=abc-123');
        assert.equal(inboxLink(null, 'abc-123'), null);
        assert.equal(inboxLink('https://msg.example', 'a b&c'), 'https://msg.example/dashboard#/inbox?c=a%20b%26c', 'an id is encoded, never trusted');
    });
});

describe('buildNoticeText', () => {
    const base = {
        kind: 'handoff' as const, reason: 'refund', lang: 'en' as const, username: 'sara_dev', senderId: '17841400000000001',
        lastMessage: 'I want my money back', windowMs: 5 * 3600_000 + 20 * 60_000, link: 'https://msg.example/dashboard#/inbox?c=abc',
    };

    it('says who, why, what they wrote, how long the window has left and where to open it, one per line', () => {
        assert.equal(buildNoticeText(base), [
            'Needs you: refund request',
            'Customer: @sara_dev',
            'Last message: «I want my money back»',
            'Reply window: closes in 5 h 20 min',
            'Open: https://msg.example/dashboard#/inbox?c=abc',
        ].join('\n'));
    });

    it('is Arabic for an Arabic profile, and names a hot lead for what it is', () => {
        const ar = buildNoticeText({ ...base, lang: 'ar', reason: 'wants_human' });
        assert.match(ar, /^يحتاج ردك: طلب التحدث مع شخص\n/);
        assert.match(ar, /\nنافذة الرد: تُغلق بعد 5 ساعة و20 دقيقة\n/);
        const hot = buildNoticeText({ ...base, kind: 'hot_lead' });
        assert.match(hot, /^Hot lead: the link was sent\n/);
        assert.ok(!hot.includes('refund request'), 'a hot lead has no handoff reason');
    });

    it('names a customer with no username by the end of their id, and an unknown reason as the assistant not being sure', () => {
        const text = buildNoticeText({ ...base, username: null, reason: 'something_new' });
        assert.match(text, /^Needs you: the assistant was not sure how to answer\n/);
        assert.match(text, /\nCustomer: Instagram user …0001\n/);
    });

    it('says the window has closed, and leaves the line out when it is unknown or there is no link', () => {
        assert.match(buildNoticeText({ ...base, windowMs: 0 }), /\nReply window: closed, so reply from the Instagram app\n/);
        const bare = buildNoticeText({ ...base, windowMs: null, link: null });
        assert.ok(!/Reply window|Open:/.test(bare), bare);
    });

    it('puts a customer\'s markup, links and reordering controls through the same filter: nothing a customer wrote becomes a link or a command', () => {
        const text = buildNoticeText({
            ...base, username: '<i>x</i>‮', lastMessage: '<a href="https://evil.example">click</a> visit evil.example⁦ `rm`',
        });
        assert.ok(!/evil/.test(text), text);
        assert.ok(!/[‪-‮⁦-⁩]/.test(text));
        assert.match(text, /^Customer: @<i>x<\/i>$/m, 'the name is shown as typed, minus the control');
        // The link takes the rest of its word with it (`">click</a>` is part of what follows the scheme): over-cutting is the safe error.
        assert.ok(text.includes('«<a href="[link] visit [link] `rm`»'), text);
    });
});

// ─── Sending ────────────────────────────────────────────────────────────────────────────────

interface Posted { url: string; body: any }

/** Replace `telegramHttp.post` for one test. */
function stubTelegram(answer: (url: string, body: any) => Promise<any>): { posted: Posted[]; restore: () => void } {
    const posted: Posted[] = [];
    const original = telegramHttp.post;
    (telegramHttp as any).post = async (url: string, body: any) => {
        posted.push({ url, body });
        return answer(url, body);
    };
    return { posted, restore: () => { (telegramHttp as any).post = original; } };
}

/** An axios error the way axios builds one: the message, and a `config.url` that carries the token. */
function axiosError(status: number | null, description: string | null, extra: Record<string, unknown> = {}): Error {
    return Object.assign(new Error(status ? `Request failed with status code ${status}` : 'timeout of 5000ms exceeded'), {
        isAxiosError: true,
        config: { url: `/bot${TOKEN}/sendMessage`, baseURL: 'https://api.telegram.org', data: JSON.stringify({ chat_id: CHAT, text: 'x' }) },
        request: { path: `/bot${TOKEN}/sendMessage`, host: 'api.telegram.org' },
        stack: `Error: boom\n    at post (https://api.telegram.org/bot${TOKEN}/sendMessage)`,
        ...(status ? { response: { status, data: description === null ? {} : { ok: false, error_code: status, description } } } : { code: 'ECONNABORTED' }),
        ...extra,
    });
}

describe('sendTelegramMessage', () => {
    it('is one sendMessage to the bot\'s own URL with the chat, the text and nothing else: plain text, no parse_mode, no link preview', async () => {
        const { posted, restore } = stubTelegram(async () => ({ data: { ok: true, result: { message_id: 7 } } }));
        try {
            const result = await sendTelegramMessage({ token: TOKEN, chatId: CHAT }, '<b>not bold</b> *nor this*');
            assert.deepEqual(result, { ok: true });
            assert.equal(posted.length, 1);
            assert.equal(posted[0]!.url, `/bot${TOKEN}/sendMessage`);
            assert.deepEqual(posted[0]!.body, { chat_id: CHAT, text: '<b>not bold</b> *nor this*', disable_web_page_preview: true });
            assert.ok(!('parse_mode' in posted[0]!.body), 'no parse_mode: nothing is read as markup');
        } finally { restore(); }
    });

    it('answers a status and a description, never an error, when Telegram says no', async () => {
        const { restore } = stubTelegram(async () => { throw axiosError(401, 'Unauthorized'); });
        try {
            assert.deepEqual(await sendTelegramMessage({ token: TOKEN, chatId: CHAT }, 'hi'), { ok: false, reason: 'rejected', status: 401, description: 'Unauthorized' });
        } finally { restore(); }
    });

    it('reads an `ok: false` answer under a 200 as a refusal too', async () => {
        const { restore } = stubTelegram(async () => ({ data: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } }));
        try {
            assert.deepEqual(await sendTelegramMessage({ token: TOKEN, chatId: CHAT }, 'hi'), { ok: false, reason: 'rejected', status: 400, description: 'Bad Request: chat not found' });
        } finally { restore(); }
    });

    it('answers `unreachable` with the error CODE only when Telegram did not answer', async () => {
        const { restore } = stubTelegram(async () => { throw axiosError(null, null); });
        try {
            assert.deepEqual(await sendTelegramMessage({ token: TOKEN, chatId: CHAT }, 'hi'), { ok: false, reason: 'unreachable', status: null, description: 'ECONNABORTED' });
        } finally { restore(); }
    });

    it('the token is in NOTHING it returns, whatever the failure and whatever Telegram echoed back', async () => {
        const failures = [
            axiosError(401, 'Unauthorized'),
            axiosError(404, `Not Found: bot${TOKEN}/sendMessage`),
            axiosError(400, `Bad Request: token ${TOKEN} is wrong`),
            axiosError(502, 'proxy error talking to /bot999999999:ZZZ_another_token_that_is_not_ours_0000000/sendMessage'),
            axiosError(null, null),
        ];
        for (const failure of failures) {
            const { restore } = stubTelegram(async () => { throw failure; });
            try {
                const result = await sendTelegramMessage({ token: TOKEN, chatId: CHAT }, 'hi');
                const wire = JSON.stringify(result);
                assert.ok(!wire.includes(TOKEN), wire);
                assert.ok(!wire.includes(`bot${TOKEN}`), wire);
                assert.ok(!/\d{5,15}:[A-Za-z0-9_-]{30,}/.test(wire), `nothing token-shaped either: ${wire}`);
            } finally { restore(); }
        }
    });
});

describe('scrub', () => {
    it('removes the saved token, its bot<token> form, and anything shaped like a token', () => {
        assert.equal(scrub(`a ${TOKEN} b`, TOKEN), 'a [token] b');
        assert.equal(scrub(`GET /bot${TOKEN}/getMe`, TOKEN), 'GET /bot[token]/getMe');
        assert.equal(scrub('/bot111111111:YYY_somebody_elses_token_0123456789_abc/x', TOKEN), '/bot[token]/x');
        assert.equal(scrub('nothing to see', null), 'nothing to see');
    });
});

// ─── Settings ───────────────────────────────────────────────────────────────────────────────

describe('parseTelegramInput', () => {
    it('accepts a token, a chat id (a number, a group\'s negative one, or a channel name) and the two switches', () => {
        assert.deepEqual(parseTelegramInput({ botToken: TOKEN, chatId: '-1001234567890', enabled: true, hotLeads: false }), {
            ok: true, value: { botToken: TOKEN, chatId: '-1001234567890', enabled: true, hotLeads: false },
        });
        assert.deepEqual(parseTelegramInput({ chatId: '@my_channel' }), { ok: true, value: { chatId: '@my_channel' } });
        assert.deepEqual(parseTelegramInput({ chatId: 42 }), { ok: true, value: { chatId: '42' } });
    });

    it('leaves a blank or absent token alone, and clears one only on an explicit null', () => {
        assert.deepEqual(parseTelegramInput({ botToken: '' }), { ok: true, value: {} });
        assert.deepEqual(parseTelegramInput({ botToken: '   ' }), { ok: true, value: {} });
        assert.deepEqual(parseTelegramInput({}), { ok: true, value: {} });
        assert.deepEqual(parseTelegramInput(undefined), { ok: true, value: {} });
        assert.deepEqual(parseTelegramInput({ botToken: null, chatId: '' }), { ok: true, value: { botToken: null, chatId: null } });
    });

    it('refuses what is not a token, a chat id or a switch, naming the field and never repeating the value', () => {
        const typo = '12345:short';
        const bad = parseTelegramInput({ botToken: typo });
        assert.equal(bad.ok, false);
        assert.equal(!bad.ok && bad.field, 'botToken');
        assert.ok(!(bad as { error: string }).error.includes(typo));
        const chat = parseTelegramInput({ chatId: 'my chat' });
        assert.equal(!chat.ok && chat.field, 'chatId');
        const sw = parseTelegramInput({ enabled: 'yes' });
        assert.equal(!sw.ok && sw.field, 'enabled');
        assert.equal(!parseTelegramInput({ hotLeads: 1 }).ok, true);
        assert.equal(!parseTelegramInput({ botToken: 12345 }).ok, true);
    });
});

describe('what the Settings card is told', () => {
    const saved: TelegramSettings = { token: TOKEN, chatId: CHAT, enabled: true, hotLeads: true };

    it('is { set, last4 } for the token and never the token: not in the JSON, in no field', () => {
        const status = describeTelegramSettings(saved);
        assert.deepEqual(status.botToken, { set: true, last4: 'abcd' });
        assert.ok(!JSON.stringify(status).includes(TOKEN));
        assert.ok(!JSON.stringify(status).includes(TOKEN.slice(0, 20)), 'not even a long part of it');
        assert.deepEqual(describeTelegramSettings({ ...saved, token: null }).botToken, { set: false, last4: null });
    });

    it('is ready only when alerts are on AND both the token and the chat id are saved', () => {
        assert.equal(telegramReady(saved), true);
        assert.equal(telegramReady({ ...saved, enabled: false }), false);
        assert.equal(telegramReady({ ...saved, token: null }), false);
        assert.equal(telegramReady({ ...saved, chatId: null }), false);
        assert.equal(describeTelegramSettings({ ...saved, chatId: null }).ready, false);
    });

    it('reads a switch as on only when it is exactly "true", and hot leads as on unless it is exactly "false"', () => {
        const of = (entries: Array<[AppSettingKey, string | null]>) => telegramSettingsOf(new Map(entries));
        assert.deepEqual(of([]), { token: null, chatId: null, enabled: false, hotLeads: true });
        assert.equal(of([[APP_SETTING_KEYS.notifyTelegramEnabled, 'TRUE']]).enabled, false);
        assert.equal(of([[APP_SETTING_KEYS.notifyTelegramEnabled, 'true']]).enabled, true);
        assert.equal(of([[APP_SETTING_KEYS.notifyTelegramHotLeads, 'false']]).hotLeads, false);
        assert.equal(of([[APP_SETTING_KEYS.notifyTelegramHotLeads, 'anything']]).hotLeads, true);
    });

    it('merges a save over what is stored, so "on" can be refused while half the address is missing', () => {
        const none: TelegramSettings = { token: null, chatId: null, enabled: false, hotLeads: true };
        assert.deepEqual(mergeTelegram(none, { enabled: true }), { ...none, enabled: true });
        assert.deepEqual(mergeTelegram(saved, { botToken: null }), { ...saved, token: null });
        assert.deepEqual(mergeTelegram(saved, {}), saved);
    });
});

describe('the saved settings', () => {
    let originalQuery: typeof pool.query;
    let originalKey: string | undefined;
    let writes: Array<{ key: string; value: string; isSecret: boolean }>;
    let deletes: string[];
    let rows: Array<{ key: string; value: string; is_secret: boolean }>;

    beforeEach(() => {
        originalKey = process.env.TOKEN_ENCRYPTION_KEY;
        process.env.TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
        writes = []; deletes = []; rows = [];
        originalQuery = pool.query;
        (pool as any).query = async (sql: string, params: any[] = []) => {
            if (/INSERT INTO app_settings/.test(sql)) {
                writes.push({ key: params[0], value: params[1], isSecret: params[2] });
                return { rows: [], rowCount: 1 };
            }
            if (/DELETE FROM app_settings/.test(sql)) { deletes.push(params[0]); return { rows: [], rowCount: 1 }; }
            if (/FROM app_settings WHERE key = ANY/.test(sql)) return { rows, rowCount: rows.length };
            throw new Error(`no result arranged for SQL: ${sql}`);
        };
    });
    afterEach(() => {
        (pool as any).query = originalQuery;
        if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
        else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
    });

    it('stores the token ENCRYPTED and marks it secret, and the chat id and the switches as they are', async () => {
        await saveTelegramInput({ botToken: TOKEN, chatId: CHAT, enabled: true, hotLeads: false }, 'u-1');
        const byKey = new Map(writes.map((w) => [w.key, w]));
        const token = byKey.get('notify.telegram_bot_token')!;
        assert.equal(token.isSecret, true);
        assert.ok(token.value.startsWith('enc:v1:'), 'encrypted at rest');
        assert.ok(!token.value.includes(TOKEN));
        assert.deepEqual([byKey.get('notify.telegram_chat_id')!.value, byKey.get('notify.telegram_chat_id')!.isSecret], [CHAT, false]);
        assert.equal(byKey.get('notify.telegram_enabled')!.value, 'true');
        assert.equal(byKey.get('notify.telegram_hot_leads')!.value, 'false', 'a switch turned off is saved as off, not deleted');
    });

    it('clears a token or a chat id on null, and writes nothing for what the save does not carry', async () => {
        await saveTelegramInput({ botToken: null, chatId: null }, 'u-1');
        assert.deepEqual(deletes.sort(), ['notify.telegram_bot_token', 'notify.telegram_chat_id']);
        assert.equal(writes.length, 0);
        await saveTelegramInput({}, 'u-1');
        assert.equal(writes.length + deletes.length, 2);
    });

    it('reads the token back decrypted, for the sender alone', async () => {
        await saveTelegramInput({ botToken: TOKEN }, 'u-1');
        const stored = writes.find((w) => w.key === 'notify.telegram_bot_token')!;
        rows = [
            { key: 'notify.telegram_bot_token', value: stored.value, is_secret: true },
            { key: 'notify.telegram_chat_id', value: CHAT, is_secret: false },
            { key: 'notify.telegram_enabled', value: 'true', is_secret: false },
        ];
        assert.deepEqual(await readTelegramSettings(), { token: TOKEN, chatId: CHAT, enabled: true, hotLeads: true });
    });

    it('the test message uses what is saved, and says plainly when there is nothing to send with', async () => {
        assert.deepEqual(await sendTestMessage('en'), { ok: false, reason: 'not_configured', status: null, description: '' });
        rows = [
            { key: 'notify.telegram_bot_token', value: TOKEN, is_secret: false },
            { key: 'notify.telegram_chat_id', value: CHAT, is_secret: false },
        ];
        const { posted, restore } = stubTelegram(async () => ({ data: { ok: true } }));
        try {
            assert.deepEqual(await sendTestMessage('ar'), { ok: true }, 'sent although alerts are not switched on: the button exists to find out');
            assert.equal(posted.length, 1);
            assert.match(posted[0]!.body.text, /^رسالة تجريبية/);
            await sendTestMessage('en');
            assert.match(posted[1]!.body.text, /^Test message/);
        } finally { restore(); }
        assert.ok(lines.every((l) => !l.includes(TOKEN)));
    });
});

after(() => restoreSink?.());
