/**
 * Who would answer a DM thread's next message, and when Meta's reply window closes, as `GET /api/conversations` states them
 * (UX overhaul US1, audit IN-02, FR-006).
 *
 * The inbox used to read ONE thing for its "AI active" badge: the thread's own switch (`conversations.is_bot_active`). The switch that
 * outranks it, the assistant's global one (`ai_agents.is_active`), lives on another screen, so with the assistant switched off every
 * thread still wore a green "AI active" and nobody was being answered. The state a person should read is the EFFECTIVE one: the global
 * switch, then the thread's own, then the sales mode. That is computed here, once, from the same row the DM pipeline reads
 * (`decideAgent` in `ai.ts`: no agent row or `is_active = false` means nobody speaks), and sent with every list item.
 *
 * `effectiveAiOf` is the SAME decision as `Attention.effectiveAi` in `dashboard/js/attention.js`, which the page uses to repaint a
 * thread the moment its own switch is flipped, before the next poll. `inboxAssistant.test.ts` loads that real file and compares the two
 * over every combination, so they cannot drift.
 *
 * Read-side only: nothing here sends a message or changes who answers.
 */
import { queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { salesSettingsOf, type SalesMode } from './dmSales/mode.js';

/** Meta's standard messaging window: a reply is allowed for 24 h after the customer's last message (DM plan section 2). */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const EFFECTIVE_AI_STATES = ['on', 'off_global', 'paused_thread', 'sales_test', 'sales_live'] as const;
export type EffectiveAi = (typeof EFFECTIVE_AI_STATES)[number];

/**
 * What the assistant is set to, from `ai_agents`, as the inbox needs it.
 *
 *   configured  there is an agent row. A tenant with none has never set the assistant up, and the pipeline then answers nobody
 *               (`decideAgent`: 'unconfigured'), so the inbox must not say "AI active" for it, and must not say "switched off" either:
 *               it was never switched on. The dashboard words the two differently.
 *   is_active   whether the assistant answers at all: false for a disabled agent AND for a tenant with no agent row.
 */
export interface AssistantState {
    configured: boolean;
    is_active: boolean;
    sales_mode: SalesMode;
    sales_test_senders: string[];
}

/**
 * The tenant's assistant state, or null when it could not be read. Never throws: a database behind a migration, or a hiccup, is logged as
 * `inbox.assistant_failed` and the list goes out without it (every item then reads from its own switch alone, as it always did), because
 * the thread list must not be held hostage to a status line.
 *
 * `sales_mode` and `sales_test_senders` are v39 columns, so a database without them is asked again for `is_active` alone (the sales mode
 * is then `off`, which is what the pipeline reads for it too: `salesSettingsOf`).
 */
export async function loadAssistantState(tenantId: string): Promise<AssistantState | null> {
    type Row = { is_active?: unknown; sales_mode?: unknown; sales_test_senders?: unknown };
    try {
        let rows: Row[];
        try {
            rows = await queryRows<Row>('SELECT is_active, sales_mode, sales_test_senders FROM ai_agents WHERE creator_id = $1', [tenantId]);
        } catch (err) {
            if ((err as { code?: string } | null)?.code !== '42703') throw err;
            rows = await queryRows<Row>('SELECT is_active FROM ai_agents WHERE creator_id = $1', [tenantId]);
        }
        return assistantStateOf(rows[0] ?? null);
    } catch (err) {
        log('warn', 'inbox.assistant_failed', { tenant_id: tenantId, ...describeError(err) });
        return null;
    }
}

/** An `ai_agents` row (or none) as the state. Pure. A row says `is_active` is false only when it is `false`: a null is the column's default, on. */
export function assistantStateOf(row: { is_active?: unknown; sales_mode?: unknown; sales_test_senders?: unknown } | null): AssistantState {
    if (!row) return { configured: false, is_active: false, sales_mode: 'off', sales_test_senders: [] };
    const sales = salesSettingsOf(row as Parameters<typeof salesSettingsOf>[0]);
    return {
        configured: true,
        is_active: row.is_active !== false,
        sales_mode: sales.mode,
        sales_test_senders: sales.testSenders,
    };
}

/**
 * The effective state of one thread. Order matters, and is the order the pipeline asks in:
 *
 *   off_global     the assistant is switched off (or was never set up): nobody is answered, whatever this thread says. It outranks a
 *                  per-thread pause, because turning that thread's switch back on would change nothing.
 *   paused_thread  the assistant is on, but not for this thread: the owner took it over, or the thread was handed to him.
 *   sales_live     the sales assistant answers every follower (`sales_mode = 'on'`).
 *   sales_test     the sales assistant answers only the listed test senders, and this thread is one of them.
 *   on             the ordinary reply path.
 *
 * With no state (`null`: it could not be read) only the thread's own switch can be said, so the answer is `paused_thread` or `on`: an
 * unread setting is never reported as off. The sender id is compared as a string, exactly as `answersWithSales` does.
 */
export function effectiveAiOf(
    thread: { is_bot_active?: unknown; instagram_user_id?: unknown },
    assistant: Pick<AssistantState, 'is_active' | 'sales_mode' | 'sales_test_senders'> | null
): EffectiveAi {
    if (assistant && assistant.is_active === false) return 'off_global';
    if (thread.is_bot_active === false) return 'paused_thread';
    if (!assistant) return 'on';
    if (assistant.sales_mode === 'on') return 'sales_live';
    if (assistant.sales_mode === 'test') {
        const id = thread.instagram_user_id;
        if (id !== undefined && id !== null && assistant.sales_test_senders.map(String).includes(String(id))) return 'sales_test';
    }
    return 'on';
}

/**
 * When Meta's window for this thread closes: the customer's last message plus 24 h, as an ISO string, or null when they have not written.
 * Counted from `last_inbound_message_at` (read from `messages`), falling back to the v39 `last_inbound_at` (which only a sales turn writes),
 * exactly as `Attention.windowLeftMs` reads them. Not clamped: a window that closed yesterday is a date in the past, which is how the
 * page knows it is closed.
 */
export function windowEndsAtOf(row: { last_inbound_message_at?: unknown; last_inbound_at?: unknown }): string | null {
    const at = (value: unknown): number => (value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN);
    const fromMessages = at(row.last_inbound_message_at);
    const ms = Number.isFinite(fromMessages) ? fromMessages : at(row.last_inbound_at);
    return Number.isFinite(ms) ? new Date(ms + REPLY_WINDOW_MS).toISOString() : null;
}
