/**
 * Split tests (A12): the Graph payloads, the result parsing, the keep-the-winner proposal, and the actions against in-memory ports.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    accountMidnight, armDailyBudget, buildCells, buildStudyParams, checkArms, createStudy, decideResult, equalSplit, FINAL_AFTER_END_MS,
    listStudies, normaliseConfidence, parseObjectiveResults, parseStudyInput, pollStudies, reconcileCreate, startStudy, startWorstCase,
    stopStudy, StudyError, winnerProposal,
    type MoneyAnswer, type NewStudyRow, type StudyAccount, type StudyObject, type StudyOp, type StudyOpInput, type StudyPorts, type StudyRow,
    type WinnerProposal,
} from './studies.js';

const NOW = new Date('2026-10-22T10:00:00Z');
const T = 'tenant-1';

function obj(over: Partial<StudyObject> & Pick<StudyObject, 'id' | 'level'>): StudyObject {
    return { metaId: `m-${over.id}`, name: over.id, status: 'PAUSED', parentId: null, budgetKind: 'none', budgetAmount: null, currency: 'SAR', adAccountId: 'act_1', ...over };
}

const CAMPAIGN = obj({ id: 'camp', level: 'campaign' });
const ADSET = obj({ id: 'set', level: 'adset', parentId: 'camp', budgetKind: 'daily', budgetAmount: 20 });
const AD_A = obj({ id: 'ad-a', level: 'ad', parentId: 'set', name: 'Reel A' });
const AD_B = obj({ id: 'ad-b', level: 'ad', parentId: 'set', name: 'Reel B' });
const SET_EG = obj({ id: 'set-eg', level: 'adset', parentId: 'camp', budgetKind: 'daily', budgetAmount: 15, name: 'Egypt' });
const SET_SA = obj({ id: 'set-sa', level: 'adset', parentId: 'camp', budgetKind: 'daily', budgetAmount: 15, name: 'Saudi' });

const creativeBody = { type: 'creative', cells: ['ad-a', 'ad-b'], dailyBudget: 30, start: '2026-10-24', end: '2026-10-31', confirm: true };

function harness(opts: { money?: MoneyAnswer; businessId?: string | null; businesses?: Array<{ id: string; name: string }>; objects?: StudyObject[]; results?: unknown } = {}) {
    const rows = new Map<string, StudyRow>();
    const ops: Array<StudyOpInput & { id: string }> = [];
    /** A2's switch and budget writes, in order: [objectId, what]. */
    const writes: Array<[string, string]> = [];
    const opState = new Map<string, StudyOp>();
    const proposals: WinnerProposal[] = [];
    const moneyCalls: Array<{ amount: number; days: number }> = [];
    const graphCalls: string[] = [];
    const saved: string[] = [];
    const objects = new Map((opts.objects ?? [CAMPAIGN, ADSET, AD_A, AD_B, SET_EG, SET_SA]).map((o) => [o.id, o]));
    let now = NOW;
    const account: StudyAccount = { adAccountId: 'act_1', timezoneOffsetHours: 3, businessId: opts.businessId === undefined ? 'biz-1' : opts.businessId, lang: 'en' };
    const ports: StudyPorts = {
        store: {
            async insert(r: NewStudyRow) {
                const row: StudyRow = { ...r, metaId: null, state: 'creating', result: null, opId: null, proposalId: null, error: null, resultsCheckedAt: null, createdAt: now };
                rows.set(row.id, row);
                return { ...row };
            },
            async update(creatorId, id, patch) {
                const row = rows.get(id);
                if (!row || row.creatorId !== creatorId) return null;
                Object.assign(row, patch);
                return { ...row };
            },
            async list(creatorId) {
                return [...rows.values()].filter((r) => r.creatorId === creatorId).map((r) => ({ ...r }));
            },
            async get(creatorId, id) {
                const row = rows.get(id);
                return row && row.creatorId === creatorId ? { ...row } : null;
            },
            async open() {
                return [...rows.values()].filter((r) => ['creating', 'ready', 'running'].includes(r.state)).map((r) => ({ ...r }));
            },
        },
        account: async () => account,
        saveBusinessId: async (_c, id) => {
            saved.push(id);
        },
        listBusinesses: async () => opts.businesses ?? [],
        graphGet: async (_c, path) => {
            graphCalls.push(path);
            if (path.endsWith('/objectives')) return { data: [{ id: 'obj-1', name: 'Cost per result', is_primary: true }] };
            return { results: opts.results ?? [] };
        },
        getObject: async (_c, id) => objects.get(id) ?? null,
        money: async (_c, candidate) => {
            moneyCalls.push(candidate);
            return opts.money ?? { fits: true, reason: null, remaining: 500, currency: 'SAR' };
        },
        enqueue: async (input) => {
            const id = `op-${ops.length + 1}`;
            ops.push({ ...input, id });
            const op: StudyOp = { id, kind: input.kind, state: 'pending', notBefore: now.toISOString(), result: null };
            opState.set(id, op);
            return op;
        },
        setStatus: async (_c, objectId, status) => {
            writes.push([objectId, status]);
            return { id: `w-${writes.length}`, kind: 'status', state: 'pending', notBefore: now.toISOString(), result: null };
        },
        setDailyBudget: async (_c, objectId, amount) => {
            writes.push([objectId, `daily:${amount}`]);
            return { id: `w-${writes.length}`, kind: 'budget', state: 'pending', notBefore: now.toISOString(), result: null };
        },
        getOp: async (_c, id) => opState.get(id) ?? null,
        createProposal: async (_c, p) => {
            proposals.push(p);
            return { id: `prop-${proposals.length}` };
        },
        now: () => now,
    };
    return {
        ports, rows, ops, writes, opState, proposals, moneyCalls, graphCalls, saved, account,
        setNow: (d: Date) => {
            now = d;
        },
    };
}

async function refused(p: Promise<unknown>, code: string, field?: string): Promise<StudyError> {
    try {
        await p;
    } catch (err) {
        assert.ok(err instanceof StudyError, `expected a StudyError, got ${String(err)}`);
        assert.equal(err.code, code);
        if (field) assert.equal(err.field, field);
        return err;
    }
    assert.fail(`expected ${code}`);
}

describe('equalSplit', () => {
    it('adds up to 100, the remainder to the first arms', () => {
        assert.deepEqual(equalSplit(2), [50, 50]);
        assert.deepEqual(equalSplit(3), [34, 33, 33]);
        assert.deepEqual(equalSplit(7), [15, 15, 14, 14, 14, 14, 14]);
        for (let n = 2; n <= 7; n++) assert.equal(equalSplit(n).reduce((a, b) => a + b, 0), 100);
    });
});

describe('parseStudyInput', () => {
    it('reads a date as midnight in the ad account\'s day', () => {
        assert.equal(accountMidnight('2026-10-24', 3)!.toISOString(), '2026-10-23T21:00:00.000Z');
        assert.equal(accountMidnight('2026-02-30', 0), null);
    });

    it('accepts a creative test from tomorrow, with its days counted', () => {
        const p = parseStudyInput(creativeBody, NOW, 3);
        assert.ok(p.ok);
        assert.equal(p.value.days, 7);
        assert.equal(p.value.dailyBudget, 30);
    });

    it('refuses today, more than 30 days, one arm, a repeated arm, no budget and no confirm', () => {
        const bad: Array<[Record<string, unknown>, string]> = [
            [{ start: '2026-10-22' }, 'start'],
            [{ end: '2026-11-24' }, 'end'],
            [{ end: '2026-10-24' }, 'end'],
            [{ cells: ['ad-a'] }, 'cells'],
            [{ cells: ['ad-a', 'ad-a'] }, 'cells'],
            [{ cells: ['a', 'b', 'c', 'd', 'e', 'f'], type: 'audience' }, 'cells'],
            [{ dailyBudget: 0 }, 'dailyBudget'],
            [{ confirm: 'yes' }, 'confirm'],
            [{ type: 'placement' }, 'type'],
        ];
        for (const [over, field] of bad) {
            const p = parseStudyInput({ ...creativeBody, ...over }, NOW, 3);
            assert.ok(!p.ok, JSON.stringify(over));
            assert.equal(p.field, field, JSON.stringify(over));
        }
    });
});

describe('checkArms', () => {
    it('refuses a running arm, an ad from another ad set, an ad set on a campaign budget, and a wrong level', () => {
        assert.throws(() => checkArms('creative', ['a', 'b'], [AD_A, { ...AD_B, status: 'ACTIVE' }]), /paused/);
        assert.throws(() => checkArms('creative', ['a', 'b'], [AD_A, { ...AD_B, parentId: 'other' }]), /same ad set/);
        assert.throws(() => checkArms('audience', ['a', 'b'], [SET_EG, { ...SET_SA, budgetKind: 'none' }]), /own daily budget/);
        assert.throws(() => checkArms('audience', ['a', 'b'], [AD_A, AD_B]), /ad sets/);
        assert.throws(() => checkArms('creative', ['a', 'b'], [AD_A, null]), (e: StudyError) => e.code === 'NOT_OWN_OBJECT');
    });
});

describe('buildStudyParams', () => {
    const start = new Date('2026-10-23T21:00:00Z');
    const end = new Date('2026-10-30T21:00:00Z');

    it('a creative test is SPLIT_TEST_V2: one ad per cell, the daily budget in minor units, cooldown and observation on the dates', () => {
        const cells = buildCells('creative', [AD_A, AD_B]);
        const p = buildStudyParams({ type: 'creative', metaName: 'T · 12345678', cells, start, end, dailyBudget: 30, currency: 'SAR' });
        assert.equal(p.type, 'SPLIT_TEST_V2');
        assert.deepEqual(p.cells, [
            { name: 'A', treatment_percentage: 50, ads: ['m-ad-a'] },
            { name: 'B', treatment_percentage: 50, ads: ['m-ad-b'] },
        ]);
        assert.deepEqual(p.creative_test_config, { daily_budget: 3000 });
        assert.equal(p.start_time, 1792789200);
        assert.equal(p.cooldown_start_time, p.start_time);
        assert.equal(p.observation_end_time, p.end_time);
    });

    it('an audience test is SPLIT_TEST with one ad set per cell and no creative config', () => {
        const p = buildStudyParams({ type: 'audience', metaName: 'T', cells: buildCells('audience', [SET_EG, SET_SA]), start, end, dailyBudget: 30, currency: 'SAR' });
        assert.equal(p.type, 'SPLIT_TEST');
        assert.deepEqual((p.cells as Array<{ adsets: string[] }>).map((c) => c.adsets), [['m-set-eg'], ['m-set-sa']]);
        assert.equal(p.creative_test_config, undefined);
    });

    it('a zero-decimal currency is sent as is', () => {
        const p = buildStudyParams({ type: 'creative', metaName: 'T', cells: buildCells('creative', [AD_A, AD_B]), start, end, dailyBudget: 3000, currency: 'JPY' });
        assert.deepEqual(p.creative_test_config, { daily_budget: 3000 });
    });

    it('splits an audience test\'s budget to the cent, never up', () => {
        assert.equal(armDailyBudget(10, 3), 3.33);
        assert.equal(armDailyBudget(30, 2), 15);
    });
});

describe('results', () => {
    const cells = buildCells('creative', [AD_A, AD_B]);
    const end = new Date('2026-10-30T21:00:00Z');
    const after = new Date(end.getTime() + FINAL_AFTER_END_MS);

    it('reads confidence as a percent, from a fraction or a percent', () => {
        assert.equal(normaliseConfidence(0.873), 87.3);
        assert.equal(normaliseConfidence(87.3), 87.3);
        assert.equal(normaliseConfidence('0.5'), 50);
        assert.equal(normaliseConfidence(null), null);
        assert.equal(normaliseConfidence(140), null);
    });

    it('parses results as an object, a JSON string, or a list of either', () => {
        const body = { high_performer_ids: ['m-ad-a'], winner_ad_object_id: null, winner_confidence: null, confidence_by_ad_object_id: { 'm-ad-a': 0.91, 'm-ad-b': 0.09 } };
        for (const raw of [body, JSON.stringify(body), [JSON.stringify(body)], [body], { results: [JSON.stringify(body)] }]) {
            const p = parseObjectiveResults(raw);
            assert.deepEqual(p.highPerformerIds, ['m-ad-a']);
            assert.deepEqual(p.confidenceById, { 'm-ad-a': 91, 'm-ad-b': 9 });
        }
        assert.deepEqual(parseObjectiveResults('not json').highPerformerIds, []);
    });

    it('high_performer_ids name the winner; the declared winner is the fallback (audience tests)', () => {
        const r = decideResult(cells, { highPerformerIds: ['m-ad-b'], winnerId: null, winnerConfidence: null, confidenceById: { 'm-ad-b': 88 } }, end, after);
        assert.deepEqual(r.winnerObjectIds, ['ad-b']);
        assert.deepEqual(r.confidenceByObjectId, { 'ad-b': 88 });
        assert.ok(r.final && !r.noWinner);
        const w = decideResult(cells, { highPerformerIds: [], winnerId: 'm-ad-a', winnerConfidence: 76, confidenceById: {} }, end, after);
        assert.deepEqual(w.winnerObjectIds, ['ad-a']);
        assert.equal(w.confidenceByObjectId['ad-a'], 76);
    });

    it('every arm a high performer, or none, is no winner once final; an id that is not an arm is ignored', () => {
        assert.ok(decideResult(cells, { highPerformerIds: ['m-ad-a', 'm-ad-b'], winnerId: null, winnerConfidence: null, confidenceById: {} }, end, after).noWinner);
        assert.ok(decideResult(cells, { highPerformerIds: ['m-other'], winnerId: null, winnerConfidence: null, confidenceById: {} }, end, after).noWinner);
        const early = decideResult(cells, { highPerformerIds: [], winnerId: null, winnerConfidence: null, confidenceById: {} }, end, new Date(end.getTime() - 1));
        assert.ok(!early.final && !early.noWinner);
    });

    it('a final result with a winner proposes pausing the other arms (test_winner, source study); none otherwise', () => {
        const study = { id: 's-1', name: 'Reels', cells, startTime: new Date('2026-10-23T21:00:00Z'), endTime: end, dailyBudget: 30, currency: 'SAR' };
        const r = decideResult(cells, { highPerformerIds: ['m-ad-a'], winnerId: null, winnerConfidence: null, confidenceById: { 'm-ad-a': 91 } }, end, after);
        const p = winnerProposal(study, r, 'en')!;
        assert.equal(p.kind, 'test_winner');
        assert.equal(p.source, 'study');
        assert.equal(p.state, 'open');
        assert.deepEqual(p.payload.item.targets, ['ad-b']);
        assert.equal(p.payload.item.kind, 'pause');
        assert.deepEqual(p.payload.item.change, { percent: -100 });
        assert.equal(p.payload.item.evidence.window, '7d');
        assert.match(p.rationale, /91% confidence/);
        assert.deepEqual(p.evidence.numbers, { days: 7, dailyBudget: 30, confidence_A: 91 });
        assert.equal(p.evidence.studyId, 's-1');
        assert.match(winnerProposal(study, r, 'ar')!.rationale, /نقترح إيقاف/);
        assert.equal(winnerProposal(study, { ...r, final: false }, 'en'), null);
        assert.equal(winnerProposal(study, { ...r, noWinner: true, winnerObjectIds: [] }, 'en'), null);
    });
});

describe('reconcileCreate', () => {
    it('done with an id → ready; failed → Meta\'s words; still queued → nothing', () => {
        assert.deepEqual(reconcileCreate({ id: 'o', kind: 'study', state: 'done', notBefore: '', result: { id: 123 } }), { state: 'ready', metaId: '123', error: null });
        assert.deepEqual(reconcileCreate({ id: 'o', kind: 'study', state: 'failed', notBefore: '', result: { message: 'No business' } }), { state: 'failed', error: 'No business' });
        assert.equal(reconcileCreate({ id: 'o', kind: 'study', state: 'pending', notBefore: '', result: null }), null);
    });
});

describe('createStudy', () => {
    it('a creative test: money-checked on daily × days, stored, ONE study op to the business, and no arm switched on', async () => {
        const h = harness();
        const { study, ops } = await createStudy(h.ports, T, 'u-1', creativeBody);
        assert.deepEqual(h.moneyCalls, [{ amount: 210, days: 7 }]);
        assert.equal(ops.length, 1);
        assert.equal(h.ops[0]!.kind, 'study');
        assert.deepEqual(h.ops[0]!.payload.exec && (h.ops[0]!.payload.exec as { path: string }).path, 'biz-1/ad_studies');
                assert.deepEqual(h.writes, [], 'creating never switches anything on');
        assert.equal(h.ops[0]!.payload.exec!.edge, 'ad_studies', 'a tagged create: a timed-out one is looked for, never made twice');
        assert.equal(study.state, 'creating');
        assert.deepEqual(study.cells.map((c) => [c.name, c.treatmentPercentage, c.level]), [['A', 50, 'ad'], ['B', 50, 'ad']]);
        assert.equal(study.currency, 'SAR');
    });

    it('an audience test sets each ad set\'s daily budget equal first (paused: nothing spends), then queues the study', async () => {
        const h = harness();
        const { ops } = await createStudy(h.ports, T, 'u-1', { ...creativeBody, type: 'audience', cells: ['set-eg', 'set-sa'] });
        assert.deepEqual(h.writes, [['set-eg', 'daily:15'], ['set-sa', 'daily:15']]);
        assert.deepEqual(ops.map((o) => o.kind), ['budget', 'budget', 'study']);
        assert.equal(h.ops[0]!.payload.exec!.params!['type'], 'SPLIT_TEST');
    });

    it('over the limits: refused with the money rule\'s code, nothing stored, nothing queued', async () => {
        const h = harness({ money: { fits: false, reason: 'OVER_MONTHLY_CAP', remaining: 40, currency: 'SAR' } });
        const err = await refused(createStudy(h.ports, T, 'u-1', creativeBody), 'OVER_MONTHLY_CAP', 'dailyBudget');
        assert.equal(err.extra.remaining, 40);
        assert.equal(h.rows.size, 0);
        assert.equal(h.ops.length, 0);
    });

    it('no saved business: the only one the token sees is used and saved; several ask the owner to pick', async () => {
        const one = harness({ businessId: null, businesses: [{ id: 'biz-9', name: 'Academy' }] });
        await createStudy(one.ports, T, 'u-1', creativeBody);
        assert.deepEqual(one.saved, ['biz-9']);
        assert.equal((one.ops[0]!.payload.exec as { path: string }).path, 'biz-9/ad_studies');
        const many = harness({ businessId: null, businesses: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
        const err = await refused(createStudy(many.ports, T, 'u-1', creativeBody), 'BUSINESS_REQUIRED', 'businessId');
        assert.equal((err.extra.choices as unknown[]).length, 2);
        assert.equal(many.ops.length, 0);
    });

    it('a running arm, or one from another ad account, is refused before anything is queued', async () => {
        const h = harness({ objects: [CAMPAIGN, ADSET, AD_A, { ...AD_B, status: 'ACTIVE' }] });
        await refused(createStudy(h.ports, T, 'u-1', creativeBody), 'INVALID', 'cells');
        const other = harness({ objects: [CAMPAIGN, ADSET, { ...AD_A, adAccountId: 'act_2' }, { ...AD_B, adAccountId: 'act_2' }] });
        await refused(createStudy(other.ports, T, 'u-1', creativeBody), 'NOT_OWN_OBJECT');
        assert.equal(h.ops.length + other.ops.length, 0);
    });
});

describe('startStudy and stopStudy', () => {
    async function readyStudy() {
        const h = harness();
        const { study } = await createStudy(h.ports, T, 'u-1', creativeBody);
        h.opState.set('op-1', { id: 'op-1', kind: 'study', state: 'done', notBefore: '', result: { id: '9001' } });
        return { h, id: study.id };
    }

    it('needs confirm: true, and a study Meta has not made yet cannot start', async () => {
        const h = harness();
        const { study } = await createStudy(h.ports, T, 'u-1', creativeBody);
        await refused(startStudy(h.ports, T, 'u-1', study.id, {}), 'INVALID', 'confirm');
        await refused(startStudy(h.ports, T, 'u-1', study.id, { confirm: true }), 'INVALID', 'state');
    });

    it('re-runs the money rule on the test plus the paused ad set it switches on, then activates arms → ad set → campaign in a chain', async () => {
        const { h, id } = await readyStudy();
        const { study, ops } = await startStudy(h.ports, T, 'u-1', id, { confirm: true });
        // The start is in the future, so the whole 7-day run counts: 30×7 for the test + 20×7 for the paused ad set it switches on.
        assert.deepEqual(h.moneyCalls.at(-1), { amount: 350, days: 7 });
        assert.equal(study.state, 'running');
        assert.equal(study.metaId, '9001');
        assert.deepEqual(h.writes, [['ad-a', 'ACTIVE'], ['ad-b', 'ACTIVE'], ['set', 'ACTIVE'], ['camp', 'ACTIVE']], 'the campaign last');
        assert.equal(ops.length, 4);
    });

    it('refused by the money rule: nothing is switched on and the test stays ready', async () => {
        const { h, id } = await readyStudy();
        h.ports.money = async () => ({ fits: false, reason: 'OVER_DAILY_MAX', remaining: 0, currency: 'SAR' });
        await refused(startStudy(h.ports, T, 'u-1', id, { confirm: true }), 'OVER_DAILY_MAX');
        assert.deepEqual(h.writes, []);
        assert.equal(h.rows.get(id)!.state, 'ready');
    });

    it('stop pauses the arms and the ad set, without a confirm', async () => {
        const { h, id } = await readyStudy();
        await startStudy(h.ports, T, 'u-1', id, { confirm: true });
        const before = h.writes.length;
        const { study } = await stopStudy(h.ports, T, 'u-1', id);
        assert.equal(study.state, 'stopped');
        assert.deepEqual(h.writes.slice(before), [['ad-a', 'PAUSED'], ['ad-b', 'PAUSED'], ['set', 'PAUSED']]);
        await refused(stopStudy(h.ports, T, 'u-1', id), 'INVALID', 'state');
    });

    it('another tenant\'s test does not exist', async () => {
        const { h, id } = await readyStudy();
        await refused(startStudy(h.ports, 'tenant-2', 'u-1', id, { confirm: true }), 'NOT_FOUND');
    });
});

describe('listStudies and pollStudies', () => {
    it('GET reconciles a finished create from the queue and makes no Meta call', async () => {
        const h = harness();
        const { study } = await createStudy(h.ports, T, 'u-1', creativeBody);
        h.opState.set('op-1', { id: 'op-1', kind: 'study', state: 'done', notBefore: '', result: { id: '9001' } });
        const { studies, businessId } = await listStudies(h.ports, T);
        assert.equal(studies[0]!.id, study.id);
        assert.equal(studies[0]!.state, 'ready');
        assert.equal(businessId, 'biz-1');
        assert.deepEqual(h.graphCalls, []);
    });

    it('a running test is read, then after its end it ends with a winner and ONE proposal', async () => {
        const body = { high_performer_ids: ['m-ad-b'], confidence_by_ad_object_id: { 'm-ad-a': 0.12, 'm-ad-b': 0.88 } };
        const h = harness({ results: [JSON.stringify(body)] });
        const { study } = await createStudy(h.ports, T, 'u-1', creativeBody);
        h.opState.set('op-1', { id: 'op-1', kind: 'study', state: 'done', notBefore: '', result: { id: '9001' } });
        await startStudy(h.ports, T, 'u-1', study.id, { confirm: true });

        h.setNow(new Date('2026-10-25T10:00:00Z'));
        await pollStudies(h.ports, Date.now() + 10_000);
        assert.deepEqual(h.graphCalls, ['9001/objectives', 'obj-1']);
        assert.equal(h.rows.get(study.id)!.state, 'running');
        assert.equal(h.rows.get(study.id)!.result!.final, false);
        // Read again within 6 h: no call.
        h.setNow(new Date('2026-10-25T12:00:00Z'));
        await pollStudies(h.ports, Date.now() + 10_000);
        assert.equal(h.graphCalls.length, 2);

        h.setNow(new Date(h.rows.get(study.id)!.endTime.getTime() + FINAL_AFTER_END_MS));
        const counts = await pollStudies(h.ports, Date.now() + 10_000);
        assert.deepEqual(counts, { checked: 1, ended: 1, failed: 0 });
        const row = h.rows.get(study.id)!;
        assert.equal(row.state, 'ended');
        assert.deepEqual(row.result!.winnerObjectIds, ['ad-b']);
        assert.equal(row.proposalId, 'prop-1');
        assert.deepEqual(h.proposals[0]!.payload.item.targets, ['ad-a']);
        await pollStudies(h.ports, Date.now() + 10_000);
        assert.equal(h.proposals.length, 1, 'an ended study is not read again');
    });

    it('a throttled read is counted, left for the next run, and never retried in the same run', async () => {
        const h = harness();
        const { study } = await createStudy(h.ports, T, 'u-1', creativeBody);
        h.opState.set('op-1', { id: 'op-1', kind: 'study', state: 'done', notBefore: '', result: { id: '9001' } });
        await startStudy(h.ports, T, 'u-1', study.id, { confirm: true });
        h.setNow(new Date('2026-10-25T10:00:00Z'));
        let calls = 0;
        h.ports.graphGet = async () => {
            calls++;
            throw Object.assign(new Error('throttled'), { code: 'RATE_LIMITED' });
        };
        const seen: unknown[] = [];
        const counts = await pollStudies(h.ports, Date.now() + 10_000, (_r, e) => seen.push(e));
        assert.deepEqual(counts, { checked: 0, ended: 0, failed: 1 });
        assert.equal(calls, 1);
        assert.equal(seen.length, 1);
        assert.equal(h.rows.get(study.id)!.state, 'running');
    });

    it('a ready test whose dates passed without a start is stopped', async () => {
        const h = harness();
        const { study } = await createStudy(h.ports, T, 'u-1', creativeBody);
        h.opState.set('op-1', { id: 'op-1', kind: 'study', state: 'done', notBefore: '', result: { id: '9001' } });
        h.setNow(new Date('2026-11-02T00:00:00Z'));
        await pollStudies(h.ports, Date.now() + 10_000);
        assert.equal(h.rows.get(study.id)!.state, 'stopped');
        assert.equal(h.graphCalls.length, 0);
    });
});

describe('startWorstCase', () => {
    it('adds a paused daily parent for every day and a lifetime parent once', () => {
        assert.equal(startWorstCase(30, 7, []), 210);
        assert.equal(startWorstCase(30, 7, [ADSET]), 350);
        assert.equal(startWorstCase(30, 7, [{ ...CAMPAIGN, budgetKind: 'lifetime', budgetAmount: 100 }]), 310);
    });
});
