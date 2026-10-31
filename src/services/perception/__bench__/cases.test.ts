/**
 * The benchmark's cases (`cases.ts`, `scripts/eval-muse/cases.json`): that the committed file is what the brief asks for (every kind, both languages typed, the drawn identity card
 * that must be handed to a person, the garbled picture that must be sent back), that a typo in it is a loud error naming the case and the field, and that a missing media file is a
 * skip by name and never a pass.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveFixture } from '../../dmSales/__evals__/fixtures.js';
import { MEDIA_LIMITS } from '../media.js';
import { displayPath, loadFile, loadMedia, mimeOfFile, parseCasesFile, parseMuseCase, selectMuseCases } from './cases.js';
import { caseOf, committed } from './testSupport.js';
import type { MuseCase } from './types.js';

const ARABIC = /\p{Script=Arabic}/u;

describe('the committed cases file', () => {
    const { cases, memory, openWeights } = committed();

    it('parses, and holds the eighteen cases: fifteen media and three voice notes, each id once', () => {
        assert.equal(cases.length, 18);
        assert.equal(new Set(cases.map((c) => c.id)).size, 18);
        assert.equal(cases.filter((c) => c.kind === 'voice').length, 3);
        for (const c of cases) assert.match(c.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    });

    it('covers every kind the brief names: a photo, a video, a story mention, the account\'s own reel and another creator\'s', () => {
        const kinds = new Set(cases.map((c) => `${c.kind}${c.owner ? `:${c.owner}` : ''}`));
        for (const k of ['image', 'video', 'story_mention', 'reel:own', 'reel:other', 'voice']) assert.ok(kinds.has(k), k);
    });

    it('has typed words in both languages: Arabic and English, each on a picture and on a reel', () => {
        const arabic = cases.filter((c) => c.typed && ARABIC.test(c.typed));
        const english = cases.filter((c) => c.typed && !ARABIC.test(c.typed));
        assert.ok(arabic.length >= 2 && english.length >= 3);
        assert.ok(arabic.some((c) => c.kind === 'image') && arabic.some((c) => c.kind === 'reel'));
        assert.ok(english.some((c) => c.kind === 'image') && english.some((c) => c.kind === 'reel'));
        for (const c of english) assert.deepEqual(c.expect.turn.reply_language, { variety: 'english' }, c.id);
    });

    it('has the drawn identity card, which must go to a person and be understood as personal', () => {
        const id = caseOf('image-id-card');
        assert.deepEqual(id.source, { kind: 'synthetic', card: 'id_card' });
        assert.deepEqual(id.expect.action, ['handoff']);
        assert.deepEqual(id.understood, { mode: 'personal' });
        assert.equal(id.typed, null);
    });

    it('has the garbled screenshot, which must be sent back, and the story, which must be thanked by name', () => {
        assert.deepEqual(caseOf('image-garbled').expect.action, ['resend']);
        assert.deepEqual(caseOf('image-garbled').understood, { mode: 'unreadable' });
        assert.deepEqual(caseOf('story-mention').expect.action, ['thank_named']);
        assert.deepEqual(caseOf('story-mention').source, { kind: 'synthetic', card: 'story_card' });
    });

    it('names the media files the brief lists, and only those (no media is in the repository)', () => {
        const files = new Set(cases.flatMap((c) => (c.source.kind === 'file' ? [c.source.file] : [])));
        assert.deepEqual([...files].sort(), ['garbled-screenshot.png', 'price-screenshot.png', 'real-reel-riyal.mp4', 'shared-reel.mp4', 'test-video.mp4', 'voice-1.m4a', 'voice-2.m4a', 'voice-3.m4a']);
        assert.equal(openWeights?.file, 'real-reel-riyal.mp4');
    });

    it('holds the price rule to the picture: every price case forbids the number and the discount the picture shows', () => {
        for (const id of ['image-price', 'image-price-words-ar', 'image-price-words-en', 'image-price-priced', 'image-price-again', 'video-price']) {
            const c = caseOf(id);
            const forbid = c.expect.forbid.map((p) => new RegExp(p, 'iu'));
            assert.ok(forbid.some((re) => re.test('299')), `${id} forbids 299`);
            assert.ok(forbid.some((re) => re.test('50%')), `${id} forbids 50%`);
        }
    });

    it('makes the offer the right one: a recommendation names only an offer the fixture has', () => {
        for (const c of cases) {
            const offers = new Set(resolveFixture(c.fixture).ctx.offers.map((o) => o.id));
            for (const id of c.expect.turn.offer_id ?? []) assert.ok(id === 'none' || offers.has(id), `${c.id}: ${id}`);
        }
    });

    it('turns what a case expects into the sales turn\'s own next_action, so the harness holds a model-decided turn to it', () => {
        assert.deepEqual(caseOf('image-price').expect.turn.next_action?.sort(), ['ask_qualifier', 'recommend', 'reply', 'send_link']);
        assert.deepEqual(caseOf('voice-payment').expect.turn.next_action, ['handoff']);
        assert.equal(caseOf('story-mention').expect.turn.next_action, undefined);
        assert.equal(caseOf('image-garbled').expect.turn.next_action, undefined);
    });

    it('has ten memory questions, four of them about something only shown on screen, with ids once each', () => {
        assert.equal(memory.length, 10);
        assert.equal(memory.filter((q) => q.visualOnly).length, 4);
        assert.equal(new Set(memory.map((q) => q.id)).size, 10);
        assert.equal(memory.filter((q) => 'none' in q.expect).length, 2);
    });

    it('says what the open-weights comparison reads one reel against: a length and facts, each with words to look for', () => {
        assert.ok(openWeights && openWeights.durationS > 30 && openWeights.facts.length >= 5);
        for (const f of openWeights!.facts) assert.ok(f.name && f.any.length > 0);
    });

    it('has expectations that all compile and no case that quietly checks nothing: every case expects an action and says what understood means', () => {
        for (const c of cases) {
            assert.ok(c.expect.action.length > 0, c.id);
            for (const p of [...(c.expect.turn.must ?? []), ...(c.expect.turn.must_not ?? []), ...c.expect.forbid]) assert.doesNotThrow(() => new RegExp(p, 'iu'), `${c.id}: ${p}`);
            assert.ok(c.understood, c.id);
        }
    });
});

// ─── A typo is a loud error ───────────────────────────────────────────────────────────────────────────────────────────────

const GOOD = {
    id: 'image-x', title: 'A photo', kind: 'image', source: { file: 'a.png' }, typed: null, fixture: 'owner-ar', writes: 'gulf', understood: { shows: [['x']] },
    expect: { action: ['answer'] },
};

const problemsOf = (over: Record<string, unknown>): string[] => {
    const parsed = parseMuseCase({ ...GOOD, ...over }, 'case image-x');
    return 'problems' in parsed ? parsed.problems : [];
};

describe('parseMuseCase', () => {
    it('accepts a good case and gives back what it holds', () => {
        const parsed = parseMuseCase(GOOD, 'case image-x');
        assert.ok('case' in parsed);
        if ('case' in parsed) {
            assert.equal(parsed.case.priorAck, false);
            assert.deepEqual(parsed.case.expect.action, ['answer']);
            assert.deepEqual(parsed.case.expect.turn.next_action, ['reply', 'ask_qualifier']);
        }
    });

    it('names the case and the field of each mistake', () => {
        const cases: [Record<string, unknown>, RegExp][] = [
            [{ extra: 1 }, /extra: is not a field of a case/],
            [{ id: 'Image X' }, /id: must be lower-case words/],
            [{ kind: 'audio' }, /kind: must be one of/],
            [{ fixture: 'production' }, /is not a fixture/],
            [{ writes: 'klingon' }, /writes: must be one of/],
            [{ understood: 'maybe' }, /understood: must be/],
            [{ understood: { shows: [] } }, /understood\.shows/],
            [{ expect: { action: [] } }, /expect\.action: must be a non-empty list/],
            [{ expect: { action: ['dance'] } }, /not something a case may expect/],
            [{ expect: { action: ['answer'], forbid: ['('] } }, /does not compile/],
            [{ expect: { action: ['answer'], must: ['('] } }, /does not compile/],
            [{ expect: { action: ['answer'], offer_id: ['nope'] } }, /is not an offer/],
            [{ expect: { action: ['answer'], nextaction: ['reply'] } }, /is not an expectation/],
            [{ typed: 5 }, /typed: must be text/],
            [{ prior_ack: 'yes' }, /prior_ack: must be true or false/],
            [{ source: {} }, /needs a file, a synthetic card or a caption/],
            [{ source: { file: '../a.png' } }, /must be a plain file name/],
            [{ source: { file: 'sub/a.png' } }, /must be a plain file name/],
            [{ source: { file: 'a.exe' } }, /is not a picture, video or audio file/],
            [{ source: { file: 'a.mp4' } }, /is video, and a case of kind image is image/],
            [{ source: { file: 'a.png', synthetic: 'id_card' } }, /either a file or a synthetic card/],
            [{ source: { synthetic: 'passport' } }, /must be id_card or story_card/],
            [{ source: { file: 'a.png', caption: 'hello' } }, /only a reel carries a caption/],
            [{ owner: 'own' }, /only a reel is/],
            [{ reference: 'text' }, /only a voice note has one/],
        ];
        for (const [over, re] of cases) assert.match(problemsOf(over).join('\n'), re, JSON.stringify(over));
        assert.ok(problemsOf({ extra: 1 })[0]!.startsWith('case image-x '), 'every problem begins with the case');
    });

    it('keeps a case honest about what it can show', () => {
        const reel = { kind: 'reel', owner: 'own', source: { file: 'a.mp4' } };
        assert.match(problemsOf({ expect: { action: ['resend'] } }).join('\n'), /resend is for a picture that cannot be read/);
        assert.match(problemsOf({ understood: 'unreadable', expect: { action: ['answer'] } }).join('\n'), /must be just "resend"/);
        assert.match(problemsOf({ expect: { action: ['thank_named'] } }).join('\n'), /thank_named is for a story mention/);
        assert.match(problemsOf({ understood: 'personal', expect: { action: ['answer'] } }).join('\n'), /action must be just "handoff"/);
        assert.match(problemsOf({ kind: 'story_mention', expect: { action: ['answer'] } }).join('\n'), /action must be just "thank_named"/);
        assert.match(problemsOf({ kind: 'story_mention', typed: 'hello', expect: { action: ['thank_named'] } }).join('\n'), /comes with no typed words/);
        assert.match(problemsOf({ ...reel, owner: undefined }).join('\n'), /a reel is "own" or "other"/);
        assert.match(problemsOf({ kind: 'reel', owner: 'other', source: { file: 'a.mp4' } }).join('\n'), /another creator's reel has no file/);
        assert.match(problemsOf({ kind: 'reel', owner: 'other', source: { caption: 'x' } }).join('\n'), /^$/, 'a caption alone is another creator\'s reel');
        assert.match(problemsOf({ kind: 'reel', owner: 'own', source: { caption: 'x' } }).join('\n'), /must be "other"|is a file/);
        assert.match(problemsOf({ kind: 'voice', source: { file: 'a.m4a' }, typed: 'hi' }).join('\n'), /comes with no typed words/);
        assert.match(problemsOf({ kind: 'image', source: { synthetic: 'id_card' }, typed: null }).join('\n'), /^$/, 'a drawn card is a good photo');
    });

    it('reads the sales evaluation\'s own expectations as that evaluation does: the wrong list for a key is an error', () => {
        assert.match(problemsOf({ expect: { action: ['answer'], reply_language: { variety: 'klingon' } } }).join('\n'), /reply_language/);
        assert.match(problemsOf({ expect: { action: ['answer'], soft: ['charm'] } }).join('\n'), /soft/);
        assert.deepEqual(problemsOf({ expect: { action: ['answer'], soft: ['tone'], reply_language: { variety: 'english' } } }), []);
    });

    it('lets an explicit next_action in the file win over the one an action implies', () => {
        const parsed = parseMuseCase({ ...GOOD, expect: { action: ['answer'], next_action: ['close'] } }, 'x');
        assert.ok('case' in parsed && parsed.case.expect.turn.next_action?.join() === 'close');
    });
});

describe('parseCasesFile', () => {
    it('collects every problem of every case in one error, and refuses a repeated id', () => {
        assert.throws(() => parseCasesFile({ version: 1, cases: [{ ...GOOD, id: 'a', kind: 'zz' }, { ...GOOD, id: 'a' }, { ...GOOD, id: 'a' }] }), (err: unknown) => {
            const m = String((err as Error).message);
            return /case a kind: must be one of/.test(m) && /the id is used twice/.test(m);
        });
    });

    it('wants the right envelope and no stray section', () => {
        assert.throws(() => parseCasesFile({ cases: [] }), /must be \{version: 1/);
        assert.throws(() => parseCasesFile({ version: 2, cases: [] }), /must be \{version: 1/);
        assert.throws(() => parseCasesFile({ version: 1, cases: [], oops: 1 }), /oops: is not a section/);
    });

    it('checks the memory questions and the open-weights section as strictly', () => {
        assert.throws(() => parseCasesFile({ version: 1, cases: [], memory: [{ id: 'q', ask: 'x', visual_only: 'no', expect: { none: true } }] }), /visual_only: must be true or false/);
        assert.throws(() => parseCasesFile({ version: 1, cases: [], memory: [{ id: 'q', ask: 'x', visual_only: true, expect: { reel: [] } }] }), /expect: must be/);
        assert.throws(() => parseCasesFile({ version: 1, cases: [], memory: [{ id: 'q', ask: 'x', visual_only: true, expect: { none: true } }, { id: 'q', ask: 'y', visual_only: true, expect: { none: true } }] }), /is used twice/);
        assert.throws(() => parseCasesFile({ version: 1, cases: [], open_weights: { file: 'x.png', duration_s: 5, facts: [] } }), /plain video file name|facts/);
        const ok = parseCasesFile({ version: 1, cases: [], open_weights: { file: 'x.mp4', duration_s: 5, facts: [{ name: 'a', any: ['b'] }] } });
        assert.equal(ok.openWeights?.durationS, 5);
    });
});

describe('selectMuseCases', () => {
    const all = committed().cases;

    it('takes an id or the start of one, comma-separated, in the order of the file; nothing named is all of them', () => {
        assert.deepEqual(selectMuseCases(all, 'story-mention,image-garbled').map((c) => c.id), ['image-garbled', 'story-mention']);
        assert.deepEqual(selectMuseCases(all, 'reel-own').map((c) => c.id), ['reel-own-riyal', 'reel-own-riyal-words-ar', 'reel-own-podcast', 'reel-own-podcast-words-en']);
        for (const spec of [undefined, '', '  ', 'all', 'ALL']) assert.equal(selectMuseCases(all, spec).length, all.length);
    });

    it('is an error, not an empty run, for a name that matches nothing (an empty run would pass)', () => {
        assert.throws(() => selectMuseCases(all, 'story-mention,nothing-like-this'), /no case matches "nothing-like-this"/);
    });
});

// ─── The media ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('loadMedia', () => {
    const fileCase = (file: string, kind: MuseCase['kind'] = 'image'): MuseCase => ({ ...caseOf('image-price'), kind, source: { kind: 'file', file, caption: null } });

    it('reads a file from the media folder, with the type its extension says', async () => {
        const seen: string[] = [];
        const load = await loadMedia(fileCase('a.png'), '/media', { readFile: async (f) => { seen.push(f); return Buffer.from('bytes'); } });
        assert.deepEqual(seen, ['/media/a.png']);
        assert.ok(load && load.ok && load.media.mime === 'image/png' && load.media.mediaKind === 'image' && load.media.bytes.toString() === 'bytes');
    });

    it('is a skip with the file\'s name, and where it was looked for, when the file is not there; never a pass', async () => {
        const load = await loadMedia(fileCase('missing.png'), '/media', { readFile: async () => { throw new Error('ENOENT'); } });
        assert.ok(load && !load.ok);
        assert.match((load as { why: string }).why, /missing\.png is not in the media folder \(\/media\)/);
    });

    it('refuses an empty file and a file over the product\'s own cap, as the product would', async () => {
        const empty = await loadMedia(fileCase('a.png'), '/m', { readFile: async () => Buffer.alloc(0) });
        assert.ok(empty && !empty.ok && /is empty/.test(empty.why));
        const big = await loadMedia(fileCase('a.png'), '/m', { readFile: async () => Buffer.alloc(MEDIA_LIMITS.image + 1) });
        assert.ok(big && !big.ok && /over the 8 MB the product reads/.test(big.why));
        const video = await loadMedia(fileCase('a.mp4', 'video'), '/m', { readFile: async () => Buffer.alloc(MEDIA_LIMITS.video + 1) });
        assert.ok(video && !video.ok && /over the 35 MB/.test(video.why));
    });

    it('draws a synthetic card instead of reading a file, and has nothing to load for a caption alone', async () => {
        const never = { readFile: async (): Promise<Buffer> => { throw new Error('no file may be read'); } };
        const card = await loadMedia(caseOf('image-id-card'), '/m', never);
        assert.ok(card && card.ok && card.media.mime === 'image/png' && card.media.bytes.length > 1000);
        assert.equal(await loadMedia(caseOf('reel-other'), '/m', never), null);
    });

    it('loadFile will not read a name that is not a plain media file', async () => {
        const io = { readFile: async () => Buffer.from('x') };
        for (const name of ['../x.png', 'a/b.png', 'a.txt', '']) assert.equal((await loadFile(name, '/m', io)).ok, false, name);
    });
});

describe('what is printed', () => {
    it('shortens the home folder wherever it appears, so a public report carries no user name', () => {
        assert.equal(displayPath('/Users/someone/Desktop/media', '/Users/someone'), '~/Desktop/media');
        assert.equal(displayPath('--media-dir=/Users/someone/x', '/Users/someone'), '--media-dir=~/x');
        assert.equal(displayPath('/elsewhere/x', '/Users/someone'), '/elsewhere/x');
        assert.equal(displayPath('/x', ''), '/x');
        assert.equal(displayPath('/x', '/'), '/x');
    });

    it('knows what a file extension is', () => {
        assert.deepEqual(mimeOfFile('a.PNG'), { mime: 'image/png', media: 'image' });
        assert.deepEqual(mimeOfFile('a.m4a'), { mime: 'audio/mp4', media: 'audio' });
        assert.equal(mimeOfFile('a.exe'), null);
    });
});
