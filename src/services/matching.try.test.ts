/**
 * POST /api/campaigns/try: the dry run of the comment pipeline's matching step.
 *
 * What is pinned, and why each is worth a test:
 *
 *   - the answer is `matchCampaign`'s own: for a table of comments the winner the dry run names is
 *     the one `matchCampaign` returns, so the dashboard cannot say "fires" about a campaign the
 *     webhook would not answer with;
 *   - the reason names the tier of the ranking that decided it (post-specific, longer list, newest);
 *   - an unsaved draft replaces the stored campaign it edits, or is added, and says why it did not
 *     answer (no keyword, keyword inside a longer word in word mode, another post, paused, outranked);
 *   - the endpoint reads the live campaigns through the webhook's own query and writes nothing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import apiRouter from '../routes/api.js';
import {
    DRAFT_ID, MAX_TRY_COMMENT_LENGTH, evaluateTry, parseTryRequest,
    type StoredCampaign, type TryDraft, type TryRequest,
} from './campaignTry.js';
import { LIVE_CAMPAIGNS_SQL } from './liveCampaigns.js';
import { matchCampaign, rankMatches, winReason } from './matching.js';
import { installFakeDb, type FakeDb } from './monteur/testDb.js';
import { setLogSink } from '../utils/log.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const TENANT = '99999999-9999-4999-8999-999999999999';

function campaign(over: Partial<StoredCampaign> & { id: string; trigger_keyword: string }): StoredCampaign {
    return { post_id: null, is_active: true, match_mode: 'substring', created_at: '2026-01-01T00:00:00Z', ...over };
}

function draft(over: Partial<TryDraft> = {}): TryDraft {
    return { id: null, trigger_keyword: '', match_mode: 'substring', post_id: null, post_ids: [], is_active: true, ...over };
}

function request(comment: string, over: Partial<TryRequest> = {}): TryRequest {
    return { comment, platform: null, postId: '', draft: null, ...over };
}

describe('try: the winner and why', () => {
    it('fires on a substring match and says it is the only campaign that does', () => {
        const stored = [campaign({ id: U1, trigger_keyword: 'كورس' })];
        const out = evaluateTry(request('كم سعر الكورس؟'), stored);

        assert.equal(out.normalized, 'كم سعر الكورس؟');
        assert.deepEqual(out.winner, {
            id: U1, keywords: ['كورس'], matched: 'كورس', matchMode: 'substring', reason: 'only_match',
        });
        assert.equal(out.draftMatches, false);
        assert.equal(out.draftMissReason, undefined, 'no draft was sent, so there is nothing to explain');
        assert.deepEqual(out.nearMisses, []);
    });

    it('normalises the comment as matching does: hamza, teh marbuta, tatweel, diacritics', () => {
        const stored = [campaign({ id: U1, trigger_keyword: 'أوبال' })];
        const out = evaluateTry(request('اريد اوبـــالَ'), stored);
        assert.equal(out.winner?.id, U1);
        assert.equal(out.normalized, 'اريد اوبال');
    });

    it('answers null when no campaign fires', () => {
        const out = evaluateTry(request('صباح الخير'), [campaign({ id: U1, trigger_keyword: 'كورس' })]);
        assert.equal(out.winner, null);
        assert.equal(out.draftMatches, false);
    });

    it('between «كورس» and «الكورس، كورسات», the longer list answers, and the reason says so', () => {
        const short = campaign({ id: U1, trigger_keyword: 'كورس' });
        const long = campaign({ id: U2, trigger_keyword: 'الكورس، كورسات' });

        const both = evaluateTry(request('كم سعر الكورس؟'), [short, long]);
        assert.equal(both.winner?.id, U2);
        assert.equal(both.winner?.reason, 'longer_list');
        assert.deepEqual(both.winner?.keywords, ['الكورس', 'كورسات']);
        assert.equal(both.winner?.matched, 'الكورس');

        // Whatever order the rows arrive in, as for matchCampaign.
        assert.equal(evaluateTry(request('كم سعر الكورس؟'), [long, short]).winner?.id, U2);

        // A comment only the short one fires on has nothing to outrank.
        const only = evaluateTry(request('ابغى كورس'), [short, long]);
        assert.equal(only.winner?.id, U1);
        assert.equal(only.winner?.reason, 'only_match');
    });

    it('the keyword list is ranked by its stored length, the rule matchCampaign has always used', () => {
        // One keyword of six letters outranks a list of two short ones (5 characters): length, not a count.
        const one = campaign({ id: U1, trigger_keyword: 'كورسات' });
        const two = campaign({ id: U2, trigger_keyword: 'كو،رس' });
        const out = evaluateTry(request('كورسات رس كو'), [two, one]);
        assert.equal(out.winner?.id, U1);
        assert.equal(out.winner?.reason, 'longer_list');
    });

    it('with equal lists, the newer campaign answers', () => {
        const older = campaign({ id: U1, trigger_keyword: 'سعر', created_at: '2026-01-01T00:00:00Z' });
        const newer = campaign({ id: U2, trigger_keyword: 'كود', created_at: '2026-03-01T00:00:00Z' });
        const out = evaluateTry(request('سعر كود'), [older, newer]);
        assert.equal(out.winner?.id, U2);
        assert.equal(out.winner?.reason, 'newest');
    });

    it('a campaign for this post beats one for every post, even a longer one', () => {
        const general = campaign({ id: U1, trigger_keyword: 'كورس، دورة، تدريب' });
        const specific = campaign({ id: U2, trigger_keyword: 'كورس', post_id: 'P1' });

        const onPost = evaluateTry(request('اريد كورس', { postId: 'P1' }), [general, specific]);
        assert.equal(onPost.winner?.id, U2);
        assert.equal(onPost.winner?.reason, 'post_specific');

        // Elsewhere the specific one never fires, so the general one is not outranked, it is alone.
        const elsewhere = evaluateTry(request('اريد كورس', { postId: 'P2' }), [general, specific]);
        assert.equal(elsewhere.winner?.id, U1);
        assert.equal(elsewhere.winner?.reason, 'only_match');
    });

    it('names the same tier the ranking used when two campaigns tie on every other one', () => {
        const a = campaign({ id: U1, trigger_keyword: 'سعر' });
        const b = campaign({ id: U2, trigger_keyword: 'كود' });
        assert.equal(winReason(a, b), 'tie');
    });
});

describe('try: word mode and near misses', () => {
    it('word mode does not fire «كورس» inside «والكورس», and says that is why', () => {
        const out = evaluateTry(
            request('والكورس ده بكام؟', { draft: draft({ trigger_keyword: 'كورس', match_mode: 'word' }) }),
            []
        );
        assert.equal(out.winner, null);
        assert.equal(out.draftMatches, false);
        assert.equal(out.draftMissReason, 'word_mode');
        assert.deepEqual(out.nearMisses, [{ id: DRAFT_ID, keyword: 'كورس', why: 'word_mode' }]);
    });

    it('word mode does fire on the standing word', () => {
        const out = evaluateTry(
            request('كورس ده بكام؟', { draft: draft({ trigger_keyword: 'كورس', match_mode: 'word' }) }),
            []
        );
        assert.equal(out.draftMatches, true);
        assert.equal(out.winner?.id, DRAFT_ID);
        assert.equal(out.winner?.matchMode, 'word');
        assert.deepEqual(out.nearMisses, []);
    });

    it('lists a live word-mode campaign that missed only because the keyword sits inside a longer word', () => {
        const word = campaign({ id: U1, trigger_keyword: 'كورس', match_mode: 'word' });
        const out = evaluateTry(request('بالكورس ده بكام'), [word]);
        assert.equal(out.winner, null);
        assert.deepEqual(out.nearMisses, [{ id: U1, keyword: 'كورس', why: 'word_mode' }]);
    });

    it('substring mode has no near misses: it accepts the keyword anywhere', () => {
        const out = evaluateTry(request('بالكورس'), [campaign({ id: U1, trigger_keyword: 'كورس' })]);
        assert.deepEqual(out.nearMisses, []);
        assert.equal(out.winner?.id, U1);
    });

    it('a word-mode campaign for another post is not a near miss on this one', () => {
        const word = campaign({ id: U1, trigger_keyword: 'كورس', match_mode: 'word', post_id: 'P1' });
        assert.deepEqual(evaluateTry(request('بالكورس', { postId: 'P2' }), [word]).nearMisses, []);
        assert.equal(evaluateTry(request('بالكورس', { postId: 'P1' }), [word]).nearMisses.length, 1);
    });

    it('a campaign that fires on another of its keywords is not listed as a near miss', () => {
        const word = campaign({ id: U1, trigger_keyword: 'كورس، سعر', match_mode: 'word' });
        const out = evaluateTry(request('بالكورس سعر'), [word]);
        assert.equal(out.winner?.id, U1);
        assert.equal(out.winner?.matched, 'سعر');
        assert.deepEqual(out.nearMisses, []);
    });
});

describe('try: the draft', () => {
    it('replaces the stored campaign with the same id: the old keyword stops counting, the new one counts', () => {
        const stored = [campaign({ id: U1, trigger_keyword: 'سعر' })];
        const edited = draft({ id: U1, trigger_keyword: 'كورس' });

        const oldWord = evaluateTry(request('كم السعر', { draft: edited }), stored);
        assert.equal(oldWord.winner, null, 'the stored «سعر» is the thing being replaced');
        assert.equal(oldWord.draftMissReason, 'no_keyword');

        const newWord = evaluateTry(request('كم سعر الكورس', { draft: edited }), stored);
        assert.equal(newWord.winner?.id, DRAFT_ID);
        assert.equal(newWord.draftMatches, true);
        assert.deepEqual(newWord.winner?.keywords, ['كورس']);

        // Without the draft the stored campaign answers, as before.
        assert.equal(evaluateTry(request('كم السعر'), stored).winner?.id, U1);
    });

    it('is added when it has no id, next to what is stored', () => {
        const stored = [campaign({ id: U1, trigger_keyword: 'سعر' })];
        const out = evaluateTry(request('كورس', { draft: draft({ trigger_keyword: 'كورس' }) }), stored);
        assert.equal(out.winner?.id, DRAFT_ID);
        assert.equal(evaluateTry(request('سعر', { draft: draft({ trigger_keyword: 'كورس' }) }), stored).winner?.id, U1);
    });

    it('an id that is not stored (a paused campaign, or someone else\'s) is added, never matched to a stored row', () => {
        const stored = [campaign({ id: U1, trigger_keyword: 'سعر' })];
        const out = evaluateTry(request('سعر', { draft: draft({ id: U3, trigger_keyword: 'كورس' }) }), stored);
        assert.equal(out.winner?.id, U1);
        assert.equal(out.draftMissReason, 'no_keyword');
    });

    it('a new draft is the newest campaign; an edited one keeps the age it already has', () => {
        const stored = [campaign({ id: U1, trigger_keyword: 'كود', created_at: '2026-02-01T00:00:00Z' })];
        const fresh = evaluateTry(request('سعر كود', { draft: draft({ trigger_keyword: 'سعر' }) }), stored);
        assert.equal(fresh.winner?.id, DRAFT_ID);
        assert.equal(fresh.winner?.reason, 'newest');

        const edited = evaluateTry(
            request('سعر كود', { draft: draft({ id: U2, trigger_keyword: 'سعر' }) }),
            stored,
            '2026-01-01T00:00:00Z'
        );
        assert.equal(edited.winner?.id, U1, 'older than the stored one, so it is outranked');
        assert.equal(edited.draftMissReason, 'shadowed');
    });

    it('says shadowed when it fires but another campaign answers, and the winner is that campaign', () => {
        const long = campaign({ id: U2, trigger_keyword: 'الكورس، كورسات' });
        const out = evaluateTry(request('سعر الكورس', { draft: draft({ trigger_keyword: 'كورس' }) }), [long]);
        // The draft is the newest, but the ranking reads the list's length before age.
        assert.equal(out.winner?.id, U2);
        assert.equal(out.winner?.reason, 'longer_list');
        assert.equal(out.draftMatches, false);
        assert.equal(out.draftMissReason, 'shadowed');
    });

    it('a post-specific stored campaign shadows a general draft on its post', () => {
        const specific = campaign({ id: U1, trigger_keyword: 'كورس', post_id: 'P1' });
        const out = evaluateTry(
            request('كورس', { postId: 'P1', draft: draft({ trigger_keyword: 'كورس، دورة' }) }),
            [specific]
        );
        assert.equal(out.winner?.id, U1);
        assert.equal(out.winner?.reason, 'post_specific');
        assert.equal(out.draftMissReason, 'shadowed');
    });

    it('a draft for one post beats a general stored campaign on that post, and misses elsewhere', () => {
        const general = campaign({ id: U1, trigger_keyword: 'كورس، دورة، تدريب' });
        const mine = draft({ trigger_keyword: 'كورس', post_id: 'P1' });

        const here = evaluateTry(request('كورس', { postId: 'P1', draft: mine }), [general]);
        assert.equal(here.winner?.id, DRAFT_ID);
        assert.equal(here.winner?.reason, 'post_specific');

        const there = evaluateTry(request('كورس', { postId: 'P2', draft: mine }), [general]);
        assert.equal(there.winner?.id, U1);
        assert.equal(there.draftMissReason, 'other_post');
    });

    it('a draft for several posts fires on any of them and misses on the rest', () => {
        const mine = draft({ trigger_keyword: 'كورس', post_ids: ['P1', 'P2'] });
        assert.equal(evaluateTry(request('كورس', { postId: 'P2', draft: mine }), []).draftMatches, true);
        assert.equal(evaluateTry(request('كورس', { postId: 'P1', draft: mine }), []).draftMatches, true);
        const miss = evaluateTry(request('كورس', { postId: 'P3', draft: mine }), []);
        assert.equal(miss.draftMatches, false);
        assert.equal(miss.draftMissReason, 'other_post');
    });

    it('post_ids wins over post_id when both are sent, as the stored shape will', () => {
        const mine = draft({ trigger_keyword: 'كورس', post_id: 'P1', post_ids: ['P2'] });
        assert.equal(evaluateTry(request('كورس', { postId: 'P1', draft: mine }), []).draftMissReason, 'other_post');
        assert.equal(evaluateTry(request('كورس', { postId: 'P2', draft: mine }), []).draftMatches, true);
    });

    it('a draft that will be saved paused matches nothing, and says paused', () => {
        const out = evaluateTry(request('كورس', { draft: draft({ trigger_keyword: 'كورس', is_active: false }) }), []);
        assert.equal(out.winner, null);
        assert.equal(out.draftMatches, false);
        assert.equal(out.draftMissReason, 'paused');
    });

    it('an empty draft keyword list matches nothing and says no_keyword', () => {
        const out = evaluateTry(request('كورس', { draft: draft({ trigger_keyword: ' ، ,' }) }), []);
        assert.equal(out.draftMissReason, 'no_keyword');
    });
});

describe('try: one rule with the webhook', () => {
    const table: StoredCampaign[] = [
        campaign({ id: 'a', trigger_keyword: 'كورس' }),
        campaign({ id: 'b', trigger_keyword: 'الكورس، كورسات', created_at: '2026-02-01T00:00:00Z' }),
        campaign({ id: 'c', trigger_keyword: 'كورس', post_id: 'P1', created_at: '2026-03-01T00:00:00Z' }),
        campaign({ id: 'd', trigger_keyword: 'سعر، تكلفة', match_mode: 'word' }),
        campaign({ id: 'e', trigger_keyword: 'تم', is_active: false }),
        campaign({ id: 'f', trigger_keyword: 'خصم، كوبون', post_id: 'P2' }),
    ];
    const comments = ['كم سعر الكورس؟', 'اريد كورس', 'بالسعر كام', 'سعر', 'تم', 'كوبون خصم', 'كورسات', 'صباح الخير', '', ' ـ '];
    const posts = ['', 'P1', 'P2', 'P9'];

    it('names the campaign matchCampaign returns, for every comment and post in the table', () => {
        for (const comment of comments) {
            for (const postId of posts) {
                const live = matchCampaign(comment, postId, table);
                const ranked = rankMatches(comment, postId, table);
                const out = evaluateTry(request(comment, { postId }), table);
                assert.equal(ranked[0]?.campaign.id, live?.id, `rankMatches: «${comment}» on «${postId}»`);
                assert.equal(out.winner?.id, live?.id, `evaluateTry: «${comment}» on «${postId}»`);
            }
        }
    });

    it('matchCampaign and rankMatches are the same function of the order the rows arrive in', () => {
        const reversed = [...table].reverse();
        for (const comment of comments) {
            assert.equal(matchCampaign(comment, 'P1', reversed)?.id, matchCampaign(comment, 'P1', table)?.id);
        }
    });

    it('loads campaigns with the webhook\'s own query: the webhook no longer carries one', () => {
        const webhook = readFileSync('src/webhook/comments.ts', 'utf8');
        assert.match(webhook, /loadLiveCampaigns\(creator\.id\)/);
        assert.doesNotMatch(webhook, /FROM campaigns/, 'a second copy of the query would let the two drift');

        const service = readFileSync('src/services/campaignTry.ts', 'utf8');
        assert.match(service, /loadLiveCampaigns\(creatorId\)/);
        assert.doesNotMatch(service, /FROM campaigns WHERE is_active|keywordMatches/, 'the dry run owns no copy of the rule');
    });
});

describe('POST /campaigns/try', () => {
    type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

    function handler(): Handle {
        const stack = (apiRouter as unknown as {
            stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }>;
        }).stack;
        const layer = stack.find((l) => l.route?.path === '/campaigns/try' && l.route.methods.post);
        assert.ok(layer, 'POST /campaigns/try must be mounted');
        const handles = layer!.route!.stack.map((l) => l.handle);
        return handles[handles.length - 1]!;
    }

    async function post(body: unknown) {
        const res = {
            statusCode: 200,
            body: null as any,
            status(code: number) { this.statusCode = code; return this; },
            json(payload: unknown) { this.body = payload; return this; },
        };
        await handler()(
            { session: { userId: 'u-1', role: 'user', tenantId: TENANT }, body, params: {}, headers: {} },
            res, () => {}
        );
        return res;
    }

    const LIVE = [
        { id: U1, trigger_keyword: 'كورس', dm_template: 'x', public_reply_template: null, post_id: null, is_active: true, match_mode: 'substring', created_at: new Date('2026-01-01T00:00:00Z') },
        { id: U2, trigger_keyword: 'الكورس، كورسات', dm_template: 'y', public_reply_template: null, post_id: null, is_active: true, match_mode: 'substring', created_at: new Date('2026-02-01T00:00:00Z') },
    ];

    let live: typeof LIVE;
    let db: FakeDb;
    let restoreSink: (() => void) | undefined;
    let originalConnect: unknown;

    beforeEach(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
        live = LIVE;
        db = installFakeDb();
        db.routes.push([/^SELECT id, trigger_keyword, dm_template/, () => ({ rows: live })]);
        db.routes.push([/^SELECT created_at FROM campaigns WHERE id = \$1 AND creator_id = \$2$/, () => ({ rows: [{ created_at: new Date('2025-12-01T00:00:00Z') }] })]);
        originalConnect = (pool as unknown as { connect: unknown }).connect;
    });
    afterEach(() => { db.restore(); restoreSink?.(); });

    it('answers with the winner, the reason and the near misses', async () => {
        const res = await post({ comment: 'كم سعر الكورس؟', platform: 'instagram' });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body, {
            normalized: 'كم سعر الكورس؟',
            winner: { id: U2, keywords: ['الكورس', 'كورسات'], matched: 'الكورس', matchMode: 'substring', reason: 'longer_list' },
            draftMatches: false,
            nearMisses: [],
        });
    });

    it('reads the tenant\'s live campaigns with the webhook\'s query, scoped to the session\'s tenant', async () => {
        await post({ comment: 'كورس' });
        const reads = db.ran(/FROM campaigns/);
        assert.equal(reads.length, 1);
        assert.equal(reads[0]!.sql, LIVE_CAMPAIGNS_SQL.replace(/\s+/g, ' ').trim());
        assert.deepEqual(reads[0]!.params, [TENANT]);
        assert.match(reads[0]!.sql, /creator_id = \$1 AND is_active = true/);
    });

    it('writes nothing: every statement is a SELECT, and no transaction is opened', async () => {
        (pool as unknown as { connect: unknown }).connect = async () => { throw new Error('the dry run opened a connection'); };
        try {
            // Every shape of request: plain, with a new draft, with an edit of a stored campaign
            // (the one case that reads a second statement), a word-mode draft, a refused request.
            await post({ comment: 'كم سعر الكورس؟' });
            await post({ comment: 'والكورس', draft: { id: null, trigger_keyword: 'كورس', match_mode: 'word' } });
            await post({ comment: 'سعر', postId: 'P1', draft: { id: U3, trigger_keyword: 'سعر', post_ids: ['P1'] } });
            await post({ comment: 'سعر', draft: { id: U1, trigger_keyword: 'سعر', is_active: false } });
            await post({ comment: '' });
        } finally {
            (pool as unknown as { connect: unknown }).connect = originalConnect;
        }

        assert.ok(db.statements.length > 0, 'the guard is vacuous if nothing ran');
        for (const s of db.statements) {
            assert.match(s.sql, /^SELECT /, `not a read: ${s.sql}`);
            assert.doesNotMatch(s.sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|UPSERT)\b/i, `writes: ${s.sql}`);
        }
        assert.equal(db.ran(/^(INSERT|UPDATE|DELETE)/i).length, 0);
    });

    it('reads a paused campaign\'s age only for the draft that edits it, tenant-scoped', async () => {
        await post({ comment: 'سعر', draft: { id: U3, trigger_keyword: 'سعر' } });
        const ages = db.ran(/^SELECT created_at FROM campaigns/);
        assert.equal(ages.length, 1);
        assert.deepEqual(ages[0]!.params, [U3, TENANT]);

        // A live campaign being edited needs no second read: its age is already in the list.
        db.statements.length = 0;
        await post({ comment: 'سعر', draft: { id: U1, trigger_keyword: 'سعر' } });
        assert.equal(db.ran(/^SELECT created_at FROM campaigns/).length, 0);
    });

    it('a draft that edits a paused campaign keeps that campaign\'s age in the ranking', async () => {
        // The stored live «كود» is from 2026-02-01; the paused U3 (the stub's answer) is from 2025-12-01.
        // Equal lists, so the older campaign is outranked, not treated as brand new.
        live = [{ ...LIVE[0]!, trigger_keyword: 'كود', created_at: new Date('2026-02-01T00:00:00Z') }];
        const res = await post({ comment: 'سعر كود', draft: { id: U3, trigger_keyword: 'سعر' } });
        assert.equal(res.body.winner.id, U1);
        assert.equal(res.body.winner.reason, 'newest');
        assert.equal(res.body.draftMissReason, 'shadowed');

        // The same draft with no id is a new campaign: the newest, so it answers.
        const fresh = await post({ comment: 'سعر كود', draft: { trigger_keyword: 'سعر' } });
        assert.equal(fresh.body.winner.id, 'draft');
    });

    it('refuses a missing, blank or over-long comment before reading anything', async () => {
        for (const body of [undefined, {}, { comment: '' }, { comment: '   ' }, { comment: 42 },
            { comment: 'ا'.repeat(MAX_TRY_COMMENT_LENGTH + 1) }]) {
            const res = await post(body);
            assert.equal(res.statusCode, 400, JSON.stringify(body)?.slice(0, 40));
            assert.match(res.body.error, /comment/);
        }
        assert.equal(db.statements.length, 0);
        assert.equal((await post({ comment: 'ا'.repeat(MAX_TRY_COMMENT_LENGTH) })).statusCode, 200);
    });

    it('refuses what it would otherwise silently reinterpret: a bad mode, platform, id or post list', async () => {
        const bad: unknown[] = [
            { comment: 'x', platform: 'tiktok' },
            { comment: 'x', postId: 12345 },
            { comment: 'x', draft: 'كورس' },
            { comment: 'x', draft: { trigger_keyword: 5 } },
            { comment: 'x', draft: { trigger_keyword: 'a', match_mode: 'exact' } },
            { comment: 'x', draft: { id: 'not-a-uuid', trigger_keyword: 'a' } },
            { comment: 'x', draft: { trigger_keyword: 'a', post_ids: 'P1' } },
            { comment: 'x', draft: { trigger_keyword: 'a', post_ids: [1] } },
            { comment: 'x', draft: { trigger_keyword: 'a', is_active: 'no' } },
            { comment: 'x', draft: { trigger_keyword: 'a'.repeat(5000) } },
        ];
        for (const body of bad) {
            const res = await post(body);
            assert.equal(res.statusCode, 400, JSON.stringify(body)?.slice(0, 60));
        }
        assert.equal(db.statements.length, 0);
    });

    it('a failing read is a 500 that does not echo the comment', async () => {
        db.restore();
        (pool as unknown as { query: unknown }).query = async () => { throw new Error('db down'); };
        const logs: string[] = [];
        const previous = setLogSink((_level, line) => { logs.push(line); });
        try {
            const res = await post({ comment: 'تعليق خاص بمتابع' });
            assert.equal(res.statusCode, 500);
            assert.doesNotMatch(JSON.stringify(res.body), /تعليق خاص/);
            assert.ok(logs.length > 0);
            assert.ok(logs.every((l) => !l.includes('تعليق خاص')), 'the comment stays out of the log');
        } finally {
            setLogSink(previous);
        }
    });
});

describe('parseTryRequest', () => {
    it('defaults the way create does: substring, active, no post, no draft id', () => {
        const parsed = parseTryRequest({ comment: 'x', draft: { trigger_keyword: 'a' } });
        assert.ok(parsed.ok);
        assert.deepEqual(parsed.value.draft, {
            id: null, trigger_keyword: 'a', match_mode: 'substring', post_id: null, post_ids: [], is_active: true,
        });
        assert.equal(parsed.value.postId, '');
    });

    it('drops empty and repeated post ids', () => {
        const parsed = parseTryRequest({ comment: 'x', draft: { trigger_keyword: 'a', post_ids: ['P1', '', 'P1', 'P2'] } });
        assert.ok(parsed.ok);
        assert.deepEqual(parsed.value.draft?.post_ids, ['P1', 'P2']);
    });
});
