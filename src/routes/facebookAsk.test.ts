/**
 * "Add keyword ask" on a Facebook video: the pure rules, and the routes with Meta mocked.
 * Nothing here reaches Meta; metaHttp is replaced and every call is recorded.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from '../services/http.js';
import { API_VERSION } from '../services/instagram.js';
import { askCandidates, askKeywordOptions, askLanguage, askState, askText, mentionsAsk, withAsk } from '../services/facebookAsk.js';
import { ASK_POOL } from '../services/monteur/copy.js';
import { growthRouter } from './growth.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MEDIA = '100560442828593_1126942440172514';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

const camp = (trigger_keyword: string, extra: Record<string, unknown> = {}) =>
    ({ id: `c-${trigger_keyword}`, trigger_keyword, post_id: null, is_active: true, match_mode: 'substring', created_at: '2026-01-01', ...extra });

describe('ask detection', () => {
    const campaigns = [camp('كورس'), camp('ستيتش, ستتش', { match_mode: 'word' }), camp('محلي, local')];

    it('finds the word an ask names, quoted or after the verb', () => {
        assert.deepEqual(askCandidates('اكتب «ستيتش» وأرسل لك الدليل'), ['ستيتش']);
        assert.deepEqual(askCandidates('اكتب كورس في التعليقات'), ['كورس']);
        assert.ok(askCandidates('اكتب كلمة "محلي" بالتعليقات 👇').includes('محلي'));
        assert.deepEqual(askCandidates('Comment «guide» below'), ['guide']);
        assert.deepEqual(askCandidates('just a caption with «quotes» but no verb'), []);
    });

    it('live when a campaign answers the word, dead when none does, none without an ask', () => {
        assert.equal(askState('اكتب كورس في التعليقات', MEDIA, campaigns), 'live');
        assert.equal(askState('ودك الدليل؟ اكتب «ستيتش»', MEDIA, campaigns), 'live');
        assert.equal(askState('📩 اكتب كلمة «ريموشن» او "edit" في الكومنتس', MEDIA, campaigns), 'dead');
        assert.equal(askState('إزاي تخلي الذكاء الاصطناعي يشتغل مكانك', MEDIA, campaigns), 'none');
    });

    it('a campaign tied to another post does not answer this one', () => {
        assert.equal(askState('اكتب «ستيتش»', MEDIA, [camp('ستيتش', { post_id: 'other_post' })]), 'dead');
    });
});

describe('keyword options and wording', () => {
    it('lists only keywords a live campaign answers here, post-specific first, each once', () => {
        const list = askKeywordOptions(MEDIA, [
            camp('كورس'), camp('local'), camp('خاص', { post_id: MEDIA }), camp('بعيد', { post_id: 'x_y' }),
            camp('قديم', { is_active: false }), camp('كورس, محلي'),
        ], 'اكتب محلي');
        assert.deepEqual(list, ['خاص', 'محلي', 'كورس', 'local']);
    });

    it('builds the line from the Monteur pool, in the caption\'s language, wrapping the variant', () => {
        assert.equal(askLanguage('اكتب كورس'), 'ar');
        assert.equal(askLanguage('Comment guide'), 'en');
        assert.equal(askText('كورس', 'ar', 0), ASK_POOL.ar[0]!.replace('{keyword}', 'كورس'));
        assert.equal(askText('guide', 'en', ASK_POOL.en.length + 1), ASK_POOL.en[1]!.replace('{keyword}', 'guide'));
        assert.equal(askText('x', 'en', -1), ASK_POOL.en.at(-1)!.replace('{keyword}', 'x'));
    });

    it('appends on its own paragraph and spots its own line', () => {
        assert.equal(withAsk('caption\n', 'ask'), 'caption\n\nask');
        assert.equal(withAsk('', 'ask'), 'ask');
        assert.ok(mentionsAsk(askText('كورس', 'ar'), 'كورس'));
        assert.ok(!mentionsAsk('كورس', 'كورس'));
    });
});

// ─── Routes ──────────────────────────────────────────────────────────────────────────────

type Rows = { rows: any[]; rowCount?: number };
let routes: [RegExp, (params: any[]) => Rows][] = [];
let metaCalls: { method: string; url: string; body?: any; config?: any }[] = [];
let onPost: (url: string, body: any) => Promise<any>;
let onGet: (url: string) => Promise<any>;
const original = { query: pool.query, post: metaHttp.post, get: metaHttp.get };

let restoreSink: (() => void) | undefined;
before(() => { const prev = setLogSink(() => {}); restoreSink = () => setLogSink(prev); });
after(() => restoreSink?.());

const metaError = (code: number, status = 400) =>
    Object.assign(new Error('meta'), { response: { status, data: { error: { code, message: `meta ${code}` } } } });

function arrange(opts: { caption?: string; mediaType?: string; campaigns?: any[] } = {}) {
    routes = [
        [/FROM post_insights/, () => ({ rows: [{ media_id: MEDIA, media_type: opts.mediaType ?? 'VIDEO', caption: opts.caption ?? 'شرح الفيديو', permalink: null }] })],
        [/FROM campaigns/, () => ({ rows: opts.campaigns ?? [camp('كورس')] })],
        [/FROM creators/, () => ({ rows: [{ id: TENANT, page_access_token: 'EAAG-test' }] })],
    ];
}

beforeEach(() => {
    routes = [];
    metaCalls = [];
    onPost = async (url) => { throw new Error(`no POST arranged for ${url}`); };
    onGet = async (url) => { throw new Error(`no GET arranged for ${url}`); };
    (pool as any).query = async (sql: string) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        const route = routes.find(([p]) => p.test(flat));
        const r = route ? route[1]([]) : { rows: [] };
        return { rows: r.rows, rowCount: r.rows.length };
    };
    (metaHttp as any).post = (url: string, body: any, config: any) => { metaCalls.push({ method: 'post', url, body, config }); return onPost(url, body); };
    (metaHttp as any).get = (url: string, config: any) => { metaCalls.push({ method: 'get', url, config }); return onGet(url); };
});
afterEach(() => {
    (pool as any).query = original.query;
    (metaHttp as any).post = original.post;
    (metaHttp as any).get = original.get;
});

function call(path: string, body: Record<string, unknown>): Promise<any> {
    const layer = (growthRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post);
    assert.ok(layer, `POST ${path} must be mounted`);
    const res: any = {
        statusCode: 200, body: null,
        status(c: number) { this.statusCode = c; return this; },
        json(p: unknown) { this.body = p; return this; },
        setHeader() {},
    };
    return layer.route.stack.at(-1).handle(
        { params: {}, query: {}, headers: {}, body, session: { userId: 'u-1', role: 'user', tenantId: TENANT }, tenantRole: 'operator' }, res, () => {}
    ).then(() => res);
}
const posts = () => metaCalls.filter((c) => c.method === 'post');
const commentPosts = () => posts().filter((c) => c.url.endsWith('/comments'));

describe('POST /facebook-ask/preview', () => {
    it('shows the exact line and the keywords, and sends nothing', async () => {
        arrange({ campaigns: [camp('كورس'), camp('محلي')] });
        const res = await call('/facebook-ask/preview', { media_id: MEDIA, keyword: 'محلي', variant: 1 });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.keywords, ['كورس', 'محلي']);
        assert.equal(res.body.keyword, 'محلي');
        assert.equal(res.body.text, ASK_POOL.ar[1]!.replace('{keyword}', 'محلي'));
        assert.equal(metaCalls.length, 0);
    });

    it('has no keyword and no text when no campaign answers the post', async () => {
        arrange({ campaigns: [] });
        const res = await call('/facebook-ask/preview', { media_id: MEDIA });
        assert.deepEqual(res.body.keywords, []);
        assert.equal(res.body.text, null);
    });

    it('refuses a post that is not a video', async () => {
        arrange({ mediaType: 'IMAGE' });
        const res = await call('/facebook-ask/preview', { media_id: MEDIA });
        assert.equal(res.statusCode, 422);
        assert.equal(res.body.code, 'not_video');
    });
});

describe('POST /facebook-ask', () => {
    it('edits the post text, keeping the caption and adding the line', async () => {
        arrange();
        onGet = async () => ({ data: { message: 'شرح الفيديو' } });
        onPost = async () => ({ data: { success: true } });
        const res = await call('/facebook-ask', { media_id: MEDIA, keyword: 'كورس', variant: 0 });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.mechanism, 'edit');
        assert.equal(posts().length, 1);
        assert.equal(posts()[0]!.url, `${BASE}/${MEDIA}`);
        assert.equal(posts()[0]!.body.message, `شرح الفيديو\n\n${ASK_POOL.ar[0]!.replace('{keyword}', 'كورس')}`);
    });

    it('refuses when the live text already has a working ask (idempotent)', async () => {
        arrange();
        onGet = async () => ({ data: { message: 'شرح\n\nاكتب «كورس» وأرسل لك' } });
        const res = await call('/facebook-ask', { media_id: MEDIA, keyword: 'كورس' });
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'already_asked');
        assert.equal(posts().length, 0);
    });

    it('refuses without an active campaign, and for a keyword no campaign answers', async () => {
        arrange({ campaigns: [] });
        let res = await call('/facebook-ask', { media_id: MEDIA, keyword: 'كورس' });
        assert.equal(res.body.code, 'no_campaign');
        arrange({ campaigns: [camp('كورس')] });
        res = await call('/facebook-ask', { media_id: MEDIA, keyword: 'غيره' });
        assert.equal(res.statusCode, 422);
        assert.equal(res.body.code, 'keyword_not_live');
        assert.equal(metaCalls.length, 0);
    });

    it('will not overwrite a caption it could not read', async () => {
        arrange();
        onGet = async () => ({ data: {} });
        const res = await call('/facebook-ask', { media_id: MEDIA, keyword: 'كورس' });
        assert.equal(res.body.code, 'text_unreadable');
        assert.equal(posts().length, 0);
    });

    it('falls back to a Page comment when Meta will not edit the object; a create that may have landed is not retried', async () => {
        arrange();
        onGet = async (url) => (url.endsWith('/comments') ? { data: { data: [{ message: 'شكرا' }] } } : { data: { message: 'شرح الفيديو' } });
        onPost = async (url) => {
            if (url.endsWith('/comments')) throw metaError(1, 500);
            throw metaError(100);
        };
        const res = await call('/facebook-ask', { media_id: MEDIA, keyword: 'كورس' });
        assert.equal(res.statusCode, 502);
        assert.equal(commentPosts().length, 1);
    });

    it('posts the comment on fallback, unless the ask is already in the comments', async () => {
        arrange();
        onGet = async (url) => (url.endsWith('/comments') ? { data: { data: [] } } : { data: { message: 'شرح' } });
        onPost = async (url) => {
            if (url.endsWith('/comments')) return { data: { id: 'cm-1' } };
            throw metaError(100);
        };
        let res = await call('/facebook-ask', { media_id: MEDIA, keyword: 'كورس' });
        assert.equal(res.body.mechanism, 'comment');
        assert.equal(commentPosts()[0]!.url, `${BASE}/${MEDIA}/comments`);

        metaCalls = [];
        onGet = async (url) => (url.endsWith('/comments') ? { data: { data: [{ message: 'اكتب «كورس»' }] } } : { data: { message: 'شرح' } });
        res = await call('/facebook-ask', { media_id: MEDIA, keyword: 'كورس' });
        assert.equal(res.statusCode, 409);
        assert.equal(commentPosts().length, 0);
    });

    it('does not route around a missing permission', async () => {
        arrange();
        onGet = async () => ({ data: { message: 'شرح' } });
        onPost = async () => { throw metaError(200, 403); };
        const res = await call('/facebook-ask', { media_id: MEDIA, keyword: 'كورس' });
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'permission');
        assert.equal(posts().length, 1);
    });
});
