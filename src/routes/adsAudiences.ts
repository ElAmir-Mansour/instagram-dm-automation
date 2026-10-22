/**
 * Audiences, under `/api/ads/audiences` (Ads Manager phase A8; contracts/dashboard-api.md "Audiences"). Mounted inside `adsRouter`, so
 * the ADS_DISABLED gate runs first and the tenant is the session's.
 *
 *   GET    /audiences                 (viewer)  { audiences, tosAccepted, tosUrl, customerList: lock view, retentionMaxDays }
 *   GET    /audiences/sources         (viewer)  { instagram, page, videos }: what an engagement or video audience can be built from
 *   POST   /audiences                 (owner)   { kind, name, spec } → 202 { audience, op }
 *   POST   /audiences/customer-list   (owner)   { name, columns, defaultCountry?, text } → 202 { audience, op, rowsAccepted, rowsExcluded… }
 *                                               403 LOCKED_LEGAL without a recorded `customer_lists` sign-off (checked BEFORE the text is read)
 *   POST   /audiences/opt-outs        (owner)   { contact } → { recorded, removalOps }: a person asked never to be in an uploaded list
 *   DELETE /audiences/:id             (owner)   { confirm: true } → { op | deleted }
 *
 * Every write goes through the ops queue (A2) and is created at Meta by it; the queue tags each create's name with `AR·<op id>`.
 *
 * **Customer lists never touch storage raw.** The text is parsed, normalised and SHA-256-hashed in this request; the hashes ride in the
 * `audience_users` ops (`scrub: true`, so the queue empties them when each upload ends) and the audience row keeps only the counts.
 * Nothing from the text is logged, audited or echoed: errors carry counts and field names only.
 */
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit, type AuditAction } from '../services/audit.js';
import {
    AudienceError, buildCreateParams, createExec, getAudience, insertAudience, listAudiences, markAudienceDeleted, parseAudienceInput,
    adoptCreatedMetaIds, RETENTION_MAX_DAYS, termsUrl, toAudienceView, usability, MIN_SEED_SIZE, type AudienceRow, type LookalikeSpec,
} from '../services/ads/audiences.js';
import {
    buildUsersParams, CUSTOMER_COLUMNS, CustomerListError, loadOptOutHashes, MAX_TEXT_BYTES, newSessionId, normaliseEmail, normalisePhone,
    parseCustomerText, prepareCustomerList, sha256Hex, toBatches, type CustomerColumn,
} from '../services/ads/hashing.js';
import { activeSignoff, lockView } from '../services/ads/legalSignoff.js';
import { enqueue, runOpInline, type EnqueueInput, type OpView } from '../services/ads/ops.js';
import { readAdsSettings, readHealth } from '../services/ads/settings.js';
import { queryRows } from '../db/query.js';
import { publishedPlatforms } from '../services/publishedIds.js';
import { getTenant, getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';
import { waitUntil } from '../utils/waitUntil.js';

const HELP_URL = '#/help/ads#customer-lists';

export interface AudienceContext {
    creatorId: string;
    adAccountId: string | null;
    igUserId: string | null;
    igUsername: string | null;
    pageId: string | null;
    pageName: string | null;
    tosAccepted: { custom: boolean | null; lookalike: boolean | null };
}

export interface VideoSource { id: string; platform: 'instagram' | 'facebook'; caption: string | null; thumbUrl: string | null; publishedAt: string | null }

export interface AudiencesDeps {
    context(req: Request): Promise<AudienceContext>;
    /** Insert the ops, then run them in order after the answer (the drain finishes whatever is left). */
    enqueue(input: EnqueueInput): Promise<OpView>;
    runInline(creatorId: string, opIds: string[]): void;
    latestOps(creatorId: string, objectKeys: string[]): Promise<Map<string, OpView>>;
    listVideos(creatorId: string): Promise<VideoSource[]>;
    canRead: RequestHandler;
    canWrite: RequestHandler;
    audit(req: Request, action: AuditAction, detail: Record<string, unknown>): Promise<void>;
}

// ─── Default wiring ─────────────────────────────────────────────────────────────────────────

async function defaultContext(req: Request): Promise<AudienceContext> {
    const creatorId = getTenantId(req);
    const [{ settings }, health, tenant] = await Promise.all([
        readAdsSettings(creatorId),
        readHealth(creatorId),
        getTenant(creatorId, ['id', 'instagram_page_id', 'facebook_page_id', 'instagram_username', 'meta_page_name']),
    ]);
    const t = tenant as unknown as Record<string, string | null> | null;
    return {
        creatorId,
        adAccountId: settings.adAccountId ?? null,
        igUserId: t?.['instagram_page_id'] ?? null,
        igUsername: t?.['instagram_username'] ?? null,
        pageId: t?.['facebook_page_id'] ?? null,
        pageName: t?.['meta_page_name'] ?? null,
        tosAccepted: health.account?.tosAccepted ?? { custom: null, lookalike: null },
    };
}

/** The newest op of each `audience:<id>` key: the list shows "being created" or why a create failed. */
export const LATEST_OPS_SQL = `
SELECT DISTINCT ON (object_key) id, kind, state, object_key, not_before, attempts, result, created_at, finished_at, actor
  FROM ads_ops
 WHERE creator_id = $1 AND object_key = ANY($2::text[]) AND kind IN ('audience_create', 'delete')
 ORDER BY object_key, created_at DESC`;

async function defaultLatestOps(creatorId: string, objectKeys: string[]): Promise<Map<string, OpView>> {
    if (objectKeys.length === 0) return new Map();
    const rows = await queryRows<{ id: string; kind: string; state: string; object_key: string; not_before: Date; attempts: number; result: Record<string, unknown> | null; created_at: Date; finished_at: Date | null; actor: { via?: string } | null }>(
        LATEST_OPS_SQL, [creatorId, objectKeys]);
    return new Map(rows.map((r) => [r.object_key, {
        id: r.id, kind: r.kind as OpView['kind'], state: r.state as OpView['state'], objectKey: r.object_key, notBefore: new Date(r.not_before).toISOString(),
        attempts: r.attempts, result: r.result, createdAt: new Date(r.created_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        actorVia: (r.actor?.via ?? 'owner') as OpView['actorVia'],
    }]));
}

/** Published videos and reels with a numeric Meta id (a Page video or an Instagram reel), newest 50. Read only. */
export const VIDEOS_SQL = `
SELECT id, platform, caption, cover_url, published_post_id, scheduled_time
  FROM scheduled_posts
 WHERE creator_id = $1 AND status = 'PUBLISHED' AND post_type IN ('video', 'reel') AND published_post_id IS NOT NULL
 ORDER BY scheduled_time DESC
 LIMIT 50`;

export async function defaultListVideos(creatorId: string): Promise<VideoSource[]> {
    const rows = await queryRows<{ caption: string | null; cover_url: string | null; published_post_id: string | null; scheduled_time: Date | null }>(VIDEOS_SQL, [creatorId]);
    const out: VideoSource[] = [];
    for (const r of rows) {
        const ids = publishedPlatforms(r.published_post_id);
        const at = r.scheduled_time ? new Date(r.scheduled_time).toISOString() : null;
        const caption = r.caption ? r.caption.slice(0, 120) : null;
        if (ids.ig && /^[0-9]+$/.test(ids.ig)) out.push({ id: ids.ig, platform: 'instagram', caption, thumbUrl: r.cover_url, publishedAt: at });
        if (ids.fb && /^[0-9]+$/.test(ids.fb)) out.push({ id: ids.fb, platform: 'facebook', caption, thumbUrl: r.cover_url, publishedAt: at });
    }
    return out;
}

export const defaultDeps: AudiencesDeps = {
    context: defaultContext,
    enqueue: (input) => enqueue(input),
    runInline: (creatorId, opIds) => {
        waitUntil((async () => {
            for (const id of opIds) {
                try { await runOpInline(id, { creatorId }); } catch (err) { log('warn', 'ads.audience_inline_failed', { op_id: id, ...describeError(err) }); return; }
            }
        })());
    },
    latestOps: defaultLatestOps,
    listVideos: defaultListVideos,
    canRead: requireTenantRole('viewer'),
    canWrite: requireTenantRole('owner'),
    audit: async (req, action, detail) => {
        await writeAudit(await actorFromSession(req.session), { action, targetType: 'creator', targetId: getTenantId(req), detail });
    },
};

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────

function body(req: Request): Record<string, unknown> {
    return (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
}

function refuse(res: Response, err: AudienceError): void {
    res.status(err.status).json({
        error: err.message, code: err.code,
        ...(err.field ? { field: err.field } : {}),
        ...(err.reason ? { reason: err.reason } : {}),
        ...(err.tosUrl ? { tosUrl: err.tosUrl } : {}),
    });
}

/** Answer a refusal this router knows; anything else goes to the ads router's `fail` (Meta errors, 500s). */
async function answer(req: Request, res: Response, err: unknown, what: string, fail: Fail): Promise<void> {
    if (err instanceof AudienceError) return refuse(res, err);
    if (err instanceof CustomerListError) {
        res.status(400).json({ error: err.message, code: 'INVALID', field: err.field });
        return;
    }
    await fail(req, res, err, what);
}

type Fail = (req: Request, res: Response, err: unknown, what: string) => Promise<void>;

function requireAccount(ctx: AudienceContext): string {
    if (!ctx.adAccountId) throw new AudienceError('ADS_NOT_CONFIGURED', 'Connect the ad account first.');
    return ctx.adAccountId;
}

function requireTerms(ctx: AudienceContext, adAccountId: string, kind: 'custom' | 'lookalike'): void {
    if (ctx.tosAccepted[kind] === false || (kind === 'lookalike' && ctx.tosAccepted.custom === false)) {
        throw new AudienceError('TERMS_NOT_ACCEPTED', "Accept Meta's Custom Audience Terms for this ad account first (in Meta: the API cannot).", { tosUrl: termsUrl(adAccountId) });
    }
}

const actorOf = (req: Request) => ({ userId: req.session?.userId ?? null, role: req.session?.role ?? null, via: 'owner' as const });

// ─── Routes ─────────────────────────────────────────────────────────────────────────────────

export function mountAudienceRoutes(router: Router, fail: Fail, deps: AudiencesDeps = defaultDeps): void {
    router.get('/audiences', deps.canRead, async (req, res) => {
        try {
            const ctx = await deps.context(req);
            await adoptCreatedMetaIds(ctx.creatorId);
            const [rows, signoff] = await Promise.all([listAudiences(ctx.creatorId), activeSignoff(ctx.creatorId, 'customer_lists')]);
            const ops = await deps.latestOps(ctx.creatorId, rows.map((r) => `audience:${r.id}`));
            res.json({
                audiences: rows.map((r) => toAudienceView(r, ops.get(`audience:${r.id}`) ?? null)),
                tosAccepted: ctx.tosAccepted,
                tosUrl: ctx.adAccountId ? termsUrl(ctx.adAccountId) : null,
                customerList: { ...lockView(signoff), helpUrl: HELP_URL },
                retentionMaxDays: RETENTION_MAX_DAYS,
            });
        } catch (err) {
            await answer(req, res, err, 'list_audiences', fail);
        }
    });

    router.get('/audiences/sources', deps.canRead, async (req, res) => {
        try {
            const ctx = await deps.context(req);
            res.json({
                instagram: ctx.igUserId ? { id: ctx.igUserId, username: ctx.igUsername } : null,
                page: ctx.pageId ? { id: ctx.pageId, name: ctx.pageName } : null,
                videos: await deps.listVideos(ctx.creatorId),
            });
        } catch (err) {
            await answer(req, res, err, 'list_audience_sources', fail);
        }
    });

    router.post('/audiences', deps.canWrite, async (req, res) => {
        try {
            const ctx = await deps.context(req);
            const adAccountId = requireAccount(ctx);
            const input = parseAudienceInput(body(req));

            let seed: AudienceRow | null = null;
            if (input.kind === 'lookalike') {
                requireTerms(ctx, adAccountId, 'lookalike');
                const spec = input.spec as LookalikeSpec;
                seed = await getAudience(ctx.creatorId, spec.seedAudienceId);
                if (!seed || seed.status === 'deleted') throw new AudienceError('NOT_FOUND', 'No such audience to copy.', { field: 'spec.seedAudienceId' });
                if (seed.kind === 'lookalike') throw new AudienceError('INVALID', 'A lookalike cannot be the source of another lookalike.', { field: 'spec.seedAudienceId', reason: 'seed_is_lookalike' });
                const { usable, unusableReason } = usability(seed);
                // A seed Meta calls too small to TARGET can still seed a lookalike: only flagged / still building / deleted refuse.
                if ((!usable && unusableReason !== 'too_small') || !seed.meta_id) {
                    throw new AudienceError('AUDIENCE_NOT_USABLE', 'The audience to copy is not ready yet.', { field: 'spec.seedAudienceId', reason: unusableReason ?? 'creating' });
                }
                const lower = seed.size_lower === null ? null : Number(seed.size_lower);
                if (lower !== null && lower < MIN_SEED_SIZE) {
                    throw new AudienceError('SEED_TOO_SMALL', `Meta needs at least ${MIN_SEED_SIZE} people in the source audience.`, { field: 'spec.seedAudienceId' });
                }
            } else {
                requireTerms(ctx, adAccountId, 'custom');
            }

            // Params first: a missing Instagram/Page refuses before any row exists.
            const params = buildCreateParams(input.kind, input.name, input.spec, { igUserId: ctx.igUserId, pageId: ctx.pageId, seedMetaId: seed?.meta_id ?? null });
            const row = await insertAudience(ctx.creatorId, { kind: input.kind, name: input.name, spec: input.spec, seedAudienceId: seed?.id ?? null });
            const op = await deps.enqueue({
                creatorId: ctx.creatorId, adAccountId, objectKey: `audience:${row.id}`, kind: 'audience_create',
                payload: { exec: createExec(adAccountId, params) }, idempotencyKey: `audience:${row.id}:create`, actor: actorOf(req),
            });
            deps.runInline(ctx.creatorId, [op.id]);
            await deps.audit(req, AUDIT_ACTIONS.adsAudienceCreated, { audience_id: row.id, kind: input.kind, op_id: op.id });
            res.status(202).json({ audience: toAudienceView(row, op), op });
        } catch (err) {
            await answer(req, res, err, 'create_audience', fail);
        }
    });

    router.post('/audiences/customer-list', deps.canWrite, async (req, res) => {
        try {
            const ctx = await deps.context(req);
            // The lock first: without a recorded sign-off the text is not even read.
            const signoff = await activeSignoff(ctx.creatorId, 'customer_lists');
            if (!signoff) {
                const view = lockView(null);
                res.status(403).json({ error: 'Customer lists are locked until a legal sign-off is recorded for your countries.', code: 'LOCKED_LEGAL', needed: view.needed, helpUrl: HELP_URL });
                return;
            }
            const adAccountId = requireAccount(ctx);
            requireTerms(ctx, adAccountId, 'custom');
            const b = body(req);

            const typed = typeof b['name'] === 'string' ? b['name'].trim() : '';
            const name = typed === '' ? 'قائمة عملاء' : parseAudienceInputName(typed);
            const defaultCountry = typeof b['defaultCountry'] === 'string' && b['defaultCountry'].trim() !== '' ? b['defaultCountry'].trim().toUpperCase() : null;
            if (defaultCountry !== null && !signoff.countries.includes(defaultCountry)) {
                throw new AudienceError('INVALID', 'The default country must be one the legal sign-off covers.', { field: 'defaultCountry', reason: 'country_not_covered' });
            }
            const columns = parseColumns(b['columns']);
            const text = b['text'];
            if (typeof text !== 'string' || text.trim() === '') throw new AudienceError('INVALID', 'Paste the list or choose a file.', { field: 'text' });
            if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new AudienceError('INVALID', 'The list is larger than 3 MB.', { field: 'text', reason: 'too_large' });

            const parsed = parseCustomerText(text, columns);
            const list = prepareCustomerList(parsed, { optOutHashes: await loadOptOutHashes(ctx.creatorId), allowedCountries: signoff.countries, defaultCountry });
            const counts = {
                rowsAccepted: list.rowsAccepted, rowsExcludedOptOut: list.rowsExcludedOptOut, rowsInvalid: list.rowsInvalid,
                rowsExcludedCountry: list.rowsExcludedCountry, rowsDuplicate: list.rowsDuplicate,
            };
            if (list.rowsAccepted === 0) {
                res.status(400).json({ error: 'No usable contact is left in this list.', code: 'INVALID', field: 'text', reason: 'no_rows', ...counts });
                return;
            }

            const row = await insertAudience(ctx.creatorId, {
                kind: 'customer_list', name, spec: { columns: list.schema, rows_sent: list.rowsAccepted, matched_estimate: null },
            });
            const actor = actorOf(req);
            const create = await deps.enqueue({
                creatorId: ctx.creatorId, adAccountId, objectKey: `audience:${row.id}`, kind: 'audience_create',
                payload: { exec: createExec(adAccountId, buildCreateParams('customer_list', name, { columns: list.schema, rows_sent: 0, matched_estimate: null }, { igUserId: null, pageId: null })) },
                idempotencyKey: `audience:${row.id}:create`, actor,
            });
            const sessionId = newSessionId();
            const ids = [create.id];
            for (const batch of toBatches(list, sessionId)) {
                const op = await deps.enqueue({
                    creatorId: ctx.creatorId, adAccountId, objectKey: `audience:${row.id}`, kind: 'audience_users', dependsOn: create.id,
                    payload: { scrub: true, exec: { method: 'POST', path: '{dep}/users', params: buildUsersParams(batch, list.rowsAccepted) } },
                    idempotencyKey: `audience:${row.id}:users:${batch.batchSeq}`, actor,
                });
                ids.push(op.id);
            }
            deps.runInline(ctx.creatorId, ids);
            await deps.audit(req, AUDIT_ACTIONS.adsCustomerListUploaded, { audience_id: row.id, batches: ids.length - 1, ...counts });
            res.status(202).json({ audience: toAudienceView(row, create), op: create, ...counts });
        } catch (err) {
            await answer(req, res, err, 'upload_customer_list', fail);
        }
    });

    router.post('/audiences/opt-outs', deps.canWrite, async (req, res) => {
        try {
            const ctx = await deps.context(req);
            const contact = body(req)['contact'];
            const hashes = optOutHashesOf(contact);
            if (hashes.length === 0) throw new AudienceError('INVALID', 'Enter a phone number with its country code, or an email.', { field: 'contact' });
            for (const hash of hashes) {
                await queryRows(RECORD_OPT_OUT_SQL, [ctx.creatorId, hash.value]);
            }
            // Take them out of the lists already at Meta too (Custom Audience Terms: later opt-outs are removed).
            const removalOps: string[] = [];
            if (ctx.adAccountId) {
                const lists = (await listAudiences(ctx.creatorId)).filter((r) => r.kind === 'customer_list' && r.meta_id);
                for (const list of lists) {
                    for (const [i, hash] of hashes.entries()) {
                        const schema: CustomerColumn = hash.kind;
                        const op = await deps.enqueue({
                            creatorId: ctx.creatorId, adAccountId: ctx.adAccountId, objectKey: `audience:${list.id}`, kind: 'audience_users',
                            payload: { scrub: true, exec: { method: 'DELETE', path: `${list.meta_id}/users`, params: { payload: JSON.stringify({ schema: [schema], data: [[hash.value]] }) } } },
                            idempotencyKey: `audience:${list.id}:optout:${hash.value.slice(0, 16)}:${i}`, actor: actorOf(req),
                        });
                        removalOps.push(op.id);
                    }
                }
                deps.runInline(ctx.creatorId, removalOps);
            }
            await deps.audit(req, AUDIT_ACTIONS.adsCustomerListOptOut, { removal_ops: removalOps.length });
            res.json({ recorded: true, removalOps: removalOps.length });
        } catch (err) {
            await answer(req, res, err, 'record_opt_out', fail);
        }
    });

    router.delete('/audiences/:id', deps.canWrite, async (req, res) => {
        try {
            const ctx = await deps.context(req);
            if (body(req)['confirm'] !== true) throw new AudienceError('INVALID', 'Confirm the deletion.', { field: 'confirm' });
            const row = await getAudience(ctx.creatorId, String(req.params['id'] ?? ''));
            if (!row || row.status === 'deleted') throw new AudienceError('NOT_FOUND', 'No such audience.');
            if (!row.meta_id) {
                // Never made it to Meta (still queued, or the create failed): nothing to delete there.
                await markAudienceDeleted(ctx.creatorId, row.id);
                await deps.audit(req, AUDIT_ACTIONS.adsAudienceDeleted, { audience_id: row.id, kind: row.kind, at_meta: false });
                res.json({ deleted: true, op: null });
                return;
            }
            const adAccountId = requireAccount(ctx);
            const op = await deps.enqueue({
                creatorId: ctx.creatorId, adAccountId, objectKey: `audience:${row.id}`, kind: 'delete',
                payload: { exec: { method: 'DELETE', path: row.meta_id } }, idempotencyKey: `audience:${row.id}:delete`, actor: actorOf(req),
            });
            await markAudienceDeleted(ctx.creatorId, row.id);
            deps.runInline(ctx.creatorId, [op.id]);
            await deps.audit(req, AUDIT_ACTIONS.adsAudienceDeleted, { audience_id: row.id, kind: row.kind, op_id: op.id, at_meta: true });
            res.json({ deleted: true, op });
        } catch (err) {
            await answer(req, res, err, 'delete_audience', fail);
        }
    });
}

// ─── Small parsers ──────────────────────────────────────────────────────────────────────────

function parseAudienceInputName(name: string): string {
    // The same neutral-name rule as every other audience.
    return parseAudienceInput({ kind: 'ig_engagement', name, spec: { event: 'engaged', retentionDays: 1 } }).name;
}

function parseColumns(value: unknown): CustomerColumn[] | 'auto' {
    if (value === undefined || value === null || value === 'auto') return 'auto';
    if (!Array.isArray(value) || value.length === 0 || value.length > CUSTOMER_COLUMNS.length
        || !value.every((c) => typeof c === 'string' && (CUSTOMER_COLUMNS as readonly string[]).includes(c))
        || new Set(value).size !== value.length) {
        throw new AudienceError('INVALID', `Columns are "auto" or a list of: ${CUSTOMER_COLUMNS.join(', ')}.`, { field: 'columns' });
    }
    return value as CustomerColumn[];
}

/** A person who asked to be left out of uploaded lists: the hash of their normalised phone or email, never the value. */
export const RECORD_OPT_OUT_SQL = `
INSERT INTO contact_consents (creator_id, platform, contact_ref, category, action, source, wording)
VALUES ($1, 'customer_list_optout', $2, 'marketing', 'withdrawn', 'owner', 'Asked to be left out of customer-list ad audiences')`;

function optOutHashesOf(contact: unknown): Array<{ kind: 'EMAIL' | 'PHONE'; value: string }> {
    if (typeof contact !== 'string' || contact.length > 200) return [];
    const email = normaliseEmail(contact);
    if (email) return [{ kind: 'EMAIL', value: sha256Hex(email) }];
    const phone = contact.trim().startsWith('+') || contact.trim().startsWith('00') ? normalisePhone(contact) : null;
    return phone ? [{ kind: 'PHONE', value: sha256Hex(phone) }] : [];
}
