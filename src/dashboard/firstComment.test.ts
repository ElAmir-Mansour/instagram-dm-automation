/**
 * The first comment on Posts (v61): the textarea with its counter in the composer, what the card says about each platform's comment
 * (waiting, posted, failed with its reason and a Retry), the submit chain, and the Retry action. The REAL `posts.js` and both catalogues in a
 * `node:vm` context through `_harness.ts`, with the API stubbed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
const post = (over: Json = {}): Json => ({
    id: 'p1', platform: 'both', post_type: 'video', status: 'PUBLISHED', caption: 'hello', media_url: null, cover_url: null,
    scheduled_time: new Date().toISOString(), error_log: null, archived_at: null, published_post_id: 'FB:1 | IG:2', first_comment: 'Sources', first_comment_status: null, ...over,
});

function load(lang: 'ar' | 'en' = 'en') {
    const retries: Array<{ id: string; platform: string }> = [];
    let failure: Error | null = null;
    const api: Json = {
        token: 'tok',
        retryFirstComment: (id: string, platform: string) => { retries.push({ id, platform }); return failure ? Promise.reject(failure) : Promise.resolve({ queued: [platform] }); },
    };
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/posts.js'], globals: { API: api, Admin: { emptyState: () => '', confirm: () => {} }, App: { canOperate: () => true } } });
    const P = h.run('PostsPage');
    const toasts: Array<{ message: string; arg: Json }> = [];
    h.UI.toast = (message: string, arg: Json) => { toasts.push({ message, arg }); return null; };
    h.UI.setZone('Asia/Kuwait');
    return { h, P, retries, toasts, fail: (e: Error | null) => { failure = e; } };
}
const card = (r: ReturnType<typeof load>, p: Json): string => String(r.P.renderScheduledCard(p));
const entry = (status: string, extra: Json = {}): Json => ({ status, at: '2026-11-27T10:00:00Z', attempt: 0, ...extra });

describe('the composer field', () => {
    it('is a textarea named first_comment with a counter against 2,200, empty for a new post and filled for an edit', () => {
        const r = load();
        const empty = String(r.P.firstCommentField(null));
        assert.match(empty, /<textarea[^>]*id="post-first-comment"[^>]*name="first_comment"/);
        assert.match(empty, /data-input="posts:firstCommentInput"/);
        assert.ok(text(empty).includes('0/2,200'), text(empty));
        assert.ok(text(empty).includes('First comment'));
        const filled = String(r.P.firstCommentField(post({ first_comment: 'Sources\n1. A' })));
        assert.ok(filled.includes('Sources\n1. A'));
        assert.doesNotMatch(filled, /\bdisabled\b/);
    });

    it('is read-only once a platform\'s comment is posted or in flight, and says why; a failed one can still be edited', () => {
        const r = load();
        for (const status of ['posted', 'sending']) {
            const markup = String(r.P.firstCommentField(post({ first_comment_status: { instagram: entry(status) } })));
            assert.match(markup, /<textarea[^>]*\bdisabled\b/, status);
            assert.ok(text(markup).includes('can no longer be edited'), status);
        }
        const failed = String(r.P.firstCommentField(post({ first_comment_status: { instagram: entry('failed', { error: 'x' }) } })));
        assert.doesNotMatch(failed, /<textarea[^>]*\bdisabled\b/);
    });

    it('is in the create and edit modals, and shown only for Instagram and Facebook', () => {
        const src = readFileSync('dashboard/js/pages/posts.js', 'utf8');
        assert.equal((src.match(/\$\{this\.firstCommentField\(/g) ?? []).length, 2, 'create and edit');
        const r = load();
        const group = r.h.el('first-comment-group');
        for (const [platform, hidden] of [['instagram', false], ['facebook', false], ['both', false], ['tiktok', true], ['youtube', true]] as const) {
            r.P.applyFirstCommentVisibility(platform);
            assert.equal(group.classList.contains('hidden'), hidden, platform);
        }
    });

    it('checks the length in the submit chain, naming the field', () => {
        const r = load();
        assert.equal(r.P.checkFirstComment({}), null);
        assert.equal(r.P.checkFirstComment({ first_comment: null }), null);
        assert.equal(r.P.checkFirstComment({ first_comment: 'x'.repeat(2200) }), null);
        const over = r.P.checkFirstComment({ first_comment: 'x'.repeat(2201) });
        assert.equal(over.field, 'post-first-comment');
        assert.match(over.message, /at most 2,200 characters, and yours has 2,201/);
    });
});

describe('the card', () => {
    it('says nothing for a post with no comment', () => {
        const r = load();
        assert.doesNotMatch(card(r, post({ first_comment: null })), /First comment/);
    });

    it('a waiting post says the comment goes out once it is live', () => {
        const r = load();
        assert.ok(text(card(r, post({ status: 'PENDING', published_post_id: null }))).includes('posts under the post as soon as it is live'));
    });

    it('shows each platform: waiting, posted, and failed with its reason and a Retry that names the post and platform', () => {
        const r = load();
        const markup = card(r, post({ first_comment_status: { instagram: entry('failed', { error: 'Permission denied' }), facebook: entry('posted', { id: 'c1' }) } }));
        const said = text(markup);
        // The reason is the failure translator's sentence (U3 wired posts.js to it); what Meta said is behind Details.
        assert.ok(said.includes('First comment failed on Instagram: Something went wrong'), said);
        assert.match(markup, /<details class="error-details">[\s\S]*Permission denied/);
        assert.ok(said.includes('The post itself is live'), said);
        assert.ok(said.includes('First comment posted on Facebook.'), said);
        assert.match(markup, /data-action="posts:retryFirstComment"[^>]*data-id="p1"[^>]*data-platform="instagram"|data-platform="instagram"[^>]*data-action="posts:retryFirstComment"/);
        assert.equal((markup.match(/posts:retryFirstComment/g) ?? []).length, 1, 'a posted comment has no Retry');
        const waiting = text(card(r, post({ first_comment_status: { instagram: entry('pending') } })));
        assert.ok(waiting.includes('waiting to post on Instagram'), waiting);
        const sending = text(card(r, post({ first_comment_status: { instagram: entry('sending') } })));
        assert.ok(sending.includes('posting on Instagram'), sending);
    });

    it('escapes what Meta said', () => {
        const r = load();
        const markup = card(r, post({ first_comment_status: { instagram: entry('failed', { error: '<img src=x onerror=alert(1)>' }) } }));
        assert.doesNotMatch(markup, /<img src=x/);
    });

    it('is in Arabic too', () => {
        const r = load('ar');
        const said = text(card(r, post({ first_comment_status: { facebook: entry('failed', { error: 'x' }) } })));
        assert.ok(said.includes('تعذّر نشر التعليق الأول على فيسبوك'), said);
        assert.ok(said.includes('أعد المحاولة'), said);
    });
});

describe('Retry', () => {
    it('asks the server once for that platform and shows it as waiting', async () => {
        const r = load();
        r.P.posts = [post({ first_comment_status: { instagram: entry('failed', { error: 'x', attempt: 1 }) } })];
        r.P.activeTab = 'other';
        await r.P.retryFirstComment('p1', 'instagram');
        assert.deepEqual(r.retries, [{ id: 'p1', platform: 'instagram' }]);
        assert.deepEqual([r.P.posts[0].first_comment_status.instagram.status, r.P.posts[0].first_comment_status.instagram.attempt], ['pending', 2]);
        assert.ok(r.toasts[0]!.message.includes('Queued'));
    });

    it('says why when the server refuses, and leaves the card as it was', async () => {
        const r = load();
        r.P.posts = [post({ first_comment_status: { instagram: entry('failed', { error: 'x' }) } })];
        r.P.activeTab = 'other';
        r.fail(Object.assign(new Error('nope'), { code: 'FIRST_COMMENT_NOT_FAILED', body: { code: 'FIRST_COMMENT_NOT_FAILED' } }));
        await r.P.retryFirstComment('p1', 'instagram');
        assert.equal(r.P.posts[0].first_comment_status.instagram.status, 'failed');
        assert.ok(r.toasts[0]!.message.includes('Could not retry'));
    });
});
