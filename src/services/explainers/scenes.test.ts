/**
 * The pictures of an explainer, from outside (scenes.ts): the owner's draw, redraw and pick of one scene, the character candidates, the allowance, and the Mac's
 * drawing step. The pictures service itself (pictures/draw.ts) has its own tests; here it is answered by stubs, so what is pinned is what this file decides:
 * WHEN each may be called, what is handed to the service, and what the explainer does about its answer.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ExplainerPicture, ExplainerRow, ExplainerSceneRow } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { StudioError } from '../studio/common.js';
import { ExplainerError } from './errors.js';
import type { AllowanceStatus } from './pictures/allowance.js';
import type { DrawNextAnswer } from './pictures/draw.js';
import { characterCandidates, currentAllowance, drawNextStep, drawOneScene, pickOneScene, picturesEditable, setPictureDeps } from './scenes.js';
import { EXPLAINER, JOB, sceneRow, TENANT } from './testFixtures.js';
import { installWorld, type World } from './testDb.js';

const OTHER_TENANT = '88888888-8888-4888-8888-888888888888';
const OTHER_JOB = '77777777-7777-4777-8777-777777777777';
const ALLOWANCE: AllowanceStatus = { provider: 'cloudflare', day: '2026-10-25', used_units: 220, pictures: 2, cap: 80, est_left: 78, paused_until: null };
const picture = (n: number): ExplainerPicture => ({
    media_id: `${String(n).padStart(2, '0').repeat(4)}-1111-4111-8111-111111111111`, url: `/api/uploads/${String(n).padStart(2, '0').repeat(4)}-1111-4111-8111-111111111111`,
    seed: n, provider: 'cloudflare', model: '@cf/black-forest-labs/flux-2-klein-4b', prompt_hash: `hash-${n}`, at: '2026-10-25T11:00:00.000Z',
});

let world: World;
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
beforeEach(() => { world = installWorld(); });
afterEach(() => {
    world.restore();
    setPictureDeps(null);
});

const refused = (code: string, status: number) => (err: unknown): boolean => err instanceof ExplainerError && err.code === code && err.status === status;
const badRequest = (err: unknown): boolean => err instanceof StudioError && err.status === 400;
const notFound = refused('EXPLAINER_NOT_FOUND', 404);

/** An explainer in `status`, with scenes whose pictures exist. */
function explainerIn(status: ExplainerRow['status'], over: Partial<ExplainerRow> = {}): ExplainerRow {
    const row = world.addExplainer({ status, ...(status === 'failed' ? { failed_step: 'draw', error: 'x' } : {}), ...over });
    world.addScenes(4, (i) => ({ picture: picture(10 + i), pictures: [picture(20 + i)], draw_status: 'done' }));
    return row;
}

/** A scene as the pictures service hands it back: the whole row, with ids and counters the dashboard must not see. */
const drawnScene = (position: number): ExplainerSceneRow => sceneRow(position, { picture: picture(40 + position), pictures: [picture(10 + position)], draw_status: 'done', draw_attempts: 2 });

// ─── Where a picture may be touched by hand ────────────────────────────────────────────────────

describe('picturesEditable — where the owner may draw, redraw and pick', () => {
    it('is true once the narration is voiced and until it is posted, and for a drawing that failed', () => {
        for (const status of ['drawing', 'review', 'ready', 'scheduled'] as const) assert.equal(picturesEditable({ status, failed_step: null }), true, status);
        assert.equal(picturesEditable({ status: 'failed', failed_step: 'draw' }), true);
    });

    it('is false before there is audio and an approved script, while a render has its pictures, and for a failure of any other step', () => {
        for (const status of ['writing', 'draft', 'voicing', 'rendering'] as const) assert.equal(picturesEditable({ status, failed_step: null }), false, status);
        for (const step of ['write', 'voice', 'render', 'schedule'] as const) assert.equal(picturesEditable({ status: 'failed', failed_step: step }), false, `failed at ${step}`);
    });
});

// ─── The owner draws one scene ─────────────────────────────────────────────────────────────────

describe('drawOneScene', () => {
    let asked: unknown[];
    beforeEach(() => {
        asked = [];
        setPictureDeps({ drawScene: async (args) => { asked.push(args); return { scene: drawnScene(args.position), allowance: ALLOWANCE }; } });
    });

    it('asks the pictures service for that scene with the owner’s note, and answers the scene as the dashboard reads it, with the allowance', async () => {
        explainerIn('review');
        const out = await drawOneScene(TENANT, EXPLAINER, '2', { note: 'he is holding a book, smiling' });
        assert.deepEqual(asked, [{ creatorId: TENANT, explainerId: EXPLAINER, position: 2, note: 'he is holding a book, smiling' }]);
        assert.deepEqual(out.allowance, ALLOWANCE);
        assert.deepEqual(Object.keys(out.scene).sort(), [
            'brief', 'characters', 'continues', 'draw_error', 'draw_note', 'draw_status', 'end_s', 'label', 'narration', 'picture', 'pictures', 'position', 'spoken', 'start_s',
        ], 'no scene id, no tenant, no attempt counter');
        assert.equal(out.scene.position, 2);
        assert.equal(out.scene.picture?.media_id, picture(42).media_id);
    });

    it('sends no note as null: a redraw without words clears the last one', async () => {
        explainerIn('drawing');
        await drawOneScene(TENANT, EXPLAINER, '0', {});
        await drawOneScene(TENANT, EXPLAINER, '0', { note: null });
        await drawOneScene(TENANT, EXPLAINER, '0', undefined);
        assert.deepEqual(asked.map((a) => (a as { note: unknown }).note), [null, null, null]);
    });

    it('hands the words over untouched: the pictures service owns what a note may say (no women or girls, 300 characters)', async () => {
        explainerIn('review');
        await drawOneScene(TENANT, EXPLAINER, '1', { note: '  a note with spaces  ' });
        assert.equal((asked[0] as { note: string }).note, '  a note with spaces  ');
    });

    it('is allowed in every state a picture may be touched in', async () => {
        for (const status of ['drawing', 'review', 'ready', 'scheduled', 'failed'] as const) {
            world.explainers.clear();
            world.scenes.length = 0;
            explainerIn(status);
            await drawOneScene(TENANT, EXPLAINER, '0', {});
        }
        assert.equal(asked.length, 5);
    });

    it('is 409 EXPLAINER_BAD_STATE in every other, saying where the explainer is, and the service is not asked', async () => {
        for (const [status, failedStep] of [['writing', null], ['draft', null], ['voicing', null], ['rendering', null], ['failed', 'write'], ['failed', 'render']] as const) {
            world.explainers.clear();
            world.scenes.length = 0;
            explainerIn(status, { failed_step: failedStep });
            await assert.rejects(drawOneScene(TENANT, EXPLAINER, '0', {}), (err: unknown) => {
                assert.ok(err instanceof ExplainerError);
                assert.equal(err.code, 'EXPLAINER_BAD_STATE');
                assert.equal(err.status, 409);
                assert.deepEqual(err.params, { status, to: 'drawn' });
                return true;
            }, `${status} ${failedStep ?? ''}`);
        }
        assert.deepEqual(asked, []);
    });

    it('is a 404 for an explainer that is not this tenant’s, one that is not there, and an id or a position that cannot be one', async () => {
        explainerIn('review');
        await assert.rejects(drawOneScene(OTHER_TENANT, EXPLAINER, '0', {}), notFound);
        await assert.rejects(drawOneScene(TENANT, OTHER_JOB, '0', {}), notFound);
        await assert.rejects(drawOneScene(TENANT, 'not-a-uuid', '0', {}), notFound);
        for (const position of ['-1', 'abc', '1.5', '', '1e2', ' 1', '9999999', undefined, null, 1.5, -1]) {
            await assert.rejects(drawOneScene(TENANT, EXPLAINER, position, {}), refused('EXPLAINER_NOT_FOUND', 404), String(position));
        }
        assert.deepEqual(asked, []);
    });

    it('is a 400 for a note that is not text, before anything is read', async () => {
        explainerIn('review');
        for (const note of [5, true, {}, ['a']]) await assert.rejects(drawOneScene(TENANT, EXPLAINER, '0', { note }), badRequest);
        assert.deepEqual(asked, []);
    });

    it('lets the service’s refusals through as they are: a paused allowance keeps its `retryAt`, a refused note its code', async () => {
        explainerIn('review');
        setPictureDeps({ drawScene: async () => { throw new ExplainerError('EXPLAINER_ALLOWANCE_PAUSED', 'Drawing is paused.', { retryAt: '2026-10-26T00:05:00.000Z' }); } });
        await assert.rejects(drawOneScene(TENANT, EXPLAINER, '0', {}), (err: unknown) => err instanceof ExplainerError && err.status === 429 && err.params?.retryAt === '2026-10-26T00:05:00.000Z');
        setPictureDeps({ drawScene: async () => { throw new ExplainerError('EXPLAINER_PROMPT_REFUSED', 'No women or girls.'); } });
        await assert.rejects(drawOneScene(TENANT, EXPLAINER, '0', { note: 'x' }), refused('EXPLAINER_PROMPT_REFUSED', 422));
    });

    it('never moves the explainer: a picture is not a status', async () => {
        explainerIn('ready', { job_id: null });
        const before = structuredClone(world.explainer());
        await drawOneScene(TENANT, EXPLAINER, '1', {});
        assert.deepEqual(world.explainer(), before);
        assert.equal(world.ran(/^UPDATE explainers/).length, 0);
    });
});

// ─── The owner goes back to an earlier picture ─────────────────────────────────────────────────

describe('pickOneScene', () => {
    let asked: unknown[];
    beforeEach(() => {
        asked = [];
        setPictureDeps({ pickPicture: async (args) => { asked.push(args); return { scene: drawnScene(args.position) }; } });
    });

    it('asks the pictures service to swap the scene’s picture for that earlier one, and answers the scene as the dashboard reads it', async () => {
        explainerIn('review');
        const out = await pickOneScene(TENANT, EXPLAINER, '3', { index: 0 });
        assert.deepEqual(asked, [{ creatorId: TENANT, explainerId: EXPLAINER, position: 3, index: 0 }]);
        assert.equal(out.scene.position, 3);
        assert.equal('id' in out.scene, false);
    });

    it('is a 400 for an index that is not a whole number from 0, and the service is not asked', async () => {
        explainerIn('review');
        for (const index of [-1, 1.5, '0', null, undefined, NaN, Infinity, {}, [0]]) {
            await assert.rejects(pickOneScene(TENANT, EXPLAINER, '0', { index }), badRequest, String(index));
        }
        await assert.rejects(pickOneScene(TENANT, EXPLAINER, '0', undefined), badRequest);
        assert.deepEqual(asked, []);
    });

    it('is allowed and refused in the same states as a draw, and is 404 for another tenant’s explainer or a scene that cannot exist', async () => {
        explainerIn('scheduled');
        await pickOneScene(TENANT, EXPLAINER, '0', { index: 0 });
        assert.equal(asked.length, 1);
        await assert.rejects(pickOneScene(OTHER_TENANT, EXPLAINER, '0', { index: 0 }), notFound);
        await assert.rejects(pickOneScene(TENANT, EXPLAINER, '-1', { index: 0 }), notFound);
        world.explainers.clear();
        world.scenes.length = 0;
        explainerIn('rendering');
        await assert.rejects(pickOneScene(TENANT, EXPLAINER, '0', { index: 0 }), refused('EXPLAINER_BAD_STATE', 409));
        assert.equal(asked.length, 1);
    });

    it('lets the service’s own 404 through for an earlier picture that is not there', async () => {
        explainerIn('review');
        setPictureDeps({ pickPicture: async () => { throw new ExplainerError('EXPLAINER_NOT_FOUND', 'Scene 1 has no earlier picture number 4.'); } });
        await assert.rejects(pickOneScene(TENANT, EXPLAINER, '0', { index: 3 }), notFound);
    });
});

// ─── Candidates and the allowance ──────────────────────────────────────────────────────────────

describe('characterCandidates', () => {
    it('asks for four pictures of the description, for this tenant, and answers what the service drew', async () => {
        const asked: unknown[] = [];
        setPictureDeps({ drawCandidates: async (args) => { asked.push(args); return { candidates: [{ media_id: 'm1', url: '/api/uploads/m1' }] }; } });
        const out = await characterCandidates(TENANT, { description: 'a curious young man in a green sweater' });
        assert.deepEqual(asked, [{ creatorId: TENANT, description: 'a curious young man in a green sweater' }]);
        assert.deepEqual(out, { candidates: [{ media_id: 'm1', url: '/api/uploads/m1' }] });
    });

    it('leaves the words to the service: an absent description is its own refusal ("describe the character first"), and a woman in it too', async () => {
        const asked: { description: string }[] = [];
        setPictureDeps({ drawCandidates: async (args) => { asked.push(args); throw new ExplainerError('EXPLAINER_PROMPT_REFUSED', 'Describe the character first: there is nothing to draw.'); } });
        await assert.rejects(characterCandidates(TENANT, {}), refused('EXPLAINER_PROMPT_REFUSED', 422));
        await assert.rejects(characterCandidates(TENANT, undefined), refused('EXPLAINER_PROMPT_REFUSED', 422));
        assert.deepEqual(asked.map((a) => a.description), ['', '']);
    });

    it('is a 400 for a description that is not text, and the service is not asked', async () => {
        let called = 0;
        setPictureDeps({ drawCandidates: async () => { called++; return { candidates: [] }; } });
        for (const description of [5, true, {}, ['a'], null]) await assert.rejects(characterCandidates(TENANT, { description }), badRequest, String(description));
        assert.equal(called, 0);
    });
});

describe('currentAllowance', () => {
    it('is what the pictures service says, and null when no image provider is set up', async () => {
        setPictureDeps({ allowanceStatus: async () => ALLOWANCE });
        assert.deepEqual(await currentAllowance(), ALLOWANCE);
        setPictureDeps({ allowanceStatus: async () => null });
        assert.equal(await currentAllowance(), null);
    });
});

// ─── The Mac's drawing step ────────────────────────────────────────────────────────────────────

describe('drawNextStep', () => {
    let steps: DrawNextAnswer[];
    let asked: unknown[];
    /** The explainer being drawn by a claimed `explainer_draw` job, as the Mac's loop finds it. */
    function drawingExplainer(over: Partial<ExplainerRow> = {}) {
        const job = world.addJob({ id: JOB, kind: 'explainer_draw', status: 'claimed', payload: { explainer_id: EXPLAINER } });
        world.addExplainer({ status: 'drawing', job_id: job.id, ...over });
        world.addScenes(4);
        return job;
    }
    beforeEach(() => {
        steps = [];
        asked = [];
        setPictureDeps({ drawNext: async (args) => { asked.push(args); return steps.shift() ?? { state: 'done' }; } });
    });

    describe('is refused, and spends nothing, unless it is the explainer’s own claimed drawing job', () => {
        const noDraw = (status: ExplainerRow['status'] = 'drawing') => (err: unknown): boolean => {
            assert.ok(err instanceof ExplainerError);
            assert.equal(err.code, 'EXPLAINER_BAD_STATE');
            assert.equal(err.status, 409);
            assert.deepEqual(err.params, { status, to: 'draw' });
            return true;
        };

        it('a job id that is not the explainer’s current job: a loop that was replaced, or another explainer’s job', async () => {
            drawingExplainer();
            const stale = world.addJob({ id: OTHER_JOB, kind: 'explainer_draw', status: 'claimed', payload: { explainer_id: EXPLAINER } });
            await assert.rejects(drawNextStep(TENANT, EXPLAINER, { job_id: stale.id }), noDraw());
            assert.deepEqual(asked, []);
        });

        it('a job id that is the explainer’s current job but is not a drawing job: the explainer’s job_id naming a render does not let a render draw', async () => {
            const job = world.addJob({ id: JOB, kind: 'explainer_render', status: 'claimed', payload: { explainer_id: EXPLAINER } });
            world.addExplainer({ status: 'drawing', job_id: job.id });
            await assert.rejects(drawNextStep(TENANT, EXPLAINER, { job_id: job.id }), noDraw());
            assert.deepEqual(asked, []);
        });

        it('a drawing job nobody has claimed, and one that has finished or failed', async () => {
            const job = drawingExplainer();
            for (const status of ['pending', 'done', 'failed'] as const) {
                job.status = status;
                await assert.rejects(drawNextStep(TENANT, EXPLAINER, { job_id: job.id }), noDraw(), status);
            }
            assert.deepEqual(asked, []);
        });

        it('an explainer that is not being drawn, whatever its job says', async () => {
            for (const status of ['review', 'failed', 'rendering', 'voicing'] as const) {
                world.explainers.clear();
                world.jobs.length = 0;
                drawingExplainer({ status, ...(status === 'failed' ? { failed_step: 'draw' as const } : {}) });
                await assert.rejects(drawNextStep(TENANT, EXPLAINER, { job_id: JOB }), noDraw(status), status);
            }
            assert.deepEqual(asked, []);
        });

        it('an explainer with no job at all', async () => {
            world.addExplainer({ status: 'drawing', job_id: null });
            await assert.rejects(drawNextStep(TENANT, EXPLAINER, { job_id: JOB }), noDraw());
            assert.deepEqual(asked, []);
        });

        it('a job of another tenant, even when the explainer names it', async () => {
            const job = world.addJob({ id: JOB, creator_id: OTHER_TENANT, kind: 'explainer_draw', status: 'claimed', payload: { explainer_id: EXPLAINER } });
            world.addExplainer({ status: 'drawing', job_id: job.id });
            await assert.rejects(drawNextStep(TENANT, EXPLAINER, { job_id: job.id }), noDraw());
            assert.deepEqual(asked, []);
        });

        it('an explainer that is not this tenant’s, one that is not there, and a malformed id: 404 before the job is looked at', async () => {
            drawingExplainer();
            await assert.rejects(drawNextStep(OTHER_TENANT, EXPLAINER, { job_id: JOB }), notFound);
            await assert.rejects(drawNextStep(TENANT, OTHER_JOB, { job_id: JOB }), notFound);
            await assert.rejects(drawNextStep(TENANT, 'nope', { job_id: JOB }), notFound);
            assert.deepEqual(asked, []);
        });

        it('a request that does not say which job it is: 400', async () => {
            drawingExplainer();
            for (const body of [undefined, null, {}, { job_id: 5 }, { job_id: '' }, { job_id: 'not-a-uuid' }, 'x']) {
                await assert.rejects(drawNextStep(TENANT, EXPLAINER, body), badRequest, JSON.stringify(body));
            }
            assert.deepEqual(asked, []);
        });
    });

    it('draws one step for the explainer’s own claimed job, and answers what the pictures service answered', async () => {
        drawingExplainer();
        steps = [{ state: 'drawn', position: 0, remaining: 3 }];
        assert.deepEqual(await drawNextStep(TENANT, EXPLAINER, { job_id: JOB }), { state: 'drawn', position: 0, remaining: 3 });
        assert.deepEqual(asked, [{ creatorId: TENANT, explainerId: EXPLAINER }], 'for the job’s own tenant and explainer, and only that');
        assert.equal(world.explainer().status, 'drawing');
    });

    it('accepts the job id in either case', async () => {
        drawingExplainer();
        await drawNextStep(TENANT, EXPLAINER, { job_id: JOB.toUpperCase() });
        assert.equal(asked.length, 1);
    });

    it('done moves the explainer from drawing to review and keeps its job until the worker completes it', async () => {
        drawingExplainer({ draw_paused_until: new Date('2026-10-25T00:05:00Z'), error: 'Waiting for the image allowance to reset (3 of 12 drawn).' });
        steps = [{ state: 'done' }];
        assert.deepEqual(await drawNextStep(TENANT, EXPLAINER, { job_id: JOB }), { state: 'done' });
        const row = world.explainer();
        assert.equal(row.status, 'review');
        assert.equal(row.job_id, JOB, 'applyDraw clears it when the worker’s result arrives');
        assert.equal(row.draw_paused_until, null);
        assert.equal(row.error, null, 'the pause note is not true any more');
        assert.equal(row.failed_step, null);
    });

    it('done answers done even when the explainer has moved on in the meantime, and moves nothing', async () => {
        drawingExplainer();
        setPictureDeps({
            drawNext: async () => {
                // The owner pressed Draw again while the last step was in flight: the explainer has another job now.
                world.explainer().job_id = OTHER_JOB;
                return { state: 'done' };
            },
        });
        assert.deepEqual(await drawNextStep(TENANT, EXPLAINER, { job_id: JOB }), { state: 'done' });
        assert.equal(world.explainer().status, 'drawing');
        assert.equal(world.explainer().job_id, OTHER_JOB);
    });

    it('done answers done for an explainer that was deleted during the step, and writes nothing', async () => {
        drawingExplainer();
        setPictureDeps({ drawNext: async () => { world.explainers.clear(); return { state: 'done' }; } });
        assert.deepEqual(await drawNextStep(TENANT, EXPLAINER, { job_id: JOB }), { state: 'done' });
        assert.equal(world.ran(/^UPDATE explainers/).length, 0);
    });

    it('drawn clears the note and the time of an earlier pause: drawing is going again, and the screen must not say it is waiting', async () => {
        drawingExplainer({ draw_paused_until: new Date('2026-10-25T00:05:00Z'), error: 'Waiting for the image allowance to reset (3 of 12 drawn).' });
        steps = [{ state: 'drawn', position: 3, remaining: 8 }];
        await drawNextStep(TENANT, EXPLAINER, { job_id: JOB });
        assert.equal(world.explainer().draw_paused_until, null);
        assert.equal(world.explainer().error, null);
        assert.equal(world.explainer().status, 'drawing');
    });

    it('drawn writes nothing when there is no pause note to clear', async () => {
        drawingExplainer();
        steps = [{ state: 'drawn', position: 0, remaining: 3 }];
        await drawNextStep(TENANT, EXPLAINER, { job_id: JOB });
        assert.equal(world.ran(/^UPDATE explainers/).length, 1, 'the one guarded statement, which matched nothing');
        assert.equal(world.explainer().updated_at.toISOString(), world.now.toISOString());
    });

    it('paused and failed write nothing here: the worker completes its job with them, and applyDraw queues the next round', async () => {
        drawingExplainer();
        const until = '2026-10-26T00:05:00.000Z';
        steps = [{ state: 'paused', until }, { state: 'failed', position: 2, error: 'The provider is busy: try again in a few minutes.' }];
        assert.deepEqual(await drawNextStep(TENANT, EXPLAINER, { job_id: JOB }), { state: 'paused', until });
        assert.deepEqual(await drawNextStep(TENANT, EXPLAINER, { job_id: JOB }), { state: 'failed', position: 2, error: 'The provider is busy: try again in a few minutes.' });
        assert.equal(world.ran(/^UPDATE explainers/).length, 0);
        assert.equal(world.explainer().status, 'drawing');
    });

    it('lets the service’s refusals through: no provider set up, or another draw already working here', async () => {
        drawingExplainer();
        setPictureDeps({ drawNext: async () => { throw new ExplainerError('EXPLAINER_NO_PROVIDER', 'No image provider is set up.'); } });
        await assert.rejects(drawNextStep(TENANT, EXPLAINER, { job_id: JOB }), refused('EXPLAINER_NO_PROVIDER', 409));
        assert.equal(world.explainer().status, 'drawing', 'the worker fails its job, and that is what fails the explainer (applyExplainerFailure)');
    });
});
