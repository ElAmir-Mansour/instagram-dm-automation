/**
 * The Ads Manager under `/api/ads` (contracts in docs/specs/002-meta-ads-manager, local; src/services/ads/README.md). Mounted BELOW
 * `resolveTenant` in api.ts, so every route acts as the session's tenant.
 *
 *   GET    /settings               the Settings card: steps, token { set, last4, source, expiresAt, health }, the stored account, limits,
 *                                  ceiling, alert recipients, spending limit, switches. Stored data only
 *   POST   /settings               any of { adAccountId, token, maxDailyBudget, monthlyCap, businessId, defaultCountries, leadRetentionDays }
 *                                  → the same, plus `warnings: ['will_pause_all']` when the new cap is at or below this month's spend
 *   POST   /settings/test          the token's scopes and assets, the tier and served version (live, 1–2 points), stored for the card
 *   POST   /settings/alerts        { telegramChatId?, email?, lang?, kinds?, test? } → { alerts, test? }
 *   POST   /spend-cap              { amount | null, confirm: true } → { op, spendCap, verified }: Meta's account spending limit
 *   GET    /accounts               { accounts }: the ad accounts the token reached at the last test (stored)
 *   GET    /money                  ?candidate=daily|lifetime:<amount>:<days> → { fits, remaining, worstCase, ... }: THE money rule
 *   GET    /overview               the Ads screen; `{ configured: false, steps }` for a tenant that is not set up yet
 *   GET    /boosts, /eligibility   Boost (v1 shapes)
 *   POST   /boosts                 create PAUSED;  POST /boosts/:id/activate { confirm: true } spends;  /pause, /refresh;  DELETE /boosts/:id
 *   POST   /campaigns/:id/status   { status, confirm };  POST /campaigns/:id/budget { amount, endTime?, confirm? };  DELETE /campaigns/:id
 *   POST   /policy                 { fields: { name: text } } → { version, blocked, findings }: the policy check alone, no Meta call (A4)
 *   POST   /drafts/validate        { spec } → { policy, money, meta, problems, warnings, bots }: creates nothing (A4)
 *   POST   /drafts                 { spec, confirmPolicyWarnings? } → 201 { campaignId, ops }: everything PAUSED (A4)
 *   POST   /uploads/sign           { filename, mime, size } → 201 { mediaId, url, upload: { method, url, headers }, expiresAt }: a signed
 *                                  direct upload to Storage, so a video is never in a request body here (A5)
 *   POST   /creatives/from-media   { mediaId, kind: 'image'|'video', coverMediaId? } → { op: null, media }: the upload handed to Meta
 *                                  (adimages, or advideos with file_url); a video needs a cover (A5)
 *   GET    /targeting/search       ?type=adinterest|adgeolocation|adlocale&q= → { items }: cached 24 h per query (A5)
 *   GET    /minimum-budgets        { currency, byGoal, syncedAt }: Meta's minimum daily budget, the floor the server enforces (A5)
 *   POST   /objects/:id/duplicate  { deep? } → { op }: a PAUSED copy (A5; adsObjects.ts)
 *   POST   /boosts with `objective: 'MESSAGES'` (or `goal: 'messages'`) is the same draft, from the Boost preset (spec.ts boostToSpec)
 *
 * **Every route answers 404 ADS_DISABLED unless the platform admin switched ads on for the tenant** (`ads.enabled.<tenant>`). Roles
 * (research R18): reads are any member's (viewer and up); every write, the token test and the account list are the owner's. A refusal is
 * `{ error, code, field?, metaCode?, metaSubcode?, retryAt? }`. The token is never in an answer, a log line or an audit row.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit, type AuditAction } from '../services/audit.js';
import {
    activateBoost, AdsError, createBoost, deleteBoost, eligibilityFor, listAdAccountsFor, listBoosts, metaRefusal, pauseBoost, refreshBoost,
    type BoostView,
} from '../services/adBoosts.js';
import { deleteCampaign, setCampaignBudget, setCampaignStatus } from '../services/ads/manager.js';
import { readOverview } from '../services/ads/overview.js';
import { AdsGraphError, withAdsContext } from '../services/ads/graph.js';
import { runGuard } from '../services/ads/guard.js';
import { describeAdsSettings, testConnection } from '../services/ads/health.js';
import { forgetMoneyPicture, MONEY_MAX, moneyFor, MoneyRefused, parseCandidate, readSpend, roundMoney } from '../services/ads/money.js';
import { notifyAds, sendAdsTest } from '../services/ads/notify.js';
import {
    alertsView, isAdsEnabled, needsCeiling, parseAlertsInput, parseSettingsInput, readAdsSettings, readAlerts, readCeiling, readHealth,
    saveAdsSettings, saveAlerts, writeHealth,
} from '../services/ads/settings.js';
import { setSpendCap, SpendCapRefused, spendCapChangesLeft } from '../services/ads/spendCap.js';
import { parseSwitchesInput, readAdsSwitches, writeAdsSwitches } from '../services/ads/switches.js';
import { fetchAccountState } from '../services/ads/metaAds.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { mountObjectRoutes } from './adsObjects.js';
import { mountAudienceRoutes } from './adsAudiences.js';
import { mountLeadRoutes } from './adsLeads.js';
import { createDraft, DraftRefused, minimumDailyBudget, validateDraft } from '../services/ads/drafts.js';
import { prepareMedia } from '../services/ads/adMedia.js';
import { signAdUpload } from '../services/ads/adUploads.js';
import { adsGraph } from '../services/ads/graphPort.js';
import { searchTargeting, type TargetingType } from '../services/ads/targetingSearch.js';
import { getPublicBaseUrl } from '../services/appSettings.js';
import { checkPolicy } from '../services/ads/policy.js';
import { boostToSpec, type MessageDestination } from '../services/ads/spec.js';
import { adsResultsRouter } from './adsResults.js';
import { adsProposalsRouter } from './adsProposals.js';
import { adsShareSpendRouter } from './adsShareSpend.js';
import { adsRulesRouter } from './adsRules.js';
import { describeError, log } from '../utils/log.js';

export const adsRouter = Router();

const canView = requireTenantRole('viewer');
const canOperate = requireTenantRole('operator');
const canAdminister = requireTenantRole('owner');

/**
 * Every route: 404 ADS_DISABLED unless ads are on for the tenant; then the rest of the request runs with the tenant and its ad account as
 * the Graph context, so every Marketing API call it makes is paced against that account.
 */
adsRouter.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
        const creatorId = getTenantId(req);
        if (!(await isAdsEnabled(creatorId))) {
            res.status(404).json({ error: 'Ads are not available for this account.', code: 'ADS_DISABLED' });
            return;
        }
        const { settings } = await readAdsSettings(creatorId);
        withAdsContext({ creatorId, adAccountId: settings.adAccountId }, () => next());
    } catch (err) {
        log('error', 'ads.gate_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read the ads settings.' });
    }
});

function body(req: Request): Record<string, unknown> {
    return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
}

async function fail(req: Request, res: Response, err: unknown, what: string): Promise<void> {
    const e = err instanceof AdsError ? err : null;
    if (e || err instanceof AdsGraphError || err instanceof MoneyRefused) {
        const r = e ?? metaRefusal(err);
        if (r.code === 'TOKEN_INVALID') await markTokenDead(req, r.metaCode ?? null);
        res.status(r.status).json({
            error: r.message, code: r.code,
            ...(r.field ? { field: r.field } : {}),
            ...(r.metaCode !== undefined ? { metaCode: r.metaCode } : r.code === 'META_ERROR' ? { metaCode: null } : {}),
            ...(r.extra.metaSubcode !== undefined ? { metaSubcode: r.extra.metaSubcode } : {}),
            ...(r.extra.retryAt ? { retryAt: r.extra.retryAt.toISOString() } : {}),
        });
        return;
    }
    log('error', `ads.${what}_failed`, describeError(err));
    res.status(500).json({ error: `Failed to ${what.replace(/_/g, ' ')}.` });
}

/** Meta refused the token on a live call: the card says so at once, and the owner is told (once a day). Never throws. */
async function markTokenDead(req: Request, code: number | null): Promise<void> {
    try {
        const creatorId = getTenantId(req);
        const health = await readHealth(creatorId);
        if (health.token.health === 'dead') return;
        health.token = { ...health.token, health: 'dead', checkedAt: new Date().toISOString() };
        await writeHealth(creatorId, health);
        const { settings } = await readAdsSettings(creatorId);
        await notifyAds({ kind: 'token_dead', code }, { creatorId, adAccountId: settings.adAccountId, accountName: health.account?.name ?? null, offsetHours: health.account?.timezoneOffsetHours ?? 0 });
    } catch (err) {
        log('warn', 'ads.token_dead_record_failed', describeError(err));
    }
}

async function audit(req: Request, action: AuditAction, boost: BoostView | null, detail: Record<string, unknown>): Promise<void> {
    await writeAudit(await actorFromSession(req.session), {
        action,
        targetType: boost ? 'ad_boost' : 'creator',
        targetId: boost ? boost.id : getTenantId(req),
        detail: boost
            ? { post_id: boost.postId, platform: boost.platform, daily_budget: boost.dailyBudget, days: boost.days, planned_total: boost.plannedTotal, currency: boost.currency, status: boost.status, campaign_id: boost.campaignId, ...detail }
            : detail,
    });
}

const actorOf = (req: Request) => ({ userId: req.session?.userId ?? null });

// ─── Settings ─────────────────────────────────────────────────────────────────────────────

adsRouter.get('/settings', canView, async (req, res) => {
    try {
        res.json(await describeAdsSettings(getTenantId(req)));
    } catch (err) {
        await fail(req, res, err, 'read_ads_settings');
    }
});

adsRouter.post('/settings', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const { settings } = await readAdsSettings(creatorId);
        const ceiling = (await needsCeiling(creatorId)) ? await readCeiling(creatorId) : null;
        const parsed = parseSettingsInput(req.body, settings, ceiling);
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.error, code: parsed.code, field: parsed.field });
            return;
        }
        await saveAdsSettings(creatorId, parsed.value, settings, req.session?.userId ?? null);
        forgetMoneyPicture(creatorId);
        // Which settings changed, never the token's value.
        const changed = [...Object.keys(parsed.value.settings), ...(parsed.value.token !== undefined ? [parsed.value.token === null ? 'token_removed' : 'token'] : [])];
        await audit(req, AUDIT_ACTIONS.adsSettingsWrite, null, { changed });
        log('info', 'ads.settings_written', { creator_id: creatorId, changed });

        // A cap saved at or below what the month already spent: the save stands (lowering a cap is always allowed), the guard runs at once
        // instead of within the hour, and the answer says every active campaign is being paused.
        const warnings: string[] = [];
        const newCap = parsed.value.settings.monthlyCap;
        if (typeof newCap === 'number') {
            const { settings: after, token } = await readAdsSettings(creatorId);
            if (token && after.adAccountId) {
                const spent = await readSpend(after.adAccountId, 'this_month', token);
                const guard = await runGuard({ only: creatorId, force: true, deadline: Date.now() + 20_000 });
                if ((spent !== null && Math.round(spent * 100) >= Math.round(newCap * 100)) || guard.paused > 0) warnings.push('will_pause_all');
            }
        }
        res.json({ ...(await describeAdsSettings(creatorId)), ...(warnings.length ? { warnings } : {}) });
    } catch (err) {
        await fail(req, res, err, 'save_ads_settings');
    }
});

adsRouter.post('/settings/test', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const result = await testConnection(creatorId);
        res.json({ ...result, settings: await describeAdsSettings(creatorId) });
    } catch (err) {
        if (err instanceof Error && err.message === 'NO_TOKEN') {
            res.status(409).json({ error: 'Paste a system-user token first.', code: 'ADS_NOT_CONFIGURED', field: 'token' });
            return;
        }
        await fail(req, res, err, 'test_ads_connection');
    }
});

adsRouter.post('/settings/alerts', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const parsed = parseAlertsInput(req.body, await readAlerts(creatorId));
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.error, code: 'INVALID', field: parsed.field });
            return;
        }
        await saveAlerts(creatorId, parsed.value, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.adsAlertsWrite, null, { changed: Object.keys(body(req)).filter((k) => k !== 'test') });
        res.json({ alerts: alertsView(parsed.value), ...(parsed.test ? { test: await sendAdsTest(creatorId) } : {}) });
    } catch (err) {
        await fail(req, res, err, 'save_ads_alerts');
    }
});

/**
 * The two A3 switches (both off by default): the bot is told which ad a conversation came from (`botContext`), and Meta's longer reply window for
 * ad-started conversations, per platform (`extendedWindow`). Reading is any member's; changing them is the owner's. The settings view carries
 * them too (`switches`); this is the card's own pair of routes.
 */
adsRouter.get('/settings/switches', canView, async (req, res) => {
    try {
        res.json({ switches: await readAdsSwitches(getTenantId(req)) });
    } catch (err) {
        await fail(req, res, err, 'read_ads_switches');
    }
});

adsRouter.post('/settings/switches', canAdminister, async (req, res) => {
    try {
        const parsed = parseSwitchesInput(req.body);
        if (!parsed.ok) {
            res.status(400).json({ error: `${parsed.field} must be true or false.`, code: 'INVALID', field: parsed.field });
            return;
        }
        const switches = await writeAdsSwitches(getTenantId(req), parsed.value, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.adsSwitchesWrite, null, { ...parsed.value });
        res.json({ switches });
    } catch (err) {
        await fail(req, res, err, 'save_ads_switches');
    }
});

adsRouter.post('/spend-cap', canAdminister, async (req, res) => {
    const b = body(req);
    if (b['confirm'] !== true) {
        res.status(400).json({ error: 'Changing the account spending limit changes what Meta lets this account spend: confirm it.', code: 'INVALID', field: 'confirm' });
        return;
    }
    const amount = b['amount'];
    if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || Math.round(amount * 100) <= 0 || amount > MONEY_MAX)) {
        res.status(400).json({ error: `Enter an amount above 0 and at most ${MONEY_MAX}, or remove the limit.`, code: 'INVALID', field: 'amount' });
        return;
    }
    try {
        const creatorId = getTenantId(req);
        const { settings, token } = await readAdsSettings(creatorId);
        if (!token || !settings.adAccountId) {
            res.status(409).json({ error: 'Set the ad account and the token first.', code: 'ADS_NOT_CONFIGURED' });
            return;
        }
        const account = await fetchAccountState(settings.adAccountId, token);
        const result = await setSpendCap({
            creatorId, adAccountId: settings.adAccountId, currency: account.currency, offsetHours: account.timezoneOffsetHours,
            amount: amount === null ? null : roundMoney(amount), token, userId: req.session?.userId ?? null,
        });
        const health = await readHealth(creatorId);
        if (health.account) await writeHealth(creatorId, { ...health, account: { ...health.account, spendCap: result.amount } });
        await audit(req, AUDIT_ACTIONS.adsSpendCapChanged, null, { asked: amount, read_back: result.amount, verified: result.verified, units: result.units, currency: account.currency });
        res.json({
            op: result.op,
            spendCap: { amount: result.amount, changesLeftToday: await spendCapChangesLeft(creatorId, settings.adAccountId, account.timezoneOffsetHours) },
            verified: result.verified,
        });
    } catch (err) {
        if (err instanceof SpendCapRefused) {
            res.status(429).json({ error: err.message, code: err.code, retryAt: err.retryAt.toISOString() });
            return;
        }
        await fail(req, res, err, 'set_spend_cap');
    }
});

adsRouter.get('/accounts', canAdminister, async (req, res) => {
    try {
        res.json({ accounts: await listAdAccountsFor(getTenantId(req)) });
    } catch (err) {
        await fail(req, res, err, 'list_ad_accounts');
    }
});

// ─── The money rule ───────────────────────────────────────────────────────────────────────

adsRouter.get('/money', canView, async (req, res) => {
    try {
        const raw = req.query['candidate'];
        const candidate = raw === undefined || raw === '' ? null : parseCandidate(raw);
        if (raw !== undefined && raw !== '' && !candidate) {
            res.status(400).json({ error: 'candidate is daily:<amount>[:<days>] or lifetime:<amount>:<days>.', code: 'INVALID', field: 'candidate' });
            return;
        }
        const creatorId = getTenantId(req);
        const { settings, token } = await readAdsSettings(creatorId);
        const limits = settings.adAccountId && settings.monthlyCap && settings.maxDailyBudget
            ? { adAccountId: settings.adAccountId, monthlyCap: settings.monthlyCap, maxDailyBudget: settings.maxDailyBudget }
            : null;
        res.json(await moneyFor(creatorId, limits, token, candidate));
    } catch (err) {
        await fail(req, res, err, 'read_ads_money');
    }
});

// ─── Boost ────────────────────────────────────────────────────────────────────────────────

adsRouter.get('/boosts', canView, async (req, res) => {
    try {
        res.json({ boosts: await listBoosts(getTenantId(req)) });
    } catch (err) {
        await fail(req, res, err, 'list_boosts');
    }
});

adsRouter.get('/eligibility', canView, async (req, res) => {
    try {
        res.json(await eligibilityFor(getTenantId(req), req.query['postId'], req.query['platform']));
    } catch (err) {
        await fail(req, res, err, 'check_eligibility');
    }
});

adsRouter.post('/boosts', canAdminister, async (req, res) => {
    const b = body(req);
    if (b['objective'] === 'MESSAGES' || b['goal'] === 'messages') {
        await boostMessages(req, res, b);
        return;
    }
    try {
        const boost = await createBoost(getTenantId(req), {
            postId: b['postId'], platform: b['platform'], dailyBudget: b['dailyBudget'], days: b['days'],
            objective: b['objective'], country: b['country'], link: b['link'],
        }, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.adsBoostCreate, boost, { outcome: 'created_paused' });
        res.status(201).json({ boost });
    } catch (err) {
        if (err instanceof AdsError && err.code === 'META_ERROR') {
            // An attempt Meta refused is on record too: objects may have been created and deleted.
            await audit(req, AUDIT_ACTIONS.adsBoostCreate, null, { outcome: 'meta_refused', post_id: b['postId'] ?? null, meta_code: err.metaCode ?? null });
        }
        await fail(req, res, err, 'create_boost');
    }
});

adsRouter.post('/boosts/:id/activate', canAdminister, async (req, res) => {
    // The dashboard's confirmation dialog sends this; a bare POST (a replayed request, a script) does not spend.
    if (body(req)['confirm'] !== true) {
        res.status(400).json({ error: 'Activating spends money: confirm it.', code: 'INVALID', field: 'confirm' });
        return;
    }
    try {
        const boost = await activateBoost(getTenantId(req), String(req.params['id']), new Date(), actorOf(req));
        await audit(req, AUDIT_ACTIONS.adsBoostActivate, boost, {});
        res.json({ boost });
    } catch (err) {
        await fail(req, res, err, 'activate_boost');
    }
});

adsRouter.post('/boosts/:id/pause', canAdminister, async (req, res) => {
    try {
        const boost = await pauseBoost(getTenantId(req), String(req.params['id']));
        await audit(req, AUDIT_ACTIONS.adsBoostPause, boost, {});
        res.json({ boost });
    } catch (err) {
        await fail(req, res, err, 'pause_boost');
    }
});

adsRouter.post('/boosts/:id/refresh', canAdminister, async (req, res) => {
    try {
        res.json({ boost: await refreshBoost(getTenantId(req), String(req.params['id'])) });
    } catch (err) {
        await fail(req, res, err, 'refresh_boost');
    }
});

adsRouter.delete('/boosts/:id', canAdminister, async (req, res) => {
    try {
        const boost = await deleteBoost(getTenantId(req), String(req.params['id']));
        await audit(req, AUDIT_ACTIONS.adsBoostDelete, boost, {});
        res.json({ boost });
    } catch (err) {
        await fail(req, res, err, 'delete_boost');
    }
});

// ─── The Ads screen ───────────────────────────────────────────────────────────────────────

adsRouter.get('/overview', canView, async (req, res) => {
    try {
        res.json(await readOverview(getTenantId(req)));
    } catch (err) {
        await fail(req, res, err, 'read_ads_overview');
    }
});

adsRouter.post('/campaigns/:id/status', canAdminister, async (req, res) => {
    const status = body(req)['status'];
    // Switching on spends money: the screen's confirmation sends this, a bare POST does not spend.
    if (status === 'ACTIVE' && body(req)['confirm'] !== true) {
        res.status(400).json({ error: 'Switching a campaign on spends money: confirm it.', code: 'INVALID', field: 'confirm' });
        return;
    }
    try {
        const campaign = await setCampaignStatus(getTenantId(req), req.params['id'], status, new Date(), actorOf(req));
        await audit(req, AUDIT_ACTIONS.adsCampaignStatus, null, { campaign_id: campaign.id, status, boost_id: campaign.boostId });
        res.json({ campaign });
    } catch (err) {
        await fail(req, res, err, 'set_campaign_status');
    }
});

adsRouter.post('/campaigns/:id/budget', canAdminister, async (req, res) => {
    try {
        const b = body(req) as { amount?: unknown; endTime?: unknown; confirm?: unknown };
        const campaign = await setCampaignBudget(getTenantId(req), req.params['id'], b, new Date(), actorOf(req));
        await audit(req, AUDIT_ACTIONS.adsCampaignBudget, null, {
            campaign_id: campaign.id, kind: campaign.budget.kind, amount: campaign.budget.amount, end_time: campaign.endTime, boost_id: campaign.boostId,
        });
        res.json({ campaign });
    } catch (err) {
        await fail(req, res, err, 'set_campaign_budget');
    }
});

adsRouter.delete('/campaigns/:id', canAdminister, async (req, res) => {
    try {
        const out = await deleteCampaign(getTenantId(req), req.params['id']);
        await audit(req, AUDIT_ACTIONS.adsCampaignDelete, null, { campaign_id: String(req.params['id']) });
        res.json(out);
    } catch (err) {
        await fail(req, res, err, 'delete_campaign');
    }
});

// ─── The builder (A4): the policy check, Meta's validation, the draft ──────────────────────

const POLICY_MAX_FIELDS = 40;
const POLICY_MAX_CHARS = 5000;

/** Refusals that carry the policy findings are answered with them, so the dialog draws them on the text again. */
async function failDraft(req: Request, res: Response, err: unknown, what: string): Promise<void> {
    if (err instanceof DraftRefused) {
        res.status(err.status).json({ error: err.message, code: err.code, findings: err.findings });
        return;
    }
    await fail(req, res, err, what);
}

adsRouter.post('/policy', canOperate, (req, res) => {
    const fields = body(req)['fields'];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        res.status(400).json({ error: 'fields is an object of field name → text.', code: 'INVALID', field: 'fields' });
        return;
    }
    const entries = Object.entries(fields as Record<string, unknown>);
    if (entries.length > POLICY_MAX_FIELDS || entries.some(([k, v]) => k.length > 100 || (v !== null && typeof v !== 'string') || (typeof v === 'string' && v.length > POLICY_MAX_CHARS))) {
        res.status(400).json({ error: `At most ${POLICY_MAX_FIELDS} fields of text, each at most ${POLICY_MAX_CHARS} characters.`, code: 'INVALID', field: 'fields' });
        return;
    }
    res.json(checkPolicy(Object.fromEntries(entries) as Record<string, string | null>));
});

adsRouter.post('/drafts/validate', canOperate, async (req, res) => {
    const b = body(req);
    try {
        res.json(await validateDraft(getTenantId(req), b['spec'] ?? b));
    } catch (err) {
        await failDraft(req, res, err, 'validate_ad_draft');
    }
});

async function createAndAnswer(req: Request, res: Response, spec: unknown, confirmPolicyWarnings: boolean, origin: 'app' | 'boost'): Promise<void> {
    try {
        const draft = await createDraft(getTenantId(req), spec, { confirmPolicyWarnings, actor: { userId: req.session?.userId ?? null, via: 'owner' }, origin });
        const s = (spec ?? {}) as { goal?: unknown; destinations?: unknown; budget?: unknown };
        await audit(req, AUDIT_ACTIONS.adsDraftCreate, null, {
            campaign_object: draft.campaignId, origin, goal: s.goal ?? null, destinations: s.destinations ?? null, budget: s.budget ?? null,
            ops: draft.ops.map((o) => o.id), outcome: 'created_paused',
        });
        res.status(201).json(draft);
    } catch (err) {
        await failDraft(req, res, err, 'create_ad_draft');
    }
}

adsRouter.post('/drafts', canAdminister, async (req, res) => {
    const b = body(req);
    await createAndAnswer(req, res, b['spec'], b['confirmPolicyWarnings'] === true, 'app');
});

/** Boost with "Send messages": the v1 inputs as a `CampaignSpec` (spec.ts `boostToSpec`), created like any draft. */
async function boostMessages(req: Request, res: Response, b: Record<string, unknown>): Promise<void> {
    const days = b['days'];
    const daily = b['dailyBudget'];
    if (typeof b['postId'] !== 'string' || (b['platform'] !== 'instagram' && b['platform'] !== 'facebook')
        || typeof daily !== 'number' || typeof days !== 'number' || typeof b['country'] !== 'string') {
        res.status(400).json({ error: 'postId, platform, dailyBudget, days and country are required.', code: 'INVALID' });
        return;
    }
    const iceBreakers = Array.isArray(b['iceBreakers']) ? (b['iceBreakers'] as Array<Record<string, unknown>>).map((x) => ({
        title: String(x?.['title'] ?? ''), ...(typeof x?.['response'] === 'string' && x['response'] ? { response: x['response'] as string } : {}),
    })) : undefined;
    const spec = boostToSpec({
        postId: b['postId'], platform: b['platform'], dailyBudget: daily, days, objective: 'MESSAGES', country: String(b['country']).toUpperCase(),
        destinations: Array.isArray(b['destinations']) ? (b['destinations'] as MessageDestination[]) : undefined,
        greeting: typeof b['greeting'] === 'string' ? b['greeting'] : undefined, iceBreakers,
    }, new Date());
    await createAndAnswer(req, res, spec, b['confirmPolicyWarnings'] === true, 'boost');
}

// ─── The full builder (A5): uploads, targeting search, minimum budgets ─────────────────────────────────────────────────────────

/** The tenant's ad account and token, or 409 ADS_NOT_CONFIGURED. */
async function callContext(req: Request): Promise<{ tenantId: string; adAccountId: string; token: string }> {
    const tenantId = getTenantId(req);
    const { settings, token } = await readAdsSettings(tenantId);
    if (!token || !settings.adAccountId) throw new AdsError(409, 'ADS_NOT_CONFIGURED', 'Connect the ad account and the token in Settings first.');
    return { tenantId, adAccountId: settings.adAccountId, token };
}

adsRouter.post('/uploads/sign', canAdminister, async (req, res) => {
    try {
        const base = await getPublicBaseUrl(null);
        if (!base) throw new AdsError(409, 'INVALID', 'Set the public address of the app first: Meta fetches uploads from it.');
        res.status(201).json(await signAdUpload(getTenantId(req), body(req), base));
    } catch (err) {
        await fail(req, res, err, 'sign_ad_upload');
    }
});

adsRouter.post('/creatives/from-media', canAdminister, async (req, res) => {
    try {
        const media = await prepareMedia(await callContext(req), body(req));
        res.json({ op: null, media });
    } catch (err) {
        await fail(req, res, err, 'prepare_ad_media');
    }
});

const TARGETING_TYPES: readonly TargetingType[] = ['adinterest', 'adgeolocation', 'adlocale'];

adsRouter.get('/targeting/search', canOperate, async (req, res) => {
    try {
        const type = String(req.query['type'] ?? '') as TargetingType;
        if (!TARGETING_TYPES.includes(type)) throw new AdsError(400, 'INVALID', 'type is adinterest, adgeolocation or adlocale.', 'type');
        const ctx = await callContext(req);
        res.json(await searchTargeting(ctx, adsGraph(ctx), type, String(req.query['q'] ?? '')));
    } catch (err) {
        await fail(req, res, err, 'search_targeting');
    }
});

adsRouter.get('/minimum-budgets', canView, async (req, res) => {
    try {
        const ctx = await callContext(req);
        const health = await readHealth(ctx.tenantId);
        const currency = health.account?.currency ?? null;
        // One floor for every goal: every ad set the builder makes is billed on impressions, and this is the one the server enforces.
        const min = currency ? await minimumDailyBudget({ adAccountId: ctx.adAccountId, token: ctx.token, currency, minDailyBudget: health.account?.minDailyBudget ?? null }) : null;
        const byGoal = min === null ? {} : { messages: min, engagement: min, reach: min, traffic: min };
        res.json({ currency, byGoal, syncedAt: health.account?.syncedAt ?? null });
    } catch (err) {
        await fail(req, res, err, 'read_minimum_budgets');
    }
});

// ─── The Campaigns tab and the queue (A2): stored reads, every write an op ─────────────────────────────────────────────────────────

mountObjectRoutes(adsRouter, fail);

// Audiences (A8): engagement, video, lookalike and customer-list audiences; the legal lock and the opt-out list (routes/adsAudiences.ts).
mountAudienceRoutes(adsRouter, fail);

// Lead ads (A10): instant forms and the leads they collect, locked per tenant until a `lead_ads` legal sign-off (routes/adsLeads.ts).
mountLeadRoutes(adsRouter);

// ─── The Results tab (A6): per-day results from the stored copy, never Meta ────────────────────────────────────────────────────────

adsRouter.use(adsResultsRouter);

// ─── AI proposals (A7): Claude drafts, a person approves; approving enqueues PAUSED creates or the one change ─────────────────────

adsRouter.use(adsProposalsRouter);

// ─── Managed clients (A11): the client's share-spend switch and its ceiling (any member reads, the owner writes) ───────────────────

adsRouter.use(adsShareSpendRouter);

// ─── Rules (A9): the owner's standing conditions; protective actions run alone, raises and resumes become proposals ───────────────

adsRouter.use(adsRulesRouter);
