/**
 * AI proposals (A7, spec Story 3): request, draft, check, approve, reject, expire, and the daily review.
 *
 * Who drafts (research R13, corrected 2026-10-22):
 *   - **The owner** (and any tenant on `studio.mac_brain_tenants`): a Studio `ads_think` job, answered by Claude Code on his Mac, on his
 *     own plan ("Claude, never Gemini"; never his API key). The providers layer REFUSES Mac-brain tenants, so they never reach it.
 *   - **Every other tenant**: the providers layer, purposes `ads_draft` / `ads_review`, on the key configured for it. With none, the
 *     request is refused up front with `AI_NOT_CONFIGURED`.
 * Both paths share the input (aggregates only, FR-049), the prompt, the schema and the checks.
 *
 *   requestProposal   a `drafting` row, then `queueAdvance` → the `ads.draft` app job → `advanceProposal`.
 *   advanceProposal   idempotent: reads the row and its latest `ads_think` job and does what is next (queue the Mac job, wait, read the
 *                     answer; or ask the provider), then `runChecks`: one regeneration on a schema or policy failure, `failed` after.
 *   approveProposal   `confirm`, re-runs policy and money (`recheckForApproval`), Meta's `validate_only` for a new campaign, then enqueues
 *                     the ops (a new campaign PAUSED; a change exactly the ops it lists), each tagged with the proposal → `applying`.
 *   settleApplying    `applying` → `applied` when every op is done, `failed` when one failed.
 *   rejectProposal    `open` → `rejected`, nothing enqueued.
 *   runDailyReview    the daily cron: tenants with ads on and ≥ 3 days of results, one review a day, at most 3 proposals.
 *
 * Nothing spends or changes at Meta before a person approves: the only writes before that are to `ads_proposals` and `studio_jobs`.
 */
import { pool } from '../../../config/db.js';
import { queryOne, queryRows } from '../../../db/query.js';
import { describeError, log } from '../../../utils/log.js';
import { resolveRoute } from '../../aiProviders/route.js';
import { generate } from '../../aiProviders/generate.js';
import { isAiError } from '../../llm/errors.js';
import { jsonSchemaFor } from '../../llm/schema.js';
import { isMacBrainAllowed } from '../../macBrain.js';
import { THINK_MODEL } from '../../monteur/think.js';
import { enqueueJob } from '../../studio/jobs.js';
import { publishedPlatforms } from '../../publishedIds.js';
import { validateSpec } from '../spec.js';
import { queueAdvance } from './advance.js';
import { recheckForApproval, runChecks } from './checks.js';
import { buildInput, type InputDeps } from './input.js';
import { getProposalPorts } from './ports.js';
import { buildPrompt } from './prompt.js';
import { schemaFor } from './schema.js';
import {
    countDailyReviewSince, getProposal, insertProposal, listProposals, patchProposal, toProposalView, transitionProposal, deleteDrafting,
} from './store.js';
import {
    MAX_DAILY_REVIEW_PROPOSALS, MAX_REQUEST_CHARS, MIN_DAYS_FOR_REVIEW, ProposalError, type CampaignSpec, type ProposalChecks, type ProposalInput,
    type ProposalModel, type ProposalPayload, type ProposalRow, type ProposalTask, type ProposalView,
} from './types.js';

/** One answer, at most: a full campaign spec is a few KB. */
export const PROPOSAL_MAX_TOKENS = 8000;
export const PROPOSAL_TIMEOUT_MS = 120_000;

export const isMacProposalTenant = (creatorId: string): Promise<boolean> => isMacBrainAllowed(creatorId);

const taskOf = (row: Pick<ProposalRow, 'kind'>): ProposalTask => (row.kind === 'change' ? 'review' : 'draft_campaign');
const purposeOf = (task: ProposalTask): 'ads_draft' | 'ads_review' => (task === 'review' ? 'ads_review' : 'ads_draft');

/** The provider layer can answer this tenant's purpose, or the request is refused before a row is written. */
async function assertProviderReady(creatorId: string, task: ProposalTask): Promise<void> {
    try {
        await resolveRoute(purposeOf(task), creatorId);
    } catch (err) {
        if (isAiError(err) && err.kind === 'no_provider') {
            throw new ProposalError(409, 'AI_NOT_CONFIGURED', 'No AI provider is set up for this business: the operator adds one in Operations → AI providers.');
        }
        throw err;
    }
}

// ─── Posts as creatives ─────────────────────────────────────────────────────────────────────────────────────────────────

interface PostRow { id: string; caption: string | null; post_type: string | null; status: string; published_post_id: string | null; platform: string | null }

/** Where the post is published, Instagram first: what an ad built on it can use (`FB:… | IG:…`, publishedIds.ts). */
function platformsOf(row: PostRow): string[] {
    const ids = publishedPlatforms(row.published_post_id);
    return [ids.ig ? 'instagram' : null, ids.fb ? 'facebook' : null].filter((p): p is string => !!p);
}

async function loadPost(creatorId: string, postId: string, platform: string | null): Promise<ProposalInput['post']> {
    if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new ProposalError(404, 'NOT_FOUND', 'No such post.', 'postId');
    const row = await queryOne<PostRow>(
        `SELECT id, caption, post_type, status, published_post_id, platform FROM scheduled_posts WHERE id = $1 AND creator_id = $2`, [postId, creatorId],
    );
    if (!row) throw new ProposalError(404, 'NOT_FOUND', 'No such post.', 'postId');
    if (row.status !== 'PUBLISHED' || platformsOf(row).length === 0) throw new ProposalError(409, 'INVALID', 'Only a published post can be advertised.', 'postId');
    const on = platform && platformsOf(row).includes(platform) ? platform : platformsOf(row)[0] ?? 'instagram';
    const insight = await queryOne<{ metrics: Record<string, unknown> | null }>(
        `SELECT metrics FROM post_insights WHERE creator_id = $1 AND scheduled_post_id = $2 ORDER BY published_at DESC NULLS LAST LIMIT 1`, [creatorId, postId],
    ).catch(() => null);
    const m = insight?.metrics ?? {};
    const num = (k: string): number | null => (typeof m[k] === 'number' && Number.isFinite(m[k]) ? (m[k] as number) : null);
    return { id: row.id, platform: on, caption: row.caption ?? '', kind: (row.post_type ?? 'post').toLowerCase(), organic: { views: num('views'), reach: num('reach'), saves: num('saved'), skipRate: null } };
}

async function recentPosts(creatorId: string): Promise<NonNullable<ProposalInput['recentPosts']>> {
    const rows = await queryRows<PostRow>(
        `SELECT id, caption, post_type, status, published_post_id, platform FROM scheduled_posts
          WHERE creator_id = $1 AND status = 'PUBLISHED' AND archived_at IS NULL ORDER BY scheduled_time DESC LIMIT 5`, [creatorId],
    ).catch(() => [] as PostRow[]);
    return rows.filter((r) => platformsOf(r).length > 0).map((r) => ({ id: r.id, platform: platformsOf(r)[0]!, caption: r.caption ?? '', kind: (r.post_type ?? 'post').toLowerCase() }));
}

/** Tests: how the input reads the tenant's profile (the real store by default). */
let inputDeps: InputDeps | undefined;
export function setProposalInputDeps(next: InputDeps | undefined): void {
    inputDeps = next;
}

async function inputFor(row: ProposalRow): Promise<ProposalInput> {
    const task = taskOf(row);
    const post = row.post_ref ? await loadPost(row.creator_id, row.post_ref.postId, row.post_ref.platform).catch(() => null) : null;
    return buildInput(row.creator_id, {
        task, request: row.request_text, post,
        recentPosts: task === 'draft_campaign' && !post ? await recentPosts(row.creator_id) : undefined,
    }, getProposalPorts(), inputDeps);
}

// ─── Request ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function requestProposal(
    creatorId: string, body: { request?: unknown; postId?: unknown; platform?: unknown; userId: string | null },
): Promise<ProposalView> {
    const request = typeof body.request === 'string' && body.request.trim() ? body.request.trim().slice(0, MAX_REQUEST_CHARS) : null;
    const postId = typeof body.postId === 'string' && body.postId ? body.postId : null;
    const platform = body.platform === 'instagram' || body.platform === 'facebook' ? body.platform : null;
    if (!request && !postId) throw new ProposalError(400, 'INVALID', 'Say what to advertise, or start from a post.', 'request');
    if (postId) await loadPost(creatorId, postId, platform);

    const mac = await isMacProposalTenant(creatorId);
    if (!mac) await assertProviderReady(creatorId, 'draft_campaign');

    const row = await insertProposal(pool, {
        creatorId, kind: 'new_campaign', source: postId ? 'post' : 'request', requestText: request,
        postRef: postId ? { postId, platform: platform ?? 'instagram' } : null,
        model: { via: mac ? 'mac' : 'api', provider: mac ? 'anthropic' : null, model: mac ? THINK_MODEL : null, effort: null, usd: null },
    });
    log('info', 'ads.proposal_requested', { creator_id: creatorId, proposal_id: row.id, source: row.source, via: mac ? 'mac' : 'api' });
    queueAdvance(creatorId, row.id, 'requested', row.id);
    return toProposalView(row);
}

// ─── Advance ────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ThinkJob { id: string; status: 'pending' | 'claimed' | 'done' | 'failed'; result: { output?: unknown; model?: unknown } | null; error: string | null }

async function latestThinkJob(creatorId: string, proposalId: string, attempt: number): Promise<ThinkJob | null> {
    return queryOne<ThinkJob>(
        `SELECT id, status, result, error FROM studio_jobs
          WHERE creator_id = $1 AND kind = 'ads_think' AND payload->>'proposalId' = $2 AND (payload->>'attempt')::int = $3
          ORDER BY created_at DESC LIMIT 1`,
        [creatorId, proposalId, attempt],
    );
}

async function fail(row: ProposalRow, error: string, checks?: ProposalChecks | null): Promise<void> {
    await transitionProposal(null, row.creator_id, row.id, 'failed', { error: error.slice(0, 1000), ...(checks ? { checks } : {}) });
    log('warn', 'ads.proposal_failed', { creator_id: row.creator_id, proposal_id: row.id, error: error.slice(0, 200) });
}

/** The `ads.draft` handler. Never moves a row that is not `drafting`; a throw is retried by the job runner. */
export async function advanceProposal(creatorId: string, proposalId: string): Promise<void> {
    const row = await getProposal(creatorId, proposalId);
    if (!row || row.state !== 'drafting') return;
    const task = taskOf(row);
    const input = await inputFor(row);
    const prompt = buildPrompt(input, row.checks?.feedback);
    const schema = schemaFor(task);

    let raw: unknown;
    let model: ProposalModel;
    if (await isMacProposalTenant(creatorId)) {
        const job = await latestThinkJob(creatorId, row.id, row.attempt);
        if (!job) {
            await enqueueJob(pool, creatorId, 'ads_think', {
                proposalId: row.id, attempt: row.attempt, task, purpose: purposeOf(task), model: THINK_MODEL,
                system: prompt.system, user: prompt.user, schema: jsonSchemaFor(schema),
            });
            log('info', 'ads.proposal_mac_queued', { creator_id: creatorId, proposal_id: row.id, attempt: row.attempt });
            return;
        }
        if (job.status === 'pending' || job.status === 'claimed') return;
        if (job.status === 'failed') { await fail(row, `Claude on the Mac could not draft it: ${job.error ?? 'the job failed'}`); return; }
        raw = job.result?.output;
        model = { via: 'mac', provider: 'anthropic', model: typeof job.result?.model === 'string' ? job.result.model : THINK_MODEL, effort: null, usd: null };
    } else {
        try {
            const answer = await generate({
                purpose: purposeOf(task), creatorId, system: prompt.system, user: prompt.user, schema,
                maxTokens: PROPOSAL_MAX_TOKENS, timeoutMs: PROPOSAL_TIMEOUT_MS, cacheSystem: true,
            });
            raw = answer.json;
            model = { via: 'api', provider: answer.provider, model: answer.model, effort: answer.effort, usd: answer.usd };
        } catch (err) {
            if (isAiError(err) && err.kind === 'no_provider') { await fail(row, 'AI_NOT_CONFIGURED: no AI provider is set up for this business.'); return; }
            if (isAiError(err) && !err.retryable) { await fail(row, `The AI provider refused: ${err.message}`); return; }
            throw err;
        }
    }

    const outcome = await runChecks({ task, raw, input, attempt: row.attempt, creatorId, ports: getProposalPorts() });
    if (outcome.kind === 'regenerate') { await regenerate(row, outcome.reason, outcome.feedback); return; }
    if (outcome.kind === 'failed') { await fail(row, outcome.reason, outcome.checks); return; }

    // The checks passed: the builder's own validation is the last word on a spec (it is what approve will create).
    for (const item of outcome.items) {
        const spec = item.payload.task === 'draft_campaign' ? item.payload.spec : 'spec' in item.payload.item.change ? item.payload.item.change.spec : null;
        if (!spec) continue;
        const v = validateSpec(spec);
        if (!v.ok) {
            const problems = v.problems.map((p) => `spec.${p.field}: ${p.message}`);
            if (row.attempt <= 1) { await regenerate(row, 'spec', problems); return; }
            await fail(row, `The campaign could not be built: ${problems.join('; ')}`, item.checks);
            return;
        }
    }

    if (outcome.items.length === 0) {
        await deleteDrafting(creatorId, row.id);
        log('info', 'ads.proposal_nothing_to_propose', { creator_id: creatorId, proposal_id: row.id });
        return;
    }
    const [first, ...rest] = outcome.items;
    const opened = [await transitionProposal(null, creatorId, row.id, 'open', {
        payload: first!.payload, rationale: first!.rationale, evidence: first!.evidence, effect: first!.effect, checks: first!.checks, model,
    })];
    for (const item of rest) {
        opened.push(await insertProposal(pool, {
            creatorId, kind: item.kind, source: row.source, requestText: row.request_text, postRef: row.post_ref, state: 'open',
            payload: item.payload, rationale: item.rationale, evidence: item.evidence, effect: item.effect, checks: item.checks, model,
        }));
    }
    log('info', 'ads.proposal_open', { creator_id: creatorId, proposal_id: row.id, count: opened.length, via: model.via });
    if (row.source === 'daily_review') {
        const alerts = getProposalPorts().alerts;
        if (alerts) {
            await alerts.send(creatorId, 'proposal_ready', 'daily_review', { count: opened.length, titles: opened.map((p) => p.rationale ?? '') })
                .catch((err) => log('warn', 'ads.proposal_alert_failed', { creator_id: creatorId, ...describeError(err) }));
        }
    }
}

async function regenerate(row: ProposalRow, reason: 'schema' | 'policy' | 'spec', feedback: string[]): Promise<void> {
    const next = await patchProposal(row.creator_id, row.id, 'drafting', {
        attempt: 2, checks: { ...(row.checks ?? { policy: [], money: { ok: true, reason: null, note: null }, meta_validate: null }), regenerated: reason, feedback: feedback.slice(0, 30) },
    });
    log('info', 'ads.proposal_regenerate', { creator_id: row.creator_id, proposal_id: row.id, reason, problems: feedback.length });
    if (next) await advanceProposal(row.creator_id, row.id);
}

// ─── Approve, reject, settle ────────────────────────────────────────────────────────────────────────────────────────────

/** The owner's edits on the card: a new campaign's name and budget amount, or a change's percent / amount. Anything bigger is the builder. */
function withEdits(payload: ProposalPayload, edits: unknown): ProposalPayload {
    if (!edits || typeof edits !== 'object') return payload;
    const e = edits as Record<string, unknown>;
    if (payload.task === 'draft_campaign') {
        const spec: CampaignSpec = { ...payload.spec, budget: { ...payload.spec.budget } };
        if (typeof e['name'] === 'string' && e['name'].trim()) spec.name = e['name'].trim().slice(0, 200);
        const budget = e['budget'] as Record<string, unknown> | undefined;
        if (budget && typeof budget['amount'] === 'number' && budget['amount'] > 0) spec.budget.amount = Math.round(budget['amount'] * 100) / 100;
        if (budget && typeof budget['end'] === 'string') spec.budget.end = budget['end'];
        return { ...payload, spec };
    }
    const change = payload.item.change;
    if ('percent' in change && typeof e['percent'] === 'number' && e['percent'] !== 0) return { ...payload, item: { ...payload.item, change: { percent: Math.round(e['percent']) } } };
    if ('from' in change && typeof e['amount'] === 'number' && e['amount'] > 0) return { ...payload, item: { ...payload.item, change: { ...change, amount: Math.round(e['amount'] * 100) / 100 } } };
    return payload;
}

export async function approveProposal(
    creatorId: string, id: string, body: { edits?: unknown; confirm?: unknown; userId: string | null },
): Promise<{ proposal: ProposalView; ops: { id: string; state: string; kind: string }[] }> {
    if (body.confirm !== true) throw new ProposalError(400, 'INVALID', 'Approving creates or changes ads: confirm it.', 'confirm');
    const row = await getProposal(creatorId, id);
    if (!row) throw new ProposalError(404, 'NOT_FOUND', 'No such proposal.');
    if (row.state === 'open' && Date.parse(row.expires_at) <= Date.now()) {
        await transitionProposal(null, creatorId, id, 'expired');
        throw new ProposalError(409, 'INVALID', 'This proposal expired (7 days). Ask for a new one.');
    }
    if (row.state !== 'open' || !row.payload) throw new ProposalError(409, 'INVALID', `This proposal is ${row.state}; only an open one can be approved.`);

    const ports = getProposalPorts();
    if (!ports.policy || !ports.money || !ports.apply) throw new ProposalError(409, 'NOT_WIRED', 'Approving is not available yet on this deployment.');
    const payload = withEdits(row.payload, body.edits);

    // Policy and money again, on what is about to be applied (Meta is read for the money rule: outside any transaction).
    const input = await inputFor(row);
    const recheck = await recheckForApproval({ payload, input, creatorId, ports });
    if (!recheck.ok) {
        throw new ProposalError(recheck.code === 'POLICY_BLOCKED' ? 422 : 409, recheck.code === 'ADS_NOT_CONFIGURED' ? 'ADS_NOT_CONFIGURED' : recheck.code, recheck.message, undefined, recheck.findings);
    }

    const spec = payload.task === 'draft_campaign' ? payload.spec : 'spec' in payload.item.change ? payload.item.change.spec : null;
    let meta: ProposalChecks['meta_validate'] = null;
    if (spec) {
        meta = await ports.apply.validateSpec(creatorId, spec);
        if (!meta.ok) throw new ProposalError(409, 'META_ERROR', `Meta did not accept this campaign: ${meta.error ?? 'no reason given'}. Edit it in the builder.`);
    }

    const now = new Date().toISOString();
    const checks: ProposalChecks = { ...(row.checks ?? recheck.checks), policy: recheck.checks.policy, money: recheck.checks.money, meta_validate: meta };
    await transitionProposal(null, creatorId, id, 'approved', { payload, checks, effect: recheck.effect, decided_by: body.userId, decided_at: now });

    let ops: { id: string; state: string; kind: string }[];
    try {
        const ctx = { proposalId: id, userId: body.userId };
        ops = payload.task === 'draft_campaign'
            ? (await ports.apply.createFromSpec(creatorId, payload.spec, ctx)).ops
            : (await ports.apply.applyChange(creatorId, payload.item, ctx)).ops;
    } catch (err) {
        const message = err instanceof Error ? err.message : 'The change could not be enqueued.';
        await transitionProposal(null, creatorId, id, 'failed', { error: message.slice(0, 1000) }).catch(() => undefined);
        throw err;
    }
    const applying = await transitionProposal(null, creatorId, id, 'applying', { checks: { ...checks, ops: ops.map((o) => o.id) } });
    log('info', 'ads.proposal_approved', { creator_id: creatorId, proposal_id: id, ops: ops.length });
    return { proposal: toProposalView(applying), ops };
}

export async function rejectProposal(creatorId: string, id: string, body: { reason?: unknown; userId: string | null }): Promise<ProposalView> {
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;
    const row = await transitionProposal(null, creatorId, id, 'rejected', { error: reason, decided_by: body.userId, decided_at: new Date().toISOString() });
    log('info', 'ads.proposal_rejected', { creator_id: creatorId, proposal_id: id });
    return toProposalView(row);
}

/** `applying` → `applied` once every op it enqueued is done; → `failed` when one failed or was cancelled. */
export async function settleApplying(creatorId: string): Promise<number> {
    const rows = await listProposals(creatorId, ['applying'], 20);
    let moved = 0;
    for (const row of rows) {
        const ids = row.checks?.ops ?? [];
        if (!ids.length) continue;
        const states = await queryRows<{ state: string }>(`SELECT state FROM ads_ops WHERE creator_id = $1 AND id = ANY($2::uuid[])`, [creatorId, ids]);
        if (states.some((s) => s.state === 'failed' || s.state === 'cancelled')) {
            await transitionProposal(null, creatorId, row.id, 'failed', { error: 'Meta refused a step; see the Campaigns tab for its message.' });
            moved++;
        } else if (states.length === ids.length && states.every((s) => s.state === 'done')) {
            await transitionProposal(null, creatorId, row.id, 'applied');
            moved++;
        }
    }
    return moved;
}

export async function listProposalViews(creatorId: string, states: string[] | null): Promise<ProposalView[]> {
    await settleApplying(creatorId).catch((err) => log('warn', 'ads.proposal_settle_failed', { creator_id: creatorId, ...describeError(err) }));
    const valid = states?.filter((s): s is ProposalRow['state'] => ['drafting', 'open', 'approved', 'applying', 'applied', 'failed', 'rejected', 'expired'].includes(s)) ?? null;
    return (await listProposals(creatorId, valid && valid.length ? valid : null)).map(toProposalView);
}

export async function getProposalView(creatorId: string, id: string): Promise<ProposalView> {
    const row = await getProposal(creatorId, id);
    if (!row) throw new ProposalError(404, 'NOT_FOUND', 'No such proposal.');
    if (row.state === 'applying') await settleApplying(creatorId).catch(() => 0);
    return toProposalView((await getProposal(creatorId, id)) ?? row);
}

// ─── The daily review ───────────────────────────────────────────────────────────────────────────────────────────────────

const startOfUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Once a day (the daily cron): for each tenant with ads on and at least 3 days of results, one review of its running ads, which makes at
 * most 3 proposals (the schema allows 3 items; nothing more is asked the same day). A tenant with no AI for it is skipped quietly.
 */
export async function runDailyReview(now: Date = new Date()): Promise<{ tenants: number; queued: number }> {
    const ports = getProposalPorts();
    if (!ports.tenants || !ports.mirror) return { tenants: 0, queued: 0 };
    const tenants = await ports.tenants.enabled();
    let queued = 0;
    for (const creatorId of tenants) {
        try {
            if ((await countDailyReviewSince(creatorId, startOfUtcDay(now))) >= 1) continue;
            const open = await listProposals(creatorId, ['drafting', 'open'], MAX_DAILY_REVIEW_PROPOSALS + 1);
            if (open.filter((p) => p.source === 'daily_review').length >= MAX_DAILY_REVIEW_PROPOSALS) continue;
            const snapshot = await ports.mirror.snapshot(creatorId);
            if (snapshot.daysOfData < MIN_DAYS_FOR_REVIEW || !snapshot.objects.some((o) => o.status === 'ACTIVE')) continue;
            const mac = await isMacProposalTenant(creatorId);
            if (!mac) {
                try { await assertProviderReady(creatorId, 'review'); } catch { continue; }
            }
            const row = await insertProposal(pool, {
                creatorId, kind: 'change', source: 'daily_review',
                model: { via: mac ? 'mac' : 'api', provider: mac ? 'anthropic' : null, model: mac ? THINK_MODEL : null, effort: null, usd: null },
            });
            queueAdvance(creatorId, row.id, 'requested', row.id);
            queued++;
        } catch (err) {
            log('warn', 'ads.daily_review_failed', { creator_id: creatorId, ...describeError(err) });
        }
    }
    log('info', 'ads.daily_review', { tenants: tenants.length, queued });
    return { tenants: tenants.length, queued };
}
