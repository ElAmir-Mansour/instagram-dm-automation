/**
 * The DM pipeline.
 *
 * The largest file in the project with no test on it, and the one whose failures are hardest
 * to see: every branch below ends in either "a real person gets answered", "a real person gets
 * answered twice" or "a real person is never answered and nothing anywhere says so". The last
 * of those is not hypothetical — it is written into `claimInbound`'s comment, where the UNIQUE
 * index on `meta_message_id` was silently swallowing every retry.
 *
 * Nothing here touches Postgres, Gemini or Meta. `pool.query` is replaced by a router that
 * answers on the SQL it is handed, `axios.post` stands in for Gemini and `metaHttp.post` for
 * the Send API; any call a test did not arrange throws. That matters more than usual in this
 * repository: `.env` holds live production credentials, so a test that reached the network
 * could DM a real customer.
 *
 * The pure helpers are tested directly. The rest is driven end-to-end through
 * `handleMessagingEvent`, because the interesting behaviour is not in any one function — it is
 * in which of `markHandled` and `releaseInbound` runs, and whether the error is re-raised.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import type { Creator } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import {
    handleMessagingEvent, needsDisclosure, normalizeDm, resolveDmPageId,
} from './messaging.js';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

// ─── Pure helpers ───────────────────────────────────────────────────────────────────────

describe('normalizeDm', () => {
    it('reads a plain text message', () => {
        assert.deepEqual(
            normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm-1', text: 'كم سعر الكورس؟' } }),
            {
                senderId: 'u-1',
                text: 'كم سعر الكورس؟',
                payload: '',
                isStoryMention: false,
                metaMessageId: 'm-1',
            }
        );
    });

    it('keeps both the visible text and the payload of a quick reply', () => {
        // The payload is what the campaign keyed on; the text is what the person sees. Losing
        // either one answers the wrong question.
        const dm = normalizeDm({
            sender: { id: 'u-1' },
            message: { mid: 'm-2', text: 'نعم', quick_reply: { payload: 'WANT_COURSE' } },
        });

        assert.equal(dm?.text, 'نعم');
        assert.equal(dm?.payload, 'WANT_COURSE');
    });

    it('takes a postback\'s title as the text and its own mid', () => {
        // A postback carries no `message`, so both fields come from a different place.
        const dm = normalizeDm({
            sender: { id: 'u-1' },
            postback: { mid: 'm-3', title: 'ابدأ', payload: 'GET_STARTED' },
        });

        assert.equal(dm?.text, 'ابدأ');
        assert.equal(dm?.payload, 'GET_STARTED');
        assert.equal(dm?.metaMessageId, 'm-3');
    });

    it('overrides any message text with the postback title when both are present', () => {
        const dm = normalizeDm({
            sender: { id: 'u-1' },
            message: { mid: 'm-4', text: 'stale' },
            postback: { title: 'ابدأ', payload: 'GET_STARTED' },
        });

        assert.equal(dm?.text, 'ابدأ');
        assert.equal(dm?.metaMessageId, 'm-4', 'message.mid still wins as the dedupe key');
    });

    it('treats a story mention as answerable even with no text', () => {
        const dm = normalizeDm({
            sender: { id: 'u-1' },
            message: { mid: 'm-5', attachments: [{ type: 'story_mention' }] },
        });

        // No text and no payload, so the "nothing to reply to" guard has to make an exception
        // for it — otherwise every story mention is dropped silently.
        assert.notEqual(dm, null);
        assert.equal(dm?.isStoryMention, true);
        assert.equal(dm?.text, '');
        assert.equal(dm?.senderId, 'u-1');
    });

    it('ignores an attachment that is not a story mention', () => {
        // An image or a voice note with no caption: there is nothing to hand Gemini, so this
        // must not be treated as a story mention and answered as one.
        const dm = normalizeDm({
            sender: { id: 'u-1' },
            message: { mid: 'm-6', attachments: [{ type: 'image' }] },
        });

        assert.equal(dm, null);
    });

    it('skips events with nothing to reply to', () => {
        // Read watermarks, delivery receipts, reactions, referrals. These outnumber real
        // messages on a busy account.
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, read: { watermark: 1 } }), null);
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, delivery: { watermark: 1 } }), null);
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm', text: '' } }), null);
        assert.equal(normalizeDm({ message: { mid: 'm', text: 'no sender' } }), null);
        assert.equal(normalizeDm({}), null);
        assert.equal(normalizeDm(null), null);
    });

    it('reports a missing mid as null rather than inventing one', () => {
        // Load-bearing: `mayRetry` is false without it, because a retry would insert a second
        // inbound row and answer the same person twice.
        const dm = normalizeDm({ sender: { id: 'u-1' }, message: { text: 'مرحبا' } });

        assert.equal(dm?.metaMessageId, null);
    });
});

describe('needsDisclosure', () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

    it('discloses on a thread that never has', () => {
        assert.equal(needsDisclosure(null), true);
        assert.equal(needsDisclosure(undefined), true);
        assert.equal(needsDisclosure(''), true);
    });

    it('does not re-disclose inside the window', () => {
        assert.equal(needsDisclosure(daysAgo(1)), false);
        assert.equal(needsDisclosure(daysAgo(6)), false);
        assert.equal(needsDisclosure(new Date()), false);
    });

    it('re-discloses after a week, and not a moment before', () => {
        // The boundary is spelled out here rather than imported, so that moving
        // DISCLOSURE_MAX_AGE_MS turns this red instead of moving with it.
        const week = 7 * 24 * 60 * 60 * 1000;
        assert.equal(needsDisclosure(new Date(Date.now() - week + 60_000)), false);
        assert.equal(needsDisclosure(new Date(Date.now() - week - 60_000)), true);
    });

    it('accepts the ISO string Postgres hands back, not just a Date', () => {
        assert.equal(needsDisclosure(daysAgo(1).toISOString()), false);
        assert.equal(needsDisclosure(daysAgo(30).toISOString()), true);
    });

    it('discloses when the stored value cannot be read as a time', () => {
        // Fail towards disclosing: an extra disclosure is a cosmetic blemish, a missing one is
        // a Meta policy breach.
        assert.equal(needsDisclosure('not a date'), true);
        assert.equal(needsDisclosure(new Date('nonsense')), true);
    });
});

describe('resolveDmPageId', () => {
    const creator = (fb: string | null): Creator => ({
        id: 'c-1', instagram_page_id: 'ig-1', facebook_page_id: fb, page_access_token: 'EAAG',
    });

    it('returns the Facebook page id when the event was addressed to it', () => {
        // Meta requires /{page-id}/messages for Page tokens; /me only resolves for
        // Instagram-Login tokens, so every Facebook Messenger reply used to go to the wrong
        // endpoint.
        assert.equal(resolveDmPageId(creator('fb-9'), ['fb-9', 'entry-1']), 'fb-9');
        assert.equal(resolveDmPageId(creator('fb-9'), [undefined, 'fb-9']), 'fb-9');
    });

    it('returns undefined for an Instagram event, so the call goes to /me', () => {
        assert.equal(resolveDmPageId(creator('fb-9'), ['ig-1', 'ig-1']), undefined);
    });

    it('returns undefined for a creator with no Facebook page at all', () => {
        assert.equal(resolveDmPageId(creator(null), ['ig-1']), undefined);
    });

    it('does not match on an empty id', () => {
        // `facebook_page_id` of '' against an absent recipient must not read as a match.
        assert.equal(resolveDmPageId(creator(''), [undefined, undefined]), undefined);
    });
});

// ─── The pipeline ───────────────────────────────────────────────────────────────────────

interface Executed {
    sql: string;
    params: any[];
}

interface Sent {
    url: string;
    body: any;
}

interface Scenario {
    creator?: Record<string, unknown> | null;
    conversation?: Record<string, unknown> | null;
    /** Rows the `ON CONFLICT (meta_message_id)` insert returns. Empty = the mid already exists. */
    inboundInsert?: Record<string, unknown>[];
    /** Rows the re-claim UPDATE returns. Empty = handled already, or someone else holds it. */
    resumeClaim?: Record<string, unknown>[];
    agent?: Record<string, unknown> | null;
    creatorQuotaCount?: number;
    appQuotaCount?: number;
    /** What Gemini answers with, or throws. */
    gemini?: () => Promise<any>;
    /** What the Send API answers with, or throws. */
    send?: (url: string, body: any) => Promise<any>;
}

const CREATOR = {
    id: 'creator-1',
    instagram_page_id: 'ig-page-1',
    facebook_page_id: 'fb-page-1',
    page_access_token: 'EAAGplaintext',
};

const geminiSaying = (reply: Record<string, unknown>) => async () => ({
    data: { candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] },
});

/**
 * Run one messaging event against stubbed Postgres, Gemini and Meta.
 *
 * Returns everything worth asserting on: the statements issued in order, the sends, and the
 * error if the pipeline re-raised one (which is the signal the job runner retries on).
 */
async function runDm(
    event: any,
    scenario: Scenario = {},
    options?: { lastAttempt: boolean },
    entryId = 'ig-page-1'
): Promise<{ executed: Executed[]; sends: Sent[]; geminiCalls: number; error: any }> {
    const {
        creator = CREATOR,
        conversation = { id: 'conv-1', is_bot_active: true, ai_disclosed_at: null },
        inboundInsert = [{ id: 'msg-1' }],
        resumeClaim = [],
        agent = { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-2.5-flash', temperature: 0.7 },
        creatorQuotaCount = 1,
        appQuotaCount = 1,
        gemini = geminiSaying({ message_type: 'text', text: 'أهلاً بك' }),
        send = async () => ({ data: { message_id: 'sent-1' } }),
    } = scenario;

    const executed: Executed[] = [];
    const sends: Sent[] = [];
    let geminiCalls = 0;

    // First match wins, so the specific patterns come before the general ones.
    const routes: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/FROM creators\s+WHERE is_active/, { rows: creator ? [creator] : [] }],
        [/UPDATE creators/, { rowCount: 1 }],
        [/INSERT INTO conversations/, { rows: conversation ? [conversation] : [] }],
        [/UPDATE conversations SET ai_disclosed_at/, { rowCount: 1 }],
        [/ON CONFLICT \(meta_message_id\)/, { rows: inboundInsert }],
        [/reply_attempts = reply_attempts \+ 1/, { rows: resumeClaim }],
        [/SET handled_at = NOW\(\)/, { rowCount: 1 }],
        [/SET reply_claimed_at = NULL WHERE/, { rowCount: 1 }],
        [/FROM ai_agents/, { rows: agent ? [agent] : [] }],
        [/SELECT direction, text/, { rows: [] }],
        [/INSERT INTO messages/, { rowCount: 1 }],   // the outbound row; no RETURNING
        [/INSERT INTO rate_limit_counters/, { rows: [{ count: creatorQuotaCount }] }],
        [/INSERT INTO app_rate_limit_counters/, { rows: [{ count: appQuotaCount }] }],
    ];

    const originalQuery = pool.query;
    const originalAxiosPost = axios.post;
    const originalMetaPost = metaHttp.post;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';

    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1];
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (axios as any).post = async () => {
        geminiCalls++;
        return gemini();
    };
    (metaHttp as any).post = async (url: string, body: any) => {
        sends.push({ url, body });
        return send(url, body);
    };

    let error: any = null;
    try {
        await handleMessagingEvent(event, entryId, options ?? { lastAttempt: false });
    } catch (err) {
        error = err;
    } finally {
        (pool as any).query = originalQuery;
        (axios as any).post = originalAxiosPost;
        (metaHttp as any).post = originalMetaPost;
        if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalKey;
    }

    return { executed, sends, geminiCalls, error };
}

const textEvent = (over: Record<string, unknown> = {}) => ({
    sender: { id: 'user-1' },
    recipient: { id: 'ig-page-1' },
    message: { mid: 'mid-1', text: 'كم سعر الكورس؟' },
    ...over,
});

/** Which of the terminal bookkeeping statements ran. */
const ranMarkHandled = (executed: Executed[]) =>
    executed.some((e) => /SET handled_at = NOW\(\)/.test(e.sql));
const ranRelease = (executed: Executed[]) =>
    executed.some((e) => /SET reply_claimed_at = NULL WHERE/.test(e.sql));

describe('handleMessagingEvent — what it declines to answer', () => {
    it('ignores the page\'s own echo without touching the database', async () => {
        const { executed, geminiCalls } = await runDm(
            textEvent({ message: { mid: 'mid-1', text: 'x', is_echo: true } })
        );

        assert.equal(executed.length, 0);
        assert.equal(geminiCalls, 0);
    });

    it('stops at the creator lookup when no tenant owns the page', async () => {
        // Returning quietly, not throwing: an event for a page this deployment does not serve
        // is routine, and raising here would make the job runner retry it forever.
        const { executed, geminiCalls, error } = await runDm(textEvent(), { creator: null });

        assert.equal(error, null);
        assert.equal(executed.length, 1, 'no conversation row for an unknown page');
        assert.equal(geminiCalls, 0);
    });

    it('answers nothing when the bot is paused, but records the message as handled', async () => {
        // Terminal on purpose: the operator took the thread over, and a retry must not decide
        // later that the bot should have answered after all.
        const { executed, sends, geminiCalls } = await runDm(textEvent(), {
            conversation: { id: 'conv-1', is_bot_active: false, ai_disclosed_at: null },
        });

        assert.equal(geminiCalls, 0);
        assert.equal(sends.length, 0);
        assert.equal(ranMarkHandled(executed), true);
    });

    it('says nothing at all for a tenant with no AI agent configured', async () => {
        // A tenant created through the admin route has no `ai_agents` row, so there is no
        // `is_active` for the off switch to be false on. Inventing a persona for them is worse
        // than silence.
        const { sends, executed } = await runDm(textEvent(), { agent: null });

        assert.equal(sends.length, 0);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(
            executed.some((e) => /'outbound'/.test(e.sql)), false,
            'no outbound row may be written for a reply that was never sent'
        );
    });
});

describe('handleMessagingEvent — claiming the inbound message', () => {
    it('upserts the thread on (creator, sender) rather than reusing one', async () => {
        // The conversation is the unit the AI history window reads from. Keying it on
        // anything but the person who wrote would pour every customer's thread into one and
        // feed strangers' messages back to Gemini as context.
        const { executed } = await runDm(textEvent());

        const upsert = executed.find((e) => /INSERT INTO conversations/.test(e.sql))!;
        assert.deepEqual(upsert.params, ['creator-1', 'user-1']);
        assert.match(upsert.sql, /ON CONFLICT \(creator_id, instagram_user_id\)/);
        assert.match(upsert.sql, /DO UPDATE SET last_message_at = NOW\(\)/,
            'one statement, not SELECT-then-INSERT: two DMs a second apart raced on this');
    });

    it('writes the inbound row, claims it, and marks it handled only at the end', async () => {
        const { executed, sends } = await runDm(textEvent());

        const claim = executed.find((e) => /ON CONFLICT \(meta_message_id\)/.test(e.sql))!;
        assert.equal(claim.params[0], 'conv-1');
        assert.equal(claim.params[1], 'creator-1');
        assert.equal(claim.params[2], 'text');
        assert.equal(claim.params[3], 'كم سعر الكورس؟');
        assert.equal(claim.params[6], 'mid-1', 'the mid is the dedupe key');

        assert.equal(sends.length, 1);

        // Order is the assertion: a crash between the send and `markHandled` must leave the
        // message claimable, so `handled_at` cannot be written before the outbound row.
        const outboundAt = executed.findIndex((e) => /'outbound'/.test(e.sql));
        const handledAt = executed.findIndex((e) => /SET handled_at = NOW\(\)/.test(e.sql));
        assert.ok(outboundAt > -1 && handledAt > outboundAt, 'handled_at must be written last');
    });

    it('labels a story mention and gives it text Gemini can read', async () => {
        const { executed } = await runDm(
            textEvent({ message: { mid: 'mid-2', attachments: [{ type: 'story_mention' }] } })
        );

        const claim = executed.find((e) => /ON CONFLICT \(meta_message_id\)/.test(e.sql))!;
        assert.equal(claim.params[2], 'story_mention');
        assert.equal(claim.params[3], '[Story Mention]');
    });

    it('re-claims a message a previous attempt left unfinished', async () => {
        // The v14 split: the UNIQUE index still dedupes redeliveries, but a row whose
        // `handled_at` is still null and whose claim has gone stale is work to be resumed.
        const { executed, sends } = await runDm(textEvent(), {
            inboundInsert: [],
            resumeClaim: [{ id: 'msg-1', reply_attempts: 2 }],
        });

        const resume = executed.find((e) => /reply_attempts = reply_attempts \+ 1/.test(e.sql))!;
        assert.equal(resume.params[0], 'mid-1');
        assert.equal(resume.params[1], 300, 'the 300s visibility window');
        assert.match(resume.sql, /AND handled_at IS NULL/);
        assert.match(resume.sql, /reply_claimed_at IS NULL OR reply_claimed_at < NOW\(\) - make_interval/);
        assert.equal(sends.length, 1, 'a resumed message still gets answered');
    });

    it('answers nobody when the message is already handled or still claimed', async () => {
        // Both cases return no row from the re-claim, and both mean "not ours". Getting this
        // wrong sends the same person a second DM, which cannot be undone.
        const { executed, sends, geminiCalls } = await runDm(textEvent(), {
            inboundInsert: [],
            resumeClaim: [],
        });

        assert.equal(geminiCalls, 0, 'and it must not pay for a Gemini call either');
        assert.equal(sends.length, 0);
        assert.equal(ranMarkHandled(executed), false);
        assert.equal(ranRelease(executed), false);
    });
});

describe('handleMessagingEvent — the AI disclosure', () => {
    it('prefixes the disclosure on a thread that has never had one, and records it', async () => {
        const { sends, executed } = await runDm(textEvent());

        assert.match(sends[0]!.body.message.text, /^🤖 رد آلي من المساعد الذكي\n/);
        assert.match(sends[0]!.body.message.text, /أهلاً بك$/);
        assert.equal(
            executed.some((e) => /UPDATE conversations SET ai_disclosed_at/.test(e.sql)), true
        );
    });

    it('does not disclose again inside the week', async () => {
        const { sends, executed } = await runDm(textEvent(), {
            conversation: {
                id: 'conv-1',
                is_bot_active: true,
                ai_disclosed_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            },
        });

        assert.equal(sends[0]!.body.message.text, 'أهلاً بك');
        assert.equal(
            executed.some((e) => /UPDATE conversations SET ai_disclosed_at/.test(e.sql)), false
        );
    });

    it('discloses again after a long gap', async () => {
        const { sends } = await runDm(textEvent(), {
            conversation: {
                id: 'conv-1',
                is_bot_active: true,
                ai_disclosed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
            },
        });

        assert.match(sends[0]!.body.message.text, /^🤖/);
    });

    it('sends the disclosure as its own message when the reply is a carousel', async () => {
        // Meta rejects `text` alongside `attachment`, so a template cannot carry the prefix.
        const { sends } = await runDm(textEvent(), {
            gemini: geminiSaying({
                message_type: 'carousel',
                text: '',
                carousel_elements: [{ title: 'كورس الذكاء الاصطناعي' }],
            }),
        });

        assert.equal(sends.length, 2, 'the disclosure travels separately');
        assert.equal(sends[0]!.body.message.text, '🤖 رد آلي من المساعد الذكي');
        assert.equal(sends[1]!.body.message.attachment.type, 'template');
    });

    it('does not record the disclosure when the send failed', async () => {
        // Otherwise a failed first reply burns the disclosure and the retry never discloses.
        const { executed } = await runDm(textEvent(), {
            send: async () => {
                throw Object.assign(new Error('blocked'), {
                    response: { status: 400, data: { error: { code: 10903 } } },
                });
            },
        });

        assert.equal(
            executed.some((e) => /UPDATE conversations SET ai_disclosed_at/.test(e.sql)), false
        );
    });
});

describe('handleMessagingEvent — which endpoint the reply goes to', () => {
    it('sends a Facebook Messenger reply to /{pageId}/messages', async () => {
        const { sends } = await runDm(
            textEvent({ recipient: { id: 'fb-page-1' } }), {}, undefined, 'fb-page-1'
        );

        assert.match(sends[0]!.url, /\/fb-page-1\/messages$/);
    });

    it('sends an Instagram reply to /me/messages', async () => {
        const { sends } = await runDm(textEvent());

        assert.match(sends[0]!.url, /\/me\/messages$/);
    });
});

describe('handleMessagingEvent — the send quota', () => {
    const exhausted = { creatorQuotaCount: 181 };

    it('releases the claim and re-raises so the runner backs off', async () => {
        // Retried rather than dropped: the counters are hourly and the backoff may well land
        // in the next window. The alternative is a real customer silently never answered.
        const { executed, sends, error } = await runDm(textEvent(), exhausted);

        assert.ok(error, 'the failure must reach the runner');
        assert.match(error.message, /Send quota exhausted \(creator: 181\/180\)/);
        assert.equal(sends.length, 0);
        assert.equal(ranRelease(executed), true, 'release is what lets the retry reach the work');
        assert.equal(ranMarkHandled(executed), false);
    });

    it('records the message as handled instead when this is the last attempt', async () => {
        // Releasing on the final attempt strands the row forever, which in the dashboard is
        // indistinguishable from the webhook having stopped.
        const { executed, error } = await runDm(textEvent(), exhausted, { lastAttempt: true });

        assert.equal(error, null);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
    });

    it('records it as handled for a mid-less event even mid-budget', async () => {
        // No mid means the partial unique index never fires, so a retry would insert a second
        // inbound row and answer the same person twice. One attempt, whatever the budget says.
        const { executed, error } = await runDm(
            textEvent({ message: { text: 'مرحبا' } }), exhausted, { lastAttempt: false }
        );

        assert.equal(error, null);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
    });

    it('refuses on the app-wide ceiling too, not only the per-creator one', async () => {
        // One tenant's viral reel can 429 every other tenant; the app pool is shared.
        const { error } = await runDm(textEvent(), { appQuotaCount: 1_001 });

        assert.match(error?.message ?? '', /Send quota exhausted \(app: 1001\/1000\)/);
    });
});

describe('handleMessagingEvent — transient versus permanent failure', () => {
    it('releases and re-raises a transient Gemini failure', async () => {
        // This is the branch that used to log-and-swallow: job marked done, inbound row
        // permanently unanswerable, customer never answered, nothing anywhere saying so.
        const { executed, error, sends } = await runDm(textEvent(), {
            gemini: async () => {
                throw Object.assign(new Error('overloaded'), {
                    response: { status: 503, data: { error: { message: 'model overloaded' } } },
                });
            },
        });

        assert.ok(error, 'the runner only backs off if the error reaches it');
        assert.match(error.message, /Gemini request failed \[HTTP 503\]/);
        assert.equal(sends.length, 0);
        assert.equal(ranRelease(executed), true);
        assert.equal(ranMarkHandled(executed), false);
    });

    it('records a permanent Meta failure as final and does not re-raise', async () => {
        // Retrying a dead token is how an app attracts Meta's enforcement attention.
        const { executed, error } = await runDm(textEvent(), {
            send: async () => {
                throw Object.assign(new Error('Invalid OAuth access token'), {
                    response: { status: 400, data: { error: { code: 190, error_subcode: 463 } } },
                });
            },
        });

        assert.equal(error, null);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
    });

    it('flips the creator\'s token_status when Meta says the token is dead', async () => {
        // Until this existed, `creators.token_status` only changed when someone opened the
        // dashboard's token page — a token that died on a Friday was invisible until Monday.
        const { executed } = await runDm(textEvent(), {
            send: async () => {
                throw Object.assign(new Error('expired'), {
                    response: { status: 400, data: { error: { code: 190, error_subcode: 463 } } },
                });
            },
        });

        const flip = executed.find((e) => /UPDATE creators/.test(e.sql));
        assert.ok(flip, 'the token death must be written down');
        assert.match(flip.sql, /token_status = 'invalid'/);
        assert.equal(flip.params[0], 'creator-1');
    });

    it('records a transient failure as final on the last attempt', async () => {
        const { executed, error } = await runDm(
            textEvent(),
            { gemini: async () => { throw new Error('socket hang up'); } },
            { lastAttempt: true }
        );

        assert.equal(error, null);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
    });
});
