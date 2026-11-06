/**
 * AWS Signature Version 4, for S3-compatible object stores (Cloudflare R2). Pure: `node:crypto` and nothing else, no network, no clock
 * unless asked. The one place this app signs a request.
 *
 * What it follows (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html, "Authenticating Requests: Using the
 * Authorization Header" and "…Using Query Parameters"):
 *
 *   canonical request  METHOD \n URI \n QUERY \n HEADERS \n SIGNED-HEADERS \n PAYLOAD-HASH
 *   string to sign     AWS4-HMAC-SHA256 \n <yyyymmddThhmmssZ> \n <scope> \n hex(sha256(canonical request))
 *   signing key        HMAC chain over "AWS4"+secret, date, region, service, "aws4_request"
 *
 * S3 differences from the generic SigV4: the canonical URI is each path segment URI-encoded ONCE (never twice), and the payload hash is
 * either the body's SHA-256 or the literal `UNSIGNED-PAYLOAD` (what a presigned URL uses, because the bytes are not known when it is made).
 *
 * `awsSigV4.test.ts` reproduces AWS's own published examples (the GET with a Range header, the PUT of `test$file.text`, the `?lifecycle`
 * GET and the presigned GET) signature for signature, so the signing is proven against the documentation rather than assumed.
 */
import { createHash, createHmac } from 'node:crypto';

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface SigV4Credentials {
    accessKeyId: string;
    secretAccessKey: string;
}

export interface SigV4Scope {
    region: string;
    service: string;
}

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

export const hashPayload = (data: string | Uint8Array): string => sha256Hex(data);

/** URI-encode one component by AWS's rules: everything but `A-Za-z0-9-_.~` is `%XX` in upper case. */
export function uriEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A path made of segments, each encoded once, `/` kept: `/bucket/a b/c$d` → `/bucket/a%20b/c%24d`. */
export function encodePath(path: string): string {
    return path.split('/').map(uriEncode).join('/');
}

/** `yyyymmddThhmmssZ`. */
export function amzDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function canonicalQuery(query: Readonly<Record<string, string>>): string {
    return Object.entries(query)
        .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
        .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
        .map(([name, value]) => `${name}=${value}`)
        .join('&');
}

function signingKey(secret: string, day: string, scope: SigV4Scope): Buffer {
    return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), scope.region), scope.service), 'aws4_request');
}

interface SignInput extends SigV4Credentials, SigV4Scope {
    method: string;
    /** The path as the key space sees it, NOT encoded: `/bucket/some key.mp4`. */
    path: string;
    query?: Readonly<Record<string, string>>;
    now: Date;
}

function canonicalAndSign(input: SignInput, canonicalHeaders: string, signedHeaders: string, payloadHash: string, query: Readonly<Record<string, string>>): {
    signature: string; credential: string;
} {
    const stamp = amzDate(input.now);
    const day = stamp.slice(0, 8);
    const scope = `${day}/${input.region}/${input.service}/aws4_request`;
    const canonical = [input.method.toUpperCase(), encodePath(input.path), canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const toSign = [SIGV4_ALGORITHM, stamp, scope, sha256Hex(canonical)].join('\n');
    return {
        signature: createHmac('sha256', signingKey(input.secretAccessKey, day, input)).update(toSign, 'utf8').digest('hex'),
        credential: `${input.accessKeyId}/${scope}`,
    };
}

export interface HeaderSignInput extends SignInput {
    /**
     * Every header to sign, names in any case. Must include `host`. `x-amz-date` (and `x-amz-content-sha256` when `payloadHash` is set and
     * `signPayloadHeader` is not false) are added here, so the caller does not.
     */
    headers: Readonly<Record<string, string>>;
    /** The body's SHA-256 (hex) or `UNSIGNED-PAYLOAD`. */
    payloadHash: string;
    /** Send `x-amz-content-sha256` too: S3 requires it. Defaults to true. AWS's own example sets it itself, so its test passes false. */
    addPayloadHeader?: boolean;
}

/** The headers to send (the ones given, plus `x-amz-date`, `x-amz-content-sha256` and `Authorization`). */
export function signHeaders(input: HeaderSignInput): Record<string, string> {
    const all: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers)) all[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
    if (input.addPayloadHeader !== false) all['x-amz-content-sha256'] = input.payloadHash;
    if (!all['x-amz-date']) all['x-amz-date'] = amzDate(input.now);
    if (!all['host']) throw new Error('signHeaders: a host header is required.');
    const names = Object.keys(all).sort();
    const canonicalHeaders = names.map((name) => `${name}:${all[name]}\n`).join('');
    const signedHeaders = names.join(';');
    const { signature, credential } = canonicalAndSign(input, canonicalHeaders, signedHeaders, input.payloadHash, input.query ?? {});
    return { ...all, authorization: `${SIGV4_ALGORITHM} Credential=${credential},SignedHeaders=${signedHeaders},Signature=${signature}` };
}

export interface PresignInput extends SignInput {
    host: string;
    /** Seconds the URL stays valid, 1 to 604800. */
    expiresSeconds: number;
}

/**
 * A presigned URL's query string (everything after `?`, `X-Amz-Signature` last): only `host` is signed and the payload is unsigned, so the
 * holder can send any body and any other header. `query` carries parameters of the request itself, signed with the rest.
 */
export function presignQuery(input: PresignInput): string {
    if (!Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > 604_800) {
        throw new Error('presignQuery: expiresSeconds must be 1 to 604800.');
    }
    const stamp = amzDate(input.now);
    const day = stamp.slice(0, 8);
    const credential = `${input.accessKeyId}/${day}/${input.region}/${input.service}/aws4_request`;
    const query: Record<string, string> = {
        ...(input.query ?? {}),
        'X-Amz-Algorithm': SIGV4_ALGORITHM,
        'X-Amz-Credential': credential,
        'X-Amz-Date': stamp,
        'X-Amz-Expires': String(input.expiresSeconds),
        'X-Amz-SignedHeaders': 'host',
    };
    const { signature } = canonicalAndSign(input, `host:${input.host}\n`, 'host', UNSIGNED_PAYLOAD, query);
    return `${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}
