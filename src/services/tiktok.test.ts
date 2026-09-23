/**
 * Every outbound TikTok call and every rule around them, against a stubbed HTTP client.
 *
 * Same stance as instagram.test.ts: `tiktokHttp` is replaced for the whole file with stubs that
 * throw on anything a test did not arrange, so nothing here can upload to a real account. What
 * these tests can prove without TikTok is the request shape — endpoint, body, headers — and the
 * pure rules: how a file is cut into chunks, how a webhook signature is checked, how TikTok's
 * string error codes are classified.
 */
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import {
    buildAuthorizeUrl, describeFailReason, exchangeCode, fetchPublishStatus, initInboxVideoUpload,
    isTikTokReauthError, mapPublishState, MAX_CHUNK_BYTES, parseJsonKeepingIds, parseWebhookEvent, planChunks,
    refreshTokens, SPLIT_CHUNK_BYTES, TIKTOK_API_BASE, TikTokApiError, tiktokHttp, toTikTokError,
    uploadChunks, verifyTikTokSignature,
} from './tiktok.js';

const MB = 1024 * 1024;

interface Recorded { method: 'post' | 'get' | 'put'; url: string; body: any; config: any }
let calls: Recorded[] = [];
let onPost: (url: string, body: any, config: any) => Promise<any>;
let onPut: (url: string, body: any, config: any) => Promise<any>;
let onGet: (url: string, config: any) => Promise<any>;

const original = { post: tiktokHttp.post, put: tiktokHttp.put, get: tiktokHttp.get };

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    calls = [];
    onPost = async (url) => { throw new Error(`no POST arranged for ${url}`); };
    onPut = async (url) => { throw new Error(`no PUT arranged for ${url}`); };
    onGet = async (url) => { throw new Error(`no GET arranged for ${url}`); };
    (tiktokHttp as any).post = (url: string, body: any, config: any) => {
        calls.push({ method: 'post', url, body, config });
        return onPost(url, body, config);
    };
    (tiktokHttp as any).put = (url: string, body: any, config: any) => {
        calls.push({ method: 'put', url, body, config });
        return onPut(url, body, config);
    };
    (tiktokHttp as any).get = (url: string, config: any) => {
        calls.push({ method: 'get', url, body: undefined, config });
        return onGet(url, config);
    };
});

afterEach(() => {
    (tiktokHttp as any).post = original.post;
    (tiktokHttp as any).put = original.put;
    (tiktokHttp as any).get = original.get;
});

/** An axios-shaped rejection carrying a TikTok v2 envelope. */
function apiError(status: number, code: string, message = code) {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, data: { error: { code, message, log_id: 'log-1' } } },
    });
}

describe('planChunks', () => {
    it('sends a small reel as exactly one chunk, which TikTok requires under 5MB', () => {
        // The promo reels are 2.9–4.6MB. TikTok's own 4MB example: video_size = chunk_size,
        // total_chunk_count = 1, Content-Range bytes 0-(size-1)/size.
        const plan = planChunks(4_642_294);
        assert.equal(plan.chunkSize, 4_642_294);
        assert.equal(plan.totalChunkCount, 1);
        assert.deepEqual(plan.ranges, [{ start: 0, end: 4_642_293 }]);
    });

    it('keeps a file of exactly 64MB whole', () => {
        const plan = planChunks(MAX_CHUNK_BYTES);
        assert.equal(plan.totalChunkCount, 1);
    });

    it('splits a larger file with the remainder riding on the final chunk', () => {
        const size = 100 * MB + 123;
        const plan = planChunks(size);

        // total_chunk_count = floor(video_size / chunk_size) — TikTok's formula, not ceil.
        assert.equal(plan.chunkSize, SPLIT_CHUNK_BYTES);
        assert.equal(plan.totalChunkCount, Math.floor(size / SPLIT_CHUNK_BYTES));
        const last = plan.ranges.at(-1)!;
        assert.equal(last.end, size - 1, 'the final chunk must end on the last byte');
        assert.ok(last.end - last.start + 1 <= 128 * MB, 'the final chunk may not exceed 128MB');

        // Contiguous, no gaps, no overlap.
        for (let i = 1; i < plan.ranges.length; i++) {
            assert.equal(plan.ranges[i]!.start, plan.ranges[i - 1]!.end + 1);
        }
    });

    it('refuses an empty file and anything over TikTok’s 4GB ceiling', () => {
        assert.throws(() => planChunks(0));
        assert.throws(() => planChunks(4 * 1024 * MB + 1));
    });
});

describe('verifyTikTokSignature', () => {
    const secret = 'client-secret-xyz';
    const body = JSON.stringify({ event: 'post.publish.inbox_delivered', content: '{"publish_id":"p1"}' });
    const sign = (t: string, payload: string, key = secret) =>
        crypto.createHmac('sha256', key).update(`${t}.${payload}`).digest('hex');

    it('accepts a signature over "<t>.<raw body>"', () => {
        const header = `t=1633174587,s=${sign('1633174587', body)}`;
        assert.equal(verifyTikTokSignature(header, Buffer.from(body), secret), true);
    });

    it('rejects a body changed after signing', () => {
        const header = `t=1633174587,s=${sign('1633174587', body)}`;
        assert.equal(verifyTikTokSignature(header, Buffer.from(body.replace('p1', 'p2')), secret), false);
    });

    it('rejects a different timestamp, a different secret, and a malformed header', () => {
        const s = sign('1633174587', body);
        assert.equal(verifyTikTokSignature(`t=1633174588,s=${s}`, body, secret), false);
        assert.equal(verifyTikTokSignature(`t=1633174587,s=${sign('1633174587', body, 'other')}`, body, secret), false);
        assert.equal(verifyTikTokSignature('garbage', body, secret), false);
        assert.equal(verifyTikTokSignature(undefined, body, secret), false);
        assert.equal(verifyTikTokSignature(`t=1,s=${s}`, body, ''), false, 'no secret configured is never valid');
    });
});

describe('buildAuthorizeUrl', () => {
    it('carries the client key, the comma-joined scopes, the exact redirect URI and the state', () => {
        const url = new URL(buildAuthorizeUrl({
            clientKey: 'awkey123', redirectUri: 'https://app.example/api/tiktok/callback', state: 'st-1',
        }));
        assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
        assert.equal(url.searchParams.get('client_key'), 'awkey123');
        assert.equal(url.searchParams.get('response_type'), 'code');
        assert.equal(url.searchParams.get('scope'), 'user.info.basic,video.upload');
        assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/api/tiktok/callback');
        assert.equal(url.searchParams.get('state'), 'st-1');
    });
});

describe('TikTok error handling', () => {
    it('keeps the string code from a v2 envelope and words the common ones', () => {
        const err = toTikTokError('TikTok upload init', apiError(403, 'spam_risk_too_many_pending_share'));
        assert.ok(err instanceof TikTokApiError);
        assert.equal(err.code, 'spam_risk_too_many_pending_share');
        assert.match(err.message, /5 unposted inbox drafts/);
        assert.equal(err.logId, 'log-1');
    });

    it('reads the OAuth endpoints’ different shape: a bare error string', () => {
        const err = toTikTokError('TikTok token refresh', {
            response: { status: 400, data: { error: 'invalid_grant', error_description: 'expired' } },
        });
        assert.ok(err instanceof TikTokApiError);
        assert.equal(err.code, 'invalid_grant');
        assert.equal(isTikTokReauthError(err), true);
    });

    it('treats only connection-level codes as "reconnect"', () => {
        assert.equal(isTikTokReauthError(new TikTokApiError('x', 'access_token_invalid')), true);
        assert.equal(isTikTokReauthError(new TikTokApiError('x', 'rate_limit_exceeded')), false);
        assert.equal(isTikTokReauthError(new Error('network')), false);
    });
});

describe('exchangeCode / refreshTokens', () => {
    it('posts a form-encoded code exchange and computes both expiries', async () => {
        onPost = async () => ({
            status: 200,
            data: {
                access_token: 'act.1', refresh_token: 'rft.1', open_id: 'open-1',
                scope: 'user.info.basic,video.upload', expires_in: 86400, refresh_expires_in: 31536000,
                token_type: 'Bearer',
            },
        });

        const now = 1_700_000_000_000;
        const tokens = await exchangeCode(
            { clientKey: 'ck', clientSecret: 'cs', code: 'the-code', redirectUri: 'https://a/cb' },
            () => now
        );

        assert.equal(calls[0]!.url, `${TIKTOK_API_BASE}/v2/oauth/token/`);
        assert.equal(calls[0]!.config.headers['Content-Type'], 'application/x-www-form-urlencoded');
        const form = new URLSearchParams(calls[0]!.body);
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('code'), 'the-code');
        assert.equal(form.get('redirect_uri'), 'https://a/cb');
        assert.equal(tokens.openId, 'open-1');
        assert.deepEqual(tokens.scopes, ['user.info.basic', 'video.upload']);
        assert.equal(tokens.accessExpiresAt.getTime(), now + 86400 * 1000);
        assert.equal(tokens.refreshExpiresAt.getTime(), now + 31536000 * 1000);
    });

    it('surfaces a 200 that carries an OAuth error rather than parsing it as tokens', async () => {
        onPost = async () => ({ status: 200, data: { error: 'invalid_grant', error_description: 'bad' } });
        const err = await refreshTokens({ clientKey: 'ck', clientSecret: 'cs', refreshToken: 'r' }).then(() => null, (e) => e);
        assert.ok(err instanceof TikTokApiError);
        assert.equal(err.code, 'invalid_grant');
    });

    it('is not retried — a refresh token may have rotated server-side on the first try', async () => {
        onPost = async () => { throw apiError(500, 'internal_error'); };
        await refreshTokens({ clientKey: 'ck', clientSecret: 'cs', refreshToken: 'r' }).catch(() => undefined);
        assert.equal(calls.length, 1);
    });
});

describe('initInboxVideoUpload', () => {
    const plan = planChunks(3 * MB);
    const okInit = async () => ({
        status: 200,
        data: { data: { publish_id: 'v_inbox_file~v2.1', upload_url: 'https://open-upload.tiktokapis.com/u/1' }, error: { code: 'ok' } },
    });

    it('asks for a FILE_UPLOAD inbox share sized exactly as planned', async () => {
        onPost = okInit;
        const init = await initInboxVideoUpload('act.1', plan);

        assert.equal(calls[0]!.url, `${TIKTOK_API_BASE}/v2/post/publish/inbox/video/init/`);
        assert.deepEqual(calls[0]!.body, {
            source_info: { source: 'FILE_UPLOAD', video_size: 3 * MB, chunk_size: 3 * MB, total_chunk_count: 1 },
        });
        assert.equal(calls[0]!.config.headers.Authorization, 'Bearer act.1');
        assert.equal(init.publishId, 'v_inbox_file~v2.1');
        assert.equal(init.captionSent, false);
    });

    it('sends the caption as post_info.title, and falls back without it if TikTok refuses the body', async () => {
        let n = 0;
        onPost = async () => {
            n++;
            if (n === 1) throw apiError(400, 'invalid_params');
            return okInit();
        };
        const init = await initInboxVideoUpload('act.1', plan, 'تعلم الذكاء الاصطناعي #AI');

        assert.deepEqual(calls[0]!.body.post_info, { title: 'تعلم الذكاء الاصطناعي #AI' });
        assert.equal(calls[1]!.body.post_info, undefined, 'the retry must drop post_info');
        assert.equal(init.captionSent, false);
    });

    it('does NOT retry any other failure — a 5xx may already have spent one of five daily drafts', async () => {
        onPost = async () => { throw apiError(500, 'internal_error'); };
        const err = await initInboxVideoUpload('act.1', plan, 'caption').then(() => null, (e) => e);
        assert.ok(err);
        assert.equal(calls.length, 1);
    });

    it('treats a 200 whose envelope is not "ok" as the failure it is', async () => {
        onPost = async () => ({ status: 200, data: { data: {}, error: { code: 'spam_risk_too_many_posts', message: 'x' } } });
        const err = await initInboxVideoUpload('act.1', plan).then(() => null, (e) => e);
        assert.ok(err instanceof TikTokApiError);
        assert.equal(err.code, 'spam_risk_too_many_posts');
    });
});

describe('uploadChunks', () => {
    it('PUTs each chunk in order with a Content-Range TikTok can check', async () => {
        onPut = async () => ({ status: 201, data: '' });
        const data = Buffer.alloc(3 * MB, 7);
        await uploadChunks('https://open-upload.tiktokapis.com/u/1', data, 'video/mp4', planChunks(data.length));

        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'put');
        assert.equal(calls[0]!.config.headers['Content-Type'], 'video/mp4');
        assert.equal(calls[0]!.config.headers['Content-Range'], `bytes 0-${3 * MB - 1}/${3 * MB}`);
        assert.equal(calls[0]!.config.headers['Content-Length'], String(3 * MB));
        assert.equal((calls[0]!.body as Buffer).length, 3 * MB);
    });

    it('refuses to upload when the bytes do not match the plan TikTok was told about', async () => {
        await assert.rejects(uploadChunks('u', Buffer.alloc(10), 'video/mp4', planChunks(11)));
        assert.equal(calls.length, 0);
    });
});

describe('fetchPublishStatus / mapPublishState', () => {
    it('reads TikTok’s misspelled post-id field without rounding the int64', async () => {
        // The incident this guards: TikTok sends the id as a JSON number, and JSON.parse turns
        // 7300000000000000001 into 7300000000000000000 — a different video's id.
        onPost = async () => ({
            status: 200,
            data: '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001],"uploaded_bytes":10},"error":{"code":"ok"}}',
        });
        const status = await fetchPublishStatus('act.1', 'p1');
        assert.equal(calls[0]!.url, `${TIKTOK_API_BASE}/v2/post/publish/status/fetch/`);
        assert.deepEqual(calls[0]!.body, { publish_id: 'p1' });
        assert.equal(status.status, 'PUBLISH_COMPLETE');
        assert.deepEqual(status.postIds, ['7300000000000000001']);
    });

    it('keeps ids exact in parseJsonKeepingIds, and leaves every other number alone', () => {
        const parsed = parseJsonKeepingIds('{"post_id":7300000000000000001,"uploaded_bytes":12345678901234567,"n":1}');
        assert.equal(parsed.post_id, '7300000000000000001');
        assert.equal(typeof parsed.uploaded_bytes, 'number', 'only id fields are quoted');
        assert.equal(parsed.n, 1);
    });

    it('maps the inbox lifecycle onto the scheduled_posts vocabulary', () => {
        assert.equal(mapPublishState('PROCESSING_UPLOAD'), 'PROCESSING');
        assert.equal(mapPublishState('SEND_TO_USER_INBOX'), 'IN_INBOX');
        // Inbox mode: TikTok reports this once the creator taps the notification and posts.
        assert.equal(mapPublishState('PUBLISH_COMPLETE'), 'PUBLISHED');
        assert.equal(mapPublishState('FAILED'), 'FAILED');
        assert.equal(mapPublishState('SOMETHING_NEW'), null, 'an unknown state must not move the row');
    });

    it('words a fail reason for the card, and never returns an empty string', () => {
        assert.match(describeFailReason('frame_rate_check_failed'), /23 and 60 fps/);
        assert.match(describeFailReason('brand_new_reason'), /brand_new_reason/);
        assert.ok(describeFailReason(null).length > 0);
    });
});

describe('parseWebhookEvent', () => {
    it('parses `content`, which TikTok sends as a JSON string', () => {
        const event = parseWebhookEvent({
            client_key: 'ck', event: 'post.publish.failed', create_time: 1700000000, user_openid: 'open-1',
            content: '{"publish_id":"p1","reason":"file_format_check_failed"}',
        });
        assert.deepEqual(event, {
            event: 'post.publish.failed', openId: 'open-1', createTime: 1700000000,
            content: { publish_id: 'p1', reason: 'file_format_check_failed' },
        });
    });

    it('keeps a numeric post_id inside content exact', () => {
        const event = parseWebhookEvent({
            event: 'post.publish.publicly_available',
            content: '{"publish_id":"p1","post_id":7300000000000000001}',
        });
        assert.equal(event?.content.post_id, '7300000000000000001');
    });

    it('tolerates malformed content and rejects a body with no event', () => {
        assert.deepEqual(parseWebhookEvent({ event: 'x', content: '{not json' })?.content, {});
        assert.equal(parseWebhookEvent({ content: '{}' }), null);
        assert.equal(parseWebhookEvent(null), null);
    });
});
