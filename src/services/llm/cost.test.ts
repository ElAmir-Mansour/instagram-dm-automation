/**
 * What a call cost: the price table, the model it is looked up by, and what an unpriced model is
 * charged so that it cannot spend past a budget for free.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { costOf, DEFAULT_PRICES, priceFor, totalUsage, usdFor, type PriceTable } from './cost.js';
import { PROVIDERS } from './registry.js';

describe('DEFAULT_PRICES', () => {
    it('seeds the Claude and Gemini models the registry offers, at the rates on the providers\' pricing pages', () => {
        assert.deepEqual(DEFAULT_PRICES, {
            'claude-opus-5-5': { in: 4, out: 20 },
            'claude-opus-5': { in: 5, out: 25 },
            'claude-opus-4-8': { in: 5, out: 25 },
            'claude-sonnet-5-5': { in: 2, out: 10 },
            'claude-sonnet-5': { in: 2, out: 10 },
            'claude-haiku-5-5': { in: 0.1, out: 0.5 },
            'gemini-3.8-flash': { in: 1.5, out: 7.5 },
            'gemini-3.1-pro-preview': { in: 2, out: 12 },
        });
    });

    it('prices every Anthropic and Gemini model the registry suggests or defaults to', () => {
        for (const p of PROVIDERS.filter((p) => p.id === 'anthropic' || p.id === 'gemini')) {
            for (const model of [p.defaultModel, ...p.suggestedModels]) {
                assert.equal(priceFor(model, {}).priced, true, `${p.id}: ${model}`);
            }
        }
    });
});

describe('priceFor', () => {
    it('finds a model by its id', () => {
        assert.deepEqual(priceFor('claude-sonnet-5-5', DEFAULT_PRICES), { in: 2, out: 10, priced: true });
    });

    it('ignores case and surrounding space in the id', () => {
        assert.deepEqual(priceFor('  Claude-Opus-5-5 ', DEFAULT_PRICES), { in: 4, out: 20, priced: true });
    });

    it('prices a dated snapshot as its alias', () => {
        assert.equal(priceFor('claude-opus-5-5-20261001', DEFAULT_PRICES).priced, true);
        assert.equal(priceFor('claude-opus-5-5-latest', DEFAULT_PRICES).priced, true);
    });

    it('does not price a different model as one whose name it merely starts with', () => {
        // `claude-opus-5` is in the defaults; Opus 5.5 is a different price, found by its own key.
        assert.deepEqual(priceFor('claude-opus-5-5', {}), { in: 4, out: 20, priced: true });
        assert.equal(priceFor('claude-opus-5-6', {}).priced, false);
        assert.equal(priceFor('claude-opus-50', {}).priced, false);
    });

    it('lets the longest matching entry win', () => {
        const table: PriceTable = { 'claude-opus-5-5-20261001': { in: 9, out: 90 } };
        assert.deepEqual(priceFor('claude-opus-5-5-20261001', table), { in: 9, out: 90, priced: true });
        assert.deepEqual(priceFor('claude-opus-5-5', table), { in: 4, out: 20, priced: true });
    });

    it('charges an unknown model the highest rate in the table and says it is not priced', () => {
        assert.deepEqual(priceFor('some-new-model', DEFAULT_PRICES), { in: 5, out: 25, priced: false });
    });

    it('takes the highest input rate and the highest output rate separately, the more cautious reading', () => {
        const table: PriceTable = { cheapIn: { in: 1, out: 500 }, cheapOut: { in: 90, out: 2 } };
        assert.deepEqual(priceFor('mystery', table), { in: 90, out: 500, priced: false });
    });

    it('lays the operator\'s prices over the defaults and never uses them instead: an empty table cannot make a call free', () => {
        assert.deepEqual(priceFor('claude-opus-5-5', {}), { in: 4, out: 20, priced: true });
        // The ceiling an unknown model gets is still the defaults' highest rate.
        assert.deepEqual(priceFor('anything', {}), { in: 5, out: 25, priced: false });
        assert.deepEqual(priceFor('anything', undefined as unknown as PriceTable), { in: 5, out: 25, priced: false });
        assert.ok(usdFor({ in: 1_000_000, out: 1_000_000 }, 'anything', {}).usd > 0);
    });

    it('lets an operator\'s entry win over the default of the same model, in either direction', () => {
        assert.deepEqual(priceFor('claude-opus-5-5', { 'claude-opus-5-5': { in: 6, out: 30 } }), { in: 6, out: 30, priced: true });
        assert.deepEqual(priceFor('claude-opus-5-5', { 'Claude-Opus-5-5': { in: 1, out: 2 } }), { in: 1, out: 2, priced: true });
    });

    it('raises the ceiling when the operator prices something dearer than anything seeded', () => {
        assert.deepEqual(priceFor('mystery', { 'gpt-6-astra': { in: 10, out: 50 } }), { in: 10, out: 50, priced: false });
        assert.deepEqual(priceFor('gpt-6-astra', { 'gpt-6-astra': { in: 10, out: 50 } }), { in: 10, out: 50, priced: true });
    });

    it('ignores table entries that are not prices, so a broken one cannot blank out a default or charge NaN', () => {
        const table = {
            'claude-opus-5-5': { in: 'a lot', out: null },
            negative: { in: -1, out: 5 },
            nan: { in: Number.NaN, out: 1 },
            'my-model': { in: 3, out: 6 },
        } as unknown as PriceTable;
        assert.deepEqual(priceFor('claude-opus-5-5', table), { in: 4, out: 20, priced: true });
        assert.deepEqual(priceFor('my-model', table), { in: 3, out: 6, priced: true });
        assert.deepEqual(priceFor('negative', table), { in: 5, out: 25, priced: false });
        assert.deepEqual(priceFor('nan', table), { in: 5, out: 25, priced: false });
    });
});

describe('usdFor', () => {
    it('multiplies tokens by the per-million rate', () => {
        assert.deepEqual(usdFor({ in: 1_000_000, out: 1_000_000 }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 24, priced: true });
        assert.deepEqual(usdFor({ in: 1_000_000, out: 0 }, 'claude-sonnet-5-5', DEFAULT_PRICES), { usd: 2, priced: true });
        assert.deepEqual(usdFor({ in: 0, out: 1_000_000 }, 'claude-haiku-5-5', DEFAULT_PRICES), { usd: 0.5, priced: true });
    });

    it('prices a realistic call: 2,000 tokens in and 800 out on Opus 5.5 is 2.4 cents', () => {
        assert.deepEqual(usdFor({ in: 2000, out: 800 }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 0.024, priced: true });
    });

    it('keeps the cost of a single Haiku token, and rounds away only floating-point noise', () => {
        assert.equal(usdFor({ in: 1, out: 1 }, 'claude-haiku-5-5', DEFAULT_PRICES).usd, 0.0000006);
        assert.equal(usdFor({ in: 3, out: 0 }, 'claude-haiku-5-5', DEFAULT_PRICES).usd, 0.0000003);
        // 2000 * 4 + 800 * 20 is 24000 / 1e6, which in floating point is not quite 0.024.
        assert.equal(usdFor({ in: 2000, out: 800 }, 'claude-opus-5-5', DEFAULT_PRICES).usd, 0.024);
    });

    it('charges an unpriced model at the top rate and flags it', () => {
        assert.deepEqual(usdFor({ in: 1_000_000, out: 1_000_000 }, 'gpt-9-unknown', DEFAULT_PRICES), { usd: 30, priced: false });
    });

    it('uses a price the operator added, and so reports the model as priced', () => {
        const prices: PriceTable = { 'gemini-4-flash': { in: 0.3, out: 2.5 } };
        assert.deepEqual(usdFor({ in: 1_000_000, out: 1_000_000 }, 'gemini-4-flash', prices), { usd: 2.8, priced: true });
    });

    it('treats tokens that are not positive numbers as none', () => {
        assert.deepEqual(usdFor({ in: -5, out: Number.NaN }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 0, priced: true });
    });
});

describe('totalUsage and costOf', () => {
    // The shape of a server-side fallback: Opus 5.5 declined, Opus 4.8 answered.
    const fallback = [
        { model: 'claude-opus-5-5', in: 535, out: 0 },
        { model: 'claude-opus-4-8', in: 412, out: 264 },
    ];

    it('adds up every model\'s tokens', () => {
        assert.deepEqual(totalUsage(fallback), { in: 947, out: 264 });
        assert.deepEqual(totalUsage([]), { in: 0, out: 0 });
    });

    it('prices each model it was billed on at its own rate', () => {
        const cost = costOf(fallback, DEFAULT_PRICES);
        // 535 * $4 / 1e6, and 412 * $5 + 264 * $25 / 1e6.
        assert.deepEqual(cost.billed.map((b) => b.usd), [0.00214, 0.00866]);
        assert.equal(cost.usd, 0.0108);
        assert.equal(cost.priced, true);
        assert.deepEqual(cost.billed.map((b) => b.model), ['claude-opus-5-5', 'claude-opus-4-8']);
    });

    it('is unpriced if any one model had to be charged at the ceiling', () => {
        const cost = costOf([{ model: 'claude-opus-5-5', in: 1000, out: 0 }, { model: 'mystery-1', in: 1000, out: 0 }], DEFAULT_PRICES);
        assert.equal(cost.priced, false);
        assert.deepEqual(cost.billed.map((b) => b.usd), [0.004, 0.005]);
    });

    it('is nothing for a call that billed nothing', () => {
        assert.deepEqual(costOf([], DEFAULT_PRICES), { usd: 0, priced: true, billed: [] });
    });

    it('does not modify the entries it was given', () => {
        const entries = [{ model: 'claude-opus-5-5', in: 10, out: 10 }];
        costOf(entries, DEFAULT_PRICES);
        assert.deepEqual(entries, [{ model: 'claude-opus-5-5', in: 10, out: 10 }]);
    });
});

describe('a figure the provider reports', () => {
    // OpenRouter's `usage.cost` arrives as `usd` with `source: 'provider'` (adapters/chatCompletions.ts).
    it('is kept by costOf and beats the table, and the entry counts as priced even for a model nobody has a price for', () => {
        const cost = costOf([{ model: 'anthropic/claude-opus-5.5', in: 1_000_000, out: 1_000_000, usd: 0.0123, source: 'provider' }], DEFAULT_PRICES);
        assert.equal(cost.usd, 0.0123);
        assert.equal(cost.priced, true);
        assert.deepEqual(cost.billed, [{ model: 'anthropic/claude-opus-5.5', in: 1_000_000, out: 1_000_000, usd: 0.0123, source: 'provider' }]);
        // Even one the table does price: the provider's number is the invoice.
        assert.equal(costOf([{ model: 'claude-opus-5-5', in: 1_000_000, out: 1_000_000, usd: 1, source: 'provider' }], DEFAULT_PRICES).usd, 1);
    });

    it('may be zero: a free model is free', () => {
        const cost = costOf([{ model: 'meta/llama:free', in: 500, out: 500, usd: 0, source: 'provider' }], DEFAULT_PRICES);
        assert.equal(cost.usd, 0);
        assert.equal(cost.priced, true);
    });

    it('is ignored when it is not a usable number, so a bad figure cannot make a call free or negative', () => {
        for (const usd of [-1, Number.NaN, Number.POSITIVE_INFINITY, '0.5' as unknown as number]) {
            const cost = costOf([{ model: 'claude-opus-5-5', in: 1_000_000, out: 0, usd, source: 'provider' }], DEFAULT_PRICES);
            assert.equal(cost.usd, 4, String(usd));
            assert.equal(cost.priced, true);
            assert.equal(cost.billed[0]!.source, 'table');
        }
    });

    it('is not trusted without its source: a usd nobody marked as the provider\'s is the table\'s to compute', () => {
        const cost = costOf([{ model: 'claude-opus-5-5', in: 1_000_000, out: 0, usd: 0.0001 }], DEFAULT_PRICES);
        assert.equal(cost.usd, 4);
        assert.deepEqual(cost.billed.map((b) => b.source), ['table']);
        assert.equal(costOf([{ model: 'claude-opus-5-5', in: 1_000_000, out: 0, usd: 0.0001, source: 'table' }], DEFAULT_PRICES).usd, 4);
    });

    it('is added to the table\'s price for the other entries of the same call', () => {
        const cost = costOf([{ model: 'claude-opus-5-5', in: 1_000_000, out: 0 }, { model: 'x/y', in: 5, out: 5, usd: 0.01, source: 'provider' }], DEFAULT_PRICES);
        assert.equal(cost.usd, 4.01);
        assert.deepEqual(cost.billed.map((b) => b.usd), [4, 0.01]);
        assert.deepEqual(cost.billed.map((b) => b.source), ['table', 'provider']);
    });

    it('marks what it priced itself as the table\'s', () => {
        assert.deepEqual(costOf([{ model: 'claude-opus-5-5', in: 1_000_000, out: 0 }], DEFAULT_PRICES).billed, [{ model: 'claude-opus-5-5', in: 1_000_000, out: 0, usd: 4, source: 'table' }]);
    });

    it('costs the same when the result is priced again, a provider\'s figure or the table\'s', () => {
        const mixed = costOf([{ model: 'x/y', in: 5, out: 5, usd: 0.0123, source: 'provider' }, { model: 'claude-opus-5-5', in: 1000, out: 1000 }], DEFAULT_PRICES);
        assert.deepEqual(costOf(mixed.billed, DEFAULT_PRICES), mixed);
    });

    it('cannot turn an unpriced ceiling estimate into a priced one by running costOf twice', () => {
        // A model nobody has a price for is charged at the table's ceiling and flagged.
        const first = costOf([{ model: 'mystery/model-9', in: 1_000_000, out: 1_000_000 }], DEFAULT_PRICES);
        assert.equal(first.priced, false);
        assert.equal(first.usd, 30);
        // Its `usd` is now on the entry, which is what used to make the second pass trust it.
        const second = costOf(first.billed, DEFAULT_PRICES);
        assert.equal(second.priced, false);
        assert.equal(second.usd, 30);
        assert.deepEqual(costOf(second.billed, DEFAULT_PRICES), second);
    });
});
