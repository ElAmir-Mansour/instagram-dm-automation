/**
 * One store that reads both Supabase Storage and Cloudflare R2 (src/services/storage.ts): which backend takes new uploads, where a row's bytes are read from,
 * what an R2 write is refused for (the free tier), how the deletion sweep and the signed-upload callers treat an `r2:` path, and that an unconfigured backend is
 * a 503 and never a guess. The database, R2 and Supabase are the in-memory doubles of r2TestKit.ts.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { signAdUpload } from './ads/adUploads.js';
import { AdsError } from './adBoosts.js';
import { signWorkerUpload } from './monteur/uploads.js';
import { checkRenderFiles } from './studio/jobs.js';
import { StudioError } from './studio/common.js';
import {
    directUploadStore, getMediaStore, MediaStorageUnavailableError, ObjectMediaStore, PostgresMediaStore, removeQueuedMediaObjects, resolveWriteTarget, setMediaStore,
    SupabaseStorageMediaStore, type MediaStore,
} from './storage.js';
import { R2CounterError, R2LimitError, R2UsageGuard, setR2Guard, type R2Guard } from './r2Usage.js';
import { bucketForPath, isR2Path, MEDIA_BUCKET, objectPathFor, PRIVATE_MEDIA_BUCKET, r2KeyOf } from './supabaseStorage.js';
import { ACCOUNT, CREATOR, FakeDb, FakeStores, R2_BUCKET, R2_HOST, R2_KEY_ID, R2_SECRET, SUPABASE, SUPABASE_KEY } from './r2TestKit.js';

const ID = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const ID2 = '1b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const NOV = new Date('2026-11-06T10:00:00Z');
const BASE = 'https://app.example.test';

let db: FakeDb;
let stores: FakeStores;
let restoreDb: () => void;
let restoreFetch: () => void;
let restoreSink: (() => void) | undefined;
let previousStore: MediaStore | null;
let previousGuard: R2Guard | null;
let logged: string[];

before(() => {
    const previous = setLogSink((_level, line) => { try { logged.push(JSON.parse(line).event); } catch { /* not ours */ } });
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
    mock.timers.enable({ apis: ['Date'], now: NOV });
    previousStore = setMediaStore(null);
    previousGuard = setR2Guard(new R2UsageGuard());
});
afterEach(() => {
    mock.timers.reset();
    setMediaStore(previousStore);
    setR2Guard(previousGuard);
    restoreFetch();
    restoreDb();
});

const supabaseCfg = { url: SUPABASE, key: SUPABASE_KEY, source: { url: 'database' as const, key: 'database' as const } };
const r2Cfg = { accountId: ACCOUNT, bucket: R2_BUCKET, accessKeyId: R2_KEY_ID, secretAccessKey: R2_SECRET };
const both = (writesTo: 'supabase' | 'r2' | null) => new ObjectMediaStore({ supabase: supabaseCfg, r2: r2Cfg, writesTo });
const BYTES = Buffer.from('some media bytes');

describe('which backend takes new uploads', () => {
    it('follows the owner\'s choice, and never lands on a backend that is not set up', () => {
        assert.equal(resolveWriteTarget(null, true, false), 'supabase');
        assert.equal(resolveWriteTarget(null, false, true), 'r2', 'nothing chosen, only R2 exists');
        assert.equal(resolveWriteTarget(null, true, true), 'supabase', 'nothing chosen: Supabase stays the default');
        assert.equal(resolveWriteTarget('r2', true, true), 'r2');
        assert.equal(resolveWriteTarget('r2', true, false), 'supabase', 'R2 chosen but not set up: the other, never nowhere');
        assert.equal(resolveWriteTarget('r2', false, false), null);
        assert.equal(resolveWriteTarget('supabase', false, true), null, 'Supabase chosen and not set up: Postgres, not a silent switch to R2');
        assert.equal(resolveWriteTarget(null, false, false), null);
    });

    it('getMediaStore builds it from the settings: both configs, one store, the chosen write target', async () => {
        db.configureSupabase();
        db.configureR2();
        const byDefault = await getMediaStore();
        assert.ok(byDefault instanceof ObjectMediaStore);
        assert.equal((byDefault as ObjectMediaStore).writesTo, 'supabase');
        assert.ok((byDefault as ObjectMediaStore).has('r2') && (byDefault as ObjectMediaStore).has('supabase'));

        db.set('storage.backend', 'r2');
        const chosen = await getMediaStore();
        assert.equal((chosen as ObjectMediaStore).writesTo, 'r2');
        assert.notEqual(chosen, byDefault, 'the choice changed, so the instance did');
        assert.equal(await getMediaStore(), chosen, 'and is kept while nothing changes');
    });

    it('is R2 alone when only R2 is set up, and Postgres when neither is', async () => {
        assert.ok((await getMediaStore()) instanceof PostgresMediaStore);
        db.configureR2();
        const store = await getMediaStore();
        assert.ok(store instanceof ObjectMediaStore && store.writesTo === 'r2' && !store.has('supabase'));
    });

    it('with R2 chosen but its keys removed, writes go back to Supabase', async () => {
        db.configureSupabase();
        db.set('storage.backend', 'r2');
        assert.equal(((await getMediaStore()) as ObjectMediaStore).writesTo, 'supabase');
    });

    it('an incomplete or malformed R2 config is no R2 config', async () => {
        db.configureSupabase();
        db.set('storage.r2_account_id', 'not-32-hex');
        db.set('storage.r2_access_key_id', R2_KEY_ID);
        db.set('storage.r2_secret_access_key', R2_SECRET, true);
        assert.equal(((await getMediaStore()) as ObjectMediaStore).has('r2'), false);
    });

    it('SupabaseStorageMediaStore is the Supabase-only store, as before', () => {
        const store = new SupabaseStorageMediaStore(supabaseCfg);
        assert.equal(store.writesTo, 'supabase');
        assert.equal(store.has('r2'), false);
        assert.equal(directUploadStore(store), store);
        assert.equal(directUploadStore(new PostgresMediaStore()), null);
        assert.equal(directUploadStore(new ObjectMediaStore({ supabase: supabaseCfg, writesTo: null })), null, 'reads only: nothing to sign against');
    });
});

describe('a row names its own backend', () => {
    const publicSupabase = `${CREATOR}/${ID}.mp4`;
    const publicR2 = `r2:${CREATOR}/${ID2}.mp4`;

    it('reads a Supabase row from Supabase and an `r2:` row from R2, whichever takes new uploads', async () => {
        stores.supabase.set(`${MEDIA_BUCKET}/${publicSupabase}`, { data: Buffer.from('from supabase'), contentType: 'video/mp4' });
        stores.r2.set(`${CREATOR}/${ID2}.mp4`, { data: Buffer.from('from r2'), contentType: 'video/mp4' });
        db.addMedia({ id: ID, storage_path: publicSupabase, size_bytes: '13' });
        db.addMedia({ id: ID2, storage_path: publicR2, size_bytes: '7' });
        for (const writesTo of ['supabase', 'r2'] as const) {
            stores.seen = [];
            const store = both(writesTo);
            assert.equal((await store.get(ID))!.data.toString(), 'from supabase');
            assert.deepEqual(stores.seen.map((c) => c.host), [new URL(SUPABASE).host]);
            stores.seen = [];
            assert.equal((await store.get(ID2))!.data.toString(), 'from r2');
            assert.deepEqual(stores.seen.map((c) => c.host), [R2_HOST]);
            assert.equal(stores.seen[0]!.path, `/${R2_BUCKET}/${CREATOR}/${ID2}.mp4`, 'the key, with no r2: prefix');
        }
    });

    it('keeps a private file where it was written: the private bucket in Supabase, under `private/` in the one R2 bucket', async () => {
        const supa = `private/${CREATOR}/${ID}.ogg`;
        stores.supabase.set(`${PRIVATE_MEDIA_BUCKET}/${supa}`, { data: Buffer.from('s'), contentType: 'audio/ogg' });
        stores.r2.set(supa, { data: Buffer.from('r'), contentType: 'audio/ogg' });
        db.addMedia({ id: ID, storage_path: supa, mime_type: 'audio/ogg', size_bytes: '1', is_private: true });
        db.addMedia({ id: ID2, storage_path: `r2:${supa}`, mime_type: 'audio/ogg', size_bytes: '1', is_private: true });
        const store = both('r2');
        assert.equal((await store.get(ID, { privateFor: CREATOR }))!.data.toString(), 's');
        assert.equal((await store.get(ID2, { privateFor: CREATOR }))!.data.toString(), 'r');
        assert.equal(await store.get(ID2), null, 'a private row is still not served publicly');
        assert.equal(stores.r2Calls().length, 1, 'and that refusal fetched nothing');
    });

    it('is a 503 (MediaStorageUnavailableError) when the row\'s backend is not set up here, never a read from the other', async () => {
        db.addMedia({ id: ID, storage_path: publicSupabase, size_bytes: '1' });
        db.addMedia({ id: ID2, storage_path: publicR2, size_bytes: '1' });
        const onlySupabase = new ObjectMediaStore({ supabase: supabaseCfg });
        await assert.rejects(onlySupabase.get(ID2), (e: unknown) => e instanceof MediaStorageUnavailableError && e.backend === 'r2' && /Cloudflare R2/.test(e.message));
        await assert.rejects(onlySupabase.open(ID2), MediaStorageUnavailableError);
        const onlyR2 = new ObjectMediaStore({ r2: r2Cfg });
        await assert.rejects(onlyR2.get(ID), (e: unknown) => e instanceof MediaStorageUnavailableError && e.backend === 'supabase');
        assert.equal(stores.seen.length, 0, 'nothing was asked of either');
    });

    it('streams an R2 row with a Range as 206, counts one Class B, and answers HEAD from the row without touching R2', async () => {
        stores.r2.set(`${CREATOR}/${ID2}.mp4`, { data: Buffer.from('0123456789'), contentType: 'video/mp4' });
        db.addMedia({ id: ID2, storage_path: publicR2, size_bytes: '10' });
        const store = both('r2');
        const head = await store.open(ID2, { headOnly: true });
        assert.equal(head && head.kind === 'stream' && head.size, 10);
        assert.equal(stores.seen.length, 0);
        assert.deepEqual(db.counters('2026-11'), { a: 0, b: 0 });

        const part = await store.open(ID2, { range: 'bytes=2-5' });
        assert.ok(part && part.kind === 'stream' && part.range);
        assert.deepEqual(part.range, { start: 2, end: 5, total: 10 });
        assert.equal(stores.r2Calls().at(-1)!.headers['range'], 'bytes=2-5');
        assert.equal(db.counters('2026-11').b, 50, 'a batch of reads was reserved for it');
        (part as any).body.destroy();
    });

    it('refuses to read R2 once Class B is used up, without sending the request (the route answers 503)', async () => {
        db.setCounters('2026-11', 0, 9_000_000);
        stores.r2.set(`${CREATOR}/${ID2}.mp4`, { data: BYTES, contentType: 'video/mp4' });
        db.addMedia({ id: ID2, storage_path: publicR2, size_bytes: String(BYTES.length) });
        await assert.rejects(both('r2').open(ID2), (e: unknown) => e instanceof R2LimitError && e.kind === 'class_b');
        await assert.rejects(both('r2').get(ID2), R2LimitError);
        assert.equal(stores.seen.length, 0, 'not one request reached Cloudflare');
        assert.ok(logged.includes('media.r2_limit_reached'));
    });

    it('refuses to read R2 when the counter cannot be read', async () => {
        db.addMedia({ id: ID2, storage_path: publicR2, size_bytes: '1' });
        db.failOn = /^INSERT INTO app_settings \(key, value, is_secret, updated_at\) SELECT/;
        await assert.rejects(both('r2').open(ID2), R2CounterError);
        assert.equal(stores.seen.length, 0);
    });

    it('still serves Supabase rows while R2 is used up: the limits are R2\'s', async () => {
        db.setCounters('2026-11', 900_000, 9_000_000);
        stores.supabase.set(`${MEDIA_BUCKET}/${publicSupabase}`, { data: BYTES, contentType: 'video/mp4' });
        db.addMedia({ id: ID, storage_path: publicSupabase, size_bytes: String(BYTES.length) });
        assert.ok(await both('r2').get(ID));
    });

    it('bucketForPath and isR2Path tell the three places apart', () => {
        assert.equal(bucketForPath(publicR2), 'r2');
        assert.equal(bucketForPath(`r2:private/${CREATOR}/${ID}.ogg`), 'r2');
        assert.equal(bucketForPath(`private/${CREATOR}/${ID}.ogg`), PRIVATE_MEDIA_BUCKET);
        assert.equal(bucketForPath(publicSupabase), MEDIA_BUCKET);
        assert.equal(isR2Path(publicR2), true);
        assert.equal(isR2Path(publicSupabase), false);
        assert.equal(isR2Path(null), false);
        assert.equal(r2KeyOf(publicR2), `${CREATOR}/${ID2}.mp4`);
    });
});

describe('put to the chosen backend', () => {
    it('R2: an `r2:` path in the row, the key in R2, data NULL, one Class A', async () => {
        const { id } = await both('r2').put({ creatorId: CREATOR, filename: 'a.mp4', mimeType: 'video/mp4', data: BYTES });
        const row = db.media.get(id)!;
        assert.equal(row.storage_path, `r2:${CREATOR}/${id}.mp4`);
        assert.equal(row.data, null);
        assert.equal(row.size_bytes, String(BYTES.length));
        assert.deepEqual(stores.r2.get(`${CREATOR}/${id}.mp4`)!.data, BYTES);
        assert.equal(stores.supabaseCalls().length, 0, 'Supabase was not touched');
        assert.deepEqual(db.counters('2026-11'), { a: 1, b: 0 });
        assert.equal(row.storage_path, `r2:${objectPathFor(CREATOR, id, 'video/mp4')}`);
    });

    it('R2, a customer\'s file: `r2:private/…`, is_private, in the same bucket', async () => {
        const { id } = await both('r2').put({ creatorId: CREATOR, filename: 'v.ogg', mimeType: 'audio/ogg', data: BYTES, private: true });
        const row = db.media.get(id)!;
        assert.equal(row.storage_path, `r2:private/${CREATOR}/${id}.ogg`);
        assert.equal(row.is_private, true);
        assert.ok(stores.r2.has(`private/${CREATOR}/${id}.ogg`));
    });

    it('Supabase: unchanged, a plain path and the bucket check first', async () => {
        const { id } = await both('supabase').put({ creatorId: CREATOR, filename: 'a.mp4', mimeType: 'video/mp4', data: BYTES });
        assert.equal(db.media.get(id)!.storage_path, `${CREATOR}/${id}.mp4`);
        assert.equal(stores.r2Calls().length, 0, 'R2 was not touched');
    });

    it('with no object store taking new uploads it is Postgres, as ever', async () => {
        const { id } = await new ObjectMediaStore({ supabase: supabaseCfg, writesTo: null }).put({ creatorId: CREATOR, filename: 'a.jpg', mimeType: 'image/jpeg', data: BYTES });
        assert.equal(db.media.get(id)!.storage_path, null);
        assert.deepEqual(db.media.get(id)!.data, BYTES);
        assert.equal(stores.seen.length, 0);
    });

    it('is REFUSED, and nothing is written, when the file would pass R2\'s storage limit', async () => {
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 100, class_a: 10, class_b: 10 }));
        db.addMedia({ id: ID, storage_path: `r2:${CREATOR}/${ID}.mp4`, size_bytes: '90' });
        await assert.rejects(both('r2').put({ creatorId: CREATOR, filename: 'a.mp4', mimeType: 'video/mp4', data: BYTES }), (e: unknown) => {
            assert.ok(e instanceof R2LimitError);
            assert.equal(e.kind, 'storage');
            assert.equal(e.code, 'R2_LIMIT');
            return true;
        });
        assert.equal(stores.seen.length, 0, 'not uploaded');
        assert.equal(db.media.size, 1, 'no row');
    });

    it('is REFUSED when this month\'s Class A is used up', async () => {
        db.setCounters('2026-11', 900_000, 0);
        await assert.rejects(both('r2').put({ creatorId: CREATOR, filename: 'a.mp4', mimeType: 'video/mp4', data: BYTES }), (e: unknown) => e instanceof R2LimitError && e.kind === 'class_a');
        assert.equal(stores.seen.length, 0);
        assert.equal(db.media.size, 0);
    });

    it('takes the object back out of R2 when its row cannot be written', async () => {
        db.failOn = /^INSERT INTO media_uploads/;
        await assert.rejects(both('r2').put({ creatorId: CREATOR, filename: 'a.mp4', mimeType: 'video/mp4', data: BYTES }), /connection to the database was lost/);
        assert.equal(stores.r2.size, 0, 'no orphan');
    });
});

describe('the deletion sweep routes each path to its own backend', () => {
    it('sends `r2:` keys (prefix stripped) to R2 and the rest to their Supabase buckets, then clears the queue', async () => {
        db.configureSupabase();
        db.configureR2();
        const pub = `${CREATOR}/${ID}.mp4`;
        const priv = `private/${CREATOR}/${ID}.ogg`;
        stores.supabase.set(`${MEDIA_BUCKET}/${pub}`, { data: BYTES, contentType: 'video/mp4' });
        stores.supabase.set(`${PRIVATE_MEDIA_BUCKET}/${priv}`, { data: BYTES, contentType: 'audio/ogg' });
        stores.r2.set(`${CREATOR}/${ID2}.mp4`, { data: BYTES, contentType: 'video/mp4' });
        stores.r2.set(priv, { data: BYTES, contentType: 'audio/ogg' });
        for (const p of [pub, priv, `r2:${CREATOR}/${ID2}.mp4`, `r2:${priv}`]) db.queue.set(p, { attempts: 0, last_error: null });

        assert.deepEqual(await removeQueuedMediaObjects(), { removed: 4, failed: 0, skipped: false });
        assert.equal(stores.r2.size, 0);
        assert.equal(stores.supabase.size, 0);
        assert.equal(db.queue.size, 0);
        const del = stores.r2Calls().filter((c) => c.method === 'POST');
        assert.equal(del.length, 1, 'one DeleteObjects request');
        assert.match(del[0]!.body!.toString(), new RegExp(`<Key>${CREATOR}/${ID2}\\.mp4</Key>`));
        assert.ok(!/r2:/.test(del[0]!.body!.toString()), 'the prefix is not part of the key');
        assert.deepEqual(db.counters('2026-11'), { a: 0, b: 0 }, 'deleting is free');
    });

    it('leaves R2 entries waiting (not failed) while R2 is not set up, and still removes the Supabase ones', async () => {
        db.configureSupabase();
        db.queue.set(`${CREATOR}/${ID}.mp4`, { attempts: 0, last_error: null });
        db.queue.set(`r2:${CREATOR}/${ID2}.mp4`, { attempts: 0, last_error: null });
        assert.deepEqual(await removeQueuedMediaObjects(), { removed: 1, failed: 0, skipped: false });
        assert.deepEqual([...db.queue.keys()], [`r2:${CREATOR}/${ID2}.mp4`]);
        assert.equal(db.queue.get(`r2:${CREATOR}/${ID2}.mp4`)!.attempts, 0);
    });

    it('keeps the entries of a backend that refuses, counted, and clears the other\'s', async () => {
        db.configureSupabase();
        db.configureR2();
        stores.r2Mode = 'signature';
        db.queue.set(`${CREATOR}/${ID}.mp4`, { attempts: 0, last_error: null });
        db.queue.set(`r2:${CREATOR}/${ID2}.mp4`, { attempts: 0, last_error: null });
        assert.deepEqual(await removeQueuedMediaObjects(), { removed: 1, failed: 1, skipped: false });
        assert.equal(db.queue.get(`r2:${CREATOR}/${ID2}.mp4`)!.attempts, 1);
        assert.match(db.queue.get(`r2:${CREATOR}/${ID2}.mp4`)!.last_error!, /Cloudflare R2 refused to delete files/);
    });
});

describe('signed uploads work with R2', () => {
    const BASE_URL = async () => BASE;

    it('the Mac worker\'s reel: an `r2:` row with the declared size, a presigned PUT to R2, one Class A', async () => {
        setMediaStore(both('r2'));
        const answer = await signWorkerUpload(CREATOR, { filename: 'reel.mp4', mime_type: 'video/mp4', size_bytes: 5_000_000 }, BASE_URL);
        const url = new URL(answer.upload.url);
        assert.equal(url.host, R2_HOST);
        assert.equal(url.searchParams.get('X-Amz-Expires'), '7200');
        assert.deepEqual(answer.upload.headers, { 'content-type': 'video/mp4' });
        assert.equal(answer.url, `${BASE}/api/uploads/${answer.id}`, 'still our own URL: Meta and TikTok are never handed R2\'s');
        const row = db.media.get(answer.id)!;
        assert.equal(row.storage_path, `r2:${CREATOR}/${answer.id}.mp4`);
        assert.equal(row.size_bytes, '5000000');
        assert.equal(row.data, null);
        assert.deepEqual(db.counters('2026-11'), { a: 1, b: 0 });
        assert.equal(stores.seen.length, 0, 'signing sends nothing');
    });

    it('is refused with R2_LIMIT, and no row is written, when the declared size would pass the storage limit', async () => {
        setMediaStore(both('r2'));
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 1_000_000, class_a: 10, class_b: 10 }));
        await assert.rejects(signWorkerUpload(CREATOR, { filename: 'reel.mp4', mime_type: 'video/mp4', size_bytes: 5_000_000 }, BASE_URL), (e: unknown) => {
            assert.ok(e instanceof StudioError);
            assert.equal(e.status, 409);
            assert.equal(e.code, 'R2_LIMIT');
            assert.match(e.message, /free storage is full/);
            return true;
        });
        assert.equal(db.media.size, 0);
        assert.deepEqual(db.counters('2026-11'), { a: 0, b: 0 }, 'and nothing was counted for a signature that was not made');
    });

    it('is refused the same way when Class A is used up', async () => {
        setMediaStore(both('r2'));
        db.setCounters('2026-11', 900_000, 0);
        await assert.rejects(signWorkerUpload(CREATOR, { filename: 'reel.mp4', mime_type: 'video/mp4', size_bytes: 5_000 }, BASE_URL), (e: unknown) => e instanceof StudioError && e.code === 'R2_LIMIT');
        assert.equal(db.media.size, 0);
    });

    it('is 503 when the counter cannot be read', async () => {
        setMediaStore(both('r2'));
        db.failOn = /^INSERT INTO app_settings \(key, value, is_secret, updated_at\) SELECT/;
        await assert.rejects(signWorkerUpload(CREATOR, { filename: 'reel.mp4', mime_type: 'video/mp4', size_bytes: 5_000 }, BASE_URL), (e: unknown) => e instanceof StudioError && e.status === 503);
    });

    it('the browser\'s ad media: the same presigned PUT, and R2_LIMIT as an ads refusal', async () => {
        setMediaStore(both('r2'));
        const ok = await signAdUpload(CREATOR, { filename: 'ad.mp4', mime: 'video/mp4', size: 2_000_000 }, BASE);
        assert.equal(new URL(ok.upload.url).host, R2_HOST);
        assert.equal(db.media.get(ok.mediaId)!.storage_path, `r2:${CREATOR}/${ok.mediaId}.mp4`);
        assert.equal(ok.url, `${BASE}/api/uploads/${ok.mediaId}`);

        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 2_500_000, class_a: 10, class_b: 10 }));
        await assert.rejects(signAdUpload(CREATOR, { filename: 'ad2.mp4', mime: 'video/mp4', size: 1_000_000 }, BASE), (e: unknown) => e instanceof AdsError && e.status === 409 && e.code === 'R2_LIMIT');
    });

    it('says "Supabase Storage or Cloudflare R2" when new uploads go to neither', async () => {
        setMediaStore(new PostgresMediaStore());
        await assert.rejects(signWorkerUpload(CREATOR, { filename: 'reel.mp4', mime_type: 'video/mp4', size_bytes: 5_000 }, BASE_URL), (e: unknown) => e instanceof StudioError && e.status === 409 && /Supabase Storage or Cloudflare R2/.test(e.message));
        await assert.rejects(signAdUpload(CREATOR, { filename: 'ad.mp4', mime: 'video/mp4', size: 5_000 }, BASE), (e: unknown) => e instanceof AdsError && e.status === 409 && /Supabase Storage or Cloudflare R2/.test(e.message));
    });
});

describe('checkRenderFiles with R2 files', () => {
    const exec = { query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) } as any;
    const RID = '2b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';

    it('heads each R2 file, and passes one that arrived at its declared size', async () => {
        setMediaStore(both('r2'));
        stores.r2.set(`${CREATOR}/${RID}.mp4`, { data: BYTES, contentType: 'video/mp4' });
        db.addMedia({ id: RID, storage_path: `r2:${CREATOR}/${RID}.mp4`, size_bytes: String(BYTES.length) });
        await checkRenderFiles(exec, CREATOR, [[RID, 'video/mp4', 'video_url']]);
        assert.equal(stores.r2Calls().at(-1)!.method, 'HEAD');
    });

    it('rejects an R2 file that never arrived, and one whose real size is over what was declared', async () => {
        setMediaStore(both('r2'));
        db.addMedia({ id: RID, storage_path: `r2:${CREATOR}/${RID}.mp4`, size_bytes: '5' });
        await assert.rejects(checkRenderFiles(exec, CREATOR, [[RID, 'video/mp4', 'video_url']]), /was signed but its file never arrived/);
        stores.r2.set(`${CREATOR}/${RID}.mp4`, { data: BYTES, contentType: 'video/mp4' });
        await assert.rejects(checkRenderFiles(exec, CREATOR, [[RID, 'video/mp4', 'video_url']]), /was signed for 5 bytes but R2 holds 16/);
    });

    it('is R2_LIMIT, not a 500, when Class B is used up', async () => {
        setMediaStore(both('r2'));
        db.setCounters('2026-11', 0, 9_000_000);
        db.addMedia({ id: RID, storage_path: `r2:${CREATOR}/${RID}.mp4`, size_bytes: '5' });
        await assert.rejects(checkRenderFiles(exec, CREATOR, [[RID, 'video/mp4', 'video_url']]), (e: unknown) => e instanceof StudioError && e.status === 409 && e.code === 'R2_LIMIT');
    });

    it('still checks Supabase files through Supabase, in the same call', async () => {
        setMediaStore(both('r2'));
        const SID = '3b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
        stores.supabase.set(`${MEDIA_BUCKET}/${CREATOR}/${SID}.mp4`, { data: BYTES, contentType: 'video/mp4' });
        db.addMedia({ id: SID, storage_path: `${CREATOR}/${SID}.mp4`, size_bytes: String(BYTES.length) });
        await assert.rejects(checkRenderFiles(exec, CREATOR, [[SID, 'video/mp4', 'video_url']]), /Supabase|signed but|asked/, 'the fake Supabase does not answer HEAD: it is asked, not R2');
        assert.equal(stores.r2Calls().length, 0);
    });
});
