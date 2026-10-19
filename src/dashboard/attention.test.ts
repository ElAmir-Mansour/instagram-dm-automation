/**
 * `Attention` (dashboard/js/attention.js): the one set of rules for "does this conversation need a person?".
 *
 * Three screens used to carry three copies (UX audit IN-03, OV-02), so the nav badge changed number with the page you were on. These
 * pin the rules themselves, because a screenshot cannot: which threads count, when the 24 h window ends, when "handled" ends, and
 * who an AI reply would come from. And they pin the property that matters more than any one rule: that the Overview, the Inbox and
 * the nav badge ask THIS file, and no screen has its own copy any more.
 *
 * Loaded the way the other dashboard suites load: the REAL shipped files, through `_harness.ts`.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, type Json } from './_harness.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-10-19T12:00:00Z');
/** An ISO time `ms` before NOW. */
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

/** A thread the bot handed to a person two hours ago; the customer's last message was an hour ago. */
const handed = (over: Json = {}): Json => ({
    id: 'c1', is_bot_active: false, stage: 'handoff', handoff_at: ago(2 * HOUR), last_operator_at: null,
    last_inbound_message_at: ago(HOUR), last_message_direction: 'outbound', last_message_at: ago(HOUR), ...over,
});
/** A thread whose last message is the customer's, with the AI off. */
const waiting = (over: Json = {}): Json => ({
    id: 'c2', is_bot_active: false, last_message_direction: 'inbound', last_message_at: ago(HOUR), last_inbound_message_at: ago(HOUR), ...over,
});

const { Attention } = loadDashboard();
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));

describe('Attention.isWaiting', () => {
    it('is a thread with the AI off whose last message is the customer\'s', () => {
        assert.equal(Attention.isWaiting(waiting()), true);
    });

    it('is not a thread the AI is answering, or one whose last message is ours, or one that says nothing', () => {
        assert.equal(Attention.isWaiting(waiting({ is_bot_active: true })), false, 'the bot will answer');
        assert.equal(Attention.isWaiting(waiting({ last_message_direction: 'outbound' })), false, 'we spoke last');
        assert.equal(Attention.isWaiting(waiting({ is_bot_active: undefined })), false, 'an unknown switch is not a pause');
        assert.equal(Attention.isWaiting(waiting({ is_bot_active: null })), false);
        assert.equal(Attention.isWaiting({}), false);
        assert.equal(Attention.isWaiting(null), false);
        assert.equal(Attention.isWaiting(undefined), false);
    });
});

describe('Attention.isHandoff', () => {
    it('is a conversation handed over to a person that nobody has answered since', () => {
        assert.equal(Attention.isHandoff(handed()), true);
    });

    it('is the same whether the bot was paused (a refund, a complaint) or left on (the model could not write a reply)', () => {
        assert.equal(Attention.isHandoff(handed({ is_bot_active: false })), true, 'paused handoff');
        assert.equal(Attention.isHandoff(handed({ is_bot_active: true, handoff_reason: 'unsure' })), true, 'failure handoff, bot still on');
    });

    it('ends when the owner replied at or after the handoff, and not when the reply is older than it', () => {
        assert.equal(Attention.isHandoff(handed({ last_operator_at: ago(30 * 60 * 1000) })), false, 'replied after');
        assert.equal(Attention.isHandoff(handed({ last_operator_at: ago(2 * HOUR) })), false, 'in the same instant: answered');
        assert.equal(Attention.isHandoff(handed({ last_operator_at: ago(5 * HOUR) })), true, 'an older reply is not an answer to this handoff');
    });

    it('is only ever a thread in the handoff stage, and a database that is behind flags nothing', () => {
        for (const stage of ['new', 'qualify', 'recommend', 'objection', 'link', 'follow_up', 'closed', undefined, null]) {
            assert.equal(Attention.isHandoff(handed({ stage })), false, String(stage));
        }
        assert.equal(Attention.isHandoff({}), false);
        assert.equal(Attention.isHandoff(null), false);
    });

    it('is still a handoff when the stamp is missing or unreadable: the stage says so', () => {
        assert.equal(Attention.isHandoff(handed({ handoff_at: null })), true);
        assert.equal(Attention.isHandoff(handed({ handoff_at: 'not a date', last_operator_at: ago(HOUR) })), true);
    });
});

describe('Attention.isHot', () => {
    const clicks = (n: number, over: Json = {}): Json => ({ links: 1, clicks: n, prefetch: 0, ...over });

    it('is a person who opened the link, who said they are ready to buy, or a lead the bot flagged', () => {
        assert.equal(Attention.isHot({ stage: 'link', link_clicks: clicks(1) }), true);
        assert.equal(Attention.isHot({ stage: 'recommend', last_intent: 'ready_to_buy' }), true);
        assert.equal(Attention.isHot({ stage: 'handoff', handoff_reason: 'hot_lead' }), true);
    });

    it('is not a link only crawlers opened, a link nobody opened, or any other intent or reason', () => {
        assert.equal(Attention.isHot({ link_clicks: clicks(0, { prefetch: 6 }) }), false);
        assert.equal(Attention.isHot({ last_intent: 'price' }), false);
        assert.equal(Attention.isHot({ handoff_reason: 'refund' }), false);
    });

    it('is never someone who opted out or whose conversation is closed', () => {
        assert.equal(Attention.isHot({ stage: 'closed', link_clicks: clicks(3), last_intent: 'ready_to_buy' }), false);
        assert.equal(Attention.isHot({ stage: 'link', opted_out_at: ago(HOUR), link_clicks: clicks(3) }), false);
    });

    it('reads nonsense as no click: text that is not a count, a negative, NaN, a missing column', () => {
        for (const thread of [null, {}, { link_clicks: null }, { link_clicks: 'many' }, { link_clicks: { clicks: 'abc' } }, { link_clicks: { clicks: -3 } }, { link_clicks: { clicks: NaN } }]) {
            assert.equal(Attention.isHot(thread), false, JSON.stringify(thread));
        }
        assert.equal(Attention.isHot({ link_clicks: { clicks: '2' } }), true, 'a count that arrives as text is still a count');
    });
});

describe('Attention.isHandled', () => {
    it('is false for every thread until the server sends handled_at: today\'s behaviour, unchanged', () => {
        assert.equal(Attention.isHandled(waiting()), false);
        assert.equal(Attention.isHandled(handed()), false);
        assert.equal(Attention.isHandled({}), false);
        assert.equal(Attention.isHandled(null), false);
    });

    it('is true once handled_at is set and the customer has not written since', () => {
        assert.equal(Attention.isHandled(waiting({ handled_at: ago(10 * 60 * 1000) })), true, 'handled after the last inbound message');
    });

    it('ends by itself when a newer message from the customer arrives, whether or not the server cleared the stamp', () => {
        assert.equal(Attention.isHandled(waiting({ handled_at: ago(3 * HOUR) })), false, 'last_inbound_message_at is newer');
        assert.equal(Attention.isHandled({ handled_at: ago(3 * HOUR), last_message_direction: 'inbound', last_message_at: ago(HOUR) }), false, 'the last message itself is the newer inbound one');
        assert.equal(Attention.isHandled({ handled_at: ago(3 * HOUR), last_inbound_at: ago(HOUR) }), false, 'the v39 stamp counts too');
    });

    it('takes the NEWEST inbound time of the three places the list item holds one', () => {
        // The v39 stamp is old (only a sales turn writes it); the message the customer sent since is what counts.
        assert.equal(Attention.isHandled(waiting({ handled_at: ago(2 * HOUR), last_inbound_at: ago(5 * HOUR), last_inbound_message_at: ago(HOUR) })), false);
        assert.equal(Attention.isHandled(waiting({ handled_at: ago(30 * 60 * 1000), last_inbound_at: ago(5 * HOUR), last_inbound_message_at: ago(HOUR) })), true);
    });

    it('treats the same instant as handled: only a STRICTLY newer message re-opens a thread', () => {
        assert.equal(Attention.isHandled(waiting({ handled_at: ago(HOUR), last_inbound_message_at: ago(HOUR) })), true);
    });

    it('is handled when nothing says the customer wrote at all, and not when the stamp is unreadable', () => {
        assert.equal(Attention.isHandled({ handled_at: ago(HOUR) }), true);
        assert.equal(Attention.isHandled(waiting({ handled_at: 'yesterday-ish' })), false);
        assert.equal(Attention.isHandled(waiting({ handled_at: null })), false);
    });
});

describe('Attention.needsHuman', () => {
    it('is waiting, or handed over, whichever it is', () => {
        assert.equal(Attention.needsHuman(waiting()), true);
        assert.equal(Attention.needsHuman(handed()), true);
        assert.equal(Attention.needsHuman(handed({ is_bot_active: true, handoff_reason: 'unsure' })), true, 'a failure handoff counts although the bot is on');
    });

    it('is not a thread that is neither, nor one the owner already answered', () => {
        assert.equal(Attention.needsHuman(waiting({ is_bot_active: true })), false);
        assert.equal(Attention.needsHuman(waiting({ last_message_direction: 'outbound' })), false);
        assert.equal(Attention.needsHuman(handed({ last_operator_at: ago(10 * 60 * 1000) })), false);
        assert.equal(Attention.needsHuman(null), false);
        assert.equal(Attention.needsHuman({}), false);
    });

    it('is not a thread marked handled, and is again once the customer writes after that', () => {
        assert.equal(Attention.needsHuman(waiting({ handled_at: ago(10 * 60 * 1000) })), false, 'handled');
        assert.equal(Attention.needsHuman(handed({ handled_at: ago(10 * 60 * 1000) })), false, 'a handoff can be marked handled too');
        assert.equal(Attention.needsHuman(waiting({ handled_at: ago(3 * HOUR) })), true, 'the customer wrote again: back in the queue');
        assert.equal(Attention.needsHuman(handed({ handled_at: ago(3 * HOUR), last_inbound_message_at: ago(HOUR) })), true);
    });

    it('can be handed to filter() as it is: it never reads `this`', () => {
        const rows = [waiting({ id: 'a' }), handed({ id: 'b' }), waiting({ id: 'c', is_bot_active: true })];
        assert.deepEqual(rows.filter(Attention.needsHuman).map((r) => r.id), ['a', 'b']);
        const { needsHuman, isWaiting, isHot, isHandled, isHandoff, windowLeftMs, effectiveAi } = Attention;
        assert.equal(needsHuman(rows[0]), true);
        assert.equal(isWaiting(rows[0]), true);
        assert.equal(isHot(rows[0]), false);
        assert.equal(isHandled(rows[0]), false);
        assert.equal(isHandoff(rows[1]), true);
        assert.equal(windowLeftMs(rows[0], NOW), 23 * HOUR);
        assert.equal(effectiveAi(rows[0], null), 'paused_thread');
    });
});

describe('Attention.windowLeftMs', () => {
    it('counts 24 hours from the customer\'s LAST message', () => {
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: ago(HOUR) }, NOW), 23 * HOUR);
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: ago(0) }, NOW), 24 * HOUR, 'a message this instant has the whole window');
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: ago(23 * HOUR + 59 * 60 * 1000) }, NOW), 60 * 1000, 'a minute left');
    });

    it('is 0 once the window has closed, exactly at 24 hours and after', () => {
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: ago(24 * HOUR) }, NOW), 0, 'at the edge: closed');
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: ago(30 * HOUR) }, NOW), 0);
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: ago(30 * 24 * HOUR) }, NOW), 0, 'a 152-day-old thread');
    });

    it('never promises more than 24 hours, whatever a clock a little behind says', () => {
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: ago(-5 * HOUR) }, NOW), 24 * HOUR);
    });

    it('prefers the message time read from messages, and falls back to the v39 column', () => {
        assert.equal(Attention.windowLeftMs({ last_inbound_at: ago(20 * HOUR), last_inbound_message_at: ago(HOUR) }, NOW), 23 * HOUR);
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: null, last_inbound_at: ago(4 * HOUR) }, NOW), 20 * HOUR);
    });

    it('is null when there is no inbound time at all, or an unreadable one, or no thread', () => {
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: null }, NOW), null);
        assert.equal(Attention.windowLeftMs({ last_inbound_message_at: 'soon' }, NOW), null);
        assert.equal(Attention.windowLeftMs({}, NOW), null);
        assert.equal(Attention.windowLeftMs(null, NOW), null);
    });

    it('reads the clock itself when it is not given one', () => {
        const left = Attention.windowLeftMs({ last_inbound_message_at: new Date(Date.now() - HOUR).toISOString() });
        assert.ok(left <= 23 * HOUR && left > 23 * HOUR - 10_000, String(left));
    });

    it('is the same number in both interface languages: the time math knows nothing about direction or locale', () => {
        const rows = [waiting(), handed(), waiting({ last_inbound_message_at: ago(30 * HOUR) }), waiting({ handled_at: ago(60_000) })];
        const answers = (lang: 'ar' | 'en'): Json => {
            const A = loadDashboard({ lang }).Attention;
            return JSON.parse(JSON.stringify(rows.map((r) => [A.windowLeftMs(r, NOW), A.needsHuman(r), A.isWaiting(r), A.isHandled(r), A.isHot(r)])));
        };
        assert.deepEqual(answers('ar'), answers('en'));
    });
});

describe('Attention.effectiveAi', () => {
    const on = { id: 'a', is_bot_active: true, instagram_user_id: '17841400000000001' };
    const paused = { ...on, is_bot_active: false };
    const settings = (over: Json = {}): Json => ({ is_active: true, sales_mode: 'off', sales_test_senders: [], ...over });

    it('is "on" for an ordinary thread with the assistant on', () => {
        assert.equal(Attention.effectiveAi(on, settings()), 'on');
    });

    it('is "off_global" when the whole assistant is switched off, whatever the thread says', () => {
        assert.equal(Attention.effectiveAi(on, settings({ is_active: false })), 'off_global', 'the thread says on, nobody answers');
        assert.equal(Attention.effectiveAi(paused, settings({ is_active: false })), 'off_global', 'it outranks a per-thread pause');
        assert.equal(Attention.effectiveAi(on, settings({ is_active: false, sales_mode: 'on' })), 'off_global', 'and sales mode');
    });

    it('is "paused_thread" when the assistant is on but not for this thread', () => {
        assert.equal(Attention.effectiveAi(paused, settings()), 'paused_thread');
        assert.equal(Attention.effectiveAi(paused, settings({ sales_mode: 'on' })), 'paused_thread', 'a paused thread is not answered by the sales assistant either');
    });

    it('is "sales_live" for every follower when sales mode is on', () => {
        assert.equal(Attention.effectiveAi(on, settings({ sales_mode: 'on' })), 'sales_live');
    });

    it('is "sales_test" only for a listed test sender, matched as text', () => {
        const test = settings({ sales_mode: 'test', sales_test_senders: ['17841400000000001', '99999'] });
        assert.equal(Attention.effectiveAi(on, test), 'sales_test');
        assert.equal(Attention.effectiveAi({ ...on, instagram_user_id: 17841400000000001n.toString() }, test), 'sales_test');
        assert.equal(Attention.effectiveAi({ ...on, instagram_user_id: 99999 }, test), 'sales_test', 'a number is compared as the text it prints as');
        assert.equal(Attention.effectiveAi({ ...on, instagram_user_id: '555' }, test), 'on', 'a follower who is not listed gets the ordinary path');
        assert.equal(Attention.effectiveAi({ id: 'x', is_bot_active: true }, test), 'on', 'no sender id: not a test sender');
        assert.equal(Attention.effectiveAi(on, settings({ sales_mode: 'test', sales_test_senders: null })), 'on');
    });

    it('is "on" for a sales mode it does not know, rather than inventing a state', () => {
        assert.equal(Attention.effectiveAi(on, settings({ sales_mode: 'maybe' })), 'on');
        assert.equal(Attention.effectiveAi(on, settings({ sales_mode: undefined })), 'on');
    });

    it('says only what the thread says while the settings have not been read: an unread switch is never reported as off', () => {
        for (const unread of [null, undefined, 'x', 7]) {
            assert.equal(Attention.effectiveAi(on, unread), 'on');
            assert.equal(Attention.effectiveAi(paused, unread), 'paused_thread');
        }
        assert.equal(Attention.effectiveAi(on, {}), 'on', 'settings with no is_active are not "off"');
        assert.equal(Attention.effectiveAi(null, settings()), 'on');
    });
});

describe('Attention is the only copy', () => {
    it('is loaded in index.html straight after components.js, at the same ?v= as the rest', () => {
        const index = readFileSync('dashboard/index.html', 'utf8');
        const scripts = [...index.matchAll(/<script defer src="\/dashboard\/js\/([\w.]+)\?v=([\w.]+)"><\/script>/g)].map((m) => [m[1], m[2]]);
        const names = scripts.map((s) => s[0]);
        assert.equal(names.indexOf('attention.js'), names.indexOf('components.js') + 1);
        assert.equal(new Set(scripts.map((s) => s[1])).size, 1, 'one version across every script');
    });

    it('has no second definition: no page module tests the fields that make a thread "waiting", "handed over" or "hot"', () => {
        const pages = readdirSync('dashboard/js/pages').filter((f) => f.endsWith('.js')).map((f) => `dashboard/js/pages/${f}`);
        // Each of these is a rule the shared file owns. A page that writes one again is the divergence this file ended.
        const rules: Array<[RegExp, string]> = [
            [/is_bot_active\s*===\s*false\s*&&/, 'waiting: AI off AND customer spoke last'],
            [/stage\s*!==\s*'handoff'/, 'handoff: only the handoff stage counts'],
            [/\.handoff_at\b/, 'handoff: the handoff stamp'],
            [/last_intent\s*===\s*'ready_to_buy'/, 'hot: ready to buy'],
            [/link_clicks\.clicks/, 'hot: link clicks'],
            [/last_inbound_message_at/, 'the window: which inbound time counts'],
        ];
        for (const file of pages) {
            const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            for (const [pattern, what] of rules) assert.equal(pattern.test(code), false, `${file} re-implements ${what}`);
        }
    });

    it('is what the Overview and the Inbox both count with: one number for the nav badge on every screen', () => {
        const h = loadDashboard({ files: ['dashboard/js/pages/overview.js', 'dashboard/js/pages/inbox.js'] });
        const threads = [
            waiting({ id: 'a' }),
            handed({ id: 'b' }),
            handed({ id: 'c', is_bot_active: true, handoff_reason: 'unsure' }),
            waiting({ id: 'd', is_bot_active: true }),
            waiting({ id: 'e', handled_at: ago(60_000) }),
            { id: 'f', is_bot_active: true, last_message_direction: 'outbound' },
        ];
        const expected = threads.filter((x) => h.Attention.needsHuman(x)).map((x) => x.id);
        assert.deepEqual(expected, ['a', 'b', 'c']);

        const Overview = h.run('OverviewPage');
        const Inbox = h.run('InboxPage');
        const badge: number[] = [];
        h.ctx.App = { setInboxWaiting: (n: number) => { badge.push(n); }, hashParam: () => '' };

        Overview.needsHumanThreads({ status: 'fulfilled', value: { data: threads } });
        Inbox.threads = threads;
        Inbox.reportWaiting();
        assert.deepEqual(badge, [3], 'the Inbox reports the shared count');
        assert.deepEqual(
            Overview.needsHumanThreads({ status: 'fulfilled', value: { data: threads } }).map((x: Json) => x.id),
            expected,
            'and the Overview counts the same threads',
        );
    });

    it('keeps the Overview\'s own briefing on "waiting" (a link to the waiting filter), oldest first, from the same predicate', () => {
        const h = loadDashboard({ files: ['dashboard/js/pages/overview.js'] });
        const Overview = h.run('OverviewPage');
        const rows = [waiting({ id: 'new', last_message_at: ago(HOUR) }), waiting({ id: 'old', last_message_at: ago(9 * HOUR) }), handed({ id: 'handoff' })];
        const got = Overview.waitingThreads({ status: 'fulfilled', value: { data: rows } }).map((x: Json) => x.id);
        assert.deepEqual(got, ['old', 'new']);
        // Arrays made inside the page's vm context have that context's Array.prototype: compare what they hold, not their realm.
        assert.deepEqual(plain(Overview.waitingThreads({ status: 'rejected', reason: new Error('x') })), []);
        assert.deepEqual(plain(Overview.waitingThreads(null)), []);
        assert.deepEqual(plain(Overview.waitingThreads({ status: 'fulfilled', value: { data: null } })), []);
    });
});
