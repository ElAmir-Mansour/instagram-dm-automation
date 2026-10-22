/**
 * The follow-up nudge's rules (`followup.ts`, DM plan §7, S9): who may be nudged, and when. Pure, so every row of the table is a person who
 * must (or must not) get a message they did not ask for.
 *
 * What is pinned, because each is a way a real person is chased who should not be, or a nudge is lost that should go:
 *
 *   - a reply, a click by a PERSON, a stop, a hand-off, a paused bot, a closed stage, a nudge already sent, a switched-off agent, sales mode
 *     off, and a test-mode sender who is not on the list each stop it;
 *   - a click by a link-preview crawler or a prefetch does NOT stop it (Meta's own crawler opens every link the moment it is sent);
 *   - it is never sent 23 hours or more after the person's last message (Meta's window is 24 h; one hour of margin), and never without a
 *     message of theirs on record;
 *   - the rules fire in an order that names the reason that matters (an opt-out is an opt-out even if they also replied);
 *   - the 23 hour clock is `windowEndsAt` (`ads/attribution.ts`): only a conversation that began from a click-to-message ad, on a platform whose
 *     `ads.extended_window` switch is on, may be nudged up to 7 days less an hour after the click; every other one keeps the 23 hours.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KIT_KEYS, KITS } from '../profile/kits.js';
import { utf8Bytes } from './text.js';
import {
    FOLLOWUP_MINUTES_DEFAULT, FOLLOWUP_MINUTES_MAX, FOLLOWUP_MINUTES_MIN, FOLLOWUP_REASONS, FOLLOWUP_WINDOW_MS, MAX_FOLLOWUPS_PER_CONVERSATION,
    followupDedupeKey, followupEligible, followupMinutesInput, followupRunAfter, parseFollowupMinutes,
    type FollowupReason, type FollowupRules, type FollowupState, type LinkClickFact,
} from './followup.js';

const NOW = new Date('2026-10-14T13:00:00Z');
const LINK_AT = new Date('2026-10-14T09:00:00Z');
const SENDER = '17841400000000001';

/** A conversation exactly as it is four hours after a link nobody has answered or opened: the one that gets the nudge. */
const BASE: FollowupState = {
    stage: 'link', senderId: SENDER, botActive: true, agentActive: true, followupsSent: 0,
    lastLinkAt: LINK_AT, lastInboundAt: new Date('2026-10-14T08:59:40Z'), optedOutAt: null, handoffAt: null,
};
const RULES: FollowupRules = { sales: { mode: 'on', testSenders: [] }, linkAt: LINK_AT, delayMinutes: 240 };

const at = (iso: string): Date => new Date(iso);
const person = (iso = '2026-10-14T10:00:00Z'): LinkClickFact => ({ clickedAt: at(iso), isPrefetch: false });
const crawler = (iso = '2026-10-14T09:00:01Z'): LinkClickFact => ({ clickedAt: at(iso), isPrefetch: true });

interface Row {
    name: string;
    state?: Partial<FollowupState>;
    clicks?: LinkClickFact[];
    rules?: Partial<FollowupRules>;
    now?: Date;
    reason: FollowupReason;
}

const TABLE: Row[] = [
    { name: 'a link nobody answered or opened, inside the window', reason: 'ok' },
    { name: 'the same with only link-preview fetches on record', clicks: [crawler(), crawler('2026-10-14T09:00:02Z'), crawler('2026-10-14T09:05:00Z')], reason: 'ok' },

    // The person acted.
    { name: 'replied since the link', state: { lastInboundAt: at('2026-10-14T09:30:00Z') }, reason: 'replied' },
    { name: 'replied a moment after the link', state: { lastInboundAt: at('2026-10-14T09:00:00.001Z') }, reason: 'replied' },
    { name: 'wrote in the same instant as the link (the turn\'s own stamp): not a reply', state: { lastInboundAt: LINK_AT }, reason: 'ok' },
    { name: 'clicked the link', clicks: [person()], reason: 'clicked' },
    { name: 'clicked, among crawler fetches', clicks: [crawler(), person(), crawler()], reason: 'clicked' },
    { name: 'opted out', state: { optedOutAt: at('2026-10-14T09:10:00Z') }, reason: 'opted_out' },

    // The thread's status.
    { name: 'handed off (handoff_at set)', state: { handoffAt: at('2026-10-14T09:10:00Z') }, reason: 'handoff' },
    { name: 'handed off (stage alone)', state: { stage: 'handoff' }, reason: 'handoff' },
    { name: 'a hand-off that happened before the link still counts: a person has had this conversation', state: { handoffAt: at('2026-10-13T09:00:00Z') }, reason: 'handoff' },
    { name: 'the AI is paused for this conversation', state: { botActive: false }, reason: 'paused' },
    { name: 'the owner\'s agent is switched off', state: { agentActive: false }, reason: 'agent_off' },
    { name: 'the nudge has already gone', state: { followupsSent: 1, stage: 'follow_up' }, reason: 'already_nudged' },
    { name: 'the nudge has already gone, and the stage is still link (a retry that read it in between)', state: { followupsSent: 1 }, reason: 'already_nudged' },
    { name: 'closed', state: { stage: 'closed' }, reason: 'stage' },
    { name: 'objecting again', state: { stage: 'objection' }, reason: 'stage' },
    { name: 'back at recommend', state: { stage: 'recommend' }, reason: 'stage' },
    { name: 'follow_up with no nudge counted (the stage alone is not a licence)', state: { stage: 'follow_up' }, reason: 'stage' },
    { name: 'a later link was sent: this job is for an older one', state: { lastLinkAt: at('2026-10-14T10:00:00Z') }, reason: 'newer_link' },
    { name: 'no link on record', state: { lastLinkAt: null }, reason: 'no_link' },

    // The window.
    { name: 'no message from them on record: the window cannot be shown to be open', state: { lastInboundAt: null }, reason: 'no_inbound' },
    { name: 'their last message was exactly 23 hours ago', state: { lastInboundAt: new Date(NOW.getTime() - FOLLOWUP_WINDOW_MS) }, reason: 'window_expired' },
    { name: 'their last message was a second inside 23 hours ago', state: { lastInboundAt: new Date(NOW.getTime() - FOLLOWUP_WINDOW_MS + 1000) }, reason: 'ok' },
    { name: 'their last message was 25 hours ago', state: { lastInboundAt: at('2026-10-13T12:00:00Z') }, reason: 'window_expired' },
    { name: 'the job ran late: now is 24 hours after the message', now: at('2026-10-15T08:59:40Z'), reason: 'window_expired' },

    // Who may be sold to.
    { name: 'sales mode off', rules: { sales: { mode: 'off', testSenders: [] } }, reason: 'sales_off' },
    { name: 'sales mode off, even for a listed sender', rules: { sales: { mode: 'off', testSenders: [SENDER] } }, reason: 'sales_off' },
    { name: 'test mode, a sender who is not on the list', rules: { sales: { mode: 'test', testSenders: ['17841400000000002'] } }, reason: 'sender_not_allowed' },
    { name: 'test mode, an empty list', rules: { sales: { mode: 'test', testSenders: [] } }, reason: 'sender_not_allowed' },
    { name: 'test mode, a sender whose id only CONTAINS a listed id', rules: { sales: { mode: 'test', testSenders: ['1784140000000000'] } }, reason: 'sender_not_allowed' },
    { name: 'test mode, a listed sender', rules: { sales: { mode: 'test', testSenders: ['17841400000000002', SENDER] } }, reason: 'ok' },
    { name: 'the operator turned follow-ups off (0 minutes)', rules: { delayMinutes: 0 }, reason: 'disabled' },
];

describe('followupEligible: the table', () => {
    for (const row of TABLE) {
        it(`${row.reason === 'ok' ? 'sends' : `does not send (${row.reason})`}: ${row.name}`, () => {
            const verdict = followupEligible({ ...BASE, ...row.state }, row.now ?? NOW, row.clicks ?? [], { ...RULES, ...row.rules });
            assert.equal(verdict.reason, row.reason);
            assert.equal(verdict.send, row.reason === 'ok');
        });
    }

    it('the table makes every reason the function has: a new rule cannot be added without a row', () => {
        assert.deepEqual([...new Set(TABLE.map((row) => row.reason))].sort(), [...FOLLOWUP_REASONS].sort());
    });
});

describe('followupEligible: a click only counts when a person made it', () => {
    it('a prefetch-only history is still eligible, however many fetches there are', () => {
        const fetches = Array.from({ length: 20 }, (_, i) => crawler(`2026-10-14T09:00:${String(i).padStart(2, '0')}Z`));
        assert.deepEqual(followupEligible(BASE, NOW, fetches, RULES), { send: true, reason: 'ok' });
    });

    it('one person\'s click is enough, wherever it sits in the list', () => {
        assert.equal(followupEligible(BASE, NOW, [person()], RULES).reason, 'clicked');
        assert.equal(followupEligible(BASE, NOW, [crawler(), crawler(), person()], RULES).reason, 'clicked');
    });

    it('no clicks at all is eligible', () => {
        assert.equal(followupEligible(BASE, NOW, [], RULES).reason, 'ok');
    });
});

describe('followupEligible: which reason is given when several apply', () => {
    it('sales mode off beats everything: nothing else is even asked', () => {
        const state = { optedOutAt: at('2026-10-14T09:10:00Z'), botActive: false, lastInboundAt: at('2026-10-14T09:30:00Z') };
        assert.equal(followupEligible({ ...BASE, ...state }, NOW, [person()], { ...RULES, sales: { mode: 'off', testSenders: [] } }).reason, 'sales_off');
    });

    it('an opt-out is an opt-out even when they also replied and clicked', () => {
        const state = { optedOutAt: at('2026-10-14T09:10:00Z'), lastInboundAt: at('2026-10-14T09:30:00Z'), stage: 'closed' as const };
        assert.equal(followupEligible({ ...BASE, ...state }, NOW, [person()], RULES).reason, 'opted_out');
    });

    it('a hand-off beats a paused bot (the hand-off pauses it)', () => {
        assert.equal(followupEligible({ ...BASE, stage: 'handoff', botActive: false, handoffAt: at('2026-10-14T09:10:00Z') }, NOW, [], RULES).reason, 'handoff');
    });

    it('a reply is reported before a click, and both before the clock', () => {
        const state = { lastInboundAt: at('2026-10-14T09:30:00Z') };
        assert.equal(followupEligible({ ...BASE, ...state }, NOW, [person()], RULES).reason, 'replied');
        assert.equal(followupEligible({ ...BASE, lastInboundAt: at('2026-10-13T09:00:00Z') }, NOW, [person()], RULES).reason, 'clicked');
    });
});

describe('followupEligible: the ad window (ads.extended_window)', () => {
    // A click on 2026-10-11 10:00Z; the person's first message came with it, and the link went out three days later (a person who came back).
    const CLICK = '2026-10-11T10:00:00Z';
    const DAY3 = at('2026-10-14T13:00:00Z');
    const AD_STATE: Partial<FollowupState> = {
        // Their last message is three days old: the default rule alone would have closed the window two days ago.
        lastInboundAt: at('2026-10-11T10:00:30Z'), lastLinkAt: at('2026-10-11T10:01:00Z'),
        entrySource: { kind: 'ctm', platform: 'instagram', at: CLICK },
    };
    const AD_RULES: Partial<FollowupRules> = { linkAt: at('2026-10-11T10:01:00Z'), extendedWindow: { instagram: true, messenger: false } };
    const verdict = (state: Partial<FollowupState>, rules: Partial<FollowupRules>, now: Date) =>
        followupEligible({ ...BASE, ...state }, now, [], { ...RULES, ...rules, linkAt: rules.linkAt ?? RULES.linkAt });

    it('a ctm conversation with its platform\'s switch on may be nudged on day 3', () => {
        assert.deepEqual(verdict(AD_STATE, AD_RULES, DAY3), { send: true, reason: 'ok' });
    });

    it('the same conversation with the switch off (or the rules silent about it) is past the 23 hour window', () => {
        assert.equal(verdict(AD_STATE, { ...AD_RULES, extendedWindow: { instagram: false, messenger: false } }, DAY3).reason, 'window_expired');
        assert.equal(verdict(AD_STATE, { ...AD_RULES, extendedWindow: undefined }, DAY3).reason, 'window_expired');
    });

    it('only the conversation\'s own platform counts: an Instagram ad with only the Messenger switch on is the 23 hour rule', () => {
        assert.equal(verdict(AD_STATE, { ...AD_RULES, extendedWindow: { instagram: false, messenger: true } }, DAY3).reason, 'window_expired');
        const messenger = { ...AD_STATE, entrySource: { kind: 'ctm' as const, platform: 'messenger' as const, at: CLICK } };
        assert.equal(verdict(messenger, { ...AD_RULES, extendedWindow: { instagram: false, messenger: true } }, DAY3).reason, 'ok');
    });

    it('a conversation that did not begin from an ad never gets more than 23 hours, whatever the switches say', () => {
        const all = { ...AD_RULES, extendedWindow: { instagram: true, messenger: true } };
        assert.equal(verdict({ ...AD_STATE, entrySource: null }, all, DAY3).reason, 'window_expired');
        assert.equal(verdict({ ...AD_STATE, entrySource: undefined }, all, DAY3).reason, 'window_expired');
        for (const kind of ['link', 'qr', 'ctwa', 'ig_bridge', 'ice_breaker', 'organic'] as const) {
            assert.equal(verdict({ ...AD_STATE, entrySource: { kind, platform: 'instagram', at: CLICK } }, all, DAY3).reason, 'window_expired', kind);
        }
    });

    it('the extended window closes at the click plus 7 days less an hour, to the millisecond', () => {
        const closes = Date.parse(CLICK) + 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
        assert.equal(verdict(AD_STATE, AD_RULES, new Date(closes - 1)).reason, 'ok');
        assert.equal(verdict(AD_STATE, AD_RULES, new Date(closes)).reason, 'window_expired');
        assert.equal(verdict(AD_STATE, AD_RULES, at('2026-10-18T13:00:00Z')).reason, 'window_expired');
    });

    it('a person who wrote late keeps their own 23 hours when that is the later end', () => {
        const state = { ...AD_STATE, lastInboundAt: at('2026-10-18T09:00:00Z'), lastLinkAt: at('2026-10-18T09:00:00Z') };
        const rules = { ...AD_RULES, linkAt: at('2026-10-18T09:00:00Z') };
        assert.equal(verdict(state, rules, at('2026-10-19T07:59:59Z')).reason, 'ok');
        assert.equal(verdict(state, rules, at('2026-10-19T08:00:00Z')).reason, 'window_expired');
    });

    it('a ctm conversation whose click time is unreadable falls back to 23 hours from their last message', () => {
        const state = { ...AD_STATE, entrySource: { kind: 'ctm' as const, platform: 'instagram' as const, at: 'not a date' } };
        assert.equal(verdict(state, AD_RULES, DAY3).reason, 'window_expired');
    });

    it('the switch widens only the clock: every other rule still stops an ad conversation', () => {
        assert.equal(verdict({ ...AD_STATE, optedOutAt: at('2026-10-12T09:00:00Z') }, AD_RULES, DAY3).reason, 'opted_out');
        assert.equal(verdict({ ...AD_STATE, botActive: false }, AD_RULES, DAY3).reason, 'paused');
        assert.equal(verdict({ ...AD_STATE, lastInboundAt: at('2026-10-12T09:00:00Z') }, AD_RULES, DAY3).reason, 'replied');
    });
});

describe('followupEligible: it decides, it changes nothing', () => {
    it('does not touch its arguments, and gives the same answer twice', () => {
        const state = Object.freeze({ ...BASE });
        const clicks = Object.freeze([Object.freeze(crawler())]);
        const rules = Object.freeze({ ...RULES, sales: Object.freeze({ mode: 'on' as const, testSenders: Object.freeze([]) as unknown as string[] }) });
        const first = followupEligible(state, NOW, clicks, rules);
        assert.deepEqual(followupEligible(state, NOW, clicks, rules), first);
        assert.equal(NOW.toISOString(), '2026-10-14T13:00:00.000Z');
    });

    it('one nudge per conversation, ever, and the window is 23 hours', () => {
        assert.equal(MAX_FOLLOWUPS_PER_CONVERSATION, 1);
        assert.equal(FOLLOWUP_WINDOW_MS, 23 * 60 * 60 * 1000);
    });
});

describe('the delay setting', () => {
    it('is four hours by default, 0 to 22 hours', () => {
        assert.equal(FOLLOWUP_MINUTES_DEFAULT, 240);
        assert.equal(FOLLOWUP_MINUTES_MIN, 0);
        assert.equal(FOLLOWUP_MINUTES_MAX, 1320);
        assert.ok(FOLLOWUP_MINUTES_MAX * 60_000 < FOLLOWUP_WINDOW_MS, 'the longest delay still falls inside the 23 hour rule');
    });

    it('reads a whole number of minutes in range, from text or a number', () => {
        for (const [raw, want] of [['240', 240], [' 10 ', 10], [10, 10], ['0', 0], [0, 0], ['1320', 1320], ['007', 7]] as const) {
            assert.equal(parseFollowupMinutes(raw), want, JSON.stringify(raw));
        }
    });

    it('reads nothing else: a typo must not save a different delay', () => {
        for (const raw of ['', ' ', 'abc', '4h', '-5', '1321', '99999', '4.5', 4.5, -1, 1321, NaN, Infinity, null, undefined, {}, [], true, '1e3', '0x10']) {
            assert.equal(parseFollowupMinutes(raw), null, JSON.stringify(raw) ?? String(raw));
        }
    });

    it('the settings route reads empty as "go back to the default", a number as itself, and anything else as an error that names the range', () => {
        assert.deepEqual(followupMinutesInput(null), { minutes: null });
        assert.deepEqual(followupMinutesInput(undefined), { minutes: null });
        assert.deepEqual(followupMinutesInput('  '), { minutes: null });
        assert.deepEqual(followupMinutesInput(''), { minutes: null });
        assert.deepEqual(followupMinutesInput(45), { minutes: 45 });
        assert.deepEqual(followupMinutesInput('0'), { minutes: 0 });
        for (const bad of ['soon', 1321, -1, 2.5, '4 hours']) {
            const result = followupMinutesInput(bad);
            assert.ok('error' in result, JSON.stringify(bad));
            assert.match(result.error, /whole number of minutes, 0 to 1320/);
        }
    });
});

describe('when the nudge is due, and the key that makes it one per link', () => {
    it('is the link time plus the delay', () => {
        assert.equal(followupRunAfter(LINK_AT, 240).toISOString(), '2026-10-14T13:00:00.000Z');
        assert.equal(followupRunAfter(LINK_AT, 10).toISOString(), '2026-10-14T09:10:00.000Z');
        assert.equal(followupRunAfter(LINK_AT, 0).toISOString(), LINK_AT.toISOString());
    });

    it('is keyed on the conversation and the message that held the link', () => {
        assert.equal(followupDedupeKey('conv-1', 'msg-9'), 'dm-followup:conv-1:msg-9');
        assert.notEqual(followupDedupeKey('conv-1', 'msg-9'), followupDedupeKey('conv-1', 'msg-10'), 'two links, two keys');
        assert.notEqual(followupDedupeKey('conv-1', 'msg-9'), followupDedupeKey('conv-2', 'msg-9'), 'two conversations, two keys');
        assert.equal(followupDedupeKey('conv-1', 'msg-9'), followupDedupeKey('conv-1', 'msg-9'), 'the same link, the same key');
    });
});

describe('the nudge line: short, no pressure, no link', () => {
    for (const key of KIT_KEYS) {
        it(`${key}: one short line that offers help, holds no link, no number and no urgency, and fits Meta's text limit with room to spare`, () => {
            const line = KITS[key].sales.lines.nudge;
            assert.ok(line.trim().length > 0);
            assert.ok(utf8Bytes(line) <= 200, `${utf8Bytes(line)} bytes`);
            assert.ok(!/\n/.test(line), 'one line');
            assert.ok(!/https?:|www\.|\/r\//i.test(line), 'a nudge carries no new link: the one they have is above it');
            assert.ok(!/[0-9٠-٩]/.test(line), 'no number, so no price or date to be wrong');
            assert.ok(!/last chance|hurry|now or never|آخر فرصة|لا تفوّت|لا تفوت|بسرعة|عاجل|فوراً|فورا/i.test(line), 'no urgency');
            assert.ok(!/[!！]{2,}/.test(line));
        });
    }
});
