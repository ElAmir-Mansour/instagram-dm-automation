/**
 * The video memory's library, under `/api/settings/ai/muse/library` (docs/specs/005-muse-sees T054, contracts/api.md "Video memory"): what each of the owner's OWN published
 * reels shows and says, as the agent remembers it. Mounted BELOW `resolveTenant` in api.ts, so every route acts as the session's tenant and every row is that tenant's.
 *
 *   GET  /                 [ { id, ig_media_id, permalink, youtube_url, posted_at, status, summary, hook_score, error, model, usd, updated_at } ]    newest reel first
 *   GET  /:id              the full `result` of one reel: the analysis (summary, topics, seen_on_screen, narration, key_moments, hook_first_3s, hook_score, caption_ar,
 *                          cover_second, cover_reason), or `{ error, detail? }` for a reel that could not be watched, or `{}` while it is queued
 *   POST /index            202 { queued, already_indexed, deduped, listed, truncated }   queue every published reel that has no `ok` row ("index all my reels")
 *   POST /:id/index        202 { queued }                                                  queue one reel again, whatever its state ("re-index")
 *
 * **Tenant owner only, on every route, reads included** (`requireTenantRole('owner')`, the guard the page token and the ice breakers use): the library is configuration of
 * the owner's agent, and indexing spends the platform's model budget. A platform admin acting as a tenant is an owner of it; an operator or a viewer is refused with 403
 * before anything is read.
 *
 * **Nothing runs by itself here.** Queueing writes `pending` rows and `muse.reel_index` jobs (`reelLibrary.ts`); the drain watches the reels, one each. A press costs
 * one read of the owner's media list from Instagram and some rows, and no model. The jobs themselves refuse when the memory switch is off, no route can answer or the
 * day's cap is spent, so a stray press cannot spend what the owner did not allow. The write routes also refuse up front with a reason the owner can act on.
 *
 * A refusal is `{ error, code }`: `MUSE_MEMORY_OFF` 409 (the `memory` switch is off), `AI_NOT_CONFIGURED` 409 (no model is routed for the reel indexer yet),
 * `META_NOT_CONNECTED` 409, `TOKEN_INVALID` 409 (Instagram refused the saved connection: reconnect it; never 401, which the dashboard reads as signed out), `META_UNAVAILABLE`
 * and `META_ERROR` 502, `REEL_NOT_FOUND` 404, `NO_MEDIA_ID` 409. The page credential is in no answer and no log line. No audit row is written: the ledger's actions are a
 * closed list that the settings route of the same feature also extends, and every press is in the log (`muse.library_index_requested`) and, for what it spends, in `ai_usage`.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { describeError, log } from '../utils/log.js';
import { NOT_CONNECTED_MESSAGE, getTenantId, requireTenantRole } from '../services/tenant.js';
import { capabilityOn, readMuseSettings } from '../services/perception/switches.js';
import { getLibraryRow, isRowId, listLibrary, queueOneReel, queueReels, reelRouteReady, upsertPending } from '../services/perception/reelLibrary.js';

export const museLibraryRouter = Router();

/** Every route is the owner's: see the top of the file. */
const canAdminister = requireTenantRole('owner');

const refuse = (res: Response, status: number, code: string, error: string): void => {
    res.status(status).json({ error, code });
};

/**
 * What must be true before a press may queue anything: the `memory` switch is on, and a model is routed for the reel indexer. Answers the refusal itself and returns
 * false when one is not.
 */
async function ready(creatorId: string, res: Response): Promise<boolean> {
    if (!capabilityOn(await readMuseSettings(creatorId), 'memory')) {
        refuse(res, 409, 'MUSE_MEMORY_OFF', 'The video memory is switched off. Turn on "memory" in the Meta vision settings first.');
        return false;
    }
    if (!(await reelRouteReady(creatorId))) {
        refuse(res, 409, 'AI_NOT_CONFIGURED', 'No model is set up to watch reels yet. The operator needs to route "reel_index" in Settings → AI providers.');
        return false;
    }
    return true;
}

function fail(res: Response, event: string, err: unknown): void {
    log('error', event, describeError(err));
    res.status(500).json({ error: 'The video memory could not be read or changed. Try again in a moment.' });
}

/** What a failed listing from Instagram says to the owner. */
function listingProblem(res: Response, reason: 'not_connected' | 'graph_auth' | 'graph_unavailable' | 'not_found' | 'graph_failed'): void {
    switch (reason) {
        case 'not_connected': return refuse(res, 409, 'META_NOT_CONNECTED', NOT_CONNECTED_MESSAGE);
        case 'graph_auth': return refuse(res, 409, 'TOKEN_INVALID', 'Instagram refused the saved connection. Reconnect Instagram and Facebook in Settings, then try again.');
        case 'graph_unavailable': return refuse(res, 502, 'META_UNAVAILABLE', 'Instagram did not answer. Try again in a moment.');
        default: return refuse(res, 502, 'META_ERROR', 'Instagram refused to list the reels. Check that the connection has permission to read media.');
    }
}

const who = (req: Request): string | null => req.session?.userId ?? null;

museLibraryRouter.get('/', canAdminister, async (req, res) => {
    try {
        res.json(await listLibrary(getTenantId(req)));
    } catch (err) {
        fail(res, 'muse.library_list_failed', err);
    }
});

museLibraryRouter.post('/index', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        if (!(await ready(creatorId, res))) return;
        const queued = await queueReels(creatorId);
        if (!queued.ok) {
            listingProblem(res, queued.reason);
            return;
        }
        log('info', 'muse.library_index_requested', { creator_id: creatorId, user_id: who(req), scope: 'all', queued: queued.queued, already_indexed: queued.kept });
        res.status(202).json({ queued: queued.queued, already_indexed: queued.kept, deduped: queued.deduped, listed: queued.listed, truncated: queued.truncated });
    } catch (err) {
        fail(res, 'muse.library_index_failed', err);
    }
});

museLibraryRouter.post('/:id/index', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const row = isRowId(req.params.id) ? await getLibraryRow(creatorId, req.params.id) : null;
        if (!row) return refuse(res, 404, 'REEL_NOT_FOUND', 'No such reel in the library.');
        if (!row.ig_media_id) return refuse(res, 409, 'NO_MEDIA_ID', 'This reel has no Instagram id, so it cannot be watched again.');
        if (!(await ready(creatorId, res))) return;
        // A reel that failed reads as queued again; one that is `ok` stays `ok` until the new analysis replaces it (`upsertPending` leaves it alone).
        await upsertPending(creatorId, [{ igMediaId: row.ig_media_id, permalink: row.permalink, postedAt: row.posted_at }]);
        const queued = await queueOneReel(creatorId, row.ig_media_id);
        log('info', 'muse.library_index_requested', { creator_id: creatorId, user_id: who(req), scope: 'one', queued });
        res.status(202).json({ queued });
    } catch (err) {
        fail(res, 'muse.library_reindex_failed', err);
    }
});

museLibraryRouter.get('/:id', canAdminister, async (req, res) => {
    try {
        const row = isRowId(req.params.id) ? await getLibraryRow(getTenantId(req), req.params.id) : null;
        if (!row) return refuse(res, 404, 'REEL_NOT_FOUND', 'No such reel in the library.');
        res.json(row.result);
    } catch (err) {
        fail(res, 'muse.library_read_failed', err);
    }
});
