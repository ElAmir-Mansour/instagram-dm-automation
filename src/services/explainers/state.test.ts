/**
 * The explainer status machine (data-model.md §5): which move is allowed, and `transitionExplainer`, the one function that makes it, with the
 * row locked. The pool answers by SQL, as in the other Studio tests; the table of moves is also checked pair by pair, all 81 of them, so a
 * move added or dropped by accident is a failing test and not a quiet change.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { ExplainerRow, ExplainerStatus, ExplainerStep } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { ExplainerError } from './errors.js';
import { canMove, EXPLAINER_STATUSES, EXPLAINER_STEPS, isAudioStale, RETRY_STATUS, transitionExplainer } from './state.js';

const ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';

const STATUSES = ['writing', 'draft', 'voicing', 'drawing', 'review', 'rendering', 'ready', 'scheduled', 'failed'] as const satisfies readonly ExplainerStatus[];
type Pair = readonly [ExplainerStatus, ExplainerStatus];

/** Data-model §5, as pairs: what the status machine allows with no failure and no stale audio. */
const ORDINARY: readonly Pair[] = [
    ['writing', 'draft'], // the writer's result
    ['draft', 'writing'], // rewrite with a note
    ['draft', 'voicing'], // the owner approves the script
    ['voicing', 'drawing'], // the voice result
    ['drawing', 'review'], // every scene has a picture
    ['review', 'rendering'], // the owner approves the pictures
    ['rendering', 'ready'], // the render result
    ['ready', 'rendering'], // re-render
    ['ready', 'scheduled'], // schedule
];
/** A narration edit after voicing makes the audio stale, and then a re-voice may start from here. */
const REVOICE: readonly Pair[] = [['drawing', 'voicing'], ['review', 'voicing'], ['ready', 'voicing']];
/** The state a step is running in, which is the only state it can fail from. */
const FAILS_FROM: Record<ExplainerStep, ExplainerStatus> = { write: 'writing', voice: 'voicing', draw: 'drawing', render: 'rendering', schedule: 'ready' };

const has = (pairs: readonly Pair[], from: ExplainerStatus, to: ExplainerStatus): boolean => pairs.some(([f, t]) => f === from && t === to);

describe('the status vocabulary', () => {
    it('is the nine states of the CHECK, in the order of data-model §1, and five steps', () => {
        assert.deepEqual([...EXPLAINER_STATUSES], [...STATUSES]);
        assert.deepEqual([...EXPLAINER_STEPS], ['write', 'voice', 'draw', 'render', 'schedule']);
    });

    it('a failed step goes back to the state it ran in, and a failed schedule to ready, where Schedule is pressed', () => {
        assert.deepEqual(RETRY_STATUS, { write: 'writing', voice: 'voicing', draw: 'drawing', render: 'rendering', schedule: 'ready' });
    });
});

describe('canMove — the table of data-model §5', () => {
    it('allows the nine ordinary moves, and no other pair, with nothing failed and the audio fresh', () => {
        for (const from of STATUSES) {
            for (const to of STATUSES) assert.equal(canMove(from, to), has(ORDINARY, from, to), `${from} → ${to}`);
        }
    });

    it('lets a narration edit with stale audio re-voice from drawing, review or ready, and changes nothing else', () => {
        for (const from of STATUSES) {
            for (const to of STATUSES) {
                assert.equal(canMove(from, to, { audioStale: true }), has(ORDINARY, from, to) || has(REVOICE, from, to), `${from} → ${to}`);
            }
        }
    });

    it('does not re-voice with fresh audio, from a state that has not been voiced, or once the explainer is scheduled', () => {
        for (const [from] of REVOICE) assert.equal(canMove(from, 'voicing', { audioStale: false }), false, from);
        for (const from of ['writing', 'voicing', 'scheduled', 'failed'] as const) assert.equal(canMove(from, 'voicing', { audioStale: true }), false, from);
        assert.equal(canMove('draft', 'voicing'), true, 'approving needs no audio');
    });

    it('lets each step fail, from the state it runs in, when the step is named', () => {
        for (const step of EXPLAINER_STEPS) {
            for (const from of STATUSES) {
                assert.equal(canMove(from, 'failed', { failedStep: step }), FAILS_FROM[step] === from, `${from} → failed (${step})`);
            }
        }
    });

    it('does not fail without naming the step, or from failed, or from a state with no step running', () => {
        for (const from of STATUSES) assert.equal(canMove(from, 'failed'), false, from);
        assert.equal(canMove('writing', 'failed', { failedStep: null }), false);
        for (const step of EXPLAINER_STEPS) assert.equal(canMove('failed', 'failed', { failedStep: step }), false);
        for (const from of ['draft', 'review', 'scheduled'] as const) {
            for (const step of EXPLAINER_STEPS) assert.equal(canMove(from, 'failed', { failedStep: step }), false, `${from} (${step})`);
        }
    });

    it('retries a failed step into that step’s state, and into no other', () => {
        for (const step of EXPLAINER_STEPS) {
            for (const to of STATUSES) {
                assert.equal(canMove('failed', to, { failedStep: step }), to === RETRY_STATUS[step], `failed (${step}) → ${to}`);
            }
        }
        for (const to of STATUSES) assert.equal(canMove('failed', to), false, `failed with no step → ${to}`);
    });

    it('never moves anywhere from scheduled, and never stays where it is', () => {
        for (const to of STATUSES) {
            assert.equal(canMove('scheduled', to, { audioStale: true, failedStep: 'schedule' }), false, to);
            assert.equal(canMove(to, to, { audioStale: true, failedStep: 'write' }), false, `${to} → ${to}`);
        }
    });
});

describe('isAudioStale', () => {
    const audio = (version: number) => ({ url: 'https://x/api/uploads/a', media_id: 'm', duration: 60, voice: 'Charon', version, words_version: version, fallback: false });

    it('is true when the narration moved on since the audio was made: its version is not the draft’s', () => {
        assert.equal(isAudioStale({ audio: audio(2), draft_version: 3 }), true);
        assert.equal(isAudioStale({ audio: audio(3), draft_version: 3 }), false);
    });

    it('is false when there is no audio yet: nothing is out of date', () => {
        assert.equal(isAudioStale({ audio: null, draft_version: 3 }), false);
    });
});

// ─── transitionExplainer ───────────────────────────────────────────────────────────────────────

function row(over: Partial<ExplainerRow> = {}): ExplainerRow {
    return {
        id: ID, creator_id: TENANT, status: 'draft', failed_step: null, error: null, topic: 'Why AI makes things up', language: 'ar', length_tier: 'short',
        sound_mode: 'sfx', music_track_id: null, subtitles: true, notes: null, source_links: [], title: null, draft: null, draft_version: 1, rewrite_note: null,
        audio: null, words: null, render: null, schedule: null, job_id: null, draw_paused_until: null, created_at: new Date(0), updated_at: new Date(0),
        ...over,
    };
}

const LOCK = /^SELECT \* FROM explainers WHERE id = \$1 AND \(\$2::uuid IS NULL OR creator_id = \$2\) FOR UPDATE$/;
const UPDATE = /^UPDATE explainers SET /;

describe('transitionExplainer', () => {
    let db: FakeDb;
    let current: ExplainerRow | null;
    let events: { level: string; event: string; fields: Record<string, unknown> }[] = [];
    let restoreSink: (() => void) | undefined;

    before(() => {
        const previous = setLogSink((level, line) => { const { ts: _ts, level: _level, event, ...fields } = JSON.parse(line); events.push({ level, event, fields }); });
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());

    beforeEach(() => {
        events = [];
        current = row();
        db = installFakeDb();
        db.routes.push(
            [LOCK, (p) => ({ rows: current && p[0] === current.id && (p[1] === null || p[1] === current.creator_id) ? [current] : [] })],
            [UPDATE, (p) => ({ rows: [{ ...current, status: p[1] }] })],
        );
    });
    afterEach(() => db.restore());

    /** The `SET` list of the UPDATE the call made, column → value (a parameter resolved, NOW() and NULL as they are). */
    function written(): Record<string, unknown> {
        const update = db.ran(UPDATE)[0];
        assert.ok(update, 'an UPDATE was sent');
        const set = /^UPDATE explainers SET (.*) WHERE id = \$1 RETURNING \*$/.exec(update!.sql);
        assert.ok(set, `UPDATE shape: ${update!.sql}`);
        return Object.fromEntries(set![1]!.split(', ').map((assignment) => {
            const [column, expression] = assignment.split(' = ') as [string, string];
            const param = /^\$(\d+)(::jsonb)?$/.exec(expression);
            if (param) return [column, update!.params[Number(param[1]) - 1]];
            return [column, expression === 'NULL' ? null : expression];
        }));
    }

    const refused = (code: string, status: number) => (err: unknown) => err instanceof ExplainerError && err.code === code && err.status === status;

    it('locks the row first, then updates it by id, and gives back the row it wrote', async () => {
        const out = await transitionExplainer(pool, ID, ['draft'], 'voicing');
        const order = db.statements.map((s) => s.sql);
        assert.match(order[0]!, LOCK);
        assert.match(order[1]!, UPDATE);
        assert.match(order[1]!, /WHERE id = \$1 RETURNING \*$/);
        assert.equal(order.length, 2);
        assert.equal(out.status, 'voicing');
        assert.equal(db.statements[1]!.params[0], ID);
        assert.equal(db.statements[1]!.params[1], 'voicing');
        assert.equal(written().updated_at, 'NOW()');
    });

    it('logs the move, with the state it left and the state it entered', async () => {
        await transitionExplainer(pool, ID, ['draft'], 'voicing');
        const moved = events.find((e) => e.event === 'explainer.transition');
        assert.deepEqual(moved && { level: moved.level, ...moved.fields }, { level: 'info', explainer_id: ID, from: 'draft', to: 'voicing' });
    });

    it('refuses a row whose state the caller did not list: 409 EXPLAINER_BAD_STATE, and nothing written', async () => {
        current = row({ status: 'ready' });
        await assert.rejects(transitionExplainer(pool, ID, ['draft'], 'voicing'), refused('EXPLAINER_BAD_STATE', 409));
        assert.equal(db.ran(UPDATE).length, 0);
    });

    it('refuses a row the table would move, when the caller’s own list leaves its state out: an approve is for a draft and for nothing else', async () => {
        current = row({ status: 'draft' });
        assert.equal(canMove('draft', 'voicing'), true, 'the table alone would allow it');
        await assert.rejects(transitionExplainer(pool, ID, ['writing'], 'voicing'), refused('EXPLAINER_BAD_STATE', 409));
        await assert.rejects(transitionExplainer(pool, ID, [], 'voicing'), refused('EXPLAINER_BAD_STATE', 409));
        assert.equal(db.ran(UPDATE).length, 0);
        assert.equal((await transitionExplainer(pool, ID, ['writing', 'draft'], 'voicing')).status, 'voicing');
    });

    it('says which state it is in and where it was asked to go', async () => {
        current = row({ status: 'ready' });
        await assert.rejects(transitionExplainer(pool, ID, ['draft'], 'voicing'), /ready.*voicing/);
    });

    it('refuses a move the table does not allow, even from a state the caller listed', async () => {
        current = row({ status: 'draft' });
        await assert.rejects(transitionExplainer(pool, ID, ['draft'], 'ready'), refused('EXPLAINER_BAD_STATE', 409));
        await assert.rejects(transitionExplainer(pool, ID, ['draft', 'review'], 'scheduled'), refused('EXPLAINER_BAD_STATE', 409));
        assert.equal(db.ran(UPDATE).length, 0);
    });

    it('404s a row that is not there: 404 EXPLAINER_NOT_FOUND', async () => {
        current = null;
        await assert.rejects(transitionExplainer(pool, ID, ['draft'], 'voicing'), refused('EXPLAINER_NOT_FOUND', 404));
        assert.equal(db.ran(UPDATE).length, 0);
    });

    it('takes the tenant when it is given one, and then a row of another tenant is not found', async () => {
        await transitionExplainer(pool, ID, ['draft'], 'voicing', {}, TENANT);
        assert.deepEqual(db.ran(LOCK)[0]!.params, [ID, TENANT]);
        db.statements.length = 0;
        await assert.rejects(transitionExplainer(pool, ID, ['draft'], 'voicing', {}, OTHER_TENANT), refused('EXPLAINER_NOT_FOUND', 404));
        assert.equal(db.ran(UPDATE).length, 0);
    });

    it('without a tenant it locks by id alone (the caller has already scoped the row it is moving)', async () => {
        await transitionExplainer(pool, ID, ['draft'], 'voicing');
        assert.deepEqual(db.ran(LOCK)[0]!.params, [ID, null]);
    });

    describe('failing', () => {
        it('records the step and the reason: the state, failed_step and error, together', async () => {
            current = row({ status: 'writing' });
            const out = await transitionExplainer(pool, ID, ['writing'], 'failed', { failed_step: 'write', error: 'The Mac is offline.' });
            assert.equal(out.status, 'failed');
            const set = written();
            assert.equal(set.status, 'failed');
            assert.equal(set.failed_step, 'write');
            assert.equal(set.error, 'The Mac is offline.');
        });

        it('needs the step: without one the move is refused', async () => {
            current = row({ status: 'writing' });
            await assert.rejects(transitionExplainer(pool, ID, ['writing'], 'failed', { error: 'x' }), refused('EXPLAINER_BAD_STATE', 409));
            await assert.rejects(transitionExplainer(pool, ID, ['writing'], 'failed', { failed_step: null, error: 'x' }), refused('EXPLAINER_BAD_STATE', 409));
            assert.equal(db.ran(UPDATE).length, 0);
        });

        it('needs the step to be the one running in the state it leaves: a voice failure cannot be recorded as a write failure', async () => {
            current = row({ status: 'voicing' });
            await assert.rejects(transitionExplainer(pool, ID, ['voicing'], 'failed', { failed_step: 'write', error: 'x' }), refused('EXPLAINER_BAD_STATE', 409));
            await transitionExplainer(pool, ID, ['voicing'], 'failed', { failed_step: 'voice', error: 'x' });
            assert.equal(written().failed_step, 'voice');
        });

        it('fails a render from rendering and a schedule from ready', async () => {
            current = row({ status: 'rendering' });
            await transitionExplainer(pool, ID, ['rendering'], 'failed', { failed_step: 'render', error: 'x' });
            db.statements.length = 0;
            current = row({ status: 'ready' });
            await transitionExplainer(pool, ID, ['ready'], 'failed', { failed_step: 'schedule', error: 'x' });
            assert.equal(written().failed_step, 'schedule');
        });
    });

    describe('retrying', () => {
        it('goes back to the failed step’s state, and clears the failure', async () => {
            current = row({ status: 'failed', failed_step: 'draw', error: 'The image provider refused.' });
            await transitionExplainer(pool, ID, ['failed'], 'drawing', { job_id: '44444444-4444-4444-8444-444444444444' });
            const set = written();
            assert.equal(set.status, 'drawing');
            assert.equal(set.failed_step, null);
            assert.equal(set.error, null);
            assert.equal(set.job_id, '44444444-4444-4444-8444-444444444444');
        });

        it('goes nowhere else: a failed draw cannot be retried into rendering', async () => {
            current = row({ status: 'failed', failed_step: 'draw' });
            await assert.rejects(transitionExplainer(pool, ID, ['failed'], 'rendering'), refused('EXPLAINER_BAD_STATE', 409));
            await assert.rejects(transitionExplainer(pool, ID, ['failed'], 'voicing'), refused('EXPLAINER_BAD_STATE', 409));
            assert.equal(db.ran(UPDATE).length, 0);
        });

        it('goes nowhere when the failure never recorded a step', async () => {
            current = row({ status: 'failed', failed_step: null });
            await assert.rejects(transitionExplainer(pool, ID, ['failed'], 'writing'), refused('EXPLAINER_BAD_STATE', 409));
        });
    });

    describe('re-voicing after a narration edit', () => {
        const audio = (version: number) => ({ url: 'https://x/api/uploads/a', media_id: 'm', duration: 60, voice: 'Charon', version, words_version: version, fallback: false });

        it('is allowed from drawing, review and ready when the audio is out of date', async () => {
            for (const status of ['drawing', 'review', 'ready'] as const) {
                db.statements.length = 0;
                current = row({ status, draft_version: 3, audio: audio(2) });
                const out = await transitionExplainer(pool, ID, ['drawing', 'review', 'ready'], 'voicing');
                assert.equal(out.status, 'voicing', status);
            }
        });

        it('is refused when the audio is the draft’s own: nothing was edited, there is nothing to re-voice', async () => {
            for (const status of ['drawing', 'review', 'ready'] as const) {
                current = row({ status, draft_version: 3, audio: audio(3) });
                await assert.rejects(transitionExplainer(pool, ID, ['drawing', 'review', 'ready'], 'voicing'), refused('EXPLAINER_BAD_STATE', 409), status);
            }
            assert.equal(db.ran(UPDATE).length, 0);
        });

        it('is not what approving a script does: from draft it needs no audio at all', async () => {
            current = row({ status: 'draft', draft_version: 3, audio: null });
            assert.equal((await transitionExplainer(pool, ID, ['draft'], 'voicing')).status, 'voicing');
        });
    });

    describe('what it writes', () => {
        it('clears an old failure or pause note on a move forward, unless the caller says otherwise', async () => {
            current = row({ status: 'drawing', error: 'Waiting for tomorrow’s allowance (3 of 20 drawn).', failed_step: null });
            await transitionExplainer(pool, ID, ['drawing'], 'review');
            assert.equal(written().error, null);
            db.statements.length = 0;
            current = row({ status: 'drawing', error: 'old' });
            await transitionExplainer(pool, ID, ['drawing'], 'review', { error: 'Two scenes were refused by the provider.' });
            assert.equal(written().error, 'Two scenes were refused by the provider.');
        });

        it('sets only the columns it is given, JSON ones as jsonb, and null as SQL NULL', async () => {
            current = row({ status: 'writing' });
            const draft = { writer: 'claude_mac' as const, captions: { meta: 'm', youtube: { title: 't', description: 'd' }, tiktok: 'tt' }, first_comment: 'c', replies: [], sources: [], est_seconds: 61.5, warnings: [] };
            await transitionExplainer(pool, ID, ['writing'], 'draft', { draft, draft_version: 2, title: 'A title', job_id: null, audio: null });
            const update = db.ran(UPDATE)[0]!;
            const set = written();
            assert.deepEqual(Object.keys(set).sort(), ['audio', 'draft', 'draft_version', 'error', 'failed_step', 'job_id', 'status', 'title', 'updated_at']);
            assert.equal(set.draft_version, 2);
            assert.equal(set.title, 'A title');
            assert.equal(set.job_id, null, 'a null job_id is SQL NULL');
            assert.match(update.sql, /draft = \$\d+::jsonb/);
            assert.equal(typeof set.draft, 'string');
            assert.deepEqual(JSON.parse(set.draft as string), draft);
            assert.match(update.sql, /audio = \$\d+::jsonb/);
            assert.equal(set.audio, null, 'null is SQL NULL, not the JSON value null');
        });

        it('passes a pause time through, and clears it', async () => {
            current = row({ status: 'drawing' });
            const until = new Date('2026-10-26T00:05:00Z');
            await transitionExplainer(pool, ID, ['drawing'], 'review', { draw_paused_until: until });
            assert.equal(written().draw_paused_until, until);
            db.statements.length = 0;
            current = row({ status: 'drawing', draw_paused_until: until });
            await transitionExplainer(pool, ID, ['drawing'], 'review', { draw_paused_until: null });
            assert.equal(written().draw_paused_until, null);
        });

        it('skips a column whose value is undefined, as if it had not been given', async () => {
            await transitionExplainer(pool, ID, ['draft'], 'voicing', { title: undefined, job_id: undefined });
            assert.ok(!('title' in written()) && !('job_id' in written()));
        });

        it('refuses a column it may not set, before it touches the database: a typo is not a column name', async () => {
            for (const bad of ['topic', 'creator_id', 'id', 'status', 'created_at', 'draft_version; DROP TABLE explainers']) {
                await assert.rejects(transitionExplainer(pool, ID, ['draft'], 'voicing', { [bad]: 'x' } as never), /not a column/, bad);
            }
            assert.equal(db.statements.length, 0);
        });
    });
});
