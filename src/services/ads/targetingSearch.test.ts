/** Targeting search, minimum budgets and the reach estimate (A5): the Graph params sent, the answers mapped, the 24 h caches. */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { AdsError } from '../adBoosts.js';
import type { AdsCallContext, AdsGraph } from './graphPort.js';
import { clearTargetingCache, reachEstimate, searchTargeting } from './targetingSearch.js';

const CTX: AdsCallContext = { tenantId: 't1', adAccountId: 'act_555', token: 'tok' };

interface Call { path: string; params: Record<string, string>; label: string }

function stubGraph(answer: (call: Call) => unknown): { graph: AdsGraph; calls: Call[] } {
    const calls: Call[] = [];
    const graph: AdsGraph = {
        async get(path, params, label) {
            const call = { path, params, label };
            calls.push(call);
            const out = answer(call);
            if (out instanceof Error) throw out;
            return out;
        },
        async post() { throw new Error('no writes expected'); },
        async create() { throw new Error('no writes expected'); },
        async del() { throw new Error('no writes expected'); },
    };
    return { graph, calls };
}

beforeEach(() => {
    clearTargetingCache();
    setLogSink(() => {});
});

describe('searchTargeting', () => {
    it('asks Graph for interests and maps the audience size bounds', async () => {
        const { graph, calls } = stubGraph(() => ({ data: [
            { id: '6003', name: 'Coffee', audience_size_lower_bound: 1000, audience_size_upper_bound: 5000, path: ['x'] },
            { id: '6004', name: 'Tea' },
            { name: 'no id' },
        ] }));
        const out = await searchTargeting(CTX, graph, 'adinterest', '  coffee ');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.path, 'search');
        assert.deepEqual(calls[0]!.params, { type: 'adinterest', q: 'coffee', limit: '25' });
        assert.deepEqual(out.items, [
            { id: '6003', name: 'Coffee', type: 'adinterest', sizeLower: 1000, sizeUpper: 5000 },
            { id: '6004', name: 'Tea', type: 'adinterest' },
        ]);
    });

    it('asks for countries, cities and regions, and takes the geo key as the id', async () => {
        const { graph, calls } = stubGraph(() => ({ data: [
            { key: 'SA', name: 'Saudi Arabia', type: 'country', country_code: 'SA' },
            { key: '2430536', name: 'Riyadh', type: 'city', country_code: 'SA', region: 'Riyadh Region' },
        ] }));
        const out = await searchTargeting(CTX, graph, 'adgeolocation', 'riy');
        assert.deepEqual(calls[0]!.params, { type: 'adgeolocation', q: 'riy', limit: '25', location_types: '["country","city","region"]' });
        assert.deepEqual(out.items, [
            { id: 'SA', name: 'Saudi Arabia', type: 'adgeolocation', countryCode: 'SA' },
            { id: '2430536', name: 'Riyadh', type: 'adgeolocation', countryCode: 'SA', region: 'Riyadh Region' },
        ]);
    });

    it('takes the locale key as the id', async () => {
        const { graph } = stubGraph(() => ({ data: [{ key: 6, name: 'English (US)' }] }));
        const out = await searchTargeting(CTX, graph, 'adlocale', 'eng');
        assert.deepEqual(out.items, [{ id: '6', name: 'English (US)', type: 'adlocale' }]);
    });

    it('refuses a query shorter than 2 or longer than 80 characters, after trimming, and a type it does not know', async () => {
        const { graph, calls } = stubGraph(() => ({ data: [] }));
        for (const q of ['', ' a ', 'x'.repeat(81), undefined as unknown as string]) {
            await assert.rejects(searchTargeting(CTX, graph, 'adinterest', q), (e: unknown) => {
                assert.ok(e instanceof AdsError);
                assert.equal(e.status, 400);
                assert.equal(e.code, 'INVALID');
                assert.equal(e.field, 'q');
                return true;
            });
        }
        await assert.rejects(searchTargeting(CTX, graph, 'adbehavior' as never, 'ok'), (e: unknown) => e instanceof AdsError && e.field === 'type');
        assert.equal(calls.length, 0);
        await searchTargeting(CTX, graph, 'adinterest', 'x'.repeat(80));
        assert.equal(calls.length, 1);
    });

    it('answers a repeat from memory, whatever its case or spacing, but not across types', async () => {
        const { graph, calls } = stubGraph(() => ({ data: [{ id: '1', name: 'Coffee' }] }));
        await searchTargeting(CTX, graph, 'adinterest', 'Coffee');
        await searchTargeting(CTX, graph, 'adinterest', ' coffee ');
        assert.equal(calls.length, 1);
        await searchTargeting(CTX, graph, 'adlocale', 'coffee');
        assert.equal(calls.length, 2);
    });

    it('does not cache a failure', async () => {
        let fail = true;
        const { graph, calls } = stubGraph(() => (fail ? new Error('boom') : { data: [] }));
        await assert.rejects(searchTargeting(CTX, graph, 'adinterest', 'coffee'));
        fail = false;
        await searchTargeting(CTX, graph, 'adinterest', 'coffee');
        assert.equal(calls.length, 2);
    });

    it('forgets after 24 hours', async () => {
        const { graph, calls } = stubGraph(() => ({ data: [] }));
        const real = Date.now;
        let now = real();
        Date.now = () => now;
        try {
            await searchTargeting(CTX, graph, 'adinterest', 'coffee');
            now += 24 * 60 * 60 * 1000 - 1000;
            await searchTargeting(CTX, graph, 'adinterest', 'coffee');
            assert.equal(calls.length, 1);
            now += 2000;
            await searchTargeting(CTX, graph, 'adinterest', 'coffee');
            assert.equal(calls.length, 2);
        } finally {
            Date.now = real;
        }
    });

    it('keeps at most 500 entries, dropping the oldest', async () => {
        const { graph, calls } = stubGraph(() => ({ data: [] }));
        for (let i = 0; i < 501; i += 1) await searchTargeting(CTX, graph, 'adinterest', `query ${i}`);
        assert.equal(calls.length, 501);
        await searchTargeting(CTX, graph, 'adinterest', 'query 500');
        assert.equal(calls.length, 501, 'the newest is still there');
        await searchTargeting(CTX, graph, 'adinterest', 'query 0');
        assert.equal(calls.length, 502, 'the oldest was dropped');
    });
});

describe('reachEstimate', () => {
    it('sends the targeting as JSON and answers the bounds', async () => {
        const { graph, calls } = stubGraph(() => ({ data: { users_lower_bound: 1000, users_upper_bound: 2500 } }));
        const out = await reachEstimate(CTX, graph, { geo_locations: { countries: ['SA'] } });
        assert.equal(calls[0]!.path, 'act_555/reachestimate');
        assert.deepEqual(calls[0]!.params, { targeting_spec: '{"geo_locations":{"countries":["SA"]}}' });
        assert.deepEqual(out, { lower: 1000, upper: 2500 });
    });

    it('answers null, never throws, when Meta fails or answers something else', async () => {
        assert.equal(await reachEstimate(CTX, stubGraph(() => new Error('rate limit')).graph, {}), null);
        assert.equal(await reachEstimate(CTX, stubGraph(() => ({ data: {} })).graph, {}), null);
        assert.equal(await reachEstimate(CTX, stubGraph(() => ({})).graph, {}), null);
    });
});
