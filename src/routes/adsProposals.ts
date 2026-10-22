/**
 * AI proposals under `/api/ads/proposals` (A7, contracts/dashboard-api.md "Proposals"; src/services/ads/proposals/). Mounted inside
 * `adsRouter`, so the ADS_DISABLED gate runs first and the tenant is the session's.
 *
 *   POST /proposals               operator+  { request?, postId?, platform? } → 202 { proposal } (drafting). AI_NOT_CONFIGURED without a key
 *   GET  /proposals?state=a,b     viewer+    { proposals }
 *   GET  /proposals/:id           viewer+    { proposal }
 *   POST /proposals/:id/approve   owner      { edits?, confirm: true } → { proposal, ops }. Policy and money re-run; a new campaign is PAUSED
 *   POST /proposals/:id/reject    owner      { reason? } → { proposal }
 *
 * Errors `{ error, code, field?, findings? }`. Nothing here spends: approving enqueues PAUSED creates or exactly the change listed.
 */
import { Router, type Request, type Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { AdsError, metaRefusal } from '../services/adBoosts.js';
import { AdsGraphError } from '../services/ads/graph.js';
import { DraftRefused } from '../services/ads/drafts.js';
import {
    approveProposal, getProposalView, listProposalViews, rejectProposal, requestProposal,
} from '../services/ads/proposals/service.js';
import { ProposalError } from '../services/ads/proposals/types.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

export const adsProposalsRouter = Router();

const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
const userOf = (req: Request): string | null => req.session?.userId ?? null;

function fail(res: Response, err: unknown, what: string): void {
    if (err instanceof ProposalError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}), ...(err.findings ? { findings: err.findings } : {}) });
        return;
    }
    if (err instanceof AdsError || err instanceof AdsGraphError) {
        const r = err instanceof AdsError ? err : metaRefusal(err);
        res.status(r.status).json({
            error: r.message, code: r.code, ...(r.field ? { field: r.field } : {}),
            ...(err instanceof DraftRefused ? { findings: err.findings } : {}),
            ...(r.extra.retryAt ? { retryAt: r.extra.retryAt.toISOString() } : {}),
        });
        return;
    }
    log('error', `ads.proposal_${what}_failed`, describeError(err));
    res.status(500).json({ error: `Failed to ${what} the proposal.` });
}

async function audit(req: Request, id: string, decision: 'approved' | 'rejected', detail: Record<string, unknown>): Promise<void> {
    await writeAudit(await actorFromSession(req.session), {
        action: AUDIT_ACTIONS.adsProposalDecided, targetType: 'ads_proposal', targetId: id, detail: { decision, ...detail },
    }).catch((err) => log('warn', 'ads.proposal_audit_failed', describeError(err)));
}

adsProposalsRouter.post('/proposals', requireTenantRole('operator'), async (req, res) => {
    try {
        const b = body(req);
        const proposal = await requestProposal(getTenantId(req), { request: b['request'], postId: b['postId'], platform: b['platform'], userId: userOf(req) });
        res.status(202).json({ proposal });
    } catch (err) {
        fail(res, err, 'request');
    }
});

adsProposalsRouter.get('/proposals', requireTenantRole('viewer'), async (req, res) => {
    try {
        const raw = typeof req.query['state'] === 'string' ? req.query['state'] : '';
        const states = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
        res.json({ proposals: await listProposalViews(getTenantId(req), states) });
    } catch (err) {
        fail(res, err, 'list');
    }
});

adsProposalsRouter.get('/proposals/:id', requireTenantRole('viewer'), async (req, res) => {
    try {
        res.json({ proposal: await getProposalView(getTenantId(req), String(req.params['id'])) });
    } catch (err) {
        fail(res, err, 'read');
    }
});

adsProposalsRouter.post('/proposals/:id/approve', requireTenantRole('owner'), async (req, res) => {
    const id = String(req.params['id']);
    try {
        const b = body(req);
        const out = await approveProposal(getTenantId(req), id, { edits: b['edits'], confirm: b['confirm'], userId: userOf(req) });
        await audit(req, id, 'approved', { kind: out.proposal.kind, ops: out.ops.map((o) => o.id), worst_case_delta: out.proposal.effect?.worstCaseDelta ?? null });
        res.json(out);
    } catch (err) {
        fail(res, err, 'approve');
    }
});

adsProposalsRouter.post('/proposals/:id/reject', requireTenantRole('owner'), async (req, res) => {
    const id = String(req.params['id']);
    try {
        const proposal = await rejectProposal(getTenantId(req), id, { reason: body(req)['reason'], userId: userOf(req) });
        await audit(req, id, 'rejected', { kind: proposal.kind });
        res.json({ proposal });
    } catch (err) {
        fail(res, err, 'reject');
    }
});
