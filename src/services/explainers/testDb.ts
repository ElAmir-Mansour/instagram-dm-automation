/**
 * Tests only: a small database for the tests of illustrated explainers. `installFakeDb` (monteur/testDb.ts) records every statement and answers by pattern;
 * this adds what a lifecycle test needs on top of it: the `explainers`, `explainer_scenes` and `studio_jobs` tables as rows that change, so a test can say
 * "approve it, then voice it, then draw it" and read the explainer back, and a transaction that rolls back gives its rows back.
 *
 * It answers exactly the statements the code emits, by their text. It is not SQL: a statement the code gains must be taught here, and a test that finds
 * "unexpected statement" has found a new one. What it cannot say (that the SQL is valid Postgres) is checked against a real database by hand, never in CI.
 */
import type { ExplainerRow, ExplainerSceneRow, StudioJobKind } from '../../db/rows.js';
import { installFakeDb, type FakeDb, type Route } from '../monteur/testDb.js';
import { defaultExplainerConfig } from '../studio/settingsTypes.js';
import { EXPLAINER, explainerRow, sceneRow, TENANT } from './testFixtures.js';

export interface FakeJob {
    id: string;
    creator_id: string;
    kind: StudioJobKind;
    status: 'pending' | 'claimed' | 'done' | 'failed';
    payload: any;
    progress: string | null;
    attempts: number;
    not_before: Date;
    claimed_at: Date | null;
    heartbeat_at: Date | null;
    result: unknown;
    error: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface FakeUpload {
    id: string;
    creator_id: string;
    mime_type: string;
    storage_path: string | null;
}

/** A `studio_workers` row: the Mac's credential, with when it was last heard from and whether it was revoked. */
export interface FakeWorker {
    id: string;
    creator_id: string;
    name: string;
    last_seen_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
}

export interface World {
    db: FakeDb;
    /** The clock the database's NOW() reads. */
    now: Date;
    explainers: Map<string, ExplainerRow>;
    scenes: ExplainerSceneRow[];
    jobs: FakeJob[];
    uploads: Map<string, FakeUpload>;
    /** The `scheduled_posts` rows `insertVideoPost` wrote, as the statement returns them. */
    posts: Record<string, any>[];
    /** The `audit_log` rows written, with `detail` parsed. */
    audit: { actor_email: string | null; action: string; target_type: string | null; target_id: string | null; detail: Record<string, unknown> }[];
    /** `media_uploads` ids that `deleteUnreferencedUploads` was asked to delete, per call. */
    deletedUploads: string[][];
    /** The ids a `scheduled_posts` row (or anything else the real statement guards on) still names: never deleted. */
    keptUploads: Set<string>;
    /** The stored `studio_settings` row of the tenant (sections only; the rest is the defaults), or null for none. */
    settingsRow: Record<string, unknown> | null;
    appSettings: Map<string, string>;
    /** The tenant's one live worker, as a date: when it was last seen (null for none). A shorthand for `addWorker({ last_seen_at })`. */
    workerLastSeen: Date | null;
    /** The `studio_workers` rows, live and revoked: what the status card and the takeover's "is the Mac up" read. */
    workers: FakeWorker[];
    /** A new job id, or explainer id: UUIDs that count up, so what a test reads is readable. */
    uuid(): string;
    addExplainer(over?: Partial<ExplainerRow>): ExplainerRow;
    /** `n` scenes for an explainer, 0-based, with the fields of `sceneRow` and any override per position. */
    addScenes(n: number, over?: (position: number) => Partial<ExplainerSceneRow>, explainerId?: string): ExplainerSceneRow[];
    addJob(over?: Partial<FakeJob>): FakeJob;
    addWorker(over?: Partial<FakeWorker>): FakeWorker;
    /** The statements run, as `{ sql, params }`, matching a pattern. */
    ran(pattern: RegExp): { sql: string; params: any[] }[];
    jobsOf(kind: StudioJobKind): FakeJob[];
    explainer(id?: string): ExplainerRow;
    sceneRows(id?: string): ExplainerSceneRow[];
    restore(): void;
}

const BASE = 'https://msg-response-auto.vercel.app';

/** The recordset a statement carries as its third parameter, parsed. */
const recordset = (param: unknown): any[] => JSON.parse(String(param));

export function installWorld(opts: { tenant?: string; owner?: string | null } = {}): World {
    const tenant = opts.tenant ?? TENANT;
    // The Mac works for the owner with nothing configured (macBrain.ts), so the tenant of these tests is the platform owner.
    const db = installFakeDb(opts.owner === null ? {} : { platformTenant: opts.owner ?? tenant });
    let counter = 0;
    const world: World = {
        db,
        now: new Date('2026-10-25T12:00:00.000Z'),
        explainers: new Map<string, ExplainerRow>(),
        scenes: [] as ExplainerSceneRow[],
        jobs: [] as FakeJob[],
        posts: [] as Record<string, any>[],
        audit: [] as World['audit'],
        uploads: new Map<string, FakeUpload>(),
        deletedUploads: [] as string[][],
        keptUploads: new Set<string>(),
        settingsRow: null as Record<string, unknown> | null,
        appSettings: new Map<string, string>([['app.public_base_url', BASE]]),
        workerLastSeen: null as Date | null,
        workers: [] as FakeWorker[],
        uuid: () => `99999999-9999-4999-8999-${String(++counter).padStart(12, '0')}`,
        addExplainer(over: Partial<ExplainerRow> = {}) {
            const row = explainerRow({ creator_id: tenant, id: over.id ?? EXPLAINER, created_at: world.now, updated_at: world.now, ...over });
            world.explainers.set(row.id, row);
            return row;
        },
        addScenes(n: number, over: (position: number) => Partial<ExplainerSceneRow> = () => ({}), explainerId: string = EXPLAINER) {
            const made = Array.from({ length: n }, (_, i) => sceneRow(i, { creator_id: tenant, explainer_id: explainerId, ...over(i) }));
            world.scenes.push(...made);
            return made;
        },
        addWorker(over: Partial<FakeWorker> = {}) {
            const worker: FakeWorker = { id: world.uuid(), creator_id: tenant, name: 'Mac', last_seen_at: world.now, revoked_at: null, created_at: world.now, ...over };
            world.workers.push(worker);
            return worker;
        },
        addJob(over: Partial<FakeJob> = {}) {
            const job: FakeJob = {
                id: world.uuid(), creator_id: tenant, kind: 'explainer_write', status: 'pending', payload: {}, progress: null, attempts: 0, not_before: world.now, claimed_at: null,
                heartbeat_at: null, result: null, error: null, created_at: world.now, updated_at: world.now, ...over,
            };
            world.jobs.push(job);
            return job;
        },
        ran: (pattern: RegExp) => db.ran(pattern),
        jobsOf: (kind: StudioJobKind) => world.jobs.filter((j) => j.kind === kind),
        explainer: (id: string = EXPLAINER) => {
            const row = world.explainers.get(id);
            if (!row) throw new Error(`no explainer ${id} in the world`);
            return row;
        },
        sceneRows: (id: string = EXPLAINER) => world.scenes.filter((s) => s.explainer_id === id).sort((a, b) => a.position - b.position),
        restore: () => db.restore(),
    };

    // ── Transactions: BEGIN takes a snapshot, ROLLBACK gives it back ──
    const snapshots: { explainers: Map<string, ExplainerRow>; scenes: ExplainerSceneRow[]; jobs: FakeJob[]; posts: Record<string, any>[] }[] = [];
    const clone = <T>(value: T): T => structuredClone(value);

    const jobView = (job: FakeJob) => ({
        id: job.id, kind: job.kind, status: job.status, payload: job.payload, progress: job.progress, attempts: job.attempts, error: job.error, claimed_at: job.claimed_at,
        heartbeat_at: job.heartbeat_at, created_at: job.created_at, updated_at: job.updated_at,
    });
    const sceneOut = (s: ExplainerSceneRow) => ({ ...s });
    const touch = (row: ExplainerRow) => { row.updated_at = world.now; };

    /** `col = $n`, `col = $n::jsonb`, `col = NULL` and `updated_at = NOW()` pairs, applied to a row. */
    function applySets(row: ExplainerRow, sets: string, params: any[]): void {
        for (const part of sets.split(', ')) {
            const bound = /^(\w+) = \$(\d+)(::jsonb)?$/.exec(part);
            if (bound) {
                const [, column, n, cast] = bound;
                const value = params[Number(n) - 1];
                (row as any)[column!] = cast && typeof value === 'string' ? JSON.parse(value) : value;
            } else if (/^(\w+) = NULL$/.test(part)) {
                (row as any)[/^(\w+)/.exec(part)![1]!] = null;
            } else if (part === 'updated_at = NOW()') {
                touch(row);
            } else {
                throw new Error(`explainers/testDb: cannot read the SET item "${part}"`);
            }
        }
    }

    const routes: Route[] = [
        // transactions
        [/^BEGIN$/, () => { snapshots.push({ explainers: clone(world.explainers), scenes: clone(world.scenes), jobs: clone(world.jobs), posts: clone(world.posts) }); return { rows: [] }; }],
        [/^COMMIT$/, () => { snapshots.pop(); return { rows: [] }; }],
        [/^ROLLBACK$/, () => {
            const snapshot = snapshots.pop();
            if (snapshot) {
                world.explainers.clear();
                for (const [id, row] of snapshot.explainers) world.explainers.set(id, row);
                world.scenes.splice(0, world.scenes.length, ...snapshot.scenes);
                world.jobs.splice(0, world.jobs.length, ...snapshot.jobs);
                world.posts.splice(0, world.posts.length, ...snapshot.posts);
            }
            return { rows: [] };
        }],

        // explainers: locks and reads
        [/^SELECT \* FROM explainers WHERE id = \$1 AND creator_id = \$2( FOR UPDATE)?$/, (p) => {
            const row = world.explainers.get(p[0]);
            return { rows: row && row.creator_id === p[1] ? [row] : [] };
        }],
        [/^SELECT \* FROM explainers WHERE id = \$1 AND \(\$2::uuid IS NULL OR creator_id = \$2\) FOR UPDATE$/, (p) => {
            const row = world.explainers.get(p[0]);
            return { rows: row && (p[1] === null || row.creator_id === p[1]) ? [row] : [] };
        }],
        [/^SELECT e\.\*, j\.status AS job_status, j\.progress AS job_progress, j\.not_before AS job_not_before, j\.created_at AS job_created_at FROM explainers e/, (p) => {
            const row = world.explainers.get(p[0]);
            if (!row || row.creator_id !== p[1]) return { rows: [] };
            const job = row.job_id ? world.jobs.find((j) => j.id === row.job_id && j.creator_id === row.creator_id) : undefined;
            return { rows: [{ ...row, job_status: job?.status ?? null, job_progress: job?.progress ?? null, job_not_before: job?.not_before ?? null, job_created_at: job?.created_at ?? null }] };
        }],
        [/^SELECT e\.id, e\.status, e\.title, e\.topic, e\.language, e\.length_tier, \(e\.draft->>'est_seconds'\)::float8 AS est_seconds/, (p) => ({
            rows: [...world.explainers.values()].filter((e) => e.creator_id === p[0]).sort((a, b) => +b.created_at - +a.created_at).map((e) => {
                const scenes = world.sceneRows(e.id);
                return {
                    id: e.id, status: e.status, title: e.title, topic: e.topic, language: e.language, length_tier: e.length_tier, est_seconds: e.draft?.est_seconds ?? null,
                    updated_at: e.updated_at, thumb_url: scenes.find((s) => s.position === 0)?.picture?.url ?? null,
                    drawn: e.status === 'drawing' ? scenes.filter((s) => s.draw_status === 'done').length : null, total: e.status === 'drawing' ? scenes.length : null,
                };
            }),
        })],
        [/^SELECT id, creator_id FROM explainers WHERE status = 'writing' OR \(status = 'failed' AND failed_step = 'write'\) ORDER BY updated_at LIMIT \$1$/, (p) => ({
            rows: [...world.explainers.values()].filter((e) => e.status === 'writing' || (e.status === 'failed' && e.failed_step === 'write')).slice(0, p[0]).map((e) => ({ id: e.id, creator_id: e.creator_id })),
        })],

        // explainers: writes
        [/^INSERT INTO explainers \(creator_id, status, topic, language, length_tier, sound_mode, music_track_id, subtitles, notes, source_links\) VALUES \(\$1, 'writing', \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9::jsonb\) RETURNING \*$/, (p) => {
            const row = explainerRow({
                id: world.uuid(), creator_id: p[0], status: 'writing', topic: p[1], language: p[2], length_tier: p[3], sound_mode: p[4], music_track_id: p[5], subtitles: p[6], notes: p[7],
                source_links: JSON.parse(p[8]), title: null, draft: null, draft_version: 0, created_at: world.now, updated_at: world.now,
            });
            world.explainers.set(row.id, row);
            return { rows: [row] };
        }],
        [/^UPDATE explainers SET (.+) WHERE id = \$1 RETURNING \*$/, (p, sql) => {
            const row = world.explainers.get(p[0]);
            if (!row) return { rows: [] };
            applySets(row, /^UPDATE explainers SET (.+) WHERE id = \$1 RETURNING \*$/.exec(sql)![1]!, p);
            return { rows: [row] };
        }],
        [/^UPDATE explainers SET (.+) WHERE id = \$1 AND creator_id = \$2 RETURNING \*$/, (p, sql) => {
            const row = world.explainers.get(p[0]);
            if (!row || row.creator_id !== p[1]) return { rows: [] };
            applySets(row, /^UPDATE explainers SET (.+) WHERE id = \$1 AND creator_id = \$2 RETURNING \*$/.exec(sql)![1]!, p);
            return { rows: [row] };
        }],
        [/^UPDATE explainers SET draw_paused_until = NULL, error = NULL, updated_at = NOW\(\) WHERE id = \$1 AND creator_id = \$2 AND status = 'drawing' AND job_id = \$3 AND \(draw_paused_until IS NOT NULL OR error IS NOT NULL\)$/, (p) => {
            const row = world.explainers.get(p[0]);
            if (!row || row.creator_id !== p[1] || row.status !== 'drawing' || row.job_id !== p[2] || (row.draw_paused_until === null && row.error === null)) return { rows: [], rowCount: 0 };
            Object.assign(row, { draw_paused_until: null, error: null });
            touch(row);
            return { rows: [], rowCount: 1 };
        }],
        [/^DELETE FROM explainers WHERE id = \$1 AND creator_id = \$2$/, (p) => {
            const row = world.explainers.get(p[0]);
            if (!row || row.creator_id !== p[1]) return { rows: [], rowCount: 0 };
            world.explainers.delete(p[0]);
            world.scenes.splice(0, world.scenes.length, ...world.scenes.filter((s) => s.explainer_id !== p[0]));
            return { rows: [], rowCount: 1 };
        }],

        // scenes
        [/^SELECT id, explainer_id, creator_id, position, narration, spoken, label, brief, characters, continues, start_s::float8 AS start_s, end_s::float8 AS end_s, picture, pictures, draw_status, draw_error, draw_note, draw_attempts, updated_at FROM explainer_scenes WHERE explainer_id = \$1 AND creator_id = \$2 ORDER BY position( FOR UPDATE)?$/, (p) => ({
            rows: world.scenes.filter((s) => s.explainer_id === p[0] && s.creator_id === p[1]).sort((a, b) => a.position - b.position).map(sceneOut),
        })],
        [/^DELETE FROM explainer_scenes WHERE explainer_id = \$1 AND creator_id = \$2$/, (p) => {
            const before = world.scenes.length;
            world.scenes.splice(0, world.scenes.length, ...world.scenes.filter((s) => !(s.explainer_id === p[0] && s.creator_id === p[1])));
            return { rows: [], rowCount: before - world.scenes.length };
        }],
        [/^INSERT INTO explainer_scenes \(explainer_id, creator_id, position, narration, spoken, label, brief, characters, continues\) SELECT /, (p) => {
            for (const r of recordset(p[2])) {
                world.scenes.push(sceneRow(r.position, {
                    id: world.uuid(), explainer_id: p[0], creator_id: p[1], narration: r.narration, spoken: r.spoken, label: r.label, brief: r.brief, characters: r.characters, continues: r.continues,
                }));
            }
            return { rows: [] };
        }],
        [/^UPDATE explainer_scenes s SET narration = x\.narration, spoken = x\.spoken, label = x\.label, brief = x\.brief, characters = ARRAY\(/, (p) => {
            for (const r of recordset(p[2])) {
                const scene = world.scenes.find((s) => s.explainer_id === p[0] && s.creator_id === p[1] && s.position === r.position);
                if (scene) Object.assign(scene, { narration: r.narration, spoken: r.spoken, label: r.label, brief: r.brief, characters: r.characters, continues: r.continues, updated_at: world.now });
            }
            return { rows: [] };
        }],
        [/^UPDATE explainer_scenes s SET start_s = x\.start, end_s = x\."end", updated_at = NOW\(\) FROM jsonb_to_recordset/, (p) => {
            for (const r of recordset(p[2])) {
                const scene = world.scenes.find((s) => s.explainer_id === p[0] && s.creator_id === p[1] && s.position === r.position);
                if (scene) {
                    if (!(r.end > r.start)) throw new Error('explainer_scenes_times_check');
                    Object.assign(scene, { start_s: r.start, end_s: r.end, updated_at: world.now });
                }
            }
            return { rows: [] };
        }],
        [/^UPDATE explainer_scenes SET draw_status = 'pending', draw_error = NULL, updated_at = NOW\(\) WHERE explainer_id = \$1 AND creator_id = \$2 AND \(draw_status = 'failed'/, (p, sql) => {
            const minutes = /make_interval/.test(sql) ? Number(p[2]) : 0;
            let n = 0;
            for (const scene of world.scenes) {
                if (scene.explainer_id !== p[0] || scene.creator_id !== p[1]) continue;
                const stale = scene.draw_status === 'drawing' && (/make_interval/.test(sql) ? +world.now - +new Date(scene.updated_at) > minutes * 60_000 : true);
                if (scene.draw_status === 'failed' || stale) {
                    Object.assign(scene, { draw_status: 'pending', draw_error: null, updated_at: world.now });
                    n++;
                }
            }
            return { rows: [], rowCount: n };
        }],

        // studio_jobs
        [/^INSERT INTO studio_jobs \(creator_id, kind, payload\) VALUES \(\$1, \$2, \$3::jsonb\) RETURNING /, (p) => {
            const job = world.addJob({ creator_id: p[0], kind: p[1], payload: JSON.parse(p[2]) });
            return { rows: [jobView(job)] };
        }],
        [/^INSERT INTO studio_jobs \(creator_id, kind, payload, not_before\) VALUES \(\$1, \$2, \$3::jsonb, \$4\) RETURNING /, (p) => {
            const job = world.addJob({ creator_id: p[0], kind: p[1], payload: JSON.parse(p[2]), not_before: p[3] });
            return { rows: [jobView(job)] };
        }],
        [/^INSERT INTO studio_jobs \(creator_id, kind, payload, status, attempts, claimed_at, heartbeat_at, progress\) VALUES \(\$1, 'explainer_write', \$2::jsonb, 'claimed', \$3, NOW\(\), NOW\(\), 'Gemini is writing it'\) RETURNING id$/, (p) => {
            const job = world.addJob({
                creator_id: p[0], kind: 'explainer_write', payload: JSON.parse(p[1]), status: 'claimed', attempts: p[2], claimed_at: world.now, heartbeat_at: world.now, progress: 'Gemini is writing it',
            });
            return { rows: [{ id: job.id }] };
        }],
        [/^UPDATE studio_jobs SET status = 'failed', error = \$3,( progress = NULL,)? updated_at = NOW\(\) WHERE id = \$1 AND creator_id = \$2 AND status = 'pending'$/, (p) => {
            const job = world.jobs.find((j) => j.id === p[0] && j.creator_id === p[1] && j.status === 'pending');
            if (!job) return { rows: [], rowCount: 0 };
            Object.assign(job, { status: 'failed', error: p[2], updated_at: world.now });
            return { rows: [], rowCount: 1 };
        }],
        [/^SELECT status, not_before FROM studio_jobs WHERE id = \$1 AND creator_id = \$2 AND kind = 'explainer_draw'$/, (p) => {
            const job = world.jobs.find((j) => j.id === p[0] && j.creator_id === p[1] && j.kind === 'explainer_draw');
            return { rows: job ? [{ status: job.status, not_before: job.not_before }] : [] };
        }],
        [/^SELECT kind, status FROM studio_jobs WHERE id = \$1 AND creator_id = \$2$/, (p) => {
            const job = world.jobs.find((j) => j.id === p[0] && j.creator_id === p[1]);
            return { rows: job ? [{ kind: job.kind, status: job.status }] : [] };
        }],
        [/^SELECT id, kind, status, payload, created_at, heartbeat_at FROM studio_jobs WHERE id = \$1 AND creator_id = \$2$/, (p) => {
            const job = world.jobs.find((j) => j.id === p[0] && j.creator_id === p[1]);
            return { rows: job ? [{ id: job.id, kind: job.kind, status: job.status, payload: job.payload, created_at: job.created_at, heartbeat_at: job.heartbeat_at }] : [] };
        }],
        [/^SELECT id, creator_id, kind, status, payload FROM studio_jobs WHERE id = \$1 AND creator_id = \$2 FOR UPDATE$/, (p) => {
            const job = world.jobs.find((j) => j.id === p[0] && j.creator_id === p[1]);
            return { rows: job ? [{ id: job.id, creator_id: job.creator_id, kind: job.kind, status: job.status, payload: job.payload }] : [] };
        }],
        [/^UPDATE studio_jobs SET status = 'done', result = \$2::jsonb, progress = NULL, error = NULL, updated_at = NOW\(\) WHERE id = \$1$/, (p) => {
            const job = world.jobs.find((j) => j.id === p[0]);
            if (job) Object.assign(job, { status: 'done', result: JSON.parse(p[1]), progress: null, error: null, updated_at: world.now });
            return { rows: [], rowCount: job ? 1 : 0 };
        }],
        [/^UPDATE studio_jobs SET status = 'failed', error = \$2, progress = NULL, updated_at = NOW\(\) WHERE id = \$1$/, (p) => {
            const job = world.jobs.find((j) => j.id === p[0]);
            if (job) Object.assign(job, { status: 'failed', error: p[1], progress: null, updated_at: world.now });
            return { rows: [], rowCount: job ? 1 : 0 };
        }],
        [/^UPDATE studio_jobs SET progress = COALESCE\(\$3, progress\), heartbeat_at = NOW\(\), updated_at = NOW\(\) WHERE id = \$1 AND creator_id = \$2 AND status = 'claimed'$/, (p) => {
            const job = world.jobs.find((j) => j.id === p[0] && j.creator_id === p[1] && j.status === 'claimed');
            if (job) Object.assign(job, { progress: p[2] ?? job.progress, heartbeat_at: world.now, updated_at: world.now });
            return { rows: [], rowCount: job ? 1 : 0 };
        }],
        [/^SELECT CASE WHEN status = 'pending' AND not_before > NOW\(\) THEN 'waiting' ELSE status END AS status, COUNT\(\*\)::int AS n FROM studio_jobs WHERE creator_id = \$1 AND status IN \('pending', 'claimed'\) GROUP BY 1$/, (p) => {
            const counts = new Map<string, number>();
            for (const job of world.jobs) {
                if (job.creator_id !== p[0] || (job.status !== 'pending' && job.status !== 'claimed')) continue;
                const key = job.status === 'pending' && +job.not_before > +world.now ? 'waiting' : job.status;
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            return { rows: [...counts].map(([status, n]) => ({ status, n })) };
        }],

        // scheduled_posts: what `insertVideoPost` writes
        [/^INSERT INTO scheduled_posts \(creator_id, platform, post_type, caption, media_url, media_urls, scheduled_time, status, cover_url, group_id, platform_options, meta_options\) VALUES \(\$1, \$2, 'video', \$3, \$4, NULL, \$5, 'PENDING', \$6, \$7, \$8::jsonb, NULL\) RETURNING \*$/, (p) => {
            const post = {
                id: world.uuid(), creator_id: p[0], platform: p[1], post_type: 'video', caption: p[2], media_url: p[3], media_urls: null, scheduled_time: p[4], status: 'PENDING',
                cover_url: p[5], group_id: p[6], platform_options: p[7] ? JSON.parse(p[7]) : null, meta_options: null,
            };
            world.posts.push(post);
            return { rows: [post] };
        }],

        // the audit log
        [/^INSERT INTO audit_log \(actor_user_id, actor_email, action, target_type, target_id, detail\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb\) RETURNING id$/, (p) => {
            world.audit.push({ actor_email: p[1], action: p[2], target_type: p[3], target_id: p[4], detail: JSON.parse(p[5]) });
            return { rows: [{ id: `audit-${world.audit.length}` }] };
        }],

        // media_uploads
        [/^SELECT id, mime_type, storage_path FROM media_uploads WHERE id = ANY\(\$1::uuid\[\]\) AND creator_id = \$2$/, (p) => ({
            rows: (p[0] as string[]).flatMap((id) => { const u = world.uploads.get(id); return u && u.creator_id === p[1] ? [{ id: u.id, mime_type: u.mime_type, storage_path: u.storage_path }] : []; }),
        })],
        [/^DELETE FROM media_uploads m WHERE m\.id = ANY\(\$2::uuid\[\]\) AND m\.creator_id = \$1 AND NOT EXISTS/, (p) => {
            const ids = (p[1] as string[]).filter((id) => !world.keptUploads.has(id));
            world.deletedUploads.push(ids);
            for (const id of ids) world.uploads.delete(id);
            return { rows: [], rowCount: ids.length };
        }],

        // settings
        [/FROM studio_settings WHERE creator_id = \$1/, () => ({ rows: world.settingsRow ? [world.settingsRow] : [] })],
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: world.appSettings.has(p[0]) ? [{ value: world.appSettings.get(p[0]), is_secret: false }] : [] })],
        // The status card's statement (`workerSummary`), and the takeover's: the most recently seen worker of the tenant that is not revoked. The predicate is in
        // the pattern, so a statement that stopped excluding the revoked ones is "unexpected" here, not answered.
        [/^SELECT name, last_seen_at FROM studio_workers WHERE creator_id = \$1 AND revoked_at IS NULL ORDER BY last_seen_at DESC NULLS LAST, created_at DESC LIMIT 1$/, (p) => {
            const live = world.workers.filter((w) => w.creator_id === p[0] && w.revoked_at === null);
            if (world.workerLastSeen) live.push({ id: 'shorthand', creator_id: p[0], name: 'Mac', last_seen_at: world.workerLastSeen, revoked_at: null, created_at: world.now });
            live.sort((a, b) => (+(b.last_seen_at ?? 0) - +(a.last_seen_at ?? 0)) || (+b.created_at - +a.created_at));
            return { rows: live[0] ? [{ name: live[0].name, last_seen_at: live[0].last_seen_at }] : [] };
        }],
    ];
    db.routes.push(...routes);
    return world;
}

/** A `studio_settings` row whose explainer section is the defaults with these changes (and nothing else stored). */
export function explainerSettings(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { explainer: { ...defaultExplainerConfig(), ...over } };
}

export { BASE };
