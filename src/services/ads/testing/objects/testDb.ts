/**
 * Tests only: everything the A2 action layer and its routes touch, faked in one place (used by actions.test.ts and
 * src/routes/adsObjects.test.ts): the pool answers by SQL for `app_settings`, `ads_objects` and `ads_ops` (a small in-memory table that
 * honours the idempotency key and the tenant), Meta is stubbed at `metaHttp` (every call is recorded, and marked in the statement
 * timeline so a test can say whether it happened between BEGIN and COMMIT), and `waitUntil` collects what was handed to it.
 */
import { metaHttp } from '../../../http.js';
import { telegramHttp } from '../../../notify.js';
import { setWaitUntil, type WaitUntil } from '../../../../utils/waitUntil.js';
import { resetAdsApiVersionCache } from '../../graph.js';
import { forgetMoneyPicture } from '../../money.js';
import type { ObjectRow } from '../../mirror.js';
import { installFakeDb, type AdsFakeDb } from '../testDb.js';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
export const ACC = '509787248064459';
export const OTHER_ACC = '999999999999999';
export const TOKEN = 'EAAB-token-for-tests-0123456789';

export const CAMPAIGN_ID = 'c0000000-0000-4000-8000-000000000001';
export const CAMPAIGN_META = '120001';
export const ADSET_ID = 'a0000000-0000-4000-8000-000000000002';
export const ADSET_META = '120002';

/** A stored object, defaults: a paused campaign with a 5 USD daily budget, in the tenant's ad account. */
export function objectRow(over: Partial<ObjectRow> = {}): ObjectRow {
    return {
        id: CAMPAIGN_ID, creatorId: TENANT, adAccountId: ACC, level: 'campaign', metaId: CAMPAIGN_META, parentId: null, name: 'Campaign', origin: 'app',
        status: 'PAUSED', effectiveStatus: 'PAUSED', objective: null, destinationType: null, optimizationGoal: null, budgetKind: 'daily', budgetAmount: 5,
        currency: 'USD', startTime: null, endTime: null, targetingSummary: null, review: null, appMeta: {}, raw: null, syncedAt: null, ...over,
    };
}

export function adsetRow(over: Partial<ObjectRow> = {}): ObjectRow {
    return objectRow({ id: ADSET_ID, level: 'adset', metaId: ADSET_META, parentId: CAMPAIGN_ID, name: 'Ad set', ...over });
}

const toDb = (r: ObjectRow) => ({
    id: r.id, creator_id: r.creatorId, ad_account_id: r.adAccountId, level: r.level, meta_id: r.metaId, parent_id: r.parentId, name: r.name, origin: r.origin,
    status: r.status, effective_status: r.effectiveStatus, objective: r.objective, destination_type: r.destinationType, optimization_goal: r.optimizationGoal,
    budget_kind: r.budgetKind, budget_amount: r.budgetAmount, currency: r.currency, start_time: r.startTime, end_time: r.endTime,
    targeting_summary: r.targetingSummary, review: r.review, app_meta: r.appMeta, raw: r.raw, synced_at: r.syncedAt,
});

/** An `ads_ops` row as Postgres returns it. */
export interface StoredOp {
    id: string;
    creator_id: string;
    ad_account_id: string;
    object_key: string;
    kind: string;
    payload: Record<string, any>;
    idempotency_key: string | null;
    depends_on: string | null;
    state: string;
    not_before: Date;
    attempts: number;
    result: Record<string, unknown> | null;
    actor: Record<string, unknown>;
    proposal_id: string | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
}

export interface MetaCall { method: 'GET' | 'POST' | 'DELETE'; url: string }

export interface ObjectsKit {
    db: AdsFakeDb;
    /** `app_settings` by key. */
    settings: Map<string, string>;
    /** The stored copy (`ads_objects`). */
    rows: ObjectRow[];
    /** Every op written, in order. */
    ops: StoredOp[];
    /** Budget ops already done this hour per ad set meta id (what `editsLeftThisHour` counts). */
    editsUsed: Map<string, number>;
    /** What the cap check sees as "about to run" (sum of `worst_case_delta` of unfinished ops). */
    aboutToRun: { total: number };
    /** Every Meta HTTP call. */
    meta: MetaCall[];
    /** Campaigns by meta id, as `GET /<id>` answers them. */
    live: Map<string, Record<string, unknown>>;
    /** What `act_<id>/campaigns` answers. */
    campaigns: any[];
    /** `act_<id>/insights` spend this month, major units as a string. */
    spent: { value: string };
    /** Promises handed to `waitUntil`. */
    waits: Promise<unknown>[];
    /** Hook: runs when `runOpInline` looks the op up (simulates the inline attempt finishing it). */
    onInline: { fn: ((op: StoredOp) => void) | null };
    /** Settings the way a configured tenant has them: account, max daily 20, monthly cap 100, a token, ads switched on, a payment method. */
    configure(over?: { maxDailyBudget?: number; monthlyCap?: number; hasPaymentMethod?: boolean | null }): void;
    /** A live campaign at Meta, ready for `GET /<id>`. */
    setLive(id: string, over?: Record<string, unknown>): Record<string, unknown>;
    restore(): void;
}

const opId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function installObjectsKit(): ObjectsKit {
    const db = installFakeDb();
    const settings = new Map<string, string>([[`ads.enabled.${TENANT}`, 'true']]);
    const kit: ObjectsKit = {
        db, settings, rows: [], ops: [], editsUsed: new Map(), aboutToRun: { total: 0 }, meta: [], live: new Map(), campaigns: [], spent: { value: '50' }, waits: [],
        onInline: { fn: null },
        configure(over = {}) {
            settings.set(`ads.settings.${TENANT}`, JSON.stringify({ adAccountId: ACC, maxDailyBudget: over.maxDailyBudget ?? 20, monthlyCap: over.monthlyCap ?? 100, tokenSource: 'pasted' }));
            settings.set(`ads.token.${TENANT}`, TOKEN);
            settings.set(`ads.health.${TENANT}`, JSON.stringify({
                account: { name: 'Acc', currency: 'USD', timezone: 'UTC', timezoneOffsetHours: 0, hasPaymentMethod: over.hasPaymentMethod === undefined ? true : over.hasPaymentMethod },
            }));
        },
        setLive(id, over = {}) {
            const c = { id, account_id: ACC, status: 'PAUSED', effective_status: 'PAUSED', adsets: { data: [] }, ...over };
            kit.live.set(id, c);
            return c;
        },
        restore() { /* replaced below */ },
    };
    let ids = 0;

    // ── app_settings ──
    const value = (key: string) => (settings.has(key) ? [{ key, value: settings.get(key), is_secret: false }] : []);
    db.routes.push(
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: value(p[0]) })],
        [/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/, (p) => ({ rows: (p[0] as string[]).flatMap(value) })],
        [/^INSERT INTO app_settings/, (p) => { settings.set(p[0], p[1]); return { rows: [] }; }],
        [/^DELETE FROM app_settings WHERE key = \$1/, (p) => { settings.delete(p[0]); return { rows: [] }; }],
        [/^INSERT INTO audit_log/, () => ({ rows: [{ id: 'a' }] })],
    );

    // ── ads_objects ──
    db.routes.push(
        [/FROM ads_objects WHERE creator_id = \$1 AND parent_id = \$2 AND status IS DISTINCT/, (p) => ({ rows: kit.rows.filter((r) => r.creatorId === p[0] && r.parentId === p[1] && r.status !== 'DELETED').map(toDb) })],
        [/FROM ads_objects WHERE (?:id = \$2::uuid|meta_id = \$2) AND creator_id = \$1 LIMIT 1$/, (p) => ({ rows: kit.rows.filter((r) => r.creatorId === p[0] && (r.id === p[1] || r.metaId === p[1])).slice(0, 1).map(toDb) })],
        [/FROM ads_objects WHERE creator_id = \$1 AND level/, (p, sql) => {
            let list = kit.rows.filter((r) => r.creatorId === p[0]);
            const level = sql.match(/level = \$(\d+)/);
            list = level ? list.filter((r) => r.level === p[Number(level[1]) - 1]) : list.filter((r) => r.level !== 'creative');
            const status = sql.match(/status = ANY\(\$(\d+)::text\[\]\)/);
            list = status ? list.filter((r) => (p[Number(status[1]) - 1] as string[]).includes(String(r.status))) : list.filter((r) => r.status !== 'DELETED');
            const parent = sql.match(/parent_id = \$(\d+)/);
            if (parent) list = list.filter((r) => r.parentId === p[Number(parent[1]) - 1]);
            return { rows: list.map(toDb) };
        }],
    );

    // ── ads_ops ──
    db.routes.push(
        [/^SELECT COALESCE\(SUM\(\(payload->>'worst_case_delta'\)::numeric\), 0\)::text AS total FROM ads_ops/, () => ({ rows: [{ total: String(kit.aboutToRun.total) }] })],
        [/AS k, COUNT\(\*\)::text AS n FROM ads_ops/, (p) => ({ rows: (p[2] as string[]).filter((id) => kit.editsUsed.has(id)).map((id) => ({ k: id, n: String(kit.editsUsed.get(id)) })) })],
        [/^INSERT INTO ads_ops \(creator_id, ad_account_id, object_key, kind, payload, idempotency_key/, (p) => {
            if (p[5] && kit.ops.some((o) => o.idempotency_key === p[5])) return { rows: [] };
            const now = new Date();
            const row: StoredOp = {
                id: opId(++ids), creator_id: p[0], ad_account_id: p[1], object_key: p[2], kind: p[3], payload: JSON.parse(p[4]), idempotency_key: p[5] ?? null,
                depends_on: p[6] ?? null, state: 'pending', not_before: p[7] ?? now, attempts: 0, result: null, actor: JSON.parse(p[8]), proposal_id: p[9] ?? null,
                created_at: now, started_at: null, finished_at: null,
            };
            kit.ops.push(row);
            return { rows: [row] };
        }],
        [/^SELECT \* FROM ads_ops WHERE idempotency_key = \$1 AND creator_id = \$2$/, (p) => ({ rows: kit.ops.filter((o) => o.idempotency_key === p[0] && o.creator_id === p[1]) })],
        [/^SELECT \* FROM ads_ops WHERE id = \$1 AND creator_id = \$2$/, (p) => ({ rows: kit.ops.filter((o) => o.id === p[0] && o.creator_id === p[1]) })],
        [/^SELECT \* FROM ads_ops WHERE creator_id = \$1 AND state = ANY/, (p) => ({ rows: kit.ops.filter((o) => o.creator_id === p[0] && (p[1] as string[]).includes(o.state)) })],
        [/^SELECT creator_id, ad_account_id FROM ads_ops WHERE id = \$1 AND state = 'pending'/, (p) => {
            const op = kit.ops.find((o) => o.id === p[0] && o.state === 'pending');
            if (op) kit.onInline.fn?.(op);
            return { rows: [] };
        }],
    );

    // ── Meta, telegram, waitUntil ──
    const original = { get: metaHttp.get, post: metaHttp.post, delete: metaHttp.delete, telegram: telegramHttp.post };
    const record = (method: MetaCall['method'], url: string) => { kit.meta.push({ method, url }); db.mark(`graph ${method} ${url}`); };
    (metaHttp as any).get = async (url: string) => {
        record('GET', url);
        const answer = (data: unknown) => ({ data, headers: {} });
        if (url.endsWith(`/act_${ACC}/insights`)) return answer({ data: [{ spend: kit.spent.value }] });
        if (url.endsWith(`/act_${ACC}/campaigns`)) return answer({ data: kit.campaigns });
        const id = url.match(/\/(\d+)$/)?.[1];
        if (id && kit.live.has(id)) return answer(kit.live.get(id));
        return answer({});
    };
    (metaHttp as any).post = async (url: string) => { record('POST', url); return { data: { success: true }, headers: {} }; };
    (metaHttp as any).delete = async (url: string) => { record('DELETE', url); return { data: { success: true }, headers: {} }; };
    (telegramHttp as any).post = async () => ({ data: { ok: true } });
    const collect: WaitUntil = (work) => { kit.waits.push(work); };
    const previousWait = setWaitUntil(collect);
    resetAdsApiVersionCache();
    forgetMoneyPicture();

    kit.restore = () => {
        db.restore();
        (metaHttp as any).get = original.get;
        (metaHttp as any).post = original.post;
        (metaHttp as any).delete = original.delete;
        (telegramHttp as any).post = original.telegram;
        setWaitUntil(previousWait);
        forgetMoneyPicture();
    };
    return kit;
}

/** The statement timeline's first index matching `pattern` (or -1). */
export function indexOfSql(db: AdsFakeDb, pattern: RegExp | string): number {
    return db.timeline().findIndex((s) => (typeof pattern === 'string' ? s === pattern : pattern.test(s)));
}
