/**
 * What a call cost: the price table, the model it is looked up by, and what an unpriced model is
 * charged so that it cannot spend past a budget for free.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    billedFromUsage, CACHE_WRITE_MULTIPLIER, cacheReadMultiplier, costOf, DEFAULT_CACHE_READ_MULTIPLIER, DEFAULT_PRICES, priceFor, totalUsage, usdFor, type PriceTable,
} from './cost.js';
import { PROVIDERS } from './registry.js';

describe('DEFAULT_PRICES', () => {
    it('seeds the Claude, Gemini, Groq and Muse models the registry offers, at the rates on the providers\' pricing pages', () => {
        assert.deepEqual(DEFAULT_PRICES, {
            'claude-opus-5-5': { in: 4, out: 20 },
            'claude-opus-5': { in: 5, out: 25 },
            'claude-opus-4-8': { in: 5, out: 25 },
            'claude-sonnet-5-5': { in: 2, out: 10 },
            'claude-sonnet-5': { in: 2, out: 10 },
            'claude-haiku-5-5': { in: 0.1, out: 0.5 },
            'gemini-3.8-flash': { in: 1.5, out: 7.5 },
            'gemini-3.1-pro-preview': { in: 2, out: 12 },
            'openai/gpt-oss-120b': { in: 0.15, out: 0.6 },
            'openai/gpt-oss-20b': { in: 0.075, out: 0.3 },
            'muse-spark-1.3': { in: 1.25, out: 4.25 },
            'muse-spark-1.2': { in: 1.25, out: 4.25 },
            'muse-spark-1.1': { in: 1.25, out: 4.25 },
            'muse-wonder-1.0': { in: 4, out: 20 },
        });
    });

    it('prices every Anthropic, Gemini, Groq and Meta model the registry suggests or defaults to', () => {
        for (const p of PROVIDERS.filter((p) => p.id === 'anthropic' || p.id === 'gemini' || p.id === 'groq' || p.id === 'meta')) {
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

// ─── Prompt-cache tokens (S2 of the DM plan) ──────────────────────────────────────────────────
//
// Priced off the model's own input price: a read is a fraction of it, a write into the 5-minute cache is 1.25x. Checked against
// platform.claude.com/docs/en/about-claude/pricing on 2026-10-14: "Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are
// priced at 0.05x the base input price" ($0.20 and $0.10), Haiku 5.5 reads at $0.01 and writes at $0.125, and every other Claude model
// reads at a tenth.

describe('cache multipliers', () => {
    it('writes cost 1.25x the input price, and an unlisted model reads at a tenth', () => {
        assert.equal(CACHE_WRITE_MULTIPLIER, 1.25);
        assert.equal(DEFAULT_CACHE_READ_MULTIPLIER, 0.1);
    });

    it('reads at 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1 and Mythos 5.1, and a tenth on every other model', () => {
        assert.equal(cacheReadMultiplier('claude-opus-5-5'), 0.05);
        assert.equal(cacheReadMultiplier('claude-sonnet-5-5'), 0.05);
        assert.equal(cacheReadMultiplier('claude-fable-5-1'), 0.025);
        assert.equal(cacheReadMultiplier('claude-mythos-5-1'), 0.025);
        for (const model of ['claude-haiku-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'gemini-3.8-flash', 'mystery/model-9', '']) {
            assert.equal(cacheReadMultiplier(model), 0.1, model);
        }
    });

    it('gives a dated snapshot its alias\'s multiplier, ignoring case and space, and does not mistake a longer name for the alias', () => {
        assert.equal(cacheReadMultiplier('claude-opus-5-5-20261001'), 0.05);
        assert.equal(cacheReadMultiplier('  Claude-Sonnet-5-5-latest '), 0.05);
        assert.equal(cacheReadMultiplier('claude-opus-5-50'), 0.1);
        assert.equal(cacheReadMultiplier('claude-opus-5-5x'), 0.1);
    });
});

describe('usdFor with cached input', () => {
    const M = 1_000_000;

    it('reads a million cached tokens at $0.20 on Opus 5.5 (0.05x of $4), $0.10 on Sonnet 5.5 and $0.01 on Haiku 5.5 (0.1x of $0.10)', () => {
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheRead: M }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 0.2, priced: true });
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheRead: M }, 'claude-sonnet-5-5', DEFAULT_PRICES), { usd: 0.1, priced: true });
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheRead: M }, 'claude-haiku-5-5', DEFAULT_PRICES), { usd: 0.01, priced: true });
    });

    it('reads at a tenth where the model has no better rate: Opus 4.8 and Sonnet 5 at $0.50 and $0.20 a million', () => {
        assert.equal(usdFor({ in: 0, out: 0, cacheRead: M }, 'claude-opus-4-8', DEFAULT_PRICES).usd, 0.5);
        assert.equal(usdFor({ in: 0, out: 0, cacheRead: M }, 'claude-sonnet-5', DEFAULT_PRICES).usd, 0.2);
    });

    it('writes a million tokens into the cache at 1.25x the input price: $5 on Opus 5.5, $2.50 on Sonnet 5.5, $0.125 on Haiku 5.5', () => {
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheWrite: M }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 5, priced: true });
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheWrite: M }, 'claude-sonnet-5-5', DEFAULT_PRICES), { usd: 2.5, priced: true });
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheWrite: M }, 'claude-haiku-5-5', DEFAULT_PRICES), { usd: 0.125, priced: true });
        assert.equal(usdFor({ in: 0, out: 0, cacheWrite: M }, 'claude-opus-4-8', DEFAULT_PRICES).usd, 6.25);
    });

    it('adds the three kinds of input and the output: they are separate, so cached tokens are never inside `in`', () => {
        // Sonnet 5.5, $2 in / $10 out: 1,000 uncached, 4,000 read, 500 written, 600 out.
        // 1000 * 2 + 4000 * 0.1 + 500 * 2.5 + 600 * 10 = 2000 + 400 + 1250 + 6000 = 9650, per million.
        assert.equal(usdFor({ in: 1000, out: 600, cacheRead: 4000, cacheWrite: 500 }, 'claude-sonnet-5-5', DEFAULT_PRICES).usd, 0.00965);
        // Without the cache the same 5,500 input tokens would have been 5500 * 2 + 600 * 10 = 17000.
        assert.equal(usdFor({ in: 5500, out: 600 }, 'claude-sonnet-5-5', DEFAULT_PRICES).usd, 0.017);
    });

    it('is cheaper to read than to send, dearer to write than to send, and pays back on the first read at 5-minute lifetime', () => {
        const send = usdFor({ in: 5000, out: 0 }, 'claude-opus-5-5', DEFAULT_PRICES).usd;
        const write = usdFor({ in: 0, out: 0, cacheWrite: 5000 }, 'claude-opus-5-5', DEFAULT_PRICES).usd;
        const read = usdFor({ in: 0, out: 0, cacheRead: 5000 }, 'claude-opus-5-5', DEFAULT_PRICES).usd;
        assert.ok(read < send && send < write);
        assert.ok(write + read < 2 * send, 'one write and one read cost less than sending it twice');
    });

    it('prices the cache off the price the operator saved: their input price moves the cached rates with it', () => {
        const prices: PriceTable = { 'claude-opus-5-5': { in: 8, out: 40 } };
        assert.equal(usdFor({ in: 0, out: 0, cacheRead: M }, 'claude-opus-5-5', prices).usd, 0.4);
        assert.equal(usdFor({ in: 0, out: 0, cacheWrite: M }, 'claude-opus-5-5', prices).usd, 10);
    });

    it('charges an unpriced model\'s cache tokens at the ceiling and flags it, so a cache cannot make an unknown model free', () => {
        // The ceiling input price in the defaults is $5 (Opus 5 and 4.8).
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheRead: M }, 'mystery/model-9', DEFAULT_PRICES), { usd: 0.5, priced: false });
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheWrite: M }, 'mystery/model-9', DEFAULT_PRICES), { usd: 6.25, priced: false });
    });

    it('treats cache tokens that are not positive numbers as none, as it does the others', () => {
        for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
            assert.deepEqual(usdFor({ in: 0, out: 0, cacheRead: bad as number, cacheWrite: bad as number }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 0, priced: true }, String(bad));
        }
    });

    it('prices a usage with no cache fields exactly as it always did', () => {
        assert.deepEqual(usdFor({ in: 2000, out: 800 }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 0.024, priced: true });
        assert.deepEqual(usdFor({ in: 2000, out: 800, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5-5', DEFAULT_PRICES), { usd: 0.024, priced: true });
    });
});

describe('cache tokens in totalUsage, billedFromUsage and costOf', () => {
    it('totalUsage adds the cache counts of every entry, and leaves the keys out when there were none', () => {
        const entries = [
            { model: 'claude-opus-5-5', in: 35, out: 0, cacheWrite: 500 },
            { model: 'claude-opus-4-8', in: 412, out: 264, cacheRead: 500 },
            { model: 'claude-opus-4-8', in: 1, out: 1, cacheRead: 250 },
        ];
        assert.deepEqual(totalUsage(entries), { in: 448, out: 265, cacheRead: 750, cacheWrite: 500 });
        assert.deepEqual(totalUsage([{ model: 'm', in: 5, out: 2, cacheRead: 0, cacheWrite: 0 }]), { in: 5, out: 2 });
        assert.deepEqual(Object.keys(totalUsage([{ model: 'm', in: 5, out: 2, cacheRead: 9 }])), ['in', 'out', 'cacheRead']);
    });

    it('billedFromUsage makes the entry for one model, keeping the cache counts only when there are some', () => {
        assert.deepEqual(billedFromUsage('claude-opus-5-5', { in: 10, out: 5 }), { model: 'claude-opus-5-5', in: 10, out: 5 });
        assert.deepEqual(billedFromUsage('claude-opus-5-5', { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 }), { model: 'claude-opus-5-5', in: 10, out: 5 });
        assert.deepEqual(billedFromUsage('claude-opus-5-5', { in: 10, out: 5, cacheRead: 7, cacheWrite: 3 }), { model: 'claude-opus-5-5', in: 10, out: 5, cacheRead: 7, cacheWrite: 3 });
    });

    it('costOf prices each model\'s cache tokens at its own multiple, and keeps them on the entries it returns', () => {
        const cost = costOf([
            { model: 'claude-opus-5-5', in: 0, out: 0, cacheRead: 1_000_000 },
            { model: 'claude-opus-4-8', in: 0, out: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
        ], DEFAULT_PRICES);
        assert.deepEqual(cost.billed.map((b) => b.usd), [0.2, 6.75]);
        assert.equal(cost.usd, 6.95);
        assert.deepEqual(cost.billed.map((b) => [b.cacheRead, b.cacheWrite]), [[1_000_000, undefined], [1_000_000, 1_000_000]]);
    });

    it('a provider\'s own figure still beats the table: cache tokens on an entry the provider priced add nothing', () => {
        const cost = costOf([{ model: 'x/y', in: 5, out: 5, cacheRead: 1_000_000, usd: 0.0123, source: 'provider' }], DEFAULT_PRICES);
        assert.equal(cost.usd, 0.0123);
        assert.equal(cost.billed[0]!.source, 'provider');
    });

    it('costs the same when the result is priced again, cache tokens included', () => {
        const first = costOf([{ model: 'claude-sonnet-5-5', in: 1000, out: 600, cacheRead: 4000, cacheWrite: 500 }], DEFAULT_PRICES);
        assert.equal(first.usd, 0.00965);
        assert.deepEqual(costOf(first.billed, DEFAULT_PRICES), first);
    });

    it('does not modify the entries it was given', () => {
        const entries = [{ model: 'claude-opus-5-5', in: 10, out: 10, cacheRead: 10, cacheWrite: 10 }];
        costOf(entries, DEFAULT_PRICES);
        assert.deepEqual(entries, [{ model: 'claude-opus-5-5', in: 10, out: 10, cacheRead: 10, cacheWrite: 10 }]);
    });
});

// ─── Meta's Muse models (dev.meta.ai/docs/pricing-rate-limits, Standard mode, checked 2026-10-30) ────────────────────────────────
//
// Muse Spark 1.3, 1.2 and 1.1: $1.25 in, $4.25 out, cached input $0.15. Muse Wonder: $4 in, $20 out, cached input $0.20. Reasoning tokens are counted
// inside `completion_tokens` and billed as output, so a call is priced from its two token counts and nothing else.

describe('Muse prices', () => {
    const M = 1_000_000;

    it('prices Muse Spark at $1.25 in and $4.25 out per million, whichever of its three versions answered, and Wonder at $4 and $20', () => {
        for (const model of ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1']) {
            assert.deepEqual(priceFor(model, {}), { in: 1.25, out: 4.25, priced: true }, model);
            assert.deepEqual(usdFor({ in: M, out: M }, model, DEFAULT_PRICES), { usd: 5.5, priced: true }, model);
        }
        assert.deepEqual(priceFor('muse-wonder-1.0', {}), { in: 4, out: 20, priced: true });
        assert.deepEqual(usdFor({ in: M, out: M }, 'muse-wonder-1.0', DEFAULT_PRICES), { usd: 24, priced: true });
    });

    it('prices the live usage of 2026-10-28 as it was billed: a one-word answer, 15 tokens in and 190 out, thinking included', () => {
        // {"completion_tokens":190,"prompt_tokens":15,...,"completion_tokens_details":{"reasoning_tokens":180}}: all 190 are output.
        // 15 * 1.25 + 190 * 4.25 = 18.75 + 807.5 = 826.25, per million.
        assert.equal(usdFor({ in: 15, out: 190 }, 'muse-spark-1.3', DEFAULT_PRICES).usd, 0.00082625);
    });

    it('reads cached input at $0.15 a million on Muse Spark (0.12x of $1.25) and $0.20 on Muse Wonder (0.05x of $4)', () => {
        assert.equal(cacheReadMultiplier('muse-spark-1.3'), 0.12);
        assert.equal(cacheReadMultiplier('muse-spark-1.2'), 0.12);
        assert.equal(cacheReadMultiplier('muse-spark-1.1'), 0.12);
        assert.equal(cacheReadMultiplier('muse-wonder-1.0'), 0.05);
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheRead: M }, 'muse-spark-1.3', DEFAULT_PRICES), { usd: 0.15, priced: true });
        assert.deepEqual(usdFor({ in: 0, out: 0, cacheRead: M }, 'muse-wonder-1.0', DEFAULT_PRICES), { usd: 0.2, priced: true });
    });

    it('prices a call whose prefix was cached: 8,000 of 10,000 prompt tokens read from the cache, 600 out', () => {
        // 2,000 * 1.25 + 8,000 * 0.15 + 600 * 4.25 = 2,500 + 1,200 + 2,550 = 6,250, per million.
        assert.equal(usdFor({ in: 2000, out: 600, cacheRead: 8000 }, 'muse-spark-1.3', DEFAULT_PRICES).usd, 0.00625);
        // The same call with no cache at all is dearer: 10,000 * 1.25 + 2,550 = 15,050.
        assert.equal(usdFor({ in: 10_000, out: 600 }, 'muse-spark-1.3', DEFAULT_PRICES).usd, 0.01505);
    });

    it('gives a dated snapshot its alias\'s price and cache rate, as it does for every model', () => {
        assert.deepEqual(priceFor('muse-spark-1.3-20261101', {}), { in: 1.25, out: 4.25, priced: true });
        assert.equal(cacheReadMultiplier('muse-spark-1.3-20261101'), 0.12);
    });

    it('does not price a Contributor-mode twin as its Standard model: it is charged at the ceiling and flagged, and nothing may route to it', () => {
        for (const model of ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor']) {
            assert.equal(priceFor(model, {}).priced, false, model);
            assert.equal(cacheReadMultiplier(model), DEFAULT_CACHE_READ_MULTIPLIER, model);
        }
    });

    it('leaves the ceiling an unknown model is charged at where it was: no Muse rate is the highest in the table', () => {
        assert.deepEqual(priceFor('some-new-model', DEFAULT_PRICES), { in: 5, out: 25, priced: false });
    });
});
