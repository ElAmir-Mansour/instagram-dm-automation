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
    applyStatus, applyWebhookEvent, MAX_PENDING_INBOX_SHARES, pendingInboxShares, uploadIdFromUrl,
} from './tiktokPublish.js';
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

    it('refuses to schedule an unknown platform, or a non-video TikTok post', () => {
        assert.match(unsupportedPlatformCombination('twitter', 'image')!, /Unknown platform/);
        assert.match(unsupportedPlatformCombination('tiktok', 'image')!, /must be videos/);
        assert.equal(unsupportedPlatformCombination('tiktok', 'video'), null);
    });
});
