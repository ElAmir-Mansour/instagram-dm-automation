/**
 * A stand-in for the database and for Telegram, shared by the tests of U3's notices (`notifyPeople.test.ts`, `telegramLink.test.ts`,
 * `routes/notify.test.ts`, `routes/goLive.test.ts`). Not a test itself, and never imported by shipped code.
 *
 * `pool.query` answers on the SQL it is handed, from a few in-memory tables (`app_settings`, the workspace's members, `oauth_states`,
 * the rate-limit counters, the audit ledger), and THROWS on any statement a test did not arrange. `telegramHttp` is replaced too: no test here
 * can reach Telegram, the live database, or send a message to a real person (`.env` holds live credentials).
 *
 * What it does NOT do: evaluate SQL. A predicate such as `expires_at > NOW()` is emulated in JavaScript, so a test that must pin the SQL
 * itself reads the statement text (`world.executed`).
 */
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { telegramHttp } from './notify.js';
import { invalidateTenantCache } from './tenant.js';

/** A made-up token of the right shape. It belongs to no bot. */
export const BOT_TOKEN = '123456789:AAH_fake_token_for_tests_0123456789abcd';

export interface FakeMember {
    userId: string;
    email: string;
    /** The membership's role. */
    role: 'owner' | 'operator' | 'viewer';
    /** `users.role`: 'platform_admin' is never told. */
    userRole?: 'user' | 'platform_admin';
    active?: boolean;
}

interface FakeState { platform: string; creatorId: string; userId: string | null; expiresAt: Date; usedAt: Date | null }

export class NotifyWorld {
    /** `app_settings` as saved (decrypted values). */
    settings: Record<string, string> = {};
    members: FakeMember[] = [];
    owner = 'tenant-owner';
    states = new Map<string, FakeState>();
    counters = new Map<string, number>();
    /** The rate limiter's statement throws for every bucket. */
    limiterDown = false;
    /** What `getUpdates` answers with: Telegram `update` objects. */
    updates: unknown[] = [];
    /** Replaces `getUpdates`'s answer (a function that throws is a Telegram that refuses). */
    getUpdatesAnswer: (() => unknown) | null = null;
    /** `getMe`'s answer, or a function that throws. */
    getMe: () => unknown = () => ({ data: { ok: true, result: { username: 'autoreply_pro_bot' } } });
    /** What a `sendMessage` answers with, by chat id (a function throws or refuses). */
    send: (chatId: string, body: Record<string, unknown>) => unknown = () => ({ data: { ok: true } });
    facts: Record<string, unknown> | null = {
        username: 'sara_dev', instagram_user_id: '17841400000000001', platform: null, profile_name: null, wa_username: null,
        last_inbound_text: 'I want a refund', last_inbound_at: new Date(Date.now() - 3 * 3600_000),
    };

    /** The go-live checklist's facts (`readFactsRow`), a creator for the comment check, the comment jobs and the activation numbers. Null = no row. */
    goliveFacts: Record<string, unknown> | null = null;
    commentCreator: Record<string, unknown> | null = { instagram_page_id: 'ig-1', facebook_page_id: 'fb-1', connected: true, meta_connected_at: new Date(Date.now() - 86_400_000) };
    commentJobs: { count: number; latest: Date | null } = { count: 0, latest: null };
    activation: Record<string, unknown> = { invite_accepted_at: null, first_dm: null, first_ai: null, staff: 0 };
    /** Every `onboarding_events` insert: its event name and parameters. */
    events: Array<{ event: string; params: unknown[]; once: boolean }> = [];

    executed: string[] = [];
    params: unknown[][] = [];
    /** Every audit row: action, target and detail. */
    audits: Array<{ action: string; targetId: unknown; detail: Record<string, unknown> }> = [];
    /** Every write to `app_settings`: key and value (null = deleted). */
    writes: Array<{ key: string; value: string | null }> = [];
    gets: Array<{ url: string; config: Record<string, any> | undefined }> = [];
    posts: Array<{ url: string; body: Record<string, any> }> = [];
    logs: string[] = [];
    /** The nonce of the newest state, for a test that has to "press Start". */
    lastNonce = '';

    private restorers: Array<() => void> = [];

    get logged(): Array<{ level: string; event: string; [k: string]: unknown }> {
        return this.logs.map((l) => JSON.parse(l));
    }

    /** All of it as one string, to prove a value is nowhere: statements' parameters, writes, logs, audits and Telegram's calls. */
    everything(): string {
        return JSON.stringify([this.params, this.audits, this.logs, this.gets, this.posts]);
    }

    withTelegram(over: Record<string, string> = {}): this {
        Object.assign(this.settings, { 'notify.telegram_bot_token': BOT_TOKEN, ...over });
        return this;
    }

    install(): void {
        const previousSink = setLogSink((_level, line) => { this.logs.push(line); });
        this.restorers.push(() => setLogSink(previousSink));
        invalidateTenantCache();

        const originalQuery = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            this.executed.push(sql);
            this.params.push(params);
            return this.answer(sql, params);
        };
        this.restorers.push(() => { (pool as unknown as { query: unknown }).query = originalQuery; });

        const originalGet = telegramHttp.get;
        const originalPost = telegramHttp.post;
        (telegramHttp as any).get = async (url: string, config?: Record<string, any>) => {
            this.gets.push({ url, config });
            if (url.endsWith('/getMe')) return this.getMe();
            if (url.endsWith('/getUpdates')) return this.getUpdatesAnswer ? this.getUpdatesAnswer() : { data: { ok: true, result: this.updates } };
            throw new Error(`unexpected Telegram GET ${url}`);
        };
        (telegramHttp as any).post = async (url: string, body: Record<string, any>) => {
            this.posts.push({ url, body });
            return this.send(String(body['chat_id']), body);
        };
        this.restorers.push(() => { (telegramHttp as any).get = originalGet; (telegramHttp as any).post = originalPost; });
    }

    restore(): void {
        for (const r of this.restorers.splice(0).reverse()) r();
        invalidateTenantCache();
    }

    /** A person presses Start in a private chat: the message the bot would see. */
    pressStart(code: string, chat: { id: number; type?: string; first_name?: string } = { id: 424242 }): void {
        this.updates.push({ update_id: this.updates.length + 1, message: { chat: { id: chat.id, type: chat.type ?? 'private' }, from: { first_name: chat.first_name ?? 'Sara' }, text: `/start ${code}` } });
    }

    private answer(sql: string, params: unknown[]): { rows: any[]; rowCount: number } {
        const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
        if (/FROM app_settings WHERE key = ANY\(\$1/.test(sql)) {
            const keys = params[0] as string[];
            return rows(keys.filter((k) => k in this.settings).map((key) => ({ key, value: this.settings[key], is_secret: false })));
        }
        if (/DELETE FROM app_settings WHERE key = \$1/.test(sql)) {
            delete this.settings[String(params[0])];
            this.writes.push({ key: String(params[0]), value: null });
            return { rows: [], rowCount: 1 };
        }
        if (/FROM app_settings WHERE key = \$1/.test(sql)) {
            const key = String(params[0]);
            return key in this.settings ? rows([{ value: this.settings[key], is_secret: false }]) : rows([]);
        }
        if (/INSERT INTO app_settings/.test(sql)) {
            this.settings[String(params[0])] = String(params[1]);
            this.writes.push({ key: String(params[0]), value: String(params[1]) });
            return { rows: [], rowCount: 1 };
        }
        if (/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/.test(sql)) return rows([{ id: this.owner }]);
        // readTeamNotify: the members who can be told, each with their own notify row, and the workspace's routing beside them.
        if (/FROM memberships m\s+JOIN users u ON u\.id = m\.user_id\s+LEFT JOIN app_settings n/.test(sql)) {
            const routingKey = String(params[1]);
            const prefix = String(params[2]);
            return rows(this.members
                .filter((m) => m.active !== false && (m.userRole ?? 'user') !== 'platform_admin')
                .sort((a, b) => a.email.localeCompare(b.email))
                .map((m) => ({ user_id: m.userId, email: m.email, role: m.role, notify: this.settings[`${prefix}${m.userId}`] ?? null, routing: this.settings[routingKey] ?? null })));
        }
        if (/INSERT INTO rate_limit_counters/.test(sql)) {
            if (this.limiterDown) throw new Error('limiter down');
            const bucket = String(params[1]);
            const next = (this.counters.get(bucket) ?? 0) + 1;
            this.counters.set(bucket, next);
            return rows([{ count: next }]);
        }
        if (/INSERT INTO audit_log/.test(sql)) {
            this.audits.push({ action: String(params[2]), targetId: params[4], detail: JSON.parse(String(params[5])) });
            return rows([{ id: `audit-${this.audits.length}` }]);
        }
        if (/SELECT email FROM users WHERE id = \$1/.test(sql)) return rows([{ email: 'owner@example.test' }]);
        if (/SELECT c\.username, c\.instagram_user_id/.test(sql)) return rows(this.facts ? [this.facts] : []);
        // The go-live checklist (`goLive.ts`) and the activation events (`activation.ts`).
        if (/SELECT \(SELECT status FROM onboarding WHERE creator_id = \$1\) AS onboarding_status/.test(sql)) return rows(this.goliveFacts ? [this.goliveFacts] : []);
        if (/SELECT instagram_page_id, facebook_page_id, \(page_access_token IS NOT NULL\) AS connected/.test(sql)) return rows(this.commentCreator ? [this.commentCreator] : []);
        if (/FROM jobs\s+WHERE kind = 'comment\.process'/.test(sql)) return rows([{ count: this.commentJobs.count, latest: this.commentJobs.latest }]);
        if (/SELECT \(SELECT MIN\(at\) FROM onboarding_events WHERE creator_id = \$1 AND event = 'invite_accepted'\)/.test(sql)) return rows([this.activation]);
        if (/INSERT INTO onboarding_events/.test(sql)) {
            const once = /WHERE NOT EXISTS/.test(sql);
            const event = once ? String(params[2]) : String(params[3]);
            this.events.push({ event, params, once });
            return { rows: [], rowCount: 1 };
        }
        // oauth_states
        if (/DELETE FROM oauth_states WHERE expires_at/.test(sql)) return { rows: [], rowCount: 0 };
        if (/INSERT INTO oauth_states \(nonce, platform, creator_id, user_id, expires_at\)/.test(sql)) {
            const [nonce, platform, creatorId, userId, expiresAt] = params as [string, string, string, string | null, Date];
            this.states.set(nonce, { platform, creatorId, userId, expiresAt, usedAt: null });
            this.lastNonce = nonce;
            return { rows: [], rowCount: 1 };
        }
        if (/SELECT 1 AS ok FROM oauth_states/.test(sql)) {
            const [nonce, platform, creatorId, userId] = params as [string, string, string, string | null];
            const s = this.states.get(nonce);
            const live = s && s.platform === platform && s.creatorId === creatorId && s.userId === userId && s.usedAt === null && s.expiresAt.getTime() > Date.now();
            return rows(live ? [{ ok: 1 }] : []);
        }
        if (/UPDATE oauth_states\s+SET used_at = NOW\(\)\s+WHERE nonce = \$1 AND platform = \$2/.test(sql)) {
            const [nonce, platform] = params as [string, string];
            const s = this.states.get(nonce);
            if (!s || s.platform !== platform || s.usedAt !== null || s.expiresAt.getTime() <= Date.now()) return rows([]);
            s.usedAt = new Date();
            return rows([{ creator_id: s.creatorId, user_id: s.userId }]);
        }
        throw new Error(`no result arranged for SQL:\n${sql}`);
    }
}
