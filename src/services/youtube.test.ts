/**
 * YouTube: the consent URL, Google's token answers, the errors that mean "reconnect", a Short's
 * title / description / tags, and the resumable upload's session protocol — against a stubbed
 * HTTP adapter, so nothing reaches Google.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { SHOP_EG } from './profile/fixtures.js';
import { throughJsonb } from './profile/jsonb.js';
import { OWNER, OTHER, emptyState, installProfileDb, setPlatformOwner } from './profile/testDb.js';
import { KINDS, type CreatorKind, type CreatorProfile } from './profile/types.js';
import {
    buildAuthorizeUrl, cutBytes, getMyChannel, listVideoStatuses, setThumbnail, isYouTubeReauthError, parseTokenResponse, queryUpload, receivedFromRange, sendBytes,
    shortDescription, shortTitle, startResumableUpload, tagsFrom, toYouTubeError, videoResource, YouTubeApiError, youtubeCategoryId, youtubeHttp,
    EDUCATION_CATEGORY_ID, HOWTO_CATEGORY_ID, PEOPLE_BLOGS_CATEGORY_ID, SCOPE_READONLY, SCOPE_UPLOAD,
} from './youtube.js';
import {
    metadataFor, privacyNote, publishYouTubePost, uploadPrivacy, youtubeCategoryFor, youtubeOptions,
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
    it('title: a video that is not a Short (tagAsShort false) is not tagged: the same title, angle brackets dropped, still cut to 100 characters', () => {
        assert.equal(shortTitle('Gemini يطلّع برومت <الإيدت>', null, false), 'Gemini يطلّع برومت الإيدت');
        assert.equal(shortTitle('', '\n🔥 دفترك الذكي\nالباقي', false), '🔥 دفترك الذكي');
        assert.equal(shortTitle('Already #shorts', null, false), 'Already #shorts', 'a tag the author wrote is the author’s');
        const near = 'a'.repeat(95);
        assert.equal(shortTitle(near, null, false), near);
        assert.ok([...shortTitle('كلمة '.repeat(40).trim(), null, false)].length <= 100);
        assert.equal(shortTitle(null, null, false), 'Short', 'the fallback word is not a tag');
    });
    it('title: the default is today’s: tagged when the switch is not given, or is true', () => {
        assert.equal(shortTitle('A hook', null), 'A hook #Shorts');
        assert.equal(shortTitle('A hook', null, true), 'A hook #Shorts');
    });
    it('description: a video that is not a Short (tagAsShort false) gets no #Shorts added, keeps one the caption carries, and is still cleaned and cut', () => {
        assert.equal(shortDescription('سطر <١>', false), 'سطر ١');
        assert.equal(shortDescription('x #Shorts', false), 'x #Shorts');
        assert.equal(shortDescription('', false), '', 'nothing to say is nothing, not a tag');
        assert.equal(shortDescription(null, false), '');
        const big = shortDescription('ع'.repeat(4000), false);
        assert.ok(Buffer.byteLength(big, 'utf8') <= 5000);
        assert.ok(!big.includes('#Shorts'));
    });
    it('description: the default is today’s: ensured when the switch is not given, or is true', () => {
        assert.equal(shortDescription('x'), 'x\n\n#Shorts');
        assert.equal(shortDescription('x', true), 'x\n\n#Shorts');
        assert.equal(shortDescription(''), '#Shorts');
    });
    it('tags: the caption’s hashtags, deduplicated, without #', () => {
        assert.deepEqual(tagsFrom('x #ai #دفتر_ذكي #AI #Shorts'), ['ai', 'دفتر_ذكي', 'Shorts']);
        assert.deepEqual(tagsFrom(null), []);
    });
    it('the resource: the category it is given, made-for-kids declared false, the language on video and audio', () => {
        const r = videoResource({ title: 't', description: 'd', tags: [], privacy: 'private', language: 'ar', categoryId: EDUCATION_CATEGORY_ID }) as any;
        assert.equal(r.snippet.categoryId, '27');
        const other = videoResource({ title: 't', description: 'd', tags: [], privacy: 'private', categoryId: PEOPLE_BLOGS_CATEGORY_ID }) as any;
        assert.equal(other.snippet.categoryId, '22', 'not Education for everyone');
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
    it('reads `shorts: false` as the opt-out, and nothing else as one: a malformed row is still tagged as every row was', () => {
        assert.deepEqual(youtubeOptions({ title: 'T', language: 'en', shorts: false }), { title: 'T', language: 'en', shorts: false });
        for (const shorts of [true, 'false', 0, null, undefined, 'no', {}, []]) {
            assert.deepEqual(youtubeOptions({ title: 'T', shorts }), { title: 'T' }, String(shorts));
        }
        assert.deepEqual(youtubeOptions({ title: 'T' }), { title: 'T' }, 'a row from before the option');
        assert.deepEqual(youtubeOptions({ mode: 'inbox' }), {}, 'a TikTok shape still reads as nothing');
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
        const m = metadataFor({ caption: 'سطر\n#ai' }, { title: 'العنوان', language: 'ar' }, 'private', HOWTO_CATEGORY_ID);
        assert.equal(m.categoryId, '26', 'the category the caller chose');
        assert.equal(m.title, 'العنوان #Shorts');
        assert.equal(m.description, 'سطر\n#ai\n\n#Shorts');
        assert.deepEqual(m.tags, ['ai']);
        assert.equal(m.language, 'ar');
    });
    it('a row that says shorts: false is not tagged as a Short, in its title or its description; every other row is, as before', () => {
        const row = { caption: 'سطر\n#ai' };
        const notAShort = metadataFor(row, { title: 'العنوان', language: 'ar', shorts: false }, 'private', HOWTO_CATEGORY_ID);
        assert.equal(notAShort.title, 'العنوان');
        assert.equal(notAShort.description, 'سطر\n#ai');
        assert.deepEqual(notAShort.tags, ['ai'], 'the rest of the metadata is what it was');
        assert.equal(notAShort.language, 'ar');
        for (const options of [{ title: 'العنوان' }, {}, { title: 'العنوان', language: 'ar' }]) {
            const short = metadataFor(row, options, 'private', HOWTO_CATEGORY_ID);
            assert.ok(short.title.endsWith('#Shorts'), JSON.stringify(options));
            assert.ok(short.description.endsWith('\n\n#Shorts'), JSON.stringify(options));
        }
    });
});

describe('the resumable upload', () => {
    const meta = { title: 't', description: 'd', tags: [], privacy: 'private' as const, categoryId: '22' };

    it('opens a session with the size and type, and returns its Location', async () => {
        const seen = stub(() => ({ status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1' } }));
        const url = await startResumableUpload('tok', meta, 1234, 'video/mp4');
        assert.equal(url, 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1');
        assert.equal(seen[0]!.method, 'POST');
        assert.deepEqual(seen[0]!.params, { uploadType: 'resumable', part: 'snippet,status' });
        assert.equal(seen[0]!.headers['x-upload-content-length'], '1234');
        assert.equal(seen[0]!.headers['x-upload-content-type'], 'video/mp4');
        assert.equal(seen[0]!.headers.authorization, 'Bearer tok');
        assert.equal(JSON.parse(String(seen[0]!.data)).snippet.categoryId, '22', 'the session is opened with the creator\'s category');
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

    it('asks videos.list for up to 50 ids in one call; a video YouTube no longer has is absent', async () => {
        const seen = stub(() => ({ status: 200, data: { items: [{ id: 'a', status: { privacyStatus: 'public', uploadStatus: 'processed' } }] } }));
        const out = await listVideoStatuses('tok', ['a', 'b']);
        assert.deepEqual((seen[0]!.params as any), { part: 'status', id: 'a,b', maxResults: 50 });
        assert.deepEqual(out.get('a'), { privacy: 'public', uploadStatus: 'processed' });
        assert.equal(out.has('b'), false);
        await assert.rejects(listVideoStatuses('tok', Array.from({ length: 51 }, (_, i) => String(i))), /at most 50/);
    });

        it('reads Range headers', () => {
        assert.equal(receivedFromRange('bytes=0-999'), 1000);
        assert.equal(receivedFromRange(undefined), 0);
    });
});

// ─── The category follows the creator (05 R19) ──────────────────────────────────────────────

describe('the category a Short is filed under', () => {
    it('follows the creator\'s kind: Education for an educator (the owner\'s), Howto & Style for a coach, People & Blogs for the rest', () => {
        assert.equal(youtubeCategoryId('educator'), '27');
        assert.equal(youtubeCategoryId('coach'), '26');
        for (const kind of ['shop', 'agency', 'creator'] as const) assert.equal(youtubeCategoryId(kind), '22', kind);
        for (const none of [null, undefined]) assert.equal(youtubeCategoryId(none), '22', 'a profile that has not said who they are');
    });

    it('is Education for exactly one kind: a fixed category for everyone would be the bug R19 is', () => {
        assert.deepEqual(KINDS.filter((k) => youtubeCategoryId(k) === EDUCATION_CATEGORY_ID), ['educator']);
        assert.ok(new Set(KINDS.map((k) => youtubeCategoryId(k))).size > 1, 'the categories are not all one');
    });

    it('is read from the tenant\'s profile context, for the reels', async () => {
        const asked: string[] = [];
        const read = async (_: string, purpose: 'clip_copy') => { asked.push(purpose); return { who: { kind: 'shop' } } as never; };
        assert.equal(await youtubeCategoryFor('anyone', read), '22');
        assert.deepEqual(asked, ['clip_copy']);
        assert.equal(await youtubeCategoryFor('anyone', async () => ({ who: { kind: 'educator' } }) as never), '27');
    });

    describe('when the profile cannot be read', () => {
        const unreadable = (platformOwner: string | null) => {
            const db = installProfileDb(emptyState());
            db.failOn = /FROM creator_profiles/;
            db.failWith = new Error('connection refused');
            setPlatformOwner(db, platformOwner);
            const sink = setLogSink(() => {});
            return () => { setLogSink(sink); db.restore(); };
        };

        it('the owner is filed as he always was: Education', async () => {
            const done = unreadable(OWNER);
            try { assert.equal(await youtubeCategoryFor(OWNER), '27'); } finally { done(); }
        });

        it('anyone else is filed under YouTube\'s own default, and the upload goes ahead: a category is not worth a scheduled slot', async () => {
            const done = unreadable(OWNER);
            try { assert.equal(await youtubeCategoryFor(OTHER), '22'); } finally { done(); }
        });
    });
});

describe('publishing a Short files it under the creator\'s category', () => {
    /** A connected channel with a fresh token and the upload scope, as `platform_connections` holds it. */
    const CONNECTION = { id: 'conn-1', status: 'active', refresh_token: 'refresh', access_token: 'tok', access_expires_at: new Date(Date.now() + 3_600_000), scopes: [SCOPE_UPLOAD] };
    const post = (creatorId: string) => ({
        id: 'post-1', creator_id: creatorId, post_type: 'video' as const, caption: 'سطر\n#ai', media_url: 'https://cdn.example/reel.mp4', external_publish_id: null,
        platform_options: null, cover_url: null,
    });

    /** The category the session was opened with, for a creator whose stored profile is `profile` (or whose profile read fails). */
    async function filedUnder(creatorId: string, profile: CreatorProfile | null, fail = false): Promise<string> {
        const state = emptyState();
        if (profile) state.profiles.set(creatorId, { profile: throughJsonb(profile), version: 2, activated_at: null, updated_by: null });
        const db = installProfileDb(state);
        db.routes.unshift([/FROM platform_connections WHERE creator_id = \$1 AND platform = 'youtube'/, () => ({ rows: [CONNECTION] })]);
        if (fail) { db.failOn = /FROM creator_profiles/; db.failWith = new Error('connection refused'); }
        setPlatformOwner(db, OWNER);
        const seen = stub((s): { status: number; data?: unknown; headers?: Record<string, string> } => {
            if (s.method === 'GET') return { status: 200, data: Buffer.from('reel'), headers: { 'content-type': 'video/mp4' } };
            if (s.method === 'POST') return { status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U9' } };
            return { status: 200, data: { id: 'vid9', status: { privacyStatus: 'private' } } };
        });
        const sink = setLogSink(() => {});
        try {
            assert.equal(await publishYouTubePost(post(creatorId)), 'PUBLISHED', 'the upload goes ahead');
        } finally {
            setLogSink(sink);
            db.restore();
        }
        const open = seen.find((s) => s.method === 'POST');
        assert.ok(open, 'a session was opened');
        return JSON.parse(String(open!.data)).snippet.categoryId;
    }

    const as = (kind: CreatorKind | null): CreatorProfile => ({ ...SHOP_EG, identity: { ...SHOP_EG.identity, kind } });

    it('opens the upload session with the category of the creator\'s kind: Education for an educator, Howto & Style for a coach, People & Blogs for a shop', async () => {
        assert.equal(await filedUnder(OTHER, as('educator')), '27');
        assert.equal(await filedUnder(OTHER, as('coach')), '26');
        assert.equal(await filedUnder(OTHER, as('shop')), '22');
        assert.equal(await filedUnder(OTHER, as(null)), '22');
    });

    it('still uploads when the profile cannot be read: the owner as an educator, anyone else under YouTube\'s own default', async () => {
        assert.equal(await filedUnder(OWNER, null, true), '27');
        assert.equal(await filedUnder(OTHER, null, true), '22');
    });
});

describe('publishing a row that is not a Short (an explainer’s horizontal video over three minutes)', () => {
    const CONNECTION = { id: 'conn-1', status: 'active', refresh_token: 'refresh', access_token: 'tok', access_expires_at: new Date(Date.now() + 3_600_000), scopes: [SCOPE_UPLOAD] };

    /** The title and description the upload session was opened with, for a row carrying these `platform_options`. */
    async function openedWith(platformOptions: unknown): Promise<{ title: string; description: string }> {
        const db = installProfileDb(emptyState());
        db.routes.unshift([/FROM platform_connections WHERE creator_id = \$1 AND platform = 'youtube'/, () => ({ rows: [CONNECTION] })]);
        setPlatformOwner(db, OWNER);
        const seen = stub((s): { status: number; data?: unknown; headers?: Record<string, string> } => {
            if (s.method === 'GET') return { status: 200, data: Buffer.from('video'), headers: { 'content-type': 'video/mp4' } };
            if (s.method === 'POST') return { status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U7' } };
            return { status: 200, data: { id: 'vid7', status: { privacyStatus: 'private' } } };
        });
        const sink = setLogSink(() => {});
        try {
            assert.equal(await publishYouTubePost({
                id: 'post-1', creator_id: OTHER, post_type: 'video' as const, caption: 'How retrieval grounds an answer.\n\n#AI', media_url: 'https://cdn.example/explainer.mp4',
                external_publish_id: null, platform_options: platformOptions, cover_url: null,
            }), 'PUBLISHED');
        } finally {
            setLogSink(sink);
            db.restore();
        }
        const open = seen.find((s) => s.method === 'POST');
        assert.ok(open, 'a session was opened');
        return JSON.parse(String(open!.data)).snippet;
    }

    it('is uploaded with its title and description as they are: no #Shorts in either', async () => {
        const snippet = await openedWith({ title: 'Why AI answers with confidence', language: 'en', shorts: false });
        assert.equal(snippet.title, 'Why AI answers with confidence');
        assert.equal(snippet.description, 'How retrieval grounds an answer.\n\n#AI');
    });

    it('every other row is uploaded as a Short, as before: #Shorts in the title and in the description', async () => {
        const withTitle = [{ title: 'Why AI answers with confidence', language: 'en' }, { title: 'Why AI answers with confidence', shorts: true }, { title: 'Why AI answers with confidence', shorts: 'false' }];
        for (const options of withTitle) {
            const snippet = await openedWith(options);
            assert.equal(snippet.title, 'Why AI answers with confidence #Shorts', JSON.stringify(options));
            assert.equal(snippet.description, 'How retrieval grounds an answer.\n\n#AI\n\n#Shorts', JSON.stringify(options));
        }
        // No options at all: the caption's first line is the title, as it always was, and it is tagged too.
        const bare = await openedWith(null);
        assert.equal(bare.title, 'How retrieval grounds an answer. #Shorts');
        assert.equal(bare.description, 'How retrieval grounds an answer.\n\n#AI\n\n#Shorts');
    });
});

describe('getMyChannel keeps what the answer already carries (docs/onboarding/03 §1)', () => {
    it('maps the description, the country and the default language: no extra quota, they come with the same `channels.list`', async () => {
        const seen = stub(() => ({
            status: 200,
            data: { items: [{ id: 'UC1', snippet: { title: 'قناتي', customUrl: '@qanati', description: '  قناة لتعليم البرمجة  ', country: 'EG', defaultLanguage: 'ar', thumbnails: { default: { url: 'https://yt3.example/a.jpg' } } } }] },
        }));
        const channel = await getMyChannel('tok');
        assert.equal(channel.description, 'قناة لتعليم البرمجة');
        assert.equal(channel.country, 'EG');
        assert.equal(channel.defaultLanguage, 'ar');
        assert.equal(channel.handle, '@qanati');
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0]!.params, { part: 'snippet', mine: 'true' });
    });

    it('has null for what the channel left empty', async () => {
        stub(() => ({ status: 200, data: { items: [{ id: 'UC1', snippet: { title: 'T', description: '   ' } }] } }));
        const channel = await getMyChannel('tok');
        assert.deepEqual([channel.description, channel.country, channel.defaultLanguage], [null, null, null]);
    });
});
