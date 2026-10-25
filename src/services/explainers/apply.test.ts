/**
 * What the Studio queue does with an explainer's four job kinds when a job ends (apply.ts, reached through `completeJob` and `failJob`, as the worker's
 * routes reach it): the script written, the narration voiced, the drawing paused, finished or failed, the videos rendered, and each failure. The database is
 * the stateful fake of testDb.ts: a result lands on rows a test can read back, and a transaction that fails gives its rows back.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ExplainerDraft } from '../../db/rows.js';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { completeJob, failJob } from '../studio/jobs.js';
import { StudioError } from '../studio/common.js';
import {
    applyExplainerFailure, applyExplainerResult, EXPLAINER_JOB_KINDS, isExplainerJobKind, MAX_VOICE_LIMIT_RETRIES, parseVoiceResult, RESEARCH_LIMITED_MESSAGE, resumeAt,
    voiceRetryAt, writerOf,
} from './apply.js';
import { estimateSeconds } from './spec.js';
import { EXPLAINER, JOB, SENTENCE, TENANT, validWriterOutput, writerScene } from './testFixtures.js';
import { BASE, explainerSettings, installWorld, type World } from './testDb.js';
import { presentExplainer } from './explainers.js';

const id = (n: number) => `${String(n).padStart(2, '0').repeat(4)}-1111-4111-8111-111111111111`;
const up = (n: number) => `${BASE}/api/uploads/${id(n)}`;
const KARIM = { key: 'karim', name: 'Karim', description: 'a curious young man', ref_media_id: null, ref_url: null, approved_at: null };

let world: World;
let logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { const { ts: _ts, level: _l, event, ...fields } = JSON.parse(line); logs.push({ level, event, fields }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
beforeEach(() => {
    logs = [];
    world = installWorld();
    world.settingsRow = explainerSettings({ characters: [KARIM] });
});
afterEach(() => world.restore());

/** An explainer that is `status`, with the job `kind` it is waiting on (claimed), and the job's id as its `job_id`. */
function waiting(status: 'writing' | 'voicing' | 'drawing' | 'rendering', kind: 'explainer_write' | 'explainer_voice' | 'explainer_draw' | 'explainer_render', over = {}) {
    const job = world.addJob({ id: JOB, kind, status: 'claimed', payload: { explainer_id: EXPLAINER }, claimed_at: world.now, heartbeat_at: world.now });
    const row = world.addExplainer({ status, job_id: job.id, ...over });
    return { job, row };
}

const stateOf = () => world.explainer();

// ─── The vocabulary ────────────────────────────────────────────────────────────────────────────

describe('isExplainerJobKind', () => {
    it('is true for the four kinds of data-model §4, and for no other job kind', () => {
        assert.deepEqual([...EXPLAINER_JOB_KINDS], ['explainer_write', 'explainer_voice', 'explainer_draw', 'explainer_render']);
        for (const kind of EXPLAINER_JOB_KINDS) assert.equal(isExplainerJobKind(kind), true, kind);
        for (const kind of ['scan_library', 'index_lesson', 'render_carousel', 'pick_folder', 'monteur_scan', 'monteur_transcribe', 'monteur_render', 'monteur_think', 'render_infographic', 'ads_think', 'explainer', 'explainer_']) {
            assert.equal(isExplainerJobKind(kind), false, kind);
        }
    });

    it('writerOf says Gemini only for a job that says so, and Claude on the Mac for every other', () => {
        assert.equal(writerOf({ payload: { explainer_id: EXPLAINER, writer: 'gemini' } as never }), 'gemini');
        for (const payload of [{ explainer_id: EXPLAINER }, { writer: 'claude_mac' }, { writer: 'GEMINI' }, null, 'gemini', []]) assert.equal(writerOf({ payload: payload as never }), 'claude_mac');
    });
});

// ─── explainer_write ───────────────────────────────────────────────────────────────────────────

describe('explainer_write: the script lands', () => {
    const written = (n = 12) => ({ written: validWriterOutput(n), model: 'claude-opus-5-5', research_rounds: 4 });

    it('replaces the scenes, bumps the version, keeps what was written, and moves the explainer to draft', async () => {
        waiting('writing', 'explainer_write', { draft_version: 0, title: null });
        world.addScenes(3);
        assert.equal(await completeJob(TENANT, JOB, written()), 'applied');

        const row = stateOf();
        assert.equal(row.status, 'draft');
        assert.equal(row.draft_version, 1);
        assert.equal(row.title, 'Why AI answers with confidence');
        assert.equal(row.job_id, null);
        assert.equal(row.error, null);
        assert.equal(row.draft!.writer, 'claude_mac');
        assert.equal(row.draft!.captions.youtube.title, 'Why AI answers with confidence');
        assert.equal(row.draft!.replies.length, 5);
        assert.equal(row.draft!.sources.length, 3);
        assert.match(row.draft!.first_comment, /^Sources/);

        const scenes = world.sceneRows();
        assert.equal(scenes.length, 12, 'the three old scenes are gone');
        assert.deepEqual(scenes.map((s) => s.position), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        assert.equal(scenes[0]!.narration, `${SENTENCE} (0)`);
        assert.deepEqual(scenes[0]!.characters, ['karim']);
        assert.equal(scenes[11]!.narration, 'Which of these have you seen fail in your own project?');
        assert.ok(scenes.every((s) => s.draw_status === 'pending' && s.picture === null && s.start_s === null));
        assert.equal(world.jobs[0]!.status, 'done');
    });

    it('estimates the length at the settings’ pace and keeps the warnings the checks found', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM], pace: { ar: 1.8, en: 1 } });
        waiting('writing', 'explainer_write', { draft_version: 0 });
        await completeJob(TENANT, JOB, written(12));
        const draft = stateOf().draft!;
        assert.equal(draft.est_seconds, estimateSeconds(validWriterOutput(12).scenes, 'en', 1));
        assert.equal(draft.est_seconds, 143, '143 spoken words, at one a second');
        assert.deepEqual(
            draft.warnings.map((w) => w.code), ['duration_long', 'slow_opening', 'scene_long'],
            'longer than the 55 to 95 seconds of a 60 to 90 second video, and at one word a second every picture stays about 12 s'
        );
    });

    it('flags a script written with no web read at all: research_limited, which the owner may approve over', async () => {
        waiting('writing', 'explainer_write');
        await completeJob(TENANT, JOB, { ...written(), research_rounds: 0 });
        const warning = stateOf().draft!.warnings.find((w) => w.code === 'research_limited');
        assert.deepEqual(warning, { code: 'research_limited', message: RESEARCH_LIMITED_MESSAGE });
        assert.equal(stateOf().status, 'draft', 'a warning, not a refusal');
    });

    it('does not flag one that read the web, and treats a missing or malformed count as unknown, which is not 0', async () => {
        for (const rounds of [1, 4, 60, undefined, null, -1, 1.5, '0', 'none', Number.NaN]) {
            world.explainers.clear();
            world.jobs.length = 0;
            waiting('writing', 'explainer_write');
            await completeJob(TENANT, JOB, { written: validWriterOutput(12), model: 'm', ...(rounds === undefined ? {} : { research_rounds: rounds }) });
            assert.ok(!stateOf().draft!.warnings.some((w) => w.code === 'research_limited'), `research_rounds ${String(rounds)}`);
        }
    });

    it('does not flag the Gemini writer: its grounding gives its sources, and it sets no research_rounds', async () => {
        waiting('writing', 'explainer_write');
        world.jobs[0]!.payload = { explainer_id: EXPLAINER, writer: 'gemini' };
        await completeJob(TENANT, JOB, { written: validWriterOutput(12), model: 'gemini-3.1-pro-preview', research_rounds: 0 });
        assert.equal(stateOf().draft!.writer, 'gemini');
        assert.ok(!stateOf().draft!.warnings.some((w) => w.code === 'research_limited'));
    });

    it('stores a draft that breaks a rule, with the problems visible and approval refused: the research the Mac did is not thrown away for a missing question mark', async () => {
        waiting('writing', 'explainer_write');
        const out = validWriterOutput(12);
        out.scenes[3] = writerScene(3, { brief: 'she holds a book at a desk' });
        out.scenes[11] = writerScene(11, { narration: 'Comment YES if you agree', spoken: 'Comment YES if you agree', label: '', source_ids: [] });
        await completeJob(TENANT, JOB, { written: out, model: 'm' });
        const row = stateOf();
        assert.equal(row.status, 'draft');
        const view = presentExplainer({ ...row, job_status: null, job_progress: null, job_not_before: null }, world.sceneRows());
        assert.deepEqual(view.problems.map((p) => `${p.code}:${p.scene}`), ['female_subject:3', 'closing_question:11', 'engagement_bait:11']);
        assert.ok(logs.some((l) => l.event === 'explainer.draft_written' && Array.isArray(l.fields.problems) && l.fields.problems.length === 3));
    });

    it('drops a character key that is not in the settings and keeps the ones that are, once each', async () => {
        waiting('writing', 'explainer_write');
        const out = validWriterOutput(12);
        out.scenes[0] = writerScene(0, { characters: ['karim', 'researcher', 'karim'] });
        await completeJob(TENANT, JOB, { written: out, model: 'm' });
        assert.deepEqual(world.sceneRows()[0]!.characters, ['karim']);
        assert.equal(logs.find((l) => l.event === 'explainer.draft_written')!.fields.unknown_characters_dropped, 1);
    });

    it('trims what it stores and records the model without echoing the script', async () => {
        waiting('writing', 'explainer_write');
        const out = validWriterOutput(12);
        out.title = '  Why AI answers  ';
        await completeJob(TENANT, JOB, { written: out, model: 'claude-opus-5-5' });
        assert.equal(stateOf().title, 'Why AI answers');
        assert.equal((world.jobs[0]!.result as { model: string }).model, 'claude-opus-5-5');
        assert.ok(!JSON.stringify(world.jobs[0]!.result).includes('The model reads the question'), 'the job keeps a summary, not the script');
    });

    it('is dropped, with nothing changed, when the job is not the explainer’s current one', async () => {
        const { row } = waiting('writing', 'explainer_write');
        world.explainers.set(row.id, { ...row, job_id: world.uuid() });
        world.addScenes(2);
        assert.equal(await completeJob(TENANT, JOB, written()), 'dropped');
        assert.equal(stateOf().status, 'writing');
        assert.equal(stateOf().draft, null);
        assert.equal(world.sceneRows().length, 2, 'the scenes it did not write are as they were');
        assert.equal(world.jobs[0]!.status, 'done');
        assert.ok(logs.some((l) => l.event === 'explainer.result_dropped' && l.fields.reason === 'superseded'));
    });

    it('is dropped when the explainer is gone, or has moved on', async () => {
        waiting('writing', 'explainer_write');
        world.explainers.clear();
        assert.equal(await completeJob(TENANT, JOB, written()), 'dropped');
        world.jobs.length = 0;
        waiting('writing', 'explainer_write', { status: 'draft' });
        assert.equal(await completeJob(TENANT, JOB, written()), 'dropped');
        assert.equal(stateOf().draft_version, 1, 'a draft the owner is reading is not replaced by a late answer');
    });

    it('is a 400 when the answer is not the object the schema describes, and changes nothing: the job stays claimed for the worker to report', async () => {
        waiting('writing', 'explainer_write');
        world.addScenes(2);
        const bad: any = validWriterOutput(12);
        bad.scenes[2].narration = 'x'.repeat(301);
        await assert.rejects(completeJob(TENANT, JOB, { written: bad, model: 'm' }), (err: unknown) =>
            err instanceof StudioError && err.status === 400 && /scenes\[2\]\.narration is 301 characters; at most 300 are allowed/.test((err.problems ?? []).join('|')));
        assert.equal(stateOf().status, 'writing');
        assert.equal(world.sceneRows().length, 2);
        assert.equal(world.jobs[0]!.status, 'claimed');
        await assert.rejects(completeJob(TENANT, JOB, 'a script'), (err: unknown) => err instanceof StudioError && err.status === 400);
        await assert.rejects(completeJob(TENANT, JOB, { model: 'm' }), (err: unknown) => err instanceof StudioError && err.status === 400);
    });

    it('lands the scenes and the move together or not at all: a move that fails gives the old scenes back', async () => {
        waiting('writing', 'explainer_write');
        world.addScenes(3);
        world.db.routes.unshift([/^UPDATE explainers SET status = \$2/, () => { throw new Error('connection terminated'); }]);
        await assert.rejects(completeJob(TENANT, JOB, written()), /connection terminated/);
        assert.equal(world.sceneRows().length, 3, 'rolled back');
        assert.equal(stateOf().status, 'writing');
        assert.equal(world.jobs[0]!.status, 'claimed');
    });
});

// ─── explainer_voice ───────────────────────────────────────────────────────────────────────────

describe('parseVoiceResult', () => {
    const POSITIONS = [0, 1, 2];
    const good = () => ({
        audio: { url: up(1), duration: 30, voice: 'ar-001-commercial-3', fallback: false }, version: 1,
        scenes: [{ position: 0, start: 0, end: 10 }, { position: 1, start: 10, end: 20 }, { position: 2, start: 20, end: 30 }],
        words: { '0': [[0, 0.4, 'The'], [0.4, 0.9, 'model']], '1': [[10, 10.5, 'It']], '2': [] },
    });
    const problems = (raw: unknown): string[] => {
        try {
            parseVoiceResult(raw, POSITIONS);
            return [];
        } catch (err) {
            return (err as StudioError).problems ?? [(err as Error).message];
        }
    };

    it('is a typed value for a result that fits, with the media id read from the upload’s address', () => {
        const parsed = parseVoiceResult(good(), POSITIONS);
        assert.equal(parsed.audio.mediaId, id(1));
        assert.equal(parsed.audio.duration, 30);
        assert.equal(parsed.scenes.length, 3);
        assert.deepEqual(parsed.words['0'], [[0, 0.4, 'The'], [0.4, 0.9, 'model']]);
        assert.deepEqual(problems(good()), []);
    });

    it('refuses what is not an object, an audio with no upload of ours, no length, no voice, or a flag that is not true or false', () => {
        assert.match(problems('x').join(), /A voice result is/);
        const bad = good() as any;
        bad.audio = { url: 'https://elsewhere.example/a.m4a', duration: 0, voice: ' ', fallback: 'no' };
        assert.deepEqual(problems(bad), [
            'audio.url is not one of this app\'s upload URLs', 'audio.duration must be the audio\'s length in seconds', 'audio.voice must be the voice that spoke', 'audio.fallback must be true or false',
        ]);
        assert.deepEqual(problems({ ...good(), audio: null }), ['audio must be { url, duration, voice, fallback }']);
        assert.deepEqual(problems({ ...good(), version: 'one' }), ['version must be the version that was voiced']);
    });

    it('refuses scenes that are not the explainer’s: the wrong count, a wrong position, no start, an end that is not after the start', () => {
        const few = good() as any;
        few.scenes = few.scenes.slice(0, 2);
        assert.match(problems(few).join('|'), /scenes has 2 entries for 3 scenes/);
        const shifted = good() as any;
        shifted.scenes[1].position = 5;
        assert.match(problems(shifted).join('|'), /scenes\[1\]\.position must be 1/);
        const noStart = good() as any;
        noStart.scenes[0].start = 'zero';
        assert.match(problems(noStart).join('|'), /scenes\[0\]\.start must be a time in seconds/);
        const backwards = good() as any;
        backwards.scenes[1].end = 10;
        assert.match(problems(backwards).join('|'), /scenes\[1\]\.end must be after its start/);
    });

    it('refuses scenes that overlap (a cut would land on the wrong picture), and a last scene that ends after the audio does', () => {
        const overlap = good() as any;
        overlap.scenes[1].start = 9;
        assert.match(problems(overlap).join('|'), /scenes\[1\] starts before the scene before it ends/);
        const tiny = good() as any;
        tiny.scenes[1].start = 9.97;
        assert.deepEqual(problems(tiny), [], 'rounding: 50 ms of overlap is the worker rounding a float');
        const long = good() as any;
        long.scenes[2].end = 31;
        assert.match(problems(long).join('|'), /the last scene ends at 31 s, after the audio's 30 s/);
        const slack = good() as any;
        slack.scenes[2].end = 30.4;
        assert.deepEqual(problems(slack), [], 'half a second of slack');
    });

    it('refuses words for a scene that is not there, a list that is too long, and entries that are not [start, end, word]; and keeps the rest', () => {
        const bad = good() as any;
        bad.words = { '0': [[0, 1, 'ok'], [2, 1, 'backwards'], ['x', 1, 'y'], [1, 2, ''], [1, 2, 3]], '7': [], '1': 'x', '2': Array.from({ length: 301 }, () => [0, 1, 'w']) };
        const found = problems(bad).join('|');
        assert.match(found, /words has "7", which is not a scene of this explainer/);
        assert.match(found, /words\["0"\] has 4 entries that are not \[start, end, word\]/);
        assert.match(found, /words\["1"\] must be a list of at most 300/);
        assert.match(found, /words\["2"\] must be a list of at most 300/);
        assert.match(problems({ ...good(), words: [] }).join(), /words must be/);
    });

    it('lists at most 20 problems', () => {
        const bad: any = { audio: null, version: 'x', scenes: Array.from({ length: 50 }, () => ({})), words: { '99': 1 } };
        assert.ok(problems(bad).length <= 20);
    });
});

describe('explainer_voice: the narration is voiced', () => {
    const scenes = () => [{ position: 0, start: 0, end: 4.5 }, { position: 1, start: 4.5, end: 9 }, { position: 2, start: 9, end: 14.2 }];
    const result = (over: Record<string, unknown> = {}) => ({
        audio: { url: up(1), duration: 14.2, voice: 'ar-001-commercial-3', fallback: false }, version: 1, scenes: scenes(),
        words: { '0': [[0, 0.5, 'The'], [0.5, 1, 'model']], '1': [[4.5, 5, 'It']], '2': [] }, ...over,
    });
    beforeEach(() => {
        world.uploads.set(id(1), { id: id(1), creator_id: TENANT, mime_type: 'audio/mp4', storage_path: null });
        waiting('voicing', 'explainer_voice', { draft_version: 1 });
        world.addScenes(3);
    });

    it('stores the audio, the scene times and the words, moves to drawing, and queues the drawing', async () => {
        assert.equal(await completeJob(TENANT, JOB, result()), 'applied');
        const row = stateOf();
        assert.equal(row.status, 'drawing');
        assert.deepEqual(row.audio, { url: up(1), media_id: id(1), duration: 14.2, voice: 'ar-001-commercial-3', version: 1, words_version: 1, fallback: false });
        assert.deepEqual(row.words!['0'], [[0, 0.5, 'The'], [0.5, 1, 'model']]);
        assert.deepEqual(world.sceneRows().map((s) => [s.start_s, s.end_s]), [[0, 4.5], [4.5, 9], [9, 14.2]]);
        const [draw] = world.jobsOf('explainer_draw');
        assert.ok(draw);
        assert.deepEqual(draw!.payload, { explainer_id: EXPLAINER });
        assert.equal(draw!.status, 'pending');
        assert.equal(row.job_id, draw!.id, 'the drawing is now the explainer’s job');
        assert.equal(row.draw_paused_until, null);
    });

    it('writes the audio on our own address, from the upload’s id: never the string a worker sent', async () => {
        const sent = result({ audio: { url: `https://evil.example/api/uploads/${id(1)}`, duration: 14.2, voice: 'v', fallback: true } });
        await completeJob(TENANT, JOB, sent);
        assert.equal(stateOf().audio!.url, up(1));
        assert.equal(stateOf().audio!.fallback, true, '"check timing" is kept');
    });

    it('refuses an audio that is not this tenant’s upload, or is not audio/mp4, before anything is written', async () => {
        world.uploads.delete(id(1));
        await assert.rejects(completeJob(TENANT, JOB, result()), (err: unknown) => err instanceof StudioError && err.status === 400 && /audio\.url: upload .* does not exist/.test((err.problems ?? []).join()));
        world.uploads.set(id(1), { id: id(1), creator_id: TENANT, mime_type: 'video/mp4', storage_path: null });
        await assert.rejects(completeJob(TENANT, JOB, result()), (err: unknown) => err instanceof StudioError && /is video\/mp4, not audio\/mp4/.test((err.problems ?? []).join()));
        world.uploads.set(id(1), { id: id(1), creator_id: 'someone-else', mime_type: 'audio/mp4', storage_path: null });
        await assert.rejects(completeJob(TENANT, JOB, result()), (err: unknown) => err instanceof StudioError && err.status === 400);
        assert.equal(stateOf().status, 'voicing');
        assert.deepEqual(world.sceneRows().map((s) => s.start_s), [null, null, null]);
        assert.equal(world.jobsOf('explainer_draw').length, 0);
    });

    it('refuses a result for another version: the audio is for words that are no longer the script’s, and the explainer is failed, not left waiting', async () => {
        assert.equal(await completeJob(TENANT, JOB, result({ version: 0 })), 'dropped');
        const row = stateOf();
        assert.equal(row.status, 'failed');
        assert.equal(row.failed_step, 'voice');
        assert.match(row.error!, /The narration changed while it was being voiced/);
        assert.equal(row.audio, null);
        assert.equal(world.jobsOf('explainer_draw').length, 0);
    });

    it('is dropped when the job is not the explainer’s current one, and when the explainer has moved on', async () => {
        world.explainers.set(EXPLAINER, { ...stateOf(), job_id: world.uuid() });
        assert.equal(await completeJob(TENANT, JOB, result()), 'dropped');
        assert.equal(stateOf().status, 'voicing');
        world.explainers.set(EXPLAINER, { ...stateOf(), job_id: JOB, status: 'draft' });
        world.jobs[0]!.status = 'claimed';
        assert.equal(await completeJob(TENANT, JOB, result()), 'dropped');
        assert.equal(stateOf().audio, null);
    });

    it('a re-voice deletes the old audio’s file and keeps the new one', async () => {
        world.explainers.set(EXPLAINER, { ...stateOf(), audio: { url: up(7), media_id: id(7), duration: 12, voice: 'v', version: 0, words_version: 0, fallback: false } });
        await completeJob(TENANT, JOB, result());
        assert.deepEqual(world.deletedUploads, [[id(7)]]);
        assert.equal(stateOf().audio!.media_id, id(1));
    });

    it('moves the move and the drawing job together: a failed move queues no drawing', async () => {
        world.db.routes.unshift([/^UPDATE explainers SET status = \$2/, () => { throw new Error('connection terminated'); }]);
        await assert.rejects(completeJob(TENANT, JOB, result()), /connection terminated/);
        assert.equal(world.jobsOf('explainer_draw').length, 0, 'rolled back');
        assert.deepEqual(world.sceneRows().map((s) => s.start_s), [null, null, null]);
    });
});

// ─── explainer_draw ────────────────────────────────────────────────────────────────────────────

describe('resumeAt', () => {
    const NOW = Date.parse('2026-10-25T12:00:00Z');
    it('is the time the worker said, when it is between a minute and two days away', () => {
        assert.equal(resumeAt('2026-10-26T00:05:00Z', NOW).toISOString(), '2026-10-26T00:05:00.000Z');
        assert.equal(resumeAt('2026-10-25T12:01:00Z', NOW).toISOString(), '2026-10-25T12:01:00.000Z');
    });

    it('is the next UTC midnight plus five minutes for a time that is past, too far, or not a time: nonsense must not make the explainer wait for a year or spin', () => {
        for (const bad of ['2026-10-25T11:00:00Z', '2026-10-25T12:00:30Z', '2027-10-26T00:00:00Z', 'tomorrow', '', null, undefined, 5, {}]) {
            assert.equal(resumeAt(bad, NOW).toISOString(), '2026-10-26T00:05:00.000Z', String(bad));
        }
    });
});

describe('explainer_draw: how a drawing ends', () => {
    beforeEach(() => {
        waiting('drawing', 'explainer_draw', { draft_version: 1 });
    });

    it('done, with the explainer already in review (the draw-next route moved it): applied, and the job is not the explainer’s any more', async () => {
        world.addScenes(2, () => ({ draw_status: 'done' }));
        world.explainers.set(EXPLAINER, { ...stateOf(), status: 'review' });
        assert.equal(await completeJob(TENANT, JOB, { state: 'done' }), 'applied');
        assert.equal(stateOf().status, 'review');
        assert.equal(stateOf().job_id, null);
    });

    it('done, with the explainer still drawing and nothing left to draw: the same move, which is the way out of drawing', async () => {
        world.addScenes(2, () => ({ draw_status: 'done' }));
        assert.equal(await completeJob(TENANT, JOB, { state: 'done' }), 'applied');
        assert.equal(stateOf().status, 'review');
    });

    it('done, with scenes still to draw: nothing moves (a worker that said "done" too early does not skip a picture)', async () => {
        world.addScenes(3, (p) => ({ draw_status: p === 2 ? 'pending' : 'done' }));
        await completeJob(TENANT, JOB, { state: 'done' });
        assert.equal(stateOf().status, 'drawing');
    });

    it('paused: queues the next drawing for the time the allowance resets, keeps drawing, and says how far it got', async () => {
        world.addScenes(5, (p) => ({ draw_status: p < 3 ? 'done' : 'pending' }));
        assert.equal(await completeJob(TENANT, JOB, { state: 'paused', until: '2026-10-26T00:05:00.000Z' }), 'applied');
        const next = world.jobsOf('explainer_draw').find((j) => j.id !== JOB)!;
        assert.equal(next.status, 'pending');
        assert.equal(next.not_before.toISOString(), '2026-10-26T00:05:00.000Z');
        assert.deepEqual(next.payload, { explainer_id: EXPLAINER });
        const row = stateOf();
        assert.equal(row.status, 'drawing');
        assert.equal(row.job_id, next.id);
        assert.equal(new Date(row.draw_paused_until!).toISOString(), '2026-10-26T00:05:00.000Z');
        assert.match(row.error!, /Waiting for the image allowance to reset \(3 of 5 drawn\)\. Drawing continues by itself after 2026-10-26T00:05:00\.000Z\./);
    });

    it('paused, with a time that is nonsense: the next UTC midnight plus five minutes', async () => {
        world.addScenes(2);
        await completeJob(TENANT, JOB, { state: 'paused', until: 'soon' });
        const next = world.jobsOf('explainer_draw').find((j) => j.id !== JOB)!;
        assert.equal(next.not_before.toISOString(), '2026-10-26T00:05:00.000Z');
    });

    it('paused, with the job already superseded: dropped, and no job is queued for an explainer another job is working on', async () => {
        world.addScenes(2);
        world.explainers.set(EXPLAINER, { ...stateOf(), job_id: world.uuid() });
        assert.equal(await completeJob(TENANT, JOB, { state: 'paused', until: '2026-10-26T00:05:00.000Z' }), 'dropped');
        assert.equal(world.jobsOf('explainer_draw').length, 1);
    });

    it('failed: stays drawing with the last scene’s reason as the note, for the owner to redraw or press Continue', async () => {
        world.addScenes(4, (p) => ({
            draw_status: p === 0 ? 'done' : 'failed', draw_error: p === 3 ? 'The image provider refused the prompt.' : p === 2 ? 'older error' : null,
            updated_at: new Date(world.now.getTime() + p * 1000),
        }));
        assert.equal(await completeJob(TENANT, JOB, { state: 'failed' }), 'applied');
        const row = stateOf();
        assert.equal(row.status, 'drawing');
        assert.equal(row.job_id, null);
        assert.equal(row.error, 'Drawing stopped after scenes kept failing (1 of 4 drawn): The image provider refused the prompt.');
    });

    it('is a 400 for a result that is no state of the drawing', async () => {
        await assert.rejects(completeJob(TENANT, JOB, { state: 'halfway' }), (err: unknown) => err instanceof StudioError && err.status === 400);
        await assert.rejects(completeJob(TENANT, JOB, 'done'), (err: unknown) => err instanceof StudioError && err.status === 400);
    });
});

// ─── explainer_render ──────────────────────────────────────────────────────────────────────────

describe('explainer_render: the videos land', () => {
    const result = (over: Record<string, unknown> = {}) => ({ vertical_url: up(2), horizontal_url: up(3), cover_url: up(4), duration: 72.4, version: 1, sound_mode: 'sfx', ...over });
    beforeEach(() => {
        world.uploads.set(id(2), { id: id(2), creator_id: TENANT, mime_type: 'video/mp4', storage_path: null });
        world.uploads.set(id(3), { id: id(3), creator_id: TENANT, mime_type: 'video/mp4', storage_path: null });
        world.uploads.set(id(4), { id: id(4), creator_id: TENANT, mime_type: 'image/jpeg', storage_path: null });
        waiting('rendering', 'explainer_render', { draft_version: 1 });
    });

    it('stores the three files on our own address, with the length, the version and the sound, and the explainer is ready', async () => {
        assert.equal(await completeJob(TENANT, JOB, result()), 'applied');
        const row = stateOf();
        assert.equal(row.status, 'ready');
        assert.deepEqual(row.render, { vertical_url: up(2), horizontal_url: up(3), cover_url: up(4), duration: 72.4, sound_mode: 'sfx', version: 1, job_id: JOB });
        assert.equal(row.job_id, null);
        assert.deepEqual(world.deletedUploads, [], 'no previous render, nothing to delete');
    });

    it('a re-render keeps the previous files until it has landed, and then deletes them (unless a post names them)', async () => {
        world.explainers.set(EXPLAINER, { ...stateOf(), render: { vertical_url: up(5), horizontal_url: up(6), cover_url: up(7), duration: 70, sound_mode: 'sfx', version: 1, job_id: 'old' } });
        await completeJob(TENANT, JOB, result());
        assert.deepEqual(world.deletedUploads, [[id(5), id(6), id(7)]]);
        assert.equal(stateOf().render!.vertical_url, up(2));
    });

    it('stores a render for an older version anyway, and the view says it is older than the edits', async () => {
        world.explainers.set(EXPLAINER, { ...stateOf(), draft_version: 3 });
        assert.equal(await completeJob(TENANT, JOB, result({ version: 1 })), 'applied');
        const row = stateOf();
        assert.equal(row.status, 'ready');
        assert.equal(row.render!.version, 1);
        const view = presentExplainer({ ...row, job_status: null, job_progress: null, job_not_before: null }, []);
        assert.equal(view.render_stale, true);
        assert.ok(logs.some((l) => l.event === 'explainer.rendered' && l.fields.older_than_edits === true));
    });

    it('refuses a file that is not this tenant’s upload of the right type, and an address that is not ours: nothing is stored', async () => {
        world.uploads.set(id(4), { id: id(4), creator_id: TENANT, mime_type: 'image/png', storage_path: null });
        await assert.rejects(completeJob(TENANT, JOB, result()), (err: unknown) => err instanceof StudioError && /cover_url: upload .* is image\/png, not image\/jpeg/.test((err.problems ?? []).join()));
        await assert.rejects(completeJob(TENANT, JOB, result({ vertical_url: 'https://elsewhere.example/v.mp4' })), (err: unknown) => err instanceof StudioError && /vertical_url is not one of this app's upload URLs/.test((err.problems ?? []).join()));
        await assert.rejects(completeJob(TENANT, JOB, result({ duration: 0, version: -1, sound_mode: 'silent' })), (err: unknown) => err instanceof StudioError && (err.problems ?? []).length === 3);
        assert.equal(stateOf().status, 'rendering');
        assert.equal(stateOf().render, null);
    });

    it('is dropped when it is not the explainer’s current render, and its files are deleted: nothing will ever name them', async () => {
        world.explainers.set(EXPLAINER, { ...stateOf(), job_id: world.uuid() });
        assert.equal(await completeJob(TENANT, JOB, result()), 'dropped');
        assert.equal(stateOf().status, 'rendering');
        assert.deepEqual(world.deletedUploads, [[id(2), id(3), id(4)]]);
    });
});

// ─── Failures ──────────────────────────────────────────────────────────────────────────────────

describe('a job that fails: the explainer fails at that step', () => {
    for (const [kind, status, step] of [
        ['explainer_write', 'writing', 'write'], ['explainer_voice', 'voicing', 'voice'], ['explainer_draw', 'drawing', 'draw'], ['explainer_render', 'rendering', 'render'],
    ] as const) {
        it(`${kind}: ${status} → failed at ${step}, with the worker’s words, and Retry knows where to go`, async () => {
            waiting(status, kind);
            await failJob(TENANT, JOB, 'claude answered with an error: something broke');
            const row = stateOf();
            assert.equal(row.status, 'failed');
            assert.equal(row.failed_step, step);
            assert.equal(row.error, 'claude answered with an error: something broke');
            assert.equal(row.job_id, null);
        });
    }

    it('keeps the old render on a failed re-render: the previous files stay until a new render succeeds', async () => {
        const render = { vertical_url: up(5), horizontal_url: up(6), cover_url: up(7), duration: 70, sound_mode: 'sfx' as const, version: 1, job_id: 'old' };
        waiting('rendering', 'explainer_render', { render });
        await failJob(TENANT, JOB, 'ffmpeg failed');
        assert.deepEqual(stateOf().render, render);
    });

    it('ignores the failure of a job that is not the explainer’s current one, and of one whose explainer has moved on or is gone', async () => {
        const { row } = waiting('voicing', 'explainer_voice');
        world.explainers.set(row.id, { ...row, job_id: world.uuid() });
        await failJob(TENANT, JOB, 'late failure');
        assert.equal(stateOf().status, 'voicing');
        world.jobs[0]!.status = 'claimed';
        world.explainers.set(row.id, { ...row, job_id: JOB, status: 'drawing' });
        await failJob(TENANT, JOB, 'late failure');
        assert.equal(stateOf().status, 'drawing');
        world.jobs[0]!.status = 'claimed';
        world.explainers.clear();
        await failJob(TENANT, JOB, 'late failure');
        assert.equal(world.jobs[0]!.status, 'failed', 'the job itself is still failed');
        assert.ok(logs.filter((l) => l.event === 'explainer.failure_ignored').length === 3);
    });

    it('never logs the failure’s text: it may quote a prompt, a path or a key', async () => {
        waiting('voicing', 'explainer_voice');
        await failJob(TENANT, JOB, 'Gemini said: key AIzaSySECRET is not valid');
        assert.doesNotMatch(JSON.stringify(logs), /AIzaSySECRET/);
    });

    it('says something when a worker fails a job without saying why', async () => {
        waiting('rendering', 'explainer_render');
        await applyExplainerFailure(pool, { id: JOB, creator_id: TENANT, kind: 'explainer_render', payload: { explainer_id: EXPLAINER } }, '   ', {
            enqueue: async () => ({ id: 'x' }), checkFiles: async () => undefined, deleteFiles: async () => 0,
        }).catch(() => undefined);
    });
});

describe('a voice that ran into Gemini’s limit is asked again at the reset', () => {
    const DAY = 'VOICE_LIMIT: Gemini\'s free voice allowance is used up (HTTP 429 RESOURCE_EXHAUSTED; the day\'s limit, GenerateRequestsPerDayPerProjectPerModel-FreeTier); Gemini asks to retry after 34s. You exceeded your current quota.';
    const MINUTE = 'VOICE_LIMIT: Gemini\'s free voice allowance is used up (HTTP 429; the minute\'s limit, GenerateRequestsPerMinutePerProjectPerModel-FreeTier); Gemini asks to retry after 34s.';

    it('voiceRetryAt: the day’s limit waits for midnight Pacific plus five minutes, the minute’s for the wait it names (at least a minute) plus a margin', () => {
        const now = Date.parse('2026-10-25T12:00:00Z');
        assert.equal(voiceRetryAt(DAY, now).toISOString(), '2026-10-26T07:05:00.000Z');
        assert.equal(voiceRetryAt(MINUTE, now).toISOString(), '2026-10-25T12:01:15.000Z', '34 s is raised to a minute, plus 15 s');
        assert.equal(voiceRetryAt(MINUTE.replace('34s', '300s'), now).toISOString(), '2026-10-25T12:05:15.000Z');
        assert.equal(voiceRetryAt(MINUTE.replace('34s', '99999s'), now).toISOString(), '2026-10-25T13:00:15.000Z', 'an hour at most');
        assert.equal(voiceRetryAt('VOICE_LIMIT: try again later.', now).toISOString(), '2026-10-26T07:05:00.000Z', 'a limit that says neither is the day’s');
    });

    it('keeps the explainer voicing, queues the voice again for that time, and says why in the note', async () => {
        waiting('voicing', 'explainer_voice', { draft_version: 2 });
        world.addScenes(3);
        await failJob(TENANT, JOB, DAY);
        const row = stateOf();
        assert.equal(row.status, 'voicing');
        const next = world.jobsOf('explainer_voice').find((j) => j.id !== JOB)!;
        assert.equal(row.job_id, next.id);
        assert.equal(next.status, 'pending');
        assert.equal(next.not_before.toISOString(), '2026-10-26T07:05:00.000Z');
        assert.equal(next.payload.version, 2, 'the same version, from the rows as they are now');
        assert.equal(next.payload.limit_retries, 1);
        assert.equal(next.payload.scenes.length, 3);
        assert.match(row.error!, /^VOICE_LIMIT: voice limit reached, trying again at 2026-10-26T07:05:00\.000Z\. Gemini's free voice allowance is used up/);
        assert.equal(row.failed_step, null);
    });

    it('is asked again at most three times: a limit that lasts three days is failed for real, with the worker’s words', async () => {
        waiting('voicing', 'explainer_voice');
        world.jobs[0]!.payload = { explainer_id: EXPLAINER, limit_retries: MAX_VOICE_LIMIT_RETRIES };
        world.addScenes(2);
        await failJob(TENANT, JOB, DAY);
        const row = stateOf();
        assert.equal(row.status, 'failed');
        assert.equal(row.failed_step, 'voice');
        assert.match(row.error!, /^VOICE_LIMIT:/);
        assert.equal(world.jobsOf('explainer_voice').length, 1);
    });

    it('a voice that fails for another reason is failed at once', async () => {
        waiting('voicing', 'explainer_voice');
        await failJob(TENANT, JOB, 'whisper.cpp timed out after 17 min on 40 chunks');
        assert.equal(stateOf().status, 'failed');
        assert.equal(world.jobsOf('explainer_voice').length, 1);
    });
});

describe('applyExplainerResult, called directly', () => {
    it('returns what completeJob stores, and applies nothing for a payload with no explainer', async () => {
        const applied = await applyExplainerResult(pool, { id: JOB, creator_id: TENANT, kind: 'explainer_draw', payload: { nothing: true } as never }, { state: 'done' }, {
            enqueue: async () => ({ id: 'x' }), checkFiles: async () => undefined, deleteFiles: async () => 0,
        });
        assert.deepEqual(applied, { outcome: 'dropped', stored: { dropped: 'no_explainer' } });
    });
});

// A reminder that the draft type the tests read is the one the rows hold.
export type { ExplainerDraft };
