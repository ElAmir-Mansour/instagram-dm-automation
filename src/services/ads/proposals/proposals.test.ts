/**
 * The model's answer and the server checks after it (A7, contracts/ai-proposal.schema.md): the schema (one regeneration), the evidence
 * check (a number the model made up drops the item), the policy check (a `block` asks again once) and the money check (an over-cap budget is
 * reduced with a note, or the draft fails below Meta's minimum). A port that is not wired is listed as unavailable, never guessed.
 *
 * No database and no network: every port is a stub.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runChecks, type CheckOutcome } from './checks.js';
import { buildPrompt } from './prompt.js';
import {
    DRAFT_SCHEMA, MAX_DRAFT_RATIONALE, MAX_GREETING, MAX_ICE_BREAKERS, MAX_ICE_BREAKER_TITLE, MAX_REVIEW_ITEMS, MAX_REVIEW_RATIONALE, parseModelJson,
    REVIEW_SCHEMA, schemaFor, validateDraft, validateReview,
} from './schema.js';
import { hasNumber, inputNumbers, textFieldsOf } from './input.js';
import type {
    CampaignSpec, DraftOutput, InputObject, MoneyAnswer, MoneyCandidate, MoneyPort, PolicyFinding, PolicyPort, ProposalInput, ProposalPorts, ReviewItem,
} from './types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const last7d = (over: Partial<InputObject['last7d']> = {}): InputObject['last7d'] => ({
    spend: 140, results: 12, costPerResult: 11.67, conversations: 12, costPerConversation: 11.67, ctr: 1.8, frequency: 1.4, trackedClicks: 30, handoffs: 3, ...over,
});

const OBJECTS: InputObject[] = [
    { id: 'c1', level: 'campaign', name: 'Courses', goal: 'messages', status: 'ACTIVE', budget: { kind: 'daily', amount: 20 }, targetingSummary: null, last7d: last7d() },
    { id: 'a1', level: 'adset', name: 'Cairo 22-45', goal: 'messages', status: 'ACTIVE', budget: { kind: 'daily', amount: 10 }, targetingSummary: null, last7d: last7d({ spend: 70, results: 9, costPerResult: 7.78 }) },
    { id: 'a2', level: 'adset', name: 'Riyadh 25-40', goal: 'messages', status: 'ACTIVE', budget: { kind: 'daily', amount: 10 }, targetingSummary: null, last7d: last7d({ spend: 70, results: 3, costPerResult: 23.33 }) },
];

const inputOf = (over: Partial<ProposalInput> = {}): ProposalInput => ({
    tenant: { lang: 'ar', currency: 'SAR', timezone: 'Asia/Riyadh', countries: ['SA', 'EG'] },
    limits: { maxDailyBudget: 50, monthlyCap: 1000, remainingThisMonth: 640, metaMinimumDaily: { messages: 3.75 } },
    offers: [{ id: 'o1', title: 'دورة', price: '99 SAR', url_is_tracked: true, summary: 'ستة دروس' }],
    request: null,
    post: null,
    policy: { rules: [] },
    account: { objects: OBJECTS, audiences: [] },
    daysOfData: 14,
    task: 'draft_campaign',
    ...over,
});

const specOf = (over: Partial<CampaignSpec> = {}): CampaignSpec => ({
    name: 'دورة الذكاء الاصطناعي',
    goal: 'messages',
    destinations: ['messenger'],
    specialCategory: 'none',
    budget: { home: 'campaign', kind: 'daily', amount: 20, start: '2026-11-01T00:00:00Z', end: '2026-11-08T00:00:00Z' },
    adsets: [{
        name: 'مصر والسعودية',
        targeting: { countries: ['EG', 'SA'], ageMin: 22, ageMax: 45, advantageAudience: true },
        placements: 'automatic',
    }],
    ads: [{
        adsetIndex: 0,
        name: 'إعلان 1',
        creative: { source: 'post', postId: 'p1', platform: 'instagram' },
        copy: { primaryText: 'تعلّم الذكاء الاصطناعي من الصفر', headline: 'ابدأ الآن', cta: 'MESSAGE_PAGE' },
        message: { greeting: 'أهلاً! كيف أساعدك؟', iceBreakers: [{ title: 'كم السعر؟' }, { title: 'متى تبدأ الدورة؟', response: 'تبدأ الأسبوع القادم.' }] },
    }],
    ...over,
});

const draftOf = (over: Partial<DraftOutput> = {}): DraftOutput => ({
    spec: specOf(),
    rationale: 'الرسائل كانت أرخص من النقرات في حسابك.',
    assumptions: ['استهدفنا الأعمار 22–45 لأن جمهورك الحالي منهم.'],
    expected: { metric: 'conversations', range: null },
    ...over,
});

const itemOf = (over: Partial<ReviewItem> = {}): ReviewItem => ({
    kind: 'pause',
    targets: ['a2'],
    change: { percent: -100 },
    evidence: { window: '7d', numbers: { spend: 70, results: 3, costPerResult: 23.33 } },
    rationale: 'تكلفة النتيجة أعلى بثلاثة أضعاف من المجموعة الأخرى.',
    ...over,
});

const moneyStub = (over: { remaining?: number | null; maxDaily?: number | null; cap?: number | null; calls?: (MoneyCandidate | null)[] } = {}): MoneyPort => {
    const remaining = over.remaining === undefined ? 640 : over.remaining;
    const maxDaily = over.maxDaily === undefined ? 50 : over.maxDaily;
    const cap = over.cap === undefined ? 1000 : over.cap;
    return {
        async check(_creator, candidate): Promise<MoneyAnswer> {
            over.calls?.push(candidate);
            const base = { currency: 'SAR', remaining, maxDailyBudget: maxDaily, monthlyCap: cap };
            if (!candidate) return { ...base, fits: true, reason: null };
            if (candidate.kind === 'daily' && maxDaily != null && candidate.amount > maxDaily) return { ...base, fits: false, reason: 'OVER_DAILY_MAX' };
            const worst = candidate.kind === 'daily' ? candidate.amount * candidate.days : candidate.amount;
            if (remaining != null && worst > remaining + 1e-9) return { ...base, fits: false, reason: 'OVER_MONTHLY_CAP' };
            return { ...base, fits: true, reason: null };
        },
        async minimumDaily() { return { messages: 3.75 }; },
    };
};

const policyStub = (findings: (fields: { field: string; text: string }[]) => PolicyFinding[]): PolicyPort => ({
    rules: () => [],
    check: (fields) => findings(fields),
});

const NO_PORTS: ProposalPorts = { policy: null, money: null, mirror: null, apply: null, tenants: null, alerts: null };
const portsOf = (over: Partial<ProposalPorts>): ProposalPorts => ({ ...NO_PORTS, ...over });

const run = (args: Partial<Parameters<typeof runChecks>[0]> & { raw: unknown }): Promise<CheckOutcome> =>
    runChecks({ task: 'draft_campaign', input: inputOf(), attempt: 1, creatorId: 't1', ports: NO_PORTS, ...args });

const okItems = (outcome: CheckOutcome) => {
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
    return outcome.kind === 'ok' ? outcome.items : [];
};

// ─── The schema ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('schema', () => {
    it('hands the providers JSON Schema for both tasks', () => {
        assert.ok('json' in DRAFT_SCHEMA && 'json' in REVIEW_SCHEMA);
        assert.equal(schemaFor('draft_campaign'), DRAFT_SCHEMA);
        assert.equal(schemaFor('review'), REVIEW_SCHEMA);
        const review = (REVIEW_SCHEMA as { json: { properties: { items: { maxItems: number } } } }).json;
        assert.equal(review.properties.items.maxItems, MAX_REVIEW_ITEMS);
    });

    it('exports the limits the contract names', () => {
        assert.deepEqual(
            [MAX_DRAFT_RATIONALE, MAX_REVIEW_RATIONALE, MAX_GREETING, MAX_ICE_BREAKERS, MAX_ICE_BREAKER_TITLE, MAX_REVIEW_ITEMS],
            [600, 400, 300, 4, 80, 3],
        );
    });

    it('accepts a well-formed draft and review', () => {
        const draft = validateDraft(draftOf());
        assert.equal(draft.ok, true);
        const withRange = validateDraft(draftOf({ expected: { metric: 'conversations', range: [8, 14] } }));
        assert.equal(withRange.ok, true);
        const review = validateReview({ items: [itemOf(), itemOf({ kind: 'lower_budget', change: { percent: -20 } }), itemOf({ kind: 'shift_budget', targets: ['a1', 'a2'], change: { from: 'a2', to: 'a1', amount: 5 } })] });
        assert.equal(review.ok, true);
        assert.equal(validateReview({ items: [] }).ok, true);
    });

    it('reads the answer as a JSON string, with or without a code fence', () => {
        const json = JSON.stringify(draftOf());
        assert.equal(validateDraft(json).ok, true);
        assert.equal(validateDraft('```json\n' + json + '\n```').ok, true);
        assert.equal(validateDraft('Here you go:\n```\n' + json + '\n```\nDone.').ok, true);
        assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
        assert.deepEqual(parseModelJson({ a: 1 }), { a: 1 });
        const bad = validateDraft('not json at all');
        assert.equal(bad.ok, false);
        if (!bad.ok) assert.match(bad.errors[0]!, /JSON/);
    });

    it('names the path of every problem', () => {
        const spec = specOf();
        spec.ads[0]!.message = { greeting: 'x'.repeat(MAX_GREETING + 1), iceBreakers: Array.from({ length: 5 }, (_, i) => ({ title: i === 0 ? 'y'.repeat(81) : `t${i}` })) };
        spec.budget.amount = 0;
        const result = validateDraft(draftOf({ spec, rationale: 'z'.repeat(601), expected: { metric: 'bogus' as never, range: [9, 3] } }));
        assert.equal(result.ok, false);
        if (result.ok) return;
        for (const expected of [
            'spec.ads[0].message.greeting: at most 300 characters',
            'spec.ads[0].message.iceBreakers: at most 4 items',
            'spec.ads[0].message.iceBreakers[0].title: at most 80 characters',
            'spec.budget.amount: must be greater than 0',
            'rationale: at most 600 characters',
            'expected.range: low must not exceed high',
        ]) assert.ok(result.errors.includes(expected), `${expected} in ${JSON.stringify(result.errors)}`);
        assert.ok(result.errors.some((e) => e.startsWith('expected.metric: must be one of')));
    });

    it('refuses wrong enums, missing keys and a bad change shape', () => {
        const spec = specOf({ goal: 'sales' as never });
        delete (spec as Partial<CampaignSpec>).adsets;
        const draft = validateDraft({ spec, rationale: 'r', assumptions: 'none', expected: { metric: 'reach', range: [1] } });
        assert.equal(draft.ok, false);
        if (!draft.ok) {
            assert.ok(draft.errors.some((e) => e.startsWith('spec.goal: must be one of')));
            assert.ok(draft.errors.some((e) => e.startsWith('spec.adsets:')));
            assert.ok(draft.errors.some((e) => e.startsWith('assumptions:')));
            assert.ok(draft.errors.some((e) => e.startsWith('expected.range:')));
        }
        const review = validateReview({ items: [itemOf({ change: { amount: 3 } as never }), itemOf({ kind: 'nope' as never })] });
        assert.equal(review.ok, false);
        if (!review.ok) {
            assert.ok(review.errors.some((e) => e.startsWith('items[0].change:')), JSON.stringify(review.errors));
            assert.ok(review.errors.some((e) => e.startsWith('items[1].kind: must be one of')));
        }
    });

    it('allows at most three review items and a 400-character rationale', () => {
        const four = validateReview({ items: [itemOf(), itemOf(), itemOf(), itemOf()] });
        assert.equal(four.ok, false);
        if (!four.ok) assert.ok(four.errors.includes('items: at most 3 items'));
        const long = validateReview({ items: [itemOf({ rationale: 'r'.repeat(401) })] });
        assert.equal(long.ok, false);
        if (!long.ok) assert.ok(long.errors.includes('items[0].rationale: at most 400 characters'));
    });

    it('requires evidence numbers to be numbers', () => {
        const result = validateReview({ items: [itemOf({ evidence: { window: '7d', numbers: { spend: 'a lot' as never } } })] });
        assert.equal(result.ok, false);
        if (!result.ok) assert.ok(result.errors.includes('items[0].evidence.numbers.spend: must be a finite number'));
    });
});

// ─── The input numbers and the text fields ───────────────────────────────────────────────────────────────────────────────

describe('inputNumbers and textFieldsOf', () => {
    it('collects the numbers of the objects, the limits and the post, and compares after rounding', () => {
        const numbers = inputNumbers(inputOf({ post: { id: 'p', platform: 'instagram', caption: 'c 12345', kind: 'reel', organic: { views: 4200, reach: 3100, saves: 40, skipRate: 0.31 } } }));
        for (const n of [140, 12, 11.67, 1.8, 20, 10, 50, 1000, 640, 3.75, 4200, 0.31]) assert.ok(hasNumber(numbers, n), String(n));
        assert.ok(hasNumber(numbers, 11.670001));
        assert.ok(!hasNumber(numbers, 777));
        assert.ok(!hasNumber(numbers, 11.7));
        assert.ok(!numbers.has(12345), 'a number inside the caption is not evidence');
    });

    it('lists every copy field with its path', () => {
        const fields = textFieldsOf(specOf());
        assert.deepEqual(fields.map((f) => f.field), [
            'name', 'ads[0].copy.primaryText', 'ads[0].copy.headline', 'ads[0].message.greeting',
            'ads[0].message.iceBreakers[0].title', 'ads[0].message.iceBreakers[1].title', 'ads[0].message.iceBreakers[1].response',
        ]);
        assert.equal(fields[1]!.text, 'تعلّم الذكاء الاصطناعي من الصفر');
    });
});

// ─── The prompt ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
    it('is deterministic, states the rules and leaves daysOfData out', () => {
        const a = buildPrompt(inputOf());
        const b = buildPrompt(inputOf());
        assert.deepEqual(a, b);
        assert.match(a.system, /Arabic/);
        assert.match(a.system, /at most 3/);
        assert.doesNotMatch(a.user, /daysOfData/);
        assert.doesNotMatch(a.user, /previous answer failed/);
        assert.equal((JSON.parse(a.user) as ProposalInput).tenant.currency, 'SAR');
    });

    it('lists the failed checks when asked again', () => {
        const { user } = buildPrompt(inputOf(), ['spec.budget.amount: must be greater than 0', 'blocked word']);
        assert.match(user, /Your previous answer failed these checks; fix them:/);
        assert.match(user, /- spec\.budget\.amount: must be greater than 0/);
        assert.match(user, /- blocked word/);
    });
});

// ─── Check 1: schema, one regeneration ──────────────────────────────────────────────────────────────────────────────────

describe('runChecks: schema', () => {
    const bad = draftOf({ rationale: 'z'.repeat(601) });

    it('asks again once with the errors on attempt 1', async () => {
        const outcome = await run({ raw: bad, attempt: 1 });
        assert.equal(outcome.kind, 'regenerate');
        if (outcome.kind !== 'regenerate') return;
        assert.equal(outcome.reason, 'schema');
        assert.ok(outcome.feedback.includes('rationale: at most 600 characters'));
    });

    it('fails on attempt 2', async () => {
        const outcome = await run({ raw: bad, attempt: 2 });
        assert.equal(outcome.kind, 'failed');
        if (outcome.kind === 'failed') assert.match(outcome.reason, /rationale/);
    });

    it('takes a JSON string answer', async () => {
        const items = okItems(await run({ raw: '```json\n' + JSON.stringify(draftOf()) + '\n```' }));
        assert.equal(items.length, 1);
        assert.equal(items[0]!.kind, 'new_campaign');
        assert.equal(items[0]!.payload.task, 'draft_campaign');
    });
});

// ─── Check 2: evidence ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('runChecks: evidence', () => {
    const review = (items: ReviewItem[], over: Partial<Parameters<typeof runChecks>[0]> = {}) =>
        run({ task: 'review', input: inputOf({ task: 'review' }), raw: { items }, ...over });

    it('keeps an item whose numbers are all in the input', async () => {
        const items = okItems(await review([itemOf()]));
        assert.equal(items.length, 1);
        assert.equal(items[0]!.kind, 'change');
        assert.deepEqual(items[0]!.evidence, itemOf().evidence);
        assert.equal(items[0]!.rationale, itemOf().rationale);
    });

    it('drops an item with a number the input does not hold, and says why', async () => {
        const invented = itemOf({ targets: ['a1'], evidence: { window: '7d', numbers: { spend: 70, results: 777 } } });
        const items = okItems(await review([invented, itemOf()]));
        assert.equal(items.length, 1);
        assert.deepEqual(items[0]!.payload.task === 'review' ? items[0]!.payload.item.targets : null, ['a2']);
        assert.deepEqual(items[0]!.checks.dropped?.map((d) => d.index), [0]);
        assert.match(items[0]!.checks.dropped?.[0]?.reason ?? '', /777/);
    });

    it('drops an item aimed at an object the account does not have', async () => {
        const items = okItems(await review([itemOf({ targets: ['zzz'] }), itemOf({ kind: 'shift_budget', targets: ['a1', 'a2'], change: { from: 'a2', to: 'nope', amount: 5 } })]));
        assert.equal(items.length, 0);
    });

    it('answers ok with no items when every item is dropped', async () => {
        const outcome = await review([itemOf({ evidence: { window: '7d', numbers: { spend: 1234.5 } } })]);
        assert.deepEqual(outcome, { kind: 'ok', items: [] });
    });
});

// ─── Check 3: policy ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('runChecks: policy', () => {
    const block: PolicyFinding = { ruleId: 'guarantee', severity: 'block', field: 'ads[0].copy.primaryText', message: 'Promises a guaranteed result' };
    const warn: PolicyFinding = { ruleId: 'urgency', severity: 'warn', field: 'ads[0].copy.headline', message: 'Urgency wording' };

    it('asks again once with the findings when a rule blocks', async () => {
        let seen: { field: string; text: string }[] = [];
        const ports = portsOf({ policy: policyStub((fields) => { seen = fields; return [block, warn]; }) });
        const outcome = await run({ raw: draftOf(), ports });
        assert.equal(outcome.kind, 'regenerate');
        if (outcome.kind !== 'regenerate') return;
        assert.equal(outcome.reason, 'policy');
        assert.ok(outcome.feedback.some((f) => f.includes('ads[0].copy.primaryText') && f.includes('Promises a guaranteed result')));
        assert.ok(seen.some((f) => f.field === 'ads[0].message.greeting'), 'every text field is checked');
    });

    it('fails on attempt 2 when it still blocks', async () => {
        const outcome = await run({ raw: draftOf(), attempt: 2, ports: portsOf({ policy: policyStub(() => [block]) }) });
        assert.equal(outcome.kind, 'failed');
        if (outcome.kind === 'failed') assert.equal(outcome.checks.policy[0]!.ruleId, 'guarantee');
    });

    it('keeps warnings on the stored checks', async () => {
        const items = okItems(await run({ raw: draftOf(), ports: portsOf({ policy: policyStub(() => [warn]) }) }));
        assert.deepEqual(items[0]!.checks.policy, [warn]);
        assert.ok(!items[0]!.checks.unavailable?.includes('policy'));
    });

    it('checks the copy of a review item that carries a spec', async () => {
        const fields: string[] = [];
        const ports = portsOf({ policy: policyStub((f) => { fields.push(...f.map((x) => x.field)); return [block]; }) });
        const item = itemOf({ kind: 'new_ad_from_post', targets: ['c1'], change: { spec: specOf() } });
        const outcome = await run({ task: 'review', input: inputOf({ task: 'review' }), raw: { items: [item] }, ports });
        assert.equal(outcome.kind, 'regenerate');
        assert.ok(fields.includes('ads[0].copy.primaryText'));
    });
});

// ─── Check 4: money ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('runChecks: money', () => {
    const daily = (amount: number, end?: string): CampaignSpec => specOf({ budget: { home: 'campaign', kind: 'daily', amount, start: '2026-11-01T00:00:00Z', end } });

    it('passes a budget that fits and records its worst case', async () => {
        const items = okItems(await run({ raw: draftOf(), ports: portsOf({ money: moneyStub() }) }));
        assert.deepEqual(items[0]!.checks.money, { ok: true, reason: null, note: null });
        assert.deepEqual(items[0]!.effect, { worstCaseDelta: 140, newWorstCase: 1000 - 640 + 140, currency: 'SAR' });
    });

    it('reduces a daily budget above the daily maximum, with a note in the tenant language', async () => {
        const items = okItems(await run({ raw: draftOf({ spec: specOf({ budget: { home: 'campaign', kind: 'daily', amount: 60, start: '2026-11-01T00:00:00Z', end: '2026-11-08T00:00:00Z' } }) }), ports: portsOf({ money: moneyStub() }) }));
        const payload = items[0]!.payload;
        assert.equal(payload.task === 'draft_campaign' ? payload.spec.budget.amount : null, 50);
        assert.equal(items[0]!.checks.money.ok, true);
        assert.match(items[0]!.checks.money.note ?? '', /50/);
        assert.match(items[0]!.checks.money.note ?? '', /[؀-ۿ]/, 'Arabic for an Arabic tenant');
        assert.equal(items[0]!.effect.worstCaseDelta, 350);
    });

    it('reduces a budget that would pass the month, to fit what is left', async () => {
        const calls: (MoneyCandidate | null)[] = [];
        const items = okItems(await run({ raw: draftOf({ spec: daily(40) }), ports: portsOf({ money: moneyStub({ calls }) }) }));
        const payload = items[0]!.payload;
        assert.equal(payload.task === 'draft_campaign' ? payload.spec.budget.amount : null, 21.33);
        assert.equal(items[0]!.checks.money.ok, true);
        assert.ok(items[0]!.checks.money.note);
        assert.equal(calls[0]?.days, 30, 'no end date: thirty days');
        assert.equal(items[0]!.effect.worstCaseDelta, 639.9);
    });

    it('says the note in English for an English tenant', async () => {
        const input = inputOf({ tenant: { lang: 'en', currency: 'USD', timezone: 'UTC', countries: ['GB'] } });
        const items = okItems(await run({ raw: draftOf({ spec: daily(40) }), input, ports: portsOf({ money: moneyStub() }) }));
        assert.match(items[0]!.checks.money.note ?? '', /reduced/i);
    });

    it('turns a lifetime budget into the amount that fits', async () => {
        const spec = specOf({ budget: { home: 'campaign', kind: 'lifetime', amount: 900, start: '2026-11-01T00:00:00Z', end: '2026-11-11T00:00:00Z' } });
        // A daily max of 100 lets 64 a day through: only the month's cap trims it.
        const input = inputOf({ limits: { maxDailyBudget: 100, monthlyCap: 1000, remainingThisMonth: 640, metaMinimumDaily: { messages: 3.75 } } });
        const items = okItems(await run({ raw: draftOf({ spec }), input, ports: portsOf({ money: moneyStub({ maxDaily: 100 }) }) }));
        const payload = items[0]!.payload;
        assert.equal(payload.task === 'draft_campaign' ? payload.spec.budget.amount : null, 640);
    });

    it('holds a lifetime budget to the daily max spread over its days', async () => {
        const spec = specOf({ budget: { home: 'campaign', kind: 'lifetime', amount: 900, start: '2026-11-01T00:00:00Z', end: '2026-11-11T00:00:00Z' } });
        const items = okItems(await run({ raw: draftOf({ spec }), ports: portsOf({ money: moneyStub() }) }));
        const payload = items[0]!.payload;
        assert.equal(payload.task === 'draft_campaign' ? payload.spec.budget.amount : null, 500, '50 a day for 10 days');
    });

    it('fails when what fits is below Meta\'s minimum for the goal', async () => {
        const outcome = await run({ raw: draftOf({ spec: daily(40) }), ports: portsOf({ money: moneyStub({ remaining: 60 }) }) });
        assert.equal(outcome.kind, 'failed');
        if (outcome.kind === 'failed') {
            assert.equal(outcome.reason, 'BELOW_META_MINIMUM');
            assert.equal(outcome.checks.money.ok, false);
            assert.equal(outcome.checks.money.reason, 'BELOW_META_MINIMUM');
        }
    });

    it('fails when nothing is left of the month', async () => {
        const outcome = await run({ raw: draftOf({ spec: daily(10) }), ports: portsOf({ money: moneyStub({ remaining: 0 }) }) });
        assert.equal(outcome.kind, 'failed');
        if (outcome.kind === 'failed') assert.equal(outcome.reason, 'OVER_MONTHLY_CAP');
    });

    it('lists money and policy as unavailable when their ports are not wired', async () => {
        const items = okItems(await run({ raw: draftOf() }));
        assert.deepEqual(items[0]!.checks.unavailable?.slice().sort(), ['money', 'policy']);
        assert.deepEqual(items[0]!.effect, { worstCaseDelta: null, newWorstCase: null, currency: null });
        assert.deepEqual(items[0]!.checks.policy, []);
    });

    describe('review items', () => {
        const review = (items: ReviewItem[], money = moneyStub()) =>
            run({ task: 'review', input: inputOf({ task: 'review' }), raw: { items }, ports: portsOf({ money }) });

        it('lets a pause and a lower_budget through with a delta of zero or less', async () => {
            const calls: (MoneyCandidate | null)[] = [];
            const items = okItems(await review([itemOf(), itemOf({ kind: 'lower_budget', targets: ['a1'], change: { percent: -50 }, evidence: { window: '7d', numbers: { spend: 70 } } })], moneyStub({ calls })));
            assert.equal(items.length, 2);
            assert.ok(items.every((i) => (i.effect.worstCaseDelta ?? 0) <= 0));
            assert.equal(items[1]!.effect.worstCaseDelta, -150);
            assert.deepEqual(calls, [], 'a change that cannot raise the spend asks nobody');
        });

        it('sends a raise_budget through the money rule and trims it to fit', async () => {
            const calls: (MoneyCandidate | null)[] = [];
            const raise = itemOf({ kind: 'raise_budget', targets: ['a1'], change: { percent: 100 }, evidence: { window: '7d', numbers: { results: 9 } } });
            const items = okItems(await review([raise], moneyStub({ calls, remaining: 150 })));
            assert.equal(items.length, 1);
            const payload = items[0]!.payload;
            const percent = payload.task === 'review' && 'percent' in payload.item.change ? payload.item.change.percent : null;
            assert.equal(percent, 50, 'a 100% raise of 10/day is 300 over 30 days; 150 is left, so 50%');
            assert.ok(items[0]!.checks.money.note);
            assert.ok(calls.length >= 1 && calls[0]?.kind === 'daily');
        });

        it('drops a raise that cannot fit at all', async () => {
            const raise = itemOf({ kind: 'raise_budget', targets: ['a1'], change: { percent: 100 }, evidence: { window: '7d', numbers: { results: 9 } } });
            const items = okItems(await review([raise], moneyStub({ remaining: 0 })));
            assert.equal(items.length, 0);
        });
    });
});
