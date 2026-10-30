/**
 * The vocabulary of perception (`types.ts`): the kinds it reads, the reasons it gives, and the record it keeps. These lists are what the gate, the download, the
 * text helpers and (later) the stored `messages.perception` all draw on, so they are pinned here once, against the lists they must agree with.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WORDLESS_KINDS } from '../../webhook/attachments.js';
import type { GateReason } from './gate.js';
import type { MediaResult } from './media.js';
import {
    ABOUT_OWNER, capabilityOfKind, FAIL_REASONS, isPerceivableKind, MIN_CONFIDENCE, PERCEIVABLE_KINDS, PERCEPTION_STATUSES, SKIP_REASONS, UNREADABLE_REASONS,
    type FailReason, type Perception, type SkipReason,
} from './types.js';

describe('the kinds perception reads', () => {
    it('are the eight the data model lists, every one a kind the pipeline stores', () => {
        assert.deepEqual([...PERCEIVABLE_KINDS], ['reel', 'share', 'story_reply', 'story_share', 'story_mention', 'image', 'video', 'audio']);
        for (const kind of PERCEIVABLE_KINDS) assert.ok((WORDLESS_KINDS as readonly string[]).includes(kind), kind);
    });

    it('leave out what keeps today\'s behaviour: a file, a sticker, a view-once or an unsupported message', () => {
        for (const kind of ['file', 'sticker', 'attachment']) assert.equal(isPerceivableKind(kind), false, kind);
        assert.deepEqual(WORDLESS_KINDS.filter((k) => !isPerceivableKind(k)), ['file', 'sticker', 'attachment']);
    });

    it('are recognised only as the exact string', () => {
        for (const v of ['Reel', ' reel', 'reel ', '', null, undefined, 3, {}, ['reel']]) assert.equal(isPerceivableKind(v), false, String(v));
        assert.equal(isPerceivableKind('reel'), true);
    });
});

describe('capabilityOfKind', () => {
    it('is `voice` for a voice note and `dm_media` for every other kind perception reads', () => {
        assert.equal(capabilityOfKind('audio'), 'voice');
        for (const kind of PERCEIVABLE_KINDS.filter((k) => k !== 'audio')) assert.equal(capabilityOfKind(kind), 'dm_media', kind);
    });

    it('is null for a kind it does not read, and for anything that is not a kind', () => {
        for (const v of ['sticker', 'file', 'attachment', 'text', '', null, undefined, 4]) assert.equal(capabilityOfKind(v), null, String(v));
    });
});

describe('the reasons perception gives, as the data model lists them', () => {
    it('skipped: the gate\'s five, the pipeline\'s sales_off, and the download\'s no_url', () => {
        assert.deepEqual([...SKIP_REASONS], ['switch_off', 'not_allowed_sender', 'sales_off', 'budget', 'unsupported_kind', 'no_key', 'no_url']);
    });

    it('failed and unreadable', () => {
        assert.deepEqual([...FAIL_REASONS], ['too_large', 'fetch_failed', 'expired_url', 'provider_error', 'timeout']);
        assert.deepEqual([...UNREADABLE_REASONS], ['low_confidence', 'empty_transcript']);
    });

    it('every reason the gate and the download can give is one of them (a value that is not in the lists does not compile)', () => {
        const gate: readonly GateReason[] = ['switch_off', 'not_allowed_sender', 'budget', 'unsupported_kind', 'no_key'];
        const asSkips: readonly SkipReason[] = gate;
        for (const reason of asSkips) assert.ok((SKIP_REASONS as readonly string[]).includes(reason), reason);

        const download: readonly Extract<MediaResult, { status: 'failed' }>['reason'][] = ['too_large', 'fetch_failed', 'expired_url', 'timeout'];
        const asFails: readonly FailReason[] = download;
        for (const reason of asFails) assert.ok((FAIL_REASONS as readonly string[]).includes(reason), reason);
    });

    it('a status, whose owner and confidence floor are the contract\'s', () => {
        assert.deepEqual([...PERCEPTION_STATUSES], ['ok', 'unreadable', 'skipped', 'failed']);
        assert.deepEqual([...ABOUT_OWNER], ['own_content', 'other_content', 'personal', 'unclear']);
        assert.equal(MIN_CONFIDENCE, 0.6);
    });
});

describe('the record kept on a message', () => {
    it('is what the data model names: a version, a kind, a status, what was seen, and what it cost', () => {
        const ok: Perception = {
            v: 1, kind: 'reel', status: 'ok', seen: 'A reel about building a backend.', transcript: 'Today we build an API', about_owner: 'own_content', confidence: 0.92,
            recall: { reel_id: 'r1', permalink: 'https://www.instagram.com/reel/ABC/', second: 13 },
            model: 'muse-spark-1.3', stored_at: '2026-11-01T09:30:00.000Z', ms: 20_400, usd: 0.021,
        };
        const story: Perception = { v: 1, kind: 'story_mention', status: 'ok', seen: 'A sunset.', mention_summary: 'a sunset over the sea', model: 'muse-spark-1.3', stored_at: '2026-11-01T09:30:00.000Z', ms: 3_100, usd: 0.005 };
        const skipped: Perception = { v: 1, kind: 'image', status: 'skipped', reason: 'budget', model: '', stored_at: '2026-11-01T09:30:00.000Z', ms: 0, usd: 0 };
        const unreadable: Perception = { v: 1, kind: 'audio', status: 'unreadable', reason: 'empty_transcript', model: 'muse-voice-transcribe-1.0', stored_at: '2026-11-01T09:30:00.000Z', ms: 2_900, usd: 0.001 };
        // It is stored as JSON: what comes back out is what went in.
        for (const p of [ok, story, skipped, unreadable]) assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
    });
});
