/**
 * "Copy existing files to R2" (src/services/r2Copy.ts): the drain's batch. In-memory database, Supabase and R2 (r2TestKit.ts); the clock is pinned.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { readCopyStatus, requestCopy, runCopyBatch } from './r2Copy.js';
import { R2UsageGuard, setR2Guard, type R2Guard } from './r2Usage.js';
import { MEDIA_BUCKET, PRIVATE_MEDIA_BUCKET } from './supabaseStorage.js';
import { CREATOR, FakeDb, FakeStores } from './r2TestKit.js';

const NOV = new Date('2026-11-06T10:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let db: FakeDb;
let stores: FakeStores;
let restoreDb: () => void;
let restoreFetch: () => void;
let restoreSink: (() => void) | undefined;
let previousGuard: R2Guard | null;
let logged: string[];

before(() => {
    const previous = setLogSink((_l, line) => { try { logged.push(JSON.parse(line).event); } catch { /* not ours */ } });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    logged = [];
    db = new FakeDb();
    stores = new FakeStores();
    restoreDb = db.install();
    restoreFetch = stores.install();
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    db.configureSupabase();
    db.configureR2();
    mock.timers.enable({ apis: ['Date'], now: NOV });
    previousGuard = setR2Guard(new R2UsageGuard());
});
afterEach(() => {
    mock.timers.reset();
    setR2Guard(previousGuard);
    restoreFetch();
    restoreDb();
});

/** A Supabase file with a row, as the app writes them. */
function supabaseFile(n: number, content = `file ${n}`, options: { private?: boolean; mime?: string } = {}): string {
    const path = `${options.private ? 'private/' : ''}${CREATOR}/${id(n)}.mp4`;
    const bytes = Buffer.from(content);
    stores.supabase.set(`${options.private ? PRIVATE_MEDIA_BUCKET : MEDIA_BUCKET}/${path}`, { data: bytes, contentType: options.mime ?? 'video/mp4' });
    db.addMedia({ id: id(n), storage_path: path, size_bytes: String(bytes.length), mime_type: options.mime ?? 'video/mp4', ...(options.private ? { is_private: true } : {}) });
    return path;
}
const saved = () => JSON.parse(db.settings.get('storage.r2_copy')!.value);

describe('asking for the copy', () => {
    it('does nothing until the owner asks', async () => {
        supabaseFile(1);
        assert.deepEqual(await runCopyBatch(), { ran: false, copied: 0, skipped: 0, stoppedBecause: null, done: false });
        assert.equal(stores.seen.length, 0);
    });

    it('records the request, and the card reads "N of M" from the rows', async () => {
        supabaseFile(1);
        supabaseFile(2);
        db.addMedia({ id: id(3), storage_path: `r2:${CREATOR}/${id(3)}.mp4`, size_bytes: '5' });
        await requestCopy(null, NOV);
        assert.deepEqual(await readCopyStatus(), { active: true, requestedAt: NOV.toISOString(), doneAt: null, lastError: null, inR2: 1, total: 3, skipped: 0 });
    });
});

describe('a batch', () => {
    it('copies a file: Supabase → R2, size verified, then the row names the R2 copy; the Supabase copy is left', async () => {
        const path = supabaseFile(1, 'the reel');
        await requestCopy(null, NOV);
        const out = await runCopyBatch();
        assert.deepEqual([out.ran, out.copied, out.stoppedBecause], [true, 1, null]);
        assert.equal(db.media.get(id(1))!.storage_path, `r2:${path}`);
        assert.equal(stores.r2.get(path)!.data.toString(), 'the reel');
        assert.equal(stores.r2.get(path)!.contentType, 'video/mp4');
        assert.ok(stores.supabase.has(`${MEDIA_BUCKET}/${path}`), 'the Supabase copy is not deleted');
        assert.ok(stores.r2Calls().some((c) => c.method === 'HEAD'), 'verified with a HEAD');
        assert.deepEqual(db.counters('2026-11'), { a: 1, b: 50 }, 'one write, and a batch of reads for the verification');
    });

    it('copies a private file from the private bucket to the same key in R2', async () => {
        const path = supabaseFile(1, 'a voice note', { private: true, mime: 'audio/ogg' });
        await requestCopy(null, NOV);
        await runCopyBatch();
        assert.equal(db.media.get(id(1))!.storage_path, `r2:${path}`);
        assert.equal(db.media.get(id(1))!.is_private, true);
        assert.ok(stores.r2.has(`private/${CREATOR}/${id(1)}.mp4`));
    });

    it('when nothing is left it is done, once, and later drains do nothing', async () => {
        supabaseFile(1);
        await requestCopy(null, NOV);
        await runCopyBatch();
        const finished = await runCopyBatch();
        assert.deepEqual([finished.ran, finished.done], [true, true]);
        assert.ok(saved().done_at);
        const calls = stores.seen.length;
        assert.equal((await runCopyBatch()).ran, false);
        assert.equal(stores.seen.length, calls);
        assert.deepEqual(await readCopyStatus().then((s) => [s.active, s.inR2, s.total]), [false, 1, 1]);
    });

    it('stays within its size budget: more files wait for the next drain', async () => {
        for (let n = 1; n <= 5; n++) supabaseFile(n, 'x'.repeat(40));
        await requestCopy(null, NOV);
        const out = await runCopyBatch({ maxBytes: 100 });
        assert.equal(out.copied, 2, '40 + 40 fit in 100; a third would pass it, so it waits');
        assert.equal((await readCopyStatus()).inR2, 2);
        assert.equal((await runCopyBatch({ maxBytes: 100 })).copied, 2);
        assert.equal((await runCopyBatch({ maxBytes: 100 })).copied, 1);
        assert.equal((await runCopyBatch()).done, true);
    });

    it('starts no new file after the deadline', async () => {
        for (let n = 1; n <= 3; n++) supabaseFile(n);
        await requestCopy(null, NOV);
        const out = await runCopyBatch({ deadline: Date.now() - 1 });
        assert.equal(out.copied, 0);
        assert.equal(stores.seen.length, 0);
    });

    it('skips a file Supabase says is gone, remembers it, and finishes the rest', async () => {
        supabaseFile(1);
        db.addMedia({ id: id(2), storage_path: `${CREATOR}/${id(2)}.mp4`, size_bytes: '5' }); // no object in Supabase
        supabaseFile(3);
        await requestCopy(null, NOV);
        const out = await runCopyBatch();
        assert.deepEqual([out.copied, out.skipped], [2, 1]);
        assert.deepEqual(saved().skipped, [id(2)]);
        assert.ok(logged.includes('media.copy_object_missing'));
        assert.equal((await runCopyBatch()).done, true, 'the missing one is not retried forever');
        assert.equal((await readCopyStatus()).skipped, 1);
    });
});

describe('when something refuses', () => {
    it('a Supabase refusal (its quota) stops the batch, changes nothing, is logged once and shown on the card; the next drain tries again', async () => {
        supabaseFile(1);
        supabaseFile(2);
        await requestCopy(null, NOV);
        stores.supabaseMode = 'refuse';
        const first = await runCopyBatch();
        assert.equal(first.copied, 0);
        assert.match(first.stoppedBecause!, /Supabase Storage refused to download the file: Egress quota exceeded/);
        assert.equal(db.media.get(id(1))!.storage_path, `${CREATOR}/${id(1)}.mp4`, 'the row is as it was');
        assert.equal(stores.r2.size, 0);
        assert.match((await readCopyStatus()).lastError!, /Egress quota exceeded/);

        const writes = db.statements.filter((s) => /^INSERT INTO app_settings \(key, value, is_secret, updated_at, updated_by\)/.test(s)).length;
        const second = await runCopyBatch();
        assert.equal(second.copied, 0);
        assert.equal(db.statements.filter((s) => /^INSERT INTO app_settings \(key, value, is_secret, updated_at, updated_by\)/.test(s)).length, writes, 'the same reason is not written, or logged, again');
        assert.equal(logged.filter((e) => e === 'media.r2_copy_stopped').length, 1);

        stores.supabaseMode = 'ok';
        const third = await runCopyBatch();
        assert.equal(third.copied, 2, 'when Supabase answers again, the copy resumes by itself');
        assert.equal((await readCopyStatus()).lastError, null);
    });

    it('stops with the reason when R2\'s storage limit would be passed, writing nothing', async () => {
        supabaseFile(1, 'x'.repeat(60));
        supabaseFile(2, 'y'.repeat(60));
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 100, class_a: 100, class_b: 100 }));
        await requestCopy(null, NOV);
        const out = await runCopyBatch();
        assert.equal(out.copied, 1);
        assert.match(out.stoppedBecause!, /Cloudflare R2's free storage is full/);
        assert.equal(db.media.get(id(2))!.storage_path, `${CREATOR}/${id(2)}.mp4`);
        assert.equal(stores.r2.size, 1);
    });

    it('stops when R2\'s Class A is used up, before it downloads anything more', async () => {
        supabaseFile(1);
        db.setCounters('2026-11', 900_000, 0);
        await requestCopy(null, NOV);
        const out = await runCopyBatch();
        assert.match(out.stoppedBecause!, /free write allowance for this month is used up/);
        assert.equal(stores.supabaseCalls().length, 0, 'nothing was downloaded for a copy that could not be written');
    });

    it('an R2 refusal (a bad token) stops the batch and says so', async () => {
        supabaseFile(1);
        stores.r2Mode = 'signature';
        await requestCopy(null, NOV);
        const out = await runCopyBatch();
        assert.match(out.stoppedBecause!, /Cloudflare R2 refused to upload the file/);
        assert.equal(db.media.get(id(1))!.storage_path, `${CREATOR}/${id(1)}.mp4`);
    });

    it('a copy whose size R2 reports differently is not trusted: the row is left alone', async () => {
        supabaseFile(1, 'abcdef');
        const real = stores.fetch.bind(stores);
        stores.fetch = async (input, init) => {
            const response = await real(input, init);
            return init?.method === 'HEAD' && new URL(input).host.endsWith('r2.cloudflarestorage.com')
                ? new Response(null, { status: 200, headers: { 'content-length': '3', 'content-type': 'video/mp4' } })
                : response;
        };
        await requestCopy(null, NOV);
        const out = await runCopyBatch();
        assert.match(out.stoppedBecause!, /holds 3 bytes of .*not the 6 copied/);
        assert.equal(db.media.get(id(1))!.storage_path, `${CREATOR}/${id(1)}.mp4`);
    });

    it('needs both stores set up, and says so', async () => {
        supabaseFile(1);
        db.settings.delete('storage.r2_account_id');
        await requestCopy(null, NOV);
        assert.match((await runCopyBatch()).stoppedBecause!, /Both Supabase Storage and Cloudflare R2 must be set up/);
    });
});

describe('a change to the row while the copy runs wins', () => {
    it('does not overwrite a path that changed, and removes the R2 object it made', async () => {
        const path = supabaseFile(1, 'the reel');
        await requestCopy(null, NOV);
        // The row moves (a retention sweep, an edit) between the SELECT and the UPDATE: change it as R2 answers the upload.
        const real = stores.fetch.bind(stores);
        stores.fetch = async (input, init) => {
            const response = await real(input, init);
            if (init?.method === 'PUT' && new URL(input).host.endsWith('r2.cloudflarestorage.com')) db.media.get(id(1))!.storage_path = `${CREATOR}/moved.mp4`;
            return response;
        };
        const out = await runCopyBatch();
        assert.equal(out.copied, 0);
        assert.equal(db.media.get(id(1))!.storage_path, `${CREATOR}/moved.mp4`, 'the other change is kept');
        assert.equal(stores.r2.has(path), false, 'our copy was taken back out: nothing orphaned');
        assert.ok(logged.includes('media.r2_copy_superseded'));
    });

    it('never removes the R2 object when another drain already pointed the row at it', async () => {
        const path = supabaseFile(1, 'the reel');
        await requestCopy(null, NOV);
        const real = stores.fetch.bind(stores);
        stores.fetch = async (input, init) => {
            const response = await real(input, init);
            if (init?.method === 'PUT' && new URL(input).host.endsWith('r2.cloudflarestorage.com')) db.media.get(id(1))!.storage_path = `r2:${path}`;
            return response;
        };
        await runCopyBatch();
        assert.equal(stores.r2.has(path), true, 'the good copy stays');
        assert.equal(db.media.get(id(1))!.storage_path, `r2:${path}`);
    });
});

describe('never throws', () => {
    it('a database that fails is a quiet no-op: the drain\'s other work goes on', async () => {
        db.failOn = /storage\.r2_copy|FROM app_settings/;
        assert.deepEqual(await runCopyBatch(), { ran: false, copied: 0, skipped: 0, stoppedBecause: null, done: false });
    });
});
