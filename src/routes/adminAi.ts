/**
 * `/api/admin/ai/*`: the AI providers layer's settings, for Operations (docs/onboarding/06 §2, "The 'AI providers' card"; P20c).
 *
 * Mounted by `admin.ts` under its platform-admin gate, and gated again here, so that moving the mount cannot open it.
 *
 *   GET    /                   the settings, masked: providers (key status, models, base URL), routes, prices, budgets, warnings, spend
 *   PUT    /                   `{providers?, routing?, prices?, budgets?}`: merge entry by entry, `null` removes an entry
 *   PUT    /keys/:provider     `{apiKey}`: checked with the provider first; a key it refuses is never saved
 *   DELETE /keys/:provider     forget the saved key (the environment's, if any, answers again)
 *   POST   /test               `{provider}`: check the key now (free); `{purpose}`: one tiny structured call down that route
 *   GET    /models/:provider   the provider's model list, for "Load models"
 *   GET    /usage              spend today and this month, by purpose and provider and tenant (`?period=month` for the month)
 *
 * **No response carries a key.** Every body is built from `describeAi` (which is told `{set, source, last4}` and nothing more), and
 * `send` checks the serialised body against every key in force, and against the one just pasted, before it goes out: a future change
 * that put a key in a body would get a 500 instead of a disclosure. Errors are the provider's own words, already scrubbed of the key.
 *
 * **Gemini's key is not saved here.** It is the DM bot's and the Studio's, and `PUT /api/admin/gemini-key` checks it against the DM bot's
 * models before replacing it; this router reports its status and tests and lists it like any other, and sends a save there.
 *
 * Provider failures are never 401 or 403: the dashboard treats those as "your session ended". A key the provider refuses is a 400; a
 * provider that could not be reached is a 502, and nothing was saved.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { setSetting } from '../services/appSettings.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { isMissingSchema, isMissingTable, MIGRATION_HINT } from '../services/health.js';
import { applyAiPlan, keyProblem, loadAiSettings, PROVIDER_KEY_SETTING, planAiPatch, type AiConfig, type ProviderKeys } from '../services/aiProviders/settings.js';
import { describeAi } from '../services/aiProviders/view.js';
import { generate, providerFetchImpl } from '../services/aiProviders/generate.js';
import { AiError, isAiError, scrub } from '../services/llm/errors.js';
import { KEY_TEST, isAiPurpose } from '../services/aiProviders/purposes.js';
import { listProviderModels, checkProviderKey } from '../services/llm/providerQuery.js';
import { isProviderId, providerById, providerName, type ProviderId } from '../services/llm/registry.js';
import type { GeminiSchema } from '../services/llm/geminiSchema.js';
import { getUsageSummary, recordKeyCheck } from '../services/aiProviders/usage.js';
import { describeError, log } from '../utils/log.js';

const router = Router();

/** 404, never 403: a non-admin has no business learning that this surface exists. The same gate `admin.ts` puts above this router. */
router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.session?.role !== 'platform_admin') {
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    next();
});

const GEMINI_KEY_ROUTE = 'Gemini\'s key is shared with the DM bot and the Studio: save or remove it with PUT / DELETE /api/admin/gemini-key, which also checks the DM bot\'s models.';

/** The one-token schema of a route test: about fifty tokens in, a few out. */
const TEST_SCHEMA: GeminiSchema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] };
const TEST_SYSTEM = 'You are a connectivity check. Answer with the JSON object {"ok": true}.';

const MODELS_SHOWN = 500;

async function audit(req: Request, action: string, detail: Record<string, unknown>): Promise<void> {
    const actor = await actorFromSession(req.session);
    await writeAudit(actor, { action, targetType: 'app', targetId: null, detail });
}

/** v34 creates `ai_usage`: without it the spend, the budgets and every `generate` call fail, and `MIGRATION_HINT` (v15) would point at the wrong file. */
const AI_MIGRATION_HINT = 'The database is missing migration v34 (src/config/migration_v34_onboarding.sql), which creates ai_usage. Apply it with `npm run migrate`, then reload.';

/** The 500 for any failure, with nothing of the request in it; a schema that is behind the code says which migration to apply. */
function failWith(res: Response, err: unknown, event: string, message: string): void {
    log('error', event, describeError(err));
    if (isMissingTable(err, 'ai_usage')) {
        res.status(500).json({ error: AI_MIGRATION_HINT, migrationPending: true });
        return;
    }
    if (isMissingSchema(err)) {
        res.status(500).json({ error: MIGRATION_HINT, migrationPending: true });
        return;
    }
    res.status(500).json({ error: message });
}

/**
 * Sends a body, unless it contains a key. `extra` is a key that is not saved yet (the one being checked) and so is not in `keys`.
 * Only a key of a length no ordinary word has is looked for: a 4-character "key" would match the English it appears in.
 */
function send(res: Response, status: number, body: unknown, keys: ProviderKeys, extra: readonly string[] = []): void {
    const text = JSON.stringify(body);
    const leaked = [...keys.secrets(), ...extra].some((secret) => secret.length >= 8 && text.includes(secret));
    if (leaked) {
        log('error', 'admin.ai_response_blocked', { status });
        res.status(500).json({ error: 'The response was withheld: it contained an API key.' });
        return;
    }
    res.status(status).json(body);
}

/** What a failed provider call is, as an HTTP status: never 401 or 403, which the dashboard reads as "signed out". */
export const httpStatusFor = (err: AiError): number => (err.kind === 'rate' || err.kind === 'server' || err.kind === 'timeout' ? 502 : 400);

const problemsBody = (problems: string[]) => ({ error: problems.length === 1 ? problems[0]! : `${problems.length} problems with the request.`, problems });

function parseProvider(req: Request, res: Response): ProviderId | null {
    const id = req.params.provider;
    if (!isProviderId(id)) {
        res.status(404).json({ error: 'No such provider.' });
        return null;
    }
    return id;
}

/** Custom's endpoint is the operator's setting; every other provider's is fixed. */
const baseUrlOf = (id: ProviderId, config: AiConfig): string | undefined => (providerById(id)?.editableBaseUrl ? config.providers[id]?.baseUrl : undefined);

// ─── The settings ────────────────────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
    try {
        const { config, keys } = await loadAiSettings();
        const summary = await getUsageSummary();
        send(res, 200, { ...describeAi(config, keys), spend: { today: summary.today, month: summary.month, dayStart: summary.dayStart } }, keys);
    } catch (err) {
        failWith(res, err, 'admin.ai_read_failed', 'Failed to read the AI settings.');
    }
});

router.put('/', async (req, res) => {
    try {
        const { config } = await loadAiSettings();
        const planned = planAiPatch(req.body, config);
        if (!planned.ok) {
            res.status(400).json(problemsBody(planned.problems));
            return;
        }
        await applyAiPlan(planned.plan, req.session?.userId ?? null);
        // Names and non-secret facts: which providers, routes (provider/model/effort), models priced and budgets changed. Never a key, never an amount.
        await audit(req, AUDIT_ACTIONS.settingsAiConfigWrite, { ...planned.plan.changes });
        const after = await loadAiSettings();
        send(res, 200, describeAi(after.config, after.keys), after.keys);
    } catch (err) {
        failWith(res, err, 'admin.ai_save_failed', 'Failed to save the AI settings.');
    }
});

// ─── Keys ────────────────────────────────────────────────────────────────────────────────────

router.put('/keys/:provider', async (req, res) => {
    const id = parseProvider(req, res);
    if (!id) return;
    if (id === 'gemini') {
        res.status(400).json({ error: GEMINI_KEY_ROUTE, code: 'USE_GEMINI_KEY_ROUTE' });
        return;
    }
    const problem = keyProblem((req.body ?? {}).apiKey);
    if (problem) {
        res.status(400).json({ error: problem });
        return;
    }
    const apiKey = String((req.body ?? {}).apiKey).trim();

    try {
        const { config } = await loadAiSettings();
        const baseUrl = baseUrlOf(id, config);
        if (providerById(id)?.editableBaseUrl && !baseUrl) {
            res.status(400).json({ error: "Save the custom endpoint's base URL first: PUT /api/admin/ai { providers: { custom: { baseUrl } } }." });
            return;
        }

        const started = Date.now();
        let warning: string | undefined;
        try {
            const check = await checkProviderKey({ provider: id, apiKey, baseUrl, fetchImpl: providerFetchImpl() });
            warning = check.warning;
        } catch (err) {
            if (!isAiError(err)) throw err;
            await recordKeyCheck(id, '', err.kind, Date.now() - started);
            log('warn', 'admin.ai_key_refused', { provider: id, kind: err.kind, http_status: err.status });
            // The key is already out of `message` (the AiError constructor scrubbed it); once more, in case a provider spelled it differently.
            res.status(httpStatusFor(err)).json({
                error: err.kind === 'rate' || err.kind === 'server' || err.kind === 'timeout'
                    ? `Could not reach ${providerName(id)} to check the key (${scrub(err.message, apiKey)}). Nothing was saved; try again.`
                    : `${providerName(id)} refused this key: ${scrub(err.message, apiKey)}`,
                kind: err.kind,
            });
            return;
        }
        await recordKeyCheck(id, '', 'ok', Date.now() - started);

        await setSetting(PROVIDER_KEY_SETTING[id], apiKey, req.session?.userId ?? null);
        // The fact, never the value.
        await audit(req, AUDIT_ACTIONS.settingsAiKeyWrite, { provider: id, change: 'saved', warning: warning ?? null });
        const after = await loadAiSettings();
        send(res, 200, { provider: id, key: after.keys.status(id), ...(warning ? { warning } : {}) }, after.keys, [apiKey]);
    } catch (err) {
        failWith(res, err, 'admin.ai_key_save_failed', 'Failed to save the key.');
    }
});

/** Allowed even when nothing would answer afterwards: revoking a leaked key must not be blocked. The card says which outcome this is. */
router.delete('/keys/:provider', async (req, res) => {
    const id = parseProvider(req, res);
    if (!id) return;
    if (id === 'gemini') {
        res.status(400).json({ error: GEMINI_KEY_ROUTE, code: 'USE_GEMINI_KEY_ROUTE' });
        return;
    }
    try {
        await setSetting(PROVIDER_KEY_SETTING[id], null, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.settingsAiKeyWrite, { provider: id, change: 'removed' });
        const after = await loadAiSettings();
        send(res, 200, { provider: id, key: after.keys.status(id) }, after.keys);
    } catch (err) {
        failWith(res, err, 'admin.ai_key_remove_failed', 'Failed to remove the key.');
    }
});

// ─── Test, models, usage ─────────────────────────────────────────────────────────────────────

/**
 * `{provider}` checks the key in force for that provider with a free call and records a `key_test` row with no tokens.
 * `{purpose}` sends one structured call (`{ok: BOOLEAN}`, a few dozen tokens) down that purpose's route, through the same router, budgets
 * and recording as real work, as `key_test`. Either answers 200 with `ok` true or false: the check's verdict is the result, not a failure.
 */
router.post('/test', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { provider, purpose } = body;
    if ((provider === undefined) === (purpose === undefined)) {
        res.status(400).json({ error: 'Send { "provider": "<id>" } to check a key, or { "purpose": "<purpose>" } to test a route.' });
        return;
    }

    try {
        const { config, keys } = await loadAiSettings();

        if (provider !== undefined) {
            if (!isProviderId(provider)) {
                res.status(400).json({ error: 'No such provider.' });
                return;
            }
            const def = providerById(provider)!;
            const apiKey = keys.get(provider);
            if (def.keyRequired && !apiKey) {
                res.status(400).json({ error: `No API key is saved for ${providerName(provider)}.` });
                return;
            }
            const baseUrl = baseUrlOf(provider, config);
            if (def.editableBaseUrl && !baseUrl) {
                res.status(400).json({ error: `${providerName(provider)} has no base URL saved.` });
                return;
            }
            const started = Date.now();
            try {
                const check = await checkProviderKey({ provider, apiKey: apiKey ?? '', baseUrl, fetchImpl: providerFetchImpl() });
                const elapsedMs = Date.now() - started;
                await recordKeyCheck(provider, '', 'ok', elapsedMs);
                send(res, 200, { ok: true, provider, elapsedMs, ...(check.warning ? { warning: check.warning } : {}) }, keys);
            } catch (err) {
                if (!isAiError(err)) throw err;
                const elapsedMs = Date.now() - started;
                await recordKeyCheck(provider, '', err.kind, elapsedMs);
                send(res, 200, { ok: false, provider, elapsedMs, error: { kind: err.kind, message: err.message } }, keys);
            }
            return;
        }

        if (!isAiPurpose(purpose)) {
            res.status(400).json({ error: 'No such purpose.' });
            return;
        }
        try {
            const out = await generate({
                purpose, usageAs: KEY_TEST, creatorId: null, system: TEST_SYSTEM, user: 'ping', schema: TEST_SCHEMA,
                maxTokens: 200, timeoutMs: 60_000, effort: 'low',
            });
            send(res, 200, { ok: true, purpose, provider: out.provider, model: out.model, usage: out.usage, usd: out.usd, priced: out.priced, elapsedMs: out.elapsed_ms }, keys);
        } catch (err) {
            if (!isAiError(err)) throw err;
            send(res, 200, { ok: false, purpose, provider: err.provider || null, model: err.model || null, error: { kind: err.kind, message: err.message } }, keys);
        }
    } catch (err) {
        failWith(res, err, 'admin.ai_test_failed', 'The test could not be run.');
    }
});

router.get('/models/:provider', async (req, res) => {
    const id = parseProvider(req, res);
    if (!id) return;
    try {
        const { config, keys } = await loadAiSettings();
        const def = providerById(id)!;
        const apiKey = keys.get(id);
        if (def.keyRequired && !apiKey) {
            res.status(400).json({ error: `No API key is saved for ${providerName(id)}.` });
            return;
        }
        const baseUrl = baseUrlOf(id, config);
        if (def.editableBaseUrl && !baseUrl) {
            res.status(400).json({ error: `${providerName(id)} has no base URL saved.` });
            return;
        }
        try {
            const models = await listProviderModels({ provider: id, apiKey: apiKey ?? '', baseUrl, fetchImpl: providerFetchImpl() });
            send(res, 200, { provider: id, models: models.slice(0, MODELS_SHOWN), truncated: models.length > MODELS_SHOWN }, keys);
        } catch (err) {
            if (!isAiError(err)) throw err;
            log('warn', 'admin.ai_models_failed', { provider: id, kind: err.kind, http_status: err.status });
            send(res, httpStatusFor(err), { error: `${providerName(id)}: ${err.message}`, kind: err.kind }, keys);
        }
    } catch (err) {
        failWith(res, err, 'admin.ai_models_failed', 'Failed to load the model list.');
    }
});

router.get('/usage', async (req, res) => {
    const period = req.query?.period === 'month' ? 'month' : 'day';
    try {
        res.json(await getUsageSummary({ period }));
    } catch (err) {
        failWith(res, err, 'admin.ai_usage_failed', 'Failed to read the AI usage.');
    }
});

export default router;
