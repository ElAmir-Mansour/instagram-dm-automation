/**
 * The memory arm (`memory.ts`): that the library is read as `reel_analyses` rows, that the transcript-only baseline keeps what is said and nothing that was seen, that a question is
 * answered right only by a reel whose analysis says what it is about (or by "no video on that yet" for a topic with none), that a link that is not the library's is counted apart, and
 * that the product's recall is reached with the gate open and the library handed in. The module the adapter wraps is a stand-in of the shape P4b commits.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    adaptRecall, outcomeOf, parseLibrary, rightReels, runMemoryArm, summarizeMemory, textOf, transcriptOnly, type LibraryRow, type MemoryResult, type Recall, type RecallModule, type TurnRecall,
} from './memory.js';
import type { MemoryQuestion } from './types.js';

const row = (id: string, result: Record<string, unknown>, over: Partial<LibraryRow> = {}): LibraryRow => ({
    id, creator_id: 'benchmark-creator', ig_media_id: `ig-${id}`, permalink: `https://www.instagram.com/reel/${id}/`, youtube_url: null, posted_at: '2026-10-01T10:00:00.000Z', status: 'ok', result, model: 'm', ms: 1, usd: 0.01,
    created_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-10-01T10:00:00.000Z', ...over,
});

const BACKEND = row('r1', {
    summary: 'A reel about a meal priced at 45 riyals paid with 1 riyal.', topics: ['backend', 'price'], seen_on_screen: ['a man in a green sweater holding his head', 'two cups of tea'],
    narration: 'the server never sees your page, only the request', key_moments: [{ second: 12, what: 'diagram of page and server' }],
});
const PODCAST = row('r2', { summary: 'Turning study files into a podcast.', topics: ['podcast'], seen_on_screen: ['a purple button that says podcast'], narration: 'comment podcast for a free lesson', key_moments: [] });
const LIBRARY = [BACKEND, PODCAST];

const Q = (id: string, expect: MemoryQuestion['expect'], visualOnly = false): MemoryQuestion => ({ id, ask: `question ${id}`, visualOnly, expect });
const GREEN = Q('green', { reel: [['green sweater'], ['riyal', '45']] }, true);
const SPOKEN = Q('spoken', { reel: [['server never sees']] });
const NONE = Q('none', { none: true });

describe('parseLibrary', () => {
    it('reads reel_analyses rows, as a list or as {rows}, and fills in what the table would hold', () => {
        const rows = parseLibrary([{ id: 'a', result: { summary: 's' }, permalink: 'https://www.instagram.com/reel/a/', posted_at: '2026-10-02T00:00:00Z' }]);
        assert.equal(rows[0]!.status, 'ok');
        assert.equal(rows[0]!.creator_id, 'benchmark-creator');
        assert.equal(rows[0]!.created_at, '2026-10-02T00:00:00Z');
        assert.equal(parseLibrary({ rows: [{ id: 'b', result: {} }] })[0]!.id, 'b');
        assert.equal(parseLibrary([{ ig_media_id: 'only-media-id', result: {} }])[0]!.id, 'only-media-id');
    });

    it('names the row that is wrong: no result, no id, a repeated id, not a list', () => {
        assert.throws(() => parseLibrary([{ id: 'a' }]), /library row 1 has no "result" object/);
        assert.throws(() => parseLibrary([{ result: {} }]), /library row 1 has no id/);
        assert.throws(() => parseLibrary([{ id: 'a', result: {} }, { id: 'a', result: {} }]), /library row 2 repeats the id/);
        assert.throws(() => parseLibrary('x'), /must be a list of reel_analyses rows/);
    });
});

describe('the transcript-only baseline', () => {
    it('keeps what each reel says aloud and nothing it shows: the narration stands where the summary stands, and the notes, topics and moments are empty', () => {
        const plain = transcriptOnly(LIBRARY);
        assert.deepEqual(plain.map((r) => r.id), ['r1', 'r2']);
        assert.deepEqual(plain[0]!.result, { summary: BACKEND.result['narration'], topics: [], seen_on_screen: [], narration: BACKEND.result['narration'], key_moments: [] });
        assert.equal(plain[0]!.permalink, BACKEND.permalink, 'the link is the reel\'s own, so the same reel can be named');
        assert.doesNotMatch(textOf(plain[0]!), /green sweater|riyal/);
        assert.match(textOf(BACKEND), /green sweater/);
    });

    it('is the same reels in the same order, with the library it was made from untouched', () => {
        const before = JSON.stringify(LIBRARY);
        transcriptOnly(LIBRARY);
        assert.equal(JSON.stringify(LIBRARY), before);
    });

    it('has an empty summary for a reel with no narration: such a reel cannot be found by what it says, which is the point', () => {
        const silent = transcriptOnly([row('r3', { summary: 'a silent reel', seen_on_screen: ['a chart'] })]);
        assert.equal(silent[0]!.result['summary'], '');
    });
});

describe('which reel a question is about', () => {
    it('is the reel whose analysis has a word of every group, in any case; a topic with no reel is null', () => {
        assert.deepEqual([...rightReels(GREEN, LIBRARY)!], ['r1']);
        assert.deepEqual([...rightReels(Q('x', { reel: [['PODCAST']] }), LIBRARY)!], ['r2']);
        assert.deepEqual([...rightReels(Q('x', { reel: [['podcast'], ['riyal']] }), LIBRARY)!], [], 'no reel has both');
        assert.equal(rightReels(NONE, LIBRARY), null);
    });
});

describe('runMemoryArm', () => {
    const outcome = (kind: 'match' | 'none' | 'nothing' | 'failed', id = 'r1', over: Record<string, unknown> = {}) => (kind === 'match'
        ? { kind, id, second: 12, link: BACKEND.permalink, ms: 2000, usd: 0.004, ...over }
        : kind === 'failed' ? { kind, reason: 'down', ms: 10, usd: 0, ...over } : { kind, ms: 1500, usd: 0.003, ...over }) as Awaited<ReturnType<Recall>>;
    const recallWith = (...answers: Awaited<ReturnType<Recall>>[]): Recall => { let i = 0; return async () => answers[Math.min(i++, answers.length - 1)]!; };

    it('is right when recall names a reel whose analysis says what the question is about', async () => {
        const [a, b] = await runMemoryArm('memory_visual', [GREEN, SPOKEN], LIBRARY, LIBRARY, recallWith(outcome('match'), outcome('match')));
        assert.deepEqual([a!.ok, a!.answeredWith, a!.visualOnly], [true, 'r1', true]);
        assert.deepEqual([b!.ok, b!.visualOnly], [true, false]);
        assert.equal(a!.usd, 0.004);
        assert.equal(a!.inventedLink, false);
    });

    it('is wrong, with the reason in a line, when it names another reel, finds none, or says there is no such video for a topic that has a reel', async () => {
        const out = await runMemoryArm('memory_visual', [GREEN, GREEN, GREEN], LIBRARY, LIBRARY, recallWith(outcome('match', 'r2'), outcome('nothing'), outcome('none')));
        assert.deepEqual(out.map((r) => [r.ok, r.why]), [[false, 'it named another reel'], [false, 'it found no video to recall'], [false, 'it said there is no such video']]);
    });

    it('is right for a topic with no reel only when it says in so many words that there is none; a reel named for it is wrong, and nothing at all is not an answer', async () => {
        const out = await runMemoryArm('memory_visual', [NONE, NONE, NONE], LIBRARY, LIBRARY, recallWith(outcome('none'), outcome('match'), outcome('nothing')));
        assert.deepEqual(out.map((r) => [r.ok, r.why]), [
            [true, null], [false, 'it named a reel for a topic the library does not cover'], [false, 'it did not say there is no such video'],
        ]);
    });

    it('counts a link that is not the library\'s as invented, apart from being wrong, and lets a start time on a library address through', async () => {
        const withTime = row('r4', { summary: 's green sweater riyal', narration: 'n' }, { youtube_url: 'https://www.youtube.com/watch?v=abc123xyz' });
        const lib = [withTime];
        const ok = await runMemoryArm('memory_visual', [GREEN], lib, lib, recallWith(outcome('match', 'r4', { link: 'https://www.youtube.com/watch?v=abc123xyz&t=13s' })));
        assert.deepEqual([ok[0]!.ok, ok[0]!.inventedLink], [true, false]);
        const bad = await runMemoryArm('memory_visual', [GREEN], lib, lib, recallWith(outcome('match', 'r4', { link: 'https://elsewhere.example/x' })));
        assert.deepEqual([bad[0]!.ok, bad[0]!.inventedLink, bad[0]!.why], [false, true, 'it named a reel or a link the library does not have']);
        const unknownId = await runMemoryArm('memory_visual', [GREEN], lib, lib, recallWith(outcome('match', 'nope', { link: null })));
        assert.equal(unknownId[0]!.inventedLink, true);
    });

    it('skips a question the library has no reel for, by name, and does not ask recall', async () => {
        let asked = 0;
        const out = await runMemoryArm('memory_visual', [Q('lost', { reel: [['a reel that does not exist']] })], LIBRARY, LIBRARY, async () => { asked++; return outcome('match'); });
        assert.deepEqual([out[0]!.status, out[0]!.ok, asked], ['skipped', false, 0]);
        assert.match(out[0]!.why ?? '', /no reel whose analysis says what this question is about/);
    });

    it('records recall failing, however it fails: an outcome and a throw are both a wrong answer with the reason', async () => {
        const a = await runMemoryArm('memory_visual', [GREEN], LIBRARY, LIBRARY, recallWith(outcome('failed')));
        assert.deepEqual([a[0]!.ok, a[0]!.why], [false, 'recall failed: down']);
        const b = await runMemoryArm('memory_visual', [GREEN], LIBRARY, LIBRARY, async () => { throw new Error('exploded'); });
        assert.deepEqual([b[0]!.ok, b[0]!.why], [false, 'recall failed: exploded']);
    });

    it('asks of the library it is given and judges against the full one: the same reel is right in both', async () => {
        const seen: number[] = [];
        const recall: Recall = async (_q, lib) => { seen.push(lib.length); return outcome('match'); };
        const plain = transcriptOnly(LIBRARY);
        const out = await runMemoryArm('memory_transcript', [SPOKEN], plain, LIBRARY, recall);
        assert.deepEqual(seen, [2]);
        assert.equal(out[0]!.ok, true);
        assert.equal(out[0]!.arm, 'memory_transcript');
    });

    it('summarises the right-reel rate overall and for the questions only shown on screen, with the invented links and the time', async () => {
        const results: MemoryResult[] = [
            ...await runMemoryArm('memory_visual', [GREEN, SPOKEN, NONE], LIBRARY, LIBRARY, recallWith(outcome('match'), outcome('match'), outcome('none'))),
            ...await runMemoryArm('memory_transcript', [GREEN, SPOKEN, NONE], transcriptOnly(LIBRARY), LIBRARY, recallWith(outcome('none'), outcome('match'), outcome('none'))),
        ];
        const visual = summarizeMemory('memory_visual', results);
        const plain = summarizeMemory('memory_transcript', results);
        assert.deepEqual([visual.right, visual.rightVisual, visual.rightSpoken], [{ n: 3, of: 3 }, { n: 1, of: 1 }, { n: 2, of: 2 }]);
        assert.deepEqual([plain.right, plain.rightVisual, plain.rightSpoken], [{ n: 2, of: 3 }, { n: 0, of: 1 }, { n: 2, of: 2 }]);
        assert.deepEqual(plain.failures, [{ questionId: 'green', reason: 'it said there is no such video' }]);
        assert.equal(visual.inventedLinks, 0);
        assert.equal(visual.questions, 3);
        assert.equal(visual.p90Ms, 2000);
    });
});

describe('what recall said, as an outcome', () => {
    it('is nothing for null, none for a result with no match, and a match with its reel, second and link otherwise', () => {
        assert.deepEqual(outcomeOf(null, 5, 0.1), { kind: 'nothing', ms: 5, usd: 0.1 });
        const none: TurnRecall = { line: 'No video on this topic yet', link: null, match: null };
        assert.deepEqual(outcomeOf(none, 5, 0), { kind: 'none', ms: 5, usd: 0 });
        const match: TurnRecall = { line: 'Relevant video', link: 'https://www.instagram.com/reel/r1/', match: { reelId: 'r1', second: 13 } };
        assert.deepEqual(outcomeOf(match, 5, 0), { kind: 'match', id: 'r1', second: 13, link: 'https://www.instagram.com/reel/r1/', ms: 5, usd: 0 });
    });
});

describe('adaptRecall', () => {
    it('calls the product\'s recallForTurn with the question as the follower\'s words, the gate open and the library handed in, and reads what it costs from the ledger', async () => {
        let spent = 0;
        const calls: { input: unknown; gate: unknown; library: unknown }[] = [];
        const mod: RecallModule = {
            async recallForTurn(input, deps) {
                calls.push({ input, gate: await deps?.gate?.({}), library: await deps?.library?.('anyone') });
                spent += 0.0042;
                return { line: 'Relevant video', link: 'https://www.instagram.com/reel/r1/', match: { reelId: 'r1', second: 12 } };
            },
        };
        const recall = adaptRecall(mod, { ledgerUsd: () => spent });
        const out = await recall('do you have a video about the server?', LIBRARY);
        assert.deepEqual(calls[0]!.input, { creatorId: 'benchmark-creator', senderId: 'benchmark-sender', text: 'do you have a video about the server?' });
        assert.deepEqual(calls[0]!.gate, { ok: true });
        assert.deepEqual((calls[0]!.library as LibraryRow[]).map((r) => r.id), ['r1', 'r2']);
        assert.equal(out.kind, 'match');
        assert.equal(out.usd, 0.0042);
    });
});
