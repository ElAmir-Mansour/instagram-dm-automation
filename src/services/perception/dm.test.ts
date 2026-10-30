/**
 * The read step of a DM (`dm.ts`), with every part handed in so what is pinned is the ORDER and what each refusal leaves behind:
 *
 *   a retry reuses the stored record → the gate → typing → what to show → Muse → stored once.
 *
 * What each order protects: nothing is downloaded, asked of Meta or written for a tenant whose switch is off or a sender who is not allowed; "typing…" is only shown
 * when someone really is working on it; a retry never pays twice; and what is stored says honestly how the media was looked at.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { perceiveDm, primaryRef, storyReplyRef, type PerceiveDmDeps, type PerceiveDmInput } from './dm.js';
import { mediaRefsOf, type DownloadedMedia, type MediaRef } from './media.js';
import { STEP_BUDGET_MS, type PerceiveResult } from './perceive.js';
import type { Source } from './source.js';
import type { Perception } from './types.js';

setLogSink(() => {});

// ─── Which thing to read ────────────────────────────────────────────────────────────────────

describe('primaryRef: the one thing in an event that Muse reads', () => {
    const attachment = (type: string, payload: Record<string, unknown> = { url: 'https://lookaside.fbsbx.com/x' }) => ({ type, payload });

    it('is the first thing the customer SENT: a photo, a video, a shared reel or post, a shared story, a story mention', () => {
        for (const [type, kind] of [['image', 'image'], ['video', 'video'], ['ig_reel', 'reel'], ['ig_post', 'share'], ['story', 'story_share'], ['story_mention', 'story_mention']] as const) {
            assert.equal(primaryRef({ attachments: [attachment(type)] })?.kind, kind, type);
        }
    });

    it('what they sent comes before the story a reply answers: a photo sent in reply to a story is the photo', () => {
        const ref = primaryRef({ reply_to: { story: { url: 'https://lookaside.fbsbx.com/s', id: '1' } }, attachments: [attachment('image')] });
        assert.equal(ref?.kind, 'image');
        assert.equal(primaryRef({ reply_to: { story: { url: 'https://lookaside.fbsbx.com/s', id: '1' } } })?.kind, 'story_reply');
    });

    it('is null for what Muse does not read: a voice note (another phase), a sticker, a file, a view-once, an unsupported message, and no attachment at all', () => {
        const none: unknown[] = [
            { attachments: [attachment('audio')] },
            { attachments: [attachment('sticker', { url: 'https://x/s.png', sticker_id: 1 })] },
            { attachments: [attachment('image', { url: 'https://x/s.png', sticker_id: 369239263222822 })] },
            { attachments: [attachment('file')] },
            { attachments: [{ type: 'ephemeral' }] },
            { is_unsupported: true },
            {}, null, undefined, 'text',
        ];
        for (const message of none) assert.equal(primaryRef(message), null, JSON.stringify(message));
    });

    it('skips a voice note that comes with a photo and reads the photo', () => {
        assert.equal(primaryRef({ attachments: [attachment('audio'), attachment('image')] })?.kind, 'image');
    });

    it('storyReplyRef is the story a message answers, or null', () => {
        assert.equal(storyReplyRef({ text: 'hi', reply_to: { story: { url: 'https://lookaside.fbsbx.com/s', id: '1' } } })?.kind, 'story_reply');
        assert.equal(storyReplyRef({ text: 'hi' }), null);
        assert.equal(storyReplyRef({ text: 'hi', reply_to: { mid: 'm' } }), null);
        assert.equal(storyReplyRef(undefined), null);
    });
});

// ─── The step ───────────────────────────────────────────────────────────────────────────────

const REF: MediaRef = mediaRefsOf({ attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/x' } }] })[0]!;
const MEDIA: DownloadedMedia = { mediaKind: 'image', mime: 'image/jpeg', bytes: Buffer.from('jpegbytes'), host: 'lookaside.fbsbx.com', ms: 80 };
const VIDEO: DownloadedMedia = { mediaKind: 'video', mime: 'video/mp4', bytes: Buffer.from('mp4bytes'), host: 'scontent.fna.fbcdn.net', ms: 200 };
const STORED_AT = '2026-10-30T10:00:20.000000+00:00';

const input = (over: Partial<PerceiveDmInput> = {}): PerceiveDmInput => ({
    creator: { id: 'creator-1', page_access_token: 'EAAGplaintext', instagram_page_id: 'ig-page-1' }, pageId: undefined, senderId: 'user-1', messageId: 'msg-1',
    ref: REF, typed: false, resumed: false, language: 'English', handle: '@sami.fit', ...over,
});

interface Probe {
    calls: string[];
    gated: any[];
    stored: any[];
    resolved: { ref: MediaRef; ctx: any }[];
    perceived: any[];
    troubles: { creatorId: string; kind: string }[];
    deps: PerceiveDmDeps;
}

/** Every part handed in, recording the order it was used in. A part a test does not arrange fails it. */
function probe(world: {
    gate?: { ok: true } | { ok: false; reason: 'switch_off' | 'not_allowed_sender' | 'budget' | 'no_key' | 'unsupported_kind' };
    stored?: Perception | null;
    storeResult?: 'echo' | 'conflict' | 'gone';
    source?: Source;
    perception?: PerceiveResult;
} = {}): Probe {
    const calls: string[] = [];
    const gated: any[] = [];
    const stored: any[] = [];
    const resolved: Probe['resolved'] = [];
    const perceived: any[] = [];
    const troubles: Probe['troubles'] = [];
    let clock = 1_000_000;
    const deps: PerceiveDmDeps = {
        now: () => clock,
        gate: async (args) => { calls.push('gate'); gated.push(args); return world.gate ?? { ok: true }; },
        readStored: async () => { calls.push('readStored'); return world.stored ?? null; },
        store: async (s) => {
            calls.push('store'); stored.push(s);
            if (world.storeResult === 'conflict') return null;
            return { ...s.perception, stored_at: STORED_AT } as Perception;
        },
        typing: async () => { calls.push('typing'); },
        resolve: async (ref, ctx) => { calls.push('resolve'); resolved.push({ ref, ctx }); clock += 1_000; return world.source ?? { source: 'media', how: 'media', media: MEDIA, caption: null, owner: 'unknown' }; },
        perceive: async (args) => {
            calls.push('perceive'); perceived.push(args); clock += 3_000;
            return world.perception ?? { perception: { v: 1, kind: args.kind, status: 'ok', seen: 'A price list.', about_owner: 'unclear', confidence: 0.9, model: 'muse-spark-1.3', ms: 3000, usd: 0.005 } };
        },
        onProviderTrouble: async (creatorId, kind) => { calls.push('trouble'); troubles.push({ creatorId, kind }); },
    };
    return { calls, gated, stored, resolved, perceived, troubles, deps };
}

const stored = (p: Probe): Record<string, any> => p.stored[0]!.perception;

describe('perceiveDm: the order, and what each refusal leaves behind', () => {
    it('gate, typing, what to show, Muse, the record: in that order, and nothing else is used', async () => {
        const p = probe();
        const out = await perceiveDm(input(), p.deps);

        assert.deepEqual(p.calls, ['gate', 'typing', 'resolve', 'perceive', 'store']);
        assert.equal(out.kind, 'read');
        assert.ok(out.kind === 'read');
        assert.equal(out.reused, false);
        assert.equal(out.perception.status, 'ok');
        assert.equal(out.perception.stored_at, STORED_AT);
    });

    it('asks the gate for this tenant, this sender and this kind, for the dm_media capability', async () => {
        const p = probe();
        await perceiveDm(input(), p.deps);
        assert.deepEqual(p.gated, [{ creatorId: 'creator-1', senderId: 'user-1', kind: 'image', capability: 'dm_media' }]);
    });

    it('a switch that is off or a sender who is not allowed leaves NOTHING behind: no typing, no download, no model, no write', async () => {
        for (const reason of ['switch_off', 'not_allowed_sender', 'unsupported_kind'] as const) {
            const p = probe({ gate: { ok: false, reason } });
            const out = await perceiveDm(input(), p.deps);
            assert.deepEqual(out, { kind: 'declined', reason }, reason);
            assert.deepEqual(p.calls, ['gate'], reason);
        }
    });

    it('the day\'s cap and a missing key are written to the row, because the owner switched this on: no typing, no download, no model', async () => {
        for (const reason of ['budget', 'no_key'] as const) {
            const p = probe({ gate: { ok: false, reason } });
            const out = await perceiveDm(input(), p.deps);
            assert.deepEqual(p.calls, ['gate', 'store'], reason);
            assert.ok(out.kind === 'read');
            assert.deepEqual([out.perception.status, out.perception.reason], ['skipped', reason]);
            assert.equal(p.stored[0].text, null, 'the row\'s text stays the placeholder');
            assert.equal(p.stored[0].messageId, 'msg-1');
            assert.equal(p.stored[0].creatorId, 'creator-1');
        }
    });

    it('a retry reuses what an earlier attempt stored, and does not even ask the gate', async () => {
        const earlier: Perception = { v: 1, kind: 'image', status: 'ok', seen: 'A price list.', model: 'muse-spark-1.3', stored_at: STORED_AT, ms: 3000, usd: 0.005 };
        const p = probe({ stored: earlier });
        const out = await perceiveDm(input({ resumed: true }), p.deps);

        assert.deepEqual(p.calls, ['readStored']);
        assert.deepEqual(out, { kind: 'read', perception: earlier, reused: true });
    });

    it('a retry that finds nothing stored does the work', async () => {
        const p = probe({ stored: null });
        const out = await perceiveDm(input({ resumed: true }), p.deps);
        assert.deepEqual(p.calls, ['readStored', 'gate', 'typing', 'resolve', 'perceive', 'store']);
        assert.ok(out.kind === 'read' && !out.reused);
    });

    it('a first attempt never looks for a stored record: there cannot be one', async () => {
        const p = probe();
        await perceiveDm(input({ resumed: false }), p.deps);
        assert.ok(!p.calls.includes('readStored'));
    });

    it('is stored ONCE; when the row already has a record the one that is there is used, not ours', async () => {
        const theirs: Perception = { v: 1, kind: 'image', status: 'ok', seen: 'Their description.', model: 'x', stored_at: STORED_AT, ms: 1, usd: 0 };
        const p = probe({ storeResult: 'conflict', stored: theirs });
        const out = await perceiveDm(input(), p.deps);
        assert.deepEqual(p.calls, ['gate', 'typing', 'resolve', 'perceive', 'store', 'readStored']);
        assert.ok(out.kind === 'read');
        assert.equal(out.perception.seen, 'Their description.');
    });

    it('a row that took neither (it was deleted in between) still returns what was understood', async () => {
        const p = probe({ storeResult: 'conflict', stored: null });
        const out = await perceiveDm(input(), p.deps);
        assert.ok(out.kind === 'read');
        assert.equal(out.perception.seen, 'A price list.');
        assert.ok(!Number.isNaN(Date.parse(out.perception.stored_at)));
    });
});

describe('perceiveDm: what is shown, and what is stored', () => {
    it('shows Muse the downloaded media as base64 with its type, the account\'s own handle cleaned, the language, and one 90-second step', async () => {
        const p = probe({ source: { source: 'media', how: 'media', media: VIDEO, caption: 'A caption', owner: 'unknown' } });
        await perceiveDm(input(), p.deps);

        const call = p.perceived[0];
        assert.deepEqual(call.media, { kind: 'video', mime: 'video/mp4', base64: Buffer.from('mp4bytes').toString('base64') });
        assert.equal(call.handle, 'sami.fit');
        assert.equal(call.language, 'English');
        assert.equal(call.caption, 'A caption');
        assert.equal(call.coverOnly, false);
        assert.equal(call.typed, false);
        assert.equal(call.creatorId, 'creator-1');
        assert.equal(call.kind, 'image');
        assert.equal(call.deadlineAt, 1_000_000 + STEP_BUDGET_MS, 'the step\'s clock starts when the gate has passed');
        assert.equal(p.resolved[0]!.ctx.deadlineAt, 1_000_000 + STEP_BUDGET_MS, 'and the download is within the same one');
        assert.deepEqual({ ...p.resolved[0]!.ctx, deadlineAt: 0 }, { creatorId: 'creator-1', igAccountId: 'ig-page-1', pageToken: 'EAAGplaintext', deadlineAt: 0 });
    });

    it('a cover is said to be only a cover, and a handle that is not one is left out', async () => {
        const p = probe({ source: { source: 'media', how: 'cover', media: MEDIA, caption: null, owner: 'other' } });
        await perceiveDm(input({ handle: 'not a handle!' }), p.deps);
        assert.equal(p.perceived[0].coverOnly, true);
        assert.equal(p.perceived[0].handle, null);
    });

    it('says how it was looked at in front of the description, and whose it is from what the code knows, not what the model guessed', async () => {
        const p = probe({ source: { source: 'media', how: 'watched', media: VIDEO, caption: 'cap', owner: 'own' } });
        await perceiveDm(input({ ref: { ...REF, kind: 'reel' } }), p.deps);
        assert.equal(stored(p).seen, 'Watched the reel. A price list.');
        assert.equal(stored(p).about_owner, 'own_content');
        assert.equal(p.stored[0].text, '[shared reel] Watched the reel. A price list.');
    });

    it('a cover with no caption is only a cover; a photo needs no prefix; an owner the code cannot tell leaves the model\'s say', async () => {
        const cover = probe({ source: { source: 'media', how: 'cover', media: MEDIA, caption: null, owner: 'unknown' } });
        await perceiveDm(input(), cover.deps);
        assert.equal(stored(cover).seen, 'Saw the cover. A price list.');
        assert.equal(stored(cover).about_owner, 'unclear');

        const plain = probe();
        await perceiveDm(input(), plain.deps);
        assert.equal(stored(plain).seen, 'A price list.');
    });

    it('a personal document is neither prefixed nor re-owned: all that is stored is "a personal document"', async () => {
        const personal: Perception = { v: 1, kind: 'image', status: 'ok', seen: 'a personal document', about_owner: 'personal', confidence: 0.9, model: 'm', stored_at: STORED_AT, ms: 1, usd: 0 };
        const { stored_at: _ignored, ...draft } = personal;
        const p = probe({ source: { source: 'media', how: 'cover', media: MEDIA, caption: 'cap', owner: 'own' }, perception: { perception: draft } });
        await perceiveDm(input(), p.deps);
        assert.equal(stored(p).seen, 'a personal document');
        assert.equal(stored(p).about_owner, 'personal');
        assert.equal(p.stored[0].text, '[photo] a personal document');
    });

    it('what Muse could not read is stored without a description and leaves the row\'s text alone', async () => {
        const p = probe({ perception: { perception: { v: 1, kind: 'image', status: 'unreadable', reason: 'low_confidence', about_owner: 'unclear', confidence: 0.3, model: 'm', ms: 1, usd: 0.005 } } });
        await perceiveDm(input(), p.deps);
        assert.equal(stored(p).status, 'unreadable');
        assert.equal(p.stored[0].text, null);
    });

    it('the library\'s notes and a caption are stored with no model asked and no typing skipped', async () => {
        const ready: Source = { source: 'ready', how: 'library', perception: { v: 1, kind: 'reel', status: 'ok', seen: 'Watched the reel earlier (the library\'s notes on it). A reel.', about_owner: 'own_content', model: 'muse-spark-1.3', ms: 0, usd: 0 } };
        const p = probe({ source: ready });
        await perceiveDm(input({ ref: { ...REF, kind: 'reel' } }), p.deps);
        assert.deepEqual(p.calls, ['gate', 'typing', 'resolve', 'store'], 'no model for it');
        assert.equal(p.stored[0].text, '[shared reel] Watched the reel earlier (the library\'s notes on it). A reel.');
    });

    it('nothing to show is a failed or skipped record with its reason, and no model is asked', async () => {
        const failed = probe({ source: { source: 'nothing', status: 'failed', reason: 'expired_url' } });
        await perceiveDm(input(), failed.deps);
        assert.deepEqual(failed.calls, ['gate', 'typing', 'resolve', 'store']);
        assert.deepEqual([stored(failed).status, stored(failed).reason, stored(failed).model, stored(failed).usd], ['failed', 'expired_url', '', 0]);
        assert.equal(failed.stored[0].text, null);

        const skipped = probe({ source: { source: 'nothing', status: 'skipped', reason: 'no_url' } });
        await perceiveDm(input(), skipped.deps);
        assert.deepEqual([stored(skipped).status, stored(skipped).reason], ['skipped', 'no_url']);
    });

    it('words they typed with it (a reply to a story) keep the row\'s text, whatever was read, and tell Muse there are some', async () => {
        const p = probe();
        await perceiveDm(input({ typed: true }), p.deps);
        assert.equal(p.stored[0].text, null, 'the typed words stay what the row says');
        assert.equal(p.perceived[0].typed, true);
        assert.equal(stored(p).status, 'ok', 'but what was read is stored');
    });
});

describe('perceiveDm: when the provider is in trouble', () => {
    it('a refused key or an account with no credit tells the owner (once a day, by the hook\'s own claim); any other failure does not', async () => {
        for (const kind of ['auth', 'quota'] as const) {
            const p = probe({ perception: { perception: { v: 1, kind: 'image', status: 'failed', reason: 'provider_error', model: '', ms: 1, usd: 0 }, errorKind: kind } });
            await perceiveDm(input(), p.deps);
            assert.deepEqual(p.troubles, [{ creatorId: 'creator-1', kind }], kind);
        }
        for (const kind of ['rate', 'server', 'timeout', 'max_tokens'] as const) {
            const p = probe({ perception: { perception: { v: 1, kind: 'image', status: 'failed', reason: 'provider_error', model: '', ms: 1, usd: 0 }, errorKind: kind } });
            await perceiveDm(input(), p.deps);
            assert.deepEqual(p.troubles, [], kind);
        }
    });

    it('a notice that throws never changes what is stored or returned', async () => {
        const p = probe({ perception: { perception: { v: 1, kind: 'image', status: 'failed', reason: 'provider_error', model: '', ms: 1, usd: 0 }, errorKind: 'auth' } });
        p.deps.onProviderTrouble = async () => { throw new Error('telegram down'); };
        const out = await perceiveDm(input(), p.deps);
        assert.ok(out.kind === 'read' && out.perception.status === 'failed');
    });
});

describe('perceiveDm: a database that cannot take the record', () => {
    let p: Probe;
    beforeEach(() => { p = probe(); });

    it('lets the error through, for the pipeline to retry; it never swallows it', async () => {
        p.deps.store = async () => { throw new Error('connection terminated'); };
        await assert.rejects(perceiveDm(input(), p.deps), /connection terminated/);
    });
});
