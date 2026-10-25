/**
 * The ports of the proposals module, wired to the phases that built them. One place, so a test can swap any of them
 * (`setProposalPorts`) and the rest of the module never imports A1–A5 directly.
 *
 *   policy   A4  `checkPolicy` and `POLICY_RULES` (ads/policy.ts): pure, bilingual.
 *   money    A1  `moneyFor` (ads/money.ts), the same rule as `GET /api/ads/money`. Reads Meta (cached a minute): never in a transaction.
 *   mirror   A2  the stored copy: `ads_objects` and `ads_insights_daily`, Postgres only. Campaigns and ad sets, with 7-day totals.
 *   apply    A4/A5  `createDraft` (ads/drafts.ts: every object PAUSED, one chain of create ops) and A2's object actions (ads/actions.ts:
 *               pause, budget). Every op this enqueues is tagged with the proposal (`ads_ops.proposal_id`, actor `via: 'proposal'`).
 *   tenants  A1  `ads.enabled.<t>`: whom the daily review runs for.
 *   alerts   A1  `notifyAds` (ads/notify.ts): `proposal_ready`, once a day per tenant.
 */
import { queryRows } from '../../../db/query.js';
import { describeError, log } from '../../../utils/log.js';
import { ownObject, requestBudget, requestStatus, type ActionContext } from '../actions.js';
import { createDraft, validateDraft } from '../drafts.js';
import { listObjects, resultsFor, type ObjectRow } from '../mirror.js';
import { moneyFor } from '../money.js';
import { notifyAds } from '../notify.js';
import { checkPolicy, POLICY_RULES } from '../policy.js';
import { readAccountTimezone } from '../results.js';
import { readAdsSettings, readHealth } from '../settings.js';
import { TENANT_SETTING_PREFIXES } from '../../appSettings.js';
import {
    ProposalError, type AlertsPort, type ApplyPort, type InputObject, type MirrorPort, type MoneyPort, type PolicyPort, type ProposalPorts,
    type ReviewItem, type TenantsPort,
} from './types.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ─── policy (A4) ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const policyPort: PolicyPort = {
    rules: (lang) => POLICY_RULES.map((r) => ({ id: r.id, severity: r.severity, description: r.explain[lang] })),
    check: (fields, lang) => checkPolicy(Object.fromEntries(fields.map((f) => [f.field, f.text]))).findings.map((f) => ({
        ruleId: f.ruleId, severity: f.severity, field: f.field, message: `${f.explain[lang]} («${f.match}»)`,
    })),
};

// ─── money (A1) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const moneyPort: MoneyPort = {
    async check(creatorId, candidate) {
        const { settings, token } = await readAdsSettings(creatorId);
        const limits = settings.adAccountId && settings.monthlyCap && settings.maxDailyBudget
            ? { adAccountId: settings.adAccountId, monthlyCap: settings.monthlyCap, maxDailyBudget: settings.maxDailyBudget }
            : null;
        const a = await moneyFor(creatorId, limits, token, candidate ? { kind: candidate.kind, amount: round2(candidate.amount), days: candidate.days } : null);
        return { fits: a.fits, currency: a.currency, remaining: a.remaining, maxDailyBudget: a.maxDailyBudget, monthlyCap: a.monthlyCap, reason: a.reason };
    },
    async minimumDaily(creatorId) {
        // A1's stored account read (the daily health check): Meta's minimum for an impressions-billed ad set, the floor for every goal.
        const min = (await readHealth(creatorId)).account?.minDailyBudget ?? null;
        const out: Record<string, number> = {};
        if (min !== null) for (const goal of ['messages', 'engagement', 'reach', 'traffic']) out[goal] = min;
        return out;
    },
};

// ─── mirror (A2) ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The most objects one input carries: enough for any small account, and a prompt that stays small. */
export const MAX_INPUT_OBJECTS = 40;

function dayIn(zone: string, at: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function goalOf(row: ObjectRow): string | null {
    const g = row.appMeta['goal'];
    return typeof g === 'string' ? g : row.optimizationGoal ?? row.objective ?? null;
}

export const mirrorPort: MirrorPort = {
    async snapshot(creatorId) {
        const [health, zone] = await Promise.all([readHealth(creatorId), readAccountTimezone(creatorId)]);
        const live = ['ACTIVE', 'PAUSED'];
        const [campaigns, adsets] = await Promise.all([
            listObjects(creatorId, { level: 'campaign', status: live }),
            listObjects(creatorId, { level: 'adset', status: live }),
        ]);
        const rows = [...campaigns, ...adsets].slice(0, MAX_INPUT_OBJECTS);
        const now = new Date();
        const to = dayIn(zone, now);
        const from = dayIn(zone, new Date(now.getTime() - 6 * 86_400_000));
        const totalsFor = async (level: 'campaign' | 'adset', list: ObjectRow[]) =>
            (await resultsFor(creatorId, level, list.map((r) => r.metaId).filter((m): m is string => !!m), from, to)).totals;
        const [ct, at] = await Promise.all([totalsFor('campaign', rows.filter((r) => r.level === 'campaign')), totalsFor('adset', rows.filter((r) => r.level === 'adset'))]);

        const objects: InputObject[] = rows.map((r) => {
            const t = r.metaId ? (r.level === 'campaign' ? ct : at).get(r.metaId) : undefined;
            const results = t ? (t.conversations || t.leads || t.linkClicks || null) : null;
            const per = (count: number | null): number | null => (t && count ? round2(t.spend / count) : null);
            return {
                id: r.id,
                level: r.level === 'campaign' ? 'campaign' : 'adset',
                name: r.name ?? '',
                goal: goalOf(r),
                status: r.effectiveStatus ?? r.status ?? 'UNKNOWN',
                budget: { kind: r.budgetKind, amount: r.budgetAmount },
                targetingSummary: r.targetingSummary,
                last7d: {
                    spend: t ? t.spend : null,
                    results,
                    costPerResult: per(results),
                    conversations: t ? t.conversations : null,
                    costPerConversation: per(t ? t.conversations : null),
                    ctr: t && t.impressions > 0 ? round2((t.linkClicks / t.impressions) * 100) : null,
                    frequency: null,
                    trackedClicks: null,
                    handoffs: null,
                },
            };
        });
        const days = await queryRows<{ n: number | string }>(
            `SELECT COUNT(DISTINCT day)::int AS n FROM ads_insights_daily WHERE creator_id = $1 AND level = 'ad' AND spend > 0`, [creatorId],
        );
        return { currency: health.account?.currency ?? null, timezone: zone, objects, audiences: [], daysOfData: Number(days[0]?.n ?? 0) };
    },
};

// ─── apply (A4/A5 builder, A2 actions) ─────────────────────────────────────────────────────────────────────────────────

/** Tag what approving a proposal enqueued: its ops carry `proposal_id`, its new objects say `origin: 'proposal'`. */
async function tag(creatorId: string, proposalId: string, opIds: string[], objectIds: string[]): Promise<void> {
    if (opIds.length) {
        await queryRows(`UPDATE ads_ops SET proposal_id = $1 WHERE creator_id = $2 AND id = ANY($3::uuid[]) RETURNING id`, [proposalId, creatorId, opIds]);
    }
    if (objectIds.length) {
        await queryRows(
            `UPDATE ads_objects SET origin = 'proposal', app_meta = app_meta || jsonb_build_object('proposal_id', $1::text)
              WHERE creator_id = $2 AND id = ANY($3::uuid[]) AND origin = 'app' RETURNING id`,
            [proposalId, creatorId, objectIds],
        );
    }
}

const actionCtx = (creatorId: string, ctx: { proposalId: string; userId: string | null }, step: number): ActionContext => ({
    creatorId, actor: { userId: ctx.userId, via: 'proposal' }, requestId: `p${ctx.proposalId.replace(/-/g, '')}s${step}`, wait: false,
});

export const applyPort: ApplyPort = {
    async validateSpec(creatorId, spec) {
        const v = await validateDraft(creatorId, spec);
        if (v.problems.length) return { ok: false, error: v.problems.map((p) => `${p.field}: ${p.message}`).join('; ') };
        if (v.policy.blocked) return { ok: false, error: 'POLICY_BLOCKED' };
        if (v.money && !v.money.fits) return { ok: false, error: v.money.reason ?? 'OVER_MONTHLY_CAP' };
        return { ok: !!v.meta?.ok, error: v.meta?.ok ? null : v.meta?.error ?? 'Meta did not accept it.' };
    },

    async createFromSpec(creatorId, spec, ctx) {
        // Warnings were shown on the card the owner approved: approving confirms them. A block is still refused by createDraft.
        const created = await createDraft(creatorId, spec, { confirmPolicyWarnings: true, actor: { userId: ctx.userId, via: 'proposal' } });
        const opIds = created.ops.map((o) => o.id);
        await tag(creatorId, ctx.proposalId, opIds, [...new Set(created.ops.map((o) => o.objectKey))]).catch((err) => {
            log('warn', 'ads.proposal_tag_failed', { creator_id: creatorId, proposal_id: ctx.proposalId, ...describeError(err) });
        });
        return { ops: created.ops.map((o) => ({ id: o.id, state: o.state, kind: o.kind })) };
    },

    async applyChange(creatorId, item: ReviewItem, ctx) {
        const { settings } = await readAdsSettings(creatorId);
        const ops: { id: string; state: string; kind: string }[] = [];
        const push = (op: { id: string; state: string; kind: string }) => ops.push({ id: op.id, state: op.state, kind: op.kind });
        let step = 0;
        const change = item.change;
        if ('spec' in change) {
            return applyPort.createFromSpec(creatorId, change.spec, ctx);
        }
        if ('from' in change) {
            // The cut first: if the raise is then refused, the account spends less, never more.
            const from = await ownObject(creatorId, settings.adAccountId, change.from);
            const to = await ownObject(creatorId, settings.adAccountId, change.to);
            if (from.budgetAmount === null || to.budgetAmount === null) throw new ProposalError(409, 'INVALID', 'A budget in this change is not in the stored copy; refresh and ask again.');
            push((await requestBudget(actionCtx(creatorId, ctx, step++), from, { amount: round2(from.budgetAmount - change.amount) })).op);
            push((await requestBudget(actionCtx(creatorId, ctx, step++), to, { amount: round2(to.budgetAmount + change.amount), confirm: true })).op);
        } else {
            for (const id of item.targets) {
                const row = await ownObject(creatorId, settings.adAccountId, id);
                if (item.kind === 'resume') {
                    // Switching back on spends: confirmed by the approval, and requestStatus re-runs the money rule (A9 rule proposals).
                    push(await requestStatus(actionCtx(creatorId, ctx, step++), row, 'ACTIVE', true));
                } else if (item.kind === 'pause' || change.percent <= -100) {
                    push(await requestStatus(actionCtx(creatorId, ctx, step++), row, 'PAUSED', false));
                } else {
                    if (row.budgetAmount === null) throw new ProposalError(409, 'INVALID', 'This budget is not in the stored copy; refresh and ask again.');
                    push((await requestBudget(actionCtx(creatorId, ctx, step++), row, { amount: round2(row.budgetAmount * (1 + change.percent / 100)), confirm: true })).op);
                }
            }
        }
        await tag(creatorId, ctx.proposalId, ops.map((o) => o.id), []).catch((err) => {
            log('warn', 'ads.proposal_tag_failed', { creator_id: creatorId, proposal_id: ctx.proposalId, ...describeError(err) });
        });
        return { ops };
    },
};

// ─── tenants and alerts (A1) ────────────────────────────────────────────────────────────────────────────────────────────

export const tenantsPort: TenantsPort = {
    async enabled() {
        const rows = await queryRows<{ key: string }>("SELECT key FROM app_settings WHERE key LIKE 'ads.enabled.%' AND value = 'true'");
        return rows.map((r) => r.key.slice(TENANT_SETTING_PREFIXES.adsEnabled.length)).filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id));
    },
};

export const alertsPort: AlertsPort = {
    async send(creatorId, kind, objectKey, detail) {
        const [{ settings }, health] = await Promise.all([readAdsSettings(creatorId), readHealth(creatorId)]);
        const titles = Array.isArray(detail['titles']) ? (detail['titles'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
        await notifyAds(
            { kind, count: Number(detail['count'] ?? titles.length) || titles.length, titles },
            { creatorId, adAccountId: settings.adAccountId, accountName: health.account?.name ?? null, offsetHours: health.account?.timezoneOffsetHours ?? 0 },
            { objectKey },
        );
    },
};

// ─── The registry ───────────────────────────────────────────────────────────────────────────────────────────────────────

const WIRED: ProposalPorts = { policy: policyPort, money: moneyPort, mirror: mirrorPort, apply: applyPort, tenants: tenantsPort, alerts: alertsPort };
let current: ProposalPorts = { ...WIRED };

export function getProposalPorts(): ProposalPorts {
    return current;
}

/** Tests: replace some ports; returns what was in force, to restore. `setProposalPorts(null)` puts the wired ones back. */
export function setProposalPorts(next: Partial<ProposalPorts> | null): ProposalPorts {
    const previous = current;
    current = next === null ? { ...WIRED } : { ...current, ...next };
    return previous;
}
