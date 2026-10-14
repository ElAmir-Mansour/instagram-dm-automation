/**
 * Where a tenant's ice breakers live and what pressing "Publish to Instagram" does (docs/DM_SALES_PLAN.md S13).
 *
 * **Stored per tenant, in `app_settings`** under `dm.ice_breakers.<creator id>` (`tenantSettingKey`): one JSON value, `{ v, config, published }`.
 * `config` is what the owner edits (a draft, validated by `parseConfig` on the way in AND on the way out, so a row nobody should have written
 * can never put a sixth ice breaker on Instagram). `published` is the record of the last publish. There is no migration: the table is
 * already there, a tenant that never opens the card has no row, and a tenant with no row has nothing to publish.
 *
 * **Nothing here runs unless a person pressed a button.** `readState` reads the database; `saveConfig` writes it; `publishToInstagram`,
 * `removeFromInstagram` and `readLive` are the only functions that call Meta, and the route that exposes them is owner-only. The DM pipeline
 * never calls any of them. Reading a draft or saving one sends nothing anywhere.
 *
 * Instagram is made to match the editor, not merely added to (`planPublish`): a property the editor has is set, one it no longer has is
 * removed when this app is what published it, and Meta's own "only properties set in the request body will be overwritten" is why.
 */
import { describeError, log } from '../../utils/log.js';
import { getSetting, setSetting, TENANT_SETTING_PREFIXES, tenantSettingKey } from '../appSettings.js';
import { deleteInstagramProfile, getInstagramProfile, setInstagramProfile } from '../instagram.js';
import { profileContextOrLegacy, type ProfileContext } from '../profile/context.js';
import { kitFor, type KitKey } from '../profile/kits.js';
import { getTenant, NOT_CONNECTED_MESSAGE } from '../tenant.js';
import {
    EMPTY_CONFIG, fingerprint, parseConfig, planPublish, readLiveProfile, READ_FIELDS, REMOVE_FIELDS, suggestIceBreakers,
    type IceBreakerConfig, type LiveProfile, type ProfileField, type PublishedState, type Suggestion,
} from './iceBreakers.js';

/** The stored value's own version: a reader that finds a newer one treats the row as unreadable rather than guessing. */
const STORE_VERSION = 1;

/** The state of a tenant's ice breakers: the draft, the last publish, and whether a draft was ever saved. */
export interface IceBreakerState {
    config: IceBreakerConfig;
    published: PublishedState | null;
    saved: boolean;
}

/** A refusal the route turns into an answer: a status, a stable code and a sentence. Never a Meta failure (those are `MetaApiError`). */
export class IceBreakerError extends Error {
    constructor(readonly code: 'META_NOT_CONNECTED' | 'INSTAGRAM_NOT_CONNECTED' | 'NOTHING_TO_PUBLISH', readonly status: number, message: string) {
        super(message);
        this.name = 'IceBreakerError';
    }
}

const keyFor = (creatorId: string) => tenantSettingKey(TENANT_SETTING_PREFIXES.dmIceBreakers, creatorId);

const isNonNegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000;

/** The published record as the row holds it, or null when it is not one: a malformed record is "never published", not a crash. */
function publishedOf(raw: unknown): PublishedState | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const p = raw as Record<string, unknown>;
    if (typeof p['at'] !== 'string' || !Number.isFinite(Date.parse(p['at']))) return null;
    if (!isNonNegativeInt(p['iceBreakers']) || !isNonNegativeInt(p['menu'])) return null;
    return {
        at: p['at'],
        by: typeof p['by'] === 'string' ? p['by'] : null,
        iceBreakers: p['iceBreakers'],
        menu: p['menu'],
        hash: typeof p['hash'] === 'string' ? p['hash'].slice(0, 32) : '',
    };
}

/**
 * The tenant's state. Fails toward "nothing saved": a value that is not JSON, is newer than this code, or holds a draft `parseConfig` refuses
 * reads as an empty editor (and is logged), so the screen opens and the owner can write a draft over it. A database error is the caller's.
 */
export async function readState(creatorId: string): Promise<IceBreakerState> {
    const raw = await getSetting(keyFor(creatorId));
    if (raw === null) return { config: { ...EMPTY_CONFIG }, published: null, saved: false };
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || (parsed as Record<string, unknown>)['v'] !== STORE_VERSION) throw new Error('unknown version');
        const row = parsed as Record<string, unknown>;
        const config = parseConfig(row['config']);
        if (!config.ok) throw new Error(`draft refused: ${config.problems.map((p) => p.code).join(',')}`);
        return { config: config.config, published: publishedOf(row['published']), saved: true };
    } catch (err) {
        log('warn', 'dm.ice_breakers_unreadable', { creator_id: creatorId, ...describeError(err) });
        return { config: { ...EMPTY_CONFIG }, published: null, saved: false };
    }
}

async function write(creatorId: string, config: IceBreakerConfig, published: PublishedState | null, userId: string | null): Promise<void> {
    await setSetting(keyFor(creatorId), JSON.stringify({ v: STORE_VERSION, config, published }), userId);
}

/** Save the owner's draft. The last publish is kept as it was, so the screen can say the draft is newer than what Instagram holds. */
export async function saveConfig(creatorId: string, config: IceBreakerConfig, userId: string | null): Promise<IceBreakerState> {
    const { published } = await readState(creatorId);
    await write(creatorId, config, published, userId);
    return { config, published, saved: true };
}

/** What a Meta call is made with: the tenant's own Page token, and only when there is an Instagram account to publish to. */
async function connectionFor(creatorId: string): Promise<{ token: string }> {
    const tenant = await getTenant(creatorId);
    if (!tenant?.page_access_token) throw new IceBreakerError('META_NOT_CONNECTED', 409, NOT_CONNECTED_MESSAGE);
    if (!tenant.instagram_page_id) throw new IceBreakerError('INSTAGRAM_NOT_CONNECTED', 409, 'No Instagram account is connected for this tenant: connect one first.');
    return { token: tenant.page_access_token };
}

/** What a publish did, for the route's answer and the audit row. */
export interface PublishResult {
    /** The properties set on Instagram by this press. */
    set: ProfileField[];
    /** The properties removed from Instagram by this press (the editor no longer has them, and this app had published them). */
    removed: ProfileField[];
    published: PublishedState;
}

/**
 * THE publish: sends the SAVED draft (what the owner saved is exactly what goes out, never what is half typed), as one POST, plus one DELETE
 * for a property the editor emptied. Throws `IceBreakerError` (nothing to publish, not connected) or Meta's own `MetaApiError`. When the POST
 * succeeds and the DELETE then fails, the record is written marked out of sync (an empty fingerprint) before the error is thrown, so the screen
 * does not claim a state Instagram does not hold, and a second press finishes the job (both calls are idempotent).
 */
export async function publishToInstagram(creatorId: string, userId: string | null): Promise<PublishResult> {
    const state = await readState(creatorId);
    const plan = planPublish(state.config, state.published);
    if (!plan) throw new IceBreakerError('NOTHING_TO_PUBLISH', 400, 'There is nothing to publish: add at least one ice breaker or menu item.');
    const { token } = await connectionFor(creatorId);

    let ice = state.published?.iceBreakers ?? 0;
    let menu = state.published?.menu ?? 0;
    const set: ProfileField[] = [];
    const removed: ProfileField[] = [];
    const record = (hash: string): PublishedState => ({ at: new Date().toISOString(), by: userId, iceBreakers: ice, menu, hash });

    if (plan.set) {
        await setInstagramProfile({ ...plan.set }, token);
        if (plan.set.ice_breakers) { set.push('ice_breakers'); ice = state.config.iceBreakers.length; }
        if (plan.set.persistent_menu) { set.push('persistent_menu'); menu = state.config.menu.length; }
    }
    if (plan.remove.length > 0) {
        try {
            await deleteInstagramProfile(plan.remove, token);
        } catch (err) {
            await write(creatorId, state.config, record(''), userId);
            throw err;
        }
        for (const field of plan.remove) {
            removed.push(field);
            if (field === 'ice_breakers') ice = 0; else menu = 0;
        }
    }

    const published = record(fingerprint(state.config));
    await write(creatorId, state.config, published, userId);
    return { set, removed, published };
}

/** "Remove from Instagram": delete both properties from the account's profile, and forget the record of a publish (the draft stays). */
export async function removeFromInstagram(creatorId: string, userId: string | null): Promise<{ removed: ProfileField[] }> {
    const state = await readState(creatorId);
    const { token } = await connectionFor(creatorId);
    await deleteInstagramProfile(REMOVE_FIELDS, token);
    await write(creatorId, state.config, null, userId);
    return { removed: [...REMOVE_FIELDS] };
}

/** What Instagram really holds right now: a read from Meta, not from our record. */
export async function readLive(creatorId: string): Promise<LiveProfile> {
    const { token } = await connectionFor(creatorId);
    return readLiveProfile(await getInstagramProfile(READ_FIELDS, token));
}

// ─── Suggestions ─────────────────────────────────────────────────────────────────────────────

/** The four starting questions for a profile's language and primary offer. Pure, so a test can hand it a context cut from a profile. */
export function suggestionsForContext(ctx: Pick<ProfileContext<'dm'>, 'language' | 'offers'>): { kit: KitKey; suggestions: Suggestion[] } {
    const kit = kitFor(ctx.language).key;
    const offer = ctx.offers.find((o) => o.primary) ?? ctx.offers[0] ?? null;
    return { kit, suggestions: suggestIceBreakers(kit, offer?.name ?? null) };
}

/**
 * The suggestions for a tenant. A profile that cannot be read is the neutral Arabic kit and no offer name (logged): the card still opens, and the
 * owner edits them anyway. Never throws.
 */
export async function suggestionsFor(creatorId: string): Promise<{ kit: KitKey; suggestions: Suggestion[] }> {
    try {
        return suggestionsForContext(await profileContextOrLegacy(creatorId, 'dm'));
    } catch (err) {
        log('warn', 'dm.ice_breakers_suggestions_unreadable', { creator_id: creatorId, ...describeError(err) });
        return { kit: 'msa', suggestions: suggestIceBreakers('msa', null) };
    }
}
