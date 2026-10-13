/**
 * Reading a public YouTube channel for the draft over a fake Google (03 §1): handle to channel to recent titles, the key that decides
 * whether the source runs at all, the failures it names, and that the key is in no error, result or log line.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { inspect } from 'node:util';
import { setLogSink } from '../../utils/log.js';
import { YOUTUBE_API_BASE, youtubeHttp } from '../youtube.js';
import { YOUTUBE_TIMEOUT_MS, fetchYouTubeChannel } from './ytSource.js';
import { networkError, stubAxios, type Reply, type SeenRequest } from './fixtures/httpStub.js';
import { CHANNEL_ID, YT_KEY, channelsBody, googleDetailError, googleError, playlistBody, playlistItem } from './fixtures/instagram.js';

const withKey = async () => ({ key: YT_KEY });
const noKey = async () => null;

let restoreHttp: (() => void) | undefined;
let seen: SeenRequest[] = [];
let lines: string[] = [];
let restoreSink: (() => void) | undefined;

before(() => {
    const previous = setLogSink((_, line) => lines.push(line));
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
beforeEach(() => { lines = []; });
afterEach(() => restoreHttp?.());

/** A fake Google: `channels` and `playlistItems` answered by path. */
function google(routes: { channels?: Reply; playlistItems?: Reply } | ((call: SeenRequest) => Reply)): void {
    const stub = stubAxios(youtubeHttp, (call) => {
        if (typeof routes === 'function') return routes(call);
        const path = call.url.replace(`${YOUTUBE_API_BASE}/`, '');
        return (routes as Record<string, Reply>)[path] ?? { status: 500, data: { error: { message: `unexpected ${path}` } } };
    });
    seen = stub.seen;
    restoreHttp = stub.restore;
}

const ok = (data: unknown): Reply => ({ status: 200, data });

function assertNoKeyAnywhere(value: unknown): void {
    for (const text of [JSON.stringify(value), inspect(value, { depth: 12, showHidden: true })]) {
        assert.ok(!text.includes(YT_KEY) && !text.includes(YT_KEY.slice(0, 16)), 'the key is in the result');
    }
    for (const line of lines) assert.ok(!line.includes(YT_KEY) && !line.includes(YT_KEY.slice(0, 16)), `a log line holds the key: ${line.slice(0, 120)}`);
}

describe('fetchYouTubeChannel: the happy road', () => {
    it('looks the handle up, then reads the uploads playlist: two requests, one quota unit each', async () => {
        google({
            channels: ok(channelsBody()),
            playlistItems: ok(playlistBody([playlistItem(2, 'كيف تبدأ البرمجة', 'وصف الفيديو الأول هنا في هذه القناة'), playlistItem(1, 'Learn Python fast')])),
        });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });

        assert.equal(seen.length, 2);
        assert.equal(seen[0]!.method, 'GET');
        assert.equal(seen[0]!.url, `${YOUTUBE_API_BASE}/channels`);
        assert.deepEqual(seen[0]!.params, { part: 'snippet,brandingSettings,contentDetails,statistics', forHandle: '@barmaga-academy', key: YT_KEY });
        assert.equal(seen[1]!.url, `${YOUTUBE_API_BASE}/playlistItems`);
        assert.deepEqual(seen[1]!.params, { part: 'snippet', playlistId: 'UUabcdefghijklmnopqrstuv', maxResults: 15, key: YT_KEY });

        assert.ok(result.ok);
        assert.equal(result.value.via, 'api_key');
        assert.equal(result.value.title, 'أكاديمية البرمجة');
        assert.equal(result.value.country, 'SA');
        assert.deepEqual(result.value.videos.map((v) => v.title), ['كيف تبدأ البرمجة', 'Learn Python fast']);
        assert.equal(result.value.videosError, null);
    });

    it('takes a link or a channel id as well as a handle', async () => {
        google({ channels: ok(channelsBody()), playlistItems: ok(playlistBody([])) });
        await fetchYouTubeChannel('https://www.youtube.com/@Barmaga-Academy/videos', { getKey: withKey });
        assert.equal(seen[0]!.params.forHandle, '@Barmaga-Academy');
        restoreHttp?.();
        google({ channels: ok(channelsBody()), playlistItems: ok(playlistBody([])) });
        await fetchYouTubeChannel(CHANNEL_ID, { getKey: withKey });
        assert.equal(seen[0]!.params.id, CHANNEL_ID);
        assert.equal(seen[0]!.params.forHandle, undefined);
        restoreHttp?.();
        google({ channels: ok(channelsBody()), playlistItems: ok(playlistBody([])) });
        await fetchYouTubeChannel('https://www.youtube.com/user/GoogleDevelopers', { getKey: withKey });
        assert.equal(seen[0]!.params.forUsername, 'GoogleDevelopers');
    });

    it('asks each request to give up after 8 seconds, and passes the draft\'s deadline signal on', async () => {
        google({ channels: ok(channelsBody()), playlistItems: ok(playlistBody([])) });
        const controller = new AbortController();
        const sent: Array<{ timeout?: number; signal?: unknown }> = [];
        const original = youtubeHttp.defaults.adapter;
        youtubeHttp.defaults.adapter = async (config: any) => {
            sent.push({ timeout: config.timeout, signal: config.signal });
            return (original as any)(config);
        };
        try {
            await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey, signal: controller.signal });
        } finally {
            youtubeHttp.defaults.adapter = original;
        }
        assert.equal(YOUTUBE_TIMEOUT_MS, 8000);
        assert.ok(sent.length === 2 && sent.every((s) => s.timeout === 8000 && s.signal === controller.signal));
    });

    it('derives the uploads playlist from the channel id when the API does not give it', async () => {
        google({ channels: ok(channelsBody({ uploads: null })), playlistItems: ok(playlistBody([])) });
        await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.equal(seen[1]!.params.playlistId, 'UUabcdefghijklmnopqrstuv');
    });

    it('reads an English channel', async () => {
        google({
            channels: ok(channelsBody({ title: 'Ahmed Fit', description: 'Training plans for busy people.', customUrl: '@ahmedfit', country: 'US', defaultLanguage: 'en', keywords: 'fitness training' })),
            playlistItems: ok(playlistBody([playlistItem(1, 'The 20 minute workout', 'A short workout you can do at home before work, with no equipment needed.')])),
        });
        const result = await fetchYouTubeChannel('@ahmedfit', { getKey: withKey });
        assert.ok(result.ok);
        assert.equal(result.value.defaultLanguage, 'en');
        assert.equal(result.value.videos[0]!.title, 'The 20 minute workout');
    });
});

describe('fetchYouTubeChannel: no key means the source is skipped, not failed', () => {
    it('is `not_configured`, with no request, and says that YouTube is unavailable and how to fix it', async () => {
        google({ channels: ok(channelsBody()) });
        for (const getKey of [noKey, async () => ({ key: '' })]) {
            const result = await fetchYouTubeChannel('@barmaga-academy', { getKey });
            assert.ok(!result.ok);
            assert.equal(result.error.kind, 'not_configured');
            assert.equal(result.error.retryable, false);
            assert.equal(result.error.source, 'youtube');
            assert.match(result.error.message, /YouTube is unavailable.*API key/);
        }
        assert.equal(seen.length, 0);
        assert.ok(lines.some((l) => l.includes('onboarding.yt_source_skipped')));
    });

    it('is `upstream`, retryable, when the setting itself cannot be read, and never throws', async () => {
        google({ channels: ok(channelsBody()) });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: async () => { throw new Error('connection refused'); } });
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'upstream');
        assert.equal(result.error.retryable, true);
        assert.equal(seen.length, 0);
    });
});

describe('fetchYouTubeChannel: failures', () => {
    it('is `invalid_handle` for text that names no channel, with no request, even with a key', async () => {
        google({ channels: ok(channelsBody()) });
        for (const bad of ['', 'x', 'https://www.youtube.com/watch?v=abc', 'a b', 'https://evil.example/@barmaga']) {
            const result = await fetchYouTubeChannel(bad, { getKey: withKey });
            assert.ok(!result.ok, bad);
            assert.equal(result.error.kind, 'invalid_handle');
        }
        assert.equal(seen.length, 0);
    });

    it('is `not_found` for a handle nobody has: Google answers 200 with no items', async () => {
        google({ channels: ok({ kind: 'youtube#channelListResponse', pageInfo: { totalResults: 0, resultsPerPage: 5 } }) });
        const result = await fetchYouTubeChannel('@nobody-has-this', { getKey: withKey });
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'not_found');
        assert.equal(result.error.retryable, false);
        assert.equal(seen.length, 1, 'the playlist is not asked for');
    });

    it('is `no_access` for a key Google rejects, in either envelope, final', async () => {
        for (const data of [googleDetailError(400, 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID', 'INVALID_ARGUMENT'), googleError(400, 'API key not valid', 'keyInvalid'), googleError(403, 'YouTube Data API v3 has not been used in project 1 before or it is disabled.', 'accessNotConfigured')]) {
            google({ channels: { status: (data.error as any).code, data } });
            const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
            assert.ok(!result.ok);
            assert.equal(result.error.kind, 'no_access');
            assert.equal(result.error.retryable, false);
            restoreHttp?.();
        }
    });

    it('is `quota`, final, for the daily limit, and `rate_limited`, retryable, for a 429', async () => {
        google({ channels: { status: 403, data: googleError(403, 'The request cannot be completed because you have exceeded your quota.', 'quotaExceeded') } });
        const quota = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(!quota.ok);
        assert.equal(quota.error.kind, 'quota');
        assert.equal(quota.error.retryable, false);
        restoreHttp?.();
        google({ channels: { status: 429, data: googleError(429, 'Too many requests', 'rateLimitExceeded') } });
        const rate = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(!rate.ok);
        assert.equal(rate.error.kind, 'rate_limited');
        assert.equal(rate.error.retryable, true);
    });

    it('is `upstream`, retryable, for a 5xx, a timeout and a reset; and makes no retry of its own', async () => {
        for (const reply of [{ status: 503, data: googleError(503, 'Backend Error', 'backendError') }, networkError('ECONNABORTED', 'timeout of 8000ms exceeded'), networkError()] as Reply[]) {
            google({ channels: reply });
            const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
            assert.ok(!result.ok);
            assert.equal(result.error.kind, 'upstream');
            assert.equal(result.error.retryable, true);
            assert.equal(seen.length, 1, 'retries belong to the draft\'s state machine, not to the source');
            restoreHttp?.();
        }
    });

    it('is `bad_request`, final, when Google calls our request malformed', async () => {
        google({ channels: { status: 400, data: googleError(400, 'Invalid value for parameter part', 'invalidParameter') } });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'bad_request');
    });
});

describe('fetchYouTubeChannel: the videos are best effort', () => {
    it('keeps the channel when the uploads list fails, and says why', async () => {
        google({ channels: ok(channelsBody()), playlistItems: { status: 403, data: googleError(403, 'quota', 'quotaExceeded') } });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(result.ok);
        assert.equal(result.value.title, 'أكاديمية البرمجة');
        assert.deepEqual(result.value.videos, []);
        assert.equal(result.value.videosError?.kind, 'quota');
    });

    it('is no error when a brand-new channel has no uploads playlist yet', async () => {
        google({ channels: ok(channelsBody()), playlistItems: { status: 404, data: googleError(404, 'The playlist identified with the request\'s playlistId parameter cannot be found.', 'playlistNotFound') } });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(result.ok);
        assert.deepEqual(result.value.videos, []);
        assert.equal(result.value.videosError, null);
    });
});

describe('the API key goes in the query string, and so: in no error, no result and no log line', () => {
    it('when Google echoes the key back in its message', async () => {
        google({ channels: { status: 403, data: googleError(403, `Requests with key=${YT_KEY} are blocked`, 'API_KEY_HTTP_REFERRER_BLOCKED') } });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'no_access');
        assert.equal(seen[0]!.params.key, YT_KEY, 'the request did carry it');
        assertNoKeyAnywhere(result);
    });

    it('when axios throws an error that holds the whole request, key and all', async () => {
        google({ channels: { status: 400, data: googleDetailError(400, 'API key not valid', 'API_KEY_INVALID', 'INVALID_ARGUMENT') } });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(!result.ok);
        assertNoKeyAnywhere(result);
    });

    it('when the failure is a network error that names the URL', async () => {
        google({ channels: networkError('ENOTFOUND', `getaddrinfo ENOTFOUND www.googleapis.com ?key=${YT_KEY}`) });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(!result.ok);
        assertNoKeyAnywhere(result);
    });

    it('when the playlist call fails and the channel is returned with the reason', async () => {
        google({ channels: ok(channelsBody()), playlistItems: { status: 403, data: googleError(403, `quota for ${YT_KEY}`, 'quotaExceeded') } });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(result.ok);
        assertNoKeyAnywhere(result);
    });

    it('on success, too', async () => {
        google({ channels: ok(channelsBody()), playlistItems: ok(playlistBody([playlistItem(1, 'One')])) });
        const result = await fetchYouTubeChannel('@barmaga-academy', { getKey: withKey });
        assert.ok(result.ok);
        assertNoKeyAnywhere(result);
        assert.ok(lines.some((l) => l.includes('onboarding.yt_source')));
    });
});
