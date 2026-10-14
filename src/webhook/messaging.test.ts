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
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { DEFAULT_MODEL } from '../services/ai.js';
import { MISSING_GEMINI_KEY } from '../services/appSettings.js';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../services/aiProviders/generate.js';
import { AiError } from '../services/llm/errors.js';
import { metaHttp } from '../services/http.js';
import { ProfileUnreadableError } from '../services/profile/context.js';
import { withSales } from '../services/dmSales/testFixtures.js';
import { FITNESS_EN, SHOP_EG } from '../services/profile/fixtures.js';
import { KITS } from '../services/profile/kits.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import type { CreatorProfile } from '../services/profile/types.js';
import { invalidateTenantCache, type Creator } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import {
    dmPlatform, dmPromptText, handleMessagingEvent, needsDisclosure, normalizeDm, resolveDmPageId,
    STORY_MENTION_TEXT,
} from './messaging.js';
import { handlers } from '../jobs/handlers.js';
import type { Job } from '../jobs/types.js';
import { ATTACHMENT_ACK_TYPE, describeWordless, WORDLESS_MESSAGE_TYPES } from './attachments.js';
import type { WebhookHandlerOptions } from './options.js';

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
                wordless: null,
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

    it('treats a story mention as a message with no words: stored as its kind, with the placeholder it always had', () => {
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
        assert.equal(dm?.wordless?.kind, 'story_mention');
        assert.equal(dm?.wordless?.ack, 'mention');
        assert.equal(dmPromptText(dm!), STORY_MENTION_TEXT);
    });

    it('returns an attachment that is not a story mention too: a photo is a message with no words, no longer dropped', () => {
        // An image or a voice note with no caption used to return null here, so the person was never stored, shown or answered.
        const dm = normalizeDm({
            sender: { id: 'u-1' },
            message: { mid: 'm-6', attachments: [{ type: 'image', payload: { url: 'https://cdn.example.test/i.jpg' } }] },
        });

        assert.notEqual(dm, null);
        assert.equal(dm?.isStoryMention, false, 'and it is not read as a story mention');
        assert.equal(dm?.wordless?.kind, 'image');
        assert.equal(dm?.wordless?.placeholder, '[photo]');
        assert.equal(dm?.text, '');
        assert.equal(dm?.metaMessageId, 'm-6');
    });

    it('reads every other message with no words: a reply to a story, a message Instagram could not show', () => {
        const reply = normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm-7', reply_to: { story: { url: 'https://cdn.example.test/s', id: '1' } } } });
        assert.equal(reply?.wordless?.kind, 'story_reply');
        const unsupported = normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm-8', is_unsupported: true } });
        assert.equal(unsupported?.wordless?.kind, 'attachment');
    });

    it('a message with words is never word-less: a caption, a quick reply and a postback keep their words', () => {
        const caption = normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm-9', text: 'كم سعره؟', attachments: [{ type: 'image', payload: { url: 'https://cdn.example.test/i.jpg' } }] } });
        assert.equal(caption?.wordless, null);
        assert.equal(caption?.text, 'كم سعره؟');
        const quick = normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm-10', quick_reply: { payload: 'P' }, attachments: [{ type: 'image' }] } });
        assert.equal(quick?.wordless, null);
        // Messenger's `fallback` is a shared link, and usually comes WITH the text of the link: that is a text DM.
        const link = normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm-11', text: 'https://example.test/page', attachments: [{ type: 'fallback', payload: { url: 'https://example.test/page', title: 'A page' } }] } });
        assert.equal(link?.wordless, null);
        assert.equal(link?.text, 'https://example.test/page');
        const postback = normalizeDm({ sender: { id: 'u-1' }, postback: { mid: 'm-12', title: 'ابدأ', payload: 'GET_STARTED' } });
        assert.equal(postback?.wordless, null);
    });

    it('an unsend is not a new message, even one that still carries attachments', () => {
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm-13', is_deleted: true } }), null);
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm-14', is_deleted: true, attachments: [{ type: 'image', payload: { url: 'x' } }] } }), null);
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm-15', is_deleted: true, text: 'x' } }), null);
    });

    it('skips events with nothing to reply to', () => {
        // Read watermarks, delivery receipts, reactions, referrals. These outnumber real
        // messages on a busy account.
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, read: { watermark: 1 } }), null);
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, delivery: { watermark: 1 } }), null);
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm', text: '' } }), null);
        assert.equal(normalizeDm({ message: { mid: 'm', text: 'no sender' } }), null);
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm' } }), null, 'a message with nothing in it');
        assert.equal(normalizeDm({ sender: { id: 'u-1' }, message: { mid: 'm', attachments: [] } }), null, 'and one with an empty list');
        assert.equal(normalizeDm({ message: { mid: 'm', attachments: [{ type: 'image' }] } }), null, 'no sender: nobody to answer, whatever it holds');
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

/**
 * v26 `conversations.platform`: which network the thread is on. The body's `object` is the exact
 * answer; the page-id match is only for jobs queued before the object travelled with them.
 */
describe('dmPlatform', () => {
    const creator = { instagram_page_id: 'ig-1', facebook_page_id: 'fb-9' };

    it('takes the body object as the answer: instagram, or page = Messenger', () => {
        assert.equal(dmPlatform('instagram', creator, [undefined, undefined]), 'instagram');
        assert.equal(dmPlatform('page', creator, [undefined, undefined]), 'facebook');
    });

    it('trusts the object over the ids, which only a job from before v26 has to fall back on', () => {
        // An Instagram event under a page-level subscription may carry the Page id in entry.id.
        assert.equal(dmPlatform('instagram', creator, ['ig-1', 'fb-9']), 'instagram');
        assert.equal(dmPlatform('page', creator, ['ig-1', 'ig-1']), 'facebook');
    });

    it('falls back to the page id the event was addressed to, recipient first', () => {
        assert.equal(dmPlatform(undefined, creator, ['ig-1', 'ig-1']), 'instagram');
        assert.equal(dmPlatform(undefined, creator, ['fb-9', 'fb-9']), 'facebook');
        assert.equal(dmPlatform(undefined, creator, [undefined, 'fb-9']), 'facebook', 'entry.id when there is no recipient');
        assert.equal(dmPlatform(undefined, creator, ['ig-1', 'fb-9']), 'instagram', 'recipient.id outranks entry.id');
    });

    it('answers null rather than guessing', () => {
        assert.equal(dmPlatform(undefined, creator, ['someone-else', undefined]), null);
        assert.equal(dmPlatform('whatsapp_business_account', creator, [undefined, undefined]), null);
        // An unset page id must not match an absent or empty id.
        assert.equal(dmPlatform(undefined, { instagram_page_id: '', facebook_page_id: null }, ['', undefined]), null);
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
    /**
     * Rows the acknowledgement's claim statement returns (src/webhook/attachmentAck.ts: the outbound row, inserted only when no later
     * message is waiting, no words are being answered and it has not asked already). Default one row; empty = the claim refused.
     */
    ackClaim?: Record<string, unknown>[];
    agent?: Record<string, unknown> | null;
    creatorQuotaCount?: number;
    appQuotaCount?: number;
    /** Rows the conversation-history SELECT returns, oldest last as the query orders them. */
    history?: Record<string, unknown>[];
    /** What Gemini answers with, or throws. */
    gemini?: () => Promise<any>;
    /** What the Send API answers with, or throws. */
    send?: (url: string, body: any) => Promise<any>;
    /** A key saved on the Operations screen, stored as it really is: encrypted. Absent = none. */
    savedGeminiKey?: string;
    /** GEMINI_API_KEY for this run; null = unset. Default 'test-key'. */
    envGeminiKey?: string | null;
    /**
     * The tenant's stored Creator Profile (P8: the DM's wording is read from it). Absent = the profile read is not arranged,
     * so it throws like any statement a test did not arrange, and the pipeline falls back to the owner's wording.
     */
    profile?: CreatorProfile;
    /**
     * Who the platform owner is (`getPlatformOwnerId`: the first creator ever made): an id, or null for no creators at all.
     * Absent = the lookup is not arranged, so it throws like any statement a test did not arrange. It only matters when the
     * profile cannot be read: the owner is then answered in his legacy wording, another tenant's job is retried.
     */
    owner?: string | null;
    /** Statements a scenario arranges on top of the standard ones, tried first (the sales turn's own reads and writes). */
    extraRoutes?: Array<[RegExp, { rows?: any[]; rowCount?: number }]>;
    /**
     * The sender-profile lookup (v40): `claim` is whether the throttle lets it through (default true), `graph` what Meta answers
     * (default a full profile) or throws. Absent = the lookup's statements are not arranged, so they throw like any statement a test
     * did not arrange: which is itself a scenario, because a lookup that cannot run must not change what happens to the DM.
     */
    senderProfile?: { claim?: boolean; graph?: (url: string, config: any) => Promise<any> };
}

/** Any 32 bytes of hex: enough to encrypt and decrypt a saved key inside one run. */
const TEST_ENCRYPTION_KEY = 'ab'.repeat(32);

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
    options?: WebhookHandlerOptions,
    entryId = 'ig-page-1',
    /** What to drive instead of `handleMessagingEvent` — the job handler, for the wiring test. */
    invoke?: (event: any, entryId: string) => Promise<void>
): Promise<{ executed: Executed[]; sends: Sent[]; lookups: Array<{ url: string; config: any }>; geminiCalls: number; geminiPayloads: any[]; geminiUrls: string[]; geminiKeys: string[]; error: any; timeline: string[] }> {
    const {
        creator = CREATOR,
        conversation = { id: 'conv-1', is_bot_active: true, ai_disclosed_at: null },
        inboundInsert = [{ id: 'msg-1' }],
        resumeClaim = [],
        ackClaim = [{ id: 'ack-1' }],
        agent = { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: DEFAULT_MODEL, temperature: 0.7 },
        history = [],
        creatorQuotaCount = 1,
        appQuotaCount = 1,
        gemini = geminiSaying({ message_type: 'text', text: 'أهلاً بك' }),
        send = async () => ({ data: { message_id: 'sent-1' } }),
        savedGeminiKey,
        envGeminiKey = 'test-key',
        profile,
        owner,
        extraRoutes = [],
        senderProfile,
    } = scenario;

    const executed: Executed[] = [];
    // Every call that leaves the pipeline, in the order it was made: a statement, Gemini, a request to Meta. What "the same calls in the same order" is checked on.
    const timeline: string[] = [];
    const sends: Sent[] = [];
    // The request body Gemini was actually handed. Recorded because one bug in this file is
    // only visible in the payload: a story mention used to append an empty `user` part.
    const geminiPayloads: any[] = [];
    // The URL carries the model, so it is the only place a model choice is visible.
    const geminiUrls: string[] = [];
    // And the header carries the key: which of the saved one and GEMINI_API_KEY answered.
    const geminiKeys: string[] = [];
    let geminiCalls = 0;

    const originalEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    if (savedGeminiKey !== undefined) process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const savedKeyRows = savedGeminiKey !== undefined
        ? [{ value: encryptSecret(savedGeminiKey), is_secret: true }]
        : [];

    // First match wins, so the specific patterns come before the general ones.
    const routes: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/FROM app_settings WHERE key/, { rows: savedKeyRows }],
        [/FROM creators\s+WHERE is_active/, { rows: creator ? [creator] : [] }],
        [/UPDATE creators/, { rowCount: 1 }],
        [/INSERT INTO conversations/, { rows: conversation ? [conversation] : [] }],
        [/UPDATE conversations SET ai_disclosed_at/, { rowCount: 1 }],
        [/ON CONFLICT \(meta_message_id\)/, { rows: inboundInsert }],
        [/reply_attempts = reply_attempts \+ 1/, { rows: resumeClaim }],
        [/SET handled_at = NOW\(\)/, { rowCount: 1 }],
        [/SET reply_claimed_at = NULL WHERE/, { rowCount: 1 }],
        [/FROM ai_agents/, { rows: agent ? [agent] : [] }],
        [/SELECT direction, text/, { rows: history }],
        [/SELECT \$1, \$2, 'outbound'/, { rows: ackClaim }],   // the acknowledgement's claim: an outbound row WITH `RETURNING id`
        [/DELETE FROM messages WHERE id = \$1/, { rowCount: 1 }],   // the claim taken back
        [/INSERT INTO messages/, { rowCount: 1 }],   // the outbound row; no RETURNING
        [/INSERT INTO rate_limit_counters/, { rows: [{ count: creatorQuotaCount }] }],
        [/INSERT INTO app_rate_limit_counters/, { rows: [{ count: appQuotaCount }] }],
    ];
    // The sender-profile lookup's two statements: the throttle's claim, and the write.
    if (senderProfile) {
        routes.unshift([/profile_fetched_at = NOW\(\)/, { rows: [{ username: 'sam_dev', profile_name: 'Sam Dev', profile_fetched_at: new Date(0) }] }]);
        routes.unshift([/SET profile_checked_at = NOW\(\)/, { rows: senderProfile.claim === false ? [] : [{ id: 'conv-1' }] }]);
    }
    // Read as the database hands it back: JSONB, its keys in Postgres's order.
    if (profile) routes.unshift([/FROM creator_profiles/, { rows: [{ profile: throughJsonb(profile), version: 3, activated_at: null }] }]);
    if (owner !== undefined) routes.unshift([/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/, { rows: owner === null ? [] : [{ id: owner }] }]);
    routes.unshift(...extraRoutes);
    // The owner lookup is cached in the process for 30 s: one run's answer must not be the next one's.
    invalidateTenantCache();

    const originalQuery = pool.query;
    const originalAxiosPost = axios.post;
    const originalMetaPost = metaHttp.post;
    const originalMetaGet = metaHttp.get;
    const lookups: Array<{ url: string; config: any }> = [];
    const originalKey = process.env.GEMINI_API_KEY;
    if (envGeminiKey === null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = envGeminiKey;

    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        timeline.push(`SQL ${sql.replace(/\s+/g, ' ').slice(0, 40)}`);
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1];
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (axios as any).post = async (url: string, payload: any, config: any) => {
        timeline.push('GEMINI');
        geminiCalls++;
        geminiPayloads.push(payload);
        geminiUrls.push(url);
        geminiKeys.push(config?.headers?.['x-goog-api-key']);
        return gemini();
    };
    (metaHttp as any).post = async (url: string, body: any) => {
        timeline.push(`META ${body?.sender_action ?? 'message'}`);
        sends.push({ url, body });
        return send(url, body);
    };
    // Only the profile lookup reads from Meta in this pipeline. Without a `senderProfile` scenario a GET is a bug in the test.
    (metaHttp as any).get = async (url: string, config: any) => {
        timeline.push('META profile');
        lookups.push({ url, config });
        if (!senderProfile) throw new Error(`no GET was arranged for ${url}`);
        return (senderProfile.graph ?? (async () => ({ data: { name: 'Sam Dev', username: 'sam_dev', profile_pic: 'https://cdn.example.test/s.jpg', follower_count: 10 } })))(url, config);
    };

    let error: any = null;
    try {
        if (invoke) await invoke(event, entryId);
        else await handleMessagingEvent(event, entryId, options ?? { lastAttempt: false });
    } catch (err) {
        error = err;
    } finally {
        (pool as any).query = originalQuery;
        (axios as any).post = originalAxiosPost;
        (metaHttp as any).post = originalMetaPost;
        (metaHttp as any).get = originalMetaGet;
        if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalKey;
        if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
        else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
        invalidateTenantCache();
    }

    return { executed, sends, lookups, geminiCalls, geminiPayloads, geminiUrls, geminiKeys, error, timeline };
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
    it('ignores the page\'s own echo: with takeover off, the default, the one statement is the read of that switch (S8)', async () => {
        // Before S8 an echo cost no statement at all. The queue still drops an echo before it is a job (router.test.ts), so this is
        // the inline fallback path only, and what it costs is one indexed row, `dm.echo_takeover`. Everything else is as it was:
        // no conversation, no claim, no pause, no model, no send.
        const { executed, geminiCalls, sends } = await runDm(
            textEvent({ message: { mid: 'mid-1', text: 'x', is_echo: true } })
        );

        assert.equal(executed.length, 1);
        assert.match(executed[0]!.sql, /FROM app_settings WHERE key/);
        assert.ok(executed[0]!.params.flat().includes('dm.echo_takeover'), 'and it is that switch it reads');
        assert.equal(geminiCalls, 0);
        assert.equal(sends.length, 0);
    });

    it('takeover on: an echo from the Page inbox app pauses the thread through the same pipeline, and still sends and asks nothing (S8)', async () => {
        const { executed, geminiCalls, sends, error } = await runDm(
            { sender: { id: 'ig-page-1' }, recipient: { id: 'user-1' }, message: { mid: 'mid-echo', text: 'I will take this one', is_echo: true, app_id: '263902037430900' } },
            { extraRoutes: [
                [/FROM app_settings WHERE key/, { rows: [{ key: 'dm.echo_takeover', value: 'true', is_secret: false }] }],
                [/UPDATE conversations SET is_bot_active = false/, { rows: [{ id: 'conv-1' }] }],
            ] }
        );

        assert.equal(error, null);
        assert.ok(executed.some((e) => /UPDATE conversations SET is_bot_active = false/.test(e.sql)), 'the thread is paused');
        assert.ok(!executed.some((e) => /ON CONFLICT \(meta_message_id\) DO NOTHING|reply_attempts/.test(e.sql) && /'customer'/.test(e.sql)), 'and it is not claimed as a customer message');
        assert.equal(sends.length, 0);
        assert.equal(geminiCalls, 0);
    });

    it('takeover on, but an echo with no app_id: nothing is paused, because it cannot be told from our own send (A4)', async () => {
        const { executed, sends } = await runDm(
            { sender: { id: 'ig-page-1' }, recipient: { id: 'user-1' }, message: { mid: 'mid-echo', text: 'x', is_echo: true } },
            { extraRoutes: [[/FROM app_settings WHERE key/, { rows: [{ key: 'dm.echo_takeover', value: 'true', is_secret: false }] }]] }
        );

        assert.equal(executed.length, 1, 'only the switch was read');
        assert.equal(sends.length, 0);
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
        // The third is the platform (v26): no body object here, so from the recipient id.
        assert.deepEqual(upsert.params, ['creator-1', 'user-1', 'instagram']);
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

    it('stores a story mention as its kind, with its placeholder, and answers it with the mention line: Gemini is never asked', async () => {
        const { executed, geminiCalls, sends } = await runDm(
            textEvent({ message: { mid: 'mid-2', attachments: [{ type: 'story_mention' }] } })
        );

        const claim = executed.find((e) => /ON CONFLICT \(meta_message_id\)/.test(e.sql))!;
        assert.equal(claim.params[2], 'story_mention');
        assert.equal(claim.params[3], '[Story Mention]');
        // It used to go to Gemini as the text "[Story Mention]", which cannot see the story: now one fixed line, no model.
        assert.equal(geminiCalls, 0);
        assert.equal(sends.length, 1);
        assert.ok(String(sends[0]!.body.message.text).endsWith(KITS.gulf.attachments.mention));
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

/**
 * P8: what the DM path says is read from the tenant's Creator Profile. The owner's profile (or none that can be read) gives
 * the text it always had; another tenant's gives its own language, register and noun, in the rules and schema Gemini is
 * handed and in the first line of the reply the person reads.
 */
describe('handleMessagingEvent — the wording is the tenant\'s (P8)', () => {
    const instruction = (payloads: any[]): string => payloads[0].systemInstruction.parts[0].text;
    const schema = (payloads: any[]): any => payloads[0].generationConfig.responseSchema;

    it('an English coach: English rules, an English schema and an English disclosure, and not a letter of Arabic in what it was told', async () => {
        const { sends, geminiPayloads, error } = await runDm(textEvent({ message: { mid: 'mid-1', text: 'How much is it?' } }), {
            profile: FITNESS_EN,
            agent: { is_active: true, system_prompt: 'You are Sami\'s assistant.', knowledge_base: 'The plan is $99.', model: DEFAULT_MODEL, temperature: 0.7 },
            gemini: geminiSaying({ message_type: 'text', text: 'It is $99.' }),
        });

        assert.equal(error, null);
        assert.match(instruction(geminiPayloads), /^You are Sami's assistant\.\n\n=== Knowledge base available to you ===\nThe plan is \$99\.\n\n=== Additional important instructions ===\n1\. Your replies must be friendly/);
        assert.match(instruction(geminiPayloads), /2\. If the user asks for offers or contact details/);
        assert.doesNotMatch(JSON.stringify([geminiPayloads[0].systemInstruction, schema(geminiPayloads)]), /[\u0600-\u06FF]/, 'no Arabic anywhere in what Gemini was handed');
        assert.match(schema(geminiPayloads).properties.text.description, /Must be written in English if appropriate\./);
        assert.match(schema(geminiPayloads).properties.quick_replies.items.properties.payload.description, /GO_TO_OFFER_1/);
        assert.equal(sends[0]!.body.message.text, '🤖 Automated reply from the AI assistant\nIt is $99.');
    });

    it('an Egyptian shop: simple Egyptian asked for, «منتجات» for the offers, an Arabic schema and the Arabic disclosure', async () => {
        const { sends, geminiPayloads, error } = await runDm(textEvent(), { profile: SHOP_EG });

        assert.equal(error, null);
        assert.match(instruction(geminiPayloads), /1\. يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللهجة المصرية البسيطة\./);
        assert.match(instruction(geminiPayloads), /2\. إذا طلب المستخدم منتجات أو معلومات تواصل/);
        assert.doesNotMatch(instruction(geminiPayloads), /كورسات/);
        assert.match(schema(geminiPayloads).properties.text.description, /Must be written in Arabic if appropriate\./);
        assert.match(schema(geminiPayloads).properties.quick_replies.items.properties.payload.description, /GO_TO_OFFER_1/);
        assert.match(sends[0]!.body.message.text, /^🤖 رد آلي من المساعد الذكي\n/);
    });

    it('a carousel from an English tenant gets its disclosure as an English message of its own', async () => {
        const { sends } = await runDm(textEvent(), {
            profile: FITNESS_EN,
            gemini: geminiSaying({ message_type: 'carousel', text: '', carousel_elements: [{ title: 'Twelve-week plan' }] }),
        });

        assert.equal(sends.length, 2);
        assert.equal(sends[0]!.body.message.text, '🤖 Automated reply from the AI assistant');
    });

    it('a profile that cannot be read is the owner\'s wording, and the person is still answered', async () => {
        // No profile read is arranged, so it throws; the reply must go out in the text the bot always spoke.
        const { sends, geminiPayloads, error, executed } = await runDm(textEvent());

        assert.equal(error, null);
        assert.ok(executed.some((e) => /FROM creator_profiles/.test(e.sql)), 'the profile was asked for');
        assert.match(instruction(geminiPayloads), /1\. يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللغة العربية الفصحى أو بلهجة سهلة ومناسبة\./);
        assert.match(instruction(geminiPayloads), /2\. إذا طلب المستخدم كورسات أو معلومات تواصل/);
        assert.match(schema(geminiPayloads).properties.quick_replies.items.properties.payload.description, /GO_TO_COURSE_1/);
        assert.match(sends[0]!.body.message.text, /^🤖 رد آلي من المساعد الذكي\n/);
    });

    describe('a profile that cannot be read, for a tenant that is not the owner', () => {
        /** The log lines of one run, as parsed events. */
        async function withLog<T>(run: () => Promise<T>): Promise<{ result: T; events: string[] }> {
            const events: string[] = [];
            const previous = setLogSink((_level, line) => { try { events.push(JSON.parse(line).event); } catch { /* not structured */ } });
            try {
                return { result: await run(), events };
            } finally {
                setLogSink(previous);
            }
        }

        it('is retried, not answered in the owner\'s wording: the error is re-raised, the claim released, Gemini never asked and nothing sent', async () => {
            const { result, events } = await withLog(() => runDm(textEvent(), { owner: 'the-owner' }));

            assert.ok(result.error instanceof ProfileUnreadableError, String(result.error));
            assert.equal(result.geminiCalls, 0);
            assert.equal(result.sends.length, 0);
            assert.equal(ranRelease(result.executed), true, 'the claim is released so the retry reaches the work');
            assert.equal(ranMarkHandled(result.executed), false, 'and the message is not settled');
            assert.ok(events.includes('profile.context_unreadable'));
            assert.ok(events.includes('dm.pipeline_failed'), 'the failure is logged where every DM failure is');
        });

        it('on the last attempt it is settled and logged, not re-raised: the runner would have nothing to retry', async () => {
            const { result, events } = await withLog(() => runDm(textEvent(), { owner: 'the-owner' }, { lastAttempt: true }));

            assert.equal(result.error, null);
            assert.equal(result.sends.length, 0, 'nothing is said in the owner\'s wording');
            assert.equal(ranMarkHandled(result.executed), true);
            assert.ok(events.includes('dm.pipeline_failed'));
        });

        it('a retry that can read the profile answers in the tenant\'s own wording', async () => {
            const { sends, geminiPayloads, error } = await runDm(textEvent(), { owner: 'the-owner', profile: SHOP_EG });
            assert.equal(error, null);
            assert.equal(sends.length, 1);
            assert.match(geminiPayloads[0].systemInstruction.parts[0].text, /باللهجة المصرية البسيطة/);
        });

        it('is the owner\'s wording when the tenant IS the owner, and when the owner cannot be found (the lookup fails, or finds nobody)', async () => {
            for (const owner of [CREATOR.id, null, undefined]) {
                const { sends, geminiPayloads, error } = await runDm(textEvent(), { owner });
                assert.equal(error, null, String(owner));
                assert.equal(sends.length, 1, String(owner));
                assert.match(geminiPayloads[0].systemInstruction.parts[0].text, /2\. إذا طلب المستخدم كورسات أو معلومات تواصل/, String(owner));
            }
        });
    });

    it('asks for the profile once per DM, however many things are read from it', async () => {
        const { executed } = await runDm(textEvent(), { profile: SHOP_EG });
        assert.equal(executed.filter((e) => /FROM creator_profiles/.test(e.sql)).length, 1);
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

/**
 * v26: the platform the thread is on, and who wrote each row — the two facts the inbox shows
 * (I8, I4). Every writer of `conversations` and `messages` in the DM pipeline is covered here;
 * the operator's manual reply is in src/routes/inboxAnalytics.test.ts.
 */
describe('handleMessagingEvent — which network, and who wrote it (v26)', () => {
    const upsertOf = (executed: Executed[]) => executed.find((e) => /INSERT INTO conversations/.test(e.sql))!;

    it('records the body object as the thread platform: instagram, or page = Messenger', async () => {
        const ig = await runDm(textEvent(), {}, { lastAttempt: false, object: 'instagram' });
        assert.equal(upsertOf(ig.executed).params[2], 'instagram');

        const fb = await runDm(
            textEvent({ recipient: { id: 'fb-page-1' } }), {}, { lastAttempt: false, object: 'page' }, 'fb-page-1'
        );
        assert.equal(upsertOf(fb.executed).params[2], 'facebook');
    });

    it('falls back to the addressed page id for a job queued before v26', async () => {
        const { executed } = await runDm(
            textEvent({ recipient: { id: 'fb-page-1' } }), {}, { lastAttempt: false }, 'fb-page-1'
        );
        assert.equal(upsertOf(executed).params[2], 'facebook');
    });

    it('fills a thread written before v26 and never flips one that has a platform', async () => {
        const { executed } = await runDm(textEvent());
        const sql = upsertOf(executed).sql.replace(/\s+/g, ' ');
        assert.match(sql, /INSERT INTO conversations \(creator_id, instagram_user_id, status, platform\)/);
        assert.match(sql, /platform = COALESCE\(conversations\.platform, EXCLUDED\.platform\)/);
    });

    it('writes the inbound row as the customer’s and the reply as the AI’s', async () => {
        const { executed } = await runDm(textEvent());

        const inbound = executed.find((e) => /ON CONFLICT \(meta_message_id\)/.test(e.sql))!;
        assert.match(inbound.sql.replace(/\s+/g, ' '), /reply_attempts, sender\) VALUES \(.*NOW\(\), 1, 'customer'\)/);

        const outbound = executed.find((e) => /'outbound'/.test(e.sql))!;
        assert.match(outbound.sql.replace(/\s+/g, ' '), /raw_payload, sender\) VALUES \(\$1, \$2, 'outbound', \$3, \$4, \$5, 'ai'\)/);
    });

    it('the dm.process job hands the body object through to the pipeline', async () => {
        // The object lives on the body, not the event, so the job payload is the only way it
        // reaches the pipeline. A handler that drops it silently falls back to the id match.
        const job = { attempts: 1, max_attempts: 3 } as unknown as Job<'dm.process'>;
        const { executed } = await runDm(
            textEvent({ recipient: { id: 'ig-page-1' } }), {}, undefined, 'ig-page-1',
            (event, entryId) => handlers['dm.process']({ event, entryId, object: 'page' }, job)
        );
        assert.equal(upsertOf(executed).params[2], 'facebook', 'the object wins over the Instagram recipient id');
    });
});

/**
 * Who the sender is (v40, the inbox's detail view): an Instagram DM triggers a profile lookup, throttled, best effort. The owner's rule
 * is that it can never get in the way of the reply, so most of these are about what does NOT change.
 */
describe('handleMessagingEvent — the sender’s profile (v40)', () => {
    const claimOf = (executed: Executed[]) => executed.find((e) => /SET profile_checked_at = NOW\(\)/.test(e.sql));
    const storeOf = (executed: Executed[]) => executed.find((e) => /profile_fetched_at = NOW\(\)/.test(e.sql));
    const IG = { lastAttempt: false, object: 'instagram' };

    it('looks an Instagram sender up on first contact: the throttle’s claim, one GET with the Page token, and the write', async () => {
        const { executed, lookups, sends, error } = await runDm(textEvent(), { senderProfile: {} }, IG);
        assert.equal(error, null);
        assert.equal(sends.length, 1, 'the reply went out as it always did');
        assert.ok(claimOf(executed), 'the claim');
        assert.deepEqual(claimOf(executed)!.params, ['conv-1', 3600, 86400]);
        assert.equal(lookups.length, 1);
        assert.match(lookups[0]!.url, /^https:\/\/graph\.facebook\.com\/v[\d.]+\/user-1$/);
        assert.equal(lookups[0]!.config.headers.Authorization, 'Bearer EAAGplaintext');
        assert.match(lookups[0]!.config.params.fields, /^name,username,profile_pic,follower_count,/);
        assert.deepEqual(storeOf(executed)!.params.slice(0, 4), ['conv-1', 'sam_dev', 'Sam Dev', 'https://cdn.example.test/s.jpg']);
        assert.equal(ranMarkHandled(executed), true);
    });

    it('a lookup Meta refuses is logged and changes nothing: the reply is sent once, the message is handled, nothing is re-raised', async () => {
        const refused = Object.assign(new Error('User consent is required'), { response: { status: 400, data: { error: { code: 230, message: 'User consent is required' } } } });
        const { executed, lookups, sends, error } = await runDm(textEvent(), { senderProfile: { graph: async () => { throw refused; } } }, IG);
        assert.equal(error, null, 'the runner is never told');
        assert.equal(sends.length, 1);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false, 'the claim on the message is not released for a profile');
        assert.equal(lookups.length, 1);
        assert.equal(storeOf(executed), undefined, 'and nothing was stored');
    });

    it('a lookup that fails on the LAST attempt does not turn an answered DM into a failed job either', async () => {
        const { error, sends } = await runDm(textEvent(), { senderProfile: { graph: async () => { throw new Error('socket hang up'); } } }, { lastAttempt: true, object: 'instagram' });
        assert.equal(error, null);
        assert.equal(sends.length, 1);
    });

    it('a database without v40 (the claim cannot run) still answers the DM, and Meta is not asked about the sender', async () => {
        // No `senderProfile` scenario: the claim throws "no result arranged", which is what a missing column does.
        const { executed, lookups, sends, error } = await runDm(textEvent(), {}, IG);
        assert.equal(error, null);
        assert.equal(sends.length, 1);
        assert.equal(lookups.length, 0);
        assert.equal(ranMarkHandled(executed), true);
    });

    it('does not call Meta when the throttle says the sender was looked up recently', async () => {
        const { executed, lookups, sends } = await runDm(textEvent(), { senderProfile: { claim: false } }, IG);
        assert.ok(claimOf(executed), 'it asked');
        assert.equal(lookups.length, 0, 'and was told no');
        assert.equal(storeOf(executed), undefined);
        assert.equal(sends.length, 1);
    });

    it('is Instagram only: a Messenger thread has no lookup, no statement and no call', async () => {
        const { executed, lookups, sends } = await runDm(
            textEvent({ recipient: { id: 'fb-page-1' } }), { senderProfile: {} }, { lastAttempt: false, object: 'page' }, 'fb-page-1'
        );
        assert.equal(claimOf(executed), undefined);
        assert.equal(lookups.length, 0);
        assert.equal(sends.length, 1);
    });

    it('also looks up a sender whose AI is paused: the operator is the one who needs the name', async () => {
        const { lookups, sends } = await runDm(textEvent(), { conversation: { id: 'conv-1', is_bot_active: false, ai_disclosed_at: null }, senderProfile: {} }, IG);
        assert.equal(sends.length, 0, 'paused: nothing sent');
        assert.equal(lookups.length, 1);
    });

    it('does not look up a message it will not answer: a redelivery, or one another attempt holds', async () => {
        const { lookups, executed } = await runDm(textEvent(), { inboundInsert: [], resumeClaim: [], senderProfile: {} }, IG);
        assert.equal(lookups.length, 0);
        assert.equal(claimOf(executed), undefined);
    });

    it('runs alongside the reply and is awaited after it: a slow lookup does not hold the reply, and the job does not finish without it', async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const pending = runDm(
            textEvent(),
            {
                senderProfile: { graph: async () => { order.push('lookup:start'); await gate; order.push('lookup:end'); return { data: { name: 'Sam', username: 'sam_dev' } }; } },
                send: async () => { order.push('reply:sent'); release(); return { data: { message_id: 'sent-1' } }; },
            },
            IG
        );
        const { error } = await pending;
        assert.equal(error, null);
        // The lookup started, the reply went out WHILE it was still waiting, and only then did it finish: it never held the reply.
        assert.deepEqual(order, ['lookup:start', 'reply:sent', 'lookup:end']);
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

    it('records a transient failure as final on the last attempt, and hands the conversation over: the customer is told, never left in silence (S8)', async () => {
        // Found live 2026-10-14: Gemini failed all three attempts and the DM got no reply at all. The detail (the pause, the stamp, the
        // owner's alert, every other branch) is in src/services/dmSales/handoff.test.ts; this is the old path's own contract.
        const { executed, error, sends } = await runDm(
            textEvent(),
            {
                gemini: async () => { throw new Error('socket hang up'); },
                profile: FITNESS_EN, owner: 'creator-1',
                extraRoutes: [
                    [/SELECT EXISTS \(SELECT 1 FROM messages n/, { rows: [{ newer_unhandled: false, answered: false }] }],
                    [/UPDATE conversations\s+SET stage = 'handoff', handoff_at = NOW\(\)/, { rowCount: 1 }],
                ],
            },
            { lastAttempt: true }
        );

        assert.equal(error, null);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
        assert.equal(sends.length, 1, 'one message to the customer: the handoff line');
        assert.ok(executed.some((e) => /SET stage = 'handoff', handoff_at = NOW\(\)/.test(e.sql)), 'and the thread is stamped');
        assert.ok(!executed.some((e) => /is_bot_active\s*=\s*FALSE/i.test(e.sql)), 'but the bot is NOT paused: an outage is not a request for a person');
    });

    it('records a permanent Meta failure on the last attempt exactly as before: no handoff line to a recipient who cannot be written to (S8)', async () => {
        const { executed, error, sends } = await runDm(
            textEvent(),
            { send: async () => { throw Object.assign(new Error('blocked'), { response: { status: 400, data: { error: { code: 10903 } } } }); } },
            { lastAttempt: true }
        );

        assert.equal(error, null);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(sends.length, 1, 'only the reply that failed');
        assert.ok(!executed.some((e) => /stage = 'handoff'/.test(e.sql)));
    });
});


// ─── What Gemini is told the person said ────────────────────────────────────────────────

describe('dmPromptText', () => {
    it('describes a story mention instead of saying nothing', () => {
        // The bug: `claimInbound` stored '[Story Mention]' while `generateAiResponse` was
        // handed `dm.text || dm.payload`, which for a pure story mention is ''. src/services/
        // ai.ts decides whether the current message is already in the history it just read by
        // comparing the stored text against the string it was passed — so those two
        // disagreeing meant it ALWAYS appended a turn, and the turn it appended was empty.
        const dm = {
            senderId: 'u', text: '', payload: '', isStoryMention: true, wordless: describeWordless({ attachments: [{ type: 'story_mention' }] }), metaMessageId: 'mid-1',
        };

        assert.equal(dmPromptText(dm), STORY_MENTION_TEXT);
    });

    it("carries a quick reply's payload, which used to be stored as an empty bubble", () => {
        const dm = {
            senderId: 'u', text: '', payload: 'COURSES', isStoryMention: false, wordless: null, metaMessageId: 'mid-1',
        };

        assert.equal(dmPromptText(dm), 'COURSES');
    });

    it('prefers what the person actually typed', () => {
        const dm = {
            senderId: 'u', text: 'كم السعر؟', payload: 'PRICE', isStoryMention: true, wordless: null, metaMessageId: 'mid-1',
        };

        assert.equal(dmPromptText(dm), 'كم السعر؟');
    });

    it('is the placeholder of the kind for a message with no words: what is stored, and what a later model turn sees in the history', () => {
        const dm = normalizeDm({ sender: { id: 'u' }, message: { mid: 'm', attachments: [{ type: 'image', payload: { url: 'x' } }, { type: 'video', payload: { url: 'y' } }] } });
        assert.equal(dmPromptText(dm!), '[photo] [video]');
    });

    it('is never empty for anything normalizeDm agrees to return', () => {
        // The invariant that matters: normalizeDm returns null unless there is text, a payload
        // or a message with no words (a story mention, a photo, ...), and each of those produces a non-empty prompt here. So no
        // reachable DM can arrive anywhere as an empty part.
        const events = [
            { sender: { id: 'u' }, message: { mid: 'm', text: 'hi' } },
            { sender: { id: 'u' }, message: { mid: 'm', quick_reply: { payload: 'P' } } },
            { sender: { id: 'u' }, postback: { mid: 'm', title: 'T', payload: 'P' } },
            { sender: { id: 'u' }, message: { mid: 'm', attachments: [{ type: 'story_mention' }] } },
            // The messages with no words: every kind of the table, on Meta's shapes.
            { sender: { id: 'u' }, message: { mid: 'm', attachments: [{ type: 'image', payload: { url: 'https://cdn.example.test/i.jpg' } }] } },
            { sender: { id: 'u' }, message: { mid: 'm', attachments: [{ type: 'ephemeral' }] } },
            { sender: { id: 'u' }, message: { mid: 'm', attachments: [{ type: 'sticker', payload: { url: 'https://cdn.example.test/s.png', sticker_id: 369239263222822 } }] } },
            { sender: { id: 'u' }, message: { mid: 'm', attachments: [{ type: 'ig_reel', payload: { url: 'https://cdn.example.test/r' } }] } },
            { sender: { id: 'u' }, message: { mid: 'm', reply_to: { story: { url: 'https://cdn.example.test/st', id: '1' } } } },
            { sender: { id: 'u' }, message: { mid: 'm', is_unsupported: true } },
        ];

        for (const event of events) {
            const dm = normalizeDm(event);
            assert.ok(dm, `normalizeDm should accept ${JSON.stringify(event)}`);
            assert.notEqual(dmPromptText(dm!), '', JSON.stringify(event));
        }
    });
});

describe('handleMessagingEvent — what reaches Gemini', () => {
    // A quick reply with no words: the one shape left whose stored text is not what the person typed (the payload stands for it).
    const payloadOnlyEvent = {
        sender: { id: 'user-1' },
        recipient: { id: 'ig-page-1' },
        message: { mid: 'mid-payload', quick_reply: { payload: 'COURSES' } },
    };

    it('never sends an empty part for a message that is only a tapped payload', async () => {
        // With the row already in history — which it always is, because claimInbound writes it
        // before the AI call — the old code produced TWO consecutive `user` turns, the second
        // one empty. An empty part is at best a wasted turn and at worst a 400 from the API.
        const { geminiPayloads } = await runDm(payloadOnlyEvent, {
            history: [{ direction: 'inbound', text: 'COURSES' }],
        });

        assert.equal(geminiPayloads.length, 1);
        const parts = geminiPayloads[0].contents.flatMap((c: any) => c.parts);
        assert.deepEqual(parts.map((part: any) => part.text), ['COURSES']);
    });

    it('stores and sends the same string, so the history check can succeed', async () => {
        // The mechanism, asserted directly: the `text` column claimInbound writes and the
        // argument generateAiResponse receives are now the same value by construction.
        const { executed, geminiPayloads } = await runDm(payloadOnlyEvent, {
            history: [{ direction: 'inbound', text: 'COURSES' }],
        });

        const insert = executed.find((e) => /ON CONFLICT \(meta_message_id\)/.test(e.sql));
        assert.ok(insert, 'the inbound row must be written');
        const storedText = insert!.params[3];
        const sentTexts = geminiPayloads[0].contents
            .flatMap((c: any) => c.parts).map((part: any) => part.text);

        assert.equal(storedText, 'COURSES');
        assert.ok(sentTexts.includes(storedText));
    });

    it('never reaches Gemini for a story mention: it is a message with no words, and is answered with a fixed line', async () => {
        const { geminiCalls, sends, error } = await runDm({
            sender: { id: 'user-1' }, recipient: { id: 'ig-page-1' },
            message: { mid: 'mid-story', attachments: [{ type: 'story_mention' }] },
        });

        assert.equal(error, null);
        assert.equal(geminiCalls, 0);
        assert.equal(sends.length, 1, 'but the person is answered, not dropped');
    });

    it('answers an agent still set to a retired model, on the default model', async () => {
        // gemini-1.5-flash stayed on the supported list, and in the dashboard's picker, after
        // Google stopped serving it, so an agent saved with it sent every DM to a model that
        // answers 404. The row is not rewritten; the reply just goes to a model that exists.
        const { geminiUrls, sends, error } = await runDm(textEvent(), {
            agent: { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-1.5-flash', temperature: 0.7 },
        });

        assert.equal(error, null);
        assert.equal(sends.length, 1, 'the customer still gets a reply');
        assert.deepEqual(geminiUrls, [
            `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`,
        ]);
    });

    it('asks for the model the agent chose when it is a supported one', async () => {
        const { geminiUrls } = await runDm(textEvent(), {
            agent: { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-3.8-flash', temperature: 0.7 },
        });

        assert.equal(geminiUrls.length, 1);
        assert.match(geminiUrls[0]!, /\/models\/gemini-3\.8-flash:generateContent$/);
    });
});

/**
 * Which Gemini key a reply is sent with. One key serves every tenant: the one a platform admin
 * saved on the Operations screen, else GEMINI_API_KEY (src/services/appSettings.ts).
 */
describe('handleMessagingEvent — the Gemini key', () => {
    it('answers with the key saved on the Operations screen, over GEMINI_API_KEY', async () => {
        const { geminiKeys, sends, error } = await runDm(textEvent(), { savedGeminiKey: 'AIza-saved-from-operations' });

        assert.equal(error, null);
        assert.equal(sends.length, 1);
        assert.deepEqual(geminiKeys, ['AIza-saved-from-operations']);
    });

    it('answers with GEMINI_API_KEY while nothing is saved', async () => {
        const { geminiKeys } = await runDm(textEvent());
        assert.deepEqual(geminiKeys, ['test-key']);
    });

    it('sends nothing, and says where to add a key, when there is none anywhere', async () => {
        const { geminiCalls, sends, executed } = await runDm(textEvent(), { envGeminiKey: null });

        assert.equal(geminiCalls, 0);
        assert.equal(sends.length, 0, 'no reply is invented without a model behind it');
        assert.ok(!executed.some((e) => /'outbound'/.test(e.sql)), 'and no outbound turn is recorded');
        assert.match(MISSING_GEMINI_KEY, /Operations screen/);
        assert.match(MISSING_GEMINI_KEY, /GEMINI_API_KEY/);
    });

    it('needs no key at all for an agent that is switched off', async () => {
        // The lookup comes after the decision to speak: a disabled agent must stay silent the
        // same way with or without a key, and must not cost a read of app_settings.
        const { executed, geminiCalls, error } = await runDm(textEvent(), {
            envGeminiKey: null,
            agent: { is_active: false, system_prompt: 'p', knowledge_base: 'k', model: DEFAULT_MODEL, temperature: 0.7 },
        });

        assert.equal(error, null);
        assert.equal(geminiCalls, 0);
        assert.ok(!executed.some((e) => /FROM app_settings/.test(e.sql)));
    });
});

/**
 * DM plan S3: which engine writes the reply, and what the pipeline does with each outcome. The engine itself is tested in
 * `services/dmEngine.test.ts`; this is the pipeline's side of it: what is sent, what is recorded, and whether the message is
 * retried. The layer is a stand-in (`setAiCaller`); Gemini is `axios.post`, as everywhere in this file.
 */
describe('handleMessagingEvent — the reply engine (S3)', () => {
    const agentOn = (engine: 'gemini' | 'providers', geminiFallback = true) => ({
        is_active: true, system_prompt: 'p', knowledge_base: 'k', model: DEFAULT_MODEL, temperature: 0.7, engine, gemini_fallback: geminiFallback,
    });

    let layerCalls: AiGenerateArgs[];
    let layer: (args: AiGenerateArgs) => Promise<AiGenerateResult>;
    let logged: { level: string; event: string; [key: string]: unknown }[];
    let undo: (() => void)[];

    const layerSaying = (reply: Record<string, unknown>) => async (): Promise<AiGenerateResult> => ({
        json: reply, usage: { in: 900, out: 60 }, billed: [], model: 'claude-test', provider: 'anthropic', stopReason: 'end_turn',
        elapsed_ms: 800, usd: 0.003, priced: true, costSource: 'table', effort: 'low', route: 'saved', usageId: '1',
    });
    const layerFailing = (kind: AiError['kind']) => async (): Promise<AiGenerateResult> => {
        throw new AiError({ kind, provider: 'anthropic', model: 'claude-test', message: `a ${kind} failure` });
    };

    beforeEach(() => {
        layerCalls = [];
        logged = [];
        layer = layerSaying({ message_type: 'text', text: 'رد من المزوّد' });
        const previousSink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
        const previousCaller = setAiCaller((args) => { layerCalls.push(args); return layer(args); });
        undo = [() => setLogSink(previousSink), () => { setAiCaller(previousCaller); }];
    });
    afterEach(() => { for (const f of undo) f(); });

    const outboundRows = (executed: Executed[]) => executed.filter((e) => /INSERT INTO messages/.test(e.sql) && /'outbound'/.test(e.sql));
    /** What a failed engine now writes (S8): the stamp, and nothing that turns the bot off. Its two statements, arranged for the harness. */
    const HANDOVER_ROUTES: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/SELECT EXISTS \(SELECT 1 FROM messages n/, { rows: [{ newer_unhandled: false, answered: false }] }],
        [/UPDATE conversations\s+SET stage = 'handoff', handoff_at = NOW\(\)/, { rowCount: 1 }],
    ];
    const stampsOf = (executed: Executed[]) => executed.filter((e) => /SET stage = 'handoff', handoff_at = NOW\(\)/.test(e.sql));
    const botTurnedOff = (executed: Executed[]) => executed.some((e) => /is_bot_active\s*=\s*FALSE/i.test(e.sql));

    it('the gemini engine is today\'s pipeline: Gemini answers, the layer is never asked', async () => {
        const { sends, geminiCalls, error, executed } = await runDm(textEvent(), { agent: agentOn('gemini') });

        assert.equal(error, null);
        assert.equal(geminiCalls, 1);
        assert.equal(layerCalls.length, 0);
        assert.equal(sends.length, 1);
        assert.equal(sends[0]!.body.message.text.endsWith('أهلاً بك'), true);
        assert.equal(ranMarkHandled(executed), true);
    });

    it('a row with no engine columns (v37 not applied yet) is the gemini engine', async () => {
        const { sends, geminiCalls, error } = await runDm(textEvent(), {
            agent: { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: DEFAULT_MODEL, temperature: 0.7 },
        });
        assert.equal(error, null);
        assert.equal(geminiCalls, 1);
        assert.equal(layerCalls.length, 0);
        assert.equal(sends.length, 1);
    });

    it('the providers engine answers through the layer: one send with its words, one outbound row, Gemini never asked', async () => {
        const { sends, geminiCalls, error, executed } = await runDm(textEvent(), { agent: agentOn('providers') });

        assert.equal(error, null);
        assert.equal(layerCalls.length, 1);
        assert.equal(layerCalls[0]!.purpose, 'dm');
        assert.equal(geminiCalls, 0);
        assert.equal(sends.length, 1);
        assert.ok(String(sends[0]!.body.message.text).endsWith('رد من المزوّد'));
        assert.equal(outboundRows(executed).length, 1);
        assert.equal(ranMarkHandled(executed), true);
    });

    it('the providers engine failing with the fallback on is answered by Gemini: still exactly one reply', async () => {
        layer = layerFailing('timeout');
        const { sends, geminiCalls, error, executed } = await runDm(textEvent(), { agent: agentOn('providers', true) });

        assert.equal(error, null);
        assert.equal(layerCalls.length, 1);
        assert.equal(geminiCalls, 1);
        assert.equal(sends.length, 1, 'never two replies');
        assert.ok(String(sends[0]!.body.message.text).endsWith('أهلاً بك'), 'Gemini\'s words');
        assert.equal(outboundRows(executed).length, 1);
        assert.equal(ranMarkHandled(executed), true);
    });

    it('with the fallback off, the customer is handed over once (the handoff line, the conversation stamped, the bot left ON); the message is closed, not retried; the log says why (S8)', async () => {
        // This was silence (S3 left it for S8's handoff to pick up): the model could not answer and nothing was said to the customer.
        layer = layerFailing('no_provider');
        const { sends, geminiCalls, error, executed } = await runDm(textEvent(), { agent: agentOn('providers', false), extraRoutes: HANDOVER_ROUTES }, { lastAttempt: false });

        assert.equal(error, null, 'not re-raised: a retry would only spend the same budget again');
        assert.equal(sends.length, 1, 'one message: the handoff line, never a model\'s words and never a second');
        assert.match(String(sends[0]!.body.message.text), /^🤖 رد آلي من المساعد الذكي\n./s, 'with the automated-service disclosure, as the first reply');
        assert.equal(geminiCalls, 0);
        assert.equal(outboundRows(executed).length, 1, 'the line is the bot\'s own row on the thread');
        assert.ok(String(sends[0]!.body.message.text).endsWith(String(outboundRows(executed)[0]!.params[2])), 'and it is the line that was sent');
        assert.equal(stampsOf(executed).length, 1, 'stamped as handed over, for the inbox\'s "Needs you"');
        assert.deepEqual(stampsOf(executed)[0]!.params, ['conv-1', 'creator-1', 'unsure']);
        assert.equal(botTurnedOff(executed), false, 'an outage is not a request for a person: the next message gets a normal reply');
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
        const failed = logged.filter((l) => l.event === 'dm.engine_failed');
        assert.equal(failed.length, 1);
        assert.equal(failed[0]!.reason, 'no_provider');
        assert.equal(failed[0]!.fallback, 'off');
        assert.equal(logged.filter((l) => l.event === 'dm.failure_handoff').length, 1);
        assert.equal(logged.filter((l) => l.event === 'dm.pipeline_failed').length, 0, 'a decision, not a crash');
        assert.equal(logged.filter((l) => l.event === 'ai.replied').length, 0, 'nothing replied');
    });

    it('both engines failing is handed over once too: no model words, no second try (S8)', async () => {
        layer = layerFailing('server');
        const { sends, geminiCalls, error, executed } = await runDm(textEvent(), {
            agent: agentOn('providers', true),
            gemini: async () => { throw new Error('socket hang up'); },
            extraRoutes: HANDOVER_ROUTES,
        }, { lastAttempt: false });

        assert.equal(error, null);
        assert.equal(layerCalls.length, 1);
        assert.equal(geminiCalls, 1);
        assert.equal(sends.length, 1, 'the handoff line, once');
        assert.equal(stampsOf(executed).length, 1);
        assert.equal(botTurnedOff(executed), false);
        assert.equal(ranMarkHandled(executed), true);
        const [failed] = logged.filter((l) => l.event === 'dm.engine_failed');
        assert.equal(failed?.reason, 'server');
        assert.equal(failed?.fallback, 'failed');
    });

    it('a handoff line that cannot be sent in that path is logged and let go: the message is still closed, and nothing loops (S8)', async () => {
        layer = layerFailing('timeout');
        const { sends, error, executed } = await runDm(textEvent(), {
            agent: agentOn('providers', false), extraRoutes: HANDOVER_ROUTES,
            send: async () => { throw Object.assign(new Error('boom'), { response: { status: 500, data: {} } }); },
        }, { lastAttempt: false });

        assert.equal(error, null);
        assert.equal(new Set(sends.map((s) => s.body.message.text)).size, 1, 'one message, tried once by this code');
        assert.equal(logged.filter((l) => l.event === 'dm.failure_handoff_send_failed').length, 1);
        assert.equal(outboundRows(executed).length, 0, 'no line is recorded that the customer never got');
        assert.equal(ranMarkHandled(executed), true);
    });

    it('a switched-off agent is silent whatever the engine, and does not count as a failure', async () => {
        const { sends, geminiCalls, executed } = await runDm(textEvent(), { agent: { ...agentOn('providers'), is_active: false } });
        assert.equal(sends.length, 0);
        assert.equal(layerCalls.length, 0);
        assert.equal(geminiCalls, 0);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(logged.filter((l) => l.event === 'dm.engine_failed').length, 0);
    });

    it('still discloses the automation on the first reply, whichever engine wrote it', async () => {
        const { sends } = await runDm(textEvent(), { agent: agentOn('providers') });
        assert.match(sends[0]!.body.message.text, /^🤖 رد آلي من المساعد الذكي\n/);
        assert.match(sends[0]!.body.message.text, /رد من المزوّد$/);
    });
});

// ─── The sales mode switch (S6) ─────────────────────────────────────────────────────────────

/**
 * `ai_agents.sales_mode` decides which brain answers a DM (docs/DM_SALES_PLAN.md S6):
 *
 *   off   exactly the pipeline as it was: the same calls, in the same order, down to the statements. The default, and the owner's today.
 *   test  the sales turn for the senders in `sales_test_senders` only; everyone else is answered the old way.
 *   on    the sales turn for everyone.
 *
 * "The same calls in the same order" is a list written out below, captured from the pipeline before the switch existed (`origin/main` at
 * `2ef25cc`, the same scenario run through both, the difference being the one statement that reads the mode). A change to the old path
 * shows up here as a different list, never as a test that still passes.
 */
describe('handleMessagingEvent — the sales mode switch (S6)', () => {
    const agentIn = (mode: 'off' | 'test' | 'on', senders: string[] = []) => ({
        is_active: true, system_prompt: 'p', knowledge_base: 'k', model: DEFAULT_MODEL, temperature: 0.7, engine: 'gemini', gemini_fallback: true,
        sales_mode: mode, sales_test_senders: senders,
    });

    /**
     * What the pipeline did for a first message on the old path, in order. `READ MODE` is the one statement the switch added (see below).
     * `CLAIM PROFILE` is the one the inbox's detail view added (v40): an Instagram thread claims its sender's profile lookup, which is at
     * most one Graph call a day and never changes what happens to the DM (`describe('… the sender's profile (v40)')`). It is not the
     * switch's: it is in every list of this block, the old path's and the sales turn's alike.
     */
    const TODAYS_CALLS = [
        'SQL SELECT id, instagram_page_id, facebook_',
        'SQL INSERT INTO conversations (creator_id,',
        'SQL INSERT INTO messages (conversation_id,',
        'SQL UPDATE conversations SET profile_checked',   // CLAIM PROFILE (v40): not arranged here, so it throws, and is logged
        'SQL SELECT sales_mode, sales_test_senders F',   // READ MODE: the only difference from the pipeline before S6
        'SQL SELECT profile, version, activated_at F',
        'SQL SELECT id FROM creators ORDER BY create',
        'SQL SELECT engine, gemini_fallback FROM ai_',
        'SQL SELECT is_active, system_prompt, knowled',
        'SQL SELECT value, is_secret FROM app_settin',
        'SQL SELECT direction, text FROM messages WH',
        'GEMINI',
        'SQL INSERT INTO rate_limit_counters (creato',
        'SQL INSERT INTO app_rate_limit_counters (bu',
        'META message',
        'SQL UPDATE conversations SET ai_disclosed_a',
        'SQL INSERT INTO messages (conversation_id,',
        'SQL UPDATE messages SET handled_at = NOW(),',
    ];

    /**
     * `timeline` is the calls as the harness saw them (a statement's first 40 characters), and `TODAYS_CALLS` their beginnings: the same
     * number of calls, each starting as the old pipeline's did. A statement or a send added, dropped or moved fails here, naming both lists.
     */
    const sameCalls = (actual: string[], expected: string[], what = 'the calls'): void => {
        const matches = actual.length === expected.length && actual.every((call, i) => call.startsWith(expected[i]!));
        assert.ok(matches, `${what} differ from today's.\nexpected:\n  ${expected.join('\n  ')}\nactual:\n  ${actual.join('\n  ')}`);
    };

    /** The sales turn's own statements, for a scenario that reaches it. */
    const SALES_ROUTES: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/UPDATE conversations\s+SET last_inbound_at/, { rows: [{ stage: 'new', qualifier_turns: 0, abuse_strikes: 0, offer_id: null, offers_linked: [], last_link_at: null, opted_out_at: null, ai_replies_last_hour: 0 }] }],
        [/SELECT EXISTS \(SELECT 1 FROM messages n/, { rows: [{ newer_unhandled: false, answered: false }] }],
        [/UPDATE conversations SET stage/, { rowCount: 1 }],
        // The comment → DM lookup (S10): arranged as "nobody replied to this sender and the conversation has no source", so a scenario that is
        // not about the bridge does not walk its failure path. A scenario about it puts its own row first.
        [/LEFT JOIN LATERAL/, { rows: [{ current_source: null, interaction_id: null, recent_campaign: null, recipient_id: null, replied_at: null, recent_keywords: null, recent_template: null, current_keywords: null, current_template: null }] }],
    ];

    let layerCalls: AiGenerateArgs[];
    let undo: () => void;
    beforeEach(() => {
        layerCalls = [];
        const previousCaller = setAiCaller(async (args) => {
            layerCalls.push(args);
            return {
                json: { intent: 'info', stage: 'new', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text: 'رد المبيعات', quick_replies: [] },
                usage: { in: 900, out: 60 }, billed: [], model: 'claude-test', provider: 'anthropic', stopReason: 'end_turn', elapsed_ms: 800, usd: 0.003,
                priced: true, costSource: 'table', effort: 'low', route: 'saved', usageId: '1',
            } as AiGenerateResult;
        });
        undo = () => { setAiCaller(previousCaller); };
    });
    afterEach(() => undo());

    it('off: the same calls in the same order as the pipeline before the switch existed, and no sender action, no layer call, no sales statement', async () => {
        const { timeline, sends, geminiCalls, error, executed } = await runDm(textEvent(), { agent: agentIn('off') });

        assert.equal(error, null);
        sameCalls(timeline, TODAYS_CALLS);
        assert.equal(geminiCalls, 1);
        assert.equal(layerCalls.length, 0);
        assert.equal(sends.length, 1, 'one message, and no typing indicator');
        assert.ok(!sends.some((s) => s.body.sender_action));
        assert.ok(!executed.some((e) => /last_inbound_at|stage = \$3|ai_meta/.test(e.sql)), 'none of the sales statements');
    });

    it('a row from before v39 (no sales columns) is off: the same calls again', async () => {
        const { timeline, layerCalls: _ignored, error } = await runDm(textEvent(), {
            agent: { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: DEFAULT_MODEL, temperature: 0.7 },
        }).then((r) => ({ ...r, layerCalls: [] }));
        assert.equal(error, null);
        sameCalls(timeline, TODAYS_CALLS);
    });

    it('a database that cannot answer the mode is off as well: the DM is answered the old way, never by the experiment', async () => {
        const { timeline, sends, error } = await runDm(textEvent(), {
            agent: agentIn('on'),
            extraRoutes: [[/SELECT sales_mode, sales_test_senders FROM ai_agents/, { rows: [] }]],
        });
        assert.equal(error, null);
        assert.equal(layerCalls.length, 0);
        assert.equal(sends.length, 1);
        assert.deepEqual(timeline.filter((c) => c === 'GEMINI'), ['GEMINI'], 'Gemini answered');
    });

    it('test with a sender who is NOT on the list takes today\'s path: the very same calls as off', async () => {
        const { timeline, sends, geminiCalls, error } = await runDm(textEvent(), { agent: agentIn('test', ['999999', '888888']) });

        assert.equal(error, null);
        sameCalls(timeline, TODAYS_CALLS, 'the calls for a sender who is not a test sender');
        assert.equal(geminiCalls, 1);
        assert.equal(layerCalls.length, 0, 'the sales turn was not reached');
        assert.ok(!sends.some((s) => s.body.sender_action));
    });

    it('test with an empty list answers nobody with the sales turn', async () => {
        const { timeline } = await runDm(textEvent(), { agent: agentIn('test', []) });
        sameCalls(timeline, TODAYS_CALLS);
        assert.equal(layerCalls.length, 0);
    });

    it('test with a listed sender is the sales turn: the layer answers, Gemini is never asked, and the person is told it was read', async () => {
        const { timeline, sends, geminiCalls, error, executed } = await runDm(
            textEvent({ sender: { id: '17841400000000001' } }),
            { agent: agentIn('test', ['17841400000000001']), extraRoutes: SALES_ROUTES }
        );

        assert.equal(error, null);
        assert.equal(layerCalls.length, 1);
        assert.equal(layerCalls[0]!.purpose, 'dm');
        assert.equal(geminiCalls, 0);
        assert.deepEqual(sends.map((s) => s.body.sender_action ?? 'message'), ['mark_seen', 'typing_on', 'message']);
        assert.ok(String(sends[2]!.body.message.text).endsWith('رد المبيعات'));
        assert.ok(executed.some((e) => /UPDATE conversations SET stage/.test(e.sql)), 'the turn was recorded');
        assert.ok(timeline.indexOf('META message') < timeline.findIndex((c) => /UPDATE messages SET handled_at/.test(c)), 'handled last');
    });

    it('on answers everyone with the sales turn', async () => {
        const { sends, geminiCalls, error } = await runDm(textEvent(), { agent: agentIn('on'), extraRoutes: SALES_ROUTES });
        assert.equal(error, null);
        assert.equal(layerCalls.length, 1);
        assert.equal(geminiCalls, 0);
        assert.equal(sends.length, 3);
    });

    it('the pause check still comes first: a paused conversation is not answered by either brain', async () => {
        const { timeline, sends } = await runDm(textEvent(), {
            agent: agentIn('on'), extraRoutes: SALES_ROUTES, conversation: { id: 'conv-1', is_bot_active: false, ai_disclosed_at: null },
        });
        assert.equal(sends.length, 0);
        assert.equal(layerCalls.length, 0);
        assert.ok(!timeline.some((c) => /sales_mode/.test(c)), 'the mode is not even read for a paused thread');
    });

    it('a transient send failure in the sales turn is retried like the old path\'s: the claim is released and the error re-raised', async () => {
        const { error, executed } = await runDm(textEvent(), {
            agent: agentIn('on'), extraRoutes: SALES_ROUTES,
            send: async (_url, body) => {
                if (body.sender_action) return { data: {} };
                throw Object.assign(new Error('boom'), { response: { status: 500, data: {} } });
            },
        }, { lastAttempt: false });
        assert.ok(error, 'raised for the job runner');
        assert.equal(ranRelease(executed), true);
        assert.equal(ranMarkHandled(executed), false);
        assert.ok(!executed.some((e) => /UPDATE conversations SET stage/.test(e.sql)), 'nothing recorded for a reply that did not go');
    });

    /**
     * A DM that follows a comment (docs/DM_SALES_PLAN.md S10, `dmSales/bridge.ts`): the person commented a keyword, was sent the link in a private
     * reply, and has written back. In the sales turn the conversation starts at `recommend` with the campaign's offer among its facts, and the
     * campaign is stored on the conversation. Everywhere else (`off`, a `test` sender who is not listed, a paused thread) not one statement
     * about it runs: the lookup lives inside the sales turn precisely so that today's calls stay today's calls.
     */
    describe('a DM that follows a comment (S10)', () => {
        const SENDER = '17841400000000001';
        const profile = withSales(FITNESS_EN, 'en');
        /** A private reply sent an hour ago to this sender, by a campaign whose text holds the plan's address. */
        const REPLIED: Record<string, unknown> = {
            current_source: null, interaction_id: 'int-1', recent_campaign: 'camp-1', recipient_id: SENDER, replied_at: new Date(Date.now() - 60 * 60 * 1000),
            recent_keywords: 'plan, خطة', recent_template: 'Here is the plan: https://samifit.example/plan', current_keywords: null, current_template: null,
        };
        const withSource: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
            [/LEFT JOIN LATERAL/, { rows: [REPLIED] }],
            [/UPDATE conversations SET source_campaign_id/, { rowCount: 1 }],
            ...SALES_ROUTES,
        ];
        /** The facts the model was given: the opening of its last turn. */
        const factsOf = (): string => (layerCalls[0]!.user as { text: string }[]).at(-1)!.text;
        const touchesSource = (executed: Array<{ sql: string }>) => executed.some((e) => /\binteractions\b|source_campaign_id/.test(e.sql));

        it('on: a conversation with a source campaign starts at recommend, with that campaign\'s offer in the facts, and the source is stored', async () => {
            const { error, executed, sends, geminiCalls } = await runDm(textEvent({ sender: { id: SENDER } }), { agent: agentIn('on'), profile, extraRoutes: withSource });

            assert.equal(error, null);
            assert.equal(geminiCalls, 0);
            assert.equal(layerCalls.length, 1);
            assert.match(factsOf(), /Stage so far: recommend/);
            assert.match(factsOf(), /They commented «plan» and were sent the link to Twelve-week plan\./);
            const lookup = executed.find((e) => /LEFT JOIN LATERAL/.test(e.sql))!;
            assert.deepEqual(lookup.params, ['conv-1', 'creator-1', SENDER, 'instagram'], 'the sender of THIS DM, in this tenant, on this network');
            const write = executed.find((e) => /UPDATE conversations SET source_campaign_id/.test(e.sql));
            assert.ok(write, 'the campaign is stored on the conversation');
            assert.deepEqual(write!.params, ['conv-1', 'camp-1', 'creator-1']);
            assert.equal(sends.filter((s) => s.body.message).length, 1, 'and the person is answered once');
        });

        it('on, with no source: the very same conversation starts at new, as before', async () => {
            const { error } = await runDm(textEvent({ sender: { id: SENDER } }), { agent: agentIn('on'), profile, extraRoutes: SALES_ROUTES });
            assert.equal(error, null);
            assert.match(factsOf(), /Stage so far: new/);
            assert.doesNotMatch(factsOf(), /They commented/);
        });

        it('test: a listed sender gets the bridge', async () => {
            const { error, executed } = await runDm(textEvent({ sender: { id: SENDER } }), { agent: agentIn('test', [SENDER]), profile, extraRoutes: withSource });
            assert.equal(error, null);
            assert.match(factsOf(), /Stage so far: recommend/);
            assert.ok(executed.some((e) => /UPDATE conversations SET source_campaign_id/.test(e.sql)));
        });

        it('test: a sender who is NOT listed is today\'s path, with the very same calls, and nothing about a comment is read or written', async () => {
            const { timeline, executed, geminiCalls, error } = await runDm(textEvent(), { agent: agentIn('test', ['999999']), extraRoutes: withSource });
            assert.equal(error, null);
            sameCalls(timeline, TODAYS_CALLS, 'the calls for a sender who is not a test sender, with a private reply waiting for him');
            assert.equal(touchesSource(executed), false);
            assert.equal(geminiCalls, 1);
            assert.equal(layerCalls.length, 0);
        });

        it('OFF IS UNCHANGED: with a private reply waiting for the sender, the calls are exactly today\'s, in the same order, and nothing about a comment is read or written', async () => {
            const { timeline, executed, geminiCalls, error, sends } = await runDm(textEvent({ sender: { id: SENDER } }), { agent: agentIn('off'), extraRoutes: withSource });
            assert.equal(error, null);
            sameCalls(timeline, TODAYS_CALLS);
            assert.equal(touchesSource(executed), false, 'no statement mentions interactions or source_campaign_id');
            assert.equal(geminiCalls, 1, 'Gemini answered');
            assert.equal(layerCalls.length, 0);
            assert.equal(sends.length, 1);
        });

        it('a paused thread is not looked up at all, in any mode', async () => {
            const { executed, sends } = await runDm(textEvent({ sender: { id: SENDER } }), {
                agent: agentIn('on'), profile, extraRoutes: withSource, conversation: { id: 'conv-1', is_bot_active: false, ai_disclosed_at: null },
            });
            assert.equal(sends.length, 0);
            assert.equal(touchesSource(executed), false);
        });

        it('a message with no words is acknowledged without the lookup, as without the sales mode', async () => {
            const photo = textEvent({ message: { mid: 'mid-photo', attachments: [{ type: 'image', payload: { url: 'https://cdn.example.test/i.jpg' } }] } });
            const { executed } = await runDm(photo, { agent: agentIn('on'), profile, extraRoutes: withSource });
            assert.equal(touchesSource(executed), false);
        });
    });
});

// ─── A message with no words ────────────────────────────────────────────────────────────────

/**
 * A photo, a video, a voice note, a file, a shared post, reel or story, a sticker, a reply to a story, a message Instagram could not show:
 * a customer who sent one used to be dropped (`normalizeDm` returned null), so it was never stored, never shown in the inbox, never
 * answered. Now it is stored as its kind and the bot sends ONE fixed line from the kit, never a model, in every `sales_mode`
 * (src/webhook/attachments.ts, src/webhook/attachmentAck.ts). What is asserted here is the pipeline's side: what is stored, what is sent,
 * what is claimed and taken back, and whether the message is retried. Meta's shapes are the documented ones (attachments.test.ts).
 */
describe('handleMessagingEvent — a message with no words', () => {
    const PHOTO = { type: 'image', payload: { url: 'https://cdn.example.test/i.jpg' } };
    const photoEvent = (over: Record<string, unknown> = {}) => textEvent({ message: { mid: 'mid-photo', attachments: [PHOTO] }, ...over });
    const LINE = KITS.gulf.attachments.media;
    const DISCLOSED = { id: 'conv-1', is_bot_active: true, ai_disclosed_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() };

    const inboundOf = (executed: Executed[]) => executed.find((e) => /ON CONFLICT \(meta_message_id\)/.test(e.sql))!;
    const claimOf = (executed: Executed[]) => executed.find((e) => /SELECT \$1, \$2, 'outbound'/.test(e.sql));
    const unclaimOf = (executed: Executed[]) => executed.find((e) => /DELETE FROM messages WHERE id = \$1/.test(e.sql));
    const ranQuota = (executed: Executed[]) => executed.some((e) => /INSERT INTO rate_limit_counters/.test(e.sql));
    const ranDisclosed = (executed: Executed[]) => executed.some((e) => /UPDATE conversations SET ai_disclosed_at/.test(e.sql));

    let layerCalls: AiGenerateArgs[];
    let logged: { level: string; event: string; [key: string]: unknown }[];
    let undo: (() => void)[];
    beforeEach(() => {
        layerCalls = [];
        logged = [];
        const previousSink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
        // The providers layer is armed with a stub that records every call: the claim is that it is never reached.
        const previousCaller = setAiCaller(async (args) => { layerCalls.push(args); throw new Error('a message with no words must never reach a model'); });
        undo = [() => setLogSink(previousSink), () => { setAiCaller(previousCaller); }];
    });
    afterEach(() => { for (const f of undo) f(); });

    it('stores a photo as a photo, with the link Meta sent, and never asks a model', async () => {
        const { executed, geminiCalls, error } = await runDm(photoEvent());

        assert.equal(error, null);
        const inbound = inboundOf(executed);
        assert.equal(inbound.params[2], 'image', 'message_type is the kind');
        assert.equal(inbound.params[3], '[photo]', 'text is the placeholder');
        assert.equal(inbound.params[4], null, 'no payload');
        assert.equal(inbound.params[6], 'mid-photo');
        assert.ok(String(inbound.params[5]).includes('https://cdn.example.test/i.jpg'), 'raw_payload is the whole Meta event, link included');
        assert.deepEqual(JSON.parse(String(inbound.params[5])), photoEvent(), 'and not reshaped');
        assert.equal(geminiCalls, 0);
        assert.equal(layerCalls.length, 0);
        assert.ok(!executed.some((e) => /FROM ai_agents[^]*sales_mode|sales_mode/.test(e.sql)), 'the sales mode is not even read');
    });

    it('answers it once, with the owner\'s line behind the disclosure: claimed first, sent, then the disclosure stamped and the message handled', async () => {
        const { executed, sends, timeline, error } = await runDm(photoEvent());

        assert.equal(error, null);
        const claim = claimOf(executed)!;
        assert.ok(claim, 'the ack\'s claim statement ran');
        assert.deepEqual(claim.params.slice(0, 4), ['conv-1', 'creator-1', ATTACHMENT_ACK_TYPE, LINE]);
        assert.equal(claim.params[2], 'attachment_ack');
        assert.deepEqual(JSON.parse(claim.params[4]), { text: LINE }, 'what the bot said, without the disclosure');
        assert.deepEqual(JSON.parse(claim.params[5]), { engine: 'rule', reply: 'attachment_ack', kind: 'image' });
        assert.equal(claim.params[6], 'msg-1', 'the inbound row it answers');
        assert.deepEqual(claim.params[7], [...WORDLESS_MESSAGE_TYPES]);

        assert.equal(sends.length, 1, 'exactly one Send API call, and no typing indicator');
        assert.match(sends[0]!.url, /\/me\/messages$/);
        assert.equal(sends[0]!.body.message.text, `${KITS.gulf.disclosure}\n${LINE}`);
        assert.equal(sends[0]!.body.recipient.id, 'user-1');

        assert.equal(ranDisclosed(executed), true, 'the thread has now been told');
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
        assert.equal(unclaimOf(executed), undefined, 'the claim stands');

        // Order: the claim comes before the send, and the disclosure and `handled_at` after it.
        const inserts = timeline.flatMap((call, i) => (call.startsWith('SQL INSERT INTO messages') ? [i] : []));
        assert.equal(inserts.length, 2, 'the inbound row, then the claim');
        const sentAt = timeline.indexOf('META message');
        assert.ok(inserts[1]! < sentAt, 'claimed before it is sent');
        assert.ok(sentAt < timeline.findIndex((c) => /UPDATE conversations SET ai_disclosed_a/.test(c)), 'disclosure recorded after the send');
        assert.ok(sentAt < timeline.findIndex((c) => /UPDATE messages SET handled_at/.test(c)), 'handled last');
    });

    it('claims in ONE statement that refuses on its own: a later message waiting, words still being answered, an ask within a day', async () => {
        const { executed } = await runDm(photoEvent());
        const sql = claimOf(executed)!.sql.replace(/\s+/g, ' ');

        assert.match(sql, /^INSERT INTO messages \(conversation_id, creator_id, direction, message_type, text, raw_payload, sender, ai_meta\) SELECT \$1, \$2, 'outbound', \$3::text, \$4::text, \$5::jsonb, 'ai', \$6::jsonb WHERE NOT EXISTS/);
        assert.equal((sql.match(/NOT EXISTS/g) || []).length, 3);
        assert.match(sql, /n\.direction = 'inbound' AND n\.id <> \$7 AND n\.created_at > \(SELECT created_at FROM messages WHERE id = \$7\)/);
        assert.match(sql, /w\.handled_at IS NULL AND w\.created_at > NOW\(\) - INTERVAL '15 minutes' AND COALESCE\(w\.message_type, 'text'\) <> ALL\(\$8::text\[\]\)/);
        assert.match(sql, /a\.direction = 'outbound' AND a\.message_type = \$3 AND a\.created_at > NOW\(\) - INTERVAL '24 hours'/);
        assert.match(sql, /RETURNING id$/);
    });

    it('answers in every sales mode with the same line: mode "on" does not reach the sales turn, and the providers layer is never called', async () => {
        const agent = { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: DEFAULT_MODEL, temperature: 0.7, engine: 'providers', gemini_fallback: true, sales_mode: 'on', sales_test_senders: [] };
        const { sends, geminiCalls, timeline, error } = await runDm(photoEvent(), { agent });

        assert.equal(error, null);
        assert.equal(layerCalls.length, 0, 'the layer stub was never called');
        assert.equal(geminiCalls, 0);
        assert.ok(!timeline.some((c) => /sales_mode|last_inbound_at/.test(c)), 'no sales statement ran');
        assert.deepEqual(sends.map((s) => s.body.sender_action ?? 'message'), ['message'], 'no mark_seen and no typing_on either');
        assert.ok(String(sends[0]!.body.message.text).endsWith(LINE));
    });

    it('answers a story mention with the mention line, as a story mention', async () => {
        const { executed, sends, geminiCalls } = await runDm(textEvent({ message: { mid: 'mid-sm', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.example.test/m' } }] } }));

        assert.equal(inboundOf(executed).params[2], 'story_mention');
        assert.equal(inboundOf(executed).params[3], '[Story Mention]');
        assert.equal(claimOf(executed)!.params[3], KITS.gulf.attachments.mention);
        assert.deepEqual(JSON.parse(claimOf(executed)!.params[5]), { engine: 'rule', reply: 'attachment_ack', kind: 'story_mention' });
        assert.equal(geminiCalls, 0);
        assert.equal(sends.length, 1);
    });

    it('answers every other kind with the media line, whatever it is: a voice note, a reel, a story reply, an unsupported message', async () => {
        const messages: Array<[string, Record<string, unknown>]> = [
            ['audio', { mid: 'a', attachments: [{ type: 'audio', payload: { url: 'https://cdn.example.test/a.m4a' } }] }],
            ['reel', { mid: 'b', attachments: [{ type: 'ig_reel', payload: { url: 'https://cdn.example.test/r' } }] }],
            ['story_reply', { mid: 'c', reply_to: { story: { url: 'https://cdn.example.test/s', id: '1' } } }],
            ['attachment', { mid: 'd', is_unsupported: true }],
        ];
        for (const [kind, message] of messages) {
            const { executed, sends, geminiCalls, error } = await runDm(textEvent({ message }));
            assert.equal(error, null, kind);
            assert.equal(inboundOf(executed).params[2], kind, kind);
            assert.equal(claimOf(executed)!.params[3], LINE, kind);
            assert.equal(sends.length, 1, kind);
            assert.equal(geminiCalls, 0, kind);
        }
    });

    it('a sticker is stored and handled, and gets no answer: no claim, no quota, no send', async () => {
        const sticker = { mid: 'mid-st', attachments: [{ type: 'sticker', payload: { url: 'https://cdn.example.test/s.png', sticker_id: 369239263222822 } }] };
        const { executed, sends, geminiCalls, error } = await runDm(textEvent({ message: sticker }));

        assert.equal(error, null);
        assert.equal(inboundOf(executed).params[2], 'sticker');
        assert.equal(inboundOf(executed).params[3], '[sticker]');
        assert.equal(claimOf(executed), undefined);
        assert.equal(ranQuota(executed), false);
        assert.equal(sends.length, 0);
        assert.equal(geminiCalls, 0);
        assert.equal(ranMarkHandled(executed), true);
        assert.ok(logged.some((l) => l.event === 'dm.wordless_silent'));
    });

    it('a claim that finds no row sends nothing, spends no quota and handles the message: a later message, words being answered, or it already asked', async () => {
        const { executed, sends, error } = await runDm(photoEvent(), { ackClaim: [] });

        assert.equal(error, null);
        assert.ok(claimOf(executed), 'it tried');
        assert.equal(sends.length, 0);
        assert.equal(ranQuota(executed), false);
        assert.equal(unclaimOf(executed), undefined, 'there is no row to take back');
        assert.equal(ranDisclosed(executed), false);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
        assert.ok(logged.some((l) => l.event === 'dm.wordless_ack_skipped'));
    });

    it('a switched-off agent says nothing to a photo either: no claim, no send, handled', async () => {
        // `ai.disabled` is a debug line (an owner using the toggle is not a fault), which the log drops unless LOG_LEVEL asks for it.
        const previousLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = 'debug';
        try {
            const { executed, sends, error } = await runDm(photoEvent(), { agent: { is_active: false, system_prompt: 'p', knowledge_base: 'k', model: DEFAULT_MODEL, temperature: 0.7 } });

            assert.equal(error, null);
            assert.equal(claimOf(executed), undefined);
            assert.equal(sends.length, 0);
            assert.equal(ranMarkHandled(executed), true);
            assert.equal(logged.find((l) => l.event === 'ai.disabled')?.level, 'debug');
        } finally {
            if (previousLevel === undefined) delete process.env.LOG_LEVEL;
            else process.env.LOG_LEVEL = previousLevel;
        }
    });

    it('a tenant with no agent row says nothing either, and it is logged as the fault it is', async () => {
        const { executed, sends, error } = await runDm(photoEvent(), { agent: null });

        assert.equal(error, null);
        assert.equal(claimOf(executed), undefined);
        assert.equal(sends.length, 0);
        assert.equal(ranMarkHandled(executed), true);
        const unconfigured = logged.find((l) => l.event === 'ai.unconfigured');
        assert.equal(unconfigured?.level, 'warn');
    });

    it('a paused conversation is stored and handled, and not answered: the pause comes before anything', async () => {
        const { executed, sends, geminiCalls } = await runDm(photoEvent(), { conversation: { id: 'conv-1', is_bot_active: false, ai_disclosed_at: null } });

        assert.equal(inboundOf(executed).params[2], 'image', 'the operator still sees it');
        assert.equal(claimOf(executed), undefined);
        assert.equal(sends.length, 0);
        assert.equal(geminiCalls, 0);
        assert.equal(ranMarkHandled(executed), true);
    });

    it('a refused send quota takes the claim back, sends nothing and handles the message: an acknowledgement is not retried', async () => {
        const { executed, sends, error } = await runDm(photoEvent(), { creatorQuotaCount: 181 }, { lastAttempt: false });

        assert.equal(error, null, 'not re-raised, even mid-budget');
        assert.equal(sends.length, 0);
        assert.deepEqual(unclaimOf(executed)?.params, ['ack-1'], 'the claim row is deleted');
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
        const refused = logged.find((l) => l.event === 'dm.quota_exhausted');
        assert.equal(refused?.source, 'dm_ack');
        assert.equal(refused?.blocked_by, 'creator');
        assert.equal(refused?.count, 181);
        assert.equal(refused?.limit, 180);
        assert.equal(ranDisclosed(executed), false);

        const app = await runDm(photoEvent(), { appQuotaCount: 1_001 });
        assert.equal(app.error, null);
        assert.equal(app.sends.length, 0);
        assert.ok(unclaimOf(app.executed));
    });

    it('a transient send failure mid-budget takes the claim back, releases the message and re-raises for the runner', async () => {
        const { executed, sends, error } = await runDm(photoEvent(), {
            send: async () => { throw Object.assign(new Error('boom'), { response: { status: 500, data: {} } }); },
        }, { lastAttempt: false });

        assert.ok(error, 'raised for the job runner');
        assert.ok(sends.length >= 1, 'it did try');
        assert.deepEqual(unclaimOf(executed)?.params, ['ack-1'], 'nothing went out, so the claim is taken back and the retry can claim again');
        assert.equal(ranRelease(executed), true);
        assert.equal(ranMarkHandled(executed), false);
        assert.equal(ranDisclosed(executed), false, 'a failed first reply still discloses next time');
    });

    it('a transient failure on the LAST attempt is final: the claim is taken back, the message handled, nothing re-raised', async () => {
        const { executed, error } = await runDm(photoEvent(), {
            send: async () => { throw Object.assign(new Error('boom'), { response: { status: 500, data: {} } }); },
        }, { lastAttempt: true });

        assert.equal(error, null);
        assert.ok(unclaimOf(executed));
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
        // S8's handoff after a reply that failed for the last time is for a customer who asked something. A photo asked nothing: no pause,
        // no stamp, no second message, no alert.
        assert.ok(!executed.some((e) => /stage = 'handoff'|is_bot_active = FALSE/.test(e.sql)), 'nothing paused');
        assert.ok(!logged.some((l) => l.event === 'dm.failure_handoff'), 'not handed over');
    });

    it('a permanent Meta error is final: the claim is taken back and the message handled, the token flagged, nothing re-raised', async () => {
        const { executed, error } = await runDm(photoEvent(), {
            send: async () => { throw Object.assign(new Error('Invalid OAuth access token'), { response: { status: 400, data: { error: { code: 190, error_subcode: 463 } } } }); },
        }, { lastAttempt: false });

        assert.equal(error, null);
        assert.ok(unclaimOf(executed));
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
        assert.ok(executed.some((e) => /UPDATE creators/.test(e.sql)), 'the token death is written down as for any reply');
    });

    it('a message with no mid gets one attempt: a failed ack is final, however much budget is left', async () => {
        const { executed, error } = await runDm(textEvent({ message: { attachments: [PHOTO] } }), {
            send: async () => { throw Object.assign(new Error('boom'), { response: { status: 500, data: {} } }); },
        }, { lastAttempt: false });

        assert.equal(error, null);
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
    });

    it('an English tenant is answered in English, with the English disclosure', async () => {
        const { executed, sends, error } = await runDm(photoEvent(), { profile: FITNESS_EN });

        assert.equal(error, null);
        assert.equal(claimOf(executed)!.params[3], KITS.en.attachments.media);
        assert.equal(sends[0]!.body.message.text, `🤖 Automated reply from the AI assistant\n${KITS.en.attachments.media}`);
        assert.doesNotMatch(String(sends[0]!.body.message.text), /[؀-ۿ]/);
    });

    it('an Egyptian shop is answered in its own register', async () => {
        const { sends } = await runDm(photoEvent(), { profile: SHOP_EG });
        assert.ok(String(sends[0]!.body.message.text).endsWith(KITS.egyptian.attachments.media));
    });

    it('a thread that was told inside the week is not told again: the line alone, and the stamp left as it was', async () => {
        const { executed, sends } = await runDm(photoEvent(), { conversation: DISCLOSED });

        assert.equal(sends[0]!.body.message.text, LINE);
        assert.equal(ranDisclosed(executed), false);
    });

    it('a Messenger customer is answered through the Page: /{pageId}/messages', async () => {
        const post = { mid: 'mid-fb', attachments: [{ type: 'post', payload: { url: 'https://cdn.example.test/p', title: 'A post', id: '17887498072083520' } }] };
        const { executed, sends } = await runDm(textEvent({ recipient: { id: 'fb-page-1' }, message: post }), {}, { lastAttempt: false, object: 'page' }, 'fb-page-1');

        assert.equal(inboundOf(executed).params[2], 'share');
        assert.match(sends[0]!.url, /\/fb-page-1\/messages$/);
    });

    it('a redelivery of a message already handled is not answered again, and a resumed one is answered once', async () => {
        const again = await runDm(photoEvent(), { inboundInsert: [], resumeClaim: [] });
        assert.equal(claimOf(again.executed), undefined);
        assert.equal(again.sends.length, 0);

        const resumed = await runDm(photoEvent(), { inboundInsert: [], resumeClaim: [{ id: 'msg-1', reply_attempts: 2 }] });
        assert.equal(resumed.sends.length, 1);
        assert.equal(claimOf(resumed.executed)!.params[6], 'msg-1');
        assert.equal(ranMarkHandled(resumed.executed), true);
    });

    it('a photo WITH a caption is a text DM: answered by the model, stored as text', async () => {
        const { executed, geminiCalls, sends } = await runDm(textEvent({ message: { mid: 'mid-cap', text: 'كم سعره؟', attachments: [PHOTO] } }));

        assert.equal(inboundOf(executed).params[2], 'text');
        assert.equal(inboundOf(executed).params[3], 'كم سعره؟');
        assert.equal(claimOf(executed), undefined);
        assert.equal(geminiCalls, 1);
        assert.equal(sends.length, 1);
    });

    it('an unsend is not stored, not shown and not answered: no statement at all', async () => {
        const { executed, sends, geminiCalls } = await runDm(textEvent({ message: { mid: 'mid-del', is_deleted: true, attachments: [PHOTO] } }));

        assert.equal(executed.length, 0);
        assert.equal(sends.length, 0);
        assert.equal(geminiCalls, 0);
    });
});
