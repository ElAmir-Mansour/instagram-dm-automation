/**
 * Platform administration.
 *
 * This is the one router in the app allowed to look across tenants, because "is anything
 * broken for anybody" is a question the per-tenant dashboard structurally cannot answer. It
 * started as two endpoints — create a creator, list creators — and has grown into the whole
 * administrative surface, because everything it does was previously done by hand in the
 * Supabase SQL editor:
 *
 *   - A mistyped `instagram_page_id` routes every webhook for a tenant into nothing, and
 *     could only be corrected with an UPDATE.
 *   - `users.passwordHint` in the dashboard told operators they could change their password.
 *     There was no password route anywhere in the app.
 *   - The `jobs` table became core infrastructure with no visibility and no operator control.
 *   - `/data-deletion` promises erasure, and erasure was a DELETE typed from memory — the one
 *     irreversible action in the product, performed with no preview and no record.
 *
 * Mounted under /api/admin from routes/api.ts, inside requireAuth + requireLiveSession and
 * ABOVE resolveTenant (a fresh deployment has no tenant to resolve, and this is the router
 * that fixes that), then gated again here on role.
 *
 * Two conventions worth knowing before reading:
 *
 *   - **404, never 403.** A non-admin has no business learning that this surface exists.
 *   - **Snake_case for creator and user columns, camelCase for derived blocks.** The raw
 *     columns keep the names the dashboard's existing row renderers already read; anything
 *     computed here is new and uses the project's TypeScript casing.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';
import { encryptSecret, hashPassword, isEncrypted } from '../config/crypto.js';
import { describeError, log } from '../utils/log.js';
import { invalidateTenantCache, isTenantRole, TENANT_ROLES } from '../services/tenant.js';
import { DEFAULT_HOURLY_LIMIT } from '../utils/rateLimiter.js';
import {
    actorFromSession, AUDIT_ACTIONS, clampAuditLimit, isAuditAction, listAudit, writeAudit,
} from '../services/audit.js';
import {
    getAllTenantHealth, getOpsSnapshot, getTenantCounts, getTenantHealth, getTenantMembers,
    isMissingSchema, MIGRATION_HINT, toIso,
} from '../services/health.js';
import {
    clampLimit, isPageId, isUserRole, lockoutRefusal, passwordProblem,
    readPageIdField, readVerifyTokenField, type FieldUpdate,
} from '../services/adminGuards.js';
import {
    inspectionStatus, inspectToken, recheckTenantToken, type TokenInspection,
} from '../services/tokenHealth.js';
import {
    commitErasure, executeErasure, previewErasure, rollbackErasure,
} from '../services/erasure.js';
import { APP_SETTING_KEYS, describeGeminiKey, getSetting, normaliseOrigin, setSetting } from '../services/appSettings.js';
import { checkMediaStorage, describeMediaStorage, getMediaUsage } from '../services/storage.js';
import { storageKeyKind, storageKeyProblem } from '../services/supabaseStorage.js';
import { checkGeminiKey } from '../services/geminiKey.js';
import { dmModelsInUse } from '../services/ai.js';

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Meta's automation ceiling as this app enforces it.
 *
 * Imported from the limiter rather than re-declared. This used to be a local `180` with a
 * comment saying it mirrored `DEFAULT_HOURLY_LIMIT` in src/utils/rateLimiter.ts, which did not
 * export it — two constants that must agree is one constant too many.
 */
const DM_HOURLY_CEILING = DEFAULT_HOURLY_LIMIT;

/** Postgres unique-violation. A duplicate page id is a 409, not a 500. */
const PG_UNIQUE_VIOLATION = '23505';
/** Postgres foreign-key violation. An unknown user or creator id is a 404. */
const PG_FK_VIOLATION = '23503';

/**
 * Everything below is platform_admin only.
 *
 * 404 rather than 403: a non-admin has no business knowing this surface exists.
 */
function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
    if (req.session?.role !== 'platform_admin') {
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    next();
}

router.use(requirePlatformAdmin);

/**
 * Record a mutating action, after it has happened.
 *
 * Never awaited for correctness — `writeAudit` cannot throw and reports `written: false` when
 * the ledger is unreachable. It IS awaited for ordering, so that a response and its audit row
 * cannot arrive out of order in a log drain.
 */
async function audit(
    req: Request,
    action: string,
    targetType: string | null,
    targetId: string | null,
    detail?: Record<string, unknown>
): Promise<void> {
    const actor = await actorFromSession(req.session);
    await writeAudit(actor, { action, targetType, targetId, detail: detail ?? null });
}

/**
 * The 500 body for a query that failed because the schema is behind the code.
 *
 * Migration v15 adds `audit_log` and two `creators` columns, and several endpoints here select
 * them. Without it those queries fail with `undefined_column` / `undefined_table`, which
 * renders as "Failed to load" and points nowhere. Naming the migration turns a mystery into a
 * one-line fix.
 */
function failWith(res: Response, err: unknown, event: string, message: string): void {
    log('error', event, describeError(err));
    if (isMissingSchema(err)) {
        res.status(500).json({ error: MIGRATION_HINT, migrationPending: true });
        return;
    }
    res.status(500).json({ error: message });
}

// ─── Ops ────────────────────────────────────────────────────────────────────

/**
 * Everything an operator needs to answer "is anything broken", in one request.
 *
 * Per tenant it is the same object `GET /api/health/tenant` returns — same SQL, so the two
 * pages cannot disagree — plus the global facts that belong to nobody in particular: the
 * queue, schema drift, storage against the tier, and the active keywords short enough to fire
 * inside an unrelated word.
 */
router.get('/ops', async (_req, res) => {
    try {
        res.json(await getOpsSnapshot());
    } catch (err) {
        failWith(res, err, 'admin.ops_failed', 'Failed to build the ops snapshot.');
    }
});

// ─── Gemini API key ─────────────────────────────────────────────────────────

/**
 * The one Gemini key the platform runs on: every tenant's DM replies and the Studio. It lives
 * in `app_settings`, encrypted, with `GEMINI_API_KEY` as the fallback (src/services/appSettings.ts),
 * so it can be replaced from the Operations screen without a redeploy.
 *
 * Nothing here ever sends the key back. The screen gets which key is answering, a masked hint of
 * a saved one, and whether removing it would fall back to the environment or leave nothing.
 */
router.get('/gemini-key', async (_req, res) => {
    try {
        res.json(await describeGeminiKey());
    } catch (err) {
        failWith(res, err, 'admin.gemini_key_read_failed', 'Failed to read the Gemini key status.');
    }
});

/**
 * Save a new key — after Google has accepted it and run the DM bot's models with it
 * (src/services/geminiKey.ts). A key that fails either check is never written, so the one in
 * use keeps answering.
 */
router.put('/gemini-key', async (req, res) => {
    const raw = (req.body ?? {}).apiKey;
    const apiKey = typeof raw === 'string' ? raw.trim() : '';
    if (!apiKey) {
        res.status(400).json({ error: 'Paste the key to save. To go back to GEMINI_API_KEY, remove the saved key instead.' });
        return;
    }
    // Loose on purpose — Google's answer is the real check. This only stops a paste that is
    // plainly not one key: whitespace inside it, or a length no API key has.
    if (apiKey.length < 20 || apiKey.length > 200 || /[^\x21-\x7e]/.test(apiKey)) {
        res.status(400).json({ error: 'That does not look like a Gemini API key.' });
        return;
    }

    try {
        const models = await dmModelsInUse();
        const check = await checkGeminiKey(apiKey, models);
        if (!check.ok) {
            log('warn', 'admin.gemini_key_refused', { http_status: check.status, reason: check.error });
            res.status(check.status).json({ error: check.error });
            return;
        }

        await setSetting(APP_SETTING_KEYS.geminiApiKey, apiKey, req.session?.userId ?? null);
        // The fact, never the value — and named so the redaction pattern leaves it readable.
        await audit(req, AUDIT_ACTIONS.settingsGeminiKeyWrite, 'app', null, {
            change: 'saved', checked_models: models, quota_spent: check.quotaSpent,
        });
        res.json({ ...(await describeGeminiKey()), checkedModels: models, quotaSpent: check.quotaSpent });
    } catch (err) {
        failWith(res, err, 'admin.gemini_key_save_failed', 'Failed to save the Gemini key.');
    }
});

/**
 * Forget the saved key, so GEMINI_API_KEY answers again. Allowed even when there is no env key
 * to fall back to — revoking a leaked key must not be blocked — so the screen asks first, and
 * says which of the two outcomes this will be.
 */
router.delete('/gemini-key', async (req, res) => {
    try {
        await setSetting(APP_SETTING_KEYS.geminiApiKey, null, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.settingsGeminiKeyWrite, 'app', null, { change: 'removed' });
        res.json(await describeGeminiKey());
    } catch (err) {
        failWith(res, err, 'admin.gemini_key_remove_failed', 'Failed to remove the Gemini key.');
    }
});

// ─── Media storage ──────────────────────────────────────────────────────────

/**
 * The Supabase Storage project every tenant's uploads go to (src/services/storage.ts): its URL,
 * and a secret key (or the legacy service_role key) saved encrypted, with `SUPABASE_URL` /
 * `SUPABASE_SERVICE_ROLE_KEY` as the fallback. One config for the deployment; each tenant's
 * files sit in their own folder of the one bucket.
 *
 * The status never carries the key. Saving asks Supabase first — reading the bucket and
 * creating it, public, if it is missing — so a key Supabase refuses is never written.
 */
router.get('/media-storage', async (_req, res) => {
    try {
        res.json(await describeMediaStorage());
    } catch (err) {
        failWith(res, err, 'admin.media_storage_read_failed', 'Failed to read the media storage status.');
    }
});

router.put('/media-storage', async (req, res) => {
    const body = req.body ?? {};
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    const rawKey = typeof body.key === 'string' ? body.key.trim() : '';

    const url = rawUrl ? normaliseOrigin(rawUrl) : null;
    if (!url) {
        res.status(400).json({ error: 'The Project URL must be an https:// address, like https://abcd1234.supabase.co' });
        return;
    }
    const keyProblem = rawKey ? storageKeyProblem(rawKey) : null;
    if (keyProblem) {
        res.status(400).json({ error: keyProblem });
        return;
    }

    try {
        // A blank key keeps the saved one — the page never has it to send back — and then
        // the environment's, so the URL can be saved on its own.
        const key = rawKey
            || (await getSetting(APP_SETTING_KEYS.mediaStorageKey))
            || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
            || '';
        if (!key) {
            res.status(400).json({ error: 'Paste the secret key as well: nothing is saved or set in the environment yet.' });
            return;
        }

        const check = await checkMediaStorage({ url, key }, { create: true });
        if (!check.ok) {
            log('warn', 'admin.media_storage_refused', { http_status: check.status, reason: check.error });
            res.status(check.status).json({ error: check.error });
            return;
        }

        const updatedBy = req.session?.userId ?? null;
        await setSetting(APP_SETTING_KEYS.mediaStorageUrl, url, updatedBy);
        if (rawKey) await setSetting(APP_SETTING_KEYS.mediaStorageKey, rawKey, updatedBy);
        // The fact, never the value, named so the redaction pattern leaves it readable.
        await audit(req, AUDIT_ACTIONS.settingsMediaStorageWrite, 'app', null, {
            change: 'saved',
            fields: rawKey ? ['url', 'credential'] : ['url'],
            credential_kind: storageKeyKind(key),
            bucket_created: check.created,
        });
        res.json(await describeMediaStorage());
    } catch (err) {
        failWith(res, err, 'admin.media_storage_save_failed', 'Failed to save the media storage settings.');
    }
});

/**
 * Forget the saved config, so the environment's (or Postgres) takes over. Refused while files
 * are in Storage and nothing else could read them: they would stop being served — including to
 * Meta and TikTok, mid-publish.
 */
router.delete('/media-storage', async (req, res) => {
    try {
        const [usage, savedUrl, savedKey] = await Promise.all([
            getMediaUsage(),
            getSetting(APP_SETTING_KEYS.mediaStorageUrl),
            getSetting(APP_SETTING_KEYS.mediaStorageKey),
        ]);
        const envUrl = process.env.SUPABASE_URL?.trim();
        const envReadsThem = Boolean(envUrl && normaliseOrigin(envUrl) && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
        if (usage.storage.files > 0 && !envReadsThem) {
            res.status(409).json({
                error: `${usage.storage.files} file(s) are in Supabase Storage. Without this config they cannot be served, so it stays. Replace it with another key instead.`,
            });
            return;
        }
        if (!savedUrl && !savedKey) {
            res.status(404).json({ error: 'Nothing is saved here to remove.' });
            return;
        }

        const updatedBy = req.session?.userId ?? null;
        await setSetting(APP_SETTING_KEYS.mediaStorageUrl, null, updatedBy);
        await setSetting(APP_SETTING_KEYS.mediaStorageKey, null, updatedBy);
        await audit(req, AUDIT_ACTIONS.settingsMediaStorageWrite, 'app', null, { change: 'removed' });
        res.json(await describeMediaStorage());
    } catch (err) {
        failWith(res, err, 'admin.media_storage_remove_failed', 'Failed to remove the media storage settings.');
    }
});

// ─── Tenants ────────────────────────────────────────────────────────────────

/**
 * One row per creator, with the numbers that tell you whether it is healthy.
 *
 * `last_webhook_at` is the column worth having. This project's own notes call a webhook
 * signature failure invisible — the 403 happens before anything touches the database, so a
 * tenant whose deliveries stopped looks exactly like a tenant nobody is messaging.
 *
 * The derivation changed with this feature and the change matters: it used to be the newest
 * `interactions` or `messages` row, and a comment that matches no campaign writes **neither**.
 * So a tenant whose keywords all stopped matching read as a tenant receiving no traffic.
 * `getAllTenantHealth` folds in `jobs`, which since v13 gets a row for every delivery before
 * Meta is acknowledged, matched or not. See src/services/health.ts.
 *
 * The response shape is unchanged: the same snake_case keys, plus additive ones.
 */
router.get('/tenants', async (_req, res) => {
    try {
        const [result, health] = await Promise.all([
            pool.query(`
                SELECT
                    c.id,
                    c.name,
                    c.instagram_page_id,
                    c.facebook_page_id,
                    c.is_active,
                    c.token_status,
                    c.token_last_checked_at,
                    c.token_error,
                    c.created_at,
                    (SELECT COUNT(*)::int FROM campaigns ca WHERE ca.creator_id = c.id) AS campaigns,
                    (SELECT COUNT(*)::int FROM scheduled_posts s WHERE s.creator_id = c.id) AS scheduled_posts,
                    (SELECT COUNT(*)::int FROM conversations cv WHERE cv.creator_id = c.id) AS conversations,
                    (SELECT COUNT(*)::int FROM scheduled_posts s
                      WHERE s.creator_id = c.id AND s.status = 'PUBLISHED'
                        AND s.scheduled_time > NOW() - INTERVAL '7 days') AS published_7d,
                    (SELECT COUNT(*)::int FROM scheduled_posts s
                      WHERE s.creator_id = c.id AND s.status = 'FAILED'
                        AND s.scheduled_time > NOW() - INTERVAL '7 days') AS failed_7d,
                    COALESCE((SELECT r.count FROM rate_limit_counters r
                               WHERE r.creator_id = c.id AND r.bucket = 'dm'
                                 AND r.window_start = date_trunc('hour', NOW())), 0)::int AS dm_this_hour
                FROM creators c
                ORDER BY c.name NULLS LAST, c.created_at
            `),
            // Degrades rather than failing.
            //
            // This is the one endpoint here that existed before this feature and that the
            // dashboard already polls, and the health query selects two columns migration v15
            // adds. Deploy the code before applying the migration and a working tenants list
            // would start 500ing — a regression caused by the deploy ORDER, which is exactly
            // the kind of failure this project keeps being bitten by. So a health query that
            // cannot run costs the derived columns and nothing else: the base rows, which
            // need no new column, still render.
            getAllTenantHealth().catch((err) => {
                log('warn', 'admin.tenants_health_degraded', describeError(err));
                return null;
            }),
        ]);

        const byId = new Map((health ?? []).map((h) => [h.tenantId, h]));

        res.json({
            dmHourlyCeiling: DM_HOURLY_CEILING,
            // So the dashboard can say "apply migration v15" rather than showing empty columns
            // that look like a dead webhook — which is the single most expensive
            // misdiagnosis available in this app.
            migrationPending: health === null,
            tenants: result.rows.map((row: any) => {
                const h = byId.get(row.id);
                return {
                    ...row,
                    // Kept at its original key so nothing in the dashboard has to change.
                    last_webhook_at: h?.lastWebhookAt ?? null,
                    // Additive: the three signals `last_webhook_at` is the max of, so a red
                    // row can say *which* path went quiet without a second request.
                    last_comment_at: h?.lastCommentAt ?? null,
                    last_inbound_dm_at: h?.lastInboundDmAt ?? null,
                    token_expires_at: h?.tokenExpiresAt ?? null,
                    token_data_access_expires_at: h?.dataAccessExpiresAt ?? null,
                    queue: h?.queue ?? { pending: 0, running: 0, failed: 0 },
                };
            }),
        });
    } catch (err) {
        failWith(res, err, 'admin.tenants_list_failed', 'Failed to fetch tenants.');
    }
});

/**
 * Validate a supplied Meta token before it is ever stored.
 *
 * Storing an unverified token means the first evidence that it is wrong is a customer's DM
 * silently failing. `debug_token` answers in one round-trip, and the two things it catches are
 * the two mistakes people actually make: pasting a USER token (which cannot post private
 * replies or publish at all) and pasting one that has already expired.
 */
async function validateSuppliedToken(
    token: string
): Promise<{ ok: true; inspection: TokenInspection } | { ok: false; error: string }> {
    let inspection: TokenInspection;
    try {
        inspection = await inspectToken(token);
    } catch (err: any) {
        const metaMessage = err?.response?.data?.error?.message;
        log('warn', 'admin.token_check_failed', describeError(err));
        return {
            ok: false,
            error: typeof metaMessage === 'string'
                ? `Meta could not verify that token: ${metaMessage}`
                : 'Meta could not be reached to verify that token — nothing was saved.',
        };
    }

    if (!inspection.isValid) {
        return { ok: false, error: inspection.error ?? 'Meta rejected that token.' };
    }
    if (inspection.type !== 'PAGE') {
        return {
            ok: false,
            error: `Wrong token type: "${inspection.type ?? 'unknown'}". You need a PAGE access token — `
                + 'a USER token cannot post private replies or publish.',
        };
    }
    return { ok: true, inspection };
}

/**
 * Refuse a page id already claimed by another creator.
 *
 * Checked explicitly rather than relying on the unique indexes, for a reason worth recording:
 * `instagram_page_id` has a real UNIQUE constraint from schema.sql, but
 * `idx_creators_facebook_page` was created as a PLAIN index by v3 and v10's
 * `CREATE UNIQUE INDEX IF NOT EXISTS` matched the name and silently did nothing — verified
 * against the live database. Migration v15 repairs it, but a route that only catches
 * `23505` would have been wrong on every deployment where it had not run yet. A pre-check is
 * also the only way to say *which* tenant holds the id, which is what the operator needs.
 */
async function pageIdConflict(
    column: 'instagram_page_id' | 'facebook_page_id',
    value: string,
    excludingCreatorId: string
): Promise<{ id: string; name: string | null } | null> {
    const { rows } = await pool.query(
        `SELECT id, name FROM creators WHERE ${column} = $1 AND id <> $2 LIMIT 1`,
        [value, excludingCreatorId]
    );
    return rows[0] ?? null;
}

/** Never return the token itself. A masked preview says whether it is the one you think. */
function maskToken(value: string | null): { configured: boolean; preview: string | null; length: number } {
    if (!value) return { configured: false, preview: null, length: 0 };
    return {
        configured: true,
        preview: `${value.slice(0, 3)}${'•'.repeat(Math.max(value.length - 5, 3))}${value.slice(-2)}`,
        length: value.length,
    };
}

/**
 * Create a creator — the first-run path.
 *
 * `instagram_page_id` and `page_access_token` are NOT NULL in the schema, so both are
 * required. The token is checked against Meta and then encrypted here, which means a tenant
 * created through this endpoint never has a plaintext or unverified token in the database at
 * any point.
 */
router.post('/tenants', async (req, res) => {
    try {
        const { name, instagram_page_id, facebook_page_id, page_access_token, webhook_verify_token } = req.body ?? {};

        if (typeof instagram_page_id !== 'string' || !instagram_page_id.trim()) {
            res.status(400).json({ error: 'instagram_page_id is required.' });
            return;
        }
        const igPageId = instagram_page_id.trim();
        if (!isPageId(igPageId)) {
            res.status(400).json({ error: `instagram_page_id is not a valid Meta page id.` });
            return;
        }
        if (typeof page_access_token !== 'string' || !page_access_token.trim()) {
            res.status(400).json({ error: 'page_access_token is required.' });
            return;
        }

        const fbPageId = typeof facebook_page_id === 'string' && facebook_page_id.trim()
            ? facebook_page_id.trim() : null;
        if (fbPageId && !isPageId(fbPageId)) {
            res.status(400).json({ error: 'facebook_page_id is not a valid Meta page id.' });
            return;
        }

        const verify = readVerifyTokenField(webhook_verify_token);
        if (verify.kind === 'error') {
            res.status(400).json({ error: verify.error });
            return;
        }

        // Checked before anything is written, so a rejected token leaves no half-made tenant.
        const checked = await validateSuppliedToken(page_access_token.trim());
        if (!checked.ok) {
            res.status(400).json({ error: checked.error });
            return;
        }

        let encrypted: string;
        try {
            encrypted = encryptSecret(page_access_token.trim());
        } catch (keyErr) {
            log('error', 'admin.tenant_encryption_failed', describeError(keyErr));
            res.status(500).json({
                error: 'TOKEN_ENCRYPTION_KEY is not configured. Generate one with `openssl rand -hex 32` and set it before creating a tenant.'
            });
            return;
        }

        const result = await pool.query(
            `INSERT INTO creators
                (name, instagram_page_id, facebook_page_id, page_access_token, webhook_verify_token,
                 is_active, token_status, token_error, token_last_checked_at,
                 token_expires_at, token_data_access_expires_at)
             VALUES ($1, $2, $3, $4, $5, true, $6, $7, NOW(), $8, $9)
             RETURNING id, name, instagram_page_id, facebook_page_id, is_active, token_status, created_at`,
            [
                typeof name === 'string' && name.trim() ? name.trim() : null,
                igPageId,
                fbPageId,
                encrypted,
                verify.kind === 'set' ? verify.value : null,
                inspectionStatus(checked.inspection),
                checked.inspection.error,
                checked.inspection.expiresAt,
                checked.inspection.dataAccessExpiresAt,
            ]
        );

        const created = result.rows[0];

        // Seed a DISABLED agent row.
        //
        // Creating a tenant used to insert into `creators` alone, and `generateAiResponse`
        // then found no `ai_agents` row — which, before the companion fix in
        // src/services/ai.ts, meant the new tenant's bot answered their real customers with a
        // generic Arabic persona and an empty knowledge base while every layer logged success.
        // That path now returns null, so the failure is safe; this row is what makes it
        // *visible*. The operator opens AI Settings and finds something switched off and
        // waiting, rather than a page describing a feature with no evidence it exists.
        //
        // `is_active = false` is the load-bearing part: an agent must be configured before it
        // speaks to anybody. Both text columns are NOT NULL in the schema, hence the starter
        // prompt. Best-effort — a tenant is still usable without an agent, and failing the
        // whole create over this would strand the token that was just verified.
        try {
            await pool.query(
                `INSERT INTO ai_agents (creator_id, is_active, system_prompt, knowledge_base)
                 VALUES ($1, false, $2, '')
                 ON CONFLICT (creator_id) DO NOTHING`,
                [created.id, 'أنت مساعد ذكي يجيب على استفسارات المتابعين باللغة العربية.']
            );
        } catch (agentErr) {
            log('warn', 'admin.tenant_agent_seed_failed', {
                creator_id: created.id, ...describeError(agentErr),
            });
        }

        // The "which creator is active" cache is keyed on nothing but time, so a new creator
        // must drop it or the legacy login keeps resolving the old one for up to 30 seconds.
        invalidateTenantCache();
        await audit(req, AUDIT_ACTIONS.tenantCreate, 'creator', created.id, {
            name: created.name,
            instagram_page_id: igPageId,
            facebook_page_id: fbPageId,
            // Deliberately the *fact*, never the value. `credential_replaced` is spelled
            // without the word "token" so the redaction pattern does not blank a boolean.
            credential_replaced: true,
            credential_type: checked.inspection.type,
            missing_scopes: checked.inspection.missingScopes,
        });

        res.status(201).json(created);
    } catch (err: any) {
        if (err?.code === PG_UNIQUE_VIOLATION) {
            res.status(409).json({ error: 'A creator with that page id already exists.' });
            return;
        }
        failWith(res, err, 'admin.tenant_create_failed', 'Failed to create tenant.');
    }
});

/**
 * Everything about one tenant, so a red row on the list can be investigated without switching
 * into it — which is what an operator had to do before, and switching tenants to diagnose one
 * is how you end up looking at the wrong customer's data.
 */
router.get('/tenants/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id)) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }

        const { rows } = await pool.query(
            `SELECT id, name, instagram_page_id, facebook_page_id, is_active, meta_user_id,
                    token_status, token_last_checked_at, token_error,
                    token_expires_at, token_data_access_expires_at,
                    page_access_token, webhook_verify_token, created_at
               FROM creators WHERE id = $1`,
            [id]
        );
        const row = rows[0];
        if (!row) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }

        const [health, counts, members] = await Promise.all([
            getTenantHealth(id),
            getTenantCounts(id),
            getTenantMembers(id),
        ]);

        const { page_access_token, webhook_verify_token, ...creator } = row;

        res.json({
            ...creator,
            token_last_checked_at: toIso(creator.token_last_checked_at),
            token_expires_at: toIso(creator.token_expires_at),
            token_data_access_expires_at: toIso(creator.token_data_access_expires_at),
            created_at: toIso(creator.created_at),
            // The token is never returned, not even masked: a Meta page token is a bearer
            // credential and a prefix is enough to correlate it across a log. Only whether it
            // is there, and whether it is still the legacy plaintext that predates encryption.
            token: {
                stored: Boolean(page_access_token),
                encrypted: isEncrypted(page_access_token),
            },
            // The verify token is not a bearer credential — it only proves to Meta that this
            // endpoint is ours — so a masked preview is safe, and it is the only way to tell
            // whether the saved value is the one pasted into Meta's console.
            webhookVerifyToken: maskToken(webhook_verify_token),
            counts,
            health,
            members,
        });
    } catch (err) {
        failWith(res, err, 'admin.tenant_detail_failed', 'Failed to fetch tenant.');
    }
});

/**
 * Edit a tenant.
 *
 * `name` and `is_active` were the only editable fields, which meant a mistyped
 * `instagram_page_id` — the field every webhook is routed by, per `getCreatorByPageId` — could
 * only be corrected with SQL against production. That is now here, validated, and refuses to
 * take an id another creator already holds.
 *
 * `null` and absent are treated differently on purpose: absent leaves a column alone, `null`
 * clears it. The old `COALESCE($1, column)` form could not express the second, so a
 * facebook_page_id could be set and never unset.
 */
router.patch('/tenants/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body ?? {};
        const { name, is_active, page_access_token } = body;

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }

        const igField = readPageIdField(body.instagram_page_id, 'instagram_page_id', false);
        const fbField = readPageIdField(body.facebook_page_id, 'facebook_page_id', true);
        const verifyField = readVerifyTokenField(body.webhook_verify_token);

        for (const field of [igField, fbField, verifyField] as FieldUpdate<string>[]) {
            if (field.kind === 'error') {
                res.status(400).json({ error: field.error });
                return;
            }
        }

        const wantsToken = typeof page_access_token === 'string' && page_access_token.trim().length > 0;
        const touched = [
            name !== undefined && 'name',
            is_active !== undefined && 'is_active',
            igField.kind !== 'absent' && 'instagram_page_id',
            fbField.kind !== 'absent' && 'facebook_page_id',
            verifyField.kind !== 'absent' && 'webhook_verify_token',
            wantsToken && 'page_access_token',
        ].filter((v): v is string => typeof v === 'string');

        if (touched.length === 0) {
            res.status(400).json({
                error: 'Nothing to update — send name, is_active, instagram_page_id, facebook_page_id, webhook_verify_token or page_access_token.'
            });
            return;
        }

        // Conflicts before writes: a 409 naming the other tenant is actionable, and a
        // Postgres unique-violation message is not.
        for (const [column, field] of [
            ['instagram_page_id', igField],
            ['facebook_page_id', fbField],
        ] as const) {
            if (field.kind !== 'set') continue;
            const clash = await pageIdConflict(column, field.value, id);
            if (clash) {
                res.status(409).json({
                    code: 'PAGE_ID_IN_USE',
                    error: `${column} ${field.value} is already assigned to ${clash.name ?? 'another tenant'} `
                        + `(${clash.id}). Two creators sharing a page id means one tenant's webhooks are `
                        + 'silently delivered to the other — clear it there first.',
                });
                return;
            }
        }

        // A token is checked against Meta before it is stored, for the same reason as on
        // create: the alternative is discovering it is wrong when a customer's DM fails.
        let inspection: TokenInspection | null = null;
        let encryptedToken: string | null = null;
        if (wantsToken) {
            const checked = await validateSuppliedToken(page_access_token.trim());
            if (!checked.ok) {
                res.status(400).json({ error: checked.error });
                return;
            }
            inspection = checked.inspection;
            try {
                encryptedToken = encryptSecret(page_access_token.trim());
            } catch (keyErr) {
                log('error', 'admin.tenant_encryption_failed', describeError(keyErr));
                res.status(500).json({
                    error: 'TOKEN_ENCRYPTION_KEY is not configured. Generate one with `openssl rand -hex 32` and set it before saving a token.'
                });
                return;
            }
        }

        // One UPDATE with a flag per field, rather than a string-built SET list: the flags are
        // bound parameters, so there is no path by which a body key becomes SQL.
        const result = await pool.query(
            `UPDATE creators
                SET name = CASE WHEN $2 THEN $3 ELSE name END,
                    is_active = CASE WHEN $4 THEN $5 ELSE is_active END,
                    instagram_page_id = CASE WHEN $6 THEN $7 ELSE instagram_page_id END,
                    facebook_page_id = CASE WHEN $8 THEN $9 ELSE facebook_page_id END,
                    webhook_verify_token = CASE WHEN $10 THEN $11 ELSE webhook_verify_token END,
                    page_access_token = CASE WHEN $12 THEN $13 ELSE page_access_token END,
                    token_status = CASE WHEN $12 THEN $14 ELSE token_status END,
                    token_error = CASE WHEN $12 THEN $15 ELSE token_error END,
                    token_last_checked_at = CASE WHEN $12 THEN NOW() ELSE token_last_checked_at END,
                    token_expires_at = CASE WHEN $12 THEN $16 ELSE token_expires_at END,
                    token_data_access_expires_at = CASE WHEN $12 THEN $17 ELSE token_data_access_expires_at END
              WHERE id = $1
          RETURNING id, name, instagram_page_id, facebook_page_id, is_active, token_status,
                    token_last_checked_at, token_error, token_expires_at,
                    token_data_access_expires_at, created_at,
                    (webhook_verify_token IS NOT NULL) AS webhook_verify_token_configured`,
            [
                id,
                name !== undefined, typeof name === 'string' && name.trim() ? name.trim() : null,
                typeof is_active === 'boolean', typeof is_active === 'boolean' ? is_active : null,
                igField.kind === 'set', igField.kind === 'set' ? igField.value : null,
                fbField.kind !== 'absent', fbField.kind === 'set' ? fbField.value : null,
                verifyField.kind !== 'absent', verifyField.kind === 'set' ? verifyField.value : null,
                Boolean(encryptedToken), encryptedToken,
                inspection ? inspectionStatus(inspection) : null,
                inspection?.error ?? null,
                inspection?.expiresAt ?? null,
                inspection?.dataAccessExpiresAt ?? null,
            ]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }

        // Deactivating the active creator changes which one the legacy session resolves to,
        // and a page id change invalidates the webhook's cached tenant resolution.
        invalidateTenantCache();

        await audit(req, AUDIT_ACTIONS.tenantUpdate, 'creator', id, {
            fields: touched,
            name: name !== undefined ? result.rows[0].name : undefined,
            is_active: typeof is_active === 'boolean' ? is_active : undefined,
            instagram_page_id: igField.kind === 'set' ? igField.value : undefined,
            facebook_page_id: fbField.kind === 'set' ? fbField.value
                : fbField.kind === 'clear' ? null : undefined,
            verify_value_changed: verifyField.kind !== 'absent' ? true : undefined,
            credential_replaced: wantsToken ? true : undefined,
        });
        if (wantsToken) {
            await audit(req, AUDIT_ACTIONS.tenantTokenWrite, 'creator', id, {
                credential_type: inspection?.type ?? null,
                missing_scopes: inspection?.missingScopes ?? [],
            });
        }

        res.json(result.rows[0]);
    } catch (err: any) {
        if (err?.code === PG_UNIQUE_VIOLATION) {
            res.status(409).json({
                code: 'PAGE_ID_IN_USE',
                error: 'Another creator already holds that page id.',
            });
            return;
        }
        failWith(res, err, 'admin.tenant_update_failed', 'Failed to update tenant.');
    }
});

/**
 * Ask Meta about this tenant's token, now, and record the answer.
 *
 * Before this, `token_status` only changed as a side effect of somebody opening the dashboard's
 * token page or of a send failing — so it could be weeks stale, and it never said *why*. The
 * columns it writes (`token_status`, `token_error`, `token_last_checked_at` and the two expiry
 * dates) are exactly what the health endpoints read back, so a re-check here immediately
 * changes what every other screen says.
 */
router.post('/tenants/:id/recheck-token', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id)) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }

        const result = await recheckTenantToken(id);
        if (!result) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }

        await audit(req, AUDIT_ACTIONS.tenantTokenRecheck, 'creator', id, {
            result_status: result.tokenStatus,
            credential_type: result.tokenType,
            missing_scopes: result.missingScopes,
        });

        res.json(result);
    } catch (err) {
        failWith(res, err, 'admin.token_recheck_failed', 'Failed to re-check the token.');
    }
});

// ─── Users ──────────────────────────────────────────────────────────────────

router.get('/users', async (_req, res) => {
    try {
        // `password_hash` is never selected — not even to discard it.
        const result = await pool.query(`
            SELECT
                u.id, u.email, u.role, u.is_active, u.token_version,
                u.last_login_at, u.created_at,
                COALESCE((
                    SELECT json_agg(json_build_object(
                        'creator_id', m.creator_id, 'role', m.role, 'name', c.name
                    ) ORDER BY c.name NULLS LAST)
                    FROM memberships m JOIN creators c ON c.id = m.creator_id
                    WHERE m.user_id = u.id
                ), '[]'::json) AS memberships
            FROM users u
            ORDER BY u.created_at
        `);
        res.json(result.rows);
    } catch (err) {
        failWith(res, err, 'admin.users_list_failed', 'Failed to fetch users.');
    }
});

/**
 * Create a user, optionally with their first membership in the same call.
 *
 * Managed onboarding: there is no self-serve signup, and this is the only way a `users` row
 * comes into existence.
 */
router.post('/users', async (req, res) => {
    try {
        const { email, password, role, creator_id } = req.body ?? {};

        if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            res.status(400).json({ error: 'A valid email is required.' });
            return;
        }
        const passwordIssue = passwordProblem(password);
        if (passwordIssue) {
            res.status(400).json({ error: passwordIssue });
            return;
        }
        if (role !== undefined && !isUserRole(role)) {
            res.status(400).json({ error: "role must be 'user' or 'platform_admin'." });
            return;
        }
        if (creator_id !== undefined && !isUuid(creator_id)) {
            res.status(400).json({ error: 'creator_id must be a uuid.' });
            return;
        }

        const passwordHash = await hashPassword(password as string);

        const result = await pool.query(
            `INSERT INTO users (email, password_hash, role)
             VALUES (lower($1), $2, $3)
             RETURNING id, email, role, is_active, token_version, created_at`,
            [email.trim(), passwordHash, role ?? 'user']
        );
        const user = result.rows[0];

        // A user with no membership can log in and reach nothing, which is a confusing first
        // experience — so the common case grants the membership in the same request.
        if (creator_id) {
            await pool.query(
                `INSERT INTO memberships (user_id, creator_id, role) VALUES ($1, $2, 'owner')
                 ON CONFLICT (user_id, creator_id) DO NOTHING`,
                [user.id, creator_id]
            );
        }

        await audit(req, AUDIT_ACTIONS.userCreate, 'user', user.id, {
            email: user.email, role: user.role, creator_id: creator_id ?? null,
        });
        if (creator_id) {
            await audit(req, AUDIT_ACTIONS.membershipGrant, 'membership', `${user.id}:${creator_id}`, {
                user_id: user.id, creator_id, membership_role: 'owner',
            });
        }

        res.status(201).json(user);
    } catch (err: any) {
        if (err?.code === PG_UNIQUE_VIOLATION) {
            res.status(409).json({ error: 'A user with that email already exists.' });
            return;
        }
        failWith(res, err, 'admin.user_create_failed', 'Failed to create user.');
    }
});

/**
 * Change a user's role or switch them off.
 *
 * Two things here are load-bearing.
 *
 * **The lockout guard.** `platform_admin` is the only role that can reach this router, so
 * demoting or deactivating the last active one leaves no way back in through the product —
 * the recovery path is an UPDATE in the SQL editor, which is the situation this whole feature
 * exists to remove. The guard runs inside the transaction that performs the write, with every
 * active admin row locked, so two concurrent demotions cannot each see "one other admin left".
 *
 * **Bumping `token_version` on a role change, not only on deactivation.** The session token
 * carries `role`, and `requireLiveSession` checks `token_version` and `is_active` — not the
 * role. Without the bump, a demoted admin keeps admin privileges until their token expires,
 * which is up to 24 hours.
 */
router.patch('/users/:id', async (req, res) => {
    const { id } = req.params;
    const { role, is_active } = req.body ?? {};

    // Validated before a pool connection is taken: `pool` is capped at 10 and the webhook
    // path competes for them, so a malformed request should not hold one to answer a 400.
    if (!isUuid(id)) {
        res.status(404).json({ error: 'User not found.' });
        return;
    }
    if (role === undefined && is_active === undefined) {
        res.status(400).json({ error: 'Nothing to update — send role and/or is_active.' });
        return;
    }
    if (role !== undefined && !isUserRole(role)) {
        res.status(400).json({ error: "role must be 'user' or 'platform_admin'." });
        return;
    }
    if (is_active !== undefined && typeof is_active !== 'boolean') {
        res.status(400).json({ error: 'is_active must be a boolean.' });
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock every active platform admin first, in a stable order, so the count below cannot
        // change under us and two concurrent demotions cannot both be allowed.
        await client.query(
            `SELECT id FROM users WHERE role = 'platform_admin' AND is_active = true ORDER BY id FOR UPDATE`
        );

        const target = (await client.query(
            'SELECT id, email, role, is_active FROM users WHERE id = $1 FOR UPDATE', [id]
        )).rows[0];

        if (!target) {
            await client.query('ROLLBACK');
            res.status(404).json({ error: 'User not found.' });
            return;
        }

        const others = (await client.query(
            `SELECT COUNT(*)::int AS n FROM users
              WHERE role = 'platform_admin' AND is_active = true AND id <> $1`, [id]
        )).rows[0].n as number;

        const refusal = lockoutRefusal(target, { role, is_active }, others);
        if (refusal) {
            await client.query('ROLLBACK');
            res.status(409).json(refusal);
            return;
        }

        // Either change can escalate or de-escalate what a live token is allowed to do, so
        // either change kills the sessions that carry the old answer.
        const roleChanging = role !== undefined && role !== target.role;
        const deactivating = is_active === false && target.is_active;
        const bump = roleChanging || deactivating;

        const updated = (await client.query(
            `UPDATE users
                SET role = COALESCE($2, role),
                    is_active = COALESCE($3, is_active),
                    token_version = token_version + CASE WHEN $4 THEN 1 ELSE 0 END
              WHERE id = $1
          RETURNING id, email, role, is_active, token_version, last_login_at, created_at`,
            [id, role ?? null, typeof is_active === 'boolean' ? is_active : null, bump]
        )).rows[0];

        await client.query('COMMIT');

        await audit(req, AUDIT_ACTIONS.userUpdate, 'user', id, {
            email: target.email,
            role_from: target.role, role_to: updated.role,
            active_from: target.is_active, active_to: updated.is_active,
            sessions_invalidated: bump,
        });

        res.json({ ...updated, sessionsInvalidated: bump });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        failWith(res, err, 'admin.user_update_failed', 'Failed to update user.');
    } finally {
        client.release();
    }
});

/**
 * Set a user's password on their behalf.
 *
 * The operator path for "I have locked myself out" and for handing over a new account. Bumping
 * `token_version` is not optional here: a password reset that leaves the old sessions alive
 * has not taken anything back.
 */
router.post('/users/:id/password', async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body ?? {};

        if (!isUuid(id)) {
            res.status(404).json({ error: 'User not found.' });
            return;
        }
        const issue = passwordProblem(password);
        if (issue) {
            res.status(400).json({ error: issue });
            return;
        }

        const passwordHash = await hashPassword(password as string);

        const result = await pool.query(
            `UPDATE users
                SET password_hash = $2, token_version = token_version + 1
              WHERE id = $1
          RETURNING id, email, token_version`,
            [id, passwordHash]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'User not found.' });
            return;
        }

        await audit(req, AUDIT_ACTIONS.userPasswordSet, 'user', id, {
            email: result.rows[0].email, sessions_invalidated: true,
        });

        res.json({
            ...result.rows[0],
            message: 'Password set. Every session that user held is now invalid.',
        });
    } catch (err) {
        failWith(res, err, 'admin.user_password_failed', 'Failed to set the password.');
    }
});

/**
 * Revoke every session a user holds.
 *
 * Bumping `token_version` is the only kill switch this system has: sessions are stateless
 * HMACs with a 24h TTL, so before this column existed a leaked token simply could not be
 * taken back. `requireLiveSession` compares the session's copy against this one on every
 * request.
 */
router.post('/users/:id/revoke', async (req, res) => {
    try {
        const { id } = req.params;

        if (!isUuid(id)) {
            res.status(404).json({ error: 'User not found.' });
            return;
        }

        const result = await pool.query(
            'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING id, email, token_version',
            [id]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'User not found.' });
            return;
        }

        const { email, ...row } = result.rows[0];
        await audit(req, AUDIT_ACTIONS.userSessionsRevoke, 'user', id, { email });

        res.json({
            message: 'All sessions for this user are now invalid.',
            ...row,
        });
    } catch (err) {
        failWith(res, err, 'admin.user_revoke_failed', 'Failed to revoke sessions.');
    }
});

/** Grant (or re-role) a membership. Idempotent, so it doubles as "change their role". */
router.post('/users/:id/memberships', async (req, res) => {
    try {
        const { id } = req.params;
        const { creator_id, role } = req.body ?? {};

        if (!isUuid(id)) {
            res.status(404).json({ error: 'User not found.' });
            return;
        }
        if (!isUuid(creator_id)) {
            res.status(400).json({ error: 'creator_id must be a uuid.' });
            return;
        }

        // `role` used to be stored verbatim — any string at all — because nothing read it.
        // It is an authorization decision now (src/services/tenant.ts), and an unrecognised
        // value resolves to `owner`: a typo would silently grant everything to somebody an
        // operator was deliberately restricting. So it is a 400, and v16 puts the same list
        // on the column as a CHECK constraint.
        const membershipRole = role === undefined || role === null || role === ''
            ? 'owner'
            : typeof role === 'string' ? role.trim() : role;
        if (!isTenantRole(membershipRole)) {
            res.status(400).json({
                error: `role must be one of: ${TENANT_ROLES.join(', ')}.`,
            });
            return;
        }

        const result = await pool.query(
            `INSERT INTO memberships (user_id, creator_id, role) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, creator_id) DO UPDATE SET role = EXCLUDED.role
             RETURNING user_id, creator_id, role, created_at`,
            [id, creator_id, membershipRole]
        );

        await audit(req, AUDIT_ACTIONS.membershipGrant, 'membership', `${id}:${creator_id}`, {
            user_id: id, creator_id, membership_role: result.rows[0].role,
        });

        res.status(201).json(result.rows[0]);
    } catch (err: any) {
        // Both FKs land here: an unknown user id and an unknown creator id are equally 404.
        if (err?.code === PG_FK_VIOLATION) {
            res.status(404).json({ error: 'No such user or tenant.' });
            return;
        }
        failWith(res, err, 'admin.membership_failed', 'Failed to grant membership.');
    }
});

/**
 * Revoke one membership.
 *
 * Deliberately not guarded against admin lockout, unlike the role and active flags above, and
 * the reason is structural rather than an oversight: `assertTenantAccess` returns true for a
 * `platform_admin` regardless of membership, and `listTenantsForSession` lists every active
 * creator for one. A platform admin therefore reaches every tenant with no memberships at all,
 * so removing their last one cannot lock anybody out of anything. Refusing it would be
 * friction with no safety behind it. `src/services/tenant.test.ts` pins that behaviour.
 */
router.delete('/users/:id/memberships/:creatorId', async (req, res) => {
    try {
        const { id, creatorId } = req.params;

        if (!isUuid(id) || !isUuid(creatorId)) {
            res.status(404).json({ error: 'Membership not found.' });
            return;
        }

        const result = await pool.query(
            `DELETE FROM memberships WHERE user_id = $1 AND creator_id = $2
          RETURNING user_id, creator_id, role`,
            [id, creatorId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Membership not found.' });
            return;
        }

        await audit(req, AUDIT_ACTIONS.membershipRevoke, 'membership', `${id}:${creatorId}`, {
            user_id: id, creator_id: creatorId, membership_role: result.rows[0].role,
        });

        res.json({ userId: id, creatorId, removed: true, role: result.rows[0].role });
    } catch (err) {
        failWith(res, err, 'admin.membership_revoke_failed', 'Failed to revoke membership.');
    }
});

// ─── Jobs ───────────────────────────────────────────────────────────────────
//
// The queue became the app's durability guarantee in v13 — every webhook delivery is written
// down before Meta is acknowledged — and then had no visibility and no controls at all. A job
// that exhausted its retries sat in the table forever, and the only way to look at one was the
// SQL editor.
//
// `payload` is deliberately never returned. It holds the verbatim Meta event, which for a DM
// is the message text and the sender's Meta user id; serving that into a list view would make
// an operator screen a second copy of the data `src/services/retention.ts` exists to prune.

const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'] as const;
const JOBS_DEFAULT_LIMIT = 50;
const JOBS_MAX_LIMIT = 200;

router.get('/jobs', async (req, res) => {
    try {
        const status = req.query['status'];
        const tenant = req.query['tenant'];
        const limit = clampLimit(req.query['limit'], JOBS_DEFAULT_LIMIT, JOBS_MAX_LIMIT);

        if (status !== undefined && !(JOB_STATUSES as readonly unknown[]).includes(status)) {
            res.status(400).json({ error: `status must be one of: ${JOB_STATUSES.join(', ')}.` });
            return;
        }

        const tenantFilter = typeof tenant === 'string' && tenant.trim() ? tenant.trim() : null;

        const [jobs, counts] = await Promise.all([
            pool.query(
                // `tenant` matches either identifier a job can carry: the creator uuid when the
                // enqueue knew it, or `tenant_key` — the Meta page id from `entry.id` — which
                // is all the webhook path has, because resolving the tenant needs a read and
                // the point of enqueueing is to answer Meta before doing any.
                `SELECT id, kind, status, attempts, max_attempts, run_after, claimed_at,
                        last_error, tenant_key, creator_id, dedupe_key, request_id,
                        created_at, updated_at
                   FROM jobs
                  WHERE ($2::text IS NULL OR status = $2)
                    AND ($3::text IS NULL OR tenant_key = $3 OR creator_id::text = $3)
                  ORDER BY created_at DESC
                  LIMIT $1`,
                [limit, typeof status === 'string' ? status : null, tenantFilter]
            ),
            pool.query(
                `SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status`
            ),
        ]);

        const byStatus: Record<string, number> = {};
        for (const s of JOB_STATUSES) byStatus[s] = 0;
        for (const row of counts.rows) byStatus[row.status] = row.n;

        res.json({ limit, counts: byStatus, jobs: jobs.rows });
    } catch (err) {
        failWith(res, err, 'admin.jobs_list_failed', 'Failed to fetch jobs.');
    }
});

/**
 * Put a dead job back in the queue.
 *
 * `attempts = 0` because the operator is asserting that whatever made it fail has been fixed —
 * a retry that kept the old count would burn its one remaining attempt and dead-letter again.
 * `last_error` is deliberately kept: until the retry succeeds (at which point `complete()`
 * clears it) it is the only record of what went wrong, and a pending job showing its previous
 * failure is more informative than one showing nothing.
 */
router.post('/jobs/:id/retry', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id)) {
            res.status(404).json({ error: 'Job not found.' });
            return;
        }

        const result = await pool.query(
            `UPDATE jobs
                SET status = 'pending', attempts = 0, claimed_at = NULL,
                    run_after = NOW(), updated_at = NOW()
              WHERE id = $1 AND status IN ('failed', 'cancelled')
          RETURNING id, kind, status, attempts, max_attempts, run_after, last_error, tenant_key`,
            [id]
        );

        if (result.rows.length === 0) {
            // Distinguish "no such job" from "not in a retryable state", because the second is
            // something the operator can act on and the first is a stale page.
            const existing = await pool.query('SELECT status FROM jobs WHERE id = $1', [id]);
            if (existing.rows.length === 0) {
                res.status(404).json({ error: 'Job not found.' });
                return;
            }
            res.status(409).json({
                code: 'JOB_NOT_RETRYABLE',
                error: `That job is "${existing.rows[0].status}", not failed or cancelled — only a job that has stopped can be retried.`,
                status: existing.rows[0].status,
            });
            return;
        }

        await audit(req, AUDIT_ACTIONS.jobRetry, 'job', id, {
            kind: result.rows[0].kind, tenant_key: result.rows[0].tenant_key,
        });

        res.json(result.rows[0]);
    } catch (err) {
        failWith(res, err, 'admin.job_retry_failed', 'Failed to retry the job.');
    }
});

/**
 * Stop a pending job from ever running.
 *
 * `cancelled` is a fifth status rather than a reuse of `failed`, because "this will never run
 * and that was the intention" is genuinely different from "this broke" — and the failed list
 * is the one an operator is meant to work through. Nothing on a hot path can see it: the claim
 * filters `status = 'pending'`, the reaper `status = 'running'`, and the retention sweep
 * `status = 'done'`, so a cancelled row is inert.
 *
 * Only from `pending`. A `running` job is already in somebody's invocation and cancelling the
 * row would not stop the work — it would just lose track of it.
 */
router.post('/jobs/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : null;

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Job not found.' });
            return;
        }

        const result = await pool.query(
            `UPDATE jobs
                SET status = 'cancelled',
                    claimed_at = NULL,
                    last_error = COALESCE($2, '[cancelled by an administrator]'),
                    updated_at = NOW()
              WHERE id = $1 AND status = 'pending'
          RETURNING id, kind, status, attempts, max_attempts, run_after, last_error, tenant_key`,
            [id, reason ? `[cancelled by an administrator] ${reason}` : null]
        );

        if (result.rows.length === 0) {
            const existing = await pool.query('SELECT status FROM jobs WHERE id = $1', [id]);
            if (existing.rows.length === 0) {
                res.status(404).json({ error: 'Job not found.' });
                return;
            }
            res.status(409).json({
                code: 'JOB_NOT_CANCELLABLE',
                error: `That job is "${existing.rows[0].status}", not pending — only a job that has not started can be cancelled.`,
                status: existing.rows[0].status,
            });
            return;
        }

        await audit(req, AUDIT_ACTIONS.jobCancel, 'job', id, {
            kind: result.rows[0].kind, tenant_key: result.rows[0].tenant_key, reason,
        });

        res.json(result.rows[0]);
    } catch (err) {
        failWith(res, err, 'admin.job_cancel_failed', 'Failed to cancel the job.');
    }
});

// ─── Data-subject erasure ───────────────────────────────────────────────────
//
// The only hard DELETE in the product. `/data-deletion` promises it; it was done by hand in
// the SQL editor, which is exactly where the obvious statement clears `messages.text` and
// leaves `raw_payload` holding a verbatim copy of the same text.
//
// Preview is mandatory and enforced by construction: POST accepts a token and nothing else,
// so there is no request body that spells "delete this handle" in one step. See
// src/services/erasure.ts for why the count-drift check also makes a replayed token harmless.

const MAX_HANDLE_LENGTH = 255;

router.get('/erasure/preview', async (req, res) => {
    try {
        const handle = req.query['handle'];
        if (typeof handle !== 'string' || !handle.trim()) {
            res.status(400).json({
                error: 'A handle is required — an Instagram username or the numeric user id (IGSID).'
            });
            return;
        }
        if (handle.trim().length > MAX_HANDLE_LENGTH) {
            res.status(400).json({ error: `A handle cannot be longer than ${MAX_HANDLE_LENGTH} characters.` });
            return;
        }

        // No audit row: this endpoint writes nothing, and that is part of its contract.
        res.json(await previewErasure(handle.trim()));
    } catch (err) {
        failWith(res, err, 'admin.erasure_preview_failed', 'Failed to build the erasure preview.');
    }
});

router.post('/erasure', async (req, res) => {
    try {
        const outcome = await executeErasure(req.body?.token);

        if (!outcome.ok) {
            res.status(outcome.status).json({
                code: outcome.code,
                error: outcome.error,
                expected: outcome.expected,
                actual: outcome.actual,
            });
            return;
        }

        // The audit row goes in on the same connection, inside the same transaction as the
        // deletes. Rows gone with nothing recording who removed them is the one outcome worse
        // than not deleting — so if the ledger write fails, the whole erasure rolls back.
        const actor = await actorFromSession(req.session);
        const recorded = await writeAudit(
            actor,
            {
                action: AUDIT_ACTIONS.erasureExecute,
                targetType: 'data_subject',
                targetId: outcome.handle,
                detail: {
                    deleted: outcome.deleted,
                    matched_usernames: outcome.target.usernames,
                    matched_instagram_user_ids: outcome.target.instagramUserIds,
                    conversation_ids: outcome.target.conversationIds,
                },
            },
            outcome.client
        );

        if (!recorded.written) {
            await rollbackErasure(outcome.client);
            log('error', 'erasure.rolled_back_unaudited', { handle_length: outcome.handle.length });
            res.status(500).json({
                error: 'The erasure could not be recorded in the audit log, so nothing was deleted. '
                    + 'Apply migration v15 (migration_v15_admin.sql) and try again.',
                migrationPending: true,
            });
            return;
        }

        await commitErasure(outcome.client);

        log('warn', 'erasure.executed', {
            audit_id: recorded.id,
            ...outcome.deleted,
        });

        res.json({
            handle: outcome.handle,
            deleted: outcome.deleted,
            auditId: recorded.id,
        });
    } catch (err) {
        failWith(res, err, 'admin.erasure_failed', 'The erasure failed and nothing was deleted.');
    }
});

// ─── Audit ──────────────────────────────────────────────────────────────────

router.get('/audit', async (req, res) => {
    try {
        const limit = clampAuditLimit(req.query['limit']);
        const rawAction = req.query['action'];

        if (rawAction !== undefined && !isAuditAction(rawAction)) {
            res.status(400).json({ error: 'Unknown action filter.' });
            return;
        }

        const listing = await listAudit(limit, typeof rawAction === 'string' ? rawAction : null);
        res.json({ limit, ...listing });
    } catch (err) {
        failWith(res, err, 'admin.audit_list_failed', 'Failed to fetch the audit log.');
    }
});

export default router;
