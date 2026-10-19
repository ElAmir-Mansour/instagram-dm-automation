/**
 * The WhatsApp Graph client, against a stubbed HTTP client.
 *
 * `metaHttp.get/post/delete` are replaced for the whole file with an implementation that THROWS on any call a test did not arrange: `.env`
 * holds live production credentials, and a test here that reached the network could message a real customer. What is pinned is what can be
 * proven without acting on the account, which is the same split `instagram.test.ts` makes: which URL each call goes to, what body and
 * headers it carries, and, for the one call that creates something (a send), that nothing which may have landed is ever sent twice.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { isPermanentMetaError, metaErrorCode, metaHttp } from './http.js';
import { API_VERSION, MetaApiError } from './instagram.js';
import {
    downloadMedia, getMediaUrl, getPhoneNumberHealth, inspectWhatsAppToken, isMetaMediaUrl, looksLikeTestNumber, mapPhoneNumberHealth,
    mapSendResult, markReadWithTyping, PHONE_NUMBER_EXTRA_FIELDS, PHONE_NUMBER_FIELDS, scrubToken, sendMessage, subscribeApp, unsubscribeApp,
} from './whatsapp.js';

const BASE = `https://graph.facebook.com/${API_VERSION}`;
const TOKEN = 'EAAGwhatsapp-system-user-token-0123456789';
const PHONE = '106540352242922';
const WABA = '102290129340398';

interface Recorded { method: 'get' | 'post' | 'delete'; url: string; body: unknown; config: any }

let calls: Recorded[] = [];
let onGet: (url: string, config: any) => Promise<any>;
let onPost: (url: string, body: any, config: any) => Promise<any>;
let onDelete: (url: string, config: any) => Promise<any>;

const original = { get: metaHttp.get, post: metaHttp.post, delete: metaHttp.delete };
let restoreSink: (() => void) | undefined;
let logged: string[] = [];

before(() => {
    const previous = setLogSink((_level, line) => { logged.push(line); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    calls = [];
    logged = [];
    onGet = async (url) => { throw new Error(`no GET was arranged for ${url}`); };
    onPost = async (url) => { throw new Error(`no POST was arranged for ${url}`); };
    onDelete = async (url) => { throw new Error(`no DELETE was arranged for ${url}`); };
    (metaHttp as any).get = (url: string, config: any) => { calls.push({ method: 'get', url, body: undefined, config }); return onGet(url, config); };
    (metaHttp as any).post = (url: string, body: any, config: any) => { calls.push({ method: 'post', url, body, config }); return onPost(url, body, config); };
    (metaHttp as any).delete = (url: string, config: any) => { calls.push({ method: 'delete', url, body: undefined, config }); return onDelete(url, config); };
});

afterEach(() => {
    (metaHttp as any).get = original.get;
    (metaHttp as any).post = original.post;
    (metaHttp as any).delete = original.delete;
});

const ok = (data: unknown) => async () => ({ data });

/** An axios-shaped Meta failure. Defaults to a 400 / code 100 so `withRetry` refuses to retry it and no test sits through a backoff. */
function metaError(code = 100, message = 'Bad thing', status = 400) {
    return Object.assign(new Error(message), { response: { status, data: { error: { code, message } } } });
}

describe('getPhoneNumberHealth', () => {
    const core = {
        id: PHONE, display_phone_number: '+1 555-025-3483', verified_name: 'Test Number', quality_rating: 'GREEN',
        code_verification_status: 'VERIFIED', name_status: 'APPROVED', throughput: { level: 'STANDARD' },
    };

    it('reads the confirmed fields with the token in the Authorization header, then the two extras in a request of their own', async () => {
        onGet = async (_url, config) => ({ data: config.params.fields === PHONE_NUMBER_FIELDS ? core : { status: 'CONNECTED', whatsapp_business_manager_messaging_limit: 'TIER_250' } });

        const health = await getPhoneNumberHealth(PHONE, TOKEN);

        assert.equal(calls.length, 2);
        assert.equal(calls[0]!.url, `${BASE}/${PHONE}`);
        assert.equal(calls[0]!.config.params.fields, 'display_phone_number,verified_name,quality_rating,code_verification_status,name_status,throughput');
        assert.equal(calls[1]!.config.params.fields, PHONE_NUMBER_EXTRA_FIELDS);
        for (const c of calls) {
            assert.equal(c.config.headers.Authorization, `Bearer ${TOKEN}`);
            assert.ok(!c.url.includes(TOKEN) && !JSON.stringify(c.config.params).includes(TOKEN), 'the token is never in a URL or a query');
        }
        assert.deepEqual(health, {
            displayPhoneNumber: '+1 555-025-3483', verifiedName: 'Test Number', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED',
            nameStatus: 'APPROVED', throughput: 'STANDARD', numberStatus: 'CONNECTED', messagingLimit: 'TIER_250', isTestNumber: true,
        });
    });

    it('still answers, with the two extras null, when Meta refuses them: one unserved field must not cost the whole read', async () => {
        onGet = async (_url, config) => {
            if (config.params.fields === PHONE_NUMBER_FIELDS) return { data: core };
            throw metaError(100, '(#100) Tried accessing nonexisting field (status)');
        };

        const health = await getPhoneNumberHealth(PHONE, TOKEN);

        assert.equal(health.qualityRating, 'GREEN');
        assert.equal(health.numberStatus, null);
        assert.equal(health.messagingLimit, null);
        assert.ok(logged.some((l) => l.includes('whatsapp.health_extras_unavailable')), 'a refused extra is logged, not silent');
    });

    it('throws a MetaApiError carrying the code when the core read fails, and never reads the extras', async () => {
        onGet = async () => { throw metaError(190, 'Invalid OAuth access token.'); };

        await assert.rejects(
            () => getPhoneNumberHealth(PHONE, TOKEN),
            (err: unknown) => err instanceof MetaApiError && err.metaCode === 190 && /Invalid OAuth access token/.test(err.message)
        );
        assert.equal(calls.length, 1);
    });

    it('refuses an id that is not numeric before any call: it goes into a URL path', async () => {
        await assert.rejects(() => getPhoneNumberHealth('../me/accounts', TOKEN), TypeError);
        await assert.rejects(() => getPhoneNumberHealth('', TOKEN), TypeError);
        assert.equal(calls.length, 0);
    });
});

describe('mapPhoneNumberHealth and looksLikeTestNumber', () => {
    it('maps a body that is not an object to all nulls', () => {
        for (const junk of [null, undefined, 'x', 42, []]) {
            const h = mapPhoneNumberHealth(junk, junk);
            assert.equal(h.displayPhoneNumber, null);
            assert.equal(h.qualityRating, null);
            assert.equal(h.isTestNumber, false);
        }
    });

    it('falls back to the older messaging_limit_tier when the new field is absent', () => {
        assert.equal(mapPhoneNumberHealth({}, { messaging_limit_tier: 'TIER_1K' }).messagingLimit, 'TIER_1K');
    });

    it('reads a +1 555 number as a test number and nothing else', () => {
        assert.equal(looksLikeTestNumber('+1 555-025-3483'), true);
        assert.equal(looksLikeTestNumber('+15550253483'), true);
        assert.equal(looksLikeTestNumber('+20 100 123 4567'), false);
        assert.equal(looksLikeTestNumber('+1 415-555-0100'), false);
        assert.equal(looksLikeTestNumber(null), false);
    });
});

describe('subscribeApp and unsubscribeApp', () => {
    it('POSTs to /{waba}/subscribed_apps with the token in the header', async () => {
        onPost = ok({ success: true });

        assert.equal(await subscribeApp(WABA, TOKEN), true);

        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'post');
        assert.equal(calls[0]!.url, `${BASE}/${WABA}/subscribed_apps`);
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
        assert.ok(!calls[0]!.url.includes(TOKEN));
    });

    it('DELETEs the same edge to unsubscribe', async () => {
        onDelete = ok({ success: true });

        assert.equal(await unsubscribeApp(WABA, TOKEN), true);

        assert.equal(calls[0]!.method, 'delete');
        assert.equal(calls[0]!.url, `${BASE}/${WABA}/subscribed_apps`);
    });

    it('reports a 200 that does not say success as false, not as success', async () => {
        onPost = ok({ success: false });
        assert.equal(await subscribeApp(WABA, TOKEN), false);
        onPost = ok({});
        assert.equal(await subscribeApp(WABA, TOKEN), false);
    });

    it('throws a MetaApiError with the code when Meta refuses', async () => {
        onPost = async () => { throw metaError(200, '(#200) Requires whatsapp_business_management permission'); };

        await assert.rejects(
            () => subscribeApp(WABA, TOKEN),
            (err: unknown) => err instanceof MetaApiError && err.metaCode === 200
        );
    });

    it('refuses a non-numeric waba id before any call', async () => {
        await assert.rejects(() => subscribeApp('12/../34', TOKEN), TypeError);
        await assert.rejects(() => unsubscribeApp('abc', TOKEN), TypeError);
        assert.equal(calls.length, 0);
    });
});

describe('sendMessage', () => {
    const payload = { recipient: 'EG.13491208655302741918', recipient_type: 'individual' as const, type: 'text', text: { body: 'أهلاً بك', preview_url: false } };

    it('POSTs to /{phone_number_id}/messages with messaging_product added and returns the wamid', async () => {
        onPost = ok({ messaging_product: 'whatsapp', contacts: [{ input: 'EG.1', wa_id: '201001234567', user_id: 'EG.13491208655302741918' }], messages: [{ id: 'wamid.HBgL123' }] });

        const result = await sendMessage(PHONE, TOKEN, payload);

        assert.deepEqual(result, { messageId: 'wamid.HBgL123', waId: '201001234567', userId: 'EG.13491208655302741918' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, `${BASE}/${PHONE}/messages`);
        assert.deepEqual(calls[0]!.body, { ...payload, messaging_product: 'whatsapp' });
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
    });

    it('does not let the payload override messaging_product', async () => {
        onPost = ok({ messages: [{ id: 'wamid.X' }] });
        await sendMessage(PHONE, TOKEN, { ...payload, messaging_product: 'instagram' });
        assert.equal((calls[0]!.body as any).messaging_product, 'whatsapp');
    });

    it('answers with messageId null, not a throw, when Meta says 200 without an id', async () => {
        onPost = ok({ messaging_product: 'whatsapp' });
        assert.equal((await sendMessage(PHONE, TOKEN, payload)).messageId, null);
    });

    it('refuses a message with no recipient, no type or a bad number id before any call', async () => {
        await assert.rejects(() => sendMessage(PHONE, TOKEN, { type: 'text', text: { body: 'x' } }), TypeError);
        await assert.rejects(() => sendMessage(PHONE, TOKEN, { recipient: 'EG.1' } as any), TypeError);
        await assert.rejects(() => sendMessage('not-an-id', TOKEN, payload), TypeError);
        assert.equal(calls.length, 0);
    });

    it('NEVER retries a send that may have landed: a 500, a timeout and a reset are each tried exactly once', async () => {
        for (const failure of [
            Object.assign(new Error('boom'), { response: { status: 500, data: {} } }),
            Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }),
            Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
            Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
        ]) {
            calls = [];
            onPost = async () => { throw failure; };
            await assert.rejects(() => sendMessage(PHONE, TOKEN, payload), MetaApiError);
            assert.equal(calls.length, 1, `${(failure as any).code ?? (failure as any).response.status} must not be retried: a duplicate message to a customer`);
        }
    });

    it('does retry what proves WhatsApp did nothing: a 429 it refused', async () => {
        let attempts = 0;
        onPost = async () => {
            attempts++;
            if (attempts === 1) throw Object.assign(new Error('Too many'), { response: { status: 429, data: {} } });
            return { data: { messages: [{ id: 'wamid.RETRIED' }] } };
        };

        assert.equal((await sendMessage(PHONE, TOKEN, payload)).messageId, 'wamid.RETRIED');
        assert.equal(attempts, 2);
    });

    it('surfaces WhatsApp codes on the error without retrying them, and adds none to the shared permanent set', async () => {
        for (const code of [131047, 131026, 131056, 130429]) {
            calls = [];
            onPost = async () => { throw metaError(code, `code ${code}`); };
            await assert.rejects(
                () => sendMessage(PHONE, TOKEN, payload),
                (err: unknown) => err instanceof MetaApiError && err.metaCode === code
            );
            assert.equal(calls.length, 1);
            // The shared policy is Instagram's too: a WhatsApp code must not change what is "permanent" there (a later task adds its own set).
            assert.equal(isPermanentMetaError(metaError(code)), false, `${code} is not in the shared PERMANENT_CODES`);
        }
        assert.equal(isPermanentMetaError(metaError(190)), true);
        assert.equal(isPermanentMetaError(metaError(200)), true);
        assert.equal(isPermanentMetaError(metaError(10903)), true);
        assert.equal(metaErrorCode(metaError(131047)), 131047);
    });

    it('keeps the message text out of the error and out of the log', async () => {
        onPost = async () => { throw metaError(131047, 'Re-engagement message'); };
        await assert.rejects(() => sendMessage(PHONE, TOKEN, payload), (err: Error) => !err.message.includes('أهلاً'));
        assert.ok(!logged.join('\n').includes('أهلاً'));
    });
});

describe('markReadWithTyping', () => {
    it('POSTs the read receipt with the typing indicator, as the contract has it', async () => {
        onPost = ok({ success: true });

        await markReadWithTyping(PHONE, TOKEN, 'wamid.INBOUND');

        assert.equal(calls[0]!.url, `${BASE}/${PHONE}/messages`);
        assert.deepEqual(calls[0]!.body, {
            messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.INBOUND', typing_indicator: { type: 'text' },
        });
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
    });

    it('is not retried, and throws so the caller can log and carry on', async () => {
        onPost = async () => { throw Object.assign(new Error('boom'), { response: { status: 500, data: {} } }); };
        await assert.rejects(() => markReadWithTyping(PHONE, TOKEN, 'wamid.INBOUND'), MetaApiError);
        assert.equal(calls.length, 1);
    });

    it('refuses a missing wamid before any call', async () => {
        await assert.rejects(() => markReadWithTyping(PHONE, TOKEN, ''), TypeError);
        assert.equal(calls.length, 0);
    });
});

describe('getMediaUrl', () => {
    it('GETs /{media_id}, scoped to the phone number when one is given, and maps the answer', async () => {
        onGet = ok({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'audio/ogg', sha256: 'abc', file_size: 4096, id: '1013859600285441' });

        const info = await getMediaUrl('1013859600285441', TOKEN, PHONE);

        assert.equal(calls[0]!.url, `${BASE}/1013859600285441`);
        assert.deepEqual(calls[0]!.config.params, { phone_number_id: PHONE });
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
        assert.deepEqual(info, { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mimeType: 'audio/ogg', sha256: 'abc', fileSize: 4096 });
    });

    it('sends no params without a phone number, and reads a string file_size', async () => {
        onGet = ok({ url: 'https://lookaside.fbsbx.com/x', file_size: '2048' });
        const info = await getMediaUrl('1013859600285441', TOKEN);
        assert.equal(calls[0]!.config.params, undefined);
        assert.equal(info.fileSize, 2048);
        assert.equal(info.mimeType, null);
    });

    it('throws when Meta answers without a url, and refuses a media id that could alter the path', async () => {
        onGet = ok({ mime_type: 'audio/ogg' });
        await assert.rejects(() => getMediaUrl('1013859600285441', TOKEN), MetaApiError);
        calls = [];
        await assert.rejects(() => getMediaUrl('1/../../me', TOKEN), TypeError);
        await assert.rejects(() => getMediaUrl('', TOKEN), TypeError);
        assert.equal(calls.length, 0);
    });
});

describe('downloadMedia and isMetaMediaUrl', () => {
    const URL_OK = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1013859600285441&ext=1&hash=x';

    it('only treats https URLs on Meta media hosts as downloadable', () => {
        for (const good of [URL_OK, 'https://scontent.xx.fbcdn.net/v/t1/a.jpg', 'https://mmg.whatsapp.net/d/f/a.enc', 'https://FBSBX.com/x']) {
            assert.equal(isMetaMediaUrl(good), true, good);
        }
        for (const bad of [
            'http://lookaside.fbsbx.com/x', 'https://evil.example/x', 'https://fbsbx.com.evil.example/x', 'https://notfbsbx.com/x',
            'https://user:pw@lookaside.fbsbx.com/x', 'ftp://lookaside.fbsbx.com/x', 'not a url', '',
        ]) {
            assert.equal(isMetaMediaUrl(bad), false, bad);
        }
    });

    it('sends the token as a bearer header only, asks for bytes with a size cap, and returns them with the content type', async () => {
        onGet = async () => ({ data: Buffer.from([1, 2, 3]), headers: { 'content-type': 'audio/ogg; codecs=opus' } });

        const media = await downloadMedia(URL_OK, TOKEN, { maxBytes: 1024 });

        assert.deepEqual([...media.data], [1, 2, 3]);
        assert.equal(media.contentType, 'audio/ogg; codecs=opus');
        assert.equal(calls[0]!.url, URL_OK);
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(calls[0]!.config.responseType, 'arraybuffer');
        assert.equal(calls[0]!.config.maxContentLength, 1024);
    });

    it('NEVER sends the token to a host that is not Meta’s', async () => {
        await assert.rejects(() => downloadMedia('https://evil.example/steal', TOKEN), TypeError);
        await assert.rejects(() => downloadMedia('http://lookaside.fbsbx.com/x', TOKEN), TypeError);
        assert.equal(calls.length, 0, 'no request was made, so no header went anywhere');
    });

    it('throws a MetaApiError whose cause carries the HTTP status, so a caller can tell an expired URL (404) from the rest', async () => {
        onGet = async () => { throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: Buffer.from('') } }); };

        await assert.rejects(
            () => downloadMedia(URL_OK, TOKEN),
            (err: unknown) => err instanceof MetaApiError && (err.cause as any)?.response?.status === 404
        );
        assert.equal(calls.length, 1, 'a 404 is not retried');
    });
});

describe('inspectWhatsAppToken', () => {
    const good = {
        is_valid: true, type: 'SYSTEM_USER', app_id: '847772258381375', expires_at: 0,
        scopes: ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management'],
    };

    it('accepts a valid token holding both scopes, and reads expires_at 0 as never', () => {
        const r = inspectWhatsAppToken(good, '847772258381375');
        assert.equal(r.error, null);
        assert.equal(r.expiresAt, null);
        assert.equal(r.type, 'SYSTEM_USER');
        assert.deepEqual(r.missingScopes, []);
    });

    it('reads a real expiry as a date', () => {
        const r = inspectWhatsAppToken({ ...good, expires_at: 1_800_000_000 });
        assert.equal(r.expiresAt?.toISOString(), '2027-01-15T08:00:00.000Z');
        assert.equal(r.error, null);
    });

    it('names a missing scope', () => {
        for (const missing of ['whatsapp_business_messaging', 'whatsapp_business_management']) {
            const r = inspectWhatsAppToken({ ...good, scopes: good.scopes.filter((s) => s !== missing) });
            assert.deepEqual(r.missingScopes, [missing]);
            assert.match(r.error ?? '', new RegExp(missing));
        }
    });

    it('refuses an invalid token, with Meta’s reason when it gave one', () => {
        assert.match(inspectWhatsAppToken({ is_valid: false, error: { message: 'Session has expired' } }).error ?? '', /not valid: Session has expired/);
        assert.match(inspectWhatsAppToken({ ...good, is_valid: false }).error ?? '', /not valid/);
        assert.match(inspectWhatsAppToken(undefined).error ?? '', /not valid/);
        assert.match(inspectWhatsAppToken('nonsense').error ?? '', /not valid/);
    });

    it('refuses a token issued to a different app, because it would subscribe the wrong app and never receive a message', () => {
        const r = inspectWhatsAppToken({ ...good, app_id: '999' }, '847772258381375');
        assert.match(r.error ?? '', /different Meta app/);
        // Without a configured app id there is nothing to compare, and nothing is refused on that ground.
        assert.equal(inspectWhatsAppToken({ ...good, app_id: '999' }, null).error, null);
        assert.equal(inspectWhatsAppToken({ ...good, app_id: 847772258381375 as unknown as string }, '847772258381375').error, null);
    });
});

describe('mapSendResult', () => {
    it('maps nothing to nulls', () => {
        for (const junk of [null, undefined, {}, 'x', { messages: [], contacts: [] }]) {
            assert.deepEqual(mapSendResult(junk), { messageId: null, waId: null, userId: null });
        }
    });
});

describe('the token never survives into an error, even when Meta echoes it', () => {
    const echo = () => metaError(190, `Invalid OAuth access token: ${TOKEN}`);

    it('scrubs it from the message of every call that can fail', async () => {
        onGet = async () => { throw echo(); };
        onPost = async () => { throw echo(); };
        onDelete = async () => { throw echo(); };
        const outcomes = await Promise.allSettled([
            getPhoneNumberHealth(PHONE, TOKEN),
            subscribeApp(WABA, TOKEN),
            unsubscribeApp(WABA, TOKEN),
            sendMessage(PHONE, TOKEN, { recipient: 'EG.1', type: 'text', text: { body: 'x' } }),
            markReadWithTyping(PHONE, TOKEN, 'wamid.X'),
            getMediaUrl('1013859600285441', TOKEN),
            downloadMedia('https://lookaside.fbsbx.com/x', TOKEN),
        ]);

        for (const outcome of outcomes) {
            assert.equal(outcome.status, 'rejected');
            const err = (outcome as PromiseRejectedResult).reason as MetaApiError;
            assert.ok(err instanceof MetaApiError);
            assert.ok(!err.message.includes(TOKEN), err.message);
            assert.match(err.message, /Invalid OAuth access token: \[token\]/);
            assert.equal(err.metaCode, 190, 'and the code is still there to classify it by');
        }
    });

    it('scrubs a refused extra read from the log line too', async () => {
        onGet = async (_url, config) => {
            if (config.params.fields === PHONE_NUMBER_FIELDS) return { data: { display_phone_number: '+1 555' } };
            throw echo();
        };
        await getPhoneNumberHealth(PHONE, TOKEN);
        assert.ok(logged.some((l) => l.includes('whatsapp.health_extras_unavailable')));
        assert.ok(!logged.join('\n').includes(TOKEN));
    });

    it('scrubToken replaces every occurrence, and leaves a message alone when there is no token', () => {
        assert.equal(scrubToken(`a ${TOKEN} b ${TOKEN}`, TOKEN), 'a [token] b [token]');
        assert.equal(scrubToken('nothing here', TOKEN), 'nothing here');
        assert.equal(scrubToken('nothing here', ''), 'nothing here');
    });
});
