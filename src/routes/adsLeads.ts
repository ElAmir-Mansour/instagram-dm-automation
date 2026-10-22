/**
 * Lead ads, under `/api/ads` (Ads Manager phase A10; contracts/dashboard-api.md "Leads"). Mounted inside `adsRouter`, so the ADS_DISABLED
 * gate runs first and the tenant is the session's.
 *
 *   GET  /lead-forms   (viewer)  { locked, signoff: { countries, recordedAt } | null, retentionDays, forms, helpUrl }
 *   POST /lead-forms   (owner)   FormInput → 201 { form }. 403 LOCKED_LEGAL without a `lead_ads` sign-off; 400 INVALID / RESTRICTED_QUESTION
 *                                with `field`; 409 NOT_CONNECTED without a Facebook Page; 502 META_ERROR with Meta's sentence. Audited.
 *   GET  /leads        (owner)   ?formId&from&to → { leads, retentionDays }: the answers, decrypted for this answer only
 *   GET  /leads.csv    (owner)   the same leads as a CSV download, AUDITED (who exported how many, never what)
 *
 * The form is created directly with the Page token (`ads/leads.ts`), not through the ops queue: the queue runs on the ADS token, and a lead
 * form is a Page object. Leads are owner-only, reads included: they are other people's personal data, and a viewer has no need of them.
 * Nothing here logs or audits an answer, a name, an email or a phone number.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit, type AuditAction } from '../services/audit.js';
import { createLeadForm, leadsCsv, listLeadForms, listLeads, retentionDays, type FormRefusal, type LeadQuery } from '../services/ads/leads.js';
import { activeSignoff, lockView } from '../services/ads/legalSignoff.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

const HELP_URL = '#/help/ads#leads-and-privacy';

export interface LeadsDeps {
    canRead: RequestHandler;
    canWrite: RequestHandler;
    audit(req: Request, action: AuditAction, detail: Record<string, unknown>): Promise<void>;
}

export const defaultLeadsDeps: LeadsDeps = {
    canRead: requireTenantRole('viewer'),
    canWrite: requireTenantRole('owner'),
    audit: async (req, action, detail) => {
        await writeAudit(await actorFromSession(req.session), { action, targetType: 'creator', targetId: getTenantId(req), detail });
    },
};

const REFUSAL_STATUS: Record<FormRefusal['code'], number> = { INVALID: 400, RESTRICTED_QUESTION: 400, LOCKED_LEGAL: 403, NOT_CONNECTED: 409, META_ERROR: 502 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?formId&from&to`, checked: a bad value is a 400 naming the field, never a database error. */
function readQuery(req: Request): { ok: true; q: LeadQuery } | { ok: false; field: string } {
    const one = (k: string): string | null => { const v = req.query[k]; return typeof v === 'string' && v.trim() ? v.trim() : null; };
    const formId = one('formId');
    if (formId && !UUID.test(formId)) return { ok: false, field: 'formId' };
    const date = (k: 'from' | 'to'): string | null | false => {
        const v = one(k);
        if (!v) return null;
        return Number.isNaN(Date.parse(v)) ? false : new Date(v).toISOString();
    };
    const from = date('from');
    if (from === false) return { ok: false, field: 'from' };
    const to = date('to');
    if (to === false) return { ok: false, field: 'to' };
    return { ok: true, q: { formId, from, to } };
}

function failed(res: Response, err: unknown, what: string): void {
    log('error', `ads.${what}_failed`, describeError(err));
    res.status(500).json({ error: `Failed to ${what.replace(/_/g, ' ')}.` });
}

export function mountLeadRoutes(router: Router, deps: LeadsDeps = defaultLeadsDeps): void {
    router.get('/lead-forms', deps.canRead, async (req, res) => {
        try {
            const creatorId = getTenantId(req);
            const [signoff, forms, days] = await Promise.all([activeSignoff(creatorId, 'lead_ads'), listLeadForms(creatorId), retentionDays(creatorId)]);
            const lock = lockView(signoff);
            res.json({
                locked: lock.locked,
                signoff: lock.locked ? null : { countries: lock.countries, recordedAt: lock.recordedAt },
                retentionDays: days,
                forms,
                helpUrl: HELP_URL,
            });
        } catch (err) {
            failed(res, err, 'list_lead_forms');
        }
    });

    router.post('/lead-forms', deps.canWrite, async (req, res) => {
        try {
            const result = await createLeadForm(getTenantId(req), req.body);
            if (!result.ok) {
                res.status(REFUSAL_STATUS[result.code]).json({ error: result.error, code: result.code, ...(result.field ? { field: result.field } : {}), ...(result.code === 'LOCKED_LEGAL' ? { helpUrl: HELP_URL } : {}) });
                return;
            }
            await deps.audit(req, AUDIT_ACTIONS.adsLeadFormSaved, {
                form_id: result.form.id, meta_id: result.form.metaId, status: result.form.status, questions: result.form.questions.length,
                consent_question: result.form.consentQuestion,
            });
            res.status(201).json({ form: result.form });
        } catch (err) {
            failed(res, err, 'create_lead_form');
        }
    });

    router.get('/leads', deps.canWrite, async (req, res) => {
        try {
            const parsed = readQuery(req);
            if (!parsed.ok) {
                res.status(400).json({ error: `The ${parsed.field} filter is not valid.`, code: 'INVALID', field: parsed.field });
                return;
            }
            const creatorId = getTenantId(req);
            const [leads, days] = await Promise.all([listLeads(creatorId, parsed.q), retentionDays(creatorId)]);
            res.setHeader('Cache-Control', 'no-store');
            res.json({ leads, retentionDays: days });
        } catch (err) {
            failed(res, err, 'list_leads');
        }
    });

    router.get('/leads.csv', deps.canWrite, async (req, res) => {
        try {
            const parsed = readQuery(req);
            if (!parsed.ok) {
                res.status(400).json({ error: `The ${parsed.field} filter is not valid.`, code: 'INVALID', field: parsed.field });
                return;
            }
            const leads = await listLeads(getTenantId(req), { ...parsed.q, limit: 5000 });
            // Audited BEFORE the file leaves: an export that cannot be recorded does not happen.
            await deps.audit(req, AUDIT_ACTIONS.adsLeadsExported, {
                count: leads.length, form_id: parsed.q.formId ?? null, from: parsed.q.from ?? null, to: parsed.q.to ?? null,
            });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).send(leadsCsv(leads));
        } catch (err) {
            failed(res, err, 'export_leads');
        }
    });
}
