/**
 * What the Studio queue does with the four explainer job kinds in E1: nothing, loudly. `completeJob` and `failJob` hand the job to
 * `applyExplainerResult` / `applyExplainerFailure`, which only log `explainer.result_unhandled` until E2 gives them their lifecycle. Nothing
 * queues these jobs yet (there is no route, and the switch is off), so a job that does arrive is a surprise worth a log line, and its
 * result is dropped rather than half-applied.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { applyExplainerFailure, applyExplainerResult, EXPLAINER_JOB_KINDS, isExplainerJobKind, type ExplainerJob } from './apply.js';

const JOB = '55555555-5555-4555-8555-555555555555';
const TENANT = '11111111-1111-4111-8111-111111111111';

let logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { const { ts: _ts, level: _level, event, ...fields } = JSON.parse(line); logs.push({ level, event, fields }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
beforeEach(() => { logs = []; });

/** An executor that records what it is asked: a no-op must send nothing. */
function recorder() {
    const sent: string[] = [];
    return { sent, exec: { query: async (sql: string) => { sent.push(sql); return { rows: [], rowCount: 0 }; } } as never };
}

const job = (kind: ExplainerJob['kind']): ExplainerJob => ({ id: JOB, creator_id: TENANT, kind, payload: { explainer_id: 'e' } });

describe('isExplainerJobKind', () => {
    it('is true for the four kinds of data-model §4, and for no other job kind', () => {
        assert.deepEqual([...EXPLAINER_JOB_KINDS], ['explainer_write', 'explainer_voice', 'explainer_draw', 'explainer_render']);
        for (const kind of EXPLAINER_JOB_KINDS) assert.equal(isExplainerJobKind(kind), true, kind);
        for (const kind of ['scan_library', 'index_lesson', 'render_carousel', 'pick_folder', 'monteur_scan', 'monteur_transcribe', 'monteur_render', 'monteur_think', 'render_infographic', 'ads_think', 'explainer', 'explainer_']) {
            assert.equal(isExplainerJobKind(kind), false, kind);
        }
    });
});

describe('applyExplainerResult (E1: a typed no-op)', () => {
    for (const kind of EXPLAINER_JOB_KINDS) {
        it(`${kind}: logs explainer.result_unhandled, sends no statement, and drops the result`, async () => {
            const { sent, exec } = recorder();
            const result = { state: 'done' };
            const applied = await applyExplainerResult(exec, job(kind), result);
            assert.equal(applied.outcome, 'dropped');
            assert.deepEqual(applied.stored, { dropped: 'not_implemented' });
            assert.equal(sent.length, 0);
            assert.deepEqual(logs.map((l) => ({ level: l.level, event: l.event })), [{ level: 'warn', event: 'explainer.result_unhandled' }]);
            assert.deepEqual(logs[0]!.fields, { job_id: JOB, kind, creator_id: TENANT, phase: 'result' });
        });
    }
});

describe('applyExplainerFailure (E1: a typed no-op)', () => {
    for (const kind of EXPLAINER_JOB_KINDS) {
        it(`${kind}: logs explainer.result_unhandled and sends no statement`, async () => {
            const { sent, exec } = recorder();
            assert.equal(await applyExplainerFailure(exec, job(kind), 'The Mac is offline.'), undefined);
            assert.equal(sent.length, 0);
            assert.deepEqual(logs.map((l) => l.event), ['explainer.result_unhandled']);
            assert.deepEqual(logs[0]!.fields, { job_id: JOB, kind, creator_id: TENANT, phase: 'failure' });
        });
    }

    it('never logs the failure’s text: it may quote a prompt, a path or a token', async () => {
        const { exec } = recorder();
        await applyExplainerFailure(exec, job('explainer_voice'), 'Gemini said: key AIzaSySECRET is not valid');
        assert.doesNotMatch(JSON.stringify(logs), /AIzaSySECRET/);
    });
});
