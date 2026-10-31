/**
 * Recall (`recall.ts`, docs/specs/005-muse-sees T055, T058): "do you have a video about X?" answered from the owner's video library.
 *
 * The pure parts are pinned on their own (the cue, the library's text, the answer, the second, the link, the lines the turn is told). The whole step then runs through the
 * REAL code (the settings, the allow-list and the cap in the gate, the providers layer with its routes and its budget rows, the library's reads) against the in-memory world of
 * `testing/testSupport.ts`, which records every request a provider would have been sent and every statement. What each claim protects:
 *
 *   - **nothing is read or asked until there is a reason**: a message with no content cue touches no setting and no model; a refusal of the gate (the switch, the sender, a
 *     route, the day's cap) or an empty library is no call, and every one of them leaves the turn as it was;
 *   - **what leaves the building is the library's notes and the message's words**, and nothing of the follower: no id, no name, no tenant, no link, no conversation;
 *   - **the library is one stable text**: the same bytes on every call while no reel has changed, and a new reel is one more LAST line, so the provider's cache keeps hitting;
 *   - **the model picks a reel by number and nothing it writes is a link**: a number the library does not have is not an answer, the second is one the notes record, and the
 *     link is built from the row;
 *   - **a failure is no recall, never an error**: the customer is answered as they would have been.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FAKE_KEYS } from '../aiProviders/testKeys.js';
import { jsonResponse } from '../llm/testFetch.js';
import { guardReply } from '../dmSales/guard.js';
import { MUSE_BUDGET_PURPOSES, perceptionRouteReady } from './gate.js';
import type { LibraryRow } from './reelLibrary.js';
import {
    buildLibrary, hasContentCue, LINE_LIMITS, MAX_REELS, mentionsLink, MESSAGE_MAX_CHARS, MIN_CALL_MS, NO_VIDEO_FACT, parseRecallAnswer, RECALL_EFFORT, RECALL_INSTRUCTIONS,
    RECALL_MAX_TOKENS, RECALL_PURPOSE, RECALL_STEP_BUDGET_MS, recallForTurn, recalledFact, recallRouteReady, recallSchema, recallSystem, setRecallDeps, snapSecond, videoLink,
    VIDEO_GUIDE, type RecallDeps,
} from './recall.js';
import { answerOn, chatAnswer, configure, installWorld, OTHER_TENANT, PAGE_TOKEN, TENANT, type World } from './testing/testSupport.js';
import type { FakeReel } from './testing/testDb.js';
import { watchFrom } from './text.js';

const SENDER = '17841400000000001';
const NOW = new Date('2026-11-01T09:30:00.000Z');

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────────

let seq = 0;
const rowId = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** A library row as `listOkForRecall` reads it. Neutral subjects, made up. */
function reel(over: Partial<LibraryRow> & { result?: Record<string, unknown> } = {}): LibraryRow {
    const id = over.id ?? rowId();
    return {
        id, creator_id: TENANT, ig_media_id: over.ig_media_id ?? `ig${id.slice(-4)}`, permalink: `https://www.instagram.com/reel/${id.slice(-8)}/`, youtube_url: null,
        posted_at: '2026-10-01T10:00:00.000Z', status: 'ok', model: 'muse-spark-1.3', ms: 30_000, usd: 0.02, created_at: '2026-10-30T08:00:00.000Z', updated_at: '2026-10-30T08:00:00.000Z',
        ...over,
        result: {
            summary: 'A reel about something.', topics: ['a topic'], seen_on_screen: ['a screen'], narration: 'spoken words', key_moments: [{ second: 5, what: 'a moment' }],
            hook_first_3s: 'a hook', hook_score: 7, caption_ar: 'caption', cover_second: 2, cover_reason: 'because', ...over.result,
        },
    };
}

const DECORATORS = (): LibraryRow => reel({
    id: rowId(), ig_media_id: '1001', permalink: 'https://www.instagram.com/reel/DECOR8TORS/', posted_at: '2026-10-01T10:00:00.000Z',
    result: {
        summary: 'Python decorators: a function that wraps another function to add behaviour, shown with a timer.',
        topics: ['python decorators', 'functions'], seen_on_screen: ['@timer', 'def wrapper(*args)'],
        key_moments: [{ second: 5, what: 'the @ syntax' }, { second: 21, what: 'a timing example' }],
    },
});
const DOCKER = (): LibraryRow => reel({
    id: rowId(), ig_media_id: '1002', permalink: 'https://www.instagram.com/reel/D0CKERVOL/', youtube_url: 'https://www.youtube.com/watch?v=Zm9vYmFyYmF6', posted_at: '2026-10-10T10:00:00.000Z',
    result: {
        summary: 'Docker volumes keep a container\'s data after it stops, shown with docker run -v.',
        topics: ['docker', 'volumes'], seen_on_screen: ['docker run -v data:/app', 'a whale logo'],
        key_moments: [{ second: 7, what: 'the -v flag' }, { second: 30, what: 'data is still there after a restart' }],
    },
});
const GIT = (): LibraryRow => reel({
    id: rowId(), ig_media_id: '1003', permalink: 'https://www.instagram.com/reel/G1TREBASE/', posted_at: '2026-10-20T10:00:00.000Z',
    result: {
        summary: 'Git rebase versus merge, drawn as two branches. Three steps are shown.',
        topics: ['git', 'rebase', 'merge'], seen_on_screen: ['git rebase main', 'a branch graph'],
        key_moments: [{ second: 3, what: 'the merge commit' }, { second: 12, what: 'the rebased history' }],
    },
});

// ─── The cue ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('hasContentCue: a word that may be asking for a video', () => {
    it('finds every cue of the contract, Arabic and English', () => {
        for (const text of ['فيديو', 'ريل', 'حلقة', 'شرح', 'بتشرح', 'شرحت', 'درس', 'video', 'reel', 'episode', 'explain', 'tutorial', 'lesson']) assert.equal(hasContentCue(text), true, text);
    });

    it('finds them inside a sentence, with the article and prepositions Arabic glues on, and with the endings English takes', () => {
        for (const text of [
            'عندك فيديو بيشرح يعني إيه باك إند؟', 'فين الفيديو بتاع الأمس', 'ممكن بالفيديو', 'شفت الريلز بتاعك', 'في حلقات عن البايثون؟', 'محتاج دروس للمبتدئين', 'اشرح لي طريقة الربط',
            'Do you have a video about Docker?', 'any VIDEOS on git?', 'where is the reel about loops', 'is there an episode on rebase', 'who explains closures best',
            'she explained it well', 'a tutorial on volumes please', 'your lessons are great',
        ]) assert.equal(hasContentCue(text), true, text);
    });

    it('folds Arabic the way keyword matching does: tatweel, diacritics, hamza and teh marbuta spellings', () => {
        for (const text of ['حـــلقة', 'حلقه', 'حَلْقة', 'فِيديو', 'فيـــديو', 'شَرح', 'دَرْس', 'ريـل']) assert.equal(hasContentCue(text), true, text);
    });

    it('is false for a message with none: a price, a greeting, a currency that only looks like a reel, a longer English word, and anything that is not text', () => {
        for (const text of ['How much is the plan?', 'السلام عليكم', 'كم سعر الاشتراك', 'ريال واحد فقط', 'hello', 'my videography business', 'thanks', '   ', '']) assert.equal(hasContentCue(text), false, text);
        for (const notText of [undefined, null, 7, {}, ['video']]) assert.equal(hasContentCue(notText), false, String(notText));
    });
});

// ─── The library's text ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('buildLibrary and recallSystem: the library as one stable text', () => {
    it('numbers the reels from 1, the OLDEST first, whatever order they were read in', () => {
        const [a, b, c] = [DECORATORS(), DOCKER(), GIT()];
        for (const rows of [[a, b, c], [c, b, a], [b, c, a]]) {
            const lib = buildLibrary(rows);
            assert.deepEqual(lib.map((e) => [e.n, e.row.ig_media_id]), [[1, '1001'], [2, '1002'], [3, '1003']]);
        }
    });

    it('writes one line per reel: <n> | <date> | <summary> | seen: … | topics: … | moments: m:ss what; m:ss what', () => {
        const lines = recallSystem(buildLibrary([DECORATORS(), DOCKER()])).split('\n').filter((l) => /^\d+ \| /.test(l));
        assert.deepEqual(lines, [
            '1 | 2026-10-01 | Python decorators: a function that wraps another function to add behaviour, shown with a timer. | seen: @timer; def wrapper(*args) | topics: python decorators, functions | moments: 0:05 the @ syntax; 0:21 a timing example',
            '2 | 2026-10-10 | Docker volumes keep a container\'s data after it stops, shown with docker run -v. | seen: docker run -v data:/app; a whale logo | topics: docker, volumes | moments: 0:07 the -v flag; 0:30 data is still there after a restart',
        ]);
    });

    it('is the instructions, then the library, and holds no link, no id and nothing of anyone: the model chooses a number', () => {
        const rows = [DECORATORS(), DOCKER(), GIT()];
        const system = recallSystem(buildLibrary(rows));
        assert.ok(system.startsWith(`${RECALL_INSTRUCTIONS}\n\nLibrary:\n1 | `));
        for (const forbidden of ['http', 'instagram.com', 'youtube', TENANT, ...rows.map((r) => r.id), ...rows.map((r) => r.permalink!)]) assert.ok(!system.includes(forbidden), forbidden);
        assert.match(RECALL_INSTRUCTIONS, /Use only numbers that are in the library/);
        assert.doesNotMatch(RECALL_INSTRUCTIONS, /\b(RAG|1M)\b/);
    });

    it('is the same bytes every time for the same reels, and a new reel is one more LAST line with every line before it untouched (what the provider\'s cache needs)', () => {
        const [a, b, c] = [DECORATORS(), DOCKER(), GIT()];
        const before = recallSystem(buildLibrary([a, b]));
        assert.equal(recallSystem(buildLibrary([b, a])), before, 'the order the rows came in does not matter');
        assert.equal(recallSystem(buildLibrary([a, b])), before, 'and it is deterministic');
        const after = recallSystem(buildLibrary([c, b, a]));
        assert.ok(after.startsWith(`${before}\n3 | `), 'the old text is a prefix of the new');
        assert.equal(after.split('\n').length, before.split('\n').length + 1);
    });

    it('keeps out a reel that was not watched and understood, one with no summary, and one with no link it may send: an address that is not https or not Instagram\'s or YouTube\'s', () => {
        const rows = [
            DECORATORS(),
            reel({ ig_media_id: 'pending', status: 'pending', result: {} }),
            reel({ ig_media_id: 'failed', status: 'failed', result: { error: 'too_large' } }),
            reel({ ig_media_id: 'nosummary', result: { summary: '   ' } }),
            reel({ ig_media_id: 'nolink', permalink: null, youtube_url: null }),
            reel({ ig_media_id: 'http', permalink: 'http://www.instagram.com/reel/PLAIN/' }),
            reel({ ig_media_id: 'foreign', permalink: 'https://evil.example/reel/x' }),
            reel({ ig_media_id: 'script', permalink: 'javascript:alert(1)' }),
            reel({ ig_media_id: 'yt-only', permalink: null, youtube_url: 'https://www.youtube.com/watch?v=AbCdEfGhIjK', result: { summary: 'Only on YouTube.' } }),
        ];
        assert.deepEqual(buildLibrary(rows).map((e) => e.row.ig_media_id).sort(), ['1001', 'yt-only']);
    });

    it('bounds every part of a line and takes out what would break it: the separator, a line break, a control character', () => {
        const long = 'x'.repeat(5000);
        const notes = reel({
            ig_media_id: 'long',
            result: {
                summary: `${long}`, topics: Array.from({ length: 30 }, (_, i) => `topic ${i} ${long}`), seen_on_screen: Array.from({ length: 30 }, (_, i) => `note ${i} ${long}`),
                key_moments: Array.from({ length: 30 }, (_, i) => ({ second: i, what: long })),
            },
        });
        const [entry] = buildLibrary([notes]);
        const parts = entry!.line.split(' | ');
        assert.equal(parts.length, 5, 'date, summary, seen, topics, moments: nothing a part held added a separator');
        assert.ok(parts[1]!.length <= LINE_LIMITS.summary);
        assert.equal(parts[2]!.slice('seen: '.length).split('; ').length, LINE_LIMITS.seenNotes);
        assert.equal(parts[3]!.slice('topics: '.length).split(', ').length, LINE_LIMITS.topics);
        assert.equal(parts[4]!.slice('moments: '.length).split('; ').length, LINE_LIMITS.moments);
        assert.ok(entry!.line.length < 6000);

        const dirty = reel({ ig_media_id: 'dirty', result: { summary: 'one | two\nthree\u0007 four\u202e', topics: ['a | b'], seen_on_screen: [], key_moments: [] } });
        const [clean] = buildLibrary([dirty]);
        assert.equal(clean!.line, '2026-10-01 | one / two three four | seen: - | topics: a / b | moments: -');
        assert.doesNotMatch(clean!.line, /[\p{Cc}\p{Cf}]/u);
    });

    it('records every moment for the second to be snapped to, and lists the first eight', () => {
        const moments = Array.from({ length: 12 }, (_, i) => ({ second: (i + 1) * 5, what: `m${i + 1}` }));
        const [entry] = buildLibrary([reel({ result: { key_moments: moments } })]);
        assert.equal(entry!.seconds.length, 12);
        assert.equal(entry!.line.split(' | ')[4]!.split('; ').length, LINE_LIMITS.moments);
    });

    it('is at most the newest MAX_REELS, numbered from 1', () => {
        const rows = Array.from({ length: MAX_REELS + 5 }, (_, i) => reel({ ig_media_id: `r${i}`, posted_at: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(), created_at: `2026-10-30T08:00:${String(i % 60).padStart(2, '0')}.000Z` }));
        const lib = buildLibrary(rows);
        assert.equal(lib.length, MAX_REELS);
        assert.equal(lib[0]!.n, 1);
        assert.equal(lib.at(-1)!.row.ig_media_id, `r${MAX_REELS + 4}`);
        assert.equal(lib[0]!.row.ig_media_id, 'r5', 'the five oldest were cut');
    });

    it('puts a reel with no date first, says "undated", and orders equal dates the same way every time', () => {
        const undated = reel({ ig_media_id: 'u', posted_at: null });
        const twinA = reel({ ig_media_id: 'a', id: '00000000-0000-4000-8000-0000000000aa', posted_at: '2026-10-05T00:00:00.000Z' });
        const twinB = reel({ ig_media_id: 'b', id: '00000000-0000-4000-8000-0000000000bb', posted_at: '2026-10-05T00:00:00.000Z' });
        const lib = buildLibrary([twinB, twinA, undated]);
        assert.deepEqual(lib.map((e) => e.row.ig_media_id), ['u', 'a', 'b']);
        assert.match(lib[0]!.line, /^undated \| /);
    });
});

// ─── The answer ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the schema and parseRecallAnswer: only the shape asked for is an answer', () => {
    it('is the contract: a closed object of four required fields, in this order', () => {
        const schema = recallSchema() as { type: string; properties: Record<string, { type: string }>; required: string[] };
        assert.equal(schema.type, 'OBJECT');
        assert.deepEqual(schema.required, ['is_content_request', 'match', 'second', 'why']);
        assert.deepEqual(Object.keys(schema.properties), schema.required);
        assert.deepEqual(Object.values(schema.properties).map((p) => p.type), ['BOOLEAN', 'INTEGER', 'INTEGER', 'STRING']);
    });

    it('reads a good answer as it is', () => {
        assert.deepEqual(parseRecallAnswer({ is_content_request: true, match: 2, second: 14, why: 'the -v flag' }, 3), { isContentRequest: true, match: 2, second: 14, why: 'the -v flag' });
        assert.deepEqual(parseRecallAnswer({ is_content_request: true, match: 0, second: 0, why: 'none fits' }, 3), { isContentRequest: true, match: 0, second: 0, why: 'none fits' });
        assert.deepEqual(parseRecallAnswer({ is_content_request: true, match: 3, second: 0, why: '' }, 3), { isContentRequest: true, match: 3, second: 0, why: '' });
    });

    it('reads a message that was not a request as that, without looking at the rest', () => {
        assert.deepEqual(parseRecallAnswer({ is_content_request: false, match: 99, second: -4, why: 'a greeting' }, 3), { isContentRequest: false, match: 0, second: 0, why: 'a greeting' });
        assert.deepEqual(parseRecallAnswer({ is_content_request: false }, 3), { isContentRequest: false, match: 0, second: 0, why: '' });
    });

    it('is no answer when a reel number is one the library does not have, or is not a whole number: it is never guessed at', () => {
        for (const match of [4, 99, -1, 1.5, '2', null, undefined, Number.NaN, {}]) assert.equal(parseRecallAnswer({ is_content_request: true, match, second: 0, why: '' }, 3), null, String(match));
        assert.equal(parseRecallAnswer({ is_content_request: true, match: 1 }, 0), null, 'with no reels no number is right but 0');
    });

    it('is no answer when it is not an object or has no boolean for is_content_request', () => {
        for (const bad of [null, undefined, 'text', 42, [], [{ is_content_request: true, match: 1 }], {}, { is_content_request: 'true', match: 1 }, { match: 1, second: 0 }]) assert.equal(parseRecallAnswer(bad, 3), null, JSON.stringify(bad));
    });

    it('makes the second a whole number from 0, and 0 for anything else or when no reel matched', () => {
        const second = (v: unknown, match = 1) => parseRecallAnswer({ is_content_request: true, match, second: v, why: '' }, 3)!.second;
        assert.deepEqual([13, 13.4, 13.6, -5, 1e9].map((v) => second(v)), [13, 13, 14, 0, 36_000]);
        assert.deepEqual(['13', null, undefined, Number.NaN, {}].map((v) => second(v)), [0, 0, 0, 0, 0]);
        assert.equal(second(20, 0), 0, 'no reel, no second');
    });

    it('cleans the sentence to one bounded line', () => {
        const a = parseRecallAnswer({ is_content_request: true, match: 1, second: 0, why: `the \u0000reel\nshows it ${'x'.repeat(500)}` }, 3)!;
        assert.doesNotMatch(a.why, /[\p{Cc}]/u);
        assert.ok(a.why.length <= 300);
    });
});

describe('snapSecond: the second said is one the reel\'s own notes record', () => {
    it('is the last recorded moment at or before the second asked for', () => {
        assert.equal(snapSecond(21, [5, 21, 40]), 21, 'a recorded moment stays as it is');
        assert.equal(snapSecond(24, [5, 21, 40]), 21, 'between two, the one it is in');
        assert.equal(snapSecond(500, [5, 21, 40]), 40, 'past the last, the last');
    });

    it('is 0, from the start, when the second comes before the first moment, when the reel has none, or when 0 was asked for', () => {
        assert.equal(snapSecond(3, [5, 21]), 0);
        assert.equal(snapSecond(30, []), 0);
        assert.equal(snapSecond(0, [0, 5]), 0);
    });
});

// ─── The link, and what the turn is told ─────────────────────────────────────────────────────────────────────────────────

describe('videoLink: the only addresses recall may send, and where the second goes', () => {
    const insta = 'https://www.instagram.com/reel/ABC123/';
    const yt = 'https://www.youtube.com/watch?v=Zm9vYmFyYmF6';

    it('is the YouTube copy with &t= when there is one and the second is past the start: that link can start there', () => {
        assert.equal(videoLink({ permalink: insta, youtube_url: yt }, 13), `${yt}&t=13s`);
        assert.equal(videoLink({ permalink: null, youtube_url: yt }, 65), `${yt}&t=65s`);
        assert.equal(videoLink({ permalink: insta, youtube_url: 'https://youtu.be/Zm9vYmFyYmF6' }, 13), 'https://youtu.be/Zm9vYmFyYmF6?t=13s', '?t= when the address has no query');
    });

    it('is the Instagram permalink otherwise, which cannot start at a second: from the start, or with no YouTube copy', () => {
        assert.equal(videoLink({ permalink: insta, youtube_url: yt }, 0), insta);
        assert.equal(videoLink({ permalink: insta, youtube_url: null }, 13), insta);
    });

    it('is the YouTube address as it is when it is all there is and the second is the start, and null when there is nothing it may send', () => {
        assert.equal(videoLink({ permalink: null, youtube_url: yt }, 0), yt);
        assert.equal(videoLink({ permalink: null, youtube_url: null }, 0), null);
        assert.equal(videoLink({ permalink: 'http://www.instagram.com/reel/x/', youtube_url: 'https://evil.example/watch?v=x' }, 9), null);
        assert.equal(videoLink({ permalink: '  https://www.instagram.com/reel/ABC123/  ', youtube_url: null }, 0), insta, 'trimmed');
    });
});

describe('recalledFact: the line the turn tells its model', () => {
    const entry = () => buildLibrary([DOCKER()])[0]!;

    it('says "Relevant video: <link> (watch from m:ss): <summary>", the second being one of the reel\'s own', () => {
        const fact = recalledFact(entry(), 31);
        assert.equal(fact.second, 30, 'asked for 31, the reel\'s moment at 30');
        assert.equal(fact.link, 'https://www.youtube.com/watch?v=Zm9vYmFyYmF6&t=30s');
        assert.ok(fact.line.startsWith('Relevant video: https://www.youtube.com/watch?v=Zm9vYmFyYmF6&t=30s (watch from 0:30): Docker volumes keep a container\'s data after it stops, shown with docker run -v. '), fact.line);
        assert.ok(fact.line.endsWith(VIDEO_GUIDE));
        assert.ok(!fact.line.includes('\n'), 'one line');
        // What the GUARD is told is the code-made part of it: the link and the second, and never the summary a model wrote.
        assert.equal(fact.claim, 'Relevant video: https://www.youtube.com/watch?v=Zm9vYmFyYmF6&t=30s (watch from 0:30)');
        assert.ok(fact.line.startsWith(`${fact.claim}: `));
        assert.ok(!fact.claim.includes('Docker') && !fact.claim.includes(VIDEO_GUIDE));
    });

    it('leaves "watch from" out for the start of the reel, and links the Instagram page', () => {
        const fact = recalledFact(entry(), 0);
        assert.equal(fact.second, 0);
        assert.equal(fact.link, 'https://www.instagram.com/reel/D0CKERVOL/');
        assert.ok(fact.line.startsWith('Relevant video: https://www.instagram.com/reel/D0CKERVOL/: Docker volumes'), fact.line);
        assert.doesNotMatch(fact.line, /\(watch from/, 'no second is named for the start of the reel');
        assert.equal(fact.claim, 'Relevant video: https://www.instagram.com/reel/D0CKERVOL/', 'a reel that starts the answer has no second to allow');
    });

    it('formats the time as a person reads it on a timeline', () => {
        assert.deepEqual([0, 5, 13, 59, 60, 65, 600, 3725].map(watchFrom), ['0:00', '0:05', '0:13', '0:59', '1:00', '1:05', '10:00', '62:05']);
        assert.deepEqual([-3, Number.NaN, 13.9].map(watchFrom), ['0:00', '0:00', '0:13']);
    });

    it('tells the model what to do with it, in words with no number in them, and admits the link is the one exception to a rule it is given every turn', () => {
        assert.doesNotMatch(VIDEO_GUIDE, /\d/);
        assert.doesNotMatch(NO_VIDEO_FACT, /\d/);
        assert.match(VIDEO_GUIDE, /the one exception to the rule against writing a link/);
        assert.match(VIDEO_GUIDE, /Give the time to watch from when there is one, and repeat no other number, price or discount that this mentions/);
        assert.match(VIDEO_GUIDE, /Do not mention any other video/);
        assert.match(NO_VIDEO_FACT, /^No video on this topic yet\./);
        assert.match(NO_VIDEO_FACT, /do not point to any other video/);
    });

    it('adds a full stop to a summary that has none, so what follows is a new sentence', () => {
        const [e] = buildLibrary([reel({ result: { summary: 'No stop here', key_moments: [] } })]);
        assert.match(recalledFact(e!, 0).line, /: No stop here\. It is the account owner/);
    });
});

describe('mentionsLink: does the reply already hold the video\'s link', () => {
    const link = 'https://www.instagram.com/reel/ABC123/';
    it('finds it however the scheme, the www and the closing slash are written', () => {
        for (const text of [`watch ${link}`, 'watch instagram.com/reel/ABC123', 'watch http://instagram.com/reel/ABC123/ now', 'watch www.instagram.com/reel/ABC123.']) assert.equal(mentionsLink(text, link), true, text);
    });
    it('does not find another reel\'s, or none', () => {
        for (const text of ['watch https://www.instagram.com/reel/XYZ789/', 'no link at all', '']) assert.equal(mentionsLink(text, link), false, text);
        assert.equal(mentionsLink('anything', ''), false);
    });
    it('keeps the query of a YouTube link: a link with another second is not the same one', () => {
        const yt = 'https://www.youtube.com/watch?v=Zm9vYmFyYmF6&t=30s';
        assert.equal(mentionsLink(`go ${yt}`, yt), true);
        assert.equal(mentionsLink('go youtube.com/watch?v=Zm9vYmFyYmF6&t=99s', yt), false);
    });
});

// ─── The guard: a link passes only when it is the recalled one ───────────────────────────────────────────────────────────

describe('the guard and recall: a library permalink passes only when it was recalled', () => {
    const lib = buildLibrary([DECORATORS(), DOCKER(), GIT()]);
    const [decorators, docker, git] = lib;
    const base = { texts: ['The plan has 12 weeks.'], prices: [] as never[] };

    it('keeps exactly the matched reel\'s link, and takes out every other permalink of the library', () => {
        const fact = recalledFact(git!, 12);
        const claims = { ...base, texts: [...base.texts, fact.claim], allowedLinks: [fact.link] };
        const reply = `Here you go ${fact.link} and also ${decorators!.row.permalink} and ${docker!.row.permalink}, from 0:12.`;
        const guarded = guardReply(reply, claims);
        assert.ok(guarded.text.includes(fact.link));
        assert.ok(!guarded.text.includes('DECOR8TORS') && !guarded.text.includes('D0CKERVOL'), guarded.text);
        assert.deepEqual(guarded.linksRemoved, [decorators!.row.permalink, docker!.row.permalink]);
        assert.equal(guarded.ok, true, 'the second it names is the line\'s, so it is no invented number');
    });

    it('takes every permalink out when nothing was recalled: no line, no link on the list', () => {
        const guarded = guardReply(`Try ${git!.row.permalink} or ${decorators!.row.permalink}`, { ...base, allowedLinks: [] });
        assert.ok(!/instagram\.com/.test(guarded.text), guarded.text);
        assert.equal(guarded.linksRemoved.length, 2);
    });

    it('takes out the recalled reel\'s link written differently (another second, no query): only the exact one is on the list', () => {
        const fact = recalledFact(docker!, 30);
        const claims = { ...base, texts: [...base.texts, fact.claim], allowedLinks: [fact.link] };
        const guarded = guardReply('See https://www.youtube.com/watch?v=Zm9vYmFyYmF6&t=7s or https://www.youtube.com/watch?v=Zm9vYmFyYmF6', claims);
        assert.ok(!/youtube/.test(guarded.text), guarded.text);
        assert.equal(guarded.linksRemoved.length, 2);
    });

    it('does not make the reel\'s summary a fact: a number, a price or a discount a model wrote about the reel is not one the reply may state', () => {
        const promo = buildLibrary([reel({ ig_media_id: 'promo', permalink: 'https://www.instagram.com/reel/PR0M0/', result: { summary: 'Only 3 spots left: a discount of 50 percent ends today, and the plan is free for 7 days.', key_moments: [{ second: 4, what: 'the offer' }] } })])[0]!;
        const fact = recalledFact(promo, 4);
        assert.ok(fact.line.includes('discount of 50 percent'), 'the model is shown the notes');
        assert.ok(!fact.claim.includes('discount') && !fact.claim.includes('50'), 'the guard is not');
        const claims = { ...base, texts: [...base.texts, fact.claim], allowedLinks: [fact.link] };
        const said = guardReply(`There is one: ${fact.link} from 0:04. It has a discount of 50 percent, only 3 spots, and it is free.`, claims);
        assert.equal(said.ok, false);
        assert.deepEqual(said.violations.map((v) => `${v.kind}:${v.found}`).sort(), ['discount:discount', 'free:free', 'number:3', 'number:50']);
        assert.equal(guardReply(`There is one: ${fact.link} from 0:04.`, claims).ok, true, 'the link and the second pass');
    });

    it('lets the reply say the second the line names, and refuses one it does not: a time is a number like any other', () => {
        const fact = recalledFact(docker!, 30);
        const claims = { ...base, texts: [...base.texts, fact.claim], allowedLinks: [fact.link] };
        assert.equal(guardReply('Start at 0:30 and watch it.', claims).ok, true);
        assert.equal(guardReply('٠:٣٠', claims).ok, true, 'Arabic-Indic digits are the same number');
        const wrong = guardReply('Start at 5:42 and watch it.', claims);
        assert.equal(wrong.ok, false);
        assert.deepEqual(wrong.violations.map((v) => v.found).sort(), ['42', '5']);
        assert.equal(guardReply('Start at 0:30 and watch it.', { ...base, allowedLinks: [] }).ok, false, 'without the line, the same words are refused');
    });
});

// ─── The whole step, in the world ────────────────────────────────────────────────────────────────────────────────────────

let world: World;
let savedKey: string | undefined;
beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    world = installWorld();
    world.ai.now = NOW;
});
afterEach(() => {
    setRecallDeps({});
    world.restore();
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

/** The owner's settings: the memory switch on, the sender on the list, a Meta key. */
function open(over: { allow?: string[]; memory?: boolean; keys?: ('meta' | 'baseten')[]; capUsd?: string } = {}): void {
    configure(world, { memory: over.memory ?? true, keys: over.keys ?? ['meta'], capUsd: over.capUsd ?? '3' });
    world.ai.setSetting(`muse.allow_senders.${TENANT}`, JSON.stringify(over.allow ?? [SENDER]));
}

/** A reel in the library table, as the indexer leaves it. */
function stock(row: LibraryRow): LibraryRow {
    const fake: FakeReel = {
        id: row.id, creator_id: row.creator_id, ig_media_id: row.ig_media_id, permalink: row.permalink, youtube_url: row.youtube_url, posted_at: row.posted_at ? new Date(row.posted_at) : null,
        status: row.status, result: row.result, model: row.model, ms: row.ms, usd: row.usd === null ? null : Number(row.usd).toFixed(6), created_at: new Date(row.created_at), updated_at: new Date(row.updated_at),
    };
    world.reel.reels.push(fake);
    return row;
}

const says = (json: Record<string, unknown>) => chatAnswer('muse-spark-1.3', json, { prompt_tokens: 6200, completion_tokens: 480 });
const GATE_DEPS = { now: () => NOW, tellOwner: async () => undefined };
const ask = (text: string, over: RecallDeps = {}) => recallForTurn({ creatorId: TENANT, senderId: SENDER, text }, { gateDeps: GATE_DEPS, ...over });
const meta = () => world.providers.calls.filter((c) => c.host === 'api.meta.ai');
const events = (event: string) => world.logs.filter((l) => l.event === event);
const printed = (): string => JSON.stringify([world.reel.statements, world.ai.statements, world.logs, meta().map((c) => c.raw)]);
const QUESTION = 'عندك فيديو بيشرح docker volumes؟';

describe('recallForTurn: a match', () => {
    beforeEach(() => { open(); stock(DECORATORS()); stock(DOCKER()); stock(GIT()); });

    it('asks once for the matching reel and answers with its link, the second to watch from and its summary', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 2, second: 30, why: 'data survives a restart' }));
        const got = await ask(QUESTION);

        assert.ok(got);
        assert.equal(got.link, 'https://www.youtube.com/watch?v=Zm9vYmFyYmF6&t=30s', 'the YouTube copy, which can start at the second');
        assert.ok(got.line.startsWith('Relevant video: https://www.youtube.com/watch?v=Zm9vYmFyYmF6&t=30s (watch from 0:30): Docker volumes keep a container\'s data'), got.line);
        assert.deepEqual(got.match && got.match.second, 30);
        assert.equal(got.claim, 'Relevant video: https://www.youtube.com/watch?v=Zm9vYmFyYmF6&t=30s (watch from 0:30)', 'what the guard is given');
        assert.equal(meta().length, 1);
        assert.equal(world.ai.usage.length, 1);
        assert.deepEqual([world.ai.usage[0]!.purpose, world.ai.usage[0]!.provider, world.ai.usage[0]!.creator_id, world.ai.usage[0]!.outcome], [RECALL_PURPOSE, 'meta', TENANT, 'ok']);
        const matched = events('recall.matched');
        assert.equal(matched.length, 1);
        assert.deepEqual([matched[0]!['second'], matched[0]!['reel_id'], matched[0]!['model']], [30, got.match!.reelId, 'muse-spark-1.3']);
    });

    it('links the Instagram page of a reel that has no YouTube copy, and says where to watch from in words', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 3, second: 12, why: 'the rebased history' }));
        const got = (await ask('is there a video that explains git rebase?'))!;
        assert.equal(got.link, 'https://www.instagram.com/reel/G1TREBASE/');
        assert.ok(got.line.startsWith('Relevant video: https://www.instagram.com/reel/G1TREBASE/ (watch from 0:12): Git rebase versus merge'), got.line);
    });

    it('says the reel\'s own second, even when the model gave one between two moments or none that fits', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 1, second: 99, why: '' }), says({ is_content_request: true, match: 1, second: 2, why: '' }));
        assert.equal((await ask('any video on decorators'))!.match!.second, 21, 'the last moment before 99');
        assert.equal((await ask('any video on decorators'))!.match!.second, 0, 'before the first moment: from the start');
    });

    it('asks Meta\'s model for the purpose recall, at low effort, with the 3,000 tokens the contract says (raised to Meta\'s floor), a strict schema and the library as the system text', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 2, second: 7, why: '' }));
        await ask(QUESTION);
        const call = meta()[0]!;
        const rows = world.reel.reels.map((r) => ({ ...r, posted_at: r.posted_at ? r.posted_at.toISOString() : null, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString() })) as unknown as LibraryRow[];

        assert.equal(call.url, 'https://api.meta.ai/v1/chat/completions');
        assert.equal(call.body.model, 'muse-spark-1.3');
        assert.equal(RECALL_EFFORT, 'low');
        assert.equal(call.body.reasoning_effort, 'low');
        assert.ok(call.body.max_tokens >= RECALL_MAX_TOKENS);
        assert.equal(call.body.response_format.type, 'json_schema');
        assert.equal(call.body.response_format.json_schema.strict, true);
        assert.deepEqual(call.body.response_format.json_schema.schema.required, ['is_content_request', 'match', 'second', 'why']);
        assert.deepEqual(call.body.messages.map((m: { role: string }) => m.role), ['system', 'user']);
        assert.equal(call.body.messages[0].content, recallSystem(buildLibrary(rows)), 'the system text is the library, and only the library');
        assert.equal(call.body.messages[1].content, QUESTION, 'the user text is the message, as they wrote it');
        assert.equal(call.headers['authorization'], `Bearer ${FAKE_KEYS.meta}`);
    });

    it('sends NOTHING of the follower, the account or a link: no id, no name, no tenant, no page credential, no address, and reads no table of anyone\'s messages', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 2, second: 7, why: '' }));
        await ask(QUESTION);
        for (const secret of [SENDER, TENANT, OTHER_TENANT, PAGE_TOKEN, FAKE_KEYS.meta, 'instagram.com', 'youtube.com', 'http', 'D0CKERVOL']) assert.ok(!meta()[0]!.raw.includes(secret), `the request carries ${secret.slice(0, 12)}`);
        const sql = world.sql().join('\n');
        for (const table of ['messages', 'conversations', 'interactions', 'comments', 'contacts', 'leads']) assert.doesNotMatch(sql, new RegExp(`\\b${table}\\b`), table);
        assert.ok(!printed().includes(SENDER), 'and no statement, log line or request of recall names the sender: the id is only compared with the allow-list');
    });

    it('cleans the message and cuts it to one bounded line before it is sent', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 0, second: 0, why: '' }));
        await ask(`video\nabout\u0000 docker\u202e ${'z'.repeat(2000)}`);
        const sent = meta()[0]!.body.messages[1].content as string;
        assert.ok(sent.startsWith('video about docker '));
        assert.ok(Array.from(sent).length <= MESSAGE_MAX_CHARS);
        assert.doesNotMatch(sent, /[\p{Cc}\p{Cf}]/u);
    });

    it('is the SAME system text on every call while the library is unchanged, and a new reel is one more last line (the provider\'s cache keeps hitting)', async () => {
        answerOn(world, 'api.meta.ai', ...[1, 2, 3].map(() => says({ is_content_request: true, match: 0, second: 0, why: '' })));
        await ask('video about docker');
        await ask('is there a reel about git?');
        const [first, second] = [meta()[0]!.body.messages[0].content as string, meta()[1]!.body.messages[0].content as string];
        assert.equal(first, second);
        assert.notEqual(meta()[0]!.body.messages[1].content, meta()[1]!.body.messages[1].content);
        stock(reel({ ig_media_id: '1004', posted_at: '2026-10-28T10:00:00.000Z', result: { summary: 'Newest.', key_moments: [] } }));
        await ask('video about docker');
        const third = meta()[2]!.body.messages[0].content as string;
        assert.ok(third.startsWith(`${first}\n4 | `), 'the three lines before it are untouched');
    });
});

describe('recallForTurn: no match, and not a request', () => {
    beforeEach(() => { open(); stock(DECORATORS()); stock(DOCKER()); });

    it('a content request that no reel covers is the honest fact: "No video on this topic yet", and no link', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 0, second: 0, why: 'nothing on kubernetes' }));
        const got = await ask('do you have a video about kubernetes?');
        assert.deepEqual(got, { line: NO_VIDEO_FACT, link: null, claim: null, match: null });
        assert.equal(events('recall.no_match').length, 1);
    });

    it('a message the model says is not a request for content adds nothing to the turn, however many reels the library has', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: false, match: 1, second: 5, why: 'a price question' }));
        assert.equal(await ask('how much is the video course?'), null);
        assert.equal(events('recall.not_a_request').length, 1);
    });

    it('a reel number the library does not have is no answer: asked once more, and with the second answer unusable too it is no recall, never a guess', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 9, second: 0, why: '' }), says({ is_content_request: true, match: 9, second: 0, why: '' }));
        assert.equal(await ask('video on docker?'), null);
        assert.equal(meta().length, 2, 'one more try, not a third');
        assert.deepEqual(events('recall.bad_answer').map((l) => l['attempt']), [1, 2]);
        assert.deepEqual(events('recall.failed').map((l) => l['outcome']), ['bad_output']);
    });

    it('a second try that answers well is used', async () => {
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 9, second: 0, why: '' }), says({ is_content_request: true, match: 2, second: 7, why: '' }));
        const got = await ask('video on docker?');
        assert.equal(got!.match!.second, 7);
        assert.equal(meta().length, 2);
    });
});

describe('recallForTurn: when nothing is asked', () => {
    it('a message with no content cue touches no setting, no table and no model: not one statement', async () => {
        open();
        stock(DOCKER());
        const before = [world.ai.statements.length, world.reel.statements.length];
        for (const text of ['How much is the plan?', 'السلام عليكم', '', '   ']) assert.equal(await ask(text), null, text);
        assert.deepEqual([world.ai.statements.length, world.reel.statements.length], before);
        assert.equal(meta().length, 0);
        assert.deepEqual(world.logs, [], 'and nothing is logged for it');
    });

    // The day's spend is `ai_usage`'s, which the gate's own tests read through SQL; here it is what the gate is handed, the way the indexer's tests hand theirs.
    for (const [name, arrange, reason] of [
        ['the memory switch is off (the default)', () => { open({ memory: false }); return {}; }, 'switch_off'],
        ['the sender is not on the allow-list', () => { open({ allow: ['99999'] }); return {}; }, 'not_allowed_sender'],
        ['nobody is on the allow-list', () => { open({ allow: [] }); return {}; }, 'not_allowed_sender'],
        ['no Meta key can answer the purpose', () => { open({ keys: [] }); return {}; }, 'no_key'],
        ['today\'s cap is spent', () => { open(); return { spentToday: async () => 3 }; }, 'budget'],
        ['today\'s spend cannot be read (a spend that is not known is spent)', () => { open(); return { spentToday: async () => { throw new Error('connection terminated'); } }; }, 'budget'],
    ] as const) {
        it(`the gate refuses when ${name}: no library read, no call, and the reason is logged as the gate logs it`, async () => {
            const gateDeps = arrange();
            stock(DOCKER());
            assert.equal(await ask('any video on docker?', { gateDeps: { ...GATE_DEPS, ...gateDeps } }), null);
            assert.equal(meta().length, 0);
            assert.equal(world.reel.statements.length, 0, 'the library was not even read');
            assert.deepEqual(world.logs.filter((l) => String(l.event).startsWith('perception.skipped:')).map((l) => [l.event, l['capability']]), [[`perception.skipped:${reason}`, 'memory']]);
        });
    }

    it('recall\'s own spend is one of the four purposes the daily cap counts', () => {
        assert.ok(MUSE_BUDGET_PURPOSES.includes('recall'));
    });

    it('under the cap it goes ahead, and a cap reached tells the owner once through the gate (the notice is the gate\'s)', async () => {
        open();
        stock(DOCKER());
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 1, second: 0, why: '' }));
        assert.ok(await ask('any video on docker?', { gateDeps: { ...GATE_DEPS, spentToday: async () => 2.99 } }));
        const told: unknown[] = [];
        assert.equal(await ask('any video on docker?', { gateDeps: { ...GATE_DEPS, spentToday: async () => 3, tellOwner: async (n) => { told.push(n); } } }), null);
        assert.equal(told.length, 1);
    });

    it('a spent cap is for THIS tenant: another tenant\'s spend does not refuse this one', async () => {
        open();
        stock(DOCKER());
        world.ai.seedUsage({ creator_id: OTHER_TENANT, purpose: 'recall', provider: 'meta', model: 'muse-spark-1.3', usd: 40, at: NOW });
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 1, second: 0, why: '' }));
        assert.ok(await ask('any video on docker?'));
    });

    it('asks whether a route can answer RECALL, not perception: a saved route for recall that cannot answer is no route, while perception still has one', async () => {
        open({ keys: ['meta'] });
        stock(DOCKER());
        assert.equal(await recallRouteReady(TENANT), true, 'with a Meta key, the default order reaches Meta for recall');
        // The operator saved a provider for recall that may not answer it (only Meta's models may): the purpose has no route, and perception's own has not changed.
        world.ai.setSetting('ai.routing', JSON.stringify({ recall: { provider: 'openai', model: 'gpt-4.1', effort: 'low' } }));
        assert.equal(await recallRouteReady(TENANT), false);
        assert.equal(await perceptionRouteReady(TENANT), true);
        assert.equal(await ask('any video on docker?'), null);
        assert.equal(meta().length, 0);
        assert.deepEqual(world.logs.filter((l) => String(l.event).startsWith('perception.skipped:')).map((l) => l.event), ['perception.skipped:no_key']);
        world.ai.settings.delete('ai.routing');
        world.ai.settings.delete('ai.providers.meta.api_key');
        assert.equal(await recallRouteReady(TENANT), false, 'and with no key at all, no route');
    });

    it('an empty library is no call: nothing was watched yet, and a reel that failed or is queued is not in it', async () => {
        open();
        assert.equal(await ask('any video on docker?'), null);
        stock(reel({ ig_media_id: 'p', status: 'pending', result: {} }));
        stock(reel({ ig_media_id: 'f', status: 'failed', result: { error: 'too_large' } }));
        stock(reel({ ig_media_id: 'n', permalink: null, youtube_url: null }));
        assert.equal(await ask('any video on docker?'), null);
        assert.equal(meta().length, 0);
        assert.equal(events('recall.empty_library').length, 2);
    });

    it('never reads another tenant\'s library', async () => {
        open();
        stock({ ...DOCKER(), creator_id: OTHER_TENANT });
        assert.equal(await ask('any video on docker?'), null);
        assert.equal(meta().length, 0, 'this tenant has no reel: nothing to ask');
        assert.ok(world.reel.statements.every((s) => s.params[0] === TENANT), 'every statement named this tenant');
    });
});

describe('recallForTurn: a failure is no recall, never an error', () => {
    beforeEach(() => { open(); stock(DECORATORS()); stock(DOCKER()); });
    const fails = (status: number) => () => jsonResponse(status, { error: { message: 'no' } });

    it('a refused key, no credit and a 429 end it at once: no second request, and the turn is as it would have been', async () => {
        for (const status of [401, 402, 429]) {
            answerOn(world, 'api.meta.ai', fails(status));
            assert.equal(await ask('any video on docker?'), null, String(status));
        }
        assert.equal(meta().length, 3, 'one request each');
        assert.deepEqual(events('recall.failed').map((l) => l['outcome']), ['auth', 'quota', 'rate']);
    });

    it('a 5xx is tried once more, and the second answer is used', async () => {
        answerOn(world, 'api.meta.ai', fails(503), says({ is_content_request: true, match: 2, second: 7, why: '' }));
        const got = await ask('any video on docker?');
        assert.equal(got!.match!.second, 7);
        assert.equal(meta().length, 2);
        assert.deepEqual(world.ai.usage.map((u) => u.outcome), ['server', 'ok']);
    });

    it('two 5xx in a row is no recall, after exactly two requests', async () => {
        answerOn(world, 'api.meta.ai', fails(503), fails(500));
        assert.equal(await ask('any video on docker?'), null);
        assert.equal(meta().length, 2);
    });

    it('an answer that is not JSON at all is a bad answer, tried once more', async () => {
        answerOn(world, 'api.meta.ai', chatAnswer('muse-spark-1.3', 'sorry, no'), says({ is_content_request: true, match: 1, second: 0, why: '' }));
        assert.ok(await ask('any video on decorators?'));
        assert.equal(meta().length, 2);
    });

    it('a call is given what is left of the step, and no retry is started when too little is: it would not finish', async () => {
        let clock = 0;
        answerOn(world, 'api.meta.ai', () => { clock += RECALL_STEP_BUDGET_MS - MIN_CALL_MS + 1; return fails(503)(); }, says({ is_content_request: true, match: 1, second: 0, why: '' }));
        assert.equal(await ask('any video on docker?', { now: () => clock }), null);
        assert.equal(meta().length, 1, 'less than MIN_CALL_MS was left, so the second request was never made');
        assert.equal(events('recall.out_of_time').length, 1);
        assert.deepEqual(events('recall.failed').map((l) => l['outcome']), ['timeout']);
    });

    it('a platform budget that is spent is no recall', async () => {
        world.ai.setSetting('ai.budget.daily_usd', '0.001');
        world.ai.seedUsage({ creator_id: null, purpose: 'dm', provider: 'meta', model: 'muse-spark-1.3', usd: 5, at: NOW });
        assert.equal(await ask('any video on docker?'), null);
        assert.equal(meta().length, 0);
    });

    it('anything that throws inside it, the library read included, is no recall too, and is logged', async () => {
        const got = await ask('any video on docker?', { library: async () => { throw new Error('connection terminated'); } });
        assert.equal(got, null);
        assert.deepEqual(events('recall.failed').map((l) => l['outcome']), ['unexpected']);
        const noGate = await ask('any video on docker?', { gate: async () => { throw new Error('boom'); } });
        assert.equal(noGate, null);
    });
});

describe('setRecallDeps: what the sales turn\'s tests use to say who may be recalled for', () => {
    it('replaces the gate and the library for every recall made without its own, and gives the previous ones back', async () => {
        const row = DOCKER();
        const previous = setRecallDeps({ gate: async () => ({ ok: true }), library: async () => [row] });
        assert.deepEqual(previous, {});
        // No settings, no key and no table are arranged: the answer comes from the stand-ins and the model call alone.
        answerOn(world, 'api.meta.ai', says({ is_content_request: true, match: 1, second: 0, why: '' }));
        configure(world, { memory: false, keys: ['meta'] });
        const got = await recallForTurn({ creatorId: TENANT, senderId: SENDER, text: 'any video on docker?' });
        assert.ok(got && got.link === 'https://www.instagram.com/reel/D0CKERVOL/');
        const restored = setRecallDeps(previous);
        assert.ok(restored.gate && restored.library);
    });

    it('a deps object given to one call wins over the installed ones', async () => {
        setRecallDeps({ gate: async () => ({ ok: true }), library: async () => [DOCKER()] });
        const got = await recallForTurn({ creatorId: TENANT, senderId: SENDER, text: 'any video on docker?' }, { gate: async () => ({ ok: false, reason: 'switch_off' }) });
        assert.equal(got, null);
    });
});

describe('the contract\'s numbers', () => {
    it('are the ones §3 states', () => {
        assert.equal(RECALL_PURPOSE, 'recall');
        assert.equal(RECALL_EFFORT, 'low');
        assert.equal(RECALL_MAX_TOKENS, 3000);
    });
});
