/**
 * Where a tenant's A/B wording experiment lives, and the one column the sales turn reads about a conversation's arm (docs/DM_SALES_PLAN.md S14).
 *
 * **Stored per tenant, in `app_settings`** under `dm.variants.<creator id>` (`tenantSettingKey`): one JSON value, `{ v, config }`, validated by
 * `parseVariantConfig` on the way in AND on the way out, so a row nobody should have written can never put a fourth arm, a link or a number into a
 * prompt. No migration: a tenant that never opens the editor has no row, and a tenant with no row has no experiment.
 *
 * **The sales turn reads it and fails toward "no experiment".** `readVariantConfig` never throws: an unreadable value or a database error is logged and
 * answered with null, the prompt every conversation had before this existed. A DM must not be lost, or answered by an experiment nobody can read,
 * because of the lookup that decides how it is answered. The same goes for `readConversationVariant`, whose column comes from v42: a database that
 * is behind answers `{ ok: false }` and the turn runs without an arm.
 *
 * What is NOT here: writing a conversation's arm. That is one more assignment in the statement that records the turn (`store.ts`, `recordTurn`), so the
 * arm and the reply it belongs to are written together or not at all.
 */
import { queryOne } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { getSetting, setSetting, TENANT_SETTING_PREFIXES, tenantSettingKey } from '../appSettings.js';
import { EMPTY_VARIANT_CONFIG, parseVariantConfig, type VariantConfig } from './variants.js';

/** The stored value's own version: a reader that finds a newer one treats the row as unreadable rather than guessing. */
const STORE_VERSION = 1;

/** What the editor shows: the saved config (an empty one before the first save), and whether anything was ever saved. */
export interface VariantState {
    config: VariantConfig;
    saved: boolean;
}

const keyFor = (creatorId: string) => tenantSettingKey(TENANT_SETTING_PREFIXES.dmVariants, creatorId);

/**
 * The tenant's config, or null for none (never saved, or a value that cannot be read: logged). Throws only on a database error, which the editor's
 * route turns into a 500. The sales turn does not call this: it calls `readVariantConfig`.
 */
async function readStored(creatorId: string): Promise<VariantConfig | null> {
    const raw = await getSetting(keyFor(creatorId));
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || (parsed as Record<string, unknown>)['v'] !== STORE_VERSION) throw new Error('unknown version');
        const config = parseVariantConfig((parsed as Record<string, unknown>)['config']);
        if (!config.ok) throw new Error(`config refused: ${config.problems.map((p) => p.code).join(',')}`);
        return config.config;
    } catch (err) {
        log('warn', 'dm.variants_unreadable', { creator_id: creatorId, ...describeError(err) });
        return null;
    }
}

/** The editor's state: an unreadable or missing value reads as an empty editor, so the screen opens and a save writes over it. */
export async function readVariantState(creatorId: string): Promise<VariantState> {
    const config = await readStored(creatorId);
    return config ? { config, saved: true } : { config: { ...EMPTY_VARIANT_CONFIG, variants: [] }, saved: false };
}

/** Save the owner's config, already parsed. Everything about the experiment is this one row. */
export async function saveVariantConfig(creatorId: string, config: VariantConfig, userId: string | null): Promise<VariantState> {
    await setSetting(keyFor(creatorId), JSON.stringify({ v: STORE_VERSION, config }), userId);
    return { config, saved: true };
}

/** The tenant's experiment for a sales turn: the saved config, or null for none. Never throws (see the top of the file). */
export async function readVariantConfig(creatorId: string): Promise<VariantConfig | null> {
    try {
        return await readStored(creatorId);
    } catch (err) {
        log('warn', 'dm.variant_config_read_failed', { creator_id: creatorId, ...describeError(err) });
        return null;
    }
}

/** The arm a conversation was given, or `ok: false` when it could not be read (v42 not applied, a database error): the turn then has no arm. */
export type ConversationVariant = { ok: true; variant: string | null } | { ok: false };

export async function readConversationVariant(conversationId: string, creatorId: string): Promise<ConversationVariant> {
    try {
        const row = await queryOne<{ sales_variant: string | null }>(
            'SELECT sales_variant FROM conversations WHERE id = $1 AND creator_id = $2',
            [conversationId, creatorId]
        );
        return { ok: true, variant: typeof row?.sales_variant === 'string' && row.sales_variant !== '' ? row.sales_variant : null };
    } catch (err) {
        log('warn', 'dm.variant_unavailable', { creator_id: creatorId, conversation_id: conversationId, ...describeError(err) });
        return { ok: false };
    }
}
