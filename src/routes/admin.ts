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
import { getPlatformOwnerId, invalidateTenantCache, isTenantRole, TENANT_ROLES } from '../services/tenant.js';
import { getMacBrainTenants, MAX_MAC_BRAIN_TENANTS, saveMacBrainTenants } from '../services/macBrain.js';
import { queryRows } from '../db/query.js';
import { DEFAULT_HOURLY_LIMIT } from '../utils/rateLimiter.js';
import {
    actorFromSession, AUDIT_ACTIONS, clampAuditLimit, isAuditAction, listAudit, writeAudit,
} from '../services/audit.js';
import {
    getAllTenantHealth, getOpsSnapshot, getTenantCounts, getTenantHealth, getTenantMembers,
    isMissingSchema, isMissingTable, MIGRATION_HINT, toIso,
} from '../services/health.js';
import {
    clampLimit, isPageId, isUserRole, lockoutRefusal, passwordProblem,
    readInstagramUsername, readNamedTenant, readPageIdField, readVerifyTokenField, readWebsiteUrl, type FieldUpdate,
} from '../services/adminGuards.js';
import {
    inspectionStatus, recheckTenantToken, type TokenInspection,
} from '../services/tokenHealth.js';
// Moved to the Meta login service (P26): the paste-a-token routes below and the Login flow owe a stored token the same check.
import { pageIdConflict, validateSuppliedToken } from '../services/metaLogin.js';
import {
    commitErasure, executeErasure, previewErasure, rollbackErasure,
} from '../services/erasure.js';
import { sendError } from '../services/errorCodes.js';
import { LegalSignoffError, listSignoffs, parseSignoffInput, recordSignoff, revokeSignoff } from '../services/ads/legalSignoff.js';
import { syncLeadgenSubscription } from '../services/ads/leads.js';
import { APP_SETTING_KEYS, describeGeminiKey, getOnboardingDefaultRules, getPublicBaseUrl, getSetting, normaliseOrigin, setSetting } from '../services/appSettings.js';
import { checkMediaStorage, describeMediaStorage, getMediaUsage } from '../services/storage.js';
import { cleanUpMediaNow, previewMediaCleanup } from '../services/retention.js';
import { storageKeyKind, storageKeyProblem } from '../services/supabaseStorage.js';
import { checkGeminiKey } from '../services/geminiKey.js';
import { dmModelsInUse, starterPersona } from '../services/ai.js';
import { clearProfileCache } from '../services/profile/cache.js';
import { recordEvent } from '../services/onboardingEvents.js';
import { contextFor } from '../services/profile/context.js';
import { defaultProfile } from '../services/profile/defaults.js';
import { patchProfile, readProfileState } from '../services/profile/patch.js';
import { createProfile, ProfileError } from '../services/profile/store.js';
import { withTransaction } from '../services/studio/common.js';
import { needsCeiling, parseCeiling, readCeiling, saveCeiling, setAdsEnabled } from '../services/ads/settings.js';
import { seedApiBrain } from '../services/studio/settings.js';
import { adminAdsRouter } from './adminAds.js';
import { adminExplainersRouter } from './adminExplainers.js';
import aiRouter from './adminAi.js';
import onboardingFunnelRouter from './adminOnboarding.js';
import { profileErrorBody } from './profile.js';
import { adminActor, advanceDraftFor, getDraftFor, guard as draftGuard, startDraftFor } from './onboardingDrafts.js';
import {
    buildInviteUrl, createInvite, InviteError, listInvites, readTtl, regenerateInvite, revokeInvite, shareFor, tenantLanguage,
    type AdminInvite, type CreatedInvite, type InvitePurpose,
} from '../services/invites.js';
import {
    describeOnboardingSettings, getOnboardingSettings, isInviteLang, isInviteRole, saveOnboardingSettings, validateOnboardingPatch,
    type InviteLang, type OnboardingSettings,
} from '../services/onboardingSettings.js';

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
/** Postgres not-null violation: a column the code expects to be nullable (v34) is not, so the migration is pending. */
const PG_NOT_NULL_VIOLATION = '23502';
/** Postgres check violation. `creators_meta_ids_need_token`: a page id with no token. */
const PG_CHECK_VIOLATION = '23514';

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

// ─── Invite links (P17) ─────────────────────────────────────────────────────────────────────────────

/** The origin this request arrived on: `getPublicBaseUrl`'s last resort, after the saved setting and PUBLIC_BASE_URL. */
function requestOrigin(req: Request): string | null {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]!.trim();
    const host = req.headers.host;
    return host ? `${proto}://${host}` : null;
}

/** An invite as the card renders it right after it is made: the listed fields, plus the one link and its message. */
interface ShareableInvite extends AdminInvite {
    /** The link. Carries the token in its fragment, and exists only in the response of the call that made it. */
    url: string;
    whatsapp_text: string;
    lang: InviteLang;
}

function shareable(created: CreatedInvite & { tenantName: string | null }, base: string, lang: InviteLang, settings: OnboardingSettings): ShareableInvite {
    const url = buildInviteUrl(base, created.token, lang);
    return {
        ...created.invite,
        url,
        lang,
        ...shareFor(settings, created.tenantName, url, lang, created.invite.purpose),
    };
}

/** The refusals the invite service throws, as the status and body the dashboard reads; anything else is a 500. */
function answerInviteFailure(res: Response, err: unknown, event: string, message: string): void {
    if (err instanceof InviteError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
        return;
    }
    failWith(res, err, event, message);
}

/** What an audit row says about an invite: ids and facts, never the link. */
function inviteAuditDetail(invite: AdminInvite, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        tenant_id: invite.creator_id,
        purpose: invite.purpose,
        membership_role: invite.role,
        email: invite.email,
        for_user_id: invite.user_id,
        expires_at: invite.expires_at,
        ...extra,
    };
}

/**
 * Make a link for a tenant and record it. Used by the invite route and by creating a tenant by name, which hands the operator
 * the link in the same response. The public base is resolved BEFORE the invite is written, so a deployment that cannot build
 * a link never leaves an invite behind that nobody can ever be given.
 */
async function issueInvite(
    req: Request,
    input: { creatorId: string; purpose?: InvitePurpose; role?: unknown; email?: unknown; userId?: string | null; ttlDays?: number | null; ttlHours?: number | null; lang: InviteLang },
    extra: Record<string, unknown> = {}
): Promise<ShareableInvite> {
    const settings = await getOnboardingSettings();
    const base = await getPublicBaseUrl(requestOrigin(req));
    if (!base) throw new InviteError(500, 'PUBLIC_URL_UNKNOWN', 'The public site address is not set (Settings → TikTok app → site address), so a link cannot be built.');
    const created = await createInvite({
        creatorId: input.creatorId,
        purpose: input.purpose,
        role: isInviteRole(input.role) ? input.role : null,
        email: typeof input.email === 'string' ? input.email : null,
        userId: input.userId ?? null,
        ttlDays: input.ttlDays ?? null,
        ttlHours: input.ttlHours ?? null,
        createdBy: req.session?.userId ?? null,
    }, settings);
    await audit(req, AUDIT_ACTIONS.inviteCreate, 'invite', created.invite.id, inviteAuditDetail(created.invite, { language: input.lang, ...extra }));
    // The funnel's first stage (P31). A password reset is not onboarding, so only a join link counts.
    if (input.purpose !== 'reset') await recordEvent({ creatorId: input.creatorId, userId: req.session?.userId ?? null, actor: 'admin' }, 'invite_created');
    return shareable(created, base, input.lang, settings);
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

// ─── AI providers (P20c) ────────────────────────────────────────────────────

/**
 * Keys, routes, prices and budgets for the AI providers layer, and the checks and usage beside them (src/routes/adminAi.ts). Mounted
 * below the platform-admin gate; the sub-router checks the role again.
 */
router.use('/ai', aiRouter);

// ─── Onboarding funnel (P31) ────────────────────────────────────────────────

/** The funnel from invite to a finished setup, for Operations (src/routes/adminOnboarding.ts). Counts and durations only. */
router.use('/onboarding', onboardingFunnelRouter);
// The Ads overview (A11). The per-tenant switch, ceiling and sign-off routes below it fall through this router.
router.use('/ads', adminAdsRouter);
// Illustrated explainers' image provider, switch and test (v59, E2). Gated again inside.
router.use('/explainers', adminExplainersRouter);

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

/**
 * "Delete files once posted" (`storage.cleanup_after_publish`, src/services/retention.ts): the
 * switch, and what a clean-up would remove now.
 */
router.get('/media-storage/cleanup', async (_req, res) => {
    try {
        const [on, preview] = await Promise.all([getSetting(APP_SETTING_KEYS.mediaCleanup), previewMediaCleanup()]);
        res.json({ on: on === 'true', preview });
    } catch (err) {
        failWith(res, err, 'admin.media_cleanup_read_failed', 'Failed to read the clean-up settings.');
    }
});

router.put('/media-storage/cleanup', async (req, res) => {
    try {
        if (typeof req.body?.on !== 'boolean') {
            res.status(400).json({ error: 'Send { on: true } or { on: false }.' });
            return;
        }
        await setSetting(APP_SETTING_KEYS.mediaCleanup, req.body.on ? 'true' : null, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.settingsMediaCleanup, 'app', null, { change: req.body.on ? 'on' : 'off' });
        res.json({ on: req.body.on, preview: await previewMediaCleanup() });
    } catch (err) {
        failWith(res, err, 'admin.media_cleanup_save_failed', 'Failed to save the clean-up setting.');
    }
});

/** "Clean up now": the same rule, at once. Irreversible, so only on this explicit request. */
router.post('/media-storage/cleanup', async (req, res) => {
    try {
        const out = await cleanUpMediaNow();
        await audit(req, AUDIT_ACTIONS.settingsMediaCleanup, 'app', null, { change: 'cleaned', files: out.files, bytes: out.bytes });
        res.json({ ...out, preview: await previewMediaCleanup() });
    } catch (err) {
        failWith(res, err, 'admin.media_cleanup_failed', 'The clean-up failed.');
    }
});

// ─── The Mac brain ──────────────────────────────────────────────────────────

/**
 * Who may use the operator's Mac (G1, src/services/macBrain.ts): the creators whose `monteur_think` and
 * infographic-`write` work runs there, on his personal Claude plan. Anthropic's terms forbid routing anyone
 * else's work through it, so the server refuses everyone else with a 409 `NEEDS_API_BRAIN`.
 *
 * The owner (`platform_tenant`: the first creator ever made, active or not) is always allowed and cannot be
 * removed; the saved list (`extra_tenants`) adds tenants. Nothing saved, `null` and `[]` all mean the owner only.
 */
async function describeMacBrain() {
    const [{ extra, source }, owner] = await Promise.all([getMacBrainTenants(), getPlatformOwnerId()]);
    const ownerId = owner ? owner.toLowerCase() : null;
    const ids = [...new Set([...extra, ...(ownerId ? [ownerId] : [])])];
    const rows = ids.length
        ? await queryRows<{ id: string; name: string | null }>('SELECT id, name FROM creators WHERE id = ANY($1::uuid[])', [ids])
        : [];
    const nameOf = (id: string): string | null => rows.find((r) => r.id.toLowerCase() === id)?.name ?? null;
    return {
        source,
        platform_tenant: ownerId ? { id: ownerId, name: nameOf(ownerId) } : null,
        extra_tenants: extra.map((id) => ({ id, name: nameOf(id) })),
    };
}

router.get('/mac-brain-tenants', async (_req, res) => {
    try {
        res.json(await describeMacBrain());
    } catch (err) {
        failWith(res, err, 'admin.mac_brain_read_failed', 'Failed to read the Mac brain tenants.');
    }
});

/**
 * `{ tenants: ["<creator id>", …] }` saves the tenants allowed besides the owner (`[]` is none: the owner
 * only); `{ tenants: null }` forgets the saved list, with the same effect. Every id must be a creator that
 * exists: a typo would otherwise add nobody, silently.
 */
router.put('/mac-brain-tenants', async (req, res) => {
    const raw = (req.body ?? {}).tenants;
    if (raw !== null && (!Array.isArray(raw) || raw.length > MAX_MAC_BRAIN_TENANTS || !raw.every(isUuid))) {
        res.status(400).json({
            error: `Send { "tenants": ["<creator id>", …] } (at most ${MAX_MAC_BRAIN_TENANTS}), or { "tenants": null } to go back to the owner alone.`,
        });
        return;
    }
    try {
        const ids = raw === null ? null : [...new Set((raw as string[]).map((id) => id.toLowerCase()))];
        if (ids && ids.length) {
            const known = await queryRows<{ id: string }>('SELECT id FROM creators WHERE id = ANY($1::uuid[])', [ids]);
            const missing = ids.filter((id) => !known.some((k) => k.id.toLowerCase() === id));
            if (missing.length) {
                res.status(404).json({ error: `No such tenant: ${missing.join(', ')}.` });
                return;
            }
        }
        const before = await getMacBrainTenants();
        const after = await saveMacBrainTenants(ids, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.settingsMacBrainWrite, 'app', null, {
            change: ids === null ? 'reset' : 'saved',
            extra_tenants: after.extra,
            previous_extra_tenants: before.extra,
            previous_source: before.source,
        });
        res.json(await describeMacBrain());
    } catch (err) {
        failWith(res, err, 'admin.mac_brain_save_failed', 'Failed to save the Mac brain tenants.');
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
 * Create a tenant.
 *
 * Two shapes of body, told apart by whether it carries a Meta connection:
 *
 *   - **By name** (v34): `{ name, lang?, instagram_username?, website? }`. No Meta ids, no token, no password: the tenant
 *     connects Meta later and an operator-made tenant is `invited` until its wizard is done (docs/onboarding/02). This is
 *     what the Tenants screen sends.
 *   - **With credentials** (the first-run path, and the legacy body): `instagram_page_id` and `page_access_token` are both
 *     required, the token is checked against Meta and then encrypted here, so a tenant created through this endpoint never
 *     has a plaintext or unverified token in the database at any point.
 *
 * Either way a new tenant gets, in ONE transaction with its `creators` row:
 *
 *   - a stored Creator Profile, version 1: `defaultProfile({ lang, rules })`, the neutral one, with `onboarding.default_rules`
 *     pre-ticked (D9). Without it the tenant is described by its legacy settings, and a tenant with none is described as the
 *     owner (his role, domain, pronouns: `profileFromLegacy`); it has to exist before anything reads the tenant (P16, plan §4b);
 *   - for an Arabic tenant, the Studio's text direction `rtl` (not a profile field, so it is seeded into `studio_settings`);
 *   - `monteur.brain: 'api'` in its Studio settings (P32): its Monteur thinks through the AI providers layer on the operator's key, never on
 *     the owner's Mac and never on Gemini. The owner's row, and every row that exists, keep the brain they have;
 *   - an `onboarding` row, `invited`. A tenant with no row reads as completed (D14), which a new tenant is not.
 *
 * Nothing is created if any of it fails: a tenant is never left without its profile. The starter DM persona follows, in the
 * tenant's language, and is best-effort as it always was.
 */
router.post('/tenants', async (req, res) => {
    try {
        const body = req.body ?? {};
        const { name, instagram_page_id, facebook_page_id, page_access_token, webhook_verify_token } = body;

        const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';
        const withCredentials = present(instagram_page_id) || present(facebook_page_id) || present(page_access_token);

        // By name, the body is read whole. With credentials the legacy body is as it always was (its name is optional, and Arabic
        // is its language), and what is new on it is read the same way: the language, and the handle and site if it carries them.
        const named = readNamedTenant(body);
        if (!withCredentials && !named.ok) {
            res.status(400).json({
                error: named.error + (present(name)
                    ? '' : ' (To create a tenant that already has a Meta connection, send instagram_page_id and page_access_token instead.)'),
            });
            return;
        }
        const rawLang = body.lang;
        if (withCredentials && present(rawLang) && rawLang !== 'ar' && rawLang !== 'en') {
            res.status(400).json({ error: 'lang must be "ar" or "en".' });
            return;
        }
        const lang: 'ar' | 'en' = rawLang === 'en' ? 'en' : 'ar';
        const handle = readInstagramUsername(body.instagram_username);
        const site = readWebsiteUrl(body.website !== undefined ? body.website : body.website_url);
        if (!handle.ok || !site.ok) {
            res.status(400).json({ error: (!handle.ok ? handle : site as { error: string }).error });
            return;
        }

        let igPageId: string | null = null;
        let fbPageId: string | null = null;
        let encrypted: string | null = null;
        let verifyValue: string | null = null;
        let checked: Extract<Awaited<ReturnType<typeof validateSuppliedToken>>, { ok: true }> | null = null;

        if (withCredentials) {
            if (typeof instagram_page_id !== 'string' || !instagram_page_id.trim()) {
                res.status(400).json({ error: 'instagram_page_id is required.' });
                return;
            }
            igPageId = instagram_page_id.trim();
            if (!isPageId(igPageId)) {
                res.status(400).json({ error: `instagram_page_id is not a valid Meta page id.` });
                return;
            }
            if (typeof page_access_token !== 'string' || !page_access_token.trim()) {
                res.status(400).json({ error: 'page_access_token is required.' });
                return;
            }

            fbPageId = typeof facebook_page_id === 'string' && facebook_page_id.trim()
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
            verifyValue = verify.kind === 'set' ? verify.value : null;

            // Checked before anything is written, so a rejected token leaves no half-made tenant.
            const validated = await validateSuppliedToken(page_access_token.trim());
            if (!validated.ok) {
                res.status(400).json({ error: validated.error });
                return;
            }
            checked = validated;

            try {
                encrypted = encryptSecret(page_access_token.trim());
            } catch (keyErr) {
                log('error', 'admin.tenant_encryption_failed', describeError(keyErr));
                res.status(500).json({
                    error: 'TOKEN_ENCRYPTION_KEY is not configured. Generate one with `openssl rand -hex 32` and set it before creating a tenant.'
                });
                return;
            }
        }

        const tenantName = withCredentials
            ? (typeof name === 'string' && name.trim() ? name.trim() : null)
            : (named.ok ? named.value.name : null);
        // The handle and site the operator typed, if any: the draft's inputs (P24), kept whether or not a Meta connection came with them.
        const instagramUsername = handle.value;
        const websiteUrl = site.value;

        // Read before the transaction opens: a setting that cannot be read fails the create, rather than a tenant being stored
        // without the rule it was meant to have.
        const rules = await getOnboardingDefaultRules();
        const profile = defaultProfile({ lang, rules });

        const created = await withTransaction(async (tx) => {
            const result = await tx.query(
                `INSERT INTO creators
                    (name, instagram_page_id, facebook_page_id, page_access_token, webhook_verify_token,
                     is_active, token_status, token_error, token_last_checked_at,
                     token_expires_at, token_data_access_expires_at, instagram_username, website_url)
                 VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, $11, $12)
                 RETURNING id, name, instagram_page_id, facebook_page_id, instagram_username, website_url, is_active, token_status, created_at`,
                [
                    tenantName,
                    igPageId,
                    fbPageId,
                    encrypted,
                    verifyValue,
                    // A tenant that has never been connected has nothing to be "valid" or "invalid": it keeps the column's own `unknown`.
                    checked ? inspectionStatus(checked.inspection) : 'unknown',
                    checked ? checked.inspection.error : null,
                    checked ? new Date() : null,
                    checked ? checked.inspection.expiresAt : null,
                    checked ? checked.inspection.dataAccessExpiresAt : null,
                    instagramUsername,
                    websiteUrl,
                ]
            );
            const row = result.rows[0];
            // The profile, its history and the mirror into the Studio and Growth settings, then where the tenant is in the wizard.
            // `rtl` is the Studio's own setting (`brand.direction` is not derived from the language), so Arabic seeds it here.
            await createProfile(row.id, profile, { source: 'admin', userId: req.session?.userId ?? null, direction: lang === 'ar' ? 'rtl' : undefined }, tx);
            // The Monteur's brain is the AI providers layer (P32): the Mac is the owner's, and a new tenant is never put on it.
            await seedApiBrain(tx, row.id);
            await tx.query(
                `INSERT INTO onboarding (creator_id, status) VALUES ($1, 'invited') ON CONFLICT (creator_id) DO NOTHING`,
                [row.id]
            );
            return row;
        });
        // `createProfile` cleared it before the commit; a reader that ran in between could have cached the old answer.
        clearProfileCache(created.id);

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
            // In the language the new tenant's DMs will speak: the one its stored profile says (`dm` surface), which is the
            // language it was created in. Not read back from the database: the profile above is what was just stored.
            const { language } = contextFor(profile, 'dm', 1);
            await pool.query(
                `INSERT INTO ai_agents (creator_id, is_active, system_prompt, knowledge_base)
                 VALUES ($1, false, $2, '')
                 ON CONFLICT (creator_id) DO NOTHING`,
                [created.id, starterPersona(language.code)]
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
            credential_replaced: checked !== null,
            credential_type: checked?.inspection.type ?? null,
            missing_scopes: checked?.inspection.missingScopes ?? [],
            // Facts about how it was made. The handle and the site are public; the profile is the default, not what was typed.
            created_by_name: !withCredentials,
            language: lang,
            profile_version: 1,
            instagram_username: created.instagram_username,
            website_url: created.website_url,
        });

        // A tenant made by name is handed to a person who is not here yet: the invite link comes back with it, so the success
        // card can show Copy and WhatsApp at once. Best-effort, like the starter agent: the tenant exists whether or not the
        // link could be made, and "Create invite link" on its page makes one later. A tenant made WITH credentials is the
        // operator's own (the first run) and has nobody to invite.
        let invite: ShareableInvite | null = null;
        if (!withCredentials) {
            try {
                invite = await issueInvite(req, { creatorId: created.id, lang }, { via: 'tenant_create' });
            } catch (inviteErr) {
                log('warn', 'admin.tenant_invite_failed', { creator_id: created.id, ...describeError(inviteErr) });
            }
        }

        res.status(201).json({
            ...created,
            language: lang,
            // Whether Meta is connected: the Tenants screen says "not connected yet" for a tenant that is not.
            meta_connected: checked !== null,
            profile: { version: 1 },
            onboarding: { status: 'invited' },
            invite,
        });
    } catch (err: any) {
        if (err?.code === PG_UNIQUE_VIOLATION) {
            res.status(409).json({ error: 'A creator with that page id already exists.' });
            return;
        }
        // The profile's own refusals (the tables are missing, the default failed validation): its status and sentence.
        if (err instanceof ProfileError) {
            res.status(err.status).json({ error: err.message, code: err.code });
            return;
        }
        // A tenant with no Meta ids needs migration v34: before it, those columns are NOT NULL.
        if (err?.code === PG_NOT_NULL_VIOLATION) {
            res.status(500).json({
                error: 'The database is missing migration v34 (src/config/migration_v34_onboarding.sql). Apply it with `npm run migrate`, then try again.',
                migrationPending: true,
            });
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
        // A page id on a tenant with no Meta token (created by name, v34): the database keeps the two together, so say what to send.
        if (err?.code === PG_CHECK_VIOLATION && String(err?.constraint ?? err?.message).includes('creators_meta_ids_need_token')) {
            res.status(400).json({
                code: 'TOKEN_REQUIRED',
                error: 'This tenant has no Meta connection yet: send page_access_token together with the page id, so the two are saved at once.',
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

// ─── Invites ────────────────────────────────────────────────────────────────

/**
 * Make a link for a tenant: `join` (a new person: `email` optional, the role from the body or the setting) or `reset` (a
 * member who lost their password: `user_id`). The answer carries the link ONCE, in `invite.url`; the token is never stored,
 * so no later call can show it again (Regenerate makes a new one). The tenant is the one in the PATH: nothing in the body can
 * point a link at another.
 */
router.post('/tenants/:id/invites', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id)) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }
        const body = req.body ?? {};

        const purpose = body.purpose === undefined || body.purpose === null ? 'join' : body.purpose;
        if (purpose !== 'join' && purpose !== 'reset') {
            res.status(400).json({ error: "purpose must be 'join' or 'reset'." });
            return;
        }
        if (body.role !== undefined && body.role !== null && !isInviteRole(body.role)) {
            res.status(400).json({ error: "role must be 'owner', 'operator' or 'viewer'." });
            return;
        }
        // Absent: the language the tenant writes in (its profile's), so the operator who never touches the picker gets the right one.
        const requestedLang = body.lang === undefined || body.lang === null || body.lang === '' ? null : body.lang;
        if (requestedLang !== null && !isInviteLang(requestedLang)) {
            res.status(400).json({ error: 'lang must be "ar" or "en".' });
            return;
        }
        const days = readTtl(body.ttl_days, 'days');
        const hours = readTtl(body.ttl_hours, 'hours');
        if (!days.ok || !hours.ok) {
            res.status(400).json({ error: (!days.ok ? days : hours as { error: string }).error });
            return;
        }
        if (purpose === 'reset' && !isUuid(body.user_id)) {
            res.status(400).json({ error: 'A reset link needs user_id: the account whose password it replaces.' });
            return;
        }

        const invite = await issueInvite(req, {
            creatorId: id, purpose, role: body.role, email: body.email, userId: purpose === 'reset' ? body.user_id : null,
            ttlDays: days.value, ttlHours: hours.value, lang: requestedLang ?? await tenantLanguage(id),
        });
        res.status(201).json({ invite });
    } catch (err) {
        answerInviteFailure(res, err, 'admin.invite_create_failed', 'Failed to create the invite.');
    }
});

/** A tenant's newest invites, without their links: the card's "Opened 2h ago", "Expires in 5 days". */
router.get('/tenants/:id/invites', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id)) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }
        const exists = await queryRows<{ id: string }>('SELECT id FROM creators WHERE id = $1', [id]);
        if (exists.length === 0) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }
        res.json({ invites: await listInvites(id) });
    } catch (err) {
        failWith(res, err, 'admin.invites_list_failed', 'Failed to list invites.');
    }
});

// ─── Ads legal sign-off (Ads Manager A8, v56) ───────────────────────────────────────────────────────────────────────

/**
 * The platform admin's record that a legal opinion covers customer lists or lead ads for some countries (Egypt PDPL 151/2020,
 * Saudi PDPL). Until a non-revoked row exists the tenant's capability stays locked (`services/ads/legalSignoff.ts`). The tenant
 * is the one in the PATH; the body cannot name another. Audited with the scope, countries and ids, never the note's text.
 */
async function adsTenantExists(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    return (await queryRows<{ id: string }>('SELECT id FROM creators WHERE id = $1', [id])).length > 0;
}

/** `{ error, code: 'INVALID', field }` for a refused sign-off body. */
function answerSignoffRefusal(res: Response, err: LegalSignoffError): void {
    res.status(400).json({ error: err.message, code: err.code, field: err.field });
}

router.get('/ads/tenants/:id/legal-signoff', async (req, res) => {
    try {
        const { id } = req.params as { id: string };
        if (!(await adsTenantExists(id))) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }
        res.json({ signoffs: await listSignoffs(id, { includeRevoked: true }) });
    } catch (err) {
        failWith(res, err, 'admin.ads_signoff_list_failed', 'Failed to list the legal sign-offs.');
    }
});

router.post('/ads/tenants/:id/legal-signoff', async (req, res) => {
    try {
        const { id } = req.params as { id: string };
        if (!(await adsTenantExists(id))) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }
        let input;
        try {
            input = parseSignoffInput(req.body);
        } catch (err) {
            if (err instanceof LegalSignoffError) {
                answerSignoffRefusal(res, err);
                return;
            }
            throw err;
        }
        const signoff = await recordSignoff(id, input, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.adsLegalSignoff, 'creator', id, {
            change: 'recorded', signoff_id: signoff.id, scope: signoff.scope, countries: signoff.countries,
        });
        // Lead ads (A10): the Page starts hearing `leadgen` now, not at the next 6-hourly catch-up.
        if (signoff.scope === 'lead_ads') await syncLeadgenQuietly(id);
        res.status(201).json({ signoff });
    } catch (err) {
        failWith(res, err, 'admin.ads_signoff_record_failed', 'Failed to record the legal sign-off.');
    }
});

/** `syncLeadgenSubscription`, never failing the admin's request: a Page that cannot be reached converges at the next lead catch-up. */
async function syncLeadgenQuietly(creatorId: string): Promise<void> {
    try {
        await syncLeadgenSubscription(creatorId);
    } catch (err) {
        log('warn', 'admin.leadgen_subscription_failed', { creator_id: creatorId, ...describeError(err) });
    }
}

router.delete('/ads/tenants/:id/legal-signoff/:sid', async (req, res) => {
    try {
        const { id, sid } = req.params as { id: string; sid: string };
        if (!(await adsTenantExists(id))) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }
        const revoked = await revokeSignoff(id, sid);
        if (revoked) {
            await audit(req, AUDIT_ACTIONS.adsLegalSignoff, 'creator', id, { change: 'revoked', signoff_id: sid });
            // The scope of a revoked row is not at hand, and re-subscribing is idempotent: the Page keeps `leadgen` only while a lead_ads
            // sign-off is still active, so a lead_ads revocation stops the notifications at once (A10).
            await syncLeadgenQuietly(id);
        }
        res.json({ revoked });
    } catch (err) {
        failWith(res, err, 'admin.ads_signoff_revoke_failed', 'Failed to revoke the legal sign-off.');
    }
});

// ─── Profile drafts (P24) ───────────────────────────────────────────────────────────────────────────

/**
 * A tenant's profile draft, from the operator's side (docs/onboarding/03 §4). The tenant has its own routes (`/api/onboarding/draft`),
 * below `resolveTenant`; they cannot serve an admin, whose session resolves to the admin's own tenant. These take the tenant from
 * the PATH. Handlers and rules are shared (`routes/onboardingDrafts.ts`); what differs is that nothing here is gated on the tenant's
 * onboarding (a re-draft after it is done is the operator's call) and that the answer carries the provider's message, the steps and the cost.
 */
const noTenant = { status: 404, body: { error: 'Tenant not found.' } };

router.get('/tenants/:id/draft', draftGuard('admin.draft_read_failed', 'Failed to read the draft.', async (req) =>
    (isUuid(req.params.id) ? getDraftFor(req.params.id, adminActor(req)) : noTenant)));

/** `{ instagram?, website?, youtube?, about?, force? }`; what is not sent comes from the handle and site typed at creation. */
router.post('/tenants/:id/draft', draftGuard('admin.draft_start_failed', 'Failed to start the draft.', async (req) =>
    (isUuid(req.params.id) ? startDraftFor(req.params.id, req.body, adminActor(req)) : noTenant)));

/** What the Tenants screen fires, un-awaited, right after creating a tenant: it starts the draft when there is none (D6). */
router.post('/tenants/:id/draft/advance', draftGuard('admin.draft_advance_failed', 'Failed to advance the draft.', async (req) =>
    (isUuid(req.params.id) ? advanceDraftFor(req.params.id, req.body, adminActor(req), true) : { ...noTenant, draftId: null }), { advance: true }));

/** Replace a link with a new one for the same person: the old one stops working in the same step. */
router.post('/invites/:id/regenerate', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id)) {
            res.status(404).json({ error: 'Invite not found.' });
            return;
        }
        const requested = (req.body ?? {}).lang;
        const requestedLang = requested === undefined || requested === null || requested === '' ? null : requested;
        if (requestedLang !== null && !isInviteLang(requestedLang)) {
            res.status(400).json({ error: 'lang must be "ar" or "en".' });
            return;
        }
        const settings = await getOnboardingSettings();
        const base = await getPublicBaseUrl(requestOrigin(req));
        if (!base) {
            res.status(500).json({ error: 'The public site address is not set (Settings → TikTok app → site address), so a link cannot be built.', code: 'PUBLIC_URL_UNKNOWN' });
            return;
        }
        const regenerated = await regenerateInvite(id, req.session?.userId ?? null, settings);
        const lang = requestedLang ?? await tenantLanguage(regenerated.invite.creator_id);
        await audit(req, AUDIT_ACTIONS.inviteRegenerate, 'invite', regenerated.invite.id, inviteAuditDetail(regenerated.invite, {
            previous_invite_id: regenerated.previousId, language: lang,
        }));
        if (regenerated.invite.purpose === 'join') {
            await recordEvent({ creatorId: regenerated.invite.creator_id, userId: req.session?.userId ?? null, actor: 'admin' }, 'invite_created');
        }
        res.status(201).json({ invite: shareable(regenerated, base, lang, settings), previous_invite_id: regenerated.previousId });
    } catch (err) {
        answerInviteFailure(res, err, 'admin.invite_regenerate_failed', 'Failed to regenerate the invite.');
    }
});

/** Revoke a link: it stops working at once. One that was already used cannot be: the person is in. */
router.delete('/invites/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id)) {
            res.status(404).json({ error: 'Invite not found.' });
            return;
        }
        const outcome = await revokeInvite(id);
        if (outcome.changed) {
            await audit(req, AUDIT_ACTIONS.inviteRevoke, 'invite', outcome.id, { tenant_id: outcome.creatorId, purpose: outcome.purpose });
        }
        res.json({ revoked: true, already_revoked: !outcome.changed, id: outcome.id });
    } catch (err) {
        answerInviteFailure(res, err, 'admin.invite_revoke_failed', 'Failed to revoke the invite.');
    }
});

// ─── Onboarding settings ────────────────────────────────────────────────────

router.get('/onboarding-settings', async (_req, res) => {
    try {
        res.json(await describeOnboardingSettings());
    } catch (err) {
        failWith(res, err, 'admin.onboarding_settings_read_failed', 'Failed to read the onboarding settings.');
    }
});

/**
 * Each field is optional: absent leaves it alone, `null` or an empty string returns it to its default. Everything is checked
 * before anything is written, so a refused value never leaves the others half saved; a 400 names the `field` to mark.
 */
router.put('/onboarding-settings', async (req, res) => {
    try {
        const patch = validateOnboardingPatch(req.body ?? {});
        if (!patch.ok) {
            res.status(400).json({ error: patch.error, field: patch.field });
            return;
        }
        if (patch.writes.length === 0) {
            res.status(400).json({ error: 'Nothing to save.' });
            return;
        }
        // The tenant that reads other people's Instagram has to exist: a typo here would send every draft's Instagram read to "not configured".
        const discovery = patch.writes.find((w) => w.field === 'discoveryCreatorId' && w.value !== null);
        if (discovery && (await queryRows<{ id: string }>('SELECT id FROM creators WHERE id = $1', [discovery.value])).length === 0) {
            res.status(400).json({ error: 'discoveryCreatorId is not a tenant.', field: 'discoveryCreatorId' });
            return;
        }
        await saveOnboardingSettings(patch.writes, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.settingsOnboardingWrite, 'app', null, {
            changed: patch.writes.filter((w) => w.value !== null).map((w) => w.field),
            reset_to_default: patch.writes.filter((w) => w.value === null).map((w) => w.field),
        });
        res.json(await describeOnboardingSettings());
    } catch (err) {
        failWith(res, err, 'admin.onboarding_settings_write_failed', 'Failed to save the onboarding settings.');
    }
});

// ─── A tenant's Creator Profile, filled in on their behalf (P19) ─────────────

/**
 * Where a tenant is in the wizard, for the admin's Profile section: `{ status, filledBy }`. A tenant with no row, and a
 * database that has not had v34 applied, read as completed (D14): the wizard's gates are for tenants made after it.
 */
async function readOnboardingState(creatorId: string): Promise<{ status: string; filledBy: string | null }> {
    try {
        const { rows } = await pool.query<{ status: string; filled_by: string | null }>(
            'SELECT status, filled_by FROM onboarding WHERE creator_id = $1', [creatorId]
        );
        return rows[0] ? { status: rows[0].status, filledBy: rows[0].filled_by } : { status: 'completed', filledBy: null };
    } catch (err) {
        if (isMissingTable(err, 'onboarding')) return { status: 'completed', filledBy: null };
        throw err;
    }
}

/** What both profile routes answer: the profile with its version (`readProfileState`), whether the tenant is the platform owner (his `no_women_imagery` rule is locked), and the onboarding state. */
async function profileAnswer(creatorId: string, state?: Awaited<ReturnType<typeof readProfileState>>): Promise<Record<string, unknown>> {
    const [profile, owner, onboarding] = await Promise.all([
        state ?? readProfileState(creatorId),
        getPlatformOwnerId(),
        readOnboardingState(creatorId),
    ]);
    return { ...profile, isPlatformOwner: owner !== null && owner.toLowerCase() === creatorId, onboarding };
}

/** The tenant a route's `:id` names, lower-cased, or null: not a uuid (never sent to the database), or no such tenant. */
async function knownTenantId(raw: unknown): Promise<string | null> {
    if (!isUuid(raw)) return null;
    const id = raw.toLowerCase();
    const { rows } = await pool.query('SELECT id FROM creators WHERE id = $1', [id]);
    return rows.length > 0 ? id : null;
}

/**
 * `GET /api/admin/tenants/:id/profile`: the tenant's profile and the version a PATCH must send back (`version` is null, and
 * `stored` false, for a tenant whose profile is still the virtual one its settings describe).
 */
router.get('/tenants/:id/profile', async (req, res) => {
    try {
        const id = await knownTenantId(req.params.id);
        if (!id) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }
        res.json(await profileAnswer(id));
    } catch (err) {
        if (err instanceof ProfileError) {
            res.status(err.status).json(profileErrorBody(err));
            return;
        }
        failWith(res, err, 'admin.tenant_profile_read_failed', 'Failed to read the profile.');
    }
});

/**
 * `PATCH /api/admin/tenants/:id/profile { version, patch, confirm_remove_owner_rule? }`: the admin fills in the profile for the
 * tenant. It is `patchProfile`, the very function `PATCH /api/profile` is, so the merge (an object merges, a list is replaced,
 * `null` removes from the maps keyed by name), the validation, the optimistic version lock (409 `PROFILE_VERSION_CONFLICT`
 * with `currentVersion`, before anything is merged) and the owner's locked `no_women_imagery` rule (409 `OWNER_RULE_LOCKED`) are
 * the same, and the answer is the same as GET's, for the profile as it now is. What is different is who it says wrote it:
 *
 *   - the history row's source is `admin`;
 *   - the audit entry is `profile.write` with `{ paths, version, on_behalf: true }`: the sections that changed, never a value;
 *   - while the tenant's onboarding is not completed, `onboarding.filled_by` becomes `admin`, in the save's own transaction, so
 *     the wizard can tell the tenant "your admin prepared this: check it" (docs/onboarding/02), and a profile never changes
 *     without it.
 *
 * A patch that changes nothing writes nothing: no version, no history, no audit, and `filled_by` stays.
 */
router.patch('/tenants/:id/profile', async (req, res) => {
    try {
        const id = await knownTenantId(req.params.id);
        if (!id) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }

        const { changed, ...state } = await patchProfile(id, req.body, {
            userId: req.session?.userId ?? null,
            source: 'admin',
            onSaved: async (tx) => {
                await tx.query(`UPDATE onboarding SET filled_by = 'admin' WHERE creator_id = $1 AND status <> 'completed'`, [id]);
            },
        });
        if (changed.length > 0) {
            // Section names only: what the profile says is never written to the audit trail.
            await audit(req, AUDIT_ACTIONS.profileWrite, 'creator', id, { paths: changed, version: state.version, on_behalf: true });
        }
        res.json(await profileAnswer(id, state));
    } catch (err) {
        if (err instanceof ProfileError) {
            res.status(err.status).json(profileErrorBody(err));
            return;
        }
        failWith(res, err, 'admin.tenant_profile_write_failed', 'Failed to save the profile.');
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
            sendError(res, 409, 'JOB_NOT_RETRYABLE', { status: existing.rows[0].status },
                `That job is "${existing.rows[0].status}", not failed or cancelled — only a job that has stopped can be retried.`,
                { status: existing.rows[0].status });
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
            sendError(res, 409, 'JOB_NOT_CANCELLABLE', { status: existing.rows[0].status },
                `That job is "${existing.rows[0].status}", not pending — only a job that has not started can be cancelled.`,
                { status: existing.rows[0].status });
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
            // `expected` and `actual` stay top-level fields: they are the counts a person compares after a drift.
            sendError(res, outcome.status, outcome.code, {}, outcome.error, { expected: outcome.expected, actual: outcome.actual });
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
                    // The contact's private uploads (customer files) deleted with them: not part of `deleted`, which is what the preview counted.
                    media_deleted: outcome.mediaDeleted ?? 0,
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
            sendError(res, 500, 'ERASURE_AUDIT_FAILED', {},
                'The erasure could not be recorded in the audit log, so nothing was deleted. '
                    + 'Apply migration v15 (migration_v15_admin.sql) and try again.',
                { migrationPending: true });
            return;
        }

        await commitErasure(outcome.client);

        log('warn', 'erasure.executed', {
            audit_id: recorded.id,
            ...outcome.deleted,
            media_deleted: outcome.mediaDeleted ?? 0,
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


// ─── Ads Manager: the per-tenant switch and the ceiling (src/services/ads/settings.ts) ──────────────────────────

async function tenantExists(id: string): Promise<boolean> {
    return (await queryRows<{ id: string }>('SELECT id FROM creators WHERE id = $1', [id])).length > 0;
}

/**
 * Switch the Ads Manager on or off for a tenant (`ads.enabled.<tenant>`). Off, every /api/ads route answers 404 ADS_DISABLED and the guard
 * and the health check skip the tenant. A managed client cannot be switched on before it has a ceiling: no client may ever set limits
 * with nothing above them. The platform owner's own tenant needs none.
 */
router.post('/ads/tenants/:id/enabled', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id) || !(await tenantExists(id))) {
            res.status(404).json({ error: 'Tenant not found.', code: 'NOT_FOUND' });
            return;
        }
        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean') {
            res.status(400).json({ error: 'enabled is true or false.', code: 'INVALID', field: 'enabled' });
            return;
        }
        if (enabled && (await needsCeiling(id)) && !(await readCeiling(id))) {
            res.status(409).json({ error: 'Set this tenant\'s ads ceiling (max daily budget and monthly cap) before switching ads on.', code: 'CEILING_REQUIRED' });
            return;
        }
        await setAdsEnabled(id, enabled, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.adsEnabledChanged, 'creator', id, { enabled });
        res.json({ enabled });
    } catch (err) {
        failWith(res, err, 'admin.ads_enabled_failed', 'Failed to change the ads switch.');
    }
});

/** A tenant's ceiling: the most its owner may set as the max daily budget and the monthly cap. */
router.post('/ads/tenants/:id/ceiling', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id) || !(await tenantExists(id))) {
            res.status(404).json({ error: 'Tenant not found.', code: 'NOT_FOUND' });
            return;
        }
        const ceiling = parseCeiling(req.body);
        if (!ceiling) {
            res.status(400).json({ error: 'Give a max daily budget and a monthly cap above 0 (the daily one not above the monthly one).', code: 'INVALID', field: 'maxDailyBudget' });
            return;
        }
        await saveCeiling(id, ceiling, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.adsCeilingChanged, 'creator', id, { ...ceiling });
        res.json({ ceiling });
    } catch (err) {
        failWith(res, err, 'admin.ads_ceiling_failed', 'Failed to save the ads ceiling.');
    }
});

export default router;
