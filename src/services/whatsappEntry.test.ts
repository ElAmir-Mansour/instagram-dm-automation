/**
 * The entry-point half of the WhatsApp Graph client (QR codes and short links, ice breakers and commands), against a stubbed HTTP client.
 *
 * `metaHttp.get/post/delete` are replaced for the whole file with an implementation that THROWS on any call a test did not arrange: `.env`
 * holds live production credentials, and a test here that reached the network could change a real number's public entry points. What is
 * pinned is what can be proven without acting on the account: which URL each call goes to, the exact body and query it carries, the limits
 * checked before anything is sent, and, for the one call that creates something, that nothing which may have landed is ever sent twice.
 * The request and response shapes are the ones on Meta's pages (cited in `whatsapp.ts`).
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from './http.js';
import { API_VERSION, MetaApiError } from './instagram.js';
import {
    COMMAND_DESCRIPTION_MAX_CHARS, COMMAND_NAME_MAX_CHARS, COMMANDS_MAX, createQrCode, deleteQrCode, getConversationalAutomation, getQrCode,
    hasEmoji, ICE_BREAKER_MAX_CHARS, ICE_BREAKERS_MAX, isQrCodeId, listQrCodes, mapConversationalAutomation, mapQrCode,
    parseConversationalAutomation, QR_CODES_MAX_PER_NUMBER, QR_PREFILL_MAX_CHARS, setConversationalAutomation,
} from './whatsapp.js';

const BASE = `https://graph.facebook.com/${API_VERSION}`;
const TOKEN = 'EAAGwhatsapp-system-user-token-0123456789';
const PHONE = '106540352242922';
const CODE = '4O4YGZEG3RIVE1';

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

/** An axios-shaped Meta failure. Defaults to a 400 / code 100 so `withRetry` refuses to retry it and no test sits through a backoff. */
function metaError(code = 100, message = 'Bad thing', status = 400) {
    return Object.assign(new Error(message), { response: { status, data: { error: { code, message } } } });
}

const qr = (code: string, message = 'Cyber Monday', image?: string) => ({
    code, prefilled_message: message, deep_link_url: `https://wa.me/message/${code}`, ...(image ? { qr_image_url: image } : {}),
});

describe('createQrCode', () => {
    it('posts the documented body to the number, with the token in the header only, and maps Meta\'s answer', async () => {
        onPost = async () => ({ data: qr(CODE, 'Cyber Monday 1', 'https://scontent.xx.fbcdn.net/qr.png') });

        const created = await createQrCode(PHONE, TOKEN, 'Cyber Monday');

        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, `${BASE}/${PHONE}/message_qrdls`);
        assert.deepEqual(calls[0]!.body, { prefilled_message: 'Cyber Monday', generate_qr_image: 'PNG' });
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
        assert.ok(!calls[0]!.url.includes(TOKEN) && !JSON.stringify(calls[0]!.body).includes(TOKEN), 'the token is in neither the URL nor the body');
        assert.deepEqual(created, {
            code: CODE, prefilledMessage: 'Cyber Monday 1', deepLinkUrl: `https://wa.me/message/${CODE}`, qrImageUrl: 'https://scontent.xx.fbcdn.net/qr.png',
        });
    });

    it('can ask for SVG instead', async () => {
        onPost = async () => ({ data: qr(CODE) });
        await createQrCode(PHONE, TOKEN, 'Hello', { format: 'SVG' });
        assert.equal((calls[0]!.body as any).generate_qr_image, 'SVG');
    });

    it('accepts exactly 140 characters (Meta\'s documented limit) and refuses 141, before any request', async () => {
        onPost = async () => ({ data: qr(CODE) });
        await createQrCode(PHONE, TOKEN, 'x'.repeat(140));
        assert.equal(calls.length, 1);

        await assert.rejects(() => createQrCode(PHONE, TOKEN, 'x'.repeat(141)), TypeError);
        assert.equal(calls.length, 1, 'the 141-character message never became a request');
    });

    it('pins Meta\'s documented limits as literals, so no test can follow a constant that was changed', () => {
        assert.equal(QR_PREFILL_MAX_CHARS, 140);
        assert.equal(QR_CODES_MAX_PER_NUMBER, 2000);
        assert.equal(ICE_BREAKERS_MAX, 4);
        assert.equal(ICE_BREAKER_MAX_CHARS, 80);
        assert.equal(COMMANDS_MAX, 30);
        assert.equal(COMMAND_NAME_MAX_CHARS, 32);
        assert.equal(COMMAND_DESCRIPTION_MAX_CHARS, 256);
    });

    it('refuses an empty message and a phone number id that is not numeric (it goes into a URL path)', async () => {
        await assert.rejects(() => createQrCode(PHONE, TOKEN, '   '), TypeError);
        await assert.rejects(() => createQrCode('../x', TOKEN, 'Hello'), TypeError);
        assert.equal(calls.length, 0);
    });

    it('is NEVER retried once it may have landed: a 500, a reset and a timeout each make exactly one request', async () => {
        for (const failure of [
            metaError(2, 'Service temporarily unavailable', 500),
            Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
            Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
        ]) {
            calls = [];
            onPost = async () => { throw failure; };
            await assert.rejects(() => createQrCode(PHONE, TOKEN, 'Hello'), MetaApiError);
            assert.equal(calls.length, 1, `retried after ${failure.message}`);
        }
    });

    it('does retry what proves Meta did nothing: a 429 it refused', async () => {
        let attempts = 0;
        onPost = async () => {
            attempts += 1;
            if (attempts === 1) throw Object.assign(new Error('Too many'), { response: { status: 429, data: {} } });
            return { data: qr(CODE) };
        };
        const created = await createQrCode(PHONE, TOKEN, 'Hello');
        assert.equal(created.code, CODE);
        assert.equal(attempts, 2);
    });

    it('throws a MetaApiError carrying the code, with the token scrubbed out of the message', async () => {
        onPost = async () => { throw metaError(131000, `Over the limit for ${TOKEN}`); };
        await assert.rejects(
            () => createQrCode(PHONE, TOKEN, 'Hello'),
            (err: unknown) => err instanceof MetaApiError && err.metaCode === 131000 && !err.message.includes(TOKEN) && err.message.includes('[token]')
        );
    });

    it('fails when Meta answers 200 without a code, rather than reporting a link that does not exist', async () => {
        onPost = async () => ({ data: { success: true } });
        await assert.rejects(() => createQrCode(PHONE, TOKEN, 'Hello'), /without a QR code/);
    });
});

describe('listQrCodes', () => {
    it('asks for the image in the same call, 25 at a time, and maps the codes in Meta\'s order', async () => {
        onGet = async () => ({ data: { data: [qr(CODE, 'One', 'https://scontent.xx.fbcdn.net/1.png'), qr('WOMVT6TJ2BP7A1', 'Two')] } });

        const codes = await listQrCodes(PHONE, TOKEN);

        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, `${BASE}/${PHONE}/message_qrdls`);
        assert.deepEqual(calls[0]!.config.params, { fields: 'code,prefilled_message,deep_link_url,qr_image_url.format(PNG)', limit: 25 });
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
        assert.deepEqual(codes.map((c) => c.code), [CODE, 'WOMVT6TJ2BP7A1']);
        assert.equal(codes[0]!.qrImageUrl, 'https://scontent.xx.fbcdn.net/1.png');
        assert.equal(codes[1]!.qrImageUrl, null);
    });

    it('follows the cursor to the end and stops when Meta stops saying there is a next page', async () => {
        onGet = async (_url, config) => {
            if (!config.params.after) return { data: { data: [qr('AAAAAA111111')], paging: { cursors: { after: 'c1' }, next: 'https://graph.facebook.com/next' } } };
            if (config.params.after === 'c1') return { data: { data: [qr('BBBBBB222222')], paging: { cursors: { after: 'c2' }, next: 'https://graph.facebook.com/next2' } } };
            return { data: { data: [qr('CCCCCC333333')], paging: { cursors: { after: 'c3' } } } };
        };

        const codes = await listQrCodes(PHONE, TOKEN);

        assert.deepEqual(codes.map((c) => c.code), ['AAAAAA111111', 'BBBBBB222222', 'CCCCCC333333']);
        assert.deepEqual(calls.map((c) => c.config.params.after), [undefined, 'c1', 'c2']);
    });

    it('does not loop on a cursor that repeats', async () => {
        onGet = async () => ({ data: { data: [qr('AAAAAA111111')], paging: { cursors: { after: 'same' }, next: 'https://graph.facebook.com/next' } } });
        const codes = await listQrCodes(PHONE, TOKEN);
        assert.equal(calls.length, 2, 'the first page, then the second page that returned the cursor it was asked for');
        assert.equal(codes.length, 2);
    });

    it('asks again without the image when Meta refuses that field spec, so the list still comes back', async () => {
        onGet = async (_url, config) => {
            if (String(config.params.fields).includes('qr_image_url')) throw metaError(100, 'Invalid fields parameter');
            return { data: { data: [qr(CODE)] } };
        };

        const codes = await listQrCodes(PHONE, TOKEN);

        assert.equal(calls.length, 2);
        assert.equal(calls[1]!.config.params.fields, 'code,prefilled_message,deep_link_url');
        assert.equal(codes[0]!.qrImageUrl, null);
        assert.ok(logged.some((l) => l.includes('whatsapp.qr_list_image_unavailable')));
    });

    it('does NOT hide a real refusal behind that fallback: a dead token fails the list', async () => {
        onGet = async () => { throw metaError(190, 'Invalid OAuth access token.'); };
        await assert.rejects(() => listQrCodes(PHONE, TOKEN), (err: unknown) => err instanceof MetaApiError && err.metaCode === 190);
        assert.equal(calls.length, 1);
    });

    it('skips an entry that has no usable code rather than inventing one', async () => {
        onGet = async () => ({ data: { data: [{ prefilled_message: 'No code' }, { code: '../etc/passwd' }, qr(CODE)] } });
        assert.deepEqual((await listQrCodes(PHONE, TOKEN)).map((c) => c.code), [CODE]);
    });
});

describe('getQrCode', () => {
    it('filters the list by code, and trusts the answer only when it IS that code', async () => {
        onGet = async () => ({ data: { data: [qr(CODE, 'Cyber Monday')] } });
        const found = await getQrCode(PHONE, TOKEN, CODE);

        assert.equal(found?.code, CODE);
        assert.equal(calls[0]!.url, `${BASE}/${PHONE}/message_qrdls`);
        assert.deepEqual(calls[0]!.config.params, { code: CODE, fields: 'code,prefilled_message,deep_link_url', limit: 1 });
    });

    it('is null only after the whole list has been checked too: an empty or foreign answer to the filter is not "not found" yet', async () => {
        onGet = async () => ({ data: { data: [qr('WOMVT6TJ2BP7A1')] } });
        assert.equal(await getQrCode(PHONE, TOKEN, CODE), null);
        assert.equal(calls.length, 2, 'the filtered read, then the list');
        assert.equal(calls[0]!.config.params.code, CODE);
        assert.equal(calls[1]!.config.params.code, undefined);

        calls = [];
        onGet = async () => ({ data: { data: [] } });
        assert.equal(await getQrCode(PHONE, TOKEN, CODE), null);
        assert.equal(calls.length, 2);
    });

    it('finds the code through the list when Meta ignores the filter, and never takes another code for it', async () => {
        onGet = async (_url, config) => (config.params.code
            ? { data: { data: [qr('WOMVT6TJ2BP7A1')] } }
            : { data: { data: [qr('WOMVT6TJ2BP7A1'), qr(CODE, 'The one asked for')] } });

        const found = await getQrCode(PHONE, TOKEN, CODE);

        assert.equal(found?.code, CODE);
        assert.equal(found?.prefilledMessage, 'The one asked for');
    });

    it('does not read the list when the filter answered with the code: one call', async () => {
        onGet = async () => ({ data: { data: [qr(CODE)] } });
        await getQrCode(PHONE, TOKEN, CODE);
        assert.equal(calls.length, 1);
    });

    it('refuses a code that is not a code, before any request', async () => {
        await assert.rejects(() => getQrCode(PHONE, TOKEN, '../x'), TypeError);
        assert.equal(calls.length, 0);
    });
});

describe('deleteQrCode', () => {
    it('deletes through the number, by code, and says whether Meta confirmed', async () => {
        onDelete = async () => ({ data: { success: true } });
        assert.equal(await deleteQrCode(PHONE, TOKEN, CODE), true);
        assert.equal(calls[0]!.url, `${BASE}/${PHONE}/message_qrdls/${CODE}`);
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);

        onDelete = async () => ({ data: {} });
        assert.equal(await deleteQrCode(PHONE, TOKEN, CODE), false);
    });

    it('refuses a code that could change the path, before any request', async () => {
        for (const bad of ['', '../123456', 'AB', 'a/b', `${CODE}?x=1`]) {
            await assert.rejects(() => deleteQrCode(PHONE, TOKEN, bad), TypeError, bad);
        }
        assert.equal(calls.length, 0);
    });
});

describe('isQrCodeId / mapQrCode', () => {
    it('accepts Meta\'s 14-character codes and nothing that is not alphanumeric', () => {
        assert.equal(isQrCodeId(CODE), true);
        for (const bad of ['', 'short', 'has space 123', 'a/b/c/d/e/f', 42, null, undefined]) assert.equal(isQrCodeId(bad), false, String(bad));
    });

    it('maps a QR object and gives null for anything without a code', () => {
        assert.deepEqual(mapQrCode(qr(CODE, 'Hi')), { code: CODE, prefilledMessage: 'Hi', deepLinkUrl: `https://wa.me/message/${CODE}`, qrImageUrl: null });
        for (const bad of [null, undefined, 'x', {}, { code: '' }]) assert.equal(mapQrCode(bad), null);
    });
});

// ─── Ice breakers and commands ──────────────────────────────────────────────────────────

describe('parseConversationalAutomation: ice breakers', () => {
    const code = (input: unknown) => ('error' in parseConversationalAutomation(input) ? (parseConversationalAutomation(input) as { code: string }).code : null);

    it('accepts up to 4 ice breakers of up to 80 characters and trims them', () => {
        const ok = parseConversationalAutomation({ prompts: ['  Plan a trip  ', 'x'.repeat(80), 'c', 'd'] });
        assert.ok('value' in ok);
        assert.deepEqual(ok.value.prompts.slice(0, 2), ['Plan a trip', 'x'.repeat(80)]);
        assert.equal(ok.value.commands, undefined, 'no commands sent means none are touched');
    });

    it('accepts an empty list: the owner may want none', () => {
        assert.deepEqual(parseConversationalAutomation({ prompts: [] }), { value: { prompts: [] } });
    });

    it('refuses a fifth ice breaker (the limit is 4)', () => {
        assert.equal(code({ prompts: ['a', 'b', 'c', 'd', 'e'] }), 'too_many_prompts');
    });

    it('refuses an ice breaker of 81 characters, naming which one', () => {
        const r = parseConversationalAutomation({ prompts: ['fine', 'x'.repeat(81)] });
        assert.ok('error' in r);
        assert.equal(r.code, 'prompt_too_long');
        assert.match(r.error, /Ice breaker 2 /);
    });

    it('refuses emoji, but not digits, # or ©', () => {
        for (const bad of ['Hello 😀', 'Flag 🇸🇦', '1️⃣ first', 'Heart ❤️', 'Sun ☀', 'مرحبا 👋']) {
            assert.equal(code({ prompts: [bad] }), 'prompt_has_emoji', bad);
        }
        for (const fine of ['Plan 2 trips', 'Press #1', '© 2026 offer', 'ما هي الخدمات المتاحة؟', 'سعر الخدمة ٥٠ دولار']) {
            assert.ok('value' in parseConversationalAutomation({ prompts: [fine] }), fine);
        }
        assert.equal(hasEmoji('plain'), false);
    });

    it('refuses what is not a list of non-empty strings', () => {
        for (const bad of [{}, { prompts: 'Hello' }, { prompts: [''] }, { prompts: ['  '] }, { prompts: [1] }, { prompts: [null] }, null, 'x']) {
            assert.equal(code(bad), 'invalid_prompts', JSON.stringify(bad));
        }
    });
});

describe('parseConversationalAutomation: commands', () => {
    const cmd = (name: string, description = 'Do the thing') => ({ command_name: name, command_description: description });
    const code = (input: unknown) => {
        const r = parseConversationalAutomation(input);
        return 'error' in r ? r.code : null;
    };

    it('accepts up to 30 commands, trimmed, and keeps their order', () => {
        const r = parseConversationalAutomation({ prompts: [], commands: [cmd(' tickets ', ' Book tickets '), cmd('hotel')] });
        assert.ok('value' in r);
        assert.deepEqual(r.value.commands, [cmd('tickets', 'Book tickets'), cmd('hotel')]);
        assert.ok('value' in parseConversationalAutomation({ prompts: [], commands: Array.from({ length: 30 }, (_, i) => cmd(`c${i}`)) }));
    });

    it('refuses a 31st command', () => {
        assert.equal(code({ prompts: [], commands: Array.from({ length: 31 }, (_, i) => cmd(`c${i}`)) }), 'too_many_commands');
    });

    it('refuses a name over 32 characters, a hint over 256, and a missing hint', () => {
        assert.equal(code({ prompts: [], commands: [cmd('n'.repeat(33))] }), 'command_name_too_long');
        assert.ok('value' in parseConversationalAutomation({ prompts: [], commands: [cmd('n'.repeat(32), 'd'.repeat(256))] }));
        assert.equal(code({ prompts: [], commands: [cmd('ok', 'd'.repeat(257))] }), 'command_description_too_long');
        assert.equal(code({ prompts: [], commands: [cmd('ok', '')] }), 'invalid_command_description');
    });

    it('refuses a name Meta documents as WITHOUT a slash, a name with spaces, a duplicate, and emoji', () => {
        assert.equal(code({ prompts: [], commands: [cmd('/tickets')] }), 'invalid_command_name');
        assert.equal(code({ prompts: [], commands: [cmd('book now')] }), 'invalid_command_name');
        assert.equal(code({ prompts: [], commands: [cmd('')] }), 'invalid_command_name');
        assert.equal(code({ prompts: [], commands: [cmd('a'), cmd('a')] }), 'duplicate_command');
        assert.equal(code({ prompts: [], commands: [cmd('ok', 'Book 😀')] }), 'command_has_emoji');
        assert.equal(code({ prompts: [], commands: 'tickets' }), 'invalid_commands');
        assert.equal(code({ prompts: [], commands: [null] }), 'invalid_command_name');
    });
});

describe('setConversationalAutomation / getConversationalAutomation', () => {
    it('posts only the prompts when no commands were given, to the documented path, and says whether Meta confirmed', async () => {
        onPost = async () => ({ data: { success: true } });

        assert.equal(await setConversationalAutomation(PHONE, TOKEN, { prompts: ['Book a flight', 'plan a vacation'] }), true);

        assert.equal(calls[0]!.url, `${BASE}/${PHONE}/conversational_automation`);
        assert.deepEqual(calls[0]!.body, { prompts: ['Book a flight', 'plan a vacation'] });
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
    });

    it('posts both when commands are given, in the documented shape', async () => {
        onPost = async () => ({ data: { success: true } });
        const commands = [{ command_name: 'tickets', command_description: 'Book flight tickets' }];
        await setConversationalAutomation(PHONE, TOKEN, { prompts: ['Hi'], commands });
        assert.deepEqual(calls[0]!.body, { prompts: ['Hi'], commands });
    });

    it('is false when Meta answers 200 without success', async () => {
        onPost = async () => ({ data: {} });
        assert.equal(await setConversationalAutomation(PHONE, TOKEN, { prompts: ['Hi'] }), false);
    });

    it('re-checks the limits itself: a fifth ice breaker or an emoji is a TypeError and never a request', async () => {
        await assert.rejects(() => setConversationalAutomation(PHONE, TOKEN, { prompts: ['a', 'b', 'c', 'd', 'e'] }), TypeError);
        await assert.rejects(() => setConversationalAutomation(PHONE, TOKEN, { prompts: ['x'.repeat(81)] }), TypeError);
        await assert.rejects(() => setConversationalAutomation(PHONE, TOKEN, { prompts: ['Hi 😀'] }), TypeError);
        assert.equal(calls.length, 0);
    });

    it('retries a transient failure once (it sets state; setting it twice is the same state)', async () => {
        let attempts = 0;
        onPost = async () => {
            attempts += 1;
            if (attempts === 1) throw metaError(2, 'Temporarily unavailable', 500);
            return { data: { success: true } };
        };
        assert.equal(await setConversationalAutomation(PHONE, TOKEN, { prompts: ['Hi'] }), true);
        assert.equal(attempts, 2);
    });

    it('wraps a Meta failure with its code and without the token', async () => {
        onPost = async () => { throw metaError(100, `Invalid parameter ${TOKEN}`); };
        await assert.rejects(
            () => setConversationalAutomation(PHONE, TOKEN, { prompts: ['Hi'] }),
            (err: unknown) => err instanceof MetaApiError && err.metaCode === 100 && !err.message.includes(TOKEN)
        );
    });

    it('reads the current state with ?fields=conversational_automation on the number', async () => {
        onGet = async () => ({
            data: {
                conversational_automation: {
                    prompts: ['Find the best hotels in the area', 'Find deals on rental cars'],
                    commands: [{ command_name: 'tickets', command_description: 'Book flight tickets' }, { command_name: 'hotel', command_description: 'Book hotel' }],
                },
                id: '123456',
            },
        });

        const state = await getConversationalAutomation(PHONE, TOKEN);

        assert.equal(calls[0]!.url, `${BASE}/${PHONE}`);
        assert.deepEqual(calls[0]!.config.params, { fields: 'conversational_automation' });
        assert.deepEqual(state.prompts, ['Find the best hotels in the area', 'Find deals on rental cars']);
        assert.deepEqual(state.commands.map((c) => c.command_name), ['tickets', 'hotel']);
    });

    it('maps a number with nothing set (Meta omits the object) to empty lists, and drops malformed entries', () => {
        assert.deepEqual(mapConversationalAutomation({ id: '1' }), { prompts: [], commands: [] });
        assert.deepEqual(mapConversationalAutomation(null), { prompts: [], commands: [] });
        assert.deepEqual(
            mapConversationalAutomation({ conversational_automation: { prompts: ['ok', 5, null], commands: [{ command_name: 'a' }, { command_description: 'no name' }, 'x'] } }),
            { prompts: ['ok'], commands: [{ command_name: 'a', command_description: '' }] }
        );
    });
});
