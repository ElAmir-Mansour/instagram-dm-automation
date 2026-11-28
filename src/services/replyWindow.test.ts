/**
 * The one rule for when a reply typed in the inbox can still reach the customer (R1-I1): `replyWindowEndsAt` / `replyWindowClosed`.
 *
 * A manual send is `messaging_type: RESPONSE` with no message tag (`sendDirectMessage`), so the window is Meta's standard 24 hours from the
 * customer's last message, and an ad conversation's longer window only where the owner switched `ads.extended_window` on for that platform.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AD_WINDOW_MS } from './ads/attribution.js';
import { lastInboundOf, replyWindowClosed, replyWindowEndsAt } from './replyWindow.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-11-28T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const OFF = { instagram: false, messenger: false };
const ON = { instagram: true, messenger: true };
const ctm = (platform: 'instagram' | 'messenger', clickedAgo: number) => ({ kind: 'ctm', platform, at: ago(clickedAgo).toISOString() });

describe('replyWindowEndsAt', () => {
    it('is 24 hours from the customer\'s last message (not the assistant\'s 23: a person typing gets no safety margin)', () => {
        assert.equal(replyWindowEndsAt({ lastInboundAt: ago(2 * HOUR) })!.toISOString(), new Date(NOW.getTime() + 22 * HOUR).toISOString());
    });

    it('is null when the customer has not written: an unknown window is never a reason to refuse', () => {
        assert.equal(replyWindowEndsAt({ lastInboundAt: null }), null);
        assert.equal(replyWindowEndsAt({ lastInboundAt: new Date('nope') }), null);
        assert.deepEqual(replyWindowClosed({ lastInboundAt: null }, NOW), { closed: false });
    });

    it('is the later of 24 h and the click + 7 d - 1 h for an ad conversation, only with the platform\'s switch on', () => {
        const last = ago(30 * HOUR);
        const click = ctm('instagram', 2 * DAY);
        const expected = new Date(ago(2 * DAY).getTime() + AD_WINDOW_MS).toISOString();
        assert.equal(replyWindowEndsAt({ lastInboundAt: last, entrySource: click, extendedWindow: ON })!.toISOString(), expected);
        assert.equal(replyWindowEndsAt({ lastInboundAt: last, entrySource: click, extendedWindow: { instagram: true, messenger: false } })!.toISOString(), expected);
        // Off (or the other platform's switch): 24 h from the last message, however fresh the click.
        const standard = new Date(last.getTime() + DAY).toISOString();
        assert.equal(replyWindowEndsAt({ lastInboundAt: last, entrySource: click, extendedWindow: OFF })!.toISOString(), standard);
        assert.equal(replyWindowEndsAt({ lastInboundAt: last, entrySource: click, extendedWindow: { instagram: false, messenger: true } })!.toISOString(), standard);
        assert.equal(replyWindowEndsAt({ lastInboundAt: last, entrySource: click })!.toISOString(), standard, 'no switches read: standard');
    });

    it('never shortens the standard window: a click older than 7 days leaves the 24 hours from the last message', () => {
        const last = ago(HOUR);
        const old = ctm('messenger', 9 * DAY);
        assert.equal(replyWindowEndsAt({ lastInboundAt: last, entrySource: old, extendedWindow: ON })!.toISOString(), new Date(last.getTime() + DAY).toISOString());
    });

    it('ignores an entry that is not a click-to-message ad, or whose click time or platform is unusable', () => {
        const last = ago(30 * HOUR);
        const standard = new Date(last.getTime() + DAY).toISOString();
        for (const entrySource of [
            { kind: 'ctwa', platform: 'instagram', at: ago(HOUR).toISOString() },
            { kind: 'link', ref: 'x', at: ago(HOUR).toISOString() },
            { kind: 'ctm', platform: 'whatsapp', at: ago(HOUR).toISOString() },
            { kind: 'ctm', platform: 'instagram', at: 'yesterday' },
            { kind: 'ctm', platform: 'instagram' },
            null,
        ]) {
            assert.equal(replyWindowEndsAt({ lastInboundAt: last, entrySource, extendedWindow: ON })!.toISOString(), standard, JSON.stringify(entrySource));
        }
    });
});

describe('replyWindowClosed', () => {
    it('is closed from the instant the window ends, with that instant as closedAt', () => {
        const last = ago(24 * HOUR);
        assert.deepEqual(replyWindowClosed({ lastInboundAt: last }, NOW), { closed: true, closedAt: NOW });
        assert.deepEqual(replyWindowClosed({ lastInboundAt: ago(24 * HOUR - 1) }, NOW), { closed: false });
        const result = replyWindowClosed({ lastInboundAt: ago(44 * DAY) }, NOW);
        assert.equal(result.closed, true);
    });

    it('is open for an ad conversation inside its longer window, and closed past it', () => {
        const open = replyWindowClosed({ lastInboundAt: ago(3 * DAY), entrySource: ctm('instagram', 3 * DAY), extendedWindow: ON }, NOW);
        assert.deepEqual(open, { closed: false });
        const shut = replyWindowClosed({ lastInboundAt: ago(8 * DAY), entrySource: ctm('instagram', 8 * DAY), extendedWindow: ON }, NOW);
        assert.equal(shut.closed, true);
    });
});

describe('lastInboundOf', () => {
    it('reads the newest inbound message, falling back to the v39 stamp, as the list does', () => {
        const a = '2026-11-28T10:00:00.000Z';
        const b = '2026-11-20T10:00:00.000Z';
        assert.equal(lastInboundOf({ last_inbound_message_at: a, last_inbound_at: b })!.toISOString(), a);
        assert.equal(lastInboundOf({ last_inbound_message_at: null, last_inbound_at: new Date(b) })!.toISOString(), b);
        assert.equal(lastInboundOf({ last_inbound_message_at: undefined, last_inbound_at: undefined }), null);
    });
});
