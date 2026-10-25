/**
 * The retention policy decision.
 *
 * Clearing `raw_payload` is irreversible and this runs against a live account, so what
 * matters most here is the set of inputs that must NOT start deleting: unset, blank,
 * mistyped, or a window short enough to destroy the evidence you would need to debug a
 * webhook problem that is still happening.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { setLogSink } from '../utils/log.js';
import { MEDIA_BUCKET, PRIVATE_MEDIA_BUCKET, setStorageFetch } from './supabaseStorage.js';
import {
    DEFAULT_RETENTION_DEPS,
    EXPLAINER_FILES_GRACE_DAYS,
    JOB_PRUNE_BATCH_SIZE,
    MAX_SWEEP_PASSES,
    MIN_RETENTION_DAYS,
    PRUNE_BATCH_SIZE,
    pruneOrphanedMedia,
    pruneOrphanedPrivateMedia,
    PRIVATE_MEDIA_ORPHAN_DAYS,
    PRIVATE_ORPHANS_SQL,
    previewMediaCleanup,
    resetProfileTableWarning,
    resolveRetention,
    runRetentionSweep,
} from './retention.js';

describe('resolveRetention', () => {
    it('is disabled when unset — the default must never delete anything', () => {
        assert.deepEqual(resolveRetention(undefined), { enabled: false, reason: 'unset' });
        assert.deepEqual(resolveRetention(''), { enabled: false, reason: 'unset' });
        assert.deepEqual(resolveRetention('   '), { enabled: false, reason: 'unset' });
    });

    it('enables pruning for a sensible window', () => {
        assert.deepEqual(resolveRetention('90'), { enabled: true, days: 90 });
        assert.deepEqual(resolveRetention('30'), { enabled: true, days: 30 });
    });

    it('accepts exactly the minimum', () => {
        assert.deepEqual(resolveRetention(String(MIN_RETENTION_DAYS)), {
            enabled: true, days: MIN_RETENTION_DAYS,
        });
    });

    it('refuses a window shorter than the minimum', () => {
        // A one-day window would clear the payloads for the webhook problem you are
        // currently trying to reproduce.
        assert.deepEqual(resolveRetention('1'), { enabled: false, reason: 'too_short' });
        assert.deepEqual(resolveRetention('6'), { enabled: false, reason: 'too_short' });
    });

    it('disables rather than guessing when the value is not a whole number of days', () => {
        // Deliberately not falling back to a default: deleting on a schedule the operator
        // did not ask for is worse than not deleting.
        for (const bad of ['abc', '90 days', '9.5', 'NaN', 'Infinity', '-30', '0', '1e3x']) {
            const result = resolveRetention(bad);
            assert.equal(result.enabled, false, `"${bad}" should not enable pruning`);
        }
    });

    it('reports invalid separately from too_short so the warning can be specific', () => {
        // The operator needs to be told which mistake they made: a typo and a too-eager
        // window want different fixes.
        assert.deepEqual(resolveRetention('abc'), { enabled: false, reason: 'invalid' });
        assert.deepEqual(resolveRetention('2'), { enabled: false, reason: 'too_short' });
    });

    it('treats a huge but valid window as enabled', () => {
        // 10 years is a policy choice, not a mistake. It is the operator's call.
        assert.deepEqual(resolveRetention('3650'), { enabled: true, days: 3650 });
    });
});

/**
 * The sweep's termination rules.
 *
 * `pruneRawPayloads` clears one batch of 5,000. That is right for one statement and wrong for
 * the only thing that calls it: the once-daily cron. An account with 60,000 unpruned messages
 * would have taken twelve days to converge, and for eleven of them the published
 * /data-deletion promise stays untrue — which is the most serious non-security issue in
 * ARCHITECTURE.md.
 *
 * Two mistakes are possible here and both are bad: stopping too early (never converging) and
 * not stopping at all (monopolising an invocation with a wall clock).
 */
describe('runRetentionSweep', () => {
    let restoreSink: (() => void) | undefined;
    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());

    /** Pruners that report a scripted count per pass, then zero. */
    function scripted(rawCounts: number[], jobCounts: number[] = [], mediaCounts: number[] = []) {
        let rawPass = 0;
        let jobPass = 0;
        let mediaPass = 0;
        return {
            pruneRaw: async () => ({ cleared: rawCounts[rawPass++] ?? 0, skipped: false }),
            pruneJobs: async () => ({ deleted: jobCounts[jobPass++] ?? 0 }),
            // Defaults to nothing-to-do, which is the real default: media retention is
            // opt-in, so every existing assertion below keeps meaning what it meant.
            pruneMedia: async () => ({ deleted: mediaCounts[mediaPass++] ?? 0, skipped: false as const }),
            removeObjects: async () => ({ removed: 0, failed: 0, skipped: false as const }),
        };
    }

    it('stops after one pass when there was nothing to do', async () => {
        // The common case by far: retention unset, no completed jobs. It must not cost 20
        // round-trips a day to discover that.
        const result = await runRetentionSweep(scripted([0], [0]));

        assert.equal(result.passes, 1);
        assert.equal(result.rawPayloadsCleared, 0);
        assert.equal(result.moreRemaining, false);
    });

    it('stops after a partial batch, which means the backlog is caught up', async () => {
        const result = await runRetentionSweep(scripted([12], [3]));

        assert.equal(result.passes, 1);
        assert.equal(result.rawPayloadsCleared, 12);
        assert.equal(result.jobsDeleted, 3);
    });

    it('keeps going while batches come back full, and converges in one run', async () => {
        // The bug this fixes: three full batches used to be three days of waiting.
        const result = await runRetentionSweep(
            scripted([PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 17], [0, 0, 0])
        );

        assert.equal(result.passes, 3);
        assert.equal(result.rawPayloadsCleared, PRUNE_BATCH_SIZE * 2 + 17);
        assert.equal(result.moreRemaining, false);
    });

    it('keeps going for a full job batch too, not only raw payloads', async () => {
        const result = await runRetentionSweep(
            scripted([0, 0], [JOB_PRUNE_BATCH_SIZE, 4])
        );

        assert.equal(result.passes, 2);
        assert.equal(result.jobsDeleted, JOB_PRUNE_BATCH_SIZE + 4);
    });

    it('keeps going for a full media batch too', async () => {
        // Same convergence rule as the other two sweeps. Without it, reclaiming a large
        // media backlog would take one batch per day - and media is the sweep most likely
        // to have a backlog, because nothing has ever deleted from media_uploads.
        const result = await runRetentionSweep(scripted([0, 0], [0, 0], [PRUNE_BATCH_SIZE, 6]));

        assert.equal(result.passes, 2);
        assert.equal(result.mediaDeleted, PRUNE_BATCH_SIZE + 6);
        assert.equal(result.moreRemaining, false);
    });

    it('removes queued Storage objects once, after every pass, even with media retention off', async () => {
        // The queue also holds objects whose rows the Studio or a tenant deletion removed, so it
        // cannot wait for MEDIA_RETENTION_DAYS, which is off by default.
        const order: string[] = [];
        const deps = {
            pruneRaw: async () => { order.push('raw'); return { cleared: order.length === 1 ? PRUNE_BATCH_SIZE : 0, skipped: false }; },
            pruneJobs: async () => { order.push('jobs'); return { deleted: 0 }; },
            pruneMedia: async () => { order.push('media'); return { deleted: 0 as const, skipped: true as const, reason: 'disabled' as const }; },
            removeObjects: async () => { order.push('objects'); return { removed: 3, failed: 0, skipped: false as const }; },
        };

        const result = await runRetentionSweep(deps);

        assert.deepEqual(order, ['raw', 'jobs', 'media', 'raw', 'jobs', 'media', 'objects']);
        assert.equal(result.mediaObjectsRemoved, 3);
        assert.equal(result.passes, 2);
    });

    it('sweeps the image allowance once, after the passes and the object queue, however many passes the others need (T054)', async () => {
        const order: string[] = [];
        let raw = 0;
        const result = await runRetentionSweep({
            pruneRaw: async () => { order.push('raw'); return { cleared: raw++ < 2 ? PRUNE_BATCH_SIZE : 0, skipped: false }; },
            pruneJobs: async () => ({ deleted: 0 }),
            pruneMedia: async () => ({ deleted: 0 as const, skipped: false as const }),
            removeObjects: async () => { order.push('objects'); return { removed: 0, failed: 0, skipped: false as const }; },
            pruneAllowance: async () => { order.push('allowance'); return 9; },
        });
        assert.equal(result.passes, 3);
        assert.deepEqual(order, ['raw', 'raw', 'raw', 'objects', 'allowance']);
        assert.equal(result.allowanceRowsDeleted, 9);
    });

    it('reports zero, and calls nothing, when a test passes dependencies without the allowance sweep', async () => {
        const result = await runRetentionSweep(scripted([0], [0]));
        assert.equal(result.allowanceRowsDeleted, 0);
    });

    it('never throws because of the allowance sweep: no table before v59, or a failure, is read as zero and logged', async () => {
        const lines: { level: string; line: string }[] = [];
        const previous = setLogSink((level, line) => lines.push({ level, line }));
        try {
            const noTable = await runRetentionSweep({
                ...scripted([0]),
                pruneAllowance: async () => { throw Object.assign(new Error('relation "image_allowance" does not exist'), { code: '42P01' }); },
            });
            assert.equal(noTable.allowanceRowsDeleted, 0);
            assert.equal(lines.length, 0, 'a database behind v59 has nothing to sweep, and that is not an error');

            const broken = await runRetentionSweep({
                ...scripted([0]),
                pruneAllowance: async () => { throw new Error('connection terminated'); },
            });
            assert.equal(broken.allowanceRowsDeleted, 0);
            assert.equal(lines.filter((l) => l.level === 'error' && l.line.includes('retention.allowance_sweep_failed')).length, 1);
        } finally {
            setLogSink(previous);
        }
    });

    describe('the real sweep carries the allowance sweep in its default dependencies (T054)', () => {
        const originalQuery = pool.query;
        let statements: string[] = [];
        beforeEach(() => {
            statements = [];
            (pool as unknown as { query: unknown }).query = async (sql: string) => { statements.push(sql.replace(/\s+/g, ' ').trim()); return { rows: [], rowCount: 4 }; };
        });
        afterEach(() => { (pool as unknown as { query: unknown }).query = originalQuery; });

        it('is there, and deletes the allowance rows older than 90 days on the pool, counting what it deleted', async () => {
            assert.equal(typeof DEFAULT_RETENTION_DEPS.pruneAllowance, 'function');
            assert.equal(await DEFAULT_RETENTION_DEPS.pruneAllowance!(), 4);
            assert.deepEqual(statements, ["DELETE FROM image_allowance WHERE day < (NOW() AT TIME ZONE 'UTC')::date - 90"]);
        });

        it('is run by the sweep, once, and its count is in the result', async () => {
            const result = await runRetentionSweep({
                pruneRaw: async () => ({ cleared: 0, skipped: false }),
                pruneJobs: async () => ({ deleted: 0 }),
                pruneMedia: async () => ({ deleted: 0 as const, skipped: false as const }),
                removeObjects: async () => ({ removed: 0, failed: 0, skipped: false as const }),
                pruneAllowance: DEFAULT_RETENTION_DEPS.pruneAllowance,
            });
            assert.equal(result.allowanceRowsDeleted, 4);
            assert.equal(statements.filter((sql) => /image_allowance/.test(sql)).length, 1);
        });
    });

    it('gives up after the pass cap rather than running until the invocation dies', async () => {
        // An endless supply of full batches. The cap is what stops a sweep from eating the
        // cron invocation that has scheduled posts to publish after it.
        const endless = {
            pruneRaw: async () => ({ cleared: PRUNE_BATCH_SIZE, skipped: false }),
            pruneJobs: async () => ({ deleted: 0 }),
            pruneMedia: async () => ({ deleted: 0 as const, skipped: true as const, reason: 'disabled' as const }),
            removeObjects: async () => ({ removed: 0, failed: 0, skipped: false as const }),
        };
        const result = await runRetentionSweep(endless);

        assert.equal(result.passes, MAX_SWEEP_PASSES);
        assert.equal(result.moreRemaining, true, 'and says so, so the operator knows to expect another run');
    });
});

describe('media retention gating', () => {
    let saved: string | undefined;

    beforeEach(() => { saved = process.env.MEDIA_RETENTION_DAYS; });
    afterEach(() => {
        if (saved === undefined) delete process.env.MEDIA_RETENTION_DAYS;
        else process.env.MEDIA_RETENTION_DAYS = saved;
    });

    it('does nothing when unset — this is an irreversible delete of the operator\'s own media', async () => {
        delete process.env.MEDIA_RETENTION_DAYS;
        const out = await pruneOrphanedMedia();
        // `reason` is the whole point: without it, "retention is off" and "the DELETE threw"
        // are the same value, and this assertion passes even when the gate is removed.
        assert.deepEqual(out, { deleted: 0, skipped: true, reason: 'disabled' });
    });

    it('refuses a window below the minimum rather than silently using a default', async () => {
        // Falling back to a default would delete media the operator never agreed to lose.
        for (const bad of ['0', '1', '6', '-30', 'thirty', '']) {
            process.env.MEDIA_RETENTION_DAYS = bad;
            const out = await pruneOrphanedMedia();
            assert.deepEqual(out, { deleted: 0, skipped: true, reason: 'disabled' }, `value ${JSON.stringify(bad)}`);
        }
    });

    it('accepts the minimum and above', () => {
        for (const good of [String(MIN_RETENTION_DAYS), '30', '365']) {
            assert.equal(resolveRetention(good).enabled, true, `value ${good}`);
        }
    });
});

/**
 * Which references keep an upload alive. There is no database here, so the DELETE itself is
 * the thing asserted — its NOT EXISTS clause is the whole policy, the same stance
 * tiktokPublish.test.ts takes on its transition clauses.
 */
describe('pruneOrphanedMedia — what still counts as in use', () => {
    let saved: string | undefined;
    let statements: string[] = [];
    let params: unknown[][] = [];
    /** What `storage.cleanup_after_publish` holds, as the app_settings read sees it. */
    let cleanupSetting: string | null = null;
    /** Makes a statement fail, as the database would: the first one this returns an error for. */
    let failWith: ((sql: string) => Error | null) | null = null;
    const originalQuery = pool.query;
    let restoreSink: (() => void) | undefined;

    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());

    beforeEach(() => {
        saved = process.env.MEDIA_RETENTION_DAYS;
        process.env.MEDIA_RETENTION_DAYS = '30';
        statements = [];
        params = [];
        cleanupSetting = null;
        failWith = null;
        resetProfileTableWarning();
        (pool as unknown as { query: unknown }).query = async (sql: string, values: unknown[] = []) => {
            if (/FROM app_settings/.test(sql)) {
                return { rows: cleanupSetting ? [{ value: cleanupSetting, is_secret: false }] : [], rowCount: 0 };
            }
            statements.push(sql.replace(/\s+/g, ' '));
            params.push(values);
            const failure = failWith?.(sql);
            if (failure) throw failure;
            return { rows: [], rowCount: 3 };
        };
    });
    afterEach(() => {
        (pool as unknown as { query: unknown }).query = originalQuery;
        if (saved === undefined) delete process.env.MEDIA_RETENTION_DAYS;
        else process.env.MEDIA_RETENTION_DAYS = saved;
    });

    /** The NOT EXISTS clause of the one DELETE the prune runs. */
    async function keepClause(): Promise<string> {
        await pruneOrphanedMedia();
        assert.equal(statements.length, 1);
        const sql = statements[0]!;
        assert.match(sql, /^ ?DELETE FROM media_uploads/);
        const clause = /NOT EXISTS \((.*)\) LIMIT/.exec(sql)?.[1];
        assert.ok(clause, 'the delete is guarded by NOT EXISTS');
        return clause!;
    }

    it('keeps every slide of a carousel, not just the first one media_url mirrors', async () => {
        // The bug this guards: media_url holds slide 1 only. Matching it alone deleted slides
        // 2..N of a carousel still waiting to publish, and Meta or TikTok then fetched a 404.
        const clause = await keepClause();
        assert.match(clause, /array_to_string\(s\.media_urls, ' '\) LIKE '%' \|\| m\.id::text \|\| '%'/);
    });

    it('still keeps media and covers, for every state that may yet publish', async () => {
        const clause = await keepClause();
        assert.match(clause, /s\.media_url LIKE/);
        assert.match(clause, /s\.cover_url LIKE/);
        // PROCESSING because a TikTok photo post is still being pulled; FAILED because an
        // edit flips it back to PENDING.
        assert.match(clause, /s\.status IN \('PENDING', 'PUBLISHING', 'PROCESSING', 'FAILED'\)/);
    });

    it('keeps a Studio draft’s rendered slides, both formats, before any post names them', async () => {
        // A `ready` draft is waiting to be scheduled. Collecting its slides first would schedule
        // a carousel of 404s — and no scheduled_posts row protects them until it is scheduled.
        const clause = await keepClause();
        assert.match(clause, /NOT EXISTS \( SELECT 1 FROM carousel_drafts d WHERE/);
        assert.match(clause, /COALESCE\(d\.render->>'ig', ''\) \|\| ' ' \|\| COALESCE\(d\.render->>'tt', ''\)\) LIKE '%' \|\| m\.id::text \|\| '%'/);
    });

    it('keeps the thumbnails the shot picker shows', async () => {
        const clause = await keepClause();
        assert.match(clause, /NOT EXISTS \( SELECT 1 FROM lesson_moments lm WHERE lm\.thumb_url LIKE '%' \|\| m\.id::text \|\| '%'/);
    });

    it('keeps a Monteur reel\u2019s video and cover while it is rendering, in review or scheduled for later', async () => {
        // A reel in review is waiting for Approve, and no scheduled post names its files until
        // then. A rejected or failed reel's files are free to go (MONTEUR.md §2).
        const clause = await keepClause();
        assert.match(clause, /NOT EXISTS \( SELECT 1 FROM clip_drafts c WHERE \(c\.status IN \('rendering', 'review'\) OR \(c\.status = 'scheduled' AND \(c\.schedule->>'scheduled_time'\)::timestamptz > NOW\(\)\)\)/,
            'a scheduled reel only until its time: after it, its posts name what is still needed');
        assert.match(clause, /COALESCE\(c\.render->>'video_url', ''\) \|\| ' ' \|\| COALESCE\(c\.render->>'tiktok_video_url', ''\) \|\| ' ' \|\| COALESCE\(c\.render->>'cover_url', ''\)\) LIKE '%' \|\| m\.id::text \|\| '%'/,
            'the TikTok cut too');
        const clips = clause.slice(clause.indexOf('FROM clip_drafts'));
        assert.doesNotMatch(clips, /'rejected'|'failed'/, 'a rejected or failed reel keeps nothing');
    });

    it('keeps an infographic\u2019s GIF while it exists, and its MP4 and cover until its posting time', async () => {
        // The GIF is posted by hand (LinkedIn, X), so no scheduled post ever names it.
        const clause = await keepClause();
        assert.match(clause, /NOT EXISTS \( SELECT 1 FROM infographics i WHERE \(COALESCE\(i\.render->>'gif_url', ''\) \|\| CASE WHEN i\.status <> 'scheduled' OR \(i\.schedule->>'scheduled_time'\)::timestamptz > NOW\(\) THEN ' ' \|\| COALESCE\(i\.render->>'mp4_url', ''\) \|\| ' ' \|\| COALESCE\(i\.render->>'cover_url', ''\) ELSE '' END\) LIKE '%' \|\| m\.id::text \|\| '%'/);
    });

    it('keeps the portrait the infographic brand shows', async () => {
        const clause = await keepClause();
        assert.match(clause, /NOT EXISTS \( SELECT 1 FROM studio_settings ss WHERE ss\.infographic->>'photo_url' LIKE '%' \|\| m\.id::text \|\| '%'/);
    });

    it('keeps the portrait and the logo a stored Creator Profile names, and the cover an offer\'s sales block names', async () => {
        // The portrait is mirrored into studio_settings, but the profile is the source of truth and the logo is
        // held by no setting at all: a swept logo is a broken image on every infographic. An offer's sales cover
        // (`offers[].sales.image_url`) lives in a list, so the offers are read whole: an upload's id anywhere in them keeps it.
        const clause = await keepClause();
        assert.match(clause, /NOT EXISTS \( SELECT 1 FROM creator_profiles cp WHERE \(COALESCE\(cp\.profile->'brand'->>'portrait_url', ''\) \|\| ' ' \|\| COALESCE\(cp\.profile->'brand'->>'logo_url', ''\) \|\| ' ' \|\| COALESCE\(\(cp\.profile->'offers'\)::text, ''\)\) LIKE '%' \|\| m\.id::text \|\| '%'/);
    });

    it('keeps every picture of a scene, the chosen one and the last three, whatever the explainer\u2019s status (v59)', async () => {
        // A scene's pictures are the product of an allowance that resets daily: collecting one that the owner can still pick is a
        // picture drawn twice. They are kept by their scene alone; the scene goes with its explainer.
        const clause = await keepClause();
        assert.match(clause, /NOT EXISTS \( SELECT 1 FROM explainer_scenes es WHERE \(COALESCE\(es\.picture::text, ''\) \|\| ' ' \|\| es\.pictures::text\) LIKE '%' \|\| m\.id::text \|\| '%'/);
        const scenes = clause.slice(clause.indexOf('FROM explainer_scenes'), clause.indexOf('FROM explainers e'));
        assert.doesNotMatch(scenes, /status|NOW\(\)|INTERVAL/, 'no state of the explainer, and no clock, lets a picture of an existing scene go');
    });

    it('keeps an explainer\u2019s voiceover, both videos and cover until 30 days after its posting time, and for as long as it is not scheduled', async () => {
        // A `ready` explainer is waiting for Schedule and no post names its files until then. Once it is scheduled they stay for
        // the 30 days of FR-031, and after them go like any posted file (the posts' own guard keeps what a post may still fetch).
        const clause = await keepClause();
        assert.equal(EXPLAINER_FILES_GRACE_DAYS, 30);
        assert.match(clause, /NOT EXISTS \( SELECT 1 FROM explainers e WHERE \(e\.status <> 'scheduled' OR COALESCE\(\(e\.schedule->>'scheduled_time'\)::timestamptz \+ INTERVAL '30 days' > NOW\(\), TRUE\)\)/);
        assert.match(clause, /AND \(COALESCE\(e\.audio->>'media_id', ''\) \|\| ' ' \|\| COALESCE\(e\.audio->>'url', ''\) \|\| ' ' \|\| COALESCE\(e\.render->>'vertical_url', ''\) \|\| ' ' \|\| COALESCE\(e\.render->>'horizontal_url', ''\) \|\| ' ' \|\| COALESCE\(e\.render->>'cover_url', ''\)\) LIKE '%' \|\| m\.id::text \|\| '%'/);
    });

    it('a scheduled explainer whose time cannot be read keeps its files: unknown is never a reason to delete', async () => {
        // `NULL + 30 days > NOW()` is NULL, and a NULL in a NOT EXISTS condition reads as "not named": the COALESCE to TRUE is what
        // keeps the file when the row is malformed.
        const clause = await keepClause();
        const timeCheck = /COALESCE\(\(e\.schedule->>'scheduled_time'\)::timestamptz \+ INTERVAL '30 days' > NOW\(\), TRUE\)/;
        assert.match(clause, timeCheck);
        // And the window is measured from the time it was scheduled FOR, not from when the row was written.
        assert.doesNotMatch(clause.slice(clause.indexOf('FROM explainers e')), /e\.updated_at|e\.created_at/);
    });

    it('keeps the reference pictures of the characters and the music tracks the explainer settings name', async () => {
        // A track is the owner's file and no post names it; a reference picture is sent with every draw that names its character.
        const clause = await keepClause();
        assert.match(clause, /NOT EXISTS \( SELECT 1 FROM studio_settings st WHERE \(COALESCE\(\(st\.explainer->'characters'\)::text, ''\) \|\| ' ' \|\| COALESCE\(\(st\.explainer->'music'\)::text, ''\)\) LIKE '%' \|\| m\.id::text \|\| '%'/);
    });

    describe('each kind of explainer file is named by the guard that keeps it (v59): a sweep deletes none of them while the explainer or its settings name it', () => {
        // The files are named only inside JSON, so the guard reads that JSON. One test per kind, so that a guard that loses one of them is the test that says which.
        // (The statements were also run against a real Postgres, with a row of every kind: see the PR.)
        const KINDS: [string, RegExp][] = [
            ['a scene\u2019s chosen picture (`picture.media_id`)', /FROM explainer_scenes es WHERE \(COALESCE\(es\.picture::text, ''\)/],
            ['a scene\u2019s earlier pictures (`pictures[].media_id`)', /\|\| ' ' \|\| es\.pictures::text\) LIKE '%' \|\| m\.id::text \|\| '%'/],
            ['a character\u2019s approved reference picture (`explainer.characters[].ref_media_id`)', /COALESCE\(\(st\.explainer->'characters'\)::text, ''\)/],
            ['a music track of the library (`explainer.music[].media_id`)', /COALESCE\(\(st\.explainer->'music'\)::text, ''\)/],
            ['the voiceover, by its id and by its address (`audio.media_id`, `audio.url`)', /COALESCE\(e\.audio->>'media_id', ''\) \|\| ' ' \|\| COALESCE\(e\.audio->>'url', ''\)/],
            ['the vertical video (`render.vertical_url`)', /COALESCE\(e\.render->>'vertical_url', ''\)/],
            ['the horizontal video (`render.horizontal_url`)', /COALESCE\(e\.render->>'horizontal_url', ''\)/],
            ['the cover (`render.cover_url`)', /COALESCE\(e\.render->>'cover_url', ''\)/],
        ];
        for (const [what, pattern] of KINDS) {
            it(`keeps ${what}`, async () => {
                assert.match(await keepClause(), pattern);
            });
        }

        it('keeps the voiceover and the videos by the explainer’s state, not by the settings or the scenes: the three guards are three separate EXISTS', async () => {
            const clause = await keepClause();
            const explainerGuard = clause.slice(clause.indexOf('FROM explainers e'), clause.indexOf('FROM studio_settings st'));
            assert.match(explainerGuard, /e\.audio/);
            assert.doesNotMatch(explainerGuard, /es\.|st\./, 'the explainer guard reads only the explainer');
            const settingsGuard = clause.slice(clause.indexOf('FROM studio_settings st'));
            assert.doesNotMatch(settingsGuard, /e\.render|e\.audio/, 'and the settings guard only the settings');
        });
    });

    it('requires every guard at once: each NOT EXISTS is ANDed, never ORed', async () => {
        // An OR between them would delete anything any single table does not name — a render
        // slide is named by no scheduled post, so it would go.
        await pruneOrphanedMedia();
        const sql = statements[0]!;
        assert.equal((sql.match(/NOT EXISTS/g) ?? []).length, 10);
        assert.equal((sql.match(/AND NOT EXISTS/g) ?? []).length, 10);
        assert.doesNotMatch(sql, /OR NOT EXISTS/);
    });

    describe('before migration v33 is applied', () => {
        const missing = (table: string): Error => Object.assign(new Error(`relation "${table}" does not exist`), { code: '42P01' });

        it('runs again without the profile guard, instead of stopping the whole sweep', async () => {
            // With no creator_profiles table no profile names a file, so the guard is vacuous: the sweep deletes
            // what it deleted before the guard existed. Without the retry the query fails whole, the prune reports
            // an error, and no media is cleaned up until `npm run migrate` runs.
            failWith = (sql) => (/creator_profiles/.test(sql) ? missing('creator_profiles') : null);
            const out = await pruneOrphanedMedia();
            assert.deepEqual(out, { deleted: 3, skipped: false });
            assert.equal(statements.length, 2);
            assert.match(statements[0]!, /creator_profiles/);
            assert.doesNotMatch(statements[1]!, /creator_profiles/);
            assert.equal((statements[1]!.match(/AND NOT EXISTS/g) ?? []).length, 9, 'every other guard is still there, the explainers\u2019 too');
            assert.deepEqual(params[1], params[0], 'with the same window, flag and batch size');
        });

        it('warns once, not on every sweep', async () => {
            const lines: string[] = [];
            const previous = setLogSink((_level, line) => lines.push(line));
            try {
                failWith = (sql) => (/creator_profiles/.test(sql) ? missing('creator_profiles') : null);
                await pruneOrphanedMedia();
                await pruneOrphanedMedia();
            } finally {
                setLogSink(previous);
            }
            assert.equal(lines.filter((l) => l.includes('retention.profile_table_missing')).length, 1);
        });

        it('does not retry a failure about any other table', async () => {
            // The retry is for the one table this migration adds. An infographics table that is missing is a
            // different problem, and running the query again without a guard would not fix it.
            failWith = () => missing('infographics');
            const out = await pruneOrphanedMedia();
            assert.deepEqual(out, { deleted: 0, skipped: true, reason: 'error' });
            assert.equal(statements.length, 1);
        });

        it('the Clean up now preview falls back the same way', async () => {
            failWith = (sql) => (/creator_profiles/.test(sql) ? missing('creator_profiles') : null);
            await previewMediaCleanup();
            assert.equal(statements.length, 2);
            assert.match(statements[0]!, /creator_profiles/);
            assert.doesNotMatch(statements[1]!, /creator_profiles/);
        });
    });

    describe('before migration v59 is applied', () => {
        const missing = (table: string): Error => Object.assign(new Error(`relation "${table}" does not exist`), { code: '42P01' });
        const noColumn = (column: string): Error => Object.assign(new Error(`column ${column} does not exist`), { code: '42703' });
        const explainerGuards = /explainer_scenes|FROM explainers|st\.explainer/;

        it('runs again without the three explainer guards, instead of stopping the whole sweep', async () => {
            // With no explainer tables no explainer names a file, so the guards are vacuous: the sweep deletes what it deleted before
            // v59. Without the retry the query fails whole and no media is cleaned up until `npm run migrate` runs.
            failWith = (sql) => (explainerGuards.test(sql) ? missing('explainer_scenes') : null);
            const out = await pruneOrphanedMedia();
            assert.deepEqual(out, { deleted: 3, skipped: false });
            assert.equal(statements.length, 2);
            assert.match(statements[0]!, explainerGuards);
            assert.doesNotMatch(statements[1]!, explainerGuards);
            assert.equal((statements[1]!.match(/AND NOT EXISTS/g) ?? []).length, 7, 'every other guard is still there, the profile\u2019s too');
            assert.deepEqual(params[1], params[0], 'with the same window, flag and batch size');
        });

        it('falls back for each of the three ways the database can say it, and only for them', async () => {
            for (const error of [missing('explainer_scenes'), missing('explainers'), noColumn('st.explainer')]) {
                statements = [];
                resetProfileTableWarning();
                failWith = (sql) => (explainerGuards.test(sql) ? error : null);
                const out = await pruneOrphanedMedia();
                assert.deepEqual(out, { deleted: 3, skipped: false }, error.message);
                assert.equal(statements.length, 2, error.message);
            }
            // A column that is missing from another table is not this migration's.
            statements = [];
            failWith = () => noColumn('e.render_x');
            assert.deepEqual(await pruneOrphanedMedia(), { deleted: 0, skipped: true, reason: 'error' });
            assert.equal(statements.length, 1);
        });

        it('warns once, not on every sweep', async () => {
            const lines: string[] = [];
            const previous = setLogSink((_level, line) => lines.push(line));
            try {
                failWith = (sql) => (explainerGuards.test(sql) ? missing('explainers') : null);
                await pruneOrphanedMedia();
                await pruneOrphanedMedia();
            } finally {
                setLogSink(previous);
            }
            assert.equal(lines.filter((l) => l.includes('retention.explainer_tables_missing')).length, 1);
        });

        it('a database behind both v33 and v59 drops both guards, one retry each, and still keeps everything else', async () => {
            failWith = (sql) => (/creator_profiles/.test(sql) ? missing('creator_profiles') : explainerGuards.test(sql) ? missing('explainers') : null);
            const out = await pruneOrphanedMedia();
            assert.deepEqual(out, { deleted: 3, skipped: false });
            assert.equal(statements.length, 3);
            assert.equal((statements[2]!.match(/AND NOT EXISTS/g) ?? []).length, 6);
            assert.doesNotMatch(statements[2]!, new RegExp(`creator_profiles|${explainerGuards.source}`));
        });

        it('does not retry a failure about any other table', async () => {
            failWith = () => missing('clip_drafts');
            assert.deepEqual(await pruneOrphanedMedia(), { deleted: 0, skipped: true, reason: 'error' });
            assert.equal(statements.length, 1);
        });

        it('the Clean up now preview falls back the same way', async () => {
            failWith = (sql) => (explainerGuards.test(sql) ? missing('explainer_scenes') : null);
            await previewMediaCleanup();
            assert.equal(statements.length, 2);
            assert.match(statements[0]!, explainerGuards);
            assert.doesNotMatch(statements[1]!, explainerGuards);
        });
    });

    it('without the setting: MEDIA_RETENTION_DAYS, by age only — a published post’s file waits like any other', async () => {
        await pruneOrphanedMedia();
        assert.deepEqual(params[0], [30, false, 5000]);
        assert.match(statements[0]!, /\$2::boolean AND EXISTS \( SELECT 1 FROM scheduled_posts s WHERE s\.status = 'PUBLISHED'/);
    });

    it('with "Delete files once posted": a published post’s files at once, anything unnamed after a week', async () => {
        cleanupSetting = 'true';
        delete process.env.MEDIA_RETENTION_DAYS;
        await pruneOrphanedMedia();
        assert.deepEqual(params[0], [MIN_RETENTION_DAYS, true, 5000]);
    });

    it('the published branch is ORed with the age only: the keep-guards still bind it', async () => {
        await pruneOrphanedMedia();
        const sql = statements[0]!;
        const where = sql.slice(sql.indexOf('WHERE ('), sql.indexOf(') AND NOT EXISTS'));
        assert.match(where, /m\.created_at < NOW\(\) - make_interval\(days => \$1\) OR \(\$2::boolean AND EXISTS/);
    });
});

/**
 * A pruned row whose bytes are in Supabase Storage takes its object with it.
 *
 * The link between the two is the v23 trigger, which queues a deleted row's `storage_path` in the
 * same transaction as the DELETE. There is no database here, so the stub plays the trigger's part
 * (the trigger itself was run against a scratch Postgres: a DELETE queues the path, a rolled-back
 * one queues nothing, a CASCADE from `creators` queues too). What is pinned is the sweep's half:
 * everything the DELETE queued is removed from the bucket in the same run, and an entry leaves the
 * queue only once Supabase has confirmed it.
 */
describe('the media retention sweep deletes the object as well as the row', () => {
    const CREATOR = '11111111-1111-4111-8111-111111111111';
    const STORED_PATH = `${CREATOR}/aaaaaaaa-0000-4000-8000-000000000001.mp4`;
    const KEY = 'sb_secret_0123456789abcdefghijKLMNOP';

    let queue: Map<string, number>;
    let removedFromBucket: string[][];
    let supabase: () => Response;
    let saved: Record<string, string | undefined>;
    let previousFetch: ReturnType<typeof setStorageFetch> = null;
    const originalQuery = pool.query;
    let restoreSink: (() => void) | undefined;

    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());

    beforeEach(() => {
        queue = new Map();
        removedFromBucket = [];
        supabase = () => new Response(JSON.stringify([{ name: STORED_PATH }]), { status: 200 });
        saved = {
            media: process.env.MEDIA_RETENTION_DAYS, raw: process.env.RAW_PAYLOAD_RETENTION_DAYS,
            enc: process.env.TOKEN_ENCRYPTION_KEY,
        };
        process.env.MEDIA_RETENTION_DAYS = '30';
        delete process.env.RAW_PAYLOAD_RETENTION_DAYS;
        process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);

        const settings = new Map([
            ['storage.supabase_url', { value: 'https://abcd1234.supabase.co', is_secret: false }],
            ['storage.supabase_service_key', { value: encryptSecret(KEY), is_secret: true }],
        ]);
        (pool as unknown as { query: unknown }).query = async (sql: string, params: any[] = []) => {
            const flat = sql.replace(/\s+/g, ' ').trim();
            // The customer-file prune (migration v51) is its own statement, tested in its own describe below: nothing to delete here.
            if (/^DELETE FROM media_uploads WHERE id IN \( SELECT m\.id FROM media_uploads m WHERE m\.is_private/.test(flat)) return { rows: [], rowCount: 0 };
            if (/^DELETE FROM media_uploads/.test(flat)) {
                // Two eligible rows: one in Storage, one legacy BYTEA. The trigger queues only
                // the first.
                queue.set(STORED_PATH, 0);
                return { rows: [], rowCount: 2 };
            }
            if (/^DELETE FROM jobs/.test(flat)) return { rows: [], rowCount: 0 };
            if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(flat)) {
                const row = settings.get(String(params[0]));
                return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            }
            if (/^SELECT storage_path FROM media_object_deletions/.test(flat)) {
                return { rows: [...queue.keys()].map((storage_path) => ({ storage_path })), rowCount: queue.size };
            }
            if (/^DELETE FROM media_object_deletions/.test(flat)) {
                for (const path of params[0] as string[]) queue.delete(path);
                return { rows: [], rowCount: (params[0] as string[]).length };
            }
            if (/^UPDATE media_object_deletions SET attempts = attempts \+ 1/.test(flat)) {
                for (const path of params[0] as string[]) queue.set(path, (queue.get(path) ?? 0) + 1);
                return { rows: [], rowCount: (params[0] as string[]).length };
            }
            throw new Error(`no result arranged for SQL: ${flat}`);
        };
        previousFetch = setStorageFetch(async (input, init) => {
            assert.equal(init?.method, 'DELETE');
            assert.equal(new URL(input).pathname, `/storage/v1/object/${MEDIA_BUCKET}`);
            removedFromBucket.push(JSON.parse(String(init?.body)).prefixes);
            return supabase();
        });
    });

    afterEach(() => {
        (pool as unknown as { query: unknown }).query = originalQuery;
        setStorageFetch(previousFetch);
        for (const [name, value] of [
            ['MEDIA_RETENTION_DAYS', saved.media], ['RAW_PAYLOAD_RETENTION_DAYS', saved.raw], ['TOKEN_ENCRYPTION_KEY', saved.enc],
        ] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    it('removes the pruned row\'s object from the bucket in the same run', async () => {
        const result = await runRetentionSweep();

        assert.equal(result.mediaDeleted, 2);
        assert.deepEqual(removedFromBucket, [[STORED_PATH]], 'only the Storage row has an object to remove');
        assert.equal(result.mediaObjectsRemoved, 1);
        assert.equal(queue.size, 0);
    });

    it('keeps the object queued, and retries it next run, when Supabase is down', async () => {
        supabase = () => new Response(JSON.stringify({ message: 'upstream unavailable' }), { status: 503 });

        const first = await runRetentionSweep();
        assert.equal(first.mediaObjectsRemoved, 0);
        assert.equal(queue.get(STORED_PATH), 1, 'still queued, one attempt counted');

        supabase = () => new Response(JSON.stringify([{ name: STORED_PATH }]), { status: 200 });
        const second = await runRetentionSweep();
        assert.equal(second.mediaObjectsRemoved, 1);
        assert.equal(queue.size, 0);
    });
});

/**
 * A customer's file (a private upload, migration v51) follows its own rule, not a post's.
 *
 * There is no database in this suite, so what is pinned is the SQL each statement is made of: which conditions it carries, that they are
 * ANDed, and in what order the sweep runs them. The posts' prune must never reach a private row; the private prune deletes a private row
 * only when it is older than `PRIVATE_MEDIA_ORPHAN_DAYS` AND no message names it (`messages.media_upload_id`), so a file a message still
 * points at survives every sweep, however old; and erasure (not retention) is what removes a file together with its message.
 */
describe('private uploads follow their own retention rule', () => {
    const originalQuery = pool.query;
    let saved: string | undefined;
    let statements: string[];
    let params: unknown[][];
    let failWith: ((sql: string) => Error | null) | null;
    let restoreSink: (() => void) | undefined;

    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());

    beforeEach(() => {
        saved = process.env.MEDIA_RETENTION_DAYS;
        process.env.MEDIA_RETENTION_DAYS = '30';
        statements = [];
        params = [];
        failWith = null;
        resetProfileTableWarning();
        (pool as unknown as { query: unknown }).query = async (sql: string, values: unknown[] = []) => {
            if (/FROM app_settings/.test(sql)) return { rows: [], rowCount: 0 };
            statements.push(sql.replace(/\s+/g, ' ').trim());
            params.push(values);
            const failure = failWith?.(sql);
            if (failure) throw failure;
            return { rows: [], rowCount: 3 };
        };
    });
    afterEach(() => {
        (pool as unknown as { query: unknown }).query = originalQuery;
        if (saved === undefined) delete process.env.MEDIA_RETENTION_DAYS;
        else process.env.MEDIA_RETENTION_DAYS = saved;
    });

    const missingColumn = (column: string): Error => Object.assign(new Error(`column m.${column} does not exist`), { code: '42703' });
    const missingTable = (table: string): Error => Object.assign(new Error(`relation "${table}" does not exist`), { code: '42P01' });

    describe('the posts\' prune never reaches one', () => {
        it('carries `AND NOT m.is_private` BEFORE every other guard, outside the age/published OR, so no age and no published post can select a private row', async () => {
            await pruneOrphanedMedia();
            const sql = statements[0]!;
            const where = sql.slice(sql.indexOf('WHERE ('));
            assert.match(where, /make_interval\(days => \$1\) OR \(\$2::boolean AND EXISTS \(.*\)\) \) AND NOT m\.is_private AND NOT EXISTS \(/,
                'the private line follows the closing of the OR group and precedes the first keep-guard');
            assert.equal((sql.match(/NOT m\.is_private/g) ?? []).length, 1);
        });

        it('the Clean up now preview and its delete leave private files out too', async () => {
            await previewMediaCleanup();
            assert.match(statements[0]!, /AND NOT m\.is_private AND NOT EXISTS \(/);
        });

        it('is unchanged in everything else: the same window, flag and batch, and the same ten keep-guards ANDed', async () => {
            await pruneOrphanedMedia();
            assert.deepEqual(params[0], [30, false, 5000]);
            assert.equal((statements[0]!.match(/AND NOT EXISTS/g) ?? []).length, 10);
            assert.doesNotMatch(statements[0]!, /OR NOT EXISTS/);
        });

        it('before v51 (no is_private column) runs again without that line, instead of stopping the sweep: no file is private yet', async () => {
            failWith = (sql) => (/is_private/.test(sql) ? missingColumn('is_private') : null);
            const out = await pruneOrphanedMedia();
            assert.deepEqual(out, { deleted: 3, skipped: false });
            assert.equal(statements.length, 2);
            assert.match(statements[0]!, /is_private/);
            assert.doesNotMatch(statements[1]!, /is_private/);
            assert.equal((statements[1]!.match(/AND NOT EXISTS/g) ?? []).length, 10, 'every keep-guard is still there');
            assert.deepEqual(params[1], params[0]);
        });

        it('behind both v33 and v51 it drops both lines, one at a time, and still runs', async () => {
            failWith = (sql) => (/creator_profiles/.test(sql) ? missingTable('creator_profiles') : /is_private/.test(sql) ? missingColumn('is_private') : null);
            const out = await pruneOrphanedMedia();
            assert.deepEqual(out, { deleted: 3, skipped: false });
            assert.equal(statements.length, 3);
            assert.doesNotMatch(statements[2]!, /creator_profiles|is_private/);
            assert.equal((statements[2]!.match(/AND NOT EXISTS/g) ?? []).length, 9);
        });

        it('does not retry a missing column that is not is_private', async () => {
            failWith = () => missingColumn('something_else');
            assert.deepEqual(await pruneOrphanedMedia(), { deleted: 0, skipped: true, reason: 'error' });
            assert.equal(statements.length, 1);
        });
    });

    describe('their own rule', () => {
        const flat = PRIVATE_ORPHANS_SQL.replace(/\s+/g, ' ').trim();

        it('is 30 days, a named constant', () => {
            assert.equal(PRIVATE_MEDIA_ORPHAN_DAYS, 30);
        });

        it('deletes a private row only when it is older than the window AND no message names it: all ANDed, oldest first, in batches', async () => {
            assert.equal(flat,
                'DELETE FROM media_uploads WHERE id IN ( SELECT m.id FROM media_uploads m WHERE m.is_private AND m.created_at < NOW() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.media_upload_id = m.id) ORDER BY m.created_at LIMIT $2 )');
            assert.doesNotMatch(flat, /\bOR\b/, 'no way around any condition');

            assert.deepEqual(await pruneOrphanedPrivateMedia(), { deleted: 3, skipped: false });
            assert.equal(statements[0], flat);
            assert.deepEqual(params[0], [PRIVATE_MEDIA_ORPHAN_DAYS, PRUNE_BATCH_SIZE]);
        });

        it('a file a message points at is kept however old: the reference alone, with no age, is a reason to keep it', () => {
            // The reference test is a NOT EXISTS over messages on this very upload id, and the age test is a separate AND:
            // so "older than 30 days" never overrides "a message names it".
            assert.match(flat, /AND NOT EXISTS \(SELECT 1 FROM messages x WHERE x\.media_upload_id = m\.id\)/);
            assert.match(flat, /AND m\.created_at < NOW\(\) - make_interval\(days => \$1\)/);
            assert.doesNotMatch(flat, /OR NOT EXISTS|OR m\.created_at/);
        });

        it('does not delete a public upload: it only ever selects is_private rows', () => {
            assert.match(flat, /WHERE m\.is_private AND/);
        });

        it('runs even with media retention OFF (MEDIA_RETENTION_DAYS unset): it is a privacy rule, not storage housekeeping', async () => {
            delete process.env.MEDIA_RETENTION_DAYS;
            assert.deepEqual(await pruneOrphanedMedia(), { deleted: 0, skipped: true, reason: 'disabled' });
            assert.equal(statements.length, 0, 'the posts\' prune did nothing');
            assert.deepEqual(await pruneOrphanedPrivateMedia(), { deleted: 3, skipped: false });
            assert.equal(statements.length, 1);
        });

        it('never throws: a database behind v50/v51 reads as nothing to prune, any other failure as an error', async () => {
            failWith = () => missingColumn('is_private');
            assert.deepEqual(await pruneOrphanedPrivateMedia(), { deleted: 0, skipped: true, reason: 'unmigrated' });
            failWith = () => missingColumn('media_upload_id');
            assert.deepEqual(await pruneOrphanedPrivateMedia(), { deleted: 0, skipped: true, reason: 'unmigrated' });
            failWith = () => new Error('connection terminated');
            assert.deepEqual(await pruneOrphanedPrivateMedia(), { deleted: 0, skipped: true, reason: 'error' });
        });
    });

    describe('in the sweep', () => {
        const base = {
            pruneRaw: async () => ({ cleared: 0, skipped: false }),
            pruneJobs: async () => ({ deleted: 0 }),
            pruneMedia: async () => ({ deleted: 0 as const, skipped: true as const, reason: 'disabled' as const }),
        };

        it('runs once after the passes and BEFORE the object queue drains, so the files\' objects go in the same run', async () => {
            const order: string[] = [];
            const result = await runRetentionSweep({
                pruneRaw: async () => { order.push('raw'); return { cleared: 0, skipped: false }; },
                pruneJobs: async () => { order.push('jobs'); return { deleted: 0 }; },
                pruneMedia: async () => { order.push('media'); return { deleted: 0 as const, skipped: true as const, reason: 'disabled' as const }; },
                prunePrivateMedia: async () => { order.push('private'); return { deleted: 4, skipped: false as const }; },
                removeObjects: async () => { order.push('objects'); return { removed: 4, failed: 0, skipped: false as const }; },
            });
            assert.deepEqual(order, ['raw', 'jobs', 'media', 'private', 'objects']);
            assert.equal(result.privateMediaDeleted, 4);
            assert.equal(result.mediaObjectsRemoved, 4);
        });

        it('keeps going while its batches come back full, and says so when the cap stops it', async () => {
            const counts = [PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 7];
            let call = 0;
            const result = await runRetentionSweep({
                ...base,
                prunePrivateMedia: async () => ({ deleted: counts[call++] ?? 0, skipped: false as const }),
                removeObjects: async () => ({ removed: 0, failed: 0, skipped: false as const }),
            });
            assert.equal(result.privateMediaDeleted, PRUNE_BATCH_SIZE * 2 + 7);
            assert.equal(call, 3);
            assert.equal(result.moreRemaining, false);

            const endless = await runRetentionSweep({
                ...base,
                prunePrivateMedia: async () => ({ deleted: PRUNE_BATCH_SIZE, skipped: false as const }),
                removeObjects: async () => ({ removed: 0, failed: 0, skipped: false as const }),
            });
            assert.equal(endless.moreRemaining, true);
            assert.equal(endless.privateMediaDeleted, PRUNE_BATCH_SIZE * MAX_SWEEP_PASSES);
        });

        it('a sweep without the dependency (an older caller) still works and reports none', async () => {
            const result = await runRetentionSweep({ ...base, removeObjects: async () => ({ removed: 0, failed: 0, skipped: false as const }) });
            assert.equal(result.privateMediaDeleted, 0);
        });
    });

    describe('the whole sweep, against a fake database and a fake Storage', () => {
        const CREATOR = '11111111-1111-4111-8111-111111111111';
        const PRIVATE_PATH = `private/${CREATOR}/bbbbbbbb-0000-4000-8000-000000000002.ogg`;
        const KEY = 'sb_secret_0123456789abcdefghijKLMNOP';
        let queue: Set<string>;
        let storageCalls: Array<{ bucket: string; prefixes: string[] }>;
        let previousFetch: ReturnType<typeof setStorageFetch> = null;
        let savedEnc: string | undefined;

        beforeEach(() => {
            queue = new Set();
            storageCalls = [];
            delete process.env.MEDIA_RETENTION_DAYS; // media retention OFF, as it is by default
            savedEnc = process.env.TOKEN_ENCRYPTION_KEY;
            process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);
            const settings = new Map([
                ['storage.supabase_url', { value: 'https://abcd1234.supabase.co', is_secret: false }],
                ['storage.supabase_service_key', { value: encryptSecret(KEY), is_secret: true }],
            ]);
            (pool as unknown as { query: unknown }).query = async (sql: string, vals: any[] = []) => {
                const text = sql.replace(/\s+/g, ' ').trim();
                if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(text)) {
                    const row = settings.get(String(vals[0]));
                    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
                }
                // The orphaned customer file is deleted, and the v23 trigger queues its object.
                if (/^DELETE FROM media_uploads WHERE id IN \( SELECT m\.id FROM media_uploads m WHERE m\.is_private/.test(text)) {
                    queue.add(PRIVATE_PATH);
                    return { rows: [], rowCount: 1 };
                }
                if (/^DELETE FROM jobs/.test(text)) return { rows: [], rowCount: 0 };
                if (/^SELECT storage_path FROM media_object_deletions/.test(text)) return { rows: [...queue].map((storage_path) => ({ storage_path })), rowCount: queue.size };
                if (/^DELETE FROM media_object_deletions/.test(text)) { for (const path of vals[0] as string[]) queue.delete(path); return { rows: [], rowCount: 1 }; }
                throw new Error(`no result arranged for SQL: ${text}`);
            };
            previousFetch = setStorageFetch(async (input, init) => {
                assert.equal(init?.method, 'DELETE');
                storageCalls.push({ bucket: new URL(input).pathname.split('/').pop()!, prefixes: JSON.parse(String(init?.body)).prefixes });
                return new Response(JSON.stringify(JSON.parse(String(init?.body)).prefixes.map((name: string) => ({ name }))), { status: 200 });
            });
        });
        afterEach(() => {
            setStorageFetch(previousFetch);
            if (savedEnc === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
            else process.env.TOKEN_ENCRYPTION_KEY = savedEnc;
        });

        it('deletes an orphaned customer file with media retention off, and removes its object from the PRIVATE bucket only, in the same run', async () => {
            const result = await runRetentionSweep();

            assert.equal(result.privateMediaDeleted, 1);
            assert.equal(result.mediaDeleted, 0, 'the posts\' prune is off and did nothing');
            assert.equal(result.mediaObjectsRemoved, 1);
            assert.deepEqual(storageCalls, [{ bucket: PRIVATE_MEDIA_BUCKET, prefixes: [PRIVATE_PATH] }]);
            assert.ok(!storageCalls.some((c) => c.bucket === MEDIA_BUCKET), 'the public bucket was not touched');
            assert.equal(queue.size, 0);
        });
    });
});
