/**
 * The effective assistant state and the reply window, as the conversation list states them (UX US1, audit IN-02, FR-006).
 *
 * `effectiveAiOf` (server) and `Attention.effectiveAi` (dashboard/js/attention.js) are the same decision written twice: the server's goes out
 * with every list item, the page's repaints a thread the instant its own switch is flipped. The first block loads the REAL dashboard file and
 * compares the two over every combination, so one cannot be changed without the other. The second pins `assistantStateOf` (what a row, or no
 * row, means) and the window's arithmetic against `Attention.windowLeftMs` the same way.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { assistantStateOf, EFFECTIVE_AI_STATES, effectiveAiOf, REPLY_WINDOW_MS, windowEndsAtOf, type AssistantState } from './inboxAssistant.js';
import { conversationView } from './inboxDetail.js';

type Json = any;

function loadAttention(): Json {
    const ctx: Json = { Date, Number, Math, String, Array, Object };
    vm.createContext(ctx);
    vm.runInContext(readFileSync('dashboard/js/attention.js', 'utf8'), ctx, { filename: 'dashboard/js/attention.js' });
    return vm.runInContext('Attention', ctx);
}

const SENDER = '17841400003051';
const settings = (over: Partial<AssistantState> = {}): AssistantState => ({ configured: true, is_active: true, sales_mode: 'off', sales_test_senders: [], ...over });

describe('effectiveAiOf', () => {
    it('is off_global whenever the assistant is switched off, even for a thread whose own switch is on', () => {
        assert.equal(effectiveAiOf({ is_bot_active: true }, settings({ is_active: false })), 'off_global');
        assert.equal(effectiveAiOf({ is_bot_active: false }, settings({ is_active: false })), 'off_global', 'it outranks a per-thread pause: turning that back on would change nothing');
        assert.equal(effectiveAiOf({ is_bot_active: true }, settings({ is_active: false, sales_mode: 'on' })), 'off_global', 'and the sales mode');
    });

    it('is paused_thread when the assistant is on and the thread\'s own switch is off, in every sales mode', () => {
        for (const sales_mode of ['off', 'test', 'on'] as const) {
            assert.equal(effectiveAiOf({ is_bot_active: false, instagram_user_id: SENDER }, settings({ sales_mode, sales_test_senders: [SENDER] })), 'paused_thread', sales_mode);
        }
    });

    it('reads the sales mode: live for everyone, test for the listed senders only, otherwise the ordinary path', () => {
        assert.equal(effectiveAiOf({ is_bot_active: true, instagram_user_id: 'x' }, settings({ sales_mode: 'on' })), 'sales_live');
        assert.equal(effectiveAiOf({ is_bot_active: true, instagram_user_id: SENDER }, settings({ sales_mode: 'test', sales_test_senders: [SENDER] })), 'sales_test');
        assert.equal(effectiveAiOf({ is_bot_active: true, instagram_user_id: '999' }, settings({ sales_mode: 'test', sales_test_senders: [SENDER] })), 'on');
        assert.equal(effectiveAiOf({ is_bot_active: true }, settings({ sales_mode: 'test', sales_test_senders: [SENDER] })), 'on', 'no sender id, no match');
        assert.equal(effectiveAiOf({ is_bot_active: true, instagram_user_id: SENDER }, settings({ sales_mode: 'off', sales_test_senders: [SENDER] })), 'on', 'a list is ignored while the mode is off');
    });

    it('compares the sender as a string, as the pipeline does, so a number from a driver still matches', () => {
        assert.equal(effectiveAiOf({ is_bot_active: true, instagram_user_id: 17841400003051 }, settings({ sales_mode: 'test', sales_test_senders: [SENDER] })), 'sales_test');
    });

    it('with no state (it could not be read) says only what the thread\'s own switch says, and never "off"', () => {
        assert.equal(effectiveAiOf({ is_bot_active: true }, null), 'on');
        assert.equal(effectiveAiOf({ is_bot_active: false }, null), 'paused_thread');
        assert.equal(effectiveAiOf({}, null), 'on');
    });

    it('answers one of the five states, always', () => {
        for (const active of [true, false]) for (const bot of [true, false, undefined, null]) for (const mode of ['off', 'test', 'on'] as const) {
            const state = effectiveAiOf({ is_bot_active: bot, instagram_user_id: SENDER }, settings({ is_active: active, sales_mode: mode, sales_test_senders: [SENDER] }));
            assert.ok((EFFECTIVE_AI_STATES as readonly string[]).includes(state), state);
        }
    });
});

describe('the server and the dashboard decide the same (Attention.effectiveAi)', () => {
    it('agrees over every combination of the global switch, the thread\'s switch, the sales mode and the sender', () => {
        const Attention = loadAttention();
        let compared = 0;
        for (const is_active of [true, false]) {
            for (const is_bot_active of [true, false]) {
                for (const sales_mode of ['off', 'test', 'on'] as const) {
                    for (const senders of [[], [SENDER], ['999']]) {
                        for (const instagram_user_id of [SENDER, '999', undefined, null]) {
                            const state = settings({ is_active, sales_mode, sales_test_senders: senders });
                            const thread = { is_bot_active, instagram_user_id };
                            assert.equal(
                                effectiveAiOf(thread, state), Attention.effectiveAi(thread, state),
                                JSON.stringify({ thread, state })
                            );
                            compared++;
                        }
                    }
                }
            }
        }
        assert.equal(compared, 2 * 2 * 3 * 3 * 4);
        // And with no settings at all.
        for (const is_bot_active of [true, false, undefined]) {
            assert.equal(effectiveAiOf({ is_bot_active }, null), Attention.effectiveAi({ is_bot_active }, null));
        }
    });

    it('closes the window at the same instant: windowEndsAtOf is what windowLeftMs counts down to', () => {
        const Attention = loadAttention();
        const now = Date.parse('2026-10-18T12:00:00.000Z');
        const rows = [
            { last_inbound_message_at: '2026-10-18T10:00:00.000Z' },
            { last_inbound_message_at: '2026-10-17T10:00:00.000Z' },                                   // closed
            { last_inbound_message_at: null, last_inbound_at: '2026-10-18T08:00:00.000Z' },            // the v39 stamp stands in
            { last_inbound_message_at: '2026-10-18T11:00:00.000Z', last_inbound_at: '2026-10-17T01:00:00.000Z' },  // the messages' stamp wins
            { last_inbound_message_at: new Date('2026-10-18T09:30:00.000Z') },                         // a Date from the driver
        ];
        for (const row of rows) {
            const end = windowEndsAtOf(row);
            assert.ok(end, JSON.stringify(row));
            const left = Math.max(0, Math.min(REPLY_WINDOW_MS, Date.parse(end) - now));
            assert.equal(left, Attention.windowLeftMs(row, now), JSON.stringify(row));
        }
        assert.equal(windowEndsAtOf({}), null);
        assert.equal(Attention.windowLeftMs({}, now), null, 'and both say "no window" for a customer who has not written');
    });
});

describe('windowEndsAtOf', () => {
    it('is the customer\'s last message plus 24 hours, as ISO, and not clamped: a closed window is a date in the past', () => {
        assert.equal(windowEndsAtOf({ last_inbound_message_at: '2026-10-18T10:00:00.000Z' }), '2026-10-19T10:00:00.000Z');
        assert.equal(windowEndsAtOf({ last_inbound_message_at: '2025-01-01T00:00:00.000Z' }), '2025-01-02T00:00:00.000Z');
    });

    it('is null for no message, an unreadable one, or a value that is not a date', () => {
        for (const row of [{}, { last_inbound_message_at: null }, { last_inbound_message_at: 'soon' }, { last_inbound_message_at: 5 }]) {
            assert.equal(windowEndsAtOf(row), null, JSON.stringify(row));
        }
    });
});

describe('assistantStateOf', () => {
    it('is "never set up" for a tenant with no agent row: not active, and not configured, which is different from switched off', () => {
        assert.deepEqual(assistantStateOf(null), { configured: false, is_active: false, sales_mode: 'off', sales_test_senders: [] });
    });

    it('is off only when the column says false: a null is the default, on', () => {
        assert.equal(assistantStateOf({ is_active: false }).is_active, false);
        assert.equal(assistantStateOf({ is_active: true }).is_active, true);
        assert.equal(assistantStateOf({ is_active: null }).is_active, true);
        assert.equal(assistantStateOf({}).configured, true);
    });

    it('reads the sales settings the way the pipeline does: an unknown mode is off, ids are trimmed strings', () => {
        assert.deepEqual(assistantStateOf({ is_active: true, sales_mode: 'test', sales_test_senders: [' 17841400003051 ', 5, ''] }), {
            configured: true, is_active: true, sales_mode: 'test', sales_test_senders: ['17841400003051'],
        });
        assert.equal(assistantStateOf({ is_active: true, sales_mode: 'sometimes' }).sales_mode, 'off');
    });
});

describe('conversationView: the three fields this release adds', () => {
    it('adds handled_at (ISO), window_ends_at and effective_ai to the row it was handed, and keeps the row', () => {
        const view = conversationView({
            id: 'c1', is_bot_active: true, instagram_user_id: SENDER, handled_at: new Date('2026-10-18T12:00:00.000Z'),
            last_inbound_message_at: '2026-10-18T10:00:00.000Z',
        }, 'instagram', null, settings({ is_active: false }));
        assert.equal(view.id, 'c1');
        assert.equal(view.handled_at, '2026-10-18T12:00:00.000Z');
        assert.equal(view.window_ends_at, '2026-10-19T10:00:00.000Z');
        assert.equal(view.effective_ai, 'off_global');
    });

    it('is null for handled_at and the window, and the thread\'s own state for effective_ai, on a bare row with no assistant state', () => {
        const bare = conversationView({ id: 'c2' }, null);
        assert.equal(bare.handled_at, null);
        assert.equal(bare.window_ends_at, null);
        assert.equal(bare.effective_ai, 'on');
        assert.equal(conversationView({ id: 'c3', is_bot_active: false }, null).effective_ai, 'paused_thread');
    });
});
