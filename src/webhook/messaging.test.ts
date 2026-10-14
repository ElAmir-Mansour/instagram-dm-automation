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
import { FITNESS_EN, SHOP_EG } from '../services/profile/fixtures.js';
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
): Promise<{ executed: Executed[]; sends: Sent[]; geminiCalls: number; geminiPayloads: any[]; geminiUrls: string[]; geminiKeys: string[]; error: any }> {
    const {
        creator = CREATOR,
        conversation = { id: 'conv-1', is_bot_active: true, ai_disclosed_at: null },
        inboundInsert = [{ id: 'msg-1' }],
        resumeClaim = [],
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
    } = scenario;

    const executed: Executed[] = [];
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
        [/INSERT INTO messages/, { rowCount: 1 }],   // the outbound row; no RETURNING
        [/INSERT INTO rate_limit_counters/, { rows: [{ count: creatorQuotaCount }] }],
        [/INSERT INTO app_rate_limit_counters/, { rows: [{ count: appQuotaCount }] }],
    ];
    // Read as the database hands it back: JSONB, its keys in Postgres's order.
    if (profile) routes.unshift([/FROM creator_profiles/, { rows: [{ profile: throughJsonb(profile), version: 3, activated_at: null }] }]);
    if (owner !== undefined) routes.unshift([/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/, { rows: owner === null ? [] : [{ id: owner }] }]);
    // The owner lookup is cached in the process for 30 s: one run's answer must not be the next one's.
    invalidateTenantCache();

    const originalQuery = pool.query;
    const originalAxiosPost = axios.post;
    const originalMetaPost = metaHttp.post;
    const originalKey = process.env.GEMINI_API_KEY;
    if (envGeminiKey === null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = envGeminiKey;

    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1];
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (axios as any).post = async (url: string, payload: any, config: any) => {
        geminiCalls++;
        geminiPayloads.push(payload);
        geminiUrls.push(url);
        geminiKeys.push(config?.headers?.['x-goog-api-key']);
        return gemini();
    };
    (metaHttp as any).post = async (url: string, body: any) => {
        sends.push({ url, body });
        return send(url, body);
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
        if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalKey;
        if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
        else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
        invalidateTenantCache();
    }

    return { executed, sends, geminiCalls, geminiPayloads, geminiUrls, geminiKeys, error };
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


// ─── What Gemini is told the person said ────────────────────────────────────────────────

describe('dmPromptText', () => {
    it('describes a story mention instead of saying nothing', () => {
        // The bug: `claimInbound` stored '[Story Mention]' while `generateAiResponse` was
        // handed `dm.text || dm.payload`, which for a pure story mention is ''. src/services/
        // ai.ts decides whether the current message is already in the history it just read by
        // comparing the stored text against the string it was passed — so those two
        // disagreeing meant it ALWAYS appended a turn, and the turn it appended was empty.
        const dm = {
            senderId: 'u', text: '', payload: '', isStoryMention: true, metaMessageId: 'mid-1',
        };

        assert.equal(dmPromptText(dm), STORY_MENTION_TEXT);
    });

    it("carries a quick reply's payload, which used to be stored as an empty bubble", () => {
        const dm = {
            senderId: 'u', text: '', payload: 'COURSES', isStoryMention: false, metaMessageId: 'mid-1',
        };

        assert.equal(dmPromptText(dm), 'COURSES');
    });

    it('prefers what the person actually typed', () => {
        const dm = {
            senderId: 'u', text: 'كم السعر؟', payload: 'PRICE', isStoryMention: true, metaMessageId: 'mid-1',
        };

        assert.equal(dmPromptText(dm), 'كم السعر؟');
    });

    it('is never empty for anything normalizeDm agrees to return', () => {
        // The invariant that matters: normalizeDm returns null unless there is text, a payload
        // or a story mention, and each of those three produces a non-empty prompt here. So no
        // reachable DM can arrive at Gemini as an empty part.
        const events = [
            { sender: { id: 'u' }, message: { mid: 'm', text: 'hi' } },
            { sender: { id: 'u' }, message: { mid: 'm', quick_reply: { payload: 'P' } } },
            { sender: { id: 'u' }, postback: { mid: 'm', title: 'T', payload: 'P' } },
            { sender: { id: 'u' }, message: { mid: 'm', attachments: [{ type: 'story_mention' }] } },
        ];

        for (const event of events) {
            const dm = normalizeDm(event);
            assert.ok(dm, `normalizeDm should accept ${JSON.stringify(event)}`);
            assert.notEqual(dmPromptText(dm!), '', JSON.stringify(event));
        }
    });
});

describe('handleMessagingEvent — what reaches Gemini', () => {
    const storyMentionEvent = {
        sender: { id: 'user-1' },
        recipient: { id: 'ig-page-1' },
        message: { mid: 'mid-story', attachments: [{ type: 'story_mention' }] },
    };

    it('never sends an empty part for a pure story mention', async () => {
        // With the row already in history — which it always is, because claimInbound writes it
        // before the AI call — the old code produced TWO consecutive `user` turns, the second
        // one empty. An empty part is at best a wasted turn and at worst a 400 from the API.
        const { geminiPayloads } = await runDm(storyMentionEvent, {
            history: [{ direction: 'inbound', text: STORY_MENTION_TEXT }],
        });

        assert.equal(geminiPayloads.length, 1);
        const parts = geminiPayloads[0].contents.flatMap((c: any) => c.parts);
        assert.deepEqual(parts.map((part: any) => part.text), [STORY_MENTION_TEXT]);
    });

    it('stores and sends the same string, so the history check can succeed', async () => {
        // The mechanism, asserted directly: the `text` column claimInbound writes and the
        // argument generateAiResponse receives are now the same value by construction.
        const { executed, geminiPayloads } = await runDm(storyMentionEvent, {
            history: [{ direction: 'inbound', text: STORY_MENTION_TEXT }],
        });

        const insert = executed.find((e) => /ON CONFLICT \(meta_message_id\)/.test(e.sql));
        assert.ok(insert, 'the inbound row must be written');
        const storedText = insert!.params[3];
        const sentTexts = geminiPayloads[0].contents
            .flatMap((c: any) => c.parts).map((part: any) => part.text);

        assert.equal(storedText, STORY_MENTION_TEXT);
        assert.ok(sentTexts.includes(storedText));
    });

    it('still answers a story mention rather than dropping it', async () => {
        // The fix must not turn a bug into a silence: a story mention is a person waiting.
        const { sends, error } = await runDm(storyMentionEvent, {
            history: [{ direction: 'inbound', text: STORY_MENTION_TEXT }],
        });

        assert.equal(error, null);
        assert.equal(sends.length, 1);
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

    it('with the fallback off, nothing is sent and nothing is written as a reply; the message is closed, not retried; the log says why', async () => {
        layer = layerFailing('no_provider');
        const { sends, geminiCalls, error, executed } = await runDm(textEvent(), { agent: agentOn('providers', false) }, { lastAttempt: false });

        assert.equal(error, null, 'not re-raised: a retry would only spend the same budget again');
        assert.equal(sends.length, 0);
        assert.equal(geminiCalls, 0);
        assert.equal(outboundRows(executed).length, 0, 'no outbound turn is invented');
        assert.equal(ranMarkHandled(executed), true);
        assert.equal(ranRelease(executed), false);
        const failed = logged.filter((l) => l.event === 'dm.engine_failed');
        assert.equal(failed.length, 1);
        assert.equal(failed[0]!.reason, 'no_provider');
        assert.equal(failed[0]!.fallback, 'off');
        assert.equal(logged.filter((l) => l.event === 'dm.pipeline_failed').length, 0, 'a decision, not a crash');
        assert.equal(logged.filter((l) => l.event === 'ai.replied').length, 0, 'nothing replied');
    });

    it('both engines failing sends no canned apology and no second try: the stub', async () => {
        layer = layerFailing('server');
        const { sends, geminiCalls, error, executed } = await runDm(textEvent(), {
            agent: agentOn('providers', true),
            gemini: async () => { throw new Error('socket hang up'); },
        }, { lastAttempt: false });

        assert.equal(error, null);
        assert.equal(layerCalls.length, 1);
        assert.equal(geminiCalls, 1);
        assert.equal(sends.length, 0);
        assert.equal(outboundRows(executed).length, 0);
        assert.equal(ranMarkHandled(executed), true);
        const [failed] = logged.filter((l) => l.event === 'dm.engine_failed');
        assert.equal(failed?.reason, 'server');
        assert.equal(failed?.fallback, 'failed');
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
