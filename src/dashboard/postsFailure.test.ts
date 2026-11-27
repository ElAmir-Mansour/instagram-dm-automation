/**
 * Posts speaks the failure translator (U3 PR B, following #332): every place `posts.js` printed what Meta, TikTok or the server said
 * now says the translator's sentence (`UI.failure`, `UI.failureLine`), in the interface language, with the raw text only behind a
 * native Details. The REAL `posts.js` and both catalogues in a `node:vm` context through `_harness.ts`, with the API stubbed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, type Json } from './_harness.js';

const RAW = 'Error validating access token: Session has expired on Friday, 27-Nov-26 at 10:00 PST';
const post = (over: Json = {}): Json => ({
    id: 'p1', platform: 'instagram', post_type: 'video', status: 'FAILED', caption: 'hello', media_url: null, cover_url: null,
    scheduled_time: new Date().toISOString(), error_log: RAW, archived_at: null, published_post_id: null, ...over,
});

function load(lang: 'ar' | 'en' = 'en') {
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/posts.js'], globals: { API: { token: 'tok' }, Admin: { emptyState: () => '', confirm: () => {} }, App: { canOperate: () => true } } });
    h.UI.setZone('Asia/Kuwait');
    const toasts: string[] = [];
    h.UI.toast = (message: string) => { toasts.push(String(message)); return null; };
    return { h, P: h.run<Json>('PostsPage'), toasts };
}
/** The markup with every `<details>` taken out: what is on the screen before anybody opens Details. */
const outside = (markup: unknown): string => String(markup).replace(/<details[\s\S]*?<\/details>/g, '');
const inside = (markup: unknown): string => [...String(markup).matchAll(/<details[\s\S]*?<\/details>/g)].map((m) => m[0]).join(' ');

describe('posts.js: a failed post says the sentence, and keeps Meta’s words behind Details', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`the card of a failed post (${lang})`, () => {
            const { h, P } = load(lang);
            const markup = String(P.renderScheduledCard(post()));
            assert.ok(outside(markup).includes(h.t('failure.META_TOKEN_EXPIRED')), 'the sentence');
            assert.ok(outside(markup).includes(h.t('posts.errorLabel')), 'under the same label as before');
            assert.equal(outside(markup).includes('Session has expired'), false, 'Meta’s English is not on the card');
            assert.ok(inside(markup).includes('Session has expired'), 'it is behind Details');
        });
    }

    it('says the generic sentence, not an empty one, for a failed post with no text', () => {
        const { h, P } = load();
        const markup = String(P.renderScheduledCard(post({ error_log: null })));
        assert.ok(outside(markup).includes(h.t('failure.generic')));
    });

    it('a held post (PENDING with a note) is a warning line with the same translation', () => {
        const { h, P } = load();
        const markup = String(P.renderScheduledCard(post({ status: 'PENDING', error_log: 'Held: waiting for TikTok to approve the inbox draft', platform: 'tiktok' })));
        assert.ok(outside(markup).includes(h.t('failure.TIKTOK_HELD_APPROVAL')), outside(markup));
        assert.equal(outside(markup).includes('Held: waiting for TikTok'), false);
    });

    it('a post put away (archived) keeps its old failure, neutral, as a sentence', () => {
        const { h, P } = load();
        const markup = String(P.renderScheduledCard(post({ archived_at: '2026-11-20T10:00:00Z' })));
        assert.ok(outside(markup).includes(h.t('failure.META_TOKEN_EXPIRED')));
        assert.equal(outside(markup).includes('Session has expired'), false);
    });

    it('a YouTube short’s note is the sentence', () => {
        const { h, P } = load();
        const markup = String(P.renderScheduledCard(post({ platform: 'youtube', status: 'PUBLISHED', published_post_id: 'YT:abcdefghijk', error_log: 'Uploaded to YouTube as private: the app is not audited yet' })));
        assert.ok(outside(markup).includes(h.t('failure.YOUTUBE_PRIVATE_UPLOAD')), outside(markup));
    });

    it('a boost’s error is a failure too', () => {
        const { h, P } = load();
        const markup = String(P.renderBoostBox({ id: 'b1', status: 'failed', platform: 'instagram', currency: 'USD', error: RAW }));
        assert.ok(outside(markup).includes(h.t('failure.META_TOKEN_EXPIRED')));
        assert.equal(outside(markup).includes('Session has expired'), false);
    });

    it('a failed first comment says the sentence in its line and the raw text behind Details', () => {
        const { h, P } = load();
        const markup = String(P.renderScheduledCard(post({ status: 'PUBLISHED', published_post_id: 'FB:1 | IG:2', first_comment: 'Sources', first_comment_status: { instagram: { status: 'failed', at: '2026-11-27T10:00:00Z', attempt: 1, error: RAW } } })));
        assert.ok(outside(markup).includes(h.t('failure.META_TOKEN_EXPIRED')), outside(markup));
        assert.ok(inside(markup).includes('Session has expired'));
    });
});

describe('posts.js: the other ways a failure reaches the screen', () => {
    it('the TikTok failed toast says the sentence, not TikTok’s text', () => {
        const src = String(load().h.run<Json>('PostsPage.handleCreate'));
        assert.ok(src.includes('UI.failureLine(tiktokRow.error_log'), 'wired in the create handler');
        assert.equal(/failedToast', \{ message: tiktokRow\.error_log/.test(src), false);
    });

    it('the creator error says the sentence and keeps the server’s words behind Details; our own sentence needs none', () => {
        const { h, P } = load();
        const failure = Object.assign(new Error('TikTok post init failed: video.publish scope missing'), { status: 502 });
        const markup = String(P.tiktokCreatorError(failure));
        assert.ok(outside(markup).includes(h.t('failure.TIKTOK_PRIVATE_ONLY')), outside(markup));
        assert.equal(outside(markup).includes('scope missing'), false);
        assert.ok(inside(markup).includes('scope missing'));
        const ours = String(P.tiktokCreatorError(h.t('posts.tiktok.direct.noCreator'), true));
        assert.ok(ours.includes(h.t('posts.tiktok.direct.noCreator')));
        assert.equal(ours.includes('<details'), false);
    });

    it('a publish failure is the translated line; the raw text is kept for Details; a message of the dashboard’s own is left alone', () => {
        const { h, P } = load();
        const fromBody = Object.assign(new Error('x'), { status: 502, body: { error: RAW } });
        assert.equal(P.publishFailure(null, fromBody), `${h.t('failure.META_TOKEN_EXPIRED')} ${h.t('failure.META_TOKEN_EXPIRED.next')}`);
        assert.equal(P.publishFailureRaw(null, fromBody), RAW);
        assert.equal(P.publishFailure({ status: 'FAILED', error: RAW }, null), `${h.t('failure.META_TOKEN_EXPIRED')} ${h.t('failure.META_TOKEN_EXPIRED.next')}`);
        assert.equal(P.publishFailureRaw({ status: 'FAILED', error: RAW }, null), RAW);
        const network = Object.assign(new Error(h.t('http.network')), { isNetworkError: true });
        assert.equal(P.publishFailure(null, network), h.t('http.network'));
        assert.equal(P.publishFailureRaw(null, network), '');
        assert.equal(P.publishFailure({ status: 'PUBLISHED' }, null), null);
        assert.equal(P.publishFailure(null, Object.assign(new Error('x'), { status: 502, body: { error: '' } })), 'x');
    });

    it('the publish panel shows the sentence and Details', () => {
        const { h, P } = load();
        P.publishError = { message: 'Sentence.', raw: RAW };
        const markup = String(P.renderPublishErrorPanel());
        assert.ok(outside(markup).includes('Sentence.'));
        assert.ok(inside(markup).includes('Session has expired'));
        assert.ok(h.t('error.details'));
    });

    it('a slide that failed to upload keeps a tooltip a person can read: translated when it can be, the server’s words after the generic line when not', () => {
        const { h, P } = load();
        const coded = Object.assign(new Error('Too large'), { status: 413, code: 'RATE_LIMITED', body: { error: 'Too large' } });
        assert.equal(typeof P.errorLine(coded, true), 'string');
        const odd = Object.assign(new Error('x'), { status: 400, body: { error: 'Image is 9 MB' } });
        assert.ok(P.errorLine(odd, true).includes('Image is 9 MB'), 'the hover text keeps what the server said');
        assert.ok(P.errorLine(odd).startsWith(h.t('failure.generic')), 'a line for a sentence is the generic one');
        assert.equal(P.errorLine(null), h.t('error.unexpected'));
    });
});
