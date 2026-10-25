/**
 * The split tests' ports (studies.ts `StudyPorts`) wired to the real modules: the settings and health of A1, the stored copy, queue and
 * switches of A2, the money rule, and A7's `ads_proposals`. Nothing here decides anything; studies.ts does.
 */
import { pool } from '../../config/db.js';
import { getObject as mirrorObject } from './mirror.js';
import { ownObject, requestBudget, requestStatus, type ActionContext } from './actions.js';
import { adsGet } from './graph.js';
import { moneyFor, roundMoney } from './money.js';
import { enqueueAndTryInline, getOp, type OpView } from './ops.js';
import { insertProposal } from './proposals/store.js';
import { readAdsSettings, readHealth, saveAdsSettings } from './settings.js';
import { pgStudyStore } from './studiesStore.js';
import { StudyError, type StudyOp, type StudyPorts } from './studies.js';
import { loadProfile } from '../profile/store.js';

const asOp = (v: OpView): StudyOp => ({ id: v.id, kind: v.kind, state: v.state, notBefore: v.notBefore, result: v.result });

const ctxOf = (creatorId: string, userId: string | null): ActionContext => ({ creatorId, actor: { userId, via: 'owner' }, wait: false });

async function tokenOf(creatorId: string): Promise<{ token: string; adAccountId: string }> {
    const { settings, token } = await readAdsSettings(creatorId);
    if (!token || !settings.adAccountId) throw new StudyError(409, 'ADS_NOT_CONFIGURED', 'Connect the ad account first.');
    return { token, adAccountId: settings.adAccountId };
}

export const studyPorts: StudyPorts = {
    store: pgStudyStore,

    async account(creatorId) {
        const [{ settings, token }, health, stored] = await Promise.all([readAdsSettings(creatorId), readHealth(creatorId), loadProfile(creatorId)]);
        if (!token || !settings.adAccountId || !settings.monthlyCap || !settings.maxDailyBudget) return null;
        return {
            adAccountId: settings.adAccountId,
            timezoneOffsetHours: health.account?.timezoneOffsetHours ?? 0,
            businessId: settings.businessId,
            lang: stored.profile.language?.primary === 'en' ? 'en' : 'ar',
        };
    },

    async saveBusinessId(creatorId, businessId) {
        const { settings } = await readAdsSettings(creatorId);
        await saveAdsSettings(creatorId, { settings: { businessId } }, settings, null);
    },

    async listBusinesses(creatorId) {
        const { token, adAccountId } = await tokenOf(creatorId);
        const res = await adsGet('me/businesses', { fields: 'id,name', limit: '25' }, token, { label: 'ads.study_businesses', creatorId, adAccountId });
        const list: unknown = res.data?.data;
        return Array.isArray(list)
            ? list.filter((b) => b && (typeof b.id === 'string' || typeof b.id === 'number')).map((b) => ({ id: String(b.id), name: typeof b.name === 'string' ? b.name : String(b.id) }))
            : [];
    },

    async graphGet(creatorId, path, params) {
        const { token, adAccountId } = await tokenOf(creatorId);
        return (await adsGet(path, params, token, { label: 'ads.study_results', creatorId, adAccountId })).data;
    },

    async getObject(creatorId, id) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
        const row = await mirrorObject(creatorId, id);
        if (!row) return null;
        return {
            id: row.id, level: row.level, metaId: row.metaId, name: row.name, status: row.status, parentId: row.parentId,
            budgetKind: row.budgetKind, budgetAmount: row.budgetAmount, currency: row.currency, adAccountId: row.adAccountId,
        };
    },

    async money(creatorId, candidate) {
        const { settings, token } = await readAdsSettings(creatorId);
        const limits = settings.adAccountId && settings.monthlyCap && settings.maxDailyBudget
            ? { adAccountId: settings.adAccountId, monthlyCap: settings.monthlyCap, maxDailyBudget: settings.maxDailyBudget }
            : null;
        const a = await moneyFor(creatorId, limits, token, { kind: 'lifetime', amount: roundMoney(candidate.amount), days: candidate.days });
        return { fits: a.fits, reason: a.reason, remaining: a.remaining, currency: a.currency ?? '' };
    },

    enqueue: async (input) => asOp(await enqueueAndTryInline(input)),

    async setStatus(creatorId, objectId, status, userId) {
        const { settings } = await readAdsSettings(creatorId);
        const row = await ownObject(creatorId, settings.adAccountId, objectId);
        // `confirm` is the owner's answer to the start dialog, which named the money; a pause needs none.
        return asOp(await requestStatus(ctxOf(creatorId, userId), row, status, status === 'ACTIVE'));
    },

    async setDailyBudget(creatorId, objectId, amount, userId) {
        const { settings } = await readAdsSettings(creatorId);
        const row = await ownObject(creatorId, settings.adAccountId, objectId);
        return asOp((await requestBudget(ctxOf(creatorId, userId), row, { kind: 'daily', amount })).op);
    },

    async getOp(creatorId, id) {
        const op = await getOp(creatorId, id);
        return op ? asOp(op) : null;
    },

    async createProposal(creatorId, p) {
        const row = await insertProposal(pool, {
            creatorId, kind: p.kind, source: p.source, state: p.state, payload: p.payload, rationale: p.rationale, evidence: p.evidence,
        });
        return { id: row.id };
    },

    now: () => new Date(),
};
