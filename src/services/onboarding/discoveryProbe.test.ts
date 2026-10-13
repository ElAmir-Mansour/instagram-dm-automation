/**
 * What the Business Discovery probe prints, and which account the platform reads with. The report is pasted into a PR, so what is
 * pinned is what it must NEVER contain: a value from the answer, an id, a cursor, the token.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    EXPECTED_MEDIA_FIELDS, EXPECTED_PROFILE_FIELDS, formatProbeReport, pickDiscoveryCreatorId, presenceAcross, shapeOf, summariseProbeBody,
} from './discoveryProbe.js';
import { GULF } from './fixtures/captions.js';
import { PLATFORM_IG_ID, PLATFORM_TOKEN, SHOP_HANDLE, discoveryBody, graphMedia, mediaFrom } from './fixtures/instagram.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('pickDiscoveryCreatorId', () => {
    it('is the saved tenant, else the owner', () => {
        assert.equal(pickDiscoveryCreatorId(OTHER, OWNER), OTHER);
        assert.equal(pickDiscoveryCreatorId(null, OWNER), OWNER);
        assert.equal(pickDiscoveryCreatorId(undefined, OWNER), OWNER);
        assert.equal(pickDiscoveryCreatorId('  ', OWNER), OWNER);
    });

    it('ignores a saved value that is not a tenant id, so a typo falls back to the owner and not to nothing', () => {
        for (const bad of ['owner', '123', `${OTHER}x`, 'DROP TABLE creators', "'; --"]) assert.equal(pickDiscoveryCreatorId(bad, OWNER), OWNER, bad);
    });

    it('lower-cases, trims, and is null with neither', () => {
        assert.equal(pickDiscoveryCreatorId(` ${OTHER.toUpperCase()} `, null), OTHER);
        assert.equal(pickDiscoveryCreatorId(null, null), null);
        assert.equal(pickDiscoveryCreatorId('nope', 'also nope'), null);
    });
});

describe('shapeOf: a value as its type and size, never the value', () => {
    it('says string(len), number, boolean, null, array(n) and object(keys)', () => {
        assert.equal(shapeOf('نور'), 'string(len=3)');
        assert.equal(shapeOf('😀😀'), 'string(len=2)', 'characters, not UTF-16 units');
        assert.equal(shapeOf(12_400), 'number');
        assert.equal(shapeOf(true), 'boolean');
        assert.equal(shapeOf(null), 'null');
        assert.equal(shapeOf([1, 2, 3]), 'array(n=3)');
        assert.equal(shapeOf({ a: 1, b: 2 }), 'object(keys=2)');
    });
});

describe('presenceAcross', () => {
    it('counts, for each field, the items that carry it, with its types and the span of its text lengths', () => {
        const rows = presenceAcross([{ a: 'xx', b: 1 }, { a: 'xxxx' }, { a: null, c: true }], ['a', 'b', 'z']);
        const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
        assert.deepEqual(byName.a, { name: 'a', present: 2, total: 3, types: ['string'], lengths: { min: 2, max: 4 } });
        assert.deepEqual(byName.b, { name: 'b', present: 1, total: 3, types: ['number'], lengths: null });
        assert.equal(byName.z!.present, 0);
        assert.equal(byName.c!.present, 1, 'a field nobody asked for is still reported');
    });
});

describe('summariseProbeBody', () => {
    it('lists the fields that came back, and which asked-for ones did not', () => {
        const s = summariseProbeBody(discoveryBody());
        assert.equal(s.ok, true);
        assert.deepEqual(s.missingProfile, []);
        assert.equal(s.media!.items, GULF.length);
        assert.deepEqual(s.otherKeys, ['id']);
        const names = s.profile.map((p) => p.name);
        for (const field of EXPECTED_PROFILE_FIELDS) assert.ok(names.includes(field), field);
    });

    it('notices a profile with no website, and posts with no view count and hidden likes', () => {
        const media = [graphMedia(1, GULF[0]!, { like_count: undefined }), graphMedia(2, GULF[1]!, { like_count: undefined }), graphMedia(3, GULF[2]!)];
        const s = summariseProbeBody(discoveryBody({ website: null, media }));
        assert.deepEqual(s.missingProfile, ['website']);
        const like = s.media!.fields.find((f) => f.name === 'like_count')!;
        assert.deepEqual([like.present, like.total], [1, 3]);
        assert.deepEqual(s.missingMedia, ['view_count']);
    });

    it('is not ok for an answer with no business_discovery', () => {
        const s = summariseProbeBody({ id: PLATFORM_IG_ID });
        assert.equal(s.ok, false);
        assert.deepEqual(s.otherKeys, ['id']);
        assert.equal(summariseProbeBody(null).ok, false);
    });
});

describe('formatProbeReport', () => {
    const report = (result: Parameters<typeof formatProbeReport>[0]['result']) =>
        formatProbeReport({ handle: SHOP_HANDLE, graphVersion: 'v26.0', askingAccountIdLength: PLATFORM_IG_ID.length, result }).join('\n');

    it('says which fields came back, with counts and lengths, and gives a verdict', () => {
        const out = report({ ok: true, body: discoveryBody({ media: mediaFrom(GULF, (i) => (i === 2 ? { like_count: undefined } : {})) }), requests: 1, ms: 412 });
        assert.match(out, /handle\s+noor\.perfumes/);
        assert.match(out, /graph version\s+v26\.0/);
        assert.match(out, /HTTP requests\s+1 · 412 ms/);
        assert.match(out, /biography\s+string\(len=\d+\)/);
        assert.match(out, /followers_count\s+number/);
        assert.match(out, /media: 6 items/);
        assert.match(out, /like_count\s+5\/6\s+number/);
        assert.match(out, /caption\s+6\/6\s+string len \d+\.\.\d+/);
        assert.match(out, /VERDICT: works\./);
    });

    it('holds no value from the answer: no bio, no caption, no website, no count, no id, no cursor, no link', () => {
        const body = discoveryBody();
        const out = report({ ok: true, body, requests: 1, ms: 10 });
        const bd = body.business_discovery as Record<string, unknown>;
        const values = [
            bd.biography, bd.website, String(bd.followers_count), String(bd.media_count), PLATFORM_IG_ID, 'QVFIUjBBYWF', 'QVFIUlhEeWo', 'pfp-of-the-owner',
            ...(bd.media as { data: Array<Record<string, unknown>> }).data.flatMap((m) => [m.caption, m.id, m.permalink, m.timestamp].map(String)),
        ].map(String);
        for (const value of values) assert.ok(!out.includes(value), `the report must not print ${JSON.stringify(value.slice(0, 30))}`);
        assert.ok(!out.includes('12400') && !out.includes('12,400'));
    });

    it('prints the HTTP status and the Graph code of a failure, and Meta\'s words with the token taken out', () => {
        const out = report({
            ok: false, requests: 1, ms: 90,
            failure: { code: 110, subcode: null, status: 400, message: 'Invalid user id' },
        });
        assert.match(out, /result\s+FAILED/);
        assert.match(out, /HTTP status\s+400/);
        assert.match(out, /Graph code\s+110/);
        assert.match(out, /classified as\s+not_readable/);
        assert.match(out, /VERDICT: not working/);
        const leaky = report({ ok: false, requests: 1, ms: 1, failure: { code: 190, subcode: 463, status: 400, message: `Invalid OAuth access token - Cannot parse access token ${PLATFORM_TOKEN}` } });
        assert.ok(!leaky.includes(PLATFORM_TOKEN), 'a token that Meta echoed is not printed');
        assert.match(leaky, /Graph code\s+190 · subcode 463/);
    });

    it('says plainly when Meta answers 200 with no profile', () => {
        const out = report({ ok: true, body: { id: PLATFORM_IG_ID }, requests: 1, ms: 5 });
        assert.match(out, /HTTP 200 but no business_discovery/);
        assert.match(out, /VERDICT: no profile returned/);
        assert.ok(!out.includes(PLATFORM_IG_ID));
    });

    it('says "partly works" when a profile field is missing', () => {
        const out = report({ ok: true, body: discoveryBody({ website: null }), requests: 1, ms: 5 });
        assert.match(out, /VERDICT: partly works\..*website/);
    });

    it('asks for exactly the fields the draft asks for', () => {
        assert.deepEqual([...EXPECTED_MEDIA_FIELDS], ['id', 'caption', 'media_type', 'media_product_type', 'timestamp', 'permalink', 'like_count', 'comments_count', 'view_count']);
        assert.deepEqual([...EXPECTED_PROFILE_FIELDS], ['username', 'biography', 'website', 'followers_count', 'media_count', 'media']);
    });
});
