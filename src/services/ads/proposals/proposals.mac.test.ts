/**
 * AI proposals end to end against a fake pool (A7, T130–T131): who drafts, the state machine, approve and reject, expiry, the daily review.
 *
 *   - the owner (the Mac-brain tenant) gets a Studio `ads_think` job through `enqueueJob`, and the guard lets it through;
 *   - any other tenant is never given an `ads_think` job: it asks the providers layer (`ads_draft`), and without a key is refused
 *     AI_NOT_CONFIGURED before a row is written;
 *   - the Mac's answer is validated and stored like a server draft (`open`); a schema failure asks the Mac again once;
 *   - drafting → open → approved → applying → applied | failed, rejected, expired after 7 days; anything else is refused;
 *   - approve needs `confirm`, refuses NOT_WIRED without the ports, re-runs policy and money, and hands the ops the proposal id.
 *
 * The ads_proposals and studio_jobs tables are modelled in memory below; Meta, the money rule and the builder are port stubs.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setAiCaller, type AiCaller } from '../../aiProviders/generate.js';
import { setJobQueue } from '../../../jobs/queue.js';
import type { JobQueue } from '../../../jobs/types.js';
import { setLogSink } from '../../../utils/log.js';
import { setWaitUntil } from '../../../utils/waitUntil.js';
import { defaultProfile } from '../../profile/defaults.js';
import { installAdsFakeDb, type AdsFakeDb } from '../testDb.js';
import { setProposalPorts } from './ports.js';
import { advanceProposal, approveProposal, rejectProposal, requestProposal, runDailyReview, setProposalInputDeps, settleApplying } from './service.js';
import { expireProposals, getProposal, transitionProposal } from './store.js';
import { ProposalError, type ApplyPort, type CampaignSpec, type MoneyPort, type PolicyPort, type ProposalPorts } from './types.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TENANT = '44444444-4444-4444-8444-444444444444';
const POST = '22222222-2222-4222-8222-222222222222';
const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY'] as const;

// ─── The tables, in memory ────────────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;
let proposals: Row[];
let studioJobs: Row[];
let opsStates: Map<string, string>;
let ids = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const JSONB = new Set(['post_ref', 'payload', 'evidence', 'effect', 'checks', 'model']);
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const copy = (r: Row): Row => JSON.parse(JSON.stringify(r));

function applySets(row: Row, setClause: string, params: any[]): void {
    for (const part of setClause.split(/,\s*(?=\w+ = )/)) {
        const m = /^(\w+) = (.+)$/.exec(part.trim());
        if (!m) continue;
        const [, col, value] = m;
        const p = /^\$(\d+)/.exec(value!);
        if (p) row[col!] = JSONB.has(col!) ? parse(params[Number(p[1]) - 1]) : params[Number(p[1]) - 1];
        else if (/^NOW\(\)/.test(value!)) row[col!] = new Date();
        else if (/^'(\w+)'$/.test(value!)) row[col!] = /^'(\w+)'$/.exec(value!)![1];
    }
}

function installTables(db: AdsFakeDb): void {
    db.routes.push(
        [/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1/, () => ({ rows: [{ id: OWNER }] })],
        [/^INSERT INTO ads_proposals /, (p) => {
            const row: Row = {
                id: uuid(), creator_id: p[0], kind: p[1], source: p[2], request_text: p[3], post_ref: parse(p[4]), state: p[5], payload: parse(p[6]),
                rationale: p[7], evidence: parse(p[8]), effect: parse(p[9]), checks: parse(p[10]), model: parse(p[11]), error: null, attempt: 1,
                decided_by: null, decided_at: null, expires_at: new Date(Date.now() + 7 * 86_400_000), created_at: new Date(), updated_at: new Date(),
            };
            proposals.push(row);
            return { rows: [copy(row)] };
        }],
        [/^SELECT .* FROM ads_proposals WHERE id = \$1 AND creator_id = \$2/, (p) => ({ rows: proposals.filter((r) => r.id === p[0] && r.creator_id === p[1]).map(copy) })],
        [/^SELECT .* FROM ads_proposals WHERE creator_id = \$1 AND \(\$2::text\[\] IS NULL/, (p) => ({
            rows: proposals.filter((r) => r.creator_id === p[0] && (!p[1] || p[1].includes(r.state))).reverse().slice(0, p[2]).map(copy),
        })],
        [/^SELECT COUNT\(\*\)::int AS n FROM ads_proposals/, (p) => ({
            rows: [{ n: proposals.filter((r) => r.creator_id === p[0] && r.source === 'daily_review' && r.created_at >= p[1]).length }],
        })],
        [/^UPDATE ads_proposals SET state = 'expired'/, (p) => {
            const hit = proposals.filter((r) => r.state === 'open' && new Date(r.expires_at) <= p[0]);
            hit.forEach((r) => { r.state = 'expired'; });
            return { rows: [], rowCount: hit.length };
        }],
        [/^UPDATE ads_proposals SET state = 'failed', error = \$2, updated_at = NOW\(\) WHERE state = 'drafting'/, (p) => {
            const hit = proposals.filter((r) => r.state === 'drafting' && new Date(r.created_at).getTime() <= (p[0] as Date).getTime() - p[2] * 3_600_000);
            hit.forEach((r) => { r.state = 'failed'; r.error = p[1]; });
            return { rows: [], rowCount: hit.length };
        }],
        [/^UPDATE ads_proposals SET (.*) WHERE id = \$1 AND creator_id = \$2( AND state = \$3)? RETURNING/, (p, sql) => {
            const m = /^UPDATE ads_proposals SET (.*) WHERE id = \$1 AND creator_id = \$2( AND state = \$3)? RETURNING/.exec(sql)!;
            const row = proposals.find((r) => r.id === p[0] && r.creator_id === p[1] && (!m[2] || r.state === p[2]));
            if (!row) return { rows: [] };
            applySets(row, m[1]!, p);
            return { rows: [copy(row)] };
        }],
        [/^DELETE FROM ads_proposals/, (p) => {
            const before = proposals.length;
            proposals = proposals.filter((r) => !(r.id === p[0] && r.creator_id === p[1] && r.state === 'drafting'));
            return { rows: [], rowCount: before - proposals.length };
        }],
        [/^INSERT INTO studio_jobs \(creator_id, kind, payload\)/, (p) => {
            const row: Row = { id: uuid(), creator_id: p[0], kind: p[1], payload: parse(p[2]), status: 'pending', result: null, error: null, created_at: new Date() };
            studioJobs.push(row);
            return { rows: [copy(row)] };
        }],
        [/^SELECT id, status, result, error FROM studio_jobs WHERE creator_id = \$1 AND kind = 'ads_think'/, (p) => ({
            rows: studioJobs.filter((j) => j.creator_id === p[0] && j.kind === 'ads_think' && j.payload.proposalId === p[1] && j.payload.attempt === p[2]).reverse().slice(0, 1).map(copy),
        })],
        [/^SELECT state FROM ads_ops WHERE creator_id = \$1 AND id = ANY/, (p) => ({ rows: (p[1] as string[]).filter((id) => opsStates.has(id)).map((id) => ({ state: opsStates.get(id) })) })],
    );
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const spec = (amount = 10): CampaignSpec => ({
    name: 'دورة الذكاء الاصطناعي', goal: 'messages', destinations: ['instagram'], specialCategory: 'none',
    budget: { home: 'campaign', kind: 'daily', amount, start: '2026-11-01T00:00:00Z', end: '2026-11-08T00:00:00Z' },
    adsets: [{ name: 'مصر', targeting: { countries: ['EG'], ageMin: 22, ageMax: 45, advantageAudience: false }, placements: 'automatic' }],
    ads: [{ adsetIndex: 0, name: 'إعلان', creative: { source: 'post', postId: POST, platform: 'instagram' }, copy: { primaryText: 'تعلّم الذكاء الاصطناعي' }, message: { greeting: 'أهلًا', iceBreakers: [{ title: 'كم السعر؟' }] } }],
});
const draftAnswer = (amount = 10) => ({ spec: spec(amount), rationale: 'الرسائل أرخص في حسابك.', assumptions: ['الأعمار 22–45'], expected: { metric: 'conversations', range: null } });

const policy: PolicyPort = { rules: () => [], check: (fields) => (fields.some((f) => /مضمون/.test(f.text)) ? [{ ruleId: 'guaranteed', severity: 'block', field: 'x', message: 'guaranteed' }] : []) };
const money = (remaining = 640): MoneyPort => ({
    async check(_c, candidate) {
        const worst = candidate ? (candidate.kind === 'daily' ? candidate.amount * candidate.days : candidate.amount) : 0;
        return { fits: worst <= remaining, currency: 'USD', remaining, maxDailyBudget: 50, monthlyCap: 1000, reason: worst <= remaining ? null : 'OVER_MONTHLY_CAP' };
    },
    async minimumDaily() { return { messages: 1 }; },
});
let applied: Array<{ kind: string; proposalId: string }>;
const apply: ApplyPort = {
    async validateSpec() { return { ok: true, error: null }; },
    async createFromSpec(_c, _s, ctx) { applied.push({ kind: 'create', proposalId: ctx.proposalId }); opsStates.set('op-a', 'pending'); return { ops: [{ id: 'op-a', state: 'pending', kind: 'create' }] }; },
    async applyChange(_c, _i, ctx) { applied.push({ kind: 'change', proposalId: ctx.proposalId }); return { ops: [{ id: 'op-b', state: 'pending', kind: 'status' }] }; },
};
const FULL: ProposalPorts = { policy, money: money(), mirror: null, apply, tenants: null, alerts: null };

// ─── Harness ────────────────────────────────────────────────────────────────────────────────────────────────────────────

let db: AdsFakeDb;
let enqueued: Array<{ kind: string; payload: any }>;
let aiCalls: Array<{ purpose: string; creatorId: string | null }>;
let aiAnswer: unknown;
let restore: Array<() => void>;
let savedEnv: Record<string, string | undefined>;
let pending: Promise<unknown>[];

before(() => {
    savedEnv = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
    for (const n of ENV_NAMES) delete process.env[n];
});
after(() => { for (const n of ENV_NAMES) if (savedEnv[n] === undefined) delete process.env[n]; else process.env[n] = savedEnv[n]; });

beforeEach(() => {
    proposals = []; studioJobs = []; opsStates = new Map(); applied = []; enqueued = []; aiCalls = []; pending = [];
    aiAnswer = draftAnswer();
    db = installAdsFakeDb();
    installTables(db);
    const queue: JobQueue = {
        async enqueue(input) { enqueued.push({ kind: input.kind, payload: input.payload }); return `job-${enqueued.length}`; },
        async claim() { return []; }, async complete() {}, async fail() {}, async reapStale() { return 0; }, async pruneCompleted() { return 0; },
    } as JobQueue;
    const prevQueue = setJobQueue(queue);
    const prevWait = setWaitUntil((work) => { pending.push(work.catch(() => undefined)); });
    const prevCaller = setAiCaller((async (args: { purpose: string; creatorId: string | null }) => {
        aiCalls.push({ purpose: args.purpose, creatorId: args.creatorId });
        return { json: aiAnswer, usage: {}, billed: [], model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'end', elapsed_ms: 1, usd: 0.01, priced: true, costSource: 'table', effort: 'medium', route: 'default', usageId: 'u1' };
    }) as unknown as AiCaller);
    const prevPorts = setProposalPorts(FULL);
    setProposalInputDeps({ loadProfile: async () => ({ profile: defaultProfile({ lang: 'ar', rules: [] }) }) });
    const prevSink = setLogSink((_level, line) => { if (process.env.DBG) console.error(line); });
    restore = [() => setJobQueue(prevQueue), () => setWaitUntil(prevWait), () => setAiCaller(prevCaller), () => setProposalPorts(prevPorts), () => setProposalInputDeps(undefined), () => setLogSink(prevSink), () => db.restore()];
});
afterEach(async () => { await Promise.all(pending); restore.reverse().forEach((r) => r()); });

/** The Mac answers the latest ads_think job. */
function macAnswers(output: unknown): void {
    const job = studioJobs.filter((j) => j.kind === 'ads_think').at(-1)!;
    job.status = 'done';
    job.result = { output, model: 'claude-opus-5-5', usage: {} };
}

// ─── Who drafts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a Mac-brain tenant (the owner)', () => {
    it('is given a Studio ads_think job through enqueueJob, and never asks the providers layer', async () => {
        const view = await requestProposal(OWNER, { request: 'روّج لدورة الذكاء الاصطناعي', userId: null });
        assert.equal(view.state, 'drafting');
        assert.equal(view.via, 'mac');
        assert.deepEqual(enqueued.map((e) => e.kind), ['ads.draft'], 'the advance is an app job');
        await advanceProposal(OWNER, view.id);
        assert.equal(studioJobs.length, 1);
        const job = studioJobs[0]!;
        assert.equal(job.kind, 'ads_think');
        assert.equal(job.payload.proposalId, view.id);
        assert.equal(job.payload.attempt, 1);
        assert.equal(job.payload.purpose, 'ads_draft');
        assert.ok(typeof job.payload.schema === 'object' && job.payload.schema.type === 'object', 'JSON Schema for claude --json-schema');
        assert.deepEqual(aiCalls, []);
        // A second advance while the Mac is working does nothing.
        await advanceProposal(OWNER, view.id);
        assert.equal(studioJobs.length, 1);
    });

    it('stores the Mac\'s answer like a server draft: validated, checked, open', async () => {
        const view = await requestProposal(OWNER, { request: 'روّج للدورة', userId: null });
        await advanceProposal(OWNER, view.id);
        macAnswers(JSON.stringify(draftAnswer()));
        await advanceProposal(OWNER, view.id);
        const row = (await getProposal(OWNER, view.id))!;
        assert.equal(row.state, 'open');
        assert.equal(row.payload?.task, 'draft_campaign');
        assert.equal(row.model?.via, 'mac');
        assert.equal(row.effect?.worstCaseDelta, 70);
        assert.deepEqual(row.checks?.policy, []);
    });

    it('asks the Mac again once when the answer breaks the schema, then fails', async () => {
        const view = await requestProposal(OWNER, { request: 'x', userId: null });
        await advanceProposal(OWNER, view.id);
        macAnswers({ spec: 'nope' });
        await advanceProposal(OWNER, view.id);
        assert.equal(studioJobs.length, 2, 'a second ads_think job');
        assert.equal(studioJobs[1]!.payload.attempt, 2);
        assert.match(studioJobs[1]!.payload.user, /Your previous answer failed these checks/);
        macAnswers({ spec: 'still nope' });
        await advanceProposal(OWNER, view.id);
        const row = (await getProposal(OWNER, view.id))!;
        assert.equal(row.state, 'failed');
        assert.match(row.error ?? '', /schema/);
    });

    it('fails the proposal when the Mac job failed', async () => {
        const view = await requestProposal(OWNER, { request: 'x', userId: null });
        await advanceProposal(OWNER, view.id);
        Object.assign(studioJobs[0]!, { status: 'failed', error: 'this worker doesn\'t know the job kind "ads_think"' });
        await advanceProposal(OWNER, view.id);
        const row = (await getProposal(OWNER, view.id))!;
        assert.equal(row.state, 'failed');
        assert.match(row.error ?? '', /know the job kind/);
    });
});

describe('any other tenant', () => {
    it('is refused AI_NOT_CONFIGURED without a key, before a row is written', async () => {
        await assert.rejects(requestProposal(TENANT, { request: 'x', userId: null }), (err: unknown) => err instanceof ProposalError && err.code === 'AI_NOT_CONFIGURED' && err.status === 409);
        assert.equal(proposals.length, 0);
        assert.equal(studioJobs.length, 0);
    });

    it('drafts on the providers layer with ads_draft, and is never given an ads_think job', async () => {
        proposals.push({
            id: uuid(), creator_id: TENANT, kind: 'new_campaign', source: 'request', request_text: 'x', post_ref: null, state: 'drafting', payload: null,
            rationale: null, evidence: null, effect: null, checks: null, model: { via: 'api' }, error: null, attempt: 1, decided_by: null, decided_at: null,
            expires_at: new Date(Date.now() + 7 * 86_400_000), created_at: new Date(), updated_at: new Date(),
        });
        const id = proposals[0]!.id;
        await advanceProposal(TENANT, id);
        assert.deepEqual(aiCalls, [{ purpose: 'ads_draft', creatorId: TENANT }]);
        assert.equal(studioJobs.length, 0);
        const row = (await getProposal(TENANT, id))!;
        assert.equal(row.state, 'open');
        assert.equal(row.model?.via, 'api');
        assert.equal(row.model?.provider, 'anthropic');
    });
});

// ─── The state machine ──────────────────────────────────────────────────────────────────────────────────────────────────

async function openProposal(amount = 10): Promise<string> {
    const view = await requestProposal(OWNER, { request: 'x', userId: null });
    await advanceProposal(OWNER, view.id);
    macAnswers(draftAnswer(amount));
    await advanceProposal(OWNER, view.id);
    return view.id;
}

describe('approve and reject', () => {
    it('approve needs confirm', async () => {
        const id = await openProposal();
        await assert.rejects(approveProposal(OWNER, id, { userId: 'u1' }), (e: unknown) => e instanceof ProposalError && e.code === 'INVALID' && e.field === 'confirm');
        assert.equal((await getProposal(OWNER, id))!.state, 'open');
    });

    it('approve enqueues the ops with the proposal id and moves open → approved → applying → applied', async () => {
        const id = await openProposal();
        const out = await approveProposal(OWNER, id, { confirm: true, userId: 'u1' });
        assert.deepEqual(applied, [{ kind: 'create', proposalId: id }]);
        assert.equal(out.proposal.state, 'applying');
        assert.deepEqual(out.ops.map((o) => o.id), ['op-a']);
        assert.equal((await getProposal(OWNER, id))!.decided_by, 'u1');
        opsStates.set('op-a', 'done');
        assert.equal(await settleApplying(OWNER), 1);
        assert.equal((await getProposal(OWNER, id))!.state, 'applied');
    });

    it('a failed op fails the proposal', async () => {
        const id = await openProposal();
        await approveProposal(OWNER, id, { confirm: true, userId: 'u1' });
        opsStates.set('op-a', 'failed');
        await settleApplying(OWNER);
        assert.equal((await getProposal(OWNER, id))!.state, 'failed');
    });

    it('approve re-runs the money rule: a budget that no longer fits is refused, nothing enqueued', async () => {
        const id = await openProposal();
        setProposalPorts({ money: money(20) });
        await assert.rejects(approveProposal(OWNER, id, { confirm: true, userId: 'u1' }), (e: unknown) => e instanceof ProposalError && e.code === 'OVER_MONTHLY_CAP');
        assert.deepEqual(applied, []);
        assert.equal((await getProposal(OWNER, id))!.state, 'open');
    });

    it('approve re-runs the policy check on edited copy', async () => {
        const id = await openProposal();
        const row = proposals.find((r) => r.id === id)!;
        row.payload.spec.ads[0].copy.primaryText = 'نتائج مضمونة';
        await assert.rejects(approveProposal(OWNER, id, { confirm: true, userId: 'u1' }), (e: unknown) => e instanceof ProposalError && e.code === 'POLICY_BLOCKED' && e.status === 422);
        assert.deepEqual(applied, []);
    });

    it('approve is refused NOT_WIRED while a port is missing', async () => {
        const id = await openProposal();
        setProposalPorts({ apply: null });
        await assert.rejects(approveProposal(OWNER, id, { confirm: true, userId: 'u1' }), (e: unknown) => e instanceof ProposalError && e.code === 'NOT_WIRED');
    });

    it('reject creates nothing, and an approved or rejected proposal cannot move again', async () => {
        const id = await openProposal();
        const view = await rejectProposal(OWNER, id, { reason: 'not now', userId: 'u1' });
        assert.equal(view.state, 'rejected');
        assert.equal(view.error, 'not now');
        assert.deepEqual(applied, []);
        await assert.rejects(approveProposal(OWNER, id, { confirm: true, userId: 'u1' }), (e: unknown) => e instanceof ProposalError && e.code === 'INVALID');
        await assert.rejects(transitionProposal(null, OWNER, id, 'open'), (e: unknown) => e instanceof ProposalError && e.status === 409);
    });
});

describe('expiry', () => {
    it('an open proposal expires after 7 days, and an expired one cannot be approved', async () => {
        const id = await openProposal();
        assert.deepEqual(await expireProposals(new Date(Date.now() + 6 * 86_400_000)), { expired: 0, staleDrafts: 0 });
        assert.deepEqual(await expireProposals(new Date(Date.now() + 8 * 86_400_000)), { expired: 1, staleDrafts: 0 });
        assert.equal((await getProposal(OWNER, id))!.state, 'expired');
        await assert.rejects(approveProposal(OWNER, id, { confirm: true, userId: 'u1' }), (e: unknown) => e instanceof ProposalError && e.code === 'INVALID');
    });

    it('a draft the Mac never answered fails after 24 hours', async () => {
        const view = await requestProposal(OWNER, { request: 'x', userId: null });
        const swept = await expireProposals(new Date(Date.now() + 25 * 3_600_000));
        assert.equal(swept.staleDrafts, 1);
        assert.equal((await getProposal(OWNER, view.id))!.state, 'failed');
    });
});

describe('the daily review', () => {
    const snapshot = (days: number) => ({
        async snapshot() {
            return {
                currency: 'USD', timezone: 'Africa/Cairo', daysOfData: days, audiences: [],
                objects: [{ id: 'c1', level: 'campaign' as const, name: 'C', goal: 'messages', status: 'ACTIVE', budget: { kind: 'daily' as const, amount: 10 }, targetingSummary: null,
                    last7d: { spend: 70, results: 7, costPerResult: 10, conversations: 7, costPerConversation: 10, ctr: 1, frequency: null, trackedClicks: null, handoffs: null } }],
            };
        },
    });

    it('drafts one review a day for tenants with 3+ days of data, and alerts when proposals open', async () => {
        const alerts: unknown[] = [];
        setProposalPorts({ tenants: { enabled: async () => [OWNER] }, mirror: snapshot(5), alerts: { send: async (...a) => { alerts.push(a); } } });
        assert.deepEqual(await runDailyReview(), { tenants: 1, queued: 1 });
        assert.deepEqual(await runDailyReview(), { tenants: 1, queued: 0 }, 'once a day');
        const id = proposals[0]!.id;
        assert.equal(proposals[0]!.source, 'daily_review');
        await advanceProposal(OWNER, id);
        assert.equal(studioJobs[0]!.payload.purpose, 'ads_review');
        macAnswers({ items: [
            { kind: 'pause', targets: ['c1'], change: { percent: -100 }, evidence: { window: '7d', numbers: { spend: 70 } }, rationale: 'أوقفها' },
            { kind: 'lower_budget', targets: ['c1'], change: { percent: -20 }, evidence: { window: '7d', numbers: { costPerResult: 10 } }, rationale: 'خفّضها' },
        ] });
        await advanceProposal(OWNER, id);
        assert.deepEqual(proposals.map((p) => [p.kind, p.state]), [['change', 'open'], ['change', 'open']]);
        assert.equal(alerts.length, 1);
    });

    it('skips a tenant with less than 3 days of results', async () => {
        setProposalPorts({ tenants: { enabled: async () => [OWNER] }, mirror: snapshot(2) });
        assert.deepEqual(await runDailyReview(), { tenants: 1, queued: 0 });
    });

    it('removes the row when the review finds nothing worth changing', async () => {
        setProposalPorts({ tenants: { enabled: async () => [OWNER] }, mirror: snapshot(5) });
        await runDailyReview();
        const id = proposals[0]!.id;
        await advanceProposal(OWNER, id);
        macAnswers({ items: [] });
        await advanceProposal(OWNER, id);
        assert.equal(proposals.length, 0);
    });
});
