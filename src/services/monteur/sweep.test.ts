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
import { EDITOR_MAX_OUTPUT, EDITOR_SCHEMA, EDITOR_THINKING, editorSchema, HUMAN_TOUCHES_PROMPT } from './editor.js';
import { PICK_MAX_OUTPUT } from './pick.js';
import {
    CLAIM_SOURCE_SQL, EXHAUST_SOURCES_SQL, EXHAUSTED_PICK_ERROR, MAX_PICK_ATTEMPTS, PICK_STALE_MINUTES, setEditRetryWaits, sweepMonteur,
    transientModelError,
} from './sweep.js';
import { installFakeDb, type FakeDb } from './testDb.js';
import type { ThinkTry } from './think.js';

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

/**
 * The same edits with the human touches, on the clip's lines: L1 «جملة3.» at 0.15 s (inside the
 * first 0.8 s), L2 at 5.15, L3 at 10.15, L4 at 15.15, L5 «جملة7.» at 20.15, in a 24.95 s clip.
 */
const EDIT_HUMAN = {
    clips: [{
        ...EDIT.clips[0]!,
        emphasis: [{ line: 2, word: 'جملة4' }, { line: 1, word: 'جملة3' }],
        doodles: [{ line: 3, word: 'جملة5', shape: 'circle', target: 'caption' }, { line: 4, word: 'جملة6', shape: 'heart', target: 'caption' }],
        transitions: [{ line: 4, word: 'جملة6', kind: 'flash' }],
        cuts: [{ line: 4, word: 'جملة6', shot: 'wide' }, { line: 2, word: 'جملة4', shot: 'close' }],
        freezes: [{ line: 3, word: 'جملة5', text: 'لحظة' }],
        behind: [{ line: 5, word: 'جملة7', text: 'مهم جدا' }],
    }],
};
/** What the sweep stores for EDIT_HUMAN: the clip's clock, L1's emphasis and the heart dropped, the cuts in time order. */
const DIRECTION = {
    cuts: [{ t: 5.15, shot: 'close' }, { t: 15.15, shot: 'wide' }],
    doodles: [{ t: 10.15, shape: 'circle', target: 'caption' }],
    freezes: [{ t: 10.15, text: 'لحظة' }],
    transitions: [{ t: 15.15, kind: 'flash' }],
    behind: [{ t: 20.15, text: 'مهم جدا' }],
    emphasis: [5.15],
};
const NO_TOUCHES = { cuts: [], doodles: [], freezes: [], transitions: [], behind: [], emphasis: [] };

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
let human: boolean | undefined;
let previousSink: ReturnType<typeof setLogSink>;
let previousWaits: readonly number[];

beforeEach(() => {
    db = installFakeDb();
    source = { id: SOURCE, creator_id: TENANT, name: 'lesson.mp4', path: '/v/lesson.mp4', duration: 100, words: WORDS, pick: null, attempts: 1 };
    handOffClaimed = true;
    calls = [];
    answers = { 'monteur.pick': PICK, 'monteur.copy': COPY, 'monteur.edit': EDIT };
    reelsPerVideo = 1;
    human = undefined;
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
        // A source the sweep already handed back ($3) is not claimed again in the same sweep.
        [/^WITH picked AS \( SELECT s\.id FROM monteur_sources s/, (p) => ({ rows: source && !(p[2] ?? []).includes(source.id) ? [source] : [] })],
        [/FROM studio_settings/, () => ({
            rows: [{ ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, reels_per_video: reelsPerVideo, ...(human === undefined ? {} : { human }) } }],
        })],
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
        assert.match(sql, /AND NOT \(s\.id = ANY\(\$3::uuid\[\]\)\)/, 'never one this sweep already handed back, waiting for the Mac');
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
        assert.deepEqual(claim!.params, [10, 3, []], 'and no source this sweep already handed back');
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
        assert.deepEqual(Object.keys(payload.brand).sort(), ['accent', 'direction', 'font', 'style']);
        assert.equal(payload.brand.style, 'classic', 'the default style');
    });

    it('sends the tenant’s edit style to the worker as brand.style', async () => {
        db.routes.unshift([/FROM studio_settings/, () => ({ rows: [{ ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, style: 'paper' } }] })]);
        await sweepMonteur(later());
        const [job] = db.ran(/^INSERT INTO studio_jobs/);
        const payload = JSON.parse(job!.params[2]);
        assert.equal(payload.brand.style, 'paper');
        assert.equal(payload.brand.font, ELAMIR_SETTINGS.brand.fonts.display);
        assert.equal(payload.brand.direction, ELAMIR_SETTINGS.brand.direction);
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

describe('sweepMonteur — the human touches (MONTEUR.md §6.2)', () => {
    const insert = () => db.ran(/^INSERT INTO clip_drafts/)[0]!;
    const editCall = () => calls.find((c) => c.purpose === 'monteur.edit')!;

    it('asks for them by default, and stores the plan in clip_drafts.direction on the clip’s clock', async () => {
        answers['monteur.edit'] = EDIT_HUMAN;
        await sweepMonteur(later());
        assert.deepEqual(editCall().schema, EDITOR_SCHEMA);
        assert.ok(editCall().system.includes(HUMAN_TOUCHES_PROMPT));
        assert.match(insert().sql, /\(creator_id, source_id, .*, copy, edits, direction\) VALUES \(.*\$15::jsonb, \$16::jsonb\)/);
        assert.deepEqual(JSON.parse(insert().params[15]), DIRECTION);
        assert.deepEqual(JSON.parse(insert().params[14]), EDITS, 'the edits as before');
        const line = logs.find((l) => l.event === 'monteur.edit');
        assert.equal(line!.touches, 7);
    });

    it('sends the plan in the render: direction without emphasis and behind, which ride beside it', async () => {
        answers['monteur.edit'] = EDIT_HUMAN;
        await sweepMonteur(later());
        const [payload] = renderPayloads();
        const { emphasis, behind, ...rest } = DIRECTION;
        assert.deepEqual(payload.direction, rest);
        assert.deepEqual(Object.keys(payload.direction), ['cuts', 'doodles', 'freezes', 'transitions']);
        assert.deepEqual(payload.emphasis, emphasis);
        assert.deepEqual(payload.behind, behind);
        assert.deepEqual(payload.edits, EDITS);
    });

    it('an answer without touches is an empty plan, sent as empty lists', async () => {
        await sweepMonteur(later());
        assert.deepEqual(JSON.parse(insert().params[15]), NO_TOUCHES);
        const [payload] = renderPayloads();
        assert.deepEqual([payload.direction, payload.emphasis, payload.behind], [{ cuts: [], doodles: [], freezes: [], transitions: [] }, [], []]);
    });

    it('switched off: the Editor is not asked for them, nothing is stored, and the render carries none, whatever the answer holds', async () => {
        human = false;
        answers['monteur.edit'] = EDIT_HUMAN;
        await sweepMonteur(later());
        assert.deepEqual(editCall().schema, editorSchema(false));
        assert.ok(!editCall().system.includes('Human touches'));
        assert.equal(insert().params[15], null, 'SQL NULL, not the JSON null');
        assert.deepEqual(JSON.parse(insert().params[14]), EDITS, 'the edits still go out');
        const [payload] = renderPayloads();
        for (const key of ['direction', 'emphasis', 'behind']) assert.ok(!(key in payload), key);
        assert.equal(logs.find((l) => l.event === 'monteur.edit')!.touches, 0);
    });

    it('a failed Editor call stores no plan and sends nothing new', async () => {
        answers['monteur.edit'] = new Error('Gemini request failed [HTTP 400]');
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'rendering');
        assert.equal(insert().params[15], null);
        const [payload] = renderPayloads();
        for (const key of ['direction', 'emphasis', 'behind']) assert.ok(!(key in payload), key);
    });

    it('a clip the answer skipped gets no plan; the other gets its own', async () => {
        reelsPerVideo = 2;
        answers['monteur.pick'] = {
            topic: PICK.topic,
            clips: [PICK.clips[0], { ...PICK.clips[0], start_line: 11, end_line: 15, title: 'عنوان ثاني', scores: { hook: 3, alone: 3, payoff: 2, send: 1 } }],
        };
        answers['monteur.copy'] = { clips: [{ ...COPY_ITEM, clip: 1 }, { ...COPY_ITEM, clip: 2, keyword_candidates: ['ملاحظة'] }] };
        answers['monteur.edit'] = { clips: [{ ...EDIT_HUMAN.clips[0]!, clip: 2, edits: [] }] };
        await sweepMonteur(later());
        const stored = db.ran(/^INSERT INTO clip_drafts/).map((i) => i.params[15]);
        assert.equal(stored[0], null);
        // Clip 2 starts at 49.85 s: its L2 is «جملة12.», so words anchored on «جملة4» fall to the line's start.
        assert.deepEqual(JSON.parse(stored[1]).emphasis, [5.15]);
        assert.ok(!('direction' in renderPayloads()[0]!) && 'direction' in renderPayloads()[1]!);
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

// ─── Claude on the Mac (MONTEUR.md §6.3) ────────────────────────────────────────────────

describe('sweepMonteur — Claude on the Mac (monteur.brain = claude_mac)', () => {
    /** Each request's tries, newest first, as the think lookup returns them; keyed by the call's purpose. */
    let thinks: Record<string, ThinkTry[]>;
    let brains: Record<string, 'gemini' | 'claude_mac'>;
    let sources: Record<string, unknown>[] | null;
    const claude = (output: unknown): ThinkTry[] => [{
        id: `done-${Math.random()}`, status: 'done', try: 1, quiet_s: 5, since_s: 5, error: null,
        result: { output, model: 'claude-opus-5-5', usage: { input_tokens: 40, cache_read_input_tokens: 2000, output_tokens: 300 } },
    }];
    const failedTries = (n: number, error: string): ThinkTry[] =>
        Array.from({ length: n }, (_, i) => ({ id: `f${i}`, status: 'failed' as const, try: n - i, quiet_s: 99_999, since_s: 99_999, result: null, error }));
    const purposeOf = (request: string) => request.split('/').pop()!;
    const queued = () => db.ran(/^INSERT INTO studio_jobs \(creator_id, kind, payload\) VALUES \(\$1, 'monteur_think'/).map((s) => JSON.parse(s.params[1]));
    const released = () => db.ran(/^UPDATE monteur_sources SET status = 'transcribed', attempts = attempts - 1/);

    beforeEach(() => {
        thinks = {};
        brains = { [TENANT]: 'claude_mac' };
        sources = null;
        db.routes.unshift(
            [/FROM studio_settings/, (p) => ({
                rows: [{ ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, reels_per_video: reelsPerVideo, brain: brains[p[0]] ?? 'gemini' } }],
            })],
            [/^SELECT id, status, result, error, \(payload->>'try'\)::int AS try/, (p) => ({ rows: (thinks[purposeOf(p[1])] ?? []).map((t) => ({ ...t })) })],
            [/^INSERT INTO studio_jobs \(creator_id, kind, payload\) VALUES \(\$1, 'monteur_think'/, () => ({ rows: [{ id: 'think-job' }] })],
            [/^UPDATE monteur_sources SET status = 'transcribed', attempts = attempts - 1/, () => ({ rows: [], rowCount: 1 })],
            [/^WITH picked AS \( SELECT s\.id FROM monteur_sources s/, (p) => {
                const list = sources ?? (source ? [source] : []);
                const next = list.find((s) => !(p[2] as string[]).includes(s.id as string));
                return { rows: next ? [next] : [] };
            }],
        );
    });

    it('never reaches Gemini, whatever state the calls are in', async () => {
        // Waiting on the pick, on the copy, on the Editor; answered; stopped: every drain of a pick.
        const drains: Record<string, ThinkTry[]>[] = [
            {},
            { 'monteur.pick': claude(PICK) },
            { 'monteur.pick': claude(PICK), 'monteur.copy': claude(COPY) },
            { 'monteur.pick': claude(PICK), 'monteur.copy': claude(COPY), 'monteur.edit': claude(EDIT) },
            { 'monteur.pick': failedTries(4, 'plan limit') },
            { 'monteur.pick': [{ ...failedTries(1, 'x')[0]!, status: 'pending', quiet_s: 40 * 60 }] },
        ];
        for (const state of drains) {
            thinks = state;
            await sweepMonteur(later());
        }
        assert.deepEqual(calls.map((c) => c.purpose), [], 'Gemini is never called with the brain on Claude');
    });

    it('a call still on the Mac hands the source back as it was: transcribed, its attempt unspent', async () => {
        const result = await sweepMonteur(later());
        assert.deepEqual(result.pick, { source_id: SOURCE, outcome: 'waiting', clips: 0 });
        assert.equal(result.waiting, 1);
        const [job] = queued();
        assert.equal(job.request, `source/${SOURCE}/a1/monteur.pick`, 'keyed by the source, its attempt and the call');
        assert.equal(job.step, 'pick');
        assert.equal(job.model, 'claude-opus-5-5');
        assert.match(job.user, /^L3 \[00:10\.0\] جملة3\.$/m, 'the same prompt Gemini gets');
        const [release] = released();
        assert.deepEqual(release!.params, [SOURCE, 1]);
        assert.match(release!.sql, /claimed_at = NULL, updated_at = NOW\(\) WHERE id = \$1 AND status = 'picking' AND attempts = \$2/);
        assert.equal(db.ran(/^UPDATE monteur_sources SET (error = \$2|status = 'failed', error = \$2)/).length, 0, 'no attempt failed, none burned');
        assert.equal(calls.length, 0);
    });

    it('moves on: the next source is claimed in the same sweep, never the one handed back', async () => {
        const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
        sources = [source!, { ...source!, id: 'second-source', creator_id: OTHER_TENANT }];
        const result = await sweepMonteur(later());
        const claims = db.ran(/^WITH picked AS/);
        assert.deepEqual(claims.map((c) => c.params[2]), [[], [SOURCE]]);
        assert.equal(result.waiting, 1);
        assert.deepEqual(result.pick, { source_id: 'second-source', outcome: 'rendering', clips: 1 }, 'a Gemini tenant’s source, picked as before');
        assert.deepEqual(calls.map((c) => c.purpose), ['monteur.pick', 'monteur.copy', 'monteur.edit']);
    });

    it('parses the answers exactly as Gemini’s, and records Claude’s model and tokens', async () => {
        brains[TENANT] = 'gemini';
        await sweepMonteur(later());
        const viaGemini = { copy: savedCopy(), edits: db.ran(/^INSERT INTO clip_drafts/)[0]!.params[14], direction: db.ran(/^INSERT INTO clip_drafts/)[0]!.params[15] };
        db.statements.length = 0;
        calls.length = 0;

        brains[TENANT] = 'claude_mac';
        thinks = { 'monteur.pick': claude(PICK), 'monteur.copy': claude(COPY), 'monteur.edit': claude(EDIT) };
        const result = await sweepMonteur(later());
        assert.deepEqual(result.pick, { source_id: SOURCE, outcome: 'rendering', clips: 1 });
        assert.equal(calls.length, 0);
        assert.deepEqual(savedCopy(), viaGemini.copy);
        assert.deepEqual(JSON.parse(db.ran(/^INSERT INTO clip_drafts/)[0]!.params[14]), EDITS);
        assert.equal(db.ran(/^INSERT INTO clip_drafts/)[0]!.params[14], viaGemini.edits);
        assert.equal(db.ran(/^INSERT INTO clip_drafts/)[0]!.params[15], viaGemini.direction, 'the human touches too');
        const record = JSON.parse(db.ran(/^UPDATE monteur_sources SET status = 'rendering'/)[0]!.params[1]);
        assert.deepEqual([record.model, record.tokens_in, record.tokens_out], ['claude-opus-5-5', 2040, 300]);
        assert.deepEqual(record.copy, { model: 'claude-opus-5-5', tokens_in: 2040, tokens_out: 300 });
        assert.deepEqual(record.edit, { model: 'claude-opus-5-5', tokens_in: 2040, tokens_out: 300 });
        assert.equal(queued().length, 0, 'nothing asked twice');
    });

    it('asks the Marketer once the pick is in, and the Editor about exactly the clips that got copy', async () => {
        thinks = { 'monteur.pick': claude(PICK) };
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'waiting');
        assert.deepEqual(queued().map((j) => j.request), [`source/${SOURCE}/a1/monteur.copy`]);
        assert.equal(db.ran(/^UPDATE monteur_sources SET pick = \$2::jsonb/).length, 1, 'the pick is saved while the copy waits');

        db.statements.length = 0;
        thinks['monteur.copy'] = claude(COPY);
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'waiting');
        const [edit] = queued();
        assert.match(edit.request, new RegExp(`^source/${SOURCE}/a1/clips-[0-9a-f]{10}/monteur\\.edit$`));
        assert.match(edit.user, /^C1\nL1 \[00:00\.2\] جملة3\./, 'the clip’s own lines, on its own clock');
        assert.equal(db.ran(/^INSERT INTO clip_drafts/).length, 0, 'a reel never goes out without the edits it waits for');
    });

    it('a repair still on the Mac is waited for; one whose every try failed leaves the first answer standing', async () => {
        reelsPerVideo = 2;
        thinks = { 'monteur.pick': claude({ ...PICK, clips: [...PICK.clips, { ...PICK.clips[0], start_line: 90, end_line: 95 }] }) };
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'waiting');
        const [repair] = queued();
        assert.equal(repair.request, `source/${SOURCE}/a1/monteur.pick-repair`);
        assert.equal(repair.step, 'pick');
        assert.match(repair.user, /\n\nYour previous answer:\n\{"topic"/, 'the prompt, the answer it got, then what to fix');
        assert.match(repair.user, /clip 2: L90–L95 is not a range of lines/);
        assert.equal(db.ran(/^UPDATE monteur_sources SET (status = 'no_clips'|pick = \$2::jsonb)/).length, 0, 'the first answer is not taken while the repair may still come');

        db.statements.length = 0;
        thinks['monteur.pick-repair'] = failedTries(4, 'plan limit');
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'waiting', 'on to the Marketer, which waits');
        const saved = JSON.parse(db.ran(/^UPDATE monteur_sources SET pick = \$2::jsonb/)[0]!.params[1]);
        assert.equal(saved.saved.clips.length, 1, 'the first answer’s good clip stands');
        assert.deepEqual(queued().map((j) => j.request), [`source/${SOURCE}/a1/monteur.copy`]);
        assert.equal(calls.length, 0);
    });

    it('a source asks again on its next pick attempt: a failed attempt is a new request', async () => {
        source = { ...source, attempts: 2 };
        await sweepMonteur(later());
        assert.equal(queued()[0].request, `source/${SOURCE}/a2/monteur.pick`);
    });

    it('stops the source when every try of a call failed, on any attempt, with what Claude said', async () => {
        thinks = { 'monteur.pick': failedTries(4, 'You have hit your usage limit') };
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'failed');
        const [failed] = db.ran(/^UPDATE monteur_sources SET status = 'failed', error = \$2/);
        assert.deepEqual(failed!.params, [SOURCE, 'Claude on the Mac didn\'t answer: You have hit your usage limit', 1]);
        assert.equal(released().length, 0);
        assert.equal(calls.length, 0);
    });

    it('an Editor whose tries all failed stops the source too: no reel without its edits, and no Gemini', async () => {
        thinks = { 'monteur.pick': claude(PICK), 'monteur.copy': claude(COPY), 'monteur.edit': failedTries(4, 'timed out') };
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'failed');
        assert.match(result.pick?.error ?? '', /^Claude on the Mac didn't answer: timed out$/);
        assert.equal(db.ran(/^INSERT INTO clip_drafts/).length, 0);
        assert.equal(calls.length, 0);
    });

    it('any other failure of the Editor’s call fails the attempt: the edits are never dropped', async () => {
        thinks = { 'monteur.pick': claude(PICK), 'monteur.copy': claude(COPY) };
        db.routes.unshift([/^SELECT id, status, result, error, \(payload->>'try'\)::int AS try/, (p) => {
            if (String(p[1]).endsWith('/monteur.edit')) throw new Error('connection terminated unexpectedly');
            return { rows: (thinks[String(p[1]).split('/').pop()!] ?? []).map((t) => ({ ...t })) };
        }]);
        const result = await sweepMonteur(later());
        assert.deepEqual(result.pick, { source_id: SOURCE, outcome: 'retry', error: 'connection terminated unexpectedly' });
        assert.equal(db.ran(/^INSERT INTO clip_drafts/).length, 0);
        assert.equal(calls.length, 0);
    });

    it('a try gone quiet for 20 minutes is failed and asked again after the backoff; the source waits', async () => {
        thinks = { 'monteur.pick': [{ id: 'quiet', status: 'pending', try: 1, quiet_s: 21 * 60, since_s: 21 * 60, result: null, error: null }] };
        db.routes.unshift([/^UPDATE studio_jobs SET status = 'failed'/, (p) => {
            thinks['monteur.pick'] = [{ ...thinks['monteur.pick']![0]!, status: 'failed', error: p[1], since_s: 0 }];
            return { rows: [], rowCount: 1 };
        }]);
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'waiting');
        assert.equal(db.ran(/^UPDATE studio_jobs SET status = 'failed'/)[0]!.params[0], 'quiet');
        assert.equal(queued().length, 0, 'try 2 after 10 minutes, not at once');
        assert.equal(released().length, 1);
        assert.equal(calls.length, 0);
    });
});
