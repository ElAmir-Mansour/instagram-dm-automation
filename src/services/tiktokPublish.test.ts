/**
 * The TikTok publish lifecycle's database transitions, against a stubbed pool.
 *
 * Three writers can move a TikTok row — the inline poll, the webhook and the reconcile sweep —
 * and they can overlap. What keeps that safe is the WHERE clause on each transition: which
 * statuses a row may be moved *from*. Those clauses are the contract, so these tests assert them
 * directly rather than re-implementing a state machine in the test.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import {
    applyStatus, applyWebhookEvent, MAX_PENDING_INBOX_SHARES, pendingInboxShares, publishTikTokPost,
    validateTikTokInboxOptions, validateTikTokOptions, type TikTokPublishTarget,
} from './tiktokPublish.js';
import { uploadIdFromUrl } from './storage.js';
import { tiktokHttp, TIKTOK_API_BASE } from './tiktok.js';
import { postModeFor } from '../routes/tiktok.js';
import { attemptPublish, isMetaPlatform, unsupportedPlatformCombination } from '../routes/api.js';

interface Statement { sql: string; params: unknown[] }
let statements: Statement[] = [];
let respond: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number };
const originalQuery = pool.query;

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    statements = [];
    respond = () => ({ rows: [], rowCount: 0 });
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        const r = respond(sql, params);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
});

const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('applyStatus — which states each transition may leave', () => {
    it('never drags a row backwards into PROCESSING', async () => {
        await applyStatus('post-1', { status: 'PROCESSING_UPLOAD', failReason: null, postIds: [] });
        assert.match(oneLine(statements[0]!.sql), /WHERE id = \$1 AND status IN \('PUBLISHING', 'PROCESSING'\)/);
    });

    it('delivers to the inbox from PUBLISHING, PROCESSING, or a FAILED our side wrote too early', async () => {
        const landed = await applyStatus('post-1', { status: 'SEND_TO_USER_INBOX', failReason: null, postIds: [] });
        assert.equal(landed, 'IN_INBOX');
        assert.match(oneLine(statements[0]!.sql), /status IN \('PUBLISHING', 'PROCESSING', 'FAILED'\)/);
    });

    it('marks an inbox draft PUBLISHED once the creator posts it, keeping the post id as TT:<id>', async () => {
        const landed = await applyStatus('post-1', {
            status: 'PUBLISH_COMPLETE', failReason: null, postIds: ['7300000000000000001'],
        });
        assert.equal(landed, 'PUBLISHED');
        const { sql, params } = statements[0]!;
        assert.match(oneLine(sql), /status IN \('PUBLISHING', 'PROCESSING', 'IN_INBOX', 'FAILED'\)/);
        assert.deepEqual(params, ['post-1', 'TT:7300000000000000001']);
    });

    it('fails only a row still in flight — a late FAILED cannot undo a delivered draft', async () => {
        await applyStatus('post-1', { status: 'FAILED', failReason: 'frame_rate_check_failed', postIds: [] });
        const { sql, params } = statements[0]!;
        assert.match(oneLine(sql), /status IN \('PUBLISHING', 'PROCESSING'\)$/);
        assert.match(String(params[1]), /23 and 60 fps/);
    });

    it('ignores a state it does not recognise instead of guessing', async () => {
        const landed = await applyStatus('post-1', { status: 'SOMETHING_NEW', failReason: null, postIds: [] });
        assert.equal(landed, null);
        assert.equal(statements.length, 0);
    });
});

describe('applyWebhookEvent', () => {
    it('routes an inbox_delivered event to the row holding that publish_id', async () => {
        respond = (sql) => {
            if (/FROM platform_connections/.test(sql)) return { rows: [{ id: 'conn-1', creator_id: 'tenant-a' }] };
            if (/FROM scheduled_posts WHERE external_publish_id/.test(sql)) return { rows: [{ id: 'post-9', creator_id: 'tenant-a' }] };
            return { rows: [], rowCount: 1 };
        };
        const outcome = await applyWebhookEvent({
            event: 'post.publish.inbox_delivered', openId: 'open-1', createTime: 1, content: { publish_id: 'p-1' },
        });
        assert.equal(outcome, 'post_in_inbox');
        const update = statements.find((s) => /UPDATE scheduled_posts SET status = 'IN_INBOX'/.test(s.sql));
        assert.ok(update, 'the row must be moved to IN_INBOX');
        assert.equal(update.params[0], 'post-9');
    });

    it('refuses an event whose account and post belong to different tenants', async () => {
        respond = (sql) => {
            if (/FROM platform_connections/.test(sql)) return { rows: [{ id: 'conn-1', creator_id: 'tenant-b' }] };
            if (/FROM scheduled_posts WHERE external_publish_id/.test(sql)) return { rows: [{ id: 'post-9', creator_id: 'tenant-a' }] };
            return { rows: [] };
        };
        const outcome = await applyWebhookEvent({
            event: 'post.publish.complete', openId: 'open-1', createTime: 1, content: { publish_id: 'p-1' },
        });
        assert.equal(outcome, 'ignored:account_mismatch');
        assert.ok(!statements.some((s) => /^\s*UPDATE scheduled_posts/.test(s.sql)));
    });

    it('deletes the stored connection when the user removes the app on TikTok’s side', async () => {
        // /data-deletion promises this route deletes the same data a Settings disconnect does —
        // the open_id, name and avatar as well as the tokens. A 'revoked' tombstone would keep
        // three of those five.
        respond = () => ({ rows: [], rowCount: 1 });
        const outcome = await applyWebhookEvent({
            event: 'authorization.removed', openId: 'open-1', createTime: 1, content: { reason: 1 },
        });
        assert.equal(outcome, 'connection_deleted');
        assert.match(oneLine(statements[0]!.sql), /^DELETE FROM platform_connections WHERE platform = 'tiktok' AND external_account_id = \$1$/);
        assert.equal(statements[0]!.params[0], 'open-1');
    });

    it('acknowledges events it has no use for without touching anything', async () => {
        const outcome = await applyWebhookEvent({ event: 'video.upload.something', openId: null, createTime: null, content: {} });
        assert.match(outcome, /^ignored:/);
        assert.equal(statements.length, 0);
    });
});

describe('pendingInboxShares', () => {
    it('counts only this tenant’s undelivered-or-unposted uploads from the last 24 hours', async () => {
        respond = () => ({ rows: [{ n: 3 }] });
        const n = await pendingInboxShares('tenant-a', 'post-1');
        assert.equal(n, 3);
        const sql = oneLine(statements[0]!.sql);
        assert.match(sql, /platform = 'tiktok'/);
        // PUBLISHING included: a concurrent drain mid-upload must count, or two drains both
        // squeeze past the limit.
        assert.match(sql, /status IN \('PUBLISHING', 'PROCESSING', 'IN_INBOX'\)/);
        assert.match(sql, /claimed_at > NOW\(\) - INTERVAL '24 hours'/);
        // Direct posts never sit in the inbox, so they must not use up its five slots.
        assert.match(sql, /COALESCE\(platform_options->>'mode', 'inbox'\) = 'inbox'/);
        assert.deepEqual(statements[0]!.params, ['tenant-a', 'post-1']);
        assert.equal(MAX_PENDING_INBOX_SHARES, 5, 'TikTok: at most 5 pending shares within any 24-hour period');
    });
});

describe('uploadIdFromUrl', () => {
    it('recognises our own upload URLs, from any origin', () => {
        const id = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
        assert.equal(uploadIdFromUrl(`https://msg-response-auto.vercel.app/api/uploads/${id}`), id);
        assert.equal(uploadIdFromUrl(`http://localhost:3000/api/uploads/${id.toUpperCase()}?v=1`), id);
    });

    it('does not mistake anything else for one', () => {
        assert.equal(uploadIdFromUrl('https://cdn.example/video.mp4'), null);
        assert.equal(uploadIdFromUrl('https://x/api/uploads/not-a-uuid'), null);
    });
});

describe('the dispatcher fails closed on platforms it does not publish to', () => {
    it('writes FAILED instead of PUBLISHED with an empty id', async () => {
        // The incident: a platform matching neither Meta branch fell through to the PUBLISHED
        // write with `published_post_id = ''` — a post reported live that went nowhere. A
        // `tiktok` row would have been exactly that before the dispatcher existed.
        const err = await attemptPublish(
            {
                id: 'post-1', platform: 'tiktok', post_type: 'video', caption: 'c',
                media_url: 'https://x/v.mp4', cover_url: null, published_post_id: null,
            },
            { id: null, page_access_token: 'tok', instagram_page_id: 'ig', facebook_page_id: 'fb' }
        ).then(() => null, (e) => e);

        assert.ok(err, 'attemptPublish must throw for a non-Meta platform');
        assert.ok(!statements.some((s) => /SET status = 'PUBLISHED'/.test(s.sql)), 'never marked PUBLISHED');
        const failed = statements.find((s) => /SET status = 'FAILED'/.test(s.sql));
        assert.ok(failed);
        assert.match(String(failed.params[0]), /Unsupported platform "tiktok"/);
    });

    it('knows exactly which platforms are Meta', () => {
        assert.equal(isMetaPlatform('both'), true);
        assert.equal(isMetaPlatform('instagram'), true);
        assert.equal(isMetaPlatform('facebook'), true);
        assert.equal(isMetaPlatform('tiktok'), false);
        assert.equal(isMetaPlatform(undefined), false);
    });

    it('refuses to schedule an unknown platform, or a TikTok type TikTok has no post for', () => {
        assert.match(unsupportedPlatformCombination('twitter', 'image')!, /Unknown platform/);
        for (const postType of ['video', 'image', 'carousel']) {
            assert.equal(unsupportedPlatformCombination('tiktok', postType), null, postType);
        }
        for (const postType of ['reel', 'story', 'feed']) {
            assert.match(unsupportedPlatformCombination('tiktok', postType)!, /video, a photo or a carousel/, postType);
        }
    });
});

describe('validateTikTokOptions — TikTok\u2019s Content Sharing Guidelines, server side', () => {
    const base = { consent: true, privacy_level: 'PUBLIC_TO_EVERYONE' };

    it('requires express consent', () => {
        const r = validateTikTokOptions({ ...base, consent: false }, { audited: true });
        assert.equal(r.ok, false);
    });

    it('requires a privacy choice — there is no default', () => {
        assert.equal(validateTikTokOptions({ consent: true }, { audited: true }).ok, false);
        assert.equal(validateTikTokOptions({ consent: true, privacy_level: 'EVERYBODY' }, { audited: true }).ok, false);
    });

    it('allows only SELF_ONLY until TikTok has audited the app', () => {
        assert.equal(validateTikTokOptions(base, { audited: false }).ok, false);
        assert.equal(validateTikTokOptions({ ...base, privacy_level: 'SELF_ONLY' }, { audited: false }).ok, true);
    });

    it('refuses branded content that is private', () => {
        const r = validateTikTokOptions({ ...base, privacy_level: 'SELF_ONLY', brand_content: true }, { audited: true });
        assert.equal(r.ok, false);
    });

    it('defaults every interaction and disclosure to OFF, and records when consent was given', () => {
        const r = validateTikTokOptions(base, { audited: true });
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.equal(r.options.mode, 'direct');
        assert.equal(r.options.allow_comment, false);
        assert.equal(r.options.allow_duet, false);
        assert.equal(r.options.allow_stitch, false);
        assert.equal(r.options.brand_organic, false);
        assert.equal(r.options.is_aigc, false);
        assert.ok(r.options.consent_at && !Number.isNaN(Date.parse(r.options.consent_at)));
    });

    it('posts directly only with both the scope and the operator switch', () => {
        assert.equal(postModeFor(true, true), 'direct');
        assert.equal(postModeFor(true, false), 'inbox');
        assert.equal(postModeFor(false, true), 'inbox', 'switched on, but this connection was made before — reconnect');
    });
});

describe('validateTikTokOptions — photo posts', () => {
    const base = { consent: true, privacy_level: 'SELF_ONLY' };

    it('drops duet, stitch and is_aigc, which a TikTok photo post does not have', () => {
        const r = validateTikTokOptions(
            { ...base, allow_duet: true, allow_stitch: true, is_aigc: true, allow_comment: true },
            { audited: false, media: 'photo' }
        );
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.equal('allow_duet' in r.options, false);
        assert.equal('allow_stitch' in r.options, false);
        assert.equal('is_aigc' in r.options, false, 'a choice kept on the row would read as applied');
        assert.equal(r.options.allow_comment, true);
    });

    it('turns music on unless it is switched off', () => {
        const on = validateTikTokOptions(base, { audited: false, media: 'photo' });
        const off = validateTikTokOptions({ ...base, auto_add_music: false }, { audited: false, media: 'photo' });
        assert.ok(on.ok && off.ok);
        if (!on.ok || !off.ok) return;
        assert.equal(on.options.auto_add_music, true);
        assert.equal(off.options.auto_add_music, false);
    });

    it('takes a title of up to 90 UTF-16 units, and leaves a blank one to the caption', () => {
        const ok = validateTikTokOptions({ ...base, title: '  ' + 'ع'.repeat(90) + '  ' }, { audited: false, media: 'photo' });
        assert.ok(ok.ok);
        if (ok.ok) assert.equal(ok.options.title, 'ع'.repeat(90));

        const blank = validateTikTokOptions({ ...base, title: '   ' }, { audited: false, media: 'photo' });
        assert.ok(blank.ok);
        if (blank.ok) assert.equal('title' in blank.options, false, 'absent means "use the caption"');

        // 46 emoji are 92 units: over, although only 46 characters.
        const over = validateTikTokOptions({ ...base, title: '😀'.repeat(46) }, { audited: false, media: 'photo' });
        assert.equal(over.ok, false);
        if (!over.ok) assert.match(over.error, /at most 90/);
    });

    it('keeps every Content Sharing Guidelines check a video has', () => {
        assert.equal(validateTikTokOptions({ ...base, consent: false }, { audited: false, media: 'photo' }).ok, false);
        assert.equal(validateTikTokOptions({ consent: true, privacy_level: 'PUBLIC_TO_EVERYONE' }, { audited: false, media: 'photo' }).ok, false);
    });

    it('leaves a video exactly as it was', () => {
        const r = validateTikTokOptions({ ...base, allow_duet: true, title: 'ignored' }, { audited: false });
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.equal(r.options.allow_duet, true);
        assert.equal('title' in r.options, false);
        assert.equal('auto_add_music' in r.options, false);
    });

    it('takes a photo title in inbox mode too, and nothing else', () => {
        assert.deepEqual(validateTikTokInboxOptions({ mode: 'inbox', title: ' عنوان ', privacy_level: 'SELF_ONLY' }, 'photo'),
            { ok: true, options: { mode: 'inbox', title: 'عنوان' } });
        assert.deepEqual(validateTikTokInboxOptions({ mode: 'inbox', title: 'x' }, 'video'), { ok: true, options: { mode: 'inbox' } });
        assert.deepEqual(validateTikTokInboxOptions(undefined, 'photo'), { ok: true, options: { mode: 'inbox' } });
        assert.equal(validateTikTokInboxOptions({ title: 'x'.repeat(91) }, 'photo').ok, false);
    });
});

/**
 * The photo branch of `publishTikTokPost`, end to end against a stubbed pool and a stubbed
 * TikTok. What it has to get right cannot be seen from the row afterwards: which URLs TikTok
 * is told to pull, and which fields each mode sends.
 */
describe('publishTikTokPost — photo posts', () => {
    const JPEG_ID = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
    const WEBP_ID = '1b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
    const PNG_ID = '2b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
    const MIMES: Record<string, string> = { [JPEG_ID]: 'image/jpeg', [WEBP_ID]: 'image/webp', [PNG_ID]: 'image/png' };

    let tiktokCalls: { url: string; body: any }[] = [];
    let creatorInfo: Record<string, unknown> = {};
    const originalPost = tiktokHttp.post;

    beforeEach(() => {
        tiktokCalls = [];
        creatorInfo = { privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], comment_disabled: false };
        (tiktokHttp as any).post = async (url: string, body: any) => {
            tiktokCalls.push({ url, body });
            if (url.endsWith('/creator_info/query/')) return { status: 200, data: { data: creatorInfo, error: { code: 'ok' } } };
            if (url.endsWith('/content/init/')) return { status: 200, data: { data: { publish_id: 'p_pub_url~1' }, error: { code: 'ok' } } };
            throw new Error(`no TikTok call arranged for ${url}`);
        };
        respond = (sql, params) => {
            if (/FROM platform_connections/.test(sql)) {
                return {
                    rows: [{
                        id: 'conn-1', creator_id: 'creator-1', status: 'active', refresh_token: 'r', access_token: 'act.1',
                        access_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
                        scopes: ['user.info.basic', 'video.upload', 'video.publish'],
                    }],
                };
            }
            if (/FROM app_settings/.test(sql)) {
                // Deliberately NOT the host the rows below were saved with.
                return { rows: params[0] === 'app.public_base_url' ? [{ value: 'https://msg-response-auto.vercel.app', is_secret: false }] : [] };
            }
            if (/FROM media_uploads/.test(sql)) {
                return { rows: (params[0] as string[]).filter((id) => MIMES[id]).map((id) => ({ id, mime_type: MIMES[id] })) };
            }
            if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
            return { rows: [], rowCount: 1 };
        };
    });

    afterEach(() => {
        (tiktokHttp as any).post = originalPost;
    });

    function row(overrides: Partial<TikTokPublishTarget> = {}): TikTokPublishTarget {
        return {
            id: 'post-1', creator_id: 'creator-1', post_type: 'carousel',
            caption: 'السطر الأول\nوالباقي #AI',
            media_url: `https://preview-123.vercel.app/api/uploads/${JPEG_ID}`,
            media_urls: [`https://preview-123.vercel.app/api/uploads/${JPEG_ID}`, `http://localhost:3000/api/uploads/${WEBP_ID}.webp`],
            external_publish_id: null,
            platform_options: { mode: 'direct', privacy_level: 'SELF_ONLY', allow_comment: true, brand_content: false, brand_organic: false },
            ...overrides,
        };
    }

    const init = () => tiktokCalls.find((c) => c.url === `${TIKTOK_API_BASE}/v2/post/publish/content/init/`);

    it('rebuilds every URL on the public base URL, with an extension, in slide order', async () => {
        const status = await publishTikTokPost(row(), 0);

        assert.equal(status, 'PROCESSING');
        // Never the host the row stored: TikTok pulls only from the verified prefix.
        assert.deepEqual(init()!.body.source_info, {
            source: 'PULL_FROM_URL',
            photo_images: [
                `https://msg-response-auto.vercel.app/api/uploads/${JPEG_ID}.jpg`,
                `https://msg-response-auto.vercel.app/api/uploads/${WEBP_ID}.webp`,
            ],
            photo_cover_index: 0,
        });
        assert.equal(init()!.body.media_type, 'PHOTO');
    });

    it('posts directly with the stored choices, the caption as description and its first line as title', async () => {
        await publishTikTokPost(row(), 0);

        assert.equal(init()!.body.post_mode, 'DIRECT_POST');
        assert.deepEqual(init()!.body.post_info, {
            title: 'السطر الأول', description: 'السطر الأول\nوالباقي #AI',
            privacy_level: 'SELF_ONLY', disable_comment: false, auto_add_music: true,
            brand_content_toggle: false, brand_organic_toggle: false,
        });
        assert.ok(tiktokCalls.some((c) => c.url.endsWith('/creator_info/query/')), 'creator_info is re-read before posting');
    });

    it('forces comments off when the creator has switched them off since', async () => {
        creatorInfo = { ...creatorInfo, comment_disabled: true };
        await publishTikTokPost(row(), 0);
        assert.equal(init()!.body.post_info.disable_comment, true);
    });

    it('sends only title and description to the inbox, and uses the stored title', async () => {
        await publishTikTokPost(row({ platform_options: { mode: 'inbox', title: 'عنوان مختار' } }), 0);

        assert.equal(init()!.body.post_mode, 'MEDIA_UPLOAD');
        assert.deepEqual(init()!.body.post_info, { title: 'عنوان مختار', description: 'السطر الأول\nوالباقي #AI' });
        assert.ok(!tiktokCalls.some((c) => c.url.endsWith('/creator_info/query/')), 'inbox mode needs no creator_info');
    });

    it('posts a single photo from media_url', async () => {
        await publishTikTokPost(row({ post_type: 'image', media_urls: null }), 0);
        assert.deepEqual(init()!.body.source_info.photo_images, [`https://msg-response-auto.vercel.app/api/uploads/${JPEG_ID}.jpg`]);
    });

    it('records the publish id before anything else, then PROCESSING', async () => {
        await publishTikTokPost(row(), 0);

        const writes = statements.filter((st) => /UPDATE scheduled_posts/.test(st.sql)).map((st) => oneLine(st.sql));
        assert.match(writes[0]!, /SET external_publish_id = \$2/);
        assert.match(writes[1]!, /SET status = 'PROCESSING'.*WHERE id = \$1 AND status = 'PUBLISHING'/);
    });

    it('refuses a PNG before TikTok is asked for anything that creates a post', async () => {
        const err = await publishTikTokPost(row({
            media_urls: [`https://x/api/uploads/${JPEG_ID}`, `https://x/api/uploads/${PNG_ID}`],
        }), 0).then(() => null, (e) => e);

        assert.match(String(err?.message), /JPEG or WebP — image 2 is PNG/);
        assert.equal(init(), undefined, 'no init');
        const failed = statements.find((st) => /SET status = 'FAILED'/.test(st.sql));
        assert.match(String(failed?.params[1]), /image 2 is PNG/, 'the reason lands on the row');
    });

    it('refuses an upload that no longer exists, and a link to another site', async () => {
        const gone = await publishTikTokPost(row({
            media_urls: [`https://x/api/uploads/${JPEG_ID}`, 'https://x/api/uploads/3b8a7a0e-3c1f-4f7e-9d0a-1234567890ab'],
        }), 0).then(() => null, (e) => e);
        assert.match(String(gone?.message), /Image 2 can’t be found/);

        const outside = await publishTikTokPost(row({
            media_urls: [`https://x/api/uploads/${JPEG_ID}`, 'https://cdn.example/slide.jpg'],
        }), 0).then(() => null, (e) => e);
        assert.match(String(outside?.message), /uploaded here/);
        assert.equal(init(), undefined);
    });

    it('does not post a second time when a previous attempt already reached TikTok', async () => {
        (tiktokHttp as any).post = async (url: string, body: any) => {
            tiktokCalls.push({ url, body });
            if (url.endsWith('/status/fetch/')) {
                return { status: 200, data: JSON.stringify({ data: { status: 'PROCESSING_DOWNLOAD' }, error: { code: 'ok' } }) };
            }
            throw new Error(`no TikTok call arranged for ${url}`);
        };

        const status = await publishTikTokPost(row({ external_publish_id: 'p_pub_url~earlier' }), 0);

        assert.equal(status, 'PROCESSING');
        assert.equal(init(), undefined, 'resumed, not re-initialised');
    });
});
