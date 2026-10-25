/**
 * The lifecycle of an illustrated explainer (explainers.ts): create, read, edit, rewrite, approve, voice again, draw, approve the pictures, render, retry and
 * delete, on the stateful fake database of testDb.ts. Every refusal of the contract (contracts/http-api.md) is here with its code, and every job queued is
 * checked against the payload of contracts/worker-jobs.md.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ExplainerDraft, ExplainerRow } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { MacBrainRefused } from '../macBrain.js';
import { StudioError } from '../studio/common.js';
import { defaultInfographicConfig, type ExplainerTrack } from '../studio/settingsTypes.js';
import {
    approveExplainer, approvePictures, BUSY_AFTER_SECONDS, BUSY_MAC_NOTE, createExplainer, deleteExplainer, editExplainer, explainerIdOf, filesOf, getExplainer, listExplainers,
    presentExplainer, renderExplainer, retryExplainer, revoiceExplainer, rewriteExplainer, startDraw,
} from './explainers.js';
import { ExplainerError } from './errors.js';
import { writerSchema } from './prompt.js';
import { CLOSING_QUESTION, EXPLAINER, JOB, SENTENCE, TENANT, validWriterOutput } from './testFixtures.js';
import { BASE, explainerSettings, installWorld, type World } from './testDb.js';
import { setRunDeps, setRunLauncher } from './writing.js';

const KARIM = { key: 'karim', name: 'Karim', description: 'a curious young man', ref_media_id: null, ref_url: null, approved_at: null };
const id = (n: number) => `${String(n).padStart(2, '0').repeat(4)}-1111-4111-8111-111111111111`;
const up = (n: number) => `${BASE}/api/uploads/${id(n)}`;
const TRACK: ExplainerTrack = { key: 'calm-01', title: 'Calm', artist: 'A. Composer', media_id: id(9), url: `/api/uploads/${id(9)}`, license: 'CC BY 4.0', credit: 'Music: Calm by A. Composer', credit_required: true };
const OTHER = '77777777-7777-4777-8777-777777777777';

let world: World;
let restoreSink: (() => void) | undefined;
let launched: Promise<void>[] = [];
let restoreLauncher: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
beforeEach(() => {
    world = installWorld();
    world.settingsRow = explainerSettings({ characters: [KARIM], music: [TRACK] });
    launched = [];
    const previous = setRunLauncher((work) => { launched.push(work); });
    const previousDeps = setRunDeps({ write: async () => { throw new Error('no Gemini in this test'); } });
    restoreLauncher = () => { setRunLauncher(previous); setRunDeps(previousDeps); };
});
afterEach(() => {
    world.restore();
    restoreLauncher?.();
});

const refused = (code: string, status: number) => (err: unknown): boolean => err instanceof ExplainerError && err.code === code && err.status === status;
const studioError = (status: number, code?: string) => (err: unknown): boolean => err instanceof StudioError && err.status === status && (code === undefined || err.code === code);

/** A script that has been written: a draft explainer with twelve scenes that pass every check, and the draft's parts. */
function draftExplainer(over: Partial<ExplainerRow> = {}, sceneOver: (position: number) => object = () => ({})) {
    const out = validWriterOutput(12);
    const draft: ExplainerDraft = {
        writer: 'claude_mac', captions: out.captions, first_comment: out.first_comment, replies: out.replies, sources: out.sources, est_seconds: 71.4, warnings: [],
    };
    const row = world.addExplainer({ status: 'draft', title: out.title, draft, draft_version: 1, ...over });
    world.addScenes(12, (i) => ({
        narration: out.scenes[i]!.narration, spoken: out.scenes[i]!.spoken, label: out.scenes[i]!.label, brief: out.scenes[i]!.brief, characters: out.scenes[i]!.characters,
        continues: out.scenes[i]!.continues, ...sceneOver(i),
    }));
    return row;
}

/** The twelve scenes as the dashboard sends them back (the whole list). */
const sceneEdits = () => world.sceneRows().map((s) => ({ narration: s.narration, spoken: s.spoken, label: s.label, brief: s.brief, characters: [...s.characters], continues: s.continues }));

const NOW = Date.parse('2026-10-25T12:00:00Z');

// ─── Create ────────────────────────────────────────────────────────────────────────────────────

describe('createExplainer', () => {
    it('is a writing explainer with the settings’ defaults, and a write job queued for the Mac with the contract payload', async () => {
        const view = await createExplainer(TENANT, { topic: '  Why AI answers with confidence  ' }, NOW);
        assert.equal(view.status, 'writing');
        assert.equal(view.topic, 'Why AI answers with confidence');
        assert.deepEqual([view.language, view.length_tier, view.sound_mode, view.subtitles, view.music_track_id, view.notes], ['ar', 'short', 'sfx', true, null, null]);
        assert.deepEqual(view.source_links, []);
        assert.equal(view.draft_version, 0);
        assert.equal(view.draft, null);
        assert.deepEqual(view.scenes, []);
        assert.deepEqual(view.problems, []);

        const [job] = world.jobsOf('explainer_write');
        assert.ok(job);
        assert.equal(job!.status, 'pending');
        assert.equal(world.explainer(view.id).job_id, job!.id, 'the job is the explainer’s, written with it');
        assert.deepEqual(view.job, { status: 'pending', progress: null, not_before: job!.not_before });
        assert.equal(launched.length, 0, 'the Mac writes: nothing runs on the server');
    });

    it('queues the payload of contracts/worker-jobs.md: the inputs, the characters, the art direction, the bounds, and the prompts with the schema', async () => {
        await createExplainer(TENANT, {
            topic: 'Why AI answers with confidence', language: 'en', length_tier: 'medium', notes: 'point to the paper', source_links: ['https://arxiv.org/abs/2005.11401'],
        }, NOW);
        const p = world.jobsOf('explainer_write')[0]!.payload;
        assert.equal(p.explainer_id, [...world.explainers.keys()][0]);
        assert.deepEqual([p.language, p.length_tier, p.topic, p.notes], ['en', 'medium', 'Why AI answers with confidence', 'point to the paper']);
        assert.deepEqual(p.source_links, ['https://arxiv.org/abs/2005.11401']);
        assert.deepEqual(p.characters, [{ key: 'karim', name: 'Karim', description: 'a curious young man' }]);
        assert.match(p.style, /warm hand-painted gouache/);
        assert.deepEqual(p.bounds, { scenes_min: 30, scenes_max: 90, seconds_min: 170, seconds_max: 310, pace: 2.5 });
        assert.equal(p.rewrite_note, undefined);
        assert.equal(p.previous_draft, undefined);
        assert.equal(p.write.model, 'claude-opus-5-5');
        assert.deepEqual(p.write.schema, writerSchema());
        assert.match(p.write.system, /RESEARCH IS MANDATORY: do it before you write anything/);
        assert.match(p.write.system, /30 to 90 scenes, spoken in 170 to 310 seconds at 2\.5 words a second/);
        assert.match(p.write.user, /^Topic: Why AI answers with confidence\nLanguage: English\nLength: 3-5 minutes: 30 to 90 scenes\.\nToday: 2026-10-25/);
        assert.match(p.write.user, /Links from the creator \(read them first\):\n- https:\/\/arxiv\.org\/abs\/2005\.11401/);
        assert.match(p.write.user, /- karim: Karim, a curious young man/);
    });

    it('uses the settings’ pace for the language and the settings’ defaults when the request names none', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM], pace: { ar: 1.5, en: 2.5 }, defaults: { sound_mode: 'music', subtitles: false, language: 'en', length_tier: 'long' } });
        const view = await createExplainer(TENANT, { topic: 'Why AI answers with confidence' }, NOW);
        assert.deepEqual([view.language, view.length_tier, view.sound_mode, view.subtitles], ['en', 'long', 'music', false]);
        assert.equal(world.jobsOf('explainer_write')[0]!.payload.bounds.pace, 2.5);
        const ar = await createExplainer(TENANT, { topic: 'لماذا يجيب الذكاء الاصطناعي بثقة', language: 'ar' }, NOW);
        assert.equal(world.jobs.find((j) => j.payload.explainer_id === ar.id)!.payload.bounds.pace, 1.5);
    });

    it('keeps the links as { url }, once each, and a library track for music (and none for sound effects)', async () => {
        const music = await createExplainer(TENANT, {
            topic: 'Why AI answers', sound_mode: 'music', music_track_id: 'calm-01', source_links: ['https://a.example/x', { url: 'https://a.example/x' }, 'https://b.example/y'],
        }, NOW);
        assert.deepEqual(music.source_links, [{ url: 'https://a.example/x' }, { url: 'https://b.example/y' }]);
        assert.equal(music.music_track_id, 'calm-01');
        const sfx = await createExplainer(TENANT, { topic: 'Why AI answers', sound_mode: 'sfx', music_track_id: 'calm-01' }, NOW);
        assert.equal(sfx.music_track_id, null);
    });

    it('refuses what the contract does, all at once, before anything is written', async () => {
        const run = (body: unknown) => createExplainer(TENANT, body, NOW);
        const problems = (err: unknown) => (err as StudioError).problems ?? [];
        await assert.rejects(run({}), (e) => studioError(400)(e) && /topic: say what the video is about/.test(problems(e).join()));
        await assert.rejects(run({ topic: 'ab' }), studioError(400));
        await assert.rejects(run({ topic: 'x'.repeat(301) }), (e) => studioError(400)(e) && /longer than 300/.test(problems(e).join()));
        await assert.rejects(run({ topic: 'topic', language: 'fr', length_tier: 'epic', sound_mode: 'silent', subtitles: 'yes', notes: 'n'.repeat(2001) }), (e) =>
            studioError(400)(e) && problems(e).length === 5);
        await assert.rejects(run({ topic: 'topic', sound_mode: 'music', music_track_id: 'nope' }), (e) => /not a track in your library/.test(problems(e).join()));
        await assert.rejects(run({ topic: 'topic', source_links: ['ftp://x.example/a', 'not a link', 'javascript:alert(1)'] }), (e) => problems(e).length === 3);
        await assert.rejects(run({ topic: 'topic', source_links: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) }), (e) => /at most 10/.test(problems(e).join()));
        assert.equal(world.explainers.size, 0);
        assert.equal(world.jobs.length, 0);
    });

    it('with Gemini chosen in Settings: no job for the Mac, a Gemini job already claimed by the server, and the run started after the commit', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM], writer: 'gemini' });
        let transactionsOpen = -1;
        setRunLauncher((work) => { transactionsOpen = world.db.statements.filter((s) => s.sql === 'BEGIN').length - world.db.statements.filter((s) => s.sql === 'COMMIT' || s.sql === 'ROLLBACK').length; launched.push(work); });
        const view = await createExplainer(TENANT, { topic: 'Why AI answers with confidence', language: 'en' }, NOW);
        assert.equal(view.status, 'writing');
        const [job] = world.jobsOf('explainer_write');
        assert.equal(job!.status, 'claimed', 'the server holds it: the Mac never sees it');
        assert.equal(job!.attempts, 3, 'every attempt spent, so a stale-claim reclaim does not hand it to the Mac');
        assert.deepEqual(job!.payload, { explainer_id: view.id, language: 'en', length_tier: 'short', topic: 'Why AI answers with confidence', writer: 'gemini' });
        assert.equal(world.explainer(view.id).job_id, job!.id);
        assert.equal(launched.length, 1, 'one run');
        assert.equal(transactionsOpen, 0, 'started after the transaction closed: no call to Google is made inside one');
        await launched[0];
    });

    it('is atomic: a job that cannot be queued leaves no explainer behind', async () => {
        world.db.routes.unshift([/^INSERT INTO studio_jobs/, () => { throw new Error('connection terminated'); }]);
        await assert.rejects(createExplainer(TENANT, { topic: 'Why AI answers with confidence' }, NOW), /connection terminated/);
        assert.equal(world.explainers.size, 0);
    });

    it('is refused for a tenant the Mac is not for, with no row: Claude’s work on the Mac is the owner’s', async () => {
        world.restore();
        world = installWorld({ tenant: TENANT, owner: OTHER });
        world.settingsRow = explainerSettings({ characters: [KARIM] });
        await assert.rejects(createExplainer(TENANT, { topic: 'Why AI answers with confidence' }, NOW), (err: unknown) => err instanceof MacBrainRefused);
        assert.equal(world.explainers.size, 0);
    });
});

// ─── Read ──────────────────────────────────────────────────────────────────────────────────────

describe('explainerIdOf', () => {
    it('is the id lower-cased, or a 404 with the explainer code before any query: a malformed uuid would be a Postgres error', () => {
        assert.equal(explainerIdOf(EXPLAINER.toUpperCase()), EXPLAINER);
        for (const bad of ['nope', '', undefined, null, 7, ['x'], '../etc']) assert.throws(() => explainerIdOf(bad), refused('EXPLAINER_NOT_FOUND', 404));
    });
});

describe('getExplainer and listExplainers', () => {
    it('reads the explainer with its scenes, whether the audio is out of date, and what the script breaks', async () => {
        draftExplainer({ audio: { url: up(1), media_id: id(1), duration: 60, voice: 'v', version: 0, words_version: 0, fallback: false } });
        const view = await getExplainer(TENANT, EXPLAINER);
        assert.equal(view.status, 'draft');
        assert.equal(view.scenes.length, 12);
        assert.equal(view.audio_stale, true, 'voiced at version 0, the script is at 1');
        assert.equal(view.scenes[0]!.position, 0);
        assert.equal(view.est_seconds, 71.4);
        assert.deepEqual(view.problems, []);
        assert.equal((view as unknown as Record<string, unknown>).creator_id, undefined, 'the tenant is not part of the view');
    });

    it('lists what the checks find, live from the scenes: never a stored copy that could go stale', async () => {
        draftExplainer({}, (i) => (i === 11 ? { narration: 'Comment YES if you agree', spoken: 'Comment YES if you agree' } : i === 2 ? { brief: 'she reads a book' } : {}));
        const view = await getExplainer(TENANT, EXPLAINER);
        assert.deepEqual(view.problems.map((p) => `${p.code}@${p.scene}`), ['female_subject@2', 'closing_question@11', 'engagement_bait@11']);
    });

    it('says how far a drawing is, and the first picture as the thumbnail', async () => {
        const picture = (n: number) => ({ media_id: id(n), url: up(n), seed: 1, provider: 'cloudflare', model: 'm', prompt_hash: 'h', at: '2026-10-25T09:00:00Z' });
        draftExplainer({ status: 'drawing' }, (i) => (i < 5 ? { draw_status: 'done', picture: picture(i + 1) } : {}));
        const view = await getExplainer(TENANT, EXPLAINER);
        assert.deepEqual(view.progress, { done: 5, total: 12 });
        assert.equal(view.thumb_url, up(1));
        draftExplainer({ id: OTHER, status: 'review' });
        assert.equal((await listExplainers(TENANT)).find((i) => i.id === OTHER)!.progress, null, 'only while drawing');
    });

    it('says whether the Mac is there, and when a render is older than the edits (a new version of the narration, or another sound)', async () => {
        world.workerLastSeen = new Date(Date.now() - 5_000);
        const render = { vertical_url: up(2), horizontal_url: up(3), cover_url: up(4), duration: 70, sound_mode: 'sfx' as const, version: 1, job_id: JOB };
        draftExplainer({ status: 'ready', render, draft_version: 1 });
        let view = await getExplainer(TENANT, EXPLAINER);
        assert.equal(view.worker!.online, true);
        assert.equal(view.render_stale, false);
        world.explainers.set(EXPLAINER, { ...world.explainer(), draft_version: 2 });
        assert.equal((await getExplainer(TENANT, EXPLAINER)).render_stale, true);
        world.explainers.set(EXPLAINER, { ...world.explainer(), draft_version: 1, sound_mode: 'music' });
        view = await getExplainer(TENANT, EXPLAINER);
        assert.equal(view.render_stale, true, 'rendered with sound effects, now music');
    });

    it('carries the allowance when it is given one, and null when it is not or when it fails', async () => {
        draftExplainer();
        assert.equal((await getExplainer(TENANT, EXPLAINER)).allowance, null);
        assert.deepEqual((await getExplainer(TENANT, EXPLAINER, { allowance: async () => ({ provider: 'cloudflare', pictures: 3 }) })).allowance, { provider: 'cloudflare', pictures: 3 });
        assert.equal((await getExplainer(TENANT, EXPLAINER, { allowance: async () => { throw new Error('down'); } })).allowance, null);
    });

    it('is a 404 for an explainer that is not there, and for another tenant’s', async () => {
        await assert.rejects(getExplainer(TENANT, EXPLAINER), refused('EXPLAINER_NOT_FOUND', 404));
        draftExplainer();
        await assert.rejects(getExplainer(OTHER, EXPLAINER), refused('EXPLAINER_NOT_FOUND', 404));
        await assert.rejects(getExplainer(TENANT, 'nope'), refused('EXPLAINER_NOT_FOUND', 404));
    });

    it('lists the newest first, as summaries, for this tenant only', async () => {
        world.addExplainer({ id: id(1), status: 'ready', created_at: new Date('2026-10-20T00:00:00Z') });
        world.addExplainer({ id: id(2), status: 'draft', created_at: new Date('2026-10-24T00:00:00Z'), draft: { writer: 'gemini', captions: validWriterOutput().captions, first_comment: '', replies: [], sources: [], est_seconds: 80, warnings: [] } });
        world.addExplainer({ id: id(3), creator_id: OTHER, status: 'draft', created_at: new Date('2026-10-25T00:00:00Z') });
        const items = await listExplainers(TENANT);
        assert.deepEqual(items.map((i) => i.id), [id(2), id(1)]);
        assert.equal(items[0]!.est_seconds, 80);
        assert.equal((items[0] as unknown as Record<string, unknown>).draft, undefined, 'a summary, not the draft');
    });

    it('reading a writing explainer whose Mac job has sat unclaimed for ten minutes hands the work to Gemini (the lazy check), and starts a run', async () => {
        const job = world.addJob({ id: JOB, kind: 'explainer_write', status: 'pending', payload: { explainer_id: EXPLAINER }, created_at: new Date(Date.now() - 11 * 60_000) });
        world.addExplainer({ status: 'writing', job_id: job.id, title: null, draft: null, draft_version: 0 });
        const view = await getExplainer(TENANT, EXPLAINER);
        assert.equal(world.jobs.find((j) => j.id === JOB)!.status, 'failed', 'the Mac’s job is closed');
        assert.equal(launched.length, 1);
        assert.equal(view.job!.status, 'claimed');
        assert.match(view.error ?? '', /The Mac did not pick this up in 10 minutes and is off or asleep, so Gemini is writing it/);
        await launched[0];
    });
});

// ─── A script that waits for a Mac that is up ──────────────────────────────────────────────────

/**
 * The Mac runs two jobs at a time, so a script can wait for a slot while the Mac is up. That is said on the explainer (`job.progress`), and it is not a reason
 * for Gemini to step in (writing.ts, tested there): the owner is told what the wait is instead of seeing a blank line, or a failure on a free Gemini key.
 */
describe('a script waiting for a Mac that is up and busy', () => {
    const seen = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000);
    /** A writing explainer whose Mac job was queued `minutes` before NOW and has not been claimed. */
    function waitingFor(minutes: number, jobOver: object = {}, over: Partial<ExplainerRow> = {}) {
        const job = world.addJob({ id: JOB, kind: 'explainer_write', status: 'pending', payload: { explainer_id: EXPLAINER }, created_at: new Date(NOW - minutes * 60_000), ...jobOver });
        world.addExplainer({ status: 'writing', job_id: job.id, title: null, draft: null, draft_version: 0, ...over });
        return job;
    }

    it('says so: the Mac is up, the job has waited longer than a free Mac would take to poll, so it is waiting for a slot', async () => {
        waitingFor(4);
        world.addWorker({ last_seen_at: seen(15) });
        const view = await getExplainer(TENANT, EXPLAINER, { now: NOW });
        assert.equal(view.status, 'writing');
        assert.deepEqual(view.job, { status: 'pending', progress: 'Waiting for your Mac: it is busy with another job', not_before: world.jobs[0]!.not_before });
        assert.equal(BUSY_MAC_NOTE, 'Waiting for your Mac: it is busy with another job');
    });

    it('does not hand an hour-old script of a busy Mac to Gemini when the dashboard reads it: no run, the Mac’s job still open, and the line says why it waits', async () => {
        const job = waitingFor(60);
        world.addWorker({ last_seen_at: seen(8) });
        const view = await getExplainer(TENANT, EXPLAINER, { now: NOW });
        assert.equal(launched.length, 0);
        assert.equal(job.status, 'pending');
        assert.equal(view.job!.status, 'pending');
        assert.equal(view.job!.progress, BUSY_MAC_NOTE);
        assert.equal(view.error, null, 'a wait is not a note about a takeover');
        assert.equal(world.jobs.filter((j) => j.payload.writer === 'gemini').length, 0);
    });

    it('when the same Mac has gone silent, the same read hands the work to Gemini, as before, and the line is Gemini’s', async () => {
        waitingFor(60);
        world.addWorker({ last_seen_at: new Date(NOW - 20 * 60_000) });
        const view = await getExplainer(TENANT, EXPLAINER, { now: NOW });
        assert.equal(launched.length, 1);
        assert.equal(view.job!.status, 'claimed');
        assert.equal(view.job!.progress, 'Gemini is writing it');
        await launched[0];
    });

    it('is not said before the job has waited a minute: a free Mac takes it within its poll, and "busy" would be a lie for those seconds', async () => {
        world.addWorker({ last_seen_at: seen(3) });
        waitingFor(BUSY_AFTER_SECONDS / 60 - 0.5);
        assert.equal((await getExplainer(TENANT, EXPLAINER, { now: NOW })).job!.progress, null);
        world.jobs.length = 0;
        world.explainers.clear();
        waitingFor(BUSY_AFTER_SECONDS / 60);
        assert.equal((await getExplainer(TENANT, EXPLAINER, { now: NOW })).job!.progress, BUSY_MAC_NOTE, 'at a minute exactly');
    });

    it('is not said when the Mac is not up: the card says offline, and a busy Mac is not what the job is waiting for', async () => {
        waitingFor(4);
        assert.equal((await getExplainer(TENANT, EXPLAINER, { now: NOW })).job!.progress, null, 'no worker');
        world.addWorker({ last_seen_at: new Date(NOW - 5 * 60_000) });
        assert.equal((await getExplainer(TENANT, EXPLAINER, { now: NOW })).job!.progress, null, 'silent for five minutes');
        world.workers.length = 0;
        world.addWorker({ last_seen_at: seen(2), revoked_at: new Date(NOW - 1000) });
        assert.equal((await getExplainer(TENANT, EXPLAINER, { now: NOW })).job!.progress, null, 'a revoked worker is not a Mac that is up');
    });

    it('never replaces what the job says itself, and is said of a pending job only: a claimed one has its own progress', async () => {
        waitingFor(4, { progress: 'queued by hand' });
        world.addWorker({ last_seen_at: seen(5) });
        assert.equal((await getExplainer(TENANT, EXPLAINER, { now: NOW })).job!.progress, 'queued by hand');
        world.jobs.length = 0;
        world.explainers.clear();
        waitingFor(4, { status: 'claimed', claimed_at: new Date(NOW - 120_000), heartbeat_at: new Date(NOW - 5000), progress: 'reading the first source' });
        assert.equal((await getExplainer(TENANT, EXPLAINER, { now: NOW })).job!.progress, 'reading the first source');
        world.jobs.length = 0;
        world.explainers.clear();
        waitingFor(4, { status: 'claimed', claimed_at: new Date(NOW - 120_000), heartbeat_at: new Date(NOW - 5000), progress: null });
        assert.equal((await getExplainer(TENANT, EXPLAINER, { now: NOW })).job!.progress, null, 'a job the Mac holds is not "waiting for a slot"');
    });

    it('is the writing step’s alone: a voice, a drawing or a render waiting for a busy Mac shows what it showed before', async () => {
        world.addWorker({ last_seen_at: seen(5) });
        for (const status of ['voicing', 'drawing', 'rendering'] as const) {
            world.jobs.length = 0;
            world.explainers.clear();
            waitingFor(4, {}, { status, title: 'T' });
            assert.equal((await getExplainer(TENANT, EXPLAINER, { now: NOW })).job!.progress, null, status);
        }
    });

    it('is not said of a job asked for later: that is waiting for a time', () => {
        const row = { ...world.addExplainer({ status: 'writing', job_id: JOB }), job_status: 'pending', job_progress: null, job_not_before: new Date(NOW + 3_600_000), job_created_at: new Date(NOW - 600_000) };
        assert.equal(presentExplainer(row, [], { worker: { online: true, lastSeen: new Date(NOW).toISOString(), name: 'Mac' }, now: NOW }).job!.progress, null);
        row.job_not_before = new Date(NOW - 1000);
        assert.equal(presentExplainer(row, [], { worker: { online: true, lastSeen: new Date(NOW).toISOString(), name: 'Mac' }, now: NOW }).job!.progress, BUSY_MAC_NOTE);
    });

    it('needs the worker’s answer: when the status card cannot be read, the view carries no line about a Mac it does not know', () => {
        const row = { ...world.addExplainer({ status: 'writing', job_id: JOB }), job_status: 'pending', job_progress: null, job_not_before: null, job_created_at: new Date(NOW - 600_000) };
        assert.equal(presentExplainer(row, [], { now: NOW }).job!.progress, null);
        assert.equal(presentExplainer(row, [], { worker: null, now: NOW }).job!.progress, null);
    });

    it('a row without the job’s creation time (an older reader) says nothing rather than guess', () => {
        const row = { ...world.addExplainer({ status: 'writing', job_id: JOB }), job_status: 'pending', job_progress: null, job_not_before: null };
        assert.equal(presentExplainer(row, [], { worker: { online: true, lastSeen: null, name: 'Mac' }, now: NOW }).job!.progress, null);
    });
});

// ─── Edit ──────────────────────────────────────────────────────────────────────────────────────

describe('editExplainer: what changes, and what it costs', () => {
    it('a label, a brief and a character edit do not touch the version: nothing is voiced again for them', async () => {
        draftExplainer({ audio: { url: up(1), media_id: id(1), duration: 60, voice: 'v', version: 1, words_version: 1, fallback: false }, status: 'review' });
        const edits = sceneEdits();
        edits[2]!.label = 'new label';
        edits[3]!.brief = 'karim holds a lantern in a dark library, wide shot';
        edits[4]!.characters = [];
        const view = await editExplainer(TENANT, EXPLAINER, { scenes: edits });
        assert.equal(view.draft_version, 1);
        assert.equal(view.audio_stale, false);
        assert.deepEqual([world.sceneRows()[2]!.label, world.sceneRows()[3]!.brief, world.sceneRows()[4]!.characters], ['new label', 'karim holds a lantern in a dark library, wide shot', []]);
    });

    it('a narration edit makes the audio out of date: the version moves and Re-voice is offered', async () => {
        draftExplainer({ audio: { url: up(1), media_id: id(1), duration: 60, voice: 'v', version: 1, words_version: 1, fallback: false }, status: 'review' });
        const edits = sceneEdits();
        edits[5]!.narration = 'A new sentence for the fifth scene of this script.';
        const view = await editExplainer(TENANT, EXPLAINER, { scenes: edits });
        assert.equal(view.draft_version, 2);
        assert.equal(view.audio_stale, true);
        assert.equal(view.status, 'review', 'the status does not move: the owner decides when to re-voice');
        assert.equal(world.sceneRows()[5]!.narration, 'A new sentence for the fifth scene of this script.');
    });

    it('what is spoken counts as narration too: the voice reads it', async () => {
        draftExplainer();
        const edits = sceneEdits();
        edits[5]!.spoken = 'Different words for the voice to say here.';
        assert.equal((await editExplainer(TENANT, EXPLAINER, { scenes: edits })).draft_version, 2);
    });

    it('the title, captions, first comment, replies and sources are saved without a new version, and the estimate and warnings are worked out again', async () => {
        draftExplainer();
        const view = await editExplainer(TENANT, EXPLAINER, {
            title: '  A better title  ',
            draft: {
                captions: { meta: 'm', youtube: { title: 'yt', description: 'yd' }, tiktok: 'tt' }, first_comment: 'Sources\n1. Lewis', replies: [{ q: 'q?', a: 'a.' }],
                sources: [{ title: 'Lewis', by: 'Lewis et al.', year: '2020', url: 'https://arxiv.org/abs/2005.11401' }],
            },
        });
        assert.equal(view.title, 'A better title');
        assert.equal(view.draft_version, 1);
        assert.deepEqual(view.draft!.captions, { meta: 'm', youtube: { title: 'yt', description: 'yd' }, tiktok: 'tt' });
        assert.equal(view.draft!.first_comment, 'Sources\n1. Lewis');
        assert.deepEqual(view.draft!.replies, [{ q: 'q?', a: 'a.' }]);
        assert.deepEqual(view.draft!.warnings.map((w) => w.code), ['few_sources'], 'one source is too few for a short explainer; 143 words at 2.5 a second is 57.2 s, inside its range');
        assert.equal(view.draft!.est_seconds, 57.2);
    });

    it('keeps the warning that the script was written with no web read: an edit does not research anything', async () => {
        draftExplainer({}, () => ({}));
        const row = world.explainer();
        world.explainers.set(EXPLAINER, { ...row, draft: { ...row.draft!, warnings: [{ code: 'research_limited', message: 'written from memory' }] } });
        const view = await editExplainer(TENANT, EXPLAINER, { title: 'Another title for it' });
        assert.ok(view.draft!.warnings.some((w) => w.code === 'research_limited'));
    });

    it('the sound and the subtitles are saved in any state that is not scheduled or rendering, even failed (a deleted track is fixed this way)', async () => {
        draftExplainer({ status: 'failed', failed_step: 'render', error: 'the track is gone', sound_mode: 'music', music_track_id: 'gone' });
        const view = await editExplainer(TENANT, EXPLAINER, { sound_mode: 'sfx', music_track_id: null, subtitles: false });
        assert.deepEqual([view.sound_mode, view.music_track_id, view.subtitles, view.status], ['sfx', null, false, 'failed']);
        const music = await editExplainer(TENANT, EXPLAINER, { sound_mode: 'music', music_track_id: 'calm-01' });
        assert.deepEqual([music.sound_mode, music.music_track_id], ['music', 'calm-01']);
    });

    it('adds and removes scenes before the narration is voiced, renumbered from 0, and not after', async () => {
        draftExplainer();
        const fewer = sceneEdits().filter((_, i) => i !== 5);
        const view = await editExplainer(TENANT, EXPLAINER, { scenes: fewer });
        assert.equal(view.scenes.length, 11);
        assert.equal(view.draft_version, 2, 'a script with a scene fewer has other words');
        assert.deepEqual(world.sceneRows().map((s) => s.position), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

        world.scenes.length = 0;
        world.explainers.clear();
        draftExplainer({ status: 'review', audio: { url: up(1), media_id: id(1), duration: 60, voice: 'v', version: 1, words_version: 1, fallback: false } });
        await assert.rejects(editExplainer(TENANT, EXPLAINER, { scenes: sceneEdits().filter((_, i) => i !== 5) }), refused('EXPLAINER_BAD_STATE', 409));
        assert.equal(world.sceneRows().length, 12);
    });

    it('does not lose a picture on an in-place edit: the scene keeps its picture, its times and its draw status', async () => {
        const picture = { media_id: id(5), url: up(5), seed: 1, provider: 'cloudflare', model: 'm', prompt_hash: 'h', at: '2026-10-25T09:00:00Z' };
        draftExplainer({ status: 'review', audio: { url: up(1), media_id: id(1), duration: 60, voice: 'v', version: 1, words_version: 1, fallback: false } },
            (i) => ({ picture, draw_status: 'done', start_s: i * 5, end_s: i * 5 + 5 }));
        const edits = sceneEdits();
        edits[1]!.label = 'edited';
        await editExplainer(TENANT, EXPLAINER, { scenes: edits });
        const scene = world.sceneRows()[1]!;
        assert.deepEqual([scene.label, scene.picture, scene.draw_status, scene.start_s, scene.end_s], ['edited', picture, 'done', 5, 10]);
    });
});

describe('editExplainer: a save may not add a problem', () => {
    const refusal = async (body: unknown): Promise<ExplainerError> => {
        try {
            await editExplainer(TENANT, EXPLAINER, body);
        } catch (err) {
            assert.ok(err instanceof ExplainerError, String(err));
            return err;
        }
        throw new Error('the save was not refused');
    };

    it('refuses a closing line that is not a question, and engagement bait, with every finding, and stores nothing', async () => {
        draftExplainer();
        const edits = sceneEdits();
        edits[11]!.narration = 'Comment YES if you agree';
        edits[11]!.spoken = 'Comment YES if you agree';
        const err = await refusal({ scenes: edits });
        assert.equal(err.code, 'EXPLAINER_DRAFT_REFUSED');
        assert.equal(err.status, 422);
        assert.deepEqual((err.extra!.findings as { code: string }[]).map((f) => f.code), ['closing_question', 'engagement_bait']);
        assert.deepEqual(err.extra!.problems, (err.extra!.findings as { message: string }[]).map((f) => f.message));
        assert.deepEqual(err.params, { found: 2 });
        assert.equal(world.sceneRows()[11]!.narration, CLOSING_QUESTION, 'nothing was stored');
        assert.equal(world.explainer().draft_version, 1);
    });

    it('refuses a woman in a picture brief, a label of more than four words, an empty narration and a field past its limit, all together', async () => {
        draftExplainer();
        const edits = sceneEdits();
        edits[1]!.brief = 'a woman reads a book';
        edits[2]!.label = 'one two three four five';
        edits[3]!.narration = '   ';
        edits[4]!.narration = 'x'.repeat(301);
        const err = await refusal({ scenes: edits });
        assert.deepEqual((err.extra!.findings as { code: string; scene: number }[]).map((f) => `${f.code}@${f.scene}`), ['female_subject@1', 'label_too_long@2', 'field_empty@3', 'field_too_long@4']);
    });

    it('refuses a title past 70 characters, as a finding like any other: a saved one must fit the bar at the top of the video', async () => {
        draftExplainer();
        const err = await refusal({ title: 'x'.repeat(71) });
        assert.deepEqual((err.extra!.findings as { code: string; field: string }[]).map((f) => `${f.code}:${f.field}`), ['field_too_long:title']);
        assert.equal(world.explainer().title, 'Why AI answers with confidence');
    });

    it('refusing the closing question’s removal: a script that loses its last scene loses the question', async () => {
        draftExplainer();
        const err = await refusal({ scenes: sceneEdits().slice(0, 11) });
        assert.deepEqual((err.extra!.findings as { code: string }[]).map((f) => f.code), ['closing_question']);
    });

    it('lets a save through that does not touch a problem the draft already has, and refuses one that adds another', async () => {
        draftExplainer({}, (i) => (i === 3 ? { brief: 'she reads a book at a desk' } : {}));
        const view = await editExplainer(TENANT, EXPLAINER, { draft: { first_comment: 'Sources\n1. Lewis' } });
        assert.deepEqual(view.problems.map((p) => p.code), ['female_subject'], 'still listed, and still blocks approval');
        const edits = sceneEdits();
        edits[7]!.brief = 'the girl reads a book';
        const err = await refusal({ scenes: edits });
        assert.deepEqual((err.extra!.findings as { scene: number }[]).map((f) => f.scene), [3, 7], 'the whole list, so it is fixed in one pass');
    });

    it('lets the owner fix a problem the writer left, one at a time', async () => {
        draftExplainer({}, (i) => (i === 3 ? { brief: 'she reads a book at a desk' } : i === 9 ? { brief: 'the mother reads a book' } : {}));
        const edits = sceneEdits();
        edits[3]!.brief = 'karim reads a book at a desk, wide shot';
        const view = await editExplainer(TENANT, EXPLAINER, { scenes: edits });
        assert.deepEqual(view.problems.map((p) => p.scene), [9]);
    });
});

describe('editExplainer: what a step refuses to have changed while it runs', () => {
    const refusedEdit = (body: unknown) => assert.rejects(editExplainer(TENANT, EXPLAINER, body), refused('EXPLAINER_BAD_STATE', 409));

    it('while writing: the script is being replaced, so nothing of it is edited; the sound still is', async () => {
        draftExplainer({ status: 'writing', job_id: null });
        await refusedEdit({ title: 'A title for the script' });
        await refusedEdit({ scenes: sceneEdits() });
        await refusedEdit({ draft: { first_comment: 'x' } });
        assert.equal((await editExplainer(TENANT, EXPLAINER, { subtitles: false })).subtitles, false);
    });

    it('while voicing: the narration is not edited, a label is', async () => {
        draftExplainer({ status: 'voicing' });
        const narration = sceneEdits();
        narration[0]!.narration = 'Changed while it is being voiced.';
        await refusedEdit({ scenes: narration });
        const label = sceneEdits();
        label[0]!.label = 'a label';
        assert.equal((await editExplainer(TENANT, EXPLAINER, { scenes: label })).scenes[0]!.label, 'a label');
    });

    it('while rendering: the title, a label and the sound are not edited; a caption is', async () => {
        draftExplainer({ status: 'rendering' });
        await refusedEdit({ title: 'A different title here' });
        const label = sceneEdits();
        label[0]!.label = 'a label';
        await refusedEdit({ scenes: label });
        await refusedEdit({ sound_mode: 'music' });
        await refusedEdit({ subtitles: false });
        const view = await editExplainer(TENANT, EXPLAINER, { draft: { first_comment: 'Sources\n1. Lewis' } });
        assert.equal(view.draft!.first_comment, 'Sources\n1. Lewis');
    });

    it('once scheduled: nothing, since the posts exist', async () => {
        draftExplainer({ status: 'scheduled' });
        await refusedEdit({ title: 'A different title here' });
        await refusedEdit({ subtitles: false });
    });

    it('with no draft yet there is nothing to edit', async () => {
        world.addExplainer({ status: 'failed', failed_step: 'write', error: 'x', draft: null, title: null });
        await refusedEdit({ draft: { first_comment: 'x' } });
    });
});

describe('editExplainer: the body', () => {
    it('says what to send when there is nothing, and refuses a key it does not know, a wrong type and an unknown character', async () => {
        draftExplainer();
        await assert.rejects(editExplainer(TENANT, EXPLAINER, {}), studioError(400));
        await assert.rejects(editExplainer(TENANT, EXPLAINER, 'x'), studioError(400));
        const problems = async (body: unknown): Promise<string[]> => {
            try {
                await editExplainer(TENANT, EXPLAINER, body);
            } catch (err) {
                return (err as StudioError).problems ?? [(err as Error).message];
            }
            return [];
        };
        assert.deepEqual(await problems({ language: 'en' }), ['language is not something an explainer\'s edit can change']);
        assert.deepEqual(await problems({ draft: { audio: {} } }), ['draft.audio is not something an explainer\'s edit can change']);
        assert.deepEqual(await problems({ sound_mode: 'silent', subtitles: 'yes', music_track_id: 'nope', title: '  ' }), [
            'title is empty', 'sound_mode must be music or sfx', 'music_track_id must be the key of a track in your library, or null', 'subtitles must be true or false',
        ]);
        const edits = sceneEdits();
        edits[0]!.characters = ['karim', 'ghost'];
        assert.match((await problems({ scenes: edits })).join(), /scenes\[0\]\.characters names "ghost", which is not one of your characters/);
        assert.deepEqual(await problems({ scenes: [] }), ['scenes must be the whole list, in order: from 1 to 300 scenes']);
        assert.match((await problems({ scenes: [{ narration: 1 }] })).join(), /scenes\[0\]\.narration must be text/);
        assert.match((await problems({ draft: { replies: Array.from({ length: 11 }, () => ({ q: 'q', a: 'a' })) } })).join(), /at most 10/);
        assert.match((await problems({ draft: { sources: [{ title: 't', by: 'b', year: '2020', url: 'javascript:x' }] } })).join(), /must be an http or https link/);
        assert.match((await problems({ draft: { captions: { meta: 'x'.repeat(2201), youtube: { title: 't', description: 'd' }, tiktok: 'k' } } })).join(), /captions\.meta is longer than 2200/);
    });

    it('is a 404 for an explainer that is not the tenant’s', async () => {
        draftExplainer();
        await assert.rejects(editExplainer(OTHER, EXPLAINER, { subtitles: false }), refused('EXPLAINER_NOT_FOUND', 404));
    });
});

// ─── Rewrite ───────────────────────────────────────────────────────────────────────────────────

describe('rewriteExplainer', () => {
    it('queues a write with the note and the draft it is about, moves to writing, and keeps the previous draft on screen until the new one arrives', async () => {
        draftExplainer();
        const view = await rewriteExplainer(TENANT, EXPLAINER, { note: '  shorter hook, add the 2020 result  ' }, NOW);
        assert.equal(view.status, 'writing');
        assert.equal(world.explainer().rewrite_note, 'shorter hook, add the 2020 result');
        assert.equal(view.scenes.length, 12, 'the old scenes are still there');
        assert.ok(view.draft, 'and the old draft');
        const [job] = world.jobsOf('explainer_write');
        assert.equal(world.explainer().job_id, job!.id);
        assert.equal(job!.payload.rewrite_note, 'shorter hook, add the 2020 result');
        assert.equal(job!.payload.previous_draft.scenes.length, 12);
        assert.equal(job!.payload.previous_draft.title, 'Why AI answers with confidence');
        assert.match(job!.payload.write.user, /REWRITE REQUEST from the creator: shorter hook, add the 2020 result/);
        assert.match(job!.payload.write.user, /Previous draft:\n\{"title":"Why AI answers with confidence"/);
    });

    it('needs a note, and a draft to rewrite', async () => {
        draftExplainer();
        await assert.rejects(rewriteExplainer(TENANT, EXPLAINER, {}, NOW), studioError(400));
        await assert.rejects(rewriteExplainer(TENANT, EXPLAINER, { note: '   ' }, NOW), studioError(400));
        await assert.rejects(rewriteExplainer(TENANT, EXPLAINER, { note: 'x'.repeat(2001) }, NOW), studioError(400));
        world.explainers.set(EXPLAINER, { ...world.explainer(), status: 'voicing' });
        await assert.rejects(rewriteExplainer(TENANT, EXPLAINER, { note: 'shorter' }, NOW), refused('EXPLAINER_BAD_STATE', 409));
        assert.equal(world.jobsOf('explainer_write').length, 0);
    });

    it('with Gemini chosen: Gemini’s own job, claimed by the server, and a run started after the commit', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM], writer: 'gemini' });
        draftExplainer();
        await rewriteExplainer(TENANT, EXPLAINER, { note: 'shorter hook' }, NOW);
        assert.equal(world.jobsOf('explainer_write')[0]!.status, 'claimed');
        assert.equal(launched.length, 1);
        await launched[0];
    });
});

// ─── Approve (gate 1) ──────────────────────────────────────────────────────────────────────────

describe('approveExplainer', () => {
    it('voices the script as the owner read it: the voice job, with his voice and style and the spoken words at that version, and the status voicing', async () => {
        draftExplainer({ language: 'en', draft_version: 3 });
        const view = await approveExplainer(TENANT, EXPLAINER, { version: 3 });
        assert.equal(view.status, 'voicing');
        const [job] = world.jobsOf('explainer_voice');
        assert.equal(world.explainer().job_id, job!.id);
        assert.equal(job!.status, 'pending');
        assert.deepEqual(Object.keys(job!.payload).sort(), ['chunk_seconds_max', 'explainer_id', 'language', 'scenes', 'style', 'version', 'voice']);
        assert.deepEqual([job!.payload.explainer_id, job!.payload.version, job!.payload.language, job!.payload.voice, job!.payload.chunk_seconds_max], [EXPLAINER, 3, 'en', 'Sadaltager', 180]);
        assert.equal(job!.payload.style, 'a calm, warm documentary narrator; clear, unhurried, curious');
        assert.equal(job!.payload.scenes.length, 12);
        assert.deepEqual(job!.payload.scenes[0], { position: 0, spoken: world.sceneRows()[0]!.spoken });
    });

    it('uses the Arabic voice from the settings for an Arabic explainer', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM], voices: { ar: 'Charon', en: 'Sadaltager' }, voice_style: 'slow and warm' });
        draftExplainer({ language: 'ar' });
        await approveExplainer(TENANT, EXPLAINER, { version: 1 });
        assert.deepEqual([world.jobsOf('explainer_voice')[0]!.payload.voice, world.jobsOf('explainer_voice')[0]!.payload.style], ['Charon', 'slow and warm']);
    });

    it('is a 409 CHANGED_MEANWHILE when the script moved on since it was read, and queues nothing', async () => {
        draftExplainer({ draft_version: 4 });
        await assert.rejects(approveExplainer(TENANT, EXPLAINER, { version: 3 }), studioError(409, 'CHANGED_MEANWHILE'));
        assert.equal(world.explainer().status, 'draft');
        assert.equal(world.jobsOf('explainer_voice').length, 0);
    });

    it('needs the version, as a whole number', async () => {
        draftExplainer();
        for (const body of [{}, { version: '1' }, { version: 1.5 }, { version: -1 }, null]) await assert.rejects(approveExplainer(TENANT, EXPLAINER, body), studioError(400));
    });

    it('refuses a script with a problem left in it, with every finding, so the owner fixes it in one pass', async () => {
        draftExplainer({}, (i) => (i === 3 ? { brief: 'she reads a book' } : i === 11 ? { narration: 'Type 1 if you agree', spoken: 'Type 1 if you agree' } : {}));
        await assert.rejects(approveExplainer(TENANT, EXPLAINER, { version: 1 }), (err: unknown) => refused('EXPLAINER_DRAFT_REFUSED', 422)(err)
            && (err as ExplainerError).params?.found === 3 && ((err as ExplainerError).extra!.findings as { code: string }[]).map((f) => f.code).join() === 'female_subject,closing_question,engagement_bait');
        assert.equal(world.explainer().status, 'draft');
        assert.equal(world.jobsOf('explainer_voice').length, 0);
    });

    it('refuses a script with no title: the bar at the top of the video needs one', async () => {
        draftExplainer({ title: null });
        await assert.rejects(approveExplainer(TENANT, EXPLAINER, { version: 1 }), (err: unknown) => refused('EXPLAINER_DRAFT_REFUSED', 422)(err) && /The title is empty/.test((err as Error).message));
    });

    it('approves over warnings: a script that runs short or has few sources is the owner’s to judge', async () => {
        draftExplainer({}, () => ({}));
        const row = world.explainer();
        world.explainers.set(EXPLAINER, { ...row, draft: { ...row.draft!, warnings: [{ code: 'few_sources', message: 'x' }, { code: 'research_limited', message: 'y' }] } });
        assert.equal((await approveExplainer(TENANT, EXPLAINER, { version: 1 })).status, 'voicing');
    });

    it('is only for a draft', async () => {
        for (const status of ['writing', 'voicing', 'drawing', 'review', 'rendering', 'ready', 'scheduled', 'failed'] as const) {
            world.explainers.clear();
            world.scenes.length = 0;
            draftExplainer({ status, ...(status === 'failed' ? { failed_step: 'write' as const } : {}) });
            await assert.rejects(approveExplainer(TENANT, EXPLAINER, { version: 1 }), refused('EXPLAINER_BAD_STATE', 409), status);
        }
        assert.equal(world.jobsOf('explainer_voice').length, 0);
    });

    it('is atomic: a move that fails queues no voice', async () => {
        draftExplainer();
        world.db.routes.unshift([/^UPDATE explainers SET status = \$2/, () => { throw new Error('connection terminated'); }]);
        await assert.rejects(approveExplainer(TENANT, EXPLAINER, { version: 1 }), /connection terminated/);
        assert.equal(world.jobsOf('explainer_voice').length, 0);
    });
});

// ─── Re-voice ──────────────────────────────────────────────────────────────────────────────────

describe('revoiceExplainer', () => {
    const audio = (version: number) => ({ url: up(1), media_id: id(1), duration: 60, voice: 'v', version, words_version: version, fallback: false });

    it('voices the narration again, at its new version, once the narration changed after it was voiced', async () => {
        draftExplainer({ status: 'review', draft_version: 2, audio: audio(1) });
        const view = await revoiceExplainer(TENANT, EXPLAINER);
        assert.equal(view.status, 'voicing');
        assert.equal(world.jobsOf('explainer_voice')[0]!.payload.version, 2);
        assert.equal(world.explainer().job_id, world.jobsOf('explainer_voice')[0]!.id);
    });

    it('works from drawing and from ready, and fails the drawing job nobody has claimed', async () => {
        const drawing = world.addJob({ kind: 'explainer_draw', status: 'pending', payload: { explainer_id: EXPLAINER } });
        draftExplainer({ status: 'drawing', draft_version: 2, audio: audio(1), job_id: drawing.id, draw_paused_until: new Date('2026-10-26T00:00:00Z') });
        await revoiceExplainer(TENANT, EXPLAINER);
        assert.equal(drawing.status, 'failed');
        assert.equal(world.explainer().draw_paused_until, null);
        world.explainers.clear();
        world.scenes.length = 0;
        draftExplainer({ status: 'ready', draft_version: 2, audio: audio(1) });
        assert.equal((await revoiceExplainer(TENANT, EXPLAINER)).status, 'voicing');
    });

    it('is refused while the audio is fresh: there is nothing to say again', async () => {
        draftExplainer({ status: 'review', draft_version: 1, audio: audio(1) });
        await assert.rejects(revoiceExplainer(TENANT, EXPLAINER), (err: unknown) => refused('EXPLAINER_BAD_STATE', 409)(err) && /has not changed since it was voiced/.test((err as Error).message));
        assert.equal(world.jobsOf('explainer_voice').length, 0);
    });

    it('is refused where there is no voiced narration to be out of date, and once scheduled', async () => {
        for (const status of ['draft', 'writing', 'voicing', 'rendering', 'scheduled', 'failed'] as const) {
            world.explainers.clear();
            world.scenes.length = 0;
            draftExplainer({ status, draft_version: 2, audio: audio(1), ...(status === 'failed' ? { failed_step: 'render' as const } : {}) });
            await assert.rejects(revoiceExplainer(TENANT, EXPLAINER), refused('EXPLAINER_BAD_STATE', 409), status);
        }
    });
});

// ─── Draw ──────────────────────────────────────────────────────────────────────────────────────

describe('startDraw', () => {
    const audio = { url: up(1), media_id: id(1), duration: 60, voice: 'v', version: 1, words_version: 1, fallback: false };

    it('queues the unattended drawing, and asks again for the scenes that failed and for any whose drawing a crash left half done', async () => {
        draftExplainer({ status: 'drawing', audio }, (i) => ({
            draw_status: i === 0 ? 'done' : i === 1 ? 'failed' : i === 2 ? 'drawing' : i === 3 ? 'drawing' : 'pending', draw_error: i === 1 ? 'refused' : null,
            updated_at: i === 2 ? new Date(world.now.getTime() - 5 * 60_000) : world.now,
        }));
        const view = await startDraw(TENANT, EXPLAINER);
        const [job] = world.jobsOf('explainer_draw');
        assert.deepEqual(job!.payload, { explainer_id: EXPLAINER });
        assert.equal(view.job!.status, 'pending');
        assert.deepEqual(world.sceneRows().slice(0, 4).map((s) => s.draw_status), ['done', 'pending', 'pending', 'drawing'], 'the one drawing a moment ago is not touched');
        assert.equal(world.sceneRows()[1]!.draw_error, null);
        assert.equal(world.explainer().error, null);
    });

    it('is one job when pressed twice: a drawing on its way is left alone', async () => {
        draftExplainer({ status: 'drawing', audio });
        await startDraw(TENANT, EXPLAINER);
        await startDraw(TENANT, EXPLAINER);
        assert.equal(world.jobsOf('explainer_draw').length, 1);
        world.jobsOf('explainer_draw')[0]!.status = 'claimed';
        await startDraw(TENANT, EXPLAINER);
        assert.equal(world.jobsOf('explainer_draw').length, 1);
    });

    it('replaces a drawing that is waiting for tomorrow with one that goes now: if the allowance is still spent it pauses again', async () => {
        const waiting = world.addJob({ kind: 'explainer_draw', status: 'pending', payload: { explainer_id: EXPLAINER }, not_before: new Date(Date.now() + 8 * 3_600_000) });
        draftExplainer({ status: 'drawing', audio, job_id: waiting.id, draw_paused_until: waiting.not_before, error: 'Waiting for the image allowance to reset' });
        await startDraw(TENANT, EXPLAINER);
        assert.equal(waiting.status, 'failed');
        const now = world.jobsOf('explainer_draw').find((j) => j.id !== waiting.id)!;
        assert.equal(world.explainer().job_id, now.id);
        assert.equal(world.explainer().error, null);
        assert.equal(world.explainer().draw_paused_until, null);
    });

    it('is only for an explainer that is drawing', async () => {
        for (const status of ['draft', 'voicing', 'review', 'rendering', 'ready', 'scheduled'] as const) {
            world.explainers.clear();
            world.scenes.length = 0;
            draftExplainer({ status });
            await assert.rejects(startDraw(TENANT, EXPLAINER), refused('EXPLAINER_BAD_STATE', 409), status);
        }
    });
});

// ─── Render (gate 2) ───────────────────────────────────────────────────────────────────────────

const picture = (n: number) => ({ media_id: id(n), url: `/api/uploads/${id(n)}`, seed: n, provider: 'cloudflare', model: 'flux', prompt_hash: 'h', at: '2026-10-25T09:00:00Z' });
const voiced = { url: up(1), media_id: id(1), duration: 71.2, voice: 'ar-001-commercial-3', version: 1, words_version: 1, fallback: false };

/** An explainer in review with twelve scenes, each with a picture and times, and the audio that goes with them. */
function reviewExplainer(over: Partial<ExplainerRow> = {}, sceneOver: (position: number) => object = () => ({})) {
    const row = draftExplainer({ status: 'review', audio: voiced, words: { '0': [[0, 0.5, 'The']] }, ...over }, (i) => ({
        picture: picture(i + 20), draw_status: 'done', start_s: i * 6, end_s: i * 6 + 6, ...sceneOver(i),
    }));
    return row;
}

describe('approvePictures', () => {
    it('renders it: the render job, with the audio, the timed scenes with their labels and pictures, the words, the brand and the sound; the status rendering', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM], music: [TRACK], title_color: '#FFD43B' });
        world.settingsRow.infographic = { ...defaultInfographicConfig(), name: { ar: 'سامي', en: 'Sam Lee' }, handle: '@samlee', site: 'samlee.example', photo_url: `/api/uploads/${id(8)}` };
        reviewExplainer({ language: 'en', sound_mode: 'music', music_track_id: 'calm-01', subtitles: false });
        const view = await approvePictures(TENANT, EXPLAINER);
        assert.equal(view.status, 'rendering');
        const [job] = world.jobsOf('explainer_render');
        assert.equal(world.explainer().job_id, job!.id);
        const p = job!.payload;
        assert.deepEqual(Object.keys(p).sort(), ['audio', 'brand', 'explainer_id', 'formats', 'language', 'music', 'scenes', 'sfx', 'sound_mode', 'subtitles', 'title', 'title_color', 'version', 'words']);
        assert.deepEqual([p.explainer_id, p.version, p.title, p.language, p.subtitles, p.sound_mode, p.sfx, p.title_color], [EXPLAINER, 1, 'Why AI answers with confidence', 'en', false, 'music', false, '#FFD43B']);
        assert.deepEqual(p.audio, { url: up(1), duration: 71.2 });
        assert.deepEqual(p.music, { url: `${BASE}/api/uploads/${id(9)}`, credit_required: true }, 'the track’s address is made absolute for the worker');
        assert.deepEqual(p.formats, ['vertical', 'horizontal']);
        assert.equal(p.scenes.length, 12);
        assert.deepEqual(p.scenes[1], { position: 1, start: 6, end: 12, label: 'idea 1', picture_url: `${BASE}/api/uploads/${id(21)}` });
        // The subtitles show each scene's narration as written, on its spoken words' times (subtitles.ts). This fixture voiced one word of scene 0,
        // so the whole narration rides on it.
        assert.deepEqual(p.words, { '0': [[0, 0.5, `${SENTENCE} (0)`]] });
        assert.deepEqual(p.brand, { name: 'Sam Lee', handle: '@samlee', site: 'samlee.example', photo_url: `${BASE}/api/uploads/${id(8)}` });
    });

    it('sends the Arabic name for an Arabic video, and the other when one is missing', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM] });
        world.settingsRow.infographic = { ...defaultInfographicConfig(), name: { ar: 'السيد', en: '' }, handle: '@h', site: 's' };
        reviewExplainer({ language: 'ar' });
        await approvePictures(TENANT, EXPLAINER);
        assert.equal(world.jobsOf('explainer_render')[0]!.payload.brand.name, 'السيد');
        assert.equal(world.jobsOf('explainer_render')[0]!.payload.sfx, true);
        assert.equal(world.jobsOf('explainer_render')[0]!.payload.music, undefined);
    });

    it('a scene that continues shows the picture before it, and every scene must end up with one', async () => {
        reviewExplainer({}, (i) => (i === 4 ? { continues: true, picture: null, draw_status: 'done' } : {}));
        await approvePictures(TENANT, EXPLAINER);
        const scenes = world.jobsOf('explainer_render')[0]!.payload.scenes;
        assert.equal(scenes[4].picture_url, scenes[3].picture_url);
    });

    it('is refused while a scene has no picture: 409 EXPLAINER_PICTURES_MISSING, with the count and which', async () => {
        reviewExplainer({}, (i) => (i === 2 || i === 9 ? { picture: null, draw_status: 'failed' } : {}));
        await assert.rejects(approvePictures(TENANT, EXPLAINER), (err: unknown) => refused('EXPLAINER_PICTURES_MISSING', 409)(err)
            && (err as ExplainerError).params?.missing === 2 && JSON.stringify((err as ExplainerError).extra) === '{"positions":[2,9]}' && /2 scenes have no picture yet: 3, 10/.test((err as Error).message));
        assert.equal(world.explainer().status, 'review');
        assert.equal(world.jobsOf('explainer_render').length, 0);
    });

    it('is refused while the narration is out of date: 409 EXPLAINER_AUDIO_STALE, before anything is queued', async () => {
        reviewExplainer({ draft_version: 2 });
        await assert.rejects(approvePictures(TENANT, EXPLAINER), refused('EXPLAINER_AUDIO_STALE', 409));
        assert.equal(world.jobsOf('explainer_render').length, 0);
    });

    it('is refused when the sound is music and the track is not in the library: 409 EXPLAINER_NO_TRACK (a deleted track, or none chosen)', async () => {
        reviewExplainer({ sound_mode: 'music', music_track_id: 'gone' });
        await assert.rejects(approvePictures(TENANT, EXPLAINER), refused('EXPLAINER_NO_TRACK', 409));
        world.explainers.set(EXPLAINER, { ...world.explainer(), music_track_id: null });
        await assert.rejects(approvePictures(TENANT, EXPLAINER), refused('EXPLAINER_NO_TRACK', 409));
        world.explainers.set(EXPLAINER, { ...world.explainer(), sound_mode: 'sfx' });
        assert.equal((await approvePictures(TENANT, EXPLAINER)).status, 'rendering', 'sound effects need none');
    });

    it('is refused with no voiced narration at all, and outside review', async () => {
        reviewExplainer({ audio: null, words: null });
        await assert.rejects(approvePictures(TENANT, EXPLAINER), refused('EXPLAINER_BAD_STATE', 409));
        for (const status of ['draft', 'writing', 'voicing', 'drawing', 'rendering', 'ready', 'scheduled', 'failed'] as const) {
            world.explainers.clear();
            world.scenes.length = 0;
            reviewExplainer({ status, ...(status === 'failed' ? { failed_step: 'render' as const } : {}) });
            await assert.rejects(approvePictures(TENANT, EXPLAINER), refused('EXPLAINER_BAD_STATE', 409), status);
        }
        assert.equal(world.jobsOf('explainer_render').length, 0);
    });

    it('needs the app’s public address, which is where the worker downloads from', async () => {
        reviewExplainer();
        world.appSettings.delete('app.public_base_url');
        await assert.rejects(approvePictures(TENANT, EXPLAINER), studioError(500));
    });
});

describe('renderExplainer: a new render of a ready explainer', () => {
    const render = { vertical_url: up(2), horizontal_url: up(3), cover_url: up(4), duration: 70, sound_mode: 'sfx' as const, version: 1, job_id: 'old' };

    it('goes back to rendering and keeps the previous files until the new render lands', async () => {
        reviewExplainer({ status: 'ready', render });
        const view = await renderExplainer(TENANT, EXPLAINER);
        assert.equal(view.status, 'rendering');
        assert.deepEqual(world.explainer().render, render, 'the old files are still the explainer’s');
        assert.equal(world.jobsOf('explainer_render').length, 1);
    });

    it('is refused for the same reasons a first render is, and outside ready', async () => {
        reviewExplainer({ status: 'ready', render, draft_version: 2 });
        await assert.rejects(renderExplainer(TENANT, EXPLAINER), refused('EXPLAINER_AUDIO_STALE', 409));
        world.explainers.set(EXPLAINER, { ...world.explainer(), status: 'review', draft_version: 1 });
        await assert.rejects(renderExplainer(TENANT, EXPLAINER), refused('EXPLAINER_BAD_STATE', 409));
    });
});

// ─── Retry ─────────────────────────────────────────────────────────────────────────────────────

describe('retryExplainer: the failed step again', () => {
    const failed = (step: 'write' | 'voice' | 'draw' | 'render' | 'schedule', over: Partial<ExplainerRow> = {}) => ({ status: 'failed' as const, failed_step: step, error: 'it broke', ...over });

    it('write: queues the write again, from the same request', async () => {
        world.addExplainer(failed('write', { draft: null, title: null, draft_version: 0 }));
        const view = await retryExplainer(TENANT, EXPLAINER, NOW);
        assert.equal(view.status, 'writing');
        assert.equal(view.error, null);
        assert.equal(view.failed_step, null);
        const [job] = world.jobsOf('explainer_write');
        assert.equal(world.explainer().job_id, job!.id);
        assert.equal(job!.payload.rewrite_note, undefined);
    });

    it('write, after a rewrite that failed: the rewrite again, with the draft it was about', async () => {
        draftExplainer(failed('write', { rewrite_note: 'shorter hook' }));
        await retryExplainer(TENANT, EXPLAINER, NOW);
        const [job] = world.jobsOf('explainer_write');
        assert.equal(job!.payload.rewrite_note, 'shorter hook');
        assert.equal(job!.payload.previous_draft.scenes.length, 12);
    });

    it('write, with Gemini chosen: Gemini’s own job and a run', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM], writer: 'gemini' });
        world.addExplainer(failed('write', { draft: null, title: null, draft_version: 0 }));
        await retryExplainer(TENANT, EXPLAINER, NOW);
        assert.equal(world.jobsOf('explainer_write')[0]!.status, 'claimed');
        assert.equal(launched.length, 1);
        await launched[0];
    });

    it('voice: queues the voice again at the version it was asked at', async () => {
        draftExplainer(failed('voice', { draft_version: 5 }));
        const view = await retryExplainer(TENANT, EXPLAINER, NOW);
        assert.equal(view.status, 'voicing');
        assert.equal(world.jobsOf('explainer_voice')[0]!.payload.version, 5);
    });

    it('draw: asks again for the scenes that failed or were left drawing, and queues the drawing', async () => {
        draftExplainer(failed('draw', { audio: voiced }), (i) => ({ draw_status: i === 0 ? 'done' : i === 1 ? 'failed' : i === 2 ? 'drawing' : 'pending' }));
        const view = await retryExplainer(TENANT, EXPLAINER, NOW);
        assert.equal(view.status, 'drawing');
        assert.deepEqual(world.sceneRows().slice(0, 3).map((s) => s.draw_status), ['done', 'pending', 'pending']);
        assert.equal(world.jobsOf('explainer_draw').length, 1);
    });

    it('render: queues the render again, with the checks a render needs: a track that is gone is a refusal that says so, not a failure that repeats', async () => {
        reviewExplainer(failed('render', { sound_mode: 'music', music_track_id: 'gone' }));
        await assert.rejects(retryExplainer(TENANT, EXPLAINER, NOW), refused('EXPLAINER_NO_TRACK', 409));
        assert.equal(world.explainer().status, 'failed');
        world.explainers.set(EXPLAINER, { ...world.explainer(), sound_mode: 'sfx' });
        const view = await retryExplainer(TENANT, EXPLAINER, NOW);
        assert.equal(view.status, 'rendering');
        assert.equal(world.jobsOf('explainer_render').length, 1);
    });

    it('schedule: back to ready, where Schedule is pressed again', async () => {
        reviewExplainer(failed('schedule', { render: { vertical_url: up(2), horizontal_url: up(3), cover_url: up(4), duration: 70, sound_mode: 'sfx', version: 1, job_id: 'x' } }));
        assert.equal((await retryExplainer(TENANT, EXPLAINER, NOW)).status, 'ready');
        assert.equal(world.jobs.length, 0);
    });

    it('is only for a failed explainer', async () => {
        draftExplainer({ status: 'draft' });
        await assert.rejects(retryExplainer(TENANT, EXPLAINER, NOW), refused('EXPLAINER_BAD_STATE', 409));
    });
});

// ─── Delete ────────────────────────────────────────────────────────────────────────────────────

describe('deleteExplainer', () => {
    it('removes the explainer and its scenes, fails the job nobody has taken, and deletes every file it holds', async () => {
        const job = world.addJob({ kind: 'explainer_draw', status: 'pending', payload: { explainer_id: EXPLAINER } });
        const render = { vertical_url: up(2), horizontal_url: up(3), cover_url: up(4), duration: 70, sound_mode: 'sfx' as const, version: 1, job_id: 'x' };
        draftExplainer({ status: 'ready', job_id: job.id, audio: voiced, render }, (i) => (i < 2 ? { picture: picture(i + 20), pictures: [picture(i + 30), picture(i + 40)] } : {}));
        await deleteExplainer(TENANT, EXPLAINER);
        assert.equal(world.explainers.size, 0);
        assert.equal(world.sceneRows().length, 0);
        assert.equal(job.status, 'failed');
        assert.equal(job.error, 'The explainer was deleted.');
        assert.deepEqual(world.deletedUploads[0]!.sort(), [id(1), id(2), id(3), id(4), id(20), id(21), id(30), id(31), id(40), id(41)].sort());
    });

    it('deletes the files after the row is gone, so nothing still counts as named by it', async () => {
        draftExplainer({ audio: voiced });
        await deleteExplainer(TENANT, EXPLAINER);
        const order = world.db.statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /^DELETE FROM explainers/.test(s)) < order.findIndex((s) => /^DELETE FROM media_uploads/.test(s)));
    });

    it('leaves the files a post names alone (the statement’s guard is the posts and the other records that name an upload)', async () => {
        draftExplainer({ audio: voiced });
        world.keptUploads.add(id(1));
        await deleteExplainer(TENANT, EXPLAINER);
        assert.deepEqual(world.deletedUploads[0], [], 'the post still shows it');
    });

    it('is a 404 for another tenant’s, and deletes nothing', async () => {
        draftExplainer();
        await assert.rejects(deleteExplainer(OTHER, EXPLAINER), refused('EXPLAINER_NOT_FOUND', 404));
        assert.equal(world.explainers.size, 1);
    });

    it('lists every upload an explainer holds: the chosen pictures, the history, the audio and the three renders', () => {
        const urls = filesOf({ audio: voiced, render: { vertical_url: 'v', horizontal_url: 'h', cover_url: 'c', duration: 1, sound_mode: 'sfx', version: 1, job_id: 'j' } },
            [{ picture: picture(1), pictures: [picture(2)] }, { picture: null, pictures: [] }]);
        assert.deepEqual(urls, [`/api/uploads/${id(1)}`, `/api/uploads/${id(2)}`, up(1), 'v', 'h', 'c']);
        assert.deepEqual(filesOf({ audio: null, render: null }, []), []);
    });
});

describe('presentExplainer', () => {
    it('gives a render of the right version and sound as not older than the edits', () => {
        const row = { ...world.addExplainer({ status: 'ready', draft_version: 2, sound_mode: 'music', render: { vertical_url: 'v', horizontal_url: 'h', cover_url: 'c', duration: 1, sound_mode: 'music', version: 2, job_id: 'j' } }), job_status: null, job_progress: null, job_not_before: null };
        assert.equal(presentExplainer(row, []).render_stale, false);
        assert.equal(presentExplainer({ ...row, render: null }, []).render_stale, false, 'no render is not an old one');
    });

    it('shows a job waiting for a time as pending with its not_before: the dashboard says "waiting for tomorrow", not "waiting for the Mac"', () => {
        const row = { ...world.addExplainer({ status: 'drawing', job_id: JOB }), job_status: 'pending', job_progress: null, job_not_before: new Date('2026-10-26T00:05:00Z') };
        assert.deepEqual(presentExplainer(row, []).job, { status: 'pending', progress: null, not_before: new Date('2026-10-26T00:05:00Z') });
        assert.equal(presentExplainer({ ...row, job_status: null }, []).job, null, 'a job that is gone is no job');
    });
});
