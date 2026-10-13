/**
 * What a call cost, from the tokens it used and a price table.
 *
 * The table is a setting, not a constant (P20c, `ai.prices`): prices change, and OpenRouter and
 * Custom models would otherwise have none. `DEFAULT_PRICES` is what those settings start from and
 * what every lookup falls back to: the operator's table is laid over it, never used instead of
 * it, so an empty or half-filled `ai.prices` cannot make a call free.
 *
 * A model neither table knows is charged at the highest rate in the merged table and marked
 * `priced: false`. Over-charging an unknown model is the safe side of a daily budget: the
 * alternative, charging nothing, lets an unpriced expensive model spend without limit, and the
 * flag is what the card shows so the operator adds the price.
 */
import type { Billed, Usage } from './types.js';

/** US dollars per million tokens. */
export type Price = { in: number; out: number };
export type PriceTable = Readonly<Record<string, Price>>;

/**
 * Checked against the providers' own pricing pages on 2026-10-13:
 *   - platform.claude.com/docs/en/about-claude/pricing: Opus 5.5 $4/$20; Opus 5 and Opus 4.8
 *     $5/$25; Sonnet 5.5 and Sonnet 5 $2/$10 (Sonnet 5's was introductory pricing that became
 *     permanent); Haiku 5.5 $0.10/$0.50 for prompts up to 100k tokens, $0.50/$2.50 above that,
 *     seeded at the lower tier since these prompts are small.
 *   - ai.google.dev/gemini-api/docs/pricing (paid tier, output includes thinking tokens):
 *     Gemini 3.8 Flash $0.75/$3.75 until 2026-12-31 and $1.50/$7.50 from 2027-01-01, seeded at
 *     the later rate so a budget cannot under-count after the change; Gemini 3.1 Pro Preview
 *     $2/$12 for prompts up to 200k tokens ($4/$18 above).
 * Not seeded: Fable ($10/$50), whose calls are therefore charged at this table's ceiling and
 * flagged, which under-counts them; and every OpenAI, OpenRouter and Custom model.
 */
export const DEFAULT_PRICES: PriceTable = {
    'claude-opus-5-5': { in: 4, out: 20 },
    'claude-opus-5': { in: 5, out: 25 },
    'claude-opus-4-8': { in: 5, out: 25 },
    'claude-sonnet-5-5': { in: 2, out: 10 },
    'claude-sonnet-5': { in: 2, out: 10 },
    'claude-haiku-5-5': { in: 0.1, out: 0.5 },
    'gemini-3.8-flash': { in: 1.5, out: 7.5 },
    'gemini-3.1-pro-preview': { in: 2, out: 12 },
};

const valid = (p: unknown): p is Price =>
    !!p && typeof p === 'object' && Number.isFinite((p as Price).in) && (p as Price).in >= 0 && Number.isFinite((p as Price).out) && (p as Price).out >= 0;

/** The defaults with the operator's valid entries laid over them. A malformed entry is skipped, not allowed to blank out a default. */
function merged(prices: PriceTable): Record<string, Price> {
    const out: Record<string, Price> = { ...DEFAULT_PRICES };
    for (const [key, price] of Object.entries(prices ?? {})) if (valid(price)) out[key] = price;
    return out;
}

/** A dated snapshot (`claude-opus-5-5-20261001`) costs what its alias does. */
const SNAPSHOT_SUFFIX = /^-(?:\d{6,8}|latest)$/;

function lookup(model: string, table: Record<string, Price>): Price | undefined {
    const id = model.trim().toLowerCase();
    let best: { length: number; price: Price } | undefined;
    for (const [key, price] of Object.entries(table)) {
        const k = key.trim().toLowerCase();
        const matches = id === k || (id.startsWith(k) && SNAPSHOT_SUFFIX.test(id.slice(k.length)));
        // The longest key wins, so `claude-opus-5-5` is never mistaken for a shorter alias; on a
        // tie the later entry, which is the operator's, wins.
        if (matches && (!best || k.length >= best.length)) best = { length: k.length, price };
    }
    return best?.price;
}

/** The price of a model, or the highest of each rate in the table (`priced: false`) when it has none. */
export function priceFor(model: string, prices: PriceTable): Price & { priced: boolean } {
    const table = merged(prices);
    const known = lookup(model, table);
    if (known) return { in: known.in, out: known.out, priced: true };
    const all = Object.values(table);
    return { in: Math.max(...all.map((p) => p.in)), out: Math.max(...all.map((p) => p.out)), priced: false };
}

const tokens = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
const round = (usd: number): number => Math.round(usd * 1e9) / 1e9;

/**
 * Dollars, to the billionth: only floating-point noise is rounded away (`0.024000000000000004`).
 * That is fine enough that Haiku's $0.10 per million (a ten-millionth of a dollar a token) is
 * kept exactly, which matters when `ai_usage` adds up thousands of tiny calls.
 */
export function usdFor(usage: Usage, model: string, prices: PriceTable): { usd: number; priced: boolean } {
    const price = priceFor(model, prices);
    return { usd: round((tokens(usage.in) * price.in + tokens(usage.out) * price.out) / 1_000_000), priced: price.priced };
}

/** The tokens of every entry, added up. */
export function totalUsage(billed: readonly Billed[]): Usage {
    return billed.reduce<Usage>((sum, b) => ({ in: sum.in + tokens(b.in), out: sum.out + tokens(b.out) }), { in: 0, out: 0 });
}

/**
 * What a whole call cost: each model it was billed on at its own price, the entries returned with
 * their `usd`, and `priced: false` if any of them had to be charged at the ceiling.
 */
export function costOf(billed: readonly Billed[], prices: PriceTable): { usd: number; priced: boolean; billed: Billed[] } {
    const entries = billed.map((b) => ({ b, cost: usdFor(b, b.model, prices) }));
    return {
        usd: round(entries.reduce((sum, e) => sum + e.cost.usd, 0)),
        priced: entries.every((e) => e.cost.priced),
        billed: entries.map((e) => ({ ...e.b, usd: e.cost.usd })),
    };
}
