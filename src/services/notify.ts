/**
 * Alerts to the owner (docs/DM_SALES_PLAN.md §8, S8): a Telegram bot he makes with @BotFather, told to him when a conversation needs a
 * person, and when a hot lead has just been sent the link.
 *
 *   settings       `app_settings` (`notify.telegram_*`), edited on the Settings card, never an environment variable: the token is the
 *                  one secret (encrypted at rest, and every route answers `{ set, last4 }` and nothing more), the chat id is his own.
 *   send           `sendTelegramMessage`: one `sendMessage`, PLAIN TEXT (no `parse_mode`, so nothing a customer typed is ever read as
 *                  markup), and a result, never a throw. The caller is a turn that has already answered the customer.
 *   text           `buildNoticeText`: who, why, the last thing they said (cut, with links and bidi controls taken out of it), how long
 *                  Meta's 24 h window has left, and the inbox link. Pure.
 *
 * **The bot token is in the URL path of every Telegram call** (`/bot<token>/sendMessage`), which makes an axios error a leak: its
 * `config.url` and its stack carry it. Nothing here ever logs or returns an error object. A failure is reduced to the HTTP status and
 * Telegram's own `description`, and both are scrubbed of the token before they leave this file (`scrub`, which also removes anything
 * shaped like a token, so a token that is NOT the saved one cannot get out through an echoed description either).
 *
 * What this module does not do: decide WHEN to alert (`dmSales/handoff.ts`), or know which tenant a conversation belongs to.
 */
import axios from 'axios';
import { getSettings, last4, setSetting, APP_SETTING_KEYS, type AppSettingKey } from './appSettings.js';

/** Telegram's Bot API. A short timeout: an alert is best effort, and a hung socket must not hold a turn. */
export const TELEGRAM_API = 'https://api.telegram.org';
export const TELEGRAM_TIMEOUT_MS = 5_000;
export const telegramHttp = axios.create({ baseURL: TELEGRAM_API, timeout: TELEGRAM_TIMEOUT_MS });

/** What @BotFather hands out: a numeric bot id, a colon, and 30+ URL-safe characters (in practice 35). */
export const BOT_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
/** A chat id is a (possibly negative) number: a person, a group or a supergroup (`-100…`). `@name` addresses a public channel. */
export const CHAT_ID_PATTERN = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

// ─── Settings ───────────────────────────────────────────────────────────────────────────────

const KEYS = {
    token: APP_SETTING_KEYS.notifyTelegramBotToken,
    chatId: APP_SETTING_KEYS.notifyTelegramChatId,
    enabled: APP_SETTING_KEYS.notifyTelegramEnabled,
    hotLeads: APP_SETTING_KEYS.notifyTelegramHotLeads,
} as const;

/** The four Telegram settings' keys: `notifyEmail.ts` reads them together with the email ones, in one round trip. */
export const TELEGRAM_SETTING_KEYS: readonly AppSettingKey[] = [KEYS.token, KEYS.chatId, KEYS.enabled, KEYS.hotLeads];

export interface TelegramSettings {
    /** The bot token, decrypted. Never put in a log line, an error, or a response. */
    token: string | null;
    chatId: string | null;
    enabled: boolean;
    /** On unless the owner turned it off (his decision of 2026-10-14: hot leads are included). */
    hotLeads: boolean;
}

/** A switch is on only when it is saved as exactly 'true'. */
const isOn = (value: string | null): boolean => value === 'true';

export function telegramSettingsOf(values: ReadonlyMap<AppSettingKey, string | null>): TelegramSettings {
    return {
        token: values.get(KEYS.token) ?? null,
        chatId: values.get(KEYS.chatId) ?? null,
        enabled: isOn(values.get(KEYS.enabled) ?? null),
        hotLeads: (values.get(KEYS.hotLeads) ?? null) !== 'false',
    };
}

/** The four settings, in one round trip. */
export async function readTelegramSettings(): Promise<TelegramSettings> {
    return telegramSettingsOf(await getSettings(TELEGRAM_SETTING_KEYS));
}

/** Alerts go out only when the owner switched them on AND both halves of the address are there. */
export function telegramReady(s: TelegramSettings): s is TelegramSettings & { token: string; chatId: string } {
    return s.enabled && Boolean(s.token) && Boolean(s.chatId);
}

/** What the Settings card is told. The token is `{ set, last4 }`: whether there is one, and its last four characters to recognise it by. */
export interface TelegramStatus {
    botToken: { set: boolean; last4: string | null };
    chatId: string | null;
    enabled: boolean;
    hotLeads: boolean;
    /** Alerts would be sent right now. */
    ready: boolean;
}

export function describeTelegramSettings(s: TelegramSettings): TelegramStatus {
    return {
        botToken: { set: Boolean(s.token), last4: s.token ? last4(s.token) : null },
        chatId: s.chatId,
        enabled: s.enabled,
        hotLeads: s.hotLeads,
        ready: telegramReady(s),
    };
}

export async function describeTelegram(): Promise<TelegramStatus> {
    return describeTelegramSettings(await readTelegramSettings());
}

/** What a save may carry. Absent leaves a setting as it is; `null` (or '' for the chat id) clears it. */
export interface TelegramInput {
    botToken?: string | null;
    chatId?: string | null;
    enabled?: boolean;
    hotLeads?: boolean;
}

export type TelegramInputResult = { ok: true; value: TelegramInput } | { ok: false; error: string; field: string };

/** The body of a save as a validated input: every field checked before any is written, so a refusal never leaves half a save behind. */
export function parseTelegramInput(body: unknown): TelegramInputResult {
    const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const value: TelegramInput = {};

    if (raw['botToken'] === null) value.botToken = null;
    else if (typeof raw['botToken'] === 'string' && raw['botToken'].trim() !== '') {
        const token = raw['botToken'].trim();
        // The pattern is stated, never the value: this error is shown to the person who typed it, and logged.
        if (!BOT_TOKEN_PATTERN.test(token)) {
            return { ok: false, field: 'botToken', error: 'That does not look like a bot token. It is the line @BotFather gives you, like 123456789:AA… (digits, a colon, then letters and digits).' };
        }
        value.botToken = token;
    } else if (raw['botToken'] !== undefined && typeof raw['botToken'] !== 'string') {
        return { ok: false, field: 'botToken', error: 'The bot token must be text.' };
    }

    if (raw['chatId'] !== undefined) {
        if (raw['chatId'] === null) value.chatId = null;
        else if (typeof raw['chatId'] === 'string' || typeof raw['chatId'] === 'number') {
            const chat = String(raw['chatId']).trim();
            if (chat === '') value.chatId = null;
            else if (!CHAT_ID_PATTERN.test(chat)) {
                return { ok: false, field: 'chatId', error: 'The chat id is a number (it can start with a minus sign), or @ and the name of a public channel.' };
            }
            else value.chatId = chat;
        } else {
            return { ok: false, field: 'chatId', error: 'The chat id must be a number.' };
        }
    }

    for (const field of ['enabled', 'hotLeads'] as const) {
        if (raw[field] === undefined) continue;
        if (typeof raw[field] !== 'boolean') return { ok: false, field, error: `${field} must be true or false.` };
        value[field] = raw[field] as boolean;
    }
    return { ok: true, value };
}

/** The settings as they will be after `input`, so "alerts on" can be refused while a half of the address is missing. */
export function mergeTelegram(current: TelegramSettings, input: TelegramInput): TelegramSettings {
    return {
        token: input.botToken === undefined ? current.token : input.botToken,
        chatId: input.chatId === undefined ? current.chatId : input.chatId,
        enabled: input.enabled ?? current.enabled,
        hotLeads: input.hotLeads ?? current.hotLeads,
    };
}

/** Write what `input` carries. The token goes through `setSetting`, the one place a secret is encrypted. */
export async function saveTelegramInput(input: TelegramInput, updatedBy: string | null): Promise<void> {
    if (input.botToken !== undefined) await setSetting(KEYS.token, input.botToken, updatedBy);
    if (input.chatId !== undefined) await setSetting(KEYS.chatId, input.chatId, updatedBy);
    if (input.enabled !== undefined) await setSetting(KEYS.enabled, input.enabled ? 'true' : 'false', updatedBy);
    if (input.hotLeads !== undefined) await setSetting(KEYS.hotLeads, input.hotLeads ? 'true' : 'false', updatedBy);
}

// ─── Sending ────────────────────────────────────────────────────────────────────────────────

/**
 * Remove every trace of a bot token from a string: the saved one wherever it is (and as the `bot<token>` of a URL), and anything
 * shaped like one. Telegram's `description` is its own text and does not carry the token, but a proxy, a captive portal or a future
 * message might echo the request path.
 */
export function scrub(text: string, token: string | null): string {
    let out = text;
    if (token) out = out.split(`bot${token}`).join('bot[token]').split(token).join('[token]');
    return out.replace(/\d{5,15}:[A-Za-z0-9_-]{30,}/g, '[token]');
}

export type SendResult =
    | { ok: true }
    /** `rejected`: Telegram answered and said no (a wrong token, a chat the bot cannot write to). `unreachable`: it did not answer. */
    | { ok: false; reason: 'rejected' | 'unreachable'; status: number | null; description: string };

/**
 * One plain-text message to the owner's chat. NEVER throws and never returns an error object: the result is a status and a scrubbed
 * description (see the top of the file). No `parse_mode`, and link previews off, so what a customer typed is shown as typed.
 */
export async function sendTelegramMessage(to: { token: string; chatId: string }, text: string): Promise<SendResult> {
    try {
        const response = await telegramHttp.post(`/bot${to.token}/sendMessage`, {
            chat_id: to.chatId,
            text,
            disable_web_page_preview: true,
        });
        if (response?.data && response.data.ok === false) {
            return { ok: false, reason: 'rejected', status: Number(response.data.error_code) || null, description: describe(response.data.description, to.token) };
        }
        return { ok: true };
    } catch (err) {
        const e = err as { response?: { status?: unknown; data?: { description?: unknown } }; code?: unknown };
        const status = typeof e?.response?.status === 'number' ? e.response.status : null;
        if (status !== null) {
            return { ok: false, reason: 'rejected', status, description: describe(e.response?.data?.description, to.token) || `HTTP ${status}` };
        }
        // Only the error CODE (ECONNABORTED, ENOTFOUND…): the message of a transport error can carry the request URL.
        return { ok: false, reason: 'unreachable', status: null, description: typeof e?.code === 'string' ? e.code.slice(0, 40) : 'network error' };
    }
}

function describe(description: unknown, token: string): string {
    return typeof description === 'string' ? scrub(description, token).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

// ─── The words of an alert ──────────────────────────────────────────────────────────────────

export type NoticeKind = 'handoff' | 'hot_lead';
export type NoticeLang = 'ar' | 'en';

/** Meta's standard messaging window: replies are allowed for 24 h after the person's last message (docs/DM_SALES_PLAN.md §2). */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Milliseconds left in Meta's window, counted from the person's last message; 0 when it has closed, null when there is no such message. */
export function windowRemainingMs(lastInboundAt: Date | string | null | undefined, now: Date): number | null {
    if (!lastInboundAt) return null;
    const at = lastInboundAt instanceof Date ? lastInboundAt.getTime() : Date.parse(lastInboundAt);
    if (Number.isNaN(at)) return null;
    return Math.max(0, Math.min(WINDOW_MS, at + WINDOW_MS - now.getTime()));
}

/** "5 h 20 min", "40 min", or "less than a minute"; Latin digits, as the whole product writes them. */
export function formatRemaining(ms: number, lang: NoticeLang): string {
    const minutes = Math.floor(ms / 60_000);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (lang === 'ar') {
        if (minutes < 1) return 'أقل من دقيقة';
        if (h === 0) return `${m} دقيقة`;
        return m === 0 ? `${h} ساعة` : `${h} ساعة و${m} دقيقة`;
    }
    if (minutes < 1) return 'less than a minute';
    if (h === 0) return `${m} min`;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * What a customer typed, made safe to put in the owner's chat. Telegram makes any link in a message tappable, so a link (a scheme, `www.`,
 * or anything shaped like a domain) is replaced by «[link]»; bidirectional controls, which can make text read in another order than it was
 * written, and control characters are removed; whitespace is collapsed; and the rest is cut to `max` characters. Never altered otherwise
 * (`<b>` stays `<b>`: the message has no `parse_mode`, so it is shown as typed).
 */
export function excerpt(text: unknown, max = 200): string {
    const cleaned = String(text ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F؜‎‏‪-‮⁦-⁩﻿]/g, '')
        .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]')
        .replace(/\S+\.[A-Za-z]{2,}\S*/g, '[link]')
        .replace(/\s+/g, ' ')
        .trim();
    const chars = Array.from(cleaned);
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : cleaned;
}

/** The inbox link: the open conversation on the public origin, or null when there is no origin to build it on. */
export function inboxLink(base: string | null, conversationId: string): string | null {
    return base ? `${base.replace(/\/+$/, '')}/dashboard#/inbox?c=${encodeURIComponent(conversationId)}` : null;
}

const TEXT = {
    ar: {
        handoff: 'يحتاج ردك',
        hot: 'عميل متحمس: أُرسل له الرابط',
        reasons: {
            unsure: 'المساعد لم يكن متأكداً من الجواب',
            engine_failed: 'تعذّر على المساعد الرد (عطل تقني)',
            refund: 'طلب استرجاع',
            complaint: 'شكوى',
            wants_human: 'طلب التحدث مع شخص',
            hot_lead: 'جاهز للشراء',
            abuse: 'رسائل مسيئة',
            // WhatsApp: why a reply could not be sent at all (the bot could not answer, and the customer could not be told).
            window_closed: 'انتهت نافذة الـ 24 ساعة فلم يمكن إرسال رد',
            billable_blocked: 'انتهت الردود المجانية على واتساب وردود المدفوعة متوقفة',
            connection_invalid: 'اتصال واتساب يحتاج إلى إعادة ربط',
        } as Record<string, string>,
        customer: 'العميل',
        last: 'آخر رسالة',
        window: 'نافذة الرد',
        windowLeft: (left: string) => `تُغلق بعد ${left}`,
        windowClosed: 'أُغلقت، يمكنك الرد من تطبيق إنستغرام',
        open: 'افتح المحادثة',
        anon: (id: string) => `مستخدم إنستغرام …${id}`,
        // A WhatsApp conversation is answered from the dashboard (there is no app to reply from outside the window), so it says so.
        whatsapp: {
            windowClosed: 'أُغلقت، ويمكنك الرد من لوحة التحكم عندما يراسلك العميل من جديد',
            anon: (id: string) => `مستخدم واتساب …${id}`,
        },
        test: 'رسالة تجريبية من AutoReply Pro. إذا وصلتك فالتنبيهات ستصل إلى هذه المحادثة.',
    },
    en: {
        handoff: 'Needs you',
        hot: 'Hot lead: the link was sent',
        reasons: {
            unsure: 'the assistant was not sure how to answer',
            engine_failed: 'the assistant could not reply (a technical failure)',
            refund: 'refund request',
            complaint: 'complaint',
            wants_human: 'asked for a person',
            hot_lead: 'ready to buy',
            abuse: 'abusive messages',
            // WhatsApp: why a reply could not be sent at all (the bot could not answer, and the customer could not be told).
            window_closed: 'the 24-hour window had closed, so no reply could be sent',
            billable_blocked: 'the free WhatsApp replies are used up and paid replies are switched off',
            connection_invalid: 'the WhatsApp connection needs reconnecting',
        } as Record<string, string>,
        customer: 'Customer',
        last: 'Last message',
        window: 'Reply window',
        windowLeft: (left: string) => `closes in ${left}`,
        windowClosed: 'closed, so reply from the Instagram app',
        open: 'Open',
        anon: (id: string) => `Instagram user …${id}`,
        // A WhatsApp conversation is answered from the dashboard (there is no app to reply from outside the window), so it says so.
        whatsapp: {
            windowClosed: 'closed, so reply from the dashboard once they write again',
            anon: (id: string) => `WhatsApp user …${id}`,
        },
        test: 'Test message from AutoReply Pro. If you can read this, alerts will reach this chat.',
    },
} as const;

export interface NoticeInput {
    kind: NoticeKind;
    /** Why a person is needed (`HandoffReason`); read for a handoff, ignored for a hot lead. */
    reason: string;
    lang: NoticeLang;
    /** `conversations.username`, or null. */
    username: string | null;
    /** The platform-scoped sender id: its last four characters name a customer with no username. */
    senderId: string;
    /** What they last wrote. Cut and cleaned here. */
    lastMessage: string;
    /** Time left in Meta's window (`windowRemainingMs`), or null when unknown. */
    windowMs: number | null;
    /** `inboxLink`, or null. */
    link: string | null;
    /** The conversation's channel when it is WhatsApp: its words name WhatsApp and the dashboard, not Instagram. Anything else is the Instagram wording, as it was. */
    platform?: string | null;
}

/**
 * Who the alert is about, as every channel names them: an Instagram handle with its @, a WhatsApp contact by profile name (a name is not a
 * handle), and a customer with neither by the last four characters of their id. Cut and cleaned like everything a customer typed. Pure.
 */
export function noticeWho(n: Pick<NoticeInput, 'lang' | 'username' | 'senderId' | 'platform'>): string {
    const t = TEXT[n.lang];
    const whatsapp = n.platform === 'whatsapp';
    const name = excerpt(n.username ?? '', 40).replace(/^@/, '');
    return name ? (whatsapp ? name : `@${name}`) : (whatsapp ? t.whatsapp.anon : t.anon)(String(n.senderId).slice(-4));
}

/** The alert, as one plain-text message. Pure. */
export function buildNoticeText(n: NoticeInput): string {
    const t = TEXT[n.lang];
    const whatsapp = n.platform === 'whatsapp';
    const who = noticeWho(n);
    const title = n.kind === 'hot_lead' ? t.hot : `${t.handoff}: ${t.reasons[n.reason] ?? t.reasons['unsure']}`;
    const lines = [title, `${t.customer}: ${who}`, `${t.last}: «${excerpt(n.lastMessage)}»`];
    if (n.windowMs !== null) lines.push(`${t.window}: ${n.windowMs <= 0 ? (whatsapp ? t.whatsapp.windowClosed : t.windowClosed) : t.windowLeft(formatRemaining(n.windowMs, n.lang))}`);
    if (n.link) lines.push(`${t.open}: ${n.link}`);
    return lines.join('\n');
}

/** The words of the "Send test message" button's message. */
export function testMessageText(lang: NoticeLang): string {
    return TEXT[lang].test;
}

/** What the test button answers with: `not_configured` when there is no token or chat id to send with. */
export type TestResult = { ok: true } | { ok: false; reason: 'not_configured' | 'rejected' | 'unreachable'; status: number | null; description: string };

/**
 * Send the test message with what is SAVED (the card saves first), whether or not alerts are switched on: the button exists to find out
 * if the token and the chat id work before the owner relies on them.
 */
export async function sendTestMessage(lang: NoticeLang = 'ar'): Promise<TestResult> {
    const s = await readTelegramSettings();
    if (!s.token || !s.chatId) return { ok: false, reason: 'not_configured', status: null, description: '' };
    return sendTelegramMessage({ token: s.token, chatId: s.chatId }, testMessageText(lang));
}
