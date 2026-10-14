/**
 * `[SPLIT]` templates.
 *
 * The rule that shapes all of this is Meta's: **one private reply per comment, ever.** So a
 * three-part template is one irreversible send followed by two ordinary DMs, and the pipeline
 * has to treat them differently. It did not: the interaction was marked SENT only after the
 * whole loop, so part 3 failing marked the row FAILED even though the recipient already had
 * parts 1 and 2 — and a retry of that row re-sent the private reply, which Meta refuses, so
 * the retry could only ever fail.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import { handleCommentChange, splitDmTemplate } from './comments.js';
import { FINAL_ATTEMPT } from './options.js';

describe('splitDmTemplate', () => {
    it('leaves a template with no marker as a single message', () => {
        assert.deepEqual(splitDmTemplate('مرحبا بك'), { first: 'مرحبا بك', followUps: [] });
    });

    it('splits on the marker and trims each part', () => {
        assert.deepEqual(splitDmTemplate('أهلا [SPLIT] هذا الرابط [SPLIT] شكرا'), {
            first: 'أهلا',
            followUps: ['هذا الرابط', 'شكرا'],
        });
    });

    it('drops empty parts rather than sending a blank message', () => {
        // A template ending in the marker, or carrying two in a row, otherwise produced a
        // send Meta rejects with "param message must be a non-empty object".
        assert.deepEqual(splitDmTemplate('أهلا [SPLIT]'), { first: 'أهلا', followUps: [] });
        assert.deepEqual(splitDmTemplate('أهلا [SPLIT] [SPLIT] شكرا'), {
            first: 'أهلا',
            followUps: ['شكرا'],
        });
        assert.deepEqual(splitDmTemplate('[SPLIT] أهلا'), { first: 'أهلا', followUps: [] });
    });

    it('keeps the first part identifiable even for an all-whitespace template', () => {
        // Nothing usable to send. Falling back to the original keeps the failure where it was
        // — one rejected send with a Meta error that names the empty message — rather than
        // turning it into a silent no-op indistinguishable from success.
        const result = splitDmTemplate('   ');
        assert.equal(result.first, '   ');
        assert.deepEqual(result.followUps, []);
    });

    it('trims a plain template too', () => {
        assert.deepEqual(splitDmTemplate('  مرحبا  '), { first: 'مرحبا', followUps: [] });
    });

    it('preserves newlines inside a part', () => {
        // Templates are written with line breaks for readability; only the outer edges are
        // trimmed.
        const { first } = splitDmTemplate('السلام عليكم\nتفضل الرابط [SPLIT] شكرا');
        assert.equal(first, 'السلام عليكم\nتفضل الرابط');
    });
});

// ─── The comment → DM bridge (docs/DM_SALES_PLAN.md S10) ──────────────────────────────────────
//
// After the private reply is SENT, the id it went to is written on the interaction (`bridge.ts`), so that the same person's DM can find the
// campaign. This is the live comment path (p50 about 4 s, answering real people today), so what is pinned is what it must NOT do: change the
// outcome. A write that throws leaves the interaction SENT and the public reply still goes out; the bridge adds no Graph call; a reply that
// went out is the only one that is ever recorded.
//
// Nothing here touches Postgres or Meta: `pool.query` answers on the SQL it is handed, `metaHttp.post` stands in for the Graph API, and any
// call a test did not arrange throws (`.env` holds live credentials; see messaging.test.ts).

const BRIDGE_CREATOR = { id: 'creator-1', instagram_page_id: 'ig-page-1', facebook_page_id: 'fb-page-1', page_access_token: 'EAAGplaintext' };

interface BridgeSent { url: string; body: any }

let bridgeComment = 0;

/** One comment, matched to a campaign whose private reply Meta takes (or refuses), through the real pipeline. */
async function runBridge(options: {
    platform?: 'instagram' | 'facebook';
    /** What the Send API answers the private reply with. */
    reply?: unknown;
    /** Meta refuses the private reply for good (code 100). */
    refuse?: boolean;
    /** The bridge's own write fails with this, as a database without v41 (or one that is down) would. */
    bridgeError?: string;
}): Promise<{ sends: BridgeSent[]; gets: string[]; statements: Array<{ sql: string; params: any[] }>; events: Array<{ level: string; event: string; [k: string]: unknown }>; error: unknown }> {
    const { platform = 'instagram', reply = { recipient_id: '17841400000000001', message_id: 'm_1' }, refuse = false, bridgeError } = options;
    const statements: Array<{ sql: string; params: any[] }> = [];
    const events: Array<{ level: string; event: string; [k: string]: unknown }> = [];
    const sends: BridgeSent[] = [];
    const gets: string[] = [];
    const id = `bridge-comment-${++bridgeComment}`;
    const campaign = {
        id: 'camp-1', trigger_keyword: 'plan', dm_template: 'Hi {username}: https://samifit.example/plan', public_reply_template: 'Check your DMs 📩', post_id: null,
        is_active: true, created_at: new Date(), match_mode: 'substring',
    };
    const routes: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/FROM creators\s+WHERE is_active/, { rows: [BRIDGE_CREATOR] }],
        [/FROM campaigns/, { rows: [campaign] }],
        [/INSERT INTO interactions/, { rows: [{ id: 'interaction-1' }] }],
        [/FROM dm_send_log/, { rows: [] }],
        [/INSERT INTO dm_send_log/, { rowCount: 1 }],
        [/INSERT INTO rate_limit_counters/, { rows: [{ count: 1 }] }],
        [/INSERT INTO app_rate_limit_counters/, { rows: [{ count: 1 }] }],
        [/UPDATE interactions/, { rowCount: 1 }],
    ];
    invalidateTenantCache();

    const originalQuery = pool.query;
    const originalPost = metaHttp.post;
    const originalGet = metaHttp.get;
    const previousSink = setLogSink((level, line) => { try { events.push({ level, ...JSON.parse(line) }); } catch { /* not structured */ } });
    (pool as any).query = async (sql: string, params: any[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' '), params });
        if (bridgeError && /UPDATE interactions SET recipient_id/.test(sql)) throw new Error(bridgeError);
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1];
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (metaHttp as any).post = async (url: string, body: any) => {
        sends.push({ url, body });
        if (/\/messages$/.test(url)) {
            if (refuse) throw Object.assign(new Error('Invalid parameter'), { response: { status: 400, data: { error: { code: 100, message: 'Invalid parameter', type: 'OAuthException' } } } });
            return { data: reply };
        }
        return { data: { id: `reply-${sends.length}` } };
    };
    (metaHttp as any).get = async (url: string) => { gets.push(url); throw new Error(`no GET was arranged for ${url}`); };

    const change = platform === 'instagram'
        ? { field: 'comments', value: { id, text: 'PLAN please', media: { id: 'media-1' }, from: { id: '17841400000000001', username: 'ali' } } }
        : { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: id, post_id: 'post-1', message: 'PLAN please', from: { id: '4000000000001', name: 'Ali' } } };

    let error: unknown = null;
    try {
        await handleCommentChange(change, platform === 'instagram' ? 'ig-page-1' : 'fb-page-1', FINAL_ATTEMPT);
    } catch (err) {
        error = err;
    } finally {
        (pool as any).query = originalQuery;
        (metaHttp as any).post = originalPost;
        (metaHttp as any).get = originalGet;
        setLogSink(previousSink);
        invalidateTenantCache();
    }
    return { sends, gets, statements, events, error };
}

/** The status each `UPDATE interactions SET status` wrote, in order: what the comment's outcome was. */
const statusWritten = (statements: Array<{ sql: string; params: any[] }>): string[] =>
    statements.filter((st) => /^UPDATE interactions SET status/.test(st.sql)).map((st) => String(st.params[0]));
const recipientWrites = (statements: Array<{ sql: string; params: any[] }>) => statements.filter((st) => /^UPDATE interactions SET recipient_id/.test(st.sql));
const publicReplyOf = (sends: BridgeSent[]): string | undefined => sends.find((s) => /\/(replies|comments)$/.test(s.url))?.body.message;

describe('handleCommentChange: the comment → DM bridge (S10)', () => {
    it('writes who the private reply went to on the interaction, after it is SENT, and says it in the log beside the commenter\'s own id (A1)', async () => {
        const { statements, events, error, sends } = await runBridge({});

        assert.equal(error, null);
        assert.deepEqual(statusWritten(statements), ['SENT']);
        const writes = recipientWrites(statements);
        assert.equal(writes.length, 1);
        assert.equal(writes[0]!.sql, 'UPDATE interactions SET recipient_id = $1, campaign_id = $2 WHERE id = $3 AND creator_id = $4');
        assert.deepEqual(writes[0]!.params, ['17841400000000001', 'camp-1', 'interaction-1', 'creator-1']);
        const sentAt = statements.findIndex((st) => /^UPDATE interactions SET status/.test(st.sql));
        assert.ok(sentAt >= 0 && sentAt < statements.indexOf(writes[0]!), 'SENT is settled before the bridge is written');
        const line = events.find((e) => e.event === 'comment.bridge_recorded');
        assert.ok(line, 'logged');
        assert.deepEqual([line!.recipient_id, line!.commenter_id, line!.same_id], ['17841400000000001', '17841400000000001', true]);
        assert.equal(publicReplyOf(sends), 'Check your DMs 📩');
    });

    it('records a Facebook comment the same way, under its own platform', async () => {
        const { statements, events, error } = await runBridge({ platform: 'facebook', reply: { recipient_id: '4000000000001', message_id: 'm_2' } });
        assert.equal(error, null);
        assert.deepEqual(recipientWrites(statements)[0]!.params, ['4000000000001', 'camp-1', 'interaction-1', 'creator-1']);
        assert.equal(events.find((e) => e.event === 'comment.bridge_recorded')!.platform, 'facebook');
    });

    for (const platform of ['instagram', 'facebook'] as const) {
        it(`A BRIDGE WRITE THAT THROWS leaves the outcome SENT, writes no FAILED, and the public reply still goes out (${platform})`, async () => {
            const { statements, sends, events, error } = await runBridge({ platform, bridgeError: 'column "recipient_id" of relation "interactions" does not exist' });

            assert.equal(error, null, 'the comment was not failed, and the job is not retried');
            assert.deepEqual(statusWritten(statements), ['SENT'], 'still SENT, and nothing else was ever written');
            assert.equal(recipientWrites(statements).length, 1, 'the write was tried');
            assert.equal(publicReplyOf(sends), 'Check your DMs 📩', 'the public reply went out after the failure');
            assert.ok(sends.some((s) => /\/likes$/.test(s.url)), 'and so did the like');
            const line = events.find((e) => e.event === 'comment.bridge_failed');
            assert.ok(line, 'one warning says what happened');
            assert.equal(line!.level, 'warn');
            assert.equal(line!.interaction_id, 'interaction-1');
            assert.ok(!events.some((e) => e.event === 'dm.send_failed'), 'and it is not reported as a failed DM');
        });
    }

    it('adds no Graph call: the private reply, the like and the public reply, as before, and nothing is read from Meta', async () => {
        const { sends, gets } = await runBridge({});
        const edges = sends.map((s) => s.url.replace(/^https:\/\/graph\.facebook\.com\/[^/]+\//, ''));
        assert.deepEqual(edges, ['me/messages', `bridge-comment-${bridgeComment}/likes`, `bridge-comment-${bridgeComment}/replies`]);
        assert.deepEqual(gets, [], 'no GET: the id comes from the private reply\'s own response');
    });

    it('a private reply that landed on a retry carries no recipient: nothing is written, the comment is SENT and answered publicly, and the log says why', async () => {
        const { statements, events, sends, error } = await runBridge({ reply: { delivered: true, landed_before_retry: true } });
        assert.equal(error, null);
        assert.equal(recipientWrites(statements).length, 0);
        assert.deepEqual(statusWritten(statements), ['SENT']);
        assert.equal(publicReplyOf(sends), 'Check your DMs 📩');
        const line = events.find((e) => e.event === 'comment.bridge_no_recipient');
        assert.ok(line);
        assert.deepEqual([line!.level, line!.landed_before_retry], ['info', true]);
    });

    it('a response with no recipient for any other reason is a warning, and still changes nothing', async () => {
        const { statements, events, error } = await runBridge({ reply: { message_id: 'm_1' } });
        assert.equal(error, null);
        assert.equal(recipientWrites(statements).length, 0);
        assert.deepEqual(statusWritten(statements), ['SENT']);
        assert.equal(events.find((e) => e.event === 'comment.bridge_no_recipient')!.level, 'warn');
    });

    it('a private reply Meta refuses is never recorded: nobody was sent anything to be answered', async () => {
        const { statements, events, error } = await runBridge({ refuse: true });
        assert.equal(error, null);
        assert.deepEqual(statusWritten(statements), ['FAILED'], 'recorded as a failure, as it always was');
        assert.equal(recipientWrites(statements).length, 0);
        assert.ok(!events.some((e) => /^comment\.bridge_/.test(e.event)));
    });
});
