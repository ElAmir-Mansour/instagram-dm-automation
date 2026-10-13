/**
 * What a call cost: the price table, the model it is looked up by, and what an unpriced model is
 * charged so that it cannot spend past a budget for free.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PRICES, priceFor, usdFor, type PriceTable } from './cost.js';

describe('DEFAULT_PRICES', () => {
    it('seeds Opus 5.5 at $4 / $20, Sonnet 5.5 at $2 / $10 and Haiku 5.5 at $0.10 / $0.50 per million tokens', () => {
        assert.deepEqual(DEFAULT_PRICES, {
            'claude-opus-5-5': { in: 4, out: 20 },
            'claude-sonnet-5-5': { in: 2, out: 10 },
            'claude-haiku-5-5': { in: 0.1, out: 0.5 },
        });
    });

    it('prices every Anthropic model the registry suggests', () => {
        for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
            assert.equal(priceFor(model, DEFAULT_PRICES).priced, true, model);
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
        const table: PriceTable = { 'claude-opus-5': { in: 1, out: 2 } };
        assert.equal(priceFor('claude-opus-5-5', table).priced, false);
        assert.equal(priceFor('claude-opus-50', table).priced, false);
        assert.equal(priceFor('claude-opus-5', table).priced, true);
    });

    it('lets the longest matching entry win', () => {
        const table: PriceTable = { 'claude-opus-5-5': { in: 4, out: 20 }, 'claude-opus-5-5-20261001': { in: 9, out: 90 } };
        assert.deepEqual(priceFor('claude-opus-5-5-20261001', table), { in: 9, out: 90, priced: true });
        assert.deepEqual(priceFor('claude-opus-5-5', table), { in: 4, out: 20, priced: true });
    });

    it('charges an unknown model the highest rate in the table and says it is not priced', () => {
        assert.deepEqual(priceFor('some-new-model', DEFAULT_PRICES), { in: 4, out: 20, priced: false });
    });

    it('takes the highest input rate and the highest output rate separately, the more cautious reading', () => {
        const table: PriceTable = { cheapIn: { in: 1, out: 50 }, cheapOut: { in: 9, out: 2 } };
        assert.deepEqual(priceFor('mystery', table), { in: 9, out: 50, priced: false });
    });

    it('ignores table entries that are not prices, rather than charging NaN', () => {
        const table = { good: { in: 3, out: 6 }, broken: { in: 'a lot', out: null }, negative: { in: -1, out: 5 } } as unknown as PriceTable;
        assert.deepEqual(priceFor('good', table), { in: 3, out: 6, priced: true });
        assert.deepEqual(priceFor('broken', table), { in: 3, out: 6, priced: false });
    });

    it('charges nothing, marked unpriced, when there is no table at all', () => {
        assert.deepEqual(priceFor('anything', {}), { in: 0, out: 0, priced: false });
    });
});

describe('usdFor', () => {
    it('multiplies tokens by the per-million rate', () => {
        assert.deepEqual(usdFor({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 24, priced: true });
        assert.deepEqual(usdFor({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-sonnet-5-5', DEFAULT_PRICES), { usd: 2, priced: true });
        assert.deepEqual(usdFor({ input_tokens: 0, output_tokens: 1_000_000 }, 'claude-haiku-5-5', DEFAULT_PRICES), { usd: 0.5, priced: true });
    });

    it('prices a realistic call: 2,000 tokens in and 800 out on Opus 5.5 is 2.4 cents', () => {
        assert.deepEqual(usdFor({ input_tokens: 2000, output_tokens: 800 }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 0.024, priced: true });
    });

    it('keeps the cost of a single Haiku token, and rounds away only floating-point noise', () => {
        assert.equal(usdFor({ input_tokens: 1, output_tokens: 1 }, 'claude-haiku-5-5', DEFAULT_PRICES).usd, 0.0000006);
        assert.equal(usdFor({ input_tokens: 3, output_tokens: 0 }, 'claude-haiku-5-5', DEFAULT_PRICES).usd, 0.0000003);
        // 2000 * 4 + 800 * 20 is 24000 / 1e6, which in floating point is not quite 0.024.
        assert.equal(usdFor({ input_tokens: 2000, output_tokens: 800 }, 'claude-opus-5-5', DEFAULT_PRICES).usd, 0.024);
    });

    it('charges an unpriced model at the top rate and flags it', () => {
        assert.deepEqual(usdFor({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'gemini-3.8-flash', DEFAULT_PRICES), { usd: 24, priced: false });
    });

    it('uses a price the operator added, and so reports the model as priced', () => {
        const prices: PriceTable = { ...DEFAULT_PRICES, 'gemini-3.8-flash': { in: 0.3, out: 2.5 } };
        assert.deepEqual(usdFor({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'gemini-3.8-flash', prices), { usd: 2.8, priced: true });
    });

    it('treats tokens that are not positive numbers as none', () => {
        assert.deepEqual(usdFor({ input_tokens: -5, output_tokens: Number.NaN }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 0, priced: true });
    });
});
