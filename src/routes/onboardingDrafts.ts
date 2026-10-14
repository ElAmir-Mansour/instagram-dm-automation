/**
 * The profile draft's routes (docs/onboarding/03 §4, P24). Three doors to one engine (`services/onboarding/drafts.ts`):
 *
 *   TENANT   `/api/onboarding/draft`, below `resolveTenant`, owner of the tenant and only while its onboarding is not completed
 *              GET     /draft            the tenant's current draft (the wizard polls this every 3 s while the tab is visible)
 *              POST    /draft            start one (or find the one that already answers these inputs)
 *              POST    /draft/advance    do the next step of it; the wizard fires it when the poll says `advanceable`
 *
 *   ADMIN    `/api/admin/tenants/:id/draft`, platform admin, any tenant, any time (mounted by `routes/admin.ts`)
 *              GET     /tenants/:id/draft
 *              POST    /tenants/:id/draft             start (`force: true` makes a new one although a fresh one answers the inputs)
 *              POST    /tenants/:id/draft/advance     what the Tenants screen fires, un-awaited, right after creating a tenant: it
 *                                                     STARTS a draft when the tenant has none, from the handle and site the operator typed
 *
 *   BACKSTOP `POST /api/onboarding/drafts/sweep`, Bearer CRON_SECRET like `/api/jobs/drain` (mounted by `routes/api.ts`, above auth)
 *
 * Why the admin has its own routes: the tenant routes sit below `resolveTenant`, which would resolve an ADMIN's session to the
 * admin's OWN tenant (or none), so an admin's "advance" there would find no draft, answer 404 and silently do nothing.
 *
 * `advance` runs the draft's steps inside the request (up to 270 s) and answers with the draft as it stands. Whether Vercel keeps
 * a function running after the browser that called it has gone is not known; `onboarding.advance_client_gone` is the log line
 * that settles it: if `onboarding.draft_advance` follows it, the work continued.
 *
 * Answers are `{ draft, … }` where `draft` is the view (`DraftView`): a tenant never sees the text that was scraped, and only a
 * fixed sentence about a failure; an admin also sees the provider's message, the steps with their `elapsed_ms`, and the cost.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { pool } from '../config/db.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { isMissingSchema } from '../services/health.js';
import { advanceDraft, currentDraft, DraftError, startDraft, toDraftView } from '../services/onboarding/drafts.js';
import { readDraftInputs, type InstagramRoad } from '../services/onboarding/draftInputs.js';
import type { DraftOrigin, DraftRow } from '../services/onboarding/draftStore.js';
import type { ViewAudience } from '../services/onboarding/draftTypes.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

/** What a missing table or column means here: the tenant-onboarding migration (v34) is not applied. */
export const DRAFT_MIGRATION_HINT = 'The database is missing migration v34 (src/config/migration_v34_onboarding.sql). Apply it with `npm run migrate`, then try again.';

export interface DraftReply {
    status: number;
    body: Record<string, unknown>;
}

const reply = (status: number, body: Record<string, unknown>): DraftReply => ({ status, body });
const view = (row: DraftRow, audience: ViewAudience) => toDraftView(row, { audience, nowMs: Date.now() });

interface CreatorFacts {
    instagram_username: string | null;
    website_url: string | null;
    /** The tenant has its own Instagram connection (a page id and a token): a draft reads its account with its own token. */
    connected: boolean;
    /** Whether the tenant is still in its wizard. A tenant with no `onboarding` row reads as completed (D14): a gate never catches one it does not know. */
    onboardingOpen: boolean;
}

/**
 * What the tenant's own row says, and where it is in its wizard, in one query (a wizard polls this every few seconds): the handle and
 * the site the operator typed at creation, whether Meta is connected, whether onboarding is still open. Null: no such tenant.
 */
async function creatorFacts(creatorId: string): Promise<CreatorFacts | null> {
    const { rows } = await pool.query<{ instagram_username: string | null; website_url: string | null; connected: boolean; onboarding_status: string | null }>(
        `SELECT c.instagram_username, c.website_url, (c.instagram_page_id IS NOT NULL AND c.page_access_token IS NOT NULL) AS connected, o.status AS onboarding_status
           FROM creators c LEFT JOIN onboarding o ON o.creator_id = c.id WHERE c.id = $1`,
        [creatorId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
        instagram_username: row.instagram_username ?? null, website_url: row.website_url ?? null, connected: row.connected === true,
        onboardingOpen: row.onboarding_status === 'invited' || row.onboarding_status === 'in_progress',
    };
}

const NOT_FOUND = reply(404, { error: 'Tenant not found.', code: 'TENANT_NOT_FOUND' });
const COMPLETED = reply(409, {
    error: 'This tenant has finished onboarding. Drafts are for the wizard; ask the operator to make a new one.',
    code: 'ONBOARDING_COMPLETED',
});

export interface Actor {
    audience: ViewAudience;
    userId: string | null;
    session: Request['session'];
    /** The tenant routes are for a tenant in its wizard; the admin's are not gated. */
    gateOnboarding: boolean;
    /** What a draft started here is called: `wizard` for the tenant, `admin_create` for the operator's first, `redraft` after. */
    origin: (hadDraft: boolean) => DraftOrigin;
}

// ─── The handlers: what each door does, as a status and a body ──────────────────────────────

/** The tenant exists, and (for the tenant's own door) its wizard is open: the facts, or the answer to give instead. */
async function admit(creatorId: string, actor: Actor): Promise<{ facts: CreatorFacts } | { refusal: DraftReply }> {
    const facts = await creatorFacts(creatorId);
    if (!facts) return { refusal: NOT_FOUND };
    if (actor.gateOnboarding && !facts.onboardingOpen) return { refusal: COMPLETED };
    return { facts };
}

export async function getDraftFor(creatorId: string, actor: Actor): Promise<DraftReply> {
    const admitted = await admit(creatorId, actor);
    if ('refusal' in admitted) return admitted.refusal;
    const row = await currentDraft(creatorId);
    return reply(200, { draft: row ? view(row, actor.audience) : null });
}

/** Start a draft from the body, falling back on what the operator typed at creation. Audited when it makes a new one. */
export async function startDraftFor(creatorId: string, body: unknown, actor: Actor): Promise<DraftReply> {
    const admitted = await admit(creatorId, actor);
    if ('refusal' in admitted) return admitted.refusal;
    const { facts } = admitted;
    const road: InstagramRoad = facts.connected ? 'own_token' : 'discovery';
    const read = readDraftInputs(body, { instagram: facts.instagram_username, website: facts.website_url }, road);
    if (!read.ok) return reply(400, { error: read.error, code: 'INVALID_INPUT', field: read.field });
    const force = actor.audience === 'admin' && typeof body === 'object' && body !== null && (body as Record<string, unknown>).force === true;

    const had = await currentDraft(creatorId);
    const started = await startDraft({ creatorId, inputs: read.value, origin: actor.origin(had !== null), requestedBy: actor.userId, force });
    if (!started.reused) {
        await writeAudit(await actorFromSession(actor.session), {
            action: AUDIT_ACTIONS.onboardingDraftStart, targetType: 'creator', targetId: creatorId,
            detail: {
                draft_id: started.row.id, origin: started.row.origin, superseded: started.superseded, forced: force,
                instagram: Boolean(read.value.instagram), website: Boolean(read.value.website), youtube: Boolean(read.value.youtube), about: Boolean(read.value.about), via: read.value.via,
            },
        });
    }
    return reply(started.reused ? 200 : 201, { draft: view(started.row, actor.audience), reused: started.reused, superseded: started.superseded });
}

export interface AdvanceReply extends DraftReply {
    /** For the caller's own logging; not part of the body. */
    draftId: string | null;
}

/**
 * Do the next steps of the tenant's current draft. `startIfNone` is the operator's door: the Tenants screen fires `advance` right
 * after creating a tenant, when there is nothing to advance yet, so it makes the draft from what was typed.
 */
export async function advanceDraftFor(creatorId: string, body: unknown, actor: Actor, startIfNone: boolean): Promise<AdvanceReply> {
    const wrap = (r: DraftReply, draftId: string | null = null): AdvanceReply => ({ ...r, draftId });
    const admitted = await admit(creatorId, actor);
    if ('refusal' in admitted) return wrap(admitted.refusal);

    let row = await currentDraft(creatorId);
    if (!row) {
        if (!startIfNone) return wrap(reply(404, { error: 'There is no draft to advance. Start one first.', code: 'NO_DRAFT' }));
        const started = await startDraftFor(creatorId, body, actor);
        if (started.status >= 400) return wrap(started);
        row = await currentDraft(creatorId);
        if (!row) return wrap(reply(500, { error: 'The draft was made and could not be read back.' }));
    }
    const result = await advanceDraft(row.id);
    const after = result.row ?? row;
    return wrap(reply(200, {
        draft: view(after, actor.audience),
        advance: { outcome: result.outcome, steps: result.steps, elapsed_ms: result.elapsed_ms },
    }), after.id);
}

// ─── Express ────────────────────────────────────────────────────────────────────────────────

/**
 * Every route's error handling, once: the engine's refusals as they are, a missing table as the migration hint, anything else a logged 500.
 * `advance: true` also logs the one line that answers "does Vercel stop the work when the browser goes away" (plan §5): it fires if the
 * client left before the answer was sent, and an `onboarding.draft_advance` after it proves the work went on.
 */
export function guard(event: string, fallback: string, fn: (req: Request, res: Response) => Promise<DraftReply | AdvanceReply>, options: { advance?: boolean } = {}) {
    return async (req: Request, res: Response): Promise<void> => {
        const started = Date.now();
        if (options.advance && typeof res.on === 'function') {
            res.on('close', () => {
                if (!res.writableFinished) log('warn', 'onboarding.advance_client_gone', { path: req.path, elapsed_ms: Date.now() - started });
            });
        }
        try {
            const out = await fn(req, res);
            res.status(out.status).json(out.body);
        } catch (err) {
            if (err instanceof DraftError) {
                res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
                return;
            }
            log('error', event, describeError(err));
            if (isMissingSchema(err)) {
                res.status(500).json({ error: DRAFT_MIGRATION_HINT, migrationPending: true });
                return;
            }
            res.status(500).json({ error: fallback });
        }
    };
}

/** The tenant's own door. Its actor: the signed-in owner, answered the tenant's view. */
function tenantActor(req: Request): Actor {
    return { audience: 'tenant', userId: req.session?.userId ?? null, session: req.session, gateOnboarding: true, origin: () => 'wizard' };
}

/** The operator's door, for any tenant. */
export function adminActor(req: Request): Actor {
    return { audience: 'admin', userId: req.session?.userId ?? null, session: req.session, gateOnboarding: false, origin: (hadDraft) => (hadDraft ? 'redraft' : 'admin_create') };
}

export const onboardingDraftsRouter = Router();

/** Owner of the tenant: the person doing the wizard. A `viewer` or `operator` membership does not make a draft for the account. */
const canDraft = requireTenantRole('owner');

onboardingDraftsRouter.use((_req, res, next) => {
    // A poll answers about one person's business: it belongs in no shared cache.
    res.setHeader('Cache-Control', 'no-store');
    next();
});

onboardingDraftsRouter.get('/draft', canDraft, guard('onboarding.draft_read_failed', 'Failed to read the draft.', (req) => getDraftFor(getTenantId(req), tenantActor(req))));
onboardingDraftsRouter.post('/draft', canDraft, guard('onboarding.draft_start_failed', 'Failed to start the draft.', (req) => startDraftFor(getTenantId(req), req.body, tenantActor(req))));
onboardingDraftsRouter.post('/draft/advance', canDraft, guard('onboarding.draft_advance_failed', 'Failed to advance the draft.', (req) => advanceDraftFor(getTenantId(req), req.body, tenantActor(req), false), { advance: true }));
