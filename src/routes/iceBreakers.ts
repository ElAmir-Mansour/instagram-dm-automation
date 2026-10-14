/**
 * The ice breakers and persistent menu of the tenant's Instagram account, under `/api/dm/ice-breakers` (docs/DM_SALES_PLAN.md S13).
 * Mounted BELOW `resolveTenant` in api.ts, so every route acts as the session's tenant and the settings row it touches is that tenant's.
 *
 *   GET    /          { config, saved, published, inSync, connected, suggestions, limits, taps }     the draft and the state of the last publish
 *   PUT    /          { iceBreakers, menu }  →  the same                                             saves the DRAFT. Sends nothing to Instagram
 *   POST   /publish   →  the same + { result, live }                                                 THE Meta write: sets (and removes) what the editor says
 *   DELETE /publish   →  the same + { result, live }                                                 deletes both from the account's Instagram profile
 *   GET    /live      { live }                                                                       what Instagram holds right now (a read from Meta)
 *
 * **Tenant owner only, on every route, reads included** (`requireTenantRole('owner')`, the same guard as the page token): a publish changes what
 * every visitor to the account sees, and the draft is configuration of the owner's sales voice. A platform admin acting as a tenant is an owner of
 * it. An operator or a viewer is refused with 403 before anything is read.
 *
 * **Nothing here runs by itself.** There is no schedule, no webhook and no deploy step that publishes: the only paths to Meta are POST and
 * DELETE `/publish` and GET `/live`, and each is a button on the Settings card. Saving a draft (PUT) writes our own row and calls nobody.
 * The ledger gets a row for each: `dm.ice_breakers_write`, `dm.ice_breakers_publish` (also when Meta refused it, so an attempt is on record)
 * and `dm.ice_breakers_remove`, with counts and a fingerprint and never the questions' text.
 *
 * A refusal is `{ error, code }`: `ICE_BREAKERS_INVALID` 400 (with `problems`, each `{ field, code, message }`), `NOTHING_TO_PUBLISH` 400,
 * `META_NOT_CONNECTED` and `INSTAGRAM_NOT_CONNECTED` 409, `META_ERROR` 502 (Meta's own message, with `metaCode`). The page token is never in an
 * answer, a log line or an audit row.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit, type AuditAction } from '../services/audit.js';
import { MetaApiError } from '../services/instagram.js';
import {
    fingerprint, ICE_BREAKER_MAX, ICE_BREAKER_QUESTION_MAX, MENU_ITEMS_MAX, MENU_TITLE_MAX, parseConfig, TAP_CODES, TAP_INTENT,
    type LiveProfile,
} from '../services/dmSales/iceBreakers.js';
import {
    IceBreakerError, publishToInstagram, readLive, readState, removeFromInstagram, saveConfig, suggestionsFor,
    type IceBreakerState, type PublishResult,
} from '../services/dmSales/iceBreakerStore.js';
import { getTenant, getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

export const iceBreakersRouter = Router();

/** Every route is the owner's: see the top of the file. */
const canAdminister = requireTenantRole('owner');

/** The screen's state: the draft, the last publish, whether Instagram is connected, and what the editor needs to draw itself. */
async function view(creatorId: string, state?: IceBreakerState): Promise<Record<string, unknown>> {
    const current = state ?? await readState(creatorId);
    const tenant = await getTenant(creatorId);
    const { kit, suggestions } = await suggestionsFor(creatorId);
    return {
        config: current.config,
        saved: current.saved,
        published: current.published,
        // The draft is what Instagram holds: the fingerprint of what was last sent is the draft's. An empty fingerprint is a publish that
        // only half finished, and is never in sync.
        inSync: current.published !== null && current.published.hash !== '' && current.published.hash === fingerprint(current.config),
        connected: { instagram: Boolean(tenant?.page_access_token && tenant.instagram_page_id) },
        suggestions: { kit, items: suggestions },
        limits: { iceBreakers: ICE_BREAKER_MAX, question: ICE_BREAKER_QUESTION_MAX, menuItems: MENU_ITEMS_MAX, menuTitle: MENU_TITLE_MAX },
        taps: TAP_CODES.map((code) => ({ code, intent: TAP_INTENT[code] })),
    };
}

/** The same Meta call, read back right after a write so the owner sees what Instagram holds. Never fails the write it follows. */
async function readBack(creatorId: string): Promise<{ live: LiveProfile | null; liveError: string | null }> {
    try {
        return { live: await readLive(creatorId), liveError: null };
    } catch (err) {
        log('warn', 'dm.ice_breakers_readback_failed', { creator_id: creatorId, ...describeError(err) });
        return { live: null, liveError: err instanceof Error ? err.message : 'Could not read back from Instagram.' };
    }
}

/** What each error answers. A `MetaApiError` is Meta's own refusal, passed on in its own words; anything else is a logged 500. */
function fail(res: Response, event: string, fallback: string, err: unknown): void {
    if (err instanceof IceBreakerError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
    }
    if (err instanceof MetaApiError) {
        log('warn', event, { ...describeError(err), meta_code: err.metaCode ?? null });
        res.status(502).json({ error: err.message, code: 'META_ERROR', metaCode: err.metaCode ?? null });
        return;
    }
    log('error', event, describeError(err));
    res.status(500).json({ error: fallback });
}

async function audit(req: Request, action: AuditAction, creatorId: string, detail: Record<string, unknown>): Promise<void> {
    await writeAudit(await actorFromSession(req.session), { action, targetType: 'tenant', targetId: creatorId, detail });
}

iceBreakersRouter.get('/', canAdminister, async (req, res) => {
    try {
        res.json(await view(getTenantId(req)));
    } catch (err) {
        fail(res, 'api.ice_breakers_read_failed', 'Failed to read the ice breakers.', err);
    }
});

iceBreakersRouter.put('/', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const parsed = parseConfig(req.body);
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.problems[0]!.message, code: 'ICE_BREAKERS_INVALID', problems: parsed.problems });
            return;
        }
        const state = await saveConfig(creatorId, parsed.config, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.dmIceBreakersWrite, creatorId, {
            ice_breakers: parsed.config.iceBreakers.length, menu_items: parsed.config.menu.length, fingerprint: fingerprint(parsed.config),
        });
        res.json(await view(creatorId, state));
    } catch (err) {
        fail(res, 'api.ice_breakers_save_failed', 'Failed to save the ice breakers.', err);
    }
});

iceBreakersRouter.post('/publish', canAdminister, async (req, res) => {
    const creatorId = getTenantId(req);
    let attempted: Record<string, unknown> = {};
    try {
        const before = await readState(creatorId);
        attempted = { ice_breakers: before.config.iceBreakers.length, menu_items: before.config.menu.length, fingerprint: fingerprint(before.config) };
        const result: PublishResult = await publishToInstagram(creatorId, req.session?.userId ?? null);
        log('info', 'dm.ice_breakers_published', { creator_id: creatorId, set: result.set, removed: result.removed });
        await audit(req, AUDIT_ACTIONS.dmIceBreakersPublish, creatorId, { ...attempted, set: result.set, removed: result.removed, result_status: 'ok' });
        res.json({
            ...(await view(creatorId)),
            result: { set: result.set, removed: result.removed },
            ...(await readBack(creatorId)),
        });
    } catch (err) {
        // A press that Meta refused is still a press: the ledger says who tried to change the account's profile, and what Meta answered.
        if (err instanceof MetaApiError) {
            await audit(req, AUDIT_ACTIONS.dmIceBreakersPublish, creatorId, { ...attempted, result_status: 'failed', meta_code: err.metaCode ?? null });
        }
        fail(res, 'api.ice_breakers_publish_failed', 'Failed to publish to Instagram.', err);
    }
});

iceBreakersRouter.delete('/publish', canAdminister, async (req, res) => {
    const creatorId = getTenantId(req);
    try {
        const result = await removeFromInstagram(creatorId, req.session?.userId ?? null);
        log('info', 'dm.ice_breakers_removed', { creator_id: creatorId, removed: result.removed });
        await audit(req, AUDIT_ACTIONS.dmIceBreakersRemove, creatorId, { removed: result.removed, result_status: 'ok' });
        res.json({
            ...(await view(creatorId)),
            result: { set: [], removed: result.removed },
            ...(await readBack(creatorId)),
        });
    } catch (err) {
        if (err instanceof MetaApiError) {
            await audit(req, AUDIT_ACTIONS.dmIceBreakersRemove, creatorId, { result_status: 'failed', meta_code: err.metaCode ?? null });
        }
        fail(res, 'api.ice_breakers_remove_failed', 'Failed to remove from Instagram.', err);
    }
});

iceBreakersRouter.get('/live', canAdminister, async (req, res) => {
    try {
        res.json({ live: await readLive(getTenantId(req)) });
    } catch (err) {
        fail(res, 'api.ice_breakers_live_failed', 'Failed to read from Instagram.', err);
    }
});
