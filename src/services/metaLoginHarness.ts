/**
 * A database and a Graph API that exist only in memory, for the tests of the Meta connection flow
 * (`metaLogin.ts`, `oauthState.ts`, `routes/meta.ts`). Not a test file, so `npm test` does not run it, and nothing in the
 * application imports it.
 *
 * `FakeDb` answers exactly the statements those modules issue and throws on any other, so a new statement is noticed rather than
 * silently answered with nothing. For `oauth_states` it does not just return canned rows: it reads the `WHERE` clause it was
 * given and applies the conditions that are in it (`used_at IS NULL`, `expires_at > NOW()`, the platform, the tenant and the
 * user). A guard deleted from the SQL is therefore a guard missing from the fake, and the test that depended on it fails: that
 * is what makes "single-use" testable without a database.
 *
 * `FakeGraph` replaces every outbound Graph call (`metaHttp` and the `axios.get` that `debug_token` uses), records each one, and
 * throws on a path nothing configured. Nothing here can reach Meta, whatever `.env` holds.
 */
import axios from 'axios';
import { pool } from '../config/db.js';
import { metaHttp } from './http.js';
import { LOGIN_SCOPES } from './metaLogin.js';

// ─── The database ───────────────────────────────────────────────────────────────────────

export interface OAuthStateRow {
    nonce: string;
    platform: string;
    creator_id: string;
    user_id: string | null;
    expires_at: Date;
    used_at: Date | null;
    created_at: Date;
    return_to: string | null;
    payload: string | null;
}

export interface FakeCreator {
    id: string;
    name: string | null;
    instagram_page_id: string | null;
    facebook_page_id: string | null;
    /** Stored form: `enc:v1:…`, or null. */
    page_access_token: string | null;
    meta_user_id: string | null;
    meta_page_name: string | null;
    meta_connected_at: Date | null;
    meta_webhook_subscribed_at: Date | null;
    instagram_username: string | null;
    token_status: string | null;
    token_error: string | null;
    token_last_checked_at: Date | null;
    token_expires_at: Date | null;
    token_data_access_expires_at: Date | null;
}

export interface AuditRow { actor_user_id: string | null; actor_email: string | null; action: string; target_type: string | null; target_id: string | null; detail: string }

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/** One counter for both fakes, so a test can say which happened first: a database statement or a Graph call. */
let tick = 0;

export function blankCreator(id: string, over: Partial<FakeCreator> = {}): FakeCreator {
    return {
        id, name: id, instagram_page_id: null, facebook_page_id: null, page_access_token: null, meta_user_id: null, meta_page_name: null,
        meta_connected_at: null, meta_webhook_subscribed_at: null, instagram_username: null, token_status: 'unknown', token_error: null,
        token_last_checked_at: null, token_expires_at: null, token_data_access_expires_at: null, ...over,
    };
}

export class FakeDb {
    oauth: OAuthStateRow[] = [];
    creators = new Map<string, FakeCreator>();
    audit: AuditRow[] = [];
    /** Every statement, with its parameters, in order. */
    statements: Array<{ sql: string; params: unknown[]; at: number }> = [];
    /** Runs once, just before the connection UPDATE is applied: lets a test make something happen between a check and the write. */
    beforeConnectionUpdate: (() => void) | null = null;
    /** A statement matching this throws, as a database that went away would. */
    failOn: RegExp | null = null;
    /** `app_settings`, by key. Plain values only (no secret is stored here). */
    settings = new Map<string, string>();
    /** The database's clock. Move it to expire a state. */
    now = Date.now();
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

    addCreator(id: string, over: Partial<FakeCreator> = {}): FakeCreator {
        const row = blankCreator(id, over);
        this.creators.set(id, row);
        return row;
    }

    /** A stable copy of every creator row, for "nothing changed" assertions. */
    snapshotCreators(): string {
        return JSON.stringify([...this.creators.values()].sort((a, b) => a.id.localeCompare(b.id)));
    }

    /** Everything this database holds that a secret could be in: every parameter of every statement, and every stored row. */
    everything(): string {
        return JSON.stringify([this.statements.map((s) => s.params), this.oauth, [...this.creators.values()], this.audit]);
    }

    private async query(rawSql: string, params: unknown[]): Promise<{ rows: any[]; rowCount: number }> {
        const sql = flat(rawSql);
        this.statements.push({ sql, params, at: tick++ });
        if (this.failOn?.test(sql)) throw new Error('connection terminated unexpectedly');
        const result = (rows: any[], rowCount = rows.length) => ({ rows, rowCount });
        const now = new Date(this.now);

        // ── oauth_states ──
        if (/^DELETE FROM oauth_states WHERE expires_at < NOW\(\) - INTERVAL '1 day'$/.test(sql)) {
            const keep = this.oauth.filter((r) => r.expires_at.getTime() >= this.now - 86_400_000);
            const removed = this.oauth.length - keep.length;
            this.oauth = keep;
            return result([], removed);
        }
        if (/^UPDATE oauth_states SET payload = NULL WHERE payload IS NOT NULL AND expires_at < NOW\(\)$/.test(sql)) {
            return result([], this.scrub((r) => r.expires_at.getTime() < this.now));
        }
        if (/^UPDATE oauth_states SET payload = NULL WHERE payload IS NOT NULL AND \(used_at IS NOT NULL OR expires_at < NOW\(\)\)$/.test(sql)) {
            return result([], this.scrub((r) => r.used_at !== null || r.expires_at.getTime() < this.now));
        }
        const insert = /^INSERT INTO oauth_states \(([^)]+)\) VALUES \(([^)]+)\)$/.exec(sql);
        if (insert) {
            const columns = insert[1]!.split(',').map((c) => c.trim());
            const row: OAuthStateRow = {
                nonce: '', platform: '', creator_id: '', user_id: null, expires_at: now, used_at: null, created_at: now, return_to: null, payload: null,
            };
            columns.forEach((c, i) => { (row as any)[c] = params[i]; });
            if (this.oauth.some((r) => r.nonce === row.nonce)) throw Object.assign(new Error('duplicate nonce'), { code: '23505' });
            this.oauth.push(row);
            return result([], 1);
        }
        const consume = /^UPDATE oauth_states SET used_at = NOW\(\) WHERE (.*) RETURNING (.*)$/.exec(sql);
        if (consume) {
            const where = consume[1]!;
            const hit = this.oauth.find((r) => this.matches(r, where, params));
            if (!hit) return result([]);
            hit.used_at = now;
            return result([project(hit, consume[2]!)]);
        }
        const peek = /^SELECT payload, return_to, expires_at FROM oauth_states WHERE (.*)$/.exec(sql);
        if (peek) {
            const hit = this.oauth.find((r) => this.matches(r, peek[1]!, params));
            return result(hit ? [{ payload: hit.payload, return_to: hit.return_to, expires_at: hit.expires_at }] : []);
        }
        const pick = /^WITH picked AS \( SELECT nonce, payload, return_to, expires_at FROM oauth_states WHERE (.*?) FOR UPDATE \) UPDATE oauth_states o SET (.*?) FROM picked WHERE o\.nonce = picked\.nonce RETURNING (.*)$/.exec(sql);
        if (pick) {
            const hit = this.oauth.find((r) => this.matches(r, pick[1]!, params));
            if (!hit) return result([]);
            const before = { payload: hit.payload, return_to: hit.return_to, expires_at: hit.expires_at };
            if (/used_at = NOW\(\)/.test(pick[2]!)) hit.used_at = now;
            if (/payload = NULL/.test(pick[2]!)) hit.payload = null;
            return result([before]);
        }

        // ── creators ──
        let m = /^SELECT facebook_page_id, instagram_page_id, \(page_access_token IS NOT NULL\) AS connected FROM creators WHERE id = \$1$/.exec(sql);
        if (m) {
            const c = this.creators.get(String(params[0]));
            return result(c ? [{ facebook_page_id: c.facebook_page_id, instagram_page_id: c.instagram_page_id, connected: c.page_access_token !== null }] : []);
        }
        m = /^SELECT id, name FROM creators WHERE (instagram_page_id|facebook_page_id) = \$1 AND id <> \$2 LIMIT 1$/.exec(sql);
        if (m) {
            const column = m[1] as 'instagram_page_id' | 'facebook_page_id';
            const c = [...this.creators.values()].find((x) => x[column] === params[0] && x.id !== params[1]);
            return result(c ? [{ id: c.id, name: c.name }] : []);
        }
        if (/^SELECT id, page_access_token FROM creators WHERE id = \$1$/.test(sql)) {
            const c = this.creators.get(String(params[0]));
            return result(c ? [{ id: c.id, page_access_token: c.page_access_token }] : []);
        }
        if (/^SELECT instagram_page_id, facebook_page_id, \(page_access_token IS NOT NULL\) AS has_token, /.test(sql)) {
            const c = this.creators.get(String(params[0]));
            return result(c ? [{ ...c, has_token: c.page_access_token !== null }] : []);
        }
        if (/^UPDATE creators SET instagram_page_id = \$2, facebook_page_id = \$3, page_access_token = \$4, /.test(sql)) {
            const hook = this.beforeConnectionUpdate;
            this.beforeConnectionUpdate = null;
            hook?.();
            const c = this.creators.get(String(params[0]));
            const reconnect = params[12] === true;
            if (!c || !(reconnect || c.page_access_token === null)) return result([]);
            for (const other of this.creators.values()) {
                if (other.id === c.id) continue;
                if ((params[1] && other.instagram_page_id === params[1]) || (params[2] && other.facebook_page_id === params[2])) {
                    throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
                }
            }
            c.instagram_page_id = params[1] as string | null;
            c.facebook_page_id = params[2] as string | null;
            c.page_access_token = params[3] as string;
            c.token_status = params[4] as string;
            c.token_error = params[5] as string | null;
            c.token_last_checked_at = now;
            c.token_expires_at = params[6] as Date | null;
            c.token_data_access_expires_at = params[7] as Date | null;
            c.meta_user_id = params[8] as string;
            c.meta_page_name = params[9] as string;
            if (params[10] !== null) c.instagram_username = params[10] as string;
            c.meta_connected_at = now;
            c.meta_webhook_subscribed_at = params[11] as Date | null;
            return result([{ id: c.id }]);
        }
        if (/^UPDATE creators SET instagram_page_id = NULL, facebook_page_id = NULL, page_access_token = NULL, /.test(sql)) {
            const c = this.creators.get(String(params[0]));
            if (!c) return result([], 0);
            Object.assign(c, {
                instagram_page_id: null, facebook_page_id: null, page_access_token: null, token_status: 'unknown', token_error: null,
                token_last_checked_at: null, token_expires_at: null, token_data_access_expires_at: null,
                meta_user_id: null, meta_page_name: null, meta_connected_at: null, meta_webhook_subscribed_at: null,
            });
            return result([], 1);
        }

        // ── app_settings ──
        if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(sql)) {
            const value = this.settings.get(String(params[0]));
            return result(value === undefined ? [] : [{ value, is_secret: false }]);
        }

        if (/^INSERT INTO app_settings \(key, value, is_secret, updated_at, updated_by\) VALUES /.test(sql)) {
            this.settings.set(String(params[0]), String(params[1]));
            return result([], 1);
        }
        if (/^DELETE FROM app_settings WHERE key = \$1$/.test(sql)) {
            return result([], this.settings.delete(String(params[0])) ? 1 : 0);
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

        throw new Error(`FakeDb: no answer for this statement: ${sql}`);
    }

    private scrub(predicate: (r: OAuthStateRow) => boolean): number {
        let n = 0;
        for (const r of this.oauth) {
            if (r.payload !== null && predicate(r)) { r.payload = null; n++; }
        }
        return n;
    }

    /**
     * Whether a row satisfies a `WHERE` clause, by reading the clause. Each condition applies only if it is IN the SQL: remove
     * `used_at IS NULL` from a statement and spent rows match it again.
     */
    private matches(r: OAuthStateRow, where: string, params: unknown[]): boolean {
        const nonce = /nonce = \$(\d)/.exec(where);
        if (nonce && r.nonce !== params[Number(nonce[1]) - 1]) return false;
        const platformParam = /platform = \$(\d)/.exec(where);
        if (platformParam && r.platform !== params[Number(platformParam[1]) - 1]) return false;
        const platformLiteral = /platform = '([a-z_]+)'/.exec(where);
        if (platformLiteral && r.platform !== platformLiteral[1]) return false;
        const creator = /creator_id = \$(\d)/.exec(where);
        if (creator && r.creator_id !== params[Number(creator[1]) - 1]) return false;
        const user = /user_id IS NOT DISTINCT FROM \$(\d)/.exec(where);
        if (user && (r.user_id ?? null) !== (params[Number(user[1]) - 1] ?? null)) return false;
        if (/used_at IS NULL/.test(where) && r.used_at !== null) return false;
        if (/expires_at > NOW\(\)/.test(where) && !(r.expires_at.getTime() > this.now)) return false;
        if (/payload IS NOT NULL/.test(where) && r.payload === null) return false;
        return true;
    }
}

/** The columns a RETURNING list names, from a row. */
function project(row: OAuthStateRow, returning: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const column of returning.split(',').map((c) => c.trim())) out[column] = (row as any)[column];
    return out;
}

// ─── Graph ──────────────────────────────────────────────────────────────────────────────

export interface GraphPage {
    id: string;
    name?: string;
    access_token?: string;
    tasks?: string[];
    instagram_business_account?: { id: string; username?: string };
}

export interface GraphCall {
    method: 'GET' | 'POST' | 'DELETE';
    /** Position in the sequence shared with `FakeDb.statements`. */
    at: number;
    path: string;
    params?: Record<string, unknown>;
    authorization?: string;
    body?: string;
}

/** What `debug_token` says about a token. */
export interface FakeInspection { is_valid?: boolean; type?: string; expires_at?: number; data_access_expires_at?: number; scopes?: string[] }

export class FakeGraph {
    shortToken = 'EAAShortLivedUserToken0123456789abcdefghij';
    longToken = 'EAALongLivedUserToken0123456789abcdefghijk';
    userId = '90001';
    userName: string | null = 'Test Owner';
    granted: string[] = [...LOGIN_SCOPES];
    declined: string[] = [];
    pages: GraphPage[] = [];
    /** Per Page token: what debug_token says. Default: a valid PAGE token with every scope and data access 80 days out. */
    inspections = new Map<string, FakeInspection>();
    /** Fail a call: the first matching `METHOD /path` pattern answers this error (a Graph error body and an HTTP status). */
    failures: Array<{ match: RegExp; status: number; error: { message: string; code?: number; error_subcode?: number }; times: number; onlyIf?: (cfg: any) => boolean }> = [];
    /** What `GET /{page}/subscribed_apps` answers: the fields the app is subscribed with. Set by the POST, cleared by the DELETE. */
    subscribed = new Map<string, string[]>();
    /** Ignore the subscribe POST, so the read-back finds no subscription. */
    dropSubscription = false;
    /** Runs when `debug_token` is asked: lets a test change the world between two steps of one flow. */
    onDebugToken: (() => void) | null = null;
    appId = '111222333444555';
    calls: GraphCall[] = [];
    private original = {
        get: metaHttp.get, post: metaHttp.post, delete: metaHttp.delete, axiosGet: axios.get,
    };

    install(): this {
        this.original = { get: metaHttp.get, post: metaHttp.post, delete: metaHttp.delete, axiosGet: axios.get };
        (metaHttp as any).get = (url: string, cfg: any = {}) => this.handle('GET', url, cfg);
        (metaHttp as any).post = (url: string, body: any, cfg: any = {}) => this.handle('POST', url, cfg, body);
        (metaHttp as any).delete = (url: string, cfg: any = {}) => this.handle('DELETE', url, cfg);
        (axios as any).get = (url: string, cfg: any = {}) => this.debugToken(url, cfg);
        return this;
    }

    restore(): void {
        (metaHttp as any).get = this.original.get;
        (metaHttp as any).post = this.original.post;
        (metaHttp as any).delete = this.original.delete;
        (axios as any).get = this.original.axiosGet;
    }

    fail(match: RegExp, status: number, error: { message: string; code?: number; error_subcode?: number }, times = 1, onlyIf?: (cfg: any) => boolean): this {
        this.failures.push({ match, status, error, times, onlyIf });
        return this;
    }

    /** Calls whose `METHOD /path` matches. */
    called(pattern: RegExp): GraphCall[] {
        return this.calls.filter((c) => pattern.test(`${c.method} ${c.path}`));
    }

    everything(): string {
        return JSON.stringify(this.calls);
    }

    private async handle(method: GraphCall['method'], url: string, cfg: any, body?: any): Promise<{ data: unknown }> {
        const path = url.replace(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+/, '');
        this.calls.push({
            method, at: tick++, path, params: cfg?.params, authorization: cfg?.headers?.Authorization,
            body: body instanceof URLSearchParams ? body.toString() : undefined,
        });

        const key = `${method} ${path}`;
        const failure = this.failures.find((f) => f.times > 0 && f.match.test(key) && (!f.onlyIf || f.onlyIf(cfg)));
        if (failure) {
            failure.times--;
            throw graphError(failure.status, failure.error);
        }

        if (method === 'GET' && path === '/oauth/access_token') {
            if (cfg.params?.code) return { data: { access_token: this.shortToken, token_type: 'bearer' } };
            if (cfg.params?.fb_exchange_token === this.shortToken) return { data: { access_token: this.longToken, token_type: 'bearer', expires_in: 5183944 } };
            throw graphError(400, { message: 'Invalid exchange', code: 100 });
        }
        if (method === 'GET' && path === '/me') return { data: { id: this.userId, ...(this.userName ? { name: this.userName } : {}) } };
        if (method === 'GET' && path === '/me/permissions') {
            return { data: { data: [
                ...this.granted.map((permission) => ({ permission, status: 'granted' })),
                ...this.declined.map((permission) => ({ permission, status: 'declined' })),
            ] } };
        }
        if (method === 'GET' && path === '/me/accounts') {
            // Two requests when the test asks for paging: the first answers with a cursor, the second with the rest.
            const after = cfg.params?.after;
            const size = Number(cfg.params?.limit ?? 100);
            const start = after ? Number(after) : 0;
            const slice = this.pages.slice(start, start + size);
            const more = start + size < this.pages.length;
            return { data: { data: slice, ...(more ? { paging: { cursors: { after: String(start + size) }, next: 'https://graph.facebook.com/next?access_token=SHOULD-NEVER-BE-FOLLOWED' } } : {}) } };
        }
        let m = /^\/(\d+)\/subscribed_apps$/.exec(path);
        if (m && method === 'POST') {
            if (!this.dropSubscription) this.subscribed.set(m[1]!, String(new URLSearchParams(body).get('subscribed_fields')).split(','));
            return { data: { success: true } };
        }
        if (m && method === 'GET') {
            const fields = this.subscribed.get(m[1]!);
            return { data: { data: fields ? [{ id: this.appId, name: 'Test app', subscribed_fields: fields }] : [] } };
        }
        if (m && method === 'DELETE') {
            this.subscribed.delete(m[1]!);
            return { data: { success: true } };
        }
        throw new Error(`FakeGraph: nothing answers ${key}`);
    }

    private async debugToken(url: string, cfg: any): Promise<{ data: unknown }> {
        if (!/\/debug_token$/.test(url)) throw new Error(`FakeGraph: axios.get must only be debug_token, got ${url}`);
        const token = String(cfg?.params?.input_token);
        this.calls.push({ method: 'GET', at: tick++, path: '/debug_token', params: { input_token: token } });
        this.onDebugToken?.();
        const failure = this.failures.find((f) => f.times > 0 && f.match.test('GET /debug_token'));
        if (failure) {
            failure.times--;
            throw graphError(failure.status, failure.error);
        }
        const over = this.inspections.get(token) ?? {};
        return { data: { data: {
            is_valid: over.is_valid ?? true,
            type: over.type ?? 'PAGE',
            expires_at: over.expires_at ?? 0,
            data_access_expires_at: over.data_access_expires_at ?? Math.floor(Date.now() / 1000) + 80 * 86_400,
            scopes: over.scopes ?? [...LOGIN_SCOPES],
        } } };
    }
}

/** An error shaped as axios throws a Graph failure: it carries the whole request config, which is exactly what must never leak. */
export function graphError(status: number, error: { message: string; code?: number; error_subcode?: number }): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
        isAxiosError: true,
        response: { status, data: { error } },
        config: { headers: { Authorization: 'Bearer EAA-THE-REQUEST-CONFIG-MUST-NOT-LEAK-0123456789abcdef' }, params: { client_secret: 'REQUEST-CONFIG-SECRET-0123456789' } },
    });
}

/** A Page as Graph lists it, with a Page token of its own and an Instagram account unless told otherwise. */
export function page(n: number, over: Partial<GraphPage> & { ig?: false | { id?: string; username?: string } } = {}): GraphPage {
    const { ig, ...rest } = over;
    const out: GraphPage = {
        id: `20000000000000${n}`,
        name: `Page ${n}`,
        access_token: `EAAPageToken${n}0123456789abcdefghijklmnopqrstuvwxyz`,
        tasks: ['MANAGE', 'CREATE_CONTENT', 'MODERATE'],
        ...rest,
    };
    if (ig !== false) out.instagram_business_account = { id: ig?.id ?? `1784140000000000${n}`, username: ig?.username ?? `page${n}` };
    return out;
}
