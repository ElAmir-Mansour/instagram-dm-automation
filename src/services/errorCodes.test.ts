/**
 * The error-code registry and `sendError` (UX F1, T001).
 *
 * Three promises are pinned here:
 *   1. The envelope is additive. `error` is still the English string every client reads (older cached bundles of
 *      `api.js` do `new Error(body.error || body.message)`), and `code`, `params` and `message` sit beside it. A route
 *      that switched to an object `error` would print "[object Object]" in those bundles, so the real `api.js` is run
 *      against a coded body below to prove it reads the message, the code and the params.
 *   2. Every registered code has an `errors.<CODE>` sentence and an `errors.<CODE>.next` next step in BOTH dashboard
 *      catalogues, and they only interpolate params the registry declares. (`check:i18n` guards that the catalogues agree with each other,
 *      not that a code has a sentence.)
 *   3. A code sent with a status the registry does not list is logged, not thrown: the person is owed the refusal.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Response } from 'express';
import { setLogSink } from '../utils/log.js';
import { ERROR_CODE_LIST, ERROR_CODES, errorBody, isErrorCode, sendError, type ErrorCode } from './errorCodes.js';

interface Sent { status: number; body: any }

function fakeRes(): { res: Response; sent: Sent } {
    const sent: Sent = { status: 200, body: undefined };
    const res = {
        status(code: number) { sent.status = code; return this; },
        json(payload: unknown) { sent.body = payload; return this; },
    } as unknown as Response;
    return { res, sent };
}

let logs: Array<{ level: string; line: string }> = [];
let restoreSink: (() => void) | undefined;
beforeEach(() => {
    logs = [];
    const previous = setLogSink((level, line) => { logs.push({ level, line }); });
    restoreSink = () => setLogSink(previous);
});
afterEach(() => restoreSink?.());

describe('the registry', () => {
    it('names every code in SCREAMING_SNAKE_CASE, with a meaning and at least one real HTTP status', () => {
        assert.ok(ERROR_CODE_LIST.length >= 40, `${ERROR_CODE_LIST.length} codes`);
        for (const code of ERROR_CODE_LIST) {
            assert.match(code, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/, code);
            const spec = ERROR_CODES[code] as { status: readonly number[]; meaning: string; params?: readonly string[] };
            assert.ok(spec.meaning.length > 10, `${code} has a meaning`);
            assert.ok(spec.status.length > 0, `${code} has a status`);
            for (const status of spec.status) assert.ok(Number.isInteger(status) && status >= 200 && status < 600, `${code}: ${status}`);
            for (const param of spec.params ?? []) assert.match(param, /^[A-Za-z]\w*$/, `${code} param ${param}`);
        }
    });

    it('carries the codes the audits named', () => {
        for (const code of [
            'META_NOT_CONNECTED', 'NOT_CONNECTED', 'JOB_NOT_RETRYABLE', 'JOB_NOT_CANCELLABLE', 'ERASURE_COUNTS_DRIFTED', 'ERASURE_PREVIEW_EXPIRED',
            'ERASURE_TOKEN_INVALID', 'CAPTION_MISSING_COLUMNS', 'INVALID_SCHEDULE_TIME', 'POST_UNSUPPORTED_COMBINATION', 'UPLOAD_TOO_LARGE',
            'NO_FREE_SLOT', 'KEYWORD_CLASH', 'PROFILE_INCOMPLETE',
        ]) assert.ok(isErrorCode(code), code);
    });

    it('does not carry WINDOW_CLOSED: no route refuses a reply for a closed window today, and a code nothing sends is not a code', () => {
        assert.equal(isErrorCode('WINDOW_CLOSED'), false);
    });

    it('isErrorCode is true for registered names only, and never for an inherited property', () => {
        assert.equal(isErrorCode('JOB_NOT_RETRYABLE'), true);
        assert.equal(isErrorCode('job_not_retryable'), false);
        assert.equal(isErrorCode('toString'), false);
        assert.equal(isErrorCode('__proto__'), false);
        assert.equal(isErrorCode(undefined), false);
        assert.equal(isErrorCode(409), false);
    });
});

describe('errorBody', () => {
    it('keeps `error` a plain string, and mirrors it as `message`, with `code` and `params` beside it', () => {
        const body = errorBody('JOB_NOT_RETRYABLE', { status: 'done' }, 'That job is "done".');
        assert.deepEqual(body, { error: 'That job is "done".', message: 'That job is "done".', code: 'JOB_NOT_RETRYABLE', params: { status: 'done' } });
        assert.equal(typeof body.error, 'string');
    });

    it('defaults params to an empty object, never undefined or null', () => {
        assert.deepEqual(errorBody('NO_FREE_SLOT', undefined, 'x').params, {});
        assert.deepEqual(errorBody('NO_FREE_SLOT', null, 'x').params, {});
    });

    it('keeps legacy top-level fields, and lets none of them overwrite the four that make the envelope', () => {
        const body = errorBody('PROFILE_INCOMPLETE', { agent: 'dm' }, 'Fill in x.', {
            problems: ['a'], field: 'minutes', error: 'SPOOFED', code: 'SPOOFED', params: 'SPOOFED', message: 'SPOOFED',
        });
        assert.equal(body.error, 'Fill in x.');
        assert.equal(body.message, 'Fill in x.');
        assert.equal(body.code, 'PROFILE_INCOMPLETE');
        assert.deepEqual(body.params, { agent: 'dm' });
        assert.deepEqual(body.problems, ['a']);
        assert.equal(body.field, 'minutes');
    });
});

describe('sendError', () => {
    it('sends the status and the envelope: the five-argument form', () => {
        const { res, sent } = fakeRes();
        sendError(res, 409, 'JOB_NOT_CANCELLABLE', { status: 'running' }, 'That job is "running".', { status: 'running' });
        assert.equal(sent.status, 409);
        assert.deepEqual(sent.body, {
            status: 'running', error: 'That job is "running".', message: 'That job is "running".', code: 'JOB_NOT_CANCELLABLE', params: { status: 'running' },
        });
        assert.deepEqual(logs, [], 'a registered status is not logged');
    });

    it('takes the message in the params’ place when there are none: the four-argument form', () => {
        const { res, sent } = fakeRes();
        sendError(res, 409, 'NO_FREE_SLOT', 'There is no free posting slot in the next weeks: choose a time.');
        assert.equal(sent.status, 409);
        assert.deepEqual(sent.body, {
            error: 'There is no free posting slot in the next weeks: choose a time.', message: 'There is no free posting slot in the next weeks: choose a time.',
            code: 'NO_FREE_SLOT', params: {},
        });
    });

    it('accepts undefined and null params with a message (the 5-argument form with nothing to interpolate)', () => {
        for (const params of [undefined, null]) {
            const { res, sent } = fakeRes();
            sendError(res, 400, 'POST_FIELDS_REQUIRED', params, 'platform, post_type, and scheduled_time are required.');
            assert.equal(sent.body.error, 'platform, post_type, and scheduled_time are required.');
            assert.deepEqual(sent.body.params, {});
        }
    });

    it('warns, and still sends, when the status is not one the registry lists', () => {
        const { res, sent } = fakeRes();
        sendError(res, 418, 'NO_FREE_SLOT', 'x');
        assert.equal(sent.status, 418, 'the person still gets their refusal');
        assert.equal(sent.body.code, 'NO_FREE_SLOT');
        assert.equal(logs.length, 1);
        assert.equal(logs[0]!.level, 'warn');
        assert.match(logs[0]!.line, /error_code\.status_mismatch/);
        assert.match(logs[0]!.line, /NO_FREE_SLOT/);
    });

    it('lets a code that is sent with more than one status use each of them', () => {
        for (const status of ERROR_CODES.UPLOAD_TOO_LARGE.status) {
            const { res, sent } = fakeRes();
            sendError(res, status, 'UPLOAD_TOO_LARGE', { maxMb: 3 }, 'x');
            assert.equal(sent.status, status);
        }
        assert.deepEqual(logs, []);
    });
});

// ─── The dashboard side ────────────────────────────────────────────────────────────────────────

function loadCatalogue(file: string): Record<string, string> {
    const sandbox: Record<string, any> = {};
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
    const lang = Object.keys(sandbox.I18N_DICT)[0]!;
    return sandbox.I18N_DICT[lang] as Record<string, string>;
}

describe('every code has its sentence and its next step in both catalogues', () => {
    const ar = loadCatalogue('dashboard/js/i18n.ar.js');
    const en = loadCatalogue('dashboard/js/i18n.en.js');
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

    for (const code of ERROR_CODE_LIST) {
        it(code, () => {
            // The convention shared with UI.errorText (UX F4): `errors.<CODE>` is the sentence, `errors.<CODE>.next` the next step.
            const declared = new Set<string>((ERROR_CODES[code] as { params?: readonly string[] }).params ?? []);
            // `count` would make t() look for plural variants; none are defined, so a refusal never passes one.
            assert.ok(!declared.has('count'), `${code} must not name a param "count"`);
            for (const [suffix, minimum] of [['', 15], ['.next', 8]] as const) {
                const key = `errors.${code}${suffix}`;
                const arabic = ar[key];
                const english = en[key];
                assert.equal(typeof arabic, 'string', `${key} in i18n.ar.js`);
                assert.equal(typeof english, 'string', `${key} in i18n.en.js`);
                assert.match(arabic!, /[\u0600-\u06FF]/, `${key}: the Arabic is Arabic`);
                assert.doesNotMatch(english!, /[\u0600-\u06FF]/, `${key}: the English is English`);
                assert.ok(arabic!.length >= minimum && english!.length >= minimum, `${key}: a sentence, not a stub`);
                assert.match(arabic!, /[.؟!]$/, `${key}: ends like a sentence`);
                assert.match(english!, /[.?!]$/, `${key}: ends like a sentence`);
                // Only the params the registry declares may be interpolated, and both languages use the same set.
                assert.deepEqual(new Set(placeholders(arabic!)), new Set(placeholders(english!)), `${key}: same placeholders in both languages`);
                for (const name of placeholders(english!)) assert.ok(declared.has(name), `${key} uses {${name}}, which ${code} does not declare`);
            }
        });
    }

    it('has no stray errors.* key for a code that is not in the registry, and no .next without its sentence', () => {
        for (const catalogue of [ar, en]) {
            for (const key of Object.keys(catalogue)) {
                if (!key.startsWith('errors.')) continue;
                const code = key.slice('errors.'.length).replace(/\.next$/, '');
                assert.ok(isErrorCode(code), `${key} has no code behind it`);
                assert.equal(typeof catalogue[`errors.${code}`], 'string', `${key} has no errors.${code} sentence`);
            }
        }
    });
});

describe('the dashboard reads a coded refusal (the real api.js)', () => {
    /** The real i18n.js and api.js in a vm, with `fetch` answering the body `sendError` wrote. */
    async function request(status: number, body: unknown): Promise<any> {
        const sandbox: Record<string, any> = {
            localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            console,
            fetch: async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }),
        };
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);
        for (const file of ['dashboard/js/i18n.js', 'dashboard/js/i18n.en.js', 'dashboard/js/api.js']) {
            vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
        }
        vm.runInContext("I18N.lang = 'en'", sandbox);
        return vm.runInContext('API', sandbox);
    }

    it('turns `error` into the Error’s message and keeps the whole body on err.body, where `code` and `params` are', async () => {
        const { res, sent } = fakeRes();
        sendError(res, 409, 'JOB_NOT_RETRYABLE', { status: 'done' }, 'That job is "done", not failed or cancelled.', { status: 'done' });
        const API = await request(sent.status, sent.body);

        const err = await API.request('/admin/jobs/x/retry', { method: 'POST' }).then(() => null, (e: any) => e);
        assert.ok(err, 'it threw');
        assert.equal(err.message, 'That job is "done", not failed or cancelled.', 'not "[object Object]"');
        assert.equal(err.status, 409);
        assert.equal(err.body.code, 'JOB_NOT_RETRYABLE');
        assert.deepEqual(JSON.parse(JSON.stringify(err.body.params)), { status: 'done' });
        assert.equal(err.body.status, 'done', 'a legacy top-level field is still where it was');
    });

    it('exposes `code` and `params` on the Error itself (UX F4), and still the whole body on err.body', async () => {
        const { res, sent } = fakeRes();
        sendError(res, 409, 'REEL_DAY_TAKEN', { day: '2026-10-20' }, 'scheduled_time: another reel from this video is already on 2026-10-20. Choose another day.');
        const API = await request(sent.status, sent.body);

        const err = await API.request('/studio/monteur/clips/x/approve', { method: 'POST' }).then(() => null, (e: any) => e);
        assert.equal(err.message, 'scheduled_time: another reel from this video is already on 2026-10-20. Choose another day.');
        assert.equal(err.code, 'REEL_DAY_TAKEN');
        assert.deepEqual(JSON.parse(JSON.stringify(err.params)), { day: '2026-10-20' });
        assert.equal(err.body.code, 'REEL_DAY_TAKEN');
    });

    it('the profile gate’s 409 still reaches the profile sheet: `code`, `missing` and `agent` stay top-level', () => {
        const body = errorBody('PROFILE_INCOMPLETE', { agent: 'dm', missing: ['identity.niche'], fixStep: 'about' }, 'Fill in identity.niche before switching on the dm.',
            { agent: 'dm', missing: ['identity.niche'], fixStep: 'about' });
        assert.equal(body.code, 'PROFILE_INCOMPLETE');
        assert.deepEqual(body.missing, ['identity.niche']);
        assert.equal(body.agent, 'dm');
    });
});

describe('typing', () => {
    it('ErrorCode is the registry’s keys, so a code nobody registered does not compile', () => {
        const code: ErrorCode = 'NO_FREE_SLOT';
        assert.equal(isErrorCode(code), true);
        // @ts-expect-error not a registered code
        const bad: ErrorCode = 'NOT_A_REGISTERED_CODE';
        assert.equal(isErrorCode(bad), false);
    });
});
