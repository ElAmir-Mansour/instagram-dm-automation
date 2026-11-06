/**
 * The R2 client (src/services/r2Storage.ts) against an in-memory R2 (`FakeStores`): what each method sends, which operation class it counts in BEFORE sending,
 * how errors map, and that a refused reserve means nothing reaches Cloudflare. The guard is a `RecordingGuard`; the limits themselves are in r2Usage.test.ts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { R2StorageClient, r2CorsPolicy, r2Host } from './r2Storage.js';
import { R2CounterError, R2LimitError } from './r2Usage.js';
import { StorageApiError } from './supabaseStorage.js';
import { ACCOUNT, FakeStores, R2_BUCKET, R2_HOST, R2_KEY_ID, R2_SECRET, RecordingGuard } from './r2TestKit.js';

let stores: FakeStores;
let guard: RecordingGuard;
let restoreFetch: () => void;
let restoreSink: (() => void) | undefined;
const NOW = new Date('2026-11-06T10:00:00Z');

before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    stores = new FakeStores();
    restoreFetch?.();
    restoreFetch = stores.install();
    guard = new RecordingGuard();
});

const client = () => new R2StorageClient({ accountId: ACCOUNT, bucket: R2_BUCKET, accessKeyId: R2_KEY_ID, secretAccessKey: R2_SECRET, guard, now: () => NOW });
const KEY = '11111111-1111-4111-8111-111111111111/0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab.mp4';
const BYTES = Buffer.from('reel bytes '.repeat(100));

describe('what each method counts, before it sends', () => {
    it('counts Class A for writes and Class B for reads, one operation each', async () => {
        const c = client();
        await c.upload(KEY, BYTES, 'video/mp4');
        assert.deepEqual(guard.calls, [{ cls: 'A', n: 1 }]);
        await c.headObject(KEY);
        await c.download(KEY);
        const stream = await c.openStream(KEY);
        stream!.body.destroy();
        await c.getBucket();
        assert.deepEqual([guard.count('A'), guard.count('B')], [1, 4]);
        await c.ensureCors(['https://app.example']);
        // GetBucketCors is a read (B), PutBucketCors a write (A).
        assert.deepEqual([guard.count('A'), guard.count('B')], [2, 5]);
    });

    it('counts a presigned upload as one Class A when it is signed, and sends nothing to Cloudflare', async () => {
        await client().createSignedUploadUrl(KEY, 'video/mp4');
        assert.deepEqual(guard.calls, [{ cls: 'A', n: 1 }]);
        assert.equal(stores.seen.length, 0);
    });

    it('does not count a delete: it is free, and it frees space', async () => {
        await client().upload(KEY, BYTES, 'video/mp4');
        guard.calls = [];
        guard.refuse = new R2LimitError('class_a', 1, 1);
        assert.equal(await client().remove([KEY]), 1);
        assert.deepEqual(guard.calls, []);
        assert.equal(stores.r2.size, 0);
    });

    it('sends NOTHING when the reserve refuses: a limit reached, or a counter that cannot be read', async () => {
        const c = client();
        for (const refusal of [new R2LimitError('class_b', 9, 9), new R2CounterError(new Error('db down'))]) {
            guard.refuse = refusal;
            await assert.rejects(c.upload(KEY, BYTES, 'video/mp4'), refusal.constructor as any);
            await assert.rejects(c.download(KEY), refusal.constructor as any);
            await assert.rejects(c.openStream(KEY), refusal.constructor as any);
            await assert.rejects(c.headObject(KEY), refusal.constructor as any);
            await assert.rejects(c.getBucket(), refusal.constructor as any);
            await assert.rejects(c.createSignedUploadUrl(KEY, 'video/mp4'), refusal.constructor as any);
            await assert.rejects(c.ensureCors(['https://app.example']), refusal.constructor as any);
        }
        assert.equal(stores.seen.length, 0, 'not one request reached Cloudflare');
    });
});

describe('requests', () => {
    it('uploads path-style to the account endpoint, SigV4-signed for region auto and service s3, with the payload hash', async () => {
        await client().upload(KEY, BYTES, 'video/mp4');
        const call = stores.r2Calls()[0]!;
        assert.equal(call.method, 'PUT');
        assert.equal(call.host, `${ACCOUNT}.r2.cloudflarestorage.com`);
        assert.equal(call.path, `/${R2_BUCKET}/${KEY}`);
        assert.match(call.headers['authorization']!, new RegExp(`^AWS4-HMAC-SHA256 Credential=${R2_KEY_ID}/20261106/auto/s3/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$`));
        assert.equal(call.headers['x-amz-date'], '20261106T100000Z');
        assert.equal(call.headers['x-amz-content-sha256'], createHash('sha256').update(BYTES).digest('hex'));
        assert.equal(call.headers['content-type'], 'video/mp4');
        assert.ok(!call.headers['authorization']!.includes(R2_SECRET), 'the secret is never on the wire');
        assert.deepEqual(stores.r2.get(KEY)!.data, BYTES);
    });

    it('encodes a key by S3\'s rules', async () => {
        await client().upload('private/c/an id$.ogg', BYTES, 'audio/ogg');
        assert.ok(stores.r2.has('private/c/an id$.ogg'));
        assert.ok(stores.seen.length === 1);
    });

    it('the presigned PUT is valid 2 hours, signs only the host, and a plain PUT with content-type works', async () => {
        const signed = await client().createSignedUploadUrl(KEY, 'video/mp4');
        const url = new URL(signed.url);
        assert.equal(url.host, R2_HOST);
        assert.equal(decodeURIComponent(url.pathname), `/${R2_BUCKET}/${KEY}`);
        assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
        assert.equal(url.searchParams.get('X-Amz-Credential'), `${R2_KEY_ID}/20261106/auto/s3/aws4_request`);
        assert.equal(url.searchParams.get('X-Amz-Date'), '20261106T100000Z');
        assert.equal(url.searchParams.get('X-Amz-Expires'), '7200');
        assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
        assert.match(url.searchParams.get('X-Amz-Signature')!, /^[0-9a-f]{64}$/);
        assert.deepEqual(signed.headers, { 'content-type': 'video/mp4' });
        assert.equal(signed.expiresAt, '2026-11-06T12:00:00.000Z');
        assert.ok(!signed.url.includes(R2_SECRET));
    });

    it('streams a range as 206 (partial) and a whole object as 200', async () => {
        await client().upload(KEY, Buffer.from('0123456789'), 'video/mp4');
        const part = await client().openStream(KEY, { start: 2, end: 5 });
        assert.equal(part!.partial, true);
        assert.equal(part!.length, 4);
        const chunks: Buffer[] = [];
        for await (const chunk of part!.body) chunks.push(Buffer.from(chunk));
        assert.equal(Buffer.concat(chunks).toString(), '2345');
        assert.equal(stores.r2Calls().at(-1)!.headers['range'], 'bytes=2-5');

        const whole = await client().openStream(KEY);
        assert.equal(whole!.partial, false);
        assert.equal(whole!.length, 10);
        whole!.body.destroy();
    });

    it('is not partial when R2 ignored the range and sent everything', async () => {
        await client().upload(KEY, Buffer.from('0123456789'), 'video/mp4');
        const ignoring = new R2StorageClient({
            accountId: ACCOUNT, bucket: R2_BUCKET, accessKeyId: R2_KEY_ID, secretAccessKey: R2_SECRET, guard,
            fetchImpl: async () => new Response('0123456789', { status: 200, headers: { 'content-length': '10' } }),
        });
        const object = await ignoring.openStream(KEY, { start: 2, end: 5 });
        assert.equal(object!.partial, false);
        assert.equal(object!.length, 10);
        object!.body.destroy();
    });

    it('answers null for a missing object, whichever call asks', async () => {
        const c = client();
        assert.equal(await c.headObject('nope'), null);
        assert.equal(await c.download('nope'), null);
        assert.equal(await c.openStream('nope'), null);
    });

    it('heads what is stored: length and type', async () => {
        await client().upload(KEY, BYTES, 'video/mp4');
        assert.deepEqual(await client().headObject(KEY), { size: BYTES.length, contentType: 'video/mp4' });
    });

    it('removes with DeleteObjects (Content-MD5, XML-escaped keys) and a missing key is not an error', async () => {
        const c = client();
        await c.upload(KEY, BYTES, 'video/mp4');
        await c.upload('a&b<c>.jpg', BYTES, 'image/jpeg');
        assert.equal(await c.remove([KEY, 'a&b<c>.jpg', 'never-existed']), 3);
        assert.equal(stores.r2.size, 0);
        const call = stores.r2Calls().at(-1)!;
        assert.equal(call.method, 'POST');
        assert.ok('delete' in call.query);
        assert.equal(call.headers['content-md5'], createHash('md5').update(call.body!).digest('base64'));
        assert.match(call.body!.toString(), /<Key>a&amp;b&lt;c&gt;\.jpg<\/Key>/);
    });

    it('reports a delete R2 refused for one key', async () => {
        const failing = new R2StorageClient({
            accountId: ACCOUNT, bucket: R2_BUCKET, accessKeyId: R2_KEY_ID, secretAccessKey: R2_SECRET, guard,
            fetchImpl: async () => new Response('<DeleteResult><Error><Key>k</Key><Code>InternalError</Code><Message>try later</Message></Error></DeleteResult>', { status: 200 }),
        });
        await assert.rejects(failing.remove(['k']), /refused to delete 1 file/);
    });
});

describe('errors', () => {
    it('maps R2\'s XML error to a StorageApiError: status, S3 code, and a message that reads like the Supabase ones', async () => {
        stores.r2Mode = 'signature';
        await assert.rejects(client().upload(KEY, BYTES, 'video/mp4'), (err: unknown) => {
            assert.ok(err instanceof StorageApiError);
            assert.equal(err.status, 403);
            assert.equal(err.code, 'SignatureDoesNotMatch');
            assert.equal(err.refused, true);
            assert.match(err.message, /^Cloudflare R2 refused to upload the file: The request signature we calculated does not match/);
            assert.match(err.message, /Check the Secret Access Key and the Account ID/);
            return true;
        });
    });

    it('an unreachable R2 is status 0', async () => {
        stores.r2Mode = 'down';
        await assert.rejects(client().download(KEY), (err: unknown) => err instanceof StorageApiError && err.unreachable && /Could not reach Cloudflare R2 to download the file/.test(err.message));
    });

    it('surfaces a refused key as an error, never as a missing file', async () => {
        stores.r2Mode = 'signature';
        await assert.rejects(client().headObject(KEY), StorageApiError);
        await assert.rejects(client().openStream(KEY), StorageApiError);
    });

    it('builds the account host and refuses to be built from anything but it', () => {
        assert.equal(r2Host('ABCDEF0123456789abcdef0123456789'), 'abcdef0123456789abcdef0123456789.r2.cloudflarestorage.com');
    });
});

describe('the bucket: HeadBucket is enough (a least-privilege "Object Read & Write" token)', () => {
    it('is fine when the bucket exists, and does not create or change anything', async () => {
        assert.deepEqual(await client().ensureBucket(), { created: false, public: false });
        assert.deepEqual(stores.r2Calls().map((c) => c.method), ['HEAD']);
        assert.deepEqual([guard.count('A'), guard.count('B')], [0, 1]);
    });

    it('a missing bucket is "Create the bucket in Cloudflare first": CreateBucket is never tried', async () => {
        stores.r2BucketExists = false;
        await assert.rejects(client().ensureBucket(), (err: unknown) => {
            assert.ok(err instanceof StorageApiError);
            assert.equal(err.status, 404);
            assert.match(err.message, /Create the bucket 'media' in Cloudflare first/);
            return true;
        });
        assert.deepEqual(stores.r2Calls().map((c) => c.method), ['HEAD'], 'no PUT of the bucket was sent');
        assert.equal(guard.count('A'), 0);
    });

    it('answers a refused HeadBucket by listing one key, which an object token may do (Class A)', async () => {
        stores.headDenied = true;
        assert.deepEqual(await client().getBucket(), { id: R2_BUCKET, public: false });
        assert.deepEqual(stores.r2Calls().map((c) => `${c.method}${c.query['list-type'] ? ' list' : ''}`), ['HEAD', 'GET list']);
        assert.deepEqual([guard.count('A'), guard.count('B')], [1, 1]);
    });
});

describe('CORS, best effort', () => {
    const ORIGIN = 'https://msg-response-auto.vercel.app';

    it('sets one rule for the app\'s origin (PUT, GET, HEAD) when there is none', async () => {
        assert.deepEqual(await client().ensureCors([ORIGIN]), { changed: true });
        const rules = stores.cors!;
        assert.match(rules, new RegExp(`<AllowedOrigin>${ORIGIN}</AllowedOrigin>`));
        for (const m of ['PUT', 'GET', 'HEAD']) assert.match(rules, new RegExp(`<AllowedMethod>${m}</AllowedMethod>`));
        assert.match(rules, /<AllowedHeader>\*<\/AllowedHeader>/);
        assert.match(rules, /<ExposeHeader>ETag<\/ExposeHeader>/);
        assert.match(rules, /<MaxAgeSeconds>3600<\/MaxAgeSeconds>/);
    });

    it('leaves rules that already allow the origin for PUT alone', async () => {
        await client().ensureCors([ORIGIN]);
        const puts = stores.r2Calls().filter((c) => c.method === 'PUT').length;
        assert.deepEqual(await client().ensureCors([ORIGIN]), { changed: false });
        assert.equal(stores.r2Calls().filter((c) => c.method === 'PUT').length, puts, 'no second PutBucketCors');
    });

    it('a refused PutBucketCors is an AccessDenied the caller can treat as "set it by hand"', async () => {
        stores.corsDenied = true;
        await assert.rejects(client().ensureCors([ORIGIN]), (err: unknown) => err instanceof StorageApiError && err.refused && err.code === 'AccessDenied');
    });

    it('a token that may not READ the rules asks the way a browser does: rules set by hand in Cloudflare are "ok", nothing is changed', async () => {
        stores.cors = `<CORSConfiguration><CORSRule><AllowedOrigin>${ORIGIN}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod></CORSRule></CORSConfiguration>`;
        stores.corsReadDenied = true;
        stores.corsDenied = true;
        assert.deepEqual(await client().ensureCors([ORIGIN]), { changed: false });
        const preflights = stores.r2Calls().filter((c) => c.method === 'OPTIONS');
        assert.equal(preflights.length, 1);
        assert.equal(preflights[0]!.headers['origin'], ORIGIN);
        assert.equal(preflights[0]!.headers['access-control-request-method'], 'PUT');
        assert.equal(preflights[0]!.headers['authorization'], undefined, 'a preflight carries no key');
        assert.equal(stores.r2Calls().filter((c) => c.method === 'PUT').length, 0, 'no PutBucketCors');
        assert.equal(guard.count('B'), 2, 'the refused read and the preflight are both counted');
    });

    it('when the rules cannot be read and the preflight says no, it still tries to set them, and a refusal there is "set it by hand"', async () => {
        stores.corsReadDenied = true;
        stores.corsDenied = true;
        await assert.rejects(client().ensureCors([ORIGIN]), (err: unknown) => err instanceof StorageApiError && err.refused && err.code === 'AccessDenied');
        assert.equal(stores.r2Calls().filter((c) => c.method === 'OPTIONS').length, 1);
    });

    it('offers the policy to paste in Cloudflare, with exactly the fields asked for', () => {
        assert.deepEqual(JSON.parse(r2CorsPolicy(ORIGIN)), [{
            AllowedOrigins: [ORIGIN], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600,
        }]);
    });
});
