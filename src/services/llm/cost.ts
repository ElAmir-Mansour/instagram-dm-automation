/**
 * What a call cost, from the tokens it used and a price table.
 *
 * The table is a setting, not a constant (P20c, `ai.prices`): prices change, and OpenRouter and
 * Custom models would otherwise have none. `DEFAULT_PRICES` is the seed those settings start from.
 *
 * A model the table does not know is charged at the table's highest rate and marked
 * `priced: false`. Over-charging an unknown model is the safe side of a daily budget: the
 * alternative, charging nothing, lets an unpriced expensive model spend without limit, and the
 * flag is what the card shows so the operator adds the price.
 */
import type { Usage } from './types.js';

/** US dollars per million tokens. */
export type Price = { in: number; out: number };
export type PriceTable = Readonly<Record<string, Price>>;

export const DEFAULT_PRICES: PriceTable = {
    'claude-opus-5-5': { in: 4, out: 20 },
    'claude-sonnet-5-5': { in: 2, out: 10 },
    'claude-haiku-5-5': { in: 0.1, out: 0.5 },
};

const valid = (p: unknown): p is Price =>
    !!p && typeof p === 'object' && Number.isFinite((p as Price).in) && (p as Price).in >= 0 && Number.isFinite((p as Price).out) && (p as Price).out >= 0;

/** A dated snapshot (`claude-opus-5-5-20261001`) costs what its alias does. */
const SNAPSHOT_SUFFIX = /^-(?:\d{6,8}|latest)$/;

function lookup(model: string, prices: PriceTable): Price | undefined {
    const id = model.trim().toLowerCase();
    let best: { key: string; price: Price } | undefined;
    for (const [key, price] of Object.entries(prices)) {
        if (!valid(price)) continue;
        const k = key.trim().toLowerCase();
        const matches = id === k || (id.startsWith(k) && SNAPSHOT_SUFFIX.test(id.slice(k.length)));
        // The longest key wins, so `claude-opus-5-5` is never mistaken for a shorter alias.
        if (matches && (!best || k.length > best.key.length)) best = { key: k, price };
    }
    return best?.price;
}

/** The price of a model, or the highest of each rate in the table (`priced: false`) when it has none. */
export function priceFor(model: string, prices: PriceTable): Price & { priced: boolean } {
    const known = lookup(model, prices);
    if (known) return { in: known.in, out: known.out, priced: true };
    const all = Object.values(prices).filter(valid);
    return { in: Math.max(0, ...all.map((p) => p.in)), out: Math.max(0, ...all.map((p) => p.out)), priced: false };
}

const tokens = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Dollars, to the billionth: only floating-point noise is rounded away (`0.024000000000000004`).
 * That is fine enough that Haiku's $0.10 per million (a ten-millionth of a dollar a token) is
 * kept exactly, which matters when `ai_usage` adds up thousands of tiny calls.
 */
export function usdFor(usage: Usage, model: string, prices: PriceTable): { usd: number; priced: boolean } {
    const price = priceFor(model, prices);
    const usd = (tokens(usage.input_tokens) * price.in + tokens(usage.output_tokens) * price.out) / 1_000_000;
    return { usd: Math.round(usd * 1e9) / 1e9, priced: price.priced };
}
