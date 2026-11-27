import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProfileError } from '../profile/store.js';
import { MediaStorageUnavailableError } from '../storage.js';
import { R2LimitError } from '../r2Usage.js';
import { checkLogoUpload, type LogoCheckDeps, type LogoRow } from './logoCheck.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ID = '6f1c2a90-3b7e-4d21-9a55-0c8e7d4b1f23';
const NOW = new Date('2026-12-01T09:30:00.000Z');

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]): number[] => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
/** A PNG's header and chunk list, with no real pixels: all the server ever reads. */
function png(width: number, height: number, colourType = 6, extra: number[][] = []): Uint8Array {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(width), ...u32(height), 8, colourType, 0, 0, 0]), ...extra.flat(), ...chunk('IDAT', [1, 2]), ...chunk('IEND', [])]);
}

const claim = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    url: `https://preview-abc.vercel.app/api/uploads/${ID}`, width: 1200, height: 400, alpha: true, tone: 'dark', colour: '#0e3b5c', ...over,
});

interface Setup { row?: Partial<LogoRow> | null; bytes?: Uint8Array | null; base?: string | null; readRowThrows?: unknown; readBytesThrows?: unknown }
function deps(s: Setup = {}): LogoCheckDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        readRow: async (id) => {
            calls.push(`row:${id}`);
            if (s.readRowThrows) throw s.readRowThrows;
            if (s.row === null) return null;
            return { creator_id: TENANT, mime_type: 'image/png', size_bytes: 9000, is_private: false, ...s.row };
        },
        readBytes: async (id) => {
            calls.push(`bytes:${id}`);
            if (s.readBytesThrows) throw s.readBytesThrows;
            return s.bytes === undefined ? png(1200, 400) : s.bytes;
        },
        publicBase: async () => (s.base === undefined ? 'https://msg-response-auto.vercel.app' : s.base),
        now: () => NOW,
    };
}

async function refusal(promise: Promise<unknown>): Promise<ProfileError> {
    try {
        await promise;
    } catch (err) {
        assert.ok(err instanceof ProfileError, `a ProfileError, got ${String(err)}`);
        return err;
    }
    throw new Error('expected a refusal');
}

describe('checkLogoUpload: what it returns', () => {
    it('the asset the profile will hold: canonical URL, the file\'s size, upper-case colour, added_at from the clock', async () => {
        const out = await checkLogoUpload(TENANT, claim(), deps());
        assert.deepEqual(out, {
            url: `https://msg-response-auto.vercel.app/api/uploads/${ID}`, width: 1200, height: 400, alpha: true, tone: 'dark', colour: '#0E3B5C', added_at: '2026-12-01T09:30:00.000Z',
        });
    });

    it('the canonical URL is on the saved public base, not the host the upload was made on', async () => {
        const out = await checkLogoUpload(TENANT, claim(), deps({ base: 'https://app.example.com' }));
        assert.equal(out.url, `https://app.example.com/api/uploads/${ID}`);
    });

    it('with no saved base, the claim\'s own origin is kept', async () => {
        const out = await checkLogoUpload(TENANT, claim(), deps({ base: null }));
        assert.equal(out.url, `https://preview-abc.vercel.app/api/uploads/${ID}`);
    });

    it('width and height come from the file; the claim is ignored', async () => {
        const out = await checkLogoUpload(TENANT, claim({ width: 1000, height: 1000 }), deps({ bytes: png(800, 640) }));
        assert.equal(out.width, 800);
        assert.equal(out.height, 640);
    });

    it('alpha is forced off for colour types 0 and 2 without tRNS, and kept for 6 and for a tRNS', async () => {
        assert.equal((await checkLogoUpload(TENANT, claim(), deps({ bytes: png(800, 600, 2) }))).alpha, false);
        assert.equal((await checkLogoUpload(TENANT, claim(), deps({ bytes: png(800, 600, 0) }))).alpha, false);
        assert.equal((await checkLogoUpload(TENANT, claim(), deps({ bytes: png(800, 600, 6) }))).alpha, true);
        assert.equal((await checkLogoUpload(TENANT, claim(), deps({ bytes: png(800, 600, 2, [chunk('tRNS', [0, 0, 0, 0, 0, 0])]) }))).alpha, true);
        // A browser that says it is opaque stays opaque, whatever the file could hold.
        assert.equal((await checkLogoUpload(TENANT, claim({ alpha: false }), deps({ bytes: png(800, 600, 6) }))).alpha, false);
    });

    it('a tenant id in another case is the same tenant', async () => {
        await checkLogoUpload(TENANT.toUpperCase(), claim(), deps());
    });
});

describe('checkLogoUpload: every problem is one machine code', () => {
    const codeOf = async (claimOver: Record<string, unknown>, s: Setup): Promise<[string, number, string[] | undefined]> => {
        const err = await refusal(checkLogoUpload(TENANT, claim(claimOver), deps(s)));
        return [err.code, err.status, err.detail.problems];
    };

    it('no row: logo.not_found', async () => assert.deepEqual(await codeOf({}, { row: null }), ['BRAND_LOGO_INVALID', 400, ['logo.not_found']]));
    it('no bytes: logo.not_found', async () => assert.deepEqual(await codeOf({}, { bytes: null }), ['BRAND_LOGO_INVALID', 400, ['logo.not_found']]));
    it('another tenant\'s upload: logo.not_yours', async () => assert.deepEqual(await codeOf({}, { row: { creator_id: OTHER } }), ['BRAND_LOGO_INVALID', 400, ['logo.not_yours']]));
    it('an upload with no tenant: logo.not_yours', async () => assert.deepEqual(await codeOf({}, { row: { creator_id: null } }), ['BRAND_LOGO_INVALID', 400, ['logo.not_yours']]));
    it('a private upload: logo.private', async () => assert.deepEqual(await codeOf({}, { row: { is_private: true } }), ['BRAND_LOGO_INVALID', 400, ['logo.private']]));
    it('a row that is not image/png: logo.not_png', async () => assert.deepEqual(await codeOf({}, { row: { mime_type: 'image/jpeg' } }), ['BRAND_LOGO_INVALID', 400, ['logo.not_png']]));
    it('a row that says png over bytes that are not: logo.not_png', async () => {
        assert.deepEqual(await codeOf({}, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }), ['BRAND_LOGO_INVALID', 400, ['logo.not_png']]);
        assert.deepEqual(await codeOf({}, { bytes: new Uint8Array([1, 2, 3]) }), ['BRAND_LOGO_INVALID', 400, ['logo.not_png']]);
    });
    it('over 3,000,000 bytes: logo.too_big', async () => {
        const big = new Uint8Array(3_000_001);
        big.set(png(1200, 400));
        assert.deepEqual(await codeOf({}, { bytes: big }), ['BRAND_LOGO_INVALID', 400, ['logo.too_big']]);
    });
    it('short side under 200 in the file: logo.too_small', async () => assert.deepEqual(await codeOf({}, { bytes: png(1200, 199) }), ['BRAND_LOGO_INVALID', 400, ['logo.too_small']]));
    it('long side over 4096 in the file: logo.too_large', async () => assert.deepEqual(await codeOf({}, { bytes: png(4097, 1000) }), ['BRAND_LOGO_INVALID', 400, ['logo.too_large']]));
    it('aspect outside 1:4 to 8:1 in the file: logo.aspect', async () => {
        assert.deepEqual(await codeOf({}, { bytes: png(2000, 200) }), ['BRAND_LOGO_INVALID', 400, ['logo.aspect']]);
        assert.deepEqual(await codeOf({}, { bytes: png(200, 1000) }), ['BRAND_LOGO_INVALID', 400, ['logo.aspect']]);
    });
    it('the limits themselves pass: 200 px, 4096 px, 8:1 and 1:4', async () => {
        await checkLogoUpload(TENANT, claim(), deps({ bytes: png(1600, 200) }));
        await checkLogoUpload(TENANT, claim(), deps({ bytes: png(200, 800) }));
        await checkLogoUpload(TENANT, claim(), deps({ bytes: png(4096, 4096) }));
    });
});

describe('checkLogoUpload: a claim that is the wrong shape reads nothing', () => {
    it('is a 400 with the shape problems, before any row or file is read', async () => {
        const d = deps();
        const err = await refusal(checkLogoUpload(TENANT, { url: 'https://x.example/not-an-upload', width: 1200, height: 400, alpha: 'yes', tone: 'grey', colour: 'blue' }, d));
        assert.equal(err.code, 'BRAND_LOGO_INVALID');
        assert.equal(err.status, 400);
        assert.ok(err.detail.problems!.length >= 4);
        assert.ok(err.detail.problems!.some((p) => /url must be one of your uploads/.test(p)));
        assert.deepEqual(d.calls, []);
    });

    it('a claim that is not an object, or has an unknown key, or a url with .jpg', async () => {
        for (const bad of [null, 'x', [1], claim({ extra: 1 }), claim({ url: `https://a.example/api/uploads/${ID}.jpg` }), claim({ width: 12.5 })]) {
            const d = deps();
            const err = await refusal(checkLogoUpload(TENANT, bad, d));
            assert.equal(err.code, 'BRAND_LOGO_INVALID');
            assert.deepEqual(d.calls, []);
        }
    });
});

describe('checkLogoUpload: storage that cannot be read is a 503, not a verdict on the logo', () => {
    const unreadable = async (s: Setup): Promise<void> => {
        const err = await refusal(checkLogoUpload(TENANT, claim(), deps(s)));
        assert.equal(err.code, 'BRAND_LOGO_UNREADABLE');
        assert.equal(err.status, 503);
        assert.deepEqual(err.detail.problems, ['logo.unreadable']);
        assert.match(err.message, /couldn't read your logo just now/);
    };

    it('an R2 allowance used up', async () => unreadable({ readBytesThrows: new R2LimitError('class_b', 9_000_000, 9_000_000) }));
    it('storage not configured for the file', async () => unreadable({ readBytesThrows: new MediaStorageUnavailableError(ID, 'r2') }));
    it('a network error', async () => unreadable({ readBytesThrows: new Error('ECONNRESET') }));
    it('the row\'s own read failing', async () => unreadable({ readRowThrows: new Error('connection terminated') }));
});
