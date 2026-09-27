/**
 * The pick sweep (MONTEUR.md §6, §6.1): the claim and its attempts, the two calls, the saved pick,
 * and the hand-off. Gemini is stood in for with `setModelCaller`, the pool answers by SQL, and the
 * log sink is captured so the token lines are checked, not assumed.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TranscriptWord } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { setModelCaller, type CallModel, type ModelRequest } from '../studio/generate.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { ASK_POOL } from './copy.js';
import { EDITOR_MAX_OUTPUT, EDITOR_SCHEMA, EDITOR_THINKING } from './editor.js';
import { PICK_MAX_OUTPUT } from './pick.js';
import {
    CLAIM_SOURCE_SQL, EXHAUST_SOURCES_SQL, EXHAUSTED_PICK_ERROR, MAX_PICK_ATTEMPTS, PICK_STALE_MINUTES, setEditRetryWaits, sweepMonteur,
    transientModelError,
} from './sweep.js';
import { installFakeDb, type FakeDb } from './testDb.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '66666666-6666-4666-8666-666666666666';
const CLIP = '77777777-7777-4777-8777-777777777777';

/** L1 at 0 s … L20 at 95 s, each line one sentence of 4.5 s. */
const WORDS: TranscriptWord[] = Array.from({ length: 20 }, (_, i) => [i * 5, i * 5 + 4.5, `جملة${i + 1}.`] as TranscriptWord);

const PICK = {
    topic: 'NotebookLM يلخص الدروس',
    clips: [{ start_line: 3, end_line: 7, title: 'عنوان 3 كلمات', hook_type: 'promise', why: 'يبدأ بنتيجة', scores: { hook: 3, alone: 3, payoff: 2, send: 2 } }],
};
const COPY_ITEM = {
    clip: 1, first_line: '🔥 دفترك الذكي', body: '✅ يلخص لك الدرس\n💡 بدقيقة', ask_line: 'تبي تجربها؟ اكتب «{keyword}» 👇',
    tiktok_body: 'متحدث يشرح كيف يلخص NotebookLM الدرس',
    hashtags: ['#ai', 'notebook lm', '#اكسبلور', '#ذكاء_اصطناعي'], keyword_candidates: ['دفت', 'دفتر', 'ملاحظة'], variants: ['الدفتر', 'دفاتر'],
    question: 'تبي تجربه؟', pitch: 'شرحته في الكورس.', alt_text: 'متحدث يشرح NotebookLM',
};
const COPY = { clips: [COPY_ITEM] };
/** Two edits on the clip's own lines: L2 is «جملة4.» (15 s into the source), L3 «جملة5.». */
const EDIT = {
    clips: [{
        clip: 1, edits: [
            { line: 2, word: 'جملة4', kind: 'keyword', text: 'نقطة مهمة', sfx: 'whoosh' },
            { line: 3, word: 'جملة5.', kind: 'emoji', emoji: '💡', sfx: 'switch' },
        ],
    }],
};
/** The clip starts at 9.85 s: 15 − 9.85 and 20 − 9.85. */
const EDITS = [
    { t: 5.15, kind: 'keyword', text: 'نقطة مهمة', sfx: 'whoosh' },
    { t: 10.15, kind: 'emoji', emoji: '💡', sfx: 'switch' },
];

let db: FakeDb;
let source: Record<string, unknown> | null;
let handOffClaimed: boolean;
let calls: ModelRequest[];
let answers: Record<string, unknown | Error>;
let logs: { event: string; [k: string]: unknown }[];
let copyCalledAt: number;
let inFlight: string[];
let inFlightVariants: string[];
let saveClaimed: boolean;
let existingTexts: string[];
let recentCaptions: { caption: string; keyword: string }[];
let previousCaller: CallModel;
let reelsPerVideo: number;
let previousSink: ReturnType<typeof setLogSink>;
let previousWaits: readonly number[];

beforeEach(() => {
    db = installFakeDb();
    source = { id: SOURCE, creator_id: TENANT, name: 'lesson.mp4', path: '/v/lesson.mp4', duration: 100, words: WORDS, pick: null, attempts: 1 };
    handOffClaimed = true;
    calls = [];
    answers = { 'monteur.pick': PICK, 'monteur.copy': COPY, 'monteur.edit': EDIT };
    reelsPerVideo = 1;
    logs = [];
    copyCalledAt = -1;
    inFlight = [];
    inFlightVariants = [];
    saveClaimed = true;
    existingTexts = [];
    recentCaptions = [];
    previousSink = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    previousWaits = setEditRetryWaits([0, 0]);
    previousCaller = setModelCaller(async (req) => {
        calls.push(req);
        if (req.purpose === 'monteur.copy') copyCalledAt = db.statements.length;
        // `{ queue: [...] }` answers one call each, and repeats its last.
        const entry = answers[req.purpose] as unknown;
        const queue = entry && typeof entry === 'object' && 'queue' in entry ? (entry as { queue: unknown[] }).queue : null;
        const answer = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : entry;
        if (answer instanceof Error) throw answer;
        req.onUsage?.({ model: 'gemini-test', tokensIn: 1000, tokensOut: 200, thinking: 50 });
        return answer;
    });
    db.routes.push(
        [/^SELECT c\.id AS creator_id FROM creators c/, () => ({ rows: [] })],
        [/^UPDATE monteur_sources SET status = 'failed', claimed_at = NULL/, () => ({ rows: [], rowCount: 0 })],
        [/^WITH picked AS \( SELECT s\.id FROM monteur_sources s/, () => ({ rows: source ? [source] : [] })],
        [/FROM studio_settings/, () => ({ rows: [{ ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, reels_per_video: reelsPerVideo } }] })],
        [/^SELECT lessons FROM studio_lessons/, () => ({ rows: [{ lessons: [{ rule: 'ابدأ بالنتيجة', evidence: 'skip 40%' }] }] })],
        [/^SELECT caption FROM post_insights/, () => ({ rows: [{ caption: 'هذي أسرع طريقة تلخص فيها درس كامل\nbody' }, { caption: 'غلطة يسويها الكل' }] })],
        [/^SELECT text FROM clip_drafts/, () => ({ rows: existingTexts.map((text) => ({ text })) })],
        [/^SELECT copy->>'keyword' AS keyword, copy->'variants' AS variants FROM clip_drafts/, () => ({
            rows: [...inFlight.map((keyword) => ({ keyword, variants: [] })), ...(inFlightVariants.length ? [{ keyword: null, variants: inFlightVariants }] : [])],
        })],
        [/^UPDATE monteur_sources SET pick = \$2::jsonb/, () => ({ rows: [], rowCount: saveClaimed ? 1 : 0 })],
        [/^SELECT copy->>'caption' AS caption, copy->>'keyword' AS keyword FROM clip_drafts/, () => ({ rows: recentCaptions })],
        [/^UPDATE monteur_sources SET status = 'rendering'/, () => ({ rows: handOffClaimed ? [{ id: SOURCE }] : [] })],
        [/^UPDATE monteur_sources SET status = 'no_clips'/, () => ({ rows: [{ id: SOURCE }] })],
        [/^INSERT INTO clip_drafts/, () => ({ rows: [{ id: CLIP }] })],
        [/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: 'job-render', kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] })],
    );
});

afterEach(() => {
    db.restore();
    setModelCaller(previousCaller);
    setLogSink(previousSink);
    setEditRetryWaits(previousWaits);
});

const later = () => ({ deadline: Date.now() + 250_000 });
const savedCopy = () => JSON.parse(db.ran(/^INSERT INTO clip_drafts/)[0]!.params[13]);

describe('the claim — the SQL', () => {
    it('takes one source, transcribed or with a claim 10 minutes stale, atomically, under 3 attempts', () => {
        const sql = CLAIM_SOURCE_SQL.replace(/\s+/g, ' ');
        assert.match(sql, /FOR UPDATE OF s SKIP LOCKED/);
        assert.match(sql, /LIMIT 1/);
        assert.match(sql, /s\.attempts < \$2/);
        assert.match(sql, /s\.status = 'transcribed' OR \(s\.status = 'picking' AND s\.claimed_at < NOW\(\) - make_interval\(mins => \$1\)\)/);
        assert.match(sql, /attempts = s\.attempts \+ 1/);
        assert.match(sql, /c\.is_active = TRUE/, 'a deactivated tenant’s videos wait');
        assert.match(sql, /RETURNING .*s\.pick/, 'with any pick saved by an earlier attempt');
        assert.equal(PICK_STALE_MINUTES, 10);
        assert.equal(MAX_PICK_ATTEMPTS, 3);
    });

    it('fails a stale claim that used its third attempt, before claiming', async () => {
        source = null;
        await sweepMonteur(later());
        const [exhaust] = db.statements;
        const [claim] = db.ran(/^WITH picked AS/);
        assert.equal(exhaust!.sql, EXHAUST_SOURCES_SQL.replace(/\s+/g, ' ').trim());
        assert.deepEqual(exhaust!.params, [10, 3, EXHAUSTED_PICK_ERROR]);
        assert.match(exhaust!.sql, /attempts >= \$2/);
        assert.deepEqual(claim!.params, [10, 3]);
    });
});

describe('sweepMonteur — a pick', () => {
    it('makes one Monteur call, one Marketer call and one Editor call, then hands the clip to the worker', async () => {
        const result = await sweepMonteur(later());
        assert.deepEqual(result.pick, { source_id: SOURCE, outcome: 'rendering', clips: 1 });
        assert.deepEqual(calls.map((c) => c.purpose), ['monteur.pick', 'monteur.copy', 'monteur.edit']);

        const [pick, copy] = calls;
        assert.match(pick!.turns[0]!.text, /^L3 \[00:10\.0\] جملة3\.$/m, 'numbered lines, L<n> [mm:ss.s] text');
        assert.match(pick!.turns[0]!.text, /^Pick up to 3 clips/m, 'reels_per_video + 2 candidates');
        assert.match(pick!.turns[0]!.text, /- هذي أسرع طريقة تلخص فيها درس كامل\n- غلطة يسويها الكل/, 'the openings of the two most-viewed posts');
        assert.match(pick!.turns[0]!.text, /- ابدأ بالنتيجة/, 'the latest lessons go in');
        assert.match(pick!.turns[0]!.text, /Never pick a moment about: MCP/, 'and the avoid terms');
        assert.equal(pick!.maxOutputTokens, PICK_MAX_OUTPUT);
        assert.equal(PICK_MAX_OUTPUT, 8192);
        assert.equal(copy!.maxOutputTokens, 8192);
        assert.ok(pick!.deadline && pick!.deadline <= Date.now() + 250_000, 'one deadline for every model the chain tries');
        assert.ok(pick!.system.length < 2500, 'a short system prompt');
        assert.match(copy!.turns[0]!.text, /\[1\] «عنوان 3 كلمات»\nL3 \[00:10\.0\]/, 'the clip’s own lines');
        assert.ok(!copy!.turns[0]!.text.includes('جملة1.'), 'and only those');

        const [clip] = db.ran(/^INSERT INTO clip_drafts/);
        const [creator, sourceId, rank, start, end, title, hook, why, score, topic, hookType, scores, text] = clip!.params;
        assert.deepEqual([creator, sourceId, rank, start, end], [TENANT, SOURCE, 1, 9.85, 34.8]);
        assert.equal(title, 'عنوان ٣ كلمات', 'Arabic-Indic digits in the burned-in title');
        assert.deepEqual([hook, why, score], ['جملة3.', 'يبدأ بنتيجة', 9]);
        assert.deepEqual([topic, hookType, JSON.parse(scores)], ['NotebookLM يلخص الدروس', 'promise', { hook: 3, alone: 3, payoff: 2, send: 2 }]);
        assert.equal(text, 'جملة3. جملة4. جملة5. جملة6. جملة7.');

        const saved = savedCopy();
        assert.equal(saved.keyword, 'دفتر', 'the 3-letter candidate is passed over');
        assert.equal(saved.keyword_create, true);
        assert.deepEqual(saved.variants, ['دفاتر'], 'a variant containing the keyword is redundant under substring matching');
        assert.deepEqual(saved.hashtags, ['ai', 'notebook_lm', 'ذكاء_اصطناعي'], '#اكسبلور is on the blocklist');
        assert.equal(saved.caption, '🔥 دفترك الذكي\n\n✅ يلخص لك الدرس\n💡 بدقيقة\n\nتبي تجربها؟ اكتب «دفتر» 👇\n\n#ai #notebook_lm #ذكاء_اصطناعي',
            'first line, body, the ask as the model wrote it, hashtags: no save line, no second ask');
        assert.ok(saved.tiktok_caption.includes('رابطه في البايو'));
        assert.ok(!saved.tiktok_caption.includes('«دفتر»'), 'TikTok can’t auto-reply: no ask');
        assert.match(saved.dm, /^هلا \{username\} 👋\n\nتبي تجربه؟\n\nشرحته في الكورس\./);

        const [job] = db.ran(/^INSERT INTO studio_jobs/);
        const payload = JSON.parse(job!.params[2]);
        assert.deepEqual(payload.cta, { line1: 'اكتب في التعليقات «دفتر»', line2: 'ويوصلك الرابط بالخاص 📩' });
        assert.deepEqual(payload.cta_tiktok, { line1: 'رابطه في البايو', line2: 'ادخل البروفايل واضغط الرابط 👆' });
        assert.deepEqual(payload.words[0], [0.15, 4.65, 'جملة3.'], 'relative to the clip');
    });

    it('saves the pick before the Marketer’s call', async () => {
        await sweepMonteur(later());
        const save = db.statements.findIndex((s) => /^UPDATE monteur_sources SET pick = \$2::jsonb/.test(s.sql));
        assert.ok(save >= 0 && save < copyCalledAt, 'a copy failure then costs no second pick');
        const record = JSON.parse(db.statements[save]!.params[1]);
        assert.equal(record.saved.clips.length, 1);
        assert.equal(record.saved.topic, 'NotebookLM يلخص الدروس');
        assert.match(db.statements[save]!.sql, /WHERE id = \$1 AND status = 'picking' AND attempts = \$3/);
    });

    it('spends nothing more when saving the pick finds another attempt holds the claim', async () => {
        saveClaimed = false;
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'lost');
        assert.deepEqual(calls.map((c) => c.purpose), ['monteur.pick'], 'no copy call');
        assert.equal(db.ran(/^INSERT INTO clip_drafts/).length, 0);
    });

    it('retries a failed copy on the saved pick, without sending the transcript again', async () => {
        await sweepMonteur(later());
        const record = JSON.parse(db.ran(/^UPDATE monteur_sources SET pick = \$2::jsonb/)[0]!.params[1]);
        calls = [];
        db.statements.length = 0;
        source = { ...source, pick: record, attempts: 2 };
        const result = await sweepMonteur(later());
        assert.deepEqual(calls.map((c) => c.purpose), ['monteur.copy', 'monteur.edit']);
        assert.equal(result.pick?.outcome, 'rendering');
    });

    it('logs each call’s tokens in and out as monteur.pick and monteur.copy — readable, not redacted', async () => {
        await sweepMonteur(later());
        for (const event of ['monteur.pick', 'monteur.copy']) {
            const line = logs.find((l) => l.event === event);
            assert.ok(line, event);
            assert.deepEqual(line!.usage, { in: 1000, out: 250, thinking: 50 }, event);
            assert.equal(line!.model, 'gemini-test');
            assert.ok(!JSON.stringify(line).includes('[redacted]'), 'the logger redacts any key with "token" in it');
        }
    });

    it('marks a video with nothing worth a reel no_clips, after one call', async () => {
        answers['monteur.pick'] = { topic: 't', clips: [{ ...PICK.clips[0], scores: { hook: 1, alone: 3, payoff: 3, send: 3 } }] };
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'no_clips');
        assert.deepEqual(calls.map((c) => c.purpose), ['monteur.pick']);
        assert.equal(db.ran(/^INSERT INTO clip_drafts/).length, 0);
        // The operator is told why, not left with an empty "no clips".
        const [update] = db.ran(/^UPDATE monteur_sources SET status = 'no_clips'/);
        assert.match(String(update!.params[3]), /rated all 1 moment\(s\) it proposed below the bar/);
    });

    it('records why proposed clips were dropped when none is kept', async () => {
        existingTexts = ['جملة3. جملة4. جملة5. جملة6. جملة7.'];
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'no_clips');
        const [update] = db.ran(/^UPDATE monteur_sources SET status = 'no_clips'/);
        assert.match(String(update!.params[3]), /repeats a reel already made/);
        assert.match(JSON.parse(String(update!.params[1])).problems[0], /repeats a reel already made/);
    });

    it('spends no call on a transcript with no words, or one shorter than the shortest clip', async () => {
        source = { ...source, words: [] };
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'no_clips');
        source = { ...source, words: WORDS.slice(0, 3) }; // 14.5 s of speech, min_seconds 20
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'no_clips');
        assert.equal(calls.length, 0);
    });

    it('asks once more when the answer can’t be cut, and keeps the better answer', async () => {
        let n = 0;
        setModelCaller(async (req) => {
            calls.push(req);
            if (req.purpose.startsWith('monteur.pick')) {
                n += 1;
                return n === 1 ? { ...PICK, clips: [{ ...PICK.clips[0], start_line: 90, end_line: 95 }] } : PICK;
            }
            return COPY;
        });
        const result = await sweepMonteur(later());
        assert.deepEqual(calls.map((c) => c.purpose), ['monteur.pick', 'monteur.pick-repair', 'monteur.copy', 'monteur.edit']);
        assert.match(calls[1]!.turns.at(-1)!.text, /clip 1: L90–L95 is not a range of lines/);
        assert.equal(result.pick?.outcome, 'rendering');
    });

    it('drops a repeat of a reel already made', async () => {
        existingTexts = ['جملة3. جملة4. جملة5. جملة6. جملة7.'];
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'no_clips');
    });
});

const renderPayloads = () => db.ran(/^INSERT INTO studio_jobs/).map((j) => JSON.parse(j.params[2]));
const handOffRecord = () => JSON.parse(db.ran(/^UPDATE monteur_sources SET status = 'rendering'/)[0]!.params[1]);

describe('sweepMonteur — the Editor (MONTEUR.md §6.2)', () => {
    it('makes ONE call after the Marketer, on each clip’s own lines and clock', async () => {
        await sweepMonteur(later());
        const edit = calls.find((c) => c.purpose === 'monteur.edit');
        assert.ok(edit, 'an Editor call');
        assert.equal(calls.filter((c) => c.purpose === 'monteur.edit').length, 1);
        assert.match(edit!.system, /^You are the editor of short vertical reels/);
        assert.deepEqual(edit!.schema, EDITOR_SCHEMA);
        assert.equal(edit!.maxOutputTokens, EDITOR_MAX_OUTPUT);
        assert.equal(edit!.thinkingBudget, EDITOR_THINKING);
        assert.ok(edit!.deadline && edit!.deadline <= Date.now() + 250_000, 'inside the sweep’s deadline');
        const text = edit!.turns[0]!.text;
        assert.match(text, /^C1\nL1 \[00:00\.\d\] جملة3\.\nL2 \[00:05\.\d\] جملة4\./, 'C<n>, then the clip’s lines from L1, on its clock');
        assert.ok(!text.includes('جملة2.') && !text.includes('جملة8.'), 'only the clip’s own lines');
    });

    it('stores each clip’s edits, and sends them in its render with t on the clip’s clock', async () => {
        await sweepMonteur(later());
        const [insert] = db.ran(/^INSERT INTO clip_drafts/);
        assert.match(insert!.sql, /\bedits\b/);
        assert.deepEqual(JSON.parse(insert!.params[14]), EDITS);
        assert.deepEqual(renderPayloads()[0]!.edits, EDITS);
    });

    it('logs monteur.edit with its tokens, and records the call on the source’s pick', async () => {
        await sweepMonteur(later());
        const line = logs.find((l) => l.event === 'monteur.edit');
        assert.ok(line, 'monteur.edit');
        assert.deepEqual(line!.usage, { in: 1000, out: 250, thinking: 50 });
        assert.equal(line!.edits, 2);
        assert.deepEqual(handOffRecord().edit, { model: 'gemini-test', tokens_in: 1000, tokens_out: 250 });
    });

    it('a failed Editor call never holds a reel back: it renders with no edits, and the failure is logged', async () => {
        answers['monteur.edit'] = new Error('Gemini request failed [HTTP 503]');
        const result = await sweepMonteur(later());
        assert.deepEqual(result.pick, { source_id: SOURCE, outcome: 'rendering', clips: 1 });
        assert.deepEqual(JSON.parse(db.ran(/^INSERT INTO clip_drafts/)[0]!.params[14]), []);
        assert.deepEqual(renderPayloads()[0]!.edits, []);
        const failed = logs.find((l) => l.event === 'monteur.edit_failed');
        assert.ok(failed, 'the failure is logged');
        assert.match(String(failed!.error), /HTTP 503/);
        assert.equal(handOffRecord().edit.error, 'Gemini request failed [HTTP 503]');
        assert.equal(db.ran(/^UPDATE monteur_sources SET error = \$2/).length, 0, 'the attempt did not fail');
    });

    it('a busy model is asked again: one 503, then the edits', async () => {
        answers['monteur.edit'] = { queue: [new Error('Gemini request failed [HTTP 503]: This model is currently experiencing high demand.'), EDIT] };
        await sweepMonteur(later());
        assert.equal(calls.filter((c) => c.purpose === 'monteur.edit').length, 2);
        assert.deepEqual(renderPayloads()[0]!.edits, EDITS);
        assert.ok(logs.find((l) => l.event === 'monteur.edit_retry'), 'the retry is logged');
        assert.ok(!logs.find((l) => l.event === 'monteur.edit_failed'));
    });

    it('a bad request or a bad answer is not retried', async () => {
        answers['monteur.edit'] = new Error('Gemini answered with text that is not valid JSON');
        await sweepMonteur(later());
        assert.equal(calls.filter((c) => c.purpose === 'monteur.edit').length, 1);
        assert.equal(transientModelError(new Error('HTTP 400 invalid argument')), false);
        assert.equal(transientModelError(new Error('Gemini request failed [HTTP 429]')), true);
    });

    it('an answer with nothing usable is a reel without edits, not a failure', async () => {
        answers['monteur.edit'] = { clips: [{ clip: 1, edits: [{ line: 99, word: 'x', kind: 'keyword', text: 'y', sfx: 'none' }] }, { clip: 7, edits: [] }] };
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'rendering');
        assert.deepEqual(renderPayloads()[0]!.edits, []);
    });

    it('gives each clip its own edits, matched by C<n>', async () => {
        reelsPerVideo = 2;
        answers['monteur.pick'] = {
            topic: PICK.topic,
            clips: [PICK.clips[0], { ...PICK.clips[0], start_line: 11, end_line: 15, title: 'عنوان ثاني', scores: { hook: 3, alone: 3, payoff: 2, send: 1 } }],
        };
        answers['monteur.copy'] = { clips: [{ ...COPY_ITEM, clip: 1 }, { ...COPY_ITEM, clip: 2, keyword_candidates: ['ملاحظة'] }] };
        answers['monteur.edit'] = {
            clips: [
                { clip: 2, edits: [{ line: 1, word: 'جملة11', kind: 'tool', text: 'NotebookLM', sfx: 'whoosh' }] },
                { clip: 1, edits: [{ line: 2, word: 'جملة4', kind: 'punch', sfx: 'click' }] },
            ],
        };
        assert.equal((await sweepMonteur(later())).pick?.clips, 2);
        const stored = db.ran(/^INSERT INTO clip_drafts/).map((i) => JSON.parse(i.params[14]));
        assert.deepEqual(stored, [[{ t: 5.15, kind: 'punch', sfx: 'click' }], [{ t: 0.15, kind: 'tool', text: 'NotebookLM', sfx: 'whoosh' }]]);
        assert.deepEqual(renderPayloads().map((p) => p.edits), stored);
    });

    it('numbers the clips that got copy: a clip the Marketer dropped is not sent, and edits land on the right clip', async () => {
        reelsPerVideo = 2;
        answers['monteur.pick'] = {
            topic: PICK.topic,
            clips: [PICK.clips[0], { ...PICK.clips[0], start_line: 11, end_line: 15, title: 'عنوان ثاني', scores: { hook: 3, alone: 3, payoff: 2, send: 1 } }],
        };
        // Clip 1's only candidate is unusable, so only clip 2 reaches the Editor, as C1.
        answers['monteur.copy'] = { clips: [{ ...COPY_ITEM, clip: 1, keyword_candidates: ['دفت'] }, { ...COPY_ITEM, clip: 2 }] };
        answers['monteur.edit'] = { clips: [{ clip: 1, edits: [{ line: 1, word: 'جملة11', kind: 'tool', text: 'NotebookLM', sfx: 'whoosh' }] }] };
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.clips, 1);
        const text = calls.find((c) => c.purpose === 'monteur.edit')!.turns[0]!.text;
        assert.match(text, /^C1\nL1 \[00:00\.\d\] جملة11\./);
        assert.ok(!text.includes('C2') && !text.includes('جملة3.'), 'the dropped clip is not sent');
        const [insert] = db.ran(/^INSERT INTO clip_drafts/);
        assert.equal(insert!.params[5], 'عنوان ثاني');
        assert.deepEqual(JSON.parse(insert!.params[14]), [{ t: 0.15, kind: 'tool', text: 'NotebookLM', sfx: 'whoosh' }]);
    });
});

describe('sweepMonteur — keywords and asks', () => {
    it('shares a keyword a reel in flight already asks for, and still marks it for a campaign', async () => {
        inFlight = ['دفتر'];
        await sweepMonteur(later());
        assert.equal(savedCopy().keyword, 'دفتر');
        assert.equal(savedCopy().keyword_create, true);
        assert.match(calls[1]!.turns[0]!.text, /Keywords in use: .*دفتر/);
    });

    it('never takes a keyword overlapping one in flight', async () => {
        inFlight = ['دفترها'];
        await sweepMonteur(later());
        assert.equal(savedCopy().keyword, 'ملاحظة');
    });

    it('never takes a keyword equal to, or overlapping, another reel’s variant', async () => {
        inFlightVariants = ['دفتر'];
        await sweepMonteur(later());
        assert.equal(savedCopy().keyword, 'ملاحظة', 'equal to a variant is never shared: two campaigns would answer it');
        assert.match(calls[1]!.turns[0]!.text, /Keywords in use: .*دفتر/, 'and the Marketer is told');
    });

    it('falls back to the pool when the model repeats a recent ask — never to cta.instagramAsk', async () => {
        recentCaptions = [{ caption: 'x\n\nتبي تجربها؟ اكتب «برومبت» 👇\n\n#y', keyword: 'برومبت' }];
        await sweepMonteur(later());
        const caption: string = savedCopy().caption;
        const used = ASK_POOL.ar.find((a) => caption.includes(a.split('{keyword}').join('دفتر')));
        assert.ok(used, caption);
        assert.ok(!caption.includes('بالتعليقات ويوصلك رابط الكورس بالخاص'), 'the tenant’s own caption ask is not the fallback');
        assert.match(calls[1]!.turns[0]!.text, /Recent asks \(don't reuse\):\n- تبي تجربها؟ اكتب «\{keyword\}» 👇/);
    });

    it('falls back to the pool when the model’s ask has no {keyword}', async () => {
        answers['monteur.copy'] = { clips: [{ ...COPY_ITEM, ask_line: 'علّق بكلمة دفتر' }] };
        await sweepMonteur(later());
        assert.ok(ASK_POOL.ar.some((a) => savedCopy().caption.includes(a.split('{keyword}').join('دفتر'))));
    });

    it('matches numbered answers by number only, never by position', async () => {
        answers['monteur.copy'] = { clips: [{ ...COPY_ITEM, clip: 2 }] };
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'retry');
        assert.match(result.pick?.error ?? '', /wrote nothing for this clip/);
    });
});

describe('sweepMonteur — auto mode', () => {
    const autoSelect = /^SELECT c\.id, c\.creator_id, c\.error FROM clip_drafts c/;

    it('approves auto-mode reels first, and reports it', async () => {
        const result = await sweepMonteur(later());
        assert.deepEqual(result.auto, { approved: 0, refused: 0 });
        const order = db.statements.map((st) => st.sql);
        const auto = order.findIndex((sql) => autoSelect.test(sql));
        assert.ok(auto > 0 && auto < order.findIndex((sql) => /^WITH picked AS/.test(sql)), 'after the exhausted claims, before the pick');
    });

    it('still approves when there is no time left for a pick', async () => {
        const result = await sweepMonteur({ deadline: Date.now() + 30_000 });
        assert.equal(result.skipped, 'no_time_for_pick');
        assert.equal(db.ran(autoSelect).length, 1);
    });

    it('never lets a failure there stop the pick', async () => {
        db.routes.unshift([autoSelect, () => { throw new Error('connection reset'); }]);
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'rendering');
        assert.deepEqual(result.auto, { approved: 0, refused: 0, error: 'connection reset' });
        assert.ok(logs.some((l) => l.event === 'monteur.auto_failed'));
    });
});

describe('sweepMonteur — attempts', () => {
    it('keeps the claim on a failed attempt, so the source waits 10 minutes before the next', async () => {
        answers['monteur.pick'] = new Error('Gemini request failed [HTTP 503]');
        const result = await sweepMonteur(later());
        assert.deepEqual(result.pick, { source_id: SOURCE, outcome: 'retry', error: 'Gemini request failed [HTTP 503]' });
        const [update] = db.ran(/^UPDATE monteur_sources SET error = \$2/);
        assert.deepEqual(update!.params, [SOURCE, 'Gemini request failed [HTTP 503]', 1]);
        assert.match(update!.sql, /WHERE id = \$1 AND status = 'picking' AND attempts = \$3/);
        assert.equal(db.ran(/SET status = 'failed', error = \$2/).length, 0);
    });

    it('fails the source on the third failed attempt', async () => {
        source = { ...source, attempts: 3 };
        answers['monteur.copy'] = new Error('Gemini returned no content');
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'failed');
        const [failed] = db.ran(/^UPDATE monteur_sources SET status = 'failed', error = \$2/);
        assert.deepEqual(failed!.params, [SOURCE, 'Gemini returned no content', 3]);
    });

    it('writes nothing when another attempt took the claim meanwhile', async () => {
        handOffClaimed = false;
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'lost');
        assert.equal(db.ran(/^INSERT INTO clip_drafts|^INSERT INTO studio_jobs/).length, 0);
    });

    it('fails the attempt when no clip got a usable keyword, rather than saving it half-written', async () => {
        answers['monteur.copy'] = { clips: [{ ...COPY_ITEM, keyword_candidates: ['two words', 'دفت'] }] };
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'retry');
        assert.match(result.pick?.error ?? '', /No usable comment keyword.*«دفت» is under 4 letters/);
        assert.equal(db.ran(/^INSERT INTO clip_drafts/).length, 0);
    });

    it('starts no pick without time left for two calls', async () => {
        const result = await sweepMonteur({ deadline: Date.now() + 30_000 });
        assert.equal(result.skipped, 'no_time_for_pick');
        assert.equal(db.ran(/^WITH picked AS/).length, 0);
        assert.equal(calls.length, 0);
    });
});
