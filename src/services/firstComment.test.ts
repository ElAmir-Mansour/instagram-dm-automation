/**
 * The first comment (v61): its validation, the queueing after a publish, the job that posts it, and Retry. Meta is a stubbed `metaHttp` that throws on anything
 * not arranged; the table and the queue are the in-memory ones of `firstCommentTestSupport.ts`.
 */
import assert from 'node:assert/strict';
import { afterEach, after, before, beforeEach, describe, it } from 'node:test';
import { metaHttp } from './http.js';
import { API_VERSION } from './instagram.js';
import { setLogSink } from '../utils/log.js';
import {
    commentTargets, FIRST_COMMENT_MAX, firstCommentDedupeKey, queueFirstComments, retryFirstComment, runFirstCommentJob, validateFirstComment,
} from './firstComment.js';
import { installFakeWorld, type FakePost, type FakeWorld } from './firstCommentTestSupport.js';

const BASE = `https://graph.facebook.com/${API_VERSION}`;
const TENANT = '11111111-1111-4111-8111-111111111111';
const POST = '33333333-3333-4333-8333-333333333333';
const originalPost = metaHttp.post;

let restoreSink: (() => void) | undefined;
let logged: Array<Record<string, any>> = [];
before(() => {
    const previous = setLogSink((_level, line) => { try { logged.push(JSON.parse(line)); } catch { /* not structured */ } });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

let world: FakeWorld;
let restore: () => void;
let posts: Array<{ url: string; body: any; config: any }>;
let onPost: (url: string, body: any) => Promise<any>;

const livePost = (over: Partial<FakePost> = {}): FakePost => ({
    id: POST, creator_id: TENANT, platform: 'both', status: 'PUBLISHED', first_comment: 'Sources\n1. A paper',
    first_comment_status: null, published_post_id: 'FB:fb-1 | IG:ig-1', ...over,
});

function arrange(post: FakePost | null) {
    ({ world, restore } = installFakeWorld(post));
}

beforeEach(() => {
    logged = [];
    posts = [];
    onPost = async (url) => { throw new Error(`no Meta POST arranged for ${url}`); };
    (metaHttp as any).post = (url: string, body: any, config: any) => { posts.push({ url, body, config }); return onPost(url, body); };
});
afterEach(() => {
    (metaHttp as any).post = originalPost;
    restore?.();
});

const payload = (platform: 'instagram' | 'facebook', attempt = 0) => ({ postId: POST, creatorId: TENANT, platform, attempt });

describe('validateFirstComment', () => {
    it('absent is "not sent", null and blank clear it, text is trimmed', () => {
        assert.deepEqual(validateFirstComment(undefined, 'both'), { ok: true, provided: false, value: null });
        assert.deepEqual(validateFirstComment(null, 'both'), { ok: true, provided: true, value: null });
        assert.deepEqual(validateFirstComment('  \n ', 'instagram'), { ok: true, provided: true, value: null });
        assert.deepEqual(validateFirstComment('  hi \n', 'facebook'), { ok: true, provided: true, value: 'hi' });
    });
    it('refuses what is not text, and more than 2,200 characters (counted after trimming)', () => {
        assert.equal(validateFirstComment(5, 'both').ok, false);
        assert.equal(validateFirstComment({}, 'both').ok, false);
        assert.equal(validateFirstComment('x'.repeat(FIRST_COMMENT_MAX), 'both').ok, true);
        const over = validateFirstComment('x'.repeat(FIRST_COMMENT_MAX + 1), 'both');
        assert.equal(over.ok, false);
        assert.equal(validateFirstComment(` ${'x'.repeat(FIRST_COMMENT_MAX)} `, 'both').ok, true);
    });
    it('refuses a comment for TikTok and YouTube, but not a blank one (clearing is always fine)', () => {
        for (const platform of ['tiktok', 'youtube']) {
            assert.equal(validateFirstComment('sources', platform).ok, false, platform);
            assert.equal(validateFirstComment('', platform).ok, true, platform);
            assert.equal(validateFirstComment(undefined, platform).ok, true, platform);
        }
    });
});

describe('commentTargets', () => {
    it('is each platform the row is for AND has an id on', () => {
        assert.deepEqual(commentTargets('both', { fb: 'f', ig: 'i' }), ['instagram', 'facebook']);
        assert.deepEqual(commentTargets('both', { fb: 'f', ig: null }), ['facebook']);
        assert.deepEqual(commentTargets('instagram', { fb: 'f', ig: 'i' }), ['instagram']);
        assert.deepEqual(commentTargets('facebook', { fb: 'f', ig: 'i' }), ['facebook']);
        assert.deepEqual(commentTargets('tiktok', { fb: 'f', ig: 'i' }), []);
        assert.deepEqual(commentTargets('youtube', { fb: 'f', ig: 'i' }), []);
    });
});

describe('queueFirstComments (called by attemptPublish after PUBLISHED)', () => {
    it('queues one job per live platform, pending, keyed by post + platform', async () => {
        arrange(livePost());
        await queueFirstComments({ id: POST, creator_id: TENANT, platform: 'both', first_comment: 'Sources' }, { fbId: 'fb-1', igId: 'ig-1' });
        assert.deepEqual(world.enqueued.map((j) => [j.kind, j.dedupeKey, (j.payload as any).platform]), [
            ['post.first_comment', `fc:${POST}:instagram`, 'instagram'],
            ['post.first_comment', `fc:${POST}:facebook`, 'facebook'],
        ]);
        assert.equal(world.post!.first_comment_status!.instagram!.status, 'pending');
        assert.equal(world.post!.first_comment_status!.facebook!.status, 'pending');
        assert.equal(world.post!.status, 'PUBLISHED', 'the post is untouched');
    });

    it('queues nothing for an empty or blank comment, or for none', async () => {
        arrange(livePost());
        for (const first_comment of [null, undefined, '', '  \n']) {
            await queueFirstComments({ id: POST, creator_id: TENANT, platform: 'both', first_comment }, { fbId: 'fb-1', igId: 'ig-1' });
        }
        assert.deepEqual(world.enqueued, []);
        assert.equal(world.post!.first_comment_status, null);
    });

    it('leaves a platform that already has an entry alone (a republish after a partial publish queues no duplicate)', async () => {
        arrange(livePost({ first_comment_status: { facebook: { status: 'posted', id: 'c-1', at: 'x', attempt: 0 } } }));
        await queueFirstComments({ id: POST, creator_id: TENANT, platform: 'both', first_comment: 'S' }, { fbId: 'fb-1', igId: 'ig-1' });
        assert.deepEqual(world.enqueued.map((j) => (j.payload as any).platform), ['instagram']);
        assert.equal(world.post!.first_comment_status!.facebook!.status, 'posted');
    });

    it('never throws: a queue that is down marks that platform failed with a way forward, and the post stays PUBLISHED', async () => {
        arrange(livePost());
        world.enqueueError = new Error('queue down');
        await queueFirstComments({ id: POST, creator_id: TENANT, platform: 'both', first_comment: 'S' }, { fbId: 'fb-1', igId: 'ig-1' });
        assert.equal(world.post!.first_comment_status!.instagram!.status, 'failed');
        assert.match(world.post!.first_comment_status!.instagram!.error!, /Retry/);
        assert.equal(world.post!.status, 'PUBLISHED');
        assert.ok(logged.some((l) => l.event === 'first_comment.queue_failed'));
    });
});

describe('the post.first_comment job', () => {
    const pendingBoth = () => livePost({ first_comment_status: { instagram: { status: 'pending', at: 'x', attempt: 0 }, facebook: { status: 'pending', at: 'x', attempt: 0 } } });

    it('posts to /{ig-media-id}/comments on Instagram, with the page credential in the header, once, and records the comment id', async () => {
        arrange(pendingBoth());
        onPost = async () => ({ data: { id: 'ig-comment-1' } });
        await runFirstCommentJob(payload('instagram'));
        assert.equal(posts.length, 1);
        assert.equal(posts[0]!.url, `${BASE}/ig-1/comments`);
        assert.deepEqual(posts[0]!.body, { message: 'Sources\n1. A paper' });
        assert.equal(posts[0]!.config.headers.Authorization, 'Bearer plain-page-token');
        const entry = world.post!.first_comment_status!.instagram!;
        assert.equal(entry.status, 'posted');
        assert.equal(entry.id, 'ig-comment-1');
        assert.equal(world.post!.first_comment_status!.facebook!.status, 'pending', 'the other platform is its own job');
        assert.equal(world.post!.status, 'PUBLISHED');
    });

    it('posts to /{post-id}/comments on Facebook', async () => {
        arrange(pendingBoth());
        onPost = async () => ({ data: { id: 'fb-comment-1' } });
        await runFirstCommentJob(payload('facebook'));
        assert.equal(posts[0]!.url, `${BASE}/fb-1/comments`);
        assert.equal(world.post!.first_comment_status!.facebook!.status, 'posted');
    });

    it('a Meta refusal is recorded as failed with its reason, the job ends without throwing, and the post stays PUBLISHED', async () => {
        arrange(pendingBoth());
        onPost = async () => { throw Object.assign(new Error('x'), { response: { status: 400, data: { error: { code: 10, message: 'Permission denied' } } } }); };
        await runFirstCommentJob(payload('instagram'));
        const entry = world.post!.first_comment_status!.instagram!;
        assert.equal(entry.status, 'failed');
        assert.match(entry.error!, /Permission denied/);
        assert.equal(world.post!.status, 'PUBLISHED', 'a failed comment never fails the post');
        assert.ok(!world.sql.some((s) => /SET status\b|status = 'FAILED'/.test(s)), 'no statement touches scheduled_posts.status');
    });

    it('a timeout that may have landed is NOT retried (it would post twice): one call, then failed', async () => {
        arrange(pendingBoth());
        onPost = async () => { throw Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }); };
        await runFirstCommentJob(payload('facebook'));
        assert.equal(posts.length, 1, 'one attempt, no retry');
        assert.equal(world.post!.first_comment_status!.facebook!.status, 'failed');
    });

    it('a 5xx is not retried either', async () => {
        arrange(pendingBoth());
        onPost = async () => { throw Object.assign(new Error('bad gateway'), { response: { status: 502, data: {} } }); };
        await runFirstCommentJob(payload('instagram'));
        assert.equal(posts.length, 1);
    });

    it('does not call Meta for an entry that is not pending: posted, failed or absent', async () => {
        for (const first_comment_status of [
            { instagram: { status: 'posted', id: 'c', at: 'x', attempt: 0 } }, { instagram: { status: 'failed', error: 'e', at: 'x', attempt: 0 } }, null,
        ] as const) {
            arrange(livePost({ first_comment_status: first_comment_status as any }));
            await runFirstCommentJob(payload('instagram'));
            assert.equal(posts.length, 0);
            restore();
        }
    });

    it('does not call Meta while the post is not PUBLISHED (a held reel, a failed post)', async () => {
        for (const status of ['PENDING', 'PUBLISHING', 'FAILED']) {
            arrange({ ...pendingBoth(), status });
            await runFirstCommentJob(payload('instagram'));
            assert.equal(posts.length, 0, status);
            assert.equal(world.post!.first_comment_status!.instagram!.status, 'pending', `${status}: left as it was`);
            restore();
        }
    });

    it('a run that died after claiming (status sending) does NOT post again: it says so and asks the owner to check', async () => {
        arrange(livePost({ first_comment_status: { instagram: { status: 'sending', at: 'x', attempt: 0 } } }));
        await runFirstCommentJob(payload('instagram'));
        assert.equal(posts.length, 0);
        const entry = world.post!.first_comment_status!.instagram!;
        assert.equal(entry.status, 'failed');
        assert.match(entry.error!, /may already be under the post/);
    });

    it('a comment cleared after the post went out is dropped quietly: no call, no entry', async () => {
        arrange({ ...pendingBoth(), first_comment: '  ' });
        await runFirstCommentJob(payload('instagram'));
        assert.equal(posts.length, 0);
        assert.equal(world.post!.first_comment_status!.instagram, undefined);
        assert.equal(world.post!.first_comment_status!.facebook!.status, 'pending');
    });

    it('fails closed with a plain reason when the post has no id for the platform, or Meta is not connected', async () => {
        arrange({ ...pendingBoth(), published_post_id: 'FB:fb-1' });
        await runFirstCommentJob(payload('instagram'));
        assert.match(world.post!.first_comment_status!.instagram!.error!, /no Instagram id/);
        assert.equal(posts.length, 0);
        restore();

        arrange(pendingBoth());
        world.token = null;
        await runFirstCommentJob(payload('facebook'));
        assert.match(world.post!.first_comment_status!.facebook!.error!, /not connected/);
        assert.equal(posts.length, 0);
    });

    it('never logs a field Meta\'s secrets could hide behind, and never the comment text', async () => {
        arrange(pendingBoth());
        onPost = async () => ({ data: { id: 'c' } });
        await runFirstCommentJob(payload('instagram'));
        const lines = logged.filter((l) => String(l.event).startsWith('first_comment.'));
        assert.ok(lines.length > 0);
        for (const line of lines) {
            assert.ok(!JSON.stringify(line).includes('A paper'), 'the comment text is not logged');
            assert.ok(!JSON.stringify(line).includes('plain-page-token'));
        }
    });
});

describe('retryFirstComment', () => {
    const failedIg = () => livePost({ first_comment_status: { instagram: { status: 'failed', error: 'e', at: 'x', attempt: 0 }, facebook: { status: 'posted', id: 'c', at: 'x', attempt: 0 } } });

    it('queues only the failed platform, pending again, with the next attempt number in a NEW dedupe key', async () => {
        arrange(failedIg());
        const out = await retryFirstComment(TENANT, POST);
        assert.deepEqual(out, { ok: true, queued: ['instagram'] });
        assert.deepEqual(world.enqueued.map((j) => j.dedupeKey), [`fc:${POST}:instagram:1`]);
        assert.notEqual(firstCommentDedupeKey(POST, 'instagram', 1), firstCommentDedupeKey(POST, 'instagram', 0));
        assert.deepEqual([world.post!.first_comment_status!.instagram!.status, world.post!.first_comment_status!.instagram!.attempt], ['pending', 1]);
        assert.equal(world.post!.first_comment_status!.facebook!.status, 'posted', 'a posted comment is never queued again');
    });

    it('is refused unless a comment has failed: posted, waiting, in flight or none', async () => {
        for (const status of ['posted', 'pending', 'sending'] as const) {
            arrange(livePost({ first_comment_status: { instagram: { status, at: 'x', attempt: 0 } } }));
            const out = await retryFirstComment(TENANT, POST);
            assert.deepEqual(out.ok ? null : out.code, 'NOT_FAILED', status);
            assert.deepEqual(world.enqueued, []);
            restore();
        }
        arrange(livePost());
        assert.equal((await retryFirstComment(TENANT, POST) as any).code, 'NOT_FAILED');
    });

    it('is refused for a post that is not published, for another tenant\'s post, and for a platform that did not fail', async () => {
        arrange({ ...failedIg(), status: 'PENDING' });
        assert.equal((await retryFirstComment(TENANT, POST) as any).code, 'NOT_PUBLISHED');
        restore();
        arrange(failedIg());
        assert.equal((await retryFirstComment('99999999-9999-4999-8999-999999999999', POST) as any).code, 'NOT_FOUND');
        assert.equal((await retryFirstComment(TENANT, POST, 'facebook') as any).code, 'NOT_FAILED');
        assert.deepEqual(world.enqueued, []);
    });

    it('two clicks queue it once (compare-and-set on failed)', async () => {
        arrange(failedIg());
        await retryFirstComment(TENANT, POST);
        const second = await retryFirstComment(TENANT, POST);
        assert.equal(second.ok, false);
        assert.equal(world.enqueued.length, 1);
    });

    it('a retried comment goes through the job and ends posted', async () => {
        arrange(failedIg());
        onPost = async () => ({ data: { id: 'ig-comment-2' } });
        await retryFirstComment(TENANT, POST);
        await runFirstCommentJob(world.enqueued[0]!.payload as any);
        assert.deepEqual([world.post!.first_comment_status!.instagram!.status, world.post!.first_comment_status!.instagram!.id], ['posted', 'ig-comment-2']);
    });
});
