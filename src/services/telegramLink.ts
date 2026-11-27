/**
 * Linking a person's own Telegram chat to the platform's bot (U3, SA-11; docs/specs/007-company-shell §6.4).
 *
 * Telegram has no OAuth for this, and nothing here receives Telegram's updates: there is no webhook and no polling job. So linking is a
 * handshake the person's own browser drives:
 *
 *   1. `startLink`    mints a single-use code (`oauth_states`, purpose `telegram`, tenant- and user-bound, ten minutes) and answers
 *                     `https://t.me/<bot username>?start=<code>`. The code is 43 base64url characters: inside Telegram's 64.
 *   2. the person opens the link and presses START: Telegram sends the bot the message `/start <code>`.
 *   3. `confirmLink`  (called every few seconds by the dashboard for two minutes) asks Telegram for the bot's pending messages
 *                     (`getUpdates`, never with an `offset`: see `telegramGetUpdates`), finds a PRIVATE chat whose message is exactly
 *                     `/start <code>`, spends the code in one statement, and keeps the chat id and the first name.
 *
 * Who could link the wrong chat, and why they cannot: the code is 256 random bits, valid for ten minutes, spent once, and checked against the
 * tenant and user it was minted for. Someone who saw the link in those minutes and pressed START first would link THEIR chat to this person's
 * account, which is why the confirmation shows the Telegram first name (the person sees whose name it is), why it is audited, and why
 * unlinking is one button. A group chat is never linked (`chat.type` must be `private`).
 *
 * **The bot token and a chat id are never logged, returned or audited.** Every failure here is a status and a scrubbed description from
 * `notify.ts`; the audit rows carry the user id only.
 */
import { describeError, log } from '../utils/log.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit, type ActorSession } from './audit.js';
import {
    readTelegramSettings, scrub, sendTelegramMessage, telegramGetMe, telegramGetUpdates,
} from './notify.js';
import { consumeOAuthState, createOAuthState, isOAuthStateLive, NONCE_PATTERN, OAUTH_STATE_TTL_MS } from './oauthState.js';
import { readUserNotify, writeUserNotify } from './notifyPeople.js';

/** What a refusal is, as the route turns it into a status and a code. */
export class TelegramLinkError extends Error {
    constructor(public readonly code: 'TELEGRAM_BOT_MISSING' | 'TELEGRAM_UNREACHABLE' | 'TELEGRAM_LINK_EXPIRED', message: string) {
        super(message);
        this.name = 'TelegramLinkError';
    }
}

export interface LinkWho {
    creatorId: string;
    userId: string;
}

export interface StartedLink {
    url: string;
    /** ISO instant the code stops working. */
    expiresAt: string;
}

/** The link a person opens. The bot's username comes from Telegram (`getMe`), never from a request. */
export async function startLink(who: LinkWho, now: () => number = Date.now): Promise<StartedLink> {
    const settings = await readTelegramSettings();
    if (!settings.token) throw new TelegramLinkError('TELEGRAM_BOT_MISSING', 'Telegram alerts are not set up on this platform yet.');
    const me = await telegramGetMe(settings.token);
    if (!me.ok) {
        // Scrubbed already; logged as a status only.
        log('warn', 'notify.telegram_link_unreachable', { outcome: me.reason, status: me.status, description: scrub(me.description, settings.token) });
        throw new TelegramLinkError('TELEGRAM_UNREACHABLE', 'Telegram did not answer. Try again in a minute.');
    }
    const code = await createOAuthState({ purpose: 'telegram', creatorId: who.creatorId, userId: who.userId, ttlMs: OAUTH_STATE_TTL_MS });
    return { url: `https://t.me/${me.username}?start=${code}`, expiresAt: new Date(now() + OAUTH_STATE_TTL_MS).toISOString() };
}

export type ConfirmResult = { linked: true; name: string } | { linked: false };

/**
 * One poll of the handshake. `{ linked: false }` means "not yet": keep asking. An expired, spent or foreign code is a
 * `TELEGRAM_LINK_EXPIRED` refusal, so the dashboard stops asking and offers a new link.
 */
export async function confirmLink(who: LinkWho, code: unknown, actor: ActorSession | undefined): Promise<ConfirmResult> {
    if (typeof code !== 'string' || !NONCE_PATTERN.test(code)) {
        throw new TelegramLinkError('TELEGRAM_LINK_EXPIRED', 'That link has expired. Make a new one.');
    }
    if (!(await isOAuthStateLive(code, 'telegram', who.creatorId, who.userId))) {
        throw new TelegramLinkError('TELEGRAM_LINK_EXPIRED', 'That link has expired. Make a new one.');
    }
    const settings = await readTelegramSettings();
    if (!settings.token) throw new TelegramLinkError('TELEGRAM_BOT_MISSING', 'Telegram alerts are not set up on this platform yet.');

    const updates = await telegramGetUpdates(settings.token);
    if (!updates.ok) {
        log('warn', 'notify.telegram_link_poll_failed', { outcome: updates.reason, status: updates.status, description: scrub(updates.description, settings.token) });
        throw new TelegramLinkError('TELEGRAM_UNREACHABLE', 'Telegram did not answer. Try again in a minute.');
    }
    const expected = `/start ${code}`;
    const found = updates.messages.find((m) => m.chatType === 'private' && m.text === expected);
    if (!found) return { linked: false };

    // The spend is the check: two polls finding the same message cannot both win.
    const spent = await consumeOAuthState(code, 'telegram');
    if (!spent || spent.creatorId !== who.creatorId || spent.userId !== who.userId) {
        throw new TelegramLinkError('TELEGRAM_LINK_EXPIRED', 'That link has expired. Make a new one.');
    }

    const name = found.firstName.trim().slice(0, 40);
    const current = await readUserNotify(who.userId);
    await writeUserNotify(who.userId, { v: 1, telegram: { chatId: found.chatId, linkedAt: new Date().toISOString(), name, paused: current.telegram?.paused ?? false } }, who.userId);

    // The confirmation in the chat itself, plain text, so the person sees it worked (and whose name it is). A failure costs nothing.
    try {
        await sendTelegramMessage({ token: settings.token, chatId: found.chatId }, 'AutoReply Pro: this chat is linked. When a customer needs you, the message will arrive here. To stop, unlink it in Settings → Notifications.');
    } catch (err) {
        log('warn', 'notify.telegram_link_confirm_failed', describeError(err));
    }
    await writeAudit(await actorFromSession(actor), { action: AUDIT_ACTIONS.notifyTelegramLink, targetType: 'user', targetId: who.userId, detail: { user_id: who.userId } });
    return { linked: true, name };
}

/** Unlink: the chat id and the name are deleted (the row goes with them). Idempotent. */
export async function unlink(who: LinkWho, actor: ActorSession | undefined): Promise<void> {
    const current = await readUserNotify(who.userId);
    if (!current.telegram) return;
    await writeUserNotify(who.userId, { v: 1, telegram: null }, who.userId);
    await writeAudit(await actorFromSession(actor), { action: AUDIT_ACTIONS.notifyTelegramUnlink, targetType: 'user', targetId: who.userId, detail: { user_id: who.userId } });
}

/** Pause or resume: the link stays, the notices stop (or start). Null when nothing is linked. */
export async function setPaused(who: LinkWho, paused: boolean): Promise<boolean> {
    const current = await readUserNotify(who.userId);
    if (!current.telegram) return false;
    await writeUserNotify(who.userId, { v: 1, telegram: { ...current.telegram, paused } }, who.userId);
    return true;
}
