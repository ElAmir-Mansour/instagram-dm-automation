/**
 * A Meta app, a database and the owner's two alert channels that exist only in memory, for the tests of `metaWebhooks.ts` and of the two routes that use it
 * (`routes/metaWebhooks.test.ts`). Not a test file, so `npm test` does not run it, and nothing in the application imports it.
 *
 * `FakeMeta` replaces `metaHttp.get` and `metaHttp.post`: the Meta app's subscriptions (`GET` and `POST /{app}/subscriptions`, with the version in the URL kept, because
 * the version is what a subscription's fields are stored at) and each Page's (`/{page}/subscribed_apps`, which `subscribePage` uses). It records every call with its
 * headers and body, so a test can say where a token travelled, and it throws on a URL nothing configured: nothing here can reach Meta, whatever `.env` holds.
 *
 * `FakeWebhookDb` answers exactly the statements `metaWebhooks.ts`, `webhookVerifyToken.ts` and the alert path issue and throws on any other, so a new statement is
 * noticed rather than silently answered with nothing. `FakeChannels` replaces Resend's and Telegram's HTTP clients.
 */
import { encryptSecret } from '../config/crypto.js';
import { pool } from '../config/db.js';
import { metaHttp } from './http.js';
import { graphError } from './metaLoginHarness.js';
import { telegramHttp } from './notify.js';
import { emailHttp } from './notifyEmail.js';
import { APP_SETTING_KEYS } from './appSettings.js';

// ─── The Meta app ───────────────────────────────────────────────────────────────────────

export interface FakeSubscription {
    object: string;
    callback_url: string;
    active: boolean;
    fields: Array<{ name: string; version: string }>;
}

export const OTHER_SITE = 'https://staging.as-systems.tech/public/instagram/webhook/smart';
export const OUR_BASE = 'https://msg-response-auto.vercel.app';
export const OUR_CALLBACK = `${OUR_BASE}/webhook`;

const fields = (names: string[], version: string): FakeSubscription['fields'] => names.map((name) => ({ name, version }));

/** The subscriptions as they were on 2026-10-30 before the fix: `instagram` and a field-less `user` at another project's site. No secret is in it. */
export function incidentSubscriptions(ours: string = OUR_CALLBACK): FakeSubscription[] {
    return [
        { object: 'instagram', callback_url: OTHER_SITE, active: true, fields: fields(['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights'], 'v25.0') },
        {
            object: 'whatsapp_business_account', callback_url: ours, active: true,
            fields: fields(['messages', 'account_update', 'account_alerts', 'phone_number_quality_update', 'phone_number_name_update', 'business_capability_update', 'user_preferences'], 'v26.0'),
        },
        { object: 'page', callback_url: ours, active: true, fields: fields(['feed', 'messages', 'messaging_postbacks'], 'v25.0') },
        { object: 'user', callback_url: OTHER_SITE, active: true, fields: [] },
    ];
}

/** Everything where it belongs: both required objects ours, active and complete, WhatsApp beside them. */
export function healthySubscriptions(ours: string = OUR_CALLBACK): FakeSubscription[] {
    return [
        { object: 'instagram', callback_url: ours, active: true, fields: fields(['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights'], 'v25.0') },
        { object: 'page', callback_url: ours, active: true, fields: fields(['feed', 'messages', 'messaging_postbacks', 'messaging_referrals'], 'v25.0') },
    ];
}

export interface MetaCall {
    method: 'GET' | 'POST';
    /** The URL exactly as it was called, the version included. */
    url: string;
    authorization: string | undefined;
    body: URLSearchParams | undefined;
    timeout: number | undefined;
}

/** An axios error for a call that never got an answer: no response, and a request config that carries what must never leak. */
export function timeoutError(): Error {
    return Object.assign(new Error('timeout of 30000ms exceeded'), {
        isAxiosError: true, code: 'ECONNABORTED',
        config: { headers: { Authorization: 'Bearer EAA-THE-REQUEST-CONFIG-MUST-NOT-LEAK-0123456789abcdef' }, data: 'access_token=THE-BODY-MUST-NOT-LEAK-0123456789' },
    });
}

export class FakeMeta {
    appId = '111222333444555';
    subscriptions: FakeSubscription[] = [];
    /** Page id → the fields this app has on it. A Page that is not here does not list the app. */
    pages = new Map<string, string[]>();
    calls: MetaCall[] = [];
    /** Does Meta accept this verify token when it calls our `GET /webhook` while it applies a subscription? */
    acceptsVerifyToken: (token: string) => boolean = () => true;
    /** Answer a POST with success and change nothing: Meta said yes and the read-back says otherwise. */
    ignorePosts = false;
    /** When set, `GET /{app}/subscriptions` answers with exactly this body: for an answer that is not a list. */
    rawSubscriptionsBody: { value: unknown } | null = null;
    /** A call whose `METHOD url` matches this throws the error, `times` times, after letting `skip` matching calls through. */
    failures: Array<{ match: RegExp; error: Error; times: number; skip: number }> = [];
    private original = { get: metaHttp.get, post: metaHttp.post };

    install(): this {
        this.original = { get: metaHttp.get, post: metaHttp.post };
        (metaHttp as any).get = async (url: string, cfg: any = {}) => this.handle('GET', url, cfg);
        (metaHttp as any).post = async (url: string, body: any, cfg: any = {}) => this.handle('POST', url, cfg, body);
        return this;
    }

    restore(): void {
        (metaHttp as any).get = this.original.get;
        (metaHttp as any).post = this.original.post;
    }

    fail(match: RegExp, error: Error, times = 1, skip = 0): this {
        this.failures.push({ match, error, times, skip });
        return this;
    }

    /** The calls whose `METHOD url` matches. */
    called(pattern: RegExp): MetaCall[] {
        return this.calls.filter((c) => pattern.test(`${c.method} ${c.url}`));
    }

    /** Everything a secret could hide in after a run: every call, with its headers and body. */
    everything(): string {
        return JSON.stringify(this.calls.map((c) => ({ ...c, body: c.body?.toString() })));
    }

    private async handle(method: 'GET' | 'POST', url: string, cfg: any, body?: any): Promise<{ data: unknown }> {
        this.calls.push({
            method, url, authorization: cfg?.headers?.Authorization,
            body: body instanceof URLSearchParams ? new URLSearchParams(body) : undefined, timeout: cfg?.timeout,
        });
        const key = `${method} ${url}`;
        const failure = this.failures.find((f) => f.times > 0 && f.match.test(key));
        if (failure && failure.skip > 0) {
            failure.skip--;
        } else if (failure) {
            failure.times--;
            throw failure.error;
        }

        const app = new RegExp(`^https://graph\\.facebook\\.com/(v\\d+\\.\\d+)/${this.appId}/subscriptions$`).exec(url);
        if (app) {
            if (method === 'GET') return { data: this.rawSubscriptionsBody ? this.rawSubscriptionsBody.value : { data: JSON.parse(JSON.stringify(this.subscriptions)) } };
            const params = body as URLSearchParams;
            if (!this.acceptsVerifyToken(params.get('verify_token') ?? '')) {
                throw graphError(400, { message: 'Callback verification failed with the following errors: HTTP Status Code = 403', code: 2200 });
            }
            if (!this.ignorePosts) this.apply(app[1]!, params);
            return { data: { success: true } };
        }

        const page = /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/(\d+)\/subscribed_apps$/.exec(url);
        if (page) {
            const id = page[1]!;
            if (method === 'POST') {
                this.pages.set(id, String(new URLSearchParams(body).get('subscribed_fields')).split(','));
                return { data: { success: true } };
            }
            const have = this.pages.get(id);
            return { data: { data: have ? [{ id: this.appId, name: 'Test app', subscribed_fields: have }] : [] } };
        }
        throw new Error(`FakeMeta: nothing answers ${key}`);
    }

    /** What Meta does with a subscription POST: the object's address and active flag are set, its fields are REPLACED by the list sent. */
    private apply(version: string, params: URLSearchParams): void {
        const object = params.get('object')!;
        const sent = (params.get('fields') ?? '').split(',').filter(Boolean).map((name) => ({ name, version }));
        const existing = this.subscriptions.find((s) => s.object === object);
        if (existing) {
            existing.callback_url = params.get('callback_url')!;
            existing.active = true;
            existing.fields = sent;
        } else {
            this.subscriptions.push({ object, callback_url: params.get('callback_url')!, active: true, fields: sent });
        }
    }
}

// ─── The database ───────────────────────────────────────────────────────────────────────

export interface FakeCreatorRow {
    id: string;
    created_at: number;
    is_active: boolean;
    instagram_page_id: string | null;
    facebook_page_id: string | null;
    /** Stored form (`enc:v1:…`) or null. */
    page_access_token: string | null;
    webhook_verify_token: string | null;
}

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

export class FakeWebhookDb {
    /** `app_settings`: the stored value, and whether it is a secret (stored encrypted, as `setSetting` does). */
    settings = new Map<string, { value: string; secret: boolean }>();
    creators: FakeCreatorRow[] = [];
    /** Tenants with a recorded `lead_ads` legal sign-off (A10): their Page is subscribed to `leadgen` too. */
    leadAds = new Set<string>();
    whatsapp = new Map<string, { phone_number_id: string; waba_id: string | null }>();
    jobs: Array<{ kind: string; tenant_key: string | null; created_at: Date }> = [];
    audit: Array<{ actor_user_id: string | null; actor_email: string | null; action: string; target_type: string | null; target_id: string | null; detail: string }> = [];
    statements: Array<{ sql: string; params: unknown[] }> = [];
    /** A statement matching this throws, as a database that went away would. */
    failOn: RegExp | null = null;
    private original = { query: pool.query, connect: pool.connect };

    install(): this {
        this.original = { query: pool.query, connect: pool.connect };
        (pool as unknown as { query: unknown }).query = (sql: string, params: unknown[] = []) => this.query(sql, params);
        return this;
    }

    restore(): void {
        (pool as unknown as { query: unknown }).query = this.original.query;
        (pool as unknown as { connect: unknown }).connect = this.original.connect;
    }

    set(key: string, value: string): void {
        this.settings.set(key, { value, secret: false });
    }

    /** A secret setting, stored the way `setSetting` stores one (encrypted): needs `TOKEN_ENCRYPTION_KEY`. */
    setSecret(key: string, plain: string): void {
        this.settings.set(key, { value: encryptSecret(plain), secret: true });
    }

    get(key: string): string | undefined {
        return this.settings.get(key)?.value;
    }

    addCreator(id: string, over: Partial<FakeCreatorRow> = {}): FakeCreatorRow {
        const row: FakeCreatorRow = {
            id, created_at: this.creators.length, is_active: true, instagram_page_id: null, facebook_page_id: null, page_access_token: null, webhook_verify_token: null, ...over,
        };
        this.creators.push(row);
        return row;
    }

    /** Switch the owner's email alerts on, the way the Settings card does. */
    enableEmail(apiKey = 're_AbCdEfGh_0123456789abcdefghijkl', to = 'owner@example.com'): void {
        this.setSecret(APP_SETTING_KEYS.notifyEmailApiKey, apiKey);
        this.set(APP_SETTING_KEYS.notifyEmailTo, to);
        this.set(APP_SETTING_KEYS.notifyEmailEnabled, 'true');
    }

    /** Switch the owner's Telegram alerts on. */
    enableTelegram(token = '123456789:AAH_fake_token_for_tests_0123456789abcd', chatId = '4242424242'): void {
        this.setSecret(APP_SETTING_KEYS.notifyTelegramBotToken, token);
        this.set(APP_SETTING_KEYS.notifyTelegramChatId, chatId);
        this.set(APP_SETTING_KEYS.notifyTelegramEnabled, 'true');
    }

    /** Everything this database holds that a secret could be in: every parameter of every statement, and every stored row. */
    everything(): string {
        return JSON.stringify([this.statements.map((s) => s.params), [...this.settings.entries()], this.creators, this.audit]);
    }

    private async query(rawSql: string, params: unknown[]): Promise<{ rows: any[]; rowCount: number }> {
        const sql = flat(rawSql);
        this.statements.push({ sql, params });
        if (this.failOn?.test(sql)) throw new Error('connection terminated unexpectedly');
        const result = (rows: any[], rowCount = rows.length) => ({ rows, rowCount });

        // ── app_settings ──
        if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(sql)) {
            const s = this.settings.get(String(params[0]));
            return result(s === undefined ? [] : [{ value: s.value, is_secret: s.secret }]);
        }
        if (/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY\(\$1::text\[\]\)$/.test(sql)) {
            const wanted = params[0] as string[];
            return result([...this.settings.entries()].filter(([k]) => wanted.includes(k)).map(([key, s]) => ({ key, value: s.value, is_secret: s.secret })));
        }
        if (/^INSERT INTO app_settings \(key, value, is_secret, updated_at, updated_by\) VALUES /.test(sql)) {
            this.settings.set(String(params[0]), { value: String(params[1]), secret: params[2] === true });
            return result([], 1);
        }
        if (/^DELETE FROM app_settings WHERE key = \$1$/.test(sql)) {
            return result([], this.settings.delete(String(params[0])) ? 1 : 0);
        }

        // ── creators ──
        if (/^SELECT webhook_verify_token FROM creators WHERE is_active = true AND webhook_verify_token IS NOT NULL LIMIT 1$/.test(sql)) {
            const c = this.creators.find((x) => x.is_active && x.webhook_verify_token !== null);
            return result(c ? [{ webhook_verify_token: c.webhook_verify_token }] : []);
        }
        if (/^SELECT id FROM creators WHERE is_active = true AND page_access_token IS NOT NULL AND facebook_page_id IS NOT NULL ORDER BY created_at, id$/.test(sql)) {
            return result(
                this.creators.filter((c) => c.is_active && c.page_access_token !== null && c.facebook_page_id !== null)
                    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)).map((c) => ({ id: c.id }))
            );
        }
        if (/^SELECT id, facebook_page_id, page_access_token FROM creators WHERE id = \$1$/.test(sql)) {
            const c = this.creators.find((x) => x.id === params[0]);
            return result(c ? [{ id: c.id, facebook_page_id: c.facebook_page_id, page_access_token: c.page_access_token }] : []);
        }
        if (/^SELECT instagram_page_id, facebook_page_id FROM creators WHERE id = \$1$/.test(sql)) {
            const c = this.creators.find((x) => x.id === params[0]);
            return result(c ? [{ instagram_page_id: c.instagram_page_id, facebook_page_id: c.facebook_page_id }] : []);
        }

        // ── a tenant's lead-ads lock (A10): `leadgenFieldsFor` ──
        if (/^SELECT id, creator_id, scope, countries, recorded_by, recorded_at, note, revoked_at FROM ads_legal_signoffs WHERE creator_id = \$1 AND scope = \$2 AND revoked_at IS NULL /.test(sql)) {
            const on = params[1] === 'lead_ads' && this.leadAds.has(String(params[0]));
            return result(on ? [{
                id: 'signoff-1', creator_id: params[0], scope: 'lead_ads', countries: ['EG'], recorded_by: null, recorded_at: new Date(0), note: 'n', revoked_at: null,
            }] : []);
        }

        // ── where the last events went ──
        if (/^SELECT external_account_id AS phone_number_id, profile->>'waba_id' AS waba_id FROM platform_connections WHERE creator_id = \$1 AND platform = 'whatsapp' AND status <> 'revoked'$/.test(sql)) {
            const w = this.whatsapp.get(String(params[0]));
            return result(w ? [w] : []);
        }
        if (/^SELECT tenant_key, MAX\(created_at\) AS latest FROM jobs WHERE tenant_key = ANY\(\$1::text\[\]\) AND kind IN \('comment\.process', 'dm\.process', 'wa\.event', 'ads\.lead'\) GROUP BY tenant_key$/.test(sql)) {
            const keys = params[0] as string[];
            const kinds = ['comment.process', 'dm.process', 'wa.event', 'ads.lead'];
            const latest = new Map<string, Date>();
            for (const j of this.jobs) {
                if (j.tenant_key === null || !keys.includes(j.tenant_key) || !kinds.includes(j.kind)) continue;
                const seen = latest.get(j.tenant_key);
                if (!seen || j.created_at > seen) latest.set(j.tenant_key, j.created_at);
            }
            return result([...latest.entries()].map(([tenant_key, at]) => ({ tenant_key, latest: at })));
        }

        // ── the audit ledger, and who the actor is ──
        if (/^INSERT INTO audit_log /.test(sql)) {
            this.audit.push({
                actor_user_id: params[0] as string | null, actor_email: params[1] as string | null, action: String(params[2]),
                target_type: params[3] as string | null, target_id: params[4] as string | null, detail: String(params[5]),
            });
            return result([{ id: `audit-${this.audit.length}` }]);
        }
        if (/^SELECT email FROM users WHERE id = \$1$/.test(sql)) return result([]);

        throw new Error(`FakeWebhookDb: no answer for this statement: ${sql}`);
    }
}

// ─── The owner's alert channels ─────────────────────────────────────────────────────────

export interface Posted { url: string; body: any; config: any }

export class FakeChannels {
    emails: Posted[] = [];
    telegrams: Posted[] = [];
    failEmail = false;
    failTelegram = false;
    private original = { email: emailHttp.post, telegram: telegramHttp.post };

    install(): this {
        this.original = { email: emailHttp.post, telegram: telegramHttp.post };
        (emailHttp as any).post = async (url: string, body: any, config: any) => {
            this.emails.push({ url, body, config });
            if (this.failEmail) throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: { message: 'Resend is down' } } });
            return { status: 200, data: { id: 'email-1' } };
        };
        (telegramHttp as any).post = async (url: string, body: any, config: any) => {
            this.telegrams.push({ url, body, config });
            if (this.failTelegram) throw Object.assign(new Error('Request failed with status code 502'), { response: { status: 502, data: { description: 'Bad Gateway' } } });
            return { data: { ok: true, result: { message_id: 7 } } };
        };
        return this;
    }

    restore(): void {
        (emailHttp as any).post = this.original.email;
        (telegramHttp as any).post = this.original.telegram;
    }
}
