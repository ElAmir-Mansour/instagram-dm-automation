/**
 * The owner's alerts by email (the second channel beside `notify.ts`'s Telegram): the same notice, as one plain-text email, through
 * Resend's HTTPS API. No dependency: one `axios` call, like every other outbound call here.
 *
 * **Why Resend, and what the free plan is** (read on resend.com on 2026-10-19):
 *   - https://resend.com/pricing: a free plan, $0, that the FAQ calls "free-forever". 3,000 emails a month and 100 a day, and NO overage:
 *     sending stops at the limits (pay-as-you-go exists only on paid plans). No card.
 *   - https://resend.com/docs/knowledge-base/resend-sending-limits: the day is the UTC day (resets at midnight UTC); sent AND received
 *     emails count, and each To/CC/BCC recipient counts on its own. We send one recipient per alert.
 *   - https://resend.com/docs/api-reference/emails/send-email: `POST https://api.resend.com/emails`, `Authorization: Bearer <key>`,
 *     JSON body `{ from, to, subject, text }` (`to` is a string or an array of up to 50; `text` is the plain-text version). A 2xx answers `{ id }`.
 *   - https://resend.com/docs/api-reference/errors: 401/403 `validation_error` and `restricted_api_key` (a wrong or limited key), 403
 *     `validation_error` "You can only send testing emails to your own email address", 429 `daily_quota_exceeded`, `monthly_quota_exceeded` and
 *     `rate_limit_exceeded` (10 requests a second a team). Every error body is `{ statusCode, name, message }`: `message` is what we show.
 *   - https://resend.com/docs/knowledge-base/403-error-resend-dev-domain ("403 Error Using resend.dev Domain"): the `resend.dev` domain, which
 *     `onboarding@resend.dev` belongs to, is for testing only and can send only to the address the Resend account was made with; any other
 *     recipient is a 403. https://resend.com/docs/send-with-nodejs adds that `onboarding@resend.dev` "is for testing only". That is exactly
 *     what an owner with no domain of his own needs, and no more: so `to` defaults to the site contact email, and the card says to sign up
 *     at Resend with that same address. A verified domain lifts it: save `notify.email_from` as an address on it.
 *
 * Quota consequence: 100 a day is far above what the per-conversation allowance lets through (`handoff.ts`: 3 handoffs and 1 hot lead an
 * hour per conversation), and a day that does hit it answers 429, which is logged as a failed email and costs the Telegram alert nothing.
 *
 *   settings   `app_settings` (`notify.email_*`), edited on the Settings card, never an environment variable. The API key is the one secret:
 *              encrypted at rest, and every route answers `{ set, last4 }` and nothing more. `to` is the owner's address, or, until he types
 *              one, the site contact email (read only when email is on and has a key, so a deployment with email off pays nothing for it).
 *   send       `sendEmail`: one POST, a result, never a throw, a 5 s timeout. The caller is a turn that has already answered the customer.
 *   text       `emailSubject` / `emailBody`: `notify.ts`'s `buildNoticeText` (so what a customer typed is cut and has its links and bidi
 *              controls taken out exactly as in Telegram) plus a line naming the channel.
 *
 * **The API key is in a request header** (`Authorization: Bearer re_…`), which makes an axios error a leak: its `config.headers` carry it.
 * Nothing here ever logs or returns an error object. A failure is reduced to the HTTP status and Resend's own `message`, scrubbed of the key
 * (`scrubKey`, which also removes anything shaped like a key or a bearer header, so a key that is NOT the saved one cannot get out through an
 * echoed message either). Resend's message can name the owner's own address; `redactAddresses` takes it out of anything that goes to a log.
 *
 * What this module does not do: decide WHEN to alert (`dmSales/handoff.ts`) or which tenant a conversation belongs to.
 */
import axios from 'axios';
import { describeError, log } from '../utils/log.js';
import { APP_SETTING_KEYS, getSettings, getSiteSettings, last4, setSetting, type AppSettingKey } from './appSettings.js';
import { buildNoticeText, noticeWho, telegramSettingsOf, TELEGRAM_SETTING_KEYS, type NoticeInput, type NoticeLang, type TelegramSettings } from './notify.js';

/** Resend's API. A short timeout: an alert is best effort, and a hung socket must not hold a turn. */
export const RESEND_API = 'https://api.resend.com';
export const EMAIL_TIMEOUT_MS = 5_000;
export const emailHttp = axios.create({ baseURL: RESEND_API, timeout: EMAIL_TIMEOUT_MS });

/** Without a verified domain of his own, the only sender Resend lets an account use (testing only; see the header). */
export const DEFAULT_EMAIL_FROM = 'AutoReply Pro <onboarding@resend.dev>';

/** What Resend hands out: `re_`, then URL-safe characters (in practice `re_` + 8 + `_` + 24). Stated loosely on purpose; Resend is the judge. */
export const EMAIL_KEY_PATTERN = /^re_[A-Za-z0-9_-]{16,128}$/;

/** One plain address: ASCII (Resend takes no more), no spaces, quotes, angle brackets or commas, so one input can never be two recipients or a header. */
export const EMAIL_ADDRESS_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

export function isEmailAddress(value: string): boolean {
    return value.length <= 254 && EMAIL_ADDRESS_PATTERN.test(value);
}

/** A sender: a bare address, or a display name and the address in angle brackets (`AutoReply Pro <alerts@example.com>`). */
export function isEmailSender(value: string): boolean {
    if (value.length > 200) return false;
    const named = /^([^<>"\\\u0000-\u001F\u007F]{1,80}?)\s*<([^<>\s]+)>$/.exec(value);
    if (named) return named[1]!.trim() !== '' && isEmailAddress(named[2]!);
    return isEmailAddress(value);
}

// ─── Settings ───────────────────────────────────────────────────────────────────────────────

const KEYS = {
    apiKey: APP_SETTING_KEYS.notifyEmailApiKey,
    to: APP_SETTING_KEYS.notifyEmailTo,
    from: APP_SETTING_KEYS.notifyEmailFrom,
    enabled: APP_SETTING_KEYS.notifyEmailEnabled,
    hotLeads: APP_SETTING_KEYS.notifyEmailHotLeads,
} as const;

export const EMAIL_SETTING_KEYS: readonly AppSettingKey[] = [KEYS.apiKey, KEYS.to, KEYS.from, KEYS.enabled, KEYS.hotLeads];

export interface EmailSettings {
    /** The Resend API key, decrypted. Never put in a log line, an error, or a response. */
    apiKey: string | null;
    /** The address the owner saved, or null: then `defaultTo` (the site contact email) is used. */
    to: string | null;
    /** The site contact email, filled in only where it is needed (`withDefaultTo`). */
    defaultTo: string | null;
    /** The sender the owner saved (an address on a domain he verified), or null for `DEFAULT_EMAIL_FROM`. */
    from: string | null;
    enabled: boolean;
    /** OFF unless the owner turned it on: a hot lead is a nudge, and the free plan has 100 emails a day. (Telegram's are on unless turned off.) */
    hotLeads: boolean;
}

/** A switch is on only when it is saved as exactly 'true'. */
const isOn = (value: string | null): boolean => value === 'true';

export function emailSettingsOf(values: ReadonlyMap<AppSettingKey, string | null>): EmailSettings {
    return {
        apiKey: values.get(KEYS.apiKey) ?? null,
        to: values.get(KEYS.to) ?? null,
        defaultTo: null,
        from: values.get(KEYS.from) ?? null,
        enabled: isOn(values.get(KEYS.enabled) ?? null),
        hotLeads: isOn(values.get(KEYS.hotLeads) ?? null),
    };
}

/** Where alerts go: the saved address, else the site contact email. */
export const effectiveTo = (s: Pick<EmailSettings, 'to' | 'defaultTo'>): string | null => s.to || s.defaultTo || null;

/** The settings with the site contact email filled in as the fallback address. A read that fails leaves it out (email is then not ready). */
export async function withDefaultTo(s: EmailSettings): Promise<EmailSettings> {
    if (s.to) return s;
    try {
        return { ...s, defaultTo: (await getSiteSettings()).contactEmail ?? null };
    } catch (err) {
        log('warn', 'notify.email_default_to_failed', describeError(err));
        return s;
    }
}

/** The five email settings, in one round trip, with the contact email as the fallback address. */
export async function readEmailSettings(): Promise<EmailSettings> {
    return withDefaultTo(emailSettingsOf(await getSettings(EMAIL_SETTING_KEYS)));
}

/**
 * BOTH channels' settings in ONE round trip (the nine keys), which is what an alert reads: with email off it costs exactly the one read
 * Telegram alone cost. The contact email, the address email falls back to, is read only when email is on, has a key and has no address saved.
 */
export async function readNotifyChannels(): Promise<{ telegram: TelegramSettings; email: EmailSettings }> {
    const values = await getSettings([...TELEGRAM_SETTING_KEYS, ...EMAIL_SETTING_KEYS]);
    let email = emailSettingsOf(values);
    if (email.enabled && email.apiKey && !email.to) email = await withDefaultTo(email);
    return { telegram: telegramSettingsOf(values), email };
}

/** Alerts go out only when the owner switched them on AND there is a key and an address to send with. */
export function emailReady(s: EmailSettings): s is EmailSettings & { apiKey: string } {
    return s.enabled && Boolean(s.apiKey) && Boolean(effectiveTo(s));
}

/** What the Settings card is told. The key is `{ set, last4 }`: whether there is one, and its last four characters to recognise it by. */
export interface EmailStatus {
    apiKey: { set: boolean; last4: string | null };
    /** Where alerts go right now: the saved address, else the site contact email. Null only when there is neither. */
    to: string | null;
    /** `to` is the site contact email, not an address the owner typed: the card says so. */
    toIsDefault: boolean;
    /** The sender the owner saved, or null for the default (`defaultFrom`). */
    from: string | null;
    defaultFrom: string;
    enabled: boolean;
    hotLeads: boolean;
    /** Alerts would be sent right now. */
    ready: boolean;
}

export function describeEmailSettings(s: EmailSettings): EmailStatus {
    return {
        apiKey: { set: Boolean(s.apiKey), last4: s.apiKey ? last4(s.apiKey) : null },
        to: effectiveTo(s),
        toIsDefault: !s.to && Boolean(s.defaultTo),
        from: s.from,
        defaultFrom: DEFAULT_EMAIL_FROM,
        enabled: s.enabled,
        hotLeads: s.hotLeads,
        ready: emailReady(s),
    };
}

export async function describeEmail(): Promise<EmailStatus> {
    return describeEmailSettings(await readEmailSettings());
}

/** What a save may carry. Absent leaves a setting as it is; `null` (or '' for the address and the sender) clears it. */
export interface EmailInput {
    apiKey?: string | null;
    to?: string | null;
    from?: string | null;
    enabled?: boolean;
    hotLeads?: boolean;
}

export type EmailInputResult = { ok: true; value: EmailInput } | { ok: false; error: string; field: string };

/** The `field` a refusal names, as the dashboard's inputs are known: not `enabled`, which is Telegram's. */
export const EMAIL_FIELDS = { apiKey: 'emailApiKey', to: 'emailTo', from: 'emailFrom', enabled: 'emailEnabled', hotLeads: 'emailHotLeads' } as const;

/**
 * The `email` part of a save's body as a validated input: every field checked before any is written, so a refusal never leaves half a save
 * behind. **Saving a valid key switches email on** unless the same save says otherwise (the owner's only step is to paste the key).
 */
export function parseEmailInput(body: unknown): EmailInputResult {
    const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const value: EmailInput = {};

    if (raw['apiKey'] === null) value.apiKey = null;
    else if (typeof raw['apiKey'] === 'string' && raw['apiKey'].trim() !== '') {
        const key = raw['apiKey'].trim();
        // The pattern is stated, never the value: this error is shown to the person who typed it, and logged.
        if (!EMAIL_KEY_PATTERN.test(key)) {
            return { ok: false, field: EMAIL_FIELDS.apiKey, error: 'That does not look like a Resend API key. It starts with re_ and is shown once, when you create it.' };
        }
        value.apiKey = key;
    } else if (raw['apiKey'] !== undefined && typeof raw['apiKey'] !== 'string') {
        return { ok: false, field: EMAIL_FIELDS.apiKey, error: 'The API key must be text.' };
    }

    if (raw['to'] !== undefined) {
        if (raw['to'] === null) value.to = null;
        else if (typeof raw['to'] === 'string') {
            const to = raw['to'].trim();
            if (to === '') value.to = null;
            else if (!isEmailAddress(to)) return { ok: false, field: EMAIL_FIELDS.to, error: 'That does not look like an email address.' };
            else value.to = to;
        } else {
            return { ok: false, field: EMAIL_FIELDS.to, error: 'The address must be text.' };
        }
    }

    if (raw['from'] !== undefined) {
        if (raw['from'] === null) value.from = null;
        else if (typeof raw['from'] === 'string') {
            const from = raw['from'].trim();
            if (from === '') value.from = null;
            else if (!isEmailSender(from)) {
                return { ok: false, field: EMAIL_FIELDS.from, error: 'The sender is an address, or a name and an address in angle brackets: Name <alerts@your-domain.com>.' };
            } else value.from = from;
        } else {
            return { ok: false, field: EMAIL_FIELDS.from, error: 'The sender must be text.' };
        }
    }

    for (const field of ['enabled', 'hotLeads'] as const) {
        if (raw[field] === undefined) continue;
        if (typeof raw[field] !== 'boolean') return { ok: false, field: EMAIL_FIELDS[field], error: `${field} must be true or false.` };
        value[field] = raw[field] as boolean;
    }

    // Pasting a key is the whole set-up: it switches email on, unless this very save says off.
    if (typeof value.apiKey === 'string' && value.enabled === undefined) value.enabled = true;
    return { ok: true, value };
}

/** The settings as they will be after `input`, so "email on" can be refused while the key or the address is missing. */
export function mergeEmail(current: EmailSettings, input: EmailInput): EmailSettings {
    return {
        apiKey: input.apiKey === undefined ? current.apiKey : input.apiKey,
        to: input.to === undefined ? current.to : input.to,
        defaultTo: current.defaultTo,
        from: input.from === undefined ? current.from : input.from,
        enabled: input.enabled ?? current.enabled,
        hotLeads: input.hotLeads ?? current.hotLeads,
    };
}

/** Write what `input` carries. The key goes through `setSetting`, the one place a secret is encrypted. */
export async function saveEmailInput(input: EmailInput, updatedBy: string | null): Promise<void> {
    if (input.apiKey !== undefined) await setSetting(KEYS.apiKey, input.apiKey, updatedBy);
    if (input.to !== undefined) await setSetting(KEYS.to, input.to, updatedBy);
    if (input.from !== undefined) await setSetting(KEYS.from, input.from, updatedBy);
    if (input.enabled !== undefined) await setSetting(KEYS.enabled, input.enabled ? 'true' : 'false', updatedBy);
    if (input.hotLeads !== undefined) await setSetting(KEYS.hotLeads, input.hotLeads ? 'true' : 'false', updatedBy);
}

// ─── Sending ────────────────────────────────────────────────────────────────────────────────

/**
 * Remove every trace of an API key from a string: the saved one wherever it is, anything shaped like one (`re_…`), and whatever follows
 * `Bearer`. Resend's `message` is its own text and does not carry the key, but a proxy or a future message might echo the request header.
 */
export function scrubKey(text: string, key: string | null): string {
    let out = text;
    if (key) out = out.split(key).join('[key]');
    return out.replace(/\bBearer\s+\S+/gi, 'Bearer [key]').replace(/\bre_[A-Za-z0-9_-]{16,}/g, '[key]');
}

/** An email address taken out of a string, for the log: Resend's refusal can name the owner's own. */
export function redactAddresses(text: string): string {
    return text.replace(/[^\s<>()"',;]+@[^\s<>()"',;]+/g, '[address]');
}

export type EmailResult =
    | { ok: true }
    /**
     * `not_configured`: no key or address to send with. `rejected`: Resend answered and said no (a wrong key, a recipient the free sender may
     * not write to, a quota). `unreachable`: it did not answer. `error`: something on our side threw before a call went out.
     */
    | { ok: false; reason: 'not_configured' | 'rejected' | 'unreachable' | 'error'; status: number | null; description: string };

const failure = (reason: 'rejected' | 'unreachable', status: number | null, description: string): EmailResult => ({ ok: false, reason, status, description });

/**
 * One plain-text email. NEVER throws and never returns an error object: the result is a status and a scrubbed message (see the top of the
 * file). The sender is the saved one, or `DEFAULT_EMAIL_FROM`.
 */
export async function sendEmail(to: { apiKey: string; to: string; from: string | null }, message: { subject: string; text: string }): Promise<EmailResult> {
    try {
        const response = await emailHttp.post(
            '/emails',
            { from: to.from || DEFAULT_EMAIL_FROM, to: [to.to], subject: message.subject, text: message.text },
            { headers: { Authorization: `Bearer ${to.apiKey}` } }
        );
        const status = typeof response?.status === 'number' ? response.status : null;
        if (status !== null && status >= 300) return failure('rejected', status, describe(response?.data, to.apiKey) || `HTTP ${status}`);
        return { ok: true };
    } catch (err) {
        try {
            const e = err as { response?: { status?: unknown; data?: unknown }; code?: unknown };
            const status = typeof e?.response?.status === 'number' ? e.response.status : null;
            if (status !== null) return failure('rejected', status, describe(e.response?.data, to.apiKey) || `HTTP ${status}`);
            // Only the error CODE (ECONNABORTED, ENOTFOUND…): the message of a transport error can carry the request, headers included.
            return failure('unreachable', null, typeof e?.code === 'string' ? e.code.slice(0, 40) : 'network error');
        } catch {
            // An error object that cannot even be read (a getter that throws) is still a failed send, not a throw.
            return failure('unreachable', null, 'network error');
        }
    }
}

/** Resend's `{ statusCode, name, message }`: its message, else its name, scrubbed of the key and cut. */
function describe(data: unknown, key: string): string {
    const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const text = typeof body['message'] === 'string' && body['message'] ? body['message'] : typeof body['name'] === 'string' ? body['name'] : '';
    return scrubKey(text, key).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ─── The words of an email ──────────────────────────────────────────────────────────────────

const TEXT = {
    ar: {
        handoff: (channel: string) => `محادثة بانتظارك على ${channel}`,
        hot: (channel: string) => `عميل متحمس على ${channel}`,
        channel: 'القناة',
        channels: { instagram: 'إنستغرام', facebook: 'فيسبوك', whatsapp: 'واتساب' },
        testSubject: 'AutoReply Pro: رسالة تجريبية',
        test: 'رسالة تجريبية من AutoReply Pro. إذا وصلتك فالتنبيهات ستصل إلى هذا البريد.',
    },
    en: {
        handoff: (channel: string) => `A conversation needs you on ${channel}`,
        hot: (channel: string) => `Hot lead on ${channel}`,
        channel: 'Channel',
        channels: { instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp' },
        testSubject: 'AutoReply Pro: test email',
        test: 'Test email from AutoReply Pro. If you can read this, alerts will reach this inbox.',
    },
} as const;

type Channel = keyof (typeof TEXT)['en']['channels'];

/** The conversation's channel; anything but WhatsApp and Facebook is Instagram, which is what the rest of the alert assumes. */
function channelOf(platform: string | null | undefined): Channel {
    return platform === 'whatsapp' ? 'whatsapp' : platform === 'facebook' ? 'facebook' : 'instagram';
}

/** «محادثة بانتظارك على واتساب — {name}» / "A conversation needs you on WhatsApp — {name}"; a hot lead is its own subject. */
export function emailSubject(n: NoticeInput): string {
    const t = TEXT[n.lang];
    const channel = t.channels[channelOf(n.platform)];
    // `noticeWho` has cut the name, taken links and bidi controls out and collapsed every line break: a subject is one line.
    return `${n.kind === 'hot_lead' ? t.hot(channel) : t.handoff(channel)} — ${noticeWho(n)}`;
}

/** The alert's own text (`buildNoticeText`, unchanged) with one line added after its title: which channel it is. */
export function emailBody(n: NoticeInput): string {
    const t = TEXT[n.lang];
    const [title = '', ...rest] = buildNoticeText(n).split('\n');
    return [title, `${t.channel}: ${t.channels[channelOf(n.platform)]}`, ...rest].join('\n');
}

/** The words of the "Send test email" button's message. */
export function testEmailMessage(lang: NoticeLang): { subject: string; text: string } {
    return { subject: TEXT[lang].testSubject, text: TEXT[lang].test };
}

/**
 * The alert as one email to the owner. NEVER throws. With no `settings` it reads the saved ones; either way it sends only when email is on
 * and has a key and an address (the fan-out in `handoff.ts` has already checked, and passes the settings it read).
 */
export async function sendEmailNotice(notice: NoticeInput, settings?: EmailSettings): Promise<EmailResult> {
    try {
        const s = settings ?? (await readEmailSettings());
        const to = effectiveTo(s);
        if (!emailReady(s) || !to) return { ok: false, reason: 'not_configured', status: null, description: '' };
        return await sendEmail({ apiKey: s.apiKey, to, from: s.from }, { subject: emailSubject(notice), text: emailBody(notice) });
    } catch (err) {
        log('warn', 'notify.email_notice_error', describeError(err));
        return { ok: false, reason: 'error', status: null, description: '' };
    }
}

/**
 * Send the test email with what is SAVED, whether or not email is switched on: the button (and the save that carries a new key) exist to
 * find out if the key and the address work before the owner relies on them. NEVER throws: a failed test must not fail the save it follows.
 */
export async function sendTestEmail(lang: NoticeLang = 'ar'): Promise<EmailResult> {
    try {
        const s = await readEmailSettings();
        const to = effectiveTo(s);
        if (!s.apiKey || !to) return { ok: false, reason: 'not_configured', status: null, description: '' };
        return await sendEmail({ apiKey: s.apiKey, to, from: s.from }, testEmailMessage(lang));
    } catch (err) {
        log('warn', 'notify.email_test_error', describeError(err));
        return { ok: false, reason: 'error', status: null, description: '' };
    }
}
