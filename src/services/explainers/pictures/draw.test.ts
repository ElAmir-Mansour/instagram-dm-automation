/**
 * Drawing a scene (T047): `drawNext`, the loop's one step; `drawScene`, the owner's draw or redraw of one; `pickPicture`, going back to an earlier
 * picture. The pool answers by SQL through an emulation of `explainer_scenes` that keeps a snapshot at BEGIN and puts it back at ROLLBACK, so what
 * the code does inside a transaction is undone when it throws, as in Postgres. The provider, the media store and the allowance are fakes: nothing
 * here reaches Cloudflare or Supabase.
 *
 * What is pinned, in the lead's words: no connection and no transaction is held across the provider call; the claim and the reservation are one
 * short transaction BEFORE it; the result is a second short one AFTER it; a woman in a brief, a note or a character description is refused before
 * any provider call and any allowance; a scene left `drawing` is claimed again after two minutes; and the chosen picture plus the last three are
 * kept, newest first, with the files that drop out deleted.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../../config/db.js';
import type { ExplainerPicture, ExplainerSceneRow } from '../../../db/rows.js';
import { setLogSink } from '../../../utils/log.js';
import { installFakeDb, type FakeDb } from '../../monteur/testDb.js';
import { setMediaStore, type MediaStore } from '../../storage.js';
import type { ExplainerCharacter } from '../../studio/settingsTypes.js';
import { ExplainerError } from '../errors.js';
import { resumeAt, utcDay } from './allowance.js';
import { clearReferenceCache, drawNext, drawScene, KEPT_HISTORY, pickPicture, STALE_DRAWING_SECONDS } from './draw.js';
import { buildScenePrompt, pictureSeed, SCENE_SIZE } from './prompt.js';
import { setImageProvider, type ImageProvider } from './provider.js';
import {
    exhausted, FakeMediaStore, installAllowanceTable, installSettings, jpegHeader, pngHeader, PNG_1X1, refused, SAVED_PROVIDER, ScriptedProvider,
    type AllowanceTableRow,
} from './testSupport.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const EXPLAINER = '11111111-aaaa-4aaa-8aaa-111111111111';
const MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const STYLE = 'warm hand-painted gouache illustration, beige and terracotta palette';
const REF_KARIM = 'cccccccc-0000-4000-8000-000000000001';
const REF_SAMIR = 'cccccccc-0000-4000-8000-000000000002';

const KARIM: ExplainerCharacter = {
    key: 'karim', name: 'كريم', description: 'a curious young man with a round head, short dark hair, dot eyes, dark green sweater',
    ref_media_id: REF_KARIM, ref_url: `/api/uploads/${REF_KARIM}`, approved_at: '2026-10-25T10:00:00.000Z',
};
const SAMIR: ExplainerCharacter = {
    key: 'samir', name: 'سمير', description: 'an old man with a white beard and round glasses',
    ref_media_id: REF_SAMIR, ref_url: `/api/uploads/${REF_SAMIR}`, approved_at: '2026-10-25T10:00:00.000Z',
};

const sceneId = (position: number): string => `bbbbbbbb-0000-4000-8000-${String(position).padStart(12, '0')}`;
const mediaId = (n: number): string => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;

function scene(position: number, over: Partial<ExplainerSceneRow> = {}): ExplainerSceneRow {
    return {
        id: sceneId(position), explainer_id: EXPLAINER, creator_id: TENANT, position, narration: `Narration ${position}`, spoken: `Spoken ${position}`,
        label: '', brief: `Brief ${position}: a lamp on a desk.`, characters: [], continues: false, start_s: position * 4, end_s: position * 4 + 4,
        picture: null, pictures: [], draw_status: 'pending', draw_error: null, draw_note: null, draw_attempts: 0, updated_at: new Date(), ...over,
    };
}

function picture(n: number): ExplainerPicture {
    return { media_id: mediaId(n), url: `/api/uploads/${mediaId(n)}`, seed: n, provider: 'cloudflare', model: MODEL, prompt_hash: String(n).repeat(64).slice(0, 64), at: '2026-10-25T09:00:00.000Z' };
}

/** What the emulated database holds, and what a test sets up in it. */
interface World {
    scenes: ExplainerSceneRow[];
    explainers: Set<string>;
    look: { style: string; characters: ExplainerCharacter[] };
    /** Upload ids the code deleted from `media_uploads`. */
    deleted: string[];
    /** Claims that are lost to another caller before this one gets its turn (the row goes `drawing` under its feet). */
    loseClaims: number;
    /** Pooled clients checked out right now. */
    held: number;
}

const isStale = (s: ExplainerSceneRow): boolean => s.draw_status === 'drawing' && Date.now() - s.updated_at.getTime() > STALE_DRAWING_SECONDS * 1000;
const isPending = (s: ExplainerSceneRow): boolean => s.draw_status === 'pending' || isStale(s);
const clone = <T>(value: T): T => structuredClone(value);

function installScenes(db: FakeDb, world: World, store: FakeMediaStore): void {
    const snapshots: ExplainerSceneRow[][] = [];
    const mine = (p: unknown[]) => (s: ExplainerSceneRow) => s.explainer_id === p[0] && s.creator_id === p[1];
    const byId = (p: unknown[]) => world.scenes.find((s) => s.id === p[0] && s.explainer_id === p[1] && s.creator_id === p[2]);
    const named = (id: string): boolean => world.scenes.some((s) => JSON.stringify([s.picture, s.pictures]).includes(id));

    db.routes.push(
        [/^BEGIN$/, () => { snapshots.push(clone(world.scenes)); return { rows: [] }; }],
        [/^COMMIT$/, () => { snapshots.pop(); return { rows: [] }; }],
        [/^ROLLBACK$/, () => { const back = snapshots.pop(); if (back) world.scenes = back; return { rows: [] }; }],
        [/^SELECT 1 FROM explainers WHERE id = \$1 AND creator_id = \$2$/, (p) => ({ rows: world.explainers.has(`${p[1]}:${p[0]}`) ? [{ '?column?': 1 }] : [] })],
        [/^SELECT explainer FROM studio_settings WHERE creator_id = \$1$/, () => ({ rows: [{ explainer: world.look }] })],

        // Reading scenes.
        [/^SELECT id, explainer_id, .*, \(draw_status = 'drawing' AND NOT \(updated_at < NOW\(\) - INTERVAL '120 seconds'\)\) AS busy FROM explainer_scenes WHERE explainer_id = \$1 AND creator_id = \$2 AND position = \$3 FOR UPDATE$/, (p) => {
            const found = world.scenes.find((s) => mine(p)(s) && s.position === p[2]);
            return { rows: found ? [{ ...clone(found), busy: found.draw_status === 'drawing' && !isStale(found) }] : [] };
        }],
        [/^SELECT id, explainer_id, .* FROM explainer_scenes WHERE explainer_id = \$1 AND creator_id = \$2 AND \(draw_status = 'pending' OR .* ORDER BY position LIMIT 1$/, (p) => {
            const found = world.scenes.filter(mine(p)).filter(isPending).sort((a, b) => a.position - b.position)[0];
            return { rows: found ? [clone(found)] : [] };
        }],
        [/^SELECT id, explainer_id, .* FROM explainer_scenes WHERE explainer_id = \$1 AND creator_id = \$2 AND position = \$3$/, (p) => {
            const found = world.scenes.find((s) => mine(p)(s) && s.position === p[2]);
            return { rows: found ? [clone(found)] : [] };
        }],
        [/^SELECT count\(\*\)::int AS n FROM explainer_scenes WHERE explainer_id = \$1 AND creator_id = \$2 AND/, (p) => ({
            rows: [{ n: world.scenes.filter(mine(p)).filter(isPending).length }],
        })],
        [/^SELECT id, position, continues FROM explainer_scenes WHERE explainer_id = \$1 AND creator_id = \$2 AND position > \$3 ORDER BY position$/, (p) => ({
            rows: world.scenes.filter(mine(p)).filter((s) => s.position > (p[2] as number)).sort((a, b) => a.position - b.position).map((s) => ({ id: s.id, position: s.position, continues: s.continues })),
        })],
        [/^SELECT picture, pictures FROM explainer_scenes WHERE id = ANY\(\$1::uuid\[\]\) AND explainer_id = \$2 AND creator_id = \$3 FOR UPDATE$/, (p) => ({
            rows: world.scenes.filter((s) => (p[0] as string[]).includes(s.id) && s.explainer_id === p[1] && s.creator_id === p[2]).map((s) => ({ picture: clone(s.picture), pictures: clone(s.pictures) })),
        })],
        [/^SELECT id, position, picture, pictures FROM explainer_scenes WHERE id = \$1 AND explainer_id = \$2 AND creator_id = \$3 FOR UPDATE$/, (p) => {
            const found = byId(p);
            return { rows: found ? [{ id: found.id, position: found.position, picture: clone(found.picture), pictures: clone(found.pictures) }] : [] };
        }],

        // Claiming a scene: the loop's (a pending one, or one stuck drawing for two minutes) and the owner's (any but one drawing right now).
        [/^UPDATE explainer_scenes SET draw_status = 'drawing', draw_error = NULL, updated_at = NOW\(\) WHERE explainer_id = \$1 AND creator_id = \$2 AND position = \$3 AND/, (p) => {
            const found = world.scenes.find((s) => mine(p)(s) && s.position === p[2]);
            if (!found) return { rows: [] };
            if (world.loseClaims > 0) {
                // Another caller's claim, committed on its own: it is in the snapshot too, so this caller's rollback does not undo it.
                world.loseClaims--;
                for (const list of [world.scenes, snapshots.at(-1) ?? []]) {
                    const theirs = list.find((s) => s.id === found.id);
                    if (theirs) Object.assign(theirs, { draw_status: 'drawing', updated_at: new Date() });
                }
                return { rows: [] };
            }
            if (!isPending(found)) return { rows: [] };
            Object.assign(found, { draw_status: 'drawing', draw_error: null, updated_at: new Date() });
            return { rows: [clone(found)] };
        }],
        [/^UPDATE explainer_scenes SET draw_status = 'drawing', draw_error = NULL, draw_note = \$4, updated_at = NOW\(\) WHERE explainer_id = \$1 AND creator_id = \$2 AND position = \$3 AND/, (p) => {
            const found = world.scenes.find((s) => mine(p)(s) && s.position === p[2]);
            if (!found || (found.draw_status === 'drawing' && !isStale(found))) return { rows: [] };
            Object.assign(found, { draw_status: 'drawing', draw_error: null, draw_note: p[3] as string | null, updated_at: new Date() });
            return { rows: [clone(found)] };
        }],

        // Writing the result.
        [/^UPDATE explainer_scenes SET picture = \$4::jsonb, pictures = \$5::jsonb, draw_status = 'done', draw_error = NULL, draw_attempts = draw_attempts \+ 1, updated_at = NOW\(\) WHERE id = \$1 AND explainer_id = \$2 AND creator_id = \$3 RETURNING/, (p) => {
            const found = byId(p);
            if (!found) return { rows: [] };
            Object.assign(found, { picture: JSON.parse(p[3]), pictures: JSON.parse(p[4]), draw_status: 'done', draw_error: null, draw_attempts: found.draw_attempts + 1, updated_at: new Date() });
            return { rows: [clone(found)] };
        }],
        [/^UPDATE explainer_scenes SET picture = \$4::jsonb, pictures = \$5::jsonb, draw_status = 'done', draw_error = NULL, updated_at = NOW\(\) WHERE id = \$1 AND explainer_id = \$2 AND creator_id = \$3 RETURNING/, (p) => {
            const found = byId(p);
            if (!found) return { rows: [] };
            Object.assign(found, { picture: JSON.parse(p[3]), pictures: JSON.parse(p[4]), draw_status: 'done', draw_error: null, updated_at: new Date() });
            return { rows: [clone(found)] };
        }],
        [/^UPDATE explainer_scenes SET picture = \$4::jsonb, pictures = '\[\]'::jsonb, draw_status = 'done', draw_error = NULL, updated_at = NOW\(\) WHERE id = \$1 AND explainer_id = \$2 AND creator_id = \$3 RETURNING/, (p) => {
            const found = byId(p);
            if (!found) return { rows: [] };
            Object.assign(found, { picture: JSON.parse(p[3]), pictures: [], draw_status: 'done', draw_error: null, updated_at: new Date() });
            return { rows: [clone(found)] };
        }],
        [/^UPDATE explainer_scenes SET picture = \$4::jsonb, pictures = '\[\]'::jsonb, draw_status = 'done', draw_error = NULL, updated_at = NOW\(\) WHERE id = ANY\(\$1::uuid\[\]\) AND explainer_id = \$2 AND creator_id = \$3$/, (p) => {
            const hit = world.scenes.filter((s) => (p[0] as string[]).includes(s.id) && s.explainer_id === p[1] && s.creator_id === p[2]);
            for (const s of hit) Object.assign(s, { picture: JSON.parse(p[3]), pictures: [], draw_status: 'done', draw_error: null, updated_at: new Date() });
            return { rows: [], rowCount: hit.length };
        }],
        [/^UPDATE explainer_scenes SET draw_status = CASE WHEN picture IS NOT NULL THEN 'done' ELSE 'failed' END, draw_error = \$4, updated_at = NOW\(\) WHERE id = \$1 AND explainer_id = \$2 AND creator_id = \$3 AND draw_status IN \('pending', 'drawing'\)$/, (p) => {
            const found = byId(p);
            if (!found || !['pending', 'drawing'].includes(found.draw_status)) return { rows: [], rowCount: 0 };
            Object.assign(found, { draw_status: found.picture ? 'done' : 'failed', draw_error: p[3] as string, updated_at: new Date() });
            return { rows: [], rowCount: 1 };
        }],
        [/^UPDATE explainer_scenes SET draw_status = CASE WHEN picture IS NOT NULL THEN 'done' ELSE 'pending' END, draw_error = NULL, updated_at = NOW\(\) WHERE id = \$1 AND explainer_id = \$2 AND creator_id = \$3 AND draw_status = 'drawing'$/, (p) => {
            const found = byId(p);
            if (!found || found.draw_status !== 'drawing') return { rows: [], rowCount: 0 };
            Object.assign(found, { draw_status: found.picture ? 'done' : 'pending', draw_error: null, updated_at: new Date() });
            return { rows: [], rowCount: 1 };
        }],

        // Deleting the files that dropped out: only those no scene of the explainer still names.
        [/^DELETE FROM media_uploads m WHERE m\.id = ANY\(\$1::uuid\[\]\) AND m\.creator_id = \$2 AND NOT EXISTS/, (p) => {
            const gone = (p[0] as string[]).filter((id) => store.files.has(id) && !named(id));
            for (const id of gone) { store.files.delete(id); world.deleted.push(id); }
            return { rows: [], rowCount: gone.length };
        }],
        [/^DELETE FROM media_uploads WHERE id = \$1 AND creator_id = \$2$/, (p) => {
            const had = store.files.delete(p[0] as string);
            if (had) world.deleted.push(p[0] as string);
            return { rows: [], rowCount: had ? 1 : 0 };
        }],
    );
}

interface Harness {
    db: FakeDb;
    world: World;
    store: FakeMediaStore;
    provider: ScriptedProvider;
    table: AllowanceTableRow[];
    logs: { level: string; event: string; fields: Record<string, unknown> }[];
}

let h: Harness;
let previousStore: MediaStore | null;
let previousProvider: ImageProvider | null | undefined;
let restoreSink: (() => void) | undefined;
let logs: Harness['logs'] = [];

before(() => {
    const previous = setLogSink((level, line) => { const { ts: _ts, level: _level, event, ...fields } = JSON.parse(line); logs.push({ level, event, fields }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    logs = [];
    clearReferenceCache();
    const db = installFakeDb();
    const store = new FakeMediaStore();
    const world: World = { scenes: [], explainers: new Set([`${TENANT}:${EXPLAINER}`]), look: { style: STYLE, characters: [KARIM, SAMIR] }, deleted: [], loseClaims: 0, held: 0 };
    store.files.set(REF_KARIM, { mimeType: 'image/png', data: pngHeader(448, 448) });
    store.files.set(REF_SAMIR, { mimeType: 'image/jpeg', data: jpegHeader(400, 300) });
    installSettings(db, { 'explainers.image_provider': SAVED_PROVIDER });
    const table = installAllowanceTable(db);
    installScenes(db, world, store);

    // Count the pooled clients checked out: the provider must be called with none.
    const connect = (pool as unknown as { connect: () => Promise<{ query: unknown; release: () => void }> }).connect;
    (pool as unknown as { connect: unknown }).connect = async () => {
        const client = await connect.call(pool);
        world.held++;
        return { query: client.query, release() { world.held--; client.release(); } };
    };

    const provider = new ScriptedProvider();
    previousStore = setMediaStore(store);
    previousProvider = setImageProvider(provider);
    h = { db, world, store, provider, table, logs };
});

afterEach(() => {
    setMediaStore(previousStore);
    setImageProvider(previousProvider);
    h.db.restore();
});

const today = (): AllowanceTableRow | undefined => h.table.find((r) => r.day === utcDay());
const sceneAt = (position: number): ExplainerSceneRow => h.world.scenes.find((s) => s.position === position)!;
const sql = (): string[] => h.db.statements.map((s) => s.sql);
const rejects = (code: string, status: number, text?: RegExp) => (err: unknown) => {
    assert.ok(err instanceof ExplainerError, `an ExplainerError, not ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    if (text) assert.match(err.message, text);
    return true;
};
/** A pause ends at the next 00:05 UTC: today's, or tomorrow's if the test ran across midnight. */
const isResumeTime = (iso: unknown): boolean => {
    const value = String(iso);
    return [resumeAt(new Date(Date.now() - 2000)).toISOString(), resumeAt(new Date()).toISOString()].includes(value);
};
const answer = <T extends { state: string }>(a: { state: string }, state: T['state']): T => {
    assert.equal(a.state, state, JSON.stringify(a));
    return a as T;
};

describe('drawNext — which scene, and when there is none', () => {
    it('answers done when nothing is pending, without touching the provider, the allowance or the store', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(1) }), scene(1, { draw_status: 'failed', draw_error: 'x' })];
        assert.deepEqual(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), { state: 'done' });
        assert.equal(h.provider.requests.length, 0);
        assert.equal(h.db.ran(/image_allowance/).length, 0);
        assert.equal(h.store.puts.length + h.store.gets.length, 0);
        assert.equal(h.db.ran(/^BEGIN$/).length, 0);
    });

    it('answers done for an explainer with no scenes at all', async () => {
        assert.deepEqual(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), { state: 'done' });
    });

    it('is 404 EXPLAINER_NOT_FOUND for an explainer that is not there, or that belongs to another tenant, before anything else is read', async () => {
        h.world.scenes = [scene(0)];
        await assert.rejects(drawNext({ creatorId: OTHER_TENANT, explainerId: EXPLAINER }), rejects('EXPLAINER_NOT_FOUND', 404));
        await assert.rejects(drawNext({ creatorId: TENANT, explainerId: '99999999-9999-4999-8999-999999999999' }), rejects('EXPLAINER_NOT_FOUND', 404));
        assert.equal(h.provider.requests.length, 0);
        assert.equal(h.db.ran(/FROM explainer_scenes/).length, 0);
    });

    it('draws the pending scene with the lowest position, skipping the scenes that are done and the ones that failed, and says how many are left', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(1) }), scene(1, { draw_status: 'failed', draw_error: 'x' }), scene(2), scene(3), scene(4)];
        const drawn = answer<{ state: 'drawn'; position: number; remaining: number }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'drawn');
        assert.equal(drawn.position, 2);
        assert.equal(drawn.remaining, 2);
        assert.equal(sceneAt(2).draw_status, 'done');
        assert.equal(sceneAt(3).draw_status, 'pending');
        assert.equal(h.provider.requests.length, 1);
    });

    it('claims a scene that has been drawing for over two minutes as if it were pending (the call that held it died), and leaves one drawing just now alone', async () => {
        h.world.scenes = [
            scene(0, { draw_status: 'drawing', updated_at: new Date(Date.now() - 10_000) }),
            scene(1, { draw_status: 'drawing', updated_at: new Date(Date.now() - (STALE_DRAWING_SECONDS + 60) * 1000) }),
            scene(2),
        ];
        const first = answer<{ state: 'drawn'; position: number; remaining: number }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'drawn');
        assert.equal(first.position, 1, 'scene 0 is being drawn by someone else just now');
        assert.equal(first.remaining, 1);
        assert.equal(sceneAt(0).draw_status, 'drawing');
        assert.equal(STALE_DRAWING_SECONDS, 120);
    });

    it('goes round again when the scene it picked was claimed by another caller first, and draws the next one', async () => {
        h.world.scenes = [scene(0), scene(1)];
        h.world.loseClaims = 1;
        const drawn = answer<{ state: 'drawn'; position: number }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'drawn');
        assert.equal(drawn.position, 1, 'scene 0 is now being drawn by the caller that won it');
        assert.equal(h.provider.requests.length, 1);
        assert.equal(today()?.pictures, 1, 'only the scene that was drawn reserved a picture');
    });

    it('gives up with 409 EXPLAINER_BAD_STATE when it loses the claim every time: another draw is working on this explainer', async () => {
        h.world.scenes = [scene(0), scene(1), scene(2), scene(3), scene(4), scene(5), scene(6), scene(7)];
        h.world.loseClaims = 99;
        await assert.rejects(drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), rejects('EXPLAINER_BAD_STATE', 409, /Another draw/));
        assert.equal(h.provider.requests.length, 0);
    });
});

describe('drawNext — the order of things, and what is held while the provider works', () => {
    it('claims the scene and reserves its units in ONE short transaction, calls the provider outside any, stores the file, then writes the result in a SECOND short transaction', async () => {
        h.world.scenes = [scene(0)];
        h.provider.onDraw = () => { h.db.statements.push({ sql: '-- provider.draw', params: [] }); };
        h.store.onPut = () => { h.db.statements.push({ sql: '-- media.put', params: [] }); };
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });

        const all = sql();
        const at = (re: RegExp, from = 0): number => all.findIndex((s, i) => i >= from && re.test(s));
        const begin1 = at(/^BEGIN$/);
        const claim = at(/^UPDATE explainer_scenes SET draw_status = 'drawing'/);
        const reserve = at(/^INSERT INTO image_allowance AS a \(provider, day, units, pictures\) SELECT/);
        const commit1 = at(/^COMMIT$/);
        const call = at(/^-- provider\.draw$/);
        const put = at(/^-- media\.put$/);
        const begin2 = at(/^BEGIN$/, commit1 + 1);
        const store = at(/^UPDATE explainer_scenes SET picture = \$4::jsonb, pictures = \$5::jsonb/);
        const commit2 = at(/^COMMIT$/, begin2);
        assert.ok(begin1 >= 0 && begin1 < claim && claim < reserve && reserve < commit1, `claim and reservation in the first transaction: ${all.join(' | ')}`);
        assert.ok(commit1 < call, 'the provider is called after that transaction has ended');
        assert.ok(call < put && put < begin2, 'the file is stored after the provider answers and before the second transaction begins');
        assert.ok(begin2 < store && store < commit2, 'the result is written in a second transaction');
        assert.equal(all.filter((s) => s === 'BEGIN').length, 2, 'two transactions, no more');
    });

    it('holds no pooled client and no open transaction while the provider works, and has the scene marked `drawing` (so a crash leaves it to be claimed again)', async () => {
        h.world.scenes = [scene(0)];
        const seen: { held: number; open: number; status: string; fresh: boolean }[] = [];
        h.provider.onDraw = () => {
            const open = sql().filter((s) => s === 'BEGIN').length - sql().filter((s) => s === 'COMMIT' || s === 'ROLLBACK').length;
            seen.push({ held: h.world.held, open, status: sceneAt(0).draw_status, fresh: Date.now() - sceneAt(0).updated_at.getTime() < 5000 });
        };
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.deepEqual(seen, [{ held: 0, open: 0, status: 'drawing', fresh: true }]);
    });

    it('holds no pooled client and no open transaction while the file is stored either', async () => {
        h.world.scenes = [scene(0)];
        const seen: { held: number; open: number }[] = [];
        h.store.onPut = () => { seen.push({ held: h.world.held, open: sql().filter((s) => s === 'BEGIN').length - sql().filter((s) => s === 'COMMIT' || s === 'ROLLBACK').length }); };
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.deepEqual(seen, [{ held: 0, open: 0 }]);
    });

    it('releases every pooled client it took, whatever happens', async () => {
        h.world.scenes = [scene(0), scene(1), scene(2)];
        h.provider.answers = [refused(), exhausted(), { data: PNG_1X1, mime: 'image/png', provider: 'cloudflare', model: MODEL }];
        for (let i = 0; i < 3; i++) await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.equal(h.world.held, 0);
    });
});

describe('drawNext — what the provider is asked, and what is kept', () => {
    it('asks for 1024×576 with the prompt of the scene, the seed of (explainer, position, attempt 0), and no references for a scene with no character', async () => {
        h.world.scenes = [scene(0, { brief: 'A lightbulb above a stack of papers.' })];
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        const [request] = h.provider.requests;
        assert.deepEqual([request!.width, request!.height], [SCENE_SIZE.width, SCENE_SIZE.height]);
        assert.equal(request!.seed, pictureSeed(EXPLAINER, 0, 0));
        assert.equal(request!.prompt, buildScenePrompt({ style: STYLE, characters: [], brief: 'A lightbulb above a stack of papers.', note: null }));
        assert.deepEqual(request!.references ?? [], []);
    });

    it('sends the approved reference of each character the scene names, in the order the scene names them, as images 0 and 1, and says so in the prompt', async () => {
        h.world.scenes = [scene(0, { characters: ['samir', 'karim'], brief: 'Samir and Karim read together.' })];
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        const [request] = h.provider.requests;
        assert.equal(request!.references!.length, 2);
        assert.deepEqual(Buffer.from(request!.references![0]!.data), jpegHeader(400, 300), 'image 0 is Samir’s reference');
        assert.equal(request!.references![0]!.mime, 'image/jpeg');
        assert.deepEqual(Buffer.from(request!.references![1]!.data), pngHeader(448, 448), 'image 1 is Karim’s');
        assert.equal(request!.references![1]!.mime, 'image/png');
        assert.match(request!.prompt, /Image 0 shows the recurring character: an old man with a white beard/);
        assert.match(request!.prompt, /Image 1 shows the recurring character: a curious young man/);
        assert.deepEqual(h.store.gets, [REF_SAMIR, REF_KARIM]);
    });

    it('sends a character once when the scene names it twice, and refuses a scene that names more than four', async () => {
        h.world.scenes = [scene(0, { characters: ['karim', 'karim'] })];
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.equal(h.provider.requests[0]!.references!.length, 1);

        h.world.scenes = [scene(0, { characters: ['karim', 'samir', 'a', 'b', 'c'] })];
        const failed = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        assert.match(failed.error, /at most 4/);
        assert.equal(h.provider.requests.length, 1, 'the second scene was never drawn');
    });

    it('stores the picture as an upload of the tenant, with the type its bytes have, and names it in the scene: media id, URL on our own address, seed, provider, model, prompt hash, time', async () => {
        h.world.scenes = [scene(0)];
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.equal(h.store.puts.length, 1);
        const [put] = h.store.puts;
        assert.equal(put!.creatorId, TENANT);
        assert.equal(put!.mimeType, 'image/png');
        assert.deepEqual(put!.data, PNG_1X1);
        assert.match(put!.filename, /^explainer-11111111-scene-1\.png$/);
        const chosen = sceneAt(0).picture!;
        assert.equal(chosen.media_id, put!.id);
        assert.equal(chosen.url, `/api/uploads/${put!.id}`);
        assert.equal(chosen.seed, pictureSeed(EXPLAINER, 0, 0));
        assert.equal(chosen.provider, 'cloudflare');
        assert.equal(chosen.model, MODEL);
        assert.match(chosen.prompt_hash, /^[0-9a-f]{64}$/);
        assert.match(chosen.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        assert.deepEqual(sceneAt(0).pictures, []);
        assert.deepEqual([sceneAt(0).draw_status, sceneAt(0).draw_error, sceneAt(0).draw_attempts], ['done', null, 1]);
    });

    it('stores a JPEG answer as image/jpeg', async () => {
        h.world.scenes = [scene(0)];
        h.provider.answers = [{ data: jpegHeader(1024, 576), mime: 'image/jpeg', provider: 'cloudflare', model: MODEL }];
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.equal(h.store.puts[0]!.mimeType, 'image/jpeg');
        assert.match(h.store.puts[0]!.filename, /\.jpg$/);
    });

    it('reserves one picture of today’s allowance for it, and keeps it', async () => {
        h.world.scenes = [scene(0)];
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.deepEqual([today()?.units, today()?.pictures], [110, 1]);
    });

    it('logs that a picture was drawn, with the ids and the time it took, and nothing of what the prompt says', async () => {
        h.world.scenes = [scene(0, { brief: 'SECRET-BRIEF a lamp' })];
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        const drawn = logs.find((l) => l.event === 'explainer.picture_drawn');
        assert.ok(drawn);
        assert.equal(drawn.fields.explainer_id, EXPLAINER);
        assert.equal(drawn.fields.position, 0);
        assert.equal(typeof drawn.fields.ms, 'number');
        assert.equal(JSON.stringify(logs).includes('SECRET-BRIEF'), false);
    });

    it('does not read a reference twice for the next scene that names the same character: the file never changes under its id', async () => {
        h.world.scenes = [scene(0, { characters: ['karim'] }), scene(1, { characters: ['karim'] })];
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.deepEqual(h.store.gets, [REF_KARIM]);
        assert.equal(h.provider.requests[1]!.references!.length, 1);
    });
});

describe('drawNext — a scene that continues the picture before it', () => {
    it('is not drawn: it takes the chosen picture of the scene before, with no provider call and nothing reserved', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(1), draw_attempts: 1 }), scene(1, { continues: true })];
        const drawn = answer<{ state: 'drawn'; position: number; remaining: number }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'drawn');
        assert.deepEqual([drawn.position, drawn.remaining], [1, 0]);
        assert.deepEqual(sceneAt(1).picture, picture(1));
        assert.deepEqual(sceneAt(1).pictures, []);
        assert.equal(sceneAt(1).draw_status, 'done');
        assert.equal(h.provider.requests.length, 0);
        assert.equal(h.db.ran(/image_allowance/).length, 0);
        assert.equal(h.store.puts.length, 0);
    });

    it('is filled in as soon as the scene before it is drawn, together with every scene after it that continues too: one draw, a run of scenes', async () => {
        h.world.scenes = [scene(0), scene(1, { continues: true }), scene(2, { continues: true }), scene(3), scene(4, { continues: true })];
        const first = answer<{ state: 'drawn'; position: number; remaining: number }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'drawn');
        assert.deepEqual([first.position, first.remaining], [0, 2], 'scenes 3 and 4 are still pending; scene 4 is filled in when scene 3 is drawn');
        const chosen = sceneAt(0).picture!;
        for (const position of [1, 2]) {
            assert.deepEqual(sceneAt(position).picture, chosen);
            assert.equal(sceneAt(position).draw_status, 'done');
        }
        assert.equal(sceneAt(3).draw_status, 'pending');
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.deepEqual(sceneAt(4).picture, sceneAt(3).picture);
        assert.equal(h.provider.requests.length, 2, 'two scenes were drawn for five');
        assert.equal(today()?.pictures, 2);
        assert.deepEqual(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), { state: 'done' });
    });

    it('is marked failed, with the reason, when the scene before it has no picture: it cannot continue what is not there', async () => {
        h.world.scenes = [scene(0, { draw_status: 'failed', draw_error: 'Cloudflare refused' }), scene(1, { continues: true })];
        const failed = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        assert.equal(failed.position, 1);
        assert.match(failed.error, /Scene 1 has no picture yet, so scene 2 cannot continue it/);
        assert.equal(sceneAt(1).draw_status, 'failed');
        assert.match(sceneAt(1).draw_error!, /cannot continue it/);
        assert.equal(h.provider.requests.length, 0);
        assert.equal(h.db.ran(/image_allowance/).length, 0);
    });

    it('is drawn like any other scene when it is the first: there is nothing before it to continue', async () => {
        h.world.scenes = [scene(0, { continues: true })];
        const drawn = answer<{ state: 'drawn'; position: number }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'drawn');
        assert.equal(drawn.position, 0);
        assert.equal(h.provider.requests.length, 1);
    });

    it('deletes the files of its own that it no longer shows, once it follows the scene before', async () => {
        h.store.files.set(mediaId(7), { mimeType: 'image/png', data: PNG_1X1 });
        h.world.scenes = [
            scene(0, { draw_status: 'done', picture: picture(1) }),
            scene(1, { continues: true, draw_status: 'pending', picture: picture(7), pictures: [] }),
        ];
        h.store.files.set(mediaId(1), { mimeType: 'image/png', data: PNG_1X1 });
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.deepEqual(h.world.deleted, [mediaId(7)]);
        assert.ok(h.store.files.has(mediaId(1)), 'the picture it now shows is kept');
    });
});

describe('drawNext — the allowance', () => {
    it('answers paused, with the time drawing may resume, when today’s cap is reached; the scene stays pending, nothing is called, nothing is claimed', async () => {
        h.world.scenes = [scene(0)];
        h.table.push({ provider: 'cloudflare', day: utcDay(), units: 8_800, pictures: 80, exhausted_at: null });
        const paused = answer<{ state: 'paused'; until: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'paused');
        assert.ok(isResumeTime(paused.until), paused.until);
        assert.equal(sceneAt(0).draw_status, 'pending', 'the claim went back with the refused reservation');
        assert.equal(h.provider.requests.length, 0);
        assert.equal(h.db.ran(/^ROLLBACK$/).length, 1);
        assert.equal(today()?.units, 8_800);
    });

    it('when Cloudflare says the allowance is used up (4006, 429): marks the day exhausted, keeps the units, puts the scene back to pending, and answers paused until 00:05 UTC', async () => {
        h.world.scenes = [scene(0), scene(1)];
        h.provider.answers = [exhausted()];
        const paused = answer<{ state: 'paused'; until: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'paused');
        assert.ok(isResumeTime(paused.until), paused.until);
        assert.ok(today()?.exhausted_at, 'the day is marked');
        assert.deepEqual([today()?.units, today()?.pictures], [110, 1], 'the reservation is kept: the estimate was low');
        assert.deepEqual([sceneAt(0).draw_status, sceneAt(0).draw_error], ['pending', null]);
        assert.equal(sceneAt(0).draw_attempts, 0, 'nothing was drawn, so the seed will be the same when it is');
        assert.equal(h.store.puts.length, 0);

        // The next call does not ask the provider again: the reservation refuses while the day is marked.
        const again = answer<{ state: 'paused'; until: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'paused');
        assert.equal(again.until, paused.until);
        assert.equal(h.provider.requests.length, 1);
    });

    it('puts a scene that was redrawn when the allowance ran out back to done, with the picture it had', async () => {
        h.world.scenes = [scene(0, { draw_status: 'drawing', updated_at: new Date(Date.now() - 3 * 60_000), picture: picture(1), draw_attempts: 1 })];
        h.provider.answers = [exhausted()];
        answer(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'paused');
        assert.deepEqual([sceneAt(0).draw_status, sceneAt(0).picture], ['done', picture(1)]);
    });
});

describe('drawNext — a failure of the provider', () => {
    it('gives the units back, marks the scene failed with the reason, and says which scene and why', async () => {
        h.world.scenes = [scene(0)];
        h.provider.answers = [refused('Cloudflare refused the picture: prompt too long')];
        const failed = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        assert.deepEqual([failed.position, failed.error], [0, 'Cloudflare refused the picture: prompt too long']);
        assert.deepEqual([sceneAt(0).draw_status, sceneAt(0).draw_error], ['failed', 'Cloudflare refused the picture: prompt too long']);
        assert.deepEqual([today()?.units, today()?.pictures], [0, 0], 'refunded');
        assert.equal(h.store.puts.length, 0);
    });

    it('goes on to the next scene on the next call: a scene that failed is not pending, so one bad scene does not stop the rest', async () => {
        h.world.scenes = [scene(0), scene(1)];
        h.provider.answers = [refused(), { data: PNG_1X1, mime: 'image/png', provider: 'cloudflare', model: MODEL }];
        answer(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        const second = answer<{ state: 'drawn'; position: number; remaining: number }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'drawn');
        assert.deepEqual([second.position, second.remaining], [1, 0]);
        assert.deepEqual(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), { state: 'done' });
        assert.deepEqual([sceneAt(0).draw_status, sceneAt(1).draw_status], ['failed', 'done']);
    });

    it('draws a failed scene again with the SAME seed when it is made pending again: a retry repeats a draw that never produced a picture', async () => {
        h.world.scenes = [scene(0)];
        h.provider.answers = [refused(), { data: PNG_1X1, mime: 'image/png', provider: 'cloudflare', model: MODEL }];
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        sceneAt(0).draw_status = 'pending';
        await drawNext({ creatorId: TENANT, explainerId: EXPLAINER });
        assert.equal(h.provider.requests[0]!.seed, h.provider.requests[1]!.seed);
        assert.equal(sceneAt(0).picture!.seed, pictureSeed(EXPLAINER, 0, 0));
        assert.equal(sceneAt(0).draw_attempts, 1);
    });

    it('marks the scene failed when the picture was drawn and could not be SAVED: the units stay spent, the error says so', async () => {
        h.world.scenes = [scene(0)];
        h.store.failPut = new Error('Storage is not reachable');
        const failed = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        assert.match(failed.error, /drawn but could not be saved: Storage is not reachable/);
        assert.equal(sceneAt(0).draw_status, 'failed');
        assert.deepEqual([today()?.units, today()?.pictures], [110, 1], 'Cloudflare did draw it');
    });

    it('treats an error that is not the provider’s own as a failure of that draw with a plain message, and refunds', async () => {
        h.world.scenes = [scene(0)];
        h.provider.answers = [new TypeError('x is not a function')];
        const failed = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        assert.match(failed.error, /failed unexpectedly/);
        assert.equal(failed.error.includes('x is not a function'), false, 'a bug’s words are for the log, not for the owner');
        assert.equal(today()?.units, 0);
        assert.ok(logs.some((l) => l.event === 'explainer.picture_failed'));
    });
});

describe('drawNext — the women guard, before anything is spent', () => {
    const untouched = (): void => {
        assert.equal(h.provider.requests.length, 0, 'the provider was not called');
        assert.equal(h.db.ran(/image_allowance/).length, 0, 'no allowance was reserved or read');
        assert.equal(h.store.gets.length + h.store.puts.length, 0, 'no file was read or stored');
        assert.equal(h.db.ran(/^BEGIN$/).length, 0, 'no transaction was begun');
    };

    it('refuses a brief that names a woman: the scene is marked failed with the refusal, and nothing was called', async () => {
        h.world.scenes = [scene(0, { brief: 'A woman reads a book at a desk.' })];
        const failed = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        assert.match(failed.error, /picture brief mentions «woman»/);
        assert.equal(sceneAt(0).draw_status, 'failed');
        assert.match(sceneAt(0).draw_error!, /never draw women or girls/);
        untouched();
    });

    it('refuses a scene whose stored redraw note names a girl', async () => {
        h.world.scenes = [scene(0, { draw_note: 'a girl smiling' })];
        const failed = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        assert.match(failed.error, /redraw note mentions «girl»/);
        untouched();
    });

    it('refuses a scene that names a character whose description names a woman, before any reference is read', async () => {
        h.world.look.characters = [KARIM, { ...SAMIR, description: 'an old woman with a white shawl' }];
        h.world.scenes = [scene(0, { characters: ['karim', 'samir'] })];
        const failed = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        assert.match(failed.error, /«samir» mentions «woman»/);
        untouched();
    });

    it('does not look at the description of a character the scene does not name', async () => {
        h.world.look.characters = [KARIM, { ...SAMIR, description: 'an old woman with a white shawl' }];
        h.world.scenes = [scene(0, { characters: ['karim'] })];
        answer(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'drawn');
    });

    it('refuses an empty brief: nothing to draw', async () => {
        h.world.scenes = [scene(0, { brief: '   ' })];
        const failed = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        assert.match(failed.error, /no picture brief/);
        untouched();
    });
});

describe('drawNext — the references', () => {
    const noCall = (): void => {
        assert.equal(h.provider.requests.length, 0);
        assert.equal(h.db.ran(/image_allowance/).length, 0);
        assert.equal(h.db.ran(/^BEGIN$/).length, 0);
    };
    const failure = async (): Promise<string> => {
        const a = answer<{ state: 'failed'; position: number; error: string }>(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'failed');
        return a.error;
    };

    it('needs an approved reference for each character the scene names: one with none is marked failed with what to do, and nothing is spent', async () => {
        h.world.look.characters = [{ ...KARIM, ref_media_id: null, ref_url: null, approved_at: null }, SAMIR];
        h.world.scenes = [scene(0, { characters: ['karim'] })];
        assert.match(await failure(), /«karim» has no approved reference picture yet. Generate candidates and approve one in Settings → Explainers/);
        noCall();
    });

    it('needs the character to be in the settings at all', async () => {
        h.world.scenes = [scene(0, { characters: ['ghost'] })];
        assert.match(await failure(), /«ghost», who is not in the Explainers settings/);
        noCall();
    });

    it('needs the reference file to be in storage', async () => {
        h.store.files.delete(REF_KARIM);
        h.world.scenes = [scene(0, { characters: ['karim'] })];
        assert.match(await failure(), /reference picture of «karim» is missing from storage/);
        noCall();
    });

    it('needs the reference to be a PNG or a JPEG', async () => {
        h.store.files.set(REF_KARIM, { mimeType: 'image/webp', data: Buffer.from('RIFF....WEBPVP8 xxxxxxxxxxxxxxxx') });
        h.world.scenes = [scene(0, { characters: ['karim'] })];
        assert.match(await failure(), /«karim» is not a PNG or a JPEG/);
        noCall();
    });

    it('refuses a reference that is 512 pixels or more on either side, with its size and what to do: FLUX.2 klein takes only smaller ones', async () => {
        for (const [width, height] of [[1024, 1024], [512, 300], [300, 512], [512, 512], [4000, 10]] as const) {
            clearReferenceCache();
            h.store.files.set(REF_KARIM, { mimeType: 'image/png', data: pngHeader(width, height) });
            h.world.scenes = [scene(0, { characters: ['karim'] })];
            const error = await failure();
            assert.match(error, new RegExp(`«karim» is ${width}×${height} pixels; it must be smaller than 512×512`), `${width}×${height}`);
            assert.match(error, /448×448/);
            noCall();
        }
    });

    it('takes a reference of 511×511, and a JPEG as well as a PNG', async () => {
        for (const bytes of [pngHeader(511, 511), jpegHeader(511, 300), pngHeader(448, 448)]) {
            clearReferenceCache();
            h.store.files.set(REF_KARIM, { mimeType: 'image/png', data: bytes });
            h.world.scenes = [scene(0, { characters: ['karim'] })];
            answer(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), 'drawn');
        }
        assert.equal(h.provider.requests.length, 3);
    });

    it('marks the scene failed, saying the file could not be read, when storage fails while reading a reference', async () => {
        h.store.failGet = new Error('Supabase is not reachable');
        h.world.scenes = [scene(0, { characters: ['karim'] })];
        assert.match(await failure(), /reference picture of «karim» could not be read from storage: Supabase is not reachable/);
        noCall();
    });
});

describe('drawNext — a scene that is gone, or changed, while it is drawn', () => {
    it('deletes the picture it stored and goes on, when the scene was deleted while the provider worked', async () => {
        h.world.scenes = [scene(0)];
        h.provider.onDraw = () => { h.world.scenes = []; };
        assert.deepEqual(await drawNext({ creatorId: TENANT, explainerId: EXPLAINER }), { state: 'done' });
        assert.equal(h.store.puts.length, 1);
        assert.deepEqual(h.world.deleted, [h.store.puts[0]!.id], 'a picture nothing names is not left behind');
    });
});

describe('drawScene — the owner draws or redraws one scene', () => {
    it('draws the scene at that position and answers with the scene as it is now and the allowance', async () => {
        h.world.scenes = [scene(0), scene(1, { brief: 'A lightbulb.' })];
        const { scene: drawn, allowance } = await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 1 });
        assert.equal(drawn.position, 1);
        assert.equal(drawn.draw_status, 'done');
        assert.equal(drawn.picture!.media_id, h.store.puts[0]!.id);
        assert.equal(typeof drawn.start_s, 'number');
        assert.deepEqual(allowance, { provider: 'cloudflare', day: utcDay(), used_units: 110, pictures: 1, cap: 80, est_left: 79, paused_until: null });
        assert.equal(sceneAt(0).draw_status, 'pending', 'only that scene');
    });

    it('selects the scene’s numbers as numbers: start and end come back as float8, not as strings', async () => {
        h.world.scenes = [scene(0)];
        await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 });
        const claim = h.db.ran(/^UPDATE explainer_scenes SET draw_status = 'drawing'/)[0]!.sql;
        assert.match(claim, /start_s::float8 AS start_s, end_s::float8 AS end_s/);
    });

    it('puts the owner’s note after the brief in the prompt, and keeps it on the scene', async () => {
        h.world.scenes = [scene(0, { characters: ['karim'], brief: 'Karim reads.' })];
        await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, note: ' he is holding a book, smiling ' });
        assert.match(h.provider.requests[0]!.prompt, /Scene: Karim reads\.\nChange for this drawing: he is holding a book, smiling\n/);
        const claim = h.db.ran(/^UPDATE explainer_scenes SET draw_status = 'drawing'/)[0]!;
        assert.equal(claim.params[3], 'he is holding a book, smiling');
        assert.equal(sceneAt(0).draw_note, 'he is holding a book, smiling');
    });

    it('draws without a note when none is given, and clears the note of the last redraw', async () => {
        h.world.scenes = [scene(0, { draw_note: 'old note', draw_status: 'done', picture: picture(1), draw_attempts: 1 })];
        await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 });
        assert.doesNotMatch(h.provider.requests[0]!.prompt, /Change for this drawing/);
        assert.equal(sceneAt(0).draw_note, null);
        await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, note: '   ' });
        assert.doesNotMatch(h.provider.requests[1]!.prompt, /Change for this drawing/);
    });

    it('draws a redraw with a NEW seed (the attempt is the number of pictures the scene has had), and a retry of a failed draw with the same', async () => {
        h.world.scenes = [scene(0)];
        h.provider.answers = [{ data: PNG_1X1, mime: 'image/png', provider: 'cloudflare', model: MODEL }, refused(), refused(), { data: PNG_1X1, mime: 'image/png', provider: 'cloudflare', model: MODEL }];
        await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }); // attempt 0
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 })); // attempt 1, fails
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 })); // attempt 1 again, fails
        await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }); // attempt 1, succeeds
        const seeds = h.provider.requests.map((r) => r.seed);
        assert.deepEqual(seeds, [pictureSeed(EXPLAINER, 0, 0), pictureSeed(EXPLAINER, 0, 1), pictureSeed(EXPLAINER, 0, 1), pictureSeed(EXPLAINER, 0, 1)]);
        assert.notEqual(seeds[0], seeds[1], 'the redraw is not the first picture again');
        assert.equal(sceneAt(0).draw_attempts, 2);
    });

    it('is refused with 404 for a scene or an explainer that is not there or not the tenant’s, and 409 for a scene that continues the one before it', async () => {
        h.world.scenes = [scene(0), scene(1, { continues: true })];
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 9 }), rejects('EXPLAINER_NOT_FOUND', 404, /No such scene/));
        await assert.rejects(drawScene({ creatorId: OTHER_TENANT, explainerId: EXPLAINER, position: 0 }), rejects('EXPLAINER_NOT_FOUND', 404));
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 1 }), rejects('EXPLAINER_BAD_STATE', 409, /Scene 2 continues the picture of scene 1/));
        assert.equal(h.provider.requests.length, 0);
    });

    it('is refused with 409 for a scene that is being drawn just now, and goes ahead with one that has been stuck for two minutes', async () => {
        h.world.scenes = [scene(0, { draw_status: 'drawing', updated_at: new Date() }), scene(1, { draw_status: 'drawing', updated_at: new Date(Date.now() - 3 * 60_000) })];
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }), rejects('EXPLAINER_BAD_STATE', 409, /being drawn right now/));
        assert.equal(h.provider.requests.length, 0);
        assert.equal((await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 1 })).scene.draw_status, 'done');
    });

    it('is 409 EXPLAINER_NO_PROVIDER when no image provider is set up, before the scene is claimed or anything is read', async () => {
        h.world.scenes = [scene(0)];
        setImageProvider(null);
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }), rejects('EXPLAINER_NO_PROVIDER', 409, /No image provider/));
        assert.equal(h.db.ran(/^BEGIN$/).length, 0);
        assert.equal(sceneAt(0).draw_status, 'pending');
    });

    it('is 429 EXPLAINER_ALLOWANCE_PAUSED with retryAt while the cap is reached, with the scene as it was', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(1), draw_attempts: 1 })];
        h.table.push({ provider: 'cloudflare', day: utcDay(), units: 8_800, pictures: 80, exhausted_at: null });
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }), (err: unknown) => {
            assert.ok(err instanceof ExplainerError);
            assert.equal(err.code, 'EXPLAINER_ALLOWANCE_PAUSED');
            assert.equal(err.status, 429);
            assert.ok(isResumeTime(err.params?.retryAt));
            return true;
        });
        assert.deepEqual([sceneAt(0).draw_status, sceneAt(0).picture], ['done', picture(1)]);
        assert.equal(h.provider.requests.length, 0);
    });

    it('is 429 too when the provider says it is used up in the middle of the draw, and the scene keeps the picture it had', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(1), draw_attempts: 1 })];
        h.provider.answers = [exhausted()];
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }), rejects('EXPLAINER_ALLOWANCE_PAUSED', 429, /used up/));
        assert.deepEqual([sceneAt(0).draw_status, sceneAt(0).picture, sceneAt(0).draw_attempts], ['done', picture(1), 1]);
        assert.ok(today()?.exhausted_at);
    });

    it('is 502 EXPLAINER_PROVIDER_ERROR when the provider fails: the units come back, and a scene that had a picture keeps it (the error is on the scene)', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(1), draw_attempts: 1 })];
        h.provider.answers = [refused('Cloudflare refused the picture: bad request')];
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }), rejects('EXPLAINER_PROVIDER_ERROR', 502, /^Cloudflare refused the picture: bad request$/));
        assert.deepEqual([sceneAt(0).draw_status, sceneAt(0).picture], ['done', picture(1)]);
        assert.equal(sceneAt(0).draw_error, 'Cloudflare refused the picture: bad request');
        assert.equal(today()?.units, 0);
    });

    it('is 502 EXPLAINER_PROVIDER_ERROR when the picture was drawn and could not be saved, and keeps the units spent', async () => {
        h.world.scenes = [scene(0)];
        h.store.failPut = new Error('Storage is not reachable');
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }), rejects('EXPLAINER_PROVIDER_ERROR', 502, /could not be saved/));
        assert.equal(sceneAt(0).draw_status, 'failed');
        assert.equal(today()?.units, 110);
    });

    it('refuses a note that names a woman or a girl before anything is read or reserved, and leaves the scene as it was', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(1), characters: ['karim'] })];
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, note: 'she is smiling' }), rejects('EXPLAINER_PROMPT_REFUSED', 422, /redraw note mentions «she»/));
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, note: 'فتاة تبتسم' }), rejects('EXPLAINER_PROMPT_REFUSED', 422));
        assert.equal(h.provider.requests.length, 0);
        assert.equal(h.store.gets.length, 0);
        assert.equal(h.db.ran(/image_allowance|^BEGIN$|explainer_scenes/).length, 0, 'not one statement: the note was refused first');
        assert.equal(sceneAt(0).draw_status, 'done');
    });

    it('refuses a brief or a character description that names a woman, and a note over 300 characters, with 422 and without marking the scene', async () => {
        h.world.scenes = [scene(0, { brief: 'Two girls laugh.' }), scene(1, { characters: ['samir'] }), scene(2)];
        h.world.look.characters = [KARIM, { ...SAMIR, description: 'a tall woman in a blue coat' }];
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }), rejects('EXPLAINER_PROMPT_REFUSED', 422, /picture brief mentions «girls»/));
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 1 }), rejects('EXPLAINER_PROMPT_REFUSED', 422, /«samir» mentions «woman»/));
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 2, note: 'x'.repeat(301) }), rejects('EXPLAINER_PROMPT_REFUSED', 422, /300/));
        assert.equal(h.provider.requests.length, 0);
        assert.equal(h.db.ran(/image_allowance/).length, 0);
        assert.deepEqual(h.world.scenes.map((s) => s.draw_status), ['pending', 'pending', 'pending']);
    });

    it('is 409 EXPLAINER_NEEDS_REFERENCE for a character with no approved reference, and does not mark the scene', async () => {
        h.world.look.characters = [{ ...KARIM, ref_media_id: null, ref_url: null, approved_at: null }];
        h.world.scenes = [scene(0, { characters: ['karim'] })];
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }), rejects('EXPLAINER_NEEDS_REFERENCE', 409, /no approved reference/));
        assert.equal(sceneAt(0).draw_status, 'pending');
        assert.equal(h.db.ran(/image_allowance/).length, 0);
    });

    it('is 409 EXPLAINER_NEEDS_REFERENCE for a reference that is 512×512 or more, saying how big it is', async () => {
        h.store.files.set(REF_KARIM, { mimeType: 'image/png', data: pngHeader(1024, 1024) });
        h.world.scenes = [scene(0, { characters: ['karim'] })];
        await assert.rejects(drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }), (err: unknown) => {
            assert.ok(err instanceof ExplainerError);
            assert.equal(err.code, 'EXPLAINER_NEEDS_REFERENCE');
            assert.match(err.message, /1024×1024 pixels; it must be smaller than 512×512/);
            assert.deepEqual(err.params, { character: 'karim', width: 1024, height: 1024 });
            return true;
        });
        assert.equal(h.provider.requests.length, 0);
    });
});

describe('drawScene — the pictures a scene keeps', () => {
    const redraw = (n = 1) => (async () => { for (let i = 0; i < n; i++) await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 }); })();

    it('keeps the earlier chosen picture as the newest of the history when the scene is drawn again', async () => {
        h.world.scenes = [scene(0)];
        await redraw(2);
        const [first, second] = h.store.puts.map((p) => p.id);
        assert.equal(sceneAt(0).picture!.media_id, second);
        assert.deepEqual(sceneAt(0).pictures.map((p) => p.media_id), [first]);
    });

    it('keeps the chosen picture plus the last three, newest first, and deletes the file that drops out of them', async () => {
        h.world.scenes = [scene(0)];
        await redraw(5);
        const ids = h.store.puts.map((p) => p.id);
        assert.equal(KEPT_HISTORY, 3);
        assert.equal(sceneAt(0).picture!.media_id, ids[4]);
        assert.deepEqual(sceneAt(0).pictures.map((p) => p.media_id), [ids[3], ids[2], ids[1]]);
        assert.deepEqual(h.world.deleted, [ids[0]], 'the oldest is gone from the media store');
        assert.equal(h.store.files.has(ids[0]!), false);
        for (const id of ids.slice(1)) assert.ok(h.store.files.has(id!), 'the others are kept');
    });

    it('deletes one file per redraw once the history is full, and never the chosen picture or one of the three', async () => {
        h.world.scenes = [scene(0)];
        await redraw(8);
        const ids = h.store.puts.map((p) => p.id);
        assert.deepEqual(h.world.deleted, ids.slice(0, 4));
        assert.deepEqual(sceneAt(0).pictures.map((p) => p.media_id), [ids[6], ids[5], ids[4]]);
        assert.equal(sceneAt(0).picture!.media_id, ids[7]);
    });

    it('never deletes a dropped file that another scene of the explainer still names', async () => {
        h.world.scenes = [scene(0), scene(5, { draw_status: 'done', picture: picture(99) })];
        await redraw(4);
        const first = h.store.puts[0]!.id;
        // Another scene comes to name the first picture (it will drop out of scene 0's history on the next draw).
        sceneAt(5).pictures = [{ ...picture(98), media_id: first, url: `/api/uploads/${first}` }];
        await redraw(1);
        assert.deepEqual(h.world.deleted, [], 'the guard held it back');
        assert.ok(h.store.files.has(first));
        const del = h.db.ran(/^DELETE FROM media_uploads m WHERE/)[0]!;
        assert.match(del.sql, /AND m\.creator_id = \$2 AND NOT EXISTS \(SELECT 1 FROM explainer_scenes s WHERE s\.explainer_id = \$3 AND \(s\.picture::text LIKE '%' \|\| m\.id::text \|\| '%' OR s\.pictures::text LIKE '%' \|\| m\.id::text \|\| '%'\)\)$/);
        assert.deepEqual(del.params.slice(1), [TENANT, EXPLAINER]);
    });

    it('deletes nothing and sends no delete while the history has room', async () => {
        h.world.scenes = [scene(0)];
        await redraw(3);
        assert.equal(h.db.ran(/^DELETE FROM media_uploads/).length, 0);
        assert.deepEqual(h.world.deleted, []);
    });
});

describe('drawScene — scenes that continue this one', () => {
    it('gives every scene after it that continues the new chosen picture, up to the first that does not', async () => {
        h.world.scenes = [
            scene(0, { draw_status: 'done', picture: picture(1), draw_attempts: 1 }),
            scene(1, { continues: true, draw_status: 'done', picture: picture(1) }),
            scene(2, { continues: true, draw_status: 'done', picture: picture(1) }),
            scene(3, { draw_status: 'done', picture: picture(30), draw_attempts: 1 }),
            scene(4, { continues: true, draw_status: 'done', picture: picture(30) }),
        ];
        h.store.files.set(mediaId(1), { mimeType: 'image/png', data: PNG_1X1 });
        const { scene: redrawn } = await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 });
        assert.deepEqual(sceneAt(1).picture, redrawn.picture);
        assert.deepEqual(sceneAt(2).picture, redrawn.picture);
        assert.deepEqual(sceneAt(3).picture, picture(30), 'a scene that does not continue keeps its own');
        assert.deepEqual(sceneAt(4).picture, picture(30), 'and so does the one that continues THAT one');
        assert.deepEqual(sceneAt(0).pictures.map((p) => p.media_id), [mediaId(1)], 'the old picture is still scene 0’s to go back to');
        assert.ok(h.store.files.has(mediaId(1)), 'and so it is not deleted, though scenes 1 and 2 no longer show it');
    });

    it('stops at a gap in the positions', async () => {
        h.world.scenes = [scene(0), scene(2, { continues: true, draw_status: 'done', picture: picture(5) })];
        await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 });
        assert.deepEqual(sceneAt(2).picture, picture(5));
    });

    it('also heals a following scene that failed because this one had no picture', async () => {
        h.world.scenes = [scene(0, { draw_status: 'failed', draw_error: 'x' }), scene(1, { continues: true, draw_status: 'failed', draw_error: 'Scene 1 has no picture yet, so scene 2 cannot continue it.' })];
        const { scene: drawn } = await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 });
        assert.deepEqual(sceneAt(1).picture, drawn.picture);
        assert.deepEqual([sceneAt(1).draw_status, sceneAt(1).draw_error], ['done', null]);
    });

    it('deletes the files of a following scene that had pictures of its own, once nothing names them', async () => {
        h.store.files.set(mediaId(40), { mimeType: 'image/png', data: PNG_1X1 });
        h.store.files.set(mediaId(41), { mimeType: 'image/png', data: PNG_1X1 });
        h.world.scenes = [scene(0), scene(1, { continues: true, draw_status: 'done', picture: picture(40), pictures: [picture(41)] })];
        await drawScene({ creatorId: TENANT, explainerId: EXPLAINER, position: 0 });
        assert.deepEqual(h.world.deleted.sort(), [mediaId(40), mediaId(41)].sort());
    });
});

describe('pickPicture — going back to an earlier picture', () => {
    const drawn = (n: number): ExplainerPicture[] => Array.from({ length: n }, (_, i) => picture(i + 1));

    it('makes an earlier picture the chosen one and sets the chosen one aside as the newest of the history; nothing is deleted', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(4), pictures: [picture(3), picture(2), picture(1)], draw_attempts: 4 })];
        const { scene: picked } = await pickPicture({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, index: 1 });
        assert.deepEqual(picked.picture, picture(2));
        assert.deepEqual(picked.pictures, [picture(4), picture(3), picture(1)]);
        assert.equal(picked.pictures.length, 3);
        assert.equal(picked.draw_attempts, 4, 'a pick draws nothing, so the next redraw is still the next attempt');
        assert.equal(h.db.ran(/^DELETE FROM media_uploads/).length, 0);
        assert.equal(h.provider.requests.length, 0);
        assert.equal(h.db.ran(/image_allowance/).length, 0);
    });

    it('can go back and forth: picking the one that was set aside restores the earlier arrangement', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(4), pictures: [picture(3), picture(2), picture(1)] })];
        await pickPicture({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, index: 0 });
        assert.deepEqual([sceneAt(0).picture, sceneAt(0).pictures], [picture(3), [picture(4), picture(2), picture(1)]]);
        await pickPicture({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, index: 0 });
        assert.deepEqual([sceneAt(0).picture, sceneAt(0).pictures], [picture(4), [picture(3), picture(2), picture(1)]]);
    });

    it('gives the picked picture to the scenes after it that continue it', async () => {
        h.world.scenes = [
            scene(0, { draw_status: 'done', picture: picture(4), pictures: drawn(3) }),
            scene(1, { continues: true, draw_status: 'done', picture: picture(4) }),
            scene(2, { draw_status: 'done', picture: picture(9) }),
        ];
        await pickPicture({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, index: 2 });
        assert.deepEqual(sceneAt(1).picture, picture(3));
        assert.deepEqual(sceneAt(2).picture, picture(9));
    });

    it('is 404 EXPLAINER_NOT_FOUND for an index there is no picture at: out of range, negative, not a whole number', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(2), pictures: [picture(1)] })];
        for (const index of [1, 3, -1, 0.5, Number.NaN, '0' as unknown as number]) {
            await assert.rejects(pickPicture({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, index }), rejects('EXPLAINER_NOT_FOUND', 404, /no earlier picture/), String(index));
        }
        assert.deepEqual(sceneAt(0).picture, picture(2));
    });

    it('is 404 for a scene or an explainer that is not there or not the tenant’s', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(2), pictures: [picture(1)] })];
        await assert.rejects(pickPicture({ creatorId: TENANT, explainerId: EXPLAINER, position: 5, index: 0 }), rejects('EXPLAINER_NOT_FOUND', 404, /No such scene/));
        await assert.rejects(pickPicture({ creatorId: OTHER_TENANT, explainerId: EXPLAINER, position: 0, index: 0 }), rejects('EXPLAINER_NOT_FOUND', 404));
    });

    it('is 409 EXPLAINER_BAD_STATE for a scene being drawn just now, and for one that continues the scene before it', async () => {
        h.world.scenes = [
            scene(0, { draw_status: 'drawing', updated_at: new Date(), picture: picture(2), pictures: [picture(1)] }),
            scene(1, { continues: true, draw_status: 'done', picture: picture(2) }),
        ];
        await assert.rejects(pickPicture({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, index: 0 }), rejects('EXPLAINER_BAD_STATE', 409, /being drawn right now/));
        await assert.rejects(pickPicture({ creatorId: TENANT, explainerId: EXPLAINER, position: 1, index: 0 }), rejects('EXPLAINER_BAD_STATE', 409, /continues the picture of scene 1/));
    });

    it('works inside one transaction: the scene is locked, then changed, with the rest of the run', async () => {
        h.world.scenes = [scene(0, { draw_status: 'done', picture: picture(2), pictures: [picture(1)] })];
        await pickPicture({ creatorId: TENANT, explainerId: EXPLAINER, position: 0, index: 0 });
        const all = sql();
        assert.equal(all.filter((s) => s === 'BEGIN').length, 1);
        assert.match(all[all.findIndex((s) => s === 'BEGIN') + 1]!, /FOR UPDATE$/);
        assert.equal(all.at(-1), 'COMMIT');
    });
});
