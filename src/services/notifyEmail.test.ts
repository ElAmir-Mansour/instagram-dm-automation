/**
 * The owner's alerts by email (`notifyEmail.ts`): what is saved, what a Resend call looks like, what an email says, and what never leaves
 * the process.
 *
 * Nothing here reaches Resend, Postgres or Meta: `emailHttp.post` is a stub and `pool.query` answers on the SQL it is handed, and any
 * statement a test did not arrange throws. What is pinned, because each is a way the owner is hurt rather than helped:
 *
 *   - the API key is in a request HEADER and therefore in every axios error: it is in no log line, no result, no response, and the card is
 *     told `{ set, last4 }` and nothing more (the key is stored encrypted);
 *   - an input can never become two recipients or a header: one plain address, no commas, spaces, angle brackets or line breaks;
 *   - the subject is one line and names the channel and the customer; the body is the Telegram alert's own text (what a customer typed has
 *     its links and reordering controls taken out) plus a line naming the channel;
 *   - saving a key switches email on (the owner's only step), hot leads stay off, and the address falls back to the site contact email.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { APP_SETTING_KEYS, DEFAULT_CONTACT_EMAIL } from './appSettings.js';
import { buildNoticeText, type NoticeInput } from './notify.js';
import {
    DEFAULT_EMAIL_FROM, EMAIL_TIMEOUT_MS, RESEND_API, describeEmailSettings, effectiveTo, emailBody, emailHttp, emailReady, emailSettingsOf, emailSubject,
    isEmailAddress, isEmailSender, mergeEmail, parseEmailInput, readEmailSettings, readNotifyChannels, redactAddresses, saveEmailInput, scrubKey,
    sendEmail, sendEmailNotice, sendTestEmail, type EmailSettings,
} from './notifyEmail.js';

/** A made-up key of the right shape. It belongs to no account. */
const KEY = 're_AbCdEfGh_0123456789abcdefghijkl';
const OWNER = 'owner@example.com';

let lines: string[];
let restoreSink: (() => void) | undefined;
beforeEach(() => {
    lines = [];
    const previous = setLogSink((_level, line) => { lines.push(line); });
    restoreSink = () => setLogSink(previous);
});
afterEach(() => { restoreSink?.(); });

interface Posted { url: string; body: any; config: any }

function stubResend(answer: (url: string, body: any, config: any) => Promise<any>): { posted: Posted[]; restore: () => void } {
    const posted: Posted[] = [];
    const original = emailHttp.post;
    (emailHttp as any).post = async (url: string, body: any, config: any) => { posted.push({ url, body, config }); return answer(url, body, config); };
    return { posted, restore: () => { (emailHttp as any).post = original; } };
}

const settings = (over: Partial<EmailSettings> = {}): EmailSettings => ({ apiKey: KEY, to: OWNER, defaultTo: null, from: null, enabled: true, hotLeads: false, ...over });

const notice = (over: Partial<NoticeInput> = {}): NoticeInput => ({
    kind: 'handoff', reason: 'refund', lang: 'en', username: 'sara_dev', senderId: '17841400000000001', lastMessage: 'I want a refund, give me my money back',
    windowMs: 20 * 3600_000 + 59 * 60_000, link: 'https://msg.example/dashboard#/inbox?c=conv-1', platform: 'instagram', ...over,
});

// ─── What is accepted ───────────────────────────────────────────────────────────────────────

describe('addresses and senders', () => {
    it('accepts one plain address, and refuses anything that could be two recipients or a header', () => {
        for (const ok of ['owner@example.com', 'first.last+alerts@sub.example.co.uk', "o'neil@example.org"]) assert.ok(isEmailAddress(ok), ok);
        for (const bad of [
            '', 'owner', 'owner@', '@example.com', 'owner@example', 'a@b.com, c@d.com', 'a@b.com;c@d.com', 'a b@example.com', '<a@b.com>', 'Name <a@b.com>',
            'a@b.com\nBcc: x@y.com', 'a@b.com\r\nSubject: x', '"a"@b.com', `${'a'.repeat(250)}@b.com`, 'مالك@example.com',
        ]) assert.ok(!isEmailAddress(bad), JSON.stringify(bad));
    });

    it('accepts a sender as an address, or a name and an address in angle brackets, and nothing else', () => {
        for (const ok of ['alerts@your-domain.com', 'AutoReply Pro <alerts@your-domain.com>', DEFAULT_EMAIL_FROM]) assert.ok(isEmailSender(ok), ok);
        for (const bad of ['', 'Name alerts@your-domain.com', '<alerts@your-domain.com>', 'A <a@b.com> <c@d.com>', 'A\nBcc: x@y.com <a@b.com>', 'A "<a@b.com>', `${'x'.repeat(100)} <a@b.com>`]) {
            assert.ok(!isEmailSender(bad), JSON.stringify(bad));
        }
    });
});

describe('parseEmailInput', () => {
    it('accepts a key, an address, a sender and the two switches', () => {
        const parsed = parseEmailInput({ apiKey: ` ${KEY} `, to: ` ${OWNER} `, from: 'AutoReply Pro <alerts@your-domain.com>', enabled: false, hotLeads: true });
        assert.deepEqual(parsed, { ok: true, value: { apiKey: KEY, to: OWNER, from: 'AutoReply Pro <alerts@your-domain.com>', enabled: false, hotLeads: true } });
    });

    it('SWITCHES EMAIL ON when a key is saved and the same save says nothing about the switch: pasting the key is the whole set-up', () => {
        assert.deepEqual(parseEmailInput({ apiKey: KEY }), { ok: true, value: { apiKey: KEY, enabled: true } });
        assert.deepEqual(parseEmailInput({ apiKey: KEY, enabled: false }), { ok: true, value: { apiKey: KEY, enabled: false } }, 'unless the save says off');
        assert.deepEqual(parseEmailInput({ to: OWNER }), { ok: true, value: { to: OWNER } }, 'no key, no change of the switch');
        assert.deepEqual(parseEmailInput({ apiKey: null }), { ok: true, value: { apiKey: null } }, 'removing the key switches nothing on');
    });

    it('leaves a blank or absent key alone, and clears a key, an address and a sender only on an explicit null or an empty string', () => {
        assert.deepEqual(parseEmailInput({ apiKey: '' }), { ok: true, value: {} });
        assert.deepEqual(parseEmailInput({ apiKey: '   ' }), { ok: true, value: {} });
        assert.deepEqual(parseEmailInput(undefined), { ok: true, value: {} });
        assert.deepEqual(parseEmailInput({ to: '', from: null }), { ok: true, value: { to: null, from: null } });
    });

    it('refuses what is not a key, an address, a sender or a switch, naming the field and never repeating the value', () => {
        const typo = 're_short';
        for (const [email, field] of [
            [{ apiKey: typo }, 'emailApiKey'],
            [{ apiKey: 'sk-live-1234567890123456789012' }, 'emailApiKey'],
            [{ apiKey: 12345 }, 'emailApiKey'],
            [{ to: 'not an address' }, 'emailTo'],
            [{ to: 'a@b.com, c@d.com' }, 'emailTo'],
            [{ to: 42 }, 'emailTo'],
            [{ from: 'no brackets here@x.com' }, 'emailFrom'],
            [{ enabled: 'yes' }, 'emailEnabled'],
            [{ hotLeads: 1 }, 'emailHotLeads'],
        ] as const) {
            const parsed = parseEmailInput(email);
            assert.equal(parsed.ok, false, JSON.stringify(email));
            if (parsed.ok) continue;
            assert.equal(parsed.field, field);
            for (const typed of [typo, 'not an address', 'a@b.com', 'no brackets here@x.com']) assert.ok(!parsed.error.includes(typed), `${parsed.error} repeats ${typed}`);
        }
    });

    it('merges a save over what is stored, so "on" can be refused while the key is missing', () => {
        const current = settings({ apiKey: null, enabled: false });
        assert.equal(mergeEmail(current, { enabled: true }).apiKey, null);
        assert.equal(emailReady(mergeEmail(current, { apiKey: KEY, enabled: true })), true);
        assert.equal(mergeEmail(settings(), { apiKey: null }).apiKey, null, 'an explicit null removes it');
        assert.equal(mergeEmail(settings(), {}).apiKey, KEY, 'absent keeps it');
        assert.equal(mergeEmail(settings({ to: OWNER }), { to: null }).to, null);
    });
});

// ─── What the card is told ──────────────────────────────────────────────────────────────────

describe('what the Settings card is told', () => {
    it('is { set, last4 } for the key and never the key: not in the JSON, in no field', () => {
        const status = describeEmailSettings(settings());
        assert.deepEqual(status.apiKey, { set: true, last4: 'ijkl' });
        assert.ok(!JSON.stringify(status).includes(KEY));
        assert.deepEqual(describeEmailSettings(settings({ apiKey: null })).apiKey, { set: false, last4: null });
    });

    it('is ready only when email is on AND there is a key AND an address, and the address is the saved one or else the contact email', () => {
        assert.equal(describeEmailSettings(settings()).ready, true);
        assert.equal(describeEmailSettings(settings({ enabled: false })).ready, false);
        assert.equal(describeEmailSettings(settings({ apiKey: null })).ready, false);
        assert.equal(describeEmailSettings(settings({ to: null, defaultTo: null })).ready, false, 'no address anywhere');
        const fallback = describeEmailSettings(settings({ to: null, defaultTo: 'contact@example.com' }));
        assert.deepEqual([fallback.ready, fallback.to, fallback.toIsDefault], [true, 'contact@example.com', true]);
        const typed = describeEmailSettings(settings({ to: OWNER, defaultTo: 'contact@example.com' }));
        assert.deepEqual([typed.to, typed.toIsDefault], [OWNER, false]);
        assert.equal(describeEmailSettings(settings()).defaultFrom, DEFAULT_EMAIL_FROM);
    });

    it('reads a switch as on only when it is exactly "true": hot leads are OFF unless turned on (Telegram\'s are on unless turned off)', () => {
        const read = (values: Record<string, string>) => emailSettingsOf(new Map(Object.entries(values)) as any);
        assert.deepEqual([read({}).enabled, read({}).hotLeads], [false, false]);
        assert.deepEqual([read({ 'notify.email_enabled': 'true' }).enabled, read({ 'notify.email_hot_leads': 'true' }).hotLeads], [true, true]);
        assert.deepEqual([read({ 'notify.email_enabled': 'yes' }).enabled, read({ 'notify.email_hot_leads': 'false' }).hotLeads], [false, false]);
        assert.equal(effectiveTo({ to: null, defaultTo: null }), null);
    });
});

// ─── The saved settings ─────────────────────────────────────────────────────────────────────

describe('the saved settings', () => {
    let originalQuery: typeof pool.query;
    let originalEncryptionKey: string | undefined;
    let writes: Array<{ key: string; value: string; isSecret: boolean }>;
    let deletes: string[];
    let rows: Array<{ key: string; value: string; is_secret: boolean }>;
    let statements: string[];
    let contactDown: boolean;

    beforeEach(() => {
        originalEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
        process.env.TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
        writes = []; deletes = []; rows = []; statements = []; contactDown = false;
        originalQuery = pool.query;
        (pool as any).query = async (sql: string, params: any[] = []) => {
            statements.push(sql.replace(/\s+/g, ' ').trim());
            if (/INSERT INTO app_settings/.test(sql)) { writes.push({ key: params[0], value: params[1], isSecret: params[2] }); return { rows: [], rowCount: 1 }; }
            if (/DELETE FROM app_settings/.test(sql)) { deletes.push(params[0]); return { rows: [], rowCount: 1 }; }
            if (/FROM app_settings WHERE key = ANY/.test(sql)) {
                const wanted = params[0] as string[];
                return { rows: rows.filter((r) => wanted.includes(r.key)), rowCount: 1 };
            }
            if (/FROM app_settings WHERE key = \$1/.test(sql)) {
                if (contactDown && params[0] === APP_SETTING_KEYS.siteContactEmail) throw new Error('connection terminated');
                const row = rows.find((r) => r.key === params[0]);
                return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
            }
            throw new Error(`no result arranged for SQL: ${sql}`);
        };
    });
    afterEach(() => {
        (pool as any).query = originalQuery;
        if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
        else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
    });

    it('stores the key ENCRYPTED and marks it secret, and the address, sender and switches as they are', async () => {
        await saveEmailInput({ apiKey: KEY, to: OWNER, from: 'A <a@b.com>', enabled: true, hotLeads: false }, 'u-1');
        const byKey = new Map(writes.map((w) => [w.key, w]));
        const key = byKey.get('notify.email_api_key')!;
        assert.equal(key.isSecret, true);
        assert.ok(key.value.startsWith('enc:v1:'), 'encrypted at rest');
        assert.ok(!key.value.includes(KEY));
        assert.deepEqual([byKey.get('notify.email_to')!.value, byKey.get('notify.email_to')!.isSecret], [OWNER, false]);
        assert.equal(byKey.get('notify.email_from')!.value, 'A <a@b.com>');
        assert.equal(byKey.get('notify.email_enabled')!.value, 'true');
        assert.equal(byKey.get('notify.email_hot_leads')!.value, 'false', 'a switch turned off is saved as off, not deleted');
    });

    it('clears on null, and writes nothing for what the save does not carry', async () => {
        await saveEmailInput({ apiKey: null, to: null, from: null }, 'u-1');
        assert.deepEqual(deletes.sort(), ['notify.email_api_key', 'notify.email_from', 'notify.email_to']);
        assert.equal(writes.length, 0);
        await saveEmailInput({}, 'u-1');
        assert.equal(writes.length + deletes.length, 3);
    });

    it('reads the key back decrypted, for the sender alone', async () => {
        await saveEmailInput({ apiKey: KEY, to: OWNER, enabled: true }, 'u-1');
        const stored = writes.find((w) => w.key === 'notify.email_api_key')!;
        rows = [
            { key: 'notify.email_api_key', value: stored.value, is_secret: true },
            { key: 'notify.email_to', value: OWNER, is_secret: false },
            { key: 'notify.email_enabled', value: 'true', is_secret: false },
        ];
        assert.deepEqual(await readEmailSettings(), { apiKey: KEY, to: OWNER, defaultTo: null, from: null, enabled: true, hotLeads: false });
    });

    it('falls back to the SITE CONTACT EMAIL when no address is saved, and to the deployment\'s default contact when that is unset too', async () => {
        const bare = await readEmailSettings();
        assert.equal(bare.to, null);
        assert.equal(bare.defaultTo, DEFAULT_CONTACT_EMAIL);
        rows = [{ key: APP_SETTING_KEYS.siteContactEmail, value: 'contact@example.com', is_secret: false }];
        const saved = await readEmailSettings();
        assert.equal(effectiveTo(saved), 'contact@example.com');
        assert.equal(describeEmailSettings(saved).toIsDefault, true);
        rows.push({ key: 'notify.email_to', value: OWNER, is_secret: false });
        statements = [];
        const typed = await readEmailSettings();
        assert.equal(effectiveTo(typed), OWNER, 'a typed address wins');
        assert.ok(!statements.some((s) => /key = \$1/.test(s)), 'and the contact email is not even read');
    });

    it('a contact email that cannot be read leaves email not ready; it does not throw', async () => {
        contactDown = true;
        const s = await readEmailSettings();
        assert.deepEqual([s.to, s.defaultTo], [null, null]);
        assert.ok(lines.some((l) => JSON.parse(l).event === 'notify.email_default_to_failed'));
    });

    it('reads BOTH channels in ONE statement, and the contact email only when email is on, has a key and has no address', async () => {
        // Email off (every deployment before it existed): the one read Telegram alone cost.
        const off = await readNotifyChannels();
        assert.equal(statements.length, 1);
        assert.match(statements[0]!, /key = ANY/);
        assert.deepEqual([off.telegram.enabled, off.email.enabled], [false, false]);

        statements = [];
        rows = [{ key: 'notify.email_enabled', value: 'false', is_secret: false }, { key: 'notify.email_api_key', value: KEY, is_secret: false }];
        await readNotifyChannels();
        assert.equal(statements.length, 1, 'a key saved but email switched off still reads nothing more');

        statements = [];
        rows = [{ key: 'notify.email_enabled', value: 'true', is_secret: false }, { key: 'notify.email_api_key', value: KEY, is_secret: false }];
        const on = await readNotifyChannels();
        assert.ok(statements.length > 1, 'on, with a key and no address: the contact email is read');
        assert.equal(effectiveTo(on.email), DEFAULT_CONTACT_EMAIL);
        assert.equal(emailReady(on.email), true);

        statements = [];
        rows.push({ key: 'notify.email_to', value: OWNER, is_secret: false });
        await readNotifyChannels();
        assert.equal(statements.length, 1, 'with an address saved there is nothing to look up');
    });

    it('the test email uses what is saved, whether or not email is on, and says plainly when there is nothing to send with', async () => {
        assert.deepEqual(await sendTestEmail('en'), { ok: false, reason: 'not_configured', status: null, description: '' });
        rows = [{ key: 'notify.email_api_key', value: KEY, is_secret: false }, { key: 'notify.email_from', value: 'A <a@b.com>', is_secret: false }];
        const { posted, restore } = stubResend(async () => ({ status: 200, data: { id: 'x' } }));
        try {
            assert.deepEqual(await sendTestEmail('ar'), { ok: true }, 'sent although email is not switched on, to the contact email');
            assert.equal(posted.length, 1);
            assert.deepEqual(posted[0]!.body.to, [DEFAULT_CONTACT_EMAIL]);
            assert.equal(posted[0]!.body.from, 'A <a@b.com>');
            assert.match(posted[0]!.body.text, /^رسالة تجريبية/);
            await sendTestEmail('en');
            assert.match(posted[1]!.body.text, /^Test email/);
            assert.match(posted[1]!.body.subject, /test email/);
        } finally { restore(); }
    });

    it('a settings read that fails is an error result, not a throw', async () => {
        (pool as any).query = async () => { throw new Error('connection terminated'); };
        assert.deepEqual(await sendTestEmail('en'), { ok: false, reason: 'error', status: null, description: '' });
        assert.deepEqual(await sendEmailNotice(notice()), { ok: false, reason: 'error', status: null, description: '' });
    });
});

// ─── Sending ────────────────────────────────────────────────────────────────────────────────

describe('sendEmail', () => {
    it('is one POST to Resend\'s /emails with a bearer key and { from, to, subject, text } and nothing else: plain text, one recipient', async () => {
        assert.equal(emailHttp.defaults.baseURL, 'https://api.resend.com');
        assert.equal(RESEND_API, 'https://api.resend.com');
        assert.equal(emailHttp.defaults.timeout, 5000);
        assert.equal(EMAIL_TIMEOUT_MS, 5000);
        const { posted, restore } = stubResend(async () => ({ status: 200, data: { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' } }));
        try {
            assert.deepEqual(await sendEmail({ apiKey: KEY, to: OWNER, from: null }, { subject: 'S', text: 'T' }), { ok: true });
            assert.equal(posted.length, 1);
            assert.equal(posted[0]!.url, '/emails');
            assert.deepEqual(posted[0]!.body, { from: DEFAULT_EMAIL_FROM, to: [OWNER], subject: 'S', text: 'T' });
            assert.deepEqual(posted[0]!.config, { headers: { Authorization: `Bearer ${KEY}` } }, 'the key is in the header, and in no body or URL');
            assert.ok(!posted[0]!.url.includes(KEY) && !JSON.stringify(posted[0]!.body).includes(KEY));
            await sendEmail({ apiKey: KEY, to: OWNER, from: 'AutoReply Pro <alerts@your-domain.com>' }, { subject: 'S', text: 'T' });
            assert.equal(posted[1]!.body.from, 'AutoReply Pro <alerts@your-domain.com>', 'the saved sender when there is one');
        } finally { restore(); }
    });

    it('answers a status and Resend\'s own message when it says no, never an error: the free sender may only write to the account\'s own address', async () => {
        const { restore } = stubResend(async () => {
            throw Object.assign(new Error('Request failed with status code 403'), {
                config: { headers: { Authorization: `Bearer ${KEY}` } },
                response: { status: 403, data: { statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address (me@example.com).' } },
            });
        });
        try {
            const result = await sendEmail({ apiKey: KEY, to: 'other@example.com', from: null }, { subject: 'S', text: 'T' });
            assert.deepEqual(result, { ok: false, reason: 'rejected', status: 403, description: 'You can only send testing emails to your own email address (me@example.com).' });
        } finally { restore(); }
    });

    it('falls back to Resend\'s error name, then to the status, and reads a 3xx/4xx that came back as a response as a refusal too', async () => {
        const named = stubResend(async () => { throw Object.assign(new Error('x'), { response: { status: 401, data: { statusCode: 401, name: 'missing_api_key' } } }); });
        try { assert.deepEqual(await sendEmail({ apiKey: KEY, to: OWNER, from: null }, { subject: 'S', text: 'T' }), { ok: false, reason: 'rejected', status: 401, description: 'missing_api_key' }); } finally { named.restore(); }
        const bare = stubResend(async () => { throw Object.assign(new Error('x'), { response: { status: 502, data: '<html>Bad gateway</html>' } }); });
        try { assert.deepEqual(await sendEmail({ apiKey: KEY, to: OWNER, from: null }, { subject: 'S', text: 'T' }), { ok: false, reason: 'rejected', status: 502, description: 'HTTP 502' }); } finally { bare.restore(); }
        const resolved = stubResend(async () => ({ status: 429, data: { message: 'You have exceeded your daily email sending quota.' } }));
        try { assert.deepEqual(await sendEmail({ apiKey: KEY, to: OWNER, from: null }, { subject: 'S', text: 'T' }), { ok: false, reason: 'rejected', status: 429, description: 'You have exceeded your daily email sending quota.' }); } finally { resolved.restore(); }
    });

    it('answers `unreachable` with the error CODE only when Resend did not answer', async () => {
        const { restore } = stubResend(async () => { throw Object.assign(new Error(`timeout of 5000ms exceeded; Authorization: Bearer ${KEY}`), { code: 'ECONNABORTED', config: { headers: { Authorization: `Bearer ${KEY}` } } }); });
        try {
            assert.deepEqual(await sendEmail({ apiKey: KEY, to: OWNER, from: null }, { subject: 'S', text: 'T' }), { ok: false, reason: 'unreachable', status: null, description: 'ECONNABORTED' });
        } finally { restore(); }
        const odd = stubResend(async () => { throw new Error(`weird ${KEY}`); });
        try {
            assert.deepEqual(await sendEmail({ apiKey: KEY, to: OWNER, from: null }, { subject: 'S', text: 'T' }), { ok: false, reason: 'unreachable', status: null, description: 'network error' });
        } finally { odd.restore(); }
    });

    it('never throws, whatever the client does', async () => {
        const evil = new Proxy({}, { get() { throw new Error(`boom ${KEY}`); } });
        const { restore } = stubResend(async () => { throw evil; });
        try {
            const result = await sendEmail({ apiKey: KEY, to: OWNER, from: null }, { subject: 'S', text: 'T' }).catch(() => 'threw');
            assert.notEqual(result, 'threw', 'a hostile error object is the one thing the catch cannot read; it must still not escape');
        } catch { assert.fail('sendEmail threw'); } finally { restore(); }
    });

    it('the key is in NOTHING it returns, whatever the failure and whatever Resend echoed back', async () => {
        const echoes: Array<() => Promise<any>> = [
            async () => { throw Object.assign(new Error(`Request failed ${KEY}`), { config: { headers: { Authorization: `Bearer ${KEY}` } }, response: { status: 401, data: { message: `Invalid key ${KEY}` } } }); },
            async () => { throw Object.assign(new Error('x'), { response: { status: 403, data: { message: 'Authorization: Bearer re_SomeOtherKey_0123456789abcdefghij is not allowed' } } }); },
            async () => { throw Object.assign(new Error(KEY), { code: 'ECONNREFUSED' }); },
            async () => ({ status: 400, data: { message: `bad ${KEY}` } }),
        ];
        for (const echo of echoes) {
            const { restore } = stubResend(echo);
            try {
                const result = JSON.stringify(await sendEmail({ apiKey: KEY, to: OWNER, from: null }, { subject: 'S', text: 'T' }));
                assert.ok(!result.includes(KEY), result);
                assert.ok(!/re_[A-Za-z0-9_-]{16,}/.test(result), `nothing shaped like a key either: ${result}`);
                assert.ok(!/Bearer\s+\S*[A-Za-z0-9]{8,}/.test(result), result);
            } finally { restore(); }
        }
    });
});

describe('scrubKey and redactAddresses', () => {
    it('removes the saved key, anything shaped like one, and whatever follows Bearer', () => {
        assert.equal(scrubKey(`bad ${KEY} here`, KEY), 'bad [key] here');
        assert.equal(scrubKey('other re_SomeOtherKey_0123456789abcdefghij key', KEY), 'other [key] key');
        assert.equal(scrubKey('Authorization: Bearer abc123', null), 'Authorization: Bearer [key]');
        assert.equal(scrubKey('nothing to hide', KEY), 'nothing to hide');
        assert.equal(scrubKey('re_short is not a key', null), 're_short is not a key');
    });

    it('takes an address out of a string for the log', () => {
        assert.equal(redactAddresses('You can only send testing emails to your own email address (me@example.com).'), 'You can only send testing emails to your own email address ([address]).');
        assert.equal(redactAddresses('a@b.com and "c@d.org", e@f.io'), '[address] and "[address]", [address]');
    });
});

// ─── The words ──────────────────────────────────────────────────────────────────────────────

describe('emailSubject', () => {
    it('names the channel and the customer: «محادثة بانتظارك على واتساب — {name}» / "A conversation needs you on WhatsApp — {name}"', () => {
        const wa = { platform: 'whatsapp', username: 'Zainab Al-Fassi' };
        assert.equal(emailSubject(notice({ ...wa })), 'A conversation needs you on WhatsApp — Zainab Al-Fassi');
        assert.equal(emailSubject(notice({ ...wa, lang: 'ar' })), 'محادثة بانتظارك على واتساب — Zainab Al-Fassi');
        assert.equal(emailSubject(notice()), 'A conversation needs you on Instagram — @sara_dev');
        assert.equal(emailSubject(notice({ lang: 'ar' })), 'محادثة بانتظارك على إنستغرام — @sara_dev');
        assert.equal(emailSubject(notice({ platform: 'facebook', lang: 'ar' })), 'محادثة بانتظارك على فيسبوك — @sara_dev');
        assert.equal(emailSubject(notice({ platform: 'facebook' })), 'A conversation needs you on Facebook — @sara_dev');
        assert.equal(emailSubject(notice({ platform: null })), 'A conversation needs you on Instagram — @sara_dev', 'no platform is Instagram, as the rest of the alert assumes');
    });

    it('is its own subject for a hot lead, and names a customer with no username by the end of their id', () => {
        assert.equal(emailSubject(notice({ kind: 'hot_lead', platform: 'whatsapp', username: 'Zainab' })), 'Hot lead on WhatsApp — Zainab');
        assert.equal(emailSubject(notice({ kind: 'hot_lead', platform: 'whatsapp', username: 'Zainab', lang: 'ar' })), 'عميل متحمس على واتساب — Zainab');
        assert.equal(emailSubject(notice({ username: null, platform: 'whatsapp', senderId: 'EG.13491208655302741918' })), 'A conversation needs you on WhatsApp — WhatsApp user …1918');
        assert.equal(emailSubject(notice({ username: null })), 'A conversation needs you on Instagram — Instagram user …0001');
    });

    it('is ONE line and carries no link, whatever a customer called themselves', () => {
        const subject = emailSubject(notice({ platform: 'whatsapp', username: 'Evil\r\nBcc: x@y.com‮evil https://phish.example/pay' }));
        assert.ok(!/[\r\n]/.test(subject), JSON.stringify(subject));
        assert.ok(!/https?:|[‪-‮⁦-⁩]/.test(subject), subject);
        assert.ok(subject.length < 140, `${subject.length} characters`);
    });
});

describe('emailBody', () => {
    it('is the Telegram alert\'s own text with one line added after the title: the channel', () => {
        for (const n of [notice(), notice({ lang: 'ar', platform: 'whatsapp', username: 'Zainab' }), notice({ kind: 'hot_lead', platform: 'facebook' }), notice({ windowMs: 0, platform: 'whatsapp' })]) {
            const telegram = buildNoticeText(n).split('\n');
            const email = emailBody(n).split('\n');
            assert.equal(email.length, telegram.length + 1);
            assert.equal(email[0], telegram[0], 'the same title');
            assert.deepEqual([email[1]], [`${n.lang === 'ar' ? 'القناة' : 'Channel'}: ${({ instagram: n.lang === 'ar' ? 'إنستغرام' : 'Instagram', facebook: n.lang === 'ar' ? 'فيسبوك' : 'Facebook', whatsapp: n.lang === 'ar' ? 'واتساب' : 'WhatsApp' } as any)[n.platform ?? 'instagram']}`]);
            assert.deepEqual(email.slice(2), telegram.slice(1), 'and the rest, line for line');
        }
    });

    it('says who, why, the channel, what they wrote, the window left and where to open it', () => {
        assert.deepEqual(emailBody(notice({ platform: 'whatsapp', username: 'Zainab Al-Fassi' })).split('\n'), [
            'Needs you: refund request',
            'Channel: WhatsApp',
            'Customer: Zainab Al-Fassi',
            'Last message: «I want a refund, give me my money back»',
            'Reply window: closes in 20 h 59 min',
            'Open: https://msg.example/dashboard#/inbox?c=conv-1',
        ]);
        assert.deepEqual(emailBody(notice({ lang: 'ar', platform: 'whatsapp', username: 'زينب', windowMs: 0 })).split('\n').slice(0, 5), [
            'يحتاج ردك: طلب استرجاع',
            'القناة: واتساب',
            'العميل: زينب',
            'آخر رسالة: «I want a refund, give me my money back»',
            'نافذة الرد: أُغلقت، ويمكنك الرد من لوحة التحكم عندما يراسلك العميل من جديد',
        ]);
    });

    it('puts what a customer typed through the same filter as Telegram: no link, no reordering control, cut and on one line', () => {
        const body = emailBody(notice({ lastMessage: `pay https://phish.example/x now evil.com‮drow\nBcc: x@y.com ${'ا'.repeat(300)}` }));
        const last = body.split('\n').find((l) => l.startsWith('Last message:'))!;
        assert.match(last, /^Last message: «pay \[link\] now \[link\] Bcc: \[link\] ا/, 'links (an address too) are [link], the control is gone, the break is a space');
        assert.ok(!/[‪-‮⁦-⁩]/.test(body));
        assert.ok(last.endsWith('…»'), 'cut with an ellipsis');
        assert.equal(body.split('\n').length, 6, 'the line break in what they typed did not add a line');
    });
});

// ─── sendEmailNotice ────────────────────────────────────────────────────────────────────────

describe('sendEmailNotice', () => {
    it('sends the subject and the body to the owner\'s address with the saved key, and says it worked', async () => {
        const { posted, restore } = stubResend(async () => ({ status: 200, data: { id: 'x' } }));
        try {
            const n = notice({ platform: 'whatsapp', username: 'Zainab' });
            assert.deepEqual(await sendEmailNotice(n, settings()), { ok: true });
            assert.equal(posted.length, 1);
            assert.deepEqual(posted[0]!.body, { from: DEFAULT_EMAIL_FROM, to: [OWNER], subject: emailSubject(n), text: emailBody(n) });
            assert.ok(!('html' in posted[0]!.body), 'plain text only');
        } finally { restore(); }
    });

    it('goes to the contact email when no address was saved, and sends nothing when email is off, keyless or addressless', async () => {
        const { posted, restore } = stubResend(async () => ({ status: 200, data: {} }));
        try {
            await sendEmailNotice(notice(), settings({ to: null, defaultTo: 'contact@example.com' }));
            assert.deepEqual(posted[0]!.body.to, ['contact@example.com']);
            const none = { ok: false, reason: 'not_configured', status: null, description: '' };
            assert.deepEqual(await sendEmailNotice(notice(), settings({ enabled: false })), none);
            assert.deepEqual(await sendEmailNotice(notice(), settings({ apiKey: null })), none);
            assert.deepEqual(await sendEmailNotice(notice(), settings({ to: null, defaultTo: null })), none);
            assert.equal(posted.length, 1);
        } finally { restore(); }
    });
});
