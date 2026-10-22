/**
 * The Campaigns tab and the queue, under `/api/ads` (tasks T054; contracts "Campaigns, ad sets and ads", "Overview, money and ops").
 * Mounted by src/routes/ads.ts AFTER its ADS_DISABLED gate, so every route here is off for a tenant without ads, and runs in the tenant's
 * Graph context.
 *
 *   GET    /objects?level=campaign&status=ACTIVE,PAUSED&parentId=   { items: [ObjectView], syncedAt }              any member
 *   GET    /objects/:id                    { object, children: [ObjectView], results: { daily, totals } }          any member
 *   POST   /objects/:id/status             { status: 'ACTIVE'|'PAUSED', confirm?, requestId? } → { op }             owner
 *   POST   /objects/:id/budget             { kind?, amount, endTime?, confirm?, requestId? } → { op, endOp }        owner
 *   POST   /objects/:id/archive            → { op }                                                                  owner
 *   DELETE /objects/:id                    { confirm: true } → { op }; never on an ACTIVE object                     owner
 *   GET    /ops/:id                        { op }                                                                    any member
 *   GET    /ops?state=pending,running,verify   { ops }                                                               any member
 *   POST   /sync                           the campaign list and today's results now: { queued: true, notBefore }; 429 RATE_LIMITED + retryAt within 15 min   operator
 *
 * **Every GET reads Postgres only** (research R2: on Meta's Limited tier a few live page views would lock the account out of the API, the
 * cap guard included). Every write is an `ads_ops` row (src/services/ads/actions.ts), answered at once with the op; the screen polls
 * `GET /ops/:id`. Every `:id` is resolved through `ownObject` (the tenant's row, in the tenant's current ad account) and nothing else.
 */
import type { Request, Response, Router } from 'express';
import { requestArchive, requestBudget, requestDelete, requestStatus, ownObject, type ActionContext } from '../services/ads/actions.js';
import { childrenOf, lastSyncedAt, listObjects, resultsFor, toObjectView, type ObjectLevel, type ObjectRow } from '../services/ads/mirror.js';
import { editsLeftThisHour, getOp, listOps, type AdsOpState, type OpView } from '../services/ads/ops.js';
import { readAdsSettings, readHealth } from '../services/ads/settings.js';
import { dayInTz, readSyncState, requestTodaySync, syncInsights, syncStructure } from '../services/ads/sync.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { waitUntil } from '../utils/waitUntil.js';
import { describeError, log } from '../utils/log.js';

type Fail = (req: Request, res: Response, err: unknown, what: string) => Promise<void>;

const LEVELS: readonly ObjectLevel[] = ['campaign', 'adset', 'ad', 'creative'];
const OPEN_STATES: AdsOpState[] = ['pending', 'running', 'verify'];
const ALL_STATES: AdsOpState[] = ['pending', 'running', 'verify', 'done', 'failed', 'cancelled'];
/** The results each row shows: the trailing 28 days, the window the daily job keeps rewriting. */
const RESULTS_DAYS = 28;

function body(req: Request): Record<string, unknown> {
    return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
}

function ctxOf(req: Request): ActionContext {
    const requestId = body(req)['requestId'];
    return {
        creatorId: getTenantId(req),
        actor: { userId: req.session?.userId ?? null, role: (req.session as { role?: string } | undefined)?.role ?? null, via: 'owner' },
        requestId: typeof requestId === 'string' ? requestId : null,
    };
}

async function tenantAccount(creatorId: string): Promise<string | null> {
    return (await readAdsSettings(creatorId)).settings.adAccountId;
}

/** The days of the results window, in the ad account's time zone (the stored rows' own days). */
async function window(creatorId: string): Promise<{ from: string; to: string }> {
    const tz = (await readHealth(creatorId)).account?.timezone ?? 'UTC';
    const now = new Date();
    return { from: dayInTz(new Date(now.getTime() - (RESULTS_DAYS - 1) * 86_400_000), tz), to: dayInTz(now, tz) };
}

/** Rows as the screen gets them: results over the window, the ad set's budget edits left this hour, and the ops not finished yet. */
async function views(creatorId: string, rows: ObjectRow[]): Promise<ReturnType<typeof toObjectView>[]> {
    if (rows.length === 0) return [];
    const { from, to } = await window(creatorId);
    const byLevel = new Map<ObjectLevel, string[]>();
    for (const r of rows) if (r.metaId) byLevel.set(r.level, [...(byLevel.get(r.level) ?? []), r.metaId]);
    const totals = new Map<string, Awaited<ReturnType<typeof resultsFor>>['totals'] extends Map<string, infer T> ? T : never>();
    for (const [level, ids] of byLevel) {
        if (level === 'creative') continue;
        const r = await resultsFor(creatorId, level, ids, from, to);
        for (const [id, t] of r.totals) totals.set(`${level}:${id}`, t);
    }
    const adsets = rows.filter((r) => r.level === 'adset' && r.metaId).map((r) => r.metaId!);
    const left = adsets.length ? await editsLeftThisHour(creatorId, adsets) : new Map<string, number>();
    const open = await listOps(creatorId, OPEN_STATES, 500);
    const byKey = new Map<string, OpView[]>();
    for (const op of open) byKey.set(op.objectKey, [...(byKey.get(op.objectKey) ?? []), op]);
    return rows.map((r) => toObjectView(r, {
        results: r.metaId ? totals.get(`${r.level}:${r.metaId}`) ?? null : null,
        editsLeftThisHour: r.level === 'adset' && r.metaId ? left.get(r.metaId) ?? null : null,
        queuedOps: byKey.get(r.id) ?? [],
    }));
}

function list(value: unknown): string[] {
    return typeof value === 'string' && value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export function mountObjectRoutes(router: Router, fail: Fail): void {
    const canView = requireTenantRole('viewer');
    const canOperate = requireTenantRole('operator');
    const canAdminister = requireTenantRole('owner');

    /** The one place a route turns `:id` into a stored object of this tenant and its current ad account. */
    const objectOf = async (req: Request): Promise<ObjectRow> => {
        const creatorId = getTenantId(req);
        return ownObject(creatorId, await tenantAccount(creatorId), req.params['id']);
    };

    router.get('/objects', canView, async (req, res) => {
        try {
            const creatorId = getTenantId(req);
            const level = req.query['level'];
            if (level !== undefined && !LEVELS.includes(level as ObjectLevel)) {
                res.status(400).json({ error: 'level is campaign, adset, ad or creative.', code: 'INVALID', field: 'level' });
                return;
            }
            const statuses = list(req.query['status']).map((s) => s.toUpperCase()).filter((s) => /^[A-Z_]{3,30}$/.test(s));
            const parentId = typeof req.query['parentId'] === 'string' ? req.query['parentId'] : undefined;
            const account = await tenantAccount(creatorId);
            const rows = (await listObjects(creatorId, {
                ...(level ? { level: level as ObjectLevel } : {}), ...(statuses.length ? { status: statuses } : {}), ...(parentId ? { parentId } : {}),
            })).filter((r) => r.adAccountId === account);
            // When the account was last READ (the sync's own clock), not when a row last changed: an account with no campaigns is still
            // up to date, and must not say "never updated".
            const state = await readSyncState(creatorId);
            res.json({ items: await views(creatorId, rows), syncedAt: state.structureAt ?? await lastSyncedAt(creatorId) });
        } catch (err) {
            await fail(req, res, err, 'list_ads_objects');
        }
    });

    router.get('/objects/:id', canView, async (req, res) => {
        try {
            const creatorId = getTenantId(req);
            const row = await objectOf(req);
            const children = (await childrenOf(creatorId, row.id)).filter((c) => c.level !== 'creative');
            const [object, ...kids] = await views(creatorId, [row, ...children]);
            let results: { daily: unknown[]; totals: unknown } = { daily: [], totals: null };
            if (row.metaId && row.level !== 'creative') {
                const { from, to } = await window(creatorId);
                const r = await resultsFor(creatorId, row.level, [row.metaId], from, to);
                results = { daily: r.daily, totals: r.totals.get(row.metaId) ?? null };
            }
            res.json({ object, children: kids, results });
        } catch (err) {
            await fail(req, res, err, 'read_ads_object');
        }
    });

    router.post('/objects/:id/status', canAdminister, async (req, res) => {
        try {
            const b = body(req);
            const op = await requestStatus(ctxOf(req), await objectOf(req), b['status'], b['confirm']);
            res.status(202).json({ op });
        } catch (err) {
            await fail(req, res, err, 'set_object_status');
        }
    });

    router.post('/objects/:id/budget', canAdminister, async (req, res) => {
        try {
            const b = body(req);
            const out = await requestBudget(ctxOf(req), await objectOf(req), { kind: b['kind'], amount: b['amount'], endTime: b['endTime'], confirm: b['confirm'] });
            res.status(202).json(out);
        } catch (err) {
            await fail(req, res, err, 'set_object_budget');
        }
    });

    router.post('/objects/:id/archive', canAdminister, async (req, res) => {
        try {
            res.status(202).json({ op: await requestArchive(ctxOf(req), await objectOf(req)) });
        } catch (err) {
            await fail(req, res, err, 'archive_object');
        }
    });

    router.delete('/objects/:id', canAdminister, async (req, res) => {
        try {
            res.status(202).json({ op: await requestDelete(ctxOf(req), await objectOf(req), body(req)['confirm']) });
        } catch (err) {
            await fail(req, res, err, 'delete_object');
        }
    });

    router.get('/ops/:id', canView, async (req, res) => {
        try {
            const id = String(req.params['id'] ?? '');
            const op = /^[0-9a-f-]{36}$/i.test(id) ? await getOp(getTenantId(req), id) : null;
            if (!op) {
                res.status(404).json({ error: 'No such change.', code: 'NOT_FOUND' });
                return;
            }
            res.json({ op });
        } catch (err) {
            await fail(req, res, err, 'read_ads_op');
        }
    });

    router.get('/ops', canView, async (req, res) => {
        try {
            const asked = list(req.query['state']).filter((s): s is AdsOpState => (ALL_STATES as string[]).includes(s));
            res.json({ ops: await listOps(getTenantId(req), asked.length ? asked : OPEN_STATES, 100) });
        } catch (err) {
            await fail(req, res, err, 'list_ads_ops');
        }
    });

    /** The campaign list and today's results now: at most once every 15 minutes (it costs points every screen shares). Runs under `waitUntil`; the drain is the backstop. */
    router.post('/sync', canOperate, async (req, res) => {
        try {
            const creatorId = getTenantId(req);
            const asked = await requestTodaySync(creatorId);
            if (!asked.queued) {
                res.status(429).json({ error: 'Results were refreshed a moment ago; try again at the time shown.', code: 'RATE_LIMITED', retryAt: asked.retryAt });
                return;
            }
            // The campaign list first (a campaign made a minute ago in Ads Manager should appear), then today's results: 2–4 points, at most
            // once per 15 minutes.
            waitUntil(syncStructure(creatorId)
                .then(() => syncInsights(creatorId, 'today'))
                .catch((err) => log('warn', 'ads.manual_sync_failed', { creator_id: creatorId, ...describeError(err) })));
            res.status(202).json(asked);
        } catch (err) {
            await fail(req, res, err, 'request_ads_sync');
        }
    });
}
