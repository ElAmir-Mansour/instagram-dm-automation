/**
 * Who the WhatsApp agent answers (docs/specs/001-whatsapp-agent, FR-007): the tenant's `ai_agents.whatsapp_mode` and its test senders, the
 * WhatsApp counterpart of `dmSales/mode.ts`' `sales_mode`.
 *
 *   off        store what arrives, answer nobody. The default for every agent, the owner's included
 *   test       answer only `whatsapp_test_senders`
 *   everyone   answer all. Refused by the API until the go-live gate (a later phase) says the public pages name WhatsApp
 *
 * The test-sender validator is this file's own, not `dmSales/mode.ts`' `SENDER_ID` (`/^\d{5,32}$/`, an Instagram or Messenger id): widening
 * that one would change what Instagram's settings route accepts. A WhatsApp sender is a BSUID (a country prefix, a dot, up to 125
 * alphanumerics: `EG.13491208655302741918`, and a parent BSUID `US.ENT.…`) or a phone number in E.164 digits.
 */
import { queryOne } from '../db/query.js';
import type { AiAgentRow } from '../db/rows.js';

export const WHATSAPP_MODES = ['off', 'test', 'everyone'] as const;
export type WhatsAppMode = (typeof WHATSAPP_MODES)[number];

export const isWhatsAppMode = (value: unknown): value is WhatsAppMode =>
    typeof value === 'string' && (WHATSAPP_MODES as readonly string[]).includes(value);

/** What a row that says nothing means, and what the column defaults to (migration v50): store, answer nobody. */
export const DEFAULT_WHATSAPP_MODE: WhatsAppMode = 'off';

/** More than a handful of test accounts is not a test. The same cap as Instagram's list. */
export const MAX_WHATSAPP_TEST_SENDERS = 20;

/** A business-scoped user id: two capitals, a dot, then 1 to 125 letters, digits and dots (which covers `US.ENT.…` parent ids). */
export const BSUID = /^[A-Z]{2}\.[A-Za-z0-9.]{1,125}$/;
/** A phone number in E.164 digits, with no plus sign and no spaces. */
export const E164_DIGITS = /^\d{8,15}$/;

export const isWhatsAppSender = (value: string): boolean => BSUID.test(value) || E164_DIGITS.test(value);

/**
 * The test-sender list from what a person typed or an API sent: a list, or one string separated by commas, spaces or lines. Trimmed and
 * deduplicated, in the order given. Anything that is not a sender is an error that names it, never dropped: a typo must not quietly leave
 * the one account the owner meant to test with off the list.
 */
export function parseWhatsAppTestSenders(input: unknown): { senders: string[] } | { error: string } {
    let parts: unknown[];
    if (input === undefined || input === null || input === '') parts = [];
    else if (typeof input === 'string') parts = input.split(/[\s,;،]+/);
    else if (Array.isArray(input)) parts = input;
    else return { error: 'test_senders must be a list of WhatsApp ids or phone numbers.' };

    const senders: string[] = [];
    for (const part of parts) {
        if (typeof part !== 'string') return { error: 'test_senders must be a list of WhatsApp ids or phone numbers.' };
        const id = part.trim();
        if (!id) continue;
        if (!isWhatsAppSender(id)) {
            return { error: `"${id.slice(0, 40)}" is not a WhatsApp sender: use the contact's id (like EG.123456789) or a phone number in digits with the country code (8 to 15 digits, no plus sign).` };
        }
        if (!senders.includes(id)) senders.push(id);
    }
    if (senders.length > MAX_WHATSAPP_TEST_SENDERS) return { error: `At most ${MAX_WHATSAPP_TEST_SENDERS} test senders.` };
    return { senders };
}

export interface WhatsAppAgentSettings {
    mode: WhatsAppMode;
    /** Trimmed, unique, in the order saved. */
    testSenders: string[];
}

/** The settings as a row holds them, with anything unreadable read as `off`. */
export function whatsAppSettingsOf(row: Partial<Pick<AiAgentRow, 'whatsapp_mode' | 'whatsapp_test_senders'>> | null | undefined): WhatsAppAgentSettings {
    const senders = Array.isArray(row?.whatsapp_test_senders)
        ? row.whatsapp_test_senders.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean)
        : [];
    return { mode: isWhatsAppMode(row?.whatsapp_mode) ? row.whatsapp_mode : DEFAULT_WHATSAPP_MODE, testSenders: senders };
}

/** The tenant's mode and test senders, or `off` when it has no agent row. A read that fails is the caller's to handle. */
export async function readWhatsAppSettings(creatorId: string): Promise<WhatsAppAgentSettings> {
    const row = await queryOne<Pick<AiAgentRow, 'whatsapp_mode' | 'whatsapp_test_senders'>>(
        'SELECT whatsapp_mode, whatsapp_test_senders FROM ai_agents WHERE creator_id = $1',
        [creatorId]
    );
    return whatsAppSettingsOf(row);
}

/**
 * Save the mode and/or the test senders. An UPDATE, never an INSERT: an agent row also holds the persona and the DM switch, and creating
 * one as a side effect of picking a WhatsApp mode would create a half-configured bot. Null when the tenant has no agent row.
 */
export async function writeWhatsAppSettings(
    creatorId: string,
    change: { mode?: WhatsAppMode; testSenders?: string[] }
): Promise<WhatsAppAgentSettings | null> {
    const row = await queryOne<Pick<AiAgentRow, 'whatsapp_mode' | 'whatsapp_test_senders'>>(
        `UPDATE ai_agents
            SET whatsapp_mode = COALESCE($2, whatsapp_mode),
                whatsapp_test_senders = COALESCE($3::text[], whatsapp_test_senders)
          WHERE creator_id = $1
      RETURNING whatsapp_mode, whatsapp_test_senders`,
        [creatorId, change.mode ?? null, change.testSenders ?? null]
    );
    return row ? whatsAppSettingsOf(row) : null;
}
