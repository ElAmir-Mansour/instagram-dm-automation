/**
 * What a call cost, from the tokens it used and a price table.
 *
 * The table is a setting, not a constant (P20c, `ai.prices`): prices change, and OpenRouter, Groq
 * and Custom models would otherwise have none. `DEFAULT_PRICES` is what those settings start from
 * and what every lookup falls back to: the operator's table is laid over it, never used instead of
 * it, so an empty or half-filled `ai.prices` cannot make a call free.
 *
 * A provider that reports what it charged overrides the table: OpenRouter's `usage.cost` arrives
 * as `Billed.usd` with `source: 'provider'` (adapters/chatCompletions.ts), and `costOf` takes it as
 * it is, `priced: true`. Everything `costOf` computes itself comes back `source: 'table'`, which it
 * will not trust if it is handed the result again.
 *
 * **Cached input** (Anthropic's prompt cache, S2 of the DM plan) is priced from the model's own input
 * price, not from a second table: a read costs a fraction of it (`cacheReadMultiplier`) and a write
 * into the 5-minute cache costs `CACHE_WRITE_MULTIPLIER` times it. So an operator's `ai.prices`
 * entry for a model moves its cached rates with it, and a model with no price is charged its cache
 * tokens at the ceiling's multiples.
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
 *   - console.groq.com/docs/model/openai/gpt-oss-120b and -20b, checked on 2026-10-15: $0.15/$0.60
 *     and $0.075/$0.30, Groq's paid rates. On Groq's free tier the same call costs nothing, so these
 *     over-count it, which is the safe side for a budget; they are only Groq's (OpenRouter reports
 *     its own cost, which overrides the table).
 *   - dev.meta.ai/docs/pricing-rate-limits (pay-as-you-go, Standard mode), checked 2026-10-30: Muse
 *     Spark 1.3, 1.2 and 1.1 $1.25/$4.25 with cached input at $0.15; Muse Wonder $4/$20 with cached
 *     input at $0.20. Reasoning tokens are counted inside `completion_tokens` and billed as output,
 *     so the table needs nothing more. Contributor mode (`-contributor`, $0.10/$0.20) is left out on
 *     purpose: no route may use it (purposes.ts), so a call on one is charged at the ceiling and
 *     flagged, which is the loud side.
 *   - baseten.co/pricing (the Model APIs table) and baseten.co/library/muse-spark-open, read 2026-10-30: Muse Spark Open $1.25 input and $4.25 output per million
 *     tokens, cached input $0.15, the same as Meta's own Muse Spark. The page names the model `meta-models/muse-spark-open`; the id the owner's key works with
 *     is `meta-models/muse-spark-open-1026`, which a dated-snapshot match does not reach (the suffix is four digits, not six to eight), so both are listed. The
 *     adapter reports no cached input for Baseten (it takes `prompt_tokens` whole), which can only over-count a call, the safe side of a budget. Reasoning tokens
 *     are counted in `completion_tokens` and billed as output. Baseten bills for image and video input as input tokens too; the page says nothing different.
 * Not seeded: Fable ($10/$50), whose calls are therefore charged at this table's ceiling and
 * flagged, which under-counts them; and every OpenAI, OpenRouter and Custom model, and the other
 * Groq models.
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
    'openai/gpt-oss-120b': { in: 0.15, out: 0.6 },
    'openai/gpt-oss-20b': { in: 0.075, out: 0.3 },
    'muse-spark-1.3': { in: 1.25, out: 4.25 },
    'muse-spark-1.2': { in: 1.25, out: 4.25 },
    'muse-spark-1.1': { in: 1.25, out: 4.25 },
    'muse-wonder-1.0': { in: 4, out: 20 },
    'meta-models/muse-spark-open-1026': { in: 1.25, out: 4.25 },
    'meta-models/muse-spark-open': { in: 1.25, out: 4.25 },
};

/**
 * What a write into the 5-minute prompt cache costs, as a multiple of the model's input price. The
 * 1-hour lifetime is 2x; this library never asks for it, so there is one multiplier.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** What a cache read costs, as a multiple of the input price, for a model the table below does not list. */
export const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;

/**
 * The models whose cache reads are not a tenth of the input price (the Claude ones below are cheaper, Muse Spark is dearer). Checked against
 * platform.claude.com/docs/en/about-claude/pricing on 2026-10-14: "Cache hits and refreshes on Claude
 * Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input price" ($0.20 and $0.10 per
 * million), and Fable 5.1 and Mythos 5.1 at 0.025x. Every other Claude model, Haiku 5.5 included,
 * is a tenth. (The `claude-api` skill's cached copy says $0.20 for Sonnet 5.5, which is the tenth;
 * the pricing page is the newer of the two and says 0.05x.)
 *
 * Meta's, from dev.meta.ai/docs/pricing-rate-limits on 2026-10-30: Muse Spark reads cached input at $0.15 of $1.25 (0.12x) and Muse Wonder
 * at $0.20 of $4 (0.05x). Its pricing page lists no cache-write rate (a prefix is cached automatically, and the request that first sends it
 * pays full input), so the Meta adapter reports reads only.
 */
const CACHE_READ_MULTIPLIERS: Readonly<Record<string, number>> = {
    'claude-opus-5-5': 0.05,
    'claude-sonnet-5-5': 0.05,
    'claude-fable-5-1': 0.025,
    'claude-mythos-5-1': 0.025,
    'muse-spark-1.3': 0.12,
    'muse-spark-1.2': 0.12,
    'muse-spark-1.1': 0.12,
    'muse-wonder-1.0': 0.05,
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

function lookup<T>(model: string, table: Readonly<Record<string, T>>): T | undefined {
    const id = model.trim().toLowerCase();
    let best: { length: number; value: T } | undefined;
    for (const [key, value] of Object.entries(table)) {
        const k = key.trim().toLowerCase();
        const matches = id === k || (id.startsWith(k) && SNAPSHOT_SUFFIX.test(id.slice(k.length)));
        // The longest key wins, so `claude-opus-5-5` is never mistaken for a shorter alias; on a
        // tie the later entry, which is the operator's, wins.
        if (matches && (!best || k.length >= best.length)) best = { length: k.length, value };
    }
    return best?.value;
}

/** What a read from the prompt cache costs on this model, as a multiple of its input price. A dated snapshot costs what its alias does. */
export function cacheReadMultiplier(model: string): number {
    return lookup(model, CACHE_READ_MULTIPLIERS) ?? DEFAULT_CACHE_READ_MULTIPLIER;
}

/** The price of a model, or the highest of each rate in the table (`priced: false`) when it has none. */
export function priceFor(model: string, prices: PriceTable): Price & { priced: boolean } {
    const table = merged(prices);
    const known = lookup(model, table);
    if (known) return { in: known.in, out: known.out, priced: true };
    const all = Object.values(table);
    return { in: Math.max(...all.map((p) => p.in)), out: Math.max(...all.map((p) => p.out)), priced: false };
}

const tokens = (n: number | undefined): number => (n !== undefined && Number.isFinite(n) && n > 0 ? n : 0);
const round = (usd: number): number => Math.round(usd * 1e9) / 1e9;

/**
 * Dollars, to the billionth: only floating-point noise is rounded away (`0.024000000000000004`).
 * That is fine enough that Haiku's $0.10 per million (a ten-millionth of a dollar a token) is
 * kept exactly, which matters when `ai_usage` adds up thousands of tiny calls.
 *
 * `usage.in` is the input at the full price; `cacheRead` and `cacheWrite` are the cached input at
 * the model's read multiple and 1.25x (see the file comment), neither of them inside `in`.
 */
export function usdFor(usage: Usage, model: string, prices: PriceTable): { usd: number; priced: boolean } {
    const price = priceFor(model, prices);
    const input =
        tokens(usage.in) * price.in +
        tokens(usage.cacheRead) * price.in * cacheReadMultiplier(model) +
        tokens(usage.cacheWrite) * price.in * CACHE_WRITE_MULTIPLIER;
    return { usd: round((input + tokens(usage.out) * price.out) / 1_000_000), priced: price.priced };
}

/** A `Billed` entry for one model's `Usage`, the cache fields kept only when there were some. */
export function billedFromUsage(model: string, usage: Usage): Billed {
    const cacheRead = tokens(usage.cacheRead);
    const cacheWrite = tokens(usage.cacheWrite);
    return { model, in: usage.in, out: usage.out, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}) };
}

/** The tokens of every entry, added up. The cache fields are there only when some entry had cached input. */
export function totalUsage(billed: readonly Billed[]): Usage {
    const sum = billed.reduce(
        (acc, b) => ({ in: acc.in + tokens(b.in), out: acc.out + tokens(b.out), cacheRead: acc.cacheRead + tokens(b.cacheRead), cacheWrite: acc.cacheWrite + tokens(b.cacheWrite) }),
        { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
    );
    return { in: sum.in, out: sum.out, ...(sum.cacheRead ? { cacheRead: sum.cacheRead } : {}), ...(sum.cacheWrite ? { cacheWrite: sum.cacheWrite } : {}) };
}

/**
 * What a whole call cost: each model it was billed on at its own price, the entries returned with
 * their `usd` and where it came from (`source`), and `priced: false` if any of them had to be
 * charged at the ceiling. An entry the provider priced (`source: 'provider'` and a valid `usd`:
 * finite, not negative) keeps its figure, so the provider's number wins over the table's guess. A
 * figure that is not valid is ignored, not trusted as a free call, and a `usd` that is not marked
 * as the provider's is recomputed, so `costOf(costOf(x).billed)` is `costOf(x)`: an unpriced
 * ceiling estimate stays unpriced.
 */
export function costOf(billed: readonly Billed[], prices: PriceTable): { usd: number; priced: boolean; billed: Billed[] } {
    const entries = billed.map((b) => ({
        b,
        cost:
            b.source === 'provider' && typeof b.usd === 'number' && Number.isFinite(b.usd) && b.usd >= 0
                ? { usd: round(b.usd), priced: true, source: 'provider' as const }
                : { ...usdFor(b, b.model, prices), source: 'table' as const },
    }));
    return {
        usd: round(entries.reduce((sum, e) => sum + e.cost.usd, 0)),
        priced: entries.every((e) => e.cost.priced),
        billed: entries.map((e) => ({ ...e.b, usd: e.cost.usd, source: e.cost.source })),
    };
}
