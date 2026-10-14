/**
 * Who the sales turn answers (docs/DM_SALES_PLAN.md S6): the tenant's `ai_agents.sales_mode` and its test-sender list.
 *
 *   off    the DM pipeline exactly as it was before the sales turn existed. The default for every agent, the owner's included.
 *   test   the sales turn for the senders in `sales_test_senders` ONLY; everyone else gets the old path. This is how the owner tries it
 *          from a second account before any customer meets it.
 *   on     the sales turn for everyone.
 *
 * Read per message, in its own statement, and it fails safe in the direction of the old path: a tenant with no agent row, a row from before
 * v39 (the columns are missing until `npm run migrate` has run) or a read that errors all answer `off`, and the last two are logged. A DM
 * must not be lost, or answered by an experiment, because of the lookup that decides how it is answered.
 */
import { queryOne } from '../../db/query.js';
import type { AiAgentRow } from '../../db/rows.js';
import { describeError, log } from '../../utils/log.js';

export const SALES_MODES = ['off', 'test', 'on'] as const;
export type SalesMode = (typeof SALES_MODES)[number];

export const isSalesMode = (value: unknown): value is SalesMode => typeof value === 'string' && (SALES_MODES as readonly string[]).includes(value);

/** What a row that says nothing means, and what the column defaults to (`migration_v39_dm_sales_state.sql`): the old path. */
export const DEFAULT_SALES_MODE: SalesMode = 'off';

/** More than a handful of test accounts is not a test. */
export const MAX_TEST_SENDERS = 20;

/** A platform-scoped sender id (an IGSID or a Messenger PSID) is a run of digits. Anything else is a typo that would silently match nobody. */
export const SENDER_ID = /^\d{5,32}$/;

export interface SalesSettings {
    mode: SalesMode;
    /** Trimmed, unique, in the order saved. */
    testSenders: string[];
}

/**
 * The test-sender list from what a person typed or an API sent: a list of ids, or one string of them separated by commas, spaces or
 * lines. Trimmed and deduplicated. Anything that is not an id is an error that names it, never dropped: a typo must not quietly leave the
 * one account the owner meant to test with off the list.
 */
export function parseTestSenders(input: unknown): { senders: string[] } | { error: string } {
    let parts: unknown[];
    if (input === undefined || input === null || input === '') parts = [];
    else if (typeof input === 'string') parts = input.split(/[\s,;،]+/);
    else if (Array.isArray(input)) parts = input;
    else return { error: 'sales_test_senders must be a list of sender ids.' };

    const senders: string[] = [];
    for (const part of parts) {
        if (typeof part !== 'string') return { error: 'sales_test_senders must be a list of sender ids.' };
        const id = part.trim();
        if (!id) continue;
        if (!SENDER_ID.test(id)) return { error: `"${id.slice(0, 40)}" is not a sender id: they are numbers only (the Instagram-scoped user id, 5 to 32 digits).` };
        if (!senders.includes(id)) senders.push(id);
    }
    if (senders.length > MAX_TEST_SENDERS) return { error: `At most ${MAX_TEST_SENDERS} test senders.` };
    return { senders };
}

/** The settings as a row holds them, with anything unreadable read as the old path. */
export function salesSettingsOf(row: Partial<Pick<AiAgentRow, 'sales_mode' | 'sales_test_senders'>> | null | undefined): SalesSettings {
    const senders = Array.isArray(row?.sales_test_senders)
        ? row.sales_test_senders.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean)
        : [];
    return { mode: isSalesMode(row?.sales_mode) ? row.sales_mode : DEFAULT_SALES_MODE, testSenders: senders };
}

/** Does the sales turn answer this sender under these settings? `off` nobody, `on` everybody, `test` only a listed id (an exact string match). */
export function answersWithSales(settings: SalesSettings, senderId: string): boolean {
    if (settings.mode === 'on') return true;
    if (settings.mode === 'test') return settings.testSenders.includes(senderId);
    return false;
}

/** The tenant's sales mode and test senders. Fails safe: see the top of the file. */
export async function readSalesSettings(creatorId: string): Promise<SalesSettings> {
    try {
        const row = await queryOne<Pick<AiAgentRow, 'sales_mode' | 'sales_test_senders'>>(
            'SELECT sales_mode, sales_test_senders FROM ai_agents WHERE creator_id = $1',
            [creatorId]
        );
        return salesSettingsOf(row);
    } catch (err) {
        log('warn', 'dm.sales_mode_read_failed', { creator_id: creatorId, ...describeError(err) });
        return { mode: DEFAULT_SALES_MODE, testSenders: [] };
    }
}
