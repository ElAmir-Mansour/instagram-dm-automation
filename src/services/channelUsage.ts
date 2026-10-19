/**
 * The WhatsApp usage ledger (`channel_usage`, migration v50; docs/specs/001-whatsapp-agent data-model.md): what each number delivered this
 * month, what Meta marked billable, and what that costs at today's rates. It exists because of one Meta rule: past 1,000 delivered service
 * messages a month, a number with no payment method has its messages silently not delivered (research R3), so the count has to exist from the
 * first message, not from the day the owner starts asking.
 *
 *   recordDelivery   one row per bucket, bumped once per `wamid` (the caller guarantees "once": whatsappStatus.ts does it in the same
 *                    transaction as the delivery_status transition, so a duplicate or out-of-order status cannot count twice)
 *   freeUsed         delivered `service` messages in a period: the "free replies used" meter
 *   periodUsage      the whole period in one read: the Settings card's numbers
 *   estimateCost     what ONE delivered message costs, from the rate table
 *   wouldBeBillable  whether the next message of a category would cost money
 *
 * **The rate table is a copy of Meta's published rates, effective 2026-10-01, and Meta changes them on Jan/Apr/Jul/Oct 1.** `RATES_EFFECTIVE`
 * says which table this is. A cost here is an ESTIMATE for the owner's budget: Meta's invoice is the truth, and `pricing.billable` on each
 * status is what decides whether a message costs anything at all (a service message inside the free tier is `billable: false`).
 */
import { pool } from '../config/db.js';
import { queryOne } from '../db/query.js';
import type { Exec } from './studio/common.js';
import { FREE_REPLIES_PER_MONTH } from './whatsappConnections.js';

/** The date the rates below took effect (research R3). The next change is the first of a quarter. */
export const RATES_EFFECTIVE = '2026-10-01';

/** The recipient's calling-code market. `other` is everyone who is neither Egyptian nor Saudi. */
export type Market = 'EG' | 'SA' | 'other';

/** The pricing categories this table prices. Meta's `pricing.category` can say more; see `estimateCost`. */
export type RatedCategory = 'service' | 'utility' | 'authentication' | 'marketing';

/**
 * USD per delivered message, by category and market.
 *
 * `other` is an ASSUMPTION, not a published rate: Meta lists Egypt, Saudi Arabia and a "rest of Middle East" band, and `other` here prices every
 * other recipient as that band ($0.0091 for service, utility and authentication; $0.0392 for marketing). A recipient outside the Middle East
 * is billed at a different band, so for them this is only the right order of magnitude.
 *
 * Service, utility and authentication share one rate (utility = service since 2026-10-01, research R3).
 */
export const RATES_USD: Readonly<Record<RatedCategory, Readonly<Record<Market, number>>>> = Object.freeze({
    service: Object.freeze({ EG: 0.0036, SA: 0.0107, other: 0.0091 }),
    utility: Object.freeze({ EG: 0.0036, SA: 0.0107, other: 0.0091 }),
    authentication: Object.freeze({ EG: 0.0036, SA: 0.0107, other: 0.0091 }),
    marketing: Object.freeze({ EG: 0.0644, SA: 0.0576, other: 0.0392 }),
});

const isRated = (category: string): category is RatedCategory => Object.hasOwn(RATES_USD, category);

/**
 * The market of a recipient, from what the webhook gives: a BSUID (`EG.1234…`, `SA.…`: the country prefix) or a phone number in digits
 * (`20…` Egypt, `966…` Saudi Arabia; a leading plus or `00` is tolerated). Anything else, or nothing, is `other`.
 */
export function marketOf(recipient: string | null | undefined): Market {
    if (typeof recipient !== 'string') return 'other';
    const value = recipient.trim();
    const bsuid = /^([A-Za-z]{2})\./.exec(value);
    if (bsuid) {
        const country = bsuid[1]!.toUpperCase();
        return country === 'EG' ? 'EG' : country === 'SA' ? 'SA' : 'other';
    }
    const digits = value.replace(/^\+/, '').replace(/^00/, '');
    if (!/^\d{8,15}$/.test(digits)) return 'other';
    if (digits.startsWith('966')) return 'SA';
    if (digits.startsWith('20')) return 'EG';
    return 'other';
}

/**
 * The ledger's period for an instant: `YYYY-MM`, in UTC.
 *
 * TODO(M12): the column is documented as "in the Messaging account's timezone" (`platform_connections.profile.timezone`), because Meta's monthly
 * free tier resets on that calendar, but nothing reads the account's timezone yet (the Graph field is not in the health read). Until it does, a
 * message delivered in the last hours of a month can be counted in the next one for an account east of UTC, or the previous one for one west of it.
 */
export function periodOf(at: Date = new Date()): string {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * What ONE delivered message costs, in USD: the rate of its category and market when Meta marked it billable, else zero.
 *
 * A category the table does not price (Meta adds some: `marketing_lite`, `authentication_international`, `referral_conversion`) is priced at the
 * MARKETING rate when it is billable: the highest in the table, so an unknown charge is over-estimated rather than hidden. Unknown and not
 * billable is free, as Meta says.
 */
export function estimateCost(input: { category: string | null | undefined; market: Market; billable: boolean | null | undefined }): number {
    if (input.billable !== true) return 0;
    const category = (input.category ?? '').toLowerCase();
    return RATES_USD[isRated(category) ? category : 'marketing'][input.market];
}

/**
 * Whether the next message of this category would cost money. Service is free while fewer than 1,000 have been delivered this month
 * (`freeUsed`); utility, authentication and marketing are never inside the free tier, and a category nobody has priced is assumed to cost.
 */
export function wouldBeBillable(input: { category: string | null | undefined; freeUsed: number }): boolean {
    if ((input.category ?? '').toLowerCase() === 'service') return input.freeUsed >= FREE_REPLIES_PER_MONTH;
    return true;
}

export interface DeliveryInput {
    creatorId: string;
    phoneNumberId: string;
    /** `pricing.category`: null when no status carried one yet (stored as `unknown`). */
    category: string | null;
    /** `pricing.type`: null is stored as `unknown`. */
    pricingType: string | null;
    /** `pricing.billable`. Anything but a literal true counts as not billable. */
    billable: boolean | null;
    /** The recipient: a BSUID or a phone number; decides the market. */
    recipient: string | null;
    /** When it was delivered; the period comes from it. Default: now. */
    at?: Date;
}

/**
 * Count one first delivery. An upsert on the bucket's primary key, so concurrent deliveries add up rather than overwrite.
 *
 * The caller must call this ONCE per `wamid`. Nothing here can tell a repeat from a first: the ledger is a counter, and the guard is the
 * `delivery_status` transition that whatsappStatus.ts makes in the same transaction (pass its client as `exec`, so the two commit together
 * or not at all).
 */
export async function recordDelivery(input: DeliveryInput, exec: Exec = pool): Promise<void> {
    const market = marketOf(input.recipient);
    const category = input.category?.trim() || 'unknown';
    const cost = estimateCost({ category, market, billable: input.billable });
    await exec.query(
        `INSERT INTO channel_usage (creator_id, platform, external_account_id, period, category, pricing_type, market, delivered, billable, est_cost_usd)
         VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, 1, $7, $8)
         ON CONFLICT (creator_id, platform, external_account_id, period, category, pricing_type, market)
         DO UPDATE SET delivered = channel_usage.delivered + 1,
                       billable = channel_usage.billable + EXCLUDED.billable,
                       est_cost_usd = channel_usage.est_cost_usd + EXCLUDED.est_cost_usd`,
        [input.creatorId, input.phoneNumberId, periodOf(input.at), category, input.pricingType?.trim() || 'unknown', market, input.billable === true ? 1 : 0, cost]
    );
}

/** Delivered `service` messages this number counted in the period: the "free replies used" figure (it can pass 1,000: the rest are billable). */
export async function freeUsed(creatorId: string, phoneNumberId: string, period: string): Promise<number> {
    const row = await queryOne<{ n: string | number | null }>(
        `SELECT COALESCE(SUM(delivered), 0) AS n FROM channel_usage
          WHERE creator_id = $1 AND platform = 'whatsapp' AND external_account_id = $2 AND period = $3 AND category = 'service'`,
        [creatorId, phoneNumberId, period]
    );
    return Number(row?.n ?? 0);
}

export interface PeriodUsage {
    period: string;
    /** Delivered `service` messages. */
    serviceDelivered: number;
    /** Delivered messages Meta marked billable, any category. */
    billable: number;
    /** The estimate so far, USD. */
    estCostUsd: number;
}

/** The Settings card's numbers for one number and period, in one read. A period with no rows is all zeros. */
export async function periodUsage(creatorId: string, phoneNumberId: string, period: string): Promise<PeriodUsage> {
    const row = await queryOne<{ service: string | number | null; billable: string | number | null; cost: string | number | null }>(
        `SELECT COALESCE(SUM(delivered) FILTER (WHERE category = 'service'), 0) AS service,
                COALESCE(SUM(billable), 0) AS billable,
                COALESCE(SUM(est_cost_usd), 0) AS cost
           FROM channel_usage
          WHERE creator_id = $1 AND platform = 'whatsapp' AND external_account_id = $2 AND period = $3`,
        [creatorId, phoneNumberId, period]
    );
    return { period, serviceDelivered: Number(row?.service ?? 0), billable: Number(row?.billable ?? 0), estCostUsd: Number(row?.cost ?? 0) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the month would cost if the rest of it looks like the part that has passed: a straight line from the estimate so far. Never less than a
 * day's worth of elapsed time in the divisor, so the first hours of a month do not project a fortune from one message. Four decimals, like the
 * column. Zero stays zero.
 */
export function projectMonthEnd(estCostUsd: number, now: Date = new Date()): number {
    if (!(estCostUsd > 0)) return 0;
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const elapsed = Math.max(now.getTime() - start, DAY_MS);
    const total = end - start;
    return Math.round(((estCostUsd * total) / Math.min(elapsed, total)) * 10_000) / 10_000;
}
