/**
 * Meta's own account spending limit (`spend_cap`), set from Settings as a second safety net under the app's monthly cap (research R7).
 * In A1 a direct call, recorded as an `ads_ops` row so its limit can be counted: Meta allows 10 changes a day (17/1885172 past that).
 *
 * Units are the one thing not settled by Meta's documentation: the write is documented in the currency's major unit, the read comes back
 * in minor units (cents). So every write is read back, and the answer says whether what Meta now holds is what was asked (`verified`),
 * and in which unit it came back (logged as `ads.spend_cap_units`), until the live check settles it.
 */
import { queryOne } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { fromMinorUnits, num, roundMoney } from '../metaAds.js';
import { adsGet, adsPost, AdsGraphError, type GraphParams } from './graph.js';
import { finishSpendOp, mayHaveLanded } from './money.js';
import { localDay } from './notify.js';

export const SPEND_CAP_CHANGES_PER_DAY = 10;

/** Midnight of the account's day after `now`, as a UTC time. */
export function nextLocalMidnight(now: Date, offsetHours: number): Date {
    const day = localDay(now, offsetHours);
    return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000 - offsetHours * 3_600_000);
}

/** How many of today's 10 changes are left (the account's day). Done and maybe-landed changes count; refused ones do not. */
export async function spendCapChangesLeft(creatorId: string, adAccountId: string, offsetHours: number, now = new Date()): Promise<number> {
    const since = new Date(nextLocalMidnight(now, offsetHours).getTime() - 86_400_000);
    try {
        const row = await queryOne<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM ads_ops
              WHERE creator_id = $1 AND ad_account_id = $2 AND kind = 'spend_cap' AND state IN ('running', 'done', 'verify') AND created_at >= $3`,
            [creatorId, adAccountId, since]
        );
        return Math.max(0, SPEND_CAP_CHANGES_PER_DAY - Number(row?.n ?? 0));
    } catch (err) {
        log('warn', 'ads.spend_cap_count_failed', describeError(err));
        return SPEND_CAP_CHANGES_PER_DAY;
    }
}

export interface SpendCapResult {
    op: { id: string; state: 'done' | 'failed'; kind: 'spend_cap' };
    /** What Meta holds now, major units; null for no limit. */
    amount: number | null;
    verified: boolean;
    units: 'minor' | 'major' | null;
}

export class SpendCapRefused extends Error {
    constructor(readonly code: 'EDIT_LIMIT', message: string, readonly retryAt: Date) {
        super(message);
        this.name = 'SpendCapRefused';
    }
}

/** Set (`amount`) or remove (`null`) the account's spending limit, then read it back. */
export async function setSpendCap(input: {
    creatorId: string; adAccountId: string; currency: string; offsetHours: number; amount: number | null; token: string; userId: string | null; now?: Date;
}): Promise<SpendCapResult> {
    const now = input.now ?? new Date();
    if ((await spendCapChangesLeft(input.creatorId, input.adAccountId, input.offsetHours, now)) <= 0) {
        throw new SpendCapRefused('EDIT_LIMIT', 'Meta allows 10 changes to the spending limit a day; try again tomorrow.', nextLocalMidnight(now, input.offsetHours));
    }
    const op = await queryOne<{ id: string }>(
        `INSERT INTO ads_ops (creator_id, ad_account_id, object_key, kind, payload, state, attempts, actor, started_at)
         VALUES ($1, $2, 'account', 'spend_cap', $3::jsonb, 'running', 1, $4::jsonb, NOW()) RETURNING id`,
        [input.creatorId, input.adAccountId, JSON.stringify({ amount: input.amount }), JSON.stringify({ userId: input.userId, via: 'owner' })]
    );
    const opId = op!.id;
    try {
        const params: GraphParams = input.amount === null ? { spend_cap_action: 'delete' } : { spend_cap: String(roundMoney(input.amount)) };
        await adsPost(`act_${input.adAccountId}`, params, input.token, { label: 'spend cap' });
    } catch (err) {
        await finishSpendOp(input.creatorId, opId, mayHaveLanded(err) ? 'verify' : 'failed', { code: (err as AdsGraphError)?.metaCode ?? null, message: err instanceof Error ? err.message.slice(0, 300) : null });
        if (err instanceof AdsGraphError && err.klass === 'spend_cap_limit') {
            throw new SpendCapRefused('EDIT_LIMIT', 'Meta allows 10 changes to the spending limit a day; try again tomorrow.', nextLocalMidnight(now, input.offsetHours));
        }
        throw err;
    }
    let raw: unknown = null;
    try {
        raw = (await adsGet(`act_${input.adAccountId}`, { fields: 'spend_cap,amount_spent' }, input.token, { label: 'spend cap read back' })).data?.spend_cap;
    } catch (err) {
        log('warn', 'ads.spend_cap_readback_failed', { creator_id: input.creatorId, ...describeError(err) });
    }
    const read = raw === null || raw === undefined || raw === '' ? null : num(raw);
    let amount: number | null = null;
    let units: SpendCapResult['units'] = null;
    let verified = false;
    if (input.amount === null) {
        verified = read === null || read === 0;
    } else if (read !== null) {
        const asMinor = roundMoney(fromMinorUnits(read, input.currency));
        if (Math.round(asMinor * 100) === Math.round(input.amount * 100)) { units = 'minor'; amount = asMinor; verified = true; }
        else if (Math.round(read * 100) === Math.round(input.amount * 100)) { units = 'major'; amount = roundMoney(read); verified = true; }
        else amount = asMinor;
    }
    log(verified ? 'info' : 'warn', 'ads.spend_cap_units', { creator_id: input.creatorId, asked: input.amount, read_back: read, units, verified });
    await finishSpendOp(input.creatorId, opId, 'done', { read_back: read, units, verified });
    return { op: { id: opId, state: 'done', kind: 'spend_cap' }, amount: input.amount === null ? null : amount, verified, units };
}
