/**
 * YouTube: the consent URL, Google's token answers, the errors that mean "reconnect", a Short's
 * title / description / tags, and the resumable upload's session protocol — against a stubbed
 * HTTP adapter, so nothing reaches Google.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
    buildAuthorizeUrl, cutBytes, setThumbnail, isYouTubeReauthError, parseTokenResponse, queryUpload, receivedFromRange, sendBytes,
    shortDescription, shortTitle, startResumableUpload, tagsFrom, toYouTubeError, videoResource, YouTubeApiError, youtubeHttp,
    SCOPE_READONLY, SCOPE_UPLOAD,
} from './youtube.js';
import {
    metadataFor, privacyNote, uploadPrivacy, youtubeOptions,
} from './youtubePublish.js';

type Seen = { method: string; url: string; headers: Record<string, string>; data: unknown; params: unknown };
const originalAdapter = youtubeHttp.defaults.adapter;
afterEach(() => { youtubeHttp.defaults.adapter = originalAdapter; });

/** Answer every request with `reply`, honouring the request's own validateStatus as axios's adapters do. */
function stub(reply: (seen: Seen) => { status: number; data?: unknown; headers?: Record<string, string> }): Seen[] {
    const seen: Seen[] = [];
    youtubeHttp.defaults.adapter = async (config: any) => {
        const s: Seen = {
            method: String(config.method).toUpperCase(), url: config.url, params: config.params, data: config.data,
            headers: Object.fromEntries(Object.entries(config.headers?.toJSON?.() ?? config.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
        };
        seen.push(s);
        const r = reply(s);
        const response = { data: r.data ?? '', status: r.status, statusText: String(r.status), headers: r.headers ?? {}, config };
        const ok = config.validateStatus ? config.validateStatus(r.status) : r.status >= 200 && r.status < 300;
        if (!ok) throw Object.assign(new Error(`Request failed with status code ${r.status}`), { response, config, isAxiosError: true });
        return response;
    };
    return seen;
}

describe('buildAuthorizeUrl', () => {
    it('asks for upload + readonly, offline, with a fresh consent so a reconnect still gets a refresh token', () => {
        const url = new URL(buildAuthorizeUrl({ clientId: '1-abc.apps.googleusercontent.com', redirectUri: 'https://x.test/api/youtube/callback', state: 's1' }));
        assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
        assert.equal(url.searchParams.get('scope'), `${SCOPE_UPLOAD} ${SCOPE_READONLY}`);
        assert.equal(url.searchParams.get('access_type'), 'offline');
        assert.equal(url.searchParams.get('prompt'), 'consent');
        assert.equal(url.searchParams.get('response_type'), 'code');
        assert.equal(url.searchParams.get('redirect_uri'), 'https://x.test/api/youtube/callback');
        assert.equal(url.searchParams.get('state'), 's1');
    });
});

describe('parseTokenResponse', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    it('reads a consent answer, scopes space-separated, and a Testing app’s 7-day refresh expiry', () => {
        const t = parseTokenResponse({
            access_token: 'ya29', expires_in: 3599, refresh_token: '1//r', scope: `${SCOPE_UPLOAD} ${SCOPE_READONLY}`,
            refresh_token_expires_in: 604799,
        }, now);
        assert.equal(t.accessToken, 'ya29');
        assert.equal(t.refreshToken, '1//r');
        assert.deepEqual(t.scopes, [SCOPE_UPLOAD, SCOPE_READONLY]);
        assert.equal(t.accessExpiresAt.toISOString(), '2026-10-04T12:59:59.000Z');
        assert.equal(t.refreshExpiresAt!.toISOString(), '2026-10-11T11:59:59.000Z');
    });
    it('a production refresh: no new refresh token, and no expiry', () => {
        const t = parseTokenResponse({ access_token: 'ya29b', expires_in: 3600, scope: SCOPE_UPLOAD }, now);
        assert.equal(t.refreshToken, null);
        assert.equal(t.refreshExpiresAt, null);
    });
    it('throws on an answer with no access token', () => {
        assert.throws(() => parseTokenResponse({ error: 'invalid_grant' }, now), (e: unknown) => e instanceof YouTubeApiError && e.reason === 'invalid_grant');
    });
});

describe('errors', () => {
    it('reads the OAuth shape and the Data API shape, in plain words', () => {
        const oauth = toYouTubeError('Google token refresh', { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Bad Request' } } });
        assert.ok(oauth instanceof YouTubeApiError && oauth.reason === 'invalid_grant');
        assert.match(oauth.message, /reconnect YouTube/);
        const api = toYouTubeError('YouTube upload start', { response: { status: 403, data: { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } } });
        assert.ok(api instanceof YouTubeApiError && api.reason === 'quotaExceeded');
        assert.match(api.message, /quota/);
    });
    it('only a dead or unpermitted login asks for a reconnect', () => {
        const err = (reason: string, status?: number) => new YouTubeApiError('x', reason, status);
        assert.equal(isYouTubeReauthError(err('invalid_grant', 400)), true);
        assert.equal(isYouTubeReauthError(err('insufficientPermissions', 403)), true);
        assert.equal(isYouTubeReauthError(err('whatever', 401)), true);
        assert.equal(isYouTubeReauthError(err('quotaExceeded', 403)), false);
        assert.equal(isYouTubeReauthError(err('uploadLimitExceeded', 400)), false);
        assert.equal(isYouTubeReauthError(new Error('socket hang up')), false);
    });
});

describe('a Short’s words', () => {
    it('title: the hook with #Shorts, angle brackets dropped, the caption’s first line when there is no hook', () => {
        assert.equal(shortTitle('Gemini يطلّع برومت <الإيدت>', null), 'Gemini يطلّع برومت الإيدت #Shorts');
        assert.equal(shortTitle('', '\n🔥 دفترك الذكي\nالباقي'), '🔥 دفترك الذكي #Shorts');
        assert.equal(shortTitle('Already #shorts', null), 'Already #shorts');
    });
    it('title: never over 100 characters, and #Shorts is dropped before the hook is cut', () => {
        const long = 'كلمة '.repeat(30).trim();
        const t = shortTitle(long, null);
        assert.ok([...t].length <= 100);
        assert.ok(!t.includes('#Shorts'));
        const near = 'a'.repeat(95);
        assert.equal(shortTitle(near, null), near, '95 + " #Shorts" would be 103');
    });
    it('description: #Shorts ensured, angle brackets dropped, at most 5,000 bytes on a character boundary', () => {
        assert.equal(shortDescription('سطر <١>'), 'سطر ١\n\n#Shorts');
        assert.equal(shortDescription('x #Shorts'), 'x #Shorts');
        const big = shortDescription('ع'.repeat(4000));
        assert.ok(Buffer.byteLength(big, 'utf8') <= 5000);
        assert.ok(!big.endsWith('�'));
        assert.equal(cutBytes('aع', 2), 'a', 'a two-byte letter is not split');
    });
    it('tags: the caption’s hashtags, deduplicated, without #', () => {
        assert.deepEqual(tagsFrom('x #ai #دفتر_ذكي #AI #Shorts'), ['ai', 'دفتر_ذكي', 'Shorts']);
        assert.deepEqual(tagsFrom(null), []);
    });
    it('the resource: Education, made-for-kids declared false, the language on video and audio', () => {
        const r = videoResource({ title: 't', description: 'd', tags: [], privacy: 'private', language: 'ar' }) as any;
        assert.equal(r.snippet.categoryId, '27');
        assert.equal(r.snippet.defaultAudioLanguage, 'ar');
        assert.ok(!('tags' in r.snippet));
        assert.deepEqual(r.status, { privacyStatus: 'private', selfDeclaredMadeForKids: false, embeddable: true });
    });
});

describe('youtubePublish rules', () => {
    it('reads platform_options defensively', () => {
        assert.deepEqual(youtubeOptions({ title: ' T ', privacy: 'unlisted', language: 'ar' }), { title: 'T', privacy: 'unlisted', language: 'ar' });
        assert.deepEqual(youtubeOptions({ mode: 'direct', privacy_level: 'SELF_ONLY' }), {}, 'a TikTok shape reads as nothing');
        assert.deepEqual(youtubeOptions({ privacy: 'everyone', language: 'not a tag!' }), {});
        assert.deepEqual(youtubeOptions(null), {});
    });
    it('private with public uploads off, whatever the row asks for; on, the row’s choice, public by default', () => {
        assert.equal(uploadPrivacy({ privacy: 'public' }, false), 'private');
        assert.equal(uploadPrivacy({}, true), 'public');
        assert.equal(uploadPrivacy({ privacy: 'unlisted' }, true), 'unlisted');
    });
    it('the note follows what YouTube reported, not what was asked', () => {
        assert.equal(privacyNote('public', 'public', true), null);
        assert.equal(privacyNote('public', null, true), null, 'no report: what was asked');
        assert.match(privacyNote('public', 'private', true)!, /YouTube kept this upload private/);
        assert.match(privacyNote('private', 'private', false)!, /"Upload Shorts as public" is off/);
        assert.equal(privacyNote('private', 'public', false), null, 'made public on YouTube’s side: nothing to say');
    });
    it('the metadata comes from the row: its title option, its caption', () => {
        const m = metadataFor({ caption: 'سطر\n#ai' }, { title: 'العنوان', language: 'ar' }, 'private');
        assert.equal(m.title, 'العنوان #Shorts');
        assert.equal(m.description, 'سطر\n#ai\n\n#Shorts');
        assert.deepEqual(m.tags, ['ai']);
        assert.equal(m.language, 'ar');
    });
});

describe('the resumable upload', () => {
    const meta = { title: 't', description: 'd', tags: [], privacy: 'private' as const };

    it('opens a session with the size and type, and returns its Location', async () => {
        const seen = stub(() => ({ status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1' } }));
        const url = await startResumableUpload('tok', meta, 1234, 'video/mp4');
        assert.equal(url, 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1');
        assert.equal(seen[0]!.method, 'POST');
        assert.deepEqual(seen[0]!.params, { uploadType: 'resumable', part: 'snippet,status' });
        assert.equal(seen[0]!.headers['x-upload-content-length'], '1234');
        assert.equal(seen[0]!.headers['x-upload-content-type'], 'video/mp4');
        assert.equal(seen[0]!.headers.authorization, 'Bearer tok');
    });

    it('refuses a session answer with no Location', async () => {
        stub(() => ({ status: 200 }));
        await assert.rejects(startResumableUpload('tok', meta, 1, 'video/mp4'), /no upload session/);
    });

    it('asks a session where it is: done with the id, part-way with the bytes held, or gone', async () => {
        stub(() => ({ status: 201, data: { id: 'vid1', status: { privacyStatus: 'public' } } }));
        assert.deepEqual(await queryUpload('tok', 'https://s', 10), { state: 'done', videoId: 'vid1', privacy: 'public' });
        const seen = stub(() => ({ status: 308, headers: { range: 'bytes=0-4' } }));
        assert.deepEqual(await queryUpload('tok', 'https://s', 10), { state: 'partial', received: 5 });
        assert.equal(seen[0]!.headers['content-range'], 'bytes */10');
        stub(() => ({ status: 308 }));
        assert.deepEqual(await queryUpload('tok', 'https://s', 10), { state: 'partial', received: 0 });
        stub(() => ({ status: 404 }));
        assert.deepEqual(await queryUpload('tok', 'https://s', 10), { state: 'gone' });
    });

    it('sends the rest from an offset with a Content-Range, and the whole file without one', async () => {
        const data = Buffer.from('0123456789');
        let seen = stub(() => ({ status: 200, data: { id: 'vid2' } }));
        assert.deepEqual(await sendBytes('tok', 'https://s', data, 'video/mp4', 0), { state: 'done', videoId: 'vid2', privacy: null });
        assert.equal(seen[0]!.headers['content-range'], undefined);
        assert.equal(seen[0]!.headers['content-length'], '10');
        seen = stub(() => ({ status: 200, data: { id: 'vid3' } }));
        await sendBytes('tok', 'https://s', data, 'video/mp4', 6);
        assert.equal(seen[0]!.headers['content-range'], 'bytes 6-9/10');
        assert.equal(seen[0]!.headers['content-length'], '4');
        assert.equal(Buffer.from(seen[0]!.data as Buffer).toString(), '6789');
    });

    it('a quota refusal surfaces as YouTube’s reason, not a bare status', async () => {
        stub(() => ({ status: 403, data: { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } } }));
        await assert.rejects(sendBytes('tok', 'https://s', Buffer.from('x'), 'video/mp4'), (e: unknown) => e instanceof YouTubeApiError && e.reason === 'quotaExceeded');
    });

    it('sets the thumbnail as a media upload to thumbnails/set, and a refusal surfaces with its reason', async () => {
        const seen = stub(() => ({ status: 200, data: {} }));
        await setThumbnail('tok', 'vid9', Buffer.from('jpg'), 'image/jpeg');
        assert.equal(seen[0]!.method, 'POST');
        assert.match(seen[0]!.url, /\/upload\/youtube\/v3\/thumbnails\/set$/);
        assert.deepEqual(seen[0]!.params, { videoId: 'vid9', uploadType: 'media' });
        assert.equal(seen[0]!.headers['content-type'], 'image/jpeg');
        stub(() => ({ status: 403, data: { error: { code: 403, errors: [{ reason: 'forbidden' }] } } }));
        await assert.rejects(setThumbnail('tok', 'vid9', Buffer.from('jpg'), 'image/jpeg'), (e: unknown) => e instanceof YouTubeApiError && e.reason === 'forbidden');
    });

    it('reads Range headers', () => {
        assert.equal(receivedFromRange('bytes=0-999'), 1000);
        assert.equal(receivedFromRange(undefined), 0);
    });
});
