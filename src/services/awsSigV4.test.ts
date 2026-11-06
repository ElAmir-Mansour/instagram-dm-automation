/**
 * SigV4 against AWS's own published S3 examples (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html and
 * sigv4-query-string-auth.html): the keys, dates and expected signatures below are the documentation's, not ours.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amzDate, encodePath, hashPayload, presignQuery, signHeaders, UNSIGNED_PAYLOAD, uriEncode } from './awsSigV4.js';

const AWS = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
};
const NOW = new Date('2013-05-24T00:00:00Z');
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const signatureOf = (headers: Record<string, string>) => /Signature=([0-9a-f]{64})$/.exec(headers.authorization!)![1];

describe('SigV4: AWS\'s published S3 examples', () => {
    it('GET Object with a Range header', () => {
        const headers = signHeaders({
            ...AWS, now: NOW, method: 'GET', path: '/test.txt', payloadHash: EMPTY_SHA,
            headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
        });
        assert.equal(headers.authorization,
            'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,'
            + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,'
            + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    });

    it('PUT Object: a `$` in the key is encoded once, and a body is signed by its hash', () => {
        const body = 'Welcome to Amazon S3.';
        assert.equal(hashPayload(body), '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
        const headers = signHeaders({
            ...AWS, now: NOW, method: 'PUT', path: '/test$file.text', payloadHash: hashPayload(body),
            headers: {
                host: 'examplebucket.s3.amazonaws.com', date: 'Fri, 24 May 2013 00:00:00 GMT',
                'x-amz-storage-class': 'REDUCED_REDUNDANCY',
            },
        });
        assert.match(headers.authorization!, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,/);
        assert.equal(signatureOf(headers), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    });

    it('GET Bucket lifecycle: a sub-resource with no value', () => {
        const headers = signHeaders({
            ...AWS, now: NOW, method: 'GET', path: '/', query: { lifecycle: '' }, payloadHash: EMPTY_SHA,
            headers: { host: 'examplebucket.s3.amazonaws.com' },
        });
        assert.equal(signatureOf(headers), 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
    });

    it('GET Bucket (List Objects): query parameters are sorted and encoded', () => {
        const headers = signHeaders({
            ...AWS, now: NOW, method: 'GET', path: '/', query: { prefix: 'J', 'max-keys': '2' }, payloadHash: EMPTY_SHA,
            headers: { host: 'examplebucket.s3.amazonaws.com' },
        });
        assert.equal(signatureOf(headers), '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
    });

    it('a presigned GET URL (query-string authentication, 86400 s)', () => {
        const query = presignQuery({
            ...AWS, now: NOW, method: 'GET', path: '/test.txt', host: 'examplebucket.s3.amazonaws.com', expiresSeconds: 86_400,
        });
        assert.equal(query,
            'X-Amz-Algorithm=AWS4-HMAC-SHA256'
            + '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'
            + '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host'
            + '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    });
});

describe('SigV4 helpers', () => {
    it('encodes by AWS\'s rules: unreserved kept, everything else %XX in upper case, `/` kept in a path', () => {
        assert.equal(uriEncode("a b/c!'()*~._-"), 'a%20b%2Fc%21%27%28%29%2A~._-');
        assert.equal(encodePath('/bucket/private/11111111/ab cd$.ogg'), '/bucket/private/11111111/ab%20cd%24.ogg');
        assert.equal(uriEncode('تم'), '%D8%AA%D9%85');
    });

    it('formats the date as AWS does', () => {
        assert.equal(amzDate(new Date('2026-11-06T09:08:07.654Z')), '20261106T090807Z');
    });

    it('refuses a lifetime AWS would, and a request with no host', () => {
        assert.throws(() => presignQuery({ ...AWS, now: NOW, method: 'PUT', path: '/k', host: 'h', expiresSeconds: 604_801 }));
        assert.throws(() => presignQuery({ ...AWS, now: NOW, method: 'PUT', path: '/k', host: 'h', expiresSeconds: 0 }));
        assert.throws(() => signHeaders({ ...AWS, now: NOW, method: 'GET', path: '/', payloadHash: UNSIGNED_PAYLOAD, headers: {} }));
    });
});
