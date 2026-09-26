/**
 * The pick sweep (MONTEUR.md §6): the claim and its attempts, the two calls, and the hand-off.
 * Gemini is stood in for with `setModelCaller`, the pool answers by SQL, and the log sink is
 * captured so the token lines are checked, not assumed.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TranscriptWord } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { setModelCaller, type CallModel, type ModelRequest } from '../studio/generate.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import {
    CLAIM_SOURCE_SQL, EXHAUST_SOURCES_SQL, EXHAUSTED_PICK_ERROR, MAX_PICK_ATTEMPTS, PICK_STALE_MINUTES, sweepMonteur,
} from './sweep.js';
import { installFakeDb, type FakeDb } from './testDb.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '66666666-6666-4666-8666-666666666666';
const CLIP = '77777777-7777-4777-8777-777777777777';

/** L1 at 0 s … L20 at 95 s, each line one sentence of 4.5 s. */
const WORDS: TranscriptWord[] = Array.from({ length: 20 }, (_, i) => [i * 5, i * 5 + 4.5, `جملة${i + 1}.`] as TranscriptWord);

const PICK = { clips: [{ start_line: 3, end_line: 7, title: 'عنوان 3 كلمات', why: 'يبدأ بنتيجة', score: 8 }] };
const COPY = {
    clips: [{
        clip: 1, first_line: '🔥 دفترك الذكي', body: '✅ يلخص لك الدرس\n💡 بدقيقة', tiktok_body: '✅ يلخص لك الدرس 👇',
        hashtags: ['#ai', 'notebook lm'], keyword_candidates: ['دفتر', 'ملاحظة'], variants: ['الدفتر', 'دفاتر'],
        question: 'تبي تجربه؟', pitch: 'شرحته في الكورس.', alt_text: 'شاشة NotebookLM',
    }],
};

let db: FakeDb;
let source: Record<string, unknown> | null;
let handOffClaimed: boolean;
let calls: ModelRequest[];
let answers: Record<string, unknown | Error>;
let logs: { event: string; [k: string]: unknown }[];
let previousCaller: CallModel;
let previousSink: ReturnType<typeof setLogSink>;

beforeEach(() => {
    db = installFakeDb();
    source = { id: SOURCE, creator_id: TENANT, name: 'lesson.mp4', path: '/v/lesson.mp4', duration: 100, words: WORDS, attempts: 1 };
    handOffClaimed = true;
    calls = [];
    answers = { 'monteur.pick': PICK, 'monteur.copy': COPY };
    logs = [];
    previousSink = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    previousCaller = setModelCaller(async (req) => {
        calls.push(req);
        const answer = answers[req.purpose];
        if (answer instanceof Error) throw answer;
        req.onUsage?.({ model: 'gemini-test', tokensIn: 1000, tokensOut: 200, thinking: 50 });
        return answer;
    });
    db.routes.push(
        [/^SELECT s\.creator_id FROM studio_settings s JOIN creators/, () => ({ rows: [] })],
        [/^UPDATE monteur_sources SET status = 'failed', claimed_at = NULL/, () => ({ rows: [], rowCount: 0 })],
        [/^WITH picked AS \( SELECT s\.id FROM monteur_sources s/, () => ({ rows: source ? [source] : [] })],
        [/FROM studio_settings/, () => ({ rows: [{ ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, reels_per_video: 1 } }] })],
        [/^SELECT lessons FROM studio_lessons/, () => ({ rows: [{ lessons: [{ rule: 'ابدأ بالنتيجة', evidence: 'skip 40%' }] }] })],
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
});

const later = () => ({ deadline: Date.now() + 250_000 });

describe('the claim — the SQL', () => {
    it('takes one source, transcribed or with a claim 10 minutes stale, atomically, under 3 attempts', () => {
        const sql = CLAIM_SOURCE_SQL.replace(/\s+/g, ' ');
        assert.match(sql, /FOR UPDATE OF s SKIP LOCKED/);
        assert.match(sql, /LIMIT 1/);
        assert.match(sql, /s\.attempts < \$2/);
        assert.match(sql, /s\.status = 'transcribed' OR \(s\.status = 'picking' AND s\.claimed_at < NOW\(\) - make_interval\(mins => \$1\)\)/);
        assert.match(sql, /attempts = s\.attempts \+ 1/);
        assert.match(sql, /c\.is_active = TRUE/, 'a deactivated tenant’s videos wait');
        assert.equal(PICK_STALE_MINUTES, 10);
        assert.equal(MAX_PICK_ATTEMPTS, 3);
    });

    it('fails a stale claim that used its third attempt, before claiming', async () => {
        source = null;
        await sweepMonteur(later());
        const [exhaust, claim] = db.statements;
        assert.equal(exhaust!.sql, EXHAUST_SOURCES_SQL.replace(/\s+/g, ' ').trim());
        assert.deepEqual(exhaust!.params, [10, 3, EXHAUSTED_PICK_ERROR]);
        assert.match(exhaust!.sql, /attempts >= \$2/);
        assert.deepEqual(claim!.params, [10, 3]);
    });
});

describe('sweepMonteur — a pick', () => {
    it('makes one Monteur call and one Marketer call, then hands the clip to the worker', async () => {
        const result = await sweepMonteur(later());
        assert.deepEqual(result.pick, { source_id: SOURCE, outcome: 'rendering', clips: 1 });
        assert.deepEqual(calls.map((c) => c.purpose), ['monteur.pick', 'monteur.copy']);

        const [pick, copy] = calls;
        assert.match(pick!.turns[0]!.text, /^L3 \[00:10\.0\] جملة3\.$/m, 'numbered lines, L<n> [mm:ss.s] text');
        assert.match(pick!.turns[0]!.text, /- ابدأ بالنتيجة/, 'the latest lessons go in');
        assert.match(pick!.turns[0]!.text, /Never pick a moment about: MCP/, 'and the avoid terms');
        assert.ok(pick!.maxOutputTokens && pick!.maxOutputTokens <= 4096, 'a capped answer');
        assert.ok(pick!.system.length < 1500, 'a short system prompt');
        assert.match(copy!.turns[0]!.text, /\[1\] «عنوان 3 كلمات»\nL3 \[00:10\.0\]/, 'the clip’s own lines');
        assert.ok(!copy!.turns[0]!.text.includes('جملة1.'), 'and only those');

        const [clip] = db.ran(/^INSERT INTO clip_drafts/);
        const [creator, sourceId, rank, start, end, title, hook, why, score, copyJson] = clip!.params;
        assert.deepEqual([creator, sourceId, rank, start, end], [TENANT, SOURCE, 1, 9.85, 34.8]);
        assert.equal(title, 'عنوان ٣ كلمات', 'Arabic-Indic digits in the burned-in title');
        assert.equal(hook, 'جملة3.');
        assert.equal(why, 'يبدأ بنتيجة');
        assert.equal(score, 8);
        const saved = JSON.parse(copyJson);
        assert.equal(saved.keyword, 'دفتر');
        assert.equal(saved.keyword_create, true);
        assert.deepEqual(saved.variants, ['دفاتر'], 'a variant containing the keyword is redundant under substring matching');
        assert.deepEqual(saved.hashtags, ['ai', 'notebook_lm']);
        assert.ok(saved.caption.includes('اكتب "دفتر" بالتعليقات ويوصلك رابط الكورس بالخاص 📩'), saved.caption);
        assert.ok(saved.caption.startsWith('🔥 دفترك الذكي'));
        assert.ok(saved.tiktok_caption.includes('رابطه في البايو'));
        assert.ok(!saved.tiktok_caption.includes('بالتعليقات'), 'TikTok can’t auto-reply: no ask');
        assert.match(saved.dm, /^هلا \{username\} 👋\n\nتبي تجربه؟\n\nشرحته في الكورس\./);

        const [job] = db.ran(/^INSERT INTO studio_jobs/);
        assert.equal(job!.params[1], 'monteur_render');
        const payload = JSON.parse(job!.params[2]);
        assert.deepEqual({ ...payload, words: payload.words.length, brand: { ...payload.brand, accent: 'x' } }, {
            clipId: CLIP, sourceId: SOURCE, path: '/v/lesson.mp4', start: 9.85, end: 34.8, title: 'عنوان ٣ كلمات', words: 5,
            cta: { line1: 'اكتب في التعليقات «دفتر»', line2: 'ويوصلك الرابط بالخاص 📩' },
            brand: { accent: 'x', font: 'Cairo', direction: 'rtl' }, cover_at: 0.5,
        });
        assert.deepEqual(payload.words[0], [0.15, 4.65, 'جملة3.'], 'relative to the clip');
        assert.match(payload.brand.accent, /^#[0-9A-F]{6}$/);

        const [moved] = db.ran(/^UPDATE monteur_sources SET status = 'rendering'/);
        assert.deepEqual(moved!.params.slice(0, 1).concat(moved!.params.slice(2)), [SOURCE, 1], 'guarded by this attempt');
        assert.deepEqual(JSON.parse(moved!.params[1]), {
            model: 'gemini-test', tokens_in: 1000, tokens_out: 250, considered: 1,
            copy: { model: 'gemini-test', tokens_in: 1000, tokens_out: 250 },
        });
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
        answers['monteur.pick'] = { clips: [{ ...PICK.clips[0], score: 3 }] };
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'no_clips');
        assert.deepEqual(calls.map((c) => c.purpose), ['monteur.pick']);
        assert.equal(db.ran(/^INSERT INTO clip_drafts/).length, 0);
    });

    it('spends no call on a transcript with no words', async () => {
        source = { ...source, words: [] };
        assert.equal((await sweepMonteur(later())).pick?.outcome, 'no_clips');
        assert.equal(calls.length, 0);
    });

    it('asks once more when the answer can’t be cut, and keeps the better answer', async () => {
        let n = 0;
        setModelCaller(async (req) => {
            calls.push(req);
            if (req.purpose.startsWith('monteur.pick')) {
                n += 1;
                return n === 1 ? { clips: [{ ...PICK.clips[0], end_line: 3 }] } : PICK; // 4.95 s, then 24.95 s
            }
            return COPY;
        });
        const result = await sweepMonteur(later());
        assert.deepEqual(calls.map((c) => c.purpose), ['monteur.pick', 'monteur.pick-repair', 'monteur.copy']);
        assert.match(calls[1]!.turns.at(-1)!.text, /clip 1: L3–L3 is 5\.0 s; a clip must be 20–45 s/);
        assert.equal(result.pick?.outcome, 'rendering');
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
        answers['monteur.copy'] = { clips: [{ ...COPY.clips[0], keyword_candidates: ['two words'] }] };
        const result = await sweepMonteur(later());
        assert.equal(result.pick?.outcome, 'retry');
        assert.match(result.pick?.error ?? '', /No usable comment keyword/);
        assert.equal(db.ran(/^INSERT INTO clip_drafts/).length, 0);
    });

    it('starts no pick without time left for two calls', async () => {
        const result = await sweepMonteur({ deadline: Date.now() + 30_000 });
        assert.equal(result.skipped, 'no_time_for_pick');
        assert.equal(db.ran(/^WITH picked AS/).length, 0);
        assert.equal(calls.length, 0);
    });
});
