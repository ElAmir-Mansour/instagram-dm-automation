/**
 * The comment pipeline's public fallback reply (P8): when the private reply can never be delivered, the comment is answered
 * in public, in the register the tenant's comment surface speaks (`profileContext(creatorId, 'comment_reply')`), and in the
 * language of the DM that was refused. The text itself is `profile/kits.ts`'s and is pinned there and in the goldens; this
 * drives `handleCommentChange` to show the register arrives at the reply, and that a profile that cannot be read is the
 * owner's Gulf line and never a lost reply.
 *
 * Nothing here touches Postgres or Meta: `pool.query` answers on the SQL it is handed, `metaHttp.post` stands in for the
 * Graph API, and any call a test did not arrange throws (`.env` holds live credentials; see messaging.test.ts).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { ProfileUnreadableError } from '../services/profile/context.js';
import { FITNESS_EN, SHOP_EG } from '../services/profile/fixtures.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import type { CreatorProfile } from '../services/profile/types.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import { handleCommentChange } from './comments.js';
import { FINAL_ATTEMPT } from './options.js';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

const CREATOR = { id: 'creator-1', instagram_page_id: 'ig-page-1', facebook_page_id: 'fb-page-1', page_access_token: 'EAAGplaintext' };

interface Sent { url: string; body: any }

/** The Graph API refusing a private reply for good: code 100, "the person cannot receive messages from Pages". */
const refused = () => Object.assign(new Error('Invalid parameter'), {
    response: { status: 400, data: { error: { code: 100, message: 'Invalid parameter', type: 'OAuthException' } } },
});

let nextComment = 0;

/** One comment, matched to a campaign whose DM Meta refuses, through the real pipeline. */
async function run(options: {
    platform: 'instagram' | 'facebook';
    dmTemplate: string;
    profile?: CreatorProfile;
    /** Let the private reply through, so the fallback is never reached. */
    deliver?: boolean;
    /**
     * Who the platform owner is (`getPlatformOwnerId`): an id, or null for no creators. Absent = the lookup is not arranged and
     * throws. It only matters when the profile cannot be read: the owner gets his Gulf wording, another tenant's job retries.
     */
    owner?: string | null;
    /** Whether a retry follows this attempt. Default: no (`FINAL_ATTEMPT`, as the inline path has it). */
    lastAttempt?: boolean;
}): Promise<{ sends: Sent[]; executed: string[]; statements: Array<{ sql: string; params: any[] }>; events: string[]; error: unknown }> {
    const { platform, dmTemplate, profile, deliver = false, owner, lastAttempt = true } = options;
    const executed: string[] = [];
    const statements: Array<{ sql: string; params: any[] }> = [];
    const events: string[] = [];
    const sends: Sent[] = [];
    const id = `comment-${++nextComment}`;
    const campaign = {
        id: 'camp-1', trigger_keyword: 'plan', dm_template: dmTemplate, public_reply_template: '', post_id: null,
        is_active: true, created_at: new Date(), match_mode: 'substring',
    };
    const routes: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/FROM creators\s+WHERE is_active/, { rows: [CREATOR] }],
        [/FROM campaigns/, { rows: [campaign] }],
        [/INSERT INTO interactions/, { rows: [{ id: 'interaction-1' }] }],
        [/FROM dm_send_log/, { rows: [] }],
        [/INSERT INTO dm_send_log/, { rowCount: 1 }],
        [/INSERT INTO rate_limit_counters/, { rows: [{ count: 1 }] }],
        [/INSERT INTO app_rate_limit_counters/, { rows: [{ count: 1 }] }],
        [/UPDATE interactions/, { rowCount: 1 }],
    ];
    // Read as the database hands it back: JSONB, its keys in Postgres's order. Absent = the read is not arranged and throws.
    if (profile) routes.unshift([/FROM creator_profiles/, { rows: [{ profile: throughJsonb(profile), version: 2, activated_at: null }] }]);
    if (owner !== undefined) routes.unshift([/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/, { rows: owner === null ? [] : [{ id: owner }] }]);
    // The owner lookup is cached in the process for 30 s: one run's answer must not be the next one's.
    invalidateTenantCache();

    const originalQuery = pool.query;
    const originalPost = metaHttp.post;
    const previousSink = setLogSink((_level, line) => { try { events.push(JSON.parse(line).event); } catch { /* not structured */ } });
    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push(sql.replace(/\s+/g, ' '));
        statements.push({ sql: sql.replace(/\s+/g, ' '), params });
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1];
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (metaHttp as any).post = async (url: string, body: any) => {
        sends.push({ url, body });
        if (/\/messages$/.test(url) && !deliver) throw refused();
        return { data: { id: `reply-${sends.length}` } };
    };

    const change = platform === 'instagram'
        ? { field: 'comments', value: { id, text: 'PLAN please', media: { id: 'media-1' }, from: { id: 'user-1', username: 'ali' } } }
        : { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: id, post_id: 'post-1', message: 'PLAN please', from: { id: 'user-2', name: 'Ali' } } };

    let error: unknown = null;
    try {
        await handleCommentChange(change, platform === 'instagram' ? 'ig-page-1' : 'fb-page-1', lastAttempt ? FINAL_ATTEMPT : { lastAttempt: false });
    } catch (err) {
        error = err;
    } finally {
        (pool as any).query = originalQuery;
        (metaHttp as any).post = originalPost;
        setLogSink(previousSink);
        invalidateTenantCache();
    }
    return { sends, executed, statements, events, error };
}

/** The public reply that went out: the one post to a comment's `replies` (Instagram) or `comments` (Facebook) edge. */
const publicReply = (sends: Sent[]): string | undefined => sends.find((s) => /\/(replies|comments)$/.test(s.url))?.body.message;

const ARABIC_DM = 'أهلا {username} 👋 اللينك هنا: https://nour.example/candle';
const ENGLISH_DM = 'Hi {username} 👋 Here is the plan: https://samifit.example/plan';

describe('handleCommentChange: the public reply that replaces a DM Meta refused', () => {
    it('an Egyptian shop is answered in Egyptian, on Facebook with its link and on Instagram pointing to the bio', async () => {
        const fb = await run({ platform: 'facebook', dmTemplate: ARABIC_DM, profile: SHOP_EG });
        assert.equal(fb.error, null);
        assert.equal(publicReply(fb.sends), 'معرفناش نبعتلك على الخاص 🙏 ده اللينك: https://nour.example/candle');

        const ig = await run({ platform: 'instagram', dmTemplate: ARABIC_DM, profile: SHOP_EG });
        assert.equal(publicReply(ig.sends), 'معرفناش نبعتلك على الخاص 🙏 اللينك في البايو 🔗');
    });

    it('an English coach is answered in English', async () => {
        const fb = await run({ platform: 'facebook', dmTemplate: ENGLISH_DM, profile: FITNESS_EN });
        assert.equal(publicReply(fb.sends), 'We couldn\'t message you privately 🙏 Here\'s the link: https://samifit.example/plan');
        const ig = await run({ platform: 'instagram', dmTemplate: ENGLISH_DM, profile: FITNESS_EN });
        assert.equal(publicReply(ig.sends), 'We couldn\'t message you privately 🙏 The link is in our bio 🔗');
    });

    it('an English coach whose campaign DM is Arabic is answered in the neutral Arabic: the language is the DM\'s, the register the neutral one', async () => {
        const fb = await run({ platform: 'facebook', dmTemplate: ARABIC_DM, profile: FITNESS_EN });
        assert.equal(publicReply(fb.sends), 'لم نتمكن من مراسلتك في الخاص 🙏 هذا هو الرابط: https://nour.example/candle');
    });

    it('a profile that cannot be read is the OWNER\'s Gulf line, and he is still answered; so is anyone while the owner cannot be found', async () => {
        // No profile read is arranged, so it throws, as a failing database would.
        for (const owner of [CREATOR.id, null, undefined]) {
            const fb = await run({ platform: 'facebook', dmTemplate: ARABIC_DM, owner });
            assert.equal(fb.error, null, String(owner));
            assert.ok(fb.executed.some((sql) => /FROM creator_profiles/.test(sql)), 'the profile was asked for');
            assert.equal(publicReply(fb.sends), 'ما قدرنا نرسل لك على الخاص 🙏 هذا الرابط: https://nour.example/candle', String(owner));
            const ig = await run({ platform: 'instagram', dmTemplate: ARABIC_DM, owner });
            assert.equal(publicReply(ig.sends), 'ما قدرنا نرسل لك على الخاص 🙏 الرابط في البايو 🔗', String(owner));
        }
    });

    describe('a profile that cannot be read, for a tenant that is not the owner', () => {
        const other = 'the-owner';
        const statusWrites = (statements: Array<{ sql: string; params: any[] }>): string[] =>
            statements.filter((st) => /^UPDATE interactions SET status/.test(st.sql)).map((st) => String(st.params[0]));

        it('with a retry to come: the job is retried, the row is left PENDING, and nothing is said in the owner\'s wording or at all', async () => {
            const { sends, statements, events, error } = await run({ platform: 'facebook', dmTemplate: ARABIC_DM, owner: other, lastAttempt: false });

            assert.ok(error instanceof ProfileUnreadableError, String(error));
            assert.equal(publicReply(sends), undefined, 'no public reply yet');
            assert.deepEqual(statusWrites(statements), ['PENDING'], 'never FAILED: a finished row would be ignored by the retry as a duplicate');
            assert.ok(events.includes('profile.context_unreadable'));
            assert.ok(!events.includes('comment.fallback_register_unreadable'), 'that line is for the attempt with nothing left');
            assert.ok(statements.some((st) => /error_log/.test(st.sql) && /profile could not be read/.test(String(st.params[1]))), 'and the row says why it is waiting');
        });

        it('on the last attempt the reply still goes out, in the neutral wording, and a line says so: it is not lost', async () => {
            const fb = await run({ platform: 'facebook', dmTemplate: ARABIC_DM, owner: other, lastAttempt: true });
            assert.equal(fb.error, null);
            assert.equal(publicReply(fb.sends), 'لم نتمكن من مراسلتك في الخاص 🙏 هذا هو الرابط: https://nour.example/candle', 'MSA, not the owner\'s Gulf');
            assert.ok(fb.events.includes('comment.fallback_register_unreadable'), 'said in the log');
            assert.deepEqual(statusWrites(fb.statements), ['FAILED'], 'the row is final, as every failure of the last attempt is');
            assert.ok(fb.statements.some((st) => /error_log/.test(st.sql) && /neutral wording/.test(String(st.params[0]))), 'and its note says the wording was neutral');

            const ig = await run({ platform: 'instagram', dmTemplate: ENGLISH_DM, owner: other, lastAttempt: true });
            assert.equal(publicReply(ig.sends), 'We couldn\'t message you privately 🙏 The link is in our bio 🔗', 'an English DM gets English');
        });

        it('a retry that can read the profile answers in the tenant\'s own register, once', async () => {
            const { sends, error, events } = await run({ platform: 'facebook', dmTemplate: ARABIC_DM, owner: other, lastAttempt: false, profile: SHOP_EG });
            assert.equal(error, null);
            assert.equal(publicReply(sends), 'معرفناش نبعتلك على الخاص 🙏 ده اللينك: https://nour.example/candle');
            assert.ok(!events.includes('profile.context_unreadable'));
        });

        it('a failure that is not the DM\'s (a dead token) posts no fallback and does not read the profile at all', async () => {
            // `shouldPostDmFallback` is false for a dead token: nothing is said publicly, so there is no register to read.
            const originalPost = metaHttp.post;
            const dead = Object.assign(new Error('token'), { response: { status: 400, data: { error: { code: 190, message: 'Invalid OAuth access token.' } } } });
            const sent: string[] = [];
            const originalQuery = pool.query;
            (pool as any).query = async (sql: string) => {
                sent.push(sql);
                if (/FROM creators\s+WHERE is_active/.test(sql)) return { rows: [CREATOR], rowCount: 1 };
                if (/FROM campaigns/.test(sql)) return { rows: [{ id: 'camp-1', trigger_keyword: 'plan', dm_template: ARABIC_DM, public_reply_template: '', post_id: null, is_active: true, created_at: new Date(), match_mode: 'substring' }], rowCount: 1 };
                if (/INSERT INTO interactions/.test(sql)) return { rows: [{ id: 'interaction-1' }], rowCount: 1 };
                if (/FROM dm_send_log|INSERT INTO rate_limit_counters|INSERT INTO app_rate_limit_counters/.test(sql)) return { rows: [{ count: 1 }], rowCount: 1 };
                if (/UPDATE (interactions|creators)/.test(sql)) return { rowCount: 1, rows: [] };
                throw new Error(`no result arranged for SQL:\n${sql}`);
            };
            (metaHttp as any).post = async () => { throw dead; };
            try {
                await handleCommentChange({ field: 'comments', value: { id: `comment-dead-${++nextComment}`, text: 'plan', media: { id: 'm' }, from: { id: 'u', username: 'ali' } } }, 'ig-page-1', FINAL_ATTEMPT);
            } finally {
                (pool as any).query = originalQuery;
                (metaHttp as any).post = originalPost;
            }
            assert.ok(!sent.some((sql) => /creator_profiles/.test(sql)));
        });
    });

    it('a comment whose DM was delivered costs no profile read, and posts no fallback', async () => {
        const { executed, sends } = await run({ platform: 'facebook', dmTemplate: ARABIC_DM, profile: SHOP_EG, deliver: true });
        assert.equal(executed.filter((sql) => /FROM creator_profiles/.test(sql)).length, 0);
        assert.equal(publicReply(sends), undefined);
    });
});
