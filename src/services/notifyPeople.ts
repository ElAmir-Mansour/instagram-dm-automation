/**
 * Who in a workspace is told when a customer needs a person (U3, SA-11; docs/specs/007-company-shell §6).
 *
 * Until U3 the only chat an alert reached was the PLATFORM owner's (`notify.telegram_*`, `notify.ts`), and only for his own workspace.
 * A company's staff had the Inbox badge and Today, and nothing outside the dashboard. Now each person links THEIR OWN Telegram chat to
 * the platform's bot (`telegramLink.ts`), and the workspace's owner chooses who covers handoffs and hot leads.
 *
 *   `user.notify.<userId>`      the person: `{ v: 1, telegram: { chatId, linkedAt, name, paused } | null }`, whatever the workspace.
 *   `notify.routing.<tenantId>` the workspace: `{ v: 1, handoff: [userId], hotLeads: [userId] }`. NO row means every active, non-admin
 *                               OWNER and OPERATOR covers both (a viewer is told only in the dashboard unless chosen).
 *
 * **Delivery is additive.** `notifyOwner` (`dmSales/handoff.ts`) keeps its name, its callers and the platform owner's own alert byte for
 * byte; `notifyPeople` runs beside it. It is told nothing about the channels it does not own: with no bot token on the platform it returns
 * before it reads anything (zero statements, which keeps the DM turn's pinned timelines), and a platform admin is never a recipient (the
 * account manager has the platform's own alerts).
 *
 * **Best effort, like every alert.** It never throws. A person whose chat refuses the message (they blocked the bot) costs the others
 * nothing. A chat id and the bot token are never logged, returned or put in an audit row: the log lines carry counts.
 */
import { queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { checkSendQuota } from '../utils/rateLimiter.js';
import { getSetting, setSetting, type TenantSettingKey } from './appSettings.js';
import { buildNoticeText, sendTelegramMessage, type NoticeInput, type NoticeKind, type TelegramSettings } from './notify.js';
import { getPlatformOwnerId, normalizeTenantRole, type TenantRole } from './tenant.js';

// ─── Keys (until PR A) ───────────────────────────────────────────────────────────────────────────────────

// until PR A: `TENANT_SETTING_PREFIXES.notifyRouting`, `USER_SETTING_PREFIXES.userNotify` and `userSettingKey()` in appSettings.ts. Same strings.
export const USER_NOTIFY_PREFIX = 'user.notify.';
export const NOTIFY_ROUTING_PREFIX = 'notify.routing.';

/** An id as a key part: a uuid's characters, at most 64. The key is built only from a session's own ids, never from a body. */
const ID_PART = /^[A-Za-z0-9-]{1,64}$/;

function keyOf(prefix: string, id: string): string {
    if (!ID_PART.test(id)) throw new Error('notify key: not an id.');
    return `${prefix}${id}`;
}

export const userNotifyKey = (userId: string): string => keyOf(USER_NOTIFY_PREFIX, userId);
export const notifyRoutingKey = (tenantId: string): string => keyOf(NOTIFY_ROUTING_PREFIX, tenantId);

// until PR A: `getSetting`/`setSetting` take `AppSettingKey | TenantSettingKey | UserSettingKey`; these two families are not in the union yet.
const asKey = (key: string): TenantSettingKey => key as unknown as TenantSettingKey;

// ─── The documents ───────────────────────────────────────────────────────────────────────────────────────

export interface TelegramLink {
    /** The private chat's id. Never logged, never in an answer, never in an audit row. */
    chatId: string;
    linkedAt: string;
    /** The first name Telegram gave, cut to 40 characters: what the confirmation shows. */
    name: string;
    paused: boolean;
}

export interface UserNotify {
    v: 1;
    telegram: TelegramLink | null;
}

export interface Routing {
    v: 1;
    handoff: string[];
    hotLeads: string[];
}

const EMPTY_USER: UserNotify = { v: 1, telegram: null };

const CHAT_ID = /^-?\d{1,20}$/;

function parseJson(raw: string | null | undefined): unknown {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/** A person's document, from its stored text. Anything that is not exactly the shape written reads as "not linked": never an exception. */
export function parseUserNotify(raw: string | null | undefined): UserNotify {
    const doc = parseJson(raw) as { telegram?: Record<string, unknown> | null } | null;
    const t = doc && typeof doc === 'object' ? doc.telegram : null;
    if (!t || typeof t !== 'object') return { ...EMPTY_USER };
    if (typeof t['chatId'] !== 'string' || !CHAT_ID.test(t['chatId'])) return { ...EMPTY_USER };
    return {
        v: 1,
        telegram: {
            chatId: t['chatId'],
            linkedAt: typeof t['linkedAt'] === 'string' ? t['linkedAt'] : '',
            name: typeof t['name'] === 'string' ? t['name'].slice(0, 40) : '',
            paused: t['paused'] === true,
        },
    };
}

/** A workspace's routing, or null when there is none (or it cannot be read), which means the default. */
export function parseRouting(raw: string | null | undefined): Routing | null {
    const doc = parseJson(raw) as { handoff?: unknown; hotLeads?: unknown } | null;
    if (!doc || typeof doc !== 'object') return null;
    const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && ID_PART.test(v)) : []);
    return { v: 1, handoff: ids(doc.handoff), hotLeads: ids(doc.hotLeads) };
}

export async function readUserNotify(userId: string): Promise<UserNotify> {
    return parseUserNotify(await getSetting(asKey(userNotifyKey(userId))));
}

export async function writeUserNotify(userId: string, doc: UserNotify, updatedBy: string | null): Promise<void> {
    // A person with nothing linked has no row at all: nothing of them is kept.
    await setSetting(asKey(userNotifyKey(userId)), doc.telegram ? JSON.stringify(doc) : null, updatedBy);
}

export async function readRouting(tenantId: string): Promise<Routing | null> {
    return parseRouting(await getSetting(asKey(notifyRoutingKey(tenantId))));
}

export async function writeRouting(tenantId: string, routing: { handoff: string[]; hotLeads: string[] }, updatedBy: string | null): Promise<void> {
    await setSetting(asKey(notifyRoutingKey(tenantId)), JSON.stringify({ v: 1, handoff: routing.handoff, hotLeads: routing.hotLeads }), updatedBy);
}

// ─── The members ─────────────────────────────────────────────────────────────────────────────────────────

export interface NotifyMember {
    userId: string;
    email: string;
    role: TenantRole;
    notify: UserNotify;
}

/**
 * The workspace's people who can be told, and its routing, in ONE statement: its active members who are not platform admins, each with
 * their own `user.notify` row, and the workspace's `notify.routing` row beside them. The keys are built in SQL from ids that are already
 * UUIDs of rows, never from anything a request sent.
 */
export async function readTeamNotify(tenantId: string): Promise<{ members: NotifyMember[]; routing: Routing | null }> {
    const rows = await queryRows<{ user_id: string; email: string; role: string; notify: string | null; routing: string | null }>(
        `SELECT m.user_id::text AS user_id, u.email, m.role, n.value AS notify,
                (SELECT value FROM app_settings WHERE key = $2::text) AS routing
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN app_settings n ON n.key = $3::text || m.user_id::text
          WHERE m.creator_id = $1 AND u.is_active AND u.role <> 'platform_admin'
          ORDER BY u.email`,
        [tenantId, notifyRoutingKey(tenantId), USER_NOTIFY_PREFIX]
    );
    return {
        members: rows.map((r) => ({ userId: r.user_id, email: r.email, role: normalizeTenantRole(r.role), notify: parseUserNotify(r.notify) })),
        routing: parseRouting(rows[0]?.routing ?? null),
    };
}

export type CoverKind = 'handoff' | 'hotLeads';

/**
 * Who covers a kind of notice. With no routing row: every owner and operator. With one: the listed ids that are still members (a
 * person who left, or was deactivated, is not in `members` and so is skipped). Pure.
 */
export function coveredBy(kind: CoverKind, members: readonly NotifyMember[], routing: Routing | null): NotifyMember[] {
    if (!routing) return members.filter((m) => m.role === 'owner' || m.role === 'operator');
    const listed = new Set(routing[kind]);
    return members.filter((m) => listed.has(m.userId));
}

/** The chats that would be written to: covered, linked and not paused, one per chat. Pure. */
export function recipientChats(kind: CoverKind, members: readonly NotifyMember[], routing: Routing | null): string[] {
    const chats = new Set<string>();
    for (const m of coveredBy(kind, members, routing)) {
        const t = m.notify.telegram;
        if (t && !t.paused) chats.add(t.chatId);
    }
    return [...chats];
}

// ─── Delivery ────────────────────────────────────────────────────────────────────────────────────────────

/** What `notifyPeople` did, for the log and the tests. `none`: nobody to tell (or no bot). */
export type PeopleOutcome = 'sent' | 'none' | 'rate_limited' | 'failed' | 'error';

export interface PeopleRequest {
    creatorId: string;
    kind: NoticeKind;
    /** `notify_people:<conversation>` or `notify_people_hot:<conversation>`: one allowance per conversation, apart from the owner's. */
    bucket: string;
    limit: number;
    /** The platform's Telegram settings, read once by `notifyOwner`. Only `token` and `chatId` are used. */
    telegram: Pick<TelegramSettings, 'token' | 'chatId'>;
    /** The notice, built once and shared with the platform owner's own alert. Null when the conversation is gone. */
    notice: () => Promise<NoticeInput | null>;
    logBase: Record<string, unknown>;
}

/**
 * Tell the workspace's people. NEVER throws. The checks run cheapest first, and the one that spends the conversation's hourly allowance runs
 * last (after we know somebody would be written to), so a workspace nobody linked spends nothing.
 */
export async function notifyPeople(req: PeopleRequest): Promise<PeopleOutcome> {
    // No bot on the platform: nothing here can send, and nothing is read (zero statements).
    const token = req.telegram.token;
    if (!token) return 'none';
    try {
        const { members, routing } = await readTeamNotify(req.creatorId);
        let chats = recipientChats(req.kind === 'hot_lead' ? 'hotLeads' : 'handoff', members, routing);
        // The platform owner's own chat gets the owner's alert already: never the same message twice.
        if (chats.length > 0 && req.telegram.chatId && chats.includes(req.telegram.chatId) && req.creatorId === (await getPlatformOwnerId())) {
            chats = chats.filter((c) => c !== req.telegram.chatId);
        }
        if (chats.length === 0) return 'none';

        try {
            const quota = await checkSendQuota(req.creatorId, req.bucket, req.limit);
            if (!quota.allowed) {
                log('info', 'notify.people_rate_limited', { ...req.logBase, count: quota.count, limit: req.limit });
                return 'rate_limited';
            }
        } catch (err) {
            // A limiter that cannot be read lets the alert through: a missed handoff is worse than a repeated one.
            log('warn', 'notify.people_limiter_failed', { ...req.logBase, ...describeError(err) });
        }

        const notice = await req.notice();
        if (!notice) return 'error';
        const text = buildNoticeText(notice);
        const results = await Promise.all(chats.map(async (chatId) => {
            try {
                const result = await sendTelegramMessage({ token, chatId }, text);
                // `description` is scrubbed of the token (notify.ts) and names no chat: the failure is counted, not described by id.
                return result.ok;
            } catch {
                return false;
            }
        }));
        const sent = results.filter(Boolean).length;
        const failed = results.length - sent;
        if (sent > 0) log('info', 'notify.people_sent', { count: sent, kind: req.kind });
        if (failed > 0) log('warn', 'notify.people_failed', { count: failed });
        return sent > 0 ? 'sent' : 'failed';
    } catch (err) {
        log('warn', 'notify.people_error', { ...req.logBase, ...describeError(err) });
        return 'error';
    }
}
