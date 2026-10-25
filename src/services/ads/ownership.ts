/**
 * Tenant isolation for the ads module (research R18, spec Story 9 scenario 2): an id that came from a request or from a queued op is
 * re-checked against the stored copy before anything reads or writes it.
 *
 *   ownObject(creatorId, id)                       the mirror row, when it belongs to this tenant AND its current ad account
 *   assertOpTarget(creatorId, adAccountId, exec)   before every Graph send (ops.ts): the path's account or object is this tenant's
 *
 * Two checks, not one, because a tenant can switch ad accounts: a row of its own old account is still not something its current token
 * may touch. Every refusal is logged (`ads.not_own_object`) and audited, because a request for another tenant's object is either a bug or a
 * probe, and both must be visible.
 *
 * The lookup is deliberately NOT filtered by `creator_id`: it finds the row whoever owns it, so a refusal can say whose it was in the
 * log (never in the answer).
 */
import { queryOne } from '../../db/query.js';
import { AUDIT_ACTIONS, writeAudit } from '../audit.js';
import { log } from '../../utils/log.js';
import { normaliseAdAccountId } from './metaAds.js';

export interface OwnedObject {
    id: string;
    metaId: string | null;
    level: string;
    adAccountId: string;
}

export class NotOwnObjectError extends Error {
    readonly code = 'NOT_OWN_OBJECT';
    readonly status = 403;
    constructor() {
        super('This ad object is not in your ad account.');
        this.name = 'NotOwnObjectError';
    }
}

export class AdsObjectNotFoundError extends Error {
    readonly code = 'NOT_FOUND';
    readonly status = 404;
    constructor() {
        super('No such ad object.');
        this.name = 'AdsObjectNotFoundError';
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^[0-9]{5,25}$/;

/** The id as a request may send it: our row's uuid or Meta's numeric id. Anything else can name no object. */
function idKind(id: string): 'uuid' | 'meta' | null {
    if (UUID.test(id)) return 'uuid';
    if (META_ID.test(id)) return 'meta';
    return null;
}

/** Same account whether stored as `123` or `act_123`. */
function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = normaliseAdAccountId(a);
    return x !== null && x === normaliseAdAccountId(b);
}

async function refuse(creatorId: string, why: 'other_tenant' | 'other_account' | 'unknown_target', target: string, owner: string | null): Promise<never> {
    // The owner's id goes to the log and the audit trail, never into the answer.
    log('warn', 'ads.not_own_object', { creator_id: creatorId, why, target, owner_creator_id: owner });
    await writeAudit(
        { userId: null, email: null },
        { action: AUDIT_ACTIONS.adsNotOwnObject, targetType: 'creator', targetId: creatorId, detail: { why, target, owner_creator_id: owner } },
    );
    throw new NotOwnObjectError();
}

/**
 * The stored-copy row for `id`, when it is this tenant's and in `adAccountId` (the tenant's current account). Otherwise NOT_OWN_OBJECT
 * (logged, audited), or NOT_FOUND when no tenant has such a row.
 */
export async function ownObject(creatorId: string, adAccountId: string | null, id: string): Promise<OwnedObject> {
    const kind = idKind(String(id ?? ''));
    if (!kind) throw new AdsObjectNotFoundError();
    const row = await queryOne<{ id: string; creator_id: string; ad_account_id: string; meta_id: string | null; level: string }>(
        kind === 'uuid'
            ? `SELECT id, creator_id, ad_account_id, meta_id, level FROM ads_objects WHERE id = $1`
            // A Meta id is unique per (tenant, level); prefer this tenant's row so its own object is never refused for another's.
            : `SELECT id, creator_id, ad_account_id, meta_id, level FROM ads_objects WHERE meta_id = $1
                ORDER BY (creator_id = $2) DESC LIMIT 1`,
        kind === 'uuid' ? [id] : [id, creatorId],
    );
    if (!row) throw new AdsObjectNotFoundError();
    if (row.creator_id !== creatorId) return refuse(creatorId, 'other_tenant', id, row.creator_id);
    if (!sameAccount(row.ad_account_id, adAccountId)) return refuse(creatorId, 'other_account', id, row.creator_id);
    return { id: row.id, metaId: row.meta_id, level: row.level, adAccountId: row.ad_account_id };
}

/** The part of an op's Graph call that names its target (ops.ts `payload.exec`). */
export interface OpTarget {
    path: string;
}

/**
 * Before an op is sent (ops.ts `sendExec`, every write, tag search and read-back):
 *   - the op's own account (`opAccountId`, when given) must still be the tenant's current account: a tenant that switched accounts does
 *     not send old ops with its new token;
 *   - `act_<id>/…` must be the tenant's current account;
 *   - `<metaId>/…` must not be a stored object of another tenant or of another account.
 * A Meta id the stored copy does not know yet (an object made in Ads Manager before the next sync) is let through and logged
 * (`ads.op_target_unmirrored`): the token is the tenant's own, so Meta itself refuses objects outside its business, and refusing would
 * block a pause on a campaign the sync has not reached.
 */
export async function assertOpTarget(creatorId: string, adAccountId: string | null, exec: OpTarget, opAccountId?: string | null): Promise<void> {
    if (opAccountId !== undefined && !sameAccount(opAccountId, adAccountId)) return refuse(creatorId, 'other_account', `act_${opAccountId ?? ''}`, null);
    const path = String(exec?.path ?? '').replace(/^\/+/, '');
    const head = path.split('/')[0] ?? '';
    if (/^act_/i.test(head)) {
        if (!sameAccount(head, adAccountId)) return refuse(creatorId, 'other_account', head, null);
        return;
    }
    if (!META_ID.test(head)) return refuse(creatorId, 'unknown_target', head.slice(0, 40), null);
    try {
        await ownObject(creatorId, adAccountId, head);
    } catch (err) {
        if (!(err instanceof AdsObjectNotFoundError)) throw err;
        log('warn', 'ads.op_target_unmirrored', { creator_id: creatorId, target: head });
    }
}
