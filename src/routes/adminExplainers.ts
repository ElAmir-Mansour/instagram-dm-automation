/**
 * `/api/admin/explainers/*`: the platform admin's card for illustrated explainers (v59; contracts/http-api.md "Settings", tasks.md T050). Mounted by
 * `admin.ts` under its platform-admin gate, and gated again here, so that moving the mount cannot open it.
 *
 *   GET   /                  { enabled: { <tenant id>: boolean }, provider: { provider, account_id, token_last4, model, daily_cap, units_per_picture } | null }
 *   PUT   /provider          { account_id, token?, daily_cap?, units_per_picture? }: the same answer. The token is stored encrypted; one left out is unchanged.
 *   PUT   /enabled           { tenant_id, enabled }: the same answer. Switching a tenant that is not the platform owner ON is 409 EXPLAINERS_OWNER_ONLY.
 *   POST  /provider/test     draws one 256×256 picture with the saved account and token: { ok, ms, error? }. It counts against the allowance.
 *
 * **No answer carries the token.** Every body is built from `describeImageProvider`, which is told the config and gives back its last four characters,
 * and `send` checks the serialised body against the token and its ciphertext before it goes out: a later change that put one in a body would get a 500
 * instead of a disclosure. The audit rows name the fields that changed and never a value. Provider failures are never 401 or 403, which the dashboard
 * reads as "your session ended": a failed Test is a 200 with `ok: false` and Cloudflare's own words, scrubbed of the token.
 *
 * Refusals of the feature (`ExplainerError`) are answered with their status in the app's usual envelope: `error` is the English sentence, as it
 * has always been (a client that reads `error` as a string keeps working), with `message`, `code` and `params` beside it (src/services/errorCodes.ts,
 * "THE SHAPE"). The explainer codes are not in `ERROR_CODES` yet, so this builds the envelope itself instead of calling `sendError`, which would throw
 * on a code it does not know.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { queryRows } from '../db/query.js';
import { TENANT_SETTING_PREFIXES } from '../services/appSettings.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { ExplainerError } from '../services/explainers/errors.js';
import { markExhausted, refundAllowance, reserveAllowance } from '../services/explainers/pictures/allowance.js';
import { TEST_PROMPT, TEST_SIZE } from '../services/explainers/pictures/prompt.js';
import {
    describeImageProvider, getImageProvider, parseImageProviderPatch, readImageProviderConfig, saveImageProvider, secretsOf, type ImageProviderConfig,
    type ImageProviderView,
} from '../services/explainers/pictures/provider.js';
import { asProviderError } from '../services/explainers/pictures/types.js';
import { setExplainersEnabled } from '../services/explainers/switch.js';
import { isMissingSchema } from '../services/health.js';
import { isPlainObject, UUID_PATTERN } from '../services/studio/common.js';
import { describeError, log } from '../utils/log.js';

export const adminExplainersRouter = Router();

/** 404, never 403: a non-admin has no business learning that this surface exists. The same gate `admin.ts` puts above this router. */
adminExplainersRouter.use((req: Request, res: Response, next: NextFunction) => {
    if (req.session?.role !== 'platform_admin') {
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    next();
});

/** What the schema being behind the code looks like here: `image_allowance` (and the other v59 tables) are missing. */
const V59_HINT = 'The database is missing migration v59 (src/config/migration_v59_explainers.sql). Apply it with `npm run migrate`, then reload.';

/** The envelope of a refusal of the feature: see the top of the file. */
function explainerErrorBody(err: ExplainerError) {
    return { error: err.message, message: err.message, code: err.code, params: err.params ?? {} };
}

/** Every route's error handling, once: a refusal of the feature is its own answer, a schema behind the code says which migration, anything else is a 500. */
function handle(event: string, fallback: string, fn: (req: Request, res: Response) => Promise<void>) {
    return async (req: Request, res: Response): Promise<void> => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof ExplainerError) {
                res.status(err.status).json(explainerErrorBody(err));
                return;
            }
            log('error', event, describeError(err));
            if (isMissingSchema(err)) {
                res.status(500).json({ error: V59_HINT, migrationPending: true });
                return;
            }
            res.status(500).json({ error: fallback });
        }
    };
}

async function audit(req: Request, action: string, targetType: string, targetId: string | null, detail: Record<string, unknown>): Promise<void> {
    const actor = await actorFromSession(req.session);
    await writeAudit(actor, { action, targetType, targetId, detail });
}

/**
 * Whether serialising `body` would put one of `secrets` in it. A "secret" shorter than eight characters is not looked for: it would match the
 * English it appears in, and no credential is that short.
 */
export function leaksSecret(body: unknown, secrets: readonly string[]): boolean {
    const text = JSON.stringify(body);
    return secrets.some((secret) => secret.length >= 8 && text.includes(secret));
}

/** Sends a body, unless it holds a secret: then a 500 that says only that. */
function send(res: Response, status: number, body: unknown, secrets: readonly string[]): void {
    if (leaksSecret(body, secrets)) {
        log('error', 'admin.explainers_response_blocked', { status });
        res.status(500).json({ error: 'The response was withheld: it contained a credential.' });
        return;
    }
    res.status(status).json(body);
}

const problemsBody = (problems: string[]) => ({ error: problems.length === 1 ? problems[0]! : `${problems.length} problems with the provider settings.`, problems });

interface ExplainersView {
    enabled: Record<string, boolean>;
    provider: ImageProviderView | null;
}

/** Every tenant with its switch (off unless the setting is `true`, as `isExplainersEnabled` reads it), and the provider as the card is shown it. */
async function readView(config: ImageProviderConfig | null): Promise<ExplainersView> {
    const prefix = TENANT_SETTING_PREFIXES.explainersEnabled;
    const [tenants, switches] = await Promise.all([
        queryRows<{ id: string }>('SELECT id FROM creators ORDER BY created_at, id'),
        queryRows<{ key: string; value: string | null }>('SELECT key, value FROM app_settings WHERE key LIKE $1', [`${prefix}%`]),
    ]);
    const on = new Set(switches.filter((row) => row.value === 'true').map((row) => row.key.slice(prefix.length).toLowerCase()));
    return {
        enabled: Object.fromEntries(tenants.map((tenant) => [tenant.id, on.has(tenant.id.toLowerCase())])),
        provider: describeImageProvider(config),
    };
}

/** The answer of GET, which PUT answers with too. `extra` is a secret that is not saved yet, to be kept out of it. */
async function sendView(res: Response, extra: readonly string[] = []): Promise<void> {
    const config = await readImageProviderConfig();
    send(res, 200, await readView(config), [...secretsOf(config), ...extra]);
}

adminExplainersRouter.get('/', handle('admin.explainers_read_failed', 'Failed to read the Explainers settings.', async (_req, res) => {
    await sendView(res);
}));

adminExplainersRouter.put('/provider', handle('admin.explainers_provider_save_failed', 'Failed to save the image provider.', async (req, res) => {
    const parsed = parseImageProviderPatch(req.body, await readImageProviderConfig());
    if (!parsed.ok) {
        res.status(400).json(problemsBody(parsed.problems));
        return;
    }
    // A save that changes nothing writes nothing and says nothing in the audit log.
    if (parsed.changed.length > 0) {
        await saveImageProvider(parsed.patch, req.session?.userId ?? null);
        // The fields, never a value: the token is not in this row, nor in any other.
        await audit(req, AUDIT_ACTIONS.explainersProviderUpdated, 'app', null, { changed: parsed.changed });
    }
    await sendView(res, parsed.patch.token ? [parsed.patch.token] : []);
}));

adminExplainersRouter.put('/enabled', handle('admin.explainers_enabled_failed', 'Failed to change the Explainers switch.', async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const tenantId = typeof body.tenant_id === 'string' && UUID_PATTERN.test(body.tenant_id) ? body.tenant_id.toLowerCase() : null;
    if (!tenantId) {
        res.status(400).json({ error: 'tenant_id must be the id of a tenant.' });
        return;
    }
    if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be true or false.' });
        return;
    }
    // The one writer of the key: it refuses a tenant that is not the owner, for ON.
    await setExplainersEnabled(tenantId, body.enabled, req.session?.userId ?? null);
    await audit(req, AUDIT_ACTIONS.explainersEnabledChanged, 'tenant', tenantId, { tenant_id: tenantId, enabled: body.enabled });
    await sendView(res);
}));

adminExplainersRouter.post('/provider/test', handle('admin.explainers_provider_test_failed', 'Failed to test the image provider.', async (_req, res) => {
    const provider = await getImageProvider();
    if (!provider) {
        throw new ExplainerError('EXPLAINER_NO_PROVIDER', 'No image provider is saved yet: save the Cloudflare account id and token first, then test.');
    }
    const started = Date.now();
    // It counts against the allowance like any picture: reserved first (429 while the cap is reached or the allocation is used up), settled after.
    const reservation = await reserveAllowance(provider, 1);
    try {
        await provider.draw({ prompt: TEST_PROMPT, width: TEST_SIZE.width, height: TEST_SIZE.height, seed: 1 });
    } catch (err) {
        const failure = asProviderError(err, { event: 'provider_test' });
        if (failure.kind === 'ALLOWANCE_EXHAUSTED') await markExhausted(provider.id);
        else await refundAllowance(reservation);
        send(res, 200, { ok: false, ms: Date.now() - started, error: failure.message }, secretsOf(await readImageProviderConfig()));
        return;
    }
    send(res, 200, { ok: true, ms: Date.now() - started }, []);
}));
