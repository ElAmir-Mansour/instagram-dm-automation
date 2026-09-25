/**
 * Business Discovery: the mapping from Meta's answer to a card, the engagement it can honestly
 * compute (against followers — it returns no reach), and the permission check that runs before
 * any lookup is spent.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { metaHttp } from '../http.js';
import { GRAPH_BASE } from '../instagram.js';
import { discoveryError, discoveryFields, getCompetitors, mapBusinessDiscovery } from './competitors.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const original = { query: pool.query, post: metaHttp.post };
let batch: string[] = [];

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    batch = [];
    (pool as any).query = async (sql: string) => {
        if (/FROM creators WHERE id/.test(sql)) return { rows: [{ id: TENANT, instagram_page_id: 'ig-1', page_access_token: 'tok' }] };
        if (/FROM growth_settings/.test(sql)) return { rows: [{ keywords: [], hashtag_sets: [], competitors: ['rival.one', 'ghost'], audience: {} }] };
        return { rows: [] };
    };
    (metaHttp as any).post = async (url: string, form: URLSearchParams) => {
        assert.equal(url, `${GRAPH_BASE}/`);
        const items = JSON.parse(form.get('batch')!) as { relative_url: string }[];
        batch = items.map((i) => decodeURIComponent(i.relative_url));
        return {
            headers: {},
            data: [
                { code: 200, body: JSON.stringify({ business_discovery: {
                    username: 'rival.one', followers_count: 1000, media_count: 80,
                    media: { data: [
                        { permalink: 'https://instagram.com/p/a', like_count: 40, comments_count: 10, media_type: 'VIDEO', timestamp: '2026-09-20T10:00:00+0000', caption: 'hi', view_count: 900 },
                        { permalink: 'https://instagram.com/p/b', comments_count: 5, media_type: 'IMAGE' },
                    ] },
                }, id: 'ig-1' }) },
                { code: 400, body: JSON.stringify({ error: { code: 110, message: 'Invalid user id' } }) },
            ],
        };
    };
});
afterEach(() => {
    (pool as any).query = original.query;
    (metaHttp as any).post = original.post;
});

describe('mapBusinessDiscovery', () => {
    it('maps followers, media and engagement against followers over posts with visible likes', () => {
        const card = mapBusinessDiscovery('rival.one', {
            business_discovery: {
                followers_count: 200, media_count: 5,
                media: { data: [{ like_count: 8, comments_count: 2 }, { like_count: 4, comments_count: 0 }, { comments_count: 9 }] },
            },
        });
        assert.equal(card.followers, 200);
        assert.equal(card.recent.length, 3);
        assert.equal(card.recent[2]!.like_count, null, 'hidden likes stay null');
        assert.equal(card.avg_engagement, 0.035, '((10/200) + (4/200)) / 2 — the hidden-likes post is left out');
        assert.equal(card.error, null);
    });

    it('has no engagement without followers, and says when Meta returned no profile', () => {
        assert.equal(mapBusinessDiscovery('x', { business_discovery: { followers_count: 0, media: { data: [{ like_count: 1 }] } } }).avg_engagement, null);
        assert.match(mapBusinessDiscovery('x', {}).error!, /no profile/);
        assert.match(discoveryError({ ok: false, error: { code: 110, subcode: null, message: 'Invalid user id', status: 400 } }), /Business or Creator/);
    });
});

describe('getCompetitors', () => {
    it('reports missing_permission from debug_token without spending a lookup', async () => {
        const out = await getCompetitors(TENANT, async () => ({ isValid: true, scopes: ['instagram_basic', 'pages_read_engagement'] }));
        assert.deepEqual(out, { status: 'missing_permission', missing: ['instagram_manage_insights'], competitors: [] });
        assert.equal(batch.length, 0);
    });

    it('looks every competitor up in one batch, with only documented fields', async () => {
        const out = await getCompetitors(TENANT, async () => ({
            isValid: true, scopes: ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
        }));
        assert.deepEqual(batch, [`ig-1?fields=${discoveryFields('rival.one')}`, `ig-1?fields=${discoveryFields('ghost')}`]);
        assert.equal(out.status, 'ok');
        assert.equal(out.competitors[0]!.followers, 1000);
        assert.equal(out.competitors[0]!.avg_engagement, 0.05);
        assert.equal(out.competitors[0]!.recent[0]!.view_count, 900);
        assert.match(out.competitors[1]!.error!, /Not found, or not a Business or Creator account/);
    });
});
