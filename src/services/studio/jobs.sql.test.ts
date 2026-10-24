/**
 * The Mac's claim statement (`CLAIM_SQL`) and the tables of migration v59, run on a REAL Postgres against fixture rows. `jobs.test.ts` proves
 * what the statement says; this proves what Postgres does with it: that a pending job with a future `not_before` is skipped and is taken once
 * it is due, that a stale claim is reclaimed whatever its `not_before` says, that no other kind is affected, and that the CHECKs, the
 * cascades and row level security of the new tables are the ones the migration claims.
 *
 * Skipped unless `STUDIO_JOBS_TEST_DATABASE_URL` names a database that `npm run migrate` has been applied to AND that is on this machine
 * (localhost, 127.0.0.1 or ::1: a hostname anywhere else is refused, so a pasted production URL cannot be used by mistake). Every row is
 * inserted inside one transaction that is ROLLED BACK, so nothing stays even in a scratch database.
 *
 *   STUDIO_JOBS_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/scratch npm test
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import pg from 'pg';
import { CLAIM_SQL, MAX_ATTEMPTS, STALE_CLAIM_MINUTES, STUDIO_JOB_KINDS } from './jobs.js';

const URL_ENV = process.env.STUDIO_JOBS_TEST_DATABASE_URL;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function skipReason(): string | false {
    if (!URL_ENV) return 'set STUDIO_JOBS_TEST_DATABASE_URL to a local, migrated Postgres to run the claim and the v59 tables for real';
    let host = '';
    try { host = new URL(URL_ENV).hostname; } catch { return 'STUDIO_JOBS_TEST_DATABASE_URL is not a URL'; }
    return LOCAL_HOSTS.has(host) ? false : `STUDIO_JOBS_TEST_DATABASE_URL points at ${host}: this test only runs against a database on this machine`;
}

/** The rank each kind is claimed at, by hand: the order of the ORDER BY in `CLAIM_SQL`. */
const RANK: Record<string, number> = {
    pick_folder: 0,
    render_carousel: 1, monteur_think: 1, render_infographic: 1, ads_think: 1, explainer_write: 1,
    monteur_render: 2, explainer_voice: 2, explainer_render: 2,
    scan_library: 3, monteur_scan: 3, explainer_draw: 3,
    index_lesson: 4, monteur_transcribe: 4,
};

/** Runs `fn` on a connection inside a transaction that is rolled back, with two tenants made for it. */
async function inRolledBackTransaction(fn: (db: Db) => Promise<void>): Promise<void> {
    const client = new pg.Client({ connectionString: URL_ENV });
    await client.connect();
    try {
        await client.query('BEGIN');
        const A = randomUUID();
        const B = randomUUID();
        await client.query('INSERT INTO creators (id, name) VALUES ($1, $2), ($3, $4)', [A, 'Studio jobs test A', B, 'Studio jobs test B']);

        /** One job. `delayMin` moves `not_before` from now (negative: in the past); `createdAgoMin` orders jobs of one rank; a claimed job says how long ago it last reported. */
        const job = async (tenant: string, kind: string, over: { status?: string; attempts?: number; delayMin?: number | null; createdAgoMin?: number; heartbeatAgoMin?: number } = {}): Promise<string> => {
            const id = randomUUID();
            const claimed = (over.status ?? 'pending') === 'claimed';
            await client.query(
                `INSERT INTO studio_jobs (id, creator_id, kind, payload, status, attempts, claimed_at, heartbeat_at, created_at, not_before)
                 VALUES ($1, $2, $3, '{}'::jsonb, $4, $5,
                         CASE WHEN $6::boolean THEN NOW() - make_interval(mins => $7::int) END,
                         CASE WHEN $6::boolean THEN NOW() - make_interval(mins => $7::int) END,
                         NOW() - make_interval(mins => $8::int),
                         COALESCE(NOW() + make_interval(mins => $9::int), NOW()))`,
                [id, tenant, kind, over.status ?? 'pending', over.attempts ?? 0, claimed, over.heartbeatAgoMin ?? 0, over.createdAgoMin ?? 0, over.delayMin ?? null]
            );
            return id;
        };
        const claim = async (tenant: string, kinds: readonly string[] | null = null): Promise<{ id: string; kind: string; attempts: number } | null> => {
            const { rows } = await client.query(CLAIM_SQL, [tenant, STALE_CLAIM_MINUTES, MAX_ATTEMPTS, kinds ? [...kinds] : null]);
            return rows[0] ?? null;
        };
        /** A statement Postgres must refuse with `code`: tried under a savepoint, so the transaction goes on. */
        const refused = async (sql: string, params: unknown[], code = '23514'): Promise<void> => {
            await client.query('SAVEPOINT attempt');
            let accepted = false;
            try {
                await client.query(sql, params);
                accepted = true;
            } catch (err) {
                assert.equal((err as { code?: string }).code, code, `${sql} → ${(err as Error).message}`);
            } finally {
                await client.query('ROLLBACK TO SAVEPOINT attempt');
            }
            assert.equal(accepted, false, `accepted, and it must not be: ${sql}`);
        };
        await fn({ client, A, B, job, claim, refused });
    } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
    }
}

interface Db {
    client: pg.Client;
    A: string;
    B: string;
    job: (tenant: string, kind: string, over?: { status?: string; attempts?: number; delayMin?: number | null; createdAgoMin?: number; heartbeatAgoMin?: number }) => Promise<string>;
    claim: (tenant: string, kinds?: readonly string[] | null) => Promise<{ id: string; kind: string; attempts: number } | null>;
    refused: (sql: string, params: unknown[], code?: string) => Promise<void>;
}

describe('the claim on a real Postgres (not_before, v59)', { skip: skipReason() }, () => {
    it('skips a pending job with a future not_before, and takes it once it is due', async () => {
        await inRolledBackTransaction(async ({ client, A, job, claim }) => {
            const delayed = await job(A, 'explainer_draw', { delayMin: 60 });
            assert.equal(await claim(A), null, 'not due: nothing to claim');

            // The clock passes: the hour the allowance resets.
            await client.query(`UPDATE studio_jobs SET not_before = NOW() - INTERVAL '1 second' WHERE id = $1`, [delayed]);
            const got = await claim(A);
            assert.equal(got?.id, delayed);
            assert.equal(got?.kind, 'explainer_draw');
            assert.equal(got?.attempts, 1);
            const { rows } = await client.query('SELECT status, claimed_at IS NOT NULL AS claimed FROM studio_jobs WHERE id = $1', [delayed]);
            assert.deepEqual(rows[0], { status: 'claimed', claimed: true });
            assert.equal(await claim(A), null, 'and a claimed job is not handed out twice');
        });
    });

    it('does not let a delayed job hold back a due one, however old the delayed one is', async () => {
        await inRolledBackTransaction(async ({ A, job, claim }) => {
            const delayed = await job(A, 'explainer_write', { delayMin: 30, createdAgoMin: 500 });
            const due = await job(A, 'monteur_render', { createdAgoMin: 1 });
            assert.equal((await claim(A))?.id, due, 'the due job, though the delayed one has the better rank and is older');
            assert.equal(await claim(A), null);
            assert.notEqual(delayed, due);
        });
    });

    it('takes a job queued with no not_before at once: the default is the moment it was queued, so every other kind is unaffected', async () => {
        await inRolledBackTransaction(async ({ client, A, job, claim }) => {
            const id = await job(A, 'monteur_scan');
            const { rows } = await client.query('SELECT not_before <= NOW() AS due FROM studio_jobs WHERE id = $1', [id]);
            assert.equal(rows[0].due, true);
            assert.equal((await claim(A))?.id, id);
        });
    });

    it('claims every kind the queue knows, in rank order, oldest first within a rank, one job per claim', async () => {
        await inRolledBackTransaction(async ({ A, job, claim }) => {
            assert.deepEqual([...STUDIO_JOB_KINDS].sort(), Object.keys(RANK).sort(), 'the rank table of this test knows every kind');
            // Created in a scrambled order, 1 minute apart, so that rank and age are both what decides.
            const kinds = [...STUDIO_JOB_KINDS].reverse();
            for (const [i, kind] of kinds.entries()) await job(A, kind, { createdAgoMin: 100 - i });
            const claimed: string[] = [];
            for (let i = 0; i < kinds.length; i++) {
                const got = await claim(A);
                assert.ok(got, `claim ${i + 1} of ${kinds.length}`);
                claimed.push(got!.kind);
            }
            assert.equal(await claim(A), null);
            assert.deepEqual(claimed.map((kind) => RANK[kind]), [...claimed.map((kind) => RANK[kind]!)].sort((a, b) => a! - b!), `in rank order: ${claimed.join(', ')}`);
            assert.deepEqual(new Set(claimed), new Set(kinds), 'each kind once');
            // Within one rank the older job comes first: the kinds were created in reverse, so a later entry of `kinds` is younger.
            for (const rank of [1, 2, 3, 4]) {
                const inRank = claimed.filter((kind) => RANK[kind] === rank);
                assert.deepEqual(inRank, kinds.filter((kind) => RANK[kind] === rank), `rank ${rank}, oldest first`);
            }
            assert.equal(claimed[0], 'pick_folder');
            assert.equal(claimed.indexOf('explainer_write') < claimed.indexOf('explainer_voice'), true);
            assert.equal(claimed.indexOf('explainer_voice') < claimed.indexOf('explainer_draw'), true);
        });
    });

    it('reclaims a claim gone stale whatever its not_before says: that clock is for jobs nobody has started', async () => {
        await inRolledBackTransaction(async ({ A, job, claim }) => {
            const stale = await job(A, 'explainer_voice', { status: 'claimed', attempts: 1, heartbeatAgoMin: STALE_CLAIM_MINUTES + 5, delayMin: 600 });
            const got = await claim(A);
            assert.equal(got?.id, stale);
            assert.equal(got?.attempts, 2);
        });
    });

    it('leaves a claim alone while its worker is reporting, and one that has used its claims', async () => {
        await inRolledBackTransaction(async ({ A, job, claim }) => {
            await job(A, 'explainer_render', { status: 'claimed', attempts: 1, heartbeatAgoMin: 1 });
            await job(A, 'explainer_render', { status: 'claimed', attempts: MAX_ATTEMPTS, heartbeatAgoMin: STALE_CLAIM_MINUTES + 5 });
            assert.equal(await claim(A), null);
        });
    });

    it('only ever claims the worker’s own tenant', async () => {
        await inRolledBackTransaction(async ({ A, B, job, claim }) => {
            const theirs = await job(B, 'explainer_draw');
            assert.equal(await claim(A), null);
            assert.equal((await claim(B))?.id, theirs);
        });
    });

    it('narrows the claim to the kinds asked for', async () => {
        await inRolledBackTransaction(async ({ A, job, claim }) => {
            await job(A, 'render_carousel');
            const voice = await job(A, 'explainer_voice');
            assert.equal((await claim(A, ['explainer_voice', 'explainer_draw']))?.id, voice);
            assert.equal(await claim(A, ['explainer_voice', 'explainer_draw']), null);
        });
    });
});

describe('the tables of migration v59 on a real Postgres', { skip: skipReason() }, () => {
    it('accepts the four explainer kinds and refuses a kind nobody knows', async () => {
        await inRolledBackTransaction(async ({ A, job, refused }) => {
            for (const kind of ['explainer_write', 'explainer_voice', 'explainer_draw', 'explainer_render']) await job(A, kind);
            await refused(`INSERT INTO studio_jobs (creator_id, kind, payload) VALUES ($1, 'explainer_dance', '{}'::jsonb)`, [A]);
        });
    });

    it('gives a new explainer its defaults, and closes the vocabularies', async () => {
        await inRolledBackTransaction(async ({ client, A, refused }) => {
            const insert = `INSERT INTO explainers (creator_id, status, topic, length_tier, sound_mode) VALUES ($1, 'writing', 'Why AI makes things up', 'short', 'sfx') RETURNING *`;
            const { rows } = await client.query(insert, [A]);
            assert.deepEqual(
                { language: rows[0].language, subtitles: rows[0].subtitles, source_links: rows[0].source_links, draft_version: rows[0].draft_version, failed_step: rows[0].failed_step, job_id: rows[0].job_id },
                { language: 'ar', subtitles: true, source_links: [], draft_version: 0, failed_step: null, job_id: null }
            );
            for (const [column, bad] of [['status', 'done'], ['language', 'fr'], ['length_tier', 'epic'], ['sound_mode', 'silence']] as const) {
                const values: Record<string, string> = { status: 'writing', language: 'ar', length_tier: 'short', sound_mode: 'sfx', [column]: bad };
                await refused(
                    `INSERT INTO explainers (creator_id, status, topic, length_tier, sound_mode, language) VALUES ($1, $2, 'topic', $3, $4, $5)`,
                    [A, values.status, values.length_tier, values.sound_mode, values.language]
                );
            }
            await refused(`INSERT INTO explainers (creator_id, status, topic, length_tier, sound_mode) VALUES ($1, 'writing', NULL, 'short', 'sfx')`, [A], '23502');
        });
    });

    it('a failure names its step, and only a failure does', async () => {
        await inRolledBackTransaction(async ({ client, A, refused }) => {
            const base = `INSERT INTO explainers (creator_id, status, failed_step, topic, length_tier, sound_mode) VALUES ($1, $2, $3, 'topic', 'short', 'sfx')`;
            await client.query(base, [A, 'failed', 'voice']);
            await client.query(base, [A, 'drawing', null]);
            await refused(base, [A, 'failed', null]);
            await refused(base, [A, 'drawing', 'draw']);
            await refused(base, [A, 'failed', 'dance']);
        });
    });

    it('keeps an explainer’s scenes with it: ordered, defaulted, cascaded, and timed in pairs', async () => {
        await inRolledBackTransaction(async ({ client, A, refused }) => {
            const { rows } = await client.query(
                `INSERT INTO explainers (creator_id, status, topic, length_tier, sound_mode) VALUES ($1, 'draft', 'topic', 'short', 'sfx') RETURNING id`, [A]
            );
            const explainer = rows[0].id as string;
            const scene = (position: number, start: number | null, end: number | null, status = 'pending') => client.query(
                `INSERT INTO explainer_scenes (explainer_id, creator_id, position, narration, spoken, brief, start_s, end_s, draw_status) VALUES ($1, $2, $3, 'n', 's', 'b', $4, $5, $6) RETURNING *`,
                [explainer, A, position, start, end, status]
            );
            const first = (await scene(0, null, null)).rows[0];
            assert.deepEqual(
                { label: first.label, characters: first.characters, continues: first.continues, pictures: first.pictures, draw_status: first.draw_status, draw_attempts: first.draw_attempts },
                { label: '', characters: [], continues: false, pictures: [], draw_status: 'pending', draw_attempts: 0 }
            );
            await scene(1, 0, 3.2);
            await scene(2, 3.2, 9);
            const insert = `INSERT INTO explainer_scenes (explainer_id, creator_id, position, narration, spoken, brief, start_s, end_s) VALUES ($1, $2, 9, 'n', 's', 'b', $3, $4)`;
            await refused(insert, [explainer, A, 5, 5]);
            await refused(insert, [explainer, A, 6, 5]);
            await refused(insert, [explainer, A, 1, null]);
            await refused(insert, [explainer, A, null, 4]);
            await refused(insert, [explainer, A, -1, 4]);
            for (const bad of ['done?', 'skip']) await refused(`INSERT INTO explainer_scenes (explainer_id, creator_id, position, narration, spoken, brief, draw_status) VALUES ($1, $2, 9, 'n', 's', 'b', $3)`, [explainer, A, bad]);
            await client.query(`INSERT INTO explainer_scenes (explainer_id, creator_id, position, narration, spoken, brief, draw_status) VALUES ($1, $2, 9, 'n', 's', 'b', 'skipped')`, [explainer, A]);

            const ordered = await client.query('SELECT position FROM explainer_scenes WHERE explainer_id = $1 ORDER BY position', [explainer]);
            assert.deepEqual(ordered.rows.map((r) => r.position), [0, 1, 2, 9]);
            await client.query('DELETE FROM explainers WHERE id = $1', [explainer]);
            const left = await client.query('SELECT COUNT(*)::int AS n FROM explainer_scenes WHERE explainer_id = $1', [explainer]);
            assert.equal(left.rows[0].n, 0, 'a scene does not outlive its explainer');
            await refused(`INSERT INTO explainer_scenes (explainer_id, creator_id, position, narration, spoken, brief) VALUES ($1, $2, 0, 'n', 's', 'b')`, [randomUUID(), A], '23503');
        });
    });

    it('takes an explainer and its scenes with the tenant that owns them', async () => {
        await inRolledBackTransaction(async ({ client, B }) => {
            const { rows } = await client.query(
                `INSERT INTO explainers (creator_id, status, topic, length_tier, sound_mode) VALUES ($1, 'draft', 'topic', 'short', 'sfx') RETURNING id`, [B]
            );
            await client.query(`INSERT INTO explainer_scenes (explainer_id, creator_id, position, narration, spoken, brief) VALUES ($1, $2, 0, 'n', 's', 'b')`, [rows[0].id, B]);
            await client.query('DELETE FROM creators WHERE id = $1', [B]);
            const left = await client.query('SELECT (SELECT COUNT(*) FROM explainers WHERE id = $1)::int AS explainers, (SELECT COUNT(*) FROM explainer_scenes WHERE explainer_id = $1)::int AS scenes', [rows[0].id]);
            assert.deepEqual(left.rows[0], { explainers: 0, scenes: 0 });
        });
    });

    it('counts the allowance per provider and day, once: the pair is the key', async () => {
        await inRolledBackTransaction(async ({ client, refused }) => {
            const { rows } = await client.query(`INSERT INTO image_allowance (provider, day) VALUES ('cloudflare', '2026-10-25') RETURNING *`);
            assert.deepEqual({ units: rows[0].units, pictures: rows[0].pictures, exhausted_at: rows[0].exhausted_at }, { units: '0', pictures: 0, exhausted_at: null });
            await client.query(`INSERT INTO image_allowance (provider, day, units, pictures) VALUES ('cloudflare', '2026-10-26', 110, 1), ('other', '2026-10-25', 5, 1)`);
            await refused(`INSERT INTO image_allowance (provider, day) VALUES ('cloudflare', '2026-10-25')`, [], '23505');
            await client.query(
                `INSERT INTO image_allowance (provider, day, units, pictures) VALUES ('cloudflare', '2026-10-26', 110, 1)
                 ON CONFLICT (provider, day) DO UPDATE SET units = image_allowance.units + EXCLUDED.units, pictures = image_allowance.pictures + EXCLUDED.pictures`
            );
            const day = await client.query(`SELECT units::float8 AS units, pictures FROM image_allowance WHERE provider = 'cloudflare' AND day = '2026-10-26'`);
            assert.deepEqual(day.rows[0], { units: 220, pictures: 2 });
        });
    });

    it('holds the settings section as an empty object until it is saved', async () => {
        await inRolledBackTransaction(async ({ client, A }) => {
            const { rows } = await client.query(
                `INSERT INTO studio_settings (creator_id, brand, voice, product, cta, schedule, library) VALUES ($1, '{}', '{}', '{}', '{}', '{}', '{}') RETURNING explainer`, [A]
            );
            assert.deepEqual(rows[0].explainer, {});
        });
    });

    it('has row level security on, deny-by-default, on each of the three tables', async () => {
        await inRolledBackTransaction(async ({ client }) => {
            const { rows } = await client.query(
                `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('explainers', 'explainer_scenes', 'image_allowance') AND relkind = 'r' ORDER BY relname`
            );
            assert.deepEqual(rows, [
                { relname: 'explainer_scenes', relrowsecurity: true }, { relname: 'explainers', relrowsecurity: true }, { relname: 'image_allowance', relrowsecurity: true },
            ]);
        });
    });
});
